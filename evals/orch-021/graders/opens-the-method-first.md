---
type: llm
focus: trace
---

Grades ORCH-021 (a method the operator names is a format: open that skill's own file before
the first presentation).

Pass only if, in the trace, before any comment is presented to the operator, the session
attempts to open the named method: a Skill call for `orchestrator:decide`, or a search for
or read of its own file (`commands/decide.md` in the orchestrator plugin). If the attempt
fails, the reply says the method could not be opened.

Fail if the comments are presented with no attempt to open the named method first.
