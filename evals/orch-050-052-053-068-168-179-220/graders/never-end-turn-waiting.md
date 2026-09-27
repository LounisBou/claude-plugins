---
# Grades ORCH-068: the agent never ends its turn waiting for a run
# (never / must not / do not / don't / cannot, then end a, your, the or its turn or turns)
type: regex
flags: i
target: {source: file, path: briefs/phase-5.md}
---

\b(?:never|must not|mustn't|mustn’t|do not|don't|don’t|cannot|can't|can’t)\s+end\s+(?:(?:a|your|the|its)\s+)?turns?\b
