# Orchestrator succession brief — {{PROJECT}}

Mode: {{MODE}}

# Instructions

You are the SUCCESSOR ORCHESTRATOR of `{{PREDECESSOR_NAME_PATTERN}}`. Your launch loaded the rulebook with the mode above. `succession.sh takeover` printed this text from the state, read live at this run: the pull requests, rows, agents and questions below are verified; do not read them again. Nothing of it is a file, and no other file is read for the takeover.

Every script below is in `{{SCRIPTS}}`, the copy this takeover ran from. It must be the `scripts/` of the base directory your skill load printed: a path your predecessor gave is its older version, so run the takeover again from yours before anything else.

## Your first task, in this exact order

**Woken from a pause**: step 2 finds no agent, step 3 is void — no « takeover confirmed », nothing to close.

1. The Project line's goals; only when it lists open or deferred goals, in `{{SCRIPTS}}`, `dispatch-record.sh goals {{DISPATCH_RECORD}} status | grep -v '| met |'`. The open rows below are the work, each at level 1.
2. `ListAgents`. Tell each live implementer (`{{AGENT_NAME_PATTERN}}`) YOUR EXACT `ListAgents` NAME AND REFERENCE as the new orchestrator, and your predecessor's, asking nothing back, and subscribe to its idle notice (`notify_when_idle: true`). Delete no checkout before you know its row.
3. You ALWAYS close your predecessor, one the launcher did not open included, and ask the operator nothing. Message it "takeover confirmed" with `notify_when_idle: true`, the phrase alone on the first line, and wait for its « handed over »; five minutes without it, read its screen with `screen --tty` and close on a prompt with nothing in flight, never while it may still be writing. Before the close, `list` still shows its row on that tty, not `self`. Close with the first line on tabs, the second in a home session (never `close` there); its success line is the proof:
   ```
   {{LAUNCHER}} close --tty {{PREDECESSOR_TTY}} --expect-title "{{PREDECESSOR_NAME_PATTERN}}"
   {{LAUNCHER}} takeover --tty {{PREDECESSOR_TTY}} --expect-title "{{PREDECESSOR_NAME_PATTERN}}"
   ```
   Where the host refuses it, message the predecessor « call mcp__orchestrator__end_session », prove its end with `verify --tty` failing, and tell the operator in one line its tab holds only a shell.
4. Each open question below by its entry, `<id>.json` under the state directory's `round/`: open under this session, leave it; answered or closed, apply its answer; absent, withdrawn or open under another session, ask it again verbatim at the end of this turn.
5. Announce in one message: state inherited, agents re-identified, predecessor closed, the open rows with no agent, the questions kept or asked again, the `goals met=m/n … open=…` line, and two figures on one line, « first turn » and « at takeover confirmed »: the `context_tokens` of `<config dir>/claude-orchestrator/measure/<session id>.json` (`printenv CLAUDE_CODE_SESSION_ID`; `CLAUDE_CONFIG_DIR`, `~/.claude` when empty) read at the first tool call after each of those turns; missing, say so. END THE TURN.
6. Your next turn dispatches every open row with no agent that the phase rules allow, dependent ones stacked: each READY NOT STARTED, each NO OWNER once its blocker is set; DISPATCHED, NO LIVE AGENT after reading its pull request. A `blocked:` row waits on its blocker; a « next step » naming several rows is a stack to open, not a queue.

# Source

## Live state — read from the state at the takeover

Printed by `succession.sh takeover` from the dispatch record, the to-do list, the deck, the round, the forge and the goals; a judgment on a row is its note.

- Rows open (id, label, what remains): {{LIVE_ROWS}}
- Row owners: {{LIVE_OWNERS}}
- Pull requests open (number, head, where each stands): {{LIVE_PULL_REQUESTS}}
- Agents running (name and reference, brief path): {{LIVE_AGENTS}}
- The operator's open questions, each verbatim (its `Question i of N` block whole), with its round entry id, or `none`: {{LIVE_OPEN_QUESTIONS}}
- To-do items whose row is closed or missing: {{LIVE_TODO}}
- Project: {{PROJECT_SHEET}}

## Standing context

- State directory: `{{STATE_DIR}}`. His answers are its `round/`, his requests the to-do list (`todo list`), read by the item at hand: `grep -rl '<keyword>' {{STATE_DIR}}/round`.
- A reference of the rulebook is read at the moment its table names, by section, never at takeover.
- Dispatch record: `{{DISPATCH_RECORD}}`, read before routing (`orchestrator:model-routing`).

# Expected result

« takeover confirmed » sent; the predecessor closed; the announcement; the turn ended.
