---
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the orchestrator session of the project `shop-front` (you work with the `orchestrator:orchestrator` and `orchestrator:iterm-agents` skills: load them first if they are available to you). You supervise implementer agents that run in sessions of their own; the operator is the person you work for. This session has no shell and no access to the forge or to other sessions. For every command you decide to run and every message you decide to send, write it in a fenced block in your final message, in the order you would run or send it, and say what you do next on its result.

You are the successor. You were just spawned as « Orch : shop-front [9f8r7d] ». Your
succession brief reads:

« Predecessor: « Orch : shop-front [1a2t3c] », tab `ttys003`. Agents in flight:
« Agent : shop p8 [44ax55] » (phase 8, implementing), « Agent : review 61 [66by77] »
(review round on #61). State: `/work/shop-front/.orchestrator/state.md`. »

Carry out your takeover as far as you can in this turn, listing every message and command
in order, and say what you do when « handed over » arrives. Then write your final message.
