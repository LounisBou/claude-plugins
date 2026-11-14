#!/bin/bash
# telemetry's suite: the plugin validates, the scripts' tests pass (events from the hook fixtures,
# each redaction pattern, the store, the transcript reader, the export against a scratch
# repository), then the command line end to end: events appended, a planted secret found by
# `check` and refusing `export`, an export to a scratch bare repository creating its `main`, the
# generated index beside the day files, two exports at once, and the automatic export a session's
# end starts as a detached process.
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

# The index, two exports at once, and the automatic export, on a second scratch repository.
head -n 1 "$CONFIG/telemetry/events/2026-11-13.jsonl" > "$CONFIG/telemetry/events/day.tmp" && mv "$CONFIG/telemetry/events/day.tmp" "$CONFIG/telemetry/events/2026-11-13.jsonl"
git init --quiet --bare "$WORK/logs2.git"
export CLAUDE_LOGS_REPO="$WORK/logs2.git"
rm -rf "$CONFIG/telemetry/export"
cli export > "$WORK/export1.out" & first=$!
cli export > "$WORK/export2.out" & second=$!
wait "$first"; code1=$?
wait "$second"; code2=$?
check "two exports at once both succeed" "0:0" "$code1:$code2"
check "two exports at once leave one commit" "1" "$(git -C "$WORK/logs2.git" rev-list --count main)"
has() { git -C "$WORK/logs2.git" cat-file -e "main:$1" 2>/dev/null; }
has index/README.md && has index/schema/tool_call.md && has index/suite/2026-11-13.json && indexed=yes || indexed=no
check "the index holds the entry point, a page per event kind and the day's manifest" "yes" "$indexed"
check "the manifest names the session" "$SESSION" \
  "$(git -C "$WORK/logs2.git" show main:index/suite/2026-11-13.json | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).sessions[0].session)')"

end_line() { printf '{"v":1,"ts":"%s","event":"session_end","session":"%s","reason":"other"}\n' "$1" "$SESSION"; }
waiting() { # waiting <seconds> <command...>: whether the command succeeds within the delay
  local limit=$1 n=0; shift
  while [ "$n" -lt $((limit * 10)) ]; do "$@" && return 0; sleep 0.1; n=$((n + 1)); done
  return 1
}
pushed_day() { has machines/suite/2026-11-14.jsonl; }
gone() { ! pgrep -f "telemetry.ts export --auto" >/dev/null; }
end_line 2026-11-14T10:00:00Z | cli append
waiting 20 pushed_day && ended=yes || ended=no
check "a session's end starts the automatic export, which pushes the new day" "yes" "$ended"
waiting 20 gone && ended=yes || ended=no
check "the detached export has ended on its own" "yes" "$ended"
commits=$(git -C "$WORK/logs2.git" rev-list --count main)
end_line 2026-11-14T10:00:01Z | cli append
check "a second end the same day starts nothing" "$commits:yes" "$(git -C "$WORK/logs2.git" rev-list --count main):$(gone && echo yes)"

[ "$fail" -eq 0 ] && echo "telemetry: all checks passed"
exit "$fail"
