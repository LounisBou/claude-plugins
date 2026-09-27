---
# Grades ITERM-020: the tab is placed with the launcher's move, beside the caller
# (a launcher move command line naming ttys031, with or without /dev/, and --right-of self;
# options in any order, with a space or '=', backslash continuations allowed)
type: regex
flags: m
---

(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?(?:"(?:[^"\n]*iterm-agent\.sh|\$\{?SCRIPT\}?)"|'[^'\n]*iterm-agent\.sh'|[^\s"'`]*iterm-agent\.sh|\$\{?SCRIPT\}?)[ \t]+move\b(?=(?:[^\n]|\\\n)*--tty[ =](?:/dev/)?ttys031\b)(?=(?:[^\n]|\\\n)*--right-of[ =]self\b)
