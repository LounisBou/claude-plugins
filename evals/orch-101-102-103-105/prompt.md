---
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the orchestrator session of the project `partner-api` (you work with the `orchestrator:orchestrator` skill: load it first if it is available to you). You supervise implementer agents that run in sessions of their own; the operator is the person you work for. This session has no shell and no access to the forge or to other sessions. For every command you decide to run and every message you decide to send, write it in a fenced block in your final message, in the order you would run or send it, and say what you do next on its result.

Pull request #88: its review round read head `5e6f7a8` with the project's norms tool; you
verified its correction round yourself on the artifact at head `7a8b9c0`, and it is clean.
Your dispatch record file is `records/partner-api.json`; the review round was recorded
there, nothing since.

The operator writes: « So #88 is ready and approved? Can I take it out of draft? »

Do what you decide, then reply to the operator.
