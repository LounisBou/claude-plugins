---
# intent: sibling: supervising a phased build
max_turns: 3
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 5
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Plan how to deliver this build as phases, each one built by a separate implementer session as a stacked PR, with you supervising and verifying each delivery.
