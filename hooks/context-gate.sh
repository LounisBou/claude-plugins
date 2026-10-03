#!/usr/bin/env bash
# The context gate, enforced by the harness rather than remembered by the model.
#
# Runs on every user prompt, and speaks only to orchestration sessions: those whose name,
# given at launch (`--name`) or by a rename, starts with `Orch :`, `Agent :`, `Audit :` or
# `Coord :` (hooks/session_name.py reads it, the same reading the stop gate uses). A session
# the operator started by hand, or one whose name cannot be read, gets nothing at all: no
# gate line, no « unmeasured » line, no model-drift line, no marker.
#
# Reads the session's measured context fill from the gauge's tap tier and, at or past the
# gate, injects one line the session cannot miss, fitted to its role: an orchestrator
# succeeds at the next quiet boundary, an agent finishes its unit and stops, an auditor
# writes its one report and stops, the coordinator succeeds when no relay is in flight.
# Below the gate it prints nothing.
#
# The gate is 80 % of the window, or 300,000 tokens on a window of 1,000,000 tokens or more:
# the cached context is replayed on every turn, and the percent alone would let a session
# on such a window carry up to 800,000 tokens of it (skills/orchestrator/SKILL.md,
# « Thresholds »).
#
# WHY A HOOK. The rule « succession is yours to trigger, do not wait » existed in
# the skill and was not applied: an orchestrator reported its context at the gate
# and asked the user what to do. A sentence the model must remember is a sentence
# it can rationalise away; a line the harness puts in front of every prompt is not.
#
# A gate that cannot measure lets the prompt through and SAYS SO — once per
# session, not on every prompt — instead of staying silent as if the fill were low. But
# not before the tap had its chance: the status line renders only after a turn has
# answered, so a session's very first prompt has no tap file yet by construction, and
# saying "unmeasured" there is a false alarm, not a finding.
# Nor when the tap file is merely old: the gauge then reads the transcript against the
# window the file carries, and that reading counts. The line names what was read: no tap
# file, or a tap file the gauge could not read a figure from.
set -u
GATE="${ORCHESTRATOR_CONTEXT_GATE:-80}"
GATE_TOKENS="${ORCHESTRATOR_CONTEXT_GATE_TOKENS:-300000}"
LARGE_WINDOW="${ORCHESTRATOR_LARGE_WINDOW:-1000000}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GAUGE="$HERE/../skills/context-gauge/scripts/context-gauge.sh"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STATE_DIR="$CONFIG_DIR/claude-orchestrator"

payload="$(cat 2>/dev/null || true)"
session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
session_id="${session_id:-${CLAUDE_CODE_SESSION_ID:-}}"
[ -n "$session_id" ] || exit 0

# The scope first: the role is the prefix of the session's name. No python3, no readable
# name, no role: nothing is said.
name=""
if command -v python3 >/dev/null 2>&1; then
    name="$(printf '%s' "$payload" | python3 -S "$HERE/session_name.py" 2>/dev/null | head -1)"
fi
case "$name" in
    "Orch :"*)
        role_line="Succeed at the next quiet boundary — run /orchestrator:succeed: spawn the successor in the operator's decision mode, then tell the user; do not ask." ;;
    "Agent :"*)
        role_line="Finish the unit in progress, report to your orchestrator with your measured context, and stop; no new phase is dispatched to you." ;;
    "Audit :"*)
        role_line="Write the one report with what you have read, and stop." ;;
    "Coord :"*)
        role_line="With no relay in flight, succeed as skills/coordination/SKILL.md « Your context » says, then tell the operator." ;;
    *) exit 0 ;;
esac

reading="$(CLAUDE_CODE_SESSION_ID="$session_id" bash "$GAUGE" "$session_id" 2>/dev/null || true)"
percent="$(printf '%s\n' "$reading" | sed -n 's/^context_percent=\([0-9]*\).*/\1/p' | head -1)"
tokens="$(printf '%s\n' "$reading" | sed -n 's/^context_tokens=\([0-9][0-9]*\)$/\1/p' | head -1)"
window="$(printf '%s\n' "$reading" | sed -n 's/^context_window=\([0-9][0-9]*\)$/\1/p' | head -1)"
source="$(printf '%s\n' "$reading" | sed -n 's/^source=\(.*\)/\1/p' | head -1)"
window_source="$(printf '%s\n' "$reading" | sed -n 's/^context_window_source=\(.*\)/\1/p' | head -1)"

# 312000 -> 312,000; a whole number of millions reads as 1M.
thousands() {
    local n="$1" out=""
    while [ "${#n}" -gt 3 ]; do out=",${n: -3}$out"; n="${n:0:${#n}-3}"; done
    printf '%s%s' "$n" "$out"
}
window_label() {
    if [ $(( $1 % 1000000 )) -eq 0 ]; then printf '%sM' $(( $1 / 1000000 )); else thousands "$1"; fi
}

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

# A reading is a measure when the tap is fresh, and also when the tap file is older than the
# gauge's freshness window or has no figure yet but carries the window: the gauge then reads
# the transcript's last usage against that window. The status line renders after a turn, so
# a prompt that follows a pause meets exactly that file; it is not a tap that failed.
measured=0
if [ -n "$percent" ]; then
    if [ "$source" = "tap" ] || { [ "$source" = "transcript" ] && [ "$window_source" = "tap-file" ]; }; then
        measured=1
    fi
fi

if [ "$measured" -eq 0 ]; then
    # The tap has had its chance only once a turn has answered: before that, the
    # transcript carries no assistant entry, and a session with none yet is not a
    # session the tap failed, it is a session the tap has not rendered for at all.
    transcript_path="$(printf '%s' "$payload" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    if [ -n "$transcript_path" ] && [ -f "$transcript_path" ] \
        && grep -q '"type"[[:space:]]*:[[:space:]]*"assistant"' "$transcript_path" 2>/dev/null; then
        marker="$STATE_DIR/ctx/$session_id.gate-unmeasured"
        if [ ! -f "$marker" ]; then
            mkdir -p "$STATE_DIR/ctx" 2>/dev/null && : > "$marker"
            # Say what was read, and only that: no tap file now may be a file the tap pruned
            # after a day without a render, and a tap file present may lack the window or
            # carry it with a transcript not yet readable.
            gate_words="The gate (${GATE}%, or $(thousands "$GATE_TOKENS") tokens on a window of $(window_label "$LARGE_WINDOW") or more) cannot be read; measure by hand before dispatching or rotating."
            if [ -f "$STATE_DIR/ctx/$session_id.json" ]; then
                echo "CONTEXT GATE: unmeasured: the tap file is present but the gauge could not read a figure from it (the next status line render may fill it). $gate_words"
            else
                echo "CONTEXT GATE: unmeasured: no tap file for this session now (never written, or pruned after a day without a render); /orchestrator:install is the repair only if the status line shows nothing. $gate_words"
            fi
        fi
    fi
    exit 0
fi

# Without the token count or the window, only the percent can be read.
if [ -n "$tokens" ] && [ -n "$window" ] && [ "$window" -ge "$LARGE_WINDOW" ]; then
    [ "$tokens" -ge "$GATE_TOKENS" ] || exit 0
    tripped="$(thousands "$tokens") tokens (gate $(thousands "$GATE_TOKENS") on a $(window_label "$window") window)"
elif [ "$percent" -ge "$GATE" ]; then
    tripped="${percent}% (gate ${GATE}%)"
else
    exit 0
fi
echo "CONTEXT GATE: this session is at ${tripped}. ${role_line}"
exit 0
