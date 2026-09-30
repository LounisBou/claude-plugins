---
# intent: two supervisors want the same branch within the hour
max_turns: 5
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Two of the supervising sessions on this box, one on the api project and one on the billing project, each just told you they will push to `release/2.3` of the api repository within the hour. Keeping the sessions on this machine out of each other's way is your job here: settle which of them pushes first.
