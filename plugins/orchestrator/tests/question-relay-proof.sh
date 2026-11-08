#!/bin/bash
# question-relay-proof.sh - no operator question lost at a succession, proven on a live machine.
#
#   tests/question-relay-proof.sh --dry
#   tests/question-relay-proof.sh --state <dir> --module <dir> [--screen '<command>']
#                                 [--window <s>] [--interval <s>] [--out <dir>]
#
# The live run is not part of `run-tests.sh`, its --dry is: the live run watches the installed
# release while a person makes a home succession, during an open decision wave, with the coordinator's pane open. The script
# drives nothing and starts no session: it samples, every 5 seconds by default for 180, the
# round under <state>/round/, the ids the coordinator's conversation was told of
# (<state>/round-told.json), the rows of the store (<module>/store/sessions/) and, given
# --screen, the coordinator's screen as that command prints it (each read bounded by the
# interval), then judges what it sampled from the module's log (<module>/hooks-module.log and
# its .1). Each sample lands in <out> (a new directory under TMPDIR by default), kept.
#
# Every question a sample showed open under the session the moves came from (the moved entries'
# movedFrom) must be one of the moves, or have been answered before: a question withdrawn at the
# hand-over, or left under its sender because the move's write failed, fails, its fate named.
# For every question the log says was moved to a successor (« round: moved to the successor
# <name>: <id> »), it expects:
#   - the question moved, never withdrawn: no sample shows it withdrawn or closed as handed over;
#   - it in the pane after the move: no « pane: <id> not drawn » line logged after the move, and
#     a render that shows it — given --screen, a screen within 20 s of the move that shows its
#     first line, else a « pane: shown <id> » logged after the move. That line is written once in
#     the module's life, so a question drawn before the move needs --screen to be proven after it;
#   - it in the pane before the successor's first measure: the same over the samples taken
#     between the move and the first one holding the successor's row;
#   - « pane: shown <id> » in the log;
#   - the coordinator's one-line notice: the id in round-told.json.
# A failed expectation prints, under it, every « not drawn » and « never drawn » line the log
# holds for that id, or « unexplained: no not drawn or never drawn line names it ». With no move
# in the window the run fails, naming the fate of each question open at its start.
#
# --dry plays six fixtures through the same sampler and judge, on a clock of its own, and checks
# each verdict: a question moved and drawn passes; one left out after the move fails with its
# « not drawn » line; one withdrawn at the hand-over, the only one, fails as unmoved; one
# withdrawn at the hand-over beside another moved fails; one whose move could not be written
# fails, the module's error under it; one no render showed after the move, with no screen read,
# fails. It prints « passed (dry) » and exits 0 when the six verdicts are the expected ones.
#
# Exit: 0 passed, 1 failed, 2 usage or a missing tool.

set -uo pipefail

STATE="" MODULE="" SCREEN="" WINDOW=180 INTERVAL=5 OUT="" DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry) DRY=1; shift ;;
    --state) STATE="${2:-}"; shift 2 ;;
    --module) MODULE="${2:-}"; shift 2 ;;
    --screen) SCREEN="${2:-}"; shift 2 ;;
    --window) WINDOW="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    *) echo "question-relay-proof: unknown option $1" >&2; exit 2 ;;
  esac
done
command -v jq >/dev/null || { echo "question-relay-proof: jq is needed" >&2; exit 2; }

# --- sampling ----------------------------------------------------------------------------------

# The sample clock: the wall clock, or, in the dry run, the fixture's own.
FAKE_NOW=""
now_utc() { if [ -n "$FAKE_NOW" ]; then echo "$FAKE_NOW"; else date -u +%Y-%m-%dT%H:%M:%SZ; fi; }

# One read of the screen command, bounded by the interval: a read that hangs is killed and said.
read_screen() {  # <file>
  local bound=$(( INTERVAL > 1 ? INTERVAL - 1 : 1 ))
  perl -e 'alarm shift; exec @ARGV' "$bound" bash -c "$SCREEN" > "$1" 2>/dev/null
  local code=$?
  [ "$code" = 142 ] && echo "(the screen read did not finish within $bound s)" > "$1"
  return 0
}

# One sample, one JSON line appended to <out>/samples.jsonl: its time, every round entry's id,
# status, sender, session, movedFrom, answer text and first question line, the store's row keys,
# the told ids, and the screen file read, if any.
sample() {  # <n>
  local n="$1" at entries rows told screen=null f
  at=$(now_utc)
  entries=$(for f in "$STATE/round"/*.json; do
      [ -f "$f" ] || continue
      jq -c 'select(type == "object" and (.id | type) == "string")
        | {id, status, from, session, movedFrom: (.movedFrom // null), answer: (.answer.text // null),
           line: ((.question // "") | split("\n") | map(sub("^\\s*_[^_]*_\\s*:\\s*"; "") | gsub("\\*\\*"; "") | gsub("^[\\s#>-]+|\\s+$"; ""))
             | map(select(length > 0)) | (.[0] // ""))}' "$f" 2>/dev/null
    done | jq -sc .)
  rows=$(ls "$MODULE/store/sessions" 2>/dev/null | jq -Rsc 'split("\n") | map(select(length > 0))')
  told=$(jq -c 'if type == "array" then . else [] end' "$STATE/round-told.json" 2>/dev/null || echo '[]')
  if [ -n "$SCREEN" ]; then
    read_screen "$OUT/screen-$n.txt"
    screen="\"screen-$n.txt\""
  fi
  jq -nc --arg at "$at" --argjson entries "${entries:-[]}" --argjson rows "${rows:-[]}" \
    --argjson told "${told:-[]}" --argjson screen "$screen" \
    '{at: $at, entries: $entries, rows: $rows, told: $told, screen: $screen}' >> "$OUT/samples.jsonl"
}

# The module's log lines that name a round entry, from both files, oldest first.
collect_log() {
  local ids
  ids=$(jq -r '.entries[].id' "$OUT/samples.jsonl" | sort -u)
  : > "$OUT/log.txt"
  [ -n "$ids" ] || return 0
  cat "$MODULE/hooks-module.log.1" "$MODULE/hooks-module.log" 2>/dev/null \
    | grep -F -- "$ids" > "$OUT/log.txt" || true
}

# --- judging -----------------------------------------------------------------------------------

pass=0; fail=0
ok() { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }
# Why an entry was left out, as the module logged it.
why() {  # <id>
  local lines
  lines=$(grep -F -e "pane: $1 not drawn: " -e "round wake: $1 open " "$OUT/log.txt" || true)
  if [ -n "$lines" ]; then printf '%s\n' "$lines" | sed 's/^/       /'
  else echo "       unexplained: no not drawn or never drawn line names $1"; fi
}
# A log line's time, in epoch seconds.
epoch() { jq -rn --arg t "$1" '$t | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601'; }
# The log lines for <id> whose text holds <what>, logged at or after <from> (epoch seconds).
logged_after() {  # <id> <what> <from>
  local line t
  while IFS= read -r line; do
    t=$(epoch "${line%% | *}") || continue
    [ "$t" -ge "$3" ] && printf '%s\n' "$line"
  done < <(grep -F -- "$2" "$OUT/log.txt" | grep -F -- "$1")
}
# Whether a screen sample shows the entry's first question line, its spaces folded.
shows() {  # <screen file> <line>
  local want
  want=$(printf '%s' "$2" | tr -s '[:space:]' ' ' | cut -c1-24)
  [ -n "$want" ] && [ -f "$OUT/$1" ] && tr -s '[:space:]' ' ' < "$OUT/$1" | grep -qF -- "$want"
}
# Whether any of the screen files read on stdin, one per line, shows the line.
any_shows() {  # <line>
  local s
  while IFS= read -r s; do shows "$s" "$1" && return 0; done
  return 1
}

judge() {
  local moves id name moved_line moved_at rowed line before n shown_after
  moves=$(grep -F 'round: moved to the successor ' "$OUT/log.txt" | sed -E 's/.*round: moved to the successor (.*): ([^ ]+)$/\2/' | sort -u)
  if [ -z "$moves" ]; then
    bad "a question open at the succession was moved to the successor"
    jq -r --slurp '(.[0].entries | map(select(.status == "open")) | map(.id)) as $open
      | .[-1].entries[] | select(.id as $id | $open | index($id))
      | "       \(.id): \(.status)\(if .answer then " — " + .answer else "" end)"' "$OUT/samples.jsonl"
    return
  fi
  # The questions the predecessor held open at the succession: each one moved, or answered first.
  local held fate
  held=$(jq -r --slurp --arg moves "$moves" '($moves | split("\n")) as $m
    | ([.[].entries[] | select(.movedFrom != null and (.id as $id | $m | index($id))) | .movedFrom] | unique) as $from
    | [.[].entries[] | select(.status == "open" and (.session as $s | $from | index($s)))] | map(.id) | unique | .[]' "$OUT/samples.jsonl")
  echo "== the questions open under the predecessor"
  for id in $held; do
    if printf '%s\n' "$moves" | grep -qxF -- "$id"; then ok "$id moved to the successor"; continue; fi
    fate=$(jq -r --slurp --arg id "$id" '[.[].entries[] | select(.id == $id)] | last
      | if .status == "answered" or (.status == "closed" and ((.answer // "") | startswith("withdrawn") | not)) then "answered"
        else "\(.status) under \(.session)\(if .answer then " — " + .answer else "" end)" end' "$OUT/samples.jsonl")
    if [ "$fate" = answered ]; then ok "$id answered before the move"; continue; fi
    bad "$id moved to the successor"; echo "       $id: $fate"
    grep -F -- "$id" "$OUT/log.txt" | grep -F 'round: ' | grep -vF 'round: moved to the successor ' | sed 's/^/       /' || true
  done
  for id in $moves; do
    moved_line=$(grep -F "round: moved to the successor " "$OUT/log.txt" | grep -F -- ": $id" | head -1)
    name=$(printf '%s' "$moved_line" | sed -E 's/.*round: moved to the successor (.*): [^ ]+$/\1/')
    moved_at=$(epoch "${moved_line%% | *}")
    echo "== $id, moved to $name"
    ok "moved to the successor (log)"
    # Every sample after the move, as JSON lines of {at, status, answer, session, line, rowed, screen}.
    jq -c --arg id "$id" --argjson from "$moved_at" '
      (.at | fromdateiso8601) as $t | select($t >= $from) | (.entries[] | select(.id == $id)) as $e
      | {t: $t, status: $e.status, answer: $e.answer, line: $e.line, screen,
         rowed: (($e.session | gsub("[^A-Za-z0-9._-]"; "_")) as $k | (.rows | index($k)) != null)}' \
      "$OUT/samples.jsonl" > "$OUT/after-$id.jsonl"
    if jq -e 'select(.status == "withdrawn" or ((.answer // "") | test("handed over")))' "$OUT/after-$id.jsonl" >/dev/null; then
      bad "moved, never withdrawn"; jq -r '"       at \(.t | todate): \(.status) — \(.answer)"' "$OUT/after-$id.jsonl" | head -3
    else ok "moved, never withdrawn"; fi
    line=$(jq -r 'select(.line != "") | .line' "$OUT/after-$id.jsonl" | head -1)
    # A render that shows it, never the mere absence of a « not drawn » line.
    shown_after=$(logged_after "$id" "pane: shown $id" "$moved_at")
    if [ -n "$(logged_after "$id" "pane: $id not drawn: " "$moved_at")" ]; then
      bad "in the pane after the move: no not drawn line since"; why "$id"
    elif [ -n "$SCREEN" ]; then
      if jq -r --argjson to $((moved_at + 20)) 'select(.t <= $to and .screen) | .screen' "$OUT/after-$id.jsonl" | any_shows "$line"; then
        ok "in the pane after the move, on screen within 20 s"
      else bad "in the pane within 20 s of the move: no screen shows « $line »"; why "$id"; fi
    elif [ -n "$shown_after" ]; then ok "in the pane after the move (pane: shown since the move)"
    else bad "in the pane after the move: no render shows it, no screen read and no pane: shown since the move"; why "$id"; fi
    rowed=$(jq -r 'select(.rowed) | .t' "$OUT/after-$id.jsonl" | head -1)
    before=$(jq -c --argjson to "${rowed:-9999999999}" 'select(.t < $to)' "$OUT/after-$id.jsonl")
    n=$(printf '%s' "$before" | grep -c . || true)
    if [ "$n" = 0 ]; then
      echo "  --   before the successor's first measure: not checked, its row came with the move"
    elif [ -n "$(logged_after "$id" "pane: $id not drawn: " "$moved_at" | while IFS= read -r l; do
        [ "$(epoch "${l%% | *}")" -lt "${rowed:-9999999999}" ] && echo "$l"; done)" ]; then
      bad "in the pane before the successor's first measure"; why "$id"
    elif [ -n "$SCREEN" ]; then
      if printf '%s\n' "$before" | jq -r 'select(.screen) | .screen' | any_shows "$line"; then
        ok "in the pane before the successor's first measure ($n sample(s) before its row)"
      else bad "in the pane before the successor's first measure: no screen shows it"; why "$id"; fi
    elif [ -n "$(printf '%s\n' "$shown_after" | while IFS= read -r l; do
        [ -n "$l" ] && [ "$(epoch "${l%% | *}")" -lt "${rowed:-9999999999}" ] && echo "$l"; done)" ]; then
      ok "in the pane before the successor's first measure (pane: shown before its row)"
    else bad "in the pane before the successor's first measure: no render shows it"; why "$id"; fi
    if grep -qF -- "pane: shown $id" "$OUT/log.txt"; then ok "pane: shown $id (log)"
    else bad "pane: shown $id (log)"; why "$id"; fi
    if jq -e --arg id "$id" 'select(.told | index($id))' "$OUT/samples.jsonl" >/dev/null; then ok "the coordinator was told of it (round-told.json)"
    else bad "the coordinator was told of it (round-told.json)"; fi
  done
}

verdict() {
  pass=0; fail=0
  judge
  if [ "$fail" = 0 ]; then echo "passed ($pass checks)"; return 0; fi
  echo "failed ($fail of $((pass + fail)) checks)"; return 1
}

# --- the live run ------------------------------------------------------------------------------

if [ "$DRY" = 0 ]; then
  [ -n "$STATE" ] && [ -n "$MODULE" ] || { echo "usage: $0 --dry | --state <dir> --module <dir> [--screen '<command>'] [--window <s>] [--interval <s>] [--out <dir>]" >&2; exit 2; }
  [ -d "$STATE/round" ] || { echo "question-relay-proof: no round under $STATE" >&2; exit 2; }
  OUT=${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/question-relay-proof-XXXXXX")}
  mkdir -p "$OUT" && : > "$OUT/samples.jsonl"
  echo "sampling every $INTERVAL s for $WINDOW s into $OUT: make the succession now"
  i=0; end=$(( $(date +%s) + WINDOW ))
  while [ "$(date +%s)" -lt "$end" ]; do
    sample "$i"; i=$((i + 1)); sleep "$INTERVAL"
  done
  collect_log
  verdict; exit $?
fi

# --- the dry run -------------------------------------------------------------------------------

DRYROOT=$(mktemp -d "${TMPDIR:-/tmp}/question-relay-dry-XXXXXX") || exit 2
trap 'rm -rf "$DRYROOT"' EXIT
T0=1793000000   # the fixtures' clock: 2026-10-26T...Z, every sample 5 s apart
at() { jq -rn --argjson t $((T0 + $1)) '$t | todate'; }
logl() { printf '%s.000Z | supervision | %s\n' "$(at "$1" | sed 's/Z$//')" "$2" >> "$MODULE/hooks-module.log"; }
entry() {  # <id> <session> <status> [movedFrom] [answer]
  jq -n --arg id "$1" --arg s "$2" --arg st "$3" --arg mf "${4:-}" --arg ans "${5:-}" '{id: $id,
    from: (if $mf == "" then "Orch : old" else "Orch : new" end), session: $s, kind: "operator",
    since: "2026-10-26T10:00:00.000Z", blocks: "the release", question: "_Question_ : ship the release now?\n- **A** : ship\n- **B** : wait",
    choices: [], recommendation: null, status: $st, at: "2026-10-26T10:00:00.000Z",
    answer: (if $ans == "" then null else {text: $ans, by: "sender", at: "2026-10-26T10:01:00.000Z"} end)}
    + (if $mf == "" then {} else {movedFrom: $mf} end)' > "$STATE/round/$1.json"
}
screen_shows() { [ "$1" = 1 ] && echo 'Questions for you — 1 pending  ship the release now?' > "$DRYROOT/screen" || echo 'Questions for you — none' > "$DRYROOT/screen"; }
row() { : > "$MODULE/store/sessions/$1"; }

# One fixture played: <steps> is a function run before each of its five samples, given the index;
# `noscreen` plays it with no screen read, the log alone to judge from.
play() {  # <name> <steps> [noscreen]
  STATE="$DRYROOT/$1/state" MODULE="$DRYROOT/$1/module" OUT="$DRYROOT/$1/out"
  mkdir -p "$STATE/round" "$MODULE/store/sessions" "$OUT"
  : > "$OUT/samples.jsonl"; : > "$MODULE/hooks-module.log"
  SCREEN="cat $DRYROOT/screen"
  [ "${3:-}" = noscreen ] && SCREEN=""
  local i
  for i in 0 1 2 3 4; do
    FAKE_NOW=$(at $((i * 5)))
    "$2" "$i"
    sample "$i"
  done
  FAKE_NOW=""
  collect_log
  verdict > "$DRYROOT/$1.out" 2>&1
  echo "exit $?" >> "$DRYROOT/$1.out"
}

# Moved at 5 s, the successor's row at 15 s: drawn throughout, told, shown before the move.
drawn() {
  case "$1" in
    0) entry q1 s-old open; row s-old; echo '["q1"]' > "$STATE/round-told.json"; logl 0 "pane: shown q1"; screen_shows 1 ;;
    1) entry q1 s-new open s-old; logl 5 "round: moved to the successor Orch : new: q1" ;;
    3) row s-new ;;
  esac
}
# Moved at 5 s, then left out: no row for its successor yet, the pane says why.
left_out() {
  case "$1" in
    0) entry q2 s-old open; row s-old; echo '["q2"]' > "$STATE/round-told.json"; logl 0 "pane: shown q2"; screen_shows 1 ;;
    1) entry q2 s-new open s-old; logl 5 "round: moved to the successor Orch : new: q2"; screen_shows 0 ;;
    2) logl 10 "pane: q2 not drawn: no row for its sender s-new" ;;
    4) row s-new ;;
  esac
}
# Withdrawn at the hand-over: never moved.
withdrawn() {
  case "$1" in
    0) entry q3 s-old open; row s-old; echo '["q3"]' > "$STATE/round-told.json"; logl 0 "pane: shown q3"; screen_shows 1 ;;
    1) entry q3 s-old withdrawn "" "handed over to its successor"; logl 5 "round: withdrawn by the sender: q3"; screen_shows 0 ;;
  esac
}
# Two questions at the hand-over: one moved and drawn, the other withdrawn instead of moved.
withdrawn_one() {
  case "$1" in
    0) entry q4 s-old open; entry q5 s-old open; row s-old; echo '["q4","q5"]' > "$STATE/round-told.json"
       logl 0 "pane: shown q4"; logl 0 "pane: shown q5"; screen_shows 1 ;;
    1) entry q4 s-new open s-old; logl 5 "round: moved to the successor Orch : new: q4"
       entry q5 s-old withdrawn "" "handed over to its successor"; logl 5 "round: withdrawn by the sender: q5" ;;
    3) row s-new ;;
  esac
}
# Two questions at the hand-over: one moved, the other's move could not be written.
write_fails() {
  case "$1" in
    0) entry q6 s-old open; entry q7 s-old open; row s-old; echo '["q6","q7"]' > "$STATE/round-told.json"
       logl 0 "pane: shown q6"; logl 0 "pane: shown q7"; screen_shows 1 ;;
    1) entry q6 s-new open s-old; logl 5 "round: moved to the successor Orch : new: q6"
       logl 5 "round: EIO: i/o error, rename '$STATE/round/q7.json.tmp-1' -> '$STATE/round/q7.json'" ;;
    3) row s-new ;;
  esac
}
# Shown before the move, moved, then never drawn again, with no line saying why and no screen read.
unseen() {
  case "$1" in
    0) entry q8 s-old open; row s-old; echo '["q8"]' > "$STATE/round-told.json"; logl 0 "pane: shown q8" ;;
    1) entry q8 s-new open s-old; logl 5 "round: moved to the successor Orch : new: q8" ;;
    3) row s-new ;;
  esac
}

play drawn drawn
play left-out left_out
play withdrawn withdrawn
play withdrawn-one withdrawn_one
play write-fails write_fails
play unseen unseen noscreen
dpass=0; dfail=0
expect() {  # <what> <fixture> <text the verdict holds>...
  local what="$1" name="$2"; shift 2
  local missing="" want
  for want in "$@"; do grep -qF -- "$want" "$DRYROOT/$name.out" || missing="$missing [$want]"; done
  if [ -z "$missing" ]; then printf '  ok   %s\n' "$what"; dpass=$((dpass + 1))
  else printf '  FAIL %s: missing%s\n' "$what" "$missing"; sed 's/^/       | /' "$DRYROOT/$name.out"; dfail=$((dfail + 1)); fi
}
expect "a question moved and drawn passes every expectation" drawn \
  "ok   moved, never withdrawn" "ok   in the pane after the move, on screen within 20 s" \
  "ok   in the pane before the successor's first measure (2 sample(s) before its row)" \
  "ok   q1 moved to the successor" "ok   pane: shown q1 (log)" "ok   the coordinator was told of it" \
  "passed (7 checks)" "exit 0"
expect "a question left out after the move fails, its not drawn line under it" left-out \
  "FAIL in the pane after the move: no not drawn line since" "pane: q2 not drawn: no row for its sender s-new" \
  "FAIL in the pane before the successor's first measure" "exit 1"
expect "a question withdrawn at the hand-over fails as unmoved, its fate named" withdrawn \
  "FAIL a question open at the succession was moved to the successor" \
  "q3: withdrawn — handed over to its successor" "exit 1"
expect "a question withdrawn at the hand-over beside one moved fails, its fate named" withdrawn-one \
  "ok   q4 moved to the successor" "FAIL q5 moved to the successor" \
  "q5: withdrawn under s-old — handed over to its successor" "round: withdrawn by the sender: q5" "exit 1"
expect "a question whose move could not be written fails, the module's error under it" write-fails \
  "ok   q6 moved to the successor" "FAIL q7 moved to the successor" "q7: open under s-old" \
  "round: EIO: i/o error, rename" "exit 1"
expect "a question no render showed after the move fails, though no line says it was left out" unseen \
  "FAIL in the pane after the move: no render shows it" "unexplained: no not drawn or never drawn line names q8" \
  "FAIL in the pane before the successor's first measure: no render shows it" "exit 1"
[ "$dfail" = 0 ] || { echo "failed (dry): $dfail of $((dpass + dfail))"; exit 1; }
echo "passed (dry)"
