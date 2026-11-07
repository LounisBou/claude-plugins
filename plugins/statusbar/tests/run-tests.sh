#!/bin/bash
# Status line test suite. No network, no shared state.
#
# Each case builds a stdin payload and an isolated settings file
# (STATUSBAR_CONFIG), then compares the ANSI-stripped output against an
# expected value. The readable levels section reads the raw colour sequences
# instead. Reset epochs are derived from `now` so countdowns are
# deterministic.

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/../statusline/statusline.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

strip_ansi() { sed $'s/\033\\[[0-9;]*m//g'; }

# config_with FLAG=VAL ... -> path to a settings file
config_with() {
  local f="$WORK/config.$RANDOM.txt"
  printf '%s\n' "$@" > "$f"
  printf '%s' "$f"
}

# check <name> <config> <payload> <expected multi-line output>
check() {
  local name="$1" config="$2" payload="$3" expected="$4" actual
  actual=$(printf '%s' "$payload" | STATUSBAR_CONFIG="$config" bash "$SCRIPT" | strip_ansi)
  if [ "$actual" = "$expected" ]; then
    printf '  ok   %s\n' "$name"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n' "$name"
    printf '       expected: %s\n' "$(printf '%s' "$expected" | tr '\n' '⏎')"
    printf '       actual:   %s\n' "$(printf '%s' "$actual"   | tr '\n' '⏎')"
    fail=$((fail + 1))
  fi
}

NOW=$(date +%s)
IN_2H=$((NOW + 8010))     # 2h13m30: 30 s of slack keeps the render at "2h13"
IN_3D=$((NOW + 259200))
EMPTY_DIR="$WORK/plain"; mkdir -p "$EMPTY_DIR"

ALL_ON=$(config_with SHOW_DIRECTORY=1 SHOW_BRANCH=1 SHOW_PR=1 SHOW_MODEL=1 \
  SHOW_USAGE=1 SHOW_SEVEN_DAY=1 SHOW_PROGRESS_BAR=1 SHOW_RESET_TIME=1 \
  SHOW_CONTEXT=1 SHOW_GIT_STATUS=1 SHOW_SESSION_NAME=1 SHOW_LINES_CHANGED=1 \
  RESET_COUNTDOWN=1)

echo "== nominal render =="

check "full payload" "$ALL_ON" \
  "{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},\"model\":{\"display_name\":\"a-model\"},
    \"session_name\":\"my session\",\"context_window\":{\"used_percentage\":26.4},
    \"cost\":{\"total_lines_added\":649,\"total_lines_removed\":167},
    \"pr\":{\"number\":1424,\"review_state\":\"pending\"},
    \"rate_limits\":{\"five_hour\":{\"used_percentage\":47.2,\"resets_at\":$IN_2H},
                     \"seven_day\":{\"used_percentage\":50.9,\"resets_at\":$IN_3D}}}" \
"plain │ PR #1424 ⋯ │ a-model │ my session
ctx: 26% │ 5h: 47% ▓▓▓▓▓░░░░░ → 2h13 │ 7d: 50% ▓▓▓▓▓░░░░░ → 3d │ +649/-167"

echo "== missing quotas =="

# rate_limits does not exist before the first API response: we must show
# "Usage: ~" and above all NOT a phantom 0% quota.
check "no rate_limits at all" "$ALL_ON" \
  "{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},\"model\":{\"display_name\":\"a-model\"},
    \"context_window\":{\"used_percentage\":12}}" \
"plain │ a-model
ctx: 12% │ Usage: ~"

check "5h present, 7d absent" "$ALL_ON" \
  "{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},
    \"rate_limits\":{\"five_hour\":{\"used_percentage\":8,\"resets_at\":$IN_2H}}}" \
"plain
5h: 8% ▓░░░░░░░░░ → 2h13"

echo "== thresholds =="

check "context >= 80 raises the warning" "$ALL_ON" \
  "{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},\"context_window\":{\"used_percentage\":83.6},
    \"rate_limits\":{\"five_hour\":{\"used_percentage\":100,\"resets_at\":$IN_2H}}}" \
"plain
⚠ ctx: 83% │ ⚠ 5h: 100% ▓▓▓▓▓▓▓▓▓▓ → 2h13"

check "0% fills no block" "$ALL_ON" \
  "{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},
    \"rate_limits\":{\"five_hour\":{\"used_percentage\":0,\"resets_at\":$IN_2H}}}" \
"plain
5h: 0% ░░░░░░░░░░ → 2h13"

echo "== readable levels =="

ESC=$'\033'
L_YELLOW="${ESC}[38;5;136m"
L_ORANGE="${ESC}[38;5;208m"
L_RED="${ESC}[0;31m"

# line2_of <payload> -> raw second line (colour sequences kept)
CTX_LEVEL=$(config_with SHOW_CONTEXT=1 SHOW_USAGE=0)

line2_of() { printf '%s' "$1" | STATUSBAR_CONFIG="${2:-$ALL_ON}" bash "$SCRIPT" | sed -n 2p; }

# check_level <name> <payload> <expected prefix; empty = no colour sequence at all>
check_level() {
  local name="$1" line="$2" prefix="$3" ok=0
  if [ -z "$prefix" ]; then
    case "$line" in *"$ESC"*) ok=0 ;; *) ok=1 ;; esac
  else
    case "$line" in "$prefix"*) ok=1 ;; esac
  fi
  if [ "$ok" = 1 ]; then
    printf '  ok   %s\n' "$name"; pass=$((pass + 1))
  else
    printf '  FAIL %s\n' "$name"; printf '       actual: %q\n' "$line"; fail=$((fail + 1))
  fi
}

for lvl in "0:" "40:" "41:$L_YELLOW" "70:$L_YELLOW" "71:$L_ORANGE" "79:$L_ORANGE" "80:${L_RED}⚠ " ; do
  p=${lvl%%:*}; want=${lvl#*:}
  payload="{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},\"context_window\":{\"used_percentage\":$p}}"
  actual=$(line2_of "$payload" "$CTX_LEVEL")
  check_level "context at $p%" "$actual" "$want"
  case "$want" in "${L_RED}"*) qwant="${L_RED}⚠ 5h: $p%" ;; "") qwant="" ;; *) qwant="${want}5h: $p%" ;; esac
  payload="{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":$p,\"resets_at\":$IN_2H}}}"
  actual=$(line2_of "$payload")
  check_level "quota at $p%" "$actual" "$qwant"
done

# The whole raw second line with the context and both quotas shown: every
# sequence, its reset, the bar and the reset tail inside the coloured zone.
R="${ESC}[0m"
for lvl in "75:${L_ORANGE}:8:" "85:${L_RED}:9:⚠ "; do
  IFS=: read -r p col filled mark <<<"$lvl"
  bar=$(printf '%*s' "$filled" '' | sed 's/ /▓/g')$(printf '%*s' "$((10 - filled))" '' | sed 's/ /░/g')
  want="${col}${mark}ctx: ${p}%${R} │ ${col}${mark}5h: ${p}% ${bar} → 2h13${R} │ ${col}${mark}7d: ${p}% ${bar} → 3d${R}"
  payload="{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},\"context_window\":{\"used_percentage\":$p},\"rate_limits\":{\"five_hour\":{\"used_percentage\":$p,\"resets_at\":$IN_2H},\"seven_day\":{\"used_percentage\":$p,\"resets_at\":$IN_3D}}}"
  actual=$(line2_of "$payload")
  if [ "$actual" = "$want" ]; then
    printf '  ok   %s\n' "whole line 2 at $p%"; pass=$((pass + 1))
  else
    printf '  FAIL %s\n' "whole line 2 at $p%"
    printf '       want:   %q\n       actual: %q\n' "$want" "$actual"; fail=$((fail + 1))
  fi
done

check "quota at 80 carries the warning" "$ALL_ON" \
  "{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":80,\"resets_at\":$IN_2H}}}" \
"plain
⚠ 5h: 80% ▓▓▓▓▓▓▓▓░░ → 2h13"

check "quota at 79 carries no warning" "$ALL_ON" \
  "{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":79,\"resets_at\":$IN_2H}}}" \
"plain
5h: 79% ▓▓▓▓▓▓▓▓░░ → 2h13"

# The separator and the session name are drawn in the default foreground.
raw1=$(printf '%s' "{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},\"model\":{\"display_name\":\"a-model\"},\"session_name\":\"my session\"}" \
  | STATUSBAR_CONFIG="$ALL_ON" bash "$SCRIPT" | sed -n 1p)
case "$raw1" in
  *"${ESC}[0;90m"*) printf '  FAIL %s\n' "separator and session name avoid the grey 0;90"; fail=$((fail + 1)) ;;
  *) printf '  ok   %s\n' "separator and session name avoid the grey 0;90"; pass=$((pass + 1)) ;;
esac
case "$raw1" in
  *"${ESC}[3mmy session"*) printf '  ok   %s\n' "session name is italic"; pass=$((pass + 1)) ;;
  *) printf '  FAIL %s\n' "session name is italic"; fail=$((fail + 1)) ;;
esac

echo "== context tokens against the gate =="

# ctx_payload <session_name> <window size> <input> <cache creation> <cache read> <pct>
# An empty session name leaves the field out of the payload.
ctx_payload() {
  local name=""
  [ -n "$1" ] && name="\"session_name\":\"$1\","
  printf '{%s"workspace":{"current_dir":"%s"},"context_window":{"used_percentage":%s,"context_window_size":%s,"current_usage":{"input_tokens":%s,"cache_creation_input_tokens":%s,"cache_read_input_tokens":%s}}}' \
    "$name" "$EMPTY_DIR" "$6" "$2" "$3" "$4" "$5"
}
CTX_ONLY=$(config_with SHOW_DIRECTORY=0 SHOW_USAGE=0 SHOW_CONTEXT=1 SHOW_CONTEXT_TOKENS=1 \
  SHOW_SESSION_NAME=0 SHOW_LINES_CHANGED=0)

check "orchestrator session on a 1M window shows the 300k gate" "$CTX_ONLY" \
  "$(ctx_payload 'Orch : build' 1000000 4000 2603 290000 30)" \
"ctx: 30% · 296k/300k"

check "agent session on a 1M window shows the 300k gate" "$CTX_ONLY" \
  "$(ctx_payload 'Agent : phase 2' 1000000 4000 2603 290000 30)" \
"ctx: 30% · 296k/300k"

check "audit session shows the gate" "$CTX_ONLY" \
  "$(ctx_payload 'Audit : method' 1000000 1000 0 99000 10)" \
"ctx: 10% · 100k/300k"
check "coordinator session shows the gate" "$CTX_ONLY" \
  "$(ctx_payload 'Coord : machine' 1000000 1000 0 99000 10)" \
"ctx: 10% · 100k/300k"

check "quoted orchestrator name still counts" "$CTX_ONLY" \
  "$(ctx_payload '\"Orch : x\"' 1000000 4000 2603 290000 30)" \
"ctx: 30% · 296k/300k"

check "unnamed session shows the tokens alone" "$CTX_ONLY" \
  "$(ctx_payload '' 1000000 4000 2603 290000 30)" \
"ctx: 30% · 296k"

check "another session name shows the tokens alone" "$CTX_ONLY" \
  "$(ctx_payload 'my session' 1000000 4000 2603 290000 30)" \
"ctx: 30% · 296k"

check "200k window: the gate is 80% of the window" "$CTX_ONLY" \
  "$(ctx_payload 'Orch : small' 200000 1000 0 99000 50)" \
"ctx: 50% · 100k/160k"

actual=$(ctx_payload 'Orch : tuned' 1000000 1000 0 99000 10 \
  | ORCHESTRATOR_CONTEXT_GATE_TOKENS=250000 STATUSBAR_CONFIG="$CTX_ONLY" bash "$SCRIPT" | strip_ansi)
if [ "$actual" = "ctx: 10% · 100k/250k" ]; then
  echo "  ok   ORCHESTRATOR_CONTEXT_GATE_TOKENS overrides the token gate"; pass=$((pass + 1))
else
  echo "  FAIL ORCHESTRATOR_CONTEXT_GATE_TOKENS overrides the token gate: got « $actual »"; fail=$((fail + 1))
fi
actual=$(ctx_payload 'Orch : small' 200000 1000 0 99000 50 \
  | ORCHESTRATOR_CONTEXT_GATE=50 STATUSBAR_CONFIG="$CTX_ONLY" bash "$SCRIPT" | strip_ansi)
if [ "$actual" = "ctx: 50% · 100k/100k" ]; then
  echo "  ok   ORCHESTRATOR_CONTEXT_GATE overrides the percentage gate"; pass=$((pass + 1))
else
  echo "  FAIL ORCHESTRATOR_CONTEXT_GATE overrides the percentage gate: got « $actual »"; fail=$((fail + 1))
fi
actual=$(ctx_payload 'Orch : big' 2000000 1000 0 99000 5 \
  | ORCHESTRATOR_LARGE_WINDOW=3000000 STATUSBAR_CONFIG="$CTX_ONLY" bash "$SCRIPT" | strip_ansi)
if [ "$actual" = "ctx: 5% · 100k/1600k" ]; then
  echo "  ok   ORCHESTRATOR_LARGE_WINDOW moves the large-window threshold"; pass=$((pass + 1))
else
  echo "  FAIL ORCHESTRATOR_LARGE_WINDOW moves the large-window threshold: got « $actual »"; fail=$((fail + 1))
fi

check "under 1,000 tokens printed as is" "$CTX_ONLY" \
  "$(ctx_payload '' 200000 400 100 99 1)" \
"ctx: 1% · 599"

check "tokens absent: the segment stays as before" "$CTX_ONLY" \
  "{\"session_name\":\"Orch : x\",\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},\"context_window\":{\"used_percentage\":30,\"context_window_size\":1000000}}" \
"ctx: 30%"

check "window size absent: tokens alone, no gate" "$CTX_ONLY" \
  "{\"session_name\":\"Orch : x\",\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},\"context_window\":{\"used_percentage\":30,\"current_usage\":{\"input_tokens\":296000}}}" \
"ctx: 30% · 296k"

check "toggle off restores the plain segment" \
  "$(config_with SHOW_DIRECTORY=0 SHOW_USAGE=0 SHOW_CONTEXT=1 SHOW_CONTEXT_TOKENS=0 SHOW_SESSION_NAME=0 SHOW_LINES_CHANGED=0)" \
  "$(ctx_payload 'Orch : build' 1000000 4000 2603 290000 30)" \
"ctx: 30%"

check "a non-numeric token field leaves the other segments and no tokens" \
  "$(config_with SHOW_DIRECTORY=0 SHOW_USAGE=0 SHOW_MODEL=1 SHOW_CONTEXT=1 SHOW_CONTEXT_TOKENS=1 \
    SHOW_SESSION_NAME=0 SHOW_LINES_CHANGED=0)" \
  "{\"model\":{\"display_name\":\"a-model\"},\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},\"context_window\":{\"used_percentage\":30,\"context_window_size\":1000000,\"current_usage\":{\"input_tokens\":\"abc\"}}}" \
"a-model
ctx: 30%"

check "the warning keeps its mark with the tokens" "$CTX_ONLY" \
  "$(ctx_payload 'Orch : full' 200000 1000 0 169000 85)" \
"⚠ ctx: 85% · 170k/160k"

echo "== regression: consecutive empty fields =="

# The separator is 0x1F rather than a tab precisely so two empty fields in a
# row cannot shift the ones after them. Here pr, model and session_name are
# all absent: current_dir, read last, must survive.
check "three empty fields in a row do not shift current_dir" "$ALL_ON" \
  "{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},\"context_window\":{\"used_percentage\":5},
    \"cost\":{\"total_lines_added\":1,\"total_lines_removed\":0},
    \"rate_limits\":{\"five_hour\":{\"used_percentage\":10,\"resets_at\":$IN_2H}}}" \
"plain
ctx: 5% │ 5h: 10% ▓░░░░░░░░░ → 2h13 │ +1/-0"

echo "== settings =="

check "everything off renders nothing" "$(config_with SHOW_DIRECTORY=0 SHOW_BRANCH=0 SHOW_PR=0 \
  SHOW_MODEL=0 SHOW_USAGE=0 SHOW_CONTEXT=0 SHOW_SESSION_NAME=0 SHOW_LINES_CHANGED=0)" \
  "{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},\"model\":{\"display_name\":\"a-model\"},
    \"rate_limits\":{\"five_hour\":{\"used_percentage\":47,\"resets_at\":$IN_2H}}}" \
""

check "bar and reset disabled" "$(config_with SHOW_PROGRESS_BAR=0 SHOW_RESET_TIME=0 \
  SHOW_DIRECTORY=0 SHOW_CONTEXT=0 SHOW_LINES_CHANGED=0)" \
  "{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},
    \"rate_limits\":{\"five_hour\":{\"used_percentage\":47,\"resets_at\":$IN_2H}}}" \
"5h: 47%"

echo "== git =="

REPO="$WORK/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main 2>/dev/null
git -C "$REPO" config user.email t@t.t; git -C "$REPO" config user.name t
echo one > "$REPO/a.txt"; git -C "$REPO" add a.txt
git -C "$REPO" commit -qm init
check "clean repository" "$(config_with SHOW_PR=0 SHOW_MODEL=0 SHOW_USAGE=0 SHOW_CONTEXT=0 \
  SHOW_SESSION_NAME=0 SHOW_LINES_CHANGED=0)" \
  "{\"workspace\":{\"current_dir\":\"$REPO\"}}" \
"repo │ ⎇ main"

echo two > "$REPO/b.txt"
check "dirty repository marked with *" "$(config_with SHOW_PR=0 SHOW_MODEL=0 SHOW_USAGE=0 \
  SHOW_CONTEXT=0 SHOW_SESSION_NAME=0 SHOW_LINES_CHANGED=0)" \
  "{\"workspace\":{\"current_dir\":\"$REPO\"}}" \
"repo │ ⎇ main*"

check "outside a repository: no git segment" "$(config_with SHOW_PR=0 SHOW_MODEL=0 SHOW_USAGE=0 \
  SHOW_CONTEXT=0 SHOW_SESSION_NAME=0 SHOW_LINES_CHANGED=0)" \
  "{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"}}" \
"plain"

echo "== robustness =="

check "empty stdin does not crash" "$ALL_ON" "" \
"Usage: ~"

check "invalid JSON does not crash" "$ALL_ON" "not json at all" \
"Usage: ~"

echo "== independence: no credentials, no network =="

# The core of the fix: not a trace of the old session-cookie mechanism.
code_only=$(grep -vE '^[[:space:]]*#' "$SCRIPT")
if printf '%s' "$code_only" | grep -qiE 'sessionkey|usage-credentials|/api/organizations|fetch-.*-usage|curl |urllib'; then
  echo "  FAIL the script still references a credential or network mechanism"
  printf '%s' "$code_only" | grep -niE 'sessionkey|usage-credentials|/api/organizations|fetch-.*-usage|curl |urllib' | sed 's/^/       /'
  fail=$((fail + 1))
else
  echo "  ok   no session cookie and no network call anywhere in the code"
  pass=$((pass + 1))
fi

# A pristine HOME stands in for a freshly provisioned machine: the status line
# must render quotas without a single credential file.
FAKE_HOME="$WORK/fresh"; mkdir -p "$FAKE_HOME"
out=$(printf '%s' "{\"workspace\":{\"current_dir\":\"$EMPTY_DIR\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":47,\"resets_at\":$IN_2H}}}" \
  | env HOME="$FAKE_HOME" STATUSBAR_CONFIG="$FAKE_HOME/absent.txt" bash "$SCRIPT" | strip_ansi)
if [ "$out" = "plain
5h: 47% ▓▓▓▓▓░░░░░ → 2h13" ]; then
  echo "  ok   pristine HOME with no credentials: quotas still render"
  pass=$((pass + 1))
else
  echo "  FAIL pristine HOME: got « $(printf '%s' "$out" | tr '\n' '⏎') »"
  fail=$((fail + 1))
fi

echo "== install / uninstall: a wrapped statusLine survives =="

# A second tool (the context tap) can wrap statusLine.command into
# "<tap script> <previous command>". install.sh and uninstall.sh must not
# clobber that wrapper: only this status bar's own path is theirs to manage.

INSTALL="$HERE/../install.sh"
UNINSTALL="$HERE/../uninstall.sh"

# fresh_config [settings-json] -> path to an isolated CLAUDE_CONFIG_DIR,
# pre-seeded with $1 as settings.json when given.
fresh_config() {
  local dir="$WORK/cfg.$RANDOM"
  mkdir -p "$dir"
  [ -n "${1:-}" ] && printf '%s' "$1" > "$dir/settings.json"
  printf '%s' "$dir"
}

dest_for() { printf '%s/statusbar/statusline.sh' "$1"; }

# check_json <name> <config-dir> <jq filter> <expected>
check_json() {
  local name="$1" dir="$2" filter="$3" expected="$4" actual
  actual=$(jq -r "$filter" "$dir/settings.json" 2>/dev/null)
  if [ "$actual" = "$expected" ]; then
    printf '  ok   %s\n' "$name"; pass=$((pass + 1))
  else
    printf '  FAIL %s\n' "$name"
    printf '       expected: %s\n' "$expected"
    printf '       actual:   %s\n' "$actual"
    fail=$((fail + 1))
  fi
}

echo "-- install --"

CFG=$(fresh_config "")
DEST=$(dest_for "$CFG")
CLAUDE_CONFIG_DIR="$CFG" bash "$INSTALL" >/dev/null
check_json "fresh install writes statusLine" "$CFG" '.statusLine.command' "$DEST"

CFG=$(fresh_config "")
DEST=$(dest_for "$CFG")
WRAPPED="/opt/tap.sh $DEST"
printf '{"statusLine":{"type":"command","command":"%s","padding":0},"other":true}' \
  "$WRAPPED" > "$CFG/settings.json"
out=$(CLAUDE_CONFIG_DIR="$CFG" bash "$INSTALL")
check_json "install over a wrapped command leaves it unchanged" "$CFG" \
  '.statusLine.command' "$WRAPPED"
check_json "install over a wrapped command keeps the other key" "$CFG" '.other' "true"
if printf '%s' "$out" | grep -qF "$WRAPPED"; then
  printf '  ok   %s\n' "install over a wrapped command reports the current command"
  pass=$((pass + 1))
else
  printf '  FAIL %s\n' "install over a wrapped command reports the current command"
  fail=$((fail + 1))
fi

CFG=$(fresh_config '{"statusLine":{"type":"command","command":"/some/other/statusline.sh","padding":0}}')
DEST=$(dest_for "$CFG")
CLAUDE_CONFIG_DIR="$CFG" bash "$INSTALL" >/dev/null
check_json "install over a foreign command replaces it" "$CFG" '.statusLine.command' "$DEST"
if grep -rq "/some/other/statusline.sh" "$CFG"/backups/*/settings.json.before 2>/dev/null; then
  printf '  ok   %s\n' "install over a foreign command backs it up"
  pass=$((pass + 1))
else
  printf '  FAIL %s\n' "install over a foreign command backs it up"
  fail=$((fail + 1))
fi

echo "-- uninstall --"

CFG=$(fresh_config "")
DEST=$(dest_for "$CFG")
printf '{"statusLine":{"type":"command","command":"%s","padding":0}}' "$DEST" > "$CFG/settings.json"
CLAUDE_CONFIG_DIR="$CFG" bash "$UNINSTALL" >/dev/null
check_json "uninstall of our own command deletes statusLine" "$CFG" 'has("statusLine")' "false"

CFG=$(fresh_config "")
DEST=$(dest_for "$CFG")
WRAPPED="/opt/tap.sh $DEST"
printf '{"statusLine":{"type":"command","command":"%s","padding":0},"other":true}' \
  "$WRAPPED" > "$CFG/settings.json"
CLAUDE_CONFIG_DIR="$CFG" bash "$UNINSTALL" >/dev/null
check_json "uninstall of a wrapped command keeps the wrapper, drops our path" "$CFG" \
  '.statusLine.command' "/opt/tap.sh"
check_json "uninstall of a wrapped command keeps the other key" "$CFG" '.other' "true"

CFG=$(fresh_config "")
DEST=$(dest_for "$CFG")
DEGENERATE="$DEST $DEST"
printf '{"statusLine":{"type":"command","command":"%s","padding":0}}' "$DEGENERATE" > "$CFG/settings.json"
CLAUDE_CONFIG_DIR="$CFG" bash "$UNINSTALL" >/dev/null
check_json "uninstall leaving nothing runnable leaves statusLine untouched" "$CFG" \
  '.statusLine.command' "$DEGENERATE"

CFG=$(fresh_config '{"statusLine":{"type":"command","command":"/some/other/statusline.sh","padding":0}}')
CLAUDE_CONFIG_DIR="$CFG" bash "$UNINSTALL" >/dev/null
check_json "uninstall of a foreign command leaves statusLine untouched" "$CFG" \
  '.statusLine.command' "/some/other/statusline.sh"

echo "-- \$HOME spelling --"

# settings.json is free text: a wrapper written by hand, or templated, may
# spell our path "$HOME/.claude/statusbar/statusline.sh" instead of
# expanding it. These runs leave CLAUDE_CONFIG_DIR unset and override HOME
# instead, so CONFIG_DIR resolves the default way ($HOME/.claude) and the
# literal "$HOME/…" spelling in the fixture really does name our script.

FAKE_HOME=$(fresh_config "")
mkdir -p "$FAKE_HOME/.claude"
WRAPPED_HOME='/opt/tap.sh $HOME/.claude/statusbar/statusline.sh'
printf '{"statusLine":{"type":"command","command":"%s","padding":0},"other":true}' \
  "$WRAPPED_HOME" > "$FAKE_HOME/.claude/settings.json"
out=$(env HOME="$FAKE_HOME" bash "$INSTALL")
check_json "install over a \$HOME-spelled wrapped command leaves it unchanged" \
  "$FAKE_HOME/.claude" '.statusLine.command' "$WRAPPED_HOME"
check_json "install over a \$HOME-spelled wrapped command keeps the other key" \
  "$FAKE_HOME/.claude" '.other' "true"
if printf '%s' "$out" | grep -qF "$WRAPPED_HOME"; then
  printf '  ok   %s\n' "install over a \$HOME-spelled wrapped command reports the current command"
  pass=$((pass + 1))
else
  printf '  FAIL %s\n' "install over a \$HOME-spelled wrapped command reports the current command"
  fail=$((fail + 1))
fi

FAKE_HOME=$(fresh_config "")
mkdir -p "$FAKE_HOME/.claude"
WRAPPED_HOME='/opt/tap.sh $HOME/.claude/statusbar/statusline.sh'
printf '{"statusLine":{"type":"command","command":"%s","padding":0},"other":true}' \
  "$WRAPPED_HOME" > "$FAKE_HOME/.claude/settings.json"
env HOME="$FAKE_HOME" bash "$UNINSTALL" >/dev/null
check_json "uninstall of a \$HOME-spelled wrapped command keeps the wrapper, drops our path" \
  "$FAKE_HOME/.claude" '.statusLine.command' "/opt/tap.sh"
check_json "uninstall of a \$HOME-spelled wrapped command keeps the other key" \
  "$FAKE_HOME/.claude" '.other' "true"

echo "-- config directory --"

# The status line reads its settings from CLAUDE_CONFIG_DIR, not ~/.claude.
CFG=$(fresh_config "")
printf 'SHOW_MODEL=1\nSHOW_DIRECTORY=0\nSHOW_USAGE=0\nSHOW_CONTEXT=0\nSHOW_LINES_CHANGED=0\nSHOW_SESSION_NAME=0\nSHOW_PR=0\nSHOW_BRANCH=0\n' > "$CFG/statusline-config.txt"
actual=$(printf '{"model":{"display_name":"fixture-model"}}' | env -u STATUSBAR_CONFIG CLAUDE_CONFIG_DIR="$CFG" bash "$SCRIPT" | strip_ansi)
if [ "$actual" = "fixture-model" ]; then
  printf '  ok   %s\n' "settings are read from CLAUDE_CONFIG_DIR"; pass=$((pass + 1))
else
  printf '  FAIL %s (got: %s)\n' "settings are read from CLAUDE_CONFIG_DIR" "$actual"; fail=$((fail + 1))
fi

# The registered entry point runs the active plugin install, not a frozen copy.
CFG=$(fresh_config "")
mkdir -p "$CFG/plugins" "$WORK/active/statusline"
printf '#!/bin/bash\necho active-install\n' > "$WORK/active/statusline/statusline.sh"
printf '{"plugins":{"claude-statusbar@some-market":[{"installPath":"%s"}]}}' "$WORK/active" \
  > "$CFG/plugins/installed_plugins.json"
CLAUDE_CONFIG_DIR="$CFG" bash "$INSTALL" >/dev/null
actual=$(printf '{}' | CLAUDE_CONFIG_DIR="$CFG" bash "$(dest_for "$CFG")")
if [ "$actual" = "active-install" ]; then
  printf '  ok   %s\n' "installed entry point runs the active plugin install"; pass=$((pass + 1))
else
  printf '  FAIL %s (got: %s)\n' "installed entry point runs the active plugin install" "$actual"; fail=$((fail + 1))
fi

# The plugin is named `statusbar` (the host reserves the `claude-` prefix); the entry point
# finds it under that name, and still under the old one until a machine reinstalls.
CFG=$(fresh_config "")
mkdir -p "$CFG/plugins" "$WORK/renamed/statusline"
printf '#!/bin/bash\necho renamed-install\n' > "$WORK/renamed/statusline/statusline.sh"
printf '{"plugins":{"statusbar@some-market":[{"installPath":"%s"}]}}' "$WORK/renamed" \
  > "$CFG/plugins/installed_plugins.json"
CLAUDE_CONFIG_DIR="$CFG" bash "$INSTALL" >/dev/null
actual=$(printf '{}' | CLAUDE_CONFIG_DIR="$CFG" bash "$(dest_for "$CFG")")
if [ "$actual" = "renamed-install" ]; then
  printf '  ok   %s\n' "installed entry point runs the active install under the plugin's new name"; pass=$((pass + 1))
else
  printf '  FAIL %s (got: %s)\n' "installed entry point runs the active install under the plugin's new name" "$actual"; fail=$((fail + 1))
fi

# The manifest's options are exactly the keys the default settings file names.
expected=$(sed 's/=.*//' "$HERE/../statusline/statusline-config.default.txt" | sort)
declared=$(jq -r '.userConfig | keys[]' "$HERE/../.claude-plugin/plugin.json" | sort)
if [ "$declared" = "$expected" ]; then
  printf '  ok   %s\n' "plugin options match the default settings keys"; pass=$((pass + 1))
else
  printf '  FAIL %s\n' "plugin options match the default settings keys"; fail=$((fail + 1))
fi
nonbool=$(jq -r '.userConfig | to_entries[] | select(.value.type != "boolean" or .value.default != true) | .key' "$HERE/../.claude-plugin/plugin.json")
if [ -z "$nonbool" ]; then
  printf '  ok   %s\n' "every plugin option is a boolean that defaults to on"; pass=$((pass + 1))
else
  printf '  FAIL %s (%s)\n' "every plugin option is a boolean that defaults to on" "$nonbool"; fail=$((fail + 1))
fi

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
