# Orchestrator refoundation — design

The orchestrator's part of `program-design.md`, whose priorities, conventions and phases
govern it. Paths are relative to `plugins/orchestrator/`; line numbers are at 0.98.0.

## Why

An outside audit of 0.98.0 found a sound method carried by an architecture that no longer
holds it: 446 commits in two months with 7 refactors, a stop gate turned from refusal to log
and back within two days, the same rule written in TypeScript, bash and Python, state spread
over JSON files written by several processes without locks, about 60,000 tokens of rules
loaded into every orchestrator, and evals that grade obedience to the plugin's own wording
rather than the quality of what ships. This build rebuilds the foundations in place, one stacked pull request at a time, without changing how the
operator works.

## Operator priorities (they rank every trade-off below)

1. **Fluidity.** Orchestrators and agents work autonomously: no new permission prompt, no
   new question to the operator, no new manual step. What works today keeps working at every
   merged phase: one iTerm tab, `claude`, `/orchestrator`; agents spawned without approval;
   never-opened directories trusted by the launcher; real iTerm sessions for orchestrator,
   coordinator and auditor; agents as windows of the orchestrator's home session; `deck.json`
   read by the Stream Deck.
2. **Ready means done.** The definition of done guarantees the work is done, done well and
   complete; nothing in this build weakens it.
3. **Separation of roles.** Implementers write, a review session reads, the orchestrator
   answers for the code and never implements, not even through a subagent of its own.
4. **Single source of truth.** Each fact, rule, path, name shape and price lives once; every
   other place reads it. Its absence is the recurring cause of the repeated fixes.
5. **Maintainability.** Clear architecture, small modules with one job, clean code,
   stability over features.
6. **Token economy.** Light briefs, no repetition, a light starting context, and the
   succession (the plugin's own compaction) kept and made cheaper.

## Goals

1. Every machine-wide fact of the orchestrator is kept by core's store, and `deck.json` is a view of it whose format is unchanged.
2. A wait is declared by a structured tool call, `declare_wait({kind, blocks})`, and the stop gate decides on it deterministically.
3. The hooks module is strict TypeScript on core, and every bash script is ported to TypeScript; Python remains only as a thin iTerm2 API adapter.
4. The machine-to-machine move works end to end on core's store. **Withdrawn**: deleted by #270.
5. The local command-text push guard is removed once the program's forge protection has shipped.
6. Deadlines cancel their work, and no temporary file outlives the write that made it.
7. The suite blocks on macOS and Linux.
8. The method kernel is about 2,000 tokens: ten principles, no dated quotation, each tested by ablation.
9. Outcome evals compare a single session with an orchestration on replayed merged pull requests and are re-measured monthly and before any learned method change merges (`program-design.md`, goal 15).
10. `routing.py` is reduced to the tier map, the cost rule and `pick`'s tables, with one price table.
11. The orchestrator starts in a mode: `build` loads the method's lifecycle, `investigate` loads supervision, agents, the gauge and the succession only.
12. The succession brief is generated from the state, its notes of judgment are capped and promoted or dropped at each generation, and a script refuses a brief that misses an open item.
13. Each role's starting context and each succession brief's size are measured at every start.

## What this build starts from

The urgent fixes run first in the former repository (`docs/specs/urgent-fixes-design.md` of
`LounisBou/claude-orchestrator`): the stop gate's order, the liveness reads, the stale gauge
reading, the coordinator's collision lines, the permission-mode allowlist, the locked trust
write. The operator keeps using the former repository's plugin meanwhile: each urgent fix
merged there is imported here the same day (`git diff <last imported> <merged> --binary | git apply
--index --directory=plugins/orchestrator`), and this build runs alongside, a conflict resolved at
the import. The last import is the former repository's `d305921`
(claude-orchestrator#304).

Defects this build owns (line numbers at 0.98.0, relative to `plugins/orchestrator/`):

- `hooks/stop-gate.ts:56`: `withDeadline` abandons work without cancelling it (goal 6).
- `hooks/supervision.ts:490,2578`: `writeAtomic` temporary files left by a killed process (goal 6).
- `skills/model-routing/scripts/routing.py:1500`: `--max-usd` checked only at submission (goal 10).
- `tests/run-tests.sh`: 29 of 2,240 checks fail on Linux as root — `chmod 000` under root,
  `stat -f` on GNU, `pgrep -f` self-match (`:5180`), `ls | grep -c` (`:5557`), temp-path
  length (`:4989`) (goal 7).
- Suspected, to confirm or drop with a reading: lost updates on round entries between the
  pane answer and a withdrawal; `close` by a recycled tty; ignored files outside the
  `workspace.sh delete` guard; handlers past the host's budget.

## State on main (2026-11-15)

Read from the code at orchestrator 0.104.5 (`775d7fdc`), row 9 at `4ca6f735`, rows 2, 3 and 10 at `9543c81a` (#371). Pull requests are this repository's.

| Goal | State | Evidence | Open, and why |
|---|---|---|---|
| 1 | met | the hooks' store on core (`core/store.ts`, `store-io.ts`); `deck.json` (version 3) a view held byte for byte by `hooks/tests/golden-deck.ts`, written only when it differs or is a minute old (#66, #70) | `round/` and `chains/` sit outside `store/`, at the paths the running releases read; every write of either goes through core's store (`store.ts`, `store-io.ts`), the chains' through `chains.ts`, keyed by the session that wrote each entry |
| 2 | partly met | `declare_wait` (`hooks/wait.ts`; #57, #60); the stop gate decides a turn's wake on the wait it declared alone, a turn that declared none ending on no wait (`checkWake` in `hooks/stop-gate.ts`, #179); `hooks/guards.ts` reads the declared wait, no last line (#351) | the relay's readers of a turn's last line remain: an orchestrator's machine line (`parseWait`), an agent's `status:` line (`parseStatus`) and « handed over » (`handsOver`) in `hooks/supervision.ts` (`program-design.md`, goal 9) |
| 3 | met, by the program's non-goal 4 | ported to TypeScript: `ci-watch`, `dispatch-record`, `rhythm`, `workspace`, `short-commands`, `succession` and the coordinator's record, round and sleep commands (#43, #45, #46, #48, #50, #56, #58, #63, #69), `brief-lint` (#341), `install` (#340), `coordinator` (#344), `goals` (#354) and `draft_guard` (#355); every `.sh` of the skills is a launcher of two lines; every hook file is under the strict check (#350, #366) | Python with logic stays in `iterm_agent.py` and `routing.py`: settled by the program's non-goal 4, Python staying where it talks to iTerm2, and `routing.py` staying, by the operator's words of 2026-11-15, about 17:40 Paris, on the recommendation: « suis tes recommandations » (`program-design.md`, last row of « State on main ») |
| 4 | withdrawn | the machine-to-machine move (`hooks/move.ts`, `hooks/moving.ts`) was deleted by #270 | — |
| 5 | met | no push guard in `hooks/guards.ts`; force-push held by github's `/github:protect` (#72) | — |
| 6 | met | `withDeadline` cancels through an `AbortSignal` (`stop-gate.ts`); temporary files older than `STALE_MS` swept (#55, #70) | — |
| 7 | met | the suite blocks on Linux, in four shards (#65, #169), and on macOS's bash 3.2 (`ci/plugins.json`) | — |
| 8 | partly met | ten principles, no dated quotation, on `method:lifecycle` (#67); `npm run context`: 2,153 tokens at a `build` start, 1,552 at an `investigate` start | no principle has been tested by ablation |
| 9 | met | the harness, cases and caps (`evals/outcome/`, `npm run outcome`; #42, #47, #49), the orchestration arm run as an orchestration (#97); one measure, `measure-1`, on 2026-11-10 (`program-design.md`, goal 15) | each case ran once per arm (proposal 6); the next measure is due by 2026-12-10 |
| 10 | met | one price table, `routing/prices.json` in the state directory; the cost rule is data in `hooks/usage.ts`; the calibration engine (`calibration.py`) was deleted by #273; `routing.py` holds the tier map (`CLASS_TIERS`, `models.json`), the cost rule and `pick`'s tables (the operator's hand-written tables, the shipped defaults, the size rule, the exploration notch, the `corrective=` pair, the profile inference `profile` prints), which every dispatch reads through `pick` (`skills/model-routing/SKILL.md`). The goal reads « tier map, cost rule and `pick`'s tables » since the operator's words of 2026-11-15, about 17:40 Paris, on the recommendation: « suis tes recommandations », `pick` and `profile` kept | — |
| 11 | met | « Your mode » in `skills/orchestrator/SKILL.md`: `build` loads `method:lifecycle`, `investigate` does not; both starts are scenarios of `ci/scenarios.json` (#74, #75) | — |
| 12 | met, by another road | `succession.sh takeover` prints the takeover from the state alone (the dispatch record, the to-do list, the round, the goals, agents and pull requests read live): no brief is written, so no note is carried and no brief is left to refuse (#71, #307) | — |
| 13 | met | the measure file's `start` (the first figure, the brief and its size; `hooks/gauge-core.ts`) (#61, #71) | — |

Phases 1, 2, 3, 5, 6, 7, 9, 10 and 11 are done and 4 is withdrawn; 8 is partly done, for the
reason above.

## Constraints

- Incremental replacement, stacked pull requests; the plugin is usable after every merge.
- Kept as they are: review on evidence, the orchestrator never judging itself, the merge
  reserved to the operator outside auto-merge, the context gauge, the `workspace.sh delete` guards (carried over
  verbatim when ported), the iTerm launch, the home session, `deck.json`'s format.
- One implementation per rule, in core when another plugin needs it (`docs/conventions.md`).
  A port replaces its source in the same pull request.
- A new rule of the kernel replaces one.

## Phases (the orchestrator may split, never merge two)

1. State: goal 1, once core's store exists (program phase 2), with a measured cut in processes spawned per measure event.
2. `declare_wait`: goal 2.
3. Strict TypeScript and ports: goals 3 and 6, one script per pull request, `workspace.sh` last.
4. Move: goal 4, withdrawn: the machine-to-machine move was deleted by #270.
5. Push guard: goal 5, after the program's forge protection.
6. Platforms: goal 7.
7. Outcome evals: goal 9; six to ten merged pull requests replayed, a spend cap per measure stated before any run, the cap the operator's.
8. Kernel: goal 8, on the evals' harness, within the program's method plugin if the operator adopts it.
9. Routing: goal 10.
10. Modes: goal 11, once the program's method plugin exists.
11. Succession: goals 12 and 13, on core's store and the round's record of his answers.

## Non-goals

1. Moving orchestrators, coordinators or auditors out of iTerm sessions.
2. Any new permission prompt, approval step or operator chore.
3. Changing `deck.json`'s format or the Stream Deck contract.
4. Removing the cost accounting or the home session.
5. New features outside the goals above.

## Review notes (2026-11-11)

Read against Jarmak 2026, « Engineering Reliable Coding Agents » (arXiv:2608.13867), chapters
13 to 15, and the studies they cite. They propose; none changes a goal until the operator
takes it.

**Already where the evidence points; keep.**

- **The succession is rebuilt from durable sources** (goal 12, decision 0007): its live state
  is printed from the state by `succession.sh takeover`
  (`templates/orchestrator-succession-brief.md`), and no note is carried. A memory a model rewrites summary after summary degrades
  (Zhang 2026, arXiv:2605.12978); immutable sources with derived summaries is the remedy, and
  this is it.
- **A brief makes the agent verify the state, not believe it** (`references/brief.md`, item
  2), and the successor reads the artifact before the brief when they disagree.
- **A light start** (goal 8, 2,153 tokens at a `build` start). Standing context files did not generally
  improve task success (Gloaguen et al. 2026, arXiv:2602.11988), and across 288 runs their
  effect on correctness was bounded to about 10 to 15 points at most (Khatri 2026,
  arXiv:2607.27250).

**Proposals.**

1. **The rotation gate is a default, not a measure.** `tripGate` hands over at 80 % of the
   window or 300,000 tokens (`hooks/gauge-core.ts`). The useful window is far smaller than the
   advertised one: on repository tasks, Claude 3.5 Sonnet fell from 29 % at 32,000 tokens to
   3 % at 256,000 (Rando et al. 2025, arXiv:2505.07897). That model is old and the figure does
   not transfer; the method does. The dispatch record holds rounds and escapes per dispatch and
   the measure file the context size: join them, and set each role's gate where rounds or
   escapes start to rise on the operator's own work.
   Put to him 2026-11-15, cost M (a join of the dispatch record and the measure file, then a gate per role); not taken.
2. **A restart on behaviour, not only on tokens.** Instructions given in pieces cost 39 % of
   performance on average, models committing early to a guess and not recovering (Laban et al.
   2025, arXiv:2505.06120, over 200,000 simulated conversations; not coding agents). Signs a
   gauge cannot see call for the same fresh start from a consolidated brief: an agent
   proposing again what an answer of his in the round rejected, re-reading a file it already read
   in the same phase, a second correction round on the same finding. Each is countable by
   code; each could trip the gate as tokens do.
   Put to him 2026-11-15, cost M (three counters in the gauge, each tripping the gate); not taken.
3. **Every brief names the head it was written against.** Stale context misleads: with
   outdated code snippets, two models produced 15 and 13 outputs incompatible with the
   current signature out of the same 17 examples (Weng et al. 2026, arXiv:2605.14478). A phase brief, a resume
   brief and the succession brief carry the commit they were written at; `brief-lint` or the
   launcher compares it with the checkout's head and lists the files the brief cites that
   changed since. With several orchestrations on one base, the case is common.
4. **A handover says what was kept and why.** For a resume brief and the succession, the
   handover of file selection names the files kept with the evidence for each, the
   candidates set aside, and the uncertainty left — not the exploration that found them. File
   selection is where most of the gain lies: on 500 SWE-bench Verified tasks, better file
   localization produced 15 to 17 times as much repair improvement as the later stages, successes
   clustering around six to ten relevant files for one model family (Sepidband et al. 2026,
   arXiv:2604.05481). A brief is judged first on the files it names.
   Put to him 2026-11-15, cost S for the rotation brief, M for the succession; taken for the rotation brief only, by the operator's words of 2026-11-15, about 17:40 Paris, on the recommendation: « suis tes recommandations ».
5. **Tune the succession by its failures.** When a successor misses, misreads or drowns an
   item, classify it — omitted, distorted, buried — and change one rule of the generation at a
   time, re-measured on the same handovers. Failure-driven compression cut peak tokens by 26 to
   54 % while improving success on non-coding agent benchmarks (Kang et al. 2025, ACON,
   arXiv:2510.00615); the transfer to coding agents is an inference to test, not a result.
   Put to him 2026-11-15, cost M (each miss classified, one rule changed and re-measured on the same handovers); not taken.
6. **Goal 9's next step: the pilot, run twice.** The measure of 2026-11-10 (`measure-1`) ran the
   rebuilt arm once on each of six cases; no case has run twice. The next pilot runs twice on the
   same case with the same model pair:

   ```bash
   npm run outcome -- pilot --out <dir-1> --model <agent model> --judge-model <judge model>
   npm run outcome -- pilot --out <dir-2> --model <agent model> --judge-model <judge model>
   ```

   The two runs compare per arm: the same grades twice, or not. On the same version, the
   behaviour baselines disagree with themselves on about one case in five
   (`learning-design.md`, review note 7); if the outcome arms do too, the six-case measure,
   one run per arm, cannot rank the arms, and the cases must grow first. Two runs of one case
   give a signal, not a rate: a rate needs several cases run twice. The runs are the
   operator's — on his machine, since the arm opens its agents through the launcher, and paid,
   up to 20 USD each under `evals/outcome/caps.json`, 40 for the pair.
