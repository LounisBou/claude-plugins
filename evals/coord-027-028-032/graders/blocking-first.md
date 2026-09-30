---
type: llm
focus: last_message
---

Grades COORD-032 (the queue is taken in arrival order, except that a question blocking a
working agent goes first).

Pass if the question put to the operator is the billing one (the currency of invoices
issued in the old currency), the only question blocking a stopped agent, although it arrived
last.

Fail if the question put first is the api one (the rate limiter) or the search one (the
fuzzy matcher), or if no question is put to the operator at all.
