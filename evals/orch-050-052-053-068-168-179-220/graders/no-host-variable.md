---
# Grades ORCH-220: no host-expanded variable in the brief
type: regex
target: {source: file, path: briefs/phase-5.md}
match: not_contains
---

\$\{?CLAUDE_PLUGIN_ROOT|\$\{[A-Za-z_]+\}
