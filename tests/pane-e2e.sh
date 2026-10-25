#!/bin/bash
# pane-e2e.sh - the coordinator's pane answered from the keyboard in a live host.
#
#   tests/pane-e2e.sh [--screens <file>] [--keep]
#
# NOT part of `run-tests.sh`, like `e2e.sh`: it drives a host session in a detached tmux
# server of its own. The host is the one logged in on this machine, on its subscription: the
# script makes no credential, asks for none and writes none. It reads the host's banner before
# it drives anything and refuses to run when the banner bills usage by the API rather than the
# subscription (ORCHESTRATOR_E2E_PLAN, `Max` by default, names the plan the banner must show).
# It types no prompt for the model: the pane is opened by its command, and the one model turn,
# the coordinator's wake in the last part, is the module's own and is interrupted once it shows.
# It skips itself without tmux, jq or the host.
#
# What it proves that the faked `$` cannot: how the host routes the keys and draws the card. A
# focused pane whose tree is taller than its body scrolls on the arrows instead of moving the
# focus, so the choices are one picker, which holds the arrows itself; a click only gives the
# pane the keys; the text field takes text only once the picker's last option has sent the ring
# there; an entry that asks two questions is answered one at a time.
#
# The host runs on its own configuration directory, which holds its login, with the user's
# settings left out (`--setting-sources project`, no MCP server) and its fullscreen layout,
# where the pane is docked beside the transcript. The host is told the terminal draws links
# (FORCE_HYPERLINK), as the operator's does: a tmux pane says nothing of it, and a host that
# cannot draw one prints its address after its text. Everything the module writes goes to the
# sandbox: its state (ORCHESTRATOR_STATE_DIR) and its own files, the store's rows among them
# (ORCHESTRATOR_MODULE_DIR), so the fixture's rows never reach the real store, and the short
# names' copies are the work directory's project commands (ORCHESTRATOR_COMMANDS_DIR), so the
# module's sync at the start never touches the host's user commands. What the host
# itself keeps of a session it ran — its counters, its session record, its caches, the
# transcript of the wake — is its own bookkeeping. Each run leaves two traces of it there, and the
# script removes neither: the transcript directory of the sandbox's work path is removed at the
# end, but the prompt history (~/.claude/history.jsonl) keeps its lines naming the sandbox, which
# the script only counts, and the host's own configuration file (~/.claude.json) keeps a project
# entry for the sandbox's work path. The script never edits that file.
# The sandbox lives under ORCHESTRATOR_E2E_DIR (/tmp by default), a directory the host already
# trusts: the script never accepts the trust question, which would write the host's
# configuration, and refuses to run when it is asked.

set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOST=${ORCHESTRATOR_HOST_CLI:-claude}
PLAN=${ORCHESTRATOR_E2E_PLAN:-Max}
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

pass=0; fail=0; ALIVE=""
check() {
  if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1))
  else printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}

# The host's own configuration directory, read for the history's count and the transcript
# directory of the sandbox's work path alone.
HOSTDIR="$HOME/.claude"
HISTORY="$HOSTDIR/history.jsonl"
BASE=${ORCHESTRATOR_E2E_DIR:-/tmp}

# Resolved to its real path: the host keys its projects on the real path.
SANDBOX=$(mktemp -d "$BASE/orchestrator-XXXXXX") && SANDBOX=$(cd "$SANDBOX" && pwd -P)
[ -d "${SANDBOX}" ] || { echo "cannot create a working directory under $BASE" >&2; exit 1; }
tm() { tmux -L "$SESSION" "$@"; }
cleanup() {
  tm kill-server 2>/dev/null
  [ -n "$ALIVE" ] && kill "$ALIVE" 2>/dev/null
  # The host writes until it is gone: removed sooner, part of it comes back.
  sleep 2
  local transcripts
  transcripts=$(printf '%s' "$SANDBOX/work" | sed 's/[^A-Za-z0-9]/-/g')
  case "$transcripts" in *-orchestrator-*-work) rm -rf "${HOSTDIR:?}/projects/$transcripts" ;; esac
  [ "$KEEP" = 1 ] || rm -rf "$SANDBOX"
  [ "$KEEP" = 1 ] && echo "sandbox kept: $SANDBOX"
  local named
  named=$(grep -cF -- "$SANDBOX" "$HISTORY" 2>/dev/null)
  echo "history: ${named:-0} lines name the sandbox"
  return 0
}
trap cleanup EXIT
[ -n "$SCREENS" ] && : > "$SCREENS"

LONG='merge it now — the release goes out today, the changelog is written, the tag is pushed and every reader of the notes sees the new pane at once'
ROWS="$SANDBOX/module/store/sessions"
COMMANDS="$SANDBOX/work/.claude/commands"

# A fresh host on a fresh fixture: orchestrator rows kept alive by a process of the script's,
# a round, and the pane opened by the coordinator's short name. The `questions` round holds two
# questions (the first with a long choice and a recommendation, the second with none); the
# `report` round holds a question with choices, a labelled one without, and a report that asks
# nothing, its sender's row waiting on the operator; the `aged` round holds the `questions`
# round's two questions, neither urgent, both asked two hours ago; the `pair` round holds one
# entry that asks two questions, its sender's row in a known repository and waiting on two pull
# requests glued by a slash.
start() {
  local rows="$1" round="${2:-questions}"
  tm kill-server 2>/dev/null
  rm -rf "$SANDBOX/module" "$SANDBOX/state" "$SANDBOX/work"
  mkdir -p "$ROWS" "$SANDBOX/state/round" "$SANDBOX/work"
  # The short names, written by the installer's own writer as the work directory's project
  # commands, never in the host's user commands: `/coordinator-supervision` below is the copy.
  ORCHESTRATOR_COMMANDS_DIR="$COMMANDS" bash "$ROOT/short-commands.sh" install >/dev/null \
    || { echo "refused: the short names could not be written to $COMMANDS" >&2; exit 1; }
  jq -n '{ tui: "fullscreen" }' > "$SANDBOX/settings.json"
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
    }' > "$ROWS/s-$who"
  done
  case "$round" in
    report) report_round "$now" ;;
    aged) questions_round "$(jq -nr 'now - 7200 | strftime("%Y-%m-%dT%H:%M:%S.000Z")')" ;;
    pair) pair_round "$now" ;;
    *) questions_round "$now" ;;
  esac
  tm new-session -d -s "$SESSION" -x 160 -y "$rows" -c "$SANDBOX/work" \
    env -i HOME="$HOME" USER="$USER" PATH="$PATH" TERM=xterm-256color FORCE_HYPERLINK=1 \
    ORCHESTRATOR_STATE_DIR="$SANDBOX/state" ORCHESTRATOR_MODULE_DIR="$SANDBOX/module" ORCHESTRATOR_COMMANDS_DIR="$COMMANDS" \
    "$HOST" --setting-sources project --strict-mcp-config --settings "$SANDBOX/settings.json" \
    --plugin-dir "$ROOT" --name "Coord : e2e"
  wait_for 'Coord : e2e' 30
  if screen | grep -qF 'trust this folder'; then
    record "the trust question"
    echo "refused: the host asks to trust $SANDBOX/work; set ORCHESTRATOR_E2E_DIR to a directory it trusts" >&2
    exit 1
  fi
  # The subscription, or nothing driven at all: the banner's first rows name the product and the
  # plan (the plan escaped, so a name with a dot or a bracket matches itself), and the API
  # billing line anywhere on the screen refuses.
  local brand plan_re
  brand=$(printf '%s' "${HOST##*/}" | awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }')
  plan_re=$(printf '%s' "$PLAN" | sed 's/[][\\.*^$(){}?+|\/-]/\\&/g')
  if screen | grep -qF 'API Usage Billing' || ! screen | head -12 | grep -qE "$brand $plan_re( |$)"; then
    record "the banner"
    echo "refused: the host's banner does not read the $PLAN subscription; nothing was driven" >&2
    screen | head -12 >&2
    exit 1
  fi
  tm send-keys -t "$SESSION" '/coordinator-supervision'
  sleep 1
  tm send-keys -t "$SESSION" Enter
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
    "$ROWS/s-alpha" > "$SANDBOX/alpha.json" && mv "$SANDBOX/alpha.json" "$ROWS/s-alpha"
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

# One turn of an orchestrator asking two questions in the decide shape, the second's subject
# named under the first's card; its sender's row in a repository whose owner is known, waiting
# on two pull requests glued by a slash.
PAIR_BLOCKS='merge of infra#195/infra#196 (staging content)'
pair_round() {
  local now="$1"
  jq --arg now "$now" --arg blocks "$PAIR_BLOCKS" '. + { repo: "acme/infra", waiting: "operator", waiting_since: $now, blocks: $blocks }' \
    "$ROWS/s-alpha" > "$SANDBOX/alpha.json" && mv "$SANDBOX/alpha.json" "$ROWS/s-alpha"
  jq -n --arg now "$now" --arg blocks "$PAIR_BLOCKS" '{
    id: "s-alpha-p1", from: "Orch : alpha", session: "s-alpha", kind: "operator", since: $now, blocks: $blocks,
    question: ("**Question 1 of 2**\n_Subject_ : the version number\n_Context_ : the public API does not change, see `plan-v2.md`.\n_Question_ : which number does the release carry?\n_Choices_ :\n- **A** : 1.15.0 — no break for the applications\n- **B** : 2.0.0 — marks the rewrite\n_Recommendation_ : A — the number follows the API\n\n"
      + "**Question 2 of 2**\n_Subject_ : the release rhythm\n_Question_ : one release per module, or one at the end?\n_Choices_ :\n- **A** : one per module — each step proven in production\n- **B** : one at the end — one upgrade per application\n_Recommendation_ : A — a regression stays in its module"),
    choices: [{letter:"A",text:"1.15.0 — no break for the applications"},{letter:"B",text:"2.0.0 — marks the rewrite"}],
    recommendation: "A", status: "open", at: $now, answer: null
  }' > "$SANDBOX/state/round/s-alpha-p1.json"
}

# The whole screen; the pane's column — what follows the first vertical bar of a row, the card's
# own bars and the track taken off — with the focused cells (inverse video) marked >>.
screen() { tm capture-pane -p -t "$SESSION"; }
column_of() {
  awk 'index($0, "│") { print substr($0, index($0, "│") + length("│")) }' \
    | sed -E 's/^[[:space:]]*│//; s/[[:space:]]*[│█]?[[:space:]]*$//; s/[[:space:]]*│$//; s/^[[:space:]]+//'
}
pane() {
  tm capture-pane -e -p -t "$SESSION" | sed -E 's/\x1b\[[0-9;]*7m/>>/g; s/\x1b\[[0-9;]*m//g; s/\x1b\]8;[^[:cntrl:]]*\x1b\\//g' \
    | column_of | sed '/^[[:space:]]*$/d'
}
wait_for() {
  local i
  for ((i = 0; i < $2 * 4; i++)); do screen | grep -qF -- "$1" && return 0; sleep 0.25; done
  return 1
}
record() { [ -n "$SCREENS" ] && { printf '== %s\n' "$1"; screen; printf '\n'; } >> "$SCREENS"; return 0; }
press() {
  local k
  for k in "$@"; do tm send-keys -t "$SESSION" "$k"; sleep 0.4; done
  sleep 1
  record "after: $*"
}
# A left click (SGR press then release) on the first cell of `$1` on the screen.
click() {
  local row col
  row=$(screen | grep -nF -- "$1" | head -1 | cut -d: -f1)
  col=$(( $(screen | sed -n "${row}p" | awk -v t="$1" '{ print substr($0, 1, index($0, t) - 1) }' | tr -d '\n' | LC_ALL=en_US.UTF-8 wc -m) + 1 ))
  tm send-keys -t "$SESSION" -l $'\e[<0;'"$col;$row"'M'
  sleep 0.08
  tm send-keys -t "$SESSION" -l $'\e[<0;'"$col;$row"'m'
  sleep 1.2
  record "after: a click on « $1 »"
}
wheel() {
  local i code=$([ "$1" = up ] && echo 64 || echo 65)
  for ((i = 0; i < $2; i++)); do tm send-keys -t "$SESSION" -l $'\e[<'"$code"';120;4M'; sleep 0.2; done
  sleep 1
  record "after: the wheel $1 x$2"
}
statuses() { jq -r '.status' "$SANDBOX/state/round/s-alpha-q1.json" "$SANDBOX/state/round/s-beta-q2.json" | paste -sd, -; }
focused() { pane | grep -o '>>.*' | sed -E 's/^>> *//; s/[[:space:]]*$//' | head -1; }
# The pane's column with its blank rows kept, the pane's words on one line, and the screen
# rows holding the track's thumb.
rawpane() { screen | column_of; }
flat() { pane | tr '\n' ' ' | tr -s ' '; }
thumb() { screen | grep -n '█$' | cut -d: -f1 | paste -sd, -; }
line_of() { pane | grep -nF -- "$1" | head -1 | cut -d: -f1; }
# The pane's rows starting with `$1` drawn dim: the host draws dim as faint or as a grey of the
# 256-colour ramp.
dim_rows() {
  tm capture-pane -e -p -t "$SESSION" \
    | grep -cE $'│(\x1b\\[[0-9;]*m)*\x1b\\[(2|38;5;2(3[2-9]|4[0-9]|5[0-5]))m(\x1b\\[[0-9;]*m)*'"$1"
}

echo "== a pane tall enough for its tree (160x50)"
start 50
record "drawn"
check "every choice's whole text is drawn above the picker" "1" "$(flat | grep -c 'sees the new pane at once')"
check "each choice's text is drawn once, the picker's options their letter" "1|1" "$(pane | grep -c 'close it — the work is dropped')|$(pane | grep -c '^C$')"
check "the questions are drawn above the orchestrators, counted once in their title" "1|1" "$([ "$(line_of 'Questions for you — 2 pending')" -lt "$(line_of 'Orchestrators')" ] && echo 1)|$(pane | grep -c 'pending')"
check "the question in a rounded card, titled by its sender and its number" "1|Orch : alpha · Question 1 / 2" "$([ "$(screen | grep -c '╭─')" -ge 1 ] && echo 1)|$(pane | grep -m1 '^Orch : alpha')"
check "one numbering, the sender's, and nothing of its turn outside its fields" "1|0|0" "$(pane | grep -cE '[0-9] / [0-9]')|$(pane | grep -c 'Recorded')|$(pane | grep -c 'You decide')"
check "each label upper-case on its own line, its text under it, the recommendation starred" "the release|merge the release branch now?|1" "$(pane | grep -A1 '^SUBJECT$' | sed -n 2p)|$(pane | grep -A1 '^QUESTION$' | sed -n 2p)|$(pane | grep -c '^★ Recommendation : B — one more')"
check "each choice behind its badge, the recommended one starred" "1|1" "$(pane | grep -c '^\[C\] *close it')|$(pane | grep -c '^\[B\] *wait for the next review — a day lost *★')"
check "a blank line between two choices, and before the picker" "||" "$(rawpane | grep -A1 '^\[B\] *wait' | sed -n 2p)|$(rawpane | grep -B1 '^\[B\] *wait' | sed -n 1p)|$(rawpane | grep -B1 '^Choose: ' | sed -n 1p)"
check "the rule and the key line, dim, the key line at the foot" "1|1|1" "$(dim_rows '────')|$(dim_rows 'arrows: move')|$([ "$(line_of 'Enter: choose')" -gt "$(line_of 'Orchestrators')" ] && echo 1)"
check "the pane opens with the keys, the recommended choice highlighted in the open picker" "1|B (recommended)" "$(pane | grep -c '^Choose: .*▴')|$(focused)"
press Escape
check "Esc gives the keys back to the prompt" "0" "$(pane | grep -c '^Choose: .*▴')"
click 'close it — the work'
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
tm send-keys -t "$SESSION" -l 'typed on a choice'
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
check "and Enter on it gives the field the keys again" "1" "$(pane | grep -c '^Other answer: .*⏎ send')"
tm send-keys -t "$SESSION" -l 'start with the README'
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
wheel up 30
top=$(thumb)
check "the wheel still scrolls the pane" "1" "$(pane | grep -c '^Questions for you')"
check "the counted height is the host's: the thumb keeps its length once the host measured" "$counted" "$(thumb | tr ',' '\n' | wc -l | tr -d ' ')"
check "at the top the key line stays pinned above the title, nothing hidden under it" "1|1" "$(pane | head -2 | grep -c 'Enter: choose')|$(pane | grep -c '^Questions for you — 2 pending')"
wheel down 30
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
check "its sender's row still shows what it waits on and blocks, each label in its column" "1|1" "$(pane | grep -c '^Status: *waiting for the operator')|$(pane | grep -c '^Blocks: *line 239 (merge of speculoos#53)')"
press Enter
check "Enter answers the question with choices, its sender reached by no session" "answered" "$(jq -r .status "$SANDBOX/state/round/s-gamma-q1.json")"
check "the labelled question without choices is drawn as a question, the report still out" "Orch : beta · Question 1 / 1|1|1|1|0" "$(pane | grep -m1 '^Orch : beta')|$(pane | grep -c '^Questions for you — 1 pending')|$(pane | grep -c '^which page goes first')|$(pane | grep -c '^Other answer')|$(pane | grep -c 'Takeover done')"
notice=$(line_of 'not delivered:')
check "the notice is one line at the section's foot, below the question, above the orchestrators" "1|1|1" "$(pane | grep -c 'not delivered:')|$([ -n "$notice" ] && [ "$notice" -gt "$(line_of 'which page goes first')" ] && echo 1)|$([ -n "$notice" ] && [ "$notice" -lt "$(line_of 'Orchestrators')" ] && echo 1)"

echo "== an entry that asks two questions (160x50)"
start 50 pair
record "drawn"
check "the first question alone in the card, the second named under it" "Orch : alpha · Question 1 / 2|0|1" "$(pane | grep -m1 '^Orch : alpha')|$(pane | grep -c 'one release per module')|$(pane | grep -c '^next: Question 2 / 2 — the release rhythm')"
check "the count is the questions left, inline code drawn without its backticks" "1|1|0" "$(pane | grep -c '^Questions for you — 2 pending')|$(flat | grep -c 'see plan-v2.md')|$(pane | grep -c '`')"
check "the glued pull requests read as written, each a link of its own" "1|2" "$(pane | grep -c 'infra#195/infra#196')|$(tm capture-pane -e -p -t "$SESSION" | grep -o $'\x1b\\]8;[^\x1b]*pull/19[56]' | sort -u | wc -l | tr -d ' ')"
press Enter
check "the first answer moves to the second question and sends nothing" "Orch : alpha · Question 2 / 2|1|open|0" "$(pane | grep -m1 '^Orch : alpha')|$(pane | grep -c '^Questions for you — 1 pending')|$(jq -r .status "$SANDBOX/state/round/s-alpha-p1.json")|$(pane | grep -c '^next:')"
press Down Enter
check "the last answer sends both, each after its number" "Question 1 of 2: A : 1.15.0 — no break for the applications · Question 2 of 2: B : one at the end — one upgrade per application" "$(jq -r .answer.text "$SANDBOX/state/round/s-alpha-p1.json")"

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
tm send-keys -t "$SESSION" '/orchestrator-supervision'
sleep 1
tm send-keys -t "$SESSION" Enter
sleep 2
check "the other role's short name closes the pane the coordinator's opened, and its record goes with it" "0|0" "$(screen | grep -c 'Questions for you')|$([ -f "$SANDBOX/state/pane.json" ] && echo 1 || echo 0)"
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
tm send-keys -t "$SESSION" '/orchestrator:supervision'
sleep 1
tm send-keys -t "$SESSION" Enter
wait_for 'Questions for you' 15
record "the pane open again"
check "reopened by the file's own prefixed name, the pane draws every pending question, those presented in the tab included" "1|1|open,open" "$(pane | grep -c '^Questions for you — 3 pending')|$(flat | grep -c 'merge the release branch now?')|$(statuses)"

# The short names as the installer writes them, here as project commands: the typeahead draws
# one name per row and one row per description, and the copy of `/coordinator-supervision`
# toggles the pane. The host also reads the operator's real ~/.claude/commands (HOME is kept
# for its login), so the rows of the operator's own copies may be drawn too: the checks count
# a wrapped description only on the rows of the sandbox's names, and need two rows at least,
# so they hold whether or not the real copies exist. A row of the list starts with its name;
# a description too long for its row continues on the next, indented under the descriptions'
# column.
typeahead() {
  tm send-keys -t "$SESSION" -l "$1"
  sleep 2
  record "the typeahead after $1"
  local drawn shown names
  drawn=$(screen)
  # Only the sandbox's rows count a wrap: the host, run with the real HOME, also lists the
  # operator's own user commands, whose descriptions this script does not own.
  names=$(ls "$COMMANDS" | sed 's/\.md$//' | tr '\n' ' ')
  shown=$(printf '%s\n' "$drawn" | awk -v names="$names" '
    /^  (❯ |  )\// { list = 1; print "name"; row = $0; sub(/^  (❯ |  )\//, "", row); split(row, w, " "); mine = index(" " names, " " w[1] " ") > 0; next }
    list && /^                    +[^ ]/ { if (mine) print "wrap"; next }
    { list = 0 }')
  tm send-keys -t "$SESSION" C-u
  sleep 0.5
  printf '%s|%s|%s' "$([ "$(printf '%s\n' "$shown" | grep -c '^name$')" -ge 2 ] && echo rows)" \
    "$(printf '%s\n' "$shown" | grep -c '^wrap$')" "$(printf '%s\n' "$drawn" | grep -cE ':[a-z-]+ \([a-z-]+\)')"
}
echo "== the short names as project commands (160x50)"
start 50
check "the copy the writer marked opened the pane, its marker read" "1|1" "$(pane | grep -c '^Questions for you')|$(grep -cx 'installed-by: claude-orchestrator' "$COMMANDS/coordinator-supervision.md")"
press Escape
tm send-keys -t "$SESSION" '/coordinator-supervision'
sleep 1
tm send-keys -t "$SESSION" Enter
sleep 2
record "the pane toggled closed"
check "typed again, the project command closes the pane" "0|1" "$(screen | grep -c 'Questions for you')|$(screen | grep -c 'Supervision pane closed.')"
check "after /orc, one name per row and one row per description" "rows|0|0" "$(typeahead '/orc')"
check "after /coordinator, one name per row and one row per description" "rows|0|0" "$(typeahead '/coordinator')"

echo "pane-e2e: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
