# Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the orchestrator a documented method and the tooling to route every dispatch to the capability tier that closes the work in one round for the least cost.

**Architecture:** Three neutral tiers (`deep`, `standard`, `light`) are bound to real model identifiers by an operator-owned map in the plugin's state directory. The launcher script resolves a `--tier` through that map and types no model argument when nothing is bound; a new `model-routing` skill carries the routing table and the escalation rules, and the briefs carry the tier down to each agent.

**Tech Stack:** bash 3.2, `jq`, AppleScript through `osascript` (untouched by this plan), Markdown skills and templates, the repository's own `tests/run-tests.sh` harness.

**Spec:** `docs/superpowers/specs/2026-09-08-model-routing-design.md`

## Global Constraints

Copied from `CLAUDE.md`; every task's requirements include them.

- **English only, everywhere**: code, comments, identifiers, output strings, documentation, commit messages, branch names, PR text. No exceptions.
- **No vendor or product name in prose.** The runtime is "the host"; its sessions are "sessions" or "agents". Model names in examples are placeholders: use `a-model`, never a real one.
- **Load-bearing identifiers are exempt**: `~/.claude/`, `.claude-plugin/`, `CLAUDE_CONFIG_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_CODE_SESSION_ID`, `claude-orchestrator`, and the host tool names a skill cites verbatim (`ListAgents`, `SendMessage`).
- **Commits**: no co-author trailer, no generated-with attribution, no tool name anywhere in the message. Subject in the imperative, body explaining *why*.
- **Before pushing**: `./tests/run-tests.sh` passes; `grep -rniI 'claude' . --exclude-dir=.git` returns only exempt occurrences; no accented character or French word outside `docs/`.
- Anything newly introduced gets a neutral name (`ORCHESTRATOR_*`, `CONFIG_DIR`). Never coin an identifier carrying the brand.
- Tests are bash, no network, no terminal automation, isolated `HOME` or state directory per case.

---

### Task 1: Tier resolution in the launcher

The pure, testable core: a tier name in, the operator's bound identifier out. Nothing else in the plan works until this does.

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm-agent.sh` (globals near line 59, a new `resolve_tier` function, a new `resolve-tier` subcommand in the dispatch `case` at the end of the file, and the usage header at lines 6-17 and 48-53)
- Test: `tests/run-tests.sh` (a new `== model tiers ==` section, inserted after the `== iterm-agents spawn (dry run) ==` section and before `echo "== context gate hook =="`)

**Interfaces:**
- Consumes: nothing.
- Produces: shell function `resolve_tier <tier>` → prints the bound identifier on stdout with a trailing newline, prints nothing when the tier is known but unbound, exits 1 through `die` when the tier is not one of `deep|standard|light`. Subcommand `iterm-agent.sh resolve-tier <tier>` with the same contract. Global `MODELS_MAP`, overridable with `ORCHESTRATOR_MODELS_MAP`.

- [ ] **Step 1: Write the failing tests**

Insert this section into `tests/run-tests.sh`, immediately before the line `echo "== context gate hook =="`. `$AGENT` and `$WORK` are already defined by the spawn section above it.

```bash
echo "== model tiers =="

# The plugin binds capability tiers, never model names. `a-model` is the repository's
# placeholder for an identifier only the operator knows.
MAP="$WORK/models.json"
printf '{"deep":"a-model","standard":"b-model","light":""}\n' > "$MAP"

check "a bound tier resolves to its identifier" "a-model" \
  "$(env ORCHESTRATOR_MODELS_MAP="$MAP" bash "$AGENT" resolve-tier deep)"
check "an unbound tier resolves to nothing" "" \
  "$(env ORCHESTRATOR_MODELS_MAP="$MAP" bash "$AGENT" resolve-tier light)"
check_status "an unbound tier is not an error" 0 \
  env ORCHESTRATOR_MODELS_MAP="$MAP" bash "$AGENT" resolve-tier light
check_status "an unknown tier exits 1" 1 \
  env ORCHESTRATOR_MODELS_MAP="$MAP" bash "$AGENT" resolve-tier deepest
check "the environment overrides the map" "c-model" \
  "$(env ORCHESTRATOR_MODELS_MAP="$MAP" ORCHESTRATOR_TIER_DEEP=c-model bash "$AGENT" resolve-tier deep)"
check "a missing map is an all-empty map" "" \
  "$(env ORCHESTRATOR_MODELS_MAP="$WORK/absent.json" bash "$AGENT" resolve-tier standard)"
check_status "a missing map is not an error" 0 \
  env ORCHESTRATOR_MODELS_MAP="$WORK/absent.json" bash "$AGENT" resolve-tier standard
check "resolve-tier wants exactly one tier" "ERROR: resolve-tier: exactly one tier is required (deep, standard or light)" \
  "$(bash "$AGENT" resolve-tier 2>&1)"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./tests/run-tests.sh 2>&1 | grep -A3 'model tiers'`
Expected: FAIL on every new check — the first ones with `ERROR: usage: iterm-agent.sh {list|spawn|verify|close|move|rotate} …` as actual, because `resolve-tier` is not a subcommand yet.

- [ ] **Step 3: Add the map global**

In `skills/iterm-agents/scripts/iterm-agent.sh`, after the `PROMPTS_DIR` line (near line 61):

```bash
# The operator's tier map. The plugin ships no model identifier: `deep`, `standard`
# and `light` name capability, and only this file says what each one runs on.
MODELS_MAP="${ORCHESTRATOR_MODELS_MAP:-$STATE_DIR/models.json}"
```

- [ ] **Step 4: Add the resolver**

Add after the `die()` helper (near line 65):

```bash
resolve_tier() {
    # A tier in, the identifier the operator bound to it out. An unbound tier prints
    # nothing and succeeds: the caller reads that as "let the host choose", which is a
    # better answer than a name this plugin has no business carrying.
    local tier="${1:-}" var value=""
    case "$tier" in
        deep|standard|light) ;;
        *) die "resolve-tier: unknown tier: $tier (expected deep, standard or light)" ;;
    esac
    # An environment override wins over the file, so one run can be routed differently
    # without editing a map every other session reads.
    var="ORCHESTRATOR_TIER_$(printf '%s' "$tier" | tr '[:lower:]' '[:upper:]')"
    eval "value=\${$var:-}"
    if [ -z "$value" ] && [ -f "$MODELS_MAP" ]; then
        command -v jq >/dev/null 2>&1 || die "resolve-tier: jq is required to read $MODELS_MAP"
        value=$(jq -r --arg t "$tier" '.[$t] // ""' "$MODELS_MAP" 2>/dev/null || true)
        [ "$value" = "null" ] && value=""
    fi
    printf '%s\n' "$value"
}

cmd_resolve_tier() {
    [ $# -eq 1 ] || die "resolve-tier: exactly one tier is required (deep, standard or light)"
    resolve_tier "$1"
}
```

- [ ] **Step 5: Wire the subcommand**

In the dispatch `case` at the end of the file, add the line after `prompt-state`:

```bash
    resolve-tier) shift; cmd_resolve_tier "$@" ;;
```

and change the usage line to:

```bash
    *) die "usage: iterm-agent.sh {list|spawn|verify|resolve-tier|close|move|rotate} [options] (see header)" ;;
```

- [ ] **Step 6: Document it in the script header**

In the `# Usage:` block (near line 13) add, after the `prompt-state` line:

```bash
#   iterm-agent.sh resolve-tier <deep|standard|light>   (prints the operator's bound identifier, empty when unbound)
```

and in the `# Environment:` block (near line 53):

```bash
#   ORCHESTRATOR_MODELS_MAP      the tier map to read (default: <state dir>/models.json)
#   ORCHESTRATOR_TIER_DEEP       override the map's binding for one run
#   ORCHESTRATOR_TIER_STANDARD   idem
#   ORCHESTRATOR_TIER_LIGHT      idem
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `./tests/run-tests.sh`
Expected: PASS, with 8 more checks than the 90 the suite reports today.

- [ ] **Step 8: Commit**

```bash
git add skills/iterm-agents/scripts/iterm-agent.sh tests/run-tests.sh
git commit -m "Resolve a capability tier through the operator's own map

A dispatch has to name what it needs — judgment, or a run a test suite
judges — without this plugin naming any model. The tier does that, and
the binding lives with the operator: an unbound tier resolves to nothing
and the host applies its default, which beats a guess made here."
```

---

### Task 2: Route spawn and rotate through the tier, and drop the hardcoded identifier

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm-agent.sh` (`cmd_spawn` argument parser and command builder, lines 227-260; `cmd_rotate` parser and forwarding, lines 473-496; usage header lines 8-17)
- Modify: `skills/iterm-agents/SKILL.md` (quick reference lines 20-41, a new caveat)
- Test: `tests/run-tests.sh` (the `== repository policy ==` section near line 44, the spawn assertion at line 114, and the `== model tiers ==` section from Task 1)

**Interfaces:**
- Consumes: `resolve_tier <tier>` from Task 1.
- Produces: `spawn --tier <deep|standard|light>` and `rotate --tier <…>`, mutually exclusive with `--model <id>`; a typed shell command that carries `--model <id>` only when one is known.

- [ ] **Step 1: Write the failing tests**

In `tests/run-tests.sh`, in the `== repository policy ==` section, after the `check "no product name in prose"` line, add:

```bash
# The tiers exist so no model family name has to appear here. The grep above looks for
# the host's name only, and would never have caught the identifier the launcher carried.
# `run-tests.sh` and the plan document are excluded because they QUOTE this very
# deny-list; everything else in the repository is held to it.
hits=$(grep -rniIE '\b(opus|sonnet|haiku)\b' "$ROOT" --exclude-dir=.git --exclude-dir=plans \
  --exclude=plan.md --exclude=CLAUDE.md --exclude=run-tests.sh || true)
check "no model family name in the plugin" "" "$hits"
```

Replace the assertion at line 114 — `check "the typed command carries the model" "1" "$(printf '%s' "$cmd" | grep -c -- '--model opus')"` — with:

```bash
check "no tier and no map types no model argument" "0" "$(printf '%s' "$cmd" | grep -c -- '--model')"
```

Append to the `== model tiers ==` section:

```bash
tcmd() {
  local out
  out=$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
    bash "$AGENT" spawn --dir "$WORK" "$@" 2>&1)
  out=${out#*shellcmd=}; printf '%s' "${out%%$'\n'*}"
}
check "a bound tier is typed as the model argument" "1" "$(tcmd --tier deep | grep -c -- '--model a-model')"
check "an unbound tier types no model argument" "0" "$(tcmd --tier light | grep -c -- '--model')"
check "an explicit model is typed as given" "1" "$(tcmd --model b-model | grep -c -- '--model b-model')"
check_status "--tier and --model together are refused" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
  bash "$AGENT" spawn --dir "$WORK" --tier deep --model b-model
check_status "an unknown tier is refused at spawn" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
  bash "$AGENT" spawn --dir "$WORK" --tier deepest
# rotate performs a real close, so its forwarding is checked on the source, as the
# suite already checks that rotate inherits the spawn's verification.
check "rotate forwards the tier to the spawn" "1" \
  "$(grep -c '\${tier:+--tier "\$tier"}' "$AGENT")"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./tests/run-tests.sh`
Expected: FAIL on `no model family name in the plugin` (the launcher still carries it twice), on `no tier and no map types no model argument` (it types one), and on every new tier-spawn check (`spawn: unknown option --tier`).

- [ ] **Step 3: Parse the tier in `cmd_spawn`**

In `cmd_spawn`, change the locals line so no identifier is defaulted:

```bash
    local dir="" model="" tier="" mode="auto" title="agent" prompt="" prompt_file="" left_of="" right_of="" verify=1
```

Add the option, next to `--model`:

```bash
            --tier) tier="$2"; shift 2 ;;
```

After the existing `--prompt`/`--prompt-file` exclusivity check, add:

```bash
    [ -z "$tier" ] || [ -z "$model" ] || die "spawn: --tier and --model are mutually exclusive"
    [ -z "$tier" ] || model=$(resolve_tier "$tier")
```

- [ ] **Step 4: Build the command without a model when none is known**

Replace the single `shellcmd=` assignment (line 259) with:

```bash
    local shellcmd="cd $(printf '%q' "$dir") && printf '\\033]0;%s\\007' $(printf '%q' "$title") && $HOST_CLI"
    # No model argument at all when neither a tier nor an explicit identifier says which:
    # the host's own default is the right answer, and a name hardcoded here would be a
    # routing decision taken by the plugin for every operator.
    if [ -n "$model" ]; then
        shellcmd="$shellcmd --model $(printf '%q' "$model")"
    fi
    shellcmd="$shellcmd --permission-mode $(printf '%q' "$mode") --settings $(printf '%q' "$settings")"
```

- [ ] **Step 5: Forward the tier through `cmd_rotate`**

In `cmd_rotate`, change the locals line to:

```bash
    local dir="" model="" tier="" mode="auto" title="agent" prompt="" prompt_file="" old_tty="" expect_title="" left_of="" right_of=""
```

Add the option next to `--model`:

```bash
            --tier) tier="$2"; shift 2 ;;
```

and change the spawn call so neither empty value is passed as a flag:

```bash
    new_tty=$(cmd_spawn --dir "$dir" --permission-mode "$mode" --title "$title" \
        ${tier:+--tier "$tier"} ${model:+--model "$model"} \
        ${prompt:+--prompt "$prompt"} ${prompt_file:+--prompt-file "$prompt_file"} ${left_of:+--left-of "$left_of"} ${right_of:+--right-of "$right_of"})
```

- [ ] **Step 6: Update the script's usage header**

In the `# Usage:` block, replace `[--model opus]` with `[--tier deep|standard|light | --model <id>]` in both the `spawn` and the `rotate` line. Add to the `# Safety model:` block:

```bash
#   - `spawn` types a model argument only when one is known: a tier the operator has
#     bound, or an explicit `--model`. With neither, the host applies its own default
#     rather than a name this plugin would be choosing for everyone.
```

- [ ] **Step 7: Update the iterm-agents skill**

In `skills/iterm-agents/SKILL.md`, in the quick reference, replace `[--model opus]` with `[--tier deep|standard|light]` on the `spawn` line and `[--model <model>]` with `[--tier <tier>]` on the `rotate` line, and add under the `spawn` block:

```
    # --tier resolves through the operator's map (<state dir>/models.json, or
    # ORCHESTRATOR_TIER_DEEP/_STANDARD/_LIGHT). An unbound tier and no --tier at all both
    # type no model argument: the host chooses. `resolve-tier <tier>` prints the binding.
```

Add to **Caveats**:

```
- **A tier nobody bound is not an error.** `spawn` then types no model argument and the host
  applies its default, so a half-filled map never silently routes deep work to a cheap model —
  it routes it to whatever the operator's host already runs. Read the map with `resolve-tier`
  before dispatching a wave, not after it comes back wrong.
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `./tests/run-tests.sh`
Expected: PASS, all checks green including `no model family name in the plugin`.

- [ ] **Step 9: Commit**

```bash
git add skills/iterm-agents/scripts/iterm-agent.sh skills/iterm-agents/SKILL.md tests/run-tests.sh
git commit -m "Type a model argument only when one is known

The launcher hardcoded an identifier, so every session it spawned ran at
one tier whatever the work was, and the name sat in a plugin whose rules
forbid it — where the policy grep, looking only for the host's name,
could never find it. A tier resolves through the operator's map; with
nothing bound, the host's own default applies."
```

---

### Task 3: Create the tier map at install time

**Files:**
- Modify: `install.sh` (state-directory section, after the `mkdir -p '$STATE_DIR/ctx'` line near line 49)
- Modify: `uninstall.sh` (the state-directory removal near line 46, message only)
- Test: `tests/run-tests.sh` (`== install ==` section, after the `tap copied and executable` check near line 268)

**Interfaces:**
- Consumes: the `MODELS_MAP` path convention from Task 1 (`<state dir>/models.json`).
- Produces: a `models.json` holding `{"deep": "", "standard": "", "light": ""}` on a fresh install, preserved verbatim on every later run.

- [ ] **Step 1: Write the failing tests**

In `tests/run-tests.sh`, insert after `check "tap copied and executable" …`:

```bash
check "tier map created with three empty bindings" '{"deep":"","standard":"","light":""}' \
  "$(jq -c . "$H/.claude/claude-orchestrator/models.json")"
printf '{"deep":"a-model","standard":"","light":""}\n' > "$H/.claude/claude-orchestrator/models.json"
env HOME="$H" bash "$ROOT/install.sh" >/dev/null 2>&1
check "an existing tier map is never overwritten" "a-model" \
  "$(jq -r .deep "$H/.claude/claude-orchestrator/models.json")"
```

And in the dry-run block near line 290, after `check "dry-run creates no state directory" …`:

```bash
check "dry-run writes no tier map" "none" \
  "$([ -f "$H3/.claude/claude-orchestrator/models.json" ] && echo written || echo none)"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./tests/run-tests.sh 2>&1 | grep -B1 -A3 'tier map'`
Expected: FAIL on `tier map created with three empty bindings`, actual empty (no such file, `jq` reads nothing).

- [ ] **Step 3: Create the map in the installer**

In `install.sh`, after the `run "mkdir -p '$STATE_DIR/ctx'"` line, add:

```bash
# The tier map: three capability tiers, bound by the operator to identifiers this
# plugin must not name. An empty binding means "let the host choose", so a fresh
# install routes exactly as it did before anything is written here.
MODELS_MAP="$STATE_DIR/models.json"
if [ "$DRY" = "1" ]; then
  say "[dry-run] tier map created: $MODELS_MAP"
elif [ -f "$MODELS_MAP" ]; then
  say "tier map already present: $MODELS_MAP"
else
  printf '{"deep": "", "standard": "", "light": ""}\n' > "$MODELS_MAP"
  say "tier map created: $MODELS_MAP"
fi
say "bind deep, standard and light there to the identifiers this host accepts;"
say "an unbound tier leaves the choice to the host."
```

- [ ] **Step 4: Name the map in the uninstaller's message**

In `uninstall.sh`, change the removal message so the operator knows the bindings go with it:

```bash
  else rm -rf "$STATE_DIR"; say "removed $STATE_DIR (tap, context files, prompts, tier map)"; fi
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `./tests/run-tests.sh`
Expected: PASS, all checks green.

- [ ] **Step 6: Commit**

```bash
git add install.sh uninstall.sh tests/run-tests.sh
git commit -m "Create the tier map where the operator will find it

A map nobody is told about is a map nobody fills, and an unfilled map
routes every dispatch to the host's default — which is safe, and silent.
The installer writes the three keys and says what they are for; an
existing map is never touched, because the bindings are the operator's."
```

---

### Task 4: The routing method as a skill

**Files:**
- Create: `skills/model-routing/SKILL.md`
- Modify: `skills/orchestrator/SKILL.md` (a gate paragraph in "Context rotation" territory, one rationalization row, one red flag)
- Test: `tests/run-tests.sh` (policy section — the new skill is prose and must stay clean)

**Interfaces:**
- Consumes: the tier vocabulary and the `resolve-tier` subcommand from Tasks 1-2.
- Produces: the skill `orchestrator:model-routing`, referenced by name from the orchestrator skill and from the briefs of Task 5.

- [ ] **Step 1: Write the skill**

Create `skills/model-routing/SKILL.md` with exactly this content:

````markdown
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
- **Unreadable figures**: say so and route on the table alone. A gate that cannot measure does not hold a run.

Pressure modifies one dispatch. It never rewrites the table.

## The record

One line per dispatch in the project's build state: class, tier, rounds to close, verdict. That record is what corrects the table for this build, and your succession brief points at it. The default table ships here; a project's corrections belong to that project, where status lives once.

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
- A tier chosen from how hard the phase feels rather than from the five readings.
- A second corrective round on a class you dropped, and the drop still standing.
- An escalation attempted inside a live session instead of as a rotation.
- Budget pressure applied to yourself, to a contract-defining phase or to the final verification.
- A wave dispatched without reading the map, then reported as routed.
````

- [ ] **Step 2: Add the dispatch gate to the orchestrator skill**

In `skills/orchestrator/SKILL.md`, immediately before the `## Context rotation` heading, insert:

```markdown
## Every dispatch names its tier

At the dispatch gate you read two figures and choose one thing: the context (below) and the budget (`five_hour_percent`, `seven_day_percent`), then the capability tier the work needs. The method is `orchestrator:model-routing` — the table by class of work, the five readings for a phase that does not sit on a row, escalation as a rotation, and the false-economy rule that reverts a drop which cost a second round. The rule it all rests on: **pay for judgment that nothing downstream re-checks**. Your own sequencing, the contracts a phase imposes on the next, and the final verification are re-read by nobody; a conversion phase is judged by the suite. The tier and the reading that chose it go into the brief, so the agent can tell you when the work outgrew them.
```

- [ ] **Step 3: Add the rationalization row**

In the `## Rationalizations` table of `skills/orchestrator/SKILL.md`, add before the last row:

```markdown
| "The top tier everywhere is the safe choice" | It is the choice that spends the review budget on work a test suite already judges. Route by what re-reads the output; keep the top tier for what nobody re-reads. |
```

- [ ] **Step 4: Add the red flag**

In `## Red flags: STOP`, add:

```markdown
- A brief written without the tier it runs at and the reading that chose it; a wave dispatched without reading the tier map.
```

- [ ] **Step 5: Run the tests**

Run: `./tests/run-tests.sh`
Expected: PASS — in particular `no product name in prose`, `no model family name in the plugin` and `nothing project- or machine-specific in the plugin` over the new skill.

- [ ] **Step 6: Commit**

```bash
git add skills/model-routing/SKILL.md skills/orchestrator/SKILL.md
git commit -m "Route a dispatch by what re-reads its output

Choosing a tier by how hard a phase feels spends the top tier on work a
test suite already judges, and spends nothing on the contracts every
later phase pays for. What re-reads the output is the reading that
decides, and the drop that costs a second round is reverted for its
class — without that rule every economy looks free at the moment it is
taken and lands two rounds later, unattributed."
```

---

### Task 5: Carry the tier down to the briefs and the commands

**Files:**
- Modify: `templates/agent-phase-brief.md` (§6 Communication)
- Modify: `templates/agent-rotation-brief.md` (new §5, existing §5 renumbered to §6)
- Modify: `templates/agent-review-brief.md` (§3 Lenses)
- Modify: `templates/orchestrator-succession-brief.md` (pointer list)
- Modify: `commands/status.md` (steps 3-4 and the allowed-tools line)
- Modify: `commands/succeed.md` (step 2)
- Test: `tests/run-tests.sh` (policy section, unchanged assertions must still pass over the new text)

**Interfaces:**
- Consumes: the tier vocabulary and `orchestrator:model-routing` from Task 4; `--tier` from Task 2.
- Produces: the placeholders `{{TIER}}`, `{{TIER_REASON}}`, `{{TIER_ESCALATION}}`, `{{LENS_TIER}}` and `{{DISPATCH_RECORD}}`, which the orchestrator fills when it instantiates a brief.

- [ ] **Step 1: Add the tier and the escalation signal to the phase brief**

In `templates/agent-phase-brief.md`, in `## 6. Communication`, after the measured-context bullet, add:

```markdown
- You run at the **{{TIER}}** tier, chosen because {{TIER_REASON}}. If the work proves to need more judgment than this brief anticipated — a contract you would have to invent, an ambiguity two STOPs did not close — say so with the evidence and stop. The orchestrator escalates by replacing you with a fresh session one tier up; it cannot see from outside that the work outgrew the brief.
```

- [ ] **Step 2: Add the tier section to the rotation brief**

In `templates/agent-rotation-brief.md`, insert a new section between `## 4. Decisions already taken — NOT reopenable` and `## 5. Protocol`:

```markdown
## 5. Tier

You run at the **{{TIER}}** tier. {{TIER_ESCALATION}}

When this rotation is an escalation, that line names what triggered it: the finding that survived the previous round, the ambiguity two STOPs did not close, or the gate crossed without a push. Read it as scope, not as a verdict on the session you replace — and do not repeat the round it failed.
```

Then renumber the existing `## 5. Protocol` heading to `## 6. Protocol`.

- [ ] **Step 3: Name the lenses' tier in the review brief**

In `templates/agent-review-brief.md`, in `## 3. Lenses`, change the dispatch sentence to:

```markdown
Dispatch one read-only sub-agent per lens at the **{{LENS_TIER}}** tier, each with the diff range `{{BASE_BRANCH}}..{{HEAD}}`, the spec section and the norms file, and the instruction to report findings only with file, line and evidence:
```

- [ ] **Step 4: Point the successor at the dispatch record**

In `templates/orchestrator-succession-brief.md`, add to the pointer list:

```markdown
- Dispatch record (class, tier, rounds to close, verdict — the table's corrections for this build): `{{DISPATCH_RECORD}}`. Read it before routing anything: a tier dropped and reverted here is a decision, not a preference.
```

- [ ] **Step 5: Show the budget and the pressure in `status`**

In `commands/status.md`, change step 3 to:

```markdown
3. Run `${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh`
   for this session and keep its `context_percent=`, `five_hour_percent=`,
   `seven_day_percent=` and `source=` lines.
```

and add a step after the present step 4:

```markdown
5. Print the routing pressure under the table, from the two quota figures:
   none below 70 % on both; « one tier down, except the orchestrator, the
   contract-defining phases and the final verification » at or above 70 % on
   either; « no new dispatch, finish what is in flight » at or above 90 %.
   Say « unmeasured » when neither figure can be read — a pressure nobody
   measured never holds a dispatch. The rule is `orchestrator:model-routing`.
```

- [ ] **Step 6: Spawn the successor at the deep tier**

In `commands/succeed.md`, step 2, replace `--model <model>` with `--tier deep`, and add after that step's sentence:

```markdown
   The successor runs at the `deep` tier: its output — the sequencing, the verdicts,
   the arbitrations it relays — is re-read by nobody. See `orchestrator:model-routing`.
```

- [ ] **Step 7: Run the tests**

Run: `./tests/run-tests.sh`
Expected: PASS. The policy checks read every modified file; no model name, no product name, no French.

- [ ] **Step 8: Commit**

```bash
git add templates commands
git commit -m "Tell each session the tier it runs at, and why

An agent cannot report that the work outgrew its brief unless it knows
what the brief assumed, and the orchestrator cannot see it from outside:
the signal only exists if the tier and the reading that chose it travel
with the scope. The successor inherits the record of what was dropped
and reverted, because that is a decision, not a preference."
```

---

### Task 6: Documentation and release

**Files:**
- Modify: `docs/design.md` (a new section 10, before the current trailing `decide` paragraph)
- Modify: `README.md` (the "What you get" table and the Requirements section)
- Modify: `.claude-plugin/plugin.json` (version)
- Test: `tests/run-tests.sh` (full suite)

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the design section**

In `docs/design.md`, insert before the final paragraph beginning `**decide** (0.4.2)`:

```markdown
## 10. Model routing

**0.6.0.** Every session the orchestrator dispatched ran at whatever the launcher
hardcoded, which put a model identifier in a plugin whose rules forbid one and paid the
top tier for work a test suite already judges.

The rule is « pay for judgment that nothing downstream re-checks »: a conversion phase is
judged by the suite, a findings list by the orchestrator, so both run cheap; the
contracts a phase imposes on the next, the final verification and the orchestrator's own
sequencing are re-read by nobody, so they do not. Three tiers name capability — `deep`,
`standard`, `light` — and the binding to real identifiers lives in the operator's
`<state dir>/models.json`, overridable per run by `ORCHESTRATOR_TIER_DEEP` and its two
siblings. `iterm-agent.sh resolve-tier <tier>` prints a binding; `spawn --tier` and
`rotate --tier` apply one, and with nothing bound the launcher types no model argument at
all so the host applies its own default. That is the behaviour change behind the minor
version: an existing installation routes to the host default until the map is filled.

`skills/model-routing/SKILL.md` carries the table by class of work, the five readings for
a phase that does not sit on a row, escalation as a rotation (a model does not change
inside a live session), the false-economy rule that reverts a drop which cost a second
round, and budget pressure read from the gauge's quota figures rather than estimated. The
briefs carry the tier down to each session, because an agent can only report that the
work outgrew its brief if it knows what the brief assumed.

Design: `docs/superpowers/specs/2026-09-08-model-routing-design.md`.
```

- [ ] **Step 2: Add the skill to the README table**

In `README.md`, in the "What you get" table, add after the `context-gauge` row:

```markdown
| skill `model-routing` | Which capability tier a dispatch gets: pay for judgment nothing downstream re-checks. A table by class of work, five readings for the cases off the table, escalation as a rotation, the false-economy rule, and budget pressure read from the quota figures. |
```

and add to the Requirements section:

```markdown
- for `model-routing`: bind `deep`, `standard` and `light` in
  `~/.claude/claude-orchestrator/models.json` (the installer creates it empty) to the
  model identifiers your host accepts. Unbound tiers leave the choice to the host.
```

- [ ] **Step 3: Bump the version**

In `.claude-plugin/plugin.json`, set `"version": "0.6.0"`, and add `"model-routing"` to the `keywords` array.

- [ ] **Step 4: Run the full suite and the policy greps by hand**

```bash
./tests/run-tests.sh
grep -rniI 'claude' . --exclude-dir=.git --exclude=CLAUDE.md --exclude=plan.md \
  | grep -viE '~/\.claude/|\$HOME/\.claude|CLAUDE_CONFIG_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_CODE_SESSION_ID|ORCHESTRATOR_HOST_CLI:-claude|claude-orchestrator|\.claude-plugin|/\.claude/'
LC_ALL=en_US.UTF-8 grep -rnI '[àâäéèêëîïôöùûüç]' . \
  --exclude-dir=.git --exclude-dir=docs --exclude=CLAUDE.md --exclude=run-tests.sh
```

Expected: the suite passes; the `claude` grep prints nothing. The accent grep prints exactly
one known line — `skills/iterm-agents/SKILL.md:86`, which documents on purpose the byte a
test feeds the script under a C locale. Any other line is something this plan introduced,
and it is a defect: `grep -P` does not exist on the platform this runs on, which is why the
class is spelled out and the locale is forced.

- [ ] **Step 5: Commit**

```bash
git add docs/design.md README.md .claude-plugin/plugin.json
git commit -m "Record the routing decision and release it

The launcher's default changes for every existing installation — with no
tier bound, the host chooses instead of the plugin — so the design says
what replaced it and the readme says what to bind before the change is
felt as a regression."
```

---

## Verification

After Task 6, the whole plan is verified by one run and three readings:

1. `./tests/run-tests.sh` — every check green, roughly 105 of them.
2. `ORCHESTRATOR_DRY_RUN=1 skills/iterm-agents/scripts/iterm-agent.sh spawn --dir . --tier deep` on a machine whose map binds `deep` — the printed `shellcmd=` carries that identifier and nothing else changed.
3. The same command with an empty map — the printed `shellcmd=` carries no `--model` at all.
4. `grep -rniIE '\b(opus|sonnet|haiku)\b' . --exclude-dir=.git --exclude-dir=plans --exclude=run-tests.sh` — nothing. The two exclusions are the files that quote the deny-list itself; if you move that grep anywhere else, it must carry them.
