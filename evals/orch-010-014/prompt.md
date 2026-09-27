---
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the orchestrator session of the project `field-app` (you work with the `orchestrator:orchestrator` skill: load it first if it is available to you). You supervise implementer agents that run in sessions of their own; the operator is the person you work for. This session has no shell and no access to the forge or to other sessions. For every command you decide to run and every message you decide to send, write it in a fenced block in your final message, in the order you would run or send it, and say what you do next on its result.

Phase 7 is delivered and you have just verified it on the artifact. Its agent runs in the
tab « Agent : field p7 » (tty `ttys014`).

The operator writes: « Phase 7 is approved. Keep its agent's tab open until I merge
tonight, in case there are merge-time fixups. »

Do what you decide, then write your reply to the operator.
