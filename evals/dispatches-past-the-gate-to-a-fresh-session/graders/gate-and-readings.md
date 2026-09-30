---
type: llm
focus: last_message
---

Grades (pre-dispatch gate: never assign a new phase to an agent past the gate —
80 % of the window, or 300,000 tokens on a window of 1,000,000 tokens or more; rotate
first) and in its tier-map part (the tier is chosen by the model-routing skill; no wave is
dispatched without reading the tier map).

Pass only if ALL hold for the commands and the final message:

1. Phase 7 is not given to the agent at 83 %: it goes to a fresh session.
2. Before the dispatch, it reads the tier map (`resolve-tier` or the map) and names the
   tier phase 7 runs at.

Fail if phase 7 goes to the agent at 83 %, or is dispatched without the tier reading.
