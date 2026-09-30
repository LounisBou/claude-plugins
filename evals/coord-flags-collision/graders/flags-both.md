---
type: llm
focus: last_message
---

Grades the coordinator's flag: a collision the facts show is told to both orchestrations
concerned, each naming the other.

Pass only if ALL hold for the final message:

1. A message goes to `Orch : api` and a message goes to `Orch : search` (one to each, or one
   addressed to both), each naming the other orchestrator and the shared ground: pull
   request #212, the branch release/2.3, or the two checkouts on it.
2. No message is sent to either `Agent :` session.

Fail if either orchestrator is left untold, if a message does not say who the other is, or if
an agent is addressed directly.
