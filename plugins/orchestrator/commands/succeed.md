---
description: Hand the orchestration over to a fresh successor session
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/dispatch-record.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/succession.sh:*), ListAgents, SendMessage
---

Execute the orchestrator succession described in
`orchestrator:orchestrator`. Load that skill first.

Preconditions, verify each before acting:

- the moment is quiet: no verdict pending, no agent mid-delivery;
- the state is in its owners (`references/succession-predecessor.md`, « Succession — the predecessor », step 0):
  every planned item and ruling is an open row with its blocker, a judgment on a row is its
  `note`, each to-do item names its rows. No brief is written: the
  successor reads the state through `succession.sh takeover`.

Then:

1. `iterm-agent.sh list` — your own row, `self`: its tty goes in the successor's prompt.
2. `iterm-agent.sh spawn --dir <worktree> --permission-mode auto
   --successor --prompt 'Load the skill orchestrator:orchestrator with the argument "<your mode>", then, from your working directory (do not cd), run <the base directory that skill load printed>/scripts/succession.sh takeover <dispatch record> --mode <your mode> --tty <your tty>, and execute what it prints.'`
   — the prompt names no script directory of yours: the successor runs the takeover, and every
   script it prints, from its own copy of the plugin, the version installed when it started, never
   from this session's older one. `<your mode>` is the operator's
   decision mode, or the successor stops at its first prompt in a tab nobody watches
   (its pair: `references/succession-predecessor.md`, « Succession — the predecessor », step 2).
   No title: `--successor` takes THIS session's own name, so the successor is the same
   `Orch: <subject>` with a reference of its own, which is what every brief cites. Where the
   launcher reads no such name, it says to type one: pass `--title "<this session's current
   name>"`, the name `ListAgents` prints for it without its bracketed reference.
   `--successor` places it immediately right of this tab, between it and the first agent,
   and hands it the chain.
3. **Name the successor to your agents** once the spawn is verified and its name and reference
   are read in `ListAgents`: `references/succession-predecessor.md`, « Succession — the predecessor », step 4.
4. Start nothing new. Wait for the successor's "takeover confirmed"; answer its questions about state only,
   and the operator's in one line naming the successor, who answers them.
   On the confirmation, send it « handed over » as your
   LAST message, with `SendMessage` to the name it confirmed from:
   a line written in your own tab reaches no one, and the successor waits on it.
   Nothing of yours is left to write; end the turn: that message is what it closes
   your tab on.

$ARGUMENTS
