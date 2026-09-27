---
type: llm
focus: last_message
---

Grades ORCH-007 (every delivery is verified on the artifact, never on the agent's report; a
delivery not diffed by the orchestrator is never approved), ORCH-011 (« written » and
« green » are not « done »: a report is a claim, checked on the repository, the process
table or the running artifact) and ORCH-088 (claimed command output is a claim, cleanup
claims included: re-run the command that decides the verdict or check the artifact).

Pass only if ALL hold for the final message:

1. Before any verdict, it lists the session's own diff of `feat/p4-facets` at 9c8d7e6
   (against its base).
2. It re-runs the deciding command itself (the test suite, at least), rather than quoting
   « 212 passed ».
3. It does not approve phase 4 on the strength of the report: the verdict is conditional
   on those readings, or deferred until they are taken.

Fail if the delivery is approved, or declared ready, from the report.
