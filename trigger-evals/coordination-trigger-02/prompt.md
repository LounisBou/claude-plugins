---
# intent: a supervisor asks whether anyone else is on a branch
max_turns: 5
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

The api supervisor on this box just asked you whether anyone else is working on `release/2.3` of the api repository before it pushes there. Check what is actually checked out and running on this machine, and answer it.
