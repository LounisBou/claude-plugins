---
# Grades: the correction round is recorded before ready is read
# (ready at the fixed head exits 0 only once fixed is on the record; either command may
# be called directly or through a variable assigned the script's path earlier in the
# output, the same variable or two different ones; a variable never so assigned still
# fails, and ready before fixed still fails)
type: regex
flags: m
---

(?:(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?[^\s"'`]*dispatch-record\.sh["']?[ \t]+fixed\b(?=(?:[^\n]|\\\n)*--head[ =]["']?7a8b9c0\b))[\s\S]*(?:(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?[^\s"'`]*dispatch-record\.sh["']?[ \t]+ready\b(?=(?:[^\n]|\\\n)*--head[ =]["']?7a8b9c0\b))|(?:(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?[^\s"'`]*dispatch-record\.sh["']?[ \t]+fixed\b(?=(?:[^\n]|\\\n)*--head[ =]["']?7a8b9c0\b))[\s\S]*(?:^[ \t]*(\w+)=["']?[^\s"'`]*dispatch-record\.sh["']?[ \t]*$[\s\S]*?(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?\$\{?\1\}?["']?[ \t]+ready\b(?=(?:[^\n]|\\\n)*--head[ =]["']?7a8b9c0\b))|(?:^[ \t]*(\w+)=["']?[^\s"'`]*dispatch-record\.sh["']?[ \t]*$[\s\S]*?(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?\$\{?\2\}?["']?[ \t]+fixed\b(?=(?:[^\n]|\\\n)*--head[ =]["']?7a8b9c0\b))[\s\S]*(?:(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?[^\s"'`]*dispatch-record\.sh["']?[ \t]+ready\b(?=(?:[^\n]|\\\n)*--head[ =]["']?7a8b9c0\b))|(?:^[ \t]*(\w+)=["']?[^\s"'`]*dispatch-record\.sh["']?[ \t]*$[\s\S]*?(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?\$\{?\3\}?["']?[ \t]+fixed\b(?=(?:[^\n]|\\\n)*--head[ =]["']?7a8b9c0\b))[\s\S]*(?:(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?\$\{?\3\}?["']?[ \t]+ready\b(?=(?:[^\n]|\\\n)*--head[ =]["']?7a8b9c0\b))|(?:^[ \t]*(\w+)=["']?[^\s"'`]*dispatch-record\.sh["']?[ \t]*$[\s\S]*?(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?\$\{?\4\}?["']?[ \t]+fixed\b(?=(?:[^\n]|\\\n)*--head[ =]["']?7a8b9c0\b))[\s\S]*(?:^[ \t]*(\w+)=["']?[^\s"'`]*dispatch-record\.sh["']?[ \t]*$[\s\S]*?(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?["']?\$\{?\5\}?["']?[ \t]+ready\b(?=(?:[^\n]|\\\n)*--head[ =]["']?7a8b9c0\b))
