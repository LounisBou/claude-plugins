#!/bin/bash
# pane-e2e.sh - the coordinator's pane answered from the keyboard in a live host.
#
#   ORCHESTRATOR_E2E_API_KEY=... tests/pane-e2e.sh [--screens <file>] [--keep]
#
# NOT part of `run-tests.sh`, like `e2e.sh`: it drives a host session in a detached tmux
# session. It sends no prompt to the model, so it costs no tokens, but the host asks for an
# account before it draws anything: the key is read from the environment and the script skips
# itself without one, without tmux, or without the host. The key reaches the host through
# its `apiKeyHelper` setting, from a file of the sandbox only the user can read. The host runs
# its fullscreen layout, where the pane is docked beside the transcript.
#
# What it proves that the faked `$` cannot: how the host routes the keys. A focused pane
# whose tree is taller than its body scrolls on the arrows instead of moving the focus, so the
# choices are one picker, which holds the arrows itself; a click only gives the pane the
# keys; the text field takes text only once the picker's last option has sent the ring there.
# Everything runs under an isolated config dir and state dir: nothing of the operator's is
# read or written but the plugin checkout itself.

set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOST=${ORCHESTRATOR_HOST_CLI:-claude}
SESSION=pane-e2e-$$
SCREENS=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --screens) SCREENS="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

for need in tmux jq "$HOST"; do
  command -v "$need" >/dev/null 2>&1 || { echo "skipped: $need is not installed"; exit 0; }
done
[ -n "${ORCHESTRATOR_E2E_API_KEY:-}" ] || { echo "skipped: ORCHESTRATOR_E2E_API_KEY is not set"; exit 0; }

pass=0; fail=0; ALIVE=""
check() {
  if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1))
  else printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}

# Resolved to its real path: under a TMPDIR behind a symlink (/var is /private/var), the host
# keys its trust on the real path, misses the one the fixture accepted, and asks again.
SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-XXXXXX") && SANDBOX=$(cd "$SANDBOX" && pwd -P)
[ -d "${SANDBOX}" ] || { echo "cannot create a working directory under ${TMPDIR:-/tmp}" >&2; exit 1; }
cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null
  [ -n "$ALIVE" ] && kill "$ALIVE" 2>/dev/null
  # The host writes its config dir until it is gone: removed sooner, part of it comes back.
  sleep 2
  [ "$KEEP" = 1 ] || rm -rf "$SANDBOX"
  [ "$KEEP" = 1 ] && echo "sandbox kept: $SANDBOX"
  return 0
}
trap cleanup EXIT
[ -n "$SCREENS" ] && : > "$SCREENS"

LONG='merge it now — the release goes out today, the changelog is written, the tag is pushed and every reader of the notes sees the new pane at once'

# A fresh host on a fresh fixture: two orchestrator rows kept alive by a process of the
# script's, a round of two questions (the first with a long choice and a recommendation, the
# second with none), and the pane opened by its command.
start() {
  local rows="$1"
  tmux kill-session -t "$SESSION" 2>/dev/null
  rm -rf "$SANDBOX/config" "$SANDBOX/state" "$SANDBOX/work"
  mkdir -p "$SANDBOX/config/claude-orchestrator/store/sessions" "$SANDBOX/state/round" "$SANDBOX/work"
  ( umask 077; printf '%s\n' "$ORCHESTRATOR_E2E_API_KEY" > "$SANDBOX/key" )
  jq -n --arg key "$SANDBOX/key" '{ apiKeyHelper: ("cat " + $key), tui: "fullscreen" }' > "$SANDBOX/settings.json"
  jq -n --arg work "$SANDBOX/work" '{
    hasCompletedOnboarding: true, theme: "dark", numStartups: 5,
    projects: { ($work): { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } }
  }' > "$SANDBOX/config/.claude.json"
  echo '{"name":"Coord : e2e"}' > "$SANDBOX/state/coordinator.json"
  [ -n "$ALIVE" ] && kill "$ALIVE" 2>/dev/null
  sleep 3600 &
  ALIVE=$!
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  for who in alpha beta; do
    jq -n --arg name "Orch : $who" --arg pid "$ALIVE" --arg now "$now" '{
      role: "orchestrator", name: $name, pid: $pid, tty: null, repo: "e2e", context_percent: 12,
      context_tokens: 24000, window: 200000, model: "a-model", busy: false, updated_at: $now
    }' > "$SANDBOX/config/claude-orchestrator/store/sessions/s-$who"
  done
  jq -n --arg now "$now" --arg long "$LONG" '{
    id: "s-alpha-q1", from: "Orch : alpha", session: "s-alpha", kind: "operator", since: $now,
    blocks: "phase 3", question: "Merge the release branch now?",
    choices: [{letter:"A",text:$long},{letter:"B",text:"wait for the next review — a day lost"},{letter:"C",text:"close it — the work is dropped"}],
    recommendation: "B", status: "open", at: $now, answer: null
  }' > "$SANDBOX/state/round/s-alpha-q1.json"
  jq -n --arg now "$now" '{
    id: "s-beta-q2", from: "Orch : beta", session: "s-beta", kind: "operator", since: $now,
    blocks: "the docs", question: "Which docs first?",
    choices: [{letter:"A",text:"the design"},{letter:"B",text:"the README"}],
    recommendation: null, status: "open", at: $now, answer: null
  }' > "$SANDBOX/state/round/s-beta-q2.json"
  env -i HOME="$HOME" PATH="$PATH" TERM=xterm-256color \
    tmux new-session -d -s "$SESSION" -x 160 -y "$rows" -c "$SANDBOX/work" \
    env CLAUDE_CONFIG_DIR="$SANDBOX/config" ORCHESTRATOR_STATE_DIR="$SANDBOX/state" \
    "$HOST" --name "Coord : e2e" --settings "$SANDBOX/settings.json" --plugin-dir "$ROOT"
  wait_for 'Coord : e2e' 30
  tmux send-keys -t "$SESSION" '/orchestrator:supervision'
  sleep 1
  tmux send-keys -t "$SESSION" Enter
  wait_for 'Questions for you' 15
}

# The whole screen, and the pane's column alone with the focused cells (inverse video) marked >>.
screen() { tmux capture-pane -p -t "$SESSION"; }
pane() {
  tmux capture-pane -e -p -t "$SESSION" | awk -F'│' 'NF > 1 { print $2 }' \
    | sed -E 's/\x1b\[[0-9;]*7m/>>/g; s/\x1b\[[0-9;]*m//g' | sed '/^[[:space:]]*$/d'
}
wait_for() {
  local i
  for ((i = 0; i < $2 * 4; i++)); do screen | grep -qF -- "$1" && return 0; sleep 0.25; done
  return 1
}
record() { [ -n "$SCREENS" ] && { printf '== %s\n' "$1"; pane; printf '\n'; } >> "$SCREENS"; return 0; }
press() {
  local k
  for k in "$@"; do tmux send-keys -t "$SESSION" "$k"; sleep 0.4; done
  sleep 1
  record "after: $*"
}
# A left click (SGR press then release) on the first cell of the screen row holding `$1`.
click() {
  local row col
  row=$(screen | grep -nF -- "$1" | head -1 | cut -d: -f1)
  col=$(screen | sed -n "${row}p" | awk -F'│' '{ print length($1) + 3 }')
  tmux send-keys -t "$SESSION" -l $'\e[<0;'"$col;$row"'M'
  sleep 0.08
  tmux send-keys -t "$SESSION" -l $'\e[<0;'"$col;$row"'m'
  sleep 1.2
  record "after: a click on « $1 »"
}
wheel() {
  local i code=$([ "$1" = up ] && echo 64 || echo 65)
  for ((i = 0; i < $2; i++)); do tmux send-keys -t "$SESSION" -l $'\e[<'"$code"';120;4M'; sleep 0.2; done
  sleep 1
  record "after: the wheel $1 x$2"
}
statuses() { jq -r '.status' "$SANDBOX/state/round/s-alpha-q1.json" "$SANDBOX/state/round/s-beta-q2.json" | paste -sd, -; }
focused() { pane | grep -o '^>>.*' | sed 's/^>> *//' | head -1; }

echo "== a pane tall enough for its tree (160x50)"
start 50
record "drawn"
check "every choice's whole text is drawn above the picker" "1" "$(pane | grep -c 'sees the new pane at')"
click 'C  close it'
check "a click on a choice answers nothing" "open,open" "$(statuses)"
check "and gives the pane the keys, the picker open" "1" "$(pane | grep -c '^Answer: .*▴')"
press Escape
check "Esc gives the keys back to the prompt" "0" "$(pane | grep -c '^Answer: .*▴')"
press C-x Tab
check "ctrl+x tab: the recommended choice is highlighted first" "B  wait for the next review — a day lost  (recommended)" "$(focused)"
press Down
check "Down moves the highlight to the next choice" "C  close it — the work is dropped" "$(focused)"
sleep 21
record "after a redraw of the pane's clock"
check "a redraw never moves the highlight" "C  close it — the work is dropped" "$(focused)"
press x y
check "a letter typed on a choice answers nothing" "open,open" "$(statuses)"
press c
check "nor does a choice's own letter" "open,open" "$(statuses)"
check "which leaves a choice highlighted and types nothing in the field" "C  close it — the work is dropped|0" "$(focused)|$(pane | grep -c '^Other answer: .*c')"
press Enter
check "Enter answers the highlighted choice" "C : close it — the work is dropped" "$(jq -r .answer.text "$SANDBOX/state/round/s-alpha-q1.json")"
check "the next question is drawn, its first choice highlighted" "1|A  the design" "$(pane | grep -c 'Which docs first?')|$(focused)"
press Tab
tmux send-keys -t "$SESSION" -l 'typed on a choice'
sleep 0.6
record "after typing on a choice"
check "Tab then text on a choice: no field reached, nothing typed, nothing answered" "0|0|answered,open" "$(pane | grep -c '^Other answer: ')|$(pane | grep -c 'typed on a choice')|$(statuses)"
press Escape C-x Tab
check "Esc then ctrl+x tab bring the ring back to the picker" "1|A  the design" "$(pane | grep -c '^Answer: .*▴')|$(focused)"
press Down Down
check "the arrows reach the free answer" "Other answer: type it below" "$(focused)"
press Enter
check "Enter on it moves the keys to the text field" "1" "$(pane | grep -c '^Other answer: .*⏎ send')"
press Up
check "Up returns the keys to the picker, the field gone with them" "1|0" "$(pane | grep -c '^Answer: .*▴')|$(pane | grep -c '^Other answer: ')"
press Enter
press Escape
check "Esc from the text field gives the keys back to the prompt" "0|0" "$(pane | grep -c '^Answer: .*▴')|$(pane | grep -c '>>')"
press C-x Tab
check "ctrl+x tab reopens the picker on the free answer, the field gone" "Other answer: type it below|0" "$(focused)|$(pane | grep -c '^Other answer: ')"
press Enter
check "and Enter on it gives the field the keys again" "1" "$(pane | grep -c '^Other answer: >>')"
tmux send-keys -t "$SESSION" -l 'start with the README'
sleep 0.6
record "after typing in the field"
check "the text lands in the field and answers nothing before Enter" "1|answered,open" "$(pane | grep -c '^Other answer: start with the README')|$(statuses)"
press Enter
check "Enter sends the typed answer" "start with the README" "$(jq -r .answer.text "$SANDBOX/state/round/s-beta-q2.json")"

echo "== a pane shorter than its tree (160x14)"
start 14
record "drawn"
check "the first draw shows the picker" "1" "$(pane | grep -c '^Answer: ')"
press C-x Tab
check "ctrl+x tab: the recommended choice is highlighted first" "B  wait for the next review — a day lost  (recommended)" "$(focused)"
press Down
check "Down moves the highlight rather than scrolling" "C  close it — the work is dropped" "$(focused)"
press Down
check "and again, to the free answer, still in view" "Other answer: type it below" "$(focused)"
press Up Up Up
check "Up walks back to the first choice" "A  merge it now — the release goes out today, the changelog is writt…" "$(focused)"
wheel up 10
check "the wheel still scrolls the pane" "1" "$(pane | grep -c '^Questions for you')"
wheel down 10
check "and back down" "0" "$(pane | grep -c '^Questions for you')"
check "nothing was answered by the walk" "open,open" "$(statuses)"
press Enter
check "Enter answers the highlighted choice in the short pane" "A : $LONG" "$(jq -r .answer.text "$SANDBOX/state/round/s-alpha-q1.json")"

echo "pane-e2e: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
