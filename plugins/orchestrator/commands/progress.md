---
description: Where the build stands, and the orchestrator's context
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/dispatch-record.sh:*), Bash(git:*), Bash(gh:*), Bash(ls:*), Bash(jq:*), Bash(cat:*), Bash(date:*), ListAgents, Read, Edit
---

Report the state of the whole build to the user, from the artifacts — never
from the rows alone, never from memory of what was said.

The hooks module answers this command on the spot, with no model turn: from the dispatch
records this session registered, one `goals met=<m>/<n> ruled_out=<k> open: …` line
per record with a `goals.md` beside it, one `open: <subject> (row <id>)` line per row still open, or
`deferred: <subject> (row <id>) — ruling: <his words>` for a row the operator deferred (put off by his
ruling, never work to dispatch),
then the tally `dispatches=<n> closed=<n> rounds_avg=<n>`. It reads no pull request and
corrects no row. The steps below run only when that answer fails; a report to the
user still follows them by hand, and correcting the rows from the artifacts is the
rulebook's principle 4, « Re-read before you ask, propose or report », due at every quiet boundary
whatever this command printed.

1. Read the dispatch record's open rows (`dispatch-record.sh summary <record> --open`: state,
   blocker, note, verdict line) and the goals' plan (`goals <record> status`).
2. Verify on the artifacts: for every phase the plan names, its branch and PR
   (`gh pr list --state all`), CI state, whether it is merged, reviewed, in
   fix-up, or not started; the head of `main`; live agents (`ListAgents`); and
   each pending decision, still open on its own artifact.
   A row is what was last recorded, the artifacts are what is: where they
   disagree, the artifacts win and the row is CORRECTED in this same
   turn (`close`, `blocker`, `note`), before anything is presented. A PR found merged or closed is reported
   as done or closed, never as pending, and FLAGGED: the orchestrator then
   stands down the work in flight on it.
3. Read the dispatch record's summary:
   `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/dispatch-record.sh summary <record>`
   — the record `/orchestrator:succeed` and the takeover name. Keep every `signal=` line: they are
   the routing corrections this build has earned: a signal nobody reads is a measurement nobody took.
4. Measure your own context: read `<module>/measure/$CLAUDE_CODE_SESSION_ID.json`
   (`<module>`: `module=` of `${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh roots`)
   and keep its `context_percent`, `context_tokens` and `context_window`.
5. Present, in this order and nothing else:
   - **Goals** — the goals line of `dispatch-record.sh goals <record> status`.
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
   - **Your context** — the measure file's figures; if past the gate —
     the smaller of 300,000 tokens (30 %) and 80 % of the reported window: 300,000 on 1,000,000; 160,000 on 200,000 — say that
     succession is next and when (the quiet boundary you will use).
6. Every figure carries the command that produced it; a figure you cannot
   re-derive from an artifact is not written.

$ARGUMENTS
