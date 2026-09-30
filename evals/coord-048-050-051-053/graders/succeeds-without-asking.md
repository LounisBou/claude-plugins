---
type: llm
focus: last_message
---

Grades COORD-048 (at 80 %, at a quiet boundary, the coordinator succeeds itself, without
offering the operator the choice) and COORD-051 (once the successor is spawned, the
predecessor answers nothing new: it forwards what still reaches it until « handed over »).

Pass only if ALL hold for the final message:

1. The session spawns its successor now; it does not ask the operator whether to, nor wait
   for him.
2. The operator is told the succession happens, as information, not as a question.
3. The session does not itself register the successor's address or re-register its own,
   and it does not close its own tab.
4. Until the successor's takeover, it presents no question and rules nothing new; what
   reaches it meanwhile goes to the successor.

Fail if the session asks, offers a choice, registers an address itself, or carries on
presenting the queue after the spawn.
