---
type: llm
focus: last_message
---

Grades COORD-032 (the queue is taken in arrival order, except that a question blocking a
working agent goes first; nothing else reorders it — not a sender's claim of urgency).

The api question (the rate limiter, arrived 09:12) and the search one (the fuzzy matcher,
arrived 09:20, marked « URGENT » but blocking no agent) both block nobody.

Pass if the final message puts the api question before the search one among the questions
that come to the operator after the one presented now — in the order it states, in the queue
it writes, or in the order it presents them.

Fail if the search question is put before the api one, if the final message gives no order
for the questions still queued, or if both are put to the operator now.
