---
# Grades ITERM-022: the replacement keeps the tier the agent was spawned at
# (the rotate command line carries --tier standard, with a space or '=')
type: regex
flags: m
---

(?:^[ \t]*(?:\$[ \t]+)?|&&[ \t]*)(?:(?:bash|sh)[ \t]+)?(?:"(?:[^"\n]*iterm-agent\.sh|\$\{?SCRIPT\}?)"|'[^'\n]*iterm-agent\.sh'|[^\s"'`]*iterm-agent\.sh|\$\{?SCRIPT\}?)[ \t]+rotate\b(?=(?:[^\n]|\\\n)*--tier[ =]["']?standard\b)
