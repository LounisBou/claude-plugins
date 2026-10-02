#!/bin/sh
# End-to-end run of bin/bugs-bot against a fake Bot API on loopback, two projects, a temporary home.
#
#   sh tests/e2e.sh                    prints "E2E OK" and exits 0
#   E2E_FORCE_FAIL=1 sh tests/e2e.sh   fails half-way on purpose, to show the server is killed anyway
#
# Touches nothing outside its own temporary directory: no real bugs home, no network, no PM2.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PY=${E2E_PYTHON:-python3}
TOKEN="123456789:AAFakeTokenFakeTokenFakeTokenFake123"
WORK=""
SERVER_PID=""

# Runs on every way out: success, a failed command under `set -e`, a failed check, a signal.
cleanup() {
    status=$?
    trap '' EXIT INT TERM HUP
    if [ -n "$SERVER_PID" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    [ -z "$WORK" ] || rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bugs-bot-e2e.XXXXXX")

fail() {
    echo "E2E FAIL: $*" >&2
    exit 1
}

BUGS_BOT_HOME="$WORK/home"
BUGS_BOT_ENV_FILE="$WORK/token.env"
BUGS_BOT_CLAUDE_DIR="$WORK/claude"
BUGS_BOT_LAUNCHER_DIR="$WORK/launcher"
export BUGS_BOT_HOME BUGS_BOT_ENV_FILE BUGS_BOT_CLAUDE_DIR BUGS_BOT_LAUNCHER_DIR
printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TOKEN" > "$BUGS_BOT_ENV_FILE"

"$PY" "$ROOT/tests/http_server_fake_bot_api.py" "$WORK/port" "$WORK/calls.log" "$TOKEN" &
SERVER_PID=$!
tries=0
while [ ! -s "$WORK/port" ]; do
    tries=$((tries + 1))
    [ "$tries" -le 100 ] || fail "the fake Bot API did not start"
    sleep 0.1
done
PORT=$(cat "$WORK/port")
BUGS_BOT_API_ROOT="http://127.0.0.1:$PORT"
export BUGS_BOT_API_ROOT

bb() { "$PY" "$ROOT/bin/bugs-bot" "$@"; }

# enqueue CHAT TITLE UPDATE_ID MESSAGE_ID MINUTE TEXT: a member posts in a group.
enqueue() {
    "$PY" - "$PORT" "$@" <<'PYEOF'
import json, sys, urllib.request
port, chat, title, update_id, message_id, minute, text = sys.argv[1:8]
update = {"update_id": int(update_id), "message": {
    "message_id": int(message_id), "date": 1790929800 + 60 * int(minute),
    "from": {"id": 42, "is_bot": False, "first_name": "Ana", "username": "ana"},
    "chat": {"id": int(chat), "title": title, "type": "supergroup"}, "text": text}}
request = urllib.request.Request(f"http://127.0.0.1:{port}/_enqueue", json.dumps([update]).encode())
urllib.request.urlopen(request).read()
PYEOF
}

# check LABEL ACTUAL EXPECTED
check() { [ "$2" = "$3" ] || fail "$1: got '$2', expected '$3'"; }

# calls METHOD: how many times the fake API was called with it.
calls() { grep -c "\"method\": \"$1\"" "$WORK/calls.log" || true; }

for name in alpha beta; do
    mkdir "$WORK/repo-$name"
    git -C "$WORK/repo-$name" init -q
done
ALPHA=-1001
BETA=-1002
OTHER=-1003

# init: the group is found among the bot's pending updates, nothing consumed.
enqueue $ALPHA "Alpha Bugs" 1 101 0 "alpha: the list is empty"
bb init --project alpha --agent-title "Agent : Alpha" --repo "$WORK/repo-alpha" > "$WORK/init-alpha.out"
grep -q "registered $ALPHA -> alpha" "$WORK/init-alpha.out" || fail "init alpha did not register its group"
enqueue $BETA "Beta Bugs" 2 201 1 "beta: crash on start"
bb init --project beta --agent-title "Agent : Beta" --repo "$WORK/repo-beta" > "$WORK/init-beta.out"
grep -q "registered $BETA -> beta" "$WORK/init-beta.out" || fail "init beta did not register its group"
[ ! -e "$BUGS_BOT_HOME/state.json" ] || fail "init consumed updates (an offset was written)"

[ -z "${E2E_FORCE_FAIL:-}" ] || fail "forced failure (E2E_FORCE_FAIL): the server must still be killed"

# pull: one batch, two projects and an unregistered group; the offset passes all of it.
enqueue $ALPHA "Alpha Bugs" 3 102 2 "alpha: the button does nothing"
enqueue $BETA "Beta Bugs" 4 202 3 "beta: wrong colour"
enqueue $OTHER "Elsewhere" 5 301 4 "not ours"
bb pull
check "offset after the batch" "$("$PY" -c "import json,sys;print(json.load(open(sys.argv[1]))['offset'])" "$BUGS_BOT_HOME/state.json")" 6
check "alpha reports" "$(cd "$WORK/repo-alpha" && bb list | wc -l | tr -d ' ')" 2
check "beta reports" "$(bb list --project beta | wc -l | tr -d ' ')" 2
bb list --project alpha | grep -q "the button does nothing" || fail "alpha misses its second report"
bb list --project beta | grep -q "alpha" && fail "an alpha report leaked into beta"
grep -q "Elsewhere" "$BUGS_BOT_HOME/unregistered.json" || fail "the unregistered group was not logged"
check "reactions" "$(calls setMessageReaction)" 4
before=$(find "$BUGS_BOT_HOME" -name report.json | wc -l | tr -d ' ')
bb pull
check "reports after a second pull" "$(find "$BUGS_BOT_HOME" -name report.json | wc -l | tr -d ' ')" "$before"

# the launcher's commands, from inside the project's repository.
cd "$WORK/repo-alpha"
ID=$(bb list | sed -n 2p | cut -d' ' -f1)
bb reply "$ID" "on it, thanks" --mention > /dev/null
"$PY" - "$WORK/calls.log" <<'PYEOF' || fail "reply --mention did not post a mention"
import json, sys
sent = [json.loads(line)["payload"] for line in open(sys.argv[1]) if '"sendMessage"' in line]
last = sent[-1]
assert last["chat_id"] == -1001 and last["text"] == "@ana on it, thanks", last
assert last["entities"][0]["type"] == "mention" and last["entities"][0]["offset"] == 0, last
assert last["reply_parameters"]["message_id"] == 102, last
PYEOF
bb taken "$ID" > /dev/null
check "status after taken" "$(bb show "$ID" | grep -c 'taken')" 1
bb fixed "$ID" --note "PR 1" > /dev/null
bb list | grep -q "$ID" && fail "a fixed report is still listed"
check "beta untouched by alpha's work" "$(bb list --project beta | wc -l | tr -d ' ')" 2

# handover: written once, read once, never replayed; per project.
bb handover write "alpha: Ana waits for a check of the button" > /dev/null
[ -f "$BUGS_BOT_HOME/alpha/handover.md" ] || fail "handover write left no note"
bb handover read | grep -q "Ana waits" || fail "handover read lost the note"
second=$(bb handover read)
check "second read" "${second%%: /*}" "no unread handover note; last archived"
check "beta has no note" "$(bb handover read --project beta)" "no handover note"

echo "E2E OK"
