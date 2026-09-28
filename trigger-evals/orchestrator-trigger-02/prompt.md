---
# intent: verifying an implementer's delivery before the next phase
max_turns: 3
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 5
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

The implementer on phase 3 says its PR is done and the tests are green. Verify its delivery before we let phase 4 start.
