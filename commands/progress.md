---
description: Where the build stands — done, in flight, remaining, decisions pending — and the orchestrator's own context
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/dispatch-record.sh:*), Bash(git:*), Bash(gh:*), Bash(ls:*), Bash(jq:*), Bash(date:*), ListAgents, Read
---

Report the state of the whole build to the user, from the artifacts and the
state file — never from memory of what was said.

1. Read the project's state file (the one the `orchestrator:orchestrator` skill
   says status lives in), the plan's phase list, and the briefs directory.
2. Verify on the artifacts: for every phase the plan names, its branch and PR
   (`gh pr list --state all`), CI state, whether it is merged, reviewed, in
   fix-up, or not started; the head of `main`; live agents (`ListAgents`).
3. Read the dispatch record's summary:
   `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/dispatch-record.sh summary <record>`
   — the path the project's state file names. Keep every `signal=` line: they are
   the routing corrections this build has earned, and a signal nobody reads is a
   measurement nobody took.
4. Measure your own context: run
   `${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh` and keep
   its `context_percent=` and `source=` lines.
5. Present, in this order and nothing else:
   - **Done** — phases merged, with PR numbers and what each delivered in one line.
   - **In flight** — phases with a PR open or an agent writing: agent name,
     head, review round, what is owed and by whom.
   - **Remaining** — phases not started, in the plan's order, and any phase
     blocked with the reason.
   - **Decisions pending** — every arbitration that is the user's to make,
     each with the two readings and their cost, never a bare identifier.
   - **Routing** — one line per `signal=` from the summary, each said as what it
     obliges: a tier reverted for a class, a cascade stopped, a class owed a second
     reader. No signal is left as a number the reader must interpret.
   - **Your context** — the gauge's figure and source; if past 60%, say that
     succession is next and when (the quiet boundary you will use).
6. Every figure carries the command that produced it; a figure you cannot
   re-derive from an artifact is not written.

$ARGUMENTS
