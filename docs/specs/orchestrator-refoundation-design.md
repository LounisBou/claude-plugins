# Orchestrator refoundation — design

The orchestrator's part of `program-design.md`, whose priorities, conventions and phases
govern it. Paths are relative to `plugins/orchestrator/`; line numbers are at 0.98.0.

## Why

An outside audit of 0.98.0 found a sound method carried by an architecture that no longer
holds it: 446 commits in two months with 7 refactors, a stop gate turned from refusal to log
and back within two days, the same rule written in TypeScript, bash and Python, state spread
over JSON files written by several processes without locks, about 60,000 tokens of rules
loaded into every orchestrator, and evals that grade obedience to the plugin's own wording
rather than the quality of what ships. This build fixes the verified defects, then rebuilds
the foundations in place, one stacked pull request at a time, without changing how the
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

1. The verified defects are fixed, each with a test that fails when its fix is reverted.
2. Spawning is hardened without any new prompt: the launcher accepts only an allowlisted permission mode, and the trust-file write is locked, atomic and backed up.
3. The local command-text push guard is removed once the program's forge protection has shipped.
4. Every machine-wide fact of the orchestrator is kept by core's store, and `deck.json` is a view of it whose format is unchanged.
5. A wait is declared by a structured tool call, `declare_wait({kind, blocks})`, and the stop gate decides on it deterministically.
6. The hooks module is strict TypeScript on core, and every bash script is ported to TypeScript; Python remains only as a thin iTerm2 API adapter.
7. The machine-to-machine move works end to end on core's store.
8. The method kernel is about 2,000 tokens: ten principles, no dated quotation, each tested by ablation.
9. Outcome evals compare a single session with an orchestration on replayed merged pull requests and are re-measured at every release.
10. `routing.py` is reduced to the tier-to-alias map and the cost rule, with one price table.

## Verified defects (goal 1)

Each was read in the code; line numbers are at 0.98.0.

- `hooks/stop-gate.ts:470-474`: the `idle-delivered` warning still returns before every
  other check, so one idle agent with an open or merged pull request skips `waiting: done`,
  `tool-not-running` and the malformed-line refusals; `idle-agents` (`:491`) does the same.
  `stop-gate.test.ts:1738` pins the wrong behaviour and is the test the ruling names to change.
- `hooks/supervision.ts:497` (also `commands.ts:83,185`): a `Set` passed where a
  `ProcessTable` (`Map`) is expected.
- `hooks/supervision.ts:857-866`: `paneIsOpen` judges liveness by bare pid, outside the rule
  `runsLive` applies.
- `hooks/gauge.ts` catch path: a failed measure keeps the previous reading, rewritten with
  its old `updated_at`; `currentIn` is not checked against the session id (`supervision.ts:1158`).
- `writeAtomic` temp files left by a killed process are never removed (`supervision.ts:490,2578`).
- `skills/coordinator/scripts/coordinator.sh:961,963`: `l[k] = (k in l) ? …` evaluates after
  `l[k]` exists under mawk; collision lines start with `", "`.
- `iterm_agent.py:4048-4052`: the trust-file rewrite has a fixed temp name and no lock.
- `iterm_agent.py:4091,3941`: `--permission-mode` is free-form while `install.sh:42` pre-approves
  `spawn --open *`, so a prompt injected into an `Orch :` session can launch `bypassPermissions`.
- `routing.py:1500`: `--max-usd` is checked only at job submission.
- `stop-gate.ts:56` `withDeadline` abandons work without cancelling it; late writes can land
  after newer ones.
- Suspected, to confirm or drop with a reading: lost updates on round entries between the
  pane answer and a withdrawal; `close` by a recycled tty; ignored files outside the
  `workspace.sh delete` guard; measure and stop handlers past the host's handler budget.
- Test portability: `tests/run-tests.sh` fails 29 of 2,240 checks on Linux as root (`chmod 000`
  under root, `stat -f` on GNU, `pgrep -f` self-match at `:5180`, `ls | grep -c` at `:5557`,
  temp-path length at `:4989`). The suite runs green on macOS and Linux.

## Constraints

- Incremental replacement, stacked pull requests; the plugin is usable after every merge.
- Kept as they are: review on evidence, the orchestrator never judging itself, the merge
  reserved to the operator, the context gauge, the `workspace.sh delete` guards (carried over
  verbatim when ported), the iTerm launch, the home session, `deck.json`'s format.
- One implementation per rule, in core when another plugin needs it (`docs/conventions.md`).
  A port replaces its source in the same pull request.
- A rule enters the kernel only when an eval shows it changes an outcome; a new rule
  replaces one.
- Transitional compatibility where a format changes (the last-line wait is still read
  until `declare_wait` has shipped and the kernel teaches only the call).

## Phases (the orchestrator may split, never merge two)

1. Defects: goal 1, on the current code.
2. Hardening: goal 2; goal 3 once the program's forge protection (its goal 12) has shipped.
3. State: goal 4, once core's store exists (program phase 2), with a measured cut in processes spawned per measure event.
4. `declare_wait`: goal 5.
5. Strict TypeScript and ports: goal 6, one script per pull request, `workspace.sh` last.
6. Move: goal 7, once the state module has shipped; the operator lists what fails today.
7. Kernel: goal 8, after phase 8's harness exists for the ablation.
8. Outcome evals: goal 9; six to ten merged pull requests replayed, a spend cap per
   measure stated before any run, the cap the operator's.
9. Routing: goal 10.

## Non-goals

1. Moving orchestrators, coordinators or auditors out of iTerm sessions.
2. Any new permission prompt, approval step or operator chore.
3. Changing `deck.json`'s format or the Stream Deck contract.
4. Removing the machine-to-machine move, the cost accounting or the home session.
5. New features outside the goals above.
