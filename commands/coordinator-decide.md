---
description: Run, in the coordinator's tab, one decision round over the open questions of every orchestrator — the urgent first, then the oldest, across senders — each ruling relayed verbatim to the orchestrator that asked
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh:*), Bash(date:*), Read, Write, Edit, ListAgents, SendMessage
---

Run a DECISION ROUND as the COORDINATOR described in `orchestrator:coordination`, over the
open questions of every orchestrator in its round. Load that skill first. This runs only in
the coordinator's session: anywhere else, say so in one line and stop.

The round's shape is `/orchestrator:decide`'s, read from `commands/decide.md` and followed as
written: one question per message, in its step 2 shape, with its context, its choices and
one recommendation; nothing on silence; a question re-presented in full after any
interruption; a ruling never reopened. The coordination skill's rules for relayed questions
hold too: the question, its context, its choices and its recommendation are the sender's,
verbatim, and you add nothing of your own. Only what follows differs.

1. **The source.** `${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh round
   --by-urgency`: its open `operator` entries are the round, every one of them, due or not,
   whether the pane is open or closed, plus the questions that reached you by message and are
   still open in your ledger. Each is written to `decision-round.md` first, as the coordination
   skill's ledger says. A closing proposal (`done`) is presented as the skill says, outside
   this round.
2. **The order.** As `--by-urgency` prints them: the urgent first, then by `since`, the
   oldest first, across senders, with no grouping by orchestrator. A question received by
   message takes its place by the time you received it. Announce the count in one line:
   « Round by `<your exact name>`: N questions, the urgent first, from `<sender>` (3),
   `<sender>` (1). »
3. **The sender in each question.** Its first line names who asks: « Question i of N — from
   `<sender's exact name>` ». The first question of each sender carries that sender's context
   block, three to five sentences in its own words, as the coordination skill's step 4 says.
4. **Re-verify before presenting.** Run `round --by-urgency` again just before each question:
   an entry answered in the pane or withdrawn by its sender meanwhile is not asked; write it
   back in the ledger and present the next one instead, the count moving with it.
5. **The relay, on each answer, in the same turn.** « Recorded: <his ruling> »; the ruling
   verbatim and dated (`date -u +%FT%TZ`, pasted) to the sender, by `SendMessage` to its
   exact `ListAgents` name, « the operator answered »; for an entry of the round,
   `coordinator.sh round-close <id> --answer "<his words>"`; marked sent in the ledger; then
   the next question in full in the same message. The relay goes with each answer, never held
   for the end: each orchestrator waits on its own.
6. **The end line.** « The round is complete: N/N. » — then one short list: each ruling, the
   line of the ledger that holds it, and the sender told.

$ARGUMENTS
