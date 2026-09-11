#!/usr/bin/env bash
# The context gate, enforced by the harness rather than remembered by the model.
#
# Runs on every user prompt. Reads the session's measured context fill from the
# gauge's tap tier and, at or past the gate, injects one line the session cannot
# miss: an orchestrator succeeds at the next quiet boundary, an implementer
# finishes its unit and stops. Below the gate it prints nothing.
#
# WHY A HOOK. The rule « succession is yours to trigger, do not wait » existed in
# the skill and was not applied: an orchestrator reported its context at the gate
# and asked the user what to do. A sentence the model must remember is a sentence
# it can rationalise away; a line the harness puts in front of every prompt is not.
#
# A gate that cannot measure lets the prompt through and SAYS SO — once per
# session, not on every prompt — instead of staying silent as if the fill were low.
set -u
GATE="${ORCHESTRATOR_CONTEXT_GATE:-60}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GAUGE="$HERE/../skills/context-gauge/scripts/context-gauge.sh"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STATE_DIR="$CONFIG_DIR/claude-orchestrator"

payload="$(cat 2>/dev/null || true)"
session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
session_id="${session_id:-${CLAUDE_CODE_SESSION_ID:-}}"
[ -n "$session_id" ] || exit 0

reading="$(CLAUDE_CODE_SESSION_ID="$session_id" bash "$GAUGE" "$session_id" 2>/dev/null || true)"
percent="$(printf '%s\n' "$reading" | sed -n 's/^context_percent=\([0-9]*\).*/\1/p' | head -1)"
source="$(printf '%s\n' "$reading" | sed -n 's/^source=\(.*\)/\1/p' | head -1)"

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

if [ "$source" != "tap" ] || [ -z "$percent" ]; then
    marker="$STATE_DIR/ctx/$session_id.gate-unmeasured"
    if [ ! -f "$marker" ]; then
        mkdir -p "$STATE_DIR/ctx" 2>/dev/null && : > "$marker"
        echo "CONTEXT GATE: unmeasured for this session (the gauge's tap is not feeding it — /orchestrator:install, then restart). The ${GATE}% gate cannot be read; measure by hand before dispatching or rotating."
    fi
    exit 0
fi

if [ "$percent" -ge "$GATE" ]; then
    echo "CONTEXT GATE: this session is at ${percent}% (gate ${GATE}%). An orchestrator SUCCEEDS at the next quiet boundary — run /orchestrator:succeed: spawn the successor in the operator's decision mode, then tell the user; do not ask. An implementer finishes the unit in progress, reports, and stops; no new phase is dispatched to it."
fi
exit 0
