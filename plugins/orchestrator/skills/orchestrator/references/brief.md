# Brief

Read before writing any brief: how it is built, the standing rules every prompt carries, the lint it passes before its spawn, and the tier its dispatch names.

## Agent prompt recipe

Write it to `<briefs dir>/<subject>.md`, then let `iterm-agent.sh spawn --brief <path> --orchestrator "<your exact ListAgents name and reference>"` build the startup prompt and spawn the fresh session in the same move (`references/agents.md`, « The agents' lifecycle is yours »). Start from `${CLAUDE_PLUGIN_ROOT}/templates/agent-phase-brief.md`; a rotation resume brief starts from `agent-rotation-brief.md`, your own succession brief from `orchestrator-succession-brief.md`. **The path must be one the fresh session can open on the machine it runs on, and it must survive until the phase is reviewed** — never only in your context or a container's temporary directory. The repository's policy on workflow artifacts (standing rules) says whether it is committed; state it in the prompt.

**`spawn --brief` lints the brief before any tab exists, and a finding warns on stderr — the launch goes on.** `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief-lint.sh <path>` flags what a script can see: an unfilled placeholder, an unexpanded variable, a path absent from this machine, a second session reference, a background run, an over-long succession brief, an implementer brief lacking address, non-goals or STOP-and-ask.

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

At the dispatch gate you read the agent's fill on `/orchestrator-status` against the gate the module reports, then choose the model/effort pair the work needs. `orchestrator:model-routing` is the aid to that decision: the table informs, you decide and write your choice, its reason and the reading that chose it in the brief, so the agent can tell you when the work outgrew it; it names the servers the session was given, so an agent never reaches for a tool it was not given.

**Route by size.** A small task (one plugin, prose or a small fix, a few files) goes to one session that writes, self-reviews, fixes the kept findings and merges where allowed; its review is the one pass `review-round.md` sizes by risk, the full multi-lens round being for risk alone.
