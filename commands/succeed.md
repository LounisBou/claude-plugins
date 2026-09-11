---
description: Hand the orchestration over to a fresh successor session
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh:*), Read, Write, Edit, ListAgents, SendMessage
---

Execute the orchestrator succession described in
`orchestrator:orchestrator`. Load that skill first.

Preconditions, verify each before acting:

- the moment is quiet: no verdict pending, no agent mid-delivery;
- the project state file is current — status lives once, there;
- the standing succession brief exists; otherwise instantiate
  `${CLAUDE_PLUGIN_ROOT}/templates/orchestrator-succession-brief.md` into the
  project's briefs directory, filling every `{{PLACEHOLDER}}`.

Then:

1. `iterm-agent.sh list` — note your own tty.
2. `iterm-agent.sh spawn --dir <worktree> --inherit-model --permission-mode auto
   --successor --prompt "Read and execute <brief path>"` — the operator's
   decision mode, or the successor stops at its first prompt in a tab nobody watches.
   No title: `--successor` takes THIS session's own name, so the successor is the same
   `Orchestrator : <feature>` with a reference of its own, which is what every brief
   cites; it also comes up under remote control under that name (spec §39). A session
   launched by hand carries no name, and the launcher then says to type one. A session the
   older launcher named carries its prompt in its own process line, so the derivation
   refuses it and the title is typed by hand, in the house format — this is the case of
   every orchestrator alive across the upgrade.
   The successor runs on the model this session runs on NOW — the operator's choice, carried
   across every succession; the map binds agents, never the orchestrator (spec §27).
   `--successor` places it immediately right of this tab, between it and the first agent,
   and hands it the chain (spec §34).
3. Answer nothing new. Wait for the successor's "takeover confirmed"; answer
   its questions about state only.
4. Never close your own tab: the successor closes it once you are idle — its brief says so
   (template step 4), and you do not run this command without that step in the brief.
5. Do not ask the user whether to succeed. At the gate you succeed, then you tell them.
6. Ten minutes after « takeover confirmed », if `iterm-agent.sh list` still shows your own
   tty and nothing of yours runs, close it yourself: `iterm-agent.sh close --tty $(tty)
   --expect-title <your title>`. A predecessor alive after the takeover answers agents that
   address it by habit; the successor closes it first, and you are the fallback.

$ARGUMENTS
