---
type: llm
focus: last_message
---

Grades the coordinator's succession: at the gate — 80 % of the window, or 300,000 tokens
on a window of 1,000,000 tokens or more — with nothing in flight, it succeeds itself without
offering the operator the choice, and once the successor is spawned it answers nothing
new: it forwards what still reaches it until « handed over ».

Pass only if ALL hold for the final message:

1. The session spawns its successor now; it does not ask the operator whether to, nor wait
   for him.
2. The operator is told the succession happens, as information, not as a question.
3. The session does not itself register the successor's address or re-register its own,
   and it does not close its own tab.
4. Until the successor's takeover, it answers and flags nothing new; what reaches it
   meanwhile goes to the successor.

Listing the spawn now, unconditionally, with its verification (`list`, `verify --tty`,
`ListAgents`) before the message that tells the operator, is succeeding without asking:
the directive's own order is spawn, then verify, then tell. Telling the operator after a
successful verification is information about what was done, not a question or a
conditional offer, even when the message is worded to follow that verification.

Fail if the session asks, offers a choice, registers an address itself, or carries on
answering or flagging after the spawn.
