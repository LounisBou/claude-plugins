---
type: llm
focus: last_message
---

Grades (an unbound tier is not an error: the launcher then types no model argument
and the host applies its default) and (the map is read before the dispatch; with
the tier the work needs unbound, the orchestrator picks the model it judges fit for the
work, writes the choice and its reason in the brief, and tells the operator in one line at
the spawn, so he can correct it or bind the tier).

Pass only if ALL hold for the commands and the final message:

1. The session reads the empty output as the deep tier being unbound, not as a failure of
   the launcher or of the map.
2. It does not hold phase 5 for it: phase 5 is dispatched now.
3. The model phase 5 runs on is the session's own stated choice: a model named for this one
   spawn (`--model <name>`), or the host's default taken on purpose. Either way the brief
   is amended, before the spawn, with that choice and its reason.
4. Its message tells the operator, in a line, that deep is unbound, which model phase 5
   runs on and why, so he can correct it or bind the tier.
5. It does not rewrite the operator's map on its own.

Fail if phase 5 is held because the tier is unbound, if a model argument is passed without
the choice and its reason in the brief or without the line to the operator, if the choice
is left unstated, if the operator's map is rebound without him, or if the message presents
the deep tier as bound.
