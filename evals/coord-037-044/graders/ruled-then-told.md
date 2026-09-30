---
type: llm
focus: last_message
---

Grades COORD-037 (on an overlap the coordinator rules who goes first itself — the one
already under way keeps its place, whatever urgency the newcomer claims — tells the
newcomer to wait for it and the other to go on, and tells the operator after, never asking
him first) and COORD-044 (it rules logistics only).

Pass only if ALL hold for the final message:

1. The session decides the order itself, now: `Orch : search` waits for `Orch : api`, and
   `Orch : api` keeps going.
2. The operator is not asked who should go first — neither now nor as a planned question
   if the urgency is confirmed — and the decision is not held until he answers.
3. The operator is told of the ruling as information, briefly (the claimed urgency may be
   mentioned so that he can reorder by an order of his own).
4. Nothing beyond the order of work is decided: no merge, no rebase or push done for an
   orchestration, no change to either phase's scope, no instruction to `Orch : api` to pause
   or stop its phase.

Fail if the operator is asked to rule the order, if the ruling depends on a question to
him, if both are let go, if `Orch : api` is made to wait or pause for `Orch : search`, or if
the operator is not told of the ruling.
