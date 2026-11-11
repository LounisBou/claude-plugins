# The learning system — design

**Status: proposal for the next version, awaiting the operator's confirmation.** Nothing in it
is decided or scheduled until the operator answers the « Open questions »; the current program
does not build it.

**Review notes (2026-11-11).** Seven notes, each marked « Review note » at the section it
concerns, check this design against published evidence on coding agents. They propose; they
decide nothing, and none changes a goal until the operator takes it. Three choices already
match that evidence and should stay: code first, and a prompt rule only by displacing one
(context files added to repositories raised inference cost by over 20 % and did not generally
improve task success, Gloaguen et al. 2026, arXiv:2602.11988); the session that learns is never the session
that worked; only code-computed grades decide.

For the version after `program-design.md`, whose priorities, conventions and constraints govern
it; nothing here is built by the current program. Paths are relative to the repository root;
line numbers are at `main` `5a78a08`.

## Why

The plugins already improve, but by hand: an incident is noticed by the operator or a
session, an audit names it, a pull request adds a guard, a rule or a test. The program's own
list of verified defects (`program-design.md`, « Verified defects by plugin ») shows the cost of
that: the same class of defect found plugin after plugin — consent read from words in four
plugins (norms `hooks/guards.ts`, pr-review `hooks/policy.ts`, implement `hooks/core.ts`, the
orchestrator's last-line gate), guards failing open in three, readiness self-attested in three —
each found by a reading, none by a measure. Nothing records, across sessions and projects, what
a guard refused, what a review found, what the operator corrected, or whether the remedy then
held.

« Learning » here means one thing: **the artifacts the host loads and the code around them
change, on evidence, and the change is kept only while a measure shows it helps.** The models do
not change. What changes is what this repository already uses to steer them: a guard, a lint, a
test, a routing table, a prompt rule, a project's norms, the operator's configuration — and the
removal of any of these that stops paying.

## Operator priorities it serves

The program's ranking holds (`program-design.md`, « Operator priorities »). This design serves:

1. **Fluidity** — capture is done by hooks, distillation by a separate session started by code;
   nothing asks the operator except what the « Open questions » below make theirs.
2. **Ready means done** — recurring findings become guards and tests that the ready gate's
   inputs then hold.
3. **Separation of roles** — the session that learns is never the session that did the work
   (decision 0004).
4. **Single source of truth** — the journal holds only what would otherwise vanish, and points
   at durable records; each lesson lives once, at its scope.
6. **Token economy** — capture costs no prompt token; a prompt rule enters only by displacing
   one (conventions, « Prompts »).

## What exists today

Verified against the repository. The design reuses each piece named here before adding one.

### Facts already recorded, durably

| Fact | Where | Writer | Trust |
|---|---|---|---|
| Review, norms, e2e record per head | `<config>/pr-records/<owner>/<name>/<head>/`, contract `packages/core/src/pr-record.ts` | github (`engine/record.py`) for pr-review, norms, implement | computed, except norms below |
| Norms result | `plugins/norms/hooks/record.ts:131,170` | norms | **model-reported**: `pass` is `open === 0`, `open` passed in by the model (the program's norms defect, still open) |
| Rounds, review head, the correction round, escapes, cost per dispatch | the dispatch record, JSON lines (`plugins/orchestrator/skills/orchestrator/scripts/dispatch-record.sh`, header) | orchestrator | the orchestrator's act (`escaped` is its judgment) |
| A tier drop that cost a round or an escape freezes the class; three one-round closes promote it | `dispatch-record.ts:810-826` (`frozen=`, `promote=`) | orchestrator | computed from the rows |
| The operator's rulings, verbatim and dated | `<briefs dir>/rulings.md` (`skills/orchestrator/references/lifecycle.md:47`), `defer`/`rule-out`/waiver arguments of `dispatch-record.sh` | orchestrator | operator |
| Token use and list-price cost per session and period | `deck.json` (`plugins/orchestrator/hooks/usage.ts`, `deck.ts`) | orchestrator | computed |
| Check runs per head | the forge | CI | computed; read by github's ready gate (`hooks/ready.ts`, `Gate.ci`) |
| Resolved review threads | the forge, read by `pr-threads --format resolved-threads` | reviewers | **external text** |

### Facts lost at the end of a session

| Fact | Where it lives now |
|---|---|
| A guard's refusal | its text in the transcript and `$.ui.log` (`plugins/github/hooks/register.ts:180,244,411`); no stable code, no durable record; 34 `refused` strings in github's `register.ts`, 8 in `ready.ts`, 12 in the orchestrator's `hooks/guards.ts` |
| A review pass's findings (severity, file, summary) | module memory (`plugins/pr-review/hooks/state.ts`, header: « nothing here outlives the session »), computed from the agents' blocks (`hooks/report.ts`) |
| The operator's answer to a structured question (Allow or Deny on a push during a walkthrough) | the host dialog only (`plugins/norms/hooks/guards.ts`, header) |
| Which norms agents found what | the walkthrough's turn |

### Loops that already learn

| Loop | What it learns | How |
|---|---|---|
| Routing calibration (`plugins/orchestrator/skills/model-routing/references/calibration.md`) | which model and effort pair serves a class of work | harvest merged pull requests, bench, calibrate, `generalize`, `export`; tables read by **scope precedence**: project, profile (`profile-<language>-<kind>.json`), global, shipped default (`defaults/README.md`); an export is the operator's to commit |
| Explore, freeze, promote (`dispatch-record.ts:810-826`) | whether a cheaper pair holds for a class | computed from the record's rounds and escapes |
| Succession notes (decision 0007) | judgment worth keeping across generations | each note promoted into an artifact or dropped at the next generation, never carried |
| « Directives follow decisions » (`plugins/orchestrator/skills/orchestrator/SKILL.md:64`) | rulings into directives | by the orchestrator's prose, not by code |
| `/norms:learn` (`plugins/norms/commands/learn.md`, `hooks/learn.ts`) | project norms from resolved review threads | the hook prefetches threads and existing headings; the model proposes one rule at a time; the operator answers « add »; the rule is appended to the project's `CONTRIBUTING.md`, which `/norms:check` then appends, section by section, to each review agent's prompt (`hooks/scope.ts:228-301`) |

### Measures

| Measure | Where | State |
|---|---|---|
| Behaviour evals, with and without the plugin | `plugins/orchestrator/evals/` (26 cases), baselines `baseline-0.34.0.json`, `baseline-0.36.0.json` | the only plugin with a behaviour suite |
| Triggering evals | `plugins/orchestrator/trigger-evals/` (50 cases) | orchestrator only |
| Outcome evals | `evals/outcome/`, `scripts/outcome.ts`, caps `evals/outcome/caps.json` | harness proved by a dry run; no paid run recorded (run output stays outside the checkout by design, `evals/outcome/README.md`) |
| Rules held by prose alone | `npm run rules` (`scripts/rules.ts`) | « named by an eval » is 0 for every plugin today: the match is lexical on backticked terms, and the evals do not name them |
| Context by scenario | `npm run context`, `ci/scenarios.json` | in CI's summary |
| Prompt budgets, duplicates | `ci/prompts.json` | ratchets |
| Warn before enforce | github's ready gate, `READY_PHASE = 'warn'` (`plugins/github/hooks/register.ts:685-693`) | a precedent for a new guard shipped in observation first |

## The design

### 1. Capture facts, never impressions

**The learning event**, a contract typed in `packages/core/src/learning.ts`, versioned, written
as `learning.json` beside each copy for a writer in Python (`packages/core/src/data.ts`):

| Field | Content |
|---|---|
| `v` | 1 |
| `id`, `at` | a unique name (time and random part), the time injected |
| `kind` | `refusal` · `finding` · `answer` · `escape` |
| `source` | `{ plugin, code }`: the writer and a stable code (`github.ready.missing-review`, `pr-review.finding`, `norms.push-ask`) |
| `subject` | `{ repo, pr, head }`, each nullable |
| `context` | `{ role, mode, paths (≤ 20, repository-relative), languages, session }` — `languages` computed from the paths by one table in core |
| `evidence` | pointers only: a record's path, a check's name at a head, a finding's severity and file, a ruling's line, a refusal's code |
| `trust` | `computed` · `operator` · `review` · `external` |

Three choices, each against the starting outline:

- **No `scope` field.** Whether a lesson belongs to the method, a language, a project or the
  operator is a judgment that needs the view across projects; the writer of one event cannot
  make it. Scope is decided at distillation (section 3).
- **No `success` kind and no `ci-failure` kind.** What a durable source keeps is pointed at,
  never copied (conventions, « One rule, one place »): check runs, records, merges, reverts and
  review threads stay on the forge, in git and in `pr-records/`, and the distiller reads them
  there. The journal holds only what vanishes with the session: refusals, findings, the
  operator's structured answers, an orchestrator's `escaped`. A success is a merged pull request
  whose events are few, computed at distillation; recording every success would be volume
  without information.
- **Never a model's self-report, never words.** No command line (it may carry a secret:
  conventions, « Permissions and security »), no prompt text, no finding summary, no figure a
  model passes to a tool. The validator refuses any field outside the contract.

> **Review note 1 — point at the step, not only at the record.** The retrospective must name a
> cause (section 2), and a cause is a step: what it received, what it did, what consumed it.
> `evidence` points at records, not at the step that produced the event. Proposal: `context`
> gains a pointer to that step — the transcript's path and the turn's index or the tool call's
> id — never its words. The host owns transcript retention, so the pointer may dangle; the
> retrospective then treats the step as missing evidence (note 2) rather than reconstructing it
> from a summary.

**Writers**, one per plugin, each into its own state directory, `<config>/<plugin>/journal/`,
one file per event through `writeAtomic` (or `writeAtomicOver` in a hooks module,
`packages/core/src/store-io.ts`). One owner per file keeps the architecture's state rule
(`architecture.md`, « State ») and needs no shared lock. Writing is an observation: it fails
open and logs (conventions, « Guards and consent »), and never delays a guard's decision. Each
writer prunes its own directory past a count and an age held once in core.

| Kind | Writer | When |
|---|---|---|
| `refusal` | github, norms, pr-review, implement, orchestrator, bugs-bot | a protecting guard refuses; its refusal gains a stable code |
| `finding` | pr-review | a review pass ends: one event per Critical or Important finding, from the agents' blocks (`hooks/report.ts`) |
| `finding` | norms | `check_done`: one event per agent that reported, once its counts are computed rather than passed in |
| `answer` | norms, github | the operator answers a structured question (Allow, Deny) |
| `escape` | orchestrator | `dispatch-record.sh escaped` |

The journal is a contract (`docs/contracts.md` gains a row): written by each plugin, read by the
learning plugin only.

### 2. Distil in code first, then in a separate session

**Clusters, computed by code.** A signature is `kind`, `source.code`, the finding's severity and
the class of its paths (source, test, docs, configuration), and the languages. The distiller
groups the journals' events by signature and joins the durable sources: the records of the
heads they name, the check runs of those heads, the merges, the reverts, and the fix pull
requests whose changed lines blame into a pull request merged within the window (a computed
escape). A cluster becomes a **candidate** when it holds at least three events from at least two
pull requests within the window; the thresholds live once in core. The same input gives the same
candidates: a test on a fixture holds it.

**The retrospective**, a session that did not write the code of any pull request it reads,
started by code at a lifecycle boundary (implement's close, the orchestrator's last goal met)
when the candidates reach a threshold, the way `/implement:review` already launches its
reviewer as another session (`plugins/implement/commands/review.md`). Its starting context is a
scenario of `ci/scenarios.json`: its skill and a digest of the candidates, each with its
evidence pointers, under a fixed ceiling. It judges, per candidate, what the code cannot: is the
cluster one cause, which remedy, at which scope. It writes nothing but candidates' remedies,
each through a pull request (section 5).

> **Review note 2 — the cause is the least reliable judgment here.** Automated failure
> attribution is weak: on logs of 127 annotated multi-agent systems, the best method named the
> responsible agent in 53.5 % of cases and the decisive step in 14.2 % (Zhang et al., ICML
> 2025, arXiv:2505.00212); the best long-context model localised the issue in 11 % of 148
> annotated traces (Deshpande et al. 2025, TRAIL, arXiv:2505.08638). Proposal: the
> retrospective writes each cause as a structured claim — the **first upstream failure** (the
> earliest step that changed the path to success, not the last visible symptom); the
> **counterfactual** (had that step been right, the earlier record unchanged, would the
> failure still have occurred?); the evidence; the alternatives it considered; a confidence —
> and may answer **« unresolved »**, naming the observation that would have decided. An
> unresolved cause yields no remedy, only, at most, an instrumentation change (note 1). The
> candidate's validator (goal 8) refuses a cause without these fields. Method: Jarmak 2026,
> « Engineering Reliable Coding Agents », arXiv:2608.13867, ch. 11.

**Candidates are state.** The learning plugin keeps one file per signature: proposed, its pull
request, merged, ineffective, rejected with the operator's ruling. A rejected candidate is not
proposed again unless its rate doubles.

### 3. Place each lesson once, at its scope

The precedence routing already reads (`model-routing/defaults/README.md`) is the model:

| Scope | Evidence that places it | Where it lands |
|---|---|---|
| project | the cluster's events come from one repository | that repository: a test or a lint in its own CI, or a rule in its `CONTRIBUTING.md` — the file `/norms:check` reads (`plugins/norms/hooks/check.ts:54`), not a `norms.md` |
| language | the same signature in at least two repositories sharing a language | a language pack: rules or checks served by the plugin whose role they belong to (norms review rules, routing's `profile-<language>-<kind>` tables) |
| method | the same signature in at least two repositories and two languages | this repository: a guard, a lint, a test, or a line of the method (`plugins/method`) |
| personal | operator answers that recur across projects and name no code | the operator's configuration repository (`LounisBou/claude-code`), on its own branch |

A lesson moves up, never copies: when a language lesson is promoted to the method, the
language pack loses it in the same pull request (conventions, « One rule, one place »).

### 4. Code first, prose last

The remedy ladder is the conventions' (« Code decides, the model judges »; decision 0005): a
guard whose refusal says what to do, a lint, a test, a routing entry; a prompt rule only when
the remedy needs judgment. The learning system adds two things the ladder lacks today:

- **A new guard ships in warn.** It reports what it would refuse and lets the call through,
  as github's ready gate does (`register.ts:685`). A later retrospective reads its would-be
  refusals: one whose pull request merged with no correction counts against it. It is
  enforced when at least nine in ten of at least five would-be refusals were right.
- **A remedy is checked after it lands.** Over the next window, the candidate's signature must
  fall by half; otherwise the candidate reopens and the remedy becomes a removal candidate.

> **Review note 3 — a precision measured on five calls.** « Nine in ten of at least five » is
> met by five right out of five, whose 95 % lower bound (Wilson) is 0.57; nine of ten gives
> 0.60. Proposal: enforce on the lower bound rather than the ratio, its threshold held in core
> with the others: a bound of 0.8 needs 16 right out of 16, a bound of 0.9 needs 35. Also,
> « merged with no correction » counts a would-be refusal as wrong even when the defect it named
> escaped: a later escape on the same lines should turn it back into a right one.

> **Review note 4 — a signature falls by itself.** A cluster becomes a candidate at its peak
> (three events from two pull requests in one window), so the next window is likely lower with
> or without a remedy: regression to the mean. Every remedy would pass « falls by half », and
> goal 11 would hold for an inert one. Proposals: measure a **rate** (events per merged pull
> request, or per session of the role) rather than a count, so a quiet window does not read as
> a cure; compare it with the signature's rate over a longer baseline than the window that
> selected it, or keep a few candidates without a remedy for one window as a control and
> credit a remedy only with the fall beyond theirs; watch the same plugin's neighbouring codes,
> since a guard can move a failure to another signature rather than remove it.

### 5. Proof, then promotion

- **A code remedy** carries its test, as every fix does (conventions, « Tests and coverage »),
  and goes through the ready gate like any change.
- **A prompt rule** carries an ablation: the case its incident becomes, run with the rule and
  without it, three runs each, on the host's evaluation command. It enters only when the eval
  shows an outcome change, and replaces a rule (conventions, « Prompts »); the plugin's budget
  in `ci/prompts.json` does not rise. A plugin with no behaviour suite (every one but the
  orchestrator) cannot take a learned prompt rule until it has one.
- **Release measure.** The outcome evals are re-measured as the operator decides (question 4);
  the grades code computes (suite, reference tests) decide a regression, the judge's grades are
  reported.

> **Review note 5 — three runs decide on chance.** With a pass-or-fail grade, three runs per
> variant cannot show a change: even three passes against three failures has a one-sided
> Fisher p of 0.05, and every lesser split is weaker. « Enters only when the eval shows an
> outcome change » would then admit rules on noise, or none. Proposal: L0 computes, from the
> per-case variance of the orchestrator's baselines, the **minimum detectable effect** at the
> per-rule budget; the ablation is paired by case and spreads its runs over several cases of
> the incident's class rather than repeating one; a result under that effect is
> reported « inconclusive », and an inconclusive rule does not enter. One run is one draw (Jarmak 2026,
> ch. 1–2).

> **Review note 6 — six cases cannot see a modest regression.** The outcome measure spends up
> to 120 USD on six cases, one run per arm (`evals/outcome/caps.json`). The cases are already
> the right kind — this repository's merged pull requests, chosen by `evals/outcome/SELECTION.md`
> — but there are six, and nine qualify in all. Six runs per arm show only a collapse of a
> pass rate, about 73 points from 79 % (note 7). Its power is bounded by the number of cases more than by the
> runs per case. Proposal: grow the case set under the same criteria from the other
> repositories where the plugins run (the dispatch records name their pull requests), rather
> than repeat six; each release measure states the smallest regression it could have detected,
> and below that size reports per case, never a difference between versions.

- **Promotion is a pull request**, in the target repository, with its provenance: the
  candidate's signature, the count of its events and pull requests, the event ids. Under
  auto-merge in this repository, a remedy that is code and only tightens merges when proved; a
  change of the method's text or of the operator's configuration waits for their structured
  answer (question 1).

### 6. Forget

- A guard the learning system added that would have refused nothing over two windows, and a
  prompt rule whose ablation shows no change, become removal candidates, proposed by the same
  path.
- For prose that predates the learning system, `npm run rules` stays the list of candidates
  (`scripts/rules.ts`); its « named by an eval » column reads the ids of the eval cases each
  rule's ablation produced, instead of a lexical match that finds none today.
- The journals are pruned by their writers; candidates closed for two windows are archived.

### 7. Resilience

- **Kill switch.** The distiller, the retrospective and every promotion live in one plugin,
  `learning`; disabling it stops them and changes nothing else. The writers keep bounded
  journals.
- **Fails safe by construction.** A writer fails open; a distiller that cannot read a journal
  reports it and proposes nothing; a promotion is a pull request that CI and the ready gate
  hold; a removal of anything is a pull request too.
- **Rollback is forward.** The host caches by version and versions only rise (`architecture.md`,
  « Release »): a rollback is a revert pull request with a raised version, opened by the
  learning plugin when a remedy's own measure worsens (a warned guard's precision, a signature
  rising after a rule).
- **Health, answered by code.** `/learning:health` prints, per window: refusals per guard code,
  findings per merged pull request by severity, review rounds and escapes (dispatch records),
  check-run failures per pull request (the forge), cost per pull request where a dispatch record
  maps sessions to it, eval pass rate from the last baselines it is given. No model turn
  (conventions, « Code decides »), no new field in `deck.json` (program non-goal 3).
- **Canary.** Before the cutover, the `next` profile is the canary (`migration.md`). After it,
  question 8.

### 8. Safeguards

| Source | Trust | May become |
|---|---|---|
| a guard, a record, a check run, git | `computed` | evidence and a cluster |
| the operator's structured answer or dated ruling | `operator` | evidence; the only source of a personal lesson |
| a review session's findings | `review` | evidence by severity and file; its summary never enters a lesson |
| a reviewer's thread, a tester's report, a pull request's body | `external` | a pointer the retrospective may open; never text copied into a rule |

- **The injection path of `/norms:learn` closes.** Today a reviewer's words become, through
  the model, a rule in `CONTRIBUTING.md` that every norms agent then reads (`hooks/scope.ts:244`).
  In the learning system a thread counts only when code shows it acted on (resolved, and the
  commented lines changed after it by the pull request's author) and its author can write to
  the repository; the rule's text is the retrospective's own, linted by norms' validator
  (`plugins/norms/hooks/validate.ts`) and a length cap, and reviewed in its pull request like
  any change. `/norms:learn` becomes a thin entry that hands a pull request's threads to the
  distiller as `external` evidence (question 10).
- **No private project leaks into a public pull request.** A method candidate's provenance
  names this repository's pull requests; others appear as counts and hashed ids (question 7).
- **No new chore.** The operator is asked only what question 1 reserves to them, batched one
  question per retrospective in the method's question format
  (`plugins/method/skills/lifecycle/references/questions.md`).

## The starting outline, verified

| Point | Verdict | What changed |
|---|---|---|
| 1. A typed, versioned learning event in core, written by hooks from facts | kept | no `scope` at capture; only what vanishes is captured, the rest pointed at; norms' counts excluded until computed |
| 2. Distil in a separate session, periodically; generalise `/norms:learn` | kept, sharpened | clustering is code, the session only judges; started at a lifecycle boundary rather than by a clock |
| 3. One place per scope; project → `norms.md` / `CLAUDE.md` | corrected | the project file norms reads is `CONTRIBUTING.md`; language packs do not exist yet and follow routing's profile precedent; personal lessons go to the configuration repository by a pull request the operator merges |
| 4. Code first, prose last | kept | already a convention; adds warn before enforce and the after-landing check |
| 5. Evals decide; outcome evals at each release, a regression blocks or rolls back | corrected | a release is a merge (`architecture.md`), and a measure is capped at 120 USD (`evals/outcome/caps.json`): a cadence is the operator's to set; only code-computed grades decide; one behaviour suite exists |
| 6. Forget rules never triggered nor named by an eval | corrected | a prose rule's triggering cannot be observed; counters serve guards, ablation serves prose; `npm run rules` names no eval today |
| 7. Resilience: canary, automatic rollback, dashboard | corrected | rollback is a forward revert; the dashboard is a command answered by code; the canary after the cutover is an open question |
| 8. Provenance, promotion by proven pull request, no chore, operator confirms method changes | kept | trust classes; the confirmation of method changes is a new approval step, against program non-goal 2, so it is question 1 |

## Goals

1. The learning event is typed in core, versioned, written as data for Python, and tested from core and from each writer and reader (`scripts/contracts.test.ts`).
2. Every refusal of a protecting guard in github, norms, pr-review, implement, the orchestrator and bugs-bot carries a stable code and writes exactly one event.
3. No event holds a command line, a prompt's words, a finding's summary or a figure a model passed to a tool: the validator refuses it, and a test per writer shows it.
4. A writer that cannot write lets the hook's decision stand and logs one line, under a test that breaks its store.
5. Each journal stays under the count and the age core sets, pruned by its writer.
6. The distiller computes the same candidates from the same journals and durable sources, under a fixture test, with no model.
7. A retrospective starts with no operator action, in a session that wrote none of the pull requests it reads, and its starting context is a scenario of `ci/scenarios.json` under its budget.
8. A candidate without a scope, a rung, its provenance and its proof (a test, or an eval case for a prompt rule) is refused by its validator.
9. A learned prompt rule merges only with an ablation showing an outcome change, within its cap, and its plugin's budget in `ci/prompts.json` does not rise.
10. A learned guard ships in warn and is enforced only at the precision this design sets, computed from its would-be refusals.
11. A remedy whose signature does not fall by half over the next window reopens its candidate.
12. A learned guard with no would-be refusal over two windows, and a learned prompt rule whose ablation shows no change, are proposed for removal.
13. A rejected candidate is not proposed again unless its rate doubles.
14. No reviewer's, tester's or pull request author's text enters a lesson; a thread counts only under the acted-on and author checks.
15. `/learning:health` answers from code, with no model turn.
16. Disabling the `learning` plugin leaves every other plugin's behaviour unchanged, under a test.
17. The eval spend of a retrospective and of a release measure stays within the caps the operator sets in `evals/`.

## Constraints

- The program's constraints hold (`program-design.md`, « Constraints »): incremental, every
  merged pull request leaves every plugin usable.
- `docs/conventions.md` governs; the journal and the candidates are contracts
  (`docs/contracts.md`), the reader declared with a version range (`architecture.md`).
- Capture adds no prompt token and no turn.
- A learned change goes through the same gates as any change: CI, the ready gate, the version
  rule.

## Phases (each may be split, never merged)

| # | Phase | Goals | Depends on | Pull requests | New files and contracts |
|---|---|---|---|---|---|
| L0 | Measure before building (below) | — | the operator's machine | none (a report) | — |
| L1 | Prerequisites in the plugins | — | program phase 7 | norms: the pass computed, not passed in (the program's open defect); pr-review: the findings of a pass kept past the session — 2 | — |
| L2 | The contract | 1, 3, 5 | — | core: `learning.ts`, its test, `learning.json`; every consumer's copy and version — 1 | contract `learning` v1; a `docs/contracts.md` row |
| L3 | Writers | 2, 3, 4 | L2; the orchestrator after its refoundation's state phase | one per plugin: github, norms, pr-review, implement, bugs-bot, orchestrator — 6 | a refusal code table per plugin; journal directory per plugin |
| L4 | The `learning` plugin and its health | 15, 16 | L3 for one plugin at least | the plugin's skeleton, manifest, suite, `/learning:health` — 1 to 2 | plugin `learning`; `ci/plugins.json`, `ci/prompts.json` entries |
| L5 | Distiller and retrospective | 6, 7, 8, 13 | L4; outcome pilot run (program phase 8) | clusters and candidates in code — 1; the retrospective's skill, its scenario, the launch from implement's close — 1; from the orchestrator — 1 | contract `candidate` v1 |
| L6 | Promotion | 9, 10, 14, 17 | L5 | warn-then-enforce in core — 1; rule ablation in the evals harness (`scripts/lib/outcome/`) — 1; `/norms:learn` as an entry to the distiller — 1; a caps entry for retrospectives — with the harness | `evals/` caps entry |
| L7 | Forget and check | 11, 12 | L6 and two windows of data | 1 to 2 | — |
| L8 | Canary after the cutover | — | program phase 9; question 8 | 0 to 2 | — |

About fifteen to eighteen pull requests. Sizes are estimates, to be read again at L0: the contract
about 150 lines and its tests 150; a writer about 60 lines and 80 of tests per plugin, plus a
code per refusal; the distiller about 400 lines and 400 of tests; the retrospective's skill
under 1,200 tokens.

## Costs

| Item | Cost | Measured by |
|---|---|---|
| Capture | no prompt token; one file of under 1 KB per event; bounded per plugin | the journal's size, in health |
| Health | no model token | — |
| A retrospective | its skill (under 1,200 tokens) and a digest under a fixed ceiling (about 4,000 tokens), then the files its remedies touch; an estimate of 40,000 to 80,000 tokens a run, to be measured | `npm run context` for the start; `deck.json` for the run |
| A learned prompt rule | one case, two variants, three runs each: about 6 × 0.31–0.42 USD, so 2 to 3 USD (the behaviour suite's per-run cost, `program-design.md`, « Eval spend caps ») | the run's report |
| A retrospective's eval spend | proposed cap 10 USD, the program's cap for one run per case after a rewrite: at most three prompt-rule candidates a retrospective | the cap in `evals/` |
| A release measure | the outcome measure's cap, 120 USD (`evals/outcome/caps.json`), at the cadence of question 4 | the harness's ledger |

## Risks and their mitigations

| Risk | Mitigation |
|---|---|
| A lesson learned from injected text | trust classes; only computed and operator facts form clusters; external text is never copied; the rule's pull request is reviewed |
| A wrong guard slows the agents (fluidity) | warn first; enforced at a measured precision; reverted when its precision falls |
| Rules accumulate | a rule enters only by replacing one, budgets only fall; removal candidates each window |
| Noisy evals decide on chance | three runs per variant; code-computed grades decide, the judge's are reported; a result under its cap's sample is reported as such |
| The journal grows or leaks | bounded by its writer; pointers only; no command text; private repositories hashed in public pull requests |
| The learning loop learns from its own changes | a learned change's events carry its candidate's id, so its effect is measured, not clustered as a new cause |
| The distiller reads another plugin's state | the journal is a declared contract with one reader |
| The retrospective costs more than it saves | its run cost is measured by the deck; health shows cost against the signatures it closed; the trigger threshold rises if it does not pay |
| Data too thin to cluster | L0 measures volume first; thresholds are data in core |

## Alternatives rejected

| Alternative | Why not |
|---|---|
| Ask each session, at its end, what it learned | a self-report: unverifiable, by the session that did the work (decisions 0004, 0005) |
| The host's memory files, written by the working session | the same session, no provenance, unbounded tokens, no measure of effect |
| One shared journal file for every plugin | several writers on one file, against one owner per contract and the store's lock under concurrent hooks |
| A database or a service | a dependency outside a plugin's copy (decision 0002); state outside the plugins' directories |
| Scope set by the writer | needs the view across projects that only the distiller has |
| Clustering by embeddings or by a model | a dependency and non-deterministic; exact signatures suffice, the model names the cause |
| Every incident becomes a behaviour eval case | 2 to 3 USD a case; most remedies are code, tested for free |
| Outcome evals as a blocking CI check | they run on the operator's machine, at up to 120 USD, on six cases |
| The retrospective inside the orchestrator's or implementer's session | the session judging its own work, and its context paying for it |
| A dashboard, or new fields in `deck.json` | a new surface, and program non-goal 3 |
| Deleting prose rules on a zero counter | a prose rule's use cannot be observed |
| The learning code inside `method` | decision 0006 holds `method` to the strictest ceiling so that it does not become the place everything goes; a separate plugin is also the kill switch |

## Non-goals

1. Changing any model's weights, or any training outside the artifacts this repository ships.
2. A new permission prompt, approval step or operator chore beyond what question 1 decides.
3. Changing `deck.json`'s format.
4. Learning from the content of the operator's conversations, or from sessions outside the
   plugins' hooks.
5. A user interface.

## Open questions for the operator

1. **Which promotions wait for you?** Recommended: **(a)** a change of the method's text or of
   your configuration waits for your structured answer, batched once per retrospective; a code
   remedy that only tightens, proved by its test, merges under auto-merge. (b) Every learned
   change waits for you: safest, a chore at each retrospective, against non-goal 2. (c) None
   waits: most fluid; a wrong method line ships unseen until its measure reverts it.
2. **Where the distiller lives.** Recommended: **a new plugin, `learning`**: a kill switch, and
   `method` keeps its ceiling. `method`: one plugin fewer, against decision 0006's intent.
   `scripts/`: cannot run in your other projects, since only plugins are installed.
3. **What starts a retrospective.** Recommended: **code, at a lifecycle boundary** (implement's
   close, the orchestrator's last goal met), when the candidates reach a threshold: no chore, no
   clock. A schedule: regular, but a session started with nothing to judge. Your command: a
   chore.
4. **Cadence of the outcome measure.** Program goal 15 says every release, and a release is a
   merge: at 120 USD a measure that cannot hold. Recommended: **at each minor version of
   `method` or the orchestrator, and before a learned method change merges**. Every N merges:
   regular, spends on changes that touch no prompt. Monthly: cheap, a regression found late.
5. **What a regression does.** Recommended: **a regression in a code-computed grade blocks the
   promotion it measures; a judge's grade only reports**. Block on every grade: decides on
   noise. Report only: a regression ships.
6. **Where language packs live.** Recommended: **in the plugin whose role they serve** (norms'
   review rules, routing's profiles), as data. One plugin per language: clean installs, many
   plugins and versions. Your configuration: personal, but then lessons do not reach other
   operators of these plugins.
7. **Which repositories it learns from, and what a public pull request may name.** Recommended:
   **every repository where the plugins run; a method pull request names only this repository's
   pull requests and counts the others under hashed ids**. Only this repository: safe, little
   data. Name everything: full provenance, private names in a public history.
8. **A canary after the cutover.** Recommended: **none at first**: warn before enforce and
   proof before merge cover a learned change; re-decide after L0's incident rate. Keep the
   `next` profile on `main` and pin the main profile to a released ref: a true canary, and a ref
   to advance.
9. **Window and retention.** Recommended: **a window of 30 days, journals kept 180 days and at
   most 2,000 events a plugin**. Shorter: faster reactions, thinner clusters. Longer: more data,
   older causes.
10. **`/norms:learn`.** Recommended: **keep the command as an entry that hands threads to the
    distiller as external evidence**; the rule's text is the retrospective's, checked and
    reviewed. Keep it as it is: the injection path stays. Remove it: the one learning command
    projects use today disappears.
11. **Eval cap per retrospective.** Recommended: **10 USD**, at most three prompt-rule
    candidates. 30 USD: more candidates proved per run. 0: code remedies only.

## What to measure before building

Each figure confirms or refutes a part of the design. None is recorded in the repository today
unless said.

| Question | Data | Where it is today |
|---|---|---|
| Are there enough events to cluster? | refusals per guard and per session | not recorded: only in host transcripts on your machine (`<config>/projects/*.jsonl`), as refusal text; a one-off count by guard prefix (`github:`, `norms:`, `pr-review:`) |
| Do findings recur across pull requests? | review findings by severity and file class | lost at session end (pr-review `state.ts`); partly in review records' `detail` (≤ 500 characters, `pr-records/`) |
| Do classes recur across plugins and projects? | the defect classes of the program's list, counted | `program-design.md`, « Verified defects by plugin » (consent from words in four plugins, guards failing open in three, readiness self-attested in three) |
| How many rounds and escapes per pull request? | `summary` of each project's dispatch record | recorded, per project, on your machine |
| What does a pull request cost? | dispatch rows' `cost`; `deck.json` per session | recorded for orchestrated work only; a solo implement session maps to no pull request |
| Do CI failures repeat? | check runs per head | on the forge; logs expire |
| Did `/norms:learn` add rules, and did they hold? | commits `docs(contributing): update project code norms from PR review feedback` in your projects, and later findings on the same files | in those projects' history |
| Does a retrospective pay? | the first one's token cost against the candidates it closed | after L5; the deck measures it |
| Can evals decide? | variance of the orchestrator's baselines per case, outcome pilot's grades | baselines in `plugins/orchestrator/evals/`; the outcome pilot has not run |
| What do you correct? | your rulings and denials | `rulings.md` per orchestration; denials are not recorded |

If refusals and findings are too few to reach three events from two pull requests within a
window, the design keeps its contract and writers and defers L5 until they are.

> **Review note 7 — L0's first reading of « Can evals decide? » (2026-11-11).** Read from the
> orchestrator's two baselines, before any paid run:
>
> | Baseline | Cases × runs | Pass with the plugin | Cases whose runs disagree |
> |---|---|---|---|
> | `baseline-0.34.0.json` (with and without) | 36 × 3 per arm | 85 of 108 (79 %); without: 5 of 108 | 8 of 36 (22 %) |
> | `baseline-0.36.0.json` (with only) | 19 × 3 or 6 | 57 of 63 (90 %) | 4 of 19 (21 %) |
>
> About one case in five gives different results on the same version: one run, or three, of
> one case is one draw. Smallest change in a pass rate near 79 % that a comparison detects
> (two proportions, 5 % two-sided, 80 % power, normal approximation, so indicative at small
> sizes):
>
> | Runs per arm | Rise detectable | Fall detectable |
> |---|---|---|
> | 3 (one case, note 5's ablation) | none | none |
> | 6 (the outcome measure, one run of six cases) | none | about 73 points (79 % to 6 %) |
> | 18 | none | about 45 points |
> | 36 | about 21 points (to 100 %) | about 32 points |
> | 60 | about 17 points | about 24 points |
> | 108 (the whole 0.34.0 suite) | about 14 points | about 18 points |
>
> What it shows: the with-and-without comparison of 0.34.0 (79 % against 5 %) is far above
> any noise, so whole-suite ablations can decide; a single rule's ablation cannot, and the
> six-case outcome measure sees only a collapse. What it does not show: these are behaviour
> evals, which grade a rule's decisions; the outcome evals' own run-to-run variance is unknown
> until cases are run twice per arm. L0's remaining steps: (1) run the pilot twice, same case,
> same model pair, within the operator's cap (`orchestrator-refoundation-design.md`, review
> note 6) — a first signal, stable or not on one case, not yet a rate; (2) for a rate, run
> several cases twice, and from it compute the cases needed for the release measure to detect
> a 20-point fall, setting note 6's growth from that number; (3) count refusals per guard
> prefix in the host transcripts, as the table above says, before L2.
