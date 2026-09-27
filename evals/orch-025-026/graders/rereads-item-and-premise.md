---
type: llm
focus: last_message
---

Grades ORCH-025 (nothing is asked, proposed or reported as pending before its state is
re-read on the artifact by a command in the same turn, never from the state file) and
ORCH-026 (the re-reading covers the question's premise: how the project ships, the target
branch or environment, what it already holds).

Pass only if ALL hold for the final reply:

1. Before any answer, proposal or question about merging, it lists a command re-reading
   #12's current state (for example `gh pr view 12`), run now.
2. It also lists a reading of the premise: how the project ships to production or which
   environment already holds what (release or deploy workflow, tags, staging, what
   production runs).
3. It does not present « draft, review round pending » as #12's current state on the
   strength of the state file, and does not advise merging or deploying before those
   readings.

Fail if the reply answers from the state file, or re-reads #12 but never questions the
« deploy main to production » premise.
