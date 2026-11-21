---
description: Start the machine's coordinator, on the operator's word
argument-hint: <subject>
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh:*), Bash(cat:*), Bash(git:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(mkdir:*), Bash(date:*), Read, Write, Edit, ListAgents, SendMessage
disable-model-invocation: true
---

Run on the operator's word only, in a session HE opened for it. No orchestrator, auditor or
agent starts a coordinator.

Start the COORDINATOR described in `orchestrator:coordination`. Load that skill first.

Preconditions, verify each before acting:

- this session is none of the plugin's roles: `ListAgents` does not name it `Orch:`,
  `Agent:` or `Audit:`;
- no live coordinator: `${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh lookup`
  prints nothing. A name printed is a coordinator that runs: tell the operator which, and
  stop.

Then:

1. **The name first.** Call `mcp__orchestrator__rename_session` with `Coord: <subject>`, then
   END THE TURN: the session takes the name when it ends, and the module resumes you under it
   with « Your name … is taken ». Steps 2 to 7 run in that
   next turn. Read your reference from `ListAgents` (« This session is … »), the
   bracketed part after the name. A refusal names the shape it wants: correct the subject and
   call again.
2. **Your tty.** `${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh list` —
   the row marked `self`.
3. **Register**, under the name and the reference of step 1:

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh register --name "Coord: <subject> [<ref>]" --tty <your tty>
   ```

   A refusal is told to the operator verbatim, and you stop. Then `lookup` prints your name.
   `mkdir -p <data>/coordinator`; an existing `notes.md` there is read and kept, otherwise
   write an empty one.
4. **Leftmost, then the pane.**

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh move --tty <your tty> --leftmost
   ```

   Then call `mcp__orchestrator__supervision` with `open` (a pane already open is left as it is).

5. **Read the facts**: `coordinator.sh owners`, then `coordinator.sh facts`.
6. **Announce.** Apply « Announcing newcomers » (`orchestrator:coordination`): every running
   `Orch:` session `ListAgents` names is one you have not yet announced to.
   Send each this text verbatim, the brackets filled — the pull requests are those `owners`
   traced to that orchestrator:

   > A coordinator runs on this machine: I am `<your exact name and reference>`, the operator's
   > single question interface. A question meant for him reaches me from the end of your turn
   > (`/orchestrator:decide`), never by a message. Asking me the facts — whose pull request is
   > this, is anyone on this branch, file or subject — is optional and never a gate.
   > The facts attribute to you: <each pull request with its branch, or « none »>. Reply only
   > to correct that.

7. **Tell the operator**, in one message: registered under `<name>`, tab leftmost, pane open, who
   was told, and every `collision` and `unread` line `facts` printed.

$ARGUMENTS
