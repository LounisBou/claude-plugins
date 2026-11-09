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
- The single arm is the host's command line run headless in its bench, with its share of the
  cap as the host's own budget. Its tools run unasked: the bench is a private clone without a
  remote. It runs with every installed orchestrator turned off.
- The orchestration arm is an orchestrator session driven the way the operator drives one. The
  launcher of this checkout's `plugins/orchestrator` (the release measured, with the plugins its
  manifest depends on) opens `Orch : eval <case id>` in a tmux home of its own under
  `<dir>/tmux`, detached from the operator's windows, Remote Control off, on the run's settings
  file, typed `/orchestrator:orchestrator build` and then the brief. The brief says no operator
  answers: the orchestrator decides each question by its own recommendation and writes it as a
  `Decision: <question> → <choice>` line, which the report lists. It also says to spawn every
  agent with `--dir` set to the graded checkout, never through `workspace.sh create`, one agent
  writing at a time. The agents it spawns are windows of the same home. The launcher records
  the trust of the arm's directory through its own ladder, where the host reads it. `--out` must be short and at least two levels below `/` (a socket's
  address holds 103 bytes): `/tmp/oc/1`, not a temporary directory of macOS.
- The harness reads the orchestrator's transcript (`<configDir>/projects/*/<session>.jsonl`, or
  under `ORCHESTRATOR_PROJECTS_DIR`) and ends the arm on the first turn whose `declare_wait`
  is `done` or waits on the operator (reported `asked-operator`, with the question, and graded
  on what it left), at the arm's share of the cap, or at its deadline; the wording of a last
  line decides nothing. A turn is concluded only when two polls in a row read the same idle
  state. Three failed reads of the home in a row end the arm, one alone does not. An
  orchestration that opened no agent is reported `not graded: no agent opened`; one that opened
  some reports their number, and `no commit in the graded checkout` when its diff is empty.
  Two bounds end an arm as not graded, each after 10 minutes: `the orchestrator did not start`
  when it has neither declared a wait nor opened an agent, and `the meter cannot see the bench`
  when it has opened agents and the meter still reads nothing. A total counts the arms not
  graded apart from those that ran.
- Every session of the arm is closed through the launcher's `close --bench --socket`, which ends
  the home with the orchestrator's window and its agents'; its server read gone proves none is
  left, a home still read is closed once more, and one left after that makes the arm an error.
  A failed opening closes every home server under `<dir>/tmux` the same way.
- An orchestration's sessions are metered through the orchestrator's `deck.json` (`--deck`
  names another path): only the sessions opened after the arm started, on a terminal of one of
  its home's panes, count, so the operator's own sessions are never charged to it.
- `--host <binary>` names the host's command line when it is not `claude` on the path.

A run stopped at a cap still writes its report, with what it measured and why it stopped.
