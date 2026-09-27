---
# Grades ORCH-040: the brief is not written under a temporary directory (the run's own
# sandbox home, itself under /private/tmp/e-*/home/, stands for the durable home)
type: tool_used
tool: Write
input_match: "(^|[^A-Za-z0-9_.-])(/tmp/|/var/folders/|/private/tmp/(?!e-[^/\"]+/home/))"
min: 0
max: 0
arm: both
---
