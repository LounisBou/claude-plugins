---
# intent: choosing models per request inside a product, not for a dispatch
max_turns: 5
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Our app calls a language model on every request. Add routing so easy requests go to a small model and hard ones to a large one, with a daily cost cap.
