#!/bin/bash
# learning's suite: the plugin validates, the scripts' tests pass (the reader and the report over
# scratch journals, the hooks module over a fake host), then the command line end to end: no
# journal, one journal, a file that is not an event.
#
# Requires bash, node and the claude CLI.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
SCRIPTS="$HERE/skills/learning/scripts"
TMPDIR="${TMPDIR:-/tmp}"
WORK=$(mktemp -d "${TMPDIR%/}/learning-suite-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
fail=0
NODE=(node --experimental-strip-types --no-warnings)

claude plugin validate "$HERE" >/dev/null || { echo "FAIL claude plugin validate"; fail=1; }
"${NODE[@]}" --test "$SCRIPTS"/*.spec.ts || { echo "FAIL the scripts' tests"; fail=1; }

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1"; echo "       expected: $2"; echo "       actual:   $3"; fail=1; fi
}
CONFIG="$WORK/config"
mkdir -p "$CONFIG"
health() { "${NODE[@]}" "$SCRIPTS/health.ts" --config "$CONFIG"; }

check "no journal is said in one line" "learning health: no journal found, no plugin writes learning events yet." "$(health)"

mkdir -p "$CONFIG/github/journal"
EVENT='{"v":1,"id":"20261114T101500Z-0a1b2c3d","at":"2026-11-14T10:15:00Z","kind":"refusal","source":{"plugin":"github","code":"github.ready.missing-review"},"subject":{"repo":null,"pr":null,"head":null},"context":{"role":null,"mode":null,"paths":[],"languages":[],"session":null},"evidence":[],"trust":"computed"}'
printf '%s\n' "$EVENT" > "$CONFIG/github/journal/20261114T101500Z-0a1b2c3d.json"
out=$(health)
check "a journal's refusal is counted by its code" "1" "$(printf '%s\n' "$out" | grep -c 'github.ready.missing-review  *1$')"
check "no file is called unreadable" "0" "$(printf '%s\n' "$out" | grep -c 'of the contract')"

printf '%s\n' '{"v":1,"command":"git push"}' > "$CONFIG/github/journal/foreign.json"
check "a file that is not an event is counted" "1" "$(health | grep -c '1 file in the journals is not an event of the contract')"

"${NODE[@]}" "$SCRIPTS/health.ts" >/dev/null 2>&1; code=$?
check "a call with no configuration directory exits 2" "2" "$code"

[ "$fail" -eq 0 ] && echo "learning: all checks passed"
exit "$fail"
