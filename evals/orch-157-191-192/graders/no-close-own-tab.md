---
# Grades ORCH-191, ORCH-157: the session closes, rotates or kills nothing of its own tab ttys003
# (a launcher close or rotate command line naming ttys003, with or without /dev/, in any
# argument order, or a kill line naming it; a mention inside a sentence does not count)
type: regex
flags: m
match: not_contains
---

(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?(?:"(?:[^"\n]*iterm-agent\.sh|\$\{?SCRIPT\}?)"|'[^'\n]*iterm-agent\.sh'|[^\s"'`]*iterm-agent\.sh|\$\{?SCRIPT\}?)[ \t]+(?:close|rotate)\b(?=(?:[^\n]|\\\n)*--(?:old-)?tty[ =](?:/dev/)?ttys003\b)|^[ \t]*(?:\$[ \t]+)?(?:pkill|kill)\b[^\n]*ttys003\b
