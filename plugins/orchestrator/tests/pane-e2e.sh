#!/bin/bash
# pane-e2e.sh - the coordinator's pane answered from the keyboard in a live host.
#
#   tests/pane-e2e.sh [--screens <file>] [--keep]
#
# A failed check keeps the module's log: in `pane-e2e-module.log` beside the screens' file,
# else its last lines printed under the failure.
#
# NOT part of `run-tests.sh`, like `e2e.sh`: it drives a host session in a detached tmux
# server of its own. The host is the one logged in on this machine, on its subscription: the
# script makes no credential, asks for none and writes none. It reads the host's banner before
# it drives anything and refuses to run when the banner bills usage by the API rather than the
# subscription: any plan the banner shows is a subscription (ORCHESTRATOR_E2E_PLAN, unset by
# default, narrows it to the one plan it names).
# Until its last part it types no prompt for the model: the pane is opened by its command, and
# the coordinator's turns — its wake, the module's notices that a question is settled — are the
# module's own and are interrupted once they show. The last part starts a second host, an
# orchestrator, whose banner is read the same way, and drives its model with project commands
# that ask it to reply with a fixed text, and with one prompt typed in its tab; then a fresh
# coordinator's model is driven by a project command that asks it to call the ask tool itself.
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
# where the pane is docked beside the transcript. Those settings hold `enabledPlugins`, so the
# plugins the module depends on (method, github) would be « not installed » to it, and a host
# that finds a dependency missing loads no module at all: the pane never draws and the module's
# log stays empty. They are loaded with the module as `--plugin-dir` folders, copies of this
# repository's under the sandbox, which the host writes in (tests/e2e-host.sh). The host is told the terminal draws links
# (FORCE_HYPERLINK), as the operator's does: a tmux pane says nothing of it, and a host that
# cannot draw one prints its address after its text. Everything the module writes goes to the
# sandbox: its state (ORCHESTRATOR_STATE_DIR) and its own files, the store's rows among them
# (ORCHESTRATOR_MODULE_DIR), so the fixture's rows never reach the real store, and the short
# names' copies are the work directory's project commands (ORCHESTRATOR_COMMANDS_DIR), so the
# module's sync at the start never touches the host's user commands, and the checkouts its stop
# gate sweeps are the sandbox's, none (ORCHESTRATOR_WORKSPACES): an orchestrator's turn end runs
# `workspace.sh sweep`, which on the default root deletes the operator's merged checkouts. What the host
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
PLAN=${ORCHESTRATOR_E2E_PLAN:-}
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
# shellcheck source=e2e-host.sh
. "$ROOT/tests/e2e-host.sh"

pass=0; fail=0; known=0; ALIVE=""
check() {
  if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1))
  else printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fail=$((fail+1)); keep_log "FAIL $1"; fi
}
# A check the pane is known to fail, a defect this script found and does not fix: printed with
# what the pane did, counted apart, never a failure. The day it passes the defect is fixed, and
# the run fails until the mark is removed (`check` in its place).
known_defect() {
  if [ "$2" = "$3" ]; then printf '  FAIL %s\n       fixed: it now passes, make it a check\n' "$1"; fail=$((fail+1))
  else printf '  KNOWN DEFECT %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; known=$((known+1)); fi
}
# The module's log as it stands, kept past the sandbox so a fall can be read afterwards: each
# section's start wipes it, and the end removes the sandbox. Appended under `$1` to the file
# beside the screens, else its last lines printed.
keep_log() {
  local log="$SANDBOX/module/hooks-module.log"
  if [ ! -s "$log" ]; then echo "       module log: empty or absent ($1)"
  elif [ -n "$SCREENS" ]; then
    { printf '== %s\n' "$1"; cat "$log"; printf '\n'; } >> "$MODULE_LOG"
    echo "       module log kept in $MODULE_LOG"
  else tail -n 30 "$log" | sed 's/^/       log: /'; fi
  return 0
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
  # The last section's log once its hosts are gone, with what they wrote after its checks.
  [ "$fail" -gt 0 ] && keep_log "the module's log at the end"
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
# The module's dependencies, copied under the sandbox (tests/e2e-host.sh).
e2e_plugin_args "$ROOT" "$SANDBOX/plugins" || exit 1
[ -n "$SCREENS" ] && : > "$SCREENS"
MODULE_LOG="$(dirname "${SCREENS:-.}")/pane-e2e-module.log"
[ -n "$SCREENS" ] && : > "$MODULE_LOG"

# The subscription, or nothing driven at all: the banner's first rows, read from the screen given
# (`$1`), name the product and the plan, and the API billing line anywhere on that screen refuses
# (e2e_banner_ok). Every host the script starts is read so before anything is typed in it.
subscription_or_exit() {
  local brand
  brand=$(printf '%s' "${HOST##*/}" | awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }')
  if ! e2e_banner_ok "$brand" "$PLAN" "$1"; then
    [ -n "$SCREENS" ] && printf '== the banner\n%s\n\n' "$1" >> "$SCREENS"
    echo "refused: the host's banner does not read $([ -n "$PLAN" ] && echo "the $PLAN" || echo a) subscription; nothing more was driven" >&2
    printf '%s\n' "$1" | head -12 >&2
    exit 1
  fi
}

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
# requests glued by a slash. `$3` is the text whose showing says the pane is drawn: its title by
# default, which a window too short for it never shows.
start() {
  local rows="$1" round="${2:-questions}" drawn="${3:-Questions for you}"
  tm kill-server 2>/dev/null
  rm -rf "$SANDBOX/module" "$SANDBOX/state" "$SANDBOX/work"
  mkdir -p "$ROWS" "$SANDBOX/state/round" "$SANDBOX/work"
  # The short names, written by the installer's own writer as the work directory's project
  # commands, never in the host's user commands: `/orchestrator-supervision` below is the copy.
  ORCHESTRATOR_COMMANDS_DIR="$COMMANDS" bash "$ROOT/short-commands.sh" install >/dev/null \
    || { echo "refused: the short names could not be written to $COMMANDS" >&2; exit 1; }
  # A section's own project commands, written before the host starts: it reads them only then.
  [ -n "${START_COMMANDS:-}" ] && "$START_COMMANDS"
  jq -n '{ tui: "fullscreen", remoteControlAtStartup: false }' > "$SANDBOX/settings.json"
  echo '{"name":"Coord: e2e"}' > "$SANDBOX/state/coordinator.json"
  [ -n "$ALIVE" ] && kill "$ALIVE" 2>/dev/null
  sleep 3600 &
  ALIVE=$!
  disown "$ALIVE"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  local who
  for who in alpha beta $([ "$round" = report ] && echo gamma); do
    jq -n --arg name "Orch: $who" --arg pid "$ALIVE" --arg now "$now" '{
      role: "orchestrator", name: $name, pid: $pid, tty: null, repo: "e2e", context_percent: 12,
      context_tokens: 24000, window: 200000, model: "a-model", busy: false, updated_at: $now
    }' > "$ROWS/s-$who"
  done
  case "$round" in
    report) report_round "$now" ;;
    aged) questions_round "$(jq -nr 'now - 7200 | strftime("%Y-%m-%dT%H:%M:%S.000Z")')" ;;
    pair) pair_round "$now" ;;
    flow) : ;;
    *) questions_round "$now" ;;
  esac
  tm new-session -d -s "$SESSION" -x "${COLS:-160}" -y "$rows" -c "$SANDBOX/work" \
    env -i HOME="$HOME" USER="$USER" PATH="$PATH" TERM=xterm-256color FORCE_HYPERLINK=1 \
    ORCHESTRATOR_STATE_DIR="$SANDBOX/state" ORCHESTRATOR_MODULE_DIR="$SANDBOX/module" ORCHESTRATOR_COMMANDS_DIR="$COMMANDS" \
    ORCHESTRATOR_WORKSPACES="$SANDBOX/workspaces" \
    "$HOST" --setting-sources project --strict-mcp-config --settings "$SANDBOX/settings.json" \
    "${E2E_PLUGIN_ARGS[@]}" --name "Coord: e2e"
  wait_for 'Coord: e2e' 30
  if screen | grep -qF 'trust this folder'; then
    record "the trust question"
    echo "refused: the host asks to trust $SANDBOX/work; set ORCHESTRATOR_E2E_DIR to a directory it trusts" >&2
    exit 1
  fi
  subscription_or_exit "$(screen)"
  tm send-keys -t "$SESSION" '/orchestrator-supervision'
  sleep 1
  tm send-keys -t "$SESSION" Enter
  wait_for "$drawn" 15
}

# One question asked with `ask`, as the tool stores it (hooks/question.ts, format 2), one file of
# the round: `<id> <asker> <at> <subject> <context> <question> <choices> <recommended> <why> <blocks>`,
# the choices a JSON list of their texts (lettered in order), `recommended` and `why` empty for none.
# Its asker is the fixture's row of that name (`alpha` is `Orch: alpha`, session `s-alpha`).
asked() {
  jq -n --arg id "$1" --arg who "$2" --arg at "$3" --arg subject "$4" --arg context "$5" --arg ask "$6" \
    --argjson choices "$7" --arg rec "$8" --arg why "$9" --arg blocks "${10}" '{
    v: 2, id: $id, sender: { session: ("s-" + $who), name: ("Orch: " + $who), role: "orchestrator", machine: "e2e-box" },
    subject: $subject, context: $context, ask: $ask,
    choices: [$choices | to_entries[] | { letter: (["A","B","C","D","E"][.key]), text: .value }],
    recommended: (if $rec == "" then null else $rec end), why: (if $why == "" then null else $why end),
    blocks: $blocks, status: "open", at: $at, answer: null, seq: 1
  }' > "$SANDBOX/state/round/$1.json"
}

# The `questions` round: alpha asks to merge the release, a long choice first and one recommended,
# beta asks which docs go first, with no recommendation.
questions_round() {
  local now="$1"
  asked s-alpha-q1 alpha "$now" "the release" "The changelog is written and the tag is pushed." "Merge the release branch now?" \
    "$(jq -nc --arg long "$LONG" '[$long, "wait for the next review — a day lost", "close it — the work is dropped"]')" B "one more pair of eyes" "phase 3"
  asked s-beta-q2 beta "$now" "the docs" "Two pages are drafted." "Which docs first?" '["the design", "the README"]' "" "" "the docs"
}

# The operator's case: an orchestrator ended on a wait for him that asks nothing, its row carrying
# the wait, beside two questions asked with `ask` by others: one with choices, whose answer no live
# session receives, and one without choices.
REPORT_BLOCKS='line 239 (merge of speculoos#53) and the next ready PRs'
report_round() {
  local now="$1"
  jq --arg now "$now" --arg blocks "$REPORT_BLOCKS" '. + { waiting: "operator", waiting_since: $now, blocks: $blocks }' \
    "$ROWS/s-alpha" > "$SANDBOX/alpha.json" && mv "$SANDBOX/alpha.json" "$ROWS/s-alpha"
  asked s-gamma-q1 gamma "$now" "the tag" "The release is merged." "Tag the release?" '["tag it", "wait"]' "" "" "the tag"
  asked s-beta-q3 beta "$now" "the docs" "Two pages are drafted." "Which page goes first, and why?" '[]' "" "" "the docs"
}

# One orchestrator asking two questions in a turn, each its own `ask`, its row in a known
# repository and waiting on two pull requests glued by a slash.
PAIR_BLOCKS='merge of infra#195/infra#196 (staging content)'
pair_round() {
  local now="$1" later
  later=$(jq -nr --arg t "$now" '$t | sub("\\.[0-9]+Z$"; "Z") | fromdate + 1 | strftime("%Y-%m-%dT%H:%M:%S.000Z")')
  jq --arg now "$now" --arg blocks "$PAIR_BLOCKS" '. + { repo: "acme/infra", waiting: "operator", waiting_since: $now, blocks: $blocks }' \
    "$ROWS/s-alpha" > "$SANDBOX/alpha.json" && mv "$SANDBOX/alpha.json" "$ROWS/s-alpha"
  asked s-alpha-p1 alpha "$now" "the version number" "The public API does not change." "Which number does the release carry?" \
    '["1.15.0 — no break for the applications", "2.0.0 — marks the rewrite"]' A "the number follows the API" "$PAIR_BLOCKS"
  asked s-alpha-p2 alpha "$later" \
    "the release rhythm" "Each module can ship alone." "One release per module, or one at the end?" \
    '["one per module — each step proven in production", "one at the end — one upgrade per application"]' A "a regression stays in its module" "$PAIR_BLOCKS"
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

# --- helpers of the sections below ---

# The pane's state routes each question: with the pane open no question but an urgent one is
# due, however old, so the coordinator is not woken; with the pane closed every open one is,
# at once; and one recorded while it is closed is drawn when it opens again. The wake is a
# prompt the module submits to the coordinator's session: interrupted as soon as it shows, it
# is the one model turn of this script. The module reads the round every 30 seconds.
WOKEN="$SANDBOX/state/round-woken.json"
woken() { jq -r 'sort | join(",")' "$WOKEN" 2>/dev/null; }
# The module records the wake only once the host took its prompt (wakeForDue), with a rename it
# runs as a process: the prompt is on the screen before the file holds it, so the file is waited
# for on its own, never read at the moment the screen shows the wake.
wait_woken() {
  local i
  for ((i = 0; i < $1 * 4; i++)); do [ -n "$(woken)" ] && return 0; sleep 0.25; done
  return 1
}
# The cost of the pane's clock, which stats the round every 2 s: the host's processor time over
# these idle seconds, printed, never asserted.
host_cpu() { ps -o time= -p "$(tm display-message -p -t "$SESSION" '#{pane_pid}')" | awk -F'[:.]' '{ print ($1 * 60 + $2) * 100 + $3 }'; }

# The short names as the installer writes them, here as project commands: the typeahead draws
# one name per row and one row per description, and the copy of `/orchestrator-supervision`, the
# one command of both roles (the operator's ruling 229, « B »), toggles the pane. The host also
# reads the operator's real ~/.claude/commands (HOME is kept
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
# The whole flow, one scenario per path a question leaves by, each asked once and gone from every
# surface: (a) answered in the pane, (c) answered in the coordinator's tab, (e) a wait that asks
# nothing answered from its field — the coordinator's host alone —, then, with a live orchestrator
# host beside it, (d) a question with choices followed by a turn that asks nothing, both drawn,
# and (b) a question answered in the orchestrator's own tab, then (f) a question the coordinator
# asked itself answered in its own pane. The orchestrator's turns are its
# model's: each is a project command asking it to reply with a fixed text, so its machine line is
# known, and a slash command is no prompt the operator typed. The pane is open and its questions
# are not urgent, so a plain `round` would print each as its header alone, the pane's, and record
# none as shown: `round-listed.json` would stay empty. `round --by-urgency` is run instead, as the
# coordinator's decision round runs it: every question's text is printed and the entries it was
# shown are recorded. The module closes such an entry itself once it is
# settled, and tells the coordinator in one line with nothing to run. The time
# is stamped once, the moment the answer is given, and both delays are measured from that stamp
# — the question leaving the pane and the notice reaching the coordinator's tab —, polled in one
# loop; (b)'s include the sender's model turn, whose end settles the entry, and the time after that
# end is printed and checked apart. A turn the notice starts in the coordinator is interrupted once
# it shows.
COORDSH="$ROOT/skills/coordinator/scripts/coordinator.sh"
DELAYS=""
# The poll's own floor: one screen read plus a 100 ms sleep a round. A figure at or under it says
# only that the change was already there at the first read or the next.
FLOOR_MS=200
coordround() { ORCHESTRATOR_STATE_DIR="$SANDBOX/state" ORCHESTRATOR_MODULE_DIR="$SANDBOX/module" CLAUDE_CONFIG_DIR="$SANDBOX/module-config" bash "$COORDSH" "$@"; }
ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }
# The milliseconds until `$2` holds (a command), polled every 100 ms up to `$1` seconds, or « never ».
until_ms() {
  local bound="$1" start i
  shift
  start=$(ms)
  for ((i = 0; i < bound * 10; i++)); do
    "$@" && { echo $(( $(ms) - start )); return 0; }
    sleep 0.1
  done
  echo never
}
# From the stamp `$1`, taken when the answer was given, the milliseconds until the pane lacks `$3`
# and until the coordinator's tab shows `$4`, both polled in the same loop every 100 ms up to `$2`
# seconds: « <pane> <tab> », each « never » when it does not happen, the tab « n/a » when `$4` is
# empty. Each figure is read after the screen read that saw it.
since_answer() {
  local t0="$1" bound="$2" text="$3" notice="$4" gone=never told=never i
  [ -z "$notice" ] && told=n/a
  for ((i = 0; i < bound * 10; i++)); do
    [ "$gone" = never ] && pane_lacks "$text" && gone=$(( $(ms) - t0 ))
    [ "$told" = never ] && in_tab "$notice" && told=$(( $(ms) - t0 ))
    [ "$gone" != never ] && [ "$told" != never ] && break
    sleep 0.1
  done
  echo "$gone $told"
}
status_is() { [ "$(jq -r .status "$SANDBOX/state/round/$1.json" 2>/dev/null)" = "$2" ]; }
# The question gone from a pane that is drawn: its « Questions for you » header on screen, so an
# empty or failed screen never reads as a question gone.
pane_lacks() {
  local drawn
  drawn=$(pane)
  printf '%s\n' "$drawn" | grep -qF 'Questions for you' && ! printf '%s\n' "$drawn" | grep -qF -- "$1"
}
# The coordinator's tab as the operator reads it: the screen's transcript column, what precedes
# the pane's bar on each row, on one line. Its transcript file is no measure: the host writes it
# late, and the orchestrator's host, in the same work directory, writes beside it.
tab() { screen | awk '{ i = index($0, "│"); print i ? substr($0, 1, i - 1) : $0 }' | tr '\n' ' ' | tr -s ' '; }
in_tab() { tab | grep -qF -- "$1"; }
# A turn's end as the tab draws it: the host's « ✻ <verb> for 4s · done 9:30 PM » line, which a
# turn in progress (« ✻ Crafting… ») does not carry. The model's own words are no mark of it: a
# reply may or may not stand in a message of its own.
turn_done() { tab | grep -qE 'for [0-9ms ]+ · done'; }
pane_has() { pane | grep -qF -- "$1"; }
picker_open() { pane | grep -q '^Choose: .*▴'; }
tab_count() { tab | grep -o -F -- "$1" | wc -l | tr -d ' '; }
# The pane given the keys when it has not them: it holds them on its open, and ctrl+x tab then
# gives them back to the prompt.
keys_to_pane() { pane | grep -qF 'ctrl+x tab or a click' && press C-x Tab; return 0; }
# A figure as measured, or « ≤ ~200 ms » when it sits on the poll's floor.
shown() {
  case "$1" in
    never|n/a) echo "$1" ;;
    *) [ "$1" -le "$FLOOR_MS" ] && echo "≤ ~${FLOOR_MS} ms" || echo "$1 ms" ;;
  esac
}
delay() { DELAYS="$DELAYS$1: pane $(shown "$2"), tab $(shown "$3"); "; echo "  delay $1: pane $(shown "$2"), tab $(shown "$3")"; }
fluid() { [ "$1" != never ] && [ "$1" -le 3000 ] && echo yes || echo "no ($1 ms)"; }

# --- the sections ---

# 1 when the pane's rows named, in the order given, come in that order, each once past the last.
ordered() {
  local previous=0 at text
  for text in "$@"; do
    at=$(line_of "$text")
    [ -n "$at" ] && [ "$at" -gt "$previous" ] || { echo 0; return; }
    previous=$at
  done
  echo 1
}

echo "== a pane tall enough for its tree (160x50)"
start 50
record "drawn"
check "every choice's whole text is drawn above the picker" "1" "$(flat | grep -c 'sees the new pane at once')"
check "each choice's text is drawn once, the picker's options their letter" "1|1" "$(pane | grep -c 'close it — the work is dropped')|$(pane | grep -c '^C$')"
check "the questions are drawn above the orchestrators, counted once in their title" "1|1" "$([ "$(line_of 'Questions for you — 2 pending')" -lt "$(line_of 'Orchestrators')" ] && echo 1)|$(pane | grep -c 'pending')"
check "each asker named once above its questions, in no card" "Orch: alpha · orchestrator · e2e-box|1|0" "$(pane | grep -m1 '^Orch: alpha')|$(pane | grep -c '^Orch: alpha')|$(screen | grep -c '╭─')"
check "the question's fields in order: subject, context, question, choices, recommendation, blocks, picker" "1" "$(ordered 'Orch: alpha' 'the release' 'The changelog is written' 'Merge the release branch now?' '[A] merge it now' '[B] wait for' '[C] close it' '★ Recommendation' 'Blocks: phase 3' 'Choose: ')"
check "the recommendation starred, what the question blocks named, nothing of the asker's turn drawn" "1|1|0" "$(pane | grep -c '^★ Recommendation: B — one more pair of eyes')|$(pane | grep -c '^Blocks: phase 3')|$(pane | grep -c 'You decide')"
check "each choice behind its badge, the recommended one starred" "1|1" "$(pane | grep -c '^\[C\] *close it')|$(pane | grep -c '^\[B\] *wait for the next review — a day lost *★')"
check "the picker follows the question's last line" "Blocks: phase 3" "$(rawpane | grep -B1 '^Choose: ' | sed -n 1p)"
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
check "the next question takes the picker, its first choice highlighted" "1|A" "$(pane | grep -c '^Choose: .*▴')|$(focused)"
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
# The window is moved to the picker after the first draw, and the pane drawn again once it has:
# the screen is read once the picker shows and the key line is pinned above it, or after 5 s.
start 14 questions 'Choose: '
for ((i = 0; i < 20; i++)); do pane | head -2 | grep -qF 'Enter: choose' && break; sleep 0.25; done
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
check "the window's end shows the last row, the thumb at the track's end: the content did not grow" "1|1" "$(pane | tail -1 | grep -c 'Orch: beta')|$([ "$(thumb | tr ',' '\n' | tail -1)" = "$(screen | grep -n '│$\|█$' | cut -d: -f1 | tail -1)" ] && echo 1)"
check "nothing was answered by the walk" "open,open" "$(statuses)"
press Enter
check "Enter answers the highlighted choice in the short pane" "A : $LONG" "$(jq -r .answer.text "$SANDBOX/state/round/s-alpha-q1.json")"

echo "== a wait that asks nothing, beside two questions (160x50)"
start 50 report
# The facts the checks below read are waited for, each up to a bound, never a fixed sleep: the
# last rows drawn are the question's field and the section's line of who waits.
wait_for 'Other answer' 15
wait_for 'ask the coordinator' 15
record "drawn"
check "the wait that asks nothing is no question: two are counted, the section says who waits" "1|1" "$(pane | grep -c '^Questions for you — 2 pending')|$(pane | grep -c '^1 orchestrator waits for you: ask the coordinator')"
check "its row still shows what it waits on and blocks, each label in its column" "1|1" "$(pane | grep -c '^Status: *waiting for the operator')|$(pane | grep -c '^Blocks: *line 239 (merge of speculoos#53)')"
check "the question without choices takes its field at once, with no picker" "1|0" "$(pane | grep -c '^Other answer')|$(pane | grep -c '^Choose: ')"
# The field is given the keys by a click: the pane holds them at its open, the ring on no element.
click 'Other answer'
wait_for '⏎ send' 5
tm send-keys -t "$SESSION" -l 'the design first'
wait_for 'the design first' 5
press Enter
until_ms 10 status_is s-beta-q3 answered >/dev/null
until_ms 15 pane_has 'Questions for you — 1 pending' >/dev/null
until_ms 15 picker_open >/dev/null
check "the free question answered from its field" "answered|the design first" "$(jq -r .status "$SANDBOX/state/round/s-beta-q3.json")|$(jq -r .answer.text "$SANDBOX/state/round/s-beta-q3.json")"
check "the question with choices is drawn next, its picker open on the first choice" "1|1|A" "$(pane | grep -c '^Questions for you — 1 pending')|$(pane | grep -c '^Choose: .*▴')|$(focused)"
press Enter
until_ms 10 status_is s-gamma-q1 answered >/dev/null
until_ms 15 pane_has 'not delivered:' >/dev/null
check "Enter answers it, its sender reached by no session" "answered|A : tag it" "$(jq -r .status "$SANDBOX/state/round/s-gamma-q1.json")|$(jq -r .answer.text "$SANDBOX/state/round/s-gamma-q1.json")"
notice=$(line_of 'not delivered:')
check "the notice is one line at the section's foot, above the orchestrators" "1|1" "$(pane | grep -c 'not delivered:')|$([ -n "$notice" ] && [ "$notice" -lt "$(line_of 'Orchestrators')" ] && echo 1)"
check "the section holds no question left, and still says who waits" "1|0|1" "$(pane | grep -c '^Questions for you$')|$(pane | grep -c 'Which page goes first')|$(pane | grep -c '^none in the pane — 1 orchestrator waits for you: ask the coordinator')"

# The operator's report of 2026-11-18: a text longer than the field's line was drawn cut with
# « … », the caret rows below at the column of a line not drawn, and the text drawn again under
# the field. The text wraps in the field, once, and the caret (the terminal's cursor) follows its
# last character: at 160 columns, at 100, where the pane is drawn over the transcript, and in a
# window shorter than the tree, where the pane would draw its scroll track. The caret's cell: the
# four cells before the terminal's cursor, a bar, and the cell under it, blank or past the row's
# end (the row's characters counted as cells: the rows read here hold no wide character).
caret_cell() {
  local cx cy
  cx=$(tm display -p -t "$SESSION" '#{cursor_x}'); cy=$(tm display -p -t "$SESSION" '#{cursor_y}')
  screen | sed -n "$((cy + 1))p" | perl -CS -ne 'chomp; my $c = '"$cx"'; my $under = $c < length ? substr($_, $c, 1) : " "; print $c < 4 ? "" : substr($_, $c - 4, 4), "|", ($under eq " " ? "blank" : $under)'
}
FIELD_TEXT="C, pas de tag pour l'instant mais les versions vont suivre celle du legacy : les corrections seront v32_33_cg1 pour corrections geonative 1, puis la suite jusqu'au bout"
for size in 160x50 100x50 160x14; do
  echo "== a long text typed in the field ($size)"
  COLS=${size%x*} start "${size#*x}" report 'Questions for you'
  # In the short window the field is below the pinned key line and the question: the wheel brings it in.
  for ((i = 0; i < 10; i++)); do pane | grep -q '^Other answer: ' && break; wheel down 1; done
  click 'Other answer'
  check "the field takes the keys ($size)" "0" "$(wait_for '⏎ send' 5; echo $?)"
  tm send-keys -t "$SESSION" -l "$FIELD_TEXT"
  wait_for "jusqu'au bout" 5
  sleep 0.5
  record "a long text typed in the field, $size"
  # Its head is drawn at most once: scrolled out of the field's four rows where they cannot hold it.
  check "the text wraps in the field, cut nowhere, drawn once ($size)" "0|1|1|1" "$(pane | grep -c '…')|$(flat | grep -c 'v32_33_cg1 pour corrections geonative 1, puis la suite')|$([ "$(screen | grep -c 'C, pas de tag')" -le 1 ] && echo 1)|$(screen | grep -c 'v32_33_cg1')"
  check "the caret follows the text's last character ($size)" "bout|blank" "$(caret_cell)"
  # The window shorter than the tree: no track beside the field, the key line still pinned at its top.
  [ "$size" = 160x14 ] && check "the key line pinned at the window's top, no track beside the field ($size)" "1|" \
    "$(pane | head -2 | grep -c 'Enter: choose')|$(thumb)"
done

echo "== an orchestrator that asks two questions (160x50)"
start 50 pair
record "drawn"
check "the asker once, the first question with its picker, the second not drawn" "1|1|0|1" "$(pane | grep -c '^Orch: alpha')|$(pane | grep -c '^the version number')|$(pane | grep -c '^the release rhythm')|$(pane | grep -c '^Choose: ')"
check "the picker is drawn under the first question" "1" "$(ordered 'the version number' 'Choose: ')"
check "the count is the questions left" "1" "$(pane | grep -c '^Questions for you — 2 pending')"
check "the glued pull requests read as written, each a link of its own" "1|2" "$([ "$(pane | grep -c 'infra#195/infra#196')" -ge 1 ] && echo 1)|$(tm capture-pane -e -p -t "$SESSION" | grep -o $'\x1b\\]8;[^\x1b]*pull/19[56]' | sort -u | wc -l | tr -d ' ')"
press Enter
check "the first answer is its own: sent, the second question is drawn and takes the picker" "answered|A : 1.15.0 — no break for the applications|open|1|1" \
  "$(jq -r .status "$SANDBOX/state/round/s-alpha-p1.json")|$(jq -r .answer.text "$SANDBOX/state/round/s-alpha-p1.json")|$(jq -r .status "$SANDBOX/state/round/s-alpha-p2.json")|$(pane | grep -c '^Questions for you — 1 pending')|$(pane | grep -c '^the release rhythm')"
press Down Enter
check "the last answer is its own, after its question" "B : one at the end — one upgrade per application" "$(jq -r .answer.text "$SANDBOX/state/round/s-alpha-p2.json")"

echo "== the pane's state routes each question (160x50)"
start 50 aged
cpu_before=$(host_cpu)
sleep 35
cpu_after=$(host_cpu)
echo "  idle cost: the host used $(( (cpu_after - cpu_before) * 10 )) ms of processor time over 35 s with the pane open"
record "35 seconds with the pane open"
check "pane open: two questions two hours old wake the coordinator for neither" "|0" "$(woken)|$(screen | grep -c 'now due in this tab')"
press Escape
tm send-keys -t "$SESSION" '/orchestrator-supervision'
sleep 1
tm send-keys -t "$SESSION" Enter
sleep 2
# One command for both roles, the operator's ruling 229 (« B »): the name that opened the pane closes it.
check "typed again, the short name closes the pane it opened, and its record goes with it" "0|0" "$(screen | grep -c 'Questions for you')|$([ -f "$SANDBOX/state/pane.json" ] && echo 1 || echo 0)"
wait_for 'now due in this tab' 40
wait_woken 10
record "the pane closed"
check "pane closed: the coordinator is woken at once for every open question" "1|s-alpha-q1,s-beta-q2" "$([ "$(screen | grep -c 'now due in this tab')" -ge 1 ] && echo 1)|$(woken)"
press Escape
asked s-alpha-q4 alpha "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "the tag" "The release is merged." "Tag the release while the pane is closed?" '["tag it", "wait"]' "" "" "the tag"
sleep 1
tm send-keys -t "$SESSION" '/orchestrator:supervision'
sleep 1
tm send-keys -t "$SESSION" Enter
wait_for 'Questions for you' 15
record "the pane open again"
check "reopened by the file's own prefixed name, the pane draws every pending question, those presented in the tab included" "1|1|open,open" "$(pane | grep -c '^Questions for you — 3 pending')|$(flat | grep -c 'Merge the release branch now?')|$(statuses)"

echo "== the short names as project commands (160x50)"
start 50
check "the copy the writer marked opened the pane, its marker read" "1|1" "$(pane | grep -c '^Questions for you')|$(grep -cx 'installed-by: claude-orchestrator' "$COMMANDS/orchestrator-supervision.md")"
press Escape
tm send-keys -t "$SESSION" '/orchestrator-supervision'
sleep 1
tm send-keys -t "$SESSION" Enter
sleep 2
record "the pane toggled closed"
check "typed again, the project command closes the pane" "0|1" "$(screen | grep -c 'Questions for you')|$(screen | grep -c 'Supervision pane closed.')"
check "after /orc, one name per row and one row per description" "rows|0|0" "$(typeahead '/orc')"
check "after /coordinator, one name per row and one row per description" "rows|0|0" "$(typeahead '/coordinator')"

echo "== (a) answered in the pane, (c) answered in the coordinator's tab (160x50)"
start 50
coordround round --by-urgency >/dev/null
check "round recorded the two entries it printed" "s-alpha-q1,s-beta-q2" "$(jq -r 'sort | join(",")' "$SANDBOX/state/round-listed.json")"
tm send-keys -t "$SESSION" Enter
stamp=$(ms)
read -r gone told <<< "$(since_answer "$stamp" 10 'Merge the release branch now?' 'Settled in the pane: Orch: alpha')"
record "(a) after the answer"
delay a "$gone" "$told"
press Escape
check "(a) answered once, gone from the pane, the coordinator told once with nothing to run, within seconds" "answered|B : wait for the next review — a day lost|pane|yes|1|0|yes" \
  "$(jq -r .status "$SANDBOX/state/round/s-alpha-q1.json")|$(jq -r .answer.text "$SANDBOX/state/round/s-alpha-q1.json")|$(jq -r .answer.by "$SANDBOX/state/round/s-alpha-q1.json")|$(fluid "$gone")|$(tab_count 'Settled in the pane: Orch: alpha')|$(tab_count 'coordinator.sh')|$(fluid "$told")"
stamp=$(ms)
# Settled as the coordinator's settle tool settles it in its tab: the question answered, with his words.
jq --arg at "$(date -u +%FT%TZ)" '.status = "answered" | .seq += 1 | .answer = {text: "A, the design (relayed in the tab)", by: "coordinator", at: $at, settler: "Coord: e2e"}' "$SANDBOX/state/round/s-beta-q2.json" > "$SANDBOX/c.json" && mv "$SANDBOX/c.json" "$SANDBOX/state/round/s-beta-q2.json"
read -r gone told <<< "$(since_answer "$stamp" 25 'Which docs first?' '')"
record "(c) after the coordinator's settle"
delay c "$gone" "$told"
check "(c) answered in the tab: gone from the pane within seconds, no notice sent back" "answered|yes|0" \
  "$(jq -r .status "$SANDBOX/state/round/s-beta-q2.json")|$(fluid "$gone")|$(tab_count 'Settled in the pane: Orch: beta')"

echo "== (e) a question without choices answered from its field (160x50)"
start 50 report
coordround round --by-urgency >/dev/null
# The field is given the keys by a click, as in the section above.
drawn=$(wait_for 'Which page goes first, and why?' 25 && echo drawn || echo missing)
check "(e) the question without choices is drawn with its field" "drawn" "$drawn"
click 'Other answer'
tm send-keys -t "$SESSION" -l 'merge speculoos#53'
sleep 0.6
tm send-keys -t "$SESSION" Enter
stamp=$(ms)
read -r gone told <<< "$(since_answer "$stamp" 10 'Which page goes first, and why?' 'Settled in the pane: Orch: beta')"
record "(e) after the answer"
delay e "$gone" "$told"
press Escape
check "(e) the typed text answers the question once, gone from the pane, the coordinator told once" "answered|merge speculoos#53|yes|1|yes" \
  "$(jq -r .status "$SANDBOX/state/round/s-beta-q3.json")|$(jq -r .answer.text "$SANDBOX/state/round/s-beta-q3.json")|$(fluid "$gone")|$(tab_count 'Settled in the pane: Orch: beta')|$(fluid "$told")"

# A live orchestrator beside the coordinator, in a second window of the same server, its turns
# its model's: replies to the project commands below, and calls of the `ask` tool. Its banner is
# read before anything is typed.
ORCH=orch
flow_command() {  # <name> <the text to reply with>
  printf -- '---\ndescription: e2e flow reply\n---\nReply with exactly the text between the two marker lines, without the marker lines, and use no tool.\n<<<\n%s\n>>>\n' "$2" > "$COMMANDS/$1.md"
}
flow_ask_command() {  # <name> <subject> <question> <choice a> <choice b> <blocks>
  printf -- '---\ndescription: e2e flow question\n---\nCall the ask tool exactly once, with exactly these arguments, and use no other tool. Then reply with the one word Asked.\nsubject: %s\ncontext: The pages are drafted and the order is open.\nquestion: %s\nchoice_a: %s\nchoice_b: %s\nrecommended: A\nwhy: the first reads best\nblocks: %s\n' "$2" "$3" "$4" "$5" "$6" > "$COMMANDS/$1.md"
}
orch_screen() { tm capture-pane -p -t "$SESSION:$ORCH"; }
start_orch() {
  tm new-window -d -t "$SESSION" -n "$ORCH" -c "$SANDBOX/work" \
    env -i HOME="$HOME" USER="$USER" PATH="$PATH" TERM=xterm-256color FORCE_HYPERLINK=1 \
    ORCHESTRATOR_STATE_DIR="$SANDBOX/state" ORCHESTRATOR_MODULE_DIR="$SANDBOX/module" ORCHESTRATOR_COMMANDS_DIR="$COMMANDS" \
    ORCHESTRATOR_WORKSPACES="$SANDBOX/workspaces" \
    "$HOST" --setting-sources project --strict-mcp-config --settings "$SANDBOX/settings.json" \
    "${E2E_PLUGIN_ARGS[@]}" --name "Orch: flow"
  local i
  for ((i = 0; i < 120; i++)); do orch_screen | grep -qF 'Orch: flow' && break; sleep 0.25; done
  [ "$i" -lt 120 ] || return 1
  subscription_or_exit "$(orch_screen)"
}
orch_type() { tm send-keys -t "$SESSION:$ORCH" -l "$1"; sleep 1; tm send-keys -t "$SESSION:$ORCH" Enter; }
flow_entries() { jq -r --arg s "$1" 'select(.sender.name? == "Orch: flow" and .status == $s) | .id' "$SANDBOX/state/round/"*.json 2>/dev/null | sort | paste -sd, -; }
flow_open_with() { [ -n "$(jq -r --arg b "$1" 'select(.sender.name? == "Orch: flow" and .status == "open" and .subject == $b) | .id' "$SANDBOX/state/round/"*.json 2>/dev/null)" ]; }
flow_id() { jq -r --arg b "$1" 'select(.sender.name? == "Orch: flow" and .subject == $b) | .id' "$SANDBOX/state/round/"*.json 2>/dev/null | head -1; }
settled_is() { status_is "$1" answered || status_is "$1" withdrawn; }
orch_shows() { orch_screen | grep -qF "$1"; }

echo "== (d) a question asked with the ask tool, then a turn that asks nothing, (b) answered in the sender's own tab (160x50)"
start 50 flow
flow_ask_command flow-ask 'the pages' 'Which page goes first?' 'the design' 'the README' 'the docs, the tag'
flow_command flow-report 'The pages are drafted. Your choice A or B, asked above, decides the order.'
flow_ask_command flow-tag 'the tag' 'Tag the release?' 'tag it' 'wait' 'the tag'
if ! start_orch; then
  check "the orchestrator's host starts" "yes" "no"
else
  orch_type '/flow-ask'
  asked=$(until_ms 120 flow_open_with 'the pages')
  record "(d) the question asked"
  check "(d) the orchestrator's question is asked with the ask tool and drawn" "yes|drawn" "$([ "$asked" != never ] && echo yes)|$(wait_for 'Which page goes first?' 25 && echo drawn || echo missing)"
  first=$(flow_id 'the pages')
  cp "$SANDBOX/state/round/$first.json" "$SANDBOX/first.json"
  coordround round --by-urgency >/dev/null
  orch_type '/flow-report'
  # The turn's reply is on the orchestrator's screen once the turn is over, then one tick of the pane's 2 s clock.
  ended=$(until_ms 120 orch_shows 'The pages are drafted')
  sleep 3
  record "(d) after the turn that asks nothing"
  check "(d) the turn that asks nothing leaves the question as it was: open, drawn, nothing withdrawn, no notice" "yes|same|$first|0|1|0" \
    "$([ "$ended" != never ] && echo yes)|$(cmp -s "$SANDBOX/first.json" "$SANDBOX/state/round/$first.json" && echo same || echo changed)|$(flow_entries open)|$( [ -n "$(flow_entries withdrawn)" ] && echo 1 || echo 0)|$(pane | grep -c 'Which page goes first?')|$(tab_count 'Settled in')"
  keys_to_pane
  tm send-keys -t "$SESSION" Enter
  stamp=$(ms)
  read -r gone told <<< "$(since_answer "$stamp" 10 'Which page goes first?' 'Settled in the pane: Orch: flow')"
  record "(d) answered in the pane"
  delay d "$gone" "$told"
  tm send-keys -t "$SESSION" Escape
  check "(d) answered once from the pane, its asker told, the coordinator told once" "answered|A : the design|delivered|yes|1|yes" \
    "$(jq -r .status "$SANDBOX/state/round/$first.json")|$(jq -r .answer.text "$SANDBOX/state/round/$first.json")|$(jq -r .delivery.state "$SANDBOX/state/round/$first.json")|$(fluid "$gone")|$(tab_count 'Settled in the pane: Orch: flow')|$(fluid "$told")"
  # The orchestrator's next turn, started by the pane's answer, is let end before (b).
  sleep 20
  orch_type '/flow-tag'
  until_ms 120 flow_open_with 'the tag' >/dev/null
  tag=$(flow_id 'the tag')
  check "(b) the question to answer in the tab is drawn" "drawn" "$(wait_for 'Tag the release?' 25 && echo drawn || echo missing)"
  coordround round --by-urgency >/dev/null
  orch_type 'B, wait. Reply with exactly the two lines « Noted. » and « waiting: done », with no tool.'
  stamp=$(ms)
  # The question is settled only when the sender's turn ends, its model's reply included: what
  # follows that end is the module's and the pane's, and is what must be fluid.
  ended=$(until_ms 120 settled_is "$tag")
  read -r gone told <<< "$(since_answer "$stamp" 25 'Tag the release?' "Settled in Orch: flow's tab")"
  record "(b) answered in the sender's tab"
  delay b "$gone" "$told"
  after() { [ "$1" = never ] || [ "$ended" = never ] && echo never || echo $(( $1 > ended ? $1 - ended : 0 )); }
  echo "  (b) the sender's turn ended $(shown "$ended") after the answer; then pane $(shown "$(after "$gone")"), tab $(shown "$(after "$told")"); the question $(jq -r .status "$SANDBOX/state/round/$tag.json") by $(jq -r .answer.by "$SANDBOX/state/round/$tag.json")"
  tm send-keys -t "$SESSION" Escape
  check "(b) answered once by the module from his words in the tab, gone from the pane within seconds of the turn's end, with nothing to run" "answered|tab|B, wait.|yes|0" \
    "$(jq -r .status "$SANDBOX/state/round/$tag.json")|$(jq -r .answer.by "$SANDBOX/state/round/$tag.json")|$(jq -r '.answer.text[0:8]' "$SANDBOX/state/round/$tag.json")|$(fluid "$(after "$gone")")|$(tab_count 'coordinator.sh')"
  # The coordinator was shown the question (`round` listed it) and is never told it is settled:
  # the plan of an answer typed in its asker's tab carries `told: false` (hooks/settle.ts,
  # planClaimed), so closeRound tells no one, and settleClaimed (hooks/question.ts) does not either.
  check "(b) the coordinator, shown the question, is told once that it was answered in its sender's tab, within seconds of the turn's end" "1|yes" \
    "$(tab_count "Settled in Orch: flow's tab")|$(fluid "$(after "$told")")"
fi

# (f) The coordinator asks a question itself, with the ask tool, and the operator answers it in its
# own pane: no message reaches the session that sends it (« no live session … has id »), so the
# answer is submitted to the coordinator's own turn, and it is the one notice it gets. Its turn,
# started by that prompt, is interrupted once the answer shows in its tab and is measured.
echo "== (f) a question the coordinator asked itself, answered in its own pane (160x50)"
coord_ask_command() { flow_ask_command coord-ask 'the order' 'Which page goes first?' 'the design' 'the README' 'the docs'; }
START_COMMANDS=coord_ask_command start 50 flow
coord_id() { jq -r 'select(.sender.name? == "Coord: e2e" and .subject == "the order") | .id' "$SANDBOX/state/round/"*.json 2>/dev/null | head -1; }
coord_open() { [ -n "$(jq -r 'select(.sender.name? == "Coord: e2e" and .subject == "the order" and .status == "open") | .id' "$SANDBOX/state/round/"*.json 2>/dev/null)" ]; }
tm send-keys -t "$SESSION" -l '/coord-ask'
sleep 1
tm send-keys -t "$SESSION" Enter
asked=$(until_ms 120 coord_open)
own=$(coord_id)
[ -n "$own" ] || own=none
# The asking turn ends, as the tab draws it, before the pane is answered.
ended=$(until_ms 120 turn_done)
check "(f) the coordinator's own question is asked with the ask tool, its turn ended, and drawn in its pane" "yes|yes|drawn" \
  "$([ "$asked" != never ] && echo yes)|$([ "$ended" != never ] && echo yes)|$([ "$(until_ms 25 pane_has 'Which page goes first?')" != never ] && echo drawn || echo missing)"
# A plain round, deliberately: the coordinator's own question is read in its pane alone, so it is
# not recorded as shown and its settling sends no « Settled in the pane » notice.
coordround round >/dev/null
keys_to_pane
tm send-keys -t "$SESSION" Enter
stamp=$(ms)
read -r gone told <<< "$(since_answer "$stamp" 15 'Which page goes first?' "The operator answered your question $own")"
record "(f) answered in the coordinator's own pane"
delay f "$gone" "$told"
# The first Escape gives the keys back to the prompt, the second interrupts the turn the answer started.
press Escape Escape
check "(f) answered once from the pane, delivered to the coordinator's own turn, no second notice, nothing « not delivered »" "answered|A : the design|delivered|yes|1|0|0|yes" \
  "$(jq -r .status "$SANDBOX/state/round/$own.json")|$(jq -r .answer.text "$SANDBOX/state/round/$own.json")|$(jq -r .delivery.state "$SANDBOX/state/round/$own.json")|$(fluid "$gone")|$(tab_count "The operator answered your question $own")|$(tab_count 'Settled in the pane: Coord: e2e')|$(pane | grep -c 'not delivered')|$(fluid "$told")"

echo "delays (from the answer; a figure ≤ ~${FLOOR_MS} ms sits on the poll's floor): $DELAYS"

echo "pane-e2e: $pass passed, $fail failed, $known known defect$([ "$known" = 1 ] || echo s) of the pane"
[ "$fail" -eq 0 ]
