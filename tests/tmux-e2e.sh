#!/bin/bash
# tmux-e2e.sh - agents as windows of a home session, spawned, listed, read, closed and
# rotated by the launcher on live hosts; then an orchestrator's own life in a home server of
# its own: the move into it, the coordinator's open, pause and wake, and the successor.
#
#   ORCHESTRATOR_TIER_LIGHT=<model> tests/tmux-e2e.sh [--keep]
#
# NOT part of `run-tests.sh`, like `e2e.sh` and `pane-e2e.sh`: it starts six host sessions in
# detached tmux servers of its own and kills every one at the end. The moved, opened and
# woken orchestrators run with ORCHESTRATOR_HOME_NO_TAB (honoured beside the test marker
# ORCHESTRATOR_TEST_RUN, which this script sets), their servers shown by no tab: the
# tab's side of those gestures is the suite's, over a recorder. The home session is made
# the way the home command will make it: window 0 holds the caller (a shell here, where the
# orchestrator would run), and the session carries the mark (`@orchestrator-home` = 1). Every
# launcher command is typed into window 0 and runs there, so its TMUX, its TMUX_PANE and its
# tty are a real pane's and nothing stands in for them. Nothing is ever attached.
#
# The hosts are the one logged in on this machine, on its subscription: the script makes no
# credential, asks for none and writes none. Before any host starts it asks the host for its
# authentication (`auth status`), and refuses unless it reads the subscription's sign-in;
# then it reads each agent's banner and refuses when the banner bills usage by the API rather
# than the subscription (ORCHESTRATOR_E2E_PLAN, `Max` by default, names the plan the banner
# must show). The agents run on the light tier, the model the operator binds to it given in
# ORCHESTRATOR_TIER_LIGHT, and each is asked to reply with a fixed word.
#
# The hosts run with the user's settings left out (`--setting-sources project`, through a
# wrapper the launcher is pointed at) and no MCP server, and with this checkout loaded as their
# plugin: the module it carries is what writes each window's `@state`. Everything the launcher writes goes to
# the sandbox: its state (ORCHESTRATOR_STATE_DIR, the chain and the launch files among it) and
# the module's own files (ORCHESTRATOR_MODULE_DIR). What the host itself keeps of a session it
# ran is its own bookkeeping: the transcript directory of the sandbox's work path is removed at
# the end, and the prompt history keeps its lines naming the sandbox, which the script only
# counts. The sandbox lives under ORCHESTRATOR_E2E_DIR (/tmp by default), a directory the host
# already trusts: the script never accepts the trust question, and refuses to go on when a
# host asks it. It skips itself without tmux, jq or the host. The banner's plan is the
# operator's: ORCHESTRATOR_E2E_PLAN=Ultra on a machine whose banner reads so.

set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOST=${ORCHESTRATOR_HOST_CLI:-claude}
PLAN=${ORCHESTRATOR_E2E_PLAN:-Max}
MODEL=${ORCHESTRATOR_TIER_LIGHT:-}
SERVER=tmux-e2e-$$
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

for need in tmux jq "$HOST"; do
  command -v "$need" >/dev/null 2>&1 || { echo "skipped: $need is not installed"; exit 0; }
done
[ -n "$MODEL" ] || { echo "refused: ORCHESTRATOR_TIER_LIGHT must name the light tier's model" >&2; exit 2; }
REAL_HOST=$(command -v "$HOST")
EPATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1))
  else printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}

# The subscription, or no host at all. USER is kept beside HOME: without it the host cannot
# read its sign-in and starts on its login screen.
auth=$(env -i HOME="$HOME" USER="$USER" PATH="$EPATH" "$REAL_HOST" auth status --json 2>/dev/null)
method=$(printf '%s' "$auth" | jq -r '.authMethod // empty' 2>/dev/null)
# The subscription's sign-in is named after the host's own site, `<host>.ai`.
if [ "$method" != "${HOST##*/}.ai" ]; then
  echo "refused: the host is not signed in on the subscription (authMethod '${method:-unread}'); no host was started" >&2
  exit 1
fi

HOSTDIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
HISTORY="$HOSTDIR/history.jsonl"
BASE=${ORCHESTRATOR_E2E_DIR:-/tmp}
# Resolved to its real path: the host keys its projects on the real path.
SANDBOX=$(mktemp -d "$BASE/tmux-e2e-XXXXXX") && SANDBOX=$(cd "$SANDBOX" && pwd -P)
[ -d "${SANDBOX}" ] || { echo "cannot create a working directory under $BASE" >&2; exit 1; }
WORKDIR="$SANDBOX/work"
STATE="$SANDBOX/state"
mkdir -p "$WORKDIR" "$STATE" "$SANDBOX/module" "$SANDBOX/bin" "$SANDBOX/run"
tm() { tmux -L "$SERVER" "$@"; }
# The home servers the run starts besides its own, each ended at the end whatever happened.
HOMES=()
cleanup() {
  tm kill-server 2>/dev/null
  local h
  for h in ${HOMES[@]+"${HOMES[@]}"}; do
    tmux -L "$h" kill-server 2>/dev/null
    rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$h" "/private/tmp/tmux-$(id -u)/$h"
  done
  # The host writes until it is gone: removed sooner, part of it comes back.
  sleep 2
  local transcripts
  transcripts=$(printf '%s' "$WORKDIR" | sed 's/[^A-Za-z0-9]/-/g')
  case "$transcripts" in *-tmux-e2e-*-work) rm -rf "${HOSTDIR:?}/projects/$transcripts" ;; esac
  rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$SERVER" "/private/tmp/tmux-$(id -u)/$SERVER"
  [ "$KEEP" = 1 ] || rm -rf "$SANDBOX"
  [ "$KEEP" = 1 ] && echo "sandbox kept: $SANDBOX"
  local named
  named=$(grep -cF -- "$SANDBOX" "$HISTORY" 2>/dev/null)
  echo "history: ${named:-0} lines name the sandbox"
  return 0
}
trap cleanup EXIT

# The host the launcher starts: the real one, without the user's settings.
WRAPPER="$SANDBOX/bin/${HOST##*/}"
# No test session may come up in Remote Control, where the operator would see it: the wrapper
# drops a --remote-control the launcher gives an orchestrator, and makes every launch carry
# remoteControlAtStartup=false, merged into the launcher's own --settings when it has one.
cat > "$WRAPPER" <<WSH
#!/bin/sh
real="$REAL_HOST"
n=\$#; prev=; patched=0
while [ \$n -gt 0 ]; do
  a=\$1; shift; n=\$((n - 1))
  case "\$prev" in
    --remote-control) prev=; continue ;;
    --settings) a=\$(printf '%s' "\$a" | jq -c '. + {remoteControlAtStartup: false}'); patched=1 ;;
  esac
  prev=\$a
  [ "\$a" = --remote-control ] && continue
  set -- "\$@" "\$a"
done
[ \$patched -eq 1 ] || set -- "\$@" --settings '{"remoteControlAtStartup":false}'
exec "\$real" --setting-sources project --plugin-dir "$ROOT" "\$@"
WSH
chmod +x "$WRAPPER"
# The launcher's own trust record names the work directory; the host trusts it through BASE.
jq -n --arg dir "$WORKDIR" '{projects: {($dir): {hasTrustDialogAccepted: true}}}' > "$SANDBOX/trust.json"

# The home session: a shell in window 0, the mark set on the session.
passthrough=()
[ -n "${CLAUDE_CONFIG_DIR:-}" ] && passthrough+=("CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR")
[ -n "${ORCHESTRATOR_PROJECTS_DIR:-}" ] && passthrough+=("ORCHESTRATOR_PROJECTS_DIR=$ORCHESTRATOR_PROJECTS_DIR")
env -i HOME="$HOME" USER="$USER" PATH="$EPATH" TERM=xterm-256color \
  ORCHESTRATOR_STATE_DIR="$STATE" ORCHESTRATOR_MODULE_DIR="$SANDBOX/module" \
  ORCHESTRATOR_HOST_CLI="$WRAPPER" ORCHESTRATOR_TRUST_FILE="$SANDBOX/trust.json" \
  ORCHESTRATOR_TIER_LIGHT="$MODEL" ORCHESTRATOR_WORKSPACES="$SANDBOX" ${passthrough[@]+"${passthrough[@]}"} \
  tmux -L "$SERVER" new-session -d -s home -n orch -x 160 -y 45 -c "$WORKDIR" '/bin/bash --noprofile --norc'
tm set -t home @orchestrator-home 1 >/dev/null
SOCKET=$(tm display -p -t home:0 '#{socket_path}')
OWN_PANE=$(tm display -p -t home:0 '#{pane_id}')
OWN_TTY=$(tm display -p -t home:0 '#{pane_tty}')

# One launcher command, typed into window 0 and waited for: its stdout, its stderr and its exit
# code land in the run directory under the step's name.
# LT names the pane it is typed into (window 0 of the home session unless set), LENV the
# variables it runs with, as `NAME=value` words.
n=0
LT=home:0
LENV=()
launcher() { # <timeout> <subcommand and options>
  local wait="$1"; shift
  n=$((n + 1))
  local step="$SANDBOX/run/$n"
  { [ ${#LENV[@]} -gt 0 ] && printf 'env'; [ ${#LENV[@]} -gt 0 ] && printf ' %q' "${LENV[@]}"
    printf ' bash %q' "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh"; printf ' %q' "$@"
    printf ' > %q 2> %q; echo $? > %q\n' "$step.out" "$step.err" "$step.rc"; } > "$step.sh"
  tm send-keys -t "$LT" "bash $step.sh" Enter
  local i=0
  while [ ! -s "$step.rc" ] && [ $i -lt $((wait * 2)) ]; do sleep 0.5; i=$((i + 1)); done
  [ -s "$step.rc" ] || { echo "timeout" > "$step.rc"; }
  STEP="$step"
}
rc() { cat "$STEP.rc"; }
out() { cat "$STEP.out"; }
# A pane of this server, or `<server>::<pane>` for one of a home server's.
screen_of() { case "$1" in *::*) tmux -L "${1%%::*}" capture-pane -p -t "${1#*::}" ;; *) tm capture-pane -p -t "$1" ;; esac; }
windows() { tm list-windows -t home -F '#{window_index} #{window_id} #{window_name} #{window_active}'; }
hosts_on() { ps -t "${1#/dev/}" -o command= 2>/dev/null | grep -c -- "--setting-sources project"; }
chain() { cat "$STATE/chains/${OWN_TTY#/dev/}.jsonl" 2>/dev/null; }
wait_for() { # <pane> <text> <seconds>
  local i=0
  while [ $i -lt $(($3 * 2)) ]; do
    screen_of "$1" | grep -qF -- "$2" && return 0
    sleep 0.5; i=$((i + 1))
  done
  return 1
}

# The host's reply: a line the host marks with its bullet and that carries the word, in
# whatever case it answers.
REPLY_RE() { printf '^[[:space:]]*⏺.*%s' "$1"; }
wait_reply() { # <pane> <word> <seconds>
  local i=0
  while [ $i -lt $(($3 * 2)) ]; do
    screen_of "$1" | grep -qiE "$(REPLY_RE "$2")" && return 0
    sleep 0.5; i=$((i + 1))
  done
  return 1
}

# The subscription, read on a host's own banner: its first rows name the product and the plan,
# and the API billing line anywhere on that screen refuses.
banner_or_exit() { # <pane>
  local brand plan_re text
  brand=$(printf '%s' "${HOST##*/}" | awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }')
  plan_re=$(printf '%s' "$PLAN" | sed 's/[][\\.*^$(){}?+|\/-]/\\&/g')
  wait_for "$1" "$brand" 30
  text=$(screen_of "$1")
  if printf '%s\n' "$text" | grep -qF 'trust this folder'; then
    echo "refused: a host asks to trust $WORKDIR; set ORCHESTRATOR_E2E_DIR to a directory it trusts" >&2
    exit 1
  fi
  if printf '%s\n' "$text" | grep -qF 'API Usage Billing' || ! printf '%s\n' "$text" | head -12 | grep -qE "$brand $plan_re( |$)"; then
    echo "refused: the host's banner does not read the $PLAN subscription; nothing more was driven" >&2
    printf '%s\n' "$text" | head -12 >&2
    exit 1
  fi
}

# A resumed session redraws its conversation, which scrolls its banner off the screen: the
# subscription was read on that conversation's banner before it ended, so here the whole
# history is read for what refuses, the API billing line or the trust question.
history_of() { case "$1" in *::*) tmux -L "${1%%::*}" capture-pane -p -S - -t "${1#*::}" ;; *) tm capture-pane -p -S - -t "$1" ;; esac; }
resumed_or_exit() { # <pane>
  local text
  sleep 5
  text=$(history_of "$1")
  if printf '%s\n' "$text" | grep -qF 'trust this folder' || printf '%s\n' "$text" | grep -qF 'API Usage Billing'; then
    echo "refused: the resumed session on $1 asks for trust or bills usage by the API; nothing more was driven" >&2
    exit 1
  fi
}

# The word is asked for in pieces, to be joined by hyphens: the reply is the only line of the
# screen that carries the whole word, never the prompt shown above it.
prompt() { printf 'Reply with these words joined by hyphens, in lower case, and nothing else: %s. Do not use any tool.' \
  "$(printf '%s' "$1" | tr '[:upper:]-' '[:lower:] ')"; }
agent() { # <title> <word>: an agent spawned as the orchestrator spawns one
  launcher 90 spawn --dir "$WORKDIR" --tier light --permission-mode acceptEdits --title "$1" \
    --prompt "$(prompt "$2")" --right-of self
}

echo "== the switch =="
check "the session carries the mark" "1" "$(tm show -qv -t home @orchestrator-home)"

echo "== spawn: two agents, each a window of the home session =="
agent "Agent : e2e one" E2E-ONE-READY
ONE_RC=$(rc); ONE=$(out | tail -1); ONE_ERR=$(cat "$STEP.err")
check "the first spawn succeeds and prints the new tty" "0|1" "$ONE_RC|$(printf '%s' "$ONE" | grep -c '^/dev/ttys')"
ONE_PANE=$(tm list-panes -s -t home -F '#{pane_tty} #{pane_id}' | awk -v t="$ONE" '$1 == t { print $2 }')
[ -n "$ONE_PANE" ] && banner_or_exit "$ONE_PANE"
check "it was verified on the process table and on its transcript's mode" "1|1" \
  "$(printf '%s' "$ONE_ERR" | grep -c "running on $ONE")|$(printf '%s' "$ONE_ERR" | grep -c 'mode acceptEdits read on the transcript')"
agent "Agent : e2e two" E2E-TWO-READY
TWO_RC=$(rc); TWO=$(out | tail -1)
check "the second spawn succeeds on another tty" "0|1" "$TWO_RC|$([ -n "$TWO" ] && [ "$TWO" != "$ONE" ] && echo 1 || echo 0)"
TWO_PANE=$(tm list-panes -s -t home -F '#{pane_tty} #{pane_id}' | awk -v t="$TWO" '$1 == t { print $2 }')
[ -n "$TWO_PANE" ] && banner_or_exit "$TWO_PANE"
check "the agents are windows 1 and 2, named, and window 0 kept the operator's view" \
  "0 orch 1|1 Agent : e2e one 0|2 Agent : e2e two 0" \
  "$(windows | awk '{ $2 = ""; print }' | sed 's/  / /' | paste -sd'|' -)"
check "each runs on the light tier's model" "1|1" \
  "$(ps -t "${ONE#/dev/}" -o command= | grep -c -- "--model $MODEL")|$(ps -t "${TWO#/dev/}" -o command= | grep -c -- "--model $MODEL")"
W1=$(tm display -p -t home:1 '#{window_id}'); W2=$(tm display -p -t home:2 '#{window_id}')
check "the chain names each window by the server's socket and its id, owned by window 0's pane" \
  "tmux:$SOCKET:$W1 $ONE tmux:$SOCKET:$OWN_PANE|tmux:$SOCKET:$W2 $TWO tmux:$SOCKET:$OWN_PANE" \
  "$(chain | jq -r '"\(.tab_id) \(.tty) \(.owner)"' | paste -sd'|' -)"

echo "== list and screen =="
launcher 20 list
check "list shows window 0 as self and both agents, in the rows the stop gate parses" "0|1|1|1" \
  "$(rc)|$(out | grep -c "^w1/t0 | $OWN_TTY | .* | self\$")|$(out | grep -c "^w1/t1 | $ONE | .* | Agent : e2e one\$")|$(out | grep -c "^w1/t2 | $TWO | .* | Agent : e2e two\$")"
if wait_reply "$ONE_PANE" E2E-ONE-READY 90; then ONE_REPLIED=1; else ONE_REPLIED=0; fi
audit_rc
check "the first agent replied within 90s" "1" "$ONE_REPLIED"
launcher 20 screen --tty "$ONE" --lines 60
check "screen reads the first agent's reply" "0|1" "$(rc)|$(out | grep -ciE "$(REPLY_RE E2E-ONE-READY)")"

echo "== the state in the tab bar =="
# The module writes @state on the agent's own window: busy while a turn runs, idle once it has
# ended. Read back from the server, as the status line reads it; a second turn is typed into the
# first agent's window so that the busy state is caught on its way.
state_of() { tm display -p -t "$1" '#{@state}' 2>/dev/null; }
state_is() { # <pane> <state> <seconds>, polled every tenth of a second
  local i=0
  while [ $i -lt $(($3 * 10)) ]; do
    [ "$(state_of "$1")" = "$2" ] && return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}
if state_is "$ONE_PANE" idle 30; then FIRST_IDLE=idle; else FIRST_IDLE=$(state_of "$ONE_PANE"); fi
check "the first turn left the agent's window idle" "idle" "$FIRST_IDLE"
tm send-keys -t "$ONE_PANE" -l "$(prompt E2E-ONE-AGAIN)"
tm send-keys -t "$ONE_PANE" Enter
if state_is "$ONE_PANE" busy 30; then SECOND_BUSY=busy; else SECOND_BUSY=$(state_of "$ONE_PANE"); fi
check "the window reads busy during the next turn" "busy" "$SECOND_BUSY"
if wait_reply "$ONE_PANE" E2E-ONE-AGAIN 90; then AGAIN_REPLIED=1; else AGAIN_REPLIED=0; fi
check "the agent answered the second turn" "1" "$AGAIN_REPLIED"
if state_is "$ONE_PANE" idle 30; then SECOND_IDLE=idle; else SECOND_IDLE=$(state_of "$ONE_PANE"); fi
check "the window reads idle after it" "idle" "$SECOND_IDLE"

echo "== close =="
launcher 20 close --tty "$ONE" --expect-title "Agent : e2e two"
check "a close whose expected words the window's name does not hold is refused, and the window stays" "1|1|1" \
  "$(rc)|$(grep -c "close: refused: the window on $ONE is named 'Agent : e2e one'" "$STEP.err")|$(windows | grep -c ' Agent : e2e one ')"
launcher 30 close --tty "$ONE" --expect-title "Agent : e2e one"
check "the first agent is closed, proved on the process table, its window and chain entry gone" "0|closed 1 session on $ONE|0|0|0" \
  "$(rc)|$(out)|$(hosts_on "$ONE")|$(windows | grep -c ' Agent : e2e one ')|$(chain | grep -c "$W1")"

echo "== rotate =="
if wait_reply "$TWO_PANE" E2E-TWO-READY 90; then TWO_REPLIED=1; else TWO_REPLIED=0; fi
check "the second agent replied within 90s" "1" "$TWO_REPLIED"
launcher 120 rotate --old-tty "$TWO" --expect-title "Agent : e2e two" --dir "$WORKDIR" --tier light \
  --permission-mode acceptEdits --title "Agent : e2e three" --prompt "$(prompt E2E-THREE-READY)" --right-of self
THREE=$(out | head -1)
check "the replacement runs before the old window is killed, and both are said" "0|1|closed 1 session on $TWO" \
  "$(rc)|$(printf '%s' "$THREE" | grep -c '^/dev/ttys')|$(out | tail -1)"
THREE_PANE=$(tm list-panes -s -t home -F '#{pane_tty} #{pane_id}' | awk -v t="$THREE" '$1 == t { print $2 }')
[ -n "$THREE_PANE" ] && banner_or_exit "$THREE_PANE"
check "the old agent is gone from the process table and its window from the session; the new one runs" "0|0|1|1" \
  "$(hosts_on "$TWO")|$(windows | grep -c ' Agent : e2e two ')|$(windows | grep -c ' Agent : e2e three 0$')|$(hosts_on "$THREE")"
W3=$(tm list-panes -s -t home -F '#{pane_tty} #{window_id}' | awk -v t="$THREE" '$1 == t { print $2 }')
check "the chain holds the replacement's window alone" "tmux:$SOCKET:$W3 $THREE" \
  "$(chain | jq -r '"\(.tab_id) \(.tty)"' | paste -sd'|' -)"
check "window 0 is still the current window" "0 orch 1" "$(windows | awk '$1 == 0 { print $1, $3, $4 }')"

# Every test host's command line, read while it runs: none may lack remoteControlAtStartup=false
# or carry --remote-control. Offenders accumulate; the last check reads them.
RC_SEEN=0; RC_BAD=()
audit_rc() {
  local line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    RC_SEEN=$((RC_SEEN + 1))
    case "$line" in *'"remoteControlAtStartup":false'*) ;; *) RC_BAD+=("no setting: ${line:0:90}") ;; esac
    case "$line" in *--remote-control*) RC_BAD+=("remote control: ${line:0:90}") ;; esac
  done < <(ps -axo command= 2>/dev/null | grep -- '--setting-sources project' | grep -v 'grep\|tmux-e2e')
}

# The session a host process on a tty registered, and how many live processes hold it.
sid_on() { # <tty>
  local pid
  pid=$(ps -t "${1#/dev/}" -o pid=,command= 2>/dev/null | awk '/--setting-sources project/ { print $1; exit }')
  [ -n "$pid" ] && jq -r '.sessionId // empty' "$HOSTDIR/sessions/$pid.json" 2>/dev/null
}
live_rows() { # <session id>: the registry's live entries for it, and the name of the last
  local f pid rows=0 name=""
  for f in "$HOSTDIR"/sessions/*.json; do
    [ "$(jq -r '.sessionId // empty' "$f" 2>/dev/null)" = "$1" ] || continue
    pid=$(basename "$f" .json)
    kill -0 "$pid" 2>/dev/null || continue
    rows=$((rows + 1)); name=$(jq -r '.name // empty' "$f")
  done
  printf '%s %s' "$rows" "$name"
}
TRANSCRIPTS="$HOSTDIR/projects/$(printf '%s' "$WORKDIR" | sed 's/[^A-Za-z0-9]/-/g')"
lines_of() { wc -l < "$TRANSCRIPTS/$1.jsonl" 2>/dev/null | tr -d ' '; }
home_tty() { tmux -L "$1" display -p -t home:0 '#{pane_tty}' 2>/dev/null; }
wait_host() { # <tty> <seconds>: a host comes up on the tty
  local i=0
  while [ $i -lt $(($2 * 2)) ]; do
    [ "$(hosts_on "$1")" -gt 0 ] && return 0
    sleep 0.5; i=$((i + 1))
  done
  return 1
}
# The proof a resumed session holds its earlier exchange: an answer only that exchange gives,
# the words of its first reply in reverse order, which no prompt of the run spells.
recall() { printf 'Take the words of the reply you gave to my first message, put them in reverse order, and reply with them joined by hyphens, in lower case, and nothing else. Do not use any tool.'; }

# A session the operator made by hand, unmarked: where the coordinator's tab and a tab that
# runs an orchestrator not yet at home stand in this run.
tm new-session -d -s plain -n coord -c "$WORKDIR" '/bin/bash --noprofile --norc'
COORD_TTY=$(tm display -p -t plain:0 '#{pane_tty}')

echo "== the move: a session moves into a home server of its own, the same conversation resumed in window 0 =="
printf '#!/bin/sh\nexec %q --setting-sources project --settings %q --model %q --permission-mode acceptEdits --name %q %q\n' \
  "$REAL_HOST" '{"remoteControlAtStartup":false}' "$MODEL" "Agent : e2e conv" "$(prompt E2E-CONV-READY)" > "$SANDBOX/run/conv.sh"
tm new-window -d -t plain: -n conv -c "$WORKDIR" "/bin/sh $SANDBOX/run/conv.sh"
CONV_TTY=$(tm display -p -t plain:conv '#{pane_tty}')
banner_or_exit plain:conv
if wait_reply plain:conv E2E-CONV-READY 90; then CONV_REPLIED=1; else CONV_REPLIED=0; fi
check "the session to move replied within 90s" "1" "$CONV_REPLIED"
CSID=$(sid_on "$CONV_TTY"); CHOME="orch-$(printf '%s' "$CSID" | tr -cd '0-9A-Za-z' | cut -c1-8)"
HOMES+=("$CHOME")
CLINES=$(lines_of "$CSID")
LT=plain:0; LENV=(ORCHESTRATOR_HOME_NO_TAB=1 ORCHESTRATOR_TEST_RUN=1 "ORCHESTRATOR_HOST_CLI=$REAL_HOST")
launcher 30 home --session "$CSID" --name "Orch : e2e conv" --prompt "$(recall)"
check "the move starts the home server named after the session, window 0 named after the orchestrator, the mark set by the conf" \
  "0|moved: $CHOME (no tab: attach with tmux -L $CHOME attach)|Orch : e2e conv|1" \
  "$(rc)|$(out)|$(tmux -L "$CHOME" display -p -t home:0 '#{window_name}' 2>/dev/null)|$(tmux -L "$CHOME" show -qv -t home @orchestrator-home 2>/dev/null)"
check "the session still runs in its old place until it ends there" "1" "$(hosts_on "$CONV_TTY")"
# The module ends the session through its own exit; the host's own command is that exit here.
tm send-keys -t plain:conv '/exit' Enter
CHOME_TTY=$(home_tty "$CHOME")
if wait_host "$CHOME_TTY" 150; then CUP=1; else CUP=0; fi
check "the old process ended and window 0 resumed the session" "0|1" "$(hosts_on "$CONV_TTY")|$CUP"
CLINE=$(ps -t "${CHOME_TTY#/dev/}" -o command= 2>/dev/null | grep -- '--setting-sources project' | head -1)
check "window 0 replays the launch: its settings, model and mode, the session resumed under the orchestrator's name" "1|1|1|1|1" \
  "$(printf '%s' "$CLINE" | grep -c -- '--setting-sources project')|$(printf '%s' "$CLINE" | grep -c -- "--model $MODEL")|$(printf '%s' "$CLINE" | grep -c -- '--permission-mode acceptEdits')|$(printf '%s' "$CLINE" | grep -c -- "--resume $CSID")|$(printf '%s' "$CLINE" | grep -c -- '--name Orch : e2e conv$')"
resumed_or_exit "$CHOME::home:0"
if wait_reply "$CHOME::home:0" ready-conv-e2e 120; then CRECALL=1; else CRECALL=0; fi
audit_rc
check "the resumed session answers from its earlier exchange" "1" "$CRECALL"
check "one live session holds the id, under the orchestrator's name, and its transcript went on" "1 Orch : e2e conv|$CSID|1" \
  "$(live_rows "$CSID")|$(sid_on "$CHOME_TTY")|$([ "$(lines_of "$CSID")" -gt "${CLINES:-0}" ] && echo 1 || echo 0)"

echo "== open, pause and wake, from the coordinator's own place =="
jq -n --arg tty "$COORD_TTY" '{tty: $tty, name: "Coord : e2e"}' > "$STATE/coordinator.json"
LENV=(ORCHESTRATOR_HOME_NO_TAB=1 ORCHESTRATOR_TEST_RUN=1)
launcher 120 spawn --open --dir "$WORKDIR" --tier light --permission-mode acceptEdits --title "Orch : e2e open" \
  --prompt "$(prompt E2E-OPEN-READY)"
OPEN_TTY=$(out | tail -1)
OHOME=$(sed -n 's/^spawn: home server \([^ ,]*\),.*/\1/p' "$STEP.err" | head -1)
[ -n "$OHOME" ] && HOMES+=("$OHOME")
OSID=$(sid_on "$OPEN_TTY")
check "an open starts the orchestrator in window 0 of a home server named after its session" \
  "0|orch-$(printf '%s' "$OSID" | tr -cd '0-9A-Za-z' | cut -c1-8)|$OPEN_TTY|Orch : e2e open|1" \
  "$(rc)|$OHOME|$(home_tty "$OHOME")|$(tmux -L "$OHOME" display -p -t home:0 '#{window_name}' 2>/dev/null)|$(tmux -L "$OHOME" show -qv -t home @orchestrator-home 2>/dev/null)"
banner_or_exit "$OHOME::home:0"
if wait_reply "$OHOME::home:0" E2E-OPEN-READY 90; then OREPLIED=1; else OREPLIED=0; fi
audit_rc
check "the opened orchestrator replied within 90s" "1" "$OREPLIED"
OLINES=$(lines_of "$OSID")
# The pause ends the whole server; the tab's close around it is the suite's, over a recorder.
PAUSED=$(ORCHESTRATOR_STATE_DIR="$STATE" python3 -c "
import sys; sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
sid, ttys = ia.end_home(sys.argv[2], 'pause')
print(sid, len(ttys))" "$ROOT/skills/iterm-agents/scripts" "$OHOME" 2>&1)
check "the pause ends the server, names the session window 0 ran, and leaves no host and no server on ps" "$OSID 1|0|0|1" \
  "$PAUSED|$(hosts_on "$OPEN_TTY")|$(pgrep -f -- "-L $OHOME" | grep -c .)|$(tmux -L "$OHOME" has-session 2>/dev/null && echo 0 || echo 1)"
printf 'b\n' > "$SANDBOX/run/brief.md"
ORCHESTRATOR_STATE_DIR="$STATE" bash "$ROOT/skills/coordinator/scripts/coordinator.sh" sleep --name "Orch : e2e open" \
  --brief "$SANDBOX/run/brief.md" --dir "$WORKDIR" --model "$MODEL" --session "$OSID" >/dev/null 2>&1
check "the sleeping record keeps the session" "1" \
  "$(ORCHESTRATOR_STATE_DIR="$STATE" bash "$ROOT/skills/coordinator/scripts/coordinator.sh" sleeping 2>/dev/null | grep -c "session $OSID\$")"
launcher 120 spawn --wake --dir "$WORKDIR" --title "Orch : e2e open" --model "$MODEL" --permission-mode acceptEdits \
  --resume "$OSID" --prompt "$(recall)"
WAKE_TTY=$(out | tail -1)
check "the wake resumes the recorded session in window 0 of a new home server" "0|$WAKE_TTY|1" \
  "$(rc)|$(home_tty "$OHOME")|$(ps -t "${WAKE_TTY#/dev/}" -o command= 2>/dev/null | grep -c -- "--resume $OSID")"
resumed_or_exit "$OHOME::home:0"
if wait_reply "$OHOME::home:0" ready-open-e2e 120; then ORECALL=1; else ORECALL=0; fi
audit_rc
check "the woken orchestrator answers from its earlier exchange, one live session under its name, its transcript gone on" \
  "1|1 Orch : e2e open|1" \
  "$ORECALL|$(live_rows "$OSID")|$([ "$(lines_of "$OSID")" -gt "${OLINES:-0}" ] && echo 1 || echo 0)"
LENV=()

echo "== the successor: a window of the same session, then window 0 =="
tm rename-window -t home:0 "Orch : e2e lead"
LT=home:0
launcher 120 spawn --successor --dir "$WORKDIR" --tier light --permission-mode acceptEdits --title "Orch : e2e lead" \
  --no-remote-control --prompt "$(prompt E2E-HEIR-READY)"
HEIR=$(out | tail -1)
HEIR_PANE=$(tm list-panes -s -t home -F '#{pane_tty} #{pane_id}' | awk -v t="$HEIR" '$1 == t { print $2 }')
HEIR_WIN=$(tm list-panes -s -t home -F '#{pane_tty} #{window_id}' | awk -v t="$HEIR" '$1 == t { print $2 }')
check "the successor is a window of the same session, under the caller's name" "0|1|1" \
  "$(rc)|$([ -n "$HEIR_PANE" ] && echo 1 || echo 0)|$(windows | grep -c " $HEIR_WIN Orch : e2e lead ")"
[ -n "$HEIR_PANE" ] && banner_or_exit "$HEIR_PANE"
check "the chain is handed over keyed on the successor's pane" "tmux:$SOCKET:$W3 $THREE tmux:$SOCKET:$HEIR_PANE|0" \
  "$(jq -r '"\(.tab_id) \(.tty) \(.owner)"' "$STATE/chains/${HEIR#/dev/}.jsonl" 2>/dev/null | paste -sd'|' -)|$(chain | grep -c .)"
W0=$(tm display -p -t home:0 '#{window_id}')
# The takeover runs in the successor's own window: a shell beside it there stands in for it.
SHELL_PANE=$(tm split-window -d -P -F '#{pane_id}' -t "$HEIR_WIN" -c "$WORKDIR" '/bin/bash --noprofile --norc')
LT="$SHELL_PANE"
launcher 30 takeover --tty "$OWN_TTY" --expect-title "Orch : e2e lead"
check "the takeover kills window 0 and gives the successor index 0, the operator's view with it" \
  "0|took window 0: the predecessor's window $W0 on $OWN_TTY was closed|0 $HEIR_WIN Orch : e2e lead 1|0" \
  "$(rc)|$(out)|$(windows | awk '$1 == 0')|$(windows | grep -c " $W0 ")"
if wait_reply "$HEIR_PANE" E2E-HEIR-READY 90; then HREPLIED=1; else HREPLIED=0; fi
audit_rc
check "the successor replied within 90s, and the chain still holds the agent under it" "1|tmux:$SOCKET:$W3 $THREE" \
  "$HREPLIED|$(jq -r '"\(.tab_id) \(.tty)"' "$STATE/chains/${HEIR#/dev/}.jsonl" 2>/dev/null | paste -sd'|' -)"

audit_rc
check "no test host came up in Remote Control: each command line carries remoteControlAtStartup=false and none carries --remote-control" "0|ok" \
  "$([ "$RC_SEEN" -ge 6 ] && echo 0 || echo "seen only $RC_SEEN")|$([ ${#RC_BAD[@]} -eq 0 ] && echo ok || printf '%s; ' "${RC_BAD[@]}")"

echo "== the end =="
tm kill-server 2>/dev/null
for h in ${HOMES[@]+"${HOMES[@]}"}; do tmux -L "$h" kill-server 2>/dev/null; done
sleep 2
check "killing the servers ends every session they held" "0|0|0|0" \
  "$(hosts_on "$THREE")|$(hosts_on "$HEIR")|$(hosts_on "$CHOME_TTY")|$(hosts_on "$WAKE_TTY")"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
