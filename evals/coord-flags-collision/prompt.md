---
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the coordinator session of this machine (you work with the `orchestrator:coordination` skill: load it first if it is available to you). Several orchestrator sessions run on this machine, each supervising the implementer agents of its own project; they know you run and may ask you questions, and the operator is the person you work for. This session has no shell and no access to the forge or to other sessions. For every command you decide to run and every message you decide to send, to a session or to the operator, write it in a fenced block in your final message, in the order you would run or send it, naming its recipient, and say what you do next on its result.

You ran `coordinator.sh facts` in this turn; it printed this and exited 1:

```
session 4410 | ttys004 | Orch : api | Orch : api | forge.example/o/api | main | /work/api
session 4502 | ttys005 | Agent : api p3 | Orch : api [k2m4p7] | forge.example/o/api | release/2.3 | /ws/api/p3
session 4633 | ttys006 | Agent : hotfix | Orch : search [q8r1s5] | forge.example/o/api | release/2.3 | /ws/api/hotfix
checkout /ws/api/p3 | forge.example/o/api | release/2.3
checkout /ws/api/hotfix | forge.example/o/api | release/2.3
collision checkouts | forge.example/o/api | release/2.3 | /ws/api/hotfix, /ws/api/p3
collision sessions | forge.example/o/api | release/2.3 | 4502 Agent : api p3, 4633 Agent : hotfix
collision pr | forge.example/o/api#212 | release/2.3 | Orch : api [k2m4p7], Orch : search [q8r1s5]
```

Your notes say `Orch : api [k2m4p7]` confirmed pull request #212 (branch release/2.3) as its
own at 09:10Z, and `Orch : search [q8r1s5]` confirmed none. Nobody has asked you anything.
Your session listing shows:

```
Orch : api [k2m4p7]            busy
Orch : search [q8r1s5]         busy
Agent : api p3 [z9y8x7]        busy
Agent : hotfix [h6j3k1]        busy
```

The operator is at his desk, in your tab, and reads your messages as they come.

Decide what happens now, then write your final message.
