---
# Grades: rotate is never given --expect-title
# (a rotate command line, at the start of a line, as a fenced block writes it; prose
# that names the flag without invoking rotate does not count)
type: regex
flags: m
match: not_contains
---

(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:[^\s"'`]*iterm-agent\.sh|\$\{?\w+\}?)[ \t]+rotate\b(?:[^\n]|\\\n)*--expect-title
