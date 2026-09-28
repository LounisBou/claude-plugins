---
# intent: escalating after a failed dispatch
max_turns: 3
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 5
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

The standard-tier implementer failed the same phase twice. Should the retry go to a stronger model, and how far up?
