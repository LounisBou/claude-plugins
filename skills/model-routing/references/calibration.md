# Calibration: how the routing tables are measured

`routing.py pick` reads a pair from the most specific table that has one: the project's, its
profile's, the global one, a shipped default, then the tier table of the skill. This reference
is how those tables are made, in the order the operator runs the steps. Every command is
`routing.py <subcommand>` (`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/scripts/routing.py`),
and everything it writes lives under `<state dir>/routing/`: measured tables name model
identifiers, so they never enter the plugin.

## 1. Harvest the tasks

`harvest <repo> --pr <n>... --class <class>` drafts one bench task per merged pull request:
its base is the merge's first parent, its brief is written to `briefs/<task>.md` from the pull
request's title and body, with any diff, file list beyond the ones the body names, and test
file content stripped. The task is appended to the project's manifest. Only merged pull
requests are replayed: the bench has no synthetic task. Without forge access, `harvest` stops
and names the pull request; a task can be written by hand.

## 2. Review each brief and mark it ready

A drafted brief is marked `draft`, and `bench` refuses a task whose brief still is. Read each
brief as the agent will: it must state the work without leaking the answer. Then `ready` it.

## 3. Set the test command and the test globs

The manifest's `test_command` is what grades a trial mechanically, and its `test_globs` say
which files of the merged diff are tests. Those files are copied over the agent's tree after
it finishes — tests it never saw — before the command runs. A manifest without either is
refused by `bench`.

## 4. Run the bench, on the operator's cap

`bench <slug> --max-usd <n>` runs each task on a grid of pairs: the families bound in the
tier map times the five efforts, or the pairs `--grid` names. `--max-usd` is required and
the operator gives it: the run stops starting trials when the trials and their judges have
cost that much, finishes those in flight, and prints what is left unmeasured. Nothing else
stops a run; the subscription gauge is recorded with each trial as a control, never read to
stop, slow or choose.

A trial sees the tree at the task's base with no history, so the merged commit is
unreachable. It runs headless on its pair with a per-trial spending cap and a wall-clock
timeout. A mechanical pass goes to a judge at the `deep` tier's pair with a fixed rubric;
satisfaction is a mechanical pass and a judge pass. A timeout, a host crash, a cap reached or
a judge answer that does not read is an `error`: its cost counts, it says nothing about the
pair's reliability, and three errors drop the pair from the run.

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
serves it.

## 7. Show what is measured

`show [<slug>]` prints the tables, the coverage of each class (measured, profile, global,
tier table), and the stale entries: those measured on a model identifier the alias no longer
resolves to. Every `cost` run on a record row and every trial updates which identifier an
alias resolves to. A stale entry is still used; the operator decides whether a bench run is
worth refreshing it.

## 8. Export the shipped defaults

`export [--to <dir>]` rewrites the local profile and global tables into the plugin's
`defaults/`, each pair's family replaced by the tier the map binds it to (`standard/medium`),
model identifiers and project names dropped. A family bound to no tier is skipped with a
warning. The exported files name no model, so they resolve through any operator's own map.
The operator decides when an export is committed.
