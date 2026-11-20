# Orchestrator succession brief — {{PROJECT}}

Mode: {{MODE}}

# Instructions

You are the SUCCESSOR ORCHESTRATOR of `{{PREDECESSOR_NAME_PATTERN}}`. Your launch loaded the rulebook with the mode above. `succession.sh takeover` printed this text from the state, read live at this run: the pull requests, rows, agents and questions below are verified; do not read them again. Nothing of it is a file, and no other file is read for the takeover.

Every script below is in `{{SCRIPTS}}`, the copy this takeover ran from. It must be the `scripts/` of the base directory your skill load printed: a path your predecessor gave is its older version, so run the takeover again from yours before anything else.

## Your first task, in this exact order

**Woken from a pause**: step 1 is void — no « takeover confirmed », nothing to close.

1. You ALWAYS close your predecessor, one the launcher did not open included, and ask the operator nothing. Message it "takeover confirmed" alone on the first line, then close it with this one command, chosen by the takeover from where that tty is ({{CLOSE_WHERE}}); its success line is the proof, and you say « handed over » only where you read it:
   ```
   {{LAUNCHER}} {{CLOSE_VERB}} --tty {{PREDECESSOR_TTY}} --expect-title "{{PREDECESSOR_NAME_PATTERN}}"
   ```
   Where the host refuses it, message the predecessor « call mcp__orchestrator__end_session », prove its end with `verify --tty` failing, and tell the operator in one line its tab holds only a shell. Show him verbatim what any `conversation:` section leaves pending: questions, commands, explanations.
2. The questions below, each by its entry, `<id>.json` under the state directory's `round/`: leave the open ones, apply each answer, and ask again, verbatim, each withdrawn one whose reason names no answer and whose premise still stands: one `ask` per turn, so the first at the end of this turn, the others each after his answer.
3. Announce in one message: state inherited, predecessor closed, the open rows with no agent, the questions kept or asked again, the Project line's `goals met=m/n open: …`. {{TURN_END}}{{HOME_STEP}}
4. {{DISPATCH_WHEN}} every open row with no agent that the phase rules allow, dependent ones stacked: each READY NOT STARTED, each NO OWNER once its blocker is set; DISPATCHED, NO LIVE AGENT after reading its pull request. A `blocked:` row waits on its blocker; a « next step » naming several rows is a stack to open, not a queue. The open rows below are the work, each at level 1.

# Source

## Live state — read from the state at the takeover

Printed by `succession.sh takeover` from the dispatch record, the to-do list, the deck, the round, the forge and the goals; a judgment on a row is its note, his words in it named by their round entry or to-do item.

- Rows open (id, label, what remains): {{LIVE_ROWS}}
- Row owners: {{LIVE_OWNERS}}
- Pull requests open (number, head, where each stands): {{LIVE_PULL_REQUESTS}}
- Agents running (name and reference, brief path): {{LIVE_AGENTS}}
- The operator's open questions, each verbatim (its `Question i of N` block whole), with its round entry id, or `none`: {{LIVE_OPEN_QUESTIONS}}
- Questions the operator answered, still to apply (round entry, subject: his letter or first sentence; his words are in that entry, read only if the item needs them): {{LIVE_ANSWERED?}}
- Questions withdrawn, to ask again under step 2 (round entry, reason, question verbatim), or `none`: {{LIVE_REASK}}
- To-do items whose row is closed or missing: {{LIVE_TODO}}
- Project: {{PROJECT_SHEET}}

## Standing context

- State directory: `{{STATE_DIR}}`. His answers are its `round/`, his requests the to-do list (`todo list`), read by the item at hand: `grep -rl '<keyword>' {{STATE_DIR}}/round`.
- Dispatch record: `{{DISPATCH_RECORD}}`, read before routing (`orchestrator:model-routing`).

# Expected result

« takeover confirmed » sent; the predecessor closed; the announcement; {{TURN_RESULT}}.
