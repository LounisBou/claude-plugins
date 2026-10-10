---
name: model-routing
description: Use when this session is about to dispatch another one — an implementer, a review collector and its lenses, a comments agent, a search subagent, a successor — and must choose the model/effort pair that closes the work in one round at the least cost, however small the job; a general question about the capability tiers, with nothing to dispatch, is not one.
---

# Model routing

**This skill is a decision aid for the orchestrator.** Its tables, its readings, its escalation and its record inform your judgment: you decide the pair, the tier or the model, and the brief carries the choice and its reason. What is not a choice of pair — how the map is bound, the mode an unattended session runs in, how a round and its cost are recorded, never de-escalating inside a phase, never cascading a phase, one notch below and never two, the classes never explored, the false-economy reversion, and reading the record's summary before a wave and reverting what it names — holds as written.

## The principle

**Pay for judgment that nothing downstream re-checks.** Work whose output a machine or you re-check — a test suite, a quality gate, a « nothing observable changed » diff — runs at the cheapest tier that closes it: an error there is caught cheaply. Work that nothing re-checks — your own sequencing, a contract later phases consume, the final verification — runs at the top tier, because an error there is paid N times. The target is the cheapest pair observed to close a class IN ONE ROUND, and a pair comes from measurements and readings taken before the dispatch, never from how hard the phase looks. The cost that ranks pairs is the measured cost of a dispatch closed to satisfaction, its corrective rounds included; never read the subscription gauge to choose.

How the tables are measured, generalised and exported: `references/calibration.md`.

## Pairs, tiers and the map

A dispatch runs on a **pair** `<alias>/<effort>`: a family alias and an effort, one of `low`, `medium`, `high`, `xhigh`, `max`. `spawn --model <alias> --effort <level>` sets it; without an effort the launcher types none and the host applies its default. Three tiers name capability: `deep`, `standard`, `light`. Their binding is the operator's, in `<state dir>/models.json`, a model alone (`"a-model"`) or a pair (`{"model": "a-model", "effort": "medium"}`); `iterm-agent.sh resolve-tier <tier>` prints `<model>` or `<model>/<effort>`, and `spawn --tier` takes the effort from the map unless `--effort` is given. **Read your map before dispatching a wave.** An unbound tier is not an error: the launcher types no model argument and the host applies its default. When the tier the work needs is unbound, pick the model you judge fit — `--model <name>` on that one spawn, or the host's default taken on purpose — write the choice and its reason in the brief, and tell the operator in one line at the spawn, so he can correct it or bind the tier. You never rebind his map yourself: a binding the mode check refuses is put to him with the refusal.

**A tier or a pair names a family alias, never a versioned identifier**, which keeps naming the model it named the day it was written. The launcher warns in one line on a versioned binding, names the alias to bind instead, and launches anyway.

**A session nobody watches runs in the operator's decision mode.** A binding the host does not run in that mode is a binding to fix: rebind the tier, or spawn that agent with `--permission-mode acceptEdits` for a few edits and allow-listed commands only. The launcher reads the mode on the session's transcript and refuses the spawn when it differs. A model you choose for an unbound tier runs in the operator's decision mode, or, with no auto mode, with `--permission-mode acceptEdits`. Name the mode in the brief where you name the pair.

## Where the pair comes from

Before each dispatch, run `routing.py pick --repo <checkout> --class <class> --record <record>`
(`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/scripts/routing.py`). It prints the pair and the
table it came from — the project's, its profile's, the global one, a shipped default, or the
tier table below. Write the pair, its source and your reason in the brief. You may override it:
say why. An entry marked `stale` was measured on a model the alias no longer resolves to; use
it, and tell the operator in one line that a bench run would refresh it.

`routing.py profile <checkout>` prints the inferred `<language>/<kind>`; a `profile` in the project's manifest overrides it, and `pick` takes the override first. A line `pair=host-default` means the class's tier is unbound: the paragraph on unbound tiers above applies.

## The table

The floor `pick` lands on when nothing is measured: the class's tier, through the map. The slug is the `--class` `pick` and the record take.

| Class of work | Slug | Tier | What re-reads its output |
|---|---|---|---|
| You, your successor, a decision round | `orchestrator`, `successor`, `decision-round` | `deep` | nobody |
| A phase that **defines a contract** a later phase consumes verbatim | `contract-phase` | `deep` | nothing until phase N+1 pays for it |
| The final verification phase (spec conformity, norms over the full diff, E2E) | `final-verification` | `deep` | nobody |
| A behaviour phase with the contract already fixed | `behaviour-phase` | `standard` | the test suite, then the review round |
| A conversion phase (move, rename, extract) | `conversion-phase` | `standard` | « nothing observable changed »: the suite judges |
| An N-bis corrective on a findings list | `n-bis` | `standard` | you, on the artifact: the diff, the decisive tests |
| A review collector, a comments agent | `review-collector`, `comments` | `standard` | you verify every finding |
| The review lenses | `review-lens` | `standard` | the collector, then you |
| Read-only search subagents | `search` | `light` | they locate; they never judge |

The tabs you launch and the subagents launched inside a session read this one table: say the lenses' pair in the review brief.

## The five readings

For a phase that does not sit plainly on a row, take these before dispatching, from the plan and the decision log:

1. **Contract novelty** — does the phase publish a signature a later phase consumes verbatim?
2. **Proof shape** — « nothing observable changed », or « the behaviour changed and a test drives it »?
3. **Blast radius** — files in scope, consumers downstream.
4. **Residual ambiguity** — questions still open on this phase in the decision log.
5. **Repair history** — findings that survived a round on this phase or its class.

Two readings high or more raises the pair by **one** notch up the class's ladder (the pairs of its table entry, ordered by measured cost per closed dispatch), never more, never as a running total: the readings are retaken at each dispatch.

## Explore one notch, never more

`pick` prints a second line, `explore=<pair>`, when the record shows three one-round closes at the class's pair, no escaped defect there, and no failed exploration of the class. The pair is **one notch** below: the immediate cheaper pair of the class's ladder, unless it was measured below the floor (a pair short of trials is offered); without a ladder to read it from, the effort one level down on the same family; at the lowest effort, the next lighter family in the map at the same effort. Take it only when the five readings show at most one high, and open the row `--explore`.

The orchestrator, a successor, a decision round, a contract-defining phase and the final verification are never explored: nothing re-checks that work, so a failure there is paid N times.

`summary` prints `frozen=<class>` after an exploration that cost a corrective round or let a defect escape: the class reverts to its pair and is not explored again this build. It prints `promote=<class> <pair>` after three explorations closed in one round: dispatch the class on that pair for the rest of the build, and fold it into the project's table with `routing.py calibrate <slug> --from-record <record>`.

An exploration is not a cascade. A cascade retries the same work one notch below and is forbidden on phases; an exploration dispatches the work once, at the lower pair, and its failure is paid by the normal correction round.

## Escalate on evidence, one step, at a session boundary

Triggers, each a thing you have read:

- the same class of finding survives one N-bis round;
- the agent STOPs twice on the same ambiguity;
- the agent crosses the context gate without a single push.

An escalation IS a rotation — fresh session, resume brief, one notch up the class's ladder, the brief carrying the evidence that triggered it. **Never de-escalate inside a phase**: a drop applies to the next dispatch of that class.

## Cascade where a retry is cheap — and only there

A cascade tries one notch below the class's pair and escalates when the result does not hold. It pays only where a failed attempt is cheap to detect and to throw away. For a phase it is not — a failed attempt costs a review round plus a rework round — so **never cascade a phase**. Three classes qualify:

| Class | What detects the failure | What a retry costs |
|---|---|---|
| A review lens | its report is empty, vague, or dies on the first verification you run | one reader, re-run |
| A read-only search subagent | it returns nothing where you know something is | one search |
| An N-bis narrow enough that the gate judges it | the project's own quality gate | one short session |

Dispatch one notch below and mark it — `dispatch-record.sh open … --cascade`; if it costs a round, re-dispatch at the class's pair and close the marked row `--verdict escalated`. `summary` reports `cascade=<class> at <pair>: N of M paid` and says `stop cascading` when fewer than half pay over at least two attempts. One notch below, never two.

## The false economy

**A pair drop that produces a second corrective round is reverted for that class, and the reversion is recorded, unless you name the mechanism, other than the pair, that cost the round.** A rework round plus its review round costs more than the phase one notch up.

## A second reader, armed by evidence

A strong judge rarely invents a defect but misses some, and a miss leaves no trace in the round that missed it. When a later round finds a defect in work already approved, record it: `dispatch-record.sh escaped <record> <id>`. `summary` then prints `signal=double-read <class> at <pair or tier>`, and that class's next round gets a **second reader with a DIFFERENT lens**; a finding is kept only when both see it. Not from a hunch, and never a second reader on the same lens.

## The record

One row per dispatch in the project's build state: class, pair (or tier), rounds to close, measured cost, verdict. It corrects the table for this build, and your succession brief points at it. Keep it with `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/dispatch-record.sh`:

```
dispatch-record.sh open <record> --class <c> --model <alias> --effort <level> [--explore] --label <what>   # prints the row id
dispatch-record.sh open <record> --class <c> --tier <t> --label <what>   # a tier row, when no pair is chosen
dispatch-record.sh round <record> <id>                                  # a review round happened
dispatch-record.sh review <record> <id> --head <sha> --norms tool|none  # and what it read
dispatch-record.sh fixed <record> <id> --head <sha>                     # the one correction round, verified
dispatch-record.sh ready <record> <id> --head <sha>                     # refuses a head neither reviewed nor fixed; with no review, warns
dispatch-record.sh close <record> <id> --verdict approved
dispatch-record.sh cost <record> <id> --session <session id>         # after each session of the dispatch ends
dispatch-record.sh summary <record>
```

`review` records instead of `round` the head it read and whether the project's own norms tool ran (`tool`) or the project ships none (`none`). `fixed` records the ONE correction round at the head you verified on the artifact; with no review on the row, or a second time, it replaces the recorded correction and warns. `ready` stands in front of telling the operator a pull request is ready: it passes at the head the last review read or the one its correction round was verified at, and refuses any other; with no review on the row it warns. The pull request stays in draft: lifting it is the operator's by default. `cost` adds a session's measured cost to the row once that session ends — its id is the one the spawn verified — so a dispatch's corrective rounds count in what it cost; a model with no price marks the row `cost_incomplete`.

The summary groups rows by class and pair, with `cost_avg=<usd>` over the closed rows whose cost is complete, and prints `frozen=<class>` and `promote=<class> <pair>` for the explorations above.

**Read the summary before a wave, and revert what it names:**

```
signal=n-bis at light averages 2 rounds: the drop did not pay, revert it for this class
```

## The costliest mistakes

- A pair chosen from how hard the phase feels, or two notches at once — run `pick`, take the five readings.
- A wave dispatched without reading the map or the summary, or a signal in it left standing.
- A class explored that is never explored, or explored again after `frozen=`.
- A phase cascaded, or an escalation attempted inside a live session instead of as a rotation.
