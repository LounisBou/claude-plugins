# The claude-plugins program — design

## Why

Eight plugins, built in eight repositories by one operator who works with them every day,
grew by layers: each incident added a rule, a guard or a copy. Audits of every plugin found
the same defects again and again — a rule implemented in several languages and drifting,
consent inferred from words, readiness self-attested, guards that let everything through
when they fail, untyped TypeScript, suites that pass only on the author's Mac, prompts heavy
with history. This program gathers the plugins in one repository and rebuilds their
foundations so that the next change is cheap and the drift cannot return. The operator moves
to this repository only once it is proved stable (`docs/migration.md`).

## Operator priorities (they rank every trade-off)

1. **Fluidity.** Orchestrators and agents work autonomously: no new permission prompt, no
   needless question, no manual step. Nothing that works today breaks.
2. **Ready means done.** The definition of done guarantees the work is done, done well and
   complete.
3. **Separation of roles.** Implementers write, a review session reads, the orchestrator
   answers for the code and never implements.
4. **Single source of truth.** Each fact lives once; its absence is the source of the
   repeated defects.
5. **Maintainability.** Clean architecture, stability, built to evolve daily.
6. **Token economy.** Light prompts and briefs, no repetition, a light starting context, the
   succession kept as the plugins' own compaction.

## Goals

1. The urgent risks are closed in the current repositories and carried into this one: the cloudflare sudoers rule, the cloudflare merge pre-approvals and the bugs-bot shell command.
2. Every plugin installs and updates from this repository's catalogue in a separate host profile, with nothing lost.
3. The shared core package exists, reaches every plugin that uses it, and replaces every copied rule listed in this spec.
4. Every contract between plugins is typed in core, versioned, and tested from its owner and from each consumer.
5. All TypeScript of the repository passes the strict configuration.
6. Every plugin suite blocks the build on macOS and on Linux.
7. A dependency lint refuses an undeclared import, a read of another plugin's private state and a dependency without a version range.
8. One ready gate serves every plugin: a record written by a session other than the implementer, bound to the reviewed head and computed from the tool's output.
9. No plugin infers the operator's consent from words, and no gate decides on the wording of a model's last line.
10. Every guard that protects fails closed.
11. No committed file grants a permission, and every installer rule is narrow and listed in the contracts.
12. Force-push protection lives on the forge, with a command that checks and applies it.
13. The verified defects of each plugin are fixed, each with a test that fails when its fix is reverted.
14. Each plugin's prompt budget is measured by CI, and the orchestrator's always-loaded method is about 2,000 tokens.
15. Outcome evals compare a single session with an orchestration on replayed merged pull requests and are re-measured at every release.
16. The operator's configuration is adapted on its own branch with no stale reference.
17. The cutover criteria of the migration document are met.
18. Every strict part of the code holds the coverage floor of the conventions.
19. The method plugin owns the lifecycle, the definition of done, the artifact formats and the question format, and no other plugin restates them.
20. implement runs the shared lifecycle alone, its review made by another session.
21. A context simulator computes the tokens of each scenario from declared loads, CI shows each pull request's difference by scenario, and the gauge's first-turn measures calibrate it.
22. A script reports the rules a prompt states that neither code enforces nor an eval names.

## Constraints

- Incremental: every merged pull request leaves every plugin usable.
- The current repositories are frozen except for urgent fixes, each re-imported here the same
  day (`docs/migration.md`).
- Kept as they are: the orchestrator's iTerm sessions and home session, `deck.json`'s format,
  the machine-to-machine move (fixed, not removed), the cost accounting, the spawn without
  approval, the launcher's trust write (made safe, not removed), review on evidence, the merge
  reserved to the operator, the context gauge, the `workspace.sh delete` guards.
- `docs/conventions.md` governs every change; a convention changes with the code it governs.
- A port replaces its source in the same pull request.

## Phases (the orchestrator may split a phase, never merge two)

| # | Phase | Goals | Notes |
|---|---|---|---|
| 0 | Urgent risks | 1 | In the current repositories, re-imported here. |
| 1 | Install from the monorepo | 2 | Verify the catalogue's relative sources on the operator's host, in the separate profile. |
| 2 | Core | 3, 5, 18 | First the packaging of core (decision 0002), then the store, the paths, the name shapes, the plugin locator. One copy removed per pull request; each part enters at the coverage floor. |
| 3 | Contracts and dependencies | 4, 7 | Every row of `docs/contracts.md`. |
| 4 | Readiness and consent | 8, 9, 10 | github first (the gate), then each consumer. |
| 4b | Method | 19, 20 | The `method` plugin from what the orchestrator and implement state today; then implement on it. |
| 5 | Security | 11, 12 | |
| 6 | Platforms | 6 | Ratchet `ci/plugins.json` plugin by plugin. |
| 7 | Plugin defects | 13 | One plugin per pull request, from the lists below. The orchestrator's urgent fixes run in its former repository and are imported; its refactoring is `orchestrator-refoundation-design.md`, and touches `plugins/orchestrator/` only once the urgent build has ended. |
| 8 | Prompts and evals | 14, 15, 21, 22 | Spend caps, set by the operator: « Eval spend caps » below. |
| 9 | Configuration and cutover | 16, 17 | |

## Eval spend caps (phase 8)

Set by the operator, passed as `--max-cost-usd` or stopped by hand at the figure. The behaviour
suites' baselines cost 0.31 to 0.42 USD a run of a case; the outcome figures are a first
estimate, corrected after the pilot.

| Run | Cap (USD) |
|---|---:|
| Behaviour suite, plugin arm, one run per case (after a rewrite) | 10 |
| Behaviour suite, plugin arm, three runs per case (a baseline) | 30 |
| Behaviour suite, both arms, three runs per case | 70 |
| Outcome pilot: one replayed pull request, single session and orchestration | 20 |
| Outcome measure: six replayed pull requests, one run per arm, each pull request and arm stopped at 10 | 120 |

A run that would need more stops at its cap and is reported with what it measured; a higher
cap is the operator's.

## Copied rules core replaces (goal 3)

- The shell reader: in core since github's copy moved there (`packages/core/src/shell.ts`); the orchestrator's `hooks/tokenizer.ts` follows once its urgent build has ended.
- The push detector, four times: orchestrator's push guard, `plugins/github/hooks` (`bashPushes`),
  `plugins/norms/hooks/guards.ts`, `plugins/pr-review/hooks/policy.ts` (`runsGitPush`). Removed
  with goal 12 rather than unified.
- The github locator `scripts/resolve_github.py`, identical in norms and pr-review.
- The session-name shape: `plugins/orchestrator/hooks/naming.ts:29`, `move.ts:95`,
  `skills/coordinator/scripts/coordinator.sh:316`, `skills/iterm-agents/scripts/iterm_agent.py:114`,
  `dispatch-record.sh:168`, and statusbar's prefixes.
- The context gate's arithmetic in `plugins/statusbar/statusline/statusline.sh:253-265`.
- The cost rule in `plugins/orchestrator/skills/model-routing/scripts/routing.py` and `hooks/usage.ts`.
- The negative-phrase list in `plugins/github/engine/ghlib/assets.py:25` and `hooks/writing.ts`.
- The read/write classification in `plugins/cloudflare/hooks/register.ts` and its Python parser.
- `logLine` ×9, `configDir` ×6, `stateDir` ×3, `writeAtomic` ×2, `gateEnv` ×2 inside the orchestrator's hooks.
- The gh installer of `plugins/pr-review/install.sh:49-150`, which duplicates github's.

## Verified defects by plugin (goal 13)

Line numbers are at import. « Suspected » items are confirmed by a reading, then fixed or dropped.

**cloudflare**
- `README.md:148-150`: the documented sudoers rule lets `tee` write any Caddyfile and `cp -p … .bak-*` copy it anywhere, `/etc/sudoers.d/` included; `caddy validate *` and `reload *` take any argument as root. (Phase 0.)
- `.claude/settings.json` pre-approves `gh pr merge:*` and `git merge:*`. (Phase 0.)
- `tests/run-tests.sh:419,1832,2120`: `stat -f … || stat -c` reads filesystem data on GNU.
- `tests/run-tests.sh:1792-1805` asserts the wording and line counts of `docs/caddy`.
- `restore` replays whatever account, zone and data a backup file carries. (The env file suspicion is dropped: an account is made only from a variable named `<NAME>_CLOUDFLARE_API_TOKEN`.)

**bugs-bot**
- `bugs_bot/agent.py:223`: `deploy_check` runs with `shell=True` from `.bugs-bot.json`, under the blanket `Bash(bugs-bot:*)` rule. (Phase 0.)
- `bugs_bot/registry.py:91-121`: `add`/`remove` read-modify-write without the lock; `jsonio.py:13` uses a fixed `.tmp` name.
- `tests/test_tm_bugs.py:394`: fails by the calendar (the purge reads the wall clock, `pull.py:24,113`).
- `hooks/guard.ts:83-124`: the group-post guard fails open.
- `hooks/core.ts` (`selfOf`, `peersOf`) parses `ListAgents` text; the launcher path and the measure-file layout are hard-coded.
- `agent/AGENT.md`, `skills/bugs-bot/SKILL.md`: about 13k tokens per agent run, a dated ruling at `AGENT.md:17`; about 62 test reads of `.md` wording.
- Suspected: tester text and images reach the orchestrator with only prose protection; `--image` (`images.py:77`) posts any local image.

**github**
- `hooks/ready.ts:476`: the records guard matches the text `pr-records/`; a built path or `rec""ord.py` passes, so a record can be forged; NotebookEdit is not covered (`register.ts:1438`).
- `hooks/register.ts:1084-1118`: waivers and auto-merge consent are read from the orchestrator's private `round/` files.
- `hooks/ready.ts:468-489`: the base plugin names its consumers.
- `engine/ghlib/http.py:122`: every 403 is retried, POSTs included; GraphQL gets no retry.
- Every guard ends in `.catch(… next(e))` (`register.ts:1435,1450`): fails open.
- `auto-merge.json` is read-modify-write without a lock.
- `register.ts:254`, `guards.ts:278`: WRITING.md (about 3.3k tokens) is read whole once per session and once per subagent before any authoring call.
- Suspected: `image-upload` pushes any local file to a `pr-assets` branch once allowed for the session.

**norms**
- `hooks/record.ts:71-104`: the pass is computed from figures the model passes in; `:35-39` stores the scope's head and never compares it at `check_done`.
- `hooks/guards.ts:50`: `/\bpush/i` on the last prompt grants a push (« don't push » included).
- The agents declared « read-only » carry `Bash`.
- `hooks/check.ts:83` couples to `ORCHESTRATOR_SPAWNED`; `scripts/resolve_base.sh:31` calls raw `gh`.
- Suspected: `/norms:learn` writes reviewer text into project rules, an injection path.

**pr-review**
- `hooks/loop.ts:57-63`: `start` then `findings {keys: []}` records a clean pass with no review run and no pinned head.
- `hooks/policy.ts:43,60`: `grantsEdit`, `grantsPush` match the word (« don't fix this one », « do not push yet » grant).
- `runsGitPush` misses `sh -c` and `eval`.
- `install.sh:49-150` installs and signs in gh a second way; the fallback writes the fixed `/tmp/claude-pr-review-request.json`.
- `skills/auto-fix-loop`: up to 5 review passes, against the orchestrator's one review and one correction round; aligned when it runs under orchestration.

**implement**
- The implementer runs `implement:check` on its own work.
- `hooks/core.ts:402`: any prompt with « agent » lifts the subagent refusal.
- `hooks/core.ts:420-438`: the check's read-only guard misses `sed -i` and redirections.
- `hooks/core.ts:441`: the host's commit attribution is silenced during feature, phase and close.
- `tests/run-tests.sh:109`: a locale-dependent wording lint.
- Open decision for the operator: implement reserved to solo work and refused in orchestrated briefs, or merged into the implementer brief.

**statusbar**
- `statusline/statusline.sh:122-130`: `date -r <epoch>` is macOS-only; on GNU the reset times vanish silently.
- `install.sh:200-211`: overwrites a foreign `statusLine` (backup only), not atomic, replaces a symlinked `settings.json` by a file.
- `statusline/statusline.sh:20` sources its config file as code at every redraw.
- Suspected: `git status` without `GIT_OPTIONAL_LOCKS=0` can take `index.lock` beside agents; `launcher.sh:10` takes the first install path.

**orchestrator** — `orchestrator-refoundation-design.md`.

**Every plugin** — TypeScript handlers typed `$: any` with no tsconfig; TypeScript tests that run only inside the host (`claude-code/testing`), to be made runnable in CI or replaced by tests of pure modules.

## Non-goals

1. Moving the orchestrator, coordinator or auditor out of iTerm sessions.
2. Any new permission prompt, approval step or operator chore.
3. Changing `deck.json`'s format.
4. Porting the Python engines to TypeScript.
5. New features outside the goals above.
