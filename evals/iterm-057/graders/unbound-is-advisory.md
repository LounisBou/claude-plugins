---
type: llm
focus: last_message
---

Grades ITERM-057 (an unbound tier is not an error: the launcher then types no model argument
and the host applies its default) and ROUTE-007 (the map is read before the dispatch; with a
tier unbound the routing table is advisory and that is said, never assumed applied).

Pass only if ALL hold for the commands and the final message:

1. The session reads the empty output as the deep tier being unbound, not as a failure
   of the launcher or of the map.
2. It does not hold phase 5 for it: phase 5 is dispatched now on the host's default, the
   spawn carrying no model argument (`--tier deep`, which resolves to nothing, or no tier
   at all). It does not rewrite the operator's map on its own.
3. It tells the operator that deep is unbound, so the tier routing is not applied (advisory)
   until the operator binds it.

Fail if phase 5 is held because the tier is unbound, if the spawn carries a model argument
(`--model`, `--inherit-model`, or a model named for this one spawn), if the operator's map is
rebound without them, or if the message presents the deep tier as bound or applied.
