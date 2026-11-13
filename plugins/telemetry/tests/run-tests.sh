#!/bin/bash
# telemetry's suite: the plugin validates, the scripts' tests pass (events from the hook fixtures,
# each redaction pattern, the store, the transcript reader, the export against a scratch
# repository), then the command line end to end: events appended, a planted secret found by
# `check` and refusing `export`, an export to a scratch bare repository creating its `main`.
#
# Requires bash, git, node and the claude CLI. No network: the logs repository is a scratch one.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
SCRIPTS="$HERE/skills/telemetry/scripts"
TMPDIR="${TMPDIR:-/tmp}"
WORK=$(mktemp -d "${TMPDIR%/}/telemetry-suite-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
fail=0
NODE=(node --experimental-strip-types --no-warnings)

claude plugin validate "$HERE" >/dev/null || { echo "FAIL claude plugin validate"; fail=1; }
"${NODE[@]}" --test "$SCRIPTS"/*.spec.ts "$SCRIPTS"/lib/*.spec.ts || { echo "FAIL the scripts' tests"; fail=1; }

# The command line, as the hooks module and the export command run it, in an isolated HOME.
export HOME="$WORK/home" TELEMETRY_ENV_FILE="$WORK/env" TELEMETRY_MACHINE=suite GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=suite GIT_AUTHOR_EMAIL=suite@example.invalid GIT_COMMITTER_NAME=suite GIT_COMMITTER_EMAIL=suite@example.invalid
unset CLAUDE_LOGS_REPO
mkdir -p "$HOME"
CONFIG="$WORK/config"
cli() { "${NODE[@]}" "$SCRIPTS/telemetry.ts" "$@" --config "$CONFIG"; }
check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1"; echo "       expected: $2"; echo "       actual:   $3"; fail=1; fi
}
SESSION=60ed5626-9879-4041-892a-5db0ff0bad69
printf 'SERVICE_PASS=a-long-enough-value\n' > "$TELEMETRY_ENV_FILE"
line() { printf '{"v":1,"ts":"%s","event":"tool_call","session":"%s","tool":"Bash","bash":{"line":"%s"}}\n' "$1" "$SESSION" "$2"; }

line 2026-11-13T10:00:00Z 'curl -u me:a-long-enough-value https://example.invalid' | cli append
check "append redacts an env value before writing" "0" "$(grep -c 'a-long-enough-value' "$CONFIG/telemetry/events/2026-11-13.jsonl")"
check "check passes on a redacted store" "check: no secret found" "$(cli check)"
check "export with no repository pushes nothing, in one line" \
  "export: CLAUDE_LOGS_REPO is not set; the events stay local in $CONFIG/telemetry/events, nothing pushed" "$(cli export)"

git init --quiet --bare "$WORK/logs.git"
export CLAUDE_LOGS_REPO="$WORK/logs.git"
check "the first export creates main" "export: 1 day file(s) of suite pushed to the logs repository" "$(cli export)"
check "main holds the day file" "1" "$(git -C "$WORK/logs.git" show main:machines/suite/2026-11-13.jsonl | wc -l | tr -d ' ')"

line 2026-11-13T10:00:01Z "planted a-long-enough-value" >> "$CONFIG/telemetry/events/2026-11-13.jsonl"
out=$(cli check); code=$?
check "check finds a planted secret, by line and pattern" "1:2026-11-13.jsonl:2: env" "$code:$(printf '%s\n' "$out" | head -1)"
out=$(cli export); code=$?
check "export refuses a planted secret" "1:export refused: 1 secret(s) found in the store, nothing pushed" "$code:$(printf '%s\n' "$out" | head -1)"
check "the refusal never prints the value" "0" "$(printf '%s\n' "$out" | grep -c 'a-long-enough-value')"
check "nothing more reached the repository" "1" "$(git -C "$WORK/logs.git" rev-list --count main)"

[ "$fail" -eq 0 ] && echo "telemetry: all checks passed"
exit "$fail"
