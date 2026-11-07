# Model routing calibration — implementation plan

> Implementers are separate sessions the orchestrator spawns, one brief per phase. Do not
> run this plan in an in-process subagent. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the model/effort pair the unit of dispatch, measure every dispatch's cost,
and calibrate the cheapest pair that satisfies each class of work — offline on replayed
merged pull requests, online from the dispatch record — per project, then per profile.

**Architecture:** One stdlib Python script, `skills/model-routing/scripts/routing.py`,
carries every new mechanism behind subcommands (`cost`, `profile`, `pick`, `calibrate`,
`harvest`, `ready`, `bench`, `generalize`, `show`, `export`). The launcher
(`iterm_agent.py`) learns `--effort` and object bindings in the tier map;
`dispatch-record.sh` learns pairs, costs and exploration signals. Measured data lives in
`<state dir>/routing/`; only name-free tier/effort defaults ship in
`skills/model-routing/defaults/`.

**Tech Stack:** Python 3 standard library, bash, `jq`, `git`; the host's headless mode
(`-p --output-format json`) for the bench; the forge CLI (`gh`) for `harvest`.

**Spec:** `docs/specs/2026-10-09-model-routing-calibration-design.md` — the plan argues
from it; implementers read both.

## Global Constraints

- English only, everywhere: code, comments, output strings, commit messages, branch names.
- No vendor, product or model family name in any file outside `docs/plans/`; model names in
  tests and examples are placeholders (`a-model`, `b-model`, `c-model`). Load-bearing
  identifiers are exempt: `~/.claude/`, `CLAUDE_CONFIG_DIR`, `CLAUDE_PLUGIN_ROOT`,
  `CLAUDE_CODE_SESSION_ID`, `claude-orchestrator`, `ORCHESTRATOR_HOST_CLI` (a line carrying
  the host binary's default must also carry `ORCHESTRATOR_HOST_CLI`, as `iterm_agent.py:51`
  does).
- No absolute home path, no real session id, nothing machine- or project-specific in the
  plugin.
- `./tests/run-tests.sh` passes after every task, its own exit code read (never through a
  pipe ending in `tail`).
- Conventional commits, imperative subject, body explains why; no co-author trailer, no tool
  attribution.
- A multi-line block comment closes with its delimiter alone on its line (Python docstrings
  that span lines end with `"""` on its own line).
- Efforts are exactly `low`, `medium`, `high`, `xhigh`, `max`. Tiers are exactly `deep`,
  `standard`, `light`.
- Nothing the bench or the tests run may reach the network or spend: every test points
  `ORCHESTRATOR_HOST_CLI` and `ORCHESTRATOR_GH` at stubs.
- The budget is the operator's: no code reads the subscription gauge to stop, throttle or
  choose; the only stop is the `--max-usd` the caller passes.

## Review Focus

1. **Duplicated usage lines in a transcript** — the host writes one line per content block,
   each repeating the message's usage; summing lines double-counts. Pinned in Task 1 step 1
   (fixture with a message split over two lines).
2. **A bench agent reaching the merged commit** — the trial tree must hold no history; an
   agent running `git log --all` or `git cat-file` on the merged sha must find nothing.
   Pinned in Task 8 step 1.
3. **A record written before this change** (rows with no `model`, `effort`, `cost_usd`) —
   every reader treats the absent fields as absent, and the summary lines of tier rows stay
   byte-identical. Pinned in Task 3 step 1 (the existing summary assertions run unchanged).
4. **A bench run interrupted and restarted** — trials already in `trials.jsonl` count, so a
   restart never re-pays a trial. Pinned in Task 9 step 1.
5. **A judge whose output is not JSON** — the trial is recorded `error` with its cost, never
   counted as a pass or a fail. Pinned in Task 8 step 1.

---

## Phase 1 — Foundation (one pull request)

### Task 1: `routing.py cost` — the measured cost of a session

**Files:**
- Create: `skills/model-routing/scripts/routing.py`
- Create: `tests/fixtures/routing/prices.json`
- Create: `tests/fixtures/routing/projects/-repo/s-1.jsonl`
- Create: `tests/fixtures/routing/projects/-repo/s-1/subagents/agent-x.jsonl`
- Modify: `tests/run-tests.sh` (new section `== routing: cost ==` before the final tally)

**Interfaces:**
- Produces: `routing.py cost <transcript>|--session <id> [--alias <alias>] [--json]`.
  Plain output: one line `cost_usd=<x.xxxxxx> models=<id>[,<id>] tokens_in=<n>
  tokens_out=<n> cache_read=<n> cache_write=<n>`; `cost_usd=unknown` when a model has no
  price (stderr names it), exit 0. `--json` prints
  `{"cost_usd": float|null, "models": {"<id>": float|null}, "tokens_in": n, "tokens_out": n,
  "cache_read": n, "cache_write": n}`. `--alias` records the resolved identifier in
  `aliases.json`.
- Produces (module functions later tasks import by running the script, never by import):
  `STATE_DIR`, `ROUTING_DIR`, `EFFORTS`, `TIERS`, `parse_pair(text) -> (model, effort)`,
  `read_json(path, default)`, `write_json(path, data)`, `note_alias(alias, models)`.

- [ ] **Step 1: Write the fixtures and the failing tests**

`tests/fixtures/routing/prices.json`:

```json
{
  "a-model-1": {"input": 4.0, "output": 20.0, "cache_write_5m": 5.0, "cache_write_1h": 8.0, "cache_read": 0.2},
  "c-model-1": {"input": 0.1, "output": 0.5, "cache_write_5m": 0.125, "cache_write_1h": 0.2, "cache_read": 0.01,
                "above": {"tokens": 100000, "input": 0.5, "output": 2.5, "cache_write_5m": 0.625, "cache_write_1h": 1.0, "cache_read": 0.05}}
}
```

`tests/fixtures/routing/projects/-repo/s-1.jsonl` (message `m1` is split over two lines that
repeat its usage — it must count once):

```
{"type":"user","message":{"role":"user","content":"go"}}
{"type":"assistant","message":{"id":"m1","model":"a-model-1","usage":{"input_tokens":1000,"output_tokens":2000,"cache_read_input_tokens":10000,"cache_creation_input_tokens":3000,"cache_creation":{"ephemeral_5m_input_tokens":1000,"ephemeral_1h_input_tokens":2000}}}}
{"type":"assistant","message":{"id":"m1","model":"a-model-1","usage":{"input_tokens":1000,"output_tokens":2000,"cache_read_input_tokens":10000,"cache_creation_input_tokens":3000,"cache_creation":{"ephemeral_5m_input_tokens":1000,"ephemeral_1h_input_tokens":2000}}}}
{"type":"assistant","message":{"id":"m2","model":"c-model-1","usage":{"input_tokens":200000,"output_tokens":1000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
```

`tests/fixtures/routing/projects/-repo/s-1/subagents/agent-x.jsonl`:

```
{"type":"assistant","message":{"id":"m3","model":"c-model-1","usage":{"input_tokens":1000,"output_tokens":1000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
```

Expected cost, by hand: `m1` = (1000×4 + 2000×20 + 10000×0.2 + 1000×5 + 2000×8)/1e6 =
0.067000; `m2` (prompt 200000 > 100000, upper rate) = (200000×0.5 + 1000×2.5)/1e6 =
0.102500; `m3` = (1000×0.1 + 1000×0.5)/1e6 = 0.000600. Total 0.170100.

Append to `tests/run-tests.sh`, before the final tally:

```bash
echo "== routing: cost =="

ROUTING="$ROOT/skills/model-routing/scripts/routing.py"
RFIX="$ROOT/tests/fixtures/routing"
RSTATE="$WORK/rstate"; mkdir -p "$RSTATE/routing"
cp "$RFIX/prices.json" "$RSTATE/routing/prices.json"
rcost() { ORCHESTRATOR_STATE_DIR="$RSTATE" ORCHESTRATOR_PROJECTS_DIR="$RFIX/projects" python3 "$ROUTING" cost "$@"; }

check "cost of a session: one usage per message id, subagents included, tiered price applied" \
  "cost_usd=0.170100 models=a-model-1,c-model-1 tokens_in=202000 tokens_out=4000 cache_read=10000 cache_write=3000" \
  "$(rcost --session s-1)"
check "cost of one transcript file, by path" "0.1695" \
  "$(rcost "$RFIX/projects/-repo/s-1.jsonl" --json | jq -r '.cost_usd|.*10000|round/10000')"
rm "$RSTATE/routing/prices.json"
check "no price file: the cost is unknown, never guessed" "cost_usd=unknown" \
  "$(rcost --session s-1 2>/dev/null | cut -d' ' -f1)"
check "no price file: stderr names the model" "1" \
  "$(rcost --session s-1 2>&1 >/dev/null | grep -c 'no price for a-model-1')"
cp "$RFIX/prices.json" "$RSTATE/routing/prices.json"
check_status "an unknown session is a refusal" 1 rcost --session s-404
rcost --session s-1 --alias a-model >/dev/null
check "the alias records the identifier it resolved to" "a-model-1" \
  "$(jq -r '.["a-model"]' "$RSTATE/routing/aliases.json")"
```

- [ ] **Step 2: Run the suite to verify the new checks fail**

Run: `./tests/run-tests.sh; echo "exit=$?"`
Expected: the `routing: cost` checks FAIL (no script), `exit=1`.

- [ ] **Step 3: Write `routing.py` with the shared helpers and `cost`**

```python
#!/usr/bin/env python3
"""routing.py - measure, calibrate and pick the model/effort pair a dispatch runs on.

The routing skill chose a tier from a table written by judgment, and nothing measured what
a dispatch cost or whether a lighter pair would have closed it. Every subcommand here turns
one part of that judgment into a reading: what a session cost, which pair a table names for
a class, what replayed pull requests say each pair delivers.

Measured data lives in <state dir>/routing/ and names model identifiers; it never enters
the plugin. Only `export` writes into the plugin, in tier/effort form.
"""

import argparse
import datetime
import fnmatch
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

STATE_DIR = os.environ.get("ORCHESTRATOR_STATE_DIR") or os.path.join(
    os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude"),
    "claude-orchestrator",
)
ROUTING_DIR = os.path.join(STATE_DIR, "routing")
PROJECTS_DIR = os.environ.get("ORCHESTRATOR_PROJECTS_DIR") or os.path.expanduser("~/.claude/projects")
MODELS_MAP = os.environ.get("ORCHESTRATOR_MODELS_MAP") or os.path.join(STATE_DIR, "models.json")
HOST_CLI = os.environ.get("ORCHESTRATOR_HOST_CLI", "claude")
GH_CLI = os.environ.get("ORCHESTRATOR_GH", "gh")
DEFAULTS_DIR = os.environ.get("ORCHESTRATOR_ROUTING_DEFAULTS") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "defaults")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
TIERS = ("deep", "standard", "light")


def die(msg):
    print("ERROR: %s" % msg, file=sys.stderr)
    sys.exit(1)


def warn(msg):
    print("WARNING: %s" % msg, file=sys.stderr)


def read_json(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default
    except ValueError:
        die("%s does not read as JSON" % path)


def write_json(path, data):
    """Through a temporary file in the same directory, so a reader never sees half a file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def parse_pair(text):
    model, sep, effort = (text or "").partition("/")
    if not model or not sep or effort not in EFFORTS:
        die("not a pair: %r (expected <alias>/<effort>, effort one of %s)" % (text, ", ".join(EFFORTS)))
    return model, effort


# --- cost -------------------------------------------------------------------------

def session_transcripts(session):
    found = glob.glob(os.path.join(PROJECTS_DIR, "*", session + ".jsonl"))
    if not found:
        die("cost: no transcript for session %s under %s" % (session, PROJECTS_DIR))
    for main in list(found):
        found += sorted(glob.glob(os.path.join(main[:-len(".jsonl")], "subagents", "*.jsonl")))
    return found


def message_usages(paths):
    """One usage per message id: the host writes one line per content block, and every one
    of them repeats the whole message's usage.
    """
    seen = {}
    anonymous = []
    for path in paths:
        with open(path) as fh:
            for line in fh:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                msg = entry.get("message") if isinstance(entry, dict) else None
                if not isinstance(msg, dict) or entry.get("type") != "assistant":
                    continue
                usage, model = msg.get("usage"), msg.get("model")
                if not isinstance(usage, dict) or not model:
                    continue
                if msg.get("id"):
                    seen[msg["id"]] = (model, usage)
                else:
                    anonymous.append((model, usage))
    return list(seen.values()) + anonymous


def message_cost(usage, price):
    inp = usage.get("input_tokens", 0) or 0
    out = usage.get("output_tokens", 0) or 0
    read = usage.get("cache_read_input_tokens", 0) or 0
    write = usage.get("cache_creation_input_tokens", 0) or 0
    split = usage.get("cache_creation") or {}
    hour = split.get("ephemeral_1h_input_tokens", 0) or 0
    five = write - hour
    rate = dict(price)
    above = price.get("above")
    if above and inp + read + write > above["tokens"]:
        rate.update(above)
    return (inp * rate["input"] + out * rate["output"] + read * rate["cache_read"]
            + five * rate["cache_write_5m"] + hour * rate["cache_write_1h"]) / 1e6


def measure(paths):
    prices = read_json(os.path.join(ROUTING_DIR, "prices.json"), {})
    out = {"cost_usd": 0.0, "models": {}, "tokens_in": 0, "tokens_out": 0,
           "cache_read": 0, "cache_write": 0}
    for model, usage in message_usages(paths):
        out["tokens_in"] += usage.get("input_tokens", 0) or 0
        out["tokens_out"] += usage.get("output_tokens", 0) or 0
        out["cache_read"] += usage.get("cache_read_input_tokens", 0) or 0
        out["cache_write"] += usage.get("cache_creation_input_tokens", 0) or 0
        price = prices.get(model)
        if price is None:
            out["models"][model] = None
            continue
        if out["models"].get(model, 0.0) is not None:
            out["models"][model] = out["models"].get(model, 0.0) + message_cost(usage, price)
    for model, cost in out["models"].items():
        if cost is None:
            print("routing: no price for %s in %s" % (model, os.path.join(ROUTING_DIR, "prices.json")),
                  file=sys.stderr)
            out["cost_usd"] = None
    if out["cost_usd"] is not None:
        out["cost_usd"] = sum(out["models"].values())
    return out


def note_alias(alias, models):
    """The identifier an alias resolved to: the one carrying the alias as a dash segment,
    else the costliest. A stale table entry is read against this.
    """
    if not alias or not models:
        return
    seg = re.compile(r"(^|-)%s(-|$)" % re.escape(alias))
    named = [m for m in sorted(models) if seg.search(m)]
    pick = named[0] if named else max(models, key=lambda m: models[m] or 0)
    path = os.path.join(ROUTING_DIR, "aliases.json")
    data = read_json(path, {})
    data[alias] = pick
    write_json(path, data)


def cmd_cost(argv):
    p = argparse.ArgumentParser(prog="cost")
    p.add_argument("transcript", nargs="?")
    p.add_argument("--session")
    p.add_argument("--alias")
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    if bool(a.transcript) == bool(a.session):
        die("cost: give a transcript path or --session <id>, not both")
    paths = session_transcripts(a.session) if a.session else [a.transcript]
    m = measure(paths)
    note_alias(a.alias, m["models"])
    if a.json:
        print(json.dumps(m, sort_keys=True))
        return
    cost = "unknown" if m["cost_usd"] is None else "%.6f" % m["cost_usd"]
    print("cost_usd=%s models=%s tokens_in=%d tokens_out=%d cache_read=%d cache_write=%d"
          % (cost, ",".join(sorted(m["models"])), m["tokens_in"], m["tokens_out"],
             m["cache_read"], m["cache_write"]))


COMMANDS = {"cost": cmd_cost}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        die("usage: routing.py {%s} ..." % "|".join(sorted(COMMANDS)))
    COMMANDS[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    main()
```

Note for Step 1's `--json` check: the path form reads only the main file (no subagent), so
it is 0.067000 + 0.102500 = 0.1695.

- [ ] **Step 4: Run the suite to verify it passes**

Run: `./tests/run-tests.sh; echo "exit=$?"`
Expected: every check ok, `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add skills/model-routing/scripts/routing.py tests/fixtures/routing tests/run-tests.sh
git commit -m "feat(routing): measure a session's cost from its transcript" -m "The routing rule ranks tiers by what a dispatch costs, and nothing measured it. One usage per message id, subagents included, priced from the operator's own price file; an unpriced model is reported unknown, never guessed."
```

### Task 2: the launcher's `--effort` and pair bindings in the tier map

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` (`resolve_tier` ~850, `build_command`
  ~1480, `cmd_spawn` ~1656, its call at ~1972, the flag lists at ~1706, ~1730, ~1883,
  `cmd_resolve_tier` ~2423)
- Modify: `skills/iterm-agents/references/commands.md` (spawn synopsis, resolve-tier)
- Modify: `tests/run-tests.sh` (next to the `resolve-tier` checks, ~2937-3007)

**Interfaces:**
- Produces: `resolve_tier_pair(tier) -> (model, effort)`; `resolve_tier(tier)` prints
  `<model>` or `<model>/<effort>`. A map value is a string (model) or an object
  `{"model": "<alias>", "effort": "<level>"}`; `ORCHESTRATOR_TIER_<TIER>` may hold either
  `model` or `model/effort`.
- Produces: `spawn --effort <level>`; the launch line carries `--effort <level>` right after
  the model argument. `--tier` takes the map's effort; an explicit `--effort` wins.

- [ ] **Step 1: Write the failing tests** (beside the existing `resolve-tier` checks)

```bash
PMAP="$WORK/pair-map.json"
printf '{"deep":{"model":"a-model","effort":"high"},"standard":"b-model","light":{"model":"c-model"}}' > "$PMAP"
check "a pair binding resolves to model/effort" "a-model/high" \
  "$(env ORCHESTRATOR_MODELS_MAP="$PMAP" bash "$AGENT" resolve-tier deep)"
check "a string binding still resolves to the model alone" "b-model" \
  "$(env ORCHESTRATOR_MODELS_MAP="$PMAP" bash "$AGENT" resolve-tier standard)"
check "an object without effort resolves to the model alone" "c-model" \
  "$(env ORCHESTRATOR_MODELS_MAP="$PMAP" bash "$AGENT" resolve-tier light)"
printf '{"deep":{"model":"a-model","effort":"huge"}}' > "$WORK/bad-effort.json"
check "an unknown effort in the map is a refusal" \
  "ERROR: resolve-tier: tier deep has an unknown effort: huge (expected low, medium, high, xhigh or max)" \
  "$(env ORCHESTRATOR_MODELS_MAP="$WORK/bad-effort.json" bash "$AGENT" resolve-tier deep 2>&1)"
printf '{"deep":{"effort":"high"}}' > "$WORK/no-model.json"
check_status "an object without a model is a refusal" 1 \
  env ORCHESTRATOR_MODELS_MAP="$WORK/no-model.json" bash "$AGENT" resolve-tier deep
pcmd() { env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$PMAP" bash "$AGENT" spawn --dir "$WORK" --title 'Agent : x' --prompt p "$@" 2>/dev/null; }
check "a pair tier types the model then the effort" "1" "$(pcmd --tier deep | grep -c -- '--model a-model --effort high')"
check "an explicit effort wins over the map's" "1" "$(pcmd --tier deep --effort low | grep -c -- '--effort low')"
check "an explicit effort with an explicit model" "1" "$(pcmd --model z-model --effort medium | grep -c -- '--model z-model --effort medium')"
check "no effort anywhere: no effort argument" "0" "$(pcmd --tier standard | grep -c -- '--effort')"
check "an unknown effort on spawn is a refusal" \
  "ERROR: spawn: unknown effort: huge (expected low, medium, high, xhigh or max)" \
  "$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title 'Agent : x' --prompt p --effort huge 2>&1 | tail -1)"
```

- [ ] **Step 2: Run the suite to verify the new checks fail**

Run: `./tests/run-tests.sh; echo "exit=$?"` — Expected: the new checks FAIL, `exit=1`.

- [ ] **Step 3: Implement**

Add after `TIERS` (~line 81):

```python
EFFORTS = ("low", "medium", "high", "xhigh", "max")
EFFORT_LIST = "low, medium, high, xhigh or max"
```

Replace the body of `resolve_tier` with a pair-aware core, keeping its docstring's
reasoning and the broken-map refusal:

```python
def resolve_tier_pair(tier):
    """A tier in, the (model, effort) the operator bound to it out; either may be empty.
    An unbound tier returns ("", "") and succeeds: the caller reads that as "let the host
    choose", which is a better answer than a name this plugin has no business carrying.
    """
    if tier not in TIERS:
        die("resolve-tier: unknown tier: %s (expected deep, standard or light)" % tier)
    value = os.environ.get("ORCHESTRATOR_TIER_" + tier.upper())
    if not value:
        if not os.path.isfile(MODELS_MAP):
            return "", ""
        try:
            with open(MODELS_MAP) as fh:
                data = json.load(fh)
            if not isinstance(data, dict):
                raise ValueError("not an object")
        except Exception:
            # A map that does not parse is NOT an unbound tier. Reading the two alike sends
            # every dispatch to the host's default while the caller reports the tier it
            # believes it asked for: one missing comma, and the routing is advisory in silence.
            die("resolve-tier: %s does not read as a tier map (invalid JSON, empty, or not an object)" % MODELS_MAP)
        value = data.get(tier) or ""
    if isinstance(value, dict):
        model, effort = str(value.get("model") or ""), str(value.get("effort") or "")
        if not model:
            die("resolve-tier: tier %s is bound to an object without a model" % tier)
    else:
        model, _, effort = str(value).partition("/")
    if effort and effort not in EFFORTS:
        die("resolve-tier: tier %s has an unknown effort: %s (expected %s)" % (tier, effort, EFFORT_LIST))
    warn_versioned(tier, model)
    return model, effort


def resolve_tier(tier):
    model, effort = resolve_tier_pair(tier)
    return model + ("/" + effort if effort and model else "")
```

In `build_command`, add the parameter `effort=""` (last keyword) and, right after the
`--model` lines:

```python
    if effort:
        cli += ["--effort", shq(effort)]
```

In `cmd_spawn`: add `p.add_argument("--effort", default="")`; add `("--effort",
args.effort)` to the three refused-flag tuples (coordinator's successor ~1706, auditor
~1730, successor ~1883 — each of these is modelled ONE way, by its caller's model); then
replace the tier resolution:

```python
    if args.effort and args.effort not in EFFORTS:
        die("spawn: unknown effort: %s (expected %s)" % (args.effort, EFFORT_LIST))
    model, effort = args.model, args.effort
    if args.tier:
        model, map_effort = resolve_tier_pair(args.tier)
        effort = args.effort or map_effort
```

and pass `effort=effort` to the `build_command(...)` call (~1972).

In `references/commands.md`, add `--effort <low|medium|high|xhigh|max>` to the spawn
synopsis with one line: « types the effort after the model; `--tier` takes the map's, an
explicit one wins », and under `resolve-tier`: « prints `<model>` or `<model>/<effort>`; a
tier may be bound to `{"model": "<alias>", "effort": "<level>"}` ».

- [ ] **Step 4: Run the suite** — `./tests/run-tests.sh; echo "exit=$?"`, Expected `exit=0`
  (the existing `resolve-tier` and `--tier` checks pass unchanged).

- [ ] **Step 5: Commit**

```bash
git add skills/iterm-agents tests/run-tests.sh
git commit -m "feat(iterm-agents): launch on a model/effort pair" -m "Effort moves token spend as much as the model family does, and the launcher could not set it. A tier may now bind an effort with its model; an explicit --effort wins."
```

### Task 3: the record's pair, cost and exploration

**Files:**
- Modify: `skills/orchestrator/scripts/dispatch-record.sh`
- Modify: `tests/run-tests.sh` (section `== dispatch record ==`, after its last check)

**Interfaces:**
- Consumes: `routing.py cost --session <id> --alias <alias> --json` (Task 1).
- Produces: `open <record> --class <c> (--tier <t> | --model <alias> [--effort <e>])
  [--label <l>] [--cascade] [--explore]`; row fields `model`, `effort`, `explore`,
  `cost_usd`, `sessions`, `cost_incomplete`.
- Produces: `cost <record> <id> --session <sid>`.
- Produces summary lines: for pair rows `class=<c> pair=<m>/<e> dispatches=… closed=…
  rounds_avg=… cost_avg=<usd>`; `frozen=<class>`; `promote=<class> <pair>`. Tier rows print
  exactly as before.

- [ ] **Step 1: Write the failing tests**

```bash
CSTATE="$WORK/cstate"; mkdir -p "$CSTATE/routing"
cp "$ROOT/tests/fixtures/routing/prices.json" "$CSTATE/routing/prices.json"
crec() { ORCHESTRATOR_STATE_DIR="$CSTATE" ORCHESTRATOR_PROJECTS_DIR="$ROOT/tests/fixtures/routing/projects" bash "$REC" "$@"; }
PR="$WORK/pairs.jsonl"
p1=$(crec open "$PR" --class behaviour-phase --model a-model --effort medium --label "p1")
check "a pair row carries model and effort" "a-model|medium|false|0" \
  "$(jq -r 'select(.id==1)|[.model,.effort,.explore,.cost_usd]|map(tostring)|join("|")' "$PR")"
crec cost "$PR" "$p1" --session s-1 >/dev/null
check "cost adds the session's measured cost to the row" "0.1701|s-1" \
  "$(jq -r 'select(.id==1)|[(.cost_usd*10000|round/10000|tostring), (.sessions|join(","))]|join("|")' "$PR")"
check "the same session twice is not counted twice" "0.1701" \
  "$(crec cost "$PR" "$p1" --session s-1 2>/dev/null; jq -r 'select(.id==1)|.cost_usd*10000|round/10000' "$PR")"
crec close "$PR" "$p1" --verdict approved >/dev/null
check "summary prints the pair and its average cost" "1" \
  "$(crec summary "$PR" | grep -c '^class=behaviour-phase pair=a-model/medium dispatches=1 closed=1 rounds_avg=0 cost_avg=0.1701$')"
check_status "open refuses an unknown effort" 1 crec open "$PR" --class x --model a-model --effort huge
check_status "open wants a tier or a model" 1 crec open "$PR" --class x
# Exploration: a failed one freezes the class; three that close in one round promote the pair.
e1=$(crec open "$PR" --class conversion-phase --model a-model --effort low --explore)
crec round "$PR" "$e1" >/dev/null; crec round "$PR" "$e1" >/dev/null; crec close "$PR" "$e1" --verdict approved >/dev/null
check "an exploration that cost a corrective round freezes its class" "1" "$(crec summary "$PR" | grep -c '^frozen=conversion-phase$')"
for i in 1 2 3; do e=$(crec open "$PR" --class n-bis --model a-model --effort low --explore); crec round "$PR" "$e" >/dev/null; crec close "$PR" "$e" --verdict approved >/dev/null; done
check "three explorations closed in one round promote the pair" "1" "$(crec summary "$PR" | grep -c '^promote=n-bis a-model/low$')"
check "an escaped defect on an exploration freezes its class too" "1" \
  "$(crec escaped "$PR" "$e" >/dev/null; crec summary "$PR" | grep -c '^frozen=n-bis$')"
```

The existing dispatch-record checks above them stay as they are: they pin that tier rows
print byte-identically (Review Focus 3).

- [ ] **Step 2: Run the suite to verify the new checks fail** — Expected `exit=1`.

- [ ] **Step 3: Implement**

Header synopsis gains:

```bash
#   dispatch-record.sh open    <record> --class <c> (--tier <deep|standard|light> | --model <alias> [--effort <level>]) [--label <text>] [--cascade] [--explore]
#   dispatch-record.sh cost    <record> <id> --session <session id>   (adds that session's measured cost)
```

and one paragraph: « A pair row names the model alias and the effort it ran on, and
`cost` adds each session's measured cost to it - the corrective rounds of a dispatch are
part of what it cost. `--explore` marks a dispatch one notch below its class's pair: one
that costs a corrective round, or lets a defect escape, freezes the class (`frozen=`); three
that close in one round promote the lower pair (`promote=`). »

Add near the top: `ROUTING="$(cd "$(dirname "$0")/../../model-routing/scripts" && pwd)/routing.py"`
and `EFFORTS="low medium high xhigh max"`.

`open` parsing gains `--model) model="$2"; shift 2 ;;`, `--effort) effort="$2"; shift 2 ;;`,
`--explore) explore=true; shift ;;`, then replaces the tier check with:

```bash
    [ -n "$tier" ] || [ -n "$model" ] || die "open: --tier or --model is required"
    [ -z "$tier" ] || case "$tier" in deep|standard|light) ;; *) die "open: unknown tier: $tier (expected deep, standard or light)" ;; esac
    [ -z "$effort" ] || case " $EFFORTS " in *" $effort "*) ;; *) die "open: unknown effort: $effort (expected low, medium, high, xhigh or max)" ;; esac
    [ -z "$effort" ] || [ -n "$model" ] || die "open: --effort needs --model"
```

and the row:

```bash
    jq -nc --argjson id "$id" --arg c "$class" --arg t "$tier" --arg l "$label" \
        --arg m "$model" --arg e "$effort" \
        --arg o "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson k "$cascade" --argjson x "$explore" \
        '{id:$id,opened:$o,class:$c,tier:$t,label:$l,rounds:0,state:"open",verdict:"",cascade:$k}
         + (if $m != "" then {model:$m,effort:$e,explore:$x,cost_usd:0,sessions:[],cost_incomplete:false} else {} end)' >> "$record"
```

New subcommand, before `summary)`:

```bash
cost)
    # What one session of this dispatch cost, added to the row: a dispatch's corrective
    # rounds are part of what it cost, and a pair is ranked on the whole of it.
    id="${3:-}"; [ -n "$id" ] || die "cost: a row id is required"
    require_row cost "$id"
    shift 3; session=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --session) session="$2"; shift 2 ;;
            *) die "cost: unknown option $1" ;;
        esac
    done
    [ -n "$session" ] || die "cost: --session is required"
    if [ "$(jq -sr --argjson i "$id" --arg s "$session" '[.[]|select(.id==$i)][0].sessions // [] | index($s) != null' "$record")" = true ]; then
        warn "cost: session $session is already counted on row $id"; exit 0
    fi
    alias=$(jq -sr --argjson i "$id" '[.[]|select(.id==$i)][0].model // ""' "$record")
    measured=$(python3 "$ROUTING" cost --session "$session" ${alias:+--alias "$alias"} --json) || die "cost: could not measure session $session"
    usd=$(printf '%s' "$measured" | jq -r '.cost_usd // "null"')
    if [ "$usd" = null ]; then
        warn "cost: session $session has an unpriced model: row $id is marked cost_incomplete"
        rewrite 'if .id==$i then .sessions += [$s] | .cost_incomplete=true else . end' "$id" --arg s "$session"
    else
        rewrite 'if .id==$i then .sessions += [$s] | .cost_usd = ((.cost_usd // 0) + $u) else . end' "$id" \
            --arg s "$session" --argjson u "$usd"
    fi
    echo "cost: row $id +$usd (session $session)"
    ;;
```

In `summary`, every group is keyed by the pair when the row has one and by the tier
otherwise, so a tier row prints `tier=light` exactly as before. Replace the first `jq`
program with:

```jq
def key: if .model then "pair=" + .model + "/" + (.effort // "default") else "tier=" + .tier end;
map(. + {key: key})
| group_by(.class + " " + .key)
| map({class: .[0].class, key: .[0].key, rows: .,
       n: length, closed: (map(select(.state=="closed"))|length),
       avg: (if length==0 then 0 else ((map(.rounds)|add) / length) end)})
| map(. + {costs: (.rows | map(select(.state=="closed" and (.cost_incomplete|not) and (.cost_usd // 0) > 0)) | map(.cost_usd))})
| sort_by(.class, .key)
| (.[] | "class=\(.class) \(.key) dispatches=\(.n) closed=\(.closed) rounds_avg=\(.avg*10|round/10)"
         + (if (.costs|length) > 0 then " cost_avg=\((.costs|add/length)*10000|round/10000)" else "" end)),
  (.[] | select(.avg > 1) | "signal=\(.class) at \(.key|sub("^(tier|pair)=";"")) averages \(.avg*10|round/10) rounds: the drop did not pay, revert it for this class")
```

In the escapes and cascade programs, add the same `def key` and `map(. + {key: key})` first,
group by `.class + " " + .key`, carry `key: .[0].key` instead of `tier`, sort by
`.class, .key`, and print `at \(.key|sub("^(tier|pair)=";""))` where they printed
`at \(.tier)`. Then, before the open rows:

```bash
    # Exploration: one that cost a corrective round or let a defect escape freezes its
    # class for the build; three that closed in one round promote the lower pair.
    jq -sr '
      map(select(.explore == true and .state == "closed"))
      | group_by(.class)
      | (.[] | select(any(.[]; .rounds > 1 or .escaped == true)) | "frozen=\(.[0].class)"),
        (.[] | select(all(.[]; .rounds <= 1 and (.escaped != true)))
             | group_by(.model + "/" + .effort)[] | select(length >= 3)
             | "promote=\(.[0].class) \(.[0].model)/\(.[0].effort)")
    ' "$record"
```

Extend the `*)` usage line and the `cmd` usage with `cost`.

- [ ] **Step 4: Run the suite** — Expected `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add skills/orchestrator/scripts/dispatch-record.sh tests/run-tests.sh
git commit -m "feat(dispatch-record): record the pair a dispatch ran on and what it cost" -m "Rounds alone could not say whether a lighter pair paid: a cheap dispatch that needs a correction may cost more than a dear one that does not. Each row now carries its pair and the sum of its sessions' measured costs, and exploration below a class's pair is frozen or promoted from the rows themselves."
```

---

## Phase 2 — Tables and online policy (one pull request)

### Task 4: `profile`, the table format and `pick`

**Files:**
- Modify: `skills/model-routing/scripts/routing.py`
- Create: `skills/model-routing/defaults/README.md`
- Create: `tests/fixtures/routing/trees/` (four tiny trees, see step 1)
- Modify: `tests/run-tests.sh` (new section `== routing: pick ==`)

**Interfaces:**
- Produces: `routing.py profile <repo>` → `<language>/<kind>`.
- Produces: `routing.py pick --repo <path> --class <c> [--record <record>]` → line 1
  `pair=<alias>/<effort> source=<scope>` (+ ` stale` when measured on another identifier),
  or `pair=<alias> source=tier-table` when only a tier binds a model, or
  `pair=host-default source=tier-table` when nothing binds; line 2 (only with `--record`
  and when the record allows it) `explore=<alias>/<effort>`.
- Produces the table format, read by every later task:

```json
{"scope": "project:<slug>", "generated": "2026-10-09",
 "entries": {"<class>": {"pair": "<alias>/<effort>", "pass_rate": 1.0, "n": 8,
                          "cost_usd": 0.42, "floor": 0.9, "models": ["<id>"],
                          "ladder": [{"pair": "<alias>/<effort>", "n": 6, "pass_rate": 0.5,
                                      "cost_usd": 0.2, "expected_usd": 0.41, "eligible": false}]}}}
```

  Shipped defaults use the same format with `"pair": "<tier>/<effort>"`, no `models`, no
  `cost_usd`.
- Produces: `CLASS_TIERS`, `NEVER_EXPLORED`, `STRICT_CLASSES`, `project_slug(repo)`,
  `infer_profile(repo)`, `table_path(scope)`, `tier_order()`, `ladder_down(pair)`.

- [ ] **Step 1: Write the fixtures and the failing tests**

Trees (each a directory with the marker files, empty unless stated):
`trees/laravel/{composer.json,artisan}`, `trees/plugin/{.claude-plugin/plugin.json,run.sh,a.sh,b.py}`,
`trees/pycli/{pyproject.toml,bin/tool}`, `trees/jslib/{package.json,index.js}`.

```bash
echo "== routing: pick =="

T="$ROOT/tests/fixtures/routing/trees"
check "profile: a composer project with artisan" "php/laravel-app" "$(python3 "$ROUTING" profile "$T/laravel")"
check "profile: a plugin by its manifest, language by dominant extension" "shell/plugin" "$(python3 "$ROUTING" profile "$T/plugin")"
check "profile: a python project with a bin entry point" "python/cli" "$(python3 "$ROUTING" profile "$T/pycli")"
check "profile: a node package with no entry point" "javascript/library" "$(python3 "$ROUTING" profile "$T/jslib")"

PS="$WORK/pstate"; mkdir -p "$PS/routing/tables" "$PS/routing/projects/laravel"
printf '{"deep":"a-model","standard":{"model":"b-model","effort":"medium"},"light":"c-model"}' > "$PS/models.json"
printf '{"slug":"laravel","repo":"%s","profile":"php/laravel-app","tasks":[]}' "$T/laravel" > "$PS/routing/projects/laravel/manifest.json"
DEF="$WORK/defaults"; mkdir -p "$DEF"
rpick() { ORCHESTRATOR_STATE_DIR="$PS" ORCHESTRATOR_ROUTING_DEFAULTS="$DEF" python3 "$ROUTING" pick --repo "$T/laravel" "$@"; }
check "nothing measured: the tier table through the map" "pair=b-model/medium source=tier-table" "$(rpick --class behaviour-phase)"
check "nothing measured, a tier bound to a model alone" "pair=c-model source=tier-table" "$(rpick --class search)"
printf '{"scope":"global","entries":{"behaviour-phase":{"pair":"light/high"}}}' > "$DEF/global.json"
check "a shipped default resolves its tier through the map" "pair=c-model/high source=shipped:global" "$(rpick --class behaviour-phase)"
printf '{"scope":"global","entries":{"behaviour-phase":{"pair":"c-model/medium","models":["c-model-1"]}}}' > "$PS/routing/tables/global.json"
check "the local global table beats the shipped defaults" "pair=c-model/medium source=global" "$(rpick --class behaviour-phase)"
printf '{"scope":"profile:php/laravel-app","entries":{"behaviour-phase":{"pair":"b-model/low","models":["b-model-1"]}}}' > "$PS/routing/tables/profile-php-laravel-app.json"
check "the profile table beats the global one" "pair=b-model/low source=profile:php/laravel-app" "$(rpick --class behaviour-phase)"
printf '{"scope":"project:laravel","entries":{"behaviour-phase":{"pair":"a-model/low","models":["a-model-1"],"ladder":[{"pair":"c-model/high","eligible":false},{"pair":"a-model/low","eligible":true}]}}}' > "$PS/routing/tables/project-laravel.json"
check "the project table beats them all" "pair=a-model/low source=project:laravel" "$(rpick --class behaviour-phase)"
printf '{"a-model":"a-model-2"}' > "$PS/routing/aliases.json"
check "an entry measured on another identifier is flagged stale" "pair=a-model/low source=project:laravel stale" "$(rpick --class behaviour-phase)"
check_status "an unknown class is a refusal" 1 rpick --class nonsense
# Exploration: three one-round closes at the class's pair, none escaped, and a class that may be explored.
ER="$WORK/explore.jsonl"; : > "$ER"
for i in 1 2 3; do printf '{"id":%d,"class":"behaviour-phase","model":"a-model","effort":"low","rounds":1,"state":"closed"}\n' "$i" >> "$ER"; done
check "three clean closes offer one notch down: no eligible cheaper rung, no lower effort, so the next lighter family" \
  "explore=b-model/low" "$(rpick --class behaviour-phase --record "$ER" | sed -n 2p)"
check "a contract phase is never explored" "1" \
  "$(printf '{"id":9,"class":"contract-phase","model":"a-model","effort":"low","rounds":1,"state":"closed"}\n%.0s' 1 2 3 > "$WORK/c.jsonl"; rpick --class contract-phase --record "$WORK/c.jsonl" | wc -l | tr -d ' ')"
```

The explore check pins the ladder rule: the entry's `ladder` lists `c-model/high` below
`a-model/low` but ineligible (it failed the floor), so it is not a candidate; `a-model` has no
effort below `low`; the next lighter family in the map is `b-model`, at the same effort.

- [ ] **Step 2: Run the suite to verify the new checks fail** — Expected `exit=1`.

- [ ] **Step 3: Implement** (add to `routing.py`; register `profile` and `pick` in
`COMMANDS`)

```python
# --- classes, tables, pick --------------------------------------------------------

# The tier table the skill ships, as data: where `pick` lands when nothing is measured.
CLASS_TIERS = {
    "orchestrator": "deep", "successor": "deep", "decision-round": "deep",
    "contract-phase": "deep", "final-verification": "deep",
    "behaviour-phase": "standard", "conversion-phase": "standard", "n-bis": "standard",
    "review-collector": "standard", "comments": "standard", "review-lens": "standard",
    "search": "light",
}
# Work nothing downstream re-checks: never explored online, held to a floor of 1.0 offline.
NEVER_EXPLORED = {"orchestrator", "successor", "decision-round", "contract-phase", "final-verification"}
STRICT_CLASSES = {"contract-phase", "final-verification"}
EXPLORE_AFTER = 3


def git_top(repo):
    r = subprocess.run(["git", "-C", repo, "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    return os.path.realpath(r.stdout.strip() if r.returncode == 0 else repo)


def project_slug(repo):
    """The manifest whose repo is this path or its checkout, else the directory's name. The
    path is matched first: a project nested in another checkout is still its own project.
    """
    here, top = os.path.realpath(repo), git_top(repo)
    for path in glob.glob(os.path.join(ROUTING_DIR, "projects", "*", "manifest.json")):
        m = read_json(path, {})
        if m.get("repo") and os.path.realpath(m["repo"]) in (here, top):
            return m["slug"]
    return re.sub(r"[^A-Za-z0-9._-]", "-", os.path.basename(here))


def manifest_path(slug):
    return os.path.join(ROUTING_DIR, "projects", slug, "manifest.json")


LANG_MARKERS = (("composer.json", "php"), ("pyproject.toml", "python"), ("setup.py", "python"),
                ("go.mod", "go"), ("Cargo.toml", "rust"), ("Gemfile", "ruby"),
                ("pom.xml", "java"), ("build.gradle", "java"))
EXTENSIONS = {".sh": "shell", ".py": "python", ".php": "php", ".js": "javascript",
              ".ts": "typescript", ".go": "go", ".rs": "rust", ".rb": "ruby", ".java": "java"}


def infer_profile(repo):
    top = os.path.realpath(repo)  # the root the caller names, never a checkout above it
    has = lambda p: os.path.exists(os.path.join(top, p))
    language = next((lang for marker, lang in LANG_MARKERS if has(marker)), "")
    if not language and has("package.json"):
        language = "typescript" if has("tsconfig.json") else "javascript"
    if not language or has(".claude-plugin"):
        counts = {}
        for root, dirs, files in os.walk(top):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "vendor")]
            for f in files:
                lang = EXTENSIONS.get(os.path.splitext(f)[1])
                if lang:
                    counts[lang] = counts.get(lang, 0) + 1
        language = max(sorted(counts), key=counts.get) if counts else (language or "unknown")
    if has("artisan"):
        kind = "laravel-app"
    elif has(".claude-plugin"):
        kind = "plugin"
    elif has("bin") or has("console") or has("cli.py") or has("__main__.py"):
        kind = "cli"
    elif has("Dockerfile") or has("public") or has("app"):
        kind = "app"
    else:
        kind = "library"
    return "%s/%s" % (language, kind)


def project_profile(repo):
    m = read_json(manifest_path(project_slug(repo)), {})
    return m.get("profile") or infer_profile(repo)


def table_path(scope, shipped=False):
    """scope: "project:<slug>", "profile:<language>/<kind>" or "global"."""
    kind, _, name = scope.partition(":")
    base = "global" if kind == "global" else "%s-%s" % (kind, name.replace("/", "-"))
    return os.path.join(DEFAULTS_DIR if shipped else os.path.join(ROUTING_DIR, "tables"), base + ".json")


def read_map():
    """{tier: (model, effort)} from the operator's map; unbound tiers are absent."""
    data = read_json(MODELS_MAP, {})
    out = {}
    for tier in TIERS:
        v = data.get(tier) if isinstance(data, dict) else None
        if isinstance(v, dict) and v.get("model"):
            out[tier] = (v["model"], v.get("effort") or "")
        elif isinstance(v, str) and v:
            m, _, e = v.partition("/")
            out[tier] = (m, e)
    return out


def tier_order():
    """The bound families, heaviest first, read from the map so no code names a family."""
    seen = []
    for tier in TIERS:
        m = read_map().get(tier)
        if m and m[0] not in seen:
            seen.append(m[0])
    return seen


def ladder_down(pair, entry=None):
    """One notch below a pair: the next cheaper ELIGIBLE pair of the entry's ladder; without
    one, effort down a level on the same family; at the lowest effort, the next lighter
    family at the same effort. None when there is nothing below.
    """
    if entry:
        ladder = entry.get("ladder") or []
        pairs = [r["pair"] for r in ladder]
        if pair in pairs:
            below = [r for r in ladder[:pairs.index(pair)] if r.get("eligible")]
            if below:
                return below[-1]["pair"]
    model, effort = parse_pair(pair)
    i = EFFORTS.index(effort)
    if i > 0:
        return "%s/%s" % (model, EFFORTS[i - 1])
    order = tier_order()
    if model in order and order.index(model) + 1 < len(order):
        return "%s/%s" % (order[order.index(model) + 1], effort)
    return None


def resolve_shipped(pair):
    tier, _, effort = pair.partition("/")
    bound = read_map().get(tier)
    return "%s/%s" % (bound[0], effort) if bound else None


def lookup(repo, cls):
    slug = project_slug(repo)
    profile = project_profile(repo)
    for scope, shipped in (("project:" + slug, False), ("profile:" + profile, False), ("global", False),
                           ("profile:" + profile, True), ("global", True)):
        entry = read_json(table_path(scope, shipped), {}).get("entries", {}).get(cls)
        if not entry:
            continue
        if shipped:
            pair = resolve_shipped(entry["pair"])
            if pair:
                return pair, "shipped:" + scope, entry
            continue
        return entry["pair"], scope, entry
    bound = read_map().get(CLASS_TIERS[cls])
    if not bound:
        return "host-default", "tier-table", None
    return (bound[0] + ("/" + bound[1] if bound[1] else "")), "tier-table", None


def is_stale(pair, entry):
    if not entry or not entry.get("models") or "/" not in pair:
        return False
    now = read_json(os.path.join(ROUTING_DIR, "aliases.json"), {}).get(pair.split("/")[0])
    return bool(now) and now not in entry["models"]


def may_explore(record, cls, pair):
    if cls in NEVER_EXPLORED or not record or not os.path.isfile(record) or "/" not in pair:
        return False
    rows = [json.loads(l) for l in open(record) if l.strip()]
    model, effort = pair.split("/")
    mine = [r for r in rows if r.get("class") == cls and r.get("state") == "closed"
            and r.get("model") == model and r.get("effort") == effort]
    if any(r.get("escaped") for r in mine):
        return False
    return sum(1 for r in mine if r.get("rounds", 0) <= 1) >= EXPLORE_AFTER


def cmd_profile(argv):
    if len(argv) != 1:
        die("profile: exactly one repository path is required")
    print(infer_profile(argv[0]))


def cmd_pick(argv):
    p = argparse.ArgumentParser(prog="pick")
    p.add_argument("--repo", required=True)
    p.add_argument("--class", dest="cls", required=True)
    p.add_argument("--record")
    a = p.parse_args(argv)
    if a.cls not in CLASS_TIERS:
        die("pick: unknown class: %s (expected one of %s)" % (a.cls, ", ".join(sorted(CLASS_TIERS))))
    pair, source, entry = lookup(a.repo, a.cls)
    print("pair=%s source=%s%s" % (pair, source, " stale" if is_stale(pair, entry) else ""))
    if may_explore(a.record, a.cls, pair):
        below = ladder_down(pair, entry)
        if below:
            print("explore=%s" % below)
```

`skills/model-routing/defaults/README.md`: three short paragraphs — what these files are
(profile and global tables exported in tier/effort form by `routing.py export`), that they
name no model and resolve through the operator's map, and that they are regenerated from
measurements, never edited by hand.

- [ ] **Step 4: Run the suite** — Expected `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add skills/model-routing tests/fixtures/routing/trees tests/run-tests.sh
git commit -m "feat(routing): pick a class's pair from the most specific table measured" -m "A pair measured on this project beats one measured on its profile, which beats the global one and the shipped defaults; the tier table stays the floor. A pick names its source and says when the entry was measured on a model the alias no longer resolves to."
```

### Task 5: `calibrate` — trials and record rows into a project table

**Files:**
- Modify: `skills/model-routing/scripts/routing.py`
- Modify: `tests/run-tests.sh` (new section `== routing: calibrate ==`)

**Interfaces:**
- Consumes: the trial line format (produced by Task 8):
  `{"task","class","pair","rep","models":{id:usd},"cost_usd","judge_cost_usd","mech":"pass|fail|error","judge":"pass|fail|null","status":"pass|fail|error","quota_before","quota_after","at"}`.
- Produces: `routing.py calibrate <slug> [--from-record <record>]...` writes
  `tables/project-<slug>.json`; prints one line per class:
  `class=<c> pair=<p> pass_rate=<r> n=<n> expected_usd=<x>` or `class=<c> no eligible pair`.
- Produces: `select_entry(cls, stats, floor) -> entry|None` and `stats_of(trials) ->
  {pair: {"n","passes","costs","models"}}` (reused by Task 10).

- [ ] **Step 1: Write the fixture and the failing tests**

The trials — class `behaviour-phase`, three pairs:
`c-model/medium` 6 trials, 4 pass, cost 0.10 each; `b-model/medium` 6 trials, 6 pass, cost
0.30; `a-model/low` 6 trials, 6 pass, cost 0.50; plus one `error` trial on `b-model/medium`
cost 0.05; class `contract-phase`: `b-model/high` 6 trials, 5 pass, 0.40; `a-model/high` 6
trials, 6 pass, 0.90. Write the lines with a small generator in the test itself so the
numbers stay readable (no fixture file):

```bash
echo "== routing: calibrate =="

CS="$WORK/calstate"; mkdir -p "$CS/routing/projects/demo"
TR="$CS/routing/projects/demo/trials.jsonl"; : > "$TR"
trial() { # class pair status cost
  printf '{"task":"t","class":"%s","pair":"%s","rep":1,"models":{"%s-1":%s},"cost_usd":%s,"status":"%s"}\n' \
    "$1" "$2" "${2%%/*}" "$4" "$4" "$3" >> "$TR"; }
for i in 1 2 3 4; do trial behaviour-phase c-model/medium pass 0.10; done
for i in 1 2; do trial behaviour-phase c-model/medium fail 0.10; done
for i in 1 2 3 4 5 6; do trial behaviour-phase b-model/medium pass 0.30; trial behaviour-phase a-model/low pass 0.50; done
trial behaviour-phase b-model/medium error 0.05
for i in 1 2 3 4 5; do trial contract-phase b-model/high pass 0.40; done
trial contract-phase b-model/high fail 0.40
for i in 1 2 3 4 5 6; do trial contract-phase a-model/high pass 0.90; done
printf '{"slug":"demo","repo":"/nonexistent","profile":"x/y","tasks":[]}' > "$CS/routing/projects/demo/manifest.json"
rcal() { ORCHESTRATOR_STATE_DIR="$CS" python3 "$ROUTING" calibrate "$@"; }
out=$(rcal demo)
check "below the floor is never chosen, however cheap" "class=behaviour-phase pair=b-model/medium pass_rate=1.0 n=6 expected_usd=0.2643" \
  "$(printf '%s\n' "$out" | grep '^class=behaviour-phase')"
check "work nothing re-checks takes a floor of 1.0" "class=contract-phase pair=a-model/high pass_rate=1.0 n=6 expected_usd=0.9" \
  "$(printf '%s\n' "$out" | grep '^class=contract-phase')"
check "an error trial costs but does not count" "6|0.2643" \
  "$(jq -r '.entries["behaviour-phase"].ladder[]|select(.pair=="b-model/medium")|"\(.n)|\(.cost_usd*10000|round/10000)"' "$CS/routing/tables/project-demo.json")"
check "the ladder is ordered by cost, cheapest first" "c-model/medium,b-model/medium,a-model/low" \
  "$(jq -r '[.entries["behaviour-phase"].ladder[].pair]|join(",")' "$CS/routing/tables/project-demo.json")"
check "the entry keeps the identifiers it was measured on" "b-model-1" \
  "$(jq -r '.entries["behaviour-phase"].models|join(",")' "$CS/routing/tables/project-demo.json")"
# Fewer than six trials: no eligible pair.
: > "$TR"; for i in 1 2 3; do trial n-bis c-model/low pass 0.01; done
check "fewer than six trials is never eligible" "class=n-bis no eligible pair" "$(rcal demo)"
# Record rows count as trials: closed in one round and not escaped is a pass.
RR="$WORK/calrec.jsonl"; : > "$RR"
for i in 1 2 3 4 5 6; do printf '{"id":%d,"class":"n-bis","model":"c-model","effort":"low","rounds":1,"state":"closed","cost_usd":0.02,"sessions":["s"],"cost_incomplete":false}\n' "$i" >> "$RR"; done
check "record rows complete the measurement" "class=n-bis pair=c-model/low pass_rate=1.0 n=9 expected_usd=0.0167" \
  "$(rcal demo --from-record "$RR")"
```

Expected values, by hand: behaviour-phase ladder by mean cost — `c-model/medium` mean 0.10
(n 6, rate 0.667, ineligible), `b-model/medium` mean (6×0.30+0.05)/7 = 0.2643, n 6, rate
1.0, `a-model/low` 0.50. Expected cost of `b-model/medium` = 0.2643 + (1−1.0)×0.50 = 0.2643
(the mean includes the error trial's cost; the `n` excludes it). Contract: `b-model/high` rate
0.833 < 1.0 floor → ineligible; `a-model/high` = 0.90. n-bis with the record: three trials
at 0.01 and six rows at 0.02 → mean 0.0167, n 9.

- [ ] **Step 2: Run the suite to verify the new checks fail** — Expected `exit=1`.

- [ ] **Step 3: Implement** (register `calibrate`)

```python
# --- calibration --------------------------------------------------------------------

MIN_TRIALS = 6


def floors():
    cfg = read_json(os.path.join(ROUTING_DIR, "config.json"), {}).get("floor", {})
    return float(cfg.get("default", 0.9)), float(cfg.get("strict", 1.0))


def read_trials(path):
    out = []
    if not os.path.isfile(path):
        return out
    with open(path) as fh:
        for n, line in enumerate(fh, 1):
            try:
                t = json.loads(line)
                parse_pair(t["pair"])
                out.append(t)
            except (ValueError, KeyError, SystemExit):
                warn("%s:%d does not read as a trial, skipped" % (path, n))
    return out


def record_trials(record):
    """A closed pair row graded by the record's own signals: one round and no escaped
    defect is a pass. Rows without a measured cost are left out.
    """
    out = []
    for line in open(record):
        if not line.strip():
            continue
        r = json.loads(line)
        if r.get("state") != "closed" or not r.get("model") or not r.get("effort"):
            continue
        if r.get("cost_incomplete") or not r.get("cost_usd"):
            continue
        ok = r.get("rounds", 0) <= 1 and not r.get("escaped")
        out.append({"class": r["class"], "pair": "%s/%s" % (r["model"], r["effort"]),
                    "cost_usd": r["cost_usd"], "models": {}, "status": "pass" if ok else "fail"})
    return out


def stats_of(trials):
    stats = {}
    for t in trials:
        s = stats.setdefault(t["pair"], {"n": 0, "passes": 0, "costs": [], "models": set()})
        s["costs"].append(float(t.get("cost_usd") or 0))
        s["models"].update((t.get("models") or {}).keys())
        if t.get("status") in ("pass", "fail"):
            s["n"] += 1
            s["passes"] += t["status"] == "pass"
    return stats


def select_entry(cls, stats, floor):
    ladder = []
    for pair, s in stats.items():
        mean = sum(s["costs"]) / len(s["costs"]) if s["costs"] else 0.0
        rate = s["passes"] / s["n"] if s["n"] else 0.0
        ladder.append({"pair": pair, "n": s["n"], "pass_rate": round(rate, 4), "cost_usd": round(mean, 6),
                       "eligible": s["n"] >= MIN_TRIALS and rate >= floor, "models": sorted(s["models"])})
    ladder.sort(key=lambda r: (r["cost_usd"], r["pair"]))
    for i, r in enumerate(ladder):
        # A failure in production is paid by an escalation: the next pair up, or a retry.
        up = ladder[i + 1]["cost_usd"] if i + 1 < len(ladder) else r["cost_usd"]
        r["expected_usd"] = round(r["cost_usd"] + (1 - r["pass_rate"]) * up, 6)
    eligible = [r for r in ladder if r["eligible"]]
    if not eligible:
        return None
    best = min(eligible, key=lambda r: (r["expected_usd"], -r["pass_rate"]))
    return {"pair": best["pair"], "pass_rate": best["pass_rate"], "n": best["n"],
            "cost_usd": best["cost_usd"], "expected_usd": best["expected_usd"], "floor": floor,
            "models": best["models"],
            "ladder": [{k: v for k, v in r.items() if k != "models"} for r in ladder]}


def build_table(scope, trials):
    default, strict = floors()
    entries, lines = {}, []
    for cls in sorted({t["class"] for t in trials}):
        floor = strict if cls in STRICT_CLASSES else default
        entry = select_entry(cls, stats_of([t for t in trials if t["class"] == cls]), floor)
        if entry:
            entries[cls] = entry
            lines.append("class=%s pair=%s pass_rate=%s n=%d expected_usd=%s"
                         % (cls, entry["pair"], entry["pass_rate"], entry["n"],
                            round(entry["expected_usd"], 4)))
        else:
            lines.append("class=%s no eligible pair" % cls)
    return {"scope": scope, "generated": datetime.date.today().isoformat(), "entries": entries}, lines


def cmd_calibrate(argv):
    p = argparse.ArgumentParser(prog="calibrate")
    p.add_argument("slug")
    p.add_argument("--from-record", dest="records", action="append", default=[])
    a = p.parse_args(argv)
    trials = read_trials(os.path.join(ROUTING_DIR, "projects", a.slug, "trials.jsonl"))
    for rec in a.records:
        trials += record_trials(rec)
    if not trials:
        die("calibrate: no trial and no record row for %s" % a.slug)
    table, lines = build_table("project:" + a.slug, trials)
    write_json(table_path("project:" + a.slug), table)
    print("\n".join(lines))
```

Printed `pass_rate` uses Python's float repr: `1.0`. `expected_usd` prints `round(x, 4)`:
`0.2643`, `0.9`, `0.0167`.

- [ ] **Step 4: Run the suite** — Expected `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add skills/model-routing/scripts/routing.py tests/run-tests.sh
git commit -m "feat(routing): calibrate a project's table from trials and record rows" -m "A pair is chosen only when enough trials show it reliable, and among those by the cost a dispatch is expected to reach once its failures are paid by an escalation; work nothing re-checks is held to a floor of 1.0."
```

### Task 6: the skill, rewritten around pairs

**Files:**
- Modify: `skills/model-routing/SKILL.md`
- Create: `skills/model-routing/references/calibration.md`
- Modify: `evals/picks-a-model-when-the-tier-is-unbound/prompt.md` and its graders, only if
  they assert a sentence this task removes
- Modify: `tests/run-tests.sh` (presence checks for the new rules, in the style of
  `spells`)

**Interfaces:**
- Consumes: `routing.py pick`, `calibrate --from-record`, `dispatch-record.sh open --model
  --effort --explore`, `cost`, `summary` lines `frozen=` / `promote=` (Tasks 3-5).

- [ ] **Step 1: Write the failing presence checks**

```bash
MR="$ROOT/skills/model-routing/SKILL.md"
check "the skill picks a pair through routing.py pick" "yes" "$(spells "$MR" 'routing.py pick --repo')"
check "the skill records each session's cost" "yes" "$(spells "$MR" 'dispatch-record.sh cost')"
check "the skill bounds exploration to one notch" "yes" "$(spells "$MR" 'one notch')"
check "the skill names what is never explored" "yes" "$(carries "$MR" 'never explored')"
check "the skill points at the calibration reference" "yes" "$(spells "$MR" 'references/calibration.md')"
check "the skill keeps the budget out of the choice" "yes" "$(carries "$MR" 'never read the subscription gauge to choose')"
```

- [ ] **Step 2: Run the suite** — Expected those checks FAIL.

- [ ] **Step 3: Rewrite the skill**

Keep the frontmatter, the opening « decision aid » paragraph (add « the pair » next to
« the tier »), « The principle », the five readings, the false economy, the second reader,
and the record section's existing commands. Change:

- **Tiers and the map** → **Pairs, tiers and the map**: a dispatch runs on a pair
  `<alias>/<effort>`; a tier may bind `{"model": "<alias>", "effort": "<level>"}`; `spawn
  --effort` sets it; an alias is always the family's, never a versioned identifier.
- New section **Where the pair comes from**, verbatim:

  ```
  Before each dispatch, run `routing.py pick --repo <checkout> --class <class> --record <record>`
  (`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/scripts/routing.py`). It prints the pair and the
  table it came from — the project's, its profile's, the global one, a shipped default, or the
  tier table below. Write the pair, its source and your reason in the brief. You may override it:
  say why. An entry marked `stale` was measured on a model the alias no longer resolves to; use
  it, and tell the operator in one line that a bench run would refresh it.
  ```
- **The table** keeps its rows; its header says it is the floor `pick` lands on when nothing
  is measured, and each class gets its slug in backticks (`behaviour-phase`, `contract-phase`,
  … exactly the keys of `CLASS_TIERS`).
- New section **Explore one notch, never more**: `pick` prints `explore=<pair>` when the
  record shows three one-round closes at the class's pair and no escaped defect; take it only
  when the five readings show at most one high; open the row `--explore`; the orchestrator,
  a successor, a decision round, a contract-defining phase and the final verification are
  never explored; `summary` prints `frozen=<class>` after a failed exploration — no more
  exploration of that class this build — and `promote=<class> <pair>` after three clean ones —
  dispatch the class on that pair, and fold it into the table with `routing.py calibrate
  <slug> --from-record <record>`. State how this differs from a cascade: a cascade retries the
  same work one tier below and is forbidden on phases; an exploration dispatches the work
  once, at the lower pair, and its failure is paid by the normal correction round.
- **Escalate** keeps its triggers; « one tier up » becomes « one notch up the class's
  ladder ».
- **The record**: add `open … --model <alias> --effort <level> [--explore]` and
  `dispatch-record.sh cost <record> <id> --session <session id>` after each session of the
  dispatch ends (its id is the one the spawn verified), and the summary's `cost_avg`,
  `frozen=`, `promote=` lines.
- One sentence in the principle: « The cost that ranks pairs is the measured cost of a
  dispatch closed to satisfaction, its corrective rounds included; never read the
  subscription gauge to choose. »
- Pointer: « How the tables are measured, generalised and exported: `references/calibration.md`. »

`references/calibration.md`: the bench workflow in operator order — `harvest`, review each
brief and `ready` it, set the manifest's `test_command` and `test_globs`, `bench <slug>
--max-usd <n>` (the operator gives the cap), `calibrate`, `generalize`, `show`, `export` —
each with one paragraph from the spec's sections 3 and 4, and the reliability floors.

Read `evals/picks-a-model-when-the-tier-is-unbound/` and every `trigger-evals/model-routing-*`
prompt; change a grader only where it asserts a sentence removed above, and say which in the
commit body.

- [ ] **Step 4: Run the suite** — Expected `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add skills/model-routing evals trigger-evals tests/run-tests.sh
git commit -m "docs(model-routing): route on measured pairs, explore one notch at most" -m "The skill chose a tier from a table nobody measured. It now reads the pair from the most specific measured table, records what each dispatch cost, and lowers a class's pair only after clean closes and only where something re-checks the work."
```

---

## Phase 3 — The bench (one pull request)

### Task 7: the manifest, `harvest` and `ready`

**Files:**
- Modify: `skills/model-routing/scripts/routing.py`
- Create: `tests/fixtures/routing/gh-stub.sh`
- Modify: `tests/run-tests.sh` (new section `== routing: bench ==`, shared fixture repo)

**Interfaces:**
- Produces: `routing.py harvest <repo> --class <c> --pr <n> [--pr <n>]... [--test-command
  <cmd>] [--test-glob <glob>]... [--budget-usd <x>]` → creates or extends
  `projects/<slug>/manifest.json` and `briefs/pr-<n>.md`; prints `harvested pr-<n> (draft)`.
- Produces: `routing.py ready <slug> <task-id>...` → marks tasks `ready`.
- Produces the manifest format:
  `{"slug","repo","profile","test_command","test_globs":[...],"budget_usd":2.0,
  "tasks":[{"id":"pr-<n>","pr":n,"class","base","merged","brief":"briefs/pr-<n>.md","status":"draft|ready"}]}`.
- Produces: `make_bench_repo` shell function in the test suite (used by Tasks 8-10).

- [ ] **Step 1: Write the stub, the fixture repo and the failing tests**

`tests/fixtures/routing/gh-stub.sh` (answers `gh pr view <n> --json ...` from env):

```bash
#!/bin/bash
# A forge stub: `pr view <n> --json title,body,mergeCommit` answers from STUB_MERGE.
[ "$1 $2" = "pr view" ] || { echo "stub: unsupported: $*" >&2; exit 1; }
printf '{"title":"Add the greeting","body":"Make hello print a greeting.\\n\\n```diff\\n+secret\\n```\\nDone.","mergeCommit":{"oid":"%s"}}\n' "$STUB_MERGE"
```

In `tests/run-tests.sh`:

```bash
echo "== routing: bench =="

# A project whose merged change makes hello.sh greet, with a test the merge added.
make_bench_repo() {
  local d="$1"; mkdir -p "$d/tests"
  git -C "$d" init -q
  printf '#!/bin/bash\necho hi\n' > "$d/hello.sh"
  printf '#!/bin/bash\n[ "$(bash hello.sh)" = "hi" ]\n' > "$d/tests/old.sh"
  git -C "$d" add -A; git -C "$d" -c user.name=t -c user.email=t@t commit -qm base
  printf '#!/bin/bash\necho hello world\n' > "$d/hello.sh"
  printf '#!/bin/bash\n[ "$(bash hello.sh)" = "hello world" ]\n' > "$d/tests/greet.sh"
  rm "$d/tests/old.sh"
  git -C "$d" add -A; git -C "$d" -c user.name=t -c user.email=t@t commit -qm merged
}
BR="$WORK/benchrepo"; make_bench_repo "$BR"
BASE=$(git -C "$BR" rev-parse HEAD~1); MERGED=$(git -C "$BR" rev-parse HEAD)
BS="$WORK/bstate"; mkdir -p "$BS"
rbench() { ORCHESTRATOR_STATE_DIR="$BS" ORCHESTRATOR_GH="$ROOT/tests/fixtures/routing/gh-stub.sh" STUB_MERGE="$MERGED" python3 "$ROUTING" "$@"; }
check "harvest drafts a task from a merged pull request" "harvested pr-7 (draft)" \
  "$(rbench harvest "$BR" --class behaviour-phase --pr 7 --test-command 'for t in tests/*.sh; do bash "$t" || exit 1; done' --test-glob 'tests/*')"
BM="$BS/routing/projects/benchrepo/manifest.json"
check "the task carries base and merge" "$BASE|$MERGED|draft|behaviour-phase" \
  "$(jq -r '.tasks[0]|[.base,.merged,.status,.class]|join("|")' "$BM")"
check "the brief keeps the description and drops fenced code" "0|1" \
  "$(grep -c secret "$BS/routing/projects/benchrepo/briefs/pr-7.md")|$(grep -c 'Make hello print a greeting.' "$BS/routing/projects/benchrepo/briefs/pr-7.md")"
check "harvesting the same pull request twice keeps one task" "1" \
  "$(rbench harvest "$BR" --class behaviour-phase --pr 7 >/dev/null; jq '.tasks|length' "$BM")"
rbench ready benchrepo pr-7 >/dev/null
check "ready marks the task" "ready" "$(jq -r '.tasks[0].status' "$BM")"
check_status "ready refuses an unknown task" 1 rbench ready benchrepo pr-99
```

- [ ] **Step 2: Run** — Expected the new checks FAIL.

- [ ] **Step 3: Implement** (register `harvest`, `ready`)

```python
# --- bench: manifest ----------------------------------------------------------------

FENCE = re.compile(r"```.*?```", re.S)


def load_manifest(slug):
    m = read_json(manifest_path(slug), None)
    if m is None:
        die("no manifest for project %s (harvest one first)" % slug)
    return m


def git(repo, *args):
    r = subprocess.run(["git", "-C", repo] + list(args), capture_output=True, text=True)
    if r.returncode != 0:
        die("git %s failed in %s: %s" % (" ".join(args), repo, r.stderr.strip()))
    return r.stdout.strip()


def cmd_harvest(argv):
    p = argparse.ArgumentParser(prog="harvest")
    p.add_argument("repo")
    p.add_argument("--class", dest="cls", required=True)
    p.add_argument("--pr", action="append", type=int, required=True)
    p.add_argument("--test-command")
    p.add_argument("--test-glob", action="append", default=[])
    p.add_argument("--budget-usd", type=float)
    a = p.parse_args(argv)
    if a.cls not in CLASS_TIERS:
        die("harvest: unknown class: %s" % a.cls)
    repo = git_top(a.repo)
    slug = project_slug(repo)
    m = read_json(manifest_path(slug), None) or {
        "slug": slug, "repo": repo, "profile": infer_profile(repo), "test_command": "",
        "test_globs": [], "budget_usd": 2.0, "tasks": []}
    if a.test_command:
        m["test_command"] = a.test_command
    if a.test_glob:
        m["test_globs"] = a.test_glob
    if a.budget_usd:
        m["budget_usd"] = a.budget_usd
    for pr in a.pr:
        r = subprocess.run([GH_CLI, "pr", "view", str(pr), "--json", "title,body,mergeCommit"],
                           cwd=repo, capture_output=True, text=True)
        if r.returncode != 0:
            die("harvest: the forge did not answer for pull request %d: %s" % (pr, r.stderr.strip()))
        info = json.loads(r.stdout)
        merged = (info.get("mergeCommit") or {}).get("oid")
        if not merged:
            die("harvest: pull request %d is not merged" % pr)
        base = git(repo, "rev-parse", merged + "^1")
        tid = "pr-%d" % pr
        brief = "briefs/%s.md" % tid
        body = FENCE.sub("", info.get("body") or "").strip()
        path = os.path.join(ROUTING_DIR, "projects", slug, brief)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write("# %s\n\n%s\n\nWork in the current directory. Run the project's tests "
                     "before you finish.\n" % (info.get("title", ""), body))
        m["tasks"] = [t for t in m["tasks"] if t["id"] != tid] + [{
            "id": tid, "pr": pr, "class": a.cls, "base": base, "merged": merged,
            "brief": brief, "status": "draft"}]
        print("harvested %s (draft)" % tid)
    write_json(manifest_path(slug), m)


def cmd_ready(argv):
    if len(argv) < 2:
        die("ready: a project and at least one task id are required")
    m = load_manifest(argv[0])
    ids = {t["id"] for t in m["tasks"]}
    for tid in argv[1:]:
        if tid not in ids:
            die("ready: no task %s in %s" % (tid, argv[0]))
    for t in m["tasks"]:
        if t["id"] in argv[1:]:
            t["status"] = "ready"
    write_json(manifest_path(argv[0]), m)
    print("ready: %s" % " ".join(argv[1:]))
```

- [ ] **Step 4: Run** — Expected `exit=0`.
- [ ] **Step 5: Commit**

```bash
git add skills/model-routing/scripts/routing.py tests/fixtures/routing/gh-stub.sh tests/run-tests.sh
git commit -m "feat(routing): harvest bench tasks from merged pull requests" -m "The bench replays real work only. A task is a merged pull request, its brief drawn from the description with any code stripped, and it enters a run only once the orchestrator has read and readied it."
```

### Task 8: one trial — isolation, run, hidden tests, judge, record

**Files:**
- Modify: `skills/model-routing/scripts/routing.py`
- Create: `skills/model-routing/references/judge-rubric.md`
- Create: `tests/fixtures/routing/host-stub.sh`
- Modify: `tests/run-tests.sh` (section `== routing: bench ==`)

**Interfaces:**
- Consumes: the manifest (Task 7), `read_map()` (Task 4).
- Produces: `run_trial(manifest, task, pair, rep, tmp_root) -> trial dict` (format in
  Task 5's Interfaces) and the hidden `routing.py trial <slug> <task-id> <pair> [--rep n]`
  that runs exactly one trial and appends it (the tests' entry point; `bench` in Task 9
  calls `run_trial` directly).
- Produces: `config.json` key `modes`: `{"<alias>": "acceptEdits"}`; default mode `auto`.

- [ ] **Step 1: Write the host stub and the failing tests**

`tests/fixtures/routing/host-stub.sh` — behaves as the headless host. The agent's
behaviour is chosen by effort: `low` writes a wrong greeting, any other writes the right
one; `max` hits the budget; `STUB_JUDGE` (`pass`, `fail`, `garbage`) shapes the judge. It
also proves isolation by recording what the agent could reach.

```bash
#!/bin/bash
# A headless-host stub. Agent runs edit hello.sh by effort; judge runs answer from STUB_JUDGE.
model=""; effort=""
while [ $# -gt 0 ]; do
  case "$1" in --model) model="$2"; shift 2 ;; --effort) effort="$2"; shift 2 ;; *) shift ;; esac
done
prompt=$(cat)
usage() { printf '{"type":"result","subtype":"%s","is_error":%s,"result":%s,"modelUsage":{"%s-1":{"costUSD":%s}}}\n' "$1" "$2" "$3" "$model" "$4"; }
if printf '%s' "$prompt" | grep -q 'JUDGE-RUBRIC'; then
  case "${STUB_JUDGE:-pass}" in
    pass) usage success false '"{\"verdict\":\"pass\",\"scores\":{\"scope\":5},\"reasons\":[]}"' 0.02 ;;
    fail) usage success false '"{\"verdict\":\"fail\",\"scores\":{\"scope\":1},\"reasons\":[\"off scope\"]}"' 0.02 ;;
    *) usage success false '"not json at all"' 0.02 ;;
  esac
  exit 0
fi
git log --all --oneline 2>/dev/null | wc -l | tr -d ' ' > .reachable-commits
[ -n "${STUB_MERGED:-}" ] && { git cat-file -e "$STUB_MERGED" 2>/dev/null && echo yes || echo no; } > .merged-reachable
case "$effort" in
  max) usage error_max_budget_usd true '""' 0.40; exit 0 ;;
  low) printf '#!/bin/bash\necho hello\n' > hello.sh ;;
  *) printf '#!/bin/bash\necho hello world\n' > hello.sh ;;
esac
usage success false '"done"' 0.10
```

Tests (after Task 7's):

```bash
chmod +x "$ROOT/tests/fixtures/routing/host-stub.sh"
printf '{"deep":"a-model","standard":"b-model","light":"c-model"}' > "$BS/models.json"
rtrial() { ORCHESTRATOR_STATE_DIR="$BS" ORCHESTRATOR_HOST_CLI="$ROOT/tests/fixtures/routing/host-stub.sh" STUB_MERGED="$MERGED" TMPDIR="$WORK" python3 "$ROUTING" trial benchrepo pr-7 "$@"; }
BT="$BS/routing/projects/benchrepo/trials.jsonl"
rtrial b-model/medium --keep >/dev/null
last() { tail -1 "$BT" | jq -r "$1"; }
check "a right change passes the hidden tests and the judge" "pass|pass|pass|0.1|0.02" \
  "$(last '[.mech,.judge,.status,.cost_usd,.judge_cost_usd]|map(tostring)|join("|")')"
KEPT=$(last '.dir')
check "the agent saw one commit and no history" "1|no" "$(cat "$KEPT/.reachable-commits")|$(cat "$KEPT/.merged-reachable")"
check "the hidden test is in place, the deleted one is gone" "yes|no" \
  "$([ -f "$KEPT/tests/greet.sh" ] && echo yes || echo no)|$([ -f "$KEPT/tests/old.sh" ] && echo yes || echo no)"
rtrial b-model/low >/dev/null
check "a wrong change fails mechanically and is never judged" "fail|null|fail|0" \
  "$(last '[.mech,.judge,.status,.judge_cost_usd]|map(tostring)|join("|")')"
STUB_JUDGE=fail rtrial b-model/high >/dev/null
check "a judge's fail is the trial's fail" "pass|fail|fail" "$(last '[.mech,.judge,.status]|join("|")')"
STUB_JUDGE=garbage rtrial b-model/high >/dev/null
check "a judge that does not answer JSON makes an error, cost kept" "error|0.1" "$(last '[.status,.cost_usd]|map(tostring)|join("|")')"
rtrial b-model/max >/dev/null
check "an agent stopped by its budget is an error with its cost" "error|0.4" "$(last '[.status,.cost_usd]|map(tostring)|join("|")')"
check "the trial records the identifiers used and the alias they resolve" "b-model-1|b-model-1" \
  "$(last '.models|keys|join(",")')|$(jq -r '.["b-model"]' "$BS/routing/aliases.json")"
check "trial directories are removed unless kept" "1" "$(ls -d "$WORK"/trial-* 2>/dev/null | wc -l | tr -d ' ')"
rbench harvest "$BR" --class behaviour-phase --pr 8 >/dev/null
check "a draft task is refused" "ERROR: trial: task pr-8 is still a draft" \
  "$(env ORCHESTRATOR_STATE_DIR="$BS" python3 "$ROUTING" trial benchrepo pr-8 b-model/medium 2>&1)"
check_status "an unknown task is refused" 1 env ORCHESTRATOR_STATE_DIR="$BS" python3 "$ROUTING" trial benchrepo pr-404 b-model/medium
```

- [ ] **Step 2: Run** — Expected the new checks FAIL.

- [ ] **Step 3: Write the rubric**

`skills/model-routing/references/judge-rubric.md` — first line the literal marker
`JUDGE-RUBRIC` (the stub keys on it; it is harmless to a real judge). Then: the judge is
given the brief, the agent's diff, the merged diff as a reference that the agent's change
need not match line for line, and the test output; it grades five criteria from 1 to 5 —
`scope` (did exactly what the brief asked, nothing it did not), `correctness` (behaviour
right beyond what the tests cover), `conventions` (reads like the surrounding code),
`tests` (added or updated where the reference did), `safety` (nothing destructive,
nothing left behind) — and answers ONLY a JSON object
`{"verdict": "pass"|"fail", "scores": {<criterion>: 1-5}, "reasons": [<one line per criterion under 4>]}`.
`verdict` is `pass` only when every criterion scores 4 or more.

- [ ] **Step 4: Implement** (register `trial`)

```python
# --- bench: one trial -----------------------------------------------------------------

RUBRIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "references", "judge-rubric.md")
TRIAL_TIMEOUT = int(os.environ.get("ORCHESTRATOR_TRIAL_TIMEOUT", "1800"))


def isolate(repo, base, root):
    """The tree at base and NO history: an agent that can read the merged commit is
    grading itself against the answer.
    """
    d = tempfile.mkdtemp(prefix="trial-", dir=root)
    archive = subprocess.run(["git", "-C", repo, "archive", base], capture_output=True, check=True)
    subprocess.run(["tar", "-x", "-C", d], input=archive.stdout, check=True)
    for args in (["init", "-q"], ["add", "-A"],
                 ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "-qm", "base"]):
        subprocess.run(["git", "-C", d] + args, check=True, capture_output=True)
    return d


def mode_for(alias):
    return read_json(os.path.join(ROUTING_DIR, "config.json"), {}).get("modes", {}).get(alias, "auto")


def host(pair, prompt, cwd, budget, mode):
    model, effort = parse_pair(pair)
    cmd = [HOST_CLI, "-p", "--model", model, "--effort", effort, "--permission-mode", mode,
           "--output-format", "json", "--no-session-persistence", "--max-budget-usd", "%.2f" % budget]
    try:
        r = subprocess.run(cmd, input=prompt, cwd=cwd, capture_output=True, text=True, timeout=TRIAL_TIMEOUT)
        res = json.loads(r.stdout.strip().splitlines()[-1])
    except (subprocess.TimeoutExpired, ValueError, IndexError):
        return {"ok": False, "models": {}, "cost": 0.0, "text": ""}
    models = {k: float(v.get("costUSD") or 0) for k, v in (res.get("modelUsage") or {}).items()}
    cost = sum(models.values()) if models else float(res.get("total_cost_usd") or 0)
    ok = not res.get("is_error") and res.get("subtype") == "success"
    return {"ok": ok, "models": models, "cost": cost, "text": res.get("result") or ""}


def overlay_hidden_tests(repo, base, merged, d, globs):
    for line in git(repo, "diff", "--name-status", base, merged).splitlines():
        status, path = line.split("\t", 1)
        path = path.split("\t")[-1]
        if not any(fnmatch.fnmatch(path, g) for g in globs):
            continue
        target = os.path.join(d, path)
        if status.startswith("D"):
            if os.path.exists(target):
                os.remove(target)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        blob = subprocess.run(["git", "-C", repo, "show", "%s:%s" % (merged, path)], capture_output=True, check=True)
        with open(target, "wb") as fh:
            fh.write(blob.stdout)


def judge(task, brief, agent_diff, ref_diff, tests_out, d):
    deep = read_map().get("deep")
    pair = "%s/%s" % (deep[0], deep[1] or "high") if deep else None
    if not pair:
        die("bench: the deep tier is unbound: the judge has no model")
    prompt = "%s\n\n## Brief\n%s\n\n## Agent diff\n%s\n\n## Reference diff\n%s\n\n## Test output\n%s\n" % (
        open(RUBRIC).read(), brief, agent_diff, ref_diff, tests_out[-4000:])
    out = host(pair, prompt, d, 2.0, mode_for(deep[0]))
    try:
        verdict = json.loads(out["text"])["verdict"]
        if verdict not in ("pass", "fail"):
            raise ValueError
        return verdict, out["cost"]
    except (ValueError, KeyError, TypeError):
        return None, out["cost"]


def run_trial(m, task, pair, rep, root, keep=False):
    repo = m["repo"]
    brief = open(os.path.join(ROUTING_DIR, "projects", m["slug"], task["brief"])).read()
    d = isolate(repo, task["base"], root)
    trial = {"task": task["id"], "class": task["class"], "pair": pair, "rep": rep,
             "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "quota_before": quota_reading(), "judge": None, "judge_cost_usd": 0}
    try:
        agent = host(pair, brief, d, float(m.get("budget_usd") or 2.0), mode_for(pair.split("/")[0]))
        trial.update(models=agent["models"], cost_usd=round(agent["cost"], 6))
        note_alias(pair.split("/")[0], agent["models"])
        if not agent["ok"]:
            trial.update(mech="error", status="error")
            return trial
        subprocess.run(["git", "-C", d, "add", "-A"], check=True)
        agent_diff = subprocess.run(["git", "-C", d, "diff", "--cached", "HEAD"], capture_output=True, text=True).stdout
        overlay_hidden_tests(repo, task["base"], task["merged"], d, m["test_globs"])
        t = subprocess.run(["bash", "-c", m["test_command"]], cwd=d, capture_output=True, text=True, timeout=TRIAL_TIMEOUT)
        trial["mech"] = "pass" if t.returncode == 0 else "fail"
        if trial["mech"] == "fail":
            trial["status"] = "fail"
            return trial
        verdict, jcost = judge(task, brief, agent_diff, git(repo, "diff", task["base"], task["merged"]),
                               t.stdout + t.stderr, d)
        trial.update(judge=verdict, judge_cost_usd=round(jcost, 6),
                     status="error" if verdict is None else verdict)
        return trial
    finally:
        trial["quota_after"] = quota_reading()
        if keep:
            trial["dir"] = d
        else:
            shutil.rmtree(d, ignore_errors=True)


def quota_reading():
    """The subscription gauge, as a control only: recorded, never acted on. Null unless a
    source file is named and readable.
    """
    path = os.environ.get("ORCHESTRATOR_QUOTA_FILE")
    return read_json(path, None) if path else None


def append_trial(slug, trial):
    path = os.path.join(ROUTING_DIR, "projects", slug, "trials.jsonl")
    with open(path, "a") as fh:
        fh.write(json.dumps(trial, sort_keys=True) + "\n")


def runnable(m, tid):
    if not m.get("test_command") or not m.get("test_globs"):
        die("bench: project %s has no test_command or test_globs in its manifest" % m["slug"])
    task = next((t for t in m["tasks"] if t["id"] == tid), None)
    if task is None:
        die("trial: no task %s in %s" % (tid, m["slug"]))
    if task["status"] != "ready":
        die("trial: task %s is still a draft" % tid)
    return task


def cmd_trial(argv):
    p = argparse.ArgumentParser(prog="trial")
    p.add_argument("slug"); p.add_argument("task"); p.add_argument("pair")
    p.add_argument("--rep", type=int, default=1)
    p.add_argument("--keep", action="store_true")
    a = p.parse_args(argv)
    parse_pair(a.pair)
    m = load_manifest(a.slug)
    trial = run_trial(m, runnable(m, a.task), a.pair, a.rep, tempfile.gettempdir(), a.keep)
    append_trial(a.slug, trial)
    print("trial %s %s rep %d: %s cost_usd=%s" % (a.task, a.pair, a.rep, trial["status"], trial["cost_usd"]))
```

Note the tests' `rtrial` sets `TMPDIR="$WORK"` so `tempfile.gettempdir()` puts trial
directories where the "removed unless kept" check counts them (one kept trial remains).

- [ ] **Step 5: Run** — Expected `exit=0`.
- [ ] **Step 6: Commit**

```bash
git add skills/model-routing tests/fixtures/routing/host-stub.sh tests/run-tests.sh
git commit -m "feat(routing): run one bench trial against hidden tests and a judge" -m "A trial sees the tree at the merge's parent and no history, so the answer is out of reach; the merge's own tests are laid over its work afterwards, and only a mechanical pass reaches the judge. The cost is the host's own list-price figure per model."
```

### Task 9: `bench` — the grid, screening, confirmation, budget, resume

**Files:**
- Modify: `skills/model-routing/scripts/routing.py`
- Modify: `tests/run-tests.sh`

**Interfaces:**
- Consumes: `run_trial`, `append_trial`, `runnable`, `read_trials`, `tier_order` (Tasks
  4-8).
- Produces: `routing.py bench <slug> --max-usd <x> [--grid <pair>,...] [--families
  <a>,<b>] [--reps 2] [--concurrency 2] [--class <c>]`; prints one line per trial and a last
  line `bench: spent=<usd> trials=<n> unmeasured=<n>`.

- [ ] **Step 1: Write the failing tests**

```bash
rbench harvest "$BR" --class behaviour-phase --pr 9 >/dev/null; rbench ready benchrepo pr-7 pr-8 pr-9 >/dev/null
: > "$BT"
rb() { ORCHESTRATOR_STATE_DIR="$BS" ORCHESTRATOR_HOST_CLI="$ROOT/tests/fixtures/routing/host-stub.sh" TMPDIR="$WORK" python3 "$ROUTING" bench benchrepo "$@"; }
check_status "bench wants a cap" 2 rb --grid b-model/medium
out=$(rb --grid b-model/low,b-model/medium,c-model/medium --max-usd 100 --reps 2 --concurrency 1)
check "screening runs every pair on two tasks" "6" "$(jq -s '[.[]|select(.rep==1)]|map(.task+.pair)|unique|map(select(startswith("pr-7") or startswith("pr-8")))|length' "$BT")"
check "a pair that failed screening is not confirmed" "0" "$(jq -s '[.[]|select(.pair=="b-model/low" and .task=="pr-9")]|length' "$BT")"
check "confirmation runs every task at every rep" "6|3" \
  "$(jq -s '[.[]|select(.pair=="b-model/medium")]|length' "$BT")|$(jq -s '[.[]|select(.pair=="b-model/medium")]|map(.task)|unique|length' "$BT")"
before=$(wc -l < "$BT")
rb --grid b-model/low,b-model/medium,c-model/medium --max-usd 100 --reps 2 --concurrency 1 >/dev/null
check "a restart re-pays nothing already measured" "$before" "$(wc -l < "$BT" | tr -d ' ')"
: > "$BT"
out=$(rb --grid b-model/medium,c-model/medium --max-usd 0.15 --concurrency 1)
check "the cap stops new trials and says what is left" "1" "$(printf '%s\n' "$out" | tail -1 | grep -c '^bench: spent=0.24 trials=2 unmeasured=6$')"
# An error recorded by an earlier run counts: two more in screening make three.
printf '{"task":"pr-9","class":"behaviour-phase","pair":"b-model/max","rep":1,"cost_usd":0.4,"status":"error"}\n' > "$BT"
rb --grid b-model/max,b-model/medium --max-usd 100 --concurrency 1 2>"$WORK/bench.err" >/dev/null
check "three errors drop a pair, and the bench says so" "1" "$(grep -c 'dropping b-model/max after 3 errors' "$WORK/bench.err")"
```

The confirmation check reads: `b-model/medium` and `c-model/medium` pass both screening
trials at the same cost and are confirmed; confirmation adds pr-9 rep 1 and every task's rep
2 → 6 trials per confirmed pair, 3 tasks. The cap: the first trial costs 0.12 (0.10 agent +
0.02 judge) < 0.15, so the second starts and brings the spend to 0.24; nothing else starts —
2 screening trials and 4 confirmation trials of `b-model/medium` stay unmeasured.

- [ ] **Step 2: Run** — Expected FAIL.

- [ ] **Step 3: Implement** (register `bench`)

```python
# --- bench: the grid ------------------------------------------------------------------

def grid_of(a):
    if a.grid:
        pairs = a.grid.split(",")
        for pr in pairs:
            parse_pair(pr)
        return pairs
    families = a.families.split(",") if a.families else tier_order()
    if not families:
        die("bench: no family bound in the tier map; name them with --families")
    return ["%s/%s" % (f, e) for f in families for e in EFFORTS]


def cmd_bench(argv):
    import concurrent.futures as cf
    p = argparse.ArgumentParser(prog="bench")
    p.add_argument("slug")
    p.add_argument("--max-usd", type=float, required=True)
    p.add_argument("--grid"); p.add_argument("--families")
    p.add_argument("--reps", type=int, default=2)
    p.add_argument("--concurrency", type=int, default=2)
    p.add_argument("--class", dest="cls")
    a = p.parse_args(argv)
    m = load_manifest(a.slug)
    pairs = grid_of(a)
    done = {(t["task"], t["pair"], t.get("rep", 1)): t
            for t in read_trials(os.path.join(ROUTING_DIR, "projects", a.slug, "trials.jsonl"))}
    state = {"spent": 0.0, "trials": 0, "errors": {}, "dropped": set()}
    for t in done.values():
        # Errors survive a restart: a pair that keeps failing to run is not retried forever.
        if t.get("status") == "error":
            state["errors"][t["pair"]] = state["errors"].get(t["pair"], 0) + 1

    def run(jobs):
        """Jobs in order; a job already in trials.jsonl is reused, never re-paid."""
        results = {}
        todo = []
        for job in jobs:
            if job in done:
                results[job] = done[job]
            else:
                todo.append(job)
        with cf.ThreadPoolExecutor(max_workers=max(1, a.concurrency)) as pool:
            running = {}
            queue = list(todo)
            while queue or running:
                while queue and len(running) < a.concurrency and state["spent"] < a.max_usd:
                    task_id, pair, rep = queue.pop(0)
                    if pair in state["dropped"]:
                        continue
                    task = runnable(m, task_id)
                    running[pool.submit(run_trial, m, task, pair, rep, tempfile.gettempdir())] = (task_id, pair, rep)
                if not running:
                    break
                fut = next(cf.as_completed(running))
                job = running.pop(fut)
                t = fut.result()
                append_trial(a.slug, t)
                done[job] = results[job] = t
                state["spent"] += t["cost_usd"] + t.get("judge_cost_usd", 0)
                state["trials"] += 1
                print("trial %s %s rep %d: %s cost_usd=%s" % (job[0], job[1], job[2], t["status"], t["cost_usd"]))
                if t["status"] == "error":
                    state["errors"][job[1]] = state["errors"].get(job[1], 0) + 1
                    if state["errors"][job[1]] >= 3 and job[1] not in state["dropped"]:
                        state["dropped"].add(job[1])
                        warn("bench: dropping %s after 3 errors" % job[1])
        return results, len(queue)

    unmeasured = 0
    by_class = {}
    for t in m["tasks"]:
        if t["status"] == "ready" and (not a.cls or t["class"] == a.cls):
            by_class.setdefault(t["class"], []).append(t["id"])
    for cls, tasks in sorted(by_class.items()):
        screen = [(tid, pr, 1) for pr in pairs for tid in tasks[:2]]
        res, left = run(screen)
        unmeasured += left
        passing = [pr for pr in pairs if all(res.get((tid, pr, 1), {}).get("status") == "pass" for tid in tasks[:2])]
        if not passing:
            continue
        cost = lambda pr: sum(res[(tid, pr, 1)]["cost_usd"] for tid in tasks[:2])
        cheapest = min(cost(pr) for pr in passing)
        confirmed = [pr for pr in passing if cost(pr) <= 1.5 * cheapest]
        jobs = [(tid, pr, rep) for pr in confirmed for tid in tasks for rep in range(1, a.reps + 1)]
        _, left = run(jobs)
        unmeasured += left
    print("bench: spent=%.2f trials=%d unmeasured=%d" % (state["spent"], state["trials"], unmeasured))
```

`argparse` exits with status 2 on a missing required option, which is what the « bench
wants a cap » check pins.

- [ ] **Step 4: Run** — Expected `exit=0`.
- [ ] **Step 5: Commit**

```bash
git add skills/model-routing/scripts/routing.py tests/run-tests.sh
git commit -m "feat(routing): bench a project on a grid of pairs under the operator's cap" -m "Every pair is screened on two tasks of a class; only those that passed both and cost within half again of the cheapest are confirmed on every task. A restart reuses what was measured, and the operator's cap is the only thing that stops a run."
```

### Task 10: `generalize`, `show`, `export`

**Files:**
- Modify: `skills/model-routing/scripts/routing.py`
- Modify: `tests/run-tests.sh` (section `== routing: generalize ==`)

**Interfaces:**
- Consumes: `stats_of`, `select_entry`, `floors`, `read_trials`, `table_path`, `read_map`,
  `is_stale` (Tasks 4-5).
- Produces: `routing.py generalize` → writes `tables/profile-*.json` for profiles with ≥2
  projects and `tables/global.json`; prints `profile=<p> projects=<n> classes=<n>` and
  `global projects=<n> classes=<n>`.
- Produces: `routing.py show [<slug>]` → per class: `class=<c> project=<pair|-> profile=<…>
  global=<…> [stale]`.
- Produces: `routing.py export [--to <dir>]` → writes `profile-*.json` and `global.json`
  in tier/effort form; prints `exported <file> (<n> classes)`, warns
  `export: <alias> is bound to no tier, <class> skipped`.

- [ ] **Step 1: Write the failing tests**

```bash
echo "== routing: generalize =="

GS="$WORK/gstate"
mkproj() { # slug profile
  mkdir -p "$GS/routing/projects/$1"
  printf '{"slug":"%s","repo":"/x/%s","profile":"%s","tasks":[]}' "$1" "$1" "$2" > "$GS/routing/projects/$1/manifest.json"; }
gtrial() { # slug class pair status cost
  printf '{"task":"t","class":"%s","pair":"%s","models":{"%s-1":%s},"cost_usd":%s,"status":"%s"}\n' "$2" "$3" "${3%%/*}" "$5" "$5" "$4" >> "$GS/routing/projects/$1/trials.jsonl"; }
mkproj p1 php/laravel-app; mkproj p2 php/laravel-app; mkproj p3 shell/plugin
# c-model/medium: perfect on p1 (6/6), poor on p2 (3/6) -> pooled 0.75: not eligible anyway.
# b-model/medium: 6/6 on p1 and p2 -> chosen for the profile.
for i in 1 2 3 4 5 6; do gtrial p1 behaviour-phase c-model/medium pass 0.1; gtrial p1 behaviour-phase b-model/medium pass 0.3; gtrial p2 behaviour-phase b-model/medium pass 0.3; done
for i in 1 2 3; do gtrial p2 behaviour-phase c-model/medium pass 0.1; gtrial p2 behaviour-phase c-model/medium fail 0.1; done
# On the global fold, add p3 where c-model/medium is perfect too: pooled 15/18 = 0.83, still not eligible.
for i in 1 2 3 4 5 6; do gtrial p3 behaviour-phase c-model/medium pass 0.1; done
printf '{"deep":"a-model","standard":"b-model","light":"c-model"}' > "$GS/models.json"
rg() { ORCHESTRATOR_STATE_DIR="$GS" python3 "$ROUTING" "$@"; }
out=$(rg generalize)
check "a profile needs two projects" "profile=php/laravel-app projects=2 classes=1" "$(printf '%s\n' "$out" | grep '^profile=')"
check "no table for a profile of one project" "no" "$([ -f "$GS/routing/tables/profile-shell-plugin.json" ] && echo yes || echo no)"
check "the profile's pair must hold in each project" "b-model/medium" \
  "$(jq -r '.entries["behaviour-phase"].pair' "$GS/routing/tables/profile-php-laravel-app.json")"
check "the global fold covers every project" "global projects=3 classes=1" "$(printf '%s\n' "$out" | grep '^global')"
# The per-project condition, isolated: c-model/medium at 6/6 on p1 and p3 and 5/6 on p2 is
# pooled 17/18 = 0.94 >= 0.9, yet fails the floor on p2 alone.
: > "$GS/routing/projects/p2/trials.jsonl"
for i in 1 2 3 4 5; do gtrial p2 behaviour-phase c-model/medium pass 0.1; done; gtrial p2 behaviour-phase c-model/medium fail 0.1
for i in 1 2 3 4 5 6; do gtrial p2 behaviour-phase b-model/medium pass 0.3; done
rg generalize >/dev/null
check "one weak project keeps a cheaper pair out of the global table" "b-model/medium" \
  "$(jq -r '.entries["behaviour-phase"].pair' "$GS/routing/tables/global.json")"
ED="$WORK/exported"; mkdir -p "$ED"
out=$(rg export --to "$ED")
check "export writes the tier, never the family" "standard/medium" "$(jq -r '.entries["behaviour-phase"].pair' "$ED/global.json")"
check "export drops identifiers and costs" "null|null" "$(jq -r '.entries["behaviour-phase"]|"\(.models)|\(.cost_usd)"' "$ED/global.json")"
check "no family name in an export" "" "$(grep -rl -e a-model -e b-model -e c-model "$ED" || true)"
printf '{"deep":"a-model","light":"c-model"}' > "$GS/models.json"
check "a family bound to no tier is skipped, with a warning per table" "2" \
  "$(rg export --to "$ED" 2>&1 >/dev/null | grep -c 'export: b-model is bound to no tier, behaviour-phase skipped')"
check "show lists each class with its tables" "1" "$(rg show p1 | grep -c '^class=behaviour-phase project=- profile=b-model/medium global=b-model/medium')"
```

- [ ] **Step 2: Run** — Expected FAIL.

- [ ] **Step 3: Implement** (register `generalize`, `show`, `export`)

```python
# --- generalisation and export --------------------------------------------------------

def all_projects():
    out = {}
    for path in sorted(glob.glob(os.path.join(ROUTING_DIR, "projects", "*", "manifest.json"))):
        m = read_json(path, {})
        trials = read_trials(os.path.join(os.path.dirname(path), "trials.jsonl"))
        if trials:
            out[m["slug"]] = (m.get("profile") or "unknown/unknown", trials)
    return out


def fold(scope, projects):
    """Pool the projects' trials; a pair qualifies only when it also meets the floor in
    every project where it was measured, so one easy project cannot carry a profile.
    """
    default, strict = floors()
    entries = {}
    classes = sorted({t["class"] for _, trials in projects.values() for t in trials})
    for cls in classes:
        floor = strict if cls in STRICT_CLASSES else default
        pooled = stats_of([t for _, ts in projects.values() for t in ts if t["class"] == cls])
        for slug, (_, ts) in projects.items():
            for pair, s in stats_of([t for t in ts if t["class"] == cls]).items():
                if s["n"] and s["passes"] / s["n"] < floor and pair in pooled:
                    pooled[pair]["n"] = 0  # disqualified: never eligible, still on the ladder
        entry = select_entry(cls, pooled, floor)
        if entry:
            entries[cls] = entry
    return {"scope": scope, "generated": datetime.date.today().isoformat(), "entries": entries}


def cmd_generalize(argv):
    projects = all_projects()
    if not projects:
        die("generalize: no project has trials")
    profiles = {}
    for slug, (profile, _) in projects.items():
        profiles.setdefault(profile, []).append(slug)
    for profile, slugs in sorted(profiles.items()):
        if len(slugs) < 2:
            continue
        table = fold("profile:" + profile, {s: projects[s] for s in slugs})
        write_json(table_path("profile:" + profile), table)
        print("profile=%s projects=%d classes=%d" % (profile, len(slugs), len(table["entries"])))
    table = fold("global", projects)
    write_json(table_path("global"), table)
    print("global projects=%d classes=%d" % (len(projects), len(table["entries"])))


def cmd_export(argv):
    p = argparse.ArgumentParser(prog="export")
    p.add_argument("--to", default=DEFAULTS_DIR)
    a = p.parse_args(argv)
    tier_of = {}
    for tier, (model, _) in read_map().items():
        tier_of.setdefault(model, tier)
    for path in sorted(glob.glob(os.path.join(ROUTING_DIR, "tables", "profile-*.json"))
                       + glob.glob(os.path.join(ROUTING_DIR, "tables", "global.json"))):
        table = read_json(path, {})
        entries = {}
        for cls, e in sorted(table.get("entries", {}).items()):
            model, effort = parse_pair(e["pair"])
            if model not in tier_of:
                warn("export: %s is bound to no tier, %s skipped" % (model, cls))
                continue
            entries[cls] = {"pair": "%s/%s" % (tier_of[model], effort), "pass_rate": e["pass_rate"],
                            "n": e["n"], "floor": e["floor"]}
        out = os.path.join(a.to, os.path.basename(path))
        write_json(out, {"scope": table.get("scope"), "generated": table.get("generated"), "entries": entries})
        print("exported %s (%d classes)" % (out, len(entries)))


def cmd_show(argv):
    slugs = argv or sorted(os.listdir(os.path.join(ROUTING_DIR, "projects")))
    for slug in slugs:
        m = load_manifest(slug)
        tables = [read_json(table_path(s), {}).get("entries", {})
                  for s in ("project:" + slug, "profile:" + (m.get("profile") or ""), "global")]
        print("project=%s profile=%s" % (slug, m.get("profile")))
        for cls in sorted(set().union(*tables)):
            cells = [t[cls]["pair"] if cls in t else "-" for t in tables]
            stale = any(cls in t and is_stale(t[cls]["pair"], t[cls]) for t in tables)
            print("class=%s project=%s profile=%s global=%s%s" % (cls, cells[0], cells[1], cells[2],
                                                                   " stale" if stale else ""))
```

The `show` check expects `profile=b-model/medium` for p1 because p1's profile table exists
after `generalize`; `project=-` because no `calibrate p1` ran. The `show` output starts
with a `project=p1 profile=php/laravel-app` header line, which the grep skips.

- [ ] **Step 4: Run** — Expected `exit=0`.
- [ ] **Step 5: Commit**

```bash
git add skills/model-routing/scripts/routing.py tests/run-tests.sh
git commit -m "feat(routing): generalise project tables to profiles and export tier defaults" -m "A profile's pair must hold on every project it was measured on, so one easy project cannot lower it. The export replaces each family with the tier it is bound to, which names no model and resolves through any operator's map."
```

### Task 11: documentation and the closing checks

**Files:**
- Modify: `README.md` (the model-routing paragraph)
- Modify: `skills/model-routing/references/calibration.md` (complete it with the commands
  as implemented)
- Modify: `skills/model-routing/defaults/README.md` (if Task 10 changed anything it says)

- [ ] **Step 1:** In `README.md`, extend the model-routing paragraph with three sentences:
  dispatches run on a measured model/effort pair; `routing.py` measures cost, benches merged
  pull requests and calibrates per project and per profile; measured tables stay in the
  operator's state directory and only tier/effort defaults ship.
- [ ] **Step 2:** Run every closing check, each read on its own exit code:

```bash
./tests/run-tests.sh; echo "exit=$?"
grep -rniI 'claude' . --exclude-dir=.git --exclude-dir=.claude | grep -v -e '~/.claude/' -e 'CLAUDE_' -e 'claude-orchestrator' -e '.claude-plugin' -e 'ORCHESTRATOR_HOST_CLI' -e 'docs/plans/' -e 'CLAUDE.md' -e 'claude-statusbar' -e 'claude-plugins-marketplace' -e '/tmp/claude-'
LC_ALL=C grep -rnP '[^\x00-\x7F]' skills/model-routing tests/fixtures/routing
```

Expected: `exit=0`; the second command prints nothing; the third prints only typographic
dashes or arrows in prose, no accented letter.

- [ ] **Step 3: Commit**

```bash
git add README.md skills/model-routing
git commit -m "docs: describe measured routing and where its tables live"
```

---

## After the build

The first real bench run spends real quota and starts only with a `--max-usd` the operator
gives. Before it: the orchestrator writes `<state dir>/routing/prices.json` from the host's
published prices and binds the three tiers in `models.json` to family aliases; `config.json`
gives `acceptEdits` to the family that has no auto mode.
