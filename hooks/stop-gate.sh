#!/usr/bin/env bash
# The stop gate, enforced by the harness rather than remembered by the model — the same
# reasoning as hooks/context-gate.sh.
#
# Runs on the host's Stop event. In an orchestrator's session only (its name in the
# launcher's listing starts with `Orch :`), it holds a stop until something will wake the
# orchestrator — a busy agent of its own, a blocking question declared on the message's
# last line, or nothing left to advance — and puts the real state of its open pull
# requests' checks in front of it once per head. hooks/stop_gate.py holds the checks and
# says why each exists; this wrapper only finds an interpreter.
#
# A refusal is the host's documented one: `{"decision": "block", "reason": …}` on stdout,
# exit 0. A stop that passes prints nothing. When the stop was already refused once in this
# turn (`stop_hook_active`) it passes: at most one refusal per turn.
#
# Its own failures never block: without python3 the stop passes and the log says so.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${ORCHESTRATOR_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-orchestrator}"

note() {
    mkdir -p "$STATE_DIR" 2>/dev/null \
        && printf '%s | - | error | %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$STATE_DIR/stop-gate.log"
}

if ! command -v python3 >/dev/null 2>&1; then
    note "python3 is not installed"
    exit 0
fi
python3 "$HERE/stop_gate.py" 2>/dev/null
code=$?
[ "$code" -eq 0 ] || note "stop_gate.py exited $code"
exit 0
