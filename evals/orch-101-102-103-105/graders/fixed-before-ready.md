---
# Grades ORCH-102, ORCH-103: the correction round is recorded before ready is read
# (ready at the fixed head exits 0 only once fixed is on the record)
type: regex
flags: m
---

(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?[^\s"'`]*dispatch-record\.sh["']?[ \t]+fixed\b(?=(?:[^\n]|\\\n)*--head[ =]["']?7a8b9c0\b)[\s\S]*(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?[^\s"'`]*dispatch-record\.sh["']?[ \t]+ready\b(?=(?:[^\n]|\\\n)*--head[ =]["']?7a8b9c0\b)
