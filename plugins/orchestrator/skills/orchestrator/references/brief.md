# Brief

Read before planning phases or writing a brief (phase, correction round, review or comments session, rotation, your own succession): how it is built, the standing rules every prompt carries, its lint, its tier.

## Agent prompt recipe

Write it to `<briefs dir>/<subject>.md`, then let `iterm-agent.sh spawn --brief <path> --orchestrator "<your exact ListAgents name and reference>"` build the startup prompt and spawn the fresh session in the same move (see « The agents' lifecycle is yours » in `references/agents.md`). Start from `${CLAUDE_PLUGIN_ROOT}/templates/agent-phase-brief.md`; a rotation's from `agent-rotation-brief.md`, your succession's from `orchestrator-succession-brief.md`. **The path must be one the fresh session can open on its machine and must survive until the phase is reviewed** — never only in your context or a container's temporary directory. Whether it is committed follows the repository's policy on workflow artifacts; state it in the prompt.

**`spawn --brief` lints the brief before any tab exists, and a finding warns on stderr — the launch goes on.** `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief-lint.sh <path>` flags: an unfilled placeholder, an unexpanded variable, a path missing here, a second session reference, a background run, an over-long succession brief, and an implementer brief lacking an address, non-goals list or STOP-and-ask clause.

Its parts, in order:

1. **Required reading**, ordered: spec → plan (global constraints + their phase) → project norms → reference files for house patterns.
2. **Environment**: exact working directory, things to verify (not rebuild), branch to create and from where, and the **state-verification commands** run before acting (head, what landed, what is in flight): it verifies, it does not believe.
3. **Scope**, sized to one agent context: a slice it can finish, self-review and gate before its context gate; a larger scope is cut into stacked PRs at planning. Deliverables copied from the plan, contracts/signatures **verbatim**, plus an explicit non-goals list ending with: "if you believe something outside this list is needed, STOP and ask the orchestrator first".
4. **Method**: TDD, incremental conventional commits, project quality gate before PR, its coverage run early (deferred minor findings become gate blockers); then the self-review (`method:lifecycle`). **A repair lands with a test that fails when it is reverted**.
5. **Forbidden list** (standing rules below).
6. **Communication protocol — the orchestrator's address is NAMED in the prompt, never discovered.** Write your session's exact `ListAgents` name and reference, as they print (e.g. `project-70 [a1b2c3]`), into the prompt. A name pattern is not an address. Then: report on start and each push; a question goes to the orchestrator and the work goes on (`method:lifecycle`, « Questions to the operator »); a blocker (STOP + proposed resolution) or the final report ends the turn on the method's status line (`method:lifecycle`, « Reports »); the full report in `{{REPORT_PATH}}` (`<briefs dir>/report-<subject>.md`), the message its verdict line, worded as the templates under `templates/agent-*-brief.md` word it.
7. **Delivery**: draft PR opened `Not Ready` (`pr-create --draft`), imposed title, description shape. Delivery ends at the push: suite green locally on the final head, pull request opened (delivered as the method says in an auto-merge project), then the final report (pull request, head sha) and the stand-down. **Figures (counts, sizes, timings) are written once, on the final head**.
8. **Resource envelope**: kill what it started, delete what it built, **and prove it with `ps` and `ls`**; the project's own shared-machine limits, where its method writes them. **Scratch lives in the session's own host scratchpad directory**, never one the brief invents, and the agent leaves it: the close deleting its checkout takes it (`agents.md`, step 4).

## Every dispatch names its tier

At the dispatch gate, read the agent's fill on `/orchestrator-status` against the module's gate, then choose the model/effort pair the work needs. `orchestrator:model-routing` informs, you decide. The brief names the tier, your reason and the reading that chose it (so the agent can tell you when the work outgrew it) and the servers the session was given, so no agent reaches for a tool it lacks.
