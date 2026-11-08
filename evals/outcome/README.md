# Outcome evals

Whether an orchestration ships better work than a single session, measured on work already
shipped: each case is a merged pull request of this repository, replayed from its base by
both arms and graded on what each leaves. The behaviour suite of the orchestrator
(`plugins/orchestrator/evals/`) grades decisions a rule makes; this one grades outcomes.

## A case

- **The start**: a private clone of the repository at the pull request's base, with no
  remote, so nothing an arm does reaches the forge.
- **The task**: the defect or the goal as the program states it before the change, never the
  merged solution.
- **The reference**: the merged result.
- **The arms**: `single`, one session; `orchestration`, the orchestrator running implementer
  sessions. Both get the same brief (`brief` in `scripts/lib/outcome/harness.ts`).

`cases.json` lists the cases; `SELECTION.md` says which and why. A pilot replays the first,
a measure the first `cases` of `caps.json`; the others are reserves.

## The grades

Computed by code where code can decide, asked of a model only where it needs judgment:

| Grade | How |
|---|---|
| suite | the plugin's `tests/run-tests.sh` on the arm's result |
| reference tests | the reference's added or changed test files laid over the arm's result, then the suite |
| intent | a judge reads the task, the arm's diff and the reference's diff: does the change do what was asked |
| review | a review by a session other than the arm's: its blocking and minor findings |
| files, overlap, outside the plugin | the arm's diff against the reference's |
| cost, duration | per arm, every session it opened included |

Before the arms, a calibration with no model: the suite must pass on the merged result, and
the reference's tests must fail on the base. A grade whose calibration fails reads « not
graded » with its reason, never a figure that measures the bench rather than the arm.

## The caps

`caps.json` holds the operator's caps; the harness reads them and stops at each:

- an arm starts only when the run can still pay a whole case-and-arm cap;
- an arm is stopped when its meter reaches its share, the cap less two judgments;
- a judgment gets at most `judgeUsd`, and none once the case-and-arm cap is spent;
- a stopped arm is still graded on what it left, and reported as stopped.

## Running it

From the repository root, into a directory outside the checkout (run output never lands in
the repository):

```bash
npm run outcome -- dry-run --out <dir> [--case <id>]
```

A dry run spends nothing: an oracle stands in for both arms (it leaves the merged result),
and a judge that compares the files touched stands in for the model. It proves the cases,
the benches, the calibration and the graders before a paid run. `<dir>/report.md` is the
report to read, `<dir>/report.json` its record, `<dir>/work/` the benches.

### The pilot and the measure

On the operator's machine, from the repository root, after a dry run whose calibration holds:

```bash
npm run outcome -- pilot   --out <dir> --model <agent model> --judge-model <judge model>
npm run outcome -- measure --out <dir> --model <agent model> --judge-model <judge model>
```

- The pilot replays the first case with both arms; the measure the first six. `--case <id>`
  replays one case under the run's caps, the way a reserve replaces a case.
- The models are named on the command line, never in the repository. Two runs compare only
  on the same pair.
- Each arm is the host's command line run headless in its bench, with its share of the cap
  as the host's own budget. Its tools run unasked: the bench is a private clone without a
  remote. The single arm runs with every installed orchestrator turned off; the
  orchestration arm loads this checkout's `plugins/orchestrator`, the release measured, and
  is asked through the orchestrator's skill.
- An orchestration's sessions are metered through the orchestrator's `deck.json` (`--deck`
  names another path): only the sessions opened after the arm started count, so the
  operator's own sessions are never charged to it. When the arm ends or is stopped, the
  sessions it opened that the deck still lists are closed by the launcher's close.
- `--host <binary>` names the host's command line when it is not `claude` on the path.

A run stopped at a cap still writes its report, with what it measured and why it stopped.
