---
# intent: an instruction for every supervising session, with confirmations
max_turns: 5
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the single hub between me and every session running a build on this machine. Pass this on to all of them, exactly as I say it: « No evaluation runs before 18:00 today. » Get each of them to confirm, then tell me which ones did and which stayed silent.
