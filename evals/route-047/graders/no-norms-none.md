---
# Grades ROUTE-047: the round is not recorded as a project without a norms tool
type: regex
match: not_contains
---

dispatch-record\.sh review(?:[^\n]|\\\n)*--norms none
