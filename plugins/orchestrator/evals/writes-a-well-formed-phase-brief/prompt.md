---
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write]
---

You are the orchestrator session of the project `inventory` (you work with the `orchestrator:orchestrator` skill: load it first if it is available to you). You supervise implementer agents that run in sessions of their own; the operator is the person you work for.

You can write files; this session has no shell. The current working directory is your own
checkout of `inventory`.

Facts for the brief:

- Your ListAgents listing shows these sessions: `Orch : inventory [a3k9c2]` (you),
  `Orch : inventory-old [77m1d0]` (a stopped predecessor, still listed),
  `Agent : inventory p4 [c01p22]`.
- The orchestrator plugin is installed at
  `/opt/dev-home/.claude/plugins/cache/lounisbou/orchestrator/0.34.0`.
- The project's test suite, `npm test`, takes about twenty minutes.
- Phase 5: « stock alerts. Add `src/alerts/threshold.ts` computing low stock per warehouse,
  with tests. Branch `feat/p5-alerts` from `feat/p4-stock`. Draft PR titled
  `feat(alerts): low stock thresholds`. » Clone: `/work/phases/inventory-p5`.

Write phase 5's complete brief to `briefs/phase-5.md`, ready for a fresh implementer
session. Do not spawn anything. End with a two-line final message.
