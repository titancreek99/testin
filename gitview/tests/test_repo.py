"""Tests for gitview.repo against a throwaway git repository."""

import os
import subprocess
import sys
import tempfile
import unittest

# Make the package importable when run from the repo root.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from gitview.repo import Repo, GitError  # noqa: E402


def git(cwd, *args):
    env = dict(os.environ)
    env.update({
        "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "t@example.com",
        "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "t@example.com",
    })
    subprocess.run(["git", *args], cwd=cwd, check=True, env=env,
                   capture_output=True, text=True)


class RepoTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        git(self.tmp, "init", "-q", "-b", "main")
        self._write("a.txt", "one\n")
        git(self.tmp, "add", ".")
        git(self.tmp, "commit", "-q", "-m", "first commit")
        self._write("a.txt", "one\ntwo\n")
        git(self.tmp, "commit", "-q", "-am", "second commit")
        # A branch with its own commit.
        git(self.tmp, "checkout", "-q", "-b", "feature")
        self._write("b.txt", "feature\n")
        git(self.tmp, "add", ".")
        git(self.tmp, "commit", "-q", "-m", "feature work")
        git(self.tmp, "checkout", "-q", "main")
        # Merge feature into main to create a merge commit.
        git(self.tmp, "merge", "--no-ff", "-q", "-m", "merge feature", "feature")
        git(self.tmp, "tag", "v1.0")
        git(self.tmp, "remote", "add", "origin", "https://example.com/x.git")
        self.repo = Repo(self.tmp)

    def _write(self, name, content):
        with open(os.path.join(self.tmp, name), "w") as fh:
            fh.write(content)

    def test_not_a_repo(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(GitError):
                Repo(d)

    def test_info(self):
        info = self.repo.info()
        self.assertEqual(info["current_branch"], "main")
        self.assertFalse(info["is_empty"])
        self.assertGreaterEqual(info["counts"]["commits"], 4)
        self.assertGreaterEqual(info["counts"]["branches"], 2)
        self.assertEqual(info["counts"]["remotes"], 1)
        self.assertEqual(info["counts"]["tags"], 1)

    def test_commits_have_parents_and_merge(self):
        commits = self.repo.commits()
        self.assertGreaterEqual(len(commits), 4)
        # Newest first: the merge commit should have two parents.
        merges = [c for c in commits if len(c["parents"]) > 1]
        self.assertEqual(len(merges), 1)
        self.assertEqual(merges[0]["subject"], "merge feature")
        # Root commit has no parents.
        roots = [c for c in commits if not c["parents"]]
        self.assertEqual(len(roots), 1)

    def test_commits_carry_ref_decorations(self):
        commits = self.repo.commits()
        all_refs = {r for c in commits for r in c["refs"]}
        self.assertIn("main", all_refs)
        self.assertIn("feature", all_refs)
        self.assertTrue(any(r.startswith("tag:") for r in all_refs))

    def test_branches(self):
        names = {b["name"] for b in self.repo.branches()}
        self.assertIn("main", names)
        self.assertIn("feature", names)
        head = [b for b in self.repo.branches() if b["is_head"]]
        self.assertEqual(head[0]["name"], "main")

    def test_remotes(self):
        remotes = self.repo.remotes()
        self.assertEqual(len(remotes), 1)
        self.assertEqual(remotes[0]["name"], "origin")
        self.assertEqual(remotes[0]["fetch"], "https://example.com/x.git")

    def test_tags(self):
        tags = self.repo.tags()
        self.assertEqual(len(tags), 1)
        self.assertEqual(tags[0]["name"], "v1.0")
        self.assertTrue(tags[0]["commit"])

    def test_commit_detail(self):
        head = self.repo.commits(limit=1)[0]
        detail = self.repo.commit_detail(head["hash"])
        self.assertEqual(detail["hash"], head["hash"])
        self.assertIn("files", detail)
        self.assertIn("stats", detail)


if __name__ == "__main__":
    unittest.main()
