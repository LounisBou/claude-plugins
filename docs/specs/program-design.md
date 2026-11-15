# The claude-plugins program — design

## Purpose — the operator's words (2026-11-14)

- « Claude Plugins, c'est une suite d'outils à destination des agents de Claude Code que je lance sur divers projets. »
- « c'est un peu ma bibliothèque de skills […] j'en ai fait des plugins qui soient facilement installables sur tous mes ordinateurs pour qu'ils soient facilement maintenables, facilement mis à jour »
- « Tous ces plugins, ils contiennent vraiment la méthodologie générale que j'utilise à la fois sur mes projets pro et mes projets perso. »
- « Des orchestrateurs qui n'écrivent pas le code, mais qui sont garants de l'objectif d'une feature, et qui vont pour implémenter, dispatcher des agents. »
- « on va faire un design, transformer ce design en plan […] c'est à ce moment-là qu'on allait définir les critères des gates, les reviews, les tests end-to-end, les normes, si c'est du front, toutes les captures d'écran »
- « C'est l'orchestrateur qui est responsable du travail produit par les agents. […] c'est à l'orchestrateur qui connaît du coup l'objectif de prendre les décisions, qu'est-ce qui doit être touché, qu'est-ce qui n'est pas nécessaire, jusqu'à amener la PR à être prête. »
- « si on est dans un projet d'automerge, cette PR prête est automatiquement mergée. Sinon, on la signale comme étant prête pour que l'opérateur, moi, puisse la relire et la merger […] à ne pas confondre la relecture et les gates. »
- « vraiment séparer ceux qui sont les garants, ceux qui écrivent le code et ceux qui contrôlent ce qui a été écrit. […] la séparation des pouvoirs. »
- « Que tous les contrôles qui peuvent être faits en automatique soient faits en automatique. Mais pas au détriment de l'efficacité dans le développement, pas en mettant des gates qui vont prendre énormément de temps »
- « pour éviter que ça soit fait à chaque fois de manière agentique et que ça utilise trop de tokens, […] au maximum on essaye de les mettre dans des scripts automatisés »
- « À chaque fois que je rajoute une règle ou que j'essaye d'automatiser quelque chose, l'objectif c'est de gagner en temps, de gagner en vitesse d'exécution et, peut-être d'éviter que des erreurs se reproduisent »
- « Toute règle […] qui surproduirait des gates, qui surproduirait des tests, qui corrigerait trop des problèmes qui finalement ne surviennent pas ou ne surviennent que très peu, serait contre-productif »
- « Claude Plugins est fait pour fluidifier et simplifier mon utilisation au quotidien et mon développement dans Claude Code et pas l'inverse, pas pour venir prévenir de bugs qui ne sont jamais arrivés »
- « Claude Plugins devient très vite une usine à gaz, avec beaucoup d'incohérences, de contradictions, et finalement il finit par produire l'exact inverse de ce qui est nécessaire. »
- « Claude Plugins, c'est pas quelque chose qui sert juste à développer Claude Plugins. […] c'est utilisé sur l'ensemble de mes projets perso ou pro, et que c'est ça le cœur du sujet de Claude Plugins »

## Why

Eight plugins, built in eight repositories by one operator who works with them every day,
grew by layers: each incident added a rule, a guard or a copy. Audits of every plugin found
the same defects again and again — a rule implemented in several languages and drifting,
consent inferred from words, readiness self-attested, guards that let everything through
when they fail, untyped TypeScript, suites that pass only on the author's Mac, prompts heavy
with history. This program gathers the plugins in one repository and rebuilds their
foundations so that the next change is cheap and the drift cannot return. The operator installs
from this repository's catalogue (`docs/migration.md`).

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

## State on main (2026-11-15)

What the code on `main` (`d540c0c6`, release 3.1) holds for each goal, read from the code and CI
on 2026-11-15, not from the history, rows 5, 6, 9, 14, 17 and 18 again at `775d7fdc`; the previous reading was `b36f7ae2` (2026-11-14). Pull
requests are named with the repository, `claude-plugins#N`. « Open » says what is left and why;
a goal is met only when its row says so, and a met row names its pull requests. Goals 2, 16 and
17 are about the operator's machines and configuration, outside this repository: their rows say
what was read there.

| # | State | Evidence | Open, and why |
|---|---|---|---|
| 1 | met | cloudflare: exact-argument sudoers rule, no committed `.claude/settings.json` (claude-plugins#7, claude-plugins#27); bugs-bot: the deploy check is run without a shell, its command split into words (`_check_argv`), and refused unless the project file is the operator's alone (`bugs_bot/agent.py`, `_refuse_foreign_check`) | — |
| 2 | met | the catalogue's relative sources (`.claude-plugin/marketplace.json`), checked by `npm run marketplace -- --check`; the operator installs from the `lounisbou` catalogue in his own profile, the plan's separate one having been left, and `npm run deploy` installs each green commit of `main` on his MacBook by itself (claude-plugins#264, claude-plugins#266, claude-plugins#272; `d540c0c6` is the commit installed) | — (the install on IznoServer is the cutover's step 2, goal 17) |
| 3 | met | `packages/core/src` (store, paths, names, shell reader, environment names, locator, contracts, deadline, process group, verdict, consent, PR and install records, the learning journal, the orchestration's measure file, gate, launcher line and `ListAgents` reading) reaches bugs-bot, drift, github, implement, learning, norms, orchestrator, pr-review, statusbar and telemetry as a copy; the shell reader replaced its copies, norms' push guard included (claude-plugins#29, claude-plugins#73, claude-plugins#181); norms' `resolve_github.py` is gone (claude-plugins#181); the negative-phrase list is one data file read by both languages (claude-plugins#199); cloudflare's read/write classification is data in `hooks/register.ts`, read by `engine/cf.py`; pr-review runs github's installer (claude-plugins#29) | — |
| 4 | partly met | typed in core with a version: PR records, the `tests` kind of a stacked pull request's light CI included (tested from both sides, `scripts/contracts.test.ts`; claude-plugins#242), consent records (claude-plugins#78), the learning events and the install record, the method's formats, the verdict line (`verdict.ts`), the store convention, the measure file (`orchestration.ts`); the launcher's `spawn` line and the `ListAgents` reading are core's | `deck.json` and the declared wait kinds are not typed in core, and the launcher's command lines carry no version (`docs/contracts.md`) |
| 5 | partly met | `tsconfig.json` covers `scripts/`, core, the drift, learning, orchestrator and telemetry skill scripts, every hook file of bugs-bot (claude-plugins#235), cloudflare, github, implement, learning, norms, pr-review, statusbar and telemetry, and twelve of the orchestrator's, one of them by import; every plugin's hook tests run in its suite, so in CI (`claude plugin test`) | 26 hook files are outside the strict check, the orchestrator's, 8 of them typing `$` as `any`; under the check, 20 hook files of bugs-bot, cloudflare, implement, norms, pr-review and statusbar type their handlers' `$` as `any`, 190 times, against « No `any` » (`docs/conventions.md`) |
| 6 | met | `ci/plugins.json`: twelve plugins block on Linux and macOS, drift running only at the release and the night (claude-plugins#23, claude-plugins#87, claude-plugins#94); the orchestrator's suite runs on Linux in four shards (claude-plugins#169); a pull request runs the Linux suites of what it changes, `main` every plugin but drift on Linux, macOS the release and each night (`scripts/plugin-matrix.ts`) | — |
| 7 | met | `npm run deps` (`scripts/deps.ts`, claude-plugins#5) | — |
| 8 | partly met | github's ready gate reads records bound to the head and refuses a review record written by the session that pushed it (claude-plugins#20, claude-plugins#130); the review verdict is computed from the review agents' findings (claude-plugins#18); norms' pass is held to the findings its agents report, the figures passed to `check_done` having to account for each once (claude-plugins#181); a check plan is accepted only from the orchestrator (claude-plugins#164); a stacked pull request's `tests` record is written by github's light CI alone (claude-plugins#242); an E2E `pass` or `fail` is computed by `mcp__github__record` from a run it performs or a Bash run of the session it observed, the pushed heads kept on disk for every session | the E2E waiver and `not-applicable` rest on the session's word, held to a quoted, dated sentence and to files with no runtime |
| 9 | partly met | no grant read from words in norms (claude-plugins#28), pr-review (claude-plugins#17), implement (claude-plugins#30); github reads consent from consent records declared with `declare_wait` (claude-plugins#78); the orchestrator's stop gate decides a turn's wake on the wait it declared alone, a turn that declared none ending on no wait (`checkWake` in `hooks/stop-gate.ts`, claude-plugins#179), and reads tool waits itself (claude-plugins#268); an operator wait is declared on the questions asked with `ask`, no question block in the wait (claude-plugins#240, claude-plugins#271); the stop gate in `hooks/guards.ts` reads no last line: the deferred ending and the hand-over come from the declaration and the successor's spawn | the turn's end in `hooks/supervision.ts` still reads an orchestrator's machine line (`parseWait`), an agent's `status:` line (`parseStatus`) and « handed over » (`handsOver`, `hooks/relay.ts`); `mcp__github__record` takes an E2E or norms waiver and an E2E exemption on the operator's words quoted with their date in `detail`, held to a quote and a date and read from no consent record (`quotedWordsRefusal`, `plugins/github/hooks/register.ts`) |
| 10 | met for the guards listed in the defects | github (claude-plugins#15), bugs-bot (claude-plugins#16), norms' push guard (claude-plugins#28) refuse when they cannot decide | — |
| 11 | met | `npm run permissions`; the installer rules of `docs/contracts.md` (claude-plugins#21) | — |
| 12 | met | `/github:protect [apply]` (claude-plugins#21); the orchestrator's local push guard removed (claude-plugins#72) | — |
| 13 | partly met | « Verified defects by plugin » below, each item marked | the items marked open or partly |
| 14 | met | `ci/prompts.json` held by CI (claude-plugins#1); the simulator (claude-plugins#32); `npm run context`: the orchestrator's start is 2,153 tokens in `build`, 1,552 in `investigate` | — |
| 15 | not met | the harness, the cases and the caps (`evals/outcome/`, `npm run outcome`; claude-plugins#42, claude-plugins#47, claude-plugins#49), the orchestration arm run as an orchestration (claude-plugins#97) | no pilot of the rebuilt arm and no measure is recorded: paid runs are the operator's, on their machine, under `evals/outcome/caps.json`; the release pull request asks whether to re-run the measure (`docs/architecture.md`, « Release »), and nothing runs without the operator's yes |
| 16 | partly met, outside this repository | the operator's configuration (`~/.claude`, branch `home` of `claude-code`) was adapted on `next-home` and merged (claude-code#43, 2026-11-10); its plugins are enabled as `@lounisbou` | no sweep for a stale reference was run: his repository is outside this one |
| 17 | partly met | `docs/migration.md`: CI is green on `main` and every plugin blocks on both platforms; the cutover's step 1 is taken (claude-code#43) and the catalogue is installed on the MacBook | criterion 2 is every goal of this table and criterion 3 goal 15, not met; no rehearsal (criterion 4) is recorded, and the stale-reference sweep (criterion 5) is goal 16's; the install on IznoServer and the restart of the sessions (the cutover's step 2) are not recorded |
| 18 | met for the strict parts | claude-plugins#1: `npm test` fails under 85 % of lines and functions, 80 % of branches, over `scripts/`, core and the skill scripts | no Python part is measured: nothing in the repository or CI runs `coverage.py`, though the conventions set the floor for Python too |
| 19 | met | `plugins/method` (the kernel and its references), core's `method.ts`; implement and the orchestrator point at `method:lifecycle` (claude-plugins#19, claude-plugins#67, claude-plugins#74) | none: the orchestrator reads an agent's status line and the operator's question block through core's `method.ts` (`reportStatus`, `parseChoices`, …), its own parsers removed |
| 20 | met | `/implement:review` runs the review in another session (claude-plugins#20) | the operator's open decision on implement in orchestrated briefs (below) |
| 21 | partly met | `npm run context`, `ci/scenarios.json`, each pull request's difference in the CI summary (claude-plugins#32); each closed generation's measure is kept from now on (claude-plugins#262) | 10 first-turn measures on the operator's machine, 38,442 to 268,902 tokens, median 80,280, read on 2026-11-14 and not re-read; the host's own load is over 97 % of the start, and ten figures are too few to calibrate |
| 22 | met | `npm run rules` (claude-plugins#33) | — |
| — | two disagreements between designs, open | goal 15 and goal 9 of `orchestrator-refoundation-design.md` want the outcome measure at every release, question 4 of `learning-design.md` and `docs/architecture.md` (« Release ») monthly and before a learned method change; goal 3 of `orchestrator-refoundation-design.md` wants the orchestrator's Python reduced to a thin iTerm2 adapter, non-goal 4 below ports no Python engine | neither is settled: which cadence goal 15 is held to, and whether `routing.py`, `goals.py`, `draft_guard.py` and the logic of `iterm_agent.py` are engines kept or scripts to port |

## The end of the program

The program is finished when every goal of the table above is met and the version that holds them is
installed where the operator works. No waiting period and no fixed protocol decide it. His words,
2026-11-15: « 24 heures d'usage sur un projet produit, c'est pas de moi ça. Ça a été inventé par les
agents et instauré comme une règle […] on peut tester l'objectif et tester tout ça beaucoup plus
simplement ».

The figures below are what the weekly report reads on a running orchestration: indicators of where
the orchestration stands, not conditions of the end.

| # | Figure | Target |
|---|---|---|
| 1 | Time an executable row spends without an agent | none above 15 minutes |
| 2 | Merge to in service | 2 hours at most, with no gesture of the operator |
| 3 | Working context of any role | 200k tokens at most; the operator put this ceiling off on 2026-11-14 until the generations are measured, so it counts once he puts it back |
| 4 | Life of an orchestrator generation | 2 hours at least |
| 5 | First turn of a takeover | 60k tokens at most |
| 6 | Row to merge | median of 1 hour at most |
| 7 | A question put to the operator again | none |
| 8 | Lines of the method's code, release to release | net zero or less |
| 9 | `main` red | never |

### Nothing of the design is set aside (the operator's words, 2026-11-15)

- « le rangement interne des types strict, tu peux ne pas le mettre en priorité, mais ça n'empêche que ça doit être fait. Ton objectif est tout de même d'aller jusqu'au bout du développement »
- « je veux qu'on livre l'ensemble du développement »
- « Je ne dois pas être à un point de blocage. »

Goals 5, 15 and 21 are therefore open like the others, after what slows his daily work: strict typing of
github's 9 hook files and the orchestrator's 26, the outcome measure run on the harness in place, and
the calibration on more first-turn measures.

## Constraints

- Incremental: every merged pull request leaves every plugin usable.
- The current repositories are frozen except for urgent fixes, each re-imported here the same
  day (`docs/migration.md`).
- Kept as they are: the orchestrator's iTerm sessions and home session, `deck.json`'s format,
  the cost accounting, the spawn without
  approval, the launcher's trust write (made safe, not removed), review on evidence, the merge
  reserved to the operator outside auto-merge (this repository is in it, `CLAUDE.md`), the context gauge, the `workspace.sh delete` guards.
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
  with goal 12 rather than unified. **Done**: the orchestrator's is removed (#72); pr-review's (#29),
  norms' (#181) and github's `bashPushes` (`hooks/ready.ts`, which tracks pushed heads for the gate)
  read core's shell reader.
- The github locator `scripts/resolve_github.py`, identical in norms and pr-review. **Done** (#181):
  norms leaves locating the github plugin to it; pr-review's is the one copy.
- The session-name shape: `plugins/orchestrator/hooks/naming.ts:29`,
  `skills/coordinator/scripts/coordinator.sh:316`, `skills/iterm-agents/scripts/iterm_agent.py:114`,
  `dispatch-record.sh:168`, and statusbar's prefixes. **Done**: core's `names.ts` is read by
  implement, bugs-bot, `dispatch-record.ts` and the orchestrator's `hooks/naming.ts` and
  `session-name.ts`; `iterm_agent.py`, `coordinator.sh` and statusbar read it as `names.json`.
- The context gate's arithmetic in `plugins/statusbar/statusline/statusline.sh:253-265`, and
  bugs-bot's third copy of the thresholds in `gate.py`. **Done**: core's `orchestration.ts`;
  statusbar shows the measure file's gate, `gate.py` reads the percentage as data.
- The cost rule in `plugins/orchestrator/skills/model-routing/scripts/routing.py` and `hooks/usage.ts`. **Done**: the rule is data in `hooks/usage.ts`, read by `routing.py`; one price table, `routing/prices.json` under the orchestrator's state directory.
- The negative-phrase list in `plugins/github/engine/ghlib/assets.py:25` and `hooks/writing.ts`. **Done** (#199): one file, `engine/negative-phrases.json`, read by both.
- The read/write classification in `plugins/cloudflare/hooks/register.ts` and its Python parser. **Done**: the list is data in `hooks/register.ts` (`READS`), read by `engine/cf.py`.
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
- `bugs_bot/agent.py:223`: `deploy_check` runs with `shell=True` from `.bugs-bot.json`, under the blanket `Bash(bugs-bot:*)` rule. (Phase 0.) **Fixed**: the command is split into words and run
  without a shell, only when the project file is the operator's alone.
- `bugs_bot/registry.py:91-121`: `add`/`remove` read-modify-write without the lock; `jsonio.py:13` uses a fixed `.tmp` name. **Fixed** (#25).
- `tests/test_tm_bugs.py:394`: fails by the calendar (the purge reads the wall clock, `pull.py:24,113`). **Fixed** (#25).
- `hooks/guard.ts:83-124`: the group-post guard fails open. **Fixed** (#16).
- `hooks/core.ts` (`selfOf`, `peersOf`) parses `ListAgents` text; the launcher path and the measure-file layout are hard-coded. **Fixed**: core's `orchestration.ts`.
- `agent/AGENT.md`, `skills/bugs-bot/SKILL.md`: about 13k tokens per agent run, a dated ruling at `AGENT.md:17`; about 62 test reads of `.md` wording. **Fixed**: the agent
  reads `AGENT.md` alone, which now holds the voice (5,959 tokens in `npm run context`'s resident-agent scenario, from 11,468); the quoted
  ruling and the rules said in both files are gone, and so are the tests that read a document's wording.
- Suspected: tester text and images reach the orchestrator with only prose protection; `--image` (`images.py:77`) posts any local image. **Fixed** for the images: only
  PNG, JPEG or WebP of 10 MB or less. The first suspicion is read and true: the agent, a model, copies the report's text into its message to
  the launcher, and only the prose of `AGENT.md` and `SKILL.md` says it is data (`hooks/guard.ts` reads what goes out to the group, nothing coming in).
  **Open: a choice.** The agent keeps sending the tester's text in its message, and the launcher has the bug in front of it at once; or it sends
  only the report's id, and the launcher runs `bugs-bot show <id>` to read the text as a command's output, one more step for each bug.

**github**
- `hooks/ready.ts:476`: the records guard matches the text `pr-records/`; a built path or `rec""ord.py` passes, so a record can be forged; NotebookEdit is not covered (`register.ts:1438`). **Fixed** (#31).
- `hooks/register.ts:1084-1118`: waivers and auto-merge consent are read from the orchestrator's private `round/` files. **Fixed** (#78): consent records.
- `hooks/ready.ts:468-489`: the base plugin names its consumers. **Fixed** (#78): producers declared in core's `pr-record.ts`.
- `engine/ghlib/http.py:122`: every 403 is retried, POSTs included; GraphQL gets no retry. **Fixed** (#31).
- Every guard ends in `.catch(… next(e))` (`register.ts:1435,1450`): fails open. **Fixed** (#15).
- `auto-merge.json` is read-modify-write without a lock. **Fixed** (#36).
- `register.ts:254`, `guards.ts:278`: WRITING.md (about 3.3k tokens) is read whole once per session and once per subagent before any authoring call.
  **Fixed** (#41): one file per kind under `engine/writing/`, named by the tool's description (`hooks/register.ts:2177`), and no guard asks for a read
  before a call any more; a commit reads 514 tokens, a comment 380, a pull request 2,004 (`npm run context`).
- Suspected: `image-upload` pushes any local file to a `pr-assets` branch once allowed for the session. **Fixed** (#31): images only.

**norms**
- `hooks/record.ts:71-104`: the pass is computed from figures the model passes in; `:35-39` stores the scope's head and never compares it at `check_done`.
  **Partly** (#28, #77, #181): the head is compared and later commits may touch only the files the check
  read; the figures the model passes must account once for each finding its agents reported, and the pass is still `open === 0` over them
  (`hooks/record.ts:268`). **Open: a choice.** The check keeps the model's word on which findings it fixed, with one round of agents as today; or the
  agents run again after the fixes and the pass is what they still report, a second round of agents for each check that fixed something.
- `hooks/guards.ts:50`: `/\bpush/i` on the last prompt grants a push (« don't push » included). **Fixed** (#28): the host's dialog.
- The agents declared « read-only » carry `Bash`. **Fixed** (#28) by a guard on their shell.
- `hooks/check.ts:83` couples to `ORCHESTRATOR_SPAWNED`; `scripts/resolve_base.sh:31` calls raw `gh`. **Fixed** (#28).
- Suspected: `/norms:learn` writes reviewer text into project rules, an injection path. **Dropped**: the threads reach the model fenced and named as
  data (`hooks/learn.ts:56-73`), the rule proposed is the model's own sentence, and none is written to `CONTRIBUTING.md` before the person has read it
  and said « add », one rule at a time (`commands/learn.md:15-16,119`).

**pr-review**
- `hooks/loop.ts:57-63`: `start` then `findings {keys: []}` records a clean pass with no review run and no pinned head. **Fixed** (#18).
- `hooks/policy.ts:43,60`: `grantsEdit`, `grantsPush` match the word (« don't fix this one », « do not push yet » grant). **Fixed** (#17).
- `runsGitPush` misses `sh -c` and `eval`. **Fixed** (#29).
- `install.sh:49-150` installs and signs in gh a second way; the fallback writes the fixed `/tmp/claude-pr-review-request.json`. **Fixed** (#29, #37).
- `skills/auto-fix-loop`: up to 5 review passes, against the orchestrator's one review and one correction round; aligned when it runs under orchestration. **Fixed**: `MAX_PASSES` is core's cap
  of review rounds, 3 (`hooks/state.ts:84`), and a session the orchestrator spawned runs the rounds of its pull request's check plan
  (`hooks/loop.ts:439-455,559`). The orchestrator's review brief runs its own readers and never the loop, so `review_only` has no place in it.

**implement**
- The implementer runs `implement:check` on its own work. **Fixed** (#20): the check is a
  self-check that writes no record (nothing in `plugins/implement` calls `mcp__github__record`); the review is `/implement:review`, in another session.
- `hooks/core.ts:402`: any prompt with « agent » lifts the subagent refusal. **Fixed** (#30).
- `hooks/core.ts:420-438`: the check's read-only guard misses `sed -i` and redirections. **Fixed** (#30).
- `hooks/core.ts:441`: the host's commit attribution is silenced during feature, phase and close.
  Kept: it is the repository's rule (no attribution, `docs/conventions.md`).
- `tests/run-tests.sh:109`: a locale-dependent wording lint. **Fixed** (#30).
- Open decision for the operator: implement reserved to solo work and refused in orchestrated briefs, or merged into the implementer brief.
  Today no orchestrator brief names implement. **Open: a choice.** Implement stays the method of a person working alone and an orchestrated agent
  follows its brief only, two ways of working that never mix; or its phases go into the implementer brief, and every delivery, alone or
  orchestrated, has the same plan, state file and gate commits, in a longer brief.

**statusbar**
- `statusline/statusline.sh:122-130`: `date -r <epoch>` is macOS-only; on GNU the reset times vanish silently. **Fixed** (#22).
- `install.sh:200-211`: overwrites a foreign `statusLine` (backup only), not atomic, replaces a symlinked `settings.json` by a file. **Partly** (#22): atomic, through the
  symlink, with a backup; a foreign `statusLine` is still replaced, with a message (`install.sh:216-221`). **Open: a choice.** The install replaces
  another tool's status line and says so, the old command kept in the backup, one command as today; or it stops when it finds one and asks before
  replacing it, one more answer to give at install (non-goal 2 weighs against it).
- `statusline/statusline.sh:20` sources its config file as code at every redraw. **Fixed** (#22).
- Suspected: `git status` without `GIT_OPTIONAL_LOCKS=0` can take `index.lock` beside agents; `launcher.sh:10` takes the first install path. **Fixed** (#22).

**orchestrator** — `orchestrator-refoundation-design.md`, whose « State on main » holds its state.

**Every plugin** — TypeScript handlers typed `$: any` with no tsconfig; TypeScript tests that run only inside the host (`claude-code/testing`), to be made runnable in CI or replaced by tests of pure modules.
**Partly**: see goal 5. Every plugin that has hook tests (bugs-bot, cloudflare, github, implement,
norms, the orchestrator, pr-review and statusbar) runs them in its suite with `claude plugin test`,
so CI runs them; cloudflare's suite alone skips them when `claude` is not on PATH.

## Non-goals

1. Moving the orchestrator, coordinator or auditor out of iTerm sessions.
2. Any new permission prompt, approval step or operator chore.
3. Changing `deck.json`'s format.
4. Porting the Python engines to TypeScript.
5. New features outside the goals above.

The next spec of the program is `method-drift-design.md`, correcting the drift of the method: pull requests no longer go all the way.
