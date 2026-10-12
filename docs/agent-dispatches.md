# Agent dispatches

The standing choices behind every dispatch: the tier and the effort each kind of work runs
at, and the rules that move a dispatch away from them. Each choice carries when it was made,
who made it, why, and the evidence it rests on, so that a later reader can tell a choice
still justified from one whose reason has gone.

A choice changes in the same pull request as the rule or the default it describes: its entry
is rewritten, and the reading it replaces moves under « Superseded » with the date it ended.
Where a skill states the rule itself, the entry points at it and keeps only the reason and
the evidence, since a rule kept in two places goes stale in one of them.

This file does not hold:

- the model behind each tier: the operator binds it in his tier map, `models.json` in the
  orchestrator's state directory. Here the families are named by their place only: the top
  family, the middle family, the smallest family;
- why a given phase got its pair: its brief says it, and the dispatch record keeps the class,
  the pair, the rounds and the measured cost of every dispatch.

## The tiers

| Tier | Binding | Serves | What re-checks it |
|---|---|---|---|
| `deep` | the top family, at the operator's default effort (high) | orchestrators, successors, decision rounds, contract-defining phases, the final verification, the bench's judge | nothing downstream |
| `standard` | the middle family at effort high | behaviour and conversion phases, correction rounds, review collectors and lenses, comments agents | the test suite, then the review round |
| `light` | the smallest family at effort medium | read-only search | the search itself: it finds or it does not |

The class of each kind of work and its tier: `skills/model-routing/SKILL.md`, « The table ».

## Choices

### 1. Pay for judgment that nothing downstream re-checks

- Since: the model routing design (`docs/specs/2026-10-09-model-routing-calibration-design.md`).
- Rule: `skills/model-routing/SKILL.md`, « The principle ».
- Why: an error in work a suite, a gate or the orchestrator re-checks is caught cheaply; an
  error in a contract or in the orchestrator's own sequencing is paid by every phase after it.

### 2. Routing informs; the orchestrator decides

- Since: 2026-09-26, the operator.
- Choice: the tables, the readings and the escalation are inputs. The orchestrator chooses the
  pair, may choose a better model than the table when the work calls for it, and writes its
  choice and its reason in the brief.
- Why: the orchestrator follows the work closely; the operator, who follows it from a
  distance, said it may see better than he does which model the work needs.

### 3. The top family's default effort is high

- Since: 2026-10-12, the operator (calibration decision O2).
- Choice: the operator's default effort for the top family is `high`. It applies to every
  session on that family that names no effort, the `deep` tier's agents included, since the
  map binds that tier to the family alone.
- Why: on short, well-specified work the effort moves the cost far more than the quality.
- Evidence: published figures for the top family on a subset of SWE-bench Pro, per resolved
  task: low 87.4 % at 0.12 USD, medium 92.8 % at 0.22, high 95.3 % at 0.29, xhigh 96.7 % at
  0.74; the same source calls gaps under about five points run noise. On the bugs-bot
  project's bench the top family passed at every effort, its cost rising from 0.18 USD at low
  to 1.09 USD at max.
- Superseded: `xhigh`, until 2026-10-12.

### 4. The standard tier runs the middle family at effort high

- Since: 2026-10-12, the operator.
- Why: on this repository's bench the middle family passed 10 trials of 10 at high and 7 of
  10 at medium. It holds until the profile and global tables say otherwise.

### 5. The light tier runs the smallest family at effort medium

- Since: 2026-10-12, the operator (calibration decision O3).
- Why: a search is checked at once, and a miss costs one more search: the cheapest tier
  belongs where an error is cheapest to see.
- Evidence: published rates per million tokens, input and output: the middle family 2 and
  10 USD; the smallest family 0.10 and 0.50 below 100,000 tokens of context, 0.50 and 2.50
  above, from four to twenty times cheaper. The family's alias resolved to its current
  release in every one of the 48 bench trials run on it.
- Not measured: the quality of a search; the pull-request bench measures implementation.
- Superseded: the middle family with no effort, until 2026-10-12.

### 6. An unattended session runs in auto mode

- Since: 2026-09-10, the operator; the smallest family's exception on 2026-09-27.
- Choice: every spawned session runs with `--permission-mode auto`; a session on the smallest
  family, which has no auto mode, runs with `--permission-mode acceptEdits`.
- Why: the auto mode's classifier is the operator's guard over work nobody watches;
  acceptEdits is the guarded mode where auto does not exist.

### 7. A successor inherits its orchestrator's current model

- Since: 2026-09-10, the operator.
- Choice: an orchestrator has no tier. Its successor runs the model the orchestrator runs
  now, read from the session's own measurement, never from a launch file or the map, and the
  successor's first statement of its model is checked.
- Why: a session's model can change while it runs; only its current reading is the
  operator's choice.

### 8. A table serves the cheapest pair equivalent to the best

- Since: routing phase 4 (#173); its defaults on 2026-10-12, the operator (calibration decision O4).
- Rule: `skills/model-routing/references/calibration.md`, « 5. Calibrate the project's table ».
- Choice: a class's entry is the cheapest pair, by expected cost, among the pairs
  statistically equivalent to the best measured pair, with `delta` 0.10 and `bar` 0.8.
- Why: the floor it replaces, 0.9 on six trials or more, sits inside the noise: ten runs
  cannot separate 70 % from 90 %, and the unit that counts is the task, not the run.
- Worked values: against a best at 10/10, 9/10 is equivalent and 8/10 is not; against 14/14,
  13/14 is and 12/14 is not; a best at 5/5 is not weak, at 4/5 it is. Changing the defaults
  costs a recompute of the tables from the trials already recorded, no bench.
- Superseded: the 0.9 floor.

### 9. A trial run on another model stays out of the tables

- Since: routing phase 4 (#173); the model of each trial recorded since the bench fixes of #171.
- Why: an alias can resolve to an older release and a session can fall back to another
  model; such a trial measured something other than its pair.

### 10. One notch at a time, and never a cascade on a phase

- Rule: `skills/model-routing/SKILL.md`, « Explore one notch, never more », « Escalate on
  evidence, one step, at a session boundary » and « Cascade where a retry is cheap — and only
  there ».
- Why: a failed phase costs a review round and a rework round, more than the phase one
  notch up; a cascade pays only where a failure is cheap to see and to throw away.

### 11. Budget is never a reason to route

- Since: 2026-10-10, the operator.
- Choice: the subscription's budget never stops, throttles or lowers a dispatch; pairs are
  ranked by the measured cost of a dispatch closed to satisfaction, its correction rounds
  included.
- Why: the budget is the operator's to manage; a pair chosen to save it and paid back in
  rework saves nothing.

### 12. The host's command line is updated after the bench, not during it

- Since: 2026-10-12, the operator (calibration decision O1).
- Why: the tables must be measured on one release of the host. The update then brings the
  effort setting of a subagent launched inside a session, and the isolation options of an
  evaluation run.
