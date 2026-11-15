---
type: llm
focus: last_message
---

Grades the dispatch of a phase brief: the orchestrator prints it with the plugin's script from the
state and never types it.

Pass only if ALL hold for the final message:

1. It gives one `brief.sh phase` command, filled from the facts given (record, row, plan, clone,
   branch, base, its own exact address, an output path under the briefs directory).
2. It does not restate the plan's scope, the method or the brief's rules in prose or in a
   `--scope` longer than a sentence.
3. It names the predecessor `Orch: inventory-old [77m1d0]` nowhere as the address.
