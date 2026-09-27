---
# Grades ITERM-019: the close is by tty with an expected title
# (a launcher command line of its own, by path or by the SCRIPT variable, quoted or not;
# options in any order, with a space or '=', backslash continuations allowed)
type: regex
flags: m
---

(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?(?:"(?:[^"\n]*iterm-agent\.sh|\$\{?SCRIPT\}?)"|'[^'\n]*iterm-agent\.sh'|[^\s"'`]*iterm-agent\.sh|\$\{?SCRIPT\}?)[ \t]+close\b(?=(?:[^\n]|\\\n)*--tty[ =]\S)(?=(?:[^\n]|\\\n)*--expect-title[ =]\S)
