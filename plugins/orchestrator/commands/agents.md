---
description: Each running implementer agent's progress and context
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh:*), Bash(ls:*), Bash(jq:*), Bash(cat:*), Bash(date:*), Bash(git:*), Bash(gh:*), ListAgents, SendMessage, Read
---

Report where every implementer agent stands, one row each, with its context —
asked of the agent, then VERIFIED on the artifact before it is written down.

The hooks module answers this command on the spot, with no model turn: the store's rows
cut to the implementer agents — name, role, context fill, age of its last measure, the most
urgent first. It asks no agent and reads no branch: where a phase's state matters, run the
steps below yourself (the ask, each branch and pull request, the table), as when that answer fails.

1. Run `ListAgents`. Keep every live implementer (the names the project's
   rows or briefs designate; when in doubt, every session that is not
   yours and not a reader).
2. `SendMessage` each one, one message (its reply wakes you), this exact ask: « Status in five lines: phase and step in progress;
   branch and head sha; last push and PR; what blocks you, if anything; your
   measured context — read
   `<module>/measure/$CLAUDE_CODE_SESSION_ID.json` (`<module>`: `module=` of `${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh roots`)
   and paste its `context_percent`, `context_tokens` and `context_window`. »
   Do not loop on the
   answers: they arrive as messages; finish the report with what you
   have and complete it when they land.
3. While they answer, read what you can without them: for each agent's branch,
   `git log --oneline origin/main..origin/<branch> | wc -l`, the head sha, and
   `gh pr list --head <branch>`; and the measure files in
   `<module>/measure/*.json`
   (session id — the file's name — `context_percent`, `context_tokens`,
   `context_window`, `model`, `updated_at`). A claim in an answer that
   the artifact contradicts is reported as the artifact says, with the claim
   beside it.
4. Present one table: agent, phase and step, **the tier it was dispatched at**
   (from its brief or the dispatch record, not from the agent), branch and head, commits ahead of main, PR and CI state, blocker,
   context % and tokens. Mark any agent past its gate with ⚠ — the rotation gate — and
   say for each what YOU owe it (a verdict, an answer).
5. An agent silent fifteen minutes: « no answer, last artifact activity <time> ».
6. An agent that reports the work needs more judgment than its brief anticipated
   is relayed with its evidence, not summarised: escalating is a rotation at the
   next boundary, and the evidence is what the replacement's brief must carry.

$ARGUMENTS
