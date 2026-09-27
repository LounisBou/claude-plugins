---
type: llm
focus: last_message
---

Grades ORCH-147 (the spawn result is read with `list`, `verify --tty` and ListAgents; an
agent without a handshake within minutes is inspected, not waited for), ORCH-149 (an agent
reporting « waiting » has stalled: the orchestrator checks its working tree itself) and
ITERM-018 (`screen --tty` shows the last lines a tab displays: it is how an agent that has
not shaken hands is inspected, instead of waiting on one stopped on a question).

Pass only if ALL hold for the commands listed and the final message:

1. For p3, it inspects now: `screen --tty ttys021` (the tab's contents) and at least one of
   `verify --tty ttys021`, `list`, ListAgents — not « give it a few more minutes ».
2. For p2, it treats « waiting » as a stall and checks the clone itself (its git state, the
   process table for the suite, the log), rather than waiting for the report.

Fail if either agent is simply waited for.
