---
# Grades ORCH-102: the correction round recorded at the verified head
# (a command line of its own: quoted or unquoted script path, --head with a space or '=',
# backslash continuations allowed; a mention inside a sentence does not count)
type: regex
flags: m
---

(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?[^\s"'`]*dispatch-record\.sh["']?[ \t]+fixed\b(?=(?:[^\n]|\\\n)*--head[ =]["']?7a8b9c0\b)
