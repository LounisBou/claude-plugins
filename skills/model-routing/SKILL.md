---
name: model-routing
description: Use when this session is about to dispatch another one — an implementer, a review collector and its lenses, a comments agent, a search subagent, a successor — and must choose the capability tier that closes the work in one round at the least cost.
---

# Model routing

## The principle

**Pay for judgment that nothing downstream re-checks.**

The rulebook already holds that a report is a claim and a findings list is not a verdict: everything an agent produces is re-read on the artifact. So work whose output is verified by a machine — a test suite, a quality gate, a « nothing observable changed » diff — or by you, can run at the cheapest tier that closes it: an error there is caught, and caught cheaply. Work that nothing re-checks — your own sequencing, the contracts a phase imposes on every later phase, the final verification pass — runs at the top tier, because an error there is paid N times.

Two corollaries govern every rule below. **The cheapest tier is not the target**: the cheapest tier observed to close a class of work IN ONE ROUND is. And **a tier is read, not felt**: it comes from readings taken before the dispatch, never from an impression of how hard the phase looks.

## Tiers and the map

Three tiers name capability: `deep`, `standard`, `light`. What each one runs on is the operator's, not this plugin's: the binding lives in `<state dir>/models.json`, and `iterm-agent.sh resolve-tier <tier>` prints it. **Read your map before dispatching a wave.** An unbound tier is not an error — the launcher then types no model argument and the host applies its default — but it means the table below is advisory rather than applied, and you say so rather than assume it took.

## The table

| Class of work | Tier | What re-reads its output |
|---|---|---|
| You, your successor, a decision round | `deep` | nobody |
| A phase that **defines a contract** a later phase consumes verbatim | `deep` | nothing until phase N+1 pays for it |
| The final verification phase (spec conformity, norms over the full diff, E2E) | `deep` | nobody |
| A behaviour phase with the contract already fixed | `standard` | the test suite, then the review round |
| A conversion phase (move, rename, extract) | `standard` | « nothing observable changed »: the suite judges |
| An N-bis corrective on a findings list | `standard` | the round that re-reads the repair |
| A review collector, a comments agent | `standard` | you verify every finding |
| The review lenses | `standard` | the collector, then you |
| Read-only search subagents | `light` | they locate; they never judge |

**Both dispatch channels use this one table**: the tabs you launch, and the subagents launched inside a session — the collector's lenses, an implementer's search readers. Say the lenses' tier in the review brief, or half this table applies nowhere.

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

## The false economy

**A tier drop that produces a second corrective round is reverted for that class, and the reversion is recorded.** A rework round plus its review round costs more than the phase would have cost one tier up.

This is the rule that keeps the table from drifting downward. Without it every drop looks free at the moment it is taken, and its cost lands two rounds later where nobody attributes it — the same shape as « it passed alone three times, it's flaky ».

## Budget pressure, measured

Before every dispatch, read `five_hour_percent` and `seven_day_percent` from `orchestrator:context-gauge`. Measure, never estimate — the same rule as context.

- **At or above ~70 % on either**: every class drops one tier EXCEPT the rows the principle protects — you and your successor, contract-defining phases, the final verification. Tell the operator in one line: a degraded wave is a fact they own.
- **At or above ~90 %**: dispatch nothing new. Finish what is in flight, queue the rest. A wave that dies mid-phase is redone from a cold session that remembers none of what it had decided, which is the most expensive outcome available.
- **Unreadable figures**: both read `unavailable` when the answer came from the transcript or the payload never carried them. Say so and route on the table alone — a gate that cannot measure does not hold a run, and an absent figure is never read as zero.

Pressure modifies one dispatch. It never rewrites the table.

## The record

One row per dispatch in the project's build state: class, tier, rounds to close, verdict. That record is what corrects the table for this build, and your succession brief points at it. The default table ships here; a project's corrections belong to that project, where status lives once.

Keep it with `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/dispatch-record.sh`:

```
dispatch-record.sh open <record> --class <c> --tier <t> --label <what>   # prints the row id
dispatch-record.sh round <record> <id>                                  # a review round happened
dispatch-record.sh close <record> <id> --verdict approved
dispatch-record.sh summary <record>
```

`summary` prints one line per class and tier, and then the line the false-economy rule exists for:

```
signal=n-bis at light averages 2 rounds: the drop did not pay, revert it for this class
```

**Read the summary before a wave, and revert what it names.** Without it the rule is applied from memory, and a rule applied from memory always finds the drop was free: its cost lands rounds later, where nobody attributes it. A signal is a reading, and a reading is what the rule was written to require.

## Rationalizations

| Excuse | Reality |
|---|---|
| "It is only a rename, the cheapest tier will do" | The row already says `standard`, and it says it because the suite judges the rename. The tier follows what re-reads the output, not how easy the diff looks. |
| "This phase is hard, give it the top tier" | Hard is not the reading. Contract novelty, proof shape, blast radius, ambiguity, repair history — two of them high, one step up. |
| "The last drop went fine, drop the next class too" | One round is not a measurement of a class. The record says which classes closed in one round; drop from that, not from a mood. |
| "The round failed, but the tier was not the reason" | Maybe. Name the mechanism the way you would for a fall under load, or revert the drop. An unattributed cost is how a false economy survives. |
| "Escalate now, the agent is struggling" | Mid-session there is nothing to escalate: the model is fixed. Rotate, or wait for the boundary. |
| "The quota is high, drop everything a tier" | Not the contracts and not yourself. A cheap orchestrator produces expensive waves, and a cheap contract is paid by every later phase. |
| "The map is empty but the tiers are in the briefs" | Then nothing is routed and the host decides everything. Run `resolve-tier`, and say the routing is advisory until the operator binds it. |
| "Two tiers up, this one is clearly out of reach" | One step. Two steps means the readings were not taken, and there is no evidence to revert to. |

## Red flags: STOP

- A dispatch prepared without the tier and the reading that chose it.
- A wave dispatched without reading the record's summary; a signal in it you have seen and not reverted.
- A tier chosen from how hard the phase feels rather than from the five readings.
- A second corrective round on a class you dropped, and the drop still standing.
- An escalation attempted inside a live session instead of as a rotation.
- Budget pressure applied to yourself, to a contract-defining phase or to the final verification.
- A wave dispatched without reading the map, then reported as routed.
