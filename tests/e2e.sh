#!/bin/sh
# End-to-end run of bin/bugs-bot against a fake Bot API and a fake Slack Web API on loopback: two
# Telegram projects and one Slack project, a temporary home.
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
SLACK_PID=""

# Runs on every way out: success, a failed command under `set -e`, a failed check, a signal.
cleanup() {
    status=$?
    trap '' EXIT INT TERM HUP
    for pid in $SERVER_PID $SLACK_PID; do
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    done
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
SLACK_TOKEN="xoxb-0000-1111-FakeSlackTokenForE2E"
printf 'TELEGRAM_BOT_TOKEN=%s\nSLACK_BOT_TOKEN=%s\n' "$TOKEN" "$SLACK_TOKEN" > "$BUGS_BOT_ENV_FILE"

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

"$PY" "$ROOT/tests/http_server_fake_slack_api.py" "$WORK/slack-port" "$WORK/slack-calls.log" "$SLACK_TOKEN" &
SLACK_PID=$!
tries=0
while [ ! -s "$WORK/slack-port" ]; do
    tries=$((tries + 1))
    [ "$tries" -le 100 ] || fail "the fake Slack API did not start"
    sleep 0.1
done
SPORT=$(cat "$WORK/slack-port")
BUGS_BOT_SLACK_API_ROOT="http://127.0.0.1:$SPORT/api"
export BUGS_BOT_SLACK_API_ROOT

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
bb delete "$ID" > /dev/null
check "messages deleted" "$(calls deleteMessage)" 1
bb show "$ID" | grep -q "on it, thanks (deleted " || fail "a deleted reply is not marked in show"
mkdir -p "$WORK/shots dir"
printf '\211PNG\r\n\032\nfake-png-body' > "$WORK/shots dir/step 1.png"
bb reply "$ID" "here is where to tap" --image "$WORK/shots dir/step 1.png" > /dev/null
"$PY" - "$WORK/calls.log" <<'PYEOF' || fail "reply --image did not send the photo threaded on the report"
import json, sys
sent = [json.loads(line)["payload"] for line in open(sys.argv[1]) if '"sendPhoto"' in line]
assert len(sent) == 1, sent
photo = sent[0]
assert photo["chat_id"] == "-1001" and photo["caption"] == "here is where to tap", photo
assert json.loads(photo["reply_parameters"]) == {"message_id": 102}, photo
assert photo["photo"] == ["image-1.png", 21, "image/png"], photo
PYEOF
bb show "$ID" | grep -q "/sent/2-1.png$" || fail "show does not list the image sent"
bb taken "$ID" > /dev/null
check "status after taken" "$(bb show "$ID" | grep -c 'taken')" 1
posted=$(calls sendMessage)
bb fixed "$ID" --note "PR 1" > /dev/null
check "messages posted by fixed --note" "$(calls sendMessage)" "$posted"
bb show "$ID" | grep -qx "fix ref: PR 1" || fail "fixed --note did not record the ref"
bb list | grep -q "$ID" && fail "a fixed report is still listed"
check "beta untouched by alpha's work" "$(bb list --project beta | wc -l | tr -d ' ')" 2

# handover: written once, read once, never replayed; per project.
bb handover write "alpha: Ana waits for a check of the button" > /dev/null
[ -f "$BUGS_BOT_HOME/alpha/handover.md" ] || fail "handover write left no note"
bb handover read | grep -q "Ana waits" || fail "handover read lost the note"
second=$(bb handover read)
check "second read" "${second%%: /*}" "no unread handover note; last archived"
check "beta has no note" "$(bb handover read --project beta)" "no handover note"

# slack: one project on a Slack channel beside the Telegram ones.
# slack_post CHANNEL SECONDS_FROM_NOW TEXT [THREAD_TS]: Ana posts in a channel (in a thread when given); prints the ts.
slack_post() {
    "$PY" - "$SPORT" "$@" <<'PYEOF'
import json, sys, time, urllib.request
port, channel, later, text = sys.argv[1:5]
ts = f"{time.time() + float(later):.6f}"
message = {"channel": channel, "ts": ts, "user": "U0ANA", "text": text}
if len(sys.argv) > 5:
    message["thread_ts"] = sys.argv[5]
urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/_post", json.dumps([message]).encode())).read()
print(ts)
PYEOF
}
slack_calls() { grep -c "\"method\": \"$1\"" "$WORK/slack-calls.log" || true; }

mkdir "$WORK/repo-gamma"
git -C "$WORK/repo-gamma" init -q
GAMMA=C0GAMMA
PARENT=$(slack_post $GAMMA 0 "gamma: export fails")
bb init --channel slack --project gamma --agent-title "Agent : Gamma" --repo "$WORK/repo-gamma" > "$WORK/init-gamma.out"
grep -q "registered $GAMMA -> gamma" "$WORK/init-gamma.out" || fail "init gamma did not register its Slack channel"
"$PY" - "$BUGS_BOT_HOME/projects.json" <<'PYEOF' || fail "the registry does not key each project by its channel"
import json, sys
keys = set(json.load(open(sys.argv[1])))
assert keys == {"telegram:-1001", "telegram:-1002", "slack:C0GAMMA"}, keys
PYEOF
bb pull
check "gamma reports" "$(bb list --project gamma | wc -l | tr -d ' ')" 1
check "alpha untouched by gamma" "$(bb list --project alpha | wc -l | tr -d ' ')" 1
check "slack reactions" "$(slack_calls reactions.add)" 1
cd "$WORK/repo-gamma"
GID=$(bb list | cut -d' ' -f1)
bb triage "$GID" bug > /dev/null
bb reply "$GID" "which file?" --mention --awaits > /dev/null
"$PY" - "$WORK/slack-calls.log" "$PARENT" <<'PYEOF' || fail "reply did not post in the report's thread with a mention"
import json, sys
posted = [json.loads(line)["payload"] for line in open(sys.argv[1]) if '"chat.postMessage"' in line]
assert posted[-1] == {"channel": "C0GAMMA", "text": "<@U0ANA> which file?", "thread_ts": sys.argv[2]}, posted[-1]
PYEOF
slack_post $GAMMA 2 "the csv one" "$PARENT" > /dev/null
bb pull
check "an answer in the thread is no report" "$(bb list | wc -l | tr -d ' ')" 1
check "the answer wakes the agent" "$(bb wait --timeout 0)" "answer $GID"
bb show "$GID" | grep -q "answer 1 .* Ana: the csv one" || fail "show does not print the answer"
check "a shown answer wakes no more" "$(bb wait --timeout 0)" ""
cd "$WORK"

echo "E2E OK"
