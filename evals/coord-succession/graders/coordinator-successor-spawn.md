---
# Grades the spawn: the successor is spawned with the coordinator's own flag (a launcher
# spawn line carrying --coordinator-successor, backslash continuations allowed)
type: regex
---

spawn\b(?:[^\n]|\\\n)*--coordinator-successor
