---
# Grades ORCH-043: the brief is linted before the spawn. `spawn --brief` runs brief-lint.sh
# itself and refuses the spawn on a finding, so the decision graded is a spawn given the brief
# (--brief with a space or '=', in any order, backslash continuations allowed). The launcher
# is named by (a) the literal path, (b) $SCRIPT/${SCRIPT} as the sibling graders use, or
# (c) a variable assigned a path ending in iterm-agent.sh earlier in the same message,
# matched back by name; a variable never assigned to the launcher does not count.
type: regex
---

(?:iterm-agent\.sh["']?|\$\{?SCRIPT\}?["']?|(?<!\w)(\w+)=["']?[^\s"']*iterm-agent\.sh[\s\S]*?["']?\$\{?\1\}?["']?)[ \t]+spawn\b(?=(?:[^\n]|\\\n)*--brief[ =]["']?[^\s"'\\-])
