"""A minimal, dependency-free HTTP server exposing the repository as JSON.

The server serves a small single-page application from the ``static`` folder
and a handful of JSON API endpoints backed by :class:`gitview.repo.Repo`.
Only the Python standard library is used so GitView runs anywhere ``git`` and
Python 3.8+ are available.
"""

from __future__ import annotations

import json
import mimetypes
import os
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from .repo import Repo, GitError

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


class GitViewHandler(BaseHTTPRequestHandler):
    # ``repo`` is injected onto the class before the server starts serving.
    repo: Repo = None  # type: ignore[assignment]

    server_version = "GitView"

    # Quieter logging: one concise line per request.
    def log_message(self, fmt, *args):  # noqa: N802 (stdlib signature)
        pass

    # -- helpers -----------------------------------------------------------

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, message, status=500):
        self._send_json({"error": message}, status=status)

    def _serve_static(self, path):
        # Default document.
        if path in ("/", ""):
            path = "/index.html"
        # Normalize and prevent path traversal.
        rel = os.path.normpath(path.lstrip("/"))
        if rel.startswith(".."):
            self._send_error_json("Not found", status=404)
            return
        full = os.path.join(STATIC_DIR, rel)
        if not os.path.isfile(full):
            self._send_error_json("Not found", status=404)
            return
        ctype, _ = mimetypes.guess_type(full)
        with open(full, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- routing -----------------------------------------------------------

    def do_GET(self):  # noqa: N802 (stdlib signature)
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if not path.startswith("/api/"):
            self._serve_static(path)
            return

        try:
            self._handle_api(path, query)
        except GitError as exc:
            self._send_error_json(str(exc), status=400)
        except Exception as exc:  # pragma: no cover - defensive
            self._send_error_json(f"Internal error: {exc}", status=500)

    def _handle_api(self, path, query):
        repo = self.repo
        if path == "/api/info":
            self._send_json(repo.info())
        elif path == "/api/commits":
            limit = _int_param(query, "limit", default=500)
            self._send_json({"commits": repo.commits(limit=limit)})
        elif path == "/api/branches":
            self._send_json({"branches": repo.branches()})
        elif path == "/api/remotes":
            self._send_json({"remotes": repo.remotes()})
        elif path == "/api/tags":
            self._send_json({"tags": repo.tags()})
        elif path.startswith("/api/commit/"):
            rev = path[len("/api/commit/"):]
            self._send_json(repo.commit_detail(rev))
        else:
            self._send_error_json("Unknown endpoint", status=404)


def _int_param(query, name, default):
    values = query.get(name)
    if not values:
        return default
    try:
        return int(values[0])
    except (TypeError, ValueError):
        return default


def serve(repo_path=".", host="127.0.0.1", port=8000, open_browser=True):
    """Start the GitView server for the repository at ``repo_path``."""
    repo = Repo(repo_path)
    GitViewHandler.repo = repo

    httpd = ThreadingHTTPServer((host, port), GitViewHandler)
    actual_port = httpd.server_address[1]
    url = f"http://{host}:{actual_port}/"

    print(f"GitView analyzing: {repo.toplevel}")
    print(f"Serving on {url}  (press Ctrl+C to stop)")

    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down GitView.")
    finally:
        httpd.server_close()
