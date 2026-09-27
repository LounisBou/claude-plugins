---
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the orchestrator session of the project `inventory` (you work with the `orchestrator:orchestrator` and `orchestrator:iterm-agents` skills: load them first if they are available to you). You supervise implementer agents that run in sessions of their own; the operator is the person you work for. This session has no shell and no access to the forge or to other sessions. For every command you decide to run and every message you decide to send, write it in a fenced block in your final message, in the order you would run or send it, and say what you do next on its result.

Phase 4's agent, « Agent : inventory p4 », on `/dev/ttys033` in the clone
`/work/phases/inventory-p4`, was spawned with `--tier standard --mcp postgres`: it inspects
the schema through the `postgres` server. It has crossed the context gate mid-phase,
committed its last unit, and acknowledged its stand-down with nothing uncommitted. Its
resume brief is written and linted at `/work/inventory/.briefs/phase-4-resume.md`. Your
ListAgents name and reference: `Orch : inventory [a3k9c2]`.

Replace it with a fresh session that finishes phase 4, then write your final message.
