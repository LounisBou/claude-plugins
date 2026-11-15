#!/usr/bin/env python3
"""draft_guard.py: the former entry point of the draft guard, kept for a caller that still names
it; the command is draft-guard.ts, run by draft-guard.sh with the same arguments, output and exit
codes."""

import os
import sys

os.execv("/bin/bash", ["bash", os.path.join(os.path.dirname(os.path.abspath(__file__)), "draft-guard.sh")] + sys.argv[1:])
