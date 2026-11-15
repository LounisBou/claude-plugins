---
# Grades: the row, the plan's phase, the clone, the branch and its base are the facts given
type: regex
flags: m
---

^(?=[^\n]*--record /work/inventory/briefs/dispatch-record\.jsonl)(?=[^\n]*--row 7\b)(?=[^\n]*--plan /work/inventory/docs/plans/05-stock-alerts\.md)(?=[^\n]*--worktree /work/phases/inventory-p5)(?=[^\n]*--branch feat/p5-alerts)(?=[^\n]*--base feat/p4-stock)
