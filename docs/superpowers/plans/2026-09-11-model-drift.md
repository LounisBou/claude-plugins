# Model Drift Implementation Plan

> **For the orchestrator:** this plan is executed by implementer SESSIONS the orchestrator spawns (`orchestrator:iterm-agents`), one brief per task — never by subagents of the orchestrator's own session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One release, 0.23.2: the gauge prints the model that answered last, and the context gate says, once per change, when it differs from the last one it read.

**Architecture:** two lines added to the gauge's output in both tiers (`model=`, `model_source=`), read from the transcript's last assistant entry, else the tap's `model_id`, else `unavailable`; a marker per session kept by the gate under `ctx/`, compared on every prompt; the tap's sweep extended to that marker. Five pinned gauge outputs re-pinned; five checks added.

**Tech Stack:** bash 3.2, python3 (the gauge's transcript reader), `jq` (the tap file read).

**Spec:** `docs/design.md`, section 32. Section 3 (the gauge and the tap) binds it.

## Global Constraints

Copied from `CLAUDE.md`; the task's requirements include them.

- **English only, everywhere.** **No vendor or product name in prose**; the runtime is "the host". Load-bearing identifiers exempt. Model names in fixtures and examples are placeholders: `a-model`, `b-model`, `t-model`, `z-model`.
- **Commits**: Conventional Commits; no trailer, no attribution, no tool name, no session link.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (218 on the base head; this task adds 5, expected `223 passed, 0 failed`); the brand grep returns only exempt occurrences; no accented character outside `docs/`.
- **Release** (spec §8): version in `plugin.json` and both fields of `marketplace.json`: `0.23.2`.
- **Never run anything against the live app from the suite.** `tests/e2e.sh` is not touched.
- **Every command runs synchronously**, in the tool call that waits for it; the suite is piped to `tail` in the same call.
- **The checkout you work in is already on the phase branch** (the orchestrator committed this plan and the spec on it): do not create another branch.

---

### Task 1: The model that answers is read, not assumed (0.23.2)

**Files:**
- Modify: `skills/context-gauge/scripts/context-gauge.sh` — the tap-file `jq` read gains `model_id`; a `read_model` function; two lines before `source=tap`; two arguments to the tier-2 python and two `print` lines before `source=transcript`.
- Modify: `hooks/context-gate.sh` — a drift block after the reading, before the unmeasured branch.
- Modify: `skills/context-gauge/scripts/statusline-tap.sh` — a third `find` line in the sweep.
- Modify: `tests/fixtures/transcript.jsonl` — a `model` field on each of the two assistant entries.
- Modify: `tests/run-tests.sh` — five gauge outputs re-pinned; one gauge check, three gate checks and one sweep check added.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.23.2`.
- Already committed on this branch by the orchestrator: `docs/design.md` (§32, and the two touches to §3.2 and §3.3) and this plan.

**Interfaces:**
- Consumes: the transcript's assistant entries (`type == "assistant"`, `message.model`); the tap file's `model_id` (written since 0.22.0 by the tap, `(.model.id // "")` of the payload); `$STATE_DIR/ctx/` for the marker.
- Produces: gauge lines `model=<id|unavailable>` and `model_source=transcript|tap|unavailable`, printed in that order immediately before `source=…` in both tiers; the gate's marker `$STATE_DIR/ctx/<session-id>.model` holding the last model read, and the line `MODEL DRIFT: this session now answers as <new>; it answered as <old> until now. The host switched on its own (a refusal, an outage): say it to the operator in your next message; a succession does not repair it.` printed exactly once per change.

- [ ] **Step 1: The fixture and the failing checks**

In `tests/fixtures/transcript.jsonl`, the two assistant lines become (the figures are unchanged):

```
{"type":"assistant","message":{"model":"z-model","usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30}}}
{"type":"assistant","message":{"model":"a-model","usage":{"input_tokens":1000,"cache_creation_input_tokens":2000,"cache_read_input_tokens":87000}}}
```

The third line of the fixture is unchanged.

In `tests/run-tests.sh`, gauge section, re-pin the five full-output checks by inserting two lines immediately before their `source=` line, in the expected text:

- `stale tap file: transcript found through its recorded path` → insert `model=a-model` then `model_source=transcript` before `source=transcript`.
- `a fresh tap without quota figures says unavailable` → insert `model=unavailable` then `model_source=unavailable` before `source=tap`.
- `fresh tap file wins` → insert `model=a-model` then `model_source=transcript` before `source=tap`.
- `stale tap file: transcript with the file's window` → insert `model=a-model` then `model_source=transcript` before `source=transcript`.
- `no tap file: --window` → insert `model=a-model` then `model_source=transcript` before `source=transcript`.

Immediately after the check `a fresh tap without quota figures says unavailable` and its `rm -f "$GSTATE/ctx/g-3.json"` line, insert:

```bash
# No transcript reachable: the tap's declared model is the reading, said as the tap's.
printf '{"session_id":"g-4","context_percent":36.4,"context_used":91000,"context_total":250000,"five_hour_percent":3,"five_hour_resets_at":null,"seven_day_percent":1,"seven_day_resets_at":null,"transcript_path":null,"model_id":"t-model","updated_epoch":%s}\n' \
  "$(date +%s)" > "$GSTATE/ctx/g-4.json"
check "no transcript: the model comes from the tap, and says so" "model=t-model
model_source=tap" "$(gauge g-4 | grep '^model')"
rm -f "$GSTATE/ctx/g-4.json"
```

In the context gate section, immediately before the line `rm -rf "$GH"`, insert:

```bash
# The model that answers can be switched under a session by the host's own fallback, and
# nothing showed it (§32). The gate keeps the last model it read and says a change once —
# a line the session cannot miss, where the status line showed nothing.
mkdir -p "$GH/projects/p"
printf '{"type":"assistant","message":{"model":"a-model","usage":{"input_tokens":1,"cache_creation_input_tokens":1,"cache_read_input_tokens":1}}}\n' > "$GH/projects/p/g-drift.jsonl"
printf '{"session_id":"g-drift","context_percent":30,"updated_epoch":%s}\n' "$now" > "$GH/claude-orchestrator/ctx/g-drift.json"
check "the first reading of the model is silent" "" "$(gate g-drift)"
printf '{"type":"assistant","message":{"model":"b-model","usage":{"input_tokens":1,"cache_creation_input_tokens":1,"cache_read_input_tokens":1}}}\n' >> "$GH/projects/p/g-drift.jsonl"
check "a changed model is said once, naming both" "1" "$(gate g-drift | grep -c 'MODEL DRIFT: this session now answers as b-model; it answered as a-model until now')"
check "and not again while it holds" "" "$(gate g-drift)"
```

In the tap section, immediately after the line `touch "$STATE/ctx/today.gate-unmeasured"`, insert:

```bash
touch -t 202001010000 "$STATE/ctx/old.model"
```

and immediately after the check `a marker from today is kept`, insert:

```bash
check "stale model markers pruned with them" "gone" "$([ -f "$STATE/ctx/old.model" ] && echo kept || echo gone)"
```

- [ ] **Step 2: Run the suite and watch the checks fail for the right reason**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `215 passed, 8 failed`: the five re-pinned outputs (no `model=` lines yet), the g-4 check (empty), « a changed model is said once » (no line), the sweep check (kept). The two silent gate checks pass already — silence is what today's gate does; they read the mechanism only beside the one between them. Report the count and the first failing check's actual value verbatim before editing.

- [ ] **Step 3: The gauge**

In `skills/context-gauge/scripts/context-gauge.sh`:

(a) In the tap-file `jq` read, add `(.model_id // "")` as the last element of the array (after `(.transcript_path // "")`) and `mid` as the last name of the `read -r` list, so the line reads `IFS=$'\x1f' read -r updated pct used total h5 d7 tp mid <<<"$(jq -r '` and the array ends with `(.transcript_path // ""), (.model_id // "") ]`.

(b) Immediately after the `die() { … }` line, insert:

```bash
# The model that answered last. The transcript is the one certain trace: the host can
# switch a session's model under it (its own fallback after a refusal or an outage) and
# neither the launch line nor the status line shows it — only each answer's own entry
# does (§32). The tap's declared model is the fallback reading; unavailable otherwise,
# in the same word as the quota figures and for the same reason.
read_model() {
  model="" model_source="unavailable"
  [ -n "$transcript" ] || transcript=$(ls "$TRANSCRIPTS_DIR"/*/"$session_id".jsonl 2>/dev/null | head -1)
  if [ -n "$transcript" ] && [ -f "$transcript" ]; then
    model=$(tail -c 300000 "$transcript" | python3 -c '
import sys, json
data = sys.stdin.buffer.read().decode("utf-8", errors="ignore")
for line in reversed(data.strip().split("\n")):
    try:
        entry = json.loads(line)
    except Exception:
        continue
    if entry.get("type") == "assistant":
        m = (entry.get("message") or {}).get("model")
        if m:
            print(m)
            break
')
    [ -n "$model" ] && model_source="transcript"
  fi
  if [ -z "$model" ] && [ -n "${mid:-}" ] && [ "$mid" != "null" ]; then
    model="$mid"; model_source="tap"
  fi
  [ -n "$model" ] || model="unavailable"
}
```

(c) In the tier-1 branch, immediately before `echo "source=tap"`, insert:

```bash
    read_model
    echo "model=$model"
    echo "model_source=$model_source"
```

(d) Immediately before the line `tail -c 300000 "$transcript" | python3 -c '` (the tier-2 reader), insert a line `read_model`. In that python program, change `source = sys.argv[2]` to:

```python
source = sys.argv[2]
model, model_source = sys.argv[3], sys.argv[4]
```

insert, immediately before `print("source=transcript")`:

```python
        print(f"model={model}")
        print(f"model_source={model_source}")
```

and change the program's closing invocation from `' "$window" "$window_source"` to `' "$window" "$window_source" "$model" "$model_source"`.

- [ ] **Step 4: The gate and the sweep**

In `hooks/context-gate.sh`, immediately after the line that sets `source=` from the reading (`source="$(printf '%s\n' "$reading" | sed -n 's/^source=\(.*\)/\1/p' | head -1)"`), insert:

```bash
# The model that answers can be switched under this session by the host's own fallback,
# and no other surface shows it (§32). Kept per session; said once per change, the
# switch back included.
model="$(printf '%s\n' "$reading" | sed -n 's/^model=\(.*\)/\1/p' | head -1)"
if [ -n "$model" ] && [ "$model" != "unavailable" ]; then
    model_marker="$STATE_DIR/ctx/$session_id.model"
    mkdir -p "$STATE_DIR/ctx" 2>/dev/null
    if [ -f "$model_marker" ]; then
        previous="$(cat "$model_marker")"
        if [ "$previous" != "$model" ]; then
            echo "MODEL DRIFT: this session now answers as ${model}; it answered as ${previous} until now. The host switched on its own (a refusal, an outage): say it to the operator in your next message; a succession does not repair it."
            printf '%s' "$model" > "$model_marker"
        fi
    else
        printf '%s' "$model" > "$model_marker"
    fi
fi
```

In `skills/context-gauge/scripts/statusline-tap.sh`, immediately after the line `find "$CTX_DIR" -name '*.gate-unmeasured' -mtime +1 -delete 2>/dev/null`, insert:

```bash
    find "$CTX_DIR" -name '*.model' -mtime +1 -delete 2>/dev/null
```

with the same indentation as the line above it.

- [ ] **Step 5: Run the suite**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `223 passed, 0 failed`. Do not weaken a check to pass; report the actual value and stop if a script and a check disagree on the contract.

- [ ] **Step 6: Version**

`.claude-plugin/plugin.json` `version` and both `version` fields of `.claude-plugin/marketplace.json`: `0.23.2`. Then `./tests/run-tests.sh 2>&1 | tail -1`: `223 passed, 0 failed`.

- [ ] **Step 7: Commit and deliver**

One commit, with this exact subject: `feat(context-gauge): read the model that answers, and say once when it changes` — the gauge, the gate, the tap, the fixture, the suite, the two version files. Body: why (the host switched a running session to a fallback model after a refusal and nothing but the transcript showed it; the gauge reads the last answer's model; the gate says a change once and keeps the marker; the sweep takes the marker). It stacks on the orchestrator's docs commit already on this branch. Push with `git push -u origin model-drift`, open the draft PR as the brief says.
