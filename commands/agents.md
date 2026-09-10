---
description: Each running implementer agent's progress, with its measured context
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh:*), Bash(ls:*), Bash(jq:*), Bash(date:*), Bash(git:*), Bash(gh:*), ListAgents, SendMessage, Read
---

Report where every implementer agent stands, one row each, with its context —
asked of the agent, then VERIFIED on the artifact before it is written down.

1. Run `ListAgents`. Keep every live implementer (the names the project's
   state file or briefs designate; when in doubt, every session that is not
   yours and not a reader).
2. Message each one with `SendMessage` and `notify_when_idle: true`, one
   message, this exact ask: « Status in five lines: phase and step in progress;
   branch and head sha; last push and PR; what blocks you, if anything; your
   measured context — run `${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh`
   and paste its `context_percent=` and `source=` lines. » Do not wait on the
   answers in a loop: they arrive as messages; finish the report with what you
   have and complete it when they land.
3. While they answer, read what you can without them: for each agent's branch,
   `git log --oneline origin/main..origin/<branch> | wc -l`, the head sha, and
   `gh pr list --head <branch>`; and the gauge's own files in
   `${CLAUDE_CONFIG_DIR:-~/.claude}/claude-orchestrator/ctx/*.json` younger than
   ten minutes (session id, `context_percent`, age). A claim in an answer that
   the artifact contradicts is reported as the artifact says, with the claim
   beside it.
4. Present one table: agent, phase and step, **the tier it was dispatched at**
   (from its brief or the dispatch record — not from the agent, which cannot see
   its own), branch and head, commits ahead of main, PR and CI state, blocker,
   context % and its source. Mark any agent past
   60% with ⚠ — the rotation gate of the `orchestrator:orchestrator` skill — and
   say for each what YOU owe it (a verdict, a release of the machine, an answer).
5. An agent that has not answered within fifteen minutes is reported as such —
   « no answer, last artifact activity <time> » — never as « probably fine ».
6. An agent that reports the work needs more judgment than its brief anticipated
   is relayed with its evidence, not summarised: escalating is a rotation at the
   next boundary, and the evidence is what the replacement's brief must carry.

$ARGUMENTS
