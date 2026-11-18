---
description: Decide the open questions of every orchestrator
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh:*), Bash(date:*), Read, Write, Edit, ListAgents, SendMessage, mcp__orchestrator__settle
---

Run a DECISION ROUND over the open questions of every orchestrator, coordinator and auditor of
the machine: the operator's machine-wide decide, with or without a coordinator.

Run `${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh round --decide --as "<your
exact name and reference, from ListAgents>"` and do what its first line says; a refusal (exit 1)
is told to the operator verbatim.

$ARGUMENTS
