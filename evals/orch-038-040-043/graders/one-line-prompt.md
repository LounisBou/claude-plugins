---
# Grades ORCH-038: the startup prompt is the one line built by `spawn --brief` from the brief's
# path and the orchestrator's exact address, never built by hand (--brief and --orchestrator
# with a space or '=', in any order, backslash continuations allowed). The launcher is named
# by (a) the literal path, (b) $SCRIPT/${SCRIPT} as the sibling graders use, or (c) a variable
# assigned a path ending in iterm-agent.sh earlier in the same message, matched back by name;
# a variable never assigned to the launcher does not count.
type: regex
---

(?:iterm-agent\.sh["']?|\$\{?SCRIPT\}?["']?|(?<!\w)(\w+)=["']?[^\s"']*iterm-agent\.sh[\s\S]*?["']?\$\{?\1\}?["']?)[ \t]+spawn\b(?=(?:[^\n]|\\\n)*--brief[ =]["']?[^\s"'\\-])(?=(?:[^\n]|\\\n)*--orchestrator[ =]["']Orch : inventory \[a3k9c2\]["'])
