---
# intent: a supervising session checks its own fill against its gate before sending work out
max_turns: 5
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Hold on before sending phase 3 out to the implementer: are you under 80% yourself? Check, don't guess.
