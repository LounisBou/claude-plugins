---
# Grades ORCH-182: the successor is not spawned below the operator mode
type: regex
match: not_contains
---

spawn(?:[^\n]|\\\n)*--successor(?:[^\n]|\\\n)*--permission-mode (default|acceptEdits|plan)
