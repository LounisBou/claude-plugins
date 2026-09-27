---
type: llm
focus: last_message
---

Grades ORCH-180 (succession is the orchestrator's to trigger: at the gate, at the next quiet
boundary, it spawns without waiting or asking and tells the user in one line after the
fact) and ORCH-184 (a project rule that the operator instantiates the orchestrator governs
the first instantiation only, never the succession).

Pass only if ALL hold for the final message:

1. The session spawns its successor now; it does not ask the operator whether to, nor wait
   for them.
2. It does not treat « the operator instantiates the orchestrator » as blocking the
   succession.
3. The operator is told that the succession happens, as information, not as a question.
   The length of the message does not matter: this session has no shell, so the spawn is
   written as a command and the whole message is necessarily written before it runs.

Fail if the session asks, offers a choice, or waits because of the project rule.
