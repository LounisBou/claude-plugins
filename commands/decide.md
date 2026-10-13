---
description: Run a decision round with the user — every open question back to back, one per message, with its context, its choices and their cost, one recommendation; rulings recorded at once, relayed and acted on when the wave ends, and a next wave asked at once if the work raises one
allowed-tools: Read, Write, Edit, ListAgents, SendMessage, Bash(${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/dispatch-record.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh:*), Bash(git:*), Bash(gh:*), Bash(ls:*), Bash(date:*)
---

Run a DECISION ROUND with the user. Use it when an agent has sent a STOP that is the
user's to decide, when an entry in the project's register or plan carries a proposed
owner or a proposed reading, when a review returned an arbitration, or when the user
says « one question at a time ». The user arbitrates scope; you decide nothing that is
theirs, and you never ask two things in one message.

**The operator's time is the scarce thing.** His words: ask every pending question one after
the other, so that he loses as little time as possible; then draw the consequences and launch
the work; and if a second wave of questions is needed, chain it. The goal is the most answers
for the fewest interruptions while he is there. So a round is a WAVE: the questions follow one
another with nothing between them, and nothing is relayed, launched or reported until the wave
is over.

**While a coordinator runs, the wave goes through it.** Before the first question, run
`${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh lookup`. A name printed, and
the round not opened by the user typing this command in this session: every question, in
the shape of step 2, goes to that coordinator with `SendMessage` instead of to him, one per
message, the wave's questions sent together with three to five sentences on what you are
working on — it is his single question interface, and runs them, verbatim, in a decision
round of its own where your questions come together — and the answer it sends back,
verbatim and dated, is his ruling, recorded as step 4 says. Nothing printed,
or the user typed the command here: ask him here.

## 1. Collect first, then announce the count

Read every pending arbitration before asking the first question: the agents' STOPs
(their messages — never answered from your own judgment), the entries marked proposed
or to ratify in the project's state file, register and plan, the findings of the last
review that need an owner. Then verify each item STILL OPEN on its own artifact — the pull
request's state and merge, the branch head, the file, the agent's last message — and the
premise its question assumes: how the project ships, which branch or environment is the
target, what that target already holds. A state file or a register describes what was true
when it was written, and the user's own merge or close is what most often settles a
question behind it. Collect wide: add the questions the next steps will need from him in
any case — a choice the next phase's brief must name, a premise its plan assumes — so that
he answers them now, while he is there, instead of in an interruption later. Every goal
`dispatch-record.sh goals <record> status` lists as `unplanned=` is a question of the wave:
plan it, or rule it out? Write the list to `decision-round.md` in the session's scratch
directory — number, title, where it comes from, status — so the round survives a
compaction. An item found settled is written there as « already done: <evidence> »,
dropped from the count, and not asked. Announce it in one line, the goals line from the same `goals status`:
« N questions, back to back. Goals: m/n met, open: G3, G4. » A question that arises mid-round is appended as N + 1, announced in one line, and
taken in order; the count in the header moves with it.

## 2. Present ONE question, in the user's language, in this exact shape

Re-verify the item and its premise on the artifact in the same turn, immediately before
presenting it: the collection may be an hour old. Found settled, it is written back as
« already done: <evidence> », dropped from the count (N in the header drops with it),
reported in one line, and the next question is presented instead —
a settled item is never asked.

- **Question i of N — the question as a sentence, naming the thing on the screen or in
  the data**, never a bare identifier.
- _Context._ Two to six sentences: what the thing is, where the user meets it, what
  happens today, what the plan or the agent says, and why this is the user's to decide, and which goal of `goals.md` it serves, and what
  stays open after it.
  Plain words. An identifier appears only beside the words that explain it — a bare
  « R63 » or « B-312 » in a question is a defect of the question.
- _The choices._ Two to four, lettered, each carrying its COST and its GAIN in one line,
  and each a materially different piece of work — never shades of one option.
- _Recommendation._ Exactly one, with its reason in one sentence. Put it first among the
  choices only if the tool you present with requires it; otherwise name it here.
- Close with « You decide: A or B? » (the letters offered), then the machine line, plain
  text, as the message's last line: `waiting: operator — blocks: <the question>` — the
  stop gate refuses a turn that ends on a bare question. END THE TURN. Nothing else in
  that message but the « Recorded » line of the answer just given: no status, no other
  question, no agent report.

## 3. Wait for the answer

Do not proceed on silence; do not assume; do not pick for them, not even the « obvious »
one — obvious to you is exactly what a round exists to check. A partial or ambiguous
answer gets ONE clarifying line, not a new question. Messages and idle notices from agents
that arrive meanwhile are read and held, never shown and never acted on: nothing stands
between a question and its answer, nor between an answer and the next question. Only a
fact that settles or changes a question still to come is acted on, by updating that
question before it is presented.

## 4. On the answer, in the same turn and in this order

1. « Recorded: <the ruling in one line> » — the user sees their decision written back.
2. Write the ruling where it lives: the project's state file or memory, the register
   entry, the plan — the durable place, never only the chat. A ruling that exists only in
   a conversation is a ruling the next session relitigates. Only the user's ruling is written
   there; a proposal never is. A ruling that rules out a goal is written with
   `dispatch-record.sh goals <record> rule-out <G> --ruling "<his words>"`, so the stop gate
   reads it. Mark it « to relay » in `decision-round.md`.
3. Present the next question IN FULL (step 2), in this same message, right under the
   « Recorded » line. Nothing else: no relay to an agent, no launch, no status — they all
   wait for the end of the wave (step 7), where they cost him nothing.

## 5. Re-present after any interruption

If ANYTHING else was shown to the user between a question and its answer — a status line
you had to write, a notice the host printed — re-present the question IN FULL when you return to it: the whole shape of step 2, never « as above »,
never a pointer. A question the user must scroll back to find is a question answered
wrong.

## 6. A ruling is not reopened

If later evidence contradicts a ruling, that is a NEW question, with the evidence as its
context, appended to the round. Never re-argue a ruled question inside another one.

## 7. End of the wave, then the next one

« The wave is complete: N/N. » Then, in this same turn:

1. Relay every ruling marked « to relay » to the agent whose STOP it answers —
   `SendMessage`, the ruling verbatim, dated (`date -u +%FT%TZ`, pasted), « the operator
   ruled » — and subscribe to its idle notice.
2. Draw the consequences and launch the work that depended on the rulings: briefs amended,
   directives corrected in the same move, agents relaunched, sessions spawned.
3. Collect again (step 1): the questions the consequences raise, the STOPs the held agents'
   messages carried, a premise a launch found false. If any is open and he is still there,
   announce « Wave 2: M questions, back to back. » and present its first question in this
   same turn — a second wave chained at once costs him far less than one asked later.
4. When no question is left: in one short list, where each ruling was written (file, entry),
   which agent was told, what was launched — and the round ends.

Rules that hold throughout: one question per message, the next one presented the moment
the last is answered; nothing relayed, launched or reported inside a wave; explanation
before options; a recommendation always; the cost inside the choice, not after the decision; never a bare
identifier; the user's language; nothing decided on their behalf.

$ARGUMENTS
