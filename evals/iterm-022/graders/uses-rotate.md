---
# Grades ITERM-022: the replacement goes through rotate, spawned before the old tab closes
# (a launcher rotate command line, by path or by the SCRIPT variable, quoted or not, naming
# the old tty ttys033 with or without /dev/; backslash continuations allowed)
type: regex
flags: m
---

(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?(?:"(?:[^"\n]*iterm-agent\.sh|\$\{?SCRIPT\}?)"|'[^'\n]*iterm-agent\.sh'|[^\s"'`]*iterm-agent\.sh|\$\{?SCRIPT\}?)[ \t]+rotate\b(?=(?:[^\n]|\\\n)*--old-tty[ =](?:/dev/)?ttys033\b)
