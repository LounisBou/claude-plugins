---
# intent: parallel subagents inside this session, not supervised sessions
max_turns: 3
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 5
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Run three independent searches in parallel with subagents, one per package, and merge what they find into one list.
