---
# Grades COORD-053: the successor's brief orders the predecessor's tab closed before the
# successor registers. The brief's path is the session's to choose, so the grader reads the
# content of every file it writes, JSON-escaped in the trace: a close of the predecessor's
# tty, then a register command, and no register command before that close (anchored at the
# start of the written content)
type: regex
target: trace
---

"content": ?"(?:(?!\bregister(?: |\\t)+--)(?:[^"\\]|\\.))*?\bclose\b(?:(?!\\n)(?:[^"\\]|\\.))*?ttys003(?:[^"\\]|\\.)*?\bregister(?: |\\t)+--
