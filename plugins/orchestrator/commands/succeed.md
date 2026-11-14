---
description: Hand the orchestration over to a fresh successor session
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief-lint.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/succession.sh:*), Read, Write, Edit, ListAgents, SendMessage
---

Execute the orchestrator succession described in
`orchestrator:orchestrator`. Load that skill first.

Preconditions, verify each before acting:

- the moment is quiet: no verdict pending, no agent mid-delivery;
- the project state file is current and the rulings marked (lifecycle item 0);
- the standing succession brief exists, a missing `Mode: ` line added with yours; otherwise instantiate
  `${CLAUDE_PLUGIN_ROOT}/templates/orchestrator-succession-brief.md` into the
  project's briefs directory, filling every `{{PLACEHOLDER}}`, never a brief written by hand;
- its « Live state » is generated now, never written by hand:
  `succession.sh live <brief path> --next "<the next step>"`, with at most five `--note` of
  judgment; each note of the last generation is promoted into an artifact
  (`--promote <n>=<path>`) or dropped. The script overwrites the previous handover's Live state,
  and the spawn refuses a brief that misses an open item.
  The brief stays within 9,000 characters, the open-questions value apart.

Then:

1. `iterm-agent.sh list` — your own row, `self`: its tty, your home server (the first
   comma-separated field of `printenv TMUX`, `none` on tabs), the launcher's path and the
   scripts directory fill the brief's predecessor placeholders, and the `Mode:` line with your own mode (`{{MODE}}`), without which the brief is refused.
2. **Lint it.** `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief-lint.sh <brief path>`;
   any finding is repaired before the spawn, a known false positive is named.
3. `iterm-agent.sh spawn --dir <worktree> --permission-mode auto
   --successor --prompt "Read and execute <brief path>"` — the operator's
   decision mode, or the successor stops at its first prompt in a tab nobody watches.
   The successor runs on this session's live model and effort, read on its transcript;
   `--tier`, `--model` and `--effort` are refused beside `--successor`, and a pair that
   cannot be read refuses the spawn.
   No title: `--successor` takes THIS session's own name, so the successor is the same
   `Orch: <subject>` with a reference of its own, which is what every brief cites. Where the
   launcher reads no such name, it says to type one: pass `--title "<this session's current
   name>"`, the name `ListAgents` prints for it without its bracketed reference.
   The successor runs on the model this session runs on NOW — the operator's choice, carried
   across every succession; the map binds agents, never the orchestrator (spec §27).
   `--successor` places it immediately right of this tab, between it and the first agent,
   and hands it the chain (spec §34).
4. **Name the successor to your agents.** Once the spawn is verified and the successor's name and
   reference are read in `ListAgents`, send each running agent of your own ONE message giving
   the successor's exact name and reference and saying that the successor's messages are its own
   from now on. An agent takes no word from a session it was never told of, and the successor
   cannot vouch for itself.
5. Start nothing new. Wait for the successor's "takeover confirmed"; answer its questions about state only,
   and the operator's in one line naming the successor, who answers them.
   On the confirmation, send it « handed over » as your
   LAST message, with `SendMessage` to the name it confirmed from:
   a line written in your own tab reaches no one, and the successor waits on it.
   Nothing of yours is left to write; end the turn: that message is what it closes
   your tab on.
6. Never close your own tab: the successor closes it on your « handed over » message — or,
   five minutes after "takeover confirmed" without it, on a reading of your tab's screen —
   its brief says so (template step 4), and you do not run this command without that step
   in the brief.
7. Do not ask the user whether to succeed. At the gate you succeed, then you tell them.

$ARGUMENTS
