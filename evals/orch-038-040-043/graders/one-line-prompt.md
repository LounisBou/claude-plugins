---
# Grades ORCH-038: the startup prompt is the one line built by `spawn --brief` from the brief's
# path and the orchestrator's exact address, never built by hand (--brief and --orchestrator
# with a space or '=', in any order, backslash continuations allowed)
type: regex
---

iterm-agent\.sh["']?[ \t]+spawn\b(?=(?:[^\n]|\\\n)*--brief[ =]["']?[^\s"'\\-])(?=(?:[^\n]|\\\n)*--orchestrator[ =]["']Orch : inventory \[a3k9c2\]["'])
