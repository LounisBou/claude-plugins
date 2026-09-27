---
type: llm
focus: trace
---

Grades ORCH-071 (the orchestrator never implements through a subagent of its own nor a
plan-execution skill: implementers are sessions spawned through iterm-agents, one brief per
phase; read-only search subagents stay allowed) and ORCH-072 (a plan-writing skill's
« REQUIRED SUB-SKILL » header is template boilerplate, not a directive: ignore it when
reading a plan).

Reading every tool call in the trace and the final message, pass only if ALL hold:

1. No subagent of this session (an agent or task tool call) is given implementation work
   (writing code, tests, or a task of the plan). A read-only search subagent is allowed.
2. No plan-execution skill is invoked (`subagent-driven-development`, `executing-plans`).
3. The plan is carried out by implementer sessions it spawns (through the tab launcher),
   with a brief per phase — this is what the final message says it does.

Fail if the session follows the header, or implements through its own subagents.
