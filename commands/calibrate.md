---
description: Calibrate a project's routing table on the operator's spend cap — harvest, ready, bench, calibrate, in order, stopping at the first failure; generalize and export are left to him
argument-hint: <checkout or slug> --max-usd <cap> --class <class> --pr <n> [--pr <n>]... [--test-command <cmd>] [--test-glob <glob>]... [--budget-usd <x>]
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/model-routing/scripts/routing.py:*), Bash(ls:*), Read
---

Calibrate one project's routing table: the four `routing.py` steps of « Calibrating a new
project » in `orchestrator:model-routing`, run in order, each on what the one before it wrote.
`references/calibration.md` of that skill has the detail of every step. Everything lands
under `<state dir>/routing/`. `routing.py` below is
`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/scripts/routing.py`.

## 0. The arguments, before anything runs

- **The spend cap.** `--max-usd <cap>`, a number above zero, in dollars.
  **No cap given, the command refuses and asks the operator for one: it never picks a cap itself**,
  never reads one from a previous run, a default or a figure in the conversation. The cap is his consent
  to what the bench spends; nothing is spent without it.
- **The project.** A checkout path, as `harvest` takes it, or the slug of a project already
  harvested, whose checkout is the `repo` of `<state dir>/routing/projects/<slug>/manifest.json`.
  A slug with no manifest is refused: `harvest` needs a checkout.
- **What to harvest.** `--class <class>` and at least one `--pr <n>`, merged pull requests whose
  merge commit is in the local clone. Missing, refuse and ask for them. `--test-command`,
  `--test-glob` and `--budget-usd` are passed to `harvest` as given.
- **The judge.** Read `<state dir>/models.json`. With no `deep` entry, stop here and say so:
  `bench` refuses a run with the `deep` tier unbound, since the judge has no model. Binding it
  is the operator's; this command never writes the map.

Tell the operator, in one line, the project, the class, the pull requests and the cap.

## 1. Harvest

```
${CLAUDE_PLUGIN_ROOT}/skills/model-routing/scripts/routing.py harvest <checkout> --class <class> --pr <n> [--pr <n>]... [--test-command <cmd>] [--test-glob <glob>]... [--budget-usd <x>]
```

It prints `harvested pr-<n> (draft)` per task; those ids are what `ready` takes. A non-zero
exit is a failure: report its last line (`harvest: <n> pull request(s) skipped: <numbers>`)
and stop.

The slug is the directory under `<state dir>/routing/projects/` whose manifest's `repo` is the
checkout (`ls` the directory, then read the manifest). Read that manifest: **an empty
`test_command` or empty `test_globs` stops the command here**,
because `ready` and `bench` both refuse such a manifest. Say which is missing and that `--test-command` and
`--test-glob` set them.

Then read each drafted brief, `projects/<slug>/briefs/pr-<n>.md`, as the agent will. A brief
that leaks the answer (a list of the files to change, a test the body spelled out) is quoted
to the operator, and you wait for him to cut it before going on. Never run `harvest` again
after he has edited a brief: it drafts the briefs anew.

## 2. Ready

```
${CLAUDE_PLUGIN_ROOT}/skills/model-routing/scripts/routing.py ready <slug> <task-id>...
```

The control run: each task's merged commit runs its own tests. Report the `ready:` and `void:`
lines. A non-zero exit is a failure: report its last line (`ready: voided <id>...`, or the
refusal) and stop. The tasks marked `ready` stay ready; the operator decides whether to bench
them as they are.

## 3. Bench, on the operator's cap

Before running it, state in one message what it will spend at most and on what: the cap
(`--max-usd <cap>`), the grid (the families bound in the map times the five efforts), the
ready tasks, the per-trial cap (`budget_usd` in the manifest), the judge at the `deep` tier's
pair, and that with the default concurrency of 2 the run can pass the cap by at most two
per-trial caps, the trials in flight finishing. Then run it: the cap is the consent.

```
${CLAUDE_PLUGIN_ROOT}/skills/model-routing/scripts/routing.py bench <slug> --max-usd <cap>
```

It prints one line per trial. Report its last line only, `bench: spent=<usd> trials=<n>
unmeasured=<n> pruned=<n>`, with any `dropping <pair>` warning. A non-zero exit is a failure:
report its last line and stop.

## 4. Calibrate

```
${CLAUDE_PLUGIN_ROOT}/skills/model-routing/scripts/routing.py calibrate <slug>
```

It writes `tables/project-<slug>.json`, which `pick` reads first, and prints one line per
class. Show those lines to the operator as the resulting table; a non-zero exit is reported
with its last line.

## Then stop

**`generalize` and `export` are not run by this command.** Pooling the project into the
profile and global tables, and writing the shipped defaults, are the operator's to ask for.
End with one line saying so.

$ARGUMENTS
