# Directive optimization — design

Date: 2026-09-25. Base: `main` at `c5c968f` (0.34.0).

## Goal

Make every markdown directive of the plugin lighter to load and at least as well
obeyed, and prove both. Lighter is measured and reported, never targeted: no
word-count goal is set, because a figure to reach is a reason to cut a rule.

Success is three readings, all required:

1. **Traceability** — every rule of 0.34.0 is inventoried and each one is kept,
   merged, moved or dropped; a drop happens only on the operator's ruling.
2. **No regression** — the eval suite scores the converted plugin at or above the
   0.34.0 baseline, case by case.
3. **Conventions** — each `SKILL.md` stays under 500 lines, detail lives in
   `references/` one level deep, each reference over 100 lines opens with a
   table of contents.

## Scope

In: `skills/*/SKILL.md`, `commands/*.md`, `templates/*.md`, `README.md`,
`docs/design.md`, `docs/superpowers/`.

Out: the shell and Python scripts, except where the operator rules that a rule
is better enforced by a script than by a sentence (phase 5).

## 1. The rules inventory

`docs/rules-inventory.md`, a working file deleted in the final phase. One row per
atomic rule:

| Column | Content |
|---|---|
| `id` | `ORCH-042`, `ITERM-007`, `TPL-PHASE-03` — prefix names the source family |
| `rule` | one normative sentence, reworded without loss of meaning |
| `sources` | every `file:line` where it appears (body, Rationalizations, Red flags, template, command) |
| `kind` | `rule` · `procedure` · `fact` · `rationale` |
| `criticality` | `critical` (a violation breaks a session or costs hours — every « Observed » incident is one) · `normal` |
| `enforced-by` | `prose` · `script` (an existing lint, gate or test) · `eval` (to write) |
| `fate` | `keep` · `merge→<id>` · `move→<file>` · `drop` · `contradiction` · `script-candidate` |
| `target` | where it lives after conversion |
| `signature` | a short literal excerpt a grep finds at `target` |

A trace script under `tests/` checks that every cited `source` exists at 0.34.0
and, after each conversion, that every `keep`, `merge` and `move` row's
`signature` is found at its `target`. It is the mechanical proof that no rule
vanished silently, and it lands with its own mutation (remove one signature from
a target, watch the script name that row).

`drop`, `contradiction` and `script-candidate` are never settled by an agent or
by the orchestrator: each goes to the operator, one at a time (phase 3).

## 2. The eval suite

`evals/` at the repository root, committed: the plugin's permanent regression
suite, run by the host's plugin evaluation command.

- **One case per critical rule**, or per cluster of critical rules that fire in
  the same situation. `prompt.md` stages a situation that tempts the violation;
  `graders/*.md` state the pass criteria against the inventory row, citing its
  id. A tool-use grader measures triggering where it applies.
- **Cases grade the decision, never the effect.** Tools that would open a tab,
  spawn a session or reach the forge are not granted; the grader reads the
  attempted call or the text.
- **Baseline** on 0.34.0 with the no-plugin arm. A case that passes without the
  plugin proves nothing and is rewritten or removed.
- **Repetitions**: three per case at baseline; one per case after each
  conversion, and three again on any case that dropped. A case unstable with the
  plugin at baseline is either a rule already badly obeyed today — a finding
  reported to the operator — or a badly written case, rewritten.
- **A drop against baseline is a finding** until its mechanism is named.
- **Envelope**: concurrency 2 at most; never beside a test-suite gate.
- **Cost gate**: the run count and its estimate go to the operator once the
  inventory fixes the number of cases, before the baseline is launched.

Cases are authored in sequence by one agent under its context gate; runs are
always one fresh session per case, since a shared context would grade the
conversation's memory instead of the rule, and a real session loads the skill
cold.

## 3. Target structure

**A rule lives once; every other place points at it.** Where it lives follows who
needs it and when.

### `skills/orchestrator/`

- `SKILL.md` holds what the orchestrator must carry at all times: the operator's
  primacy and its duties, the core loop (plan → brief → launch → verify →
  review → terminate → replace) one line per step, the thresholds, one
  deduplicated Rationalizations table, and Red flags that point at their rule
  rather than restating it. Each step carries an **action-bound load
  instruction**: « before writing a brief, read `references/briefs.md` ».
- `references/briefs.md` — prompt recipe, standing rules.
- `references/review.md` — review on evidence, disposable review sessions, the
  cost of a round.
- `references/lifecycle.md` — launch, control, terminate, rotation, succession.
- `references/machine.md` — shared-machine resources.
- `references/audit.md` — the auditor.
- `references/incidents.md` — the « Observed » narratives, indexed by rule id.
  The body keeps at most a one-line justification per rule.

The risk of this shape is a rule sitting in a reference that is not read when it
applies. The load instruction is tied to the action, not the topic, and every
critical eval case is staged at the moment of the action, so the suite measures
exactly that risk.

### Other skills

`iterm-agents`, `model-routing` and `context-gauge` follow the same shape;
`iterm-agents` separates its script command reference
(`references/commands.md`) from its rules of use.

### Commands

Thin: the command's own procedure, pointing at the skill for rules. `audit.md`
and `audit-end.md` drop what `references/audit.md` holds.

### Templates

Templates are read by agents that do not load the orchestrator skill, so they
keep in full the rules the agent needs (handshake, silence rule, STOP-and-ask,
synchronous commands, and the rest). The skill stops restating them and points
at the template. No template points at a plugin path; `brief-lint.sh` already
refuses one.

### Descriptions

Optimized last, with a triggering query set per skill (should-trigger and
should-not-trigger), rate measured before and after.

### Documentation

The delivered plans and spec under `docs/superpowers/` are deleted — history
keeps them — including this spec, at the end. `docs/design.md` is rewritten as
the current architecture: decisions since reversed leave it, and whatever a
skill already states is replaced by a pointer.

## 4. Base and phases

Phases 1 and 2 only add files and start on `main` now. Conversions start once
the open drafts #63 (`feat/state-refresh`) and #64 (`feat/latest-models`) are
merged or abandoned; the inventory then gets an update pass for their rules. If
they are still open at that point, the orchestrator brings the operator an
arbitration with its cost; nothing is stacked on drafts outside this work.

One agent per phase, one draft pull request per phase, stacked on the previous
phase's branch head, one kind of change per phase.

| # | Phase | Kind | Proof |
|---|---|---|---|
| 1 | Inventory + trace script | addition | review samples sections of every source file for missing rules |
| 2 | Eval suite + baseline | addition | no-plugin arm; stability over three repetitions |
| 3 | Decision round (operator and orchestrator) | decision | every `drop`, `contradiction`, `script-candidate` ruled and recorded |
| 4a | `orchestrator` skill → `SKILL.md` + `references/` | conversion | trace 100 %, evals ≥ baseline |
| 4b | `iterm-agents`, `model-routing`, `context-gauge` | conversion | same |
| 4c | Commands and templates | conversion | same, plus `brief-lint.sh` green on every template |
| 5 | Behaviour changes ruled in phase 3 | behaviour | one eval case per change, failing on the previous head |
| 6 | Documentation | docs | no dead link; no duplicate of a skill |
| 7 | Descriptions | behaviour | triggering rate before and after |
| 8 | Final verification and version bump | verification | full suite, `tests/run-tests.sh`, the repository's pre-push greps, inventory deleted |

Every pull request gets both readings before its verdict: a disposable review
session including the norms check, then `dispatch-record.sh ready` at its head.
Each brief names its tier, chosen with the model-routing skill.
