"""Read and analyze a git repository via its ``.git`` directory.

This module wraps the ``git`` command line (which operates directly on the
``.git`` directory) to extract structured information about commits, branches,
remotes and tags. It intentionally depends only on the Python standard library
and a working ``git`` executable.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional


class GitError(RuntimeError):
    """Raised when a git command fails or the path is not a git repository."""


# Field separator unlikely to appear in commit metadata.
_FS = "\x1f"  # unit separator
_RS = "\x1e"  # record separator


@dataclass
class Commit:
    hash: str
    short: str
    parents: List[str]
    author_name: str
    author_email: str
    author_date: int  # unix timestamp
    committer_name: str
    committer_date: int
    subject: str
    body: str
    refs: List[str] = field(default_factory=list)


class Repo:
    """A thin wrapper around a git repository rooted at ``path``."""

    def __init__(self, path: str = "."):
        self.path = os.path.abspath(path)
        self.git_dir = self._resolve_git_dir()
        self.toplevel = self._run(["rev-parse", "--show-toplevel"]).strip() or self.path

    # -- low level ---------------------------------------------------------

    def _run(self, args: List[str], check: bool = True) -> str:
        try:
            proc = subprocess.run(
                ["git", *args],
                cwd=self.path,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except FileNotFoundError as exc:  # git not installed
            raise GitError("The 'git' executable was not found on PATH.") from exc
        if check and proc.returncode != 0:
            raise GitError(
                f"git {' '.join(args)} failed: {proc.stderr.strip() or proc.stdout.strip()}"
            )
        return proc.stdout

    def _resolve_git_dir(self) -> str:
        try:
            proc = subprocess.run(
                ["git", "rev-parse", "--git-dir"],
                cwd=self.path,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError as exc:
            raise GitError("The 'git' executable was not found on PATH.") from exc
        if proc.returncode != 0:
            raise GitError(
                f"'{self.path}' is not inside a git repository (no .git found)."
            )
        git_dir = proc.stdout.strip()
        if not os.path.isabs(git_dir):
            git_dir = os.path.abspath(os.path.join(self.path, git_dir))
        return git_dir

    # -- high level API ----------------------------------------------------

    def info(self) -> Dict[str, Any]:
        """Return general information about the repository."""
        head = self.current_branch()
        is_empty = False
        try:
            self._run(["rev-parse", "HEAD"])
        except GitError:
            is_empty = True
        return {
            "path": self.toplevel,
            "git_dir": self.git_dir,
            "current_branch": head,
            "is_empty": is_empty,
            "head_detached": head is None and not is_empty,
            "counts": {
                "commits": self.commit_count(),
                "branches": len(self.branches()),
                "remotes": len(self.remotes()),
                "tags": len(self.tags()),
            },
        }

    def current_branch(self) -> Optional[str]:
        out = self._run(["symbolic-ref", "--quiet", "--short", "HEAD"], check=False)
        name = out.strip()
        return name or None

    def commit_count(self) -> int:
        out = self._run(["rev-list", "--all", "--count"], check=False).strip()
        try:
            return int(out)
        except ValueError:
            return 0

    def commits(self, limit: Optional[int] = None, all_refs: bool = True,
                rev: Optional[str] = None) -> List[Dict[str, Any]]:
        """Return commits in topological order (newest first).

        Fields are separated by unit separators and records by record
        separators so that arbitrary commit messages parse safely.
        """
        fmt = _FS.join([
            "%H", "%h", "%P",
            "%an", "%ae", "%at",
            "%cn", "%ct",
            "%s", "%b", "%D",
        ]) + _RS

        args = ["log", "--topo-order", "--date-order", f"--pretty=format:{fmt}"]
        if limit:
            args.append(f"--max-count={limit}")
        if rev:
            args.append(rev)
        elif all_refs:
            args.append("--all")

        out = self._run(args, check=False)
        commits: List[Dict[str, Any]] = []
        for record in out.split(_RS):
            record = record.strip("\n")
            if not record:
                continue
            parts = record.split(_FS)
            if len(parts) < 11:
                continue
            (h, short, parents, an, ae, at, cn, ct, subject, body, decorate) = parts[:11]
            refs = _parse_decorations(decorate)
            commits.append(asdict(Commit(
                hash=h,
                short=short,
                parents=parents.split() if parents.strip() else [],
                author_name=an,
                author_email=ae,
                author_date=int(at) if at.isdigit() else 0,
                committer_name=cn,
                committer_date=int(ct) if ct.isdigit() else 0,
                subject=subject,
                body=body.strip(),
                refs=refs,
            )))
        return commits

    def branches(self) -> List[Dict[str, Any]]:
        """Return local and remote-tracking branches."""
        fmt = _FS.join([
            "%(refname)", "%(refname:short)", "%(objectname)",
            "%(objectname:short)", "%(HEAD)", "%(upstream:short)",
            "%(committerdate:unix)",
        ])
        out = self._run(
            ["for-each-ref", "--sort=-committerdate",
             f"--format={fmt}", "refs/heads", "refs/remotes"],
            check=False,
        )
        branches = []
        for line in out.splitlines():
            if not line.strip():
                continue
            parts = line.split(_FS)
            if len(parts) < 7:
                continue
            refname, short, oid, short_oid, is_head, upstream, cdate = parts[:7]
            is_remote = refname.startswith("refs/remotes/")
            # Skip the symbolic "origin/HEAD -> origin/main" style refs.
            if is_remote and short.endswith("/HEAD"):
                continue
            branches.append({
                "name": short,
                "full": refname,
                "commit": oid,
                "short": short_oid,
                "is_head": is_head.strip() == "*",
                "is_remote": is_remote,
                "remote": short.split("/", 1)[0] if is_remote else None,
                "upstream": upstream or None,
                "date": int(cdate) if cdate.isdigit() else 0,
            })
        return branches

    def remotes(self) -> List[Dict[str, Any]]:
        """Return configured remotes with their fetch/push URLs."""
        out = self._run(["remote", "-v"], check=False)
        remotes: Dict[str, Dict[str, str]] = {}
        for line in out.splitlines():
            if not line.strip():
                continue
            try:
                name, rest = line.split("\t", 1)
                url, kind = rest.rsplit(" ", 1)
            except ValueError:
                continue
            kind = kind.strip("()")
            entry = remotes.setdefault(name, {"name": name, "fetch": "", "push": ""})
            if kind in ("fetch", "push"):
                entry[kind] = url
        return list(remotes.values())

    def tags(self) -> List[Dict[str, Any]]:
        """Return tags with their target commit."""
        fmt = _FS.join([
            "%(refname:short)", "%(objectname)",
            "%(*objectname)", "%(creatordate:unix)", "%(subject)",
        ])
        out = self._run(
            ["for-each-ref", "--sort=-creatordate",
             f"--format={fmt}", "refs/tags"],
            check=False,
        )
        tags = []
        for line in out.splitlines():
            if not line.strip():
                continue
            parts = line.split(_FS)
            if len(parts) < 5:
                continue
            name, oid, deref_oid, cdate, subject = parts[:5]
            tags.append({
                "name": name,
                # For annotated tags the dereferenced commit is in deref_oid.
                "commit": deref_oid or oid,
                "date": int(cdate) if cdate.isdigit() else 0,
                "subject": subject,
            })
        return tags

    def commit_detail(self, rev: str) -> Dict[str, Any]:
        """Return detailed info for a single commit, including changed files."""
        # Basic metadata (reuse the commits() parser for one revision).
        meta = self.commits(limit=1, all_refs=False, rev=rev)
        if not meta:
            raise GitError(f"Unknown revision: {rev}")
        detail = meta[0]

        # Numstat for changed files.
        numstat = self._run(
            ["show", "--numstat", "--format=", rev], check=False
        )
        files = []
        for line in numstat.splitlines():
            if not line.strip():
                continue
            cols = line.split("\t")
            if len(cols) < 3:
                continue
            added, removed, path = cols[0], cols[1], "\t".join(cols[2:])
            files.append({
                "added": None if added == "-" else int(added),
                "removed": None if removed == "-" else int(removed),
                "path": path,
                "binary": added == "-" and removed == "-",
            })
        detail["files"] = files
        detail["stats"] = {
            "files": len(files),
            "added": sum(f["added"] or 0 for f in files),
            "removed": sum(f["removed"] or 0 for f in files),
        }
        return detail


def _parse_decorations(decorate: str) -> List[str]:
    """Parse the ``%D`` ref decoration string into a list of ref names."""
    if not decorate.strip():
        return []
    refs = []
    for token in decorate.split(","):
        token = token.strip()
        if not token:
            continue
        # "HEAD -> main" => keep both HEAD and main.
        if "->" in token:
            left, right = token.split("->", 1)
            refs.append(left.strip())
            refs.append(right.strip())
        else:
            refs.append(token)
    return refs
