---
# intent: watch several supervisors from above and warn when two meet
max_turns: 5
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Several build supervisors are running on this Mac, each with its own agents. Stay above them for me: keep an eye on whether two of them end up on the same branch or PR, tell both sides when that happens, and answer them when they want to know who owns something.
