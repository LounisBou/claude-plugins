# Model routing calibration — design

Date: 2026-10-09
Status: approved design, pending implementation plan

## Why

`model-routing` picks a capability tier (`deep`, `standard`, `light`) for every dispatch
from a table written by judgment. Its principle is right — the cheapest tier observed to
close a class in one round — but nothing observes it:

- **Effort is not a variable.** The host accepts `--effort low|medium|high|xhigh|max` on
  every current model family, and effort moves token spend as much as the family does.
  The launcher, the tier map and the record ignore it.
- **Cost is never measured.** The record counts rounds, not tokens. A cheap agent that
  needs a corrective round may cost more than a dear one that does not, and nothing
  says so.
- **The table is a prior, never a measurement.** It is the same for a shell plugin and a
  web application, and it never learns that a lighter family closes a class reliably.

The operator wants the orchestrator to dispatch, for each task, **the cheapest
model/effort pair that delivers to full satisfaction**, with the model always the latest
release of its family, and a method that keeps that choice measured as models change.

## Goals

1. The unit of choice is a **pair** `<alias>/<effort>`: a family alias (always the
   latest release) and an effort level.
2. Every dispatch's cost is **measured** from its transcript and attached to its record
   row; corrective rounds add to the same row. The figure that ranks pairs is the cost
   per dispatch closed to satisfaction, never the cost per session.
3. **Offline calibration**: a bench replays merged pull requests of a project on a grid
   of pairs, grades each trial mechanically then by a judge, and reduces the trials to a
   per-project table.
4. **Generalisation**: per-project tables fold into per-profile tables (language ×
   project kind) and one global table, which serve projects never measured.
5. **Online refinement**: the orchestrator explores one notch below a class's pair under
   strict conditions, and the record corrects the table build after build.

## Non-goals

- Synthetic bench tasks. The corpus is merged pull requests only (operator's ruling).
- Reading the 5h/7d budget to stop, throttle or drop a tier. The budget is recorded as a
  control, never acted on; the only cap is the one the operator passes to a bench run.
- Shipping measured tables in the plugin. They name model identifiers, which the
  repository's policy keeps out of its files; they live in the operator's state dir.
- Replacing the tier table. It stays the shipped default when no measurement exists.

## Decisions taken with the operator (2026-10-09)

| # | Question | Ruling |
|---|---|---|
| 1 | Data source | Both: offline bench and online refinement |
| 2 | Who judges satisfaction | Mechanical checks first, then a judge at the top tier with a fixed rubric (bench); the existing deferred signals online |
| 3 | Online exploration | Bounded: one notch below, on low-blast phases only, frozen for the build on a failure |
| 4 | Cost unit | API-equivalent dollars decide; the subscription gauge is recorded as a control |
| 5 | Bench corpus | Replayed merged pull requests only |
| 6 | Scope | Any git repository, one table per project, generalised to profile and global tables |
| 7 | Bench engine | A dedicated headless runner (not the plugin evaluation command, which has no effort flag; not the iTerm spawn path, which cannot run in parallel) |

## Architecture

One stdlib Python script, `skills/model-routing/scripts/routing.py`, holds every new
mechanism behind subcommands; the existing shell and Python scripts gain flags.

```
routing.py cost      <transcript> [--json]            cost of one session
routing.py profile   <repo>                           inferred <language>/<kind>
routing.py pick      --repo <path> --class <c>        pair + the table it came from
routing.py harvest   <repo> --pr <n>... --class <c>   draft bench tasks from merged PRs
routing.py bench     <project> [--grid ...] --max-usd <n> [--reps 2]
routing.py calibrate <project>                        trials -> project table
routing.py generalize                                 project tables -> profile + global
routing.py show      [<project>]                      tables, staleness, coverage
routing.py export    [--to <dir>]                     profile + global tables as tier/effort defaults
```

Everything it writes lives under `<state dir>/routing/`:

```
<state dir>/routing/
  prices.json                       per model identifier: input, output, cache writes (5 min, 1 h), cache read, $/MTok, dated
  aliases.json                      per family alias: the identifier it last resolved to
  config.json                       per-alias permission mode, reliability floors (optional)
  projects/<slug>/manifest.json     repo path, profile, test command, test globs, tasks
  projects/<slug>/briefs/<task>.md  the brief each trial receives
  projects/<slug>/trials.jsonl      one line per trial
  tables/project-<slug>.json
  tables/profile-<language>-<kind>.json
  tables/global.json
```

The plugin ships one more directory, `skills/model-routing/defaults/`, holding the
exported profile and global tables in **tier/effort** form (section 4): they name no model,
so they pass the repository's policy checks and resolve through any operator's own map.

`<state dir>` is the plugin's existing one (`ORCHESTRATOR_STATE_DIR`, default
`~/.claude/claude-orchestrator`). The host binary is `ORCHESTRATOR_HOST_CLI`, as in the
launcher; tests point it at a stub.

## 1. The foundation: pair, effort, cost, record

**Pair notation.** `<alias>/<effort>`, e.g. `a-model/medium`. The alias is a family alias;
the existing rule that a versioned identifier draws a warning applies to the pair's model
half unchanged.

**The tier map** (`models.json`) accepts, per tier, the current string form or an object
`{"model": "<alias>", "effort": "<level>"}`. Without an effort, the launcher types none and
the host applies its default, exactly as an unbound model does today. `resolve-tier`
prints `<model>` or `<model>/<effort>`.

**The launcher** (`iterm_agent.py spawn`) gains `--effort <level>`, validated against the
five levels, typed into the launch line after `--model`. `--tier` takes the effort from the
map when the map gives one; an explicit `--effort` wins. The permission-mode check is
unchanged.

**Cost of a session** (`routing.py cost`). Reads the session's transcript and its
subagents' transcripts (`<projects>/<slug>/<session>.jsonl` and
`<projects>/<slug>/<session>/subagents/*.jsonl`), keeps one usage per message id (the host
writes one line per content block, each repeating the message's usage), and sums `input_tokens`, `output_tokens`, `cache_creation_input_tokens` and
`cache_read_input_tokens` — the cache writes split into 5-minute and 1-hour by the
usage's `cache_creation` detail, which bill at different rates — grouped by the **model identifier the message records**, times
`prices.json`. Prints `cost_usd=<x> model=<id>[,<id>] tokens_in=… tokens_out=… cache_read=…
cache_write=…`. A model identifier absent from `prices.json` prints `cost_usd=unknown` and
names it on stderr: a price is never guessed. A tiered price (a family whose rate rises
past a prompt size) is expressed in `prices.json` as `{"above": <tokens>, …}` and applied
per message.

**The record** (`dispatch-record.sh`):

- `open` accepts `--model <alias>` and `--effort <level>` alongside `--tier`.
- `cost <record> <id> --session <session id>` locates the session's transcript, runs
  `routing.py cost`, and **adds** the figure to the row (`cost_usd`, `sessions`). An
  unknown cost marks the row `cost_incomplete`.
- `open … --explore` marks an exploratory dispatch (section 2).
- `summary` groups by class × pair (rows without a pair group by tier, as today) and adds
  `cost_avg=<usd>` per group, computed over closed rows with a complete cost. Rows written
  before this change read unchanged.

## 2. Online policy (`model-routing` skill)

**Where the pair comes from**, in order — `routing.py pick` walks it and prints the first
hit with its source:

1. the project's table, for the class;
2. the project's profile table;
3. the global table;
4. the tier table already in the skill, through the map.

The skill stays a decision aid: the orchestrator may override the pick, and writes the pair,
its source and its reason in the brief, as it writes the tier today.

**A stale entry** — one measured on a model identifier the alias no longer resolves to —
is still used; `pick` prints `stale` and the orchestrator says so in one line to the
operator, who decides whether a bench run is worth it.

**Bounded exploration.** A class's pair may be lowered **one notch** for one dispatch
when all hold:

- the class closed in one round at its current pair at least **3** times in the record
  with no `escaped` defect;
- the five readings show at most one high;
- the class is not the orchestrator, a successor, a decision round, a contract-defining
  phase or the final verification — work nothing re-checks is never explored.

One notch is the next cheaper pair on the class's **ladder**: the pairs of its table
entry ordered by measured cost per closed dispatch; without measurements, effort down one
level on the same family, then the next lighter family at its current effort. The
dispatch is opened `--explore`. If it costs an N-bis round or later gets an `escaped`
defect, the class reverts and `summary` prints `frozen=<class>`: no exploration on that
class for the rest of the build. Three exploratory closes in one round promote the lower
pair for the build, and `summary` prints `promote=<class> <pair>`; promoting it into the
project table is `routing.py calibrate --from-record <record>`, which treats each closed
row as a trial graded by the record's own signals.

**Escalation** keeps its triggers and its "one step, at a session boundary" rule; one step
is now one notch up the ladder. The cascade classes are unchanged, expressed on pairs. The
false-economy rule applies unchanged.

**Lighter and heavier families** are read from the tier map — the family bound to the
next tier down or up — so no code names a family.

**A family with no auto mode.** A family with no auto mode runs in `acceptEdits`, in
production and in the bench alike, so the bench measures it under the constraint it will
have.

## 3. The offline bench

**A task** is one merged pull request: `{id, pr, class, base, merged, brief, budget_usd}`,
where `base` is the merge's first parent. `harvest` drafts tasks: it reads the pull
request's title and body through the forge, writes `briefs/<task>.md` from them with any
diff, file list beyond the ones the body names, or test file content stripped, and appends
the task to the manifest. The orchestrator reviews each brief before it enters a run;
`bench` refuses a task whose brief is still marked `draft`.

**Classes the bench covers** are those a merged pull request replays: contract-defining,
behaviour and conversion phases, and N-bis correctives (fix pull requests). Review lenses,
collectors, comments agents and search subagents are calibrated online only.

**A trial** is one task × one pair × one repetition:

1. **Isolation.** `git archive <base>` extracted into a fresh directory under a temporary
   root, then `git init` and one commit: the agent sees the tree at `base` and no history,
   so the merged commit is unreachable.
2. **Run.** `<host> -p --model <alias> --effort <level> --permission-mode <mode>
   --output-format json --max-budget-usd <budget> --no-session-persistence`, the brief on
   stdin, the directory as cwd, under a wall-clock timeout (default 30 minutes).
3. **Mechanical check.** The test files the merged diff touched (matched by the
   manifest's `test_globs`) are copied over the agent's tree — hidden tests the agent never
   saw — then the manifest's test command runs. Pass = exit 0.
4. **Judge.** Only after a mechanical pass: `<host> -p` at the `deep` tier's pair with the
   rubric `skills/model-routing/references/judge-rubric.md`, given the brief, the agent's
   diff, the merged diff as a reference, and the test output. It returns JSON: a score per
   criterion, `verdict: pass|fail`, and one reason per failed criterion. Satisfaction =
   mechanical pass and judge pass.
5. **Record.** One line in `trials.jsonl`: task, class, pair, repetition, model
   identifiers actually used, `cost_usd` = the sum of the host's per-model `costUSD` from
   its JSON result (list-price basis, subagents included — the same API-equivalent unit
   `prices.json` gives online, without a second price table to keep in step), tokens, duration, mechanical
   result, judge verdict and scores, judge cost (kept apart, never in the pair's cost),
   and the subscription gauge before and after when a source exposes it (`null`
   otherwise).

**The grid and its pruning.** The full grid is the families bound in the tier map ×
five efforts — three families, 15 pairs; `--families` names them when the map does not. A run proceeds in two stages per class:

- **Screening**: every pair once on two tasks of the class.
- **Confirmation**: the pairs that passed both screening trials and whose cost is within
  1.5× the cheapest passing pair, on every task of the class, `--reps` times (default 2).

`--grid` restricts the pairs explicitly. `--max-usd` is required: the run stops starting
trials when the cumulative cost of trials and judges reaches it, finishes those in flight,
and prints what is left unmeasured. Trials run up to `--concurrency` at once (default 2).

**Failures.** A trial that times out, hits its budget, or crashes the host is recorded
`error`: its cost counts, it is excluded from the pass rate, and three errors on one pair
drop that pair from the run with a line saying so.

## 4. Tables and generalisation

**Calibrate** reduces a project's trials to one entry per class:

- per pair: `n`, pass rate, mean cost per trial, and **expected cost per satisfied
  dispatch** = mean cost + (1 − pass rate) × mean cost of the next pair up the ladder
  (a failure in production is paid by an escalation);
- the eligible pairs are those with `n ≥ 6` and a pass rate ≥ the **reliability floor**:
  0.9 by default, **1.0** for contract-defining phases and the final verification (work
  nothing re-checks);
- the entry is the eligible pair with the lowest expected cost; ties go to the higher
  pass rate. The entry stores the full ladder, the floor used, the model identifiers
  measured, and the date.

A class with no eligible pair gets no entry, and `pick` falls through to the next table.

**Profile.** `routing.py profile` infers `<language>/<kind>` from the tree: language by
manifest file (`composer.json`, `pyproject.toml`, `package.json`, `go.mod`, …) and else by
dominant extension; kind by marker (`artisan` → `laravel-app`, `.claude-plugin/` → `plugin`,
a `bin`/console entry point → `cli`, else `library` or `app`). The manifest may override it.

**Generalise** pools the trials of every project sharing a profile and runs the same
selection, with one extra condition: the chosen pair must meet the floor **in each project
where it was measured**, so one easy project cannot drag a profile down. The global table
is the same fold over every project. A profile table needs at least two projects; until
then the global table serves it.

**Export.** `routing.py export` rewrites the local profile and global tables into
`skills/model-routing/defaults/`, each pair's family replaced by the tier the map binds it
to (`standard/medium`), model identifiers and project names dropped. A family bound to no
tier is skipped with a warning. The operator decides when an export is committed.

**The pick order with shipped defaults** is: project table, local profile table, local
global table, shipped profile default, shipped global default, tier table. A shipped
`tier/effort` resolves through the map; an unbound tier falls through.

**Staleness.** Each entry keeps the model identifiers it was measured on. Every `cost`
run on a record row and every bench trial updates `aliases.json` with the identifier the
alias resolved to (the one carrying the alias as a dash segment, else the costliest).
`show` and `pick` flag entries whose alias now resolves to another identifier, and the coverage per class
(measured, profile, global, tier table).

## 5. Errors and testing

- `prices.json` missing or lacking an identifier: `cost` prints `unknown`, and the record
  row is marked `cost_incomplete`; `calibrate --from-record` leaves such rows out. Bench
  trials carry the host's own `costUSD` (section 3) and need no price file. The orchestrator
  fills `prices.json` from the host's published prices; it is the operator's file, never
  shipped.
- No forge access for `harvest`: it stops naming the pull request; a task can be written by
  hand.
- A manifest without a test command or test globs: `bench` refuses the project.
- A stale or partly written `trials.jsonl` line: skipped with a warning, never fatal.

**Tests** (in `tests/run-tests.sh`, no spending): `cost` on fixture transcripts (mixed
models, tiered price, unknown identifier); `profile` on fixture trees; `pick`'s fall-through
order; `calibrate` and `generalize` on fixture trials (floor, ladder, per-project
condition, `n` threshold); `bench` end to end with `ORCHESTRATOR_HOST_CLI` pointing at a stub
that writes a canned edit and a canned transcript, including isolation (no history
reachable), hidden-test overlay, budget stop, error accounting; `dispatch-record.sh` new
flags and summary lines; the launcher's `--effort` and map-object parsing. The trigger
evals and behaviour evals of `model-routing` are re-read and updated where the pair
replaces the tier.

## Delivery

Three phases, each its own pull request, in order:

1. **Foundation** — `prices.json` format, `routing.py cost`, the launcher's `--effort` and
   map objects, the record's pair, `cost` and `--explore`, summary lines.
2. **Tables and online policy** — `profile`, `pick`, the table format, `calibrate
   --from-record`, the skill's rewrite around pairs, the ladder and bounded exploration.
3. **Bench** — `harvest`, `bench`, `calibrate`, `generalize`, `show`, `export`, the judge
   rubric.

The first real bench run spends real quota: it starts only with a `--max-usd` the operator
gives.
