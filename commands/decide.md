---
description: Run a decision round with the user — every open question one at a time, with its context, its choices and their cost, one recommendation, and each ruling recorded and relayed before the next
allowed-tools: Read, Write, Edit, ListAgents, SendMessage, Bash(git:*), Bash(gh:*), Bash(ls:*), Bash(date:*)
---

Run a DECISION ROUND with the user. Use it when an agent has sent a STOP that is the
user's to decide, when an entry in the project's register or plan carries a proposed
owner or a proposed reading, when a review returned an arbitration, or when the user
says « one question at a time ». The user arbitrates scope; you decide nothing that is
theirs, and you never ask two things in one message.

## 1. Collect first, then announce the count

Read every pending arbitration before asking the first question: the agents' STOPs
(their messages — never answered from your own judgment), the entries marked proposed
or to ratify in the project's state file, register and plan, the findings of the last
review that need an owner. Then verify each item STILL OPEN on its own artifact — the pull
request's state and merge, the branch head, the file, the agent's last message — and the
premise its question assumes: how the project ships, which branch or environment is the
target, what that target already holds. A state file or a register describes what was true
when it was written, and the user's own merge or close is what most often settles a
question behind it. Write the list to `decision-round.md` in the session's scratch
directory — number, title, where it comes from, status — so the round survives a
compaction. An item found settled is written there as « already done: <evidence> »,
dropped from the count, and not asked. Announce it in one line: « N questions, one at a
time. » A question that arises mid-round is appended as N + 1, announced in one line, and
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
  happens today, what the plan or the agent says, and why this is the user's to decide.
  Plain words. An identifier appears only beside the words that explain it — a bare
  « R63 » or « B-312 » in a question is a defect of the question.
- _The choices._ Two to four, lettered, each carrying its COST and its GAIN in one line,
  and each a materially different piece of work — never shades of one option.
- _Recommendation._ Exactly one, with its reason in one sentence. Put it first among the
  choices only if the tool you present with requires it; otherwise name it here.
- Close with « You decide: A or B? » (the letters offered), and END THE TURN. Nothing
  else in that message: no status, no other question, no agent report.

## 3. Wait for the answer

Do not proceed on silence; do not assume; do not pick for them, not even the « obvious »
one — obvious to you is exactly what a round exists to check. A partial or ambiguous
answer gets ONE clarifying line, not a new question. Messages from agents that arrive
meanwhile are handled (a GO, an acknowledgment) but not shown as a wall between the
question and its answer.

## 4. On the answer, in the same turn and in this order

1. « Recorded: <the ruling in one line> » — the user sees their decision written back.
2. Write it where it lives: the project's state file or memory, the register entry, the
   plan — the durable place, never only the chat. A ruling that exists only in a
   conversation is a ruling the next session relitigates.
3. Tell the agent whose STOP it answers — `SendMessage`, the ruling verbatim, dated,
   « the operator ruled » — and subscribe to its idle notice.
4. Present the next question IN FULL (step 2). Not before.

## 5. Re-present after any interruption

If ANYTHING else was shown to the user between a question and its answer — an agent's
report you relayed, a task notification, a status line you had to write — re-present the
question IN FULL when you return to it: the whole shape of step 2, never « as above »,
never a pointer. A question the user must scroll back to find is a question answered
wrong.

## 6. A ruling is not reopened

If later evidence contradicts a ruling, that is a NEW question, with the evidence as its
context, appended to the round. Never re-argue a ruled question inside another one.

## 7. End

« The round is complete: N/N. » Then, in one short list: where each ruling was written
(file, entry) and which agent was told. Then, and only then, the work that depended on
the rulings starts — briefs amended, directives corrected in the same move, agents
relaunched.

Rules that hold throughout: one question per message; explanation before options; a
recommendation always; the cost inside the choice, not after the decision; never a bare
identifier; the user's language; nothing decided on their behalf.

$ARGUMENTS
