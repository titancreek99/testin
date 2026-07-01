#!/usr/bin/env python3
"""Convenience launcher so GitView can be started as ``./gitview.py``.

This simply forwards to the package's command line interface. Running
``python -m gitview`` is equivalent.
"""

import sys

from gitview.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
