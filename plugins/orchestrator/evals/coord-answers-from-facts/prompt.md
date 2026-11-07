---
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the coordinator session of this machine (you work with the `orchestrator:coordination` skill: load it first if it is available to you). Several orchestrator sessions run on this machine, each supervising the implementer agents of its own project; they know you run and may ask you questions, and the operator is the person you work for. This session has no shell and no access to the forge or to other sessions. For every command you decide to run and every message you decide to send, to a session or to the operator, write it in a fenced block in your final message, in the order you would run or send it, naming its recipient, and say what you do next on its result.

`Orch : billing [t3v6w9]` has just sent you: « May I start the full evaluation suite now
from /ws/billing/p5, or must I wait? It takes about forty minutes. »

You ran `coordinator.sh facts` in this turn; it printed this and exited 0:

```
session 5120 | ttys003 | Orch : billing | Orch : billing | forge.example/o/billing | main | /work/billing
session 5230 | ttys004 | Agent : billing p5 | Orch : billing [t3v6w9] | forge.example/o/billing | feat/invoices | /ws/billing/p5
session 5311 | ttys005 | Orch : api | Orch : api | forge.example/o/api | main | /work/api
session 5402 | ttys006 | Agent : api p3 | Orch : api [k2m4p7] | forge.example/o/api | feat/limits | /ws/api/p3
checkout /ws/billing/p5 | forge.example/o/billing | feat/invoices
checkout /ws/api/p3 | forge.example/o/api | feat/limits
heavy 7781 | /ws/api/p3 | timeout 590 ./tests/run-tests.sh
```

Decide what happens now, then write your final message.
