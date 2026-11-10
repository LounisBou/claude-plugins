---
description: Run a decision round over the open questions
allowed-tools: Read, Write, Edit, ListAgents, SendMessage, Bash(${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/dispatch-record.sh:*), Bash(git:*), Bash(gh:*), Bash(ls:*), Bash(date:*)
---

Run a DECISION ROUND with the user. Use it when an agent has sent a STOP that is the
user's to decide, when an entry in the project's register or plan carries a proposed
owner or a proposed reading, when a review returned an arbitration, or when the user
says « one question at a time ». The user arbitrates scope; you decide nothing of
theirs and never ask two things in one message.

**The operator's time is the scarce thing.** His words: ask every pending question one after
the other, so that he loses as little time as possible; then draw the consequences and launch
the work; and if a second wave of questions is needed, chain it. So a round is a WAVE: the questions follow one
another, nothing shown between them; each ruling is relayed to its agent at once, and nothing
is launched or reported until the wave is over.

**While a coordinator runs, the wave goes through it**, carried by the hooks module: each
question ends its turn as step 2 says, and the module forwards it.
The first says in three to five sentences what you work on, for its round of its own where
your questions come together.
Its pane shows each one, the coordinator's tab when the pane is closed;
declare it with `declare_wait` and `urgent: true` only for what step 1 calls urgent.
Its answer, verbatim and dated, is his ruling, recorded as step 4 says. **And each question is
written in full in your own chat too**: his ruling of 2026-11-03, « […] but also and at the
same time in their own chat […], in both. »

## 1. Collect first, then announce the count

Read every pending arbitration before the first question: the agents' STOPs
(their messages — never answered from your own judgment), the entries marked proposed
or to ratify in the project's state file, register and plan, the findings of the last
review that need an owner. Then verify each item STILL OPEN on its own artifact — the pull
request's state and merge, the branch head, the file, the agent's last message — and the
premise its question assumes: how the project ships, which branch or environment is the
target, what that target already holds. A state file or a register says what was true when
written; the user's own merge or close most often settles a question behind it. Collect wide: add the questions the next steps will need from him — a choice the next phase's brief must name, a premise its plan assumes — so that
he answers them now. Every goal
`dispatch-record.sh goals <record> status` lists as `unplanned=` is a question of the wave:
plan it, or rule it out? Write the list to `decision-round.md` in the session's scratch
directory — number, title, where it comes from, status — so the round survives a
compaction, in asking order: the urgent first (a production fault, a detected
regression, a decision under a real deadline), then the oldest first. An item found settled is written there as « already done: <evidence> »,
dropped from the count, and not asked. Announce it in one line, the goals line from the same `goals status`:
« N questions, back to back. Goals: m/n met, open: G3, G4. » A question that arises mid-round is appended as N + 1, announced in one line, and
taken in order; the count in the header moves with it.

## 2. Present ONE question

Re-verify the item and its premise on the artifact in the same turn, immediately before
presenting it: the collection may be an hour old. Found settled, it is written back as
« already done: <evidence> », dropped from the count (N in the header drops with it),
reported in one line, and the next question is presented instead: a settled item is never asked.

The shape is the method's question (`method:lifecycle`, « Questions to the operator »), in the user's
language, one field per line: the operator's pane draws these fields alone. The context names
the goal of `goals.md` the question serves. Close with « You decide: » and the letters offered,
then « or your own words ». Then call
`declare_wait({kind: "operator", blocks: "<the question>"})`. Split references in `blocks` by `, `, never `/`. END THE TURN. Nothing else in
that message but the « Recorded » line of the answer just given: no status, no other
question, no agent report.

## 3. Wait for the answer

Do not proceed on silence; do not assume; do not pick for them, not even the « obvious »
one. A partial or ambiguous
answer gets ONE clarifying line, not a new question. Messages and idle notices from agents
that arrive meanwhile are read and held, never shown and never acted on: nothing stands
between a question and its answer, nor between an answer and the next question. Only a
fact that settles or changes a question still to come is acted on, by updating that
question before it is presented.

## 4. On the answer, in the same turn and in this order

1. « Recorded: <the ruling in one line> » — the user sees their decision written back.
2. Write the ruling first to the orchestration's rulings file, verbatim and dated
   (`references/lifecycle.md`, « Prune the state file before you hand over »), then where
   it applies: the state file or memory, the register entry, the plan — never only the
   chat, or the next session relitigates it. Only the user's ruling is written there. A ruling that rules out a goal is written with
   `dispatch-record.sh goals <record> rule-out <G> --ruling "<his words>"`, so the stop gate
   reads it. A ruling that defers work (« later, when I say so ») is recorded with
   `dispatch-record.sh defer <record> <id> --ruling "<his words, dated>"` for a row and
   `dispatch-record.sh goals <record> defer <G> --ruling "<his words, dated>"` for a goal, never left
   open as a question: the turn then declares `declare_wait({kind: "deferred", blocks: "<n> items"})`, which asks him nothing.
3. Relay it at once, showing nothing of it, to the agent whose STOP it answers, if any — `SendMessage`,
   the ruling verbatim, dated (`date -u +%FT%TZ`, pasted), « the operator ruled » — and mark
   it « relayed » in `decision-round.md`.
4. Present the next question IN FULL (step 2), in this same message, right under the
   « Recorded » line. Nothing else: no launch, no status — they wait for the wave's end
   (step 7), where they cost him nothing.

## 5. Re-present after any interruption

If ANYTHING else was shown to the user between a question and its answer — a status line
you had to write, a notice the host printed — re-present the question IN FULL, in step 2's whole shape, never « as above » or a pointer. A question the user must scroll back to find is a question answered
wrong. Until he answers, every turn re-presents it so: the stop gate logs any turn without it.

## 6. A ruling is not reopened

If later evidence contradicts a ruling, that is a NEW question, with the evidence as its
context, appended to the round. Never re-argue a ruled question inside another one.

## 7. End of the wave, then the next one

« The wave is complete: N/N. » Then, in this same turn:

1. Check every ruling is marked « relayed », and relay one that is not as step 4 says.
2. Draw the consequences and launch the work that depended on the rulings: briefs amended,
   directives corrected in the same move, agents relaunched, sessions spawned.
3. Collect again (step 1): the questions the consequences raise, the STOPs the held agents'
   messages carried, a premise a launch found false. If any is open and he is still there,
   announce « Wave 2: M questions, back to back. » and present its first question in this
   same turn.
4. When no question is left: in one short list, where each ruling was written (file, entry),
   which agent was told, what was launched — and the round ends.

Rules that hold throughout: nothing launched or reported inside a wave, each ruling relayed at once; explanation
before options; nothing decided on their behalf.

$ARGUMENTS
