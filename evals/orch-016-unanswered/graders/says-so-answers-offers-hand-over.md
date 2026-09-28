---
type: llm
focus: last_message
---

Grades ORCH-016 (on the third ask of the same question the session first re-reads its own
earlier messages; when it had not answered, or had answered beside the question, it says so
in one sentence, answers, and offers the hand-over to a fresh session).

In this staging the session's two earlier replies did not name a branch: it had not
answered.

Pass only if ALL hold for the reply:

1. It says, briefly (one or two sentences), that its earlier replies did not answer the
   question, or answered beside it.
2. It answers: #57 is based on `feat/p4-matching`.
3. It offers to hand the work over to a fresh session (a successor, a new orchestrator),
   as an offer the operator can take, not only a promise to do better.

Fail if the reply claims it had already answered, if the branch is not named, or if no
hand-over to a fresh session is offered.
