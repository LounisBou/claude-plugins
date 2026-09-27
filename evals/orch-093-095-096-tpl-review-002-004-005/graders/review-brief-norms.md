---
type: llm
focus: {source: file, path: briefs/review-88.md}
---

Grades ORCH-095 (the norms check runs in the round's review session on the pinned worktree,
report-only; its exit code is not a verdict), ORCH-096 (the norms lens is the project's own
tool wherever the project ships one) and TPL-REVIEW-002 (where the norms check names a
command, the review agent runs it; if the machine cannot afford it, it says so and stops,
never substituting a hand reading).

Pass only if ALL hold for the brief:

1. It has the review session run `make norms` itself, on the pinned worktree, as a
   report-only reading whose exit code is not a verdict.
2. It forbids replacing that run by a hand reading of the norms: if the run cannot be
   afforded, the agent says so and stops.
