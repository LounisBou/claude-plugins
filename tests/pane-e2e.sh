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

# A fresh host on a fresh fixture: orchestrator rows kept alive by a process of the script's,
# a round, and the pane opened by its command. The `questions` round holds two questions (the
# first with a long choice and a recommendation, the second with none); the `report` round
# holds a question with choices, a labelled one without, and a report that asks nothing, its
# sender's row waiting on the operator; the `aged` round holds the `questions` round's two
# questions, neither urgent, both asked two hours ago.
start() {
  local rows="$1" round="${2:-questions}"
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
  local who
  for who in alpha beta $([ "$round" = report ] && echo gamma); do
    jq -n --arg name "Orch : $who" --arg pid "$ALIVE" --arg now "$now" '{
      role: "orchestrator", name: $name, pid: $pid, tty: null, repo: "e2e", context_percent: 12,
      context_tokens: 24000, window: 200000, model: "a-model", busy: false, updated_at: $now
    }' > "$SANDBOX/config/claude-orchestrator/store/sessions/s-$who"
  done
  if [ "$round" = report ]; then
    report_round "$now"
  elif [ "$round" = aged ]; then
    questions_round "$(jq -nr 'now - 7200 | strftime("%Y-%m-%dT%H:%M:%S.000Z")')"
  else
    questions_round "$now"
  fi
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

questions_round() {
  local now="$1"
  jq -n --arg now "$now" --arg long "$LONG" '{
    id: "s-alpha-q1", from: "Orch : alpha", session: "s-alpha", kind: "operator", since: $now,
    blocks: "phase 3",
    question: ("Recorded: the docs first.\n\n**Question 1 of 2**\n_Subject_ : the release\n_Question_ : merge the release branch now?\n- **A** : " + $long
      + "\n- **B** : wait for the next review — a day lost\n- **C** : close it — the work is dropped\n_Recommendation_ : B — one more pair of eyes\n\nYou decide: A, B or C?"),
    choices: [{letter:"A",text:$long},{letter:"B",text:"wait for the next review — a day lost"},{letter:"C",text:"close it — the work is dropped"}],
    recommendation: "B", status: "open", at: $now, answer: null
  }' > "$SANDBOX/state/round/s-alpha-q1.json"
  jq -n --arg now "$now" '{
    id: "s-beta-q2", from: "Orch : beta", session: "s-beta", kind: "operator", since: $now,
    blocks: "the docs", question: "Which docs first?",
    choices: [{letter:"A",text:"the design"},{letter:"B",text:"the README"}],
    recommendation: null, status: "open", at: $now, answer: null
  }' > "$SANDBOX/state/round/s-beta-q2.json"
}

# The operator's case: a takeover report with no field and no choice, ended on a wait for him;
# its sender's row carries the wait. Beside it a question with choices, whose answer no live
# session receives, and a labelled question without choices.
REPORT_BLOCKS='line 239 (merge of speculoos#53) and the next ready PRs'
report_round() {
  local now="$1"
  jq --arg now "$now" --arg blocks "$REPORT_BLOCKS" '. + { waiting: "operator", waiting_since: $now, blocks: $blocks }' \
    "$SANDBOX/config/claude-orchestrator/store/sessions/s-alpha" > "$SANDBOX/alpha.json" \
    && mv "$SANDBOX/alpha.json" "$SANDBOX/config/claude-orchestrator/store/sessions/s-alpha"
  jq -n --arg now "$now" --arg blocks "$REPORT_BLOCKS" '{
    id: "s-alpha-r1", from: "Orch : alpha", session: "s-alpha", kind: "operator", since: $now, blocks: $blocks,
    question: "Takeover done.\n\n| PR | state |\n|---|---|\n| speculoos#53 | ready |\n| speculoos#54 | ready |",
    choices: [], recommendation: null, status: "open", at: $now, answer: null
  }' > "$SANDBOX/state/round/s-alpha-r1.json"
  jq -n --arg now "$now" '{
    id: "s-gamma-q1", from: "Orch : gamma", session: "s-gamma", kind: "operator", since: $now, blocks: "the tag",
    question: "_Question_ : tag the release?\n- **A** : tag it\n- **B** : wait",
    choices: [{letter:"A",text:"tag it"},{letter:"B",text:"wait"}], recommendation: null, status: "open", at: $now, answer: null
  }' > "$SANDBOX/state/round/s-gamma-q1.json"
  jq -n --arg now "$now" '{
    id: "s-beta-q3", from: "Orch : beta", session: "s-beta", kind: "operator", since: $now, blocks: "the docs",
    question: "**Question 1 of 1**\n_Subject_ : the docs\n_Question_ : which page goes first, and why?",
    choices: [], recommendation: null, status: "open", at: $now, answer: null
  }' > "$SANDBOX/state/round/s-beta-q3.json"
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
focused() { pane | grep -o '^>>.*' | sed -E 's/^>> *//; s/[[:space:]]*█?[[:space:]]*$//' | head -1; }
# The pane's column with its blank rows kept, and the screen rows holding the track's thumb.
rawpane() { tmux capture-pane -p -t "$SESSION" | awk -F'│' 'NF > 1 { print $2 }' | sed -E 's/[[:space:]]+$//'; }
thumb() { screen | grep -n '█$' | cut -d: -f1 | paste -sd, -; }
line_of() { pane | grep -nF -- "$1" | head -1 | cut -d: -f1; }

echo "== a pane tall enough for its tree (160x50)"
start 50
record "drawn"
check "every choice's whole text is drawn above the picker" "1" "$(pane | grep -c 'sees the new pane at')"
check "each choice's text is drawn once, the picker's options their letter" "1|1" "$(pane | grep -c 'close it — the work is dropped')|$(pane | grep -c '^  C *$')"
check "the questions are drawn above the orchestrators, counted once in their title" "1|1" "$([ "$(line_of 'Questions for you — 2 pending')" -lt "$(line_of 'Orchestrators')" ] && echo 1)|$(pane | grep -c 'pending')"
check "one numbering, the sender's, and nothing of its turn outside its fields" "Orch : alpha — Question 1 of 2|1|0|0" "$(pane | grep -m1 '^Orch : alpha')|$(pane | grep -c ' of [0-9]')|$(pane | grep -c 'Recorded')|$(pane | grep -c 'You decide')"
check "the fields as the sender labelled them, the recommendation below the choices" "1|1|1" "$(pane | grep -c '^Subject : the release')|$(pane | grep -c '^Question : merge the release')|$(pane | grep -c '^Recommendation : B — one more')"
check "a blank line between two choices, and before the picker" "||" "$(rawpane | grep -A1 '^B) wait' | sed -n 2p)|$(rawpane | grep -B1 '^B) wait' | sed -n 1p)|$(rawpane | grep -B1 '^Choose: ' | sed -n 1p)"
check "the key line is drawn in the default colour, visible" "1|0" "$(pane | grep -c 'Enter: choose')|$(tmux capture-pane -e -p -t "$SESSION" | grep 'Enter: choose' | grep -c $'\x1b\\[2m')"
check "the pane opens with the keys, the recommended choice highlighted in the open picker" "1|B (recommended)" "$(pane | grep -c '^Choose: .*▴')|$(focused)"
press Escape
check "Esc gives the keys back to the prompt" "0" "$(pane | grep -c '^Choose: .*▴')"
click 'C) close it'
check "a click on a choice answers nothing" "open,open" "$(statuses)"
check "and gives the pane the keys, the picker open" "1" "$(pane | grep -c '^Choose: .*▴')"
press Escape
check "Esc gives the keys back again" "0" "$(pane | grep -c '^Choose: .*▴')"
press C-x Tab
check "ctrl+x tab: the recommended choice is highlighted first" "B (recommended)" "$(focused)"
press Down
check "Down moves the highlight to the next choice" "C" "$(focused)"
sleep 21
record "after a redraw of the pane's clock"
check "a redraw never moves the highlight" "C" "$(focused)"
press x y
check "a letter typed on a choice answers nothing" "open,open" "$(statuses)"
press c
check "nor does a choice's own letter" "open,open" "$(statuses)"
check "which leaves a choice highlighted and types nothing in the field" "C|0" "$(focused)|$(pane | grep -c '^Other answer: .*c')"
press Enter
check "Enter answers the highlighted choice" "C : close it — the work is dropped" "$(jq -r .answer.text "$SANDBOX/state/round/s-alpha-q1.json")"
check "the next question is drawn, its first choice highlighted" "1|A" "$(pane | grep -c 'Which docs first?')|$(focused)"
press Tab
tmux send-keys -t "$SESSION" -l 'typed on a choice'
sleep 0.6
record "after typing on a choice"
check "Tab then text on a choice: no field reached, nothing typed, nothing answered" "0|0|answered,open" "$(pane | grep -c '^Other answer: ')|$(pane | grep -c 'typed on a choice')|$(statuses)"
press Escape C-x Tab
check "Esc then ctrl+x tab bring the ring back to the picker" "1|A" "$(pane | grep -c '^Choose: .*▴')|$(focused)"
press Down Down
check "the arrows reach the free answer" "Other answer: type it below" "$(focused)"
press Enter
check "Enter on it moves the keys to the text field" "1" "$(pane | grep -c '^Other answer: .*⏎ send')"
press Up
check "Up returns the keys to the picker, the field gone with them" "1|0" "$(pane | grep -c '^Choose: .*▴')|$(pane | grep -c '^Other answer: ')"
press Enter
press Escape
check "Esc from the text field gives the keys back to the prompt" "0|0" "$(pane | grep -c '^Choose: .*▴')|$(pane | grep -c '>>')"
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
check "the first draw shows the picker" "1" "$(pane | grep -c '^Choose: ')"
check "the pane opens with the keys, the recommended choice highlighted" "B (recommended)" "$(focused)"
check "the key line is pinned at the window's top, the track on its right edge" "1|1" "$(pane | head -2 | grep -c 'Enter: choose')|$([ -n "$(thumb)" ] && echo 1)"
press Escape C-x Tab
check "ctrl+x tab: the recommended choice is highlighted first" "B (recommended)" "$(focused)"
press Down
check "Down moves the highlight rather than scrolling" "C" "$(focused)"
press Down
check "and again, to the free answer, still in view" "Other answer: type it below" "$(focused)"
press Up Up Up
check "Up walks back to the first choice" "A" "$(focused)"
counted=$(thumb | tr ',' '\n' | wc -l | tr -d ' ')
wheel up 20
top=$(thumb)
check "the wheel still scrolls the pane" "1" "$(pane | grep -c '^Questions for you')"
check "the counted height is the host's: the thumb keeps its length once the host measured" "$counted" "$(thumb | tr ',' '\n' | wc -l | tr -d ' ')"
check "at the top the key line stays pinned above the title, nothing hidden under it" "1|1" "$(pane | head -2 | grep -c 'Enter: choose')|$(pane | grep -c '^Questions for you — 2 pending')"
wheel down 20
check "and back down" "0" "$(pane | grep -c '^Questions for you')"
check "the thumb moved down with the window, the key line still in view" "1|1" "$([ "${top%%,*}" -lt "$(thumb | cut -d, -f1)" ] && echo 1)|$(pane | head -2 | grep -c 'Enter: choose')"
wheel down 4
check "the window's end shows the last row, the thumb at the track's end: the content did not grow" "1|1" "$(pane | tail -1 | grep -c 'Orch : beta')|$([ "$(thumb | tr ',' '\n' | tail -1)" = "$(screen | grep -n '│$\|█$' | cut -d: -f1 | tail -1)" ] && echo 1)"
check "nothing was answered by the walk" "open,open" "$(statuses)"
press Enter
check "Enter answers the highlighted choice in the short pane" "A : $LONG" "$(jq -r .answer.text "$SANDBOX/state/round/s-alpha-q1.json")"

echo "== a wait that asks nothing, beside two questions (160x50)"
start 50 report
record "drawn"
check "the report is no question: not drawn under the questions, not counted" "1|0|0" "$(pane | grep -c '^Questions for you — 2 pending')|$(pane | grep -c 'Takeover done')|$(pane | grep -c 'speculoos#54')"
check "its sender's row still shows what it waits on and blocks" "1|1" "$(pane | grep -c 'Status: waiting for the operator')|$(pane | grep -c 'Blocks: *line 239 (merge of speculoos#53)')"
press Enter
check "Enter answers the question with choices, its sender reached by no session" "answered" "$(jq -r .status "$SANDBOX/state/round/s-gamma-q1.json")"
check "the labelled question without choices is drawn as a question, the report still out" "Orch : beta — Question 1 of 1|1|1|1|0" "$(pane | grep -m1 '^Orch : beta')|$(pane | grep -c '^Questions for you — 1 pending')|$(pane | grep -c '^Question : which page goes first')|$(pane | grep -c '^Other answer')|$(pane | grep -c 'Takeover done')"
notice=$(line_of 'not delivered:')
check "the notice is one line at the section's foot, below the question, above the orchestrators" "1|1|1" "$(pane | grep -c 'not delivered:')|$([ -n "$notice" ] && [ "$notice" -gt "$(line_of 'Question : which page')" ] && echo 1)|$([ -n "$notice" ] && [ "$notice" -lt "$(line_of 'Orchestrators')" ] && echo 1)"

# The pane's state routes each question: with the pane open no question but an urgent one is
# due, however old, so the coordinator is not woken; with the pane closed every open one is,
# at once; and one recorded while it is closed is drawn when it opens again. The wake is a
# prompt the module submits to the coordinator's session: interrupted as soon as it shows, it
# is the one model turn of this script. The module reads the round every 30 seconds.
WOKEN="$SANDBOX/state/round-woken.json"
woken() { jq -r 'sort | join(",")' "$WOKEN" 2>/dev/null; }
echo "== the pane's state routes each question (160x50)"
start 50 aged
sleep 35
record "35 seconds with the pane open"
check "pane open: two questions two hours old wake the coordinator for neither" "|0" "$(woken)|$(screen | grep -c 'now due in this tab')"
press Escape
tmux send-keys -t "$SESSION" '/orchestrator:supervision'
sleep 1
tmux send-keys -t "$SESSION" Enter
sleep 2
check "the command closes the pane, and its record goes with it" "0|0" "$(screen | grep -c 'Questions for you')|$([ -f "$SANDBOX/state/pane.json" ] && echo 1 || echo 0)"
wait_for 'now due in this tab' 40
record "the pane closed"
check "pane closed: the coordinator is woken at once for every open question" "1|s-alpha-q1,s-beta-q2" "$([ "$(screen | grep -c 'now due in this tab')" -ge 1 ] && echo 1)|$(woken)"
press Escape
jq -n --arg now "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" '{
  id: "s-alpha-q4", from: "Orch : alpha", session: "s-alpha", kind: "operator", since: $now, blocks: "the tag",
  question: "_Question_ : tag the release while the pane is closed?\n- **A** : tag it\n- **B** : wait",
  choices: [{letter:"A",text:"tag it"},{letter:"B",text:"wait"}], recommendation: null, status: "open", at: $now, answer: null
}' > "$SANDBOX/state/round/s-alpha-q4.json"
sleep 1
tmux send-keys -t "$SESSION" '/orchestrator:supervision'
sleep 1
tmux send-keys -t "$SESSION" Enter
wait_for 'Questions for you' 15
record "the pane open again"
check "reopened, the pane draws every pending question, those presented in the tab included" "1|1|open,open" "$(pane | grep -c '^Questions for you — 3 pending')|$(pane | grep -c '^Question : merge the release')|$(statuses)"

echo "pane-e2e: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
