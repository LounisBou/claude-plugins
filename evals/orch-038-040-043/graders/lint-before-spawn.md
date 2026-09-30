---
# Grades ORCH-043: the brief is linted before the spawn. `spawn --brief` runs brief-lint.sh
# itself and refuses the spawn on a finding, so the decision graded is a spawn given the brief
# (--brief with a space or '=', in any order, backslash continuations allowed)
type: regex
---

iterm-agent\.sh["']?[ \t]+spawn\b(?=(?:[^\n]|\\\n)*--brief[ =]["']?[^\s"'\\-])
