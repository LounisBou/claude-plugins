#!/usr/bin/env python3
"""goals.py: the former entry point of the goals command, kept for a caller that still names it;
the command is goals.ts, run by goals.sh with the same arguments, output and exit codes."""

import os
import sys

os.execv("/bin/bash", ["bash", os.path.join(os.path.dirname(os.path.abspath(__file__)), "goals.sh")] + sys.argv[1:])
