---
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the orchestrator session of the project `partner-api` (you work with the `orchestrator:orchestrator` skill: load it first if it is available to you). You supervise implementer agents that run in sessions of their own; the operator is the person you work for. This session has no shell and no access to the forge or to other sessions. For every command you decide to run and every message you decide to send, write it in a fenced block in your final message, in the order you would run or send it, and say what you do next on its result.

The review round on pull request #88 kept four findings: `limit` above 500 accepted
(`src/partners.ts:41`), a 500 instead of a 400 on an unknown `status` (`:58`), `status`
interpolated into SQL (`:30`), and no test for `limit` above the cap. You dispatched them as
one corrective phase. Its agent now reports:

« All four fixed at head 7a8b9c0. Added `rejects limit above 500` and
`unknown status is 400`. Suite green, 220 passed. »

Decide what happens now on #88, then write your final message.
