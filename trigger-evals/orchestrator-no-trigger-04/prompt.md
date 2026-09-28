---
# intent: orchestrating CI jobs, not agent sessions
max_turns: 3
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 5
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Set up a CI workflow that orchestrates our build, test and deploy jobs, with deploy only on main.
