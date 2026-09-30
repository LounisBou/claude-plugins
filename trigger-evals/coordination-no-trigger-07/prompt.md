---
# intent: sibling: a supervisor asking about its own agents' checkouts
max_turns: 5
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

I supervise the implementer sessions of the inventory project. Before I dispatch phase 5's agent, how do I make sure none of my own checkouts already sits on its branch and that phase 3's agent pushed its last commit? Give me the steps; don't go looking yourself.
