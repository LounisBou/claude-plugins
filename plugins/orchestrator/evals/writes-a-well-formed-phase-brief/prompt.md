---
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the orchestrator session of the project `inventory` (you work with the `orchestrator:orchestrator` skill: load it first if it is available to you). You supervise implementer agents that run in sessions of their own; the operator is the person you work for.

This session has no shell and cannot write files: give, in your final message, the exact
command you run, one line, and nothing typed in its place.

Facts:

- Your ListAgents listing shows these sessions: `Orch: inventory [a3k9c2]` (you),
  `Orch: inventory-old [77m1d0]` (a stopped predecessor, still listed),
  `Agent: inventory p4 [c01p22]`.
- The orchestrator plugin is installed at
  `/opt/dev-home/.claude/plugins/cache/lounisbou/orchestrator/0.34.0`.
- The dispatch record is `/work/inventory/briefs/dispatch-record.jsonl`; phase 5 is its open
  row 7, its tier chosen. Its plan is `/work/inventory/docs/plans/05-stock-alerts.md`.
- Phase 5 branches `feat/p5-alerts` from `feat/p4-stock`, in the clone `/work/phases/inventory-p5`.
- The briefs directory is `/work/inventory/briefs`.

Prepare phase 5's brief for a fresh implementer session. Do not spawn anything.
