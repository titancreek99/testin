"""Command line entry point for GitView.

Usage::

    python -m gitview [PATH] [--port PORT] [--host HOST] [--no-browser]

``PATH`` defaults to the current directory and must be inside a git
repository (a directory containing a ``.git`` folder).
"""

from __future__ import annotations

import argparse
import sys

from . import __version__
from .repo import GitError
from .server import serve


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="gitview",
        description="Browser-based interactive git repository analyzer.",
    )
    parser.add_argument(
        "path",
        nargs="?",
        default=".",
        help="Path to a git repository (default: current directory).",
    )
    parser.add_argument(
        "-p", "--port", type=int, default=8000,
        help="Port to serve on (default: 8000; use 0 to pick a free port).",
    )
    parser.add_argument(
        "--host", default="127.0.0.1",
        help="Host/interface to bind (default: 127.0.0.1).",
    )
    parser.add_argument(
        "--no-browser", action="store_true",
        help="Do not automatically open a web browser.",
    )
    parser.add_argument(
        "-V", "--version", action="version",
        version=f"GitView {__version__}",
    )
    args = parser.parse_args(argv)

    try:
        serve(
            repo_path=args.path,
            host=args.host,
            port=args.port,
            open_browser=not args.no_browser,
        )
    except GitError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"error: could not start server: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
