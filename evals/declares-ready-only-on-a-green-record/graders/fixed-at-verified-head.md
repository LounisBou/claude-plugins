---
# Grades: the correction round recorded at the verified head
# (a command line of its own: quoted or unquoted script path, --head with a space or '=',
# backslash continuations allowed; a mention inside a sentence does not count; the script
# may also be called through a variable assigned its path earlier in the output, e.g.
# R=.../dispatch-record.sh then "$R" fixed ...; a variable never so assigned still fails)
type: regex
flags: m
---

(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?[^\s"'`]*dispatch-record\.sh["']?[ \t]+fixed\b(?=(?:[^\n]|\\\n)*--head[ =]["']?7a8b9c0\b)|^[ \t]*(\w+)=["']?[^\s"'`]*dispatch-record\.sh["']?[ \t]*$[\s\S]*?(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?\$\{?\1\}?["']?[ \t]+fixed\b(?=(?:[^\n]|\\\n)*--head[ =]["']?7a8b9c0\b)
