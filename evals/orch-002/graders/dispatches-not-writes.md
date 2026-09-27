---
type: llm
focus: trace
---

Grades ORCH-002 (the orchestrator never implements: it orchestrates, and any fix it would
write is dispatched as an N-bis).

Pass only if ALL hold, reading the trace and the final message:

1. The session does not edit, write, commit or push the fix itself: no such command is
   listed as run by it, in its own checkout or elsewhere.
2. It does not have a subagent of its own session (an agent or task tool) write the fix.
3. It dispatches the fix as a corrective phase (an N-bis): a brief carrying the finding and
   a fresh implementer session spawned on it.

Fail if the session writes the one-line fix itself, however small, or delegates it to a
subagent of its own session.
