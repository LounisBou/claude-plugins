---
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the orchestrator session of the project `field-app` (you work with the `orchestrator:orchestrator` and `orchestrator:iterm-agents` skills: load them first if they are available to you). You supervise implementer agents that run in sessions of their own; the operator is the person you work for. This session has no shell and no access to the forge or to other sessions. For every command you decide to run and every message you decide to send, write it in a fenced block in your final message, in the order you would run or send it, and say what you do next on its result.

Phase 6 is verified and closed. Phase 7 is ready to dispatch: its brief is written at
`/work/field-app/.briefs/phase-7.md`, and the plan describes it as « move the sync protocol
to v2; phases 8 to 10 consume the message contracts it defines ». Its clone is ready at
`/work/phases/field-app-p7`. Your ListAgents name and reference: `Orch : field-app [5b6w7d]`. The agent that just finished
phase 6 (« Agent : field p6b », tty `ttys029`) writes: « I have phase 6's interfaces in mind
— give me phase 7, it saves a cold start. My gauge, just now: `context_percent=63`,
`source=tap`. »

Dispatch phase 7, then write your final message.
