---
description: Hand the orchestration over to a fresh successor session
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief-lint.sh:*), Read, Write, Edit, ListAgents, SendMessage
---

Execute the orchestrator succession described in
`orchestrator:orchestrator`. Load that skill first.

Preconditions, verify each before acting:

- the moment is quiet: no verdict pending, no agent mid-delivery;
- the project state file is current — status lives once, there;
- the standing succession brief exists; otherwise instantiate
  `${CLAUDE_PLUGIN_ROOT}/templates/orchestrator-succession-brief.md` into the
  project's briefs directory, filling every `{{PLACEHOLDER}}` —
  never a brief written by hand: one dropped the template's step 4, the successor's close
  of this session, and the predecessor stayed open (`brief-lint.sh` now refuses it);
- its « Live state » section is filled now, from the state file's live part (the section is
  the hand-over copy of it; status still lives once, in the state file). The brief is standing:
  after its first use the five fields hold the last handover's text, not placeholders, so the
  predecessor overwrites the previous handover's Live state, never appends to it. The whole
  brief stays within 10,000 characters: the lint refuses more.

Then:

1. `iterm-agent.sh list` — note your own tty.
2. **Lint it.** `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief-lint.sh <brief path>`;
   any finding is repaired before the spawn, a known false positive is named.
3. `iterm-agent.sh spawn --dir <worktree> --inherit-model --permission-mode auto
   --successor --prompt "Read and execute <brief path>"` — the operator's
   decision mode, or the successor stops at its first prompt in a tab nobody watches.
   No title: `--successor` takes THIS session's own name, so the successor is the same
   `Orch : <subject>` with a reference of its own, which is what every brief
   cites; it also comes up under remote control under that name (spec §39). The launcher
   reads that name from the host's registry, where `rename_session` puts it, before the
   launch line's `--name`. Where it reads none — the rename never landed — or none it can
   read as one — a whole launch line from an older launcher, or a session named under the
   older convention — it says to type one: pass `--title "<this session's current name>"`,
   the name `ListAgents` prints for it without its bracketed reference, in the house format. This is the case of every
   orchestrator alive across the upgrade.
   The successor runs on the model this session runs on NOW — the operator's choice, carried
   across every succession; the map binds agents, never the orchestrator (spec §27).
   `--successor` places it immediately right of this tab, between it and the first agent,
   and hands it the chain (spec §34).
4. **Name the successor to your agents.** Once the spawn is verified and the successor's name and
   reference are read in `ListAgents`, send each running agent of your own ONE message giving
   the successor's exact name and reference and saying that the successor's messages are its own
   from now on. An agent takes no word from a session it was never told of, and the successor
   cannot vouch for itself.
5. Answer nothing new. Wait for the successor's "takeover confirmed"; answer
   its questions about state only. On the confirmation, send it « handed over » as your
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
