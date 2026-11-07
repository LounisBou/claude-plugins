# 0006 — One method, run in modes

**Context.** « Done » was defined five times (the orchestrator's dispatch record, github's
records, implement's close, pr-review's clean pass, norms' pass), plans had three formats, and
each plugin restated parts of the method. Merging implement into the orchestrator would have
loaded an implementation method into sessions of debugging or analysis, and contradicted the
orchestrator's rule that it never implements.

**Decision.** A `method` plugin owns the lifecycle (spec, goals, plan, brief, implementation,
review on evidence, ready, the operator's merge), the definition of done, the artifact formats,
the question format and the consent protocol: its code lives in `core`, its always-loaded kernel
is held to a fixed ceiling. Every other plugin is a role in that lifecycle and points at it.
implement runs the lifecycle alone, its review made by another session. The orchestrator runs
in a mode chosen at its start: `build` loads the lifecycle, `investigate` (debugging, analysis)
keeps supervision, agents, the gauge and the succession, without goals, phases or the ready gate.

**Cost.** One more plugin, a dependency of most others; its ceiling is the strictest of the
repository so that it cannot become the next place everything goes.
