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

## State on main (2026-11-14)

What the code on `main` (`6a0cd839`) holds for each goal, read from the code and CI, not from
the history. Pull requests are named with the repository, `claude-plugins#N`. « Open » says what is
left and why; a goal is met only when its row says so. Goals 2, 16 and 17 are operator steps
outside this repository.

| # | State | Evidence | Open, and why |
|---|---|---|---|
| 1 | partly met | cloudflare: exact-argument sudoers rule, no committed `.claude/settings.json` (claude-plugins#7, claude-plugins#27); bugs-bot: the deploy check is refused unless the project file is the operator's alone (`bugs_bot/agent.py`, `_refuse_foreign_check`) | bugs-bot's `deploy_check` still runs with `shell=True` (`bugs_bot/agent.py:254`): the risk is narrowed to the operator's own command, not removed |
| 2 | operator step | the catalogue's relative sources (`.claude-plugin/marketplace.json`), checked by `npm run marketplace -- --check` | an install in a separate profile on the operator's machine; nothing in this repository can run it |
| 3 | partly met | `packages/core/src` (store, paths, names, shell reader, environment names, locator, contracts, deadline, process group, verdict, consent and PR records, the orchestration's measure file, gate, launcher line and `ListAgents` reading) reaches bugs-bot, github, implement, norms, orchestrator, pr-review and statusbar as a copy; the shell reader replaced its copies (claude-plugins#29, claude-plugins#73); pr-review runs github's installer (claude-plugins#29) | the copies listed in « Copied rules core replaces » marked open: `resolve_github.py` (norms, pr-review), the session-name shape, the negative-phrase list; `logLine` is defined in 11 orchestrator hook files, `configDir` in 6 |
| 4 | partly met | typed in core with a version: PR records (tested from both sides, `scripts/contracts.test.ts`), consent records (claude-plugins#78), the method's formats, the verdict line (`verdict.ts`), the store convention, the measure file (`orchestration.ts`); the launcher's `spawn` line and the `ListAgents` reading are core's | `deck.json` and the declared wait kinds are not typed in core, and the launcher's command lines carry no version (`docs/contracts.md`) |
| 5 | partly met | `tsconfig.json` covers `scripts/`, core, the drift, orchestrator and telemetry skill scripts, eight of the orchestrator's hook files and two of telemetry's | the other hook files of every plugin are outside the strict check (36 files still type `$` as `any`) |
| 6 | met | `ci/plugins.json`: eleven plugins block on Linux and macOS, drift on Linux and only at the release and the night (claude-plugins#23, claude-plugins#87, claude-plugins#94); the orchestrator's suite runs on Linux in four shards (claude-plugins#169); macOS runs at the release and each night | — |
| 7 | met | `npm run deps` (`scripts/deps.ts`, claude-plugins#5) | — |
| 8 | partly met | github's ready gate reads records bound to the head and refuses a review record written by the session that pushed it (claude-plugins#20, claude-plugins#130); the review verdict is computed from the review agents' findings (claude-plugins#18); a check plan is accepted only from the orchestrator (claude-plugins#164) | norms' pass is still computed from the figures the model passes to `check_done` (`plugins/norms/hooks/record.ts`) |
| 9 | partly met | no grant read from words in norms (claude-plugins#28), pr-review (claude-plugins#17), implement (claude-plugins#30); github reads consent from consent records declared with `declare_wait` (claude-plugins#78); the orchestrator's stop gate decides a turn's wake on the wait it declared alone, a turn that declared none ending on no wait (`checkWake` in `hooks/stop-gate.ts`, claude-plugins#179) | other readers of an orchestrator turn's last line remain in `hooks/guards.ts` (`operatorWaitRefusal`, `unansweredRefusal`, and `deferredIds` in the done branch), and the relay parses an agent's `status:` line |
| 10 | met for the guards listed in the defects | github (claude-plugins#15), bugs-bot (claude-plugins#16), norms' push guard (claude-plugins#28) refuse when they cannot decide | — |
| 11 | met | `npm run permissions`; the installer rules of `docs/contracts.md` (claude-plugins#21) | — |
| 12 | met | `/github:protect [apply]` (claude-plugins#21); the orchestrator's local push guard removed (claude-plugins#72) | — |
| 13 | partly met | « Verified defects by plugin » below, each item marked | the items marked open or partly |
| 14 | met | `ci/prompts.json` held by CI; `npm run context`: the orchestrator's start is 1,931 tokens in `build`, 1,266 in `investigate` | — |
| 15 | not met | the harness, the cases and the caps (`evals/outcome/`, `npm run outcome`; claude-plugins#42, claude-plugins#47, claude-plugins#49), the orchestration arm run as an orchestration (claude-plugins#97) | no pilot of the rebuilt arm and no measure is recorded: paid runs are the operator's, on their machine, under `evals/outcome/caps.json`; the release pull request asks whether to re-run the measure (`docs/architecture.md`, « Release »), and nothing runs without the operator's yes |
| 16 | operator step | — | the operator's configuration repository, outside this one |
| 17 | operator step | `docs/migration.md` | follows goals 2, 6, 15, 16; the criteria need the operator's days of use and a rehearsal |
| 18 | met for the strict parts | `npm test` fails under 85 % of lines and functions, 80 % of branches, over `scripts/`, core and the skill scripts | no Python part is measured; a part joins the day it is strict |
| 19 | met | `plugins/method` (the kernel and its references), core's `method.ts`; implement and the orchestrator point at `method:lifecycle` (claude-plugins#19, claude-plugins#67, claude-plugins#74) | the orchestrator's relay still parses an agent's status line with its own `parseStatus` (`hooks/relay.ts`) rather than core's `reportStatus` |
| 20 | met | `/implement:review` runs the review in another session (claude-plugins#20) | the operator's open decision on implement in orchestrated briefs (below) |
| 21 | partly met | `npm run context`, `ci/scenarios.json`, each pull request's difference in the CI summary (claude-plugins#32) | 10 first-turn measures on the operator's machine, 38,442 to 268,902 tokens, median 80,280; the host's own load is over 97 % of the start, and ten figures are too few to calibrate |
| 22 | met | `npm run rules` (claude-plugins#33) | — |

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
| 7 | Plugin defects | 13 | One plugin per pull request, from the lists below. The orchestrator's urgent fixes run in its former repository and are imported the same day; its refactoring is `orchestrator-refoundation-design.md`, run here alongside. |
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

The outcome pilot (one replayed pull request, both arms) and the outcome measure (six, one run
per arm) are capped in `evals/outcome/caps.json`, which the harness reads and stops at.

A run that would need more stops at its cap and is reported with what it measured; a higher
cap is the operator's.

## Copied rules core replaces (goal 3)

- The shell reader: in core (`packages/core/src/shell.ts`), read by github, implement, norms, pr-review and the orchestrator's kill guard. **Done.**
- The push detector, four times: orchestrator's push guard, `plugins/github/hooks` (`bashPushes`),
  `plugins/norms/hooks/guards.ts`, `plugins/pr-review/hooks/policy.ts` (`runsGitPush`). Removed
  with goal 12 rather than unified. **Open**: the orchestrator's is removed (#72) and pr-review's
  reads core's shell reader (#29); norms keeps its own `PUSH` regex (`hooks/guards.ts`), and
  github's `bashPushes` (`hooks/ready.ts`) tracks pushed heads for the gate.
- The github locator `scripts/resolve_github.py`, identical in norms and pr-review. **Open.**
- The session-name shape: `plugins/orchestrator/hooks/naming.ts:29`, `move.ts:95`,
  `skills/coordinator/scripts/coordinator.sh:316`, `skills/iterm-agents/scripts/iterm_agent.py:114`,
  `dispatch-record.sh:168`, and statusbar's prefixes. **Open**: core's `names.ts` is read by
  implement, `dispatch-record.ts` and the orchestrator's `hooks/naming.ts`, `move.ts` and
  `session-name.ts`; `iterm_agent.py` reads it as `names.json`; `coordinator.sh` and statusbar
  still hold their own.
- The context gate's arithmetic in `plugins/statusbar/statusline/statusline.sh:253-265`, and
  bugs-bot's third copy of the thresholds in `gate.py`. **Done**: core's `orchestration.ts`;
  statusbar shows the measure file's gate, `gate.py` reads the percentage as data.
- The cost rule in `plugins/orchestrator/skills/model-routing/scripts/routing.py` and `hooks/usage.ts`. **Done**: the rule is data in `hooks/usage.ts`, read by `routing.py`; one price table, `routing/prices.json` under the orchestrator's state directory.
- The negative-phrase list in `plugins/github/engine/ghlib/assets.py:25` and `hooks/writing.ts`. **Open**: two copies a test keeps equal.
- The read/write classification in `plugins/cloudflare/hooks/register.ts` and its Python parser. **Open.**
- `logLine` ×9, `configDir` ×6, `stateDir` ×3, `writeAtomic` ×2, `gateEnv` ×2 inside the orchestrator's hooks. **Done**: one module, `hooks/module-io.ts`, imported by every hook file.
- The gh installer of `plugins/pr-review/install.sh:49-150`, which duplicates github's. **Done** (#29).

## Verified defects by plugin (goal 13)

Line numbers are at import. « Suspected » items are confirmed by a reading, then fixed or dropped.
Each item ends on its state on `main`: **fixed** (with its pull request), **partly** or **open**.

**cloudflare**
- `README.md:148-150`: the documented sudoers rule lets `tee` write any Caddyfile and `cp -p … .bak-*` copy it anywhere, `/etc/sudoers.d/` included; `caddy validate *` and `reload *` take any argument as root. (Phase 0.) **Fixed**: an exact-argument rule.
- `.claude/settings.json` pre-approves `gh pr merge:*` and `git merge:*`. (Phase 0.) **Fixed.**
- `tests/run-tests.sh:419,1832,2120`: `stat -f … || stat -c` reads filesystem data on GNU. **Fixed** (#27).
- `tests/run-tests.sh:1792-1805` asserts the wording and line counts of `docs/caddy`. **Fixed.**
- `restore` replays whatever account, zone and data a backup file carries. (The env file suspicion is dropped: an account is made only from a variable named `<NAME>_CLOUDFLARE_API_TOKEN`.) **Fixed** (#27): a backup
  replays only at the account and zone it lies under.

**bugs-bot**
- `bugs_bot/agent.py:223`: `deploy_check` runs with `shell=True` from `.bugs-bot.json`, under the blanket `Bash(bugs-bot:*)` rule. (Phase 0.) **Partly**: still `shell=True`, run only
  when the project file is the operator's alone.
- `bugs_bot/registry.py:91-121`: `add`/`remove` read-modify-write without the lock; `jsonio.py:13` uses a fixed `.tmp` name. **Fixed** (#25).
- `tests/test_tm_bugs.py:394`: fails by the calendar (the purge reads the wall clock, `pull.py:24,113`). **Fixed** (#25).
- `hooks/guard.ts:83-124`: the group-post guard fails open. **Fixed** (#16).
- `hooks/core.ts` (`selfOf`, `peersOf`) parses `ListAgents` text; the launcher path and the measure-file layout are hard-coded. **Fixed**: core's `orchestration.ts`.
- `agent/AGENT.md`, `skills/bugs-bot/SKILL.md`: about 13k tokens per agent run, a dated ruling at `AGENT.md:17`; about 62 test reads of `.md` wording. **Open**
  (13,138 tokens in `npm run context`'s resident-agent scenario; the dated ruling is at `AGENT.md:16`).
- Suspected: tester text and images reach the orchestrator with only prose protection; `--image` (`images.py:77`) posts any local image. **Partly**: only
  PNG, JPEG or WebP of 10 MB or less; the first suspicion is not read yet.

**github**
- `hooks/ready.ts:476`: the records guard matches the text `pr-records/`; a built path or `rec""ord.py` passes, so a record can be forged; NotebookEdit is not covered (`register.ts:1438`). **Fixed** (#31).
- `hooks/register.ts:1084-1118`: waivers and auto-merge consent are read from the orchestrator's private `round/` files. **Fixed** (#78): consent records.
- `hooks/ready.ts:468-489`: the base plugin names its consumers. **Fixed** (#78): producers declared in core's `pr-record.ts`.
- `engine/ghlib/http.py:122`: every 403 is retried, POSTs included; GraphQL gets no retry. **Fixed** (#31).
- Every guard ends in `.catch(… next(e))` (`register.ts:1435,1450`): fails open. **Fixed** (#15).
- `auto-merge.json` is read-modify-write without a lock. **Fixed** (#36).
- `register.ts:254`, `guards.ts:278`: WRITING.md (about 3.3k tokens) is read whole once per session and once per subagent before any authoring call.
  **Partly** (#41): split into one file per kind under `engine/writing/`, each still read whole.
- Suspected: `image-upload` pushes any local file to a `pr-assets` branch once allowed for the session. **Fixed** (#31): images only.

**norms**
- `hooks/record.ts:71-104`: the pass is computed from figures the model passes in; `:35-39` stores the scope's head and never compares it at `check_done`.
  **Partly** (#28, #77): the head is compared and later commits may touch only the files the check
  read; the pass is still computed from the model's figures.
- `hooks/guards.ts:50`: `/\bpush/i` on the last prompt grants a push (« don't push » included). **Fixed** (#28): the host's dialog.
- The agents declared « read-only » carry `Bash`. **Fixed** (#28) by a guard on their shell.
- `hooks/check.ts:83` couples to `ORCHESTRATOR_SPAWNED`; `scripts/resolve_base.sh:31` calls raw `gh`. **Fixed** (#28).
- Suspected: `/norms:learn` writes reviewer text into project rules, an injection path. **Open**: not read yet.

**pr-review**
- `hooks/loop.ts:57-63`: `start` then `findings {keys: []}` records a clean pass with no review run and no pinned head. **Fixed** (#18).
- `hooks/policy.ts:43,60`: `grantsEdit`, `grantsPush` match the word (« don't fix this one », « do not push yet » grant). **Fixed** (#17).
- `runsGitPush` misses `sh -c` and `eval`. **Fixed** (#29).
- `install.sh:49-150` installs and signs in gh a second way; the fallback writes the fixed `/tmp/claude-pr-review-request.json`. **Fixed** (#29, #37).
- `skills/auto-fix-loop`: up to 5 review passes, against the orchestrator's one review and one correction round; aligned when it runs under orchestration. **Open**: `MAX_PASSES` is 5; the one-pass
  reviewer mode (`review_only`) exists and `/implement:review` uses it, the orchestrator's templates do not.

**implement**
- The implementer runs `implement:check` on its own work. **Partly** (#20): kept as a
  self-check; the review is `/implement:review`, in another session.
- `hooks/core.ts:402`: any prompt with « agent » lifts the subagent refusal. **Fixed** (#30).
- `hooks/core.ts:420-438`: the check's read-only guard misses `sed -i` and redirections. **Fixed** (#30).
- `hooks/core.ts:441`: the host's commit attribution is silenced during feature, phase and close.
  Kept: it is the repository's rule (no attribution, `docs/conventions.md`).
- `tests/run-tests.sh:109`: a locale-dependent wording lint. **Fixed** (#30).
- Open decision for the operator: implement reserved to solo work and refused in orchestrated briefs, or merged into the implementer brief.
  Still open; today no orchestrator brief names implement.

**statusbar**
- `statusline/statusline.sh:122-130`: `date -r <epoch>` is macOS-only; on GNU the reset times vanish silently. **Fixed** (#22).
- `install.sh:200-211`: overwrites a foreign `statusLine` (backup only), not atomic, replaces a symlinked `settings.json` by a file. **Partly** (#22): atomic, through the
  symlink, with a backup; a foreign `statusLine` is still replaced, with a message.
- `statusline/statusline.sh:20` sources its config file as code at every redraw. **Fixed** (#22).
- Suspected: `git status` without `GIT_OPTIONAL_LOCKS=0` can take `index.lock` beside agents; `launcher.sh:10` takes the first install path. **Fixed** (#22).

**orchestrator** — `orchestrator-refoundation-design.md`, whose « State on main » holds its state.

**Every plugin** — TypeScript handlers typed `$: any` with no tsconfig; TypeScript tests that run only inside the host (`claude-code/testing`), to be made runnable in CI or replaced by tests of pure modules.
**Partly**: see goal 5. The suites of cloudflare, implement, norms and the orchestrator run
`claude plugin test`; those of bugs-bot, github, pr-review and statusbar do not.

## Non-goals

1. Moving the orchestrator, coordinator or auditor out of iTerm sessions.
2. Any new permission prompt, approval step or operator chore.
3. Changing `deck.json`'s format.
4. Porting the Python engines to TypeScript.
5. New features outside the goals above.

The next spec of the program is `method-drift-design.md`, correcting the drift of the method: pull requests no longer go all the way.
