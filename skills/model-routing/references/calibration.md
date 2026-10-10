# Calibration: how the routing tables are measured

`routing.py pick` reads a pair from the most specific table that has one: the project's, its
profile's, the global one, a shipped default, then the tier table of the skill. This reference
is how those tables are made, in the order the operator runs the steps. Every command is
`routing.py <subcommand>` (`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/scripts/routing.py`),
and everything it writes lives under `<state dir>/routing/`: measured tables name model
identifiers, so they never enter the plugin.

## 1. Harvest the tasks

`harvest <repo> --class <class> --pr <n> [--pr <n>]... [--test-command <cmd>] [--test-glob
<glob>]... [--budget-usd <x>]` drafts one bench task per merged pull request, `pr-<n>`, and
prints `harvested pr-<n> (draft)`. Its base is the merge's first parent; its brief is written
to `projects/<slug>/briefs/pr-<n>.md` from the pull request's title and body, with every
fenced code block stripped. The task is appended to `projects/<slug>/manifest.json`, which
also holds the repository, its profile, the test command, the test globs and each trial's
spending cap in dollars (`budget_usd`, 2 by default); harvesting a pull request again
replaces its task and drafts it anew. Only merged pull requests are replayed: the bench has no
synthetic task. The forge is reached through `gh` (`ORCHESTRATOR_GH` names another binary);
when it does not answer, `harvest` stops and names the pull request, and a task can be written
into the manifest by hand.

## 2. Review each brief and mark it ready

A drafted brief is marked `draft`, and `bench` refuses a task whose brief still is. Read each
brief as the agent will: it must state the work without leaking the answer — a file list or a
test the body spelled out in prose is yours to cut. Then `ready <slug> <task-id>...` it.

## 3. Set the test command and the test globs

The manifest's `test_command` is what grades a trial mechanically, and its `test_globs` say
which files of the merged diff are tests. Those files are copied over the agent's tree after
it finishes — tests it never saw — and the test files the merge deleted are removed, before
the command runs in the trial's directory. A manifest without either is refused by `bench`.
Both are set by `harvest --test-command` and `--test-glob`, or in the manifest.

## 4. Run the bench, on the operator's cap

`bench <slug> --max-usd <n> [--grid <pair>,...] [--families <a>,<b>] [--reps 2]
[--concurrency 2] [--class <class>]` runs the ready tasks on a grid of pairs: the families
bound in the tier map (or those `--families` names) times the five efforts, or the pairs
`--grid` names. It prints one line per trial and a last line `bench: spent=<usd> trials=<n>
unmeasured=<n>`, where unmeasured counts every planned trial the cap or a dropped pair left
undone. `--max-usd` is required and
the operator gives it: the run stops starting trials when the trials and their judges have
cost that much, finishes those in flight, and prints what is left unmeasured. Nothing else
stops a run; the subscription gauge is recorded with each trial as a control, never read to
stop, slow or choose.

A trial sees the tree at the task's base with no history, so the merged commit is
unreachable, and its one commit holds every file of the base whatever ignore rules apply; its directory is created under the system's temporary root and removed when the
trial ends. It runs headless on its pair, the brief on stdin, with the manifest's per-trial
spending cap and a wall-clock timeout (`ORCHESTRATOR_TRIAL_TIMEOUT`, 1800 seconds by default),
in the permission mode `config.json` gives its alias (`{"modes": {"<alias>": "acceptEdits"}}`)
or `auto`. It loads the project's settings only, never the user's (instructions, plugins,
hooks), because a trial measures the pair on the project, not on the operator's environment.
A mechanical pass goes to a judge at the `deep` tier's pair (effort `high` when the
map binds none) with the fixed rubric `references/judge-rubric.md`; a run with the `deep` tier
unbound is refused before anything is spent. Satisfaction is a mechanical pass and a judge
pass. A timeout, a host that crashes or cannot start, a cap reached, tests that never finish or
a judge answer that does not read is an `error`: its cost counts, it says nothing about the
pair's reliability, and three errors drop the pair from the run — errors of this run only, so
one host outage never strikes a pair for good. A judge that answers nothing after a mechanical
pass is an `error` too (`judge` null) but is never counted toward a drop: the agent did its
part. A worker that raises is recorded as an `error` trial, never lost.

A cost that cannot be read — no answer, or a model with no figure and no total to fall back
on — is never free: the trial is charged the per-trial ceiling it was launched with, carries
`"cost_incomplete": true`, counts toward the cap, and stays out of the pair's mean cost.
A timeout kills the whole process group of the host and of the test command.

Two limits, plainly. A trial's isolation removes the history, but the headless session runs
with its own permissions on the machine and could reach the real repository. And with
`--concurrency N` a run can pass `--max-usd` by at most N per-trial ceilings, since the trials
in flight finish.

Each trial is one line of `projects/<slug>/trials.jsonl`: task, class, pair, repetition, the
model identifiers the host reports with their cost, `cost_usd` (the host's own per-model
figure, so no price file is needed), tokens, duration, the mechanical result, the judge's
verdict, scores (`judge_scores`) and reasons (`judge_reasons`), and its cost kept apart, and the subscription gauge before and after, read from the
file `ORCHESTRATOR_QUOTA_FILE` names, or `null`. Every trial also records which identifier its
alias resolved to.
A trial whose tests fail also carries `tests_tail`, the last 2,000 characters of the test
output, and `tests_failed`, the lines of that output holding `FAIL`, `FAILED` or `ERROR` as a
whole word, in order, at most 40 of them, each cut at 300 characters, and empty when no line
matches, because a suite that prints its failures where they happen leaves none of them in the
tail. A trial whose judge answer does not read carries `judge_raw`, the first 2,000 characters
of that answer, with `judge_ok`, whether the host reported a successful run.

Each class runs in two stages. **Screening**: every pair once on two tasks. **Confirmation**:
the pairs that passed both screening trials and cost within 1.5 times the cheapest passing
one, on every task of the class, `--reps` times (2 by default). A run interrupted and
restarted re-pays no trial already recorded in `trials.jsonl`.

## 5. Calibrate the project's table

`calibrate <slug>` reduces the project's trials to one entry per class, written to
`tables/project-<slug>.json`. Per pair it measures `n` (graded trials, errors excluded), the
pass rate, the mean cost per trial (errors included), and the **expected cost per satisfied
dispatch**: the mean cost plus (1 - pass rate) times the mean cost of the next pair up the
ladder, since a failure in production is paid by an escalation. The pairs, cheapest first,
form the class's ladder; the entry is the eligible pair with the lowest expected cost, ties
to the higher pass rate. A class with no eligible pair gets no entry, and `pick` falls
through to the next table.

`--from-record <record>`, repeatable, adds the dispatch record's closed pair rows as trials:
one round and no escaped defect is a pass. A row whose cost is incomplete, or that names no
effort, is left out. This is how an exploration's promotion reaches the table.

**The reliability floors.** A pair is eligible with at least 6 graded trials and a pass rate
at or above the floor: 0.9 by default, 1.0 for `contract-phase` and `final-verification`,
work nothing re-checks. `config.json` may set `{"floor": {"default": <rate>, "strict":
<rate>}}`.

## 6. Generalise to profiles and the global table

`generalize` pools the trials of every project sharing a profile — the
`<language>/<kind>` `routing.py profile <repo>` prints, or the manifest's own — and runs the
same selection, with one more condition: the chosen pair must meet the floor in each project
where it was measured, so one easy project cannot drag a profile down. A profile table needs
at least two projects; until then the global table, the same fold over every project,
serves it. Projects of unknown language never form a profile: they share nothing but the
absence of a marker, so they count toward the global table only. A pair held back by one
project (with at least 6 graded trials of it below the floor) keeps its pooled figures on the ladder, marked not eligible. `generalize` prints
`profile=<p> projects=<n> classes=<n>` per profile table and `global projects=<n>
classes=<n>`.

## 7. Show what is measured

`show [<slug>]` prints, per project, one line per class: `class=<c> project=<pair|->
profile=<pair|-> global=<pair|->`, the coverage of each table, with `stale` at the end when an
entry was measured on a model identifier the alias no longer resolves to; a class on no line
falls to the tier table. Every `cost` run on a record row and every trial updates which identifier an
alias resolves to. A stale entry is still used; the operator decides whether a bench run is
worth refreshing it.

## 8. Export the shipped defaults

`export [--to <dir>]` rewrites the local profile and global tables into the plugin's
`defaults/`, each pair's family replaced by the tier the map binds it to (`standard/medium`),
its ladder written the same way, model identifiers, costs and project names dropped. A table with no class in tier form is not written (`export: <file> has no class in tier form, not written`), and an existing file stays as it was. A family
bound to no tier is skipped with a warning, `export: <alias> is bound to no tier, <class>
skipped`; `pick` reads a shipped ladder's rungs back through the map. The exported files name no model, so they resolve through any operator's own map.
The operator decides when an export is committed.
