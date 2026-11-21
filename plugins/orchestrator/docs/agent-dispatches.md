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
| `deep` | the top family, at the effort its calling orchestrator runs at now | orchestrators, successors, decision rounds, contract-defining phases, the final verification | nothing downstream |
| `standard` | the middle family at effort high, shipped by the plugin | behaviour and conversion phases, correction rounds, review collectors and lenses, comments agents | the test suite, then the review round |
| `light` | the smallest family at effort medium, shipped by the plugin | read-only search | the search itself: it finds or it does not |

The class of each kind of work and its tier: `skills/model-routing/SKILL.md`, « The table ».

## Choices

### 1. Pay for judgment that nothing downstream re-checks

- Since: the model routing design of 2026-10-09.
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

### 3. Every launched session carries its model and its effort

- Since: 2026-11-04, the operator. His rule, relayed verbatim by the audit session:
  « agents' model and effort are decided by the orchestrator; orchestrators inherit the model
  and effort of their predecessor; same for auditors and the coordinator. The default model
  applies only to sessions he launches by hand. If not, it is a critical bug. » His rulings
  on it the same day, in English: an agent an orchestrator launches gets its default from
  that orchestrator; an orchestrator, a coordinator or an auditor he launches himself runs at
  the effort he sets; a succession always inherits its predecessor's effort, whatever the
  role; the tier efforts ship in the plugin; an agent named with neither a tier nor a model
  is refused; an orchestrator the coordinator opens keeps the host's default for the
  session unless his order names a model and an effort.
- Choice: no launch leaves the effort to the host's setting, except an opening or a wake with
  nothing to read, where the operator's own default is the point.
  - A succession of any role — an orchestrator's or an auditor's successor, an auditor, the
    coordinator's successor, an agent's rotation given no pair — runs on its predecessor's
    live model and effort, read on the predecessor's transcript: the last request of its
    main thread names both. `--tier`, `--model` and `--effort` are refused beside
    `--successor`; nothing is a default, and a pair that cannot be read refuses the launch.
  - An agent's pair is its orchestrator's: a tier, or `--model` with `--effort`. A tier the
    map binds a model alone runs at the effort the plugin ships for it, `standard` high and
    `light` medium (choices 4 and 5), `deep` medium (the operator's order of 2026-11-21,
    over-consumption: deep at xhigh cost twice the medium). An effort the map binds wins over
    them. A model without an effort, and an agent
    with neither a tier nor a model, are refused.
  - An opened orchestrator types the model and the effort its order names, or neither. A
    woken one resumes on the pair its resumed transcript holds, else its recorded pair, else
    the host's default; it is never asked of the operator at the wake.
  - The home move resumes on the session's pair read on its transcript, not on its launch line.
- Why: the host's effort setting is the operator's default for new sessions, and he changes
  it by typing an effort command in any tab: every session launched since ran at that level,
  whatever its orchestrator, its tier or its predecessor ran at.
- Rule: `skills/iterm-agents/SKILL.md`, « Safety order for a launch », and `skills/model-routing/SKILL.md`.
- Superseded: « The top family's default effort is high », until 2026-11-04 — since
  2026-10-12, the operator (calibration decision O2): « the operator's default effort for the
  top family is `high`. It applies to every session on that family that names no effort, the
  `deep` tier's agents included, since the map binds that tier to the family alone. » Its
  evidence stays the reason the shipped efforts are not the top ones: published figures for
  the top family on a subset of SWE-bench Pro, per resolved task: low 87.4 % at 0.12 USD,
  medium 92.8 % at 0.22, high 95.3 % at 0.29, xhigh 96.7 % at 0.74; the same source calls
  gaps under about five points run noise. On the bugs-bot project's bench the top family
  passed at every effort, its cost rising from 0.18 USD at low to 1.09 USD at max. Before it:
  `xhigh`, until 2026-10-12.

### 4. The standard tier runs the middle family at effort high

- Since: 2026-10-12, the operator; shipped by the plugin as the tier's effort since 2026-11-04
  (choice 3).
- Why: on this repository's bench the middle family passed 10 trials of 10 at high and 7 of
  10 at medium. It holds until the profile and global tables say otherwise.

### 5. The light tier runs the smallest family at effort medium

- Since: 2026-10-12, the operator (calibration decision O3); shipped by the plugin as the
  tier's effort since 2026-11-04 (choice 3).
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

### 7. A successor inherits its orchestrator's current model and effort

- Since: 2026-09-10, the operator; the effort, and the transcript as the source, since
  2026-11-04 (choice 3).
- Choice: an orchestrator has no tier. Its successor runs the model and the effort the
  orchestrator runs now, read on the orchestrator's own transcript (its last main-thread
  request), never from a launch file or the map, and the successor's first statement of its
  model is checked.
- Why: a session's model and effort can change while it runs; only its current reading is
  the operator's choice. The transcript follows a change within the turn that makes it, and
  exists for a session launched by hand or without the plugin.
- Superseded: the model alone, read from the hooks module's measure file, until 2026-11-04.

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

### 13. A correction round runs one effort notch above its phase

- Since: routing phase 4 (#181, 2026-10-12), from the operator's study of the dispatch trials.
- Rule: `skills/model-routing/SKILL.md`, « The correction round runs one notch above its
  phase »; `routing.py pick` prints the pair as `corrective=<pair>`.
- Choice: a phase starts at the cheap pair its table gives, and its correction round runs the
  same family one effort level up (the same pair at the top effort). The review and the
  correction round are the escalation; this is not a cascade, and a phase is never retried at
  its own pair.
- Why: the round is the retry of a first attempt that fell short, and the same pair repeats the
  same shortfall; paying the notch only on a failure keeps the first attempt cheap.

### 14. A table measured on small work does not serve a large phase

- Since: routing phase 4 (#181, 2026-10-12), from the same study.
- Rule: `skills/model-routing/SKILL.md`, « Where the pair comes from » (pick by size).
- Choice: a phase of more than 3 files or more than 50 lines is large. `pick`, given its size,
  serves only an entry measured on large work, and otherwise names the scope it skipped
  (`size=large beyond=<scope>`), falling to the tier table when none was. A phase beyond every
  measured size gets a read-only search exploration first, its summary in the brief.
- Why: the gaps between pairs are small on short single-file work with a full spec and large
  beyond it, and our corpora are almost all short work: a pair's record there says little about
  a large phase.
