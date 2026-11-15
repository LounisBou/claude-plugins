---
# Grades: no host-expanded variable in the command
type: regex
match: not_contains
---

\$\{?CLAUDE_PLUGIN_ROOT|\$\{[A-Za-z_]+\}
