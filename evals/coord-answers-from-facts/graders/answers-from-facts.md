---
type: llm
focus: last_message
---

Grades the coordinator's answer to « may I or must I wait »: it answers from the facts it
read, and they are what the answer rests on.

Pass only if ALL hold for the final message:

1. A reply goes to `Orch : billing`.
2. That reply names the one fact that bears on the question: a heavy run already under way
   — the test suite (pid 7781) of the api orchestration, in /ws/api/p3 — and that nothing
   else collides with billing.

Fail if no reply goes to `Orch : billing`, or if it does not mention the running api suite.
