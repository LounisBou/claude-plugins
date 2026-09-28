---
name: model-routing
description: Use when this session is about to dispatch another one — an implementer, a review collector and its lenses, a comments agent, a search subagent, a successor — and must choose the capability tier that closes the work in one round at the least cost, however small the job; a general question about the tiers, with nothing to dispatch, is not one.
---

# Model routing

**This skill is a decision aid for the orchestrator.** Its table, its readings, its escalation and its record are inputs to your own judgment: you decide the tier or the model, and you write the choice and its reason in the brief. They inform the choice of a tier and do not replace it. What is not a choice of tier — how the map is bound, the mode an unattended session runs in, how a round is recorded, never de-escalating inside a phase, never cascading a phase, one tier below the row and never two, the false-economy reversion, and reading the record's summary before a wave and reverting what it names — holds as written. `references/incidents.md` tells, by rule id, the incident behind a rule — read it when a rule's reason is in question.

## The principle

**Pay for judgment that nothing downstream re-checks.**

The rulebook already holds that a report is a claim and a findings list is not a verdict: everything an agent produces is re-read on the artifact. So work whose output is verified by a machine — a test suite, a quality gate, a « nothing observable changed » diff — or by you, can run at the cheapest tier that closes it: an error there is caught, and caught cheaply. Work that nothing re-checks — your own sequencing, the contracts a phase imposes on every later phase, the final verification pass — runs at the top tier, because an error there is paid N times.

Two corollaries govern every rule below. **The cheapest tier is not the target**: the cheapest tier observed to close a class of work IN ONE ROUND is. And **a tier is read, not felt**: it comes from readings taken before the dispatch, never from an impression of how hard the phase looks.

## Tiers and the map

Three tiers name capability: `deep`, `standard`, `light`. What each one runs on is the operator's, not this plugin's: the binding lives in `<state dir>/models.json`, and `iterm-agent.sh resolve-tier <tier>` prints it. **Read your map before dispatching a wave.** An unbound tier is not an error — the launcher then types no model argument and the host applies its default. When the tier the work needs is unbound, pick the model you judge fit for the work — `--model <name>` on that one spawn, or the host's default taken on purpose — write the choice and its reason in the brief, and tell the operator in one line at the spawn, so he can correct it or bind the tier. The operator's reasoning: « if the orchestrator judges that a better model should be used, it may have a better view than I do, following the work from a distance ». His map stays his: you never rebind it yourself — a binding the mode check refuses is put to him with the refusal; a model you choose for an unbound tier runs in the operator's decision mode, or, for a model with no auto mode, with `--permission-mode acceptEdits`.

**A tier is bound to a family alias, never to a versioned identifier.** The alias is the unversioned name the host resolves to that family's latest model; a versioned identifier keeps naming the model it named the day it was written, and goes stale without a sign. The launcher now warns in one line when a tier resolves to a versioned identifier, names the alias to bind instead, and launches anyway: the map is the operator's to rebind.

**A tier is bound to a model the host runs in the operator's decision mode, or no unattended agent runs at it**: the host once ignored the mode at one tier of three, and its sessions stood on their first permission prompt. So **a session nobody watches runs in the operator's decision mode**, and a binding that does not give that is a binding to fix: rebind the tier, or spawn that agent with `--permission-mode acceptEdits` for a few edits and allow-listed commands only, which the same model did honour. The launcher reads the mode on the session's own transcript and refuses the spawn when it differs, so a wrong binding costs a refusal rather than an agent asleep in a tab. Name the mode in the brief where you name the tier.

## The table

Each row is the tier this skill reads for a class of work: the input you start from, weighed with the readings below and the record. You decide the tier, and the brief carries it with its reason.

| Class of work | Tier | What re-reads its output |
|---|---|---|
| You, your successor, a decision round | `deep` | nobody |
| A phase that **defines a contract** a later phase consumes verbatim | `deep` | nothing until phase N+1 pays for it |
| The final verification phase (spec conformity, norms over the full diff, E2E) | `deep` | nobody |
| A behaviour phase with the contract already fixed | `standard` | the test suite, then the review round |
| A conversion phase (move, rename, extract) | `standard` | « nothing observable changed »: the suite judges |
| An N-bis corrective on a findings list | `standard` | you, on the artifact: the diff, the decisive tests, a mutation |
| A review collector, a comments agent | `standard` | you verify every finding |
| The review lenses | `standard` | the collector, then you |
| Read-only search subagents | `light` | they locate; they never judge |

**Both dispatch channels read this one table**: the tabs you launch, and the subagents launched inside a session — the collector's lenses, an implementer's search readers. Say the lenses' tier in the review brief, or half this table applies nowhere.

## The five readings

For a phase that does not sit plainly on a row, take these before dispatching, from the plan and the decision log:

1. **Contract novelty** — does the phase publish a signature a later phase consumes verbatim? The plan's interface section answers it.
2. **Proof shape** — « nothing observable changed », or « the behaviour changed and a test drives it »? The plan declares it: one kind of change per phase.
3. **Blast radius** — files in scope, consumers downstream.
4. **Residual ambiguity** — questions still open on this phase in the decision log.
5. **Repair history** — findings that survived a round on this phase or its class.

Two readings high or more raises the row by **one** tier. Never more than one step, and never as a running total: the readings are retaken at each dispatch.

## Escalate on evidence, one step, at a session boundary

Triggers, each of them a thing you have read and not a feeling about the agent:

- the same class of finding survives one N-bis round;
- the agent STOPs twice on the same ambiguity;
- the agent crosses the context gate without a single push.

An escalation IS a rotation: a model does not change inside a live session. Fresh session, resume brief, one tier up, and the brief carries the evidence that triggered it — otherwise the replacement repeats the round that failed.

**Never de-escalate inside a phase.** A drop applies to the next dispatch of that class.

## Cascade where a retry is cheap — and only there

Routing before the work, from the table's reading, is what the table does. The cheaper
strategy in the literature is a **cascade**: try the cheap model, escalate when the result
does not hold. It reports very large savings, and it rests on one assumption — that a failed
attempt is cheap to detect and cheap to throw away.

For an implementation phase that assumption is false, and expensively so: a failed attempt
is a whole review round plus a rework round, which is exactly what the false-economy rule
below exists to punish. **Never cascade a phase.**

For three classes it is true, because a machine says whether the attempt held and throwing
it away costs one short session:

| Class | What detects the failure | What a retry costs |
|---|---|---|
| A review lens | its report is empty, vague, or dies on the first verification you run | one reader, re-run |
| A read-only search subagent | it returns nothing where you know something is | one search |
| An N-bis narrow enough that the gate judges it | the project's own quality gate | one short session |

**How to cascade.** Dispatch one tier BELOW the table's row and mark it — `dispatch-record.sh open … --cascade`. If the attempt holds in one round, the bet paid. If it costs a round, re-dispatch at the table's row and close the marked row `--verdict escalated`.

**When to stop.** `summary` reports `cascade=<class> at <tier>: N of M paid`, and says `stop cascading` when fewer than half pay over at least two attempts — at that point the retries cost more than the tier they saved. Marking is what makes this readable at all: unmarked, a cascade that failed is indistinguishable from a row that simply needed two rounds, and nobody can tell an economy from a cost.

**One step, as everywhere else.** A cascade is one tier below the row, never two. Two steps means the readings were not taken.

## The false economy

**A tier drop that produces a second corrective round is reverted for that class, and the reversion is recorded.** A rework round plus its review round costs more than the phase would have cost one tier up.

This is the rule that keeps the table from drifting downward. Without it every drop looks free at the moment it is taken, and its cost lands two rounds later where nobody attributes it — the same shape as « it passed alone three times, it's flaky ».

## A second reader, armed by evidence and not by default

The published measurements of model judges are lopsided in a way that matters here: a
strong judge keeps false POSITIVES low — it rarely invents a defect — while its false
negatives stay moderate to high. What a review costs you is what it MISSED, and a missed
defect leaves no trace in the round that missed it.

The recommended mitigation is a panel of differing readers with a consensus rule. Standing
panels are expensive, and your compensating control is already stronger than a vote: you
verify every finding on the artifact yourself, and you mutate the tests the verdict rests
on. So the panel is not a default here. It is armed by evidence:

- When a later round contradicts an approval — a defect in work already approved — record
  it: `dispatch-record.sh escaped <record> <id>`.
- `summary` then prints `signal=double-read <class> at <tier>`. From that point, that class
  gets a **second reader with a DIFFERENT lens** on its next round, and a finding is kept
  only when both readers see it.
- Different lens, not a second opinion on the same one: two readers asked the same question
  agree by construction, and agreement bought that way is the shape of a gate green over
  nothing.

**Do not arm this from a hunch.** A round with no escape recorded is a round that read what
it was meant to read, as far as anything here can tell — and an unrecorded escape is a
measurement nobody took, not an absence of the problem. Recording it when you find one is
the whole cost of the rule.

## The record

One row per dispatch in the project's build state: class, tier, rounds to close, verdict. That record is what corrects the table for this build, and your succession brief points at it. The default table ships here; a project's corrections belong to that project, where status lives once.

Keep it with `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/dispatch-record.sh`:

```
dispatch-record.sh open <record> --class <c> --tier <t> --label <what>   # prints the row id
dispatch-record.sh round <record> <id>                                  # a review round happened
dispatch-record.sh review <record> <id> --head <sha> --norms tool|none  # and what it read
dispatch-record.sh fixed <record> <id> --head <sha>                     # the one correction round, verified
dispatch-record.sh ready <record> <id> --head <sha>                     # 0 only if reviewed or fixed there
dispatch-record.sh close <record> <id> --verdict approved
dispatch-record.sh summary <record>
```

`review` is what a review round records instead of `round`: the head it read, and whether the project's own norms tool ran (`tool`) or the project ships none (`none`). `fixed` records the ONE correction round that review produced, at the head you verified on the artifact; it is refused without a review and refused a second time. `ready` is the gate in front of telling the operator a pull request is ready — it exits 0 only when that head is the one the last review read or the one its correction round was verified at. The pull request stays in draft: lifting it is the operator's.

`summary` prints one line per class and tier, and then the line the false-economy rule exists for:

```
signal=n-bis at light averages 2 rounds: the drop did not pay, revert it for this class
```

**Read the summary before a wave, and revert what it names.** Without it the rule is applied from memory, and a rule applied from memory always finds the drop was free: its cost lands rounds later, where nobody attributes it. A signal is a reading, and a reading is what the rule was written to require.

## Rationalizations

| Excuse | Reality |
|---|---|
| "It is only a rename, the cheapest tier will do" | The row reads `standard` because the suite judges the rename: the tier follows what re-reads the output (« The principle »). |
| "This phase is hard, give it the top tier" | Hard is not a reading: « The five readings ». |
| "The last drop went fine, drop the next class too" | One round is not a measurement of a class. Drop from the record (« The record »), not from a mood. |
| "The round failed, but the tier was not the reason" | Name the mechanism, or revert the drop: « The false economy ». |
| "Escalate now, the agent is struggling" | An escalation is a rotation: « Escalate on evidence ». |
| "The map is empty but the tiers are in the briefs" | Then the tier names nothing. Run `resolve-tier`; where the tier is unbound, choose the model yourself, write the choice and its reason in the brief, and tell the operator in one line. |
| "Cascading saved 90% in the papers, so cascade the phases too" | Never cascade a phase: « Cascade where a retry is cheap ». |
| "The review found nothing, so the code is clean" | It found nothing it read; a miss exists only once recorded: « A second reader ». |
| "The cascade failed once, that proves nothing" | Right, and one success proves nothing either: the rule reads the paid rate over two attempts. |
| "Two tiers up, this one is clearly out of reach" | One step: « The five readings ». |

## Red flags: STOP

- A dispatch prepared without the tier and the reading that chose it.
- A wave dispatched without reading the record's summary, or a signal in it not reverted (« The record »).
- A phase dispatched as a cascade, or a cascade without `--cascade` on its row (« Cascade where a retry is cheap »).
- A defect found in approved work not recorded as an escape; a second reader given the same lens (« A second reader »).
- A tier chosen from how hard the phase feels rather than from the five readings.
- A second corrective round on a class you dropped, and the drop still standing (« The false economy »).
- An escalation attempted inside a live session instead of as a rotation.
- A wave dispatched without reading the map, then reported as routed.
