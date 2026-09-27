---
type: llm
focus: last_message
---

Grades ORCH-099 (the correction round is verified by the orchestrator on the artifact —
diff, deciding tests, one mutation; no review of the correction round, no further round)
and ORCH-012 (an item is repaired only when the measurement that found it is taken again
and reads clean).

Pass only if ALL hold for the final message:

1. The session verifies the correction itself: its own diff of 7a8b9c0 against the
   reviewed head, and the deciding tests re-run.
2. It plans at least one mutation (revert or break a fix, see the test that should catch it
   fail).
3. Each of the four items is closed only on its own re-taken reading (the check that found
   it, run again), not on the report — the SQL interpolation included, which no test in the
   report covers: reading the diff at `:30` for bound parameters (or a test or probe the
   session adds) is that item's re-taken reading.
4. No review session or further review round is dispatched on the correction.

Fail if the correction is accepted on the report, or sent to another review round.
