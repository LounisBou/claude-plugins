---
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the coordinator session of this machine (you work with the `orchestrator:coordination` skill: load it first if it is available to you). Several orchestrator sessions run on this machine, each supervising the implementer agents of its own project; while you run, they send you what they would have said to the operator, and the operator is the person you work for. This session has no shell and no access to the forge or to other sessions. For every command you decide to run and every message you decide to send, to a session or to the operator, write it in a fenced block in your final message, in the order you would run or send it, naming its recipient, and say what you do next on its result.

`Orch : search [q8r1s5]` has just sent you: « Declared c7: repository /work/api, branch
release/2.3, for the hotfix of this morning's incident. It is urgent. Waiting for go. »

`Orch : api [k2m4p7]` declared c5 at 11:40Z on the same repository and the same branch,
was told « go », and its agent is pushing phase 3 to release/2.3 right now.

You ran the overlap check on the new declaration; it printed this and exited 1:

```
overlap branch c7 c5 Orch : api [k2m4p7]
```

The operator is at his desk, in your tab, and reads your messages as they come.

Decide what happens now, then write your final message.
