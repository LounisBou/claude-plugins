# 0008 — One method, one orchestrator

Replaces 0006, whose orchestrator ran in a mode chosen at its start.

**Context.** « Done » was defined five times (the orchestrator's dispatch record, github's
records, implement's close, pr-review's clean pass, norms' pass), plans had three formats, and
each plugin restated parts of the method. Merging implement into the orchestrator would have
loaded an implementation method into sessions that only coordinate, and contradicted the
orchestrator's rule that it never implements. The mode, `build` or `investigate`, was then forced
at every start, while many sessions do both. The operator's ruling
(`q-04cd620e-5ba-mwz59yh4-ail0`, 2026-11-27T15:37:40Z): « Retirer le mode : un seul
orchestrateur. Une enquête devient une ligne dont la livraison est un rapport, et une
modification passe en PR avec la méthode. Les objectifs, les phases et le gate ne s'appliquent
qu'au travail qui finit en PR. »

**Decision.** A `method` plugin owns the lifecycle (spec, goals, plan, brief, implementation,
review on evidence, ready, the operator's merge), the definition of done, the artifact formats,
the question format and the consent protocol: its code lives in `core`, its always-loaded kernel
is held to a fixed ceiling. Every other plugin is a role in that lifecycle and points at it.
implement runs the lifecycle alone, its review made by another session. There is one
orchestrator, with no mode: it loads the lifecycle before planning work that ends in a pull
request, and goals, phases and the ready gate apply to that work alone. An investigation is a row
whose delivery is a report; a change it finds is a new row ending in a pull request.

**Cost.** One more plugin, a dependency of most others; its ceiling is the strictest of the
repository so that it cannot become the next place everything goes. For one release the
orchestrator's scripts accept `--mode` and ignore it, for the lines written before.
