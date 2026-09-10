# Model routing — design

Status: validated · Scope: how the orchestrator picks the capability tier of every
session and subagent it dispatches, and the tooling that makes that choice executable.

## 1. Goal

The orchestrator dispatches every session that does the work: implementers, review
collectors, review lenses, comments agents, search subagents, its own successor. Each
dispatch currently runs at whatever the launch script hardcodes. This design gives the
orchestrator a method for choosing the ablest tier for the job while spending as little
as the job allows, and the minimum tooling to apply it: a tier vocabulary, an
operator-owned map from tier to model identifier, a `--tier` flag on the launcher, and
the tests that hold all three.

It also removes a model identifier the plugin should never have carried in its own
source (`iterm-agent.sh`, twice), which the policy grep did not catch because it only
looks for the host's name.

## 2. The principle

**Pay for judgment that nothing downstream re-checks.**

This is the rulebook's own doctrine turned toward cost. The orchestrator skill already
holds that a report is a claim and a finding list is not a verdict: everything an agent
produces is re-read on the artifact. So work whose output is verified by a machine (a
test suite, a quality gate, a "nothing observable changed" diff) or by the orchestrator
(a findings list, an exploration result) can run at the cheapest tier that closes it —
an error there is caught, and caught cheaply. Work that nothing re-checks — the
orchestrator's own sequencing, the contracts a phase imposes on every later phase, the
final verification pass — runs at the top tier, because an error there is paid N times.

Two corollaries the rest of the design implements:

- The cheapest tier is not the target. **The cheapest tier observed to close a class of
  work in one round** is the target; a round that has to be repeated costs more than the
  tier it saved.
- A tier is chosen from readings taken before the dispatch, not from an impression of
  how hard the phase looks.

## 3. Tiers and the map

Three tiers, named by capability: `deep`, `standard`, `light`. The plugin names no model.

The binding lives in `${CLAUDE_CONFIG_DIR:-~/.claude}/claude-orchestrator/models.json`,
beside `ctx/` in the state directory the installer already creates:

```json
{"deep": "", "standard": "", "light": ""}
```

- The installer creates the file with three empty values and **never overwrites an
  existing one**.
- `ORCHESTRATOR_TIER_DEEP`, `ORCHESTRATOR_TIER_STANDARD`, `ORCHESTRATOR_TIER_LIGHT`
  override the file for one run.
- An empty or missing binding is not an error: it means "let the host choose". The
  launcher then types no model argument at all.

An unbound tier degrades to the host default rather than to a guess, so a half-filled
map never silently routes deep work to a cheap model.

## 4. The routing table

| Class of work | Tier | What re-reads its output |
|---|---|---|
| Orchestrator, successor, decision round | `deep` | nobody |
| Phase that **defines a contract** a later phase consumes verbatim | `deep` | nothing until phase N+1 pays for it |
| Final verification phase (spec conformity, norms over the full diff, E2E) | `deep` | nobody |
| Behaviour phase, contract already fixed | `standard` | the test suite, then the review round |
| Conversion phase (move, rename, extract) | `standard` | "nothing observable changed": the suite judges |
| N-bis corrective on a findings list | `standard` | the round that re-reads the repair |
| Review collector, comments agent | `standard` | the orchestrator verifies every finding |
| Review lenses (the fan-out readers) | `standard` | the collector, then the orchestrator |
| Read-only search subagents | `light` | they locate; they never judge |

**Both dispatch channels use this one table.** Tab sessions launched by the launcher
script, and subagents launched from inside a session — the review collector's lenses,
an implementer's read-only search subagents. The review brief states the tier the
collector gives its lenses; without that, half the table applies nowhere.

## 5. The five readings

For a phase that does not obviously sit on a row of the table, take these five readings
from the plan and the decision log **before** dispatching. Each is a reading, not an
impression:

1. **Contract novelty** — does the phase publish a signature a later phase consumes
   verbatim? The plan's interface section answers this.
2. **Proof shape** — "nothing observable changed", or "the behaviour changed and a test
   drives it"? The plan already declares this: one kind of change per phase.
3. **Blast radius** — files in scope, consumers downstream.
4. **Residual ambiguity** — questions still open on this phase in the decision log.
5. **Repair history** — findings that survived a round on this phase or its class.

Two or more readings high raises the table's row by **one** tier. Never more than one
step at a time, and never as a running total: the readings are retaken at each dispatch.

## 6. Escalation, de-escalation, false economy

**Escalate on evidence, one step, at a session boundary.** The triggers:

- the same class of finding survives one N-bis round;
- the agent STOPs twice on the same ambiguity;
- the agent crosses the context gate without a single push.

An escalation is executed **as a rotation**: a fresh session at the higher tier with a
resume brief. A model does not change inside a live session, so escalation and rotation
are the same act, and the rotation brief carries the evidence that triggered it.

**Never de-escalate inside a phase.** A drop applies to the next dispatch of that class.

**The false-economy rule.** A tier drop that produces a second corrective round is
reverted for that class, and the reversion is recorded. A rework round plus its review
round costs more than the phase would have cost one tier up. This rule is what stops the
table drifting downward: without it, every drop looks free at the moment it is taken,
and the cost lands two rounds later where nobody attributes it.

## 7. Budget pressure, measured

The status-line tap already captures `five_hour_percent` and `seven_day_percent`, and the
gauge already prints them. Before every dispatch the orchestrator **reads** them — the
same doctrine the skill applies to context: measure, never estimate.

- **Above ~70 % on either figure**: every class drops one tier, **except** the rows the
  principle protects — orchestrator and successor, contract-defining phases, final
  verification. The orchestrator states the degradation to the operator in one line: a
  degraded wave is a fact the operator owns.
- **Above ~90 %**: no new dispatch. Finish what is in flight, queue the rest. A wave that
  dies mid-phase is the most expensive failure available, because the phase is redone
  from a cold session with no memory of what it had already decided.

Pressure modifies the tier for one dispatch. It never rewrites the table.

The two thresholds are read by the orchestrator, not enforced by code: nothing in the
plugin blocks a dispatch. A gate that cannot measure must not hold a run, and a quota
figure can be missing (an idle session's tap file ages out). When the figures cannot be
read, the orchestrator says so and routes on the table alone.

## 8. The dispatch record

One line per dispatch in the project's own build state: class, tier, rounds to close,
verdict. That record is what corrects the table for this build under §6, and the
succession brief points at it.

The plugin ships the default table and holds no history: a project's empirical
corrections belong to that project's state, where status lives once.

## 9. Surface

**New skill `skills/model-routing/SKILL.md`** — the principle, the table, the five
readings, escalation and false economy, budget pressure, and its own rationalizations
table. A separate skill, as the gauge is, with a short gate paragraph added to
`skills/orchestrator/SKILL.md`: the tier is chosen at the dispatch gate, where the
context figure is already read. The orchestrator skill is dense enough that pouring the
whole table into it would cost more readability than the cross-reference costs.

**`skills/iterm-agents/scripts/iterm-agent.sh`**

- `--tier deep|standard|light` on `spawn` and `rotate`, resolved through the map.
- `--model <id>` kept as an explicit override. `--tier` and `--model` together are
  refused, as `--prompt` and `--prompt-file` already are.
- The hardcoded model default is removed from both argument parsers. With neither a tier
  nor a binding, **no model argument is typed at all** and the host applies its own
  default.
- There is no default tier. A `spawn` or `rotate` without `--tier` and without `--model`
  types no model argument, exactly as an unbound tier does.
- New subcommand `resolve-tier <name>`: prints the bound identifier, exit 1 when the tier
  is unknown, exit 0 with empty output when it is known but unbound. This is what the
  orchestrator runs to read its own map, and what the tests call.

**Templates**

- `agent-phase-brief.md` §6: the tier the agent was dispatched at and the reading that
  decided it, plus the agent-side escalation signal — *if the work proves to need more
  judgment than this brief anticipated, STOP and say so with the evidence*. The
  orchestrator cannot see that from outside.
- `agent-rotation-brief.md`: the resume tier, and when the rotation **is** an escalation,
  the evidence that triggered it.
- `agent-review-brief.md`: the tier the collector gives its lenses.
- `orchestrator-succession-brief.md`: a pointer to the dispatch record of §8.

**Commands**

- `commands/status.md` gains the two quota figures and the current pressure state. No new
  command: the dispatch gate already reads the status.
- `commands/succeed.md` passes `--tier deep` in place of an explicit model.

**Installer** — `install.sh` creates `models.json` with three empty bindings if absent,
prints where it is and what to write in it, and `--dry-run` still changes nothing.
`uninstall.sh` removes it with the rest of the state directory.

**Docs** — a section in `docs/design.md`, a paragraph in `README.md`, version `0.6.0` in
`plugin.json`: the launcher's observable default changes for existing installations.

## 10. Tests

Added to `tests/run-tests.sh`, same constraints as the rest of the suite (bash, no
network, no terminal automation, isolated `HOME`):

- **Policy**: the repository names no real model family anywhere outside its own
  documentation of the map's shape. The existing assertion that the typed command
  carries a specific model identifier is removed — it asserts exactly what this design
  forbids.
- **Map resolution**: bound tier resolves to its identifier; unbound tier resolves to
  empty with exit 0; unknown tier exits 1; the environment variable wins over the file;
  a missing file behaves as an all-empty map.
- **Launcher**: `--tier` types the bound identifier; `--tier` with an unbound tier types
  no model argument; no tier and no map types no model argument; `--tier` with `--model`
  is refused; `rotate` passes the tier through to the spawn it performs.

## 11. Compatibility

An existing installation that relied on the launcher's hardcoded default sees its
spawned sessions fall back to the host default until the operator fills the map. That is
the intended migration and the reason for the minor version bump; the installer prints
the file path and the three keys on every run so an upgrade surfaces it.

## 12. Out of scope

- Measuring the money cost of a dispatch. The host exposes quota percentages, not prices;
  the design routes on the figures that exist.
- Choosing tiers for sessions the orchestrator does not dispatch. The operator's own
  session is the operator's business.
- A per-project floor forcing a minimum tier. It would put model identifiers in a
  downstream repository and move the policy away from the operator; revisit only if a
  project demands it.
