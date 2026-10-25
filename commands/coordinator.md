---
description: Start the machine's coordinator, on the operator's word
argument-hint: <subject>
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh:*), Bash(cat:*), Bash(git:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(mkdir:*), Bash(date:*), Read, Write, Edit, ListAgents, SendMessage
---

Run on the operator's word only, in a session HE opened for it. No orchestrator, auditor or
agent starts a coordinator.

Start the COORDINATOR described in `orchestrator:coordination`. Load that skill first.

Usage: `/coordinator <subject>`.

Preconditions, verify each before acting:

- this session is none of the plugin's roles: `ListAgents` does not name it `Orch :`,
  `Agent :` or `Audit :`;
- no live coordinator: `${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh lookup`
  prints nothing. A name printed is a coordinator that runs: tell the operator which, and
  stop;
- the subject is at most 25 characters and neither begins nor ends with a space: the launcher
  refuses any other shape of `Coord : <subject>`, and your successor's spawn would fail.

Then:

1. **The name first.** Call `mcp__orchestrator__rename_session` with `Coord : <subject>`, then
   END THE TURN: the session takes the name when it ends, and the module resumes you under it
   with « Your name … is taken »; a message sent before then is refused. Steps 2 to 7 run in
   that next turn. Read your reference from `ListAgents` (« This session is … »), the
   bracketed part after the name. A refusal names the shape it wants: correct the subject and
   call again.
2. **Your tty.** `${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh list` —
   the row marked `self`.
3. **Register**, under the name and the reference of step 1:

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh register --name "Coord : <subject> [<ref>]" --tty <your tty>
   ```

   A refusal is told to the operator verbatim, and you stop. Then `lookup` prints your name:
   the proof. `mkdir -p <state dir>/coordinator`; an existing `notes.md` there is read and
   kept, otherwise write an empty one.
4. **Leftmost.**

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh move --tty <your tty> --leftmost
   ```

   Your tab is `self`, so the move needs no `--force`. The launcher keeps the place yours:
   `rotate` and `move` refuse a tab whose session is named `Coord :` unless `--force` — yours
   from the end of step 1's turn, the launcher reading the name from the host's registry — and
   the title is refused on any spawn but your successor's, `--coordinator-successor --title
   "Coord : <subject>"`, which opens at the FIRST place of the window, the chain ignored, on
   the caller's model and under remote control under its title, joins no chain, and refuses
   `--successor`, `--auditor`, `--left-of` and `--right-of` beside it.

5. **Read the facts**: `coordinator.sh owners`, then `coordinator.sh facts`.
6. **Announce.** Apply « Announcing newcomers » (`orchestrator:coordination`): a fresh
   `ListAgents` names every running `Orch :` session as one you have not yet announced to.
   Send each this text verbatim, the brackets filled — the pull requests are those `owners`
   traced to that orchestrator:

   > A coordinator runs on this machine: I am `<your exact name and reference>`, since
   > <date -u +%FT%TZ>. I am the operator's single question interface: from now on, send me
   > every question meant for him — your own arbitrations and the questions of your agents
   > you relay — never to him in your tab. With your questions, send three to five sentences
   > on what you are working on: project, repository, current phase or pull requests, where
   > it stands. I relay each question to him verbatim, with its context and your name, in a
   > decision round where your questions come together, opened by that account of your work;
   > I send his answer back to you verbatim and dated, and I answer none of them myself. For the facts, ask me when in doubt: whose pull request is this, is anyone on this
   > branch, file or subject, may I do this or must I wait. Asking me the facts is optional and
   > never a gate: nothing of yours waits for my word.
   > The facts attribute to you: <each pull request with its branch, or « none »>. Confirm or
   > correct that once, in one line.

7. **Tell the operator**, in one short message: registered under `<name>`, tab leftmost, who
   was told, and every `collision` and `unread` line `facts` printed.

From here, the skill is the rulebook.

$ARGUMENTS
