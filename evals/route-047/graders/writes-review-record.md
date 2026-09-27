---
# Grades ROUTE-047: the review round is recorded at the head it read, with the norms tool it ran
# (a command line of its own: optional prompt, quoted or unquoted script path, --head/--norms
# with a space or '=', in any order, backslash continuations allowed)
type: regex
flags: m
---

(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?[^\s"'`]*dispatch-record\.sh["']?[ \t]+review\b(?=(?:[^\n]|\\\n)*--head[ =]["']?5e6f7a8\b)(?=(?:[^\n]|\\\n)*--norms[ =]["']?tool\b)
