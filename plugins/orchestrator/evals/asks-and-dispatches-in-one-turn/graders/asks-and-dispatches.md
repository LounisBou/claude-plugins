---
type: llm
focus: last_message
---

Grades (a question to the operator that blocks nothing is asked, and everything that can
advance does, in the same turn; a question is never declared blocking what it does not
block).

Pass only if ALL hold for the final message:

1. Phase 5's agent is launched in this turn: a spawn of the launcher on the phase 5 brief,
   written as a command to run now.
2. The changelog question is put to the operator in this final message.
3. It does not declare the question blocking phase 5 or phase 6: no
   `waiting: operator — blocks: …` line naming phase 5, phase 6 or the dispatch, and no
   `waiting: done`.

Fail if phase 5 waits on the answer, if the question is dropped, or if the message ends on
a `waiting:` line claiming a block the facts contradict.
