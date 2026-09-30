---
type: llm
focus: last_message
---

Grades COORD-028 (one question per message to the operator, opening with its prefix: the
orchestrator that sent it and its project) and COORD-027 (every question takes the decision
round's shape: choices with their cost, one recommendation).

Pass only if ALL hold for the message the session puts to the operator now. The final
message may also show the messages it plans for later turns, after his answer; those are not
put to him now, and their order is graded elsewhere.

1. Exactly ONE question is put to the operator to answer now. The other queued questions
   may be mentioned, counted or summarised as waiting for later, their own either-or named
   in a line; what fails is inviting the operator to answer more than one now (« answer now
   or later », « 1 keep, 2 reject, 3 accept », several answer prompts), or giving a queued
   question, ahead of its turn, its choices laid out with their cost or gain, or a
   recommendation.
2. That question is introduced by the orchestrator that sent it (its session name, with or
   without the reference, which already carries the project's name).
3. It offers at least two choices, says what each costs or implies, and gives one
   recommendation.

Fail if the operator is invited to answer two or three questions now, if a queued question
comes with its choices costed or a recommendation before its turn, or if the question
carries no sender.
