---
# Grades ITERM-051: rotate is never given --expect-title
type: regex
match: not_contains
---

(\$\{?\w+\}?|iterm-agent\.sh)\s+rotate\b(?:[^\n]|\\\n)*--expect-title
