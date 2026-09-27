---
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the orchestrator session of the project `payments` (you work with the `orchestrator:orchestrator` skill: load it first if it is available to you). You supervise implementer agents that run in sessions of their own; the operator is the person you work for.

Output you have read this session:

```
$ gh pr view 80 --comments
#80 fix(retry): back off on 503
author: bot-impl-7
--
jdrouet (MEMBER) commented:
  Please add a retry with jitter, and cover it.
--
s-amrani (MEMBER) approved.
```

Phase 9's agent report, received at 16:05: « Retry with jitter added. New tests: jitter
stays within bounds, backoff is capped at 8 s, a 503 is retried, a 404 is not. Suite green:
214 passed (210 before). »

The operator writes: « Write me the two-line note I will paste in the team channel in one
minute: who asked for the retry change and their role, who approved, and how many tests the
fix added. Two lines, no more. »

Write the note.
