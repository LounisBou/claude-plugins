#!/bin/bash
# context-gauge.sh — a session's own context fill, measured rather than estimated.
#
# Usage: context-gauge.sh [session-id] [--window N] [--max-age S]
#   session-id defaults to CLAUDE_CODE_SESSION_ID, set by the host in every session.
#
# Tier 1 (harness-exact): <state>/ctx/<session-id>.json, deposited on every status
#   line render by statusline-tap.sh. Used when younger than --max-age (default 120 s).
# Tier 2 (computed): the transcript's last `usage` block — input plus cache tokens is
#   the context sent on the last turn. Needs the window size: the stale tap file's
#   total, else --window, else 200000; context_window_source= says which.
#
# ORCHESTRATOR_STATE_DIR and ORCHESTRATOR_TRANSCRIPTS_DIR override the locations.

set -u

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STATE_DIR="${ORCHESTRATOR_STATE_DIR:-$CONFIG_DIR/claude-orchestrator}"
TRANSCRIPTS_DIR="${ORCHESTRATOR_TRANSCRIPTS_DIR:-$CONFIG_DIR/projects}"

die() { echo "ERROR: $*" >&2; exit 1; }

session_id="" window="" max_age=120
while [ $# -gt 0 ]; do
  case "$1" in
    --window) window="$2"; shift 2 ;;
    --max-age) max_age="$2"; shift 2 ;;
    --*) die "unknown option $1" ;;
    *) session_id="$1"; shift ;;
  esac
done
session_id="${session_id:-${CLAUDE_CODE_SESSION_ID:-}}"
[ -n "$session_id" ] || die "usage: context-gauge.sh [session-id] [--window N] [--max-age S] (CLAUDE_CODE_SESSION_ID is unset)"

tap_file="$STATE_DIR/ctx/$session_id.json"
window_source=""
transcript=""
if [ -f "$tap_file" ]; then
  IFS=$'\x1f' read -r updated pct used total h5 d7 tp <<<"$(jq -r '
    [ (.updated_epoch // 0), (.context_percent // null), (.context_used // null),
      (.context_total // null), (.five_hour_percent // null), (.seven_day_percent // null),
      (.transcript_path // "") ]
    | map(tostring) | join("\u001f")' "$tap_file" 2>/dev/null)"
  [ -f "${tp:-}" ] && transcript="$tp"
  age=$(( $(date +%s) - ${updated:-0} ))
  if [ "$age" -lt "$max_age" ] && [ "${pct:-null}" != "null" ]; then
    echo "context_percent=$pct"
    echo "context_tokens=$used"
    echo "context_window=$total"
    # One word for "the figure is not there", in both tiers. A line that is absent, or
    # that reads `null`, is one a reader takes for zero — and zero means "no budget
    # pressure" exactly when the pressure cannot be measured.
    [ "${h5:-null}" = "null" ] && h5=unavailable
    [ "${d7:-null}" = "null" ] && d7=unavailable
    echo "five_hour_percent=$h5"
    echo "seven_day_percent=$d7"
    echo "source=tap"
    exit 0
  fi
  if [ "${total:-null}" != "null" ]; then
    window="$total"
    window_source="tap-file"
  fi
fi
if [ -z "$window_source" ]; then
  if [ -n "$window" ]; then window_source="flag"; else window=200000; window_source="default"; fi
fi

# The tap file names the transcript when the host sent transcript_path; otherwise
# the transcript is looked up by session id under the projects directory.
[ -n "$transcript" ] || transcript=$(ls "$TRANSCRIPTS_DIR"/*/"$session_id".jsonl 2>/dev/null | head -1)
[ -n "$transcript" ] || die "no tap file and no transcript for session $session_id"

tail -c 300000 "$transcript" | python3 -c '
import sys, json
window = int(sys.argv[1])
source = sys.argv[2]
data = sys.stdin.buffer.read().decode("utf-8", errors="ignore")
for line in reversed(data.strip().split("\n")):
    try:
        entry = json.loads(line)
    except Exception:
        continue
    usage = (entry.get("message") or {}).get("usage")
    if usage and usage.get("cache_read_input_tokens") is not None:
        ctx = usage.get("input_tokens", 0) + usage.get("cache_creation_input_tokens", 0) + usage.get("cache_read_input_tokens", 0)
        print(f"context_percent={ctx / window * 100:.1f}")
        print(f"context_tokens={ctx}")
        print(f"context_window={window}")
        print(f"context_window_source={source}")
        # The quota figures live in the status line payload alone: the transcript has no
        # trace of them. They are still printed, because the callers that read this output
        # are told to keep those lines, and a missing line reads as zero.
        print("five_hour_percent=unavailable")
        print("seven_day_percent=unavailable")
        print("source=transcript")
        if source == "default":
            print("warning=window assumed; pass --window or wire the tap (/orchestrator:install) for the real size")
        sys.exit(0)
print("ERROR: no usage block found in the transcript tail", file=sys.stderr)
sys.exit(1)
' "$window" "$window_source"
