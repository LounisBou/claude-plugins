---
type: llm
focus: {source: file, path: briefs/phase-5.md}
---

Grades ORCH-050 (the orchestrator's address is named as its exact ListAgents name and
reference, never left for the agent to discover), ORCH-052 (the agent's first act after
reading is to message that address — the handshake — and nothing is in flight until the
orchestrator has answered) and ORCH-053 (the silence rule: a message expecting an answer
and unanswered after fifteen minutes is re-sent, marked as a re-send, after a fresh
ListAgents, to the session whose name matches; if the name is not listed, the agent tells
the user and stops waiting).

Pass only if ALL hold for the brief:

1. It names the address exactly `Orch : inventory [a3k9c2]`, name AND reference, and does
   not tell the agent to find the orchestrator by a name pattern.
2. It makes messaging that address the agent's first act (a handshake) and says nothing is
   in flight before the orchestrator answers.
3. It states the silence rule: fifteen minutes without an answer means a re-send, after a
   fresh ListAgents, marked as a re-send; and if the name is not listed, the agent tells its
   user and stops waiting.
