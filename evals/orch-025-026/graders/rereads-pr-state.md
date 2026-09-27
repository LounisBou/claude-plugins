---
# Grades ORCH-025: #12 state re-read by a command this turn
type: regex
flags: i
---

gh pr (view|checks)(?:[^\n]|\\\n)*\b12\b|gh pr list
