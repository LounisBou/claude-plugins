---
description: Start the machine's coordinator, on the operator's word, in a session he opened — named, registered, placed leftmost, and announced to every orchestrator
argument-hint: <subject>
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh:*), Bash(git:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(mkdir:*), Bash(date:*), Read, Write, Edit, ListAgents, SendMessage
---

Run on the operator's word only, in a session HE opened for it. No orchestrator, auditor or
agent starts a coordinator.

Start the COORDINATOR described in `orchestrator:coordination`. Load that skill first.

Usage: `/orchestrator:coordinator <subject>`.

Preconditions, verify each before acting:

- this session is none of the plugin's roles: `ListAgents` does not name it `Orch :`,
  `Agent :` or `Audit :`;
- no live coordinator: `${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh lookup`
  prints nothing. A name printed is a coordinator that runs: tell the operator which, and
  stop;
- the subject is at most 25 characters and neither begins nor ends with a space: the launcher
  refuses any other shape of `Coord : <subject>`, and your successor's spawn would fail.

Then:

1. **The name first.** Hand the operator this one line, and end the turn:

   ```
   /rename "Coord : <subject>"
   ```

   When he says it is done, read the name back from `ListAgents` (« This session is … »): it
   must start with `Coord : <subject>`, followed by its reference; otherwise hand the line
   again.
2. **Your tty.** `${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh list` —
   the row marked `self`.
3. **Register**, under the name exactly as `ListAgents` prints it:

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
   `rotate` and `move` refuse a tab whose session is named `Coord :` unless `--force`, and
   the title is refused on any spawn but your successor's, `--coordinator-successor --title
   "Coord : <subject>"`, which opens at the FIRST place of the window, the chain ignored, on
   the caller's model and under remote control under its title, joins no chain, and refuses
   `--successor`, `--auditor`, `--left-of` and `--right-of` beside it.

5. **Read the facts**: `coordinator.sh owners`, then `coordinator.sh facts`.
6. **Announce.** A fresh `ListAgents`; to every `Orch :` session it lists, one `SendMessage`,
   this text verbatim, the brackets filled — the pull requests are those `owners` traced to
   that orchestrator:

   > A coordinator runs on this machine: I am `<your exact name and reference>`, since
   > <date -u +%FT%TZ>. When in doubt, ask me: whose pull request is this, is anyone on this
   > branch, file or subject, may I do this or must I wait. Asking me is optional and never a
   > gate: nothing of yours waits for my word, and you still speak to the operator directly.
   > The facts attribute to you: <each pull request with its branch, or « none »>. Confirm or
   > correct that once, in one line.

7. **Tell the operator**, in one short message: registered under `<name>`, tab leftmost, who
   was told, and every `collision` and `unread` line `facts` printed.

From here, the skill is the rulebook.

$ARGUMENTS
