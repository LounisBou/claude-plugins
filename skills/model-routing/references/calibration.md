# Calibration: how the routing tables are measured

`routing.py pick` reads a pair from the most specific table that has one: the project's, its
profile's, the global one, a shipped default, then the tier table of the skill, passing over an
entry measured on smaller work than the phase it is given (section 5). This reference
is how those tables are made, in the order the operator runs the steps. Every command is
`routing.py <subcommand>` (`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/scripts/routing.py`),
and everything it writes lives under `<state dir>/routing/`: measured tables name model
identifiers, so they never enter the plugin.

`/orchestrator:calibrate` runs sections 1 to 5 for one project, in order, on the operator's
spend cap: `harvest`, the brief review, `ready`, `bench --max-usd <cap>` and `calibrate`. It
refuses without a cap and never picks one, stops at the first failure, and runs neither
`generalize` nor `export` (sections 6 and 8): those stay the operator's to ask for.

## 1. Harvest the tasks

`harvest <repo> --class <class> --pr <n> [--pr <n>]... [--test-command <cmd>] [--test-glob
<glob>]... [--budget-usd <x>]` drafts one bench task per merged pull request, `pr-<n>`, and
prints `harvested pr-<n> (draft)`. Its base is the merge's first parent; its brief is written
to `projects/<slug>/briefs/pr-<n>.md` from the pull request's title and body, with every
fenced code block stripped. The task is appended to `projects/<slug>/manifest.json`, which
also holds the repository, its profile, the test command, the test globs and each trial's
spending cap in dollars (`budget_usd`, 2 by default); harvesting a pull request again
replaces its task and drafts it anew. Only merged pull requests are replayed: the bench has no
synthetic task. The forge is reached through `gh` (`ORCHESTRATOR_GH` names another binary).
A pull request that cannot be replayed (the forge does not answer for it, it is not merged, or
its merge commit is not in the local clone) is skipped with a warning naming it; every other
pull request of the run is still written to the manifest, and `harvest` then exits non-zero
with `harvest: <n> pull request(s) skipped: <numbers>`. Fetch the missing commit and harvest
the skipped ones again, or write their tasks into the manifest by hand.

## 2. Review each brief and mark it ready

A drafted brief is marked `draft`, and `bench` refuses a task whose brief still is. Read each
brief as the agent will: it must state the work without leaking the answer — a file list or a
test the body spelled out in prose is yours to cut. Then `ready <slug> <task-id>...` it.

`ready` proves each task passable before it is benched. It runs the manifest's `test_command`
on the tree of the task's merged commit (the reference solution: never the base, never an
agent's work), under the trial timeout, and a task whose own merged commit fails its tests can
be passed by no pair. Exit 0 marks the task `ready` and prints `ready: <id> (control passed in
<s>s)`. A failure or a timeout marks it `void`, with `void` holding `control: the merged
commit's own tests fail (exit <n>)` or `control: the merged commit's own tests time out`, and
prints `void: <id> <reason>`, then the first five failing lines on stderr. What the control
saw stays on the task as `control`: `at`, `exit` (`null` on a timeout), `duration_s` and, when
it did not pass, `tests_failed` and `tests_tail` as a failed trial keeps them. The tasks are
proved in the order given and the manifest is written after each, so a run killed midway keeps
the tasks proved before it; `ready` exits 1 when it voided any, its last line `ready: voided
<id>...`. A manifest with no `test_command` or no `test_globs` (section 3) or an unknown task
stops it before any run, and a merged commit the clone cannot read stops it at that task,
which is left as it was: that is no verdict on the task.

`void <slug> <task-id>... --reason <text>` sets tasks aside by hand, with no control run. It
is for a task whose merged commit passes but whose tests assert behaviour the brief never
states, which no pair can pass either. The reason is required and non-empty; it is written on
the task (`void`) and printed as `void: <id> <reason>`. A voided task returns only through
`ready`, which proves it again and drops its `void` field when it passes. `bench` skips a task
that is not ready (`bench: task <id> is still a draft, skipped`, or `bench: task <id> is void,
skipped`), and a table counts only the trials of ready tasks (section 5).

## 3. Set the test command and the test globs

The manifest's `test_command` is what grades a trial mechanically, and its `test_globs` say
which files of the merged diff are tests. Those files are copied over the agent's tree after
it finishes — tests it never saw — and the test files the merge deleted are removed, before
the command runs in the trial's directory. A manifest without either is refused by `bench` and by `ready`.
Both are set by `harvest --test-command` and `--test-glob`, or in the manifest.

## 4. Run the bench, on the operator's cap

`bench <slug> --max-usd <n> [--grid <pair>,...] [--families <a>,<b>] [--reps 2]
[--concurrency 2] [--class <class>]` runs the ready tasks on a grid of pairs: the families
bound in the tier map (or those `--families` names) times the five efforts, or the pairs
`--grid` names. It prints one line per trial and a last line `bench: spent=<usd> trials=<n>
unmeasured=<n> pruned=<n>`, where unmeasured counts every planned trial the cap or a dropped
pair left undone and pruned the pairs stopped after stage A and never re-admitted (below).
`--max-usd` is required and the operator gives it: the run stops starting trials when the
trials and their judges have cost that much, finishes those in flight, and prints what is left
unmeasured. Nothing else stops a run; the subscription gauge is recorded with each trial as a
control, never read to stop, slow or choose.

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
file `ORCHESTRATOR_QUOTA_FILE` names, or `null`. Every trial also records `model`, the
identifier its alias ran on, and, when one of the models it reports carries the alias, updates
which identifier the alias resolves to. The spec runs each family on its latest release, and an
alias can lag behind it on a host: when the trial's
identifier is an older release of the family than one the host has reported (in any trial, or
in the alias record) or the map names, `bench` and `trial` warn once per family and run,
naming both identifiers. The trial still counts; whether to rebench on the newer release is the
operator's call.
A trial whose tests fail also carries `tests_tail`, the last 2,000 characters of the test
output, and `tests_failed`, the lines of that output holding `FAIL`, `FAILED` or `ERROR` as a
whole word, in order, at most 40 of them, each cut at 300 characters, and empty when no line
matches, because a suite that prints its failures where they happen leaves none of them in the
tail. A trial whose judge answer does not read carries `judge_raw`, the first 2,000 characters
of that answer, with `judge_ok`, whether the host reported a successful run.

Each class runs paired, its tasks in manifest order, every pair on the same tasks:

1. **Stage A**: every pair of the grid, once, on the first half of the class's tasks, rounded
   up (a class of one task runs it).
2. **Prune**: a pair stops here when it passed no stage-A task, or when another pair costs no
   more on average (errors paid for, a cost that could not be read left out), passed every
   stage-A task it passed, and beats it on one of the two: cheaper, or one more task passed. A
   pair dropped after three errors is neither kept nor pruned.
3. **Stage B**: every surviving pair, once, on the remaining tasks. A survivor is then covered
   (section 5), in a class of at least 3 tasks.
4. **Second repetition**: the selection of section 5 is computed on the class's trials. The
   best pair, when it is in the grid, and each covered pair of the grid whose `p_equiv` lies
   between 0.3 and 0.7, run repetitions 2 to `--reps` (2 by default; 1 skips the step) on every
   task, and the selection is computed again. `p_equiv` is the share of paired draws where the
   pair is at least the best minus `delta`, the figure `equivalent` thresholds at one half: a
   pair well inside or well outside that threshold would not move, one near it might.
5. **Re-admission**: when the class is then weak or has no equivalent pair, the pairs pruned
   at step 2 re-enter, cheapest first (mean stage-A cost, then name): each runs stage B and,
   as step 4 would for it, its second repetition if it is the best or between 0.3 and 0.7.
   It stops at the first entry, or when none is left. A class with no covered pair, because it
   has fewer than 3 tasks or nothing survived, has nothing a pruned pair could change.

The cap ends a class at the stage it interrupts: the trials that stage left undone are
counted unmeasured, and no later stage is planned. A run interrupted and restarted re-pays no trial
already recorded in `trials.jsonl` and takes the same decisions: the trials of a pruned pair
stay out of the selection until it re-enters.

## 5. Calibrate the project's table

`calibrate <slug>` reduces the project's trials to one entry per class, written to
`tables/project-<slug>.json`, and prints one line per class: `class=<c> pair=<p>
pass_rate=<r> n=<n> expected_usd=<e> p_best=<p> size=<s>`, or `class=<c> no eligible pair
(<reason>)`.

**Ready tasks only.** A trial of a task the manifest holds as `void`, or still as a `draft`,
is left out before any figure and before `--from-record` adds its rows: nothing could pass
that task, so it would cap every pair under the bar. When `calibrate` leaves any out it says so
once on stderr, `<slug>: excluded <n> trial(s) of task(s) not ready: <ids>`, the ids sorted. A
trial that names no task (a record row) or a task the manifest does not name is kept. Nothing
is erased: a task made ready again brings its trials back.

**What enters.** A trial whose main model — the identifier it spent most on — is not its
pair's model is off-model. A pair naming a full identifier (a dash and a last segment that is
a number or a date, `b-model-1`) is on-model only when the main model is that identifier, a
bracketed suffix on the reported one (`[1m]`) ignored: `b-model-1-1` is another model. A pair
naming an alias is on-model when the main model carries it as a dash segment (`b-model` in
`b-model-1`). Anything else (an alias resolved to another family, a fallback) measured another
model. It is counted in its rung's `off_model` and kept out of every other figure. A trial
that reports no model (a record row, an old trial) is not checked. One model is one pair: a
trial whose pair names the identifier an alias resolves to in `aliases.json` counts under the
alias (`b-model-1/medium` under `b-model/medium` once `b-model` maps to `b-model-1`, the first
alias in name order if several do), the on-model check still reading the pair as recorded; an
older release of the family has no alias and stays a pair of its own. A grid that names that
identifier runs and records under the alias too, so a bench cannot pin one release behind an
alias that lags. `bench` reads its grid the same way, so a trial recorded under the identifier
is reused when the grid names the alias.

**Per task.** A class's tasks are every task with at least one graded trial. Per pair:
`per_task`, each task's `[passes, graded]`; `tasks`, the tasks it was graded on; `n`, its
graded trials (errors excluded); `pass_rate`, the mean of its per-task rates, so a pair is
weighed by the tasks it closed, not by how often it ran them. Its mean cost per trial (errors
included, an unread cost left out) feeds the **expected cost per satisfied dispatch**: the mean
cost plus (1 - pass rate) times the mean cost of the next pair up the ladder, since a failure
in production is paid by an escalation. Beside it, `median_usd` and `median_ci`, the 5th and
95th percentiles of the median over 1,000 bootstrap resamples of the pair's costs. The pairs,
cheapest first, form the class's ladder.

**The selection.** Each pair's success probability is Beta(1 + passes, 1 + fails), drawn 4,000
times for each covered pair, from a generator of the pair's own seeded by the class and the
pair (the cost bootstrap draws from the same one): the same trials give the same file, and
a pair's draws depend on its own trials only, so a pair added without being covered, or a
trial of another class, moves no figure of the others.

- **Covered**: graded on every task of the class, in a class of at least 3 tasks. A class
  with fewer gets `no covered pair`. A class with no bench task (record rows only) covers
  every pair with at least 6 graded trials.
- **Best**: the covered pair with the highest pass rate; ties to more passes, then the cheaper.
  `p_best` is each covered pair's share of the draws where it is the highest.
- **Weak**: the best pair's posterior median below `bar` gives the class no entry (`best
  <pair> weak`), and `pick` falls through to the next table.
- **Equivalent**: a covered pair whose draw is at least the best's minus `delta` in half the
  paired draws or more. Against a best at 10/10, 9/10 is equivalent and 8/10 is not; against
  14/14, 13/14 is and 12/14 is not; a best at 5/5 is not weak, at 4/5 it is.
- **Strict classes**, `contract-phase` and `final-verification`, work nothing re-checks: an
  equivalent pair is eligible only when none of its graded trials failed.
- **The entry**: the eligible pair with the lowest expected cost, ties to the higher pass
  rate; none eligible is `no equivalent pair`.

`config.json` may set `{"selection": {"delta": <d>, "bar": <b>}}`; 0.10 and 0.8 by default.
Each is a number from 0 to 1: any other value is refused, naming the key and the value.

The entry keeps its pair, `pass_rate`, `n`, `tasks`, `p_best`, `cost_usd`, `median_usd`,
`expected_usd`, the `best` pair, the `delta`, `bar` and `strict` it was selected with, the
identifiers it was measured on, its size and the ladder. Each rung keeps `pair`, `n`, `tasks`,
`per_task`, `pass_rate`, `p_best` (covered pairs only), `p_equiv` (covered pairs only),
`cost_usd`, `median_usd`, `median_ci`, `expected_usd`, `off_model`, `covered`, `equivalent`
and `eligible`. A rung
covered and not equivalent is no notch for an exploration; a rung not covered is offered. A
table written before this selection still reads: its rungs are judged by the floor it carries.

**The size stamp.** A task's size is read from its merged diff, `base..merged` in the
manifest's repository, the files matching `test_globs` left out — the hidden tests are not the
agent's work: `small` when it touches at most 3 files and 50 lines added and deleted, `large`
beyond, `unknown` with one warning per task when the diff cannot be read. It is computed at
each `calibrate`, never written into the manifest. The entry's `size` is the largest bucket
among its class's tasks (`large` over `small` over `unknown`), and `sizes` counts the tasks of
each.

**Pick by size.** `pick --repo <r> --class <c> [--record <rec>] [--files <n> --lines <n>]` is
given the phase's size: both counts or neither, whole numbers, 0 or more (one alone, or a
count that is not one, is refused). They are bucketed by the rule a task is, `large` beyond 3
files or 50 lines, and the first line gains `size=<bucket>`. An entry whose `size` is not
`large` does not serve a `large` phase; a table written before the stamp has none and reads as
`unknown`. `pick` goes on down its order (project, profile, global, shipped, tier table) to the
first entry measured on large work, or to the tier table, and the line then reads
`size=large beyond=<scope>`, the scope being the first entry skipped: `project:<slug>`,
`profile:<p>`, `global`, `shipped:profile:<p>` or `shipped:global`. A shipped entry whose tier
the map does not bind is skipped as ever and is never named. Without the options `pick` reads
no size.

The output, in order: `pair=<p> source=<s>[ stale][ size=<bucket>[ beyond=<scope>]]`;
`explore=<pair>` when an exploration is offered; `nbis=<pair>` last, the picked pair one effort
level up on the same family (the same pair at `max`), and no line for a pair with no effort.
The skill runs a phase's correction round at that pair.

`--from-record <record>`, repeatable, adds the dispatch record's closed pair rows as trials:
one round and no escaped defect is a pass. A row whose cost is incomplete, or that names no
effort, is left out. A record row has no task: in a class measured on bench tasks it counts as
one more cell of its pair's mean, and covers nothing. This is how an exploration's promotion
reaches the table.

A `floor` key left in `config.json` is read by nothing: neither the tables nor the bench use a
floor any more.

## 6. Generalise to profiles and the global table

`generalize` pools the trials of every project sharing a profile — the
`<language>/<kind>` `routing.py profile <repo>` prints, or the manifest's own — and runs the
same selection on the pooled figures, each task named by its project. It reads each project's
trials as `calibrate` does, ready tasks only, and says what it left out with the same stderr
line, once per project; a project with no trial left is no project of the fold. A pair qualifies in a
fold when it is covered in at least two of the fold's projects having the class (one, for a
fold of a single project), and its pooled trials are those of the projects where it is
covered. A pair is held back when, in a project where it is covered, it is not equivalent to
that project's best, so one easy project cannot carry a profile: it keeps its pooled figures
on the ladder, marked not eligible. A fold's entry takes the largest size over its pooled
tasks. A profile table needs at least two projects; until then the global table, the same
fold over every project, serves it. Projects of unknown language never form a profile: they
share nothing but the absence of a marker, so they count toward the global table only.
`generalize` prints `profile=<p> projects=<n> classes=<n>` per profile table and `global
projects=<n> classes=<n>`.

## 7. Show what is measured

`show [--detail] [<slug>...]` prints, per project, one line per class: `class=<c>
project=<pair|-> profile=<pair|-> global=<pair|->`, the coverage of each table, with `stale` at
the end when an entry was measured on a model identifier the alias no longer resolves to; a
class on no line falls to the tier table. With `--detail`, each class of the project's table is
followed by its ladder, cheapest first, one line per rung: `  rung pair=<p> tasks=<k>
pass_rate=<r> p_best=<p> median_usd=<m> ci=<lo>..<hi> expected_usd=<e> off_model=<k>`, with
` equivalent` and ` chosen` at the end where they hold; a figure an older table lacks reads
`-`. Every `cost` run on a record row and every trial updates which identifier an alias
resolves to, when one of the models it reports carries the alias. A stale entry is still used;
the operator decides whether a bench run is worth refreshing it.

## 8. Export the shipped defaults

`export [--to <dir>]` rewrites the local profile and global tables into the plugin's
`defaults/`, each pair's family replaced by the tier the map binds it to (`standard/medium`),
its ladder written the same way, model identifiers, costs and project names dropped. An
exported entry keeps `pass_rate`, `n`, `delta`, `bar`, `strict` and `size`; a rung keeps
`tasks`, `pass_rate`, `p_best`, `covered`, `equivalent` and `eligible`; a figure a table does
not have is left out, never written as a null. A table with no class in tier form is not written (`export: <file> has no class in tier form, not written`), and an existing file stays as it was. A family
bound to no tier is skipped with a warning, `export: <alias> is bound to no tier, <class>
skipped`; `pick` reads a shipped ladder's rungs back through the map. The exported files name no model, so they resolve through any operator's own map.
The operator decides when an export is committed.
