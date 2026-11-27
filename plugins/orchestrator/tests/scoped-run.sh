#!/bin/bash
# Test suite. No network, no terminal automation, isolated HOME per case.
#
# Requires bash, git, jq, python3 and node (the deck's usage rule runs under node, through
# the module's own transcript reader).
#
# Each case runs a script against a temporary state directory or a temporary
# HOME and compares its output or its side effects with an expected value.

set -u

# Every sort and comparison of the suite reads bytes, whatever the runner's locale: a UTF-8
# collation of English puts `forbidden2.md` before `forbidden.md`. The character type is kept,
# so text in « » and ⏎ reads as it does under the runner's own.
if [ -n "${LC_ALL:-}" ]; then export LC_CTYPE="$LC_ALL"; unset LC_ALL; fi
export LC_COLLATE=C

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ORCH_REFS="$ROOT/skills/orchestrator/references"
# Read by the cases of the rule-owner checks, long before the record's own section.
REC="$ROOT/skills/orchestrator/scripts/dispatch-record.sh"
# macOS sets TMPDIR with a trailing slash: every path built on it would carry a double slash
# the scripts under test collapse, and no expected line would match what they print.
TMPDIR="${TMPDIR:-/tmp}"
export TMPDIR="${TMPDIR%/}"
# Explicitly inside TMPDIR: the platform default lands in a directory a sandboxed
# shell may not write to, and the suite then runs with an empty path where it thinks
# it has a directory.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-XXXXXX")
[ -d "${WORK}" ] || { echo "cannot create a working directory under ${TMPDIR:-/tmp}" >&2; exit 1; }
# The suite's own tmux servers are killed where they are used; their socket files are not,
# and one pair a run piled up in the operator's tmux directory.
SUITE_SOCKETS="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)"
suite_exit() { rm -rf "$WORK" ${SHORTTMP:+"$SHORTTMP"}; rm -f "$SUITE_SOCKETS/suite-home-$$" "$SUITE_SOCKETS/suite-conf-$$"; }
trap suite_exit EXIT

pass=0
fail=0
# The names of the failed cases, said again after the count: a long run's failures are read at its end.
failed=''

# The launcher refuses a directory the host has never opened, in a dry run as much as in a
# real one: "what would happen" includes being refused. The suite declares the precondition
# once, in a file of its own, so no test ever reads or writes the operator's configuration.
# The host CLI the suite reads the process table for, PINNED. It is read from the
# environment, and an operator's own shell carries it as an absolute path: the same suite
# was matching two different names on his machine and on a clean one, and only one of them
# matched the tables the suite itself writes. A test must not read differently depending on
# who runs it.
export ORCHESTRATOR_HOST_CLI=claude

# The dispatch record registers itself under the host's session id when it has one. A suite
# run from inside a session must not write into that operator's own state directory. Nor
# may a run from inside tmux change the chain owner the launcher reads (TMUX, TMUX_PANE).
unset CLAUDE_CODE_SESSION_ID TMUX TMUX_PANE

# The role a launched session carries is read by the hooks and the launcher from its
# environment: the launcher exports it in every launch, and a session started from one inherits
# it. A suite run from inside an auditor, an agent or a spawned orchestrator must read none of
# it; a case that needs a role sets it on its own command. `--role-probe` prints the names of
# the role variables the suite still sees at its start, none when it cleared them all.
ROLE_VARS='ORCHESTRATOR_SPAWNED ORCHESTRATOR_AUDITOR ORCHESTRATOR_REPORTS_TO ORCHESTRATOR_BRIEF ORCHESTRATOR_TIER ORCHESTRATOR_CONTEXT_GATE ORCHESTRATOR_CONTEXT_GATE_TOKENS ORCHESTRATOR_SELF_ID ORCHESTRATOR_NEW_SESSION_ID'
# shellcheck disable=SC2086
unset $ROLE_VARS
if [ "${1:-}" = --role-probe ]; then
  for v in $ROLE_VARS; do [ -z "${!v+x}" ] || echo "$v"; done
  exit 0
fi

# A launch reads a session's model and effort on its transcript. Every transcript the suite
# reads is its own: the host's projects directory is never read. `pair_transcript <session>
# <model> <effort>` writes one whose main thread ran on that pair (no effort field when the
# effort is empty), followed by a compaction request on another pair, which is not the
# main thread's and must never be read as it.
export ORCHESTRATOR_PROJECTS_DIR="$WORK/projects"
# The dispatch record, the CI watch and the succession check write the audit trail into the
# orchestrator's journal under the configuration directory: every run of the suite wrote the
# operator's own. Its journal is the suite's.
export ORCHESTRATOR_JOURNAL_DIR="$WORK/journal"
pair_transcript() {
  local config='' ; [ -n "$3" ] && config=",\"output_config\":{\"effort\":\"$3\"}"
  mkdir -p "$ORCHESTRATOR_PROJECTS_DIR/p"
  printf '{"type":"api-request","sessionId":"%s","querySource":"repl_main_thread","params":{"model":"%s"%s}}\n' "$1" "$2" "$config" \
    > "$ORCHESTRATOR_PROJECTS_DIR/p/$1.jsonl"
  printf '%s\n' '{"type":"api-request","querySource":"compact","params":{"model":"x-small","output_config":{"effort":"low"}}}' \
    >> "$ORCHESTRATOR_PROJECTS_DIR/p/$1.jsonl"
}
# A succession through a helper that names no session runs on the suite's own session, whose
# main thread ran on s-model at high.
pair_transcript s-suite s-model high
# An agent's pair is its orchestrator's to name: an agent spawned with neither a tier nor a
# model is refused. The cases below test something else, so a spawn of theirs that names no
# pair, and is none of the launches whose pair is not a tier's, runs on the light tier.
needs_tier() {
  case " $* " in
    *" --successor "*|*" --auditor "*|*" --coordinator-successor "*|*" --wake "*|*" --open "*) ;;
    *" --tier "*|*" --tier="*|*" --model "*|*" --model="*|*" --inherit-model "*) ;;
    *) printf -- '--tier light' ;;
  esac
}

export ORCHESTRATOR_TRUST_FILE="$WORK/suite-trust.json"
"$(command -v python3 || echo python3)" -c "
import json,os,sys
json.dump({'projects': {os.path.realpath(sys.argv[1]): {'hasTrustDialogAccepted': True}}},
          open(sys.argv[2], 'w'))" "$WORK" "$ORCHESTRATOR_TRUST_FILE"

# check <name> <expected> <actual>
# The lines read, joined by ⏎ with no trailing one. GNU tr maps bytes, and ⏎ is three: it
# cannot be a tr target under any locale.
nl_join() { awk 'NR > 1 { printf "\342\217\216" } { printf "%s", $0 }'; }

check() {
  if [ "$2" = "$3" ]; then
    printf '  ok   %s\n' "$1"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n' "$1"
    printf '       expected: %s\n' "$(printf '%s' "$2" | nl_join)"
    printf '       actual:   %s\n' "$(printf '%s' "$3" | nl_join)"
    fail=$((fail + 1))
    failed="$failed  FAIL $1"$'\n'
  fi
}

# A file's permission bits in octal: GNU stat first, since its -f reads the filesystem and
# answers, then BSD's.
perm_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%OLp' "$1"; }

# Root reads and writes through any permission: a case built on a file its runner may not read
# or a directory it may not write means nothing under root, and is skipped with the reason said.
# `skip_as_root <name> || check <name> …`
skipped=0
skip_case() {  # <name> <reason>: the case is not run here, and the run says why
  printf '  skip %s (%s)\n' "$1" "$2"
  skipped=$((skipped + 1))
}
skip_as_root() {
  [ "$(id -u)" = 0 ] || return 1
  skip_case "$1" "as root, permissions do not bind"
}

# check_status <name> <expected-exit-code> <command...>
check_status() {
  local name="$1" expected="$2"
  shift 2
  "$@" >/dev/null 2>&1
  local code=$?
  check "$name" "exit $expected" "exit $code"
}

# Read as presence, not as a count: a document may spell a literal on one line or on five,
# and a guard that pins the number breaks on a sentence that was merely rewritten.
spells() { grep -qF -- "$2" "$1" && echo yes || echo no; }
carries() { grep -qiF "$2" "$1" && echo yes || echo no; }

# Defined here, outside every part, because a section of a later part reads them: its helpers,
# the paths it names and the fixtures it builds from them.
# plugin did not open, the predecessor is asked to end its own session through the module.
# That end is proved on the tty, never on `list`, which keeps the row of a tab left holding a
# shell.
SUCC="$ROOT/templates/orchestrator-succession-brief.md"
SUCC4=$(awk '/^4\. /{f=1} /^5\. /{f=0} f' "$SUCC" | tr '\n' ' ' | tr -s ' ')
SUCC3=$(awk '/^3\. /{f=1} /^4\. /{f=0} f' "$SUCC" | tr '\n' ' ' | tr -s ' ')
succ3_has() { printf '%s' "$SUCC3" | grep -oF -- "$1" | wc -l | tr -d ' '; }
succ4_has() { printf '%s' "$SUCC4" | grep -oF -- "$1" | wc -l | tr -d ' '; }
# used to mean « immediately right of my tab », which put every new agent BETWEEN the
# orchestrator and the previous one. The chain file names the last agent; `self` resolves
# to it. A dry run reads the chain and never writes it: there is no tab to record.
AGENT="$ROOT/skills/iterm-agents/scripts/iterm-agent.sh"
# The hand-over itself, on the module: the predecessor's own entries move under the
# successor's tty and owner, its foreign entries stay, and a stale file on the successor's
# recycled tty is replaced, not appended to. Nothing to hand over hands over an empty chain.
py=$(command -v python3 || echo python3)
transfer() { ORCHESTRATOR_STATE_DIR="$WORK/istate" "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
print(m.chain_transfer('/dev/ttys900', 'S-ME', '/dev/ttys950', 'S-NEW'))" 2>&1; }
append() { ORCHESTRATOR_STATE_DIR="$WORK/istate" "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
m.chain_append('/dev/ttys900', sys.argv[1], sys.argv[2], 'S-ME', resident=sys.argv[3] == 'yes')
print('|'.join(str(m.is_resident(e)) for e in m.chain_read('/dev/ttys900')))" "$@" 2>&1; }
# A commit made through an empty `-C` path would land in the repository the suite runs from.
gc() { [ "${1:-}" = -C ] && [ -z "${2:-}" ] && return 1; git -c user.email=t@local -c user.name=t "$@"; }
exists() { [ -e "$1" ] && echo 1 || echo 0; }
# A process whose working directory is a given directory, until `release`.
LIVE=""
hold() {
  ( cd "$1" && exec sleep 60 ) & LIVE="$LIVE $!"
  local i=0 want; want=$(rp "$1")
  while [ $i -lt 50 ]; do
    lsof -a -p "${LIVE##* }" -d cwd -Fn 2>/dev/null | grep -qxF "n$want" && return 0
    sleep 0.1; i=$((i + 1))
  done
}
release() { local p; for p in $LIVE; do kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; done; LIVE=""; }
# checked the file: a path built from a host variable the agent's shell does not set, and
# a second session reference sitting beside the real one. Both are mechanical; both are
# caught here, before the dispatch rather than after the round.
LINT="$ROOT/skills/orchestrator/scripts/brief-lint.sh"
B="$WORK/briefs"; mkdir -p "$B"
ok_brief() {  # a brief with nothing wrong in it
  cat > "$1" <<BRIEF
# scratch — Phase 1: thing

You are the implementer for this phase.

## 1. Required reading

1. Spec: \`$WORK/briefs\`

## 3. Scope

Non-goals:

- Nothing outside this list.
- If you believe something outside this list is needed, STOP and ask the orchestrator first.

## 6. Communication

- Your orchestrator is the session **\`project-70 [a1b2c3]\`** and no other session.
- Every report ends with your measured context, from the hooks module's measure file.
BRIEF
}
ok_brief "$B/good.md"
ok_brief "$B/placeholder.md"; printf 'Branch: {{BRANCH}}\n' >> "$B/placeholder.md"
ISTATE="$WORK/istate"
shaped() {
  case " $* " in
    *" --prompt "*|*" --prompt-file "*) set -- "$@" ;;
    *) set -- --prompt p "$@" ;;
  esac
  CLAUDE_CODE_SESSION_ID="${CLAUDE_CODE_SESSION_ID-s-suite}" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" $(needs_tier "$@") "$@" 2>&1
}
# and run dry through the launcher, and the successor's brief, filled, lints clean — and that
# the irreversible acts stay guarded: a merge is never the coordinator's, and a tab is closed
# only by title, the predecessor's, before the successor registers.
COORDSKILL="$ROOT/skills/coordination/SKILL.md"
COORDREF="$ROOT/skills/coordination/references/orchestrators.md"
COORDCMD="$ROOT/commands/coordinator.md"
COORDEND="$ROOT/commands/coordinator-end.md"
COORDTPL="$ROOT/templates/coordinator-succession-brief.md"
# handshake stays in each succession template, and the copies may not drift apart. The auditor's
# and the coordinator's step 3 are one text, read with their line breaks folded; the
# orchestrator's, longer, carries the same core.
handshake() { sed -n '/^3\. \*\*Take over\.\*\*/,/nothing in flight\./p' "$1" | tr '\n' ' ' | tr -s ' '; }
UNTRUSTED="$WORK/untrusted"; mkdir -p "$UNTRUSTED"
# to a stranger's tab must not make that tab movable. The owner is the session sitting on
# the caller's tty RIGHT NOW, read from the app; the match is on the TAB id. The dry run
# has no app and keeps ORCHESTRATOR_SELF_ID and the tty, which is what its checks seed.
MSTUB='
import asyncio, sys
sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
class S:
    def __init__(s, sid, tty): s.session_id=sid; s.tty=tty
    async def async_get_variable(s, k): return {"tty": s.tty}.get(k)
class T:
    def __init__(s, tid, sess): s.tab_id=tid; s.sessions=[sess]; s.all_sessions=[sess]
class W:
    def __init__(s, tabs): s.window_id="w"; s.tabs=tabs
class App:
    def __init__(s, wins): s.windows=wins
app=App([W([T("1",S("S-LIVE","/dev/ttys801")), T("2",S("S-AGENT","/dev/ttys802"))])])
'
# --pid narrows verify to one process, and counts EVERY host CLI on the tty: a session that
# runs a nested host CLI shows two, and the recorded one is not always the first.
printf '/dev/ttys901 5100 a-host --name outer\n/dev/ttys901 5101 a-host --nested\n' > "$WORK/ps-two.txt"
field() { printf '%s\n' "$1" | sed -n "s/^$2://p"; }

# The suite runs in four parts that CI runs in parallel. SUITE_SHARD=<1-4> runs the
# sections of that part and nothing else; unset, the whole suite runs. Each section sits in exactly one
# part, between its `if shard_has` and its `fi`. What a section of a later part reads from an earlier
# one (a helper, a path, a fixture) is defined above, outside every part.
case "${SUITE_SHARD:-1}" in 1|2|3|4) ;; *) echo "SUITE_SHARD is 1, 2, 3 or 4, not ${SUITE_SHARD}" >&2; exit 1 ;; esac
shard_has() { [ -z "${SUITE_SHARD:-}" ] || [ "$SUITE_SHARD" = "$1" ]; }
echo "== iterm-agents: every spawn form's dry run, byte for byte =="
# The launcher's terminal operations sit behind one object, so a second terminal can stand
# beside the iTerm one. That is a conversion: nothing the operator or an orchestrator reads
# may change. The golden file was recorded from the launcher before the move; the script
# prints every spawn form (and the close, rotate and move dry runs) with its lines, its
# refusals and its exit codes, and the two must stay identical.
DRYGOLD="$ROOT/tests/fixtures/spawn-dry-run.golden"
DRYNOW="$WORK/spawn-dry-run.now"
bash "$ROOT/tests/fixtures/spawn-dry-run.sh" > "$DRYNOW" 2>&1
check "the dry run of every spawn form is byte-identical to the recorded one" "same" \
  "$(cmp -s "$DRYGOLD" "$DRYNOW" && echo same || diff "$DRYGOLD" "$DRYNOW" | head -5)"
# The host compacts where the operator's settings say, and no launch sets it for any role:
# a compaction window passed by the launcher put sessions under or past their gate three
# times. Neither the recorded dry run, nor this run's, nor any launcher script names the
# host's compaction key. The name is split here so this line is not its own finding.
COMPACT_KEY="AUTO_COMPACT""_WINDOW"
check "no launch sets a compaction window: the recorded dry run, this run's and the scripts" "0|0|" \
  "$(grep -c -F "$COMPACT_KEY" "$DRYGOLD")|$(grep -c -F "$COMPACT_KEY" "$DRYNOW")|$(cd "$ROOT" && git grep -n -F "$COMPACT_KEY" -- 'skills/*/scripts/*' 'hooks/*.ts' 2>/dev/null)"
check "and the recording covers the forms: successor, auditor, coordinator, wake, open, chain, close, rotate, move" "1|1|1|1|1|1|1|1|1" \
  "$(for h in '### successor, derived name' '### auditor$' '### coordinator successor' '### wake' '### open$' '### agent, right of self, chain of two' '### close$' '### rotate$' '### move, leftmost'; do grep -c -- "$h" "$DRYGOLD"; done | paste -sd'|' -)"

echo "== iterm-agents spawn (dry run) =="
# The prompt is never typed into the shell: a 3 000-character prompt with non-ASCII
# bytes, quotes and a backslash goes to a file byte for byte, the typed command stays
# short and reads that file, and none of it depends on the locale — the first launch
# with an inline prompt was truncated by AppleScript and never ran, and a `sed`
# under LC_ALL=C died on an em dash.
AGENT="$ROOT/skills/iterm-agents/scripts/iterm-agent.sh"
long=$(printf 'x%.0s' $(seq 1 3000))
prompt="Read « this » — é \"quoted\" back\\slash $long"
out=$(LC_ALL=C ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --tier light --dir "$WORK" --title "Agent: B-1 — é" --prompt "$prompt" 2>&1)
code=$?
check "dry-run spawn under LC_ALL=C exits 0" "0" "$code"
cmd=${out#*launch=}; cmd=${cmd%%$'\n'*}
file=${out#*prompt_file=}; file=${file%%$'\n'*}
# The bound measures the typed command without the two temporary paths it names, the working
# directory (`cd <dir> && `) and the state directory of the prompt file: both live under
# mktemp's directory, whose length depends on TMPDIR (about 40 characters longer on macOS).
typed=${cmd#cd $WORK && }; typed=${typed//$ISTATE/}
check "the launch stays short whatever the prompt" "short" "$([ "${#typed}" -lt 1000 ] && echo short || echo "${#typed} chars typed")"
check "the launch reads the prompt from its file" "1" "$(printf '%s' "$cmd" | grep -c '"\$(cat ')"
# The dry run names the file and writes none; the writer is driven directly for the bytes.
check "the prompt file holds the prompt byte for byte" "$prompt" \
  "$(LC_ALL=C ORCHESTRATOR_STATE_DIR="$ISTATE" "$(command -v python3)" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
print(open(ia.write_prompt_file(sys.argv[1], sys.argv[2]), encoding='utf-8').read(), end='')" "$prompt" "Agent: B-1 — é")"
check "the prompt file lives under the state directory" "yes" "$([ "${file#"$ISTATE"/prompts/}" != "$file" ] && echo yes || echo "$file")"
# §45: the prompt file carries its kind in its name, so the three files a launch leaves
# under prompts/ sort by kind like the two already did.
check "the prompt file's name carries its kind" "1" "$(basename "$file" | grep -c '^prompt-')"
check "the launch carries the decision mode" "1" "$(printf '%s' "$cmd" | grep -c -- '--permission-mode auto')"
check "no tier and no map: no model argument" "0" "$(printf '%s' "$cmd" | grep -c -- '--model')"
check "the launch changes into the working directory" "1" "$(printf '%s' "$cmd" | grep -c "^cd $WORK && ")"
# Every spawn marks the session as launcher-spawned: the kill guard is active only
# where this is set, and the operator's own sessions never carry it (phase 3 ruling 5).
check "the launch marks the session launcher-spawned" "1" "$(printf '%s' "$out" | grep -c 'export ORCHESTRATOR_SPAWNED=1')"
# Row 451: a plain tab opens in an app that may have been started from a session, so it carries
# that session's id and nesting marks, and a coordinator's successor launched there wrote no
# transcript. The launch file, run as the tab runs it, leaves none of them and keeps the account's
# and the operator's own configuration under the same prefix.
# The probe's Python is set apart from the command substitution: bash 3.2 (the system bash on
# macOS) mis-parses the dict literal and the escaped quotes inside `$(...)` within double quotes.
NEST_PY="
import subprocess, sys
sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
script = ia.write_launch_script(\"env | grep '^CLAUDE' | sort | paste -sd'|' -\", 'Agent: nesting')
env = {'PATH': '$PATH', 'CLAUDEX': '1', 'CLAUDE_CONFIG_DIR': '/acct', 'CLAUDE_CODE_USE_BEDROCK': '1'}
for name in 'CLAUDECODE CLAUDE_PID CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_CHILD_NOTES_DIR CLAUDE_CODE_BRIDGE_SESSION_ID CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_SESSION_ATTENDED'.split():
    env[name] = '1'
print(subprocess.run(['/bin/sh', script], env=env, capture_output=True, text=True).stdout.strip())"
check "the launch file leaves the tab without the caller's session identity and nesting marks, and keeps the account and the operator's configuration" \
  "CLAUDEX=1|CLAUDE_CODE_USE_BEDROCK=1|CLAUDE_CONFIG_DIR=/acct" \
  "$(ORCHESTRATOR_STATE_DIR="$ISTATE" "$(command -v python3)" -c "$NEST_PY")"
# Named absolutely even though the tab now runs a login shell: a dotfile that breaks PATH
# must not be able to kill the launch, and the session dies before its tty can be read
# when the name does not resolve.
check "the launch execs the CLI by absolute path" "1" "$(printf '%s' "$cmd" | grep -cE 'exec /[^ ]+/')"
# The tab runs the launch through a LOGIN shell, so the session inherits the operator's
# PATH — the package manager's binaries included — rather than the app's bare default.
# Observed: no spawned session could run `gh`, so none could open a pull request. The CLI
# is still named absolutely inside the launch: finding the program must not depend on the
# operator's dotfiles, only the session's environment does.
check "the tab runs the launch through a login shell" "1" "$(printf '%s' "$out" | grep -c '^program=.* -l <launch-file>$')"
check "the login shell is the operator's" "1" "$(env ORCHESTRATOR_LOGIN_SHELL=/bin/bash ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --tier light --dir "$WORK" --title "Agent: shell" --prompt p 2>&1 | grep -c '^program=/bin/bash -l ')"
check "the launch text itself is unchanged by the shell" "1" "$(env ORCHESTRATOR_LOGIN_SHELL=/bin/bash ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --tier light --dir "$WORK" --title "Agent: shell" --prompt p 2>&1 | sed -n 's/^launch=//p' | grep -cE '^cd .* && .* && exec /[^ ]+/')"

# The title is the session's NAME, not a tab label the shell overwrites: two sessions in one
# checkout otherwise share the host's stem and differ by a reference nobody reads at a
# glance (observed: an implementer listed under its orchestrator's own name). Non-ASCII
# bytes travel like the prompt does — quoted by the shell's own rules.
check "the launch names the session after its title" "1" "$(printf '%s' "$cmd" | grep -c -- "--name 'Agent: B-1 — é'")"
# The title is the operator's format and the launcher holds every spawn to it: a successor
# once came up as `steward-successor` in every listing, because the launcher took whatever
# was typed and the house format was nowhere (§39). The name is SHORT and it has two roles
# (§42): `Orch: <subject>` for an orchestrator and its successor, `Agent: <subject>` for
# anything an orchestrator spawns, the subject at most twenty-five characters — the
# operator read his window and could not tell one agent from another at a glance.
# `--title-free` is the escape for a probe that names its tab otherwise, and the dry run
# says when it is on.
# An orchestrator's launch, read through its one plain door: its successor, spawned by an
# orchestrator caller and without remote control, whose launch line is a plain spawn's.
ORCHVPS="$WORK/ps-orch-vehicle.txt"
printf '/dev/ttys900 claude --name Orch: f\n' > "$ORCHVPS"
orchv() { ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_PS_TABLE="$ORCHVPS" "$@"; }
check "a shaped title names the session" "1" \
  "$(shaped --title 'Agent: x' | sed -n 's/^launch=//p' | grep -c -- "--name 'Agent: x'")"
check "and so does an orchestrator's" "1" \
  "$(orchv shaped --title 'Orch: x' --successor --no-remote-control | sed -n 's/^launch=//p' | grep -c -- "--name 'Orch: x'")"
check "and so does a probe's" "1" \
  "$(shaped --title 'Agent: anchor' | sed -n 's/^launch=//p' | grep -c -- "--name 'Agent: anchor'")"
check "the dry run says which name it passes" "1" "$(shaped --title 'Agent: anchor' | grep -c '^name=Agent: anchor$')"
check "a title typed in the former shape, « Agent : x », names the session the current way" "1|1" \
  "$(shaped --title 'Agent : x' | sed -n 's/^launch=//p' | grep -c -- "--name 'Agent: x'")|$(shaped --title 'Agent : x' | grep -c '^name=Agent: x$')"
check "a title without the shape is refused, and the reason names the shape and the cap" "1|1" \
  "$(shaped --title foo >/dev/null 2>&1; echo $?)|$(shaped --title foo | grep -c 'a title reads "Orch: <subject>" or "Agent: <subject>", the subject at most 25 characters and neither starting nor ending with a space, got .foo.')"
# The older roles are the ones the operator could not read, so they are refused like any
# other unshaped title: the spelled-out role words are gone from the launcher, not merely
# from the documents.
check "an older role is refused too" "1|1" \
  "$(shaped --title 'Implementer : x' >/dev/null 2>&1; echo $?)|$(shaped --title 'Reviewer : 1' >/dev/null 2>&1; echo $?)"
# The cap is on the SUBJECT, which is what a listing shows beside every other name.
D42SUB25=$(printf 'x%.0s' $(seq 1 25))
D42SUB26=$(printf 'x%.0s' $(seq 1 26))
check "a subject of 25 characters is accepted, of 26 refused" "1|1" \
  "$(shaped --title "Agent: $D42SUB25" | sed -n 's/^launch=//p' | grep -c -- "--name 'Agent: $D42SUB25'")|$(shaped --title "Agent: $D42SUB26" >/dev/null 2>&1; echo $?)"
# §45: a subject neither starts nor ends on a space — a listing then shows a name that
# reads as empty, or one the operator cannot tell from its trimmed twin. Spaces inside the
# subject stay allowed, and the cap is unchanged.
check "a subject that is a single space is refused, and the reason names the space rule" "1|1" \
  "$(shaped --title 'Agent:  ' >/dev/null 2>&1; echo $?)|$(shaped --title 'Agent:  ' | grep -c 'neither starting nor ending with a space')"
check "a subject ending on a space is refused" "1|1" \
  "$(shaped --title 'Agent: x ' >/dev/null 2>&1; echo $?)|$(shaped --title 'Agent: x ' | grep -c 'neither starting nor ending with a space')"
check "a subject starting on a space is refused" "1|1" \
  "$(shaped --title 'Agent:  x' >/dev/null 2>&1; echo $?)|$(shaped --title 'Agent:  x' | grep -c 'neither starting nor ending with a space')"
check "a space inside the subject stays allowed" "1" \
  "$(shaped --title 'Agent: x y' | sed -n 's/^launch=//p' | grep -c -- "--name 'Agent: x y'")"
# A name is one line. The shape's end anchor also matches BEFORE a trailing newline in this
# language, so `Agent: x` followed by one passed it — and the guard the older code spent on
# a newline in a derived name was retired with that code, leaving nothing behind it. The
# title is written into the launch and read back out of the process table: a second line
# there is not a name, it is whatever follows one.
D42NL="Agent: x
"
check "a title carrying a trailing newline is refused" "1|1" \
  "$(shaped --title "$D42NL" >/dev/null 2>&1; echo $?)|$(shaped --title "$D42NL" | grep -c 'a title reads')"
check "the old default title is refused too" "1|1" \
  "$(shaped --title agent >/dev/null 2>&1; echo $?)|$(shaped --title agent | grep -c 'a title reads')"
check "no title: refused unless --title-free" "1|1" \
  "$(shaped >/dev/null 2>&1; echo $?)|$(shaped | grep -c "got ''")"
check "--title-free lets an unshaped title through, and says so" "1|1" \
  "$(shaped --title-free --title foo | sed -n 's/^launch=//p' | grep -c -- '--name foo')|$(shaped --title-free --title foo | grep -c '^title_free=yes$')"
check "--title-free with no title keeps the old default" "1" \
  "$(shaped --title-free | sed -n 's/^launch=//p' | grep -c -- '--name agent')"

# A value that starts with a dash reads as an option once past shq's "safe characters"
# gate — `--title-free --title=--evil` emitted `--name --evil` bare, and the host read
# `--evil` as its own option instead of the name's value. The value is force-quoted.
check "a dashed value is quoted, not read as an option" "1" \
  "$(shaped --title-free --title=--evil | sed -n 's/^launch=//p' | grep -c -- "--name '--evil'")"
check "a shaped title still reads as today" "1" \
  "$(shaped --title 'Agent: x' | sed -n 's/^launch=//p' | grep -c -- "--name 'Agent: x'")"

# `%r` renders a title with an apostrophe wrapped in double quotes instead of single ones,
# so the refusal's own literal quoting shifted with what the operator typed. `got '<title>'`
# is now the sentence whatever the title holds.
D5TITLE="it's not shaped"
check "the shape refusal always quotes with single quotes" "1" \
  "$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --tier light --dir "$WORK" --title "$D5TITLE" --prompt p 2>&1 | grep -c "got '$D5TITLE'")"

# An agent's servers are CHOSEN, from a catalogue the operator owns (§42). Every launch
# used to carry the setting that enables all of the project's servers, so a fresh session
# never parked on the host's question about them; measured, that loaded a browser driver
# and a devtools bridge into every agent, about seventy megabytes each, used by none. The
# first answer — the strict flag on every launch, an all-or-nothing flag to put the setting
# back — was measured before it shipped and did not hold either: the setting never governed
# those two processes, and the strict flag drops every server of EVERY scope, so an agent
# under it had neither a documentation server nor a connector whatever its brief needed.
# So the launch is strict AND carries a configuration file written for that session, from
# named definitions the operator keeps in the catalogue with a default set.
CAT="$WORK/mcp-catalogue.json"
printf '{"servers":{"a":{"command":"a-cmd"},"b":{"command":"b-cmd"}},"default":["a"]}\n' > "$CAT"
NOCAT="$WORK/mcp-absent.json"; rm -f "$NOCAT"
mcpd() {
  case " $* " in
    *" --prompt "*|*" --prompt-file "*) set -- "$@" ;;
    *) set -- --prompt p "$@" ;;
  esac
  CLAUDE_CODE_SESSION_ID="${CLAUDE_CODE_SESSION_ID-s-suite}" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MCP_CATALOGUE="$CAT" \
  bash "$AGENT" spawn --dir "$WORK" --title 'Agent: x' $(needs_tier "$@") "$@" 2>&1
}
nocat() {
  case " $* " in
    *" --prompt "*|*" --prompt-file "*) set -- "$@" ;;
    *) set -- --prompt p "$@" ;;
  esac
  CLAUDE_CODE_SESSION_ID="${CLAUDE_CODE_SESSION_ID-s-suite}" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MCP_CATALOGUE="$NOCAT" \
  bash "$AGENT" spawn --dir "$WORK" --title 'Agent: x' $(needs_tier "$@") "$@" 2>&1
}
# The file the launch names is read back, not assumed: the launch line says a path, the
# content says which servers the session will actually load.
# A dry run writes no file, so the definitions a real launch would write are produced by
# the same writer, driven directly with the same catalogue and the same names.
mcp_keys() { ORCHESTRATOR_STATE_DIR="$WORK/mcp-written" ORCHESTRATOR_MCP_CATALOGUE="$CAT" "$py" -c "
import json, sys
sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
cat = ia.read_catalogue()
path = ia.write_mcp_file(ia.select_servers(sys.argv[1:], cat), cat, 'x')
print(','.join(json.load(open(path))['mcpServers'].keys()))" "$@"; }
mcp_file_of() { printf '%s' "$1" | sed -n 's/^mcp_file=//p'; }

check "the default set is loaded, from a file the launch names" "1|1|a|a" \
  "$(mcpd | sed -n 's/^launch=//p' | grep -c -- '--strict-mcp-config')|$(mcpd | sed -n 's/^launch=//p' | grep -c -- '--mcp-config ')|$(mcpd | sed -n 's/^mcp=//p')|$(mcp_keys)"
check "--mcp adds a catalogued server for the agent that needs it" "a,b|a,b" \
  "$(mcpd --mcp b | sed -n 's/^mcp=//p')|$(mcp_keys b)"
check "several names travel comma-separated or as repeated options, each once" "a,b|a,b|a,b|a,b" \
  "$(mcpd --mcp a,b | sed -n 's/^mcp=//p')|$(mcp_keys a,b)|$(mcpd --mcp a --mcp b | sed -n 's/^mcp=//p')|$(mcp_keys a b)"
check "--mcp none loads nothing, and writes no file" "none|none|0" \
  "$(mcpd --mcp none | sed -n 's/^mcp=//p')|$(mcpd --mcp none | sed -n 's/^mcp_file=//p')|$(mcpd --mcp none | sed -n 's/^launch=//p' | grep -c -- '--mcp-config')"
check "--mcp none among others still loads nothing" "none" \
  "$(mcpd --mcp b --mcp none | sed -n 's/^mcp=//p')"
# Asked for nothing, so nothing is needed to give it: `none` needs no catalogue, and says
# nothing on stderr either — that line is for a caller who said nothing at all.
check "--mcp none needs no catalogue, and says nothing" "0|0|none|" \
  "$(nocat --mcp none >/dev/null 2>&1; echo $?)|$(nocat --mcp none | sed -n 's/^launch=//p' | grep -c -- '--mcp-config')|$(nocat --mcp none | sed -n 's/^mcp=//p')|$(nocat --mcp none | grep 'no server catalogue' || true)"
# A name the catalogue does not hold is a typo or a server the operator has not written
# yet; either way the agent would come up without it and nobody would know until it
# reached for a tool. Refused before a tab exists, with the names there are.
check "a name the catalogue does not hold is refused, with the names it does" "1|1" \
  "$(mcpd --mcp c >/dev/null 2>&1; echo $?)|$(mcpd --mcp c | grep -c -- "--mcp 'c' is not in the catalogue $CAT (names: a, b)")"
check "--mcp with no catalogue is refused, and names the installer" "1|1" \
  "$(nocat --mcp b >/dev/null 2>&1; echo $?)|$(nocat --mcp b | grep -c -- "--mcp needs a server catalogue at $NOCAT; the installer creates one")"
# No catalogue and nothing asked is not a refusal: the launch is strict and loads nothing,
# which is what a machine without a catalogue can honestly give. It says so on stderr.
check "no catalogue and no --mcp: strict, no file, and a line on stderr" "1|0|none|1" \
  "$(nocat | sed -n 's/^launch=//p' | grep -c -- '--strict-mcp-config')|$(nocat | sed -n 's/^launch=//p' | grep -c -- '--mcp-config')|$(nocat | sed -n 's/^mcp=//p')|$(nocat | grep -c "^spawn: no server catalogue at $NOCAT: the session loads no server$")"
# A catalogue that does not read as one is not an empty catalogue: reading the two alike
# would send every agent out with no server while the caller believes it named some — the
# same reasoning the tier map's own refusal was written on.
BADCAT="$WORK/mcp-bad.json"; printf '["a","b"]\n' > "$BADCAT"
check "a catalogue that is not one is refused, and the refusal names the shape" "1|1" \
  "$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MCP_CATALOGUE="$BADCAT" bash "$AGENT" spawn --tier light --dir "$WORK" --title 'Agent: x' --prompt p >/dev/null 2>&1; echo $?)|$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MCP_CATALOGUE="$BADCAT" bash "$AGENT" spawn --tier light --dir "$WORK" --title 'Agent: x' --prompt p 2>&1 | grep -c -- "$BADCAT does not read as a server catalogue (a \"servers\" object and a \"default\" list)")"
# A default naming a server the catalogue does not hold is not caught by the shape check
# above (both fields still read as an object and a list): the launch would silently drop
# the unknown name and give the agent a set the operator never wrote. Refused instead, and
# a catalogue whose default names only held servers is unaffected.
BADDEF="$WORK/mcp-bad-default.json"
printf '{"servers":{"a":{"command":"a-cmd"}},"default":["a","zzz"]}\n' > "$BADDEF"
check "a default name absent from servers is refused; one fully held still launches" "1|1|1" \
  "$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MCP_CATALOGUE="$BADDEF" bash "$AGENT" spawn --tier light --dir "$WORK" --mcp a --title 'Agent: x' --prompt p >/dev/null 2>&1; echo $?)|$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MCP_CATALOGUE="$BADDEF" bash "$AGENT" spawn --tier light --dir "$WORK" --mcp a --title 'Agent: x' --prompt p 2>&1 | grep -c -- "the catalogue $BADDEF lists 'zzz' in default but not in servers")|$(mcpd | sed -n 's/^launch=//p' | grep -c -- '--mcp-config ')"
# Every asked name is checked against the catalogue BEFORE `none` short-circuits the
# selection: a typo beside `none` used to select nothing and say nothing, which is how a
# caller who mistyped one name among several would never learn it.
check "typo,none is refused naming typo; a,none still selects nothing" "1|1|none" \
  "$(mcpd --mcp typo,none >/dev/null 2>&1; echo $?)|$(mcpd --mcp typo,none | grep -c -- "--mcp 'typo' is not in the catalogue $CAT (names: a, b)")|$(mcpd --mcp a,none | sed -n 's/^mcp=//p')"
# The host's --mcp-config takes SEVERAL values, so whatever follows it is read as another
# file: the prompt placed there was read as one (« MCP config file not found: <the
# prompt> »). The pair is closed by --permission-mode, which takes exactly one.
check "the server file is followed by the decision mode, never by the prompt" "1|0" \
  "$(mcpd --prompt p | sed -n 's/^launch=//p' | grep -cE -- '--mcp-config [^ ]+ --permission-mode ')|$(mcpd --prompt p | sed -n 's/^launch=//p' | grep -c -- 'enableAllProjectMcpServers')"
check "the setting that enabled every project server is in no launch" "0|0|0" \
  "$(mcpd | sed -n 's/^launch=//p' | grep -c -- 'enableAllProjectMcpServers')|$(mcpd --mcp b | sed -n 's/^launch=//p' | grep -c -- 'enableAllProjectMcpServers')|$(nocat | sed -n 's/^launch=//p' | grep -c -- 'enableAllProjectMcpServers')"
# The file is written under the state directory, beside the prompt file and named like it.
check "the server file lives beside the prompt file, named like it" "yes|yes" \
  "$(f=$(mcp_file_of "$(mcpd)"); [ "${f#"$ISTATE"/prompts/mcp-}" != "$f" ] && echo yes || echo "$f")|$(f=$(mcp_file_of "$(mcpd)"); [ "${f%.json}" != "$f" ] && echo yes || echo "$f")"

# --account-connectors: one CHOSEN spawn loads the account's connectors — the ones sessions
# the operator opens by hand already load, and which --strict-mcp-config (§42) excludes from
# every spawn since it drops every scope but the file the catalogue writes. The flag drops
# strict for that spawn only; the catalogue's chosen servers still travel exactly as before.
# Dropping strict reopens the project's own "enable these MCP servers?" dialog that
# --strict-mcp-config had made moot, so it is pre-answered again, the way every launch
# pre-answered it before the catalogue existed (`enableAllProjectMcpServers`, confirmed
# against the host's own settings shape — `enabledMcpjsonServers` / `disabledMcpjsonServers`
# sit beside it there). Without the flag nothing changes: byte-identical to every other spawn.
check "without the flag, the launch is unchanged: strict, no project-server setting" "1|0" \
  "$(mcpd | sed -n 's/^launch=//p' | grep -c -- '--strict-mcp-config')|$(mcpd | sed -n 's/^launch=//p' | grep -c -- 'enableAllProjectMcpServers')"
check "--account-connectors drops --strict-mcp-config" "0" \
  "$(mcpd --account-connectors | sed -n 's/^launch=//p' | grep -c -- '--strict-mcp-config')"
check "--account-connectors still hands over the chosen servers' file, unchanged" "1|a" \
  "$(mcpd --account-connectors | sed -n 's/^launch=//p' | grep -c -- '--mcp-config ')|$(mcpd --account-connectors | sed -n 's/^mcp=//p')"
check "--account-connectors pre-answers the project's own server dialog" "1" \
  "$(mcpd --account-connectors | sed -n 's/^launch=//p' | grep -Fc -- '"enableAllProjectMcpServers":true')"
# These read the settings with no install record: a role's plugin cuts are checked in the lean section.
check "--account-connectors merges into the one --settings JSON already on the launch" "1" \
  "$(CLAUDE_CONFIG_DIR="$WORK/no-install-record" mcpd --account-connectors | sed -n 's/^launch=//p' | grep -Fc -- "--settings '{\"remoteControlAtStartup\":false,\"enableAllProjectMcpServers\":true,\"syncClaudeAiSkills\":false,\"awaySummaryEnabled\":false,\"env\":{\"CLAUDE_CODE_TOTAL_TOKENS_REMINDER\":\"off\",\"CLAUDE_CODE_SILENT_TURN_REMINDER\":\"0\"}}'")"
check "the dry run says the option is on, and off by default" "1|1" \
  "$(mcpd --account-connectors | grep -c '^account_connectors=yes$')|$(mcpd | grep -c '^account_connectors=no$')"
# No catalogue at all: still drops strict and still pre-answers, and still writes no file —
# the option changes strict and the setting, nothing about server SELECTION.
check "--account-connectors with no catalogue still drops strict and pre-answers" "0|0|1" \
  "$(nocat --account-connectors | sed -n 's/^launch=//p' | grep -c -- '--strict-mcp-config')|$(nocat --account-connectors | sed -n 's/^launch=//p' | grep -c -- '--mcp-config ')|$(nocat --account-connectors | sed -n 's/^launch=//p' | grep -Fc -- '"enableAllProjectMcpServers":true')"

# A successor carries the PREDECESSOR's name, read from the process table, and comes up
# under remote control: the operator drives his orchestrators from the host's remote
# client as well as from the tab, and an agent is driven by its orchestrator alone (§39).
# The table is a file here; a live run reads `ps`.
PSTAB="$WORK/ps-table.txt"
printf '/dev/ttys900 /opt/x/host --name Orch: f --permission-mode auto\n' > "$PSTAB"
PSNONAME="$WORK/ps-noname.txt"
printf '/dev/ttys900 /opt/x/host --permission-mode auto\n' > "$PSNONAME"
succ() {
  local t="$1"; shift
  case " $* " in
    *" --prompt "*|*" --prompt-file "*) set -- "$@" ;;
    *) set -- --prompt p "$@" ;;
  esac
  CLAUDE_CODE_SESSION_ID="${CLAUDE_CODE_SESSION_ID-s-suite}" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_PS_TABLE="$t" bash "$AGENT" spawn --dir "$WORK" $(needs_tier "$@") "$@" 2>&1
}
check "a successor with no title takes the caller's session name" "1" \
  "$(succ "$PSTAB" --successor | sed -n 's/^launch=//p' | grep -c -- "--name 'Orch: f'")"
check "and comes up under remote control, under that name" "1" \
  "$(succ "$PSTAB" --successor | sed -n 's/^launch=//p' | grep -c -- "--remote-control 'Orch: f'")"
check "--no-remote-control drops the flag and keeps the name" "0|1" \
  "$(succ "$PSTAB" --successor --no-remote-control | sed -n 's/^launch=//p' | grep -c -- '--remote-control')|$(succ "$PSTAB" --successor --no-remote-control | sed -n 's/^launch=//p' | grep -c -- "--name 'Orch: f'")"
check "a plain spawn never carries remote control" "0" \
  "$(shaped --title 'Agent: x' | sed -n 's/^launch=//p' | grep -c -- '--remote-control')"
# The host starts remote control for every new session by default (a server-side rollout
# decides when nothing is set). An agent is driven by its orchestrator alone, so it comes
# up with the setting that turns that default off; only a successor carries the flag
# instead, never both.
check "a plain spawn carries the setting off, and no --remote-control" "1|0" \
  "$(CLAUDE_CONFIG_DIR="$WORK/no-install-record" shaped --title 'Agent: x' | sed -n 's/^launch=//p' | grep -Fc -- "--settings '{\"remoteControlAtStartup\":false,\"syncClaudeAiSkills\":false,\"awaySummaryEnabled\":false,\"env\":{\"CLAUDE_CODE_TOTAL_TOKENS_REMINDER\":\"off\",\"CLAUDE_CODE_SILENT_TURN_REMINDER\":\"0\"}}'")|$(shaped --title 'Agent: x' | sed -n 's/^launch=//p' | grep -c -- '--remote-control')"
check "a successor carries the flag, and not the setting" "1|0" \
  "$(succ "$PSTAB" --successor | sed -n 's/^launch=//p' | grep -c -- "--remote-control 'Orch: f'")|$(succ "$PSTAB" --successor | sed -n 's/^launch=//p' | grep -c -- 'remoteControlAtStartup')"
check "--successor --no-remote-control carries the setting" "1" \
  "$(CLAUDE_CONFIG_DIR="$WORK/no-install-record" succ "$PSTAB" --successor --no-remote-control | sed -n 's/^launch=//p' | grep -Fc -- "--settings '{\"remoteControlAtStartup\":false,\"syncClaudeAiSkills\":false,\"env\":{\"CLAUDE_CODE_TOTAL_TOKENS_REMINDER\":\"off\"}}'")"
check "a caller launched without a name cannot derive one" "1|1" \
  "$(succ "$PSNONAME" --successor >/dev/null 2>&1; echo $?)|$(succ "$PSNONAME" --successor | grep -c "needs the caller's session name")"
# The derived name is held to the SAME shape as a typed one (§42), which retires the
# length guard that stood here: a caller that the OLDER launcher named carries the prompt
# in its own process line, so the derivation copied a launch line instead of a name —
# measured live at 366 characters — and a caller named under the older convention
# (a role word spelled out in full) derives nothing either. Both are refused by the shape,
# and the refusal quotes the first forty characters: a launch line must not fill a terminal.
PSLONG="$WORK/ps-long.txt"
printf '/dev/ttys900 /opt/x/host --name Orchestrator : %s --permission-mode auto\n' "$(printf 'x%.0s' $(seq 1 185))" > "$PSLONG"
PSOLD="$WORK/ps-old.txt"
printf '/dev/ttys900 /opt/x/host --name Orchestrator : f --permission-mode auto\n' > "$PSOLD"
PSSHORT="$WORK/ps-short.txt"
printf '/dev/ttys900 /opt/x/host --name Orch: %s --permission-mode auto\n' "$(printf 'x%.0s' $(seq 1 25))" > "$PSSHORT"
PSLONGSUB="$WORK/ps-long-subject.txt"
printf '/dev/ttys900 /opt/x/host --name Orch: %s --permission-mode auto\n' "$(printf 'x%.0s' $(seq 1 26))" > "$PSLONGSUB"
# §39 changed this refusal's WORDS and not its verdict: a launch line is past anything a
# name can be, so it is not read back as one at all, and « does not read Orch: <subject> »
# was saying the wrong thing about a string nobody could read in the first place.
check "a derived name that is a launch line is refused as unreadable" "1|1" \
  "$(succ "$PSLONG" --successor >/dev/null 2>&1; echo $?)|$(succ "$PSLONG" --successor | grep -c "session name cannot be read from the process table")"
check "a caller named under the older convention derives nothing" "1|1" \
  "$(succ "$PSOLD" --successor >/dev/null 2>&1; echo $?)|$(succ "$PSOLD" --successor | grep -c "the caller's session name 'Orchestrator : f' does not read .Orch: <subject>.; pass --title .Orch: <subject>.")"
check "a derived subject of 25 characters still derives, of 26 is refused" "1|1" \
  "$(succ "$PSSHORT" --successor | sed -n 's/^launch=//p' | grep -c -- "--name 'Orch: $(printf 'x%.0s' $(seq 1 25))'")|$(succ "$PSLONGSUB" --successor >/dev/null 2>&1; echo $?)"
# An orchestrator's title is a successor's, and a plain anchor lands after the chain: the
# tab the operator found at the far right of his window, inheriting nothing (§39).
check "an orchestrator's title on a plain anchor is refused" "1|1" \
  "$(shaped --title 'Orch: f' --right-of self | grep -c "an orchestrator's title is a successor's")|$(shaped --title 'Orch: f' --left-of /dev/ttys555 | grep -c 'spawn it with --successor')"
# A successor is named after its caller by definition; --title-free asks for the ESCAPE
# from that shape, which does not apply to a name the launcher derives itself.
check "--successor with --title-free is refused" "1|1" \
  "$(succ "$PSTAB" --successor --title-free >/dev/null 2>&1; echo $?)|$(succ "$PSTAB" --successor --title-free | grep -c 'a successor is named after its caller, --title-free does not apply')"

# The process table is read through ONE function, and the suite replaces `ps` with a file.
name_on() { ORCHESTRATOR_PS_TABLE="$1" "$py" -c "
import sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
print(m.session_name_on(sys.argv[1]))" "$2"; }
check "the table gives the name the host process was launched with" "Orch: f" "$(name_on "$PSTAB" /dev/ttys900)"
check "a process launched without a name reads as none" "None" "$(name_on "$PSNONAME" /dev/ttys900)"
check "a tty the table does not name reads as none" "None" "$(name_on "$PSTAB" /dev/ttys555)"
# The host keeps a session's current name in its registry, and a rename changes the
# registry, never argv: read from argv alone, a renamed orchestrator listed as « (host
# default) » and its successor was refused for having no name.
NCFG="$WORK/namecfg"; mkdir -p "$NCFG/sessions"
printf '/dev/ttys900 5151 claude --resume x\n' > "$WORK/ps-reg.txt"
printf '/dev/ttys900 5252 claude --name Agent: old\n' > "$WORK/ps-reg-argv.txt"
printf '{"pid":5151,"name":"\xe2\x80\x9cOrch : g\xe2\x80\x9d"}\n' > "$NCFG/sessions/5151.json"
printf '{"pid":5252,"name":""}\n' > "$NCFG/sessions/5252.json"
check "a registry file names the session, its quotes stripped" "Orch: g" \
  "$(CLAUDE_CONFIG_DIR="$NCFG" name_on "$WORK/ps-reg.txt" /dev/ttys900)"
check "an empty registry name falls back to the launch name" "Agent: old" \
  "$(CLAUDE_CONFIG_DIR="$NCFG" name_on "$WORK/ps-reg-argv.txt" /dev/ttys900)"
printf '{"pid":5252,"name":"Agent: renamed"}\n' > "$NCFG/sessions/5252.json"
check "and a registry name wins over the launch name" "Agent: renamed" \
  "$(CLAUDE_CONFIG_DIR="$NCFG" name_on "$WORK/ps-reg-argv.txt" /dev/ttys900)"
check "a successor of a session named only in the registry takes that name" "1" \
  "$(CLAUDE_CONFIG_DIR="$NCFG" succ "$WORK/ps-reg.txt" --successor | sed -n 's/^launch=//p' | grep -c -- "--name 'Orch: g'")"

# What the dry run could not see and the live round did: `ps` shows a command line with
# the shell's quoting gone, so whatever FOLLOWS --name runs into the name. The prompt sat
# there, and every spawned session's name column read the title followed by the whole
# brief. The prompt goes BEFORE the options now, so --name is followed by --remote-control
# or by nothing. Read end to end: the launch this dry run prints, turned into the line
# `ps` would show, fed back through the reader.
ps_line() { "$py" -c "
import shlex, sys
launch, prompt_file, tty = sys.argv[1], sys.argv[2], sys.argv[3]
argv = shlex.split(launch.split(' && ')[-1])[1:]
argv = [open(prompt_file).read().strip() if a.startswith('\$(cat ') else a for a in argv]
print('%s %s' % (tty, ' '.join(argv)))" "$1" "$2" "$3"; }
PROMPT_COLON="$WORK/prompt-colon.txt"
printf 'Read and execute /tmp/brief.md. Your orchestrator is Orch: plugin family [abc123].\n' > "$PROMPT_COLON"
d1launch=$(shaped --title 'Agent: x' --prompt-file "$PROMPT_COLON" | sed -n 's/^launch=//p')
ps_line "$d1launch" "$PROMPT_COLON" /dev/ttys900 > "$WORK/ps-launched.txt"
check "the name a spawn leaves in the process table is the title, and stops there" "Agent: x" \
  "$(name_on "$WORK/ps-launched.txt" /dev/ttys900)"
d1succ=$(succ "$PSTAB" --successor --prompt-file "$PROMPT_COLON" | sed -n 's/^launch=//p')
ps_line "$d1succ" "$PROMPT_COLON" /dev/ttys901 > "$WORK/ps-succ.txt"
check "and a successor's, with the remote-control flag behind it" "Orch: f" \
  "$(name_on "$WORK/ps-succ.txt" /dev/ttys901)"
# A successor reads the state through `succession.sh takeover` (decision 0007): no brief is
# written, so the launcher reads none; the prompt `/orchestrator:succeed` writes carries the load
# of the rulebook and the takeover command, and is passed as given.
SUCCB="$WORK/succession-brief.md"; printf '# Orchestrator succession brief — scratch\n' > "$SUCCB"
TAKEOVER_PROMPT='Load the skill orchestrator:orchestrator, then run /p/succession.sh takeover /r.jsonl --tty /dev/ttys900 and execute what it prints.'
check "a successor spawns on the takeover prompt, and on a prompt naming a brief, which it no longer reads" "1|0|1|0" \
  "$(succ "$PSTAB" --successor --prompt "$TAKEOVER_PROMPT" | grep -c '^launch=')|$(succ "$PSTAB" --successor --prompt "$TAKEOVER_PROMPT" | grep -c 'refused')|$(succ "$PSTAB" --successor --prompt "Read and execute $SUCCB" | grep -c '^launch=')|$(succ "$PSTAB" --successor --prompt "Read and execute $SUCCB" | grep -c 'refused')"
# `--brief` builds the spawn's prompt from the brief and the successor's prompt, which carries the
# takeover, would be dropped: the combination is refused, before any tab opens, and says why.
succ_brief() { CLAUDE_CODE_SESSION_ID="${CLAUDE_CODE_SESSION_ID-s-suite}" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_PS_TABLE="$PSTAB" bash "$AGENT" spawn --dir "$WORK" --successor \
  --brief "$SUCCB" --orchestrator "Orch: f [abc123]" 2>&1; }
check "a successor spawned with --brief is refused, before any tab, rather than losing its takeover" "1|1|0" \
  "$(succ_brief | grep -c 'spawn: refused: --successor takes its prompt, not --brief')|$(succ_brief | grep -c 'loads the rulebook and runs the takeover')|$(succ_brief | grep -c '^launch=')"
check "the launch puts the prompt before the name" "1" \
  "$(printf '%s' "$d1launch" | grep -cE '"\$\(cat [^"]+\)" --name ')"

# The listing's row is formatted by a pure function, so its shape is read without an app.
# The tab title is the host's summary of the conversation and it moves; the name is fixed
# at launch, and it is what an orchestrator recognises its own agents by (§38).
row() { "$py" -c "
import sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
print(m.row_for(1, 2, '/dev/ttys900', sys.argv[1], None if sys.argv[2] == '-' else sys.argv[2],
                sys.argv[3] == 'self', sys.argv[4] == 'hidden'))" "$1" "$2" "$3" "$4"; }
check "the row carries the tab title, the session name and the caller's own mark" \
  'w1/t2 | /dev/ttys900 | ✳ T | Agent: x | self' "$(row '✳ T' 'Agent: x' self visible)"
check "a session launched without a name says so, and a hidden pane still says hidden" \
  'w1/t2 | /dev/ttys900 | ✳ T | (host default) | hidden' "$(row '✳ T' - other hidden)"

# `move` moves what it is told to, and warns (stderr and close.log) when the tab is neither the
# caller's own nor in its chain: an orchestrator that had never measured its own tty took the
# last tab for its own (§38), and the warning is what finds that move afterwards.
mv_() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME bash "$AGENT" move "$@" 2>&1; }
mkdir -p "$ISTATE/chains"
printf '{"tab_id":"1","tty":"/dev/ttys901","owner":"S-ME"}\n' > "$ISTATE/chains/ttys900.jsonl"
check "a tab of the caller's chain moves" "1" \
  "$(mv_ --tty /dev/ttys901 --left-of self | grep -c '^move=/dev/ttys901 left_of=/dev/ttys900$')"
check "the caller's own tab moves" "1" \
  "$(mv_ --tty /dev/ttys900 --left-of /dev/ttys555 | grep -c '^move=/dev/ttys900 left_of=/dev/ttys555$')"
printf '{"tab_id":"2","tty":"/dev/ttys902","owner":"S-ME"}\n' > "$ISTATE/chains/ttys900.jsonl"
rm -f "$ISTATE/close.log"
check "a tab that is neither moves anyway, a warning on stderr and in close.log naming it" "0|1|1" \
  "$(mv_ --tty /dev/ttys901 --left-of self >/dev/null 2>&1; echo $?)|$(mv_ --tty /dev/ttys901 --left-of self | grep -c "^move: warning: /dev/ttys901 is not in this session's chain: moved anyway$")|$(grep -q "move: warning: /dev/ttys901 is not in this session's chain: moved anyway$" "$ISTATE/close.log" && echo 1 || echo 0)"
check "and it still prints the move" "1" \
  "$(mv_ --tty /dev/ttys901 --left-of self | grep -c '^move=/dev/ttys901 left_of=/dev/ttys900$')"
check "--force on that tab still moves it: exit 0, the move printed" "0|1" \
  "$(mv_ --tty /dev/ttys901 --left-of self --force >/dev/null 2>&1; echo $?)|$(mv_ --tty /dev/ttys901 --left-of self --force | grep -c '^move=/dev/ttys901 left_of=/dev/ttys900$')"

# `--leftmost` places a tab at the first place of its window, no neighbour tab named: a
# third form beside `--left-of` and `--right-of`, exclusive with both.
check "--leftmost moves the caller's own tab to the first place of its window" "1" \
  "$(mv_ --tty /dev/ttys900 --leftmost | grep -c '^move=/dev/ttys900 left_of=leftmost$')"
check "--leftmost is exclusive with --left-of and --right-of" "1|1" \
  "$(mv_ --tty /dev/ttys900 --leftmost --right-of self >/dev/null 2>&1; echo $?)|$(mv_ --tty /dev/ttys900 --leftmost --right-of self | grep -c -- '--leftmost is exclusive with --left-of and --right-of')"
check "no anchor at all is refused, naming all three forms" "1|1" \
  "$(mv_ --tty /dev/ttys900 >/dev/null 2>&1; echo $?)|$(mv_ --tty /dev/ttys900 | grep -c -- '--left-of, --right-of or --leftmost is required')"

# The guard that refuses a stranger's tab applies to `--leftmost` exactly as it does to
# `--left-of` and `--right-of`: the anchor form changes, not whose tab this is.
check "--leftmost moves a tab out of the caller's chain too, with the warning naming it" "0|1" \
  "$(mv_ --tty /dev/ttys901 --leftmost >/dev/null 2>&1; echo $?)|$(mv_ --tty /dev/ttys901 --leftmost | grep -c "^move: warning: /dev/ttys901 is not in this session's chain: moved anyway$")"

# An AUDITOR is neither a successor nor an agent (§52). It is placed immediately RIGHT of
# the orchestrator it audits (its caller, or the tab --of names), the chain ignored — on the
# caller's model and under remote control under its own title; but it takes no chain and
# joins none: the orchestrator it audits keeps its agents, and the auditor is nobody's agent.
# Its title is REQUIRED and reads
# `Audit: <subject>`, a shape refused everywhere but under --auditor.
AUDSTATE="$WORK/audstate"; AUDCFG="$WORK/audcfg"
# The auditor inherits the caller's model from the measure file, and that file is the
# module's own artifact: it is read under the config dir (CLAUDE_CONFIG_DIR, else the
# home's .claude), never under the state override, while the chains and prompts the same
# spawn touches still sit under the override.
mkdir -p "$AUDSTATE/chains" "$AUDCFG/claude-orchestrator/measure"
printf '{"context_tokens":21000,"context_window":200000,"context_percent":10,"model":"aud-model","updated_at":"2026-10-10T00:00:00Z"}\n' > "$AUDCFG/claude-orchestrator/measure/s-aud.json"
pair_transcript s-aud aud-model high
printf '{"tab_id":"7","tty":"/dev/ttys901","owner":"S-ME"}\n' > "$AUDSTATE/chains/ttys900.jsonl"
aud() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" CLAUDE_CONFIG_DIR="$AUDCFG" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-aud bash "$AGENT" spawn --dir "$WORK" --prompt p $(needs_tier "$@") "$@" 2>&1; }
audl() { aud "$@" | sed -n 's/^launch=//p'; }
AUDOUT=$(aud --auditor --title 'Audit: tm')
AUDLAUNCH=$(printf '%s' "$AUDOUT" | sed -n 's/^launch=//p')
check "an auditor is named by its title and comes up under remote control under it" "1|1" \
  "$(printf '%s' "$AUDLAUNCH" | grep -c -- "--name 'Audit: tm'")|$(printf '%s' "$AUDLAUNCH" | grep -c -- "--remote-control 'Audit: tm'")"
check "and without the setting that turns remote control off" "0" "$(printf '%s' "$AUDLAUNCH" | grep -c -- 'remoteControlAtStartup')"
check "an auditor runs on the caller's model with no flag to ask for it" "1" "$(printf '%s' "$AUDLAUNCH" | grep -c -- '--model aud-model')"
check "an auditor anchors on self, past no agent, and the dry run says what it is" "1|1|1" \
  "$(printf '%s' "$AUDOUT" | grep -c '^anchor=self$')|$(printf '%s' "$AUDOUT" | grep -c '^auditor=yes$')|$(printf '%s' "$AUDOUT" | grep -c '^successor=no$')"
check "an auditor sits on the RIGHT of the orchestrator it audits, as a successor and a plain anchor do" "right|right|right" \
  "$(printf '%s' "$AUDOUT" | sed -n 's/^side=//p')|$(aud --title 'Orch: f' --successor | sed -n 's/^side=//p')|$(aud --title 'Agent: x' --right-of self | sed -n 's/^side=//p')"
# The audited orchestrator is the caller, or the tab --of names; a coordinator is no orchestrator.
AUDCOORDPS="$WORK/ps-audcoord.txt"; printf '/dev/ttys900 claude --name Coord: c\n' > "$AUDCOORDPS"
audc() { ORCHESTRATOR_PS_TABLE="$AUDCOORDPS" aud "$@"; }
check "an auditor given --of anchors on that tab, on its right, in no chain" "1|right|none" \
  "$(aud --auditor --of /dev/ttys555 --title 'Audit: tm' | grep -c '^anchor=/dev/ttys555$')|$(aud --auditor --of /dev/ttys555 --title 'Audit: tm' | sed -n 's/^side=//p')|$(aud --auditor --of /dev/ttys555 --title 'Audit: tm' | sed -n 's/^chain=//p')"
check "--of self is the caller's own tab, as no --of is" "1" \
  "$(aud --auditor --of self --title 'Audit: tm' | grep -c '^anchor=self$')"
check "--of is an auditor's: refused without --auditor, and refused when it names no tty" "1|1|1|1" \
  "$(aud --of /dev/ttys555 --title 'Agent: x' >/dev/null 2>&1; echo $?)|$(aud --of /dev/ttys555 --title 'Agent: x' | grep -c -- '--of names the orchestrator an auditor audits')|$(aud --auditor --of nowhere --title 'Audit: tm' >/dev/null 2>&1; echo $?)|$(aud --auditor --of nowhere --title 'Audit: tm' | grep -c -- "--of names the audited orchestrator's tty")"
check "a coordinator's auditor must name the orchestrator it audits: refused with no --of, and with its own tab" "1|1|1" \
  "$(audc --auditor --title 'Audit: tm' >/dev/null 2>&1; echo $?)|$(audc --auditor --title 'Audit: tm' | grep -c "the coordinator's own tab is not an orchestrator's")|$(audc --auditor --of /dev/ttys900 --title 'Audit: tm' >/dev/null 2>&1; echo $?)"
check "and with --of an orchestrator's tab it is launched, right of that tab" "0|1|right" \
  "$(audc --auditor --of /dev/ttys555 --title 'Audit: tm' >/dev/null 2>&1; echo $?)|$(audc --auditor --of /dev/ttys555 --title 'Audit: tm' | grep -c '^anchor=/dev/ttys555$')|$(audc --auditor --of /dev/ttys555 --title 'Audit: tm' | sed -n 's/^side=//p')"
check "where a plain spawn from the same caller anchors after its last agent" "1" \
  "$(aud --title 'Agent: x' --right-of self | grep -c '^anchor=/dev/ttys901$')"
check "a chain is appended to by an agent, handed over by a successor, left alone by an auditor" "append|transfer|none" \
  "$(aud --title 'Agent: x' --right-of self | sed -n 's/^chain=//p')|$(aud --title 'Orch: f' --successor | sed -n 's/^chain=//p')|$(printf '%s' "$AUDOUT" | sed -n 's/^chain=//p')"
check "an auditor without a title is refused, and the reason names the shape" "1|1" \
  "$(aud --auditor >/dev/null 2>&1; echo $?)|$(aud --auditor | grep -c -- '--auditor needs --title "Audit: <subject>"')"
AUD25=$(printf 'x%.0s' $(seq 1 25)); AUD26=$(printf 'x%.0s' $(seq 1 26))
check "an auditor's subject of 25 characters is accepted, of 26 refused" "1|1" \
  "$(audl --auditor --title "Audit: $AUD25" | grep -c -- "--name 'Audit: $AUD25'")|$(aud --auditor --title "Audit: $AUD26" >/dev/null 2>&1; echo $?)"
check "an auditor under an agent's or an orchestrator's title is refused" "1|1|1" \
  "$(aud --auditor --title 'Agent: x' >/dev/null 2>&1; echo $?)|$(aud --auditor --title 'Orch: x' >/dev/null 2>&1; echo $?)|$(aud --auditor --title 'Agent: x' | grep -c "an auditor's title reads \"Audit: <subject>\"")"
check "an audit title is refused without --auditor: plain, anchored, free, successor" "1|1|1|1" \
  "$(aud --title 'Audit: x' | grep -c "an audit title is an auditor's")|$(aud --title 'Audit: x' --right-of self | grep -c "an audit title is an auditor's")|$(aud --title-free --title 'Audit: x' | grep -c "an audit title is an auditor's")|$(aud --successor --title 'Audit: x' | grep -c "an audit title is an auditor's")"
check "and that refusal exits 1" "1" "$(aud --title 'Audit: x' >/dev/null 2>&1; echo $?)"
for AUDFLAG in --successor '--right-of self' '--left-of /dev/ttys555' --title-free '--tier deep' --no-remote-control; do
  # shellcheck disable=SC2086 # the flag and its value are two words on purpose
  check "an auditor refuses $AUDFLAG" "1|1" \
    "$(aud --auditor --title 'Audit: x' $AUDFLAG >/dev/null 2>&1; echo $?)|$(aud --auditor --title 'Audit: x' $AUDFLAG | grep -c "is not an auditor's")"
done
check "an auditor with no readable pair is refused, naming where its transcript was looked for" "1" \
  "$(CLAUDE_CODE_SESSION_ID=s-aud-none ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" bash "$AGENT" spawn --dir "$WORK" --auditor --title 'Audit: x' --prompt p 2>&1 | grep -cF "no transcript for session s-aud-none under $ORCHESTRATOR_PROJECTS_DIR")"
check "--inherit-model beside --auditor asks for what is already implied" "1" \
  "$(audl --auditor --inherit-model --title 'Audit: x' | grep -c -- '--model aud-model')"
# An auditor given its pair runs on it (the caller's pair is read only when none is given).
AUDPAIR=$(aud --auditor --model m-x --effort low --title 'Audit: tm')
check "an auditor given --model and --effort runs on that pair, not its caller's" "1|0" \
  "$(printf '%s' "$AUDPAIR" | grep -c -- '--model m-x --effort low')|$(printf '%s' "$AUDPAIR" | grep -c -- '--model aud-model')"
check "an auditor given neither runs on its caller's model and effort" "1" \
  "$(audl --auditor --title 'Audit: tm' | grep -c -- '--model aud-model --effort high')"
check "an auditor given a model without an effort is refused" "1" \
  "$(aud --auditor --model m-x --title 'Audit: tm' >/dev/null 2>&1; echo $?)"

# An auditor kept on past its report succeeds on the operator's word (§9.4, §52): `spawn --successor` from
# a session named `Audit: <subject>` derives that name like it does for `Orch:`, lands
# immediately right of the caller (so, once the predecessor's tab is closed, in the auditor's
# own place right of its orchestrator), runs on the caller's model under remote control, and
# takes and hands no chain: an auditor has none, and written into one it would anchor an
# orchestrator's next agent.
PSAUDTAB="$WORK/ps-audit-succ.txt"
printf '/dev/ttys900 /opt/x/host --name Audit: tm --permission-mode auto\n' > "$PSAUDTAB"
audsucc() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" CLAUDE_CONFIG_DIR="$AUDCFG" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-aud ORCHESTRATOR_PS_TABLE="${AUDPS:-$PSAUDTAB}" \
  bash "$AGENT" spawn --dir "$WORK" --prompt p $(needs_tier "$@") "$@" 2>&1; }
AUDSUCCOUT=$(audsucc --successor --inherit-model --permission-mode auto)
AUDSUCCLAUNCH=$(printf '%s' "$AUDSUCCOUT" | sed -n 's/^launch=//p')
check "an auditor's successor takes the caller's name and comes up under remote control under it" "1|1|0" \
  "$(printf '%s' "$AUDSUCCLAUNCH" | grep -c -- "--name 'Audit: tm'")|$(printf '%s' "$AUDSUCCLAUNCH" | grep -c -- "--remote-control 'Audit: tm'")|$(printf '%s' "$AUDSUCCLAUNCH" | grep -c -- 'remoteControlAtStartup')"
check "it runs on the caller's model, with the flag or without" "1|1" \
  "$(printf '%s' "$AUDSUCCLAUNCH" | grep -c -- '--model aud-model')|$(audsucc --successor | sed -n 's/^launch=//p' | grep -c -- '--model aud-model')"
check "it lands immediately right of the caller, past no agent of any chain" "right|1" \
  "$(printf '%s' "$AUDSUCCOUT" | sed -n 's/^side=//p')|$(printf '%s' "$AUDSUCCOUT" | grep -c '^anchor=self$')"
check "it takes and hands no chain, and is not an auditor's spawn" "none|yes|no" \
  "$(printf '%s' "$AUDSUCCOUT" | sed -n 's/^chain=//p')|$(printf '%s' "$AUDSUCCOUT" | sed -n 's/^successor=//p')|$(printf '%s' "$AUDSUCCOUT" | sed -n 's/^auditor=//p')"
check "an orchestrator's successor from the same state still hands the chain over" "transfer" \
  "$(succ "$PSTAB" --successor | sed -n 's/^chain=//p')"
check "a typed audit title is still refused beside --successor, and a 26-character subject is refused" "1|1" \
  "$(audsucc --successor --title 'Audit: x' | grep -c "an audit title is an auditor's")|$(printf '/dev/ttys900 /opt/x/host --name Audit: %s --permission-mode auto\n' "$AUD26" > "$WORK/ps-audit-long.txt"; AUDPS="$WORK/ps-audit-long.txt"; audsucc --successor >/dev/null 2>&1; echo $?)"
# The 25-character subject is the longest an auditor's title takes: it is ACCEPTED as a
# successor, under the caller's name, right of it, in no chain. That half falls with the auditor
# branch removed, which the refusal of 26 alone does not (it fails either title shape).
printf '/dev/ttys900 /opt/x/host --name Audit: %s --permission-mode auto\n' "$AUD25" > "$WORK/ps-audit-25.txt"
AUD25OUT=$(AUDPS="$WORK/ps-audit-25.txt"; audsucc --successor)
check "a 25-character subject is accepted as a successor: the caller's name, right of it, in no chain" "1|right|none" \
  "$(printf '%s' "$AUD25OUT" | grep -c "^name=Audit: $AUD25\$")|$(printf '%s' "$AUD25OUT" | sed -n 's/^side=//p')|$(printf '%s' "$AUD25OUT" | sed -n 's/^chain=//p')"
# An auditor's successor runs on the caller's model and comes up under remote control under its
# name: a tier, a model or no remote control beside --successor is refused, one flag at a time.
for AUDSUCCFLAG in "--tier standard" "--model a-model" "--no-remote-control"; do
  check "an auditor's successor refuses ${AUDSUCCFLAG%% *}, and says so" "1|1" \
    "$(audsucc --successor $AUDSUCCFLAG >/dev/null 2>&1; echo $?)|$(audsucc --successor $AUDSUCCFLAG | grep -c -- "spawn: refused: ${AUDSUCCFLAG%% *} is not an auditor's successor's")"
done

# An auditor lands where it was told only if the terminal's API answered; the API-less rung
# places nothing, and any other cause leaves the tab elsewhere with the launch reported as
# done. So the launcher READS the order the listing prints, repairs once with its own move,
# reads again, and says so on stdout, exiting non-zero, when it is still wrong. The decision
# is a pure function of what was read, so the suite drives it with a scripted listing.
settle() { "$py" -c "
import sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
AUD, CALLER = '/dev/ttys950', '/dev/ttys900'
def rows(*order):
    return [m.row_for(1, i, tty, 't', None, False, False) for i, tty in enumerate(order, 1)]
RIGHT = rows('/dev/ttys800', CALLER, AUD, '/dev/ttys901')
WRONG = rows(AUD, '/dev/ttys800', CALLER, '/dev/ttys901')
OTHER_WINDOW = [m.row_for(2, 1, AUD, 't', None, False, False), m.row_for(1, 2, CALLER, 't', None, False, False)]
HIDDEN = [m.row_for(1, 1, '/dev/ttys777', 't', None, False, False), m.row_for(1, 1, CALLER, 't', None, False, True),
          m.row_for(1, 2, AUD, 't', None, False, False)]  # the audited orchestrator is a hidden pane of tab 1
scenario = sys.argv[1]
reads, moves = [], []
if scenario == 'placed': seq = [RIGHT]
elif scenario == 'repaired': seq = [WRONG, RIGHT]
elif scenario == 'stuck': seq = [WRONG, WRONG]
elif scenario == 'unread': seq = [None]
elif scenario == 'unread-after-move': seq = [WRONG, None]
elif scenario == 'unserved': seq = [WRONG, WRONG]
elif scenario == 'elsewhere': seq = [OTHER_WINDOW, OTHER_WINDOW]
else:
    seq = None
if seq is None:
    print(m.placed_right_of({'window': OTHER_WINDOW, 'hidden': HIDDEN}[scenario], AUD, CALLER))
    sys.exit(0)
def read():
    reads.append(1)
    return seq[min(len(reads), len(seq)) - 1]
def move(tty, anchor):
    moves.append((tty, anchor))
    return False if scenario == 'unserved' else True
line, code = m.settle_auditor(read, move, AUD, CALLER)
print('%d|%d|%s|%d|%s' % (len(reads), len(moves), ','.join('%s>%s' % t for t in moves), code, line))
" "$1"; }
check "an auditor already immediately right of its orchestrator is read once and moved never" "1|0||0|" "$(settle placed)"
check "a misplaced auditor is moved right of its orchestrator, then read again, and nothing is said" \
  "2|1|/dev/ttys950>/dev/ttys900|0|" "$(settle repaired)"
check "an auditor still misplaced after one move is said on one line naming both ttys and the remedy, exit 1" \
  "2|1|/dev/ttys950>/dev/ttys900|1|spawn: the auditor on /dev/ttys950 is not immediately right of /dev/ttys900; repair it with: iterm-agent.sh move --tty /dev/ttys950 --right-of /dev/ttys900" \
  "$(settle stuck)"
check "a listing that cannot be read is said unverified, with the way to read it, and the session stays" \
  "1|0||1|spawn: could not read the tab order, so the auditor's place on /dev/ttys950 is unverified; check with: iterm-agent.sh list" \
  "$(settle unread)"
check "a listing lost after the move is unverified too, not reported as misplaced" \
  "2|1|/dev/ttys950>/dev/ttys900|1|spawn: could not read the tab order, so the auditor's place on /dev/ttys950 is unverified; check with: iterm-agent.sh list" \
  "$(settle unread-after-move)"
check "a move the terminal cannot serve says its API is not available, and offers no move command" \
  "2|1|/dev/ttys950>/dev/ttys900|1|spawn: the auditor on /dev/ttys950 is not immediately right of /dev/ttys900, and could not be moved because the terminal's API is not available; read iterm-agent.sh list and move the tab by hand only if it is misplaced" \
  "$(settle unserved)"
check "an auditor in another window than its caller says so, since a move cannot cross windows" \
  "2|1|/dev/ttys950>/dev/ttys900|1|spawn: the auditor on /dev/ttys950 is in another window than its orchestrator on /dev/ttys900; see iterm-agent.sh list" \
  "$(settle elsewhere)"
check "the same tab number in another window is not right of the orchestrator" "False" "$(settle window)"
check "an orchestrator that is a hidden pane is placed by its tab: the auditor in the tab after it counts" "True" \
  "$(settle hidden)"

# The move finds its anchor by ANY pane of a tab, as the anchor probe does, and never across
# windows: an orchestrator in a split tab whose current pane is another pane is still in its tab.
mvright() { "$py" -c "
import asyncio, sys
sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
class S:
    def __init__(self, tty): self.tty = tty; self.session_id = tty
    async def async_get_variable(self, name): return self.tty
class T:
    def __init__(self, tab_id, *ttys): self.tab_id = tab_id; self.all_sessions = [S(x) for x in ttys]; self.current_session = self.all_sessions[-1]
class W:
    def __init__(self, window_id, *tabs): self.window_id = window_id; self.tabs = list(tabs); self.set = None
    async def async_set_tabs(self, tabs): self.set = [t.tab_id for t in tabs]
class App:
    def __init__(self, *windows): self.windows = windows
class API:
    def __init__(self, app): self.app = app
    async def async_get_app(self, connection): return self.app
AUD, CALLER = '/dev/ttys950', '/dev/ttys900'
split = T('c', CALLER, '/dev/ttys777')  # the orchestrator's pane is hidden: another pane is current
if sys.argv[1] == 'split':
    w = W('w1', T('a', AUD), T('b', '/dev/ttys800'), split, T('d', '/dev/ttys801')); api = API(App(w))
else:
    w = W('w1', T('a', AUD), T('b', '/dev/ttys800')); api = API(App(w, W('w2', split)))
asyncio.run(m.move_right_of(api, None, AUD, CALLER))
print(w.set)
" "$1"; }
check "an auditor moves immediately after an orchestrator whose current pane is another pane of its tab" \
  "['b', 'c', 'a', 'd']" "$(mvright split)"
check "an orchestrator in another window moves nothing: a move does not cross windows" "None" "$(mvright window)"

# The wiring is a decision of its own: the repair is called, the line goes to STDOUT, the tty
# is printed whatever the repair did, and the exit follows. The suite drives `cmd_spawn`
# itself with the terminal stubbed under it — the real `served_by`, `repair_auditor_place`
# and `settle_auditor` — and reads what a caller reads: stdout, stderr and the exit code.
AUDTRUST="$WORK/aud-trust.json"; printf '{"projects":{}}\n' > "$AUDTRUST"
spawn_aud() { # <scenario> [backend]: prints the exit code; stdout and stderr land in files
  ORCHESTRATOR_STATE_DIR="$AUDSTATE" CLAUDE_CONFIG_DIR="$AUDCFG" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_SELF_ID=S-ME \
  CLAUDE_CODE_SESSION_ID=s-aud ORCHESTRATOR_BACKEND="${2:-api}" ORCHESTRATOR_TRUST_FILE="$AUDTRUST" \
  AUD_OUT="$WORK/aud-spawn.out" AUD_ERR="$WORK/aud-spawn.err" "$py" -c "
import contextlib, sys
sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
AUD, CALLER = '/dev/ttys950', '/dev/ttys900'
def rows(*order):
    return [m.row_for(1, i, tty, 't', None, False, False) for i, tty in enumerate(order, 1)]
RIGHT = rows('/dev/ttys800', CALLER, AUD)
WRONG = rows(AUD, '/dev/ttys800', CALLER)
scenario = sys.argv[1]
WRONG_HOME = rows(AUD, '/dev/ttys800', '/dev/ttys004')
readings = {'misplaced': [WRONG, WRONG], 'unread': ['boom'], 'move-fails': [WRONG, RIGHT],
            'api-less': [WRONG, WRONG], 'broken': [['wx/t1 | /dev/ttys950 | t | n']],
            'home': [WRONG_HOME, WRONG_HOME]}[scenario]
if scenario == 'home':
    # The caller is an orchestrator of a home session: its own tty is a pane, and the tab
    # that shows the server runs the tmux client on /dev/ttys004.
    class Done: returncode = 0; stdout = '/dev/ttys004\n'
    m.in_home_session = lambda: True
    m.tmux_call = lambda args, env=None: Done()
reads = []
def next_reading():
    reads.append(1)
    item = readings[min(len(reads), len(readings)) - 1]
    if item == 'boom':
        raise RuntimeError('the listing failed')
    return item
def stub_run(fn):
    if fn.__name__ == 'probe': return True
    if fn.__name__ == 'go': return AUD
    if fn.__name__ == 'rows': return next_reading()
    if fn.__name__ == 'ids': return ('sess-aud', 'tab-aud')
    if fn.__name__ == 'owner': return 'S-ME'
    if scenario == 'move-fails': raise RuntimeError('set_tabs refused')
m.run = stub_run
m.as_spawn = lambda command: AUD
m.as_list = next_reading
code = 0
with open('$WORK/aud-spawn.out', 'w') as out, open('$WORK/aud-spawn.err', 'w') as err, \
     contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
    try:
        m.cmd_spawn(m.args_from_line('spawn', ['--dir', '$WORK', '--prompt', 'p', '--auditor', '--title', 'Audit: tm',
                     '--trust', '--no-verify']))
    except SystemExit as exc:
        code = exc.code or 0
print(code)
" "$1"; }
check "a misplaced auditor: the line on stdout, the tty still printed, exit 1" "1|1|1" \
  "$(spawn_aud misplaced)|$(grep -c 'is not immediately right of /dev/ttys900; repair it with: iterm-agent.sh move --tty /dev/ttys950 --right-of /dev/ttys900' "$WORK/aud-spawn.out")|$(grep -c '^/dev/ttys950$' "$WORK/aud-spawn.out")"
check "an orchestrator of a home session is audited from the tab that shows it, not from its pane" "1|1" \
  "$(spawn_aud home)|$(grep -c 'is not immediately right of /dev/ttys004; repair it with: iterm-agent.sh move --tty /dev/ttys950 --right-of /dev/ttys004' "$WORK/aud-spawn.out")"
check "a listing that cannot be read: one line on stderr, the unverified line, the tty printed, exit 1" "1|1|1|1" \
  "$(spawn_aud unread)|$(grep -c 'could not be read: the listing failed' "$WORK/aud-spawn.err")|$(grep -c "the auditor's place on /dev/ttys950 is unverified; check with: iterm-agent.sh list" "$WORK/aud-spawn.out")|$(grep -c '^/dev/ttys950$' "$WORK/aud-spawn.out")"
check "an exception in the move: one line on stderr, the tty printed, the second reading decides" "0|1|1|0" \
  "$(spawn_aud move-fails)|$(grep -c 'could not be moved' "$WORK/aud-spawn.err")|$(grep -c '^/dev/ttys950$' "$WORK/aud-spawn.out")|$(grep -c 'Traceback' "$WORK/aud-spawn.err")"
check "a repair that itself breaks: one line on stderr, the unverified line, the tty printed, exit 1" "1|1|1|1" \
  "$(spawn_aud broken)|$(grep -c 'could not be settled' "$WORK/aud-spawn.err")|$(grep -c 'is unverified' "$WORK/aud-spawn.out")|$(grep -c '^/dev/ttys950$' "$WORK/aud-spawn.out")"
check "the API-less rung: no placement warning on stderr, the API-not-available line, the tty, exit 1" "1|0|1|1" \
  "$(spawn_aud api-less applescript)|$(grep -c 'cannot place a tab' "$WORK/aud-spawn.err")|$(grep -c "could not be moved because the terminal's API is not available" "$WORK/aud-spawn.out")|$(grep -c '^/dev/ttys950$' "$WORK/aud-spawn.out")"
# The launch records the auditor as its launcher's, by the app's session id, so that `move`
# can repair a place that came out wrong; the record is read back, then removed so the
# refusals below meet a stranger's auditor.
check "a spawned auditor is recorded under its tty with the app's session id and its launcher" "1|1" \
  "$(grep -c '"launcher": "S-ME"' "$AUDSTATE/auditors/ttys950.json")|$(grep -c '"session": "sess-aud"' "$AUDSTATE/auditors/ttys950.json")"
rm -rf "$AUDSTATE/auditors"

# `rotate` and `move` treat an auditor's tab as not the caller's to replace or place: it is
# read by its NAME in the process table, so a stale chain entry naming it moves nothing.
PSAUD="$WORK/ps-audit.txt"
printf '/dev/ttys950 /opt/x/claude --name Audit: tm\n/dev/ttys901 /opt/x/claude --name Agent: x\n' > "$PSAUD"
audrot() { CLAUDE_CODE_SESSION_ID="${CLAUDE_CODE_SESSION_ID-s-suite}" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" ORCHESTRATOR_PS_TABLE="$PSAUD" \
  bash "$AGENT" rotate --dir "$WORK" --title "Agent: rotated" --prompt p $(needs_tier "$@") "$@" 2>&1; }
check "rotate refuses --auditor" "1" "$(audrot --old-tty /dev/ttys901 --auditor | grep -c -- '--auditor is not a rotation')"
AUDROT=$(audrot --old-tty /dev/ttys950)
check "rotate refuses an auditor's tab before it spawns anything" "0|1|1" \
  "$(printf '%s' "$AUDROT" | grep -c '^launch=')|$(printf '%s' "$AUDROT" | grep -c "rotate: refused: /dev/ttys950 is an auditor's tab ('Audit: tm')")|$(audrot --old-tty /dev/ttys950 >/dev/null 2>&1; echo $?)"
check "--force rotates it, and says so" "1|1" \
  "$(audrot --old-tty /dev/ttys950 --force | tail -1 | grep -c '^close=/dev/ttys950')|$(audrot --old-tty /dev/ttys950 --force | grep -c "^rotate: forced: /dev/ttys950 is an auditor's tab")"
check "an agent's tab still rotates without --force" "1" "$(audrot --old-tty /dev/ttys901 | tail -1 | grep -c '^close=/dev/ttys901')"
printf '{"tab_id":"8","tty":"/dev/ttys950","owner":"S-ME"}\n' >> "$AUDSTATE/chains/ttys900.jsonl"
audmv() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" ORCHESTRATOR_SELF_TTY="${AUDSELF:-/dev/ttys900}" \
  ORCHESTRATOR_SELF_ID=S-ME ORCHESTRATOR_PS_TABLE="$PSAUD" bash "$AGENT" move "$@" 2>&1; }
check "an auditor's tab is not moved, even with a stale chain entry naming it" "1|1" \
  "$(audmv --tty /dev/ttys950 --right-of self >/dev/null 2>&1; echo $?)|$(audmv --tty /dev/ttys950 --right-of self | grep -c "move: refused: /dev/ttys950 is an auditor's tab ('Audit: tm'), not this session's to place (pass --force to move it anyway)")"
check "--force moves it, and says so" "0|1" \
  "$(audmv --tty /dev/ttys950 --right-of self --force >/dev/null 2>&1; echo $?)|$(audmv --tty /dev/ttys950 --right-of self --force | grep -c "^move: forced: /dev/ttys950 is an auditor's tab")"
check "an auditor's tab is not moved leftmost either" "1|1" \
  "$(audmv --tty /dev/ttys950 --leftmost >/dev/null 2>&1; echo $?)|$(audmv --tty /dev/ttys950 --leftmost | grep -c "move: refused: /dev/ttys950 is an auditor's tab ('Audit: tm'), not this session's to place (pass --force to move it anyway)")"
check "--force moves it leftmost too, and says so" "0|1" \
  "$(audmv --tty /dev/ttys950 --leftmost --force >/dev/null 2>&1; echo $?)|$(audmv --tty /dev/ttys950 --leftmost --force | grep -c "^move: forced: /dev/ttys950 is an auditor's tab")"
check "an agent of the chain still moves" "1" "$(audmv --tty /dev/ttys901 --right-of self | grep -c '^move=/dev/ttys901 right_of=/dev/ttys900$')"
check "an auditor places its own tab" "1" \
  "$(AUDSELF=/dev/ttys950 audmv --tty /dev/ttys950 --right-of /dev/ttys900 | grep -c '^move=/dev/ttys950 right_of=/dev/ttys900$')"
# The launcher that placed an auditor repairs its place without --force; another session still
# needs it, and a record naming no launcher opens nothing.
mkdir -p "$AUDSTATE/auditors"
printf '{"tty": "/dev/ttys950", "session": "sess-aud", "launcher": "S-ME"}\n' > "$AUDSTATE/auditors/ttys950.json"
check "an auditor its own launcher placed is moved without --force, and not called forced" "0|1|0" \
  "$(audmv --tty /dev/ttys950 --right-of /dev/ttys900 >/dev/null 2>&1; echo $?)|$(audmv --tty /dev/ttys950 --right-of /dev/ttys900 | grep -c '^move=/dev/ttys950 right_of=/dev/ttys900$')|$(audmv --tty /dev/ttys950 --right-of /dev/ttys900 | grep -c 'forced')"
printf '{"tty": "/dev/ttys950", "session": "sess-aud", "launcher": "S-OTHER"}\n' > "$AUDSTATE/auditors/ttys950.json"
check "an auditor another session placed is still refused" "1|1" \
  "$(audmv --tty /dev/ttys950 --right-of /dev/ttys900 >/dev/null 2>&1; echo $?)|$(audmv --tty /dev/ttys950 --right-of /dev/ttys900 | grep -c "move: refused: /dev/ttys950 is an auditor's tab")"
rm -rf "$AUDSTATE/auditors"

# The COORDINATOR sits above every orchestrator on the machine. Its own successor is
# neither an auditor nor an agent: it lands at the FIRST place of the caller's window (not
# merely beside it), the chain ignored — on the caller's model and under remote control
# under its own title; it takes no chain and joins none. Its title is REQUIRED and reads
# `Coord: <subject>`, a shape refused everywhere but under --coordinator-successor.
CRDSTATE="$WORK/crdstate"; CRDCFG="$WORK/crdcfg"
mkdir -p "$CRDSTATE/chains" "$CRDCFG/claude-orchestrator/measure"
printf '{"context_tokens":21000,"context_window":200000,"context_percent":10,"model":"crd-model","updated_at":"2026-10-10T00:00:00Z"}\n' > "$CRDCFG/claude-orchestrator/measure/s-crd.json"
pair_transcript s-crd crd-model high
printf '{"tab_id":"7","tty":"/dev/ttys901","owner":"S-ME"}\n' > "$CRDSTATE/chains/ttys900.jsonl"
# The caller reads as an orchestrator: a wake takes --open's caller rule.
CRDCALLER="$WORK/ps-crdcaller.txt"; printf '/dev/ttys900 claude --name Orch: f\n' > "$CRDCALLER"
crd() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" CLAUDE_CONFIG_DIR="$CRDCFG" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_PS_TABLE="$CRDCALLER" \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-crd bash "$AGENT" spawn --dir "$WORK" --prompt p $(needs_tier "$@") "$@" 2>&1; }
crdl() { crd "$@" | sed -n 's/^launch=//p'; }
CRDOUT=$(crd --coordinator-successor --title 'Coord: ops')
CRDLAUNCH=$(printf '%s' "$CRDOUT" | sed -n 's/^launch=//p')
check "the coordinator's successor is named by its title and comes up under remote control under it" "1|1" \
  "$(printf '%s' "$CRDLAUNCH" | grep -c -- "--name 'Coord: ops'")|$(printf '%s' "$CRDLAUNCH" | grep -c -- "--remote-control 'Coord: ops'")"
check "and without the setting that turns remote control off" "0" "$(printf '%s' "$CRDLAUNCH" | grep -c -- 'remoteControlAtStartup')"
check "the coordinator's successor runs on the caller's model with no flag to ask for it" "1" "$(printf '%s' "$CRDLAUNCH" | grep -c -- '--model crd-model')"
check "it lands at the first place of the caller's window, joins no chain, and the dry run says what it is" "1|1|1|1" \
  "$(printf '%s' "$CRDOUT" | grep -c '^anchor=leftmost$')|$(printf '%s' "$CRDOUT" | grep -c '^side=left$')|$(printf '%s' "$CRDOUT" | grep -c '^coordinator_successor=yes$')|$(printf '%s' "$CRDOUT" | grep -c '^chain=none$')"
check "a coordinator-successor without a title is refused, and the reason names the shape" "1|1" \
  "$(crd --coordinator-successor >/dev/null 2>&1; echo $?)|$(crd --coordinator-successor | grep -c -- '--coordinator-successor needs --title "Coord: <subject>"')"
CRD25=$(printf 'x%.0s' $(seq 1 25)); CRD26=$(printf 'x%.0s' $(seq 1 26))
check "a coordinator's subject of 25 characters is accepted, of 26 refused" "1|1" \
  "$(crdl --coordinator-successor --title "Coord: $CRD25" | grep -c -- "--name 'Coord: $CRD25'")|$(crd --coordinator-successor --title "Coord: $CRD26" >/dev/null 2>&1; echo $?)"
check "a coordinator-successor under an agent's or an orchestrator's title is refused" "1|1|1" \
  "$(crd --coordinator-successor --title 'Agent: x' >/dev/null 2>&1; echo $?)|$(crd --coordinator-successor --title 'Orch: x' >/dev/null 2>&1; echo $?)|$(crd --coordinator-successor --title 'Agent: x' | grep -c "the coordinator's title reads \"Coord: <subject>\"")"
check "a Coord title is refused without --coordinator-successor: plain, anchored, free, successor" "1|1|1|1" \
  "$(crd --title 'Coord: x' | grep -c 'a "Coord:" title is the coordinator')|$(crd --title 'Coord: x' --right-of self | grep -c 'a "Coord:" title is the coordinator')|$(crd --title-free --title 'Coord: x' | grep -c 'a "Coord:" title is the coordinator')|$(crd --successor --title 'Coord: x' | grep -c 'a "Coord:" title is the coordinator')"
check "and that refusal exits 1" "1" "$(crd --title 'Coord: x' >/dev/null 2>&1; echo $?)"
for CRDFLAG in --successor --auditor '--left-of /dev/ttys555' '--right-of self' \
    --title-free '--tier deep' '--model m' --no-remote-control; do
  # shellcheck disable=SC2086 # the flag and its value are two words on purpose
  check "a coordinator-successor refuses $CRDFLAG" "1|1" \
    "$(crd --coordinator-successor --title 'Coord: x' $CRDFLAG >/dev/null 2>&1; echo $?)|$(crd --coordinator-successor --title 'Coord: x' $CRDFLAG | grep -c "is not a coordinator-successor's")"
done
check "a coordinator-successor with no readable pair is refused, naming where its transcript was looked for" "1" \
  "$(CLAUDE_CODE_SESSION_ID=s-crd-none ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" bash "$AGENT" spawn --dir "$WORK" --coordinator-successor --title 'Coord: x' --prompt p 2>&1 | grep -cF "no transcript for session s-crd-none under $ORCHESTRATOR_PROJECTS_DIR")"
check "--inherit-model beside --coordinator-successor asks for what is already implied" "1" \
  "$(crdl --coordinator-successor --inherit-model --title 'Coord: x' | grep -c -- '--model crd-model')"

# `rotate` and `move` treat the coordinator's tab as not the caller's to replace or place,
# exactly like an auditor's: read by its NAME in the process table, so a stale chain entry
# naming it moves nothing.
PSCRD="$WORK/ps-coord.txt"
printf '/dev/ttys950 /opt/x/claude --name Coord: ops\n/dev/ttys901 /opt/x/claude --name Agent: x\n' > "$PSCRD"
crdrot() { CLAUDE_CODE_SESSION_ID="${CLAUDE_CODE_SESSION_ID-s-suite}" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" ORCHESTRATOR_PS_TABLE="$PSCRD" \
  bash "$AGENT" rotate --dir "$WORK" --title "Agent: rotated" --prompt p $(needs_tier "$@") "$@" 2>&1; }
check "rotate refuses --coordinator-successor" "1" "$(crdrot --old-tty /dev/ttys901 --coordinator-successor | grep -c -- '--coordinator-successor is not a rotation')"
CRDROT=$(crdrot --old-tty /dev/ttys950)
check "rotate refuses the coordinator's tab before it spawns anything" "0|1|1" \
  "$(printf '%s' "$CRDROT" | grep -c '^launch=')|$(printf '%s' "$CRDROT" | grep -c "rotate: refused: /dev/ttys950 is the coordinator's tab ('Coord: ops')")|$(crdrot --old-tty /dev/ttys950 >/dev/null 2>&1; echo $?)"
check "--force rotates it, and says so" "1|1" \
  "$(crdrot --old-tty /dev/ttys950 --force | tail -1 | grep -c '^close=/dev/ttys950')|$(crdrot --old-tty /dev/ttys950 --force | grep -c "^rotate: forced: /dev/ttys950 is the coordinator's tab")"
# A paused orchestrator is relaunched with --wake: its recorded name, model and effort, right
# of the caller, in no chain, under remote control. Nothing is guessed: no model, no wake.
WKOUT=$(crd --wake --title 'Orch: alpha' --model a-model --effort high)
WKLAUNCH=$(printf '%s' "$WKOUT" | sed -n 's/^launch=//p')
check "a wake runs under its recorded name, model and effort, under remote control" "1|1|1|1" \
  "$(printf '%s' "$WKLAUNCH" | grep -c -- "--name 'Orch: alpha'")|$(printf '%s' "$WKLAUNCH" | grep -c -- '--model a-model --effort high')|$(printf '%s' "$WKLAUNCH" | grep -c -- "--remote-control 'Orch: alpha'")|$(printf '%s' "$WKOUT" | grep -c '^wake=yes$')"
check "a wake lands right of its caller and joins no chain" "1|1|1" \
  "$(printf '%s' "$WKOUT" | grep -c '^side=right$')|$(printf '%s' "$WKOUT" | grep -c '^anchor=self$')|$(printf '%s' "$WKOUT" | grep -c '^chain=none$')"
check "a wake with no pair to read runs on the host's default, and under another title it is refused" "0|none|host default|1|1" \
  "$(crd --wake --title 'Orch: alpha' | sed -n 's/^launch=//p' | grep -c -- '--model')|$(crd --wake --title 'Orch: alpha' | sed -n 's/^effort=//p')|$(crd --wake --title 'Orch: alpha' | sed -n 's/^pair_source=//p')|$(crd --wake --title 'Agent: alpha' --model m | grep -c -- '--wake needs the recorded name')|$(crd --wake --title 'Orch: alpha [abc123]' --model m >/dev/null 2>&1; echo $?)"
for WKFLAG in --successor --auditor '--right-of self' --title-free '--tier deep' --inherit-model --resident --no-remote-control; do
  # shellcheck disable=SC2086 # the flag and its value are two words on purpose
  check "a wake refuses $WKFLAG" "1|1" "$(crd --wake --title 'Orch: x' --model m $WKFLAG >/dev/null 2>&1; echo $?)|$(crd --wake --title 'Orch: x' --model m $WKFLAG | grep -c "is not a wake's")"
done
check "a wake beside --coordinator-successor is refused" "1" "$(crd --wake --coordinator-successor --title 'Orch: x' --model m >/dev/null 2>&1; echo $?)"
check "rotate refuses --wake" "1" "$(crdrot --old-tty /dev/ttys901 --wake | grep -c -- '--wake is not a rotation')"
# A woken orchestrator runs on the plan it slept on, whoever wakes it: the sleeping record's
# `config` is exported in its launch; a record without one is plan 1, and none exported; no record
# at all leaves the caller's own plan.
printf '[{"name":"Orch: plan2","config":"/plan/two"},{"name":"Orch: plan1"}]' > "$CRDSTATE/sleeping.json"
check "a wake exports the plan its sleeping record names, not its caller's" "1|0" \
  "$(crdl --wake --title 'Orch: plan2' --model m --effort high | grep -cF 'export CLAUDE_CONFIG_DIR=/plan/two &&')|$(crdl --wake --title 'Orch: plan2' --model m --effort high | grep -cF "$CRDCFG")"
check "a record with no config wakes on plan 1: nothing exported, though the caller runs on another plan" "0" \
  "$(crdl --wake --title 'Orch: plan1' --model m --effort high | grep -cF 'export CLAUDE_CONFIG_DIR')"
check "a wake no record names runs on its caller's plan" "1" \
  "$(crdl --wake --title 'Orch: other' --model m --effort high | grep -cF "export CLAUDE_CONFIG_DIR=$CRDCFG &&")"
mkdir -p "$WORK/wake-plan"
printf '{"projects":{"%s":{"hasTrustDialogAccepted":true}}}' "$WORK" > "$WORK/wake-plan/.claude.json"
printf '[{"name":"Orch: plan2","config":"%s"}]' "$WORK/wake-plan" > "$CRDSTATE/sleeping.json"
check "a wake trusts the checkout in its sleeper's own record, not its caller's" "already|unread" \
  "$(ORCHESTRATOR_TRUST_FILE= crd --wake --title 'Orch: plan2' --model m --effort high | sed -n 's/^trust=//p')|$(ORCHESTRATOR_TRUST_FILE= crd --wake --title 'Orch: other' --model m --effort high | sed -n 's/^trust=//p')"
rm -f "$CRDSTATE/sleeping.json"
check "a spawn exports its caller's plan, in a tab or a home window alike" "1|1" \
  "$(crdl --title 'Agent: plan' | grep -cF "export CLAUDE_CONFIG_DIR=$CRDCFG &&")|$(crdl --wake --title 'Orch: alpha' --model m --effort high | grep -cF "export CLAUDE_CONFIG_DIR=$CRDCFG &&")"
# A new orchestrator opened on the operator's order: by a coordinator or an orchestrator only,
# read by the caller's name, right of it, in no chain, under remote control, on the deep tier
# unless told. An agent, an auditor or a session with no name never opens one.
OPSTATE="$WORK/opstate"; mkdir -p "$OPSTATE/chains"; OPPS="$WORK/ps-open.txt"
opn() { local caller="$1"; shift
  if [ "$caller" = - ]; then printf '/dev/ttys900 /opt/x/claude\n' > "$OPPS"
  else printf '/dev/ttys900 /opt/x/claude --name %s\n' "$caller" > "$OPPS"; fi
  ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="${OPST:-$OPSTATE}" CLAUDE_CONFIG_DIR="${OPCFG:-$CRDCFG}" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-crd ORCHESTRATOR_PS_TABLE="$OPPS" ORCHESTRATOR_TIER_DEEP=deep-model \
  bash "$AGENT" spawn --dir "$WORK" --prompt p $(needs_tier "$@") "$@" 2>&1; }
OPOUT=$(opn 'Coord: ops' --open --title 'Orch: sync logs')
OPLAUNCH=$(printf '%s' "$OPOUT" | sed -n 's/^launch=//p')
check "an opening by the coordinator runs under its title, on the host's default pair, under remote control" "1|0|1|1" \
  "$(printf '%s' "$OPLAUNCH" | grep -c -- "--name 'Orch: sync logs'")|$(printf '%s' "$OPLAUNCH" | grep -c -- '--model deep-model')|$(printf '%s' "$OPLAUNCH" | grep -c -- "--remote-control 'Orch: sync logs'")|$(printf '%s' "$OPOUT" | grep -c '^open=yes$')"
check "an opened orchestrator lands right of its caller and joins no chain" "1|1|1" \
  "$(printf '%s' "$OPOUT" | grep -c '^side=right$')|$(printf '%s' "$OPOUT" | grep -c '^anchor=self$')|$(printf '%s' "$OPOUT" | grep -c '^chain=none$')"
check "an orchestrator launched under the former « Orch : gateway » opens one too" "1" \
  "$(opn 'Orch : gateway' --open --title 'Orch: x' | grep -c '^open=yes$')"
check "an orchestrator opens one too, and a model it names wins over the tier" "1|1" \
  "$(opn 'Orch: gateway' --open --title 'Orch: x' | grep -c '^open=yes$')|$(opn 'Orch: gateway' --open --title 'Orch: x' --model a-model --effort high | sed -n 's/^launch=//p' | grep -c -- '--model a-model')"
check "an agent, an auditor or a session with no name never opens one" "1|1|1|1" \
  "$(opn 'Agent: x' --open --title 'Orch: x' >/dev/null 2>&1; echo $?)|$(opn 'Agent: x' --open --title 'Orch: x' | grep -c 'an agent never opens an orchestrator')|$(opn 'Audit: x' --open --title 'Orch: x' | grep -c 'an agent never opens an orchestrator')|$(opn - --open --title 'Orch: x' | grep -c "this session reads 'no name'")"
# A new orchestrator is born on the plan asked with --plan: 1, 2, or auto by the quota files of
# the state directory; the caller's own plan when auto has no fresh reading of both. Only a
# birth is routed: an agent, a successor and an auditor take no --plan.
PLHOME="$WORK/plhome"; PLST="$WORK/plstate"; mkdir -p "$PLHOME" "$PLST/quota"
plq() { printf '{"version":1,"account":"%s","config":"%s","five_hour":{"used_percentage":%s,"resets_at":1},"seven_day":{"used_percentage":%s,"resets_at":2},"at":"%s"}' "$1" "$2" "$3" "$4" "$5" > "$PLST/quota/$1.json"; }
plopn() { HOME="$PLHOME" OPST="$PLST" opn 'Coord: ops' --open --title 'Orch: routed' "$@"; }
plexp() { plopn "$@" | sed -n 's/^launch=//p' | grep -oF "export CLAUDE_CONFIG_DIR=$PLHOME/.claude-bis &&" | head -1; }
check "--plan 2 opens the orchestrator on the second plan's directory, whatever its caller runs on" "export CLAUDE_CONFIG_DIR=$PLHOME/.claude-bis &&" "$(plexp --plan 2)"
check "--plan 1 opens it on plan 1: nothing exported, though its caller runs on another plan" "0|default" \
  "$(plopn --plan 1 | sed -n 's/^launch=//p' | grep -cF 'export CLAUDE_CONFIG_DIR')|$(plopn --plan 1 | sed -n 's/^plan=//p')"
check "with no --plan the opening keeps its caller's plan" "1|0" \
  "$(plopn | sed -n 's/^launch=//p' | grep -cF "export CLAUDE_CONFIG_DIR=$CRDCFG &&")|$(plopn | grep -c '^plan=')"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ); OLD=$(date -u -r $(( $(date +%s) - 3600 )) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)
plq acc1 "$PLHOME/.claude" 80 10 "$NOW"; plq acc2 "$PLHOME/.claude-bis" 20 30 "$NOW"
check "--plan auto takes the plan with the most room, a plan's room being what its fuller window leaves" "export CLAUDE_CONFIG_DIR=$PLHOME/.claude-bis &&" "$(plexp --plan auto)"
plq acc1 "$PLHOME/.claude" 10 5 "$NOW"; plq acc2 "$PLHOME/.claude-bis" 20 90 "$NOW"
check "and the other way round, the plan whose fuller window is the emptier" "0|default" \
  "$(plopn --plan auto | sed -n 's/^launch=//p' | grep -cF 'export CLAUDE_CONFIG_DIR')|$(plopn --plan auto | sed -n 's/^plan=//p')"
plq acc1 "$PLHOME/.claude" 10 5 "$OLD"
check "--plan auto with a stale reading keeps the caller's plan" "1" \
  "$(plopn --plan auto | sed -n 's/^launch=//p' | grep -cF "export CLAUDE_CONFIG_DIR=$CRDCFG &&")"
rm -f "$PLST/quota/acc1.json"
check "--plan auto with a plan unread keeps the caller's plan" "1" \
  "$(plopn --plan auto | sed -n 's/^launch=//p' | grep -cF "export CLAUDE_CONFIG_DIR=$CRDCFG &&")"
check "--plan 3 is refused, and so is --plan on an agent, a successor and an auditor" "1|1|1|1|1" \
  "$(plopn --plan 3 | grep -c -- '--plan is 1, 2 or auto')|$(opn 'Orch: gateway' --title 'Agent: a' --plan 2 | grep -c -- '--plan routes an orchestrator at its birth')|$(opn 'Orch: gateway' --successor --plan 2 | grep -c -- '--plan routes an orchestrator at its birth')|$(opn 'Orch: gateway' --auditor --title 'Audit: a' --plan 2 | grep -c -- '--plan routes an orchestrator at its birth')|$(opn 'Orch: gateway' --title 'Agent: a' --plan 2 >/dev/null 2>&1; echo $?)"
# A move across plans is a wake with --plan: the sleeper's record names the plan it slept on, --plan
# the one it wakes on, and the conversation of the former, which lives in that plan's directory, is
# not resumed on the latter.
printf '[{"name":"Orch: routed","config":"%s"}]' "$PLHOME/.claude-bis" > "$PLST/sleeping.json"
plwk() { HOME="$PLHOME" OPST="$PLST" opn 'Coord: ops' --wake --title 'Orch: routed' --model m --effort high "$@"; }
check "a wake on the plan the sleeper slept on keeps its conversation" "1|0" \
  "$(plwk --resume abc-1 | sed -n 's/^launch=//p' | grep -cE "'--resume' abc-1 ")|$(plwk --resume abc-1 2>&1 | grep -c 'starts a fresh conversation')"
check "--plan 1 moves it to plan 1: nothing exported, the conversation not resumed, the move said" "0|0|1" \
  "$(plwk --plan 1 --resume abc-1 | sed -n 's/^launch=//p' | grep -cF 'export CLAUDE_CONFIG_DIR')|$(plwk --plan 1 --resume abc-1 | sed -n 's/^launch=//p' | grep -c -- '--resume')|$(plwk --plan 1 --resume abc-1 2>&1 | grep -c 'the move to the other plan starts a fresh conversation')"
printf '[{"name":"Orch: routed"}]' > "$PLST/sleeping.json"
check "--plan 2 moves a plan 1 sleeper to the second plan's directory" "1" \
  "$(plwk --plan 2 | sed -n 's/^launch=//p' | grep -cF "export CLAUDE_CONFIG_DIR=$PLHOME/.claude-bis &&")"
check "--plan 2 on a sleeper already on plan 2 keeps its conversation" "1" \
  "$(printf '[{"name":"Orch: routed","config":"%s"}]' "$PLHOME/.claude-bis" > "$PLST/sleeping.json"; plwk --plan 2 --resume abc-1 | sed -n 's/^launch=//p' | grep -cE "'--resume' abc-1 ")"
printf '[{"name":"Orch: routed"}]' > "$PLST/sleeping.json"
check "a move to plan 2 drops the conversation of a plan 1 sleeper, the move said" "0|1" \
  "$(plwk --plan 2 --resume abc-1 | sed -n 's/^launch=//p' | grep -c -- '--resume')|$(plwk --plan 2 --resume abc-1 2>&1 | grep -c 'the move to the other plan starts a fresh conversation')"
check "a wake with --plan and no record for it keeps the --resume it was given" "1" \
  "$(rm -f "$PLST/sleeping.json"; plwk --plan 2 --resume abc-1 | sed -n 's/^launch=//p' | grep -cE "'--resume' abc-1 ")"
plq acc1 "$PLHOME/.claude" 90 10 "$NOW"; plq acc2 "$PLHOME/.claude-bis" 20 30 "$NOW"
printf '[{"name":"Orch: routed"}]' > "$PLST/sleeping.json"
check "--plan auto on a wake moves it to the plan with more room, and says so in the dry run" "1|1" \
  "$(plwk --plan auto | sed -n 's/^launch=//p' | grep -cF "export CLAUDE_CONFIG_DIR=$PLHOME/.claude-bis &&")|$(plwk --plan auto | grep -c "^plan=$PLHOME/.claude-bis$")"
rm -f "$PLST/quota/acc1.json"
check "--plan auto on a wake with no fresh reading of both stays on the sleeper's plan, and says so" "0|1" \
  "$(plwk --plan auto | sed -n 's/^launch=//p' | grep -cF 'export CLAUDE_CONFIG_DIR')|$(plwk --plan auto 2>&1 | grep -c -- '--plan auto has no fresh quota reading')"
check "so does an opening, on its caller's plan" "1|1" \
  "$(plopn --plan auto | sed -n 's/^launch=//p' | grep -cF "export CLAUDE_CONFIG_DIR=$CRDCFG &&")|$(plopn --plan auto 2>&1 | grep -c -- '--plan auto has no fresh quota reading')"
printf '{"version":true,"account":"acc1","config":"%s","five_hour":{"used_percentage":1,"resets_at":1},"at":"%s"}' "$PLHOME/.claude" "$NOW" > "$PLST/quota/acc1.json"
check "a quota file core's parseQuota would refuse (a boolean version) steers nothing" "1" \
  "$(plopn --plan auto | sed -n 's/^launch=//p' | grep -cF "export CLAUDE_CONFIG_DIR=$CRDCFG &&")"
printf '{"version":1,"account":"acc1","config":"%s","five_hour":{"used_percentage":1,"resets_at":1},"seven_day":"x","at":"%s"}' "$PLHOME/.claude" "$NOW" > "$PLST/quota/acc1.json"
check "and so does a window that is no window beside a good one" "1" \
  "$(plopn --plan auto | sed -n 's/^launch=//p' | grep -cF "export CLAUDE_CONFIG_DIR=$CRDCFG &&")"
# The staleness the launcher reads is core's.
check "the staleness the launcher reads is the quota contract's, 30 minutes" "QUOTA_STALE_AFTER_MS = 30 * 60 * 1000|QUOTA_STALE_AFTER = 30 * 60" \
  "$(grep -o 'QUOTA_STALE_AFTER_MS = 30 \* 60 \* 1000' "$ROOT/core/quota.ts")|$(grep -o 'QUOTA_STALE_AFTER = 30 \* 60' "$ROOT/skills/iterm-agents/scripts/iterm_agent.py")"
rm -f "$PLST/sleeping.json"
# A move across plans lands in a directory the target plan may never have opened: the wake is
# refused as any launch is, and --trust records it in the target plan's own record.
mkdir -p "$PLHOME/.claude-bis"; printf '{"projects":{}}' > "$PLHOME/.claude-bis/.claude.json"
PLST2="$WORK/plstate2"; mkdir -p "$PLST2"; printf '[{"name":"Orch: routed"}]' > "$PLST2/sleeping.json"
plmove() { HOME="$PLHOME" OPST="$PLST2" ORCHESTRATOR_TRUST_FILE= opn 'Coord: ops' --wake --title 'Orch: routed' --model m --effort high --plan 2 "$@"; }
check "a move to a plan that never opened the directory is refused without --trust, and recorded with it" "1|recorded" \
  "$(plmove | grep -c 'the host has not been told to trust')|$(plmove --trust | sed -n 's/^trust=//p')"
OPREC="$WORK/opstate-rec"; mkdir -p "$OPREC/chains"
printf '{"name":"Coord: hand","tty":"/dev/ttys900"}\n' > "$OPREC/coordinator.json"
check "a coordinator opened by hand, named only by its own record, opens one" "1" \
  "$(OPST="$OPREC" opn - --open --title 'Orch: x' | grep -c '^open=yes$')"
OPRECOLD="$WORK/opstate-rec-former"; mkdir -p "$OPRECOLD/chains"
printf '{"name":"Coord : hand","tty":"/dev/ttys900"}\n' > "$OPRECOLD/coordinator.json"
check "a coordinator whose record reads the former « Coord : hand » opens one too" "1" \
  "$(OPST="$OPRECOLD" opn - --open --title 'Orch: x' | grep -c '^open=yes$')"
# A launch routed to an account is refused when the host would stop it on a first-start dialog:
# read in the account's own `.claude.json`, which is never written. A record that cannot be read
# is warned of, and the launch goes on.
ACHOME="$WORK/achome"; ACST="$WORK/acstate"; ACFILE="$ACHOME/.claude-bis/.claude.json"
mkdir -p "$ACHOME/.claude-bis" "$ACST"
ACGATE='"cachedGrowthBookFeatures":{"tengu_chrome_auto_enable":true}'
acrec() { printf '{%s}' "$1" > "$ACFILE"; }
acopn() { HOME="$ACHOME" OPST="$ACST" opn 'Coord: ops' --open --title 'Orch: routed' --plan 2 --permission-mode auto "$@"; }
acrefused() { acopn | grep -c "spawn: refused: the account of $ACFILE has not passed $1"; }
acrec '"hasCompletedOnboarding":true,"cachedChromeExtensionInstalled":true,'"$ACGATE"
check "an account with the extension and no answer to its first start is refused, the key and the hand step named" "1|0|1" \
  "$(acrefused 'the browser extension dialog (claudeInChromeDefaultEnabled absent)')|$(acopn | grep -c '^launch=')|$(acopn | grep -cF "CLAUDE_CONFIG_DIR=$ACHOME/.claude-bis claude --permission-mode auto\` and answer the dialog")"
acrec '"hasCompletedOnboarding":true,"chromeExtension":{"pairedDeviceId":"d1"},'"$ACGATE"
check "a paired browser is the extension detected too" "1" "$(acrefused 'the browser extension dialog')"
check "the host shows that dialog in another mode than auto too, which is refused" "1" \
  "$(acopn --permission-mode acceptEdits | grep -c 'has not passed the browser extension dialog')"
check "a bypassPermissions launch is offered no such dialog, and passes" "1|0" \
  "$(acopn --permission-mode bypassPermissions | grep -c '^launch=')|$(acopn --permission-mode bypassPermissions | grep -c 'has not passed')"
check "the refusal names the step that records the answer when no dialog shows, which lifts it" "1" \
  "$(acopn | grep -cF 'and answer the dialog; if it shows none, type /chrome there and select « Turn on by default », which records the answer')"
acrec '"numStartups":1'
check "a bypassPermissions launch is still refused on an onboarding not passed" "1|0" \
  "$(acopn --permission-mode bypassPermissions | grep -c 'has not passed the onboarding')|$(acopn --permission-mode bypassPermissions | grep -c '^launch=')"
check "an onboarding refusal names no step of the browser dialog" "0" "$(acopn | grep -cF '/chrome')"
ACPASS=''
for ACANSWER in true false; do
  acrec '"hasCompletedOnboarding":true,"cachedChromeExtensionInstalled":true,"claudeInChromeDefaultEnabled":'"$ACANSWER,$ACGATE"
  ACPASS="$ACPASS$(acopn | grep -c '^launch=')|$(acopn | grep -c 'first.start');"
done
check "either answer to the dialog passes, with no warning" "1|0;1|0;" "$ACPASS"
acrec '"hasCompletedOnboarding":true,'"$ACGATE"
check "an account whose extension is not recorded is offered nothing, and passes" "1|0" \
  "$(acopn | grep -c '^launch=')|$(acopn | grep -c 'first.start')"
acrec '"hasCompletedOnboarding":true,"cachedChromeExtensionInstalled":true,"cachedGrowthBookFeatures":{"tengu_chrome_auto_enable":false}'
check "an account the host's gate offers nothing passes" "1" "$(acopn | grep -c '^launch=')"
acrec '"numStartups":1'
check "an account that has not passed the onboarding is refused naming it" "1|0" \
  "$(acrefused 'the onboarding (hasCompletedOnboarding)')|$(acopn | grep -c '^launch=')"
ACWARN=''
for ACBROKEN in absent 'not json' '[1]' '{"projects":{}}'; do
  if [ "$ACBROKEN" = absent ]; then rm -f "$ACFILE"; else printf '%s' "$ACBROKEN" > "$ACFILE"; fi
  ACWARN="$ACWARN$(acopn | grep -c '^launch=')|$(acopn | grep -c "spawn: warning: whether the account of $ACFILE passed its first-start dialogs is unknown");"
done
check "a record absent, unreadable or of another shape is warned of, and the launch goes on" "1|1;1|1;1|1;1|1;" "$ACWARN"
acrec '"numStartups":1'
printf '[{"name":"Orch: routed","config":"%s"}]' "$ACHOME/.claude-bis" > "$ACST/sleeping.json"
check "a wake onto a plan other than its caller's is checked with no --plan" "1" \
  "$(HOME="$ACHOME" OPST="$ACST" opn 'Coord: ops' --wake --title 'Orch: routed' --model m --effort high | grep -c 'has not passed the onboarding')"
rm -f "$ACST/sleeping.json"
check "--plan is checked even when its caller already runs on that plan" "1|0" \
  "$(OPCFG="$ACHOME/.claude-bis" acrefused 'the onboarding')|$(OPCFG="$ACHOME/.claude-bis" acopn | grep -c '^launch=')"
printf '{"numStartups":1}' > "$ACHOME/.claude.json"
check "a route to plan 1 reads the record in the home directory, and the hand step unsets the plan variable" "1|1|0" \
  "$(acopn --plan 1 | grep -cF "the account of $ACHOME/.claude.json has not passed the onboarding")|$(acopn --plan 1 | grep -cF 'env -u CLAUDE_CONFIG_DIR claude --permission-mode auto')|$(acopn --plan 1 | grep -c '^launch=')"
rm -f "$ACHOME/.claude.json"
# The account is read before anything is written: a directory the host never opened, which a
# launch is refused for, is not reached when the account is.
ACSUM=$(cksum < "$ACFILE")
check "the account is refused before the directory's trust is read, its record left as it was" "1|0|same" \
  "$(acopn --dir "$UNTRUSTED" | grep -c 'has not passed the onboarding')|$(acopn --dir "$UNTRUSTED" | grep -c 'has not been told to trust')|$([ "$(cksum < "$ACFILE")" = "$ACSUM" ] && echo same || echo changed)"
acrec '"hasCompletedOnboarding":true'
check "and that directory is refused on its trust once the account passes" "1" \
  "$(acopn --dir "$UNTRUSTED" | grep -c 'has not been told to trust')"
acrec '"numStartups":1'
check "a launch that stays on its caller's plan reads no account record" "1|0" \
  "$(HOME="$ACHOME" OPST="$ACST" opn 'Coord: ops' --open --title 'Orch: routed' | grep -c '^launch=')|$(HOME="$ACHOME" OPST="$ACST" opn 'Coord: ops' --open --title 'Orch: routed' | grep -c 'first.start')"
check "an opening needs an orchestrator's title, with no reference" "1|1" \
  "$(opn 'Coord: ops' --open --title 'Agent: x' | grep -c -- "--open needs the new orchestrator's name")|$(opn 'Coord: ops' --open --title 'Orch: x [abc123]' >/dev/null 2>&1; echo $?)"
for OPFLAG in --successor --auditor --wake '--right-of self' '--left-of /dev/ttys555' --title-free --resident --no-remote-control; do
  # shellcheck disable=SC2086 # the flag and its value are two words on purpose
  check "an opening refuses $OPFLAG" "1|0" "$(opn 'Coord: ops' --open --title 'Orch: x' $OPFLAG >/dev/null 2>&1; echo $?)|$(opn 'Coord: ops' --open --title 'Orch: x' $OPFLAG | grep -c '^launch=')"
done
check "rotate refuses --open" "1" "$(crdrot --old-tty /dev/ttys901 --open | grep -c -- '--open is not a rotation')"
check "an opening refuses a tier: its pair is the order's or the host's default" "1|0" \
  "$(ORCHESTRATOR_TIER_STANDARD=std-model opn 'Coord: ops' --open --title 'Orch: x' --tier standard | grep -c -- "--tier is not an opening's")|$(ORCHESTRATOR_TIER_STANDARD=std-model opn 'Coord: ops' --open --title 'Orch: x' --tier standard | grep -c '^launch=')"
# Outside a dry run the caller is read from the real process table: the suite's two
# stand-ins would let any session name itself the coordinator. The directory does not
# exist, so a launcher that let the stand-ins through still stops short of a tab.
check "outside a dry run, an opening refuses the suite's stand-ins for the caller" "1|1" \
  "$(env -u ORCHESTRATOR_DRY_RUN ORCHESTRATOR_STATE_DIR="$OPSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_PS_TABLE="$OPPS" bash "$AGENT" spawn --open --title 'Orch: x' --dir "$WORK/no-such-dir" --prompt p 2>&1 | grep -c 'are for tests and dry runs')|$(env -u ORCHESTRATOR_DRY_RUN ORCHESTRATOR_STATE_DIR="$OPSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 bash "$AGENT" spawn --open --title 'Orch: x' --dir "$WORK/no-such-dir" --prompt p 2>&1 | grep -c 'are for tests and dry runs')"
check "outside a dry run, a wake refuses the same stand-ins, and names itself" "1|1|1" \
  "$(env -u ORCHESTRATOR_DRY_RUN ORCHESTRATOR_STATE_DIR="$OPSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_PS_TABLE="$OPPS" bash "$AGENT" spawn --wake --title 'Orch: x' --model a-model --effort high --dir "$WORK/no-such-dir" --prompt p 2>&1 | grep -c 'are for tests and dry runs')|$(env -u ORCHESTRATOR_DRY_RUN ORCHESTRATOR_STATE_DIR="$OPSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 bash "$AGENT" spawn --wake --title 'Orch: x' --model a-model --effort high --dir "$WORK/no-such-dir" --prompt p 2>&1 | grep -c -- '--wake reads its caller')|$(env -u ORCHESTRATOR_DRY_RUN ORCHESTRATOR_STATE_DIR="$OPSTATE" ORCHESTRATOR_PS_TABLE="$OPPS" bash "$AGENT" spawn --wake --title 'Orch: x' --model a-model --effort high --dir "$WORK/no-such-dir" --prompt p 2>&1 | grep -c 'are for tests and dry runs')"
check "an agent's tab still rotates without --force" "1" "$(crdrot --old-tty /dev/ttys901 | tail -1 | grep -c '^close=/dev/ttys901')"
# The first coordinator is opened by hand and names itself through a rename, which never
# reaches argv: named only in the host registry, or only in the coordinator's own record,
# its tab is still not an agent to rotate or to move.
CRDREGCFG="$WORK/crdregcfg"; mkdir -p "$CRDREGCFG/sessions"
printf '{"pid":6161,"name":"Coord: hand"}\n' > "$CRDREGCFG/sessions/6161.json"
printf '/dev/ttys951 6161 claude --resume x\n/dev/ttys952 6262 claude --resume y\n' > "$WORK/ps-coord-reg.txt"
crdregrot() { CLAUDE_CODE_SESSION_ID="${CLAUDE_CODE_SESSION_ID-s-suite}" CLAUDE_CONFIG_DIR="$CRDREGCFG" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$1" ORCHESTRATOR_PS_TABLE="$WORK/ps-coord-reg.txt" \
  bash "$AGENT" rotate --dir "$WORK" --title "Agent: rotated" --prompt p --tier light --old-tty "$2" 2>&1; }
CRDREGROT=$(crdregrot "$CRDSTATE" /dev/ttys951)
check "rotate refuses a coordinator named only in the host registry" "0|1" \
  "$(printf '%s' "$CRDREGROT" | grep -c '^launch=')|$(printf '%s' "$CRDREGROT" | grep -c "rotate: refused: /dev/ttys951 is the coordinator's tab ('Coord: hand')")"
CRDRECSTATE="$WORK/crdrecstate"; mkdir -p "$CRDRECSTATE"
printf '{"name":"Coord: rec [abc123]","tty":"/dev/ttys952"}\n' > "$CRDRECSTATE/coordinator.json"
CRDRECROT=$(crdregrot "$CRDRECSTATE" /dev/ttys952)
check "rotate refuses the tty the coordinator's record registers" "0|1" \
  "$(printf '%s' "$CRDRECROT" | grep -c '^launch=')|$(printf '%s' "$CRDRECROT" | grep -c "rotate: refused: /dev/ttys952 is the coordinator's tab ('Coord: rec \[abc123\]')")"
check "and move names it, forced or not" "1|1" \
  "$(CLAUDE_CONFIG_DIR="$CRDREGCFG" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDRECSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_SELF_ID=S-ME ORCHESTRATOR_PS_TABLE="$WORK/ps-coord-reg.txt" bash "$AGENT" move --tty /dev/ttys952 --right-of self 2>&1 | grep -c "move: refused: /dev/ttys952 is the coordinator's tab")|$(CLAUDE_CONFIG_DIR="$CRDREGCFG" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDRECSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_SELF_ID=S-ME ORCHESTRATOR_PS_TABLE="$WORK/ps-coord-reg.txt" bash "$AGENT" move --tty /dev/ttys952 --right-of self --force 2>&1 | grep -c "^move: forced: /dev/ttys952 is the coordinator's tab")"
printf '{"tab_id":"9","tty":"/dev/ttys950","owner":"S-ME"}\n' >> "$CRDSTATE/chains/ttys900.jsonl"
crdmv() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME ORCHESTRATOR_PS_TABLE="$PSCRD" bash "$AGENT" move "$@" 2>&1; }
check "the coordinator's tab is not moved, even with a stale chain entry naming it" "1|1" \
  "$(crdmv --tty /dev/ttys950 --right-of self >/dev/null 2>&1; echo $?)|$(crdmv --tty /dev/ttys950 --right-of self | grep -c "move: refused: /dev/ttys950 is the coordinator's tab ('Coord: ops'), not this session's to place (pass --force to move it anyway)")"
check "--force moves it, and says so" "0|1" \
  "$(crdmv --tty /dev/ttys950 --right-of self --force >/dev/null 2>&1; echo $?)|$(crdmv --tty /dev/ttys950 --right-of self --force | grep -c "^move: forced: /dev/ttys950 is the coordinator's tab")"
check "the coordinator's tab is not moved leftmost either" "1|1" \
  "$(crdmv --tty /dev/ttys950 --leftmost >/dev/null 2>&1; echo $?)|$(crdmv --tty /dev/ttys950 --leftmost | grep -c "move: refused: /dev/ttys950 is the coordinator's tab ('Coord: ops'), not this session's to place (pass --force to move it anyway)")"
check "--force moves it leftmost too, and says so" "0|1" \
  "$(crdmv --tty /dev/ttys950 --leftmost --force >/dev/null 2>&1; echo $?)|$(crdmv --tty /dev/ttys950 --leftmost --force | grep -c "^move: forced: /dev/ttys950 is the coordinator's tab")"
check "an agent of the chain still moves" "1" "$(crdmv --tty /dev/ttys901 --right-of self | grep -c '^move=/dev/ttys901 right_of=/dev/ttys900$')"
check "the coordinator's own tab moves leftmost, by itself" "1" \
  "$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys950 ORCHESTRATOR_SELF_ID=S-ME ORCHESTRATOR_PS_TABLE="$PSCRD" bash "$AGENT" move --tty /dev/ttys950 --leftmost | grep -c '^move=/dev/ttys950 left_of=leftmost$')"

# The launcher's documentation names the move --leftmost form; the coordinator's placement
# is explained where it is used, the start command and the successor's brief, so a session
# that loads the launcher's skill, the orchestrator's or a brief template reads nothing of
# the coordinator. The entry point's header still lists both forms.
ITERMSKILL="$ROOT/skills/iterm-agents/SKILL.md"
ITERMCMDS="$ROOT/skills/iterm-agents/references/commands.md"
ITERMSH="$ROOT/skills/iterm-agents/scripts/iterm-agent.sh"
# Text the rulings overtook must not come back: the opening takes no tier, a succession reads the
# transcript with or without --inherit-model, and the measure file feeds no launch.
check "no text still says the opening takes the deep tier, the succession depends on --inherit-model or the measure file feeds it" "0|0|0" \
  "$(grep -c 'on the deep tier unless told' "$ROOT/docs/design.md")|$(grep -cE 'whether or not (it is typed|--inherit-model)|^ *# +--inherit-model is typed' "$ITERMCMDS")|$(grep -c -- "launcher's \`--inherit-model\` takes the model" "$ROOT/README.md")"
coord_outside_routing() {
  awk 'BEGIN { RS = "" } { p = $0; gsub(/(^|\n)allowed-tools:[^\n]*/, "", p) }
    tolower(p) ~ /coordinat/ && p !~ /^\*\*While a coordinator runs/ { print FILENAME }' "$@"
}

# The coordinator's own rulebook and its two commands. The judgment is prose, so what is
# checked here is that every command line the prose hands the session is one the tooling
# runs — the succession's spawn line and the start's leftmost move are taken out of the text
# A skill and a command of one plugin share one address, `orchestrator:<name>`, and the host
# resolves it to the command: a skill named like a command is never loaded by its name, and a
# command that says « load that skill first » loads itself. The coordinator's skill was first
# named like its start command, and a staged coordinator read the start steps as its rulebook.
name_collisions() {  # <skills dir> <commands dir>: one line per name both carry
  local s n
  for s in "$1"/*/SKILL.md; do
    n=$(sed -n 's/^name: //p' "$s" | head -1)
    [ -f "$2/$n.md" ] && echo "collision:$n"
    [ -f "$2/$(basename "$(dirname "$s")").md" ] && echo "collision:$(basename "$(dirname "$s")")"
  done | sort -u
}
check "no skill and no command of the plugin share a name" "" "$(name_collisions "$ROOT/skills" "$ROOT/commands")"
NCCMDS="$WORK/collision-commands"; mkdir -p "$NCCMDS"; cp "$ROOT"/commands/*.md "$NCCMDS"/; cp "$COORDCMD" "$NCCMDS/coordination.md"
check "a command planted under a skill's name falls the check, and names it" "collision:coordination" \
  "$(name_collisions "$ROOT/skills" "$NCCMDS")"
# The short names (the operator's rulings of 2026-10-24 and 2026-10-25): the plugin's commands
# carry no `name:`, so the typeahead reads `/orchestrator:<file>` as it did, and the short names,
# the coordinator's `coordinator-…`, the others `orchestrator-…`, come from `short-names.tsv`,
# which the installer writes as user commands. Only a command the model is not offered
# (`disable-model-invocation: true`) has one: the model's list already holds every other as
# `orchestrator:<file>`, and a copy would list it twice. A command file of that kind the table does
# not know is one whose short name nobody chose; one of the other kind the table names is doubled.
# The pane has one command, for both roles (rule 229 of the rules
# review, the operator's ruling of 2026-11-04: « B, Ne garder que /orchestrator:supervision »).
COMMAND_NAMES='audit:orchestrator-audit coordinator:coordinator coordinator-end:coordinator-end install:orchestrator-install sleeping:orchestrator-sleeping supervision:orchestrator-supervision uninstall:orchestrator-uninstall'
short_names_wrong() {  # <commands dir> <table>: one line per command named, unnamed, unknown or doubled
  local pair f stem listed
  for f in "$1"/*.md; do
    stem=$(basename "$f" .md)
    awk 'NR == 1 { next } /^---$/ { exit } { print }' "$f" | grep -q '^name: ' && echo "named:$stem"
    listed=yes; awk -F '\t' -v s="$stem" '$2 == s { found = 1 } END { exit !found }' "$2" || listed=no
    if awk 'NR == 1 { next } /^---$/ { exit } { print }' "$f" | grep -qx 'disable-model-invocation: true'; then
      [ "$listed" = yes ] || echo "unknown:$stem"
    else
      [ "$listed" = no ] || echo "doubled:$stem"
    fi
  done
  for pair in $COMMAND_NAMES; do
    awk -F '\t' -v s="${pair#*:}" -v f="${pair%%:*}" '$1 == s && $2 == f { found = 1 } END { exit !found }' "$2" \
      || echo "missing:${pair%%:*}"
  done
}
check "no command carries a name, and the table gives each its short name" "" \
  "$(short_names_wrong "$ROOT/commands" "$ROOT/short-names.tsv")"
SNCMDS="$WORK/short-name-commands"; mkdir -p "$SNCMDS"; cp "$ROOT"/commands/*.md "$SNCMDS"/
awk 'NR == 2 { print "name: orchestrator-status" } { print }' "$ROOT/commands/status.md" > "$SNCMDS/status.md"
cp "$ROOT/commands/sleeping.md" "$SNCMDS/stray.md"; { grep -v '^orchestrator-audit' "$ROOT/short-names.tsv"; printf 'orchestrator-status\tstatus\n'; } > "$WORK/short-names.tsv"
check "a command with a name, one the table does not know, one it lost and one it doubles fail the check" "unknown:audit|named:status|doubled:status|unknown:stray|missing:audit" \
  "$(short_names_wrong "$SNCMDS" "$WORK/short-names.tsv" | paste -sd'|' -)"
check "the pane has one command, the coordinator's copy gone from the commands and the table" "no|0" \
  "$([ -e "$ROOT/commands/coordinator-supervision.md" ] && echo yes || echo no)|$(grep -c 'coordinator-supervision' "$ROOT/short-names.tsv")"
# One short line each (the operator, 2026-10-25: ten to fifteen words at most, no more): the typeahead
# draws a description beside its name and wraps a long one on two rows.
long_descriptions() {  # <commands dir>: one line per command whose description is too long
  local f d
  for f in "$1"/*.md; do
    d=$(awk 'NR == 1 { next } /^---$/ { exit } { print }' "$f" | sed -n 's/^description: //p')
    [ -n "$d" ] || { echo "none:$(basename "$f" .md)"; continue; }
    [ "$(printf '%s' "$d" | wc -w | tr -d ' ')" -le 15 ] && [ "$(printf '%s' "$d" | LC_ALL=en_US.UTF-8 wc -m | tr -d ' ')" -le 60 ] \
      || echo "long:$(basename "$f" .md)"
  done
}
check "every command's description is at most 15 words and 60 characters" "" "$(long_descriptions "$ROOT/commands")"
LDCMDS="$WORK/long-descriptions"; mkdir -p "$LDCMDS"
printf -- '---\ndescription: one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen\n---\n' > "$LDCMDS/words.md"
printf -- '---\ndescription: %s\n---\n' "$(printf 'x%.0s' $(seq 1 61))" > "$LDCMDS/chars.md"
printf -- '---\ndescription: Open the supervision pane\n---\n' > "$LDCMDS/short.md"
check "sixteen words, or sixty-one characters, fail the check" "long:chars|long:words" "$(long_descriptions "$LDCMDS" | paste -sd'|' -)"
check "each coordinator command carries its description and its allowed tools" "1|1|1|1" \
  "$(sed -n '1,5p' "$COORDCMD" | grep -c '^description: ')|$(sed -n '1,5p' "$COORDCMD" | grep -c '^allowed-tools: .*coordinator\.sh')|$(sed -n '1,5p' "$COORDEND" | grep -c '^description: ')|$(sed -n '1,5p' "$COORDEND" | grep -c '^allowed-tools: .*coordinator\.sh')"
# Topic 6.3, the operator's ruling of 2026-10-31: the answer the coordinator settles is sent in the
# same call (the settle tool, hooks/question.ts), never at the round's next reading, to the asker of
# a question asked with `ask`; a closing proposal's close sends nothing. The header and the design say so.
check "the header and the design send a question's answer in the settle call, not at the next reading" "yes|yes|no|yes|no" \
  "$(spells "$ROOT/skills/coordinator/scripts/coordinator.sh" "sends a question asked with \`ask\` its answer in the same call")|$(spells "$ROOT/skills/coordinator/scripts/coordinator.sh" "close of a closing proposal sends nothing")|$(spells "$ROOT/skills/coordinator/scripts/coordinator.sh" "the coordinator's hooks module sends the answer at")|$(spells "$ROOT/docs/design.md" 'sends its asker the answer in the same call')|$(spells "$ROOT/docs/design.md" 'sends that answer at its next round reading')"
# Rule 219: the paragraph on the coordinator, up to its 2026-11-03 sentence, lightened from 650.
# 400 until the sender's account came back (the operator's ruling of 2026-11-04, « restore
# everything and fix », after an independent control).
check "the decision round's coordinator paragraph stays at 450 characters or fewer" "yes" \
  "$([ "$(sed -n '/^\*\*While a coordinator runs, the wave goes through it\*\*/,/^His answer there is his ruling/p' "$ROOT/commands/decide.md" | sed '$d' | wc -m | tr -d ' ')" -le 450 ] && echo yes || echo no)"
# The module carries each question; the round sending them itself as well delivered one question twice.
check "the decision round no longer looks the coordinator up or sends it the questions itself, and stays at 8,800 bytes or fewer" "no|no|0|yes" \
  "$(spells "$ROOT/commands/decide.md" 'coordinator.sh lookup')|$(spells "$ROOT/commands/decide.md" 'goes to that coordinator with `SendMessage`')|$(sed -n '1,5p' "$ROOT/commands/decide.md" | grep -c '^allowed-tools: .*coordinator\.sh')|$([ "$(wc -c < "$ROOT/commands/decide.md" | tr -d ' ')" -le 8800 ] && echo yes || echo no)"
# The machine-wide decide is run by its script: the command runs it and does what its first line
# says, the round's steps being the coordination skill's, never copied into the command.
CDECIDE="$ROOT/commands/coordinator-decide.md"
check "coordinator-decide runs round --decide and does what its line says, holds no state machine, and is listed" \
  "yes|0|1|yes" \
  "$(spells "$CDECIDE" 'and do what its first line says')|$(grep -c 'decide: machine' "$CDECIDE")|$(sed -n '1,5p' "$CDECIDE" | grep -c '^allowed-tools: .*coordinator\.sh.*mcp__orchestrator__settle')|$(spells "$ROOT/README.md" '| `/orchestrator:coordinator-decide` |')"
COORDSPAWN=$(grep -m1 -o 'iterm-agent.sh spawn --coordinator-successor.*' "$ROOT/skills/coordination/references/succession.md" 2>/dev/null | sed -e 's/^iterm-agent.sh spawn //' \
  -e 's#<subject>#ops#' -e "s#<your working directory>#$WORK#" -e 's#${CLAUDE_PLUGIN_ROOT}#/plugin#g')
coordspawn() { eval "set -- $COORDSPAWN"; ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" CLAUDE_CONFIG_DIR="$CRDCFG" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-crd bash "$AGENT" spawn $(needs_tier "$@") "$@" 2>&1; }
COORDSPAWNOUT=$(if [ -n "$COORDSPAWN" ]; then coordspawn; else echo "no spawn line"; fi)
check "the skill's succession spawn line is one the launcher runs as the coordinator's successor" "1|1|1|1" \
  "$(printf '%s' "$COORDSPAWNOUT" | grep -c '^coordinator_successor=yes$')|$(printf '%s' "$COORDSPAWNOUT" | grep -c '^anchor=leftmost$')|$(printf '%s' "$COORDSPAWNOUT" | grep -c '^chain=none$')|$(printf '%s' "$COORDSPAWNOUT" | sed -n 's/^launch=//p' | grep -c -- "--name 'Coord: ops'")"

# The start renames itself through the plugin's tool before it registers, and places its tab.
COORDLINE() { grep -n -m1 -F -- "$2" "$1" | cut -d: -f1; }
check "the start renames itself before it registers" "1" \
  "$([ "$(COORDLINE "$COORDCMD" 'Call `mcp__orchestrator__rename_session` with `Coord: <subject>`')" -lt "$(COORDLINE "$COORDCMD" 'coordinator.sh register --name')" ] 2>/dev/null && echo 1 || echo 0)"
COORDMOVE=$(grep -m1 -o 'iterm-agent.sh move --tty <your tty> --leftmost' "$COORDCMD" 2>/dev/null | sed -e 's/^iterm-agent.sh move //' -e 's#<your tty>#/dev/ttys950#')
check "the command's move line puts the coordinator's own tab leftmost" "1" \
  "$(if [ -n "$COORDMOVE" ]; then eval "set -- $COORDMOVE"; ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys950 ORCHESTRATOR_SELF_ID=S-ME ORCHESTRATOR_PS_TABLE="$PSCRD" bash "$AGENT" move "$@" 2>&1 | grep -c '^move=/dev/ttys950 left_of=leftmost$'; else echo 0; fi)"

# The operator's ruling of 2026-11-20: a coordinator opened fresh opens its supervision pane at its
# start, after it registered; a succession keeps the pane its predecessor had (the module puts it
# back as it was), so neither its brief nor its steps open one. The opening is a step of the
# command, not code: the module cannot tell a fresh start from a successor.
COORDOPEN='Then call `mcp__orchestrator__supervision` with `open`'
check "a fresh start opens the supervision pane after it registered, a succession's brief and steps open none" "1|no|no" \
  "$([ "$(COORDLINE "$COORDCMD" 'coordinator.sh register --name')" -lt "$(COORDLINE "$COORDCMD" "$COORDOPEN")" ] 2>/dev/null && echo 1 || echo 0)|$(spells "$COORDTPL" 'mcp__orchestrator__supervision')|$(spells "$ROOT/skills/coordination/references/succession.md" 'mcp__orchestrator__supervision')"

# The end clears only the recorded coordinator's record: run from the wrong tab it would end
# a coordinator nobody asked to end.
check "the end checks this session is the recorded coordinator before it clears" "1" \
  "$([ "$(COORDLINE "$COORDEND" '**This session is the recorded coordinator.**')" -lt "$(COORDLINE "$COORDEND" 'coordinator.sh clear')" ] 2>/dev/null && echo 1 || echo 0)"

# A coordinator started by hand is closed too, nothing asked: its title is the host's, the
# host may refuse the close, and the end it then asks for is proved on the tty, not on list.
COORDFILLED="$WORK/coordinator-brief-filled.md"
mkdir -p "$WORK/coord-fill/coordinator" "$WORK/coord-fill/scratch"; : > "$WORK/coord-fill/coordinator/notes.md"; : > "$WORK/coord-fill/scratch/decision-round.md"
if [ -f "$COORDTPL" ]; then
  sed -E -e 's#\{\{PREDECESSOR\}\}#Coord: ops [a1b2c3]#g' -e 's#\{\{PREDECESSOR_TTY\}\}#/dev/ttys950#g' -e 's#\{\{SUBJECT\}\}#ops#g' \
    -e "s#\{\{STATE_DIR\}\}#$WORK/coord-fill#g" -e "s#\{\{NOTES_FILE\}\}#$WORK/coord-fill/coordinator/notes.md#g" -e "s#\{\{ROUND_FILE\}\}#$WORK/coord-fill/scratch/decision-round.md#g" \
    -e "s#\{\{COORDINATOR_SH\}\}#$ROOT/skills/coordinator/scripts/coordinator.sh#g" -e "s#\{\{ITERM_AGENT_SH\}\}#$AGENT#g" \
    -e "s#\{\{[A-Z_]+\}\}#$WORK#g" "$COORDTPL" > "$COORDFILLED"
fi
check "the coordinator's succession brief, filled with a real predecessor's values, lints clean" "yes|0" \
  "$([ -s "$COORDFILLED" ] && echo yes || echo no)|$(bash "$ROOT/skills/orchestrator/scripts/brief-lint.sh" "$COORDFILLED" >/dev/null 2>&1; echo $?)"

# `/orchestrator-audit` (§52): the brief instantiated and linted, the auditor spawned with
# the launcher's own flag and verified on the artifact. The spawn line is not only spelled:
# it is taken out of the command and run dry through the launcher, so a command that drifts
# from the launcher's flags falls here.
AUDCMD="$ROOT/commands/audit.md"
AUDSPAWN=$(grep -m1 -o 'iterm-agent.sh spawn .*' "$AUDCMD" 2>/dev/null | sed -e 's/^iterm-agent.sh spawn //' -e 's/`.*$//' \
  -e "s#<repository>#$WORK#" -e 's#<subject>#tm#' -e 's#<brief path>#/tmp/audit-brief.md#')
audspawn() { eval "set -- $AUDSPAWN"; ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" CLAUDE_CONFIG_DIR="$AUDCFG" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-aud bash "$AGENT" spawn $(needs_tier "$@") "$@" 2>&1; }
AUDSPAWNOUT=$(if [ -n "$AUDSPAWN" ]; then audspawn; else echo "no spawn line"; fi)
check "the command's spawn line is one the launcher runs as an auditor" "1|1|1|1" \
  "$(printf '%s' "$AUDSPAWNOUT" | grep -c '^auditor=yes$')|$(printf '%s' "$AUDSPAWNOUT" | grep -c '^name=Audit: tm$')|$(printf '%s' "$AUDSPAWNOUT" | grep -c '^chain=none$')|$(printf '%s' "$AUDSPAWNOUT" | sed -n 's/^launch=//p' | grep -c -- "--permission-mode auto")"
check "and it carries neither a tier, nor a successor's flag, nor an anchor" "0" \
  "$(printf '%s' "$AUDSPAWN" | grep -cE -- '--tier|--successor|--right-of|--left-of')"

# The audit brief (§52), filled, lints clean: a template whose own text trips the lint would
# reach every auditor with a finding its caller learned to ignore. The report path is one the
# auditor creates, so it cannot exist when the brief is linted (issue #52): the command names
# it to the lint as created later, and the lint exempts exactly it — a second absent path in
# the same brief is still a finding.
AUDBRIEF="$ROOT/templates/agent-audit-brief.md"
# Rule 78 of the rules review, on the ruling on topic 18: the guarded auditor's steps leave the
# audit brief for a pointer to the succession template's « Standing context », which carries
# them once: the copy, the spawn line in full, the operator told, the handshake.
AUDSUCCTPL="$ROOT/templates/auditor-succession-brief.md"
# The predecessor tells the operator BEFORE it hands over, as /orchestrator:succeed orders it:
# « handed over » is its last message, nothing follows it.
AUDBRIEFSPAWN=$(grep -m1 -o '{{ITERM_AGENT_SH}} spawn .*' "$AUDSUCCTPL" 2>/dev/null | sed -e 's/^{{ITERM_AGENT_SH}} spawn //' -e 's/`.*$//' \
  -e 's#{{REPOSITORY}}#'"$WORK"'#' -e 's#<succession brief path>#/tmp/audit-succession-brief.md#')
audbriefspawn() { eval "set -- $AUDBRIEFSPAWN"; audsucc "$@"; }
AUDBRIEFSPAWNOUT=$(if [ -n "$AUDBRIEFSPAWN" ]; then audbriefspawn; else echo "no spawn line"; fi)
check "the succession template's spawn line is one the launcher runs as an auditor's succession" "1|none|1" \
  "$(printf '%s' "$AUDBRIEFSPAWNOUT" | grep -c '^name=Audit: tm$')|$(printf '%s' "$AUDBRIEFSPAWNOUT" | sed -n 's/^chain=//p')|$(printf '%s' "$AUDBRIEFSPAWNOUT" | sed -n 's/^launch=//p' | grep -c -- "--permission-mode auto")"
AUDFILLED="$WORK/audit-brief-filled.md"
if [ -f "$AUDBRIEF" ]; then
  sed -E -e 's#\{\{ORCHESTRATOR_NAME\}\}#Orch: f [a1b2c3]#g' -e "s#\{\{[A-Z_]+\}\}#$WORK#g" "$AUDBRIEF" > "$AUDFILLED"
fi
check "the audit brief, every placeholder filled, lints clean" "yes|0" \
  "$([ -s "$AUDFILLED" ] && echo yes || echo no)|$(bash "$ROOT/skills/orchestrator/scripts/brief-lint.sh" "$AUDFILLED" >/dev/null 2>&1; echo $?)"
# The report path is one the auditor creates, so it cannot exist when the brief is linted:
# the first live audit brief read two findings by construction (issue #52). The command names
# that one path to the lint as created later, and the lint exempts exactly it — a second
# absent path in the same brief is still a finding.
AUDREPORT="$WORK/audits/2026-09-13-tm.md"
AUDREAL="$WORK/audit-brief-real.md"
if [ -f "$AUDBRIEF" ]; then
  sed -E -e "s#\{\{REPORT_PATH\}\}#$AUDREPORT#g" -e "s#\{\{[A-Z_]+\}\}#$WORK#g" "$AUDBRIEF" > "$AUDREAL"
fi
check "an instantiated audit brief lints to zero with its report path expected, one finding without" "0|brief-lint: $AUDREAL: 0 findings" \
  "$(bash "$LINT" "$AUDREAL" --expect-created "$AUDREPORT" >/dev/null 2>&1; echo $?)|$(bash "$LINT" "$AUDREAL" --expect-created "$AUDREPORT" 2>&1)"
cp "$AUDREAL" "$WORK/audit-brief-other.md" 2>/dev/null; printf 'Spec: `%s/nowhere.md`\n' "$WORK" >> "$WORK/audit-brief-other.md"
check "--expect-created exempts the path it names and no other" "1|0" \
  "$(bash "$LINT" "$WORK/audit-brief-other.md" --expect-created "$AUDREPORT" 2>/dev/null | grep -c "path does not exist: $WORK/nowhere.md")|$(bash "$LINT" "$WORK/audit-brief-other.md" --expect-created "$AUDREPORT" 2>/dev/null | grep -c "path does not exist: $AUDREPORT")"
check "--expect-created without a path is refused, and says so" "1|1" \
  "$(bash "$LINT" "$AUDREAL" --expect-created >/dev/null 2>&1; echo $?)|$(bash "$LINT" "$AUDREAL" --expect-created 2>&1 | grep -c -- '--expect-created needs a path')"
# Every placeholder of the brief is one the command says how to fill.
# The auditor's succession brief: modelled on the coordinator's, short, with the audit's terms
# kept and the predecessor exchange the only message allowed.
AUDSUCCTPL="$ROOT/templates/auditor-succession-brief.md"
# A successor can succeed again: it restates the spawn line in full and finds its own name,
# reference and tty first, as the coordinator's successor does.
# A successor inherits its predecessor's live pair by default: no template, command or skill the
# orchestrator reads teaches --inherit-model on the succession line.
check "no template, command or orchestrator skill teaches --successor --inherit-model" "0" \
  "$(grep -rlE -e '--successor( [^`]*)? --inherit-model' "$ROOT/templates" "$ROOT/commands" "$ROOT/skills/orchestrator" 2>/dev/null | wc -l | tr -d ' ')"
AUDSUCCFILLED="$WORK/audit-succession-filled.md"
[ -f "$AUDSUCCTPL" ] && sed -E -e "s#\{\{[A-Z_]+\}\}#$WORK#g" "$AUDSUCCTPL" > "$AUDSUCCFILLED"
check "the auditor's succession brief, every placeholder filled, lints clean" "yes|0" \
  "$([ -s "$AUDSUCCFILLED" ] && echo yes || echo no)|$(bash "$ROOT/skills/orchestrator/scripts/brief-lint.sh" "$AUDSUCCFILLED" >/dev/null 2>&1; echo $?)"
# The code cites §52: the section it cites exists.
check "the design document has the audit's numbered section" "1" \
  "$(grep -c '^## 52\. The audit of an orchestrator$' "$ROOT/docs/design.md")"

printf 'a prompt\n' > "$file"
out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --tier light --dir "$WORK" --title "Agent: prompt" --prompt-file "$file" 2>&1)
check "--prompt-file reuses the given file" "1" "$(printf '%s' "$out" | grep -c "prompt_file=$file")"
out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --tier light --dir "$WORK" --title "Agent: prompt" --prompt "a prompt" 2>&1)
cmd=${out#*launch=}; cmd=${cmd%%$'\n'*}
check "--prompt: the server flag is still there" "1" "$(printf '%s' "$cmd" | grep -c -- '--strict-mcp-config')"
check_status "--prompt and --prompt-file together are refused" 1 env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --tier light --dir "$WORK" --prompt x --prompt-file "$file"

# A launch with no startup prompt at all could never have its mode read (the host writes
# no transcript before a first prompt), so it is refused before any tab is made rather than
# spending the mode timeout finding that out.
check_status "a promptless spawn is refused before any tab is made" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --tier light --dir "$WORK" --title "Agent: prompt"
noprompt=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --tier light --dir "$WORK" --title "Agent: prompt" 2>&1)
check "and says why, before any dry-run launch line" "1|0" \
  "$(printf '%s' "$noprompt" | grep -c 'no startup prompt')|$(printf '%s' "$noprompt" | grep -c '^launch=')"
check_status "--no-verify does not lift the promptless refusal" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --tier light --dir "$WORK" --title "Agent: prompt" --no-verify
check_status "a promptless rotation is refused the same way, the old session never touched" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  bash "$AGENT" rotate --tier light --old-tty /dev/ttys999 --dir "$WORK" --title "Agent: rotated"
rotnoprompt=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  bash "$AGENT" rotate --tier light --old-tty /dev/ttys999 --dir "$WORK" --title "Agent: rotated" 2>&1)
check "and no close of the old tty is even attempted" "0" "$(printf '%s' "$rotnoprompt" | grep -c '^close=')"
check_status "verify on a tty nobody has exits 1" 1 bash "$AGENT" verify --tty /dev/ttys999
check "screen without a tty says which option is missing" "ERROR: screen: --tty is required" \
  "$(bash "$AGENT" screen 2>&1 | head -1)"

# A directory the host has never opened stops the session on a workspace question whose
# highlighted answer is "exit". Nobody sits at that keyboard: the session waits for ever
# having never read its brief, or takes a stray keystroke and quits — and from outside both
# look like a launched agent, because the process is genuinely running. Caught before the
# tab exists, since afterwards it is found out from an agent that never answers.
py=$(command -v python3 || echo python3)
TRUSTF="$WORK/trust.json"; printf '{"projects":{}}' > "$TRUSTF"
check_status "an untrusted directory is refused before a tab is made" 1 \
  env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  CLAUDE_CODE_SESSION_ID=s-suite bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent: trust" --tier deep --prompt p
check "the refusal says how to proceed" "1" \
  "$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
     CLAUDE_CODE_SESSION_ID=s-suite bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent: trust" --tier deep --prompt p 2>&1 | grep -c -- '--trust')"
check_status "--trust records it and proceeds" 0 \
  env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  CLAUDE_CODE_SESSION_ID=s-suite bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent: trust" --tier deep --trust --prompt p
check "the record now holds the directory" "true" \
  "$("$py" -c "import json,os,sys; d=json.load(open(sys.argv[1])); print(str(d['projects'].get(os.path.realpath(sys.argv[2]),{}).get('hasTrustDialogAccepted')).lower())" "$TRUSTF" "$UNTRUSTED")"
check_status "a directory already recorded needs no flag" 0 \
  env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  CLAUDE_CODE_SESSION_ID=s-suite bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent: trust" --tier deep --prompt p
check "the record keeps owner-only permissions" "600" \
  "$(perm_of "$TRUSTF")"

# A record that already says yes is not rewritten: the host writes this file too, and a
# rewrite for nothing is a window in which one of the two loses. The fixture is written
# compact on purpose — the launcher's own writer indents, so any rewrite changes the bytes.
compact="{\"projects\":{\"$(cd "$UNTRUSTED" && pwd -P)\":{\"hasTrustDialogAccepted\":true}}}"
printf '%s' "$compact" > "$TRUSTF"
out=$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
      CLAUDE_CODE_SESSION_ID=s-suite bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent: trust" --tier deep --trust --prompt p 2>&1)
check "--trust on a recorded directory does not rewrite the record" "$compact" "$(cat "$TRUSTF")"
check "and the dry run says the record already held it" "1" "$(printf '%s' "$out" | grep -c '^trust=already$')"
check "--trust on an unrecorded directory says it recorded it" "1" \
  "$(printf '{"projects":{}}' > "$TRUSTF"; env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
     CLAUDE_CODE_SESSION_ID=s-suite bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent: trust" --tier deep --trust --prompt p 2>&1 | grep -c '^trust=recorded$')"
# A record the launcher cannot read is a gate that cannot measure: it lets the launch
# through AND says so, instead of launching past a question nobody will see.
# The trust is the account's: a session run on a second account (CLAUDE_CONFIG_DIR) has its own
# .claude.json, and a spawn in a new checkout is trusted there; with no such variable it is the
# home's. The suite's own override (ORCHESTRATOR_TRUST_FILE) comes first.
trust_probe() { # <HOME> <extra env...>: where --trust writes the record of a directory
  local home="$1"; shift
  env -u ORCHESTRATOR_TRUST_FILE -u CLAUDE_CONFIG_DIR HOME="$home" "$@" "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
ia.grant_directory_trust('$WORK/trust-new')
print(ia.TRUST_FILE)"
}
mkdir -p "$WORK/trust-home" "$WORK/trust-acct"
check "--trust writes the account's own .claude.json when CLAUDE_CONFIG_DIR names one" \
  "$WORK/trust-acct/.claude.json|1|0" \
  "$(trust_probe "$WORK/trust-home" CLAUDE_CONFIG_DIR="$WORK/trust-acct")|$(grep -c 'trust-new' "$WORK/trust-acct/.claude.json")|$([ -e "$WORK/trust-home/.claude.json" ] && echo 1 || echo 0)"
check "and the home's .claude.json when it names none" "$WORK/trust-home/.claude.json|1" \
  "$(trust_probe "$WORK/trust-home")|$(grep -c 'trust-new' "$WORK/trust-home/.claude.json")"
check "the suite's own trust file wins over both" "$WORK/trust-own.json" \
  "$(trust_probe "$WORK/trust-home" CLAUDE_CONFIG_DIR="$WORK/trust-acct" ORCHESTRATOR_TRUST_FILE="$WORK/trust-own.json")"
# A spawn under a second plan's configuration directory finds the checkout trusted in that
# directory's .claude.json, not in the home's: a fresh clone made for a plan 2 session no longer
# stops on the host's « Quick safety check » dialog.
mkdir -p "$WORK/trust-fresh" "$WORK/trust-acct2"
printf '{"projects":{}}' > "$WORK/trust-acct2/.claude.json"
out=$(env -u ORCHESTRATOR_TRUST_FILE CLAUDE_CONFIG_DIR="$WORK/trust-acct2" HOME="$WORK/trust-home" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
      CLAUDE_CODE_SESSION_ID=s-suite bash "$AGENT" spawn --dir "$WORK/trust-fresh" --title "Agent: trust" --tier deep --trust --prompt p 2>&1)
check "a spawn under a plan 2 configuration directory trusts the checkout in that directory's record" "recorded|true|1" \
  "$(printf '%s\n' "$out" | sed -n 's/^trust=//p')|$("$py" -c "import json,os,sys; print(str(json.load(open(sys.argv[1]))['projects'].get(os.path.realpath(sys.argv[2]),{}).get('hasTrustDialogAccepted')).lower())" "$WORK/trust-acct2/.claude.json" "$WORK/trust-fresh")|$(printf '%s\n' "$out" | grep -c "^launch=.*export CLAUDE_CONFIG_DIR=$WORK/trust-acct2 ")"
# What a plan names, as the launcher reads it: its record, its transcripts' folder and the variable.
plan_probe() { # <config dir or empty> <HOME>: TRUST_FILE, PROJECTS_DIR and the variable after use_config
  env -u ORCHESTRATOR_TRUST_FILE -u ORCHESTRATOR_PROJECTS_DIR -u CLAUDE_CONFIG_DIR HOME="$2" CLAUDE_CONFIG_DIR="$WORK/trust-acct" "$py" -c "
import os, sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
ia.use_config(sys.argv[1])
print(ia.TRUST_FILE, ia.PROJECTS_DIR, os.environ.get('CLAUDE_CONFIG_DIR', 'none'))" "$1"; }
check "use_config moves the trust record, the transcripts' folder and the variable to the plan named" \
  "/p2/.claude.json /p2/projects /p2" "$(plan_probe /p2 "$WORK/trust-home")"
check "and plan 1 is the home's, the variable gone" "$WORK/trust-home/.claude.json $WORK/trust-home/.claude/projects none" "$(plan_probe '' "$WORK/trust-home")"
check "the transcripts' folder follows the configuration directory at start, the launcher's and the routing's alike" "$WORK/trust-acct/projects|$WORK/trust-acct/projects" \
  "$(env -u ORCHESTRATOR_PROJECTS_DIR CLAUDE_CONFIG_DIR="$WORK/trust-acct" "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia; print(ia.PROJECTS_DIR)")|$(env -u ORCHESTRATOR_PROJECTS_DIR CLAUDE_CONFIG_DIR="$WORK/trust-acct" "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/model-routing/scripts')
import routing; print(routing.PROJECTS_DIR)")"
# The plan a session runs on is read on its own process, whoever asks.
# A platform binary such as sleep hides its environment from ps: the probes are the interpreter's.
env CLAUDE_CONFIG_DIR=/plan/probe "$py" -c "import time; time.sleep(30)" & PCRUN=$!; disown
env -u CLAUDE_CONFIG_DIR "$py" -c "import time; time.sleep(30)" & PCNONE=$!; disown
sleep 1
check "process_config reads the variable in a running process's environment, and says none for a process without one" "/plan/probe|none" \
  "$("$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
print('%s|%s' % (ia.process_config(sys.argv[1]), ia.process_config(sys.argv[2]) or 'none'))" "$PCRUN" "$PCNONE")"
kill "$PCRUN" "$PCNONE" 2>/dev/null
printf '{not json' > "$WORK/trust-garbage.json"
out=$(env ORCHESTRATOR_TRUST_FILE="$WORK/trust-garbage.json" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
      CLAUDE_CODE_SESSION_ID=s-suite bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent: trust" --tier deep --prompt p 2>&1); code=$?
check "an unreadable record lets the launch through" "0" "$code"
check "and says so, naming the flag" "1|1" \
  "$(printf '%s' "$out" | grep -c 'cannot be read')|$(printf '%s' "$out" | grep -c '^trust=unread$')"
# The trust check runs BEFORE the prompt file is written: a refusal that already wrote one
# is a refusal that leaves a stray file under the state directory's prompts/.
D8STATE=$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-XXXXXX")
D8TRUST="$WORK/trust-d8.json"; printf '{"projects":{}}' > "$D8TRUST"
D8DIR="$WORK/untrusted-d8"; mkdir -p "$D8DIR"
env ORCHESTRATOR_TRUST_FILE="$D8TRUST" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$D8STATE" \
  bash "$AGENT" spawn --tier light --dir "$D8DIR" --title "Agent: trust" --prompt "hello" >/dev/null 2>&1
check "the trust refusal leaves no prompt file" "0" \
  "$(find "$D8STATE/prompts" -type f 2>/dev/null | wc -l | tr -d ' ')"
rm -rf "$D8STATE"
# Entries outlive their directories — a checkout per phase adds one per dispatch — and
# nothing removed them. prune lists; only --apply writes; the kept entry keeps its shape.
GONE="$WORK/gone-checkout"
"$py" -c "import json,sys; json.dump({'projects':{sys.argv[1]:{'hasTrustDialogAccepted':True,'allowedTools':['x']},sys.argv[2]:{'hasTrustDialogAccepted':True}}}, open(sys.argv[3],'w'))" \
  "$(cd "$UNTRUSTED" && pwd -P)" "$GONE" "$TRUSTF"
before=$(cat "$TRUSTF")
check "trust prune lists the gone entry, only it, and writes nothing" "$GONE|unchanged" \
  "$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" bash "$AGENT" trust prune 2>/dev/null)|$([ "$(cat "$TRUSTF")" = "$before" ] && echo unchanged || echo rewritten)"
check "trust prune --apply removes it and keeps the rest, owner-only" "1|0|600" \
  "$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" bash "$AGENT" trust prune --apply >/dev/null 2>&1; \
     "$py" -c "import json,sys; d=json.load(open(sys.argv[1]))['projects']; print('%d|%d' % (sys.argv[2] in d and d[sys.argv[2]].get('allowedTools')==['x'], sys.argv[3] in d))" "$TRUSTF" "$(cd "$UNTRUSTED" && pwd -P)" "$GONE")|$(perm_of "$TRUSTF")"
check "trust accepts prune and refuses another action" "0|1" \
  "$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" bash "$AGENT" trust prune >/dev/null 2>&1; echo $?)|$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" bash "$AGENT" trust wipe >/dev/null 2>&1; echo $?)"

# The title guard, on the part of a title that holds still. The first character is an
# activity glyph the session flips on its own — busy, then idle — and a rotation stands the
# old agent down before spending ten seconds on its replacement, so a title captured before
# and compared after is guaranteed to differ. The guard meant to make a close unambiguous
# refused every rotation instead.
title_in() { "$py" -c "
import sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
print('yes' if m.stable_title(sys.argv[1]) in m.stable_title(sys.argv[2]) else 'no')" "$1" "$2"; }
check "a title matches across an activity change" "yes" "$(title_in '◑ Lire et attendre' '✳ Lire et attendre')"
check "a captured prefix still matches" "yes" "$(title_in '◑ Lire' '✳ Lire et attendre')"
check "a plain title matches itself" "yes" "$(title_in 'Chat' 'Chat')"
check "a title in the former shape, « Agent : x », matches the current one both ways" "yes|yes" \
  "$(title_in 'Agent: x' '✳ Agent : x')|$(title_in '◑ Agent : x' 'Agent: x')"
check "a different title still does not match" "no" "$(title_in 'autre' '✳ Lire et attendre')"

# The shell of a fresh tab is read before anything is typed into it: a startup question
# waiting for a keystroke ate the first character of a command twice in one night.
# Twice: once before the first typing, once before the single retry.

echo "== iterm-agents: iTerm2 answers, or it is said why (§46) =="
# Every reading here is about the fault that made the launcher unkillable: the app stopped
# dispatching AppleEvents, the library asked it for a cookie through an UNBOUNDED
# `osascript`, and the call never returned. The suite stands both halves up with stubs, so
# none of it needs a window server.
IBIN="$WORK/ibin"
mkdir -p "$IBIN"
# An `osascript` that never answers, the way the app behaves when its main thread is wedged.
printf '#!/bin/bash\ncat >/dev/null\nsleep 60\n' > "$IBIN/osascript-deaf"
# One that answers the way a healthy app does.
printf '#!/bin/bash\ncat >/dev/null\necho 3.7.0\n' > "$IBIN/osascript-live"
# One that fails the way a missing app does.
printf '#!/bin/bash\ncat >/dev/null\necho "execution error: iTerm2 got an error" >&2\nexit 1\n' > "$IBIN/osascript-broken"
chmod +x "$IBIN"/osascript-*

ipy() { "$py" -c "
import sys
sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
$1
"; }

check "a bounded osascript that never answers is killed and reported as a timeout" "timeout" \
  "$(ORCHESTRATOR_OSASCRIPT="$IBIN/osascript-deaf" ORCHESTRATOR_PROBE_TIMEOUT=2 \
     ipy "print(ia.osascript_run('x')[0])")"
# Scoped to this suite's own stub path, not the bare name: a bare `pgrep -f osascript-deaf`
# reads machine-wide and flakes when another suite's own deaf stub is alive at the same time.
# The bracket keeps the pattern from matching the probe's own command line, which spells it.
check "the deaf probe leaves no osascript behind" "0" \
  "$(ORCHESTRATOR_OSASCRIPT="$IBIN/osascript-deaf" ORCHESTRATOR_PROBE_TIMEOUT=2 \
     ipy "
import subprocess
ia.osascript_run('x')
print(subprocess.run(['pgrep','-f','$IBIN/[o]sascript-deaf'],capture_output=True,text=True).stdout.count('\n'))")"

# Proof the scoped guard still falls on a real leak: a copy of the stub started directly
# under this suite's own work directory and left running on purpose, so "0" above means a
# clean kill, not a pattern too narrow to ever match anything.
LEAKED="$IBIN/osascript-deaf-leak"
cp "$IBIN/osascript-deaf" "$LEAKED"
"$LEAKED" </dev/null >/dev/null 2>&1 &
LEAK_PID=$!
check "the scoped guard still catches a leak planted in a scratch copy" "1" \
  "$(pgrep -f -- "$LEAKED" | wc -l | tr -d ' ')"
kill "$LEAK_PID" 2>/dev/null
wait "$LEAK_PID" 2>/dev/null
rm -f "$LEAKED"
check "a live app answers the preflight with its version" "True 3.7.0" \
  "$(ORCHESTRATOR_OSASCRIPT="$IBIN/osascript-live" ipy \
     "print('%s %s' % ia.app_responsive())")"
check "a wedged app fails the preflight as a timeout, not as an error" "False timeout" \
  "$(ORCHESTRATOR_OSASCRIPT="$IBIN/osascript-deaf" ORCHESTRATOR_PROBE_TIMEOUT=2 ipy \
     "print('%s %s' % ia.app_responsive())")"
check "a refusing app fails the preflight as an error" "False error" \
  "$(ORCHESTRATOR_OSASCRIPT="$IBIN/osascript-broken" ipy \
     "print('%s %s' % ia.app_responsive())")"

# The sample is the only reading that tells « busy » from « wedged in a modal loop », and the
# modal loop is the one an operator clears with one keystroke. The stack below is the real
# one, trimmed: a context menu left open by a single right-click.
check "a modal menu in the sample is named as the cause, with its remedy" "modal|Escape" \
  "$(ipy "
c = ia.cause_from_sample('''
 1931 -[NSView _showMenuForEvent:]  (in AppKit)
 1931 -[NSMenuTrackingSession startRunningMenuEventLoop:]  (in AppKit)
''')
print('%s|%s' % ('modal' if 'MODAL' in c else 'no', 'Escape' if 'Escape' in c else 'no'))")"
check "a sheet is named the same way" "modal" \
  "$(ipy "print('modal' if 'MODAL' in ia.cause_from_sample('1 -[NSApplication runModalForWindow:]') else 'no')")"
check "an unrecognised stack is not called a modal loop" "other" \
  "$(ipy "print('modal' if 'MODAL' in ia.cause_from_sample('1 mach_msg_trap (in libsystem_kernel.dylib)') else 'other')")"
check "no sample at all says so instead of guessing" "sampled" \
  "$(ipy "print('sampled' if 'sampled' in ia.cause_from_sample('') else 'no')")"

echo "== iterm-agents: a close never destroys what the operator typed and has not sent =="
# A succession closed the predecessor's tab while the operator was typing in its prompt, and his
# text was lost. A close reads the host's prompt box first (faint cells left out: the host draws
# its placeholder and its suggestions faint), waits for what he typed to be sent or cleared, and
# past its bound refuses, the tab kept and his text on the refusal's line.
PRULE="$(printf '\033[38;5;244m')$(printf '─%.0s' $(seq 1 40))$(printf '\033[39m')"
PEMPTY="$PRULE Orch: x
$(printf '\033[39m❯\302\240\033[2mTry "write a test"\033[0m')
$PRULE
  x │ Opus"
PTYPED="$PRULE Orch: x
$(printf '\033[39m❯\302\240')je réponds
  sur deux lignes
$PRULE
  x │ Opus"
check "the prompt box: a faint placeholder is nothing typed, the operator's lines are his text, no box is never an empty one" \
  "||je réponds⏎sur deux lignes|None|" \
  "$(PE="$PEMPTY" PT="$PTYPED" ipy "
import os
print('|' + ia.typed_input(ia.unfaint(os.environ['PE']).split(chr(10))) + '|' + ia.typed_input(ia.unfaint(os.environ['PT']).split(chr(10))) + '|' + str(ia.typed_input(['\$ ls', 'a'])) + '|')" | nl_join)"
# Bash mode draws ! as the mark; a busy host on a theme of ANSI colours draws ❯ faint, so it is
# left out with the faint cells; a dialog (a permission, a question) draws no box at all.
check "bash mode's ! box holds his command, a faint mark's box his text; a dialog shows no box, never an empty one" \
  "git push --force|je tape|None" \
  "$(ipy "
R = '─' * 40
bash = [R, '!\u00a0git push --force', R]
faint = ia.unfaint(R + '\n\x1b[2m❯\x1b[22m\u00a0je tape\n' + R).split('\n')
dialog = [R, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', R]
print('|'.join(str(ia.typed_input(lines)) for lines in (bash, faint, dialog)))")"
# The host draws its placeholder, when it draws its own cursor, as an inverse first letter then
# the rest faint: that letter is no text; the cursor on a letter of his text keeps it.
PINVERSE="$PRULE Orch: x
$(printf '\033[39m❯\302\240\033[7mT\033[27m\033[2mry \"write a test\"\033[0m')
$PRULE"
check "an inverse first letter before a faint placeholder is nothing typed, in a pane and in an iTerm2 line; his text under the cursor is kept" \
  "|je tape||je tape" \
  "$(PI="$PINVERSE" ipy "
import os
class Style:
    def __init__(self, faint, inverse): self.faint, self.inverse = faint, inverse
class Line:
    def __init__(self, cells): self.cells = cells
    def string_at(self, x): return self.cells[x][0]
    def style_at(self, x): return Style(*self.cells[x][1:]) if x < len(self.cells) else None
R = '─' * 40
hint = Line([('❯', False, False), ('\u00a0', False, False), ('T', False, True)] + [(c, True, False) for c in 'ry this'])
typed = Line([('❯', False, False), ('\u00a0', False, False)] + [(c, False, c == 'a') for c in 'je tape'])
cursor = ia.unfaint(R + '\n❯\u00a0je t\x1b[7ma\x1b[27mpe\n' + R).split('\n')
print('|'.join([ia.typed_input(ia.unfaint(os.environ['PI']).split('\n')), ia.typed_input(cursor), ia.typed_input([R, ia.plain_cells(hint), R]), ia.typed_input([R, ia.plain_cells(typed), R])]))")"
# The app answers a cell the host moved the cursor over as NUL, and says which cells are faint.
check "an iTerm2 line: its NUL cells are spaces, its faint cells left out" "❯ je tape|❯" \
  "$(ipy "
class Style:
    def __init__(self, faint): self.faint = faint
class Line:
    def __init__(self, cells): self.cells = cells
    def string_at(self, x): return self.cells[x][0]
    def style_at(self, x): return Style(self.cells[x][1]) if x < len(self.cells) else None
typed = Line([('❯', False), ('\\u00a0', False)] + [(c, False) for c in 'je'] + [('\\x00', False)] + [(c, False) for c in 'tape'] + [('\\x00', False)] * 3)
hint = Line([('❯', False), ('\\u00a0', False)] + [(c, True) for c in 'Try this'])
print(ia.plain_cells(typed).replace(chr(0xa0), ' ') + '|' + ia.plain_cells(hint).strip())")"
check "a colour's own arguments are no faint; 2 sets it, 22, 0 and an empty style reset it" "False|True|False|False|False" \
  "$(ipy "print('|'.join(str(ia.faint_after(p, f)) for p, f in (('38;5;2', False), ('1;2', False), ('22', True), ('0', True), ('', True))))")"
# await_unsent on a read that answers in turn, its clock a step per read: nothing typed closes at
# once; text then sent goes on after it and says so; text kept past the bound, or unread once
# seen, refuses with nothing closed; a prompt that cannot be read refuses at once.
unsent() { READS="$1" ipy "
import os
reads = os.environ['READS'].split(',')
t = [0]
def read():
    r = reads.pop(0) if len(reads) > 1 else reads[0]
    if r == 'NONE':
        raise RuntimeError('no API')
    return '' if r == 'EMPTY' else None if r == 'NOBOX' else r.replace('/', chr(10))
def clock():
    t[0] += 1
    return t[0]
try:
    print(ia.await_unsent('close', '/dev/ttys901', read, bound=5, sleep=lambda s: None, clock=clock))
except SystemExit as e:
    print('exit=%s' % e.code)" 2>&1; }
res=$(unsent EMPTY)
check "an empty prompt closes as before, nothing said" "False" "$res"
res=$(unsent 'mon texte,mon texte,EMPTY')
check "text typed, then sent or cleared: the close goes on, having said it waited" "1|True" \
  "$(printf '%s\n' "$res" | grep -c '^close: the prompt on /dev/ttys901 holds text the operator typed and has not sent: waiting up to 5s')|$(printf '%s\n' "$res" | tail -1)"
res=$(unsent 'mon texte')
check "text still there at the bound: refused, the tab kept, his text on the line" "1|exit=3" \
  "$(printf '%s\n' "$res" | grep -c '^ERROR: close: refused: the prompt on /dev/ttys901 still holds text the operator typed and has not sent, after 5s: the tab is kept, nothing was closed.*His text: «mon texte»$')|$(printf '%s\n' "$res" | tail -1)"
res=$(unsent 'mon texte,NONE')
check "text seen, then a prompt that cannot be read: never taken for sent, refused at the bound with his text" "1|exit=3" \
  "$(printf '%s\n' "$res" | grep -c '^ERROR: close: refused: .*His text: «mon texte»$')|$(printf '%s\n' "$res" | tail -1)"
res=$(unsent NONE)
check "a prompt that cannot be read is never taken for an empty one: refused at once, the tab kept" "1|exit=3" \
  "$(printf '%s\n' "$res" | grep -c '^ERROR: close: refused: the prompt on /dev/ttys901 cannot be read (no API), so whether it holds text .*: the tab is kept, nothing was closed$')|$(printf '%s\n' "$res" | tail -1)"
# A screen with no box (a dialog, a host still drawing) is waited for as text is: a box drawn
# empty then closes; none drawn by the bound refuses, with nothing to show.
res=$(unsent 'NOBOX,EMPTY')
check "no prompt box, then an empty one: the close waits, then goes on, no text seen" "1|False" \
  "$(printf '%s\n' "$res" | grep -c '^close: the prompt on /dev/ttys901 shows no prompt box (a dialog, or a host still drawing), so what it holds is not known: waiting up to 5s')|$(printf '%s\n' "$res" | tail -1)"
res=$(unsent NOBOX)
check "no prompt box by the bound: refused, the tab kept" "1|exit=3" \
  "$(printf '%s\n' "$res" | grep -c '^ERROR: close: refused: the screen on /dev/ttys901 showed no prompt box for 5s .*: the tab is kept, nothing was closed$')|$(printf '%s\n' "$res" | tail -1)"
# The refusal is one line: the module's close keeps the last line, and a successor reads it as
# the launcher's, never the host's, so no end_session ends the tab over his text.
res=$(unsent 'je réponds/sur deux lignes')
check "his text on several lines is on the refusal's one line, after the way out" "1|0|exit=3" \
  "$(printf '%s\n' "$res" | grep -c '^ERROR: close: refused: .*this refusal is the launcher.s, no refusal of the host.s: never ask the session to call end_session, which would destroy his text\. His text: «je réponds ⏎ sur deux lignes»$')|$(printf '%s\n' "$res" | grep -c '^sur deux lignes')|$(printf '%s\n' "$res" | tail -1)"
# A takeover reads its predecessor's pane before the kill: text there keeps window 0 as it is.
unsent_takeover() { SCREEN="$1" SCREEN2="${2:-}" ORCHESTRATOR_INPUT_WAIT="${TWAIT:-0}" ORCHESTRATOR_STATE_DIR="$ESTATE" ipy "
import os
P = ia.Pane
killed = []
class Home:
    def window_of(self, tty, what):
        return P('home', '0', '@1', '%1', tty, 'Orch: x', '') if tty == '/dev/ttys966' \\
            else P('home', '2', '@3', '%3', tty, 'Orch: x', '')
    def kill(self, window, what): killed.append(window)
    def survives(self, stable_id): return False
    def stable_id(self, window): return 'tmux:s:' + window
    def session(self): return 'home'
ia.TmuxTerminal = Home
ia.in_home_session = lambda: True
ia.self_tty = lambda: '/dev/ttys967'
# The pane's capture: SCREEN, then SCREEN2 once read (what he left: sent or cleared).
reads = []
def tmux_out(args, what):
    if 'capture-pane' not in args:
        return '0'
    reads.append(1)
    return os.environ['SCREEN2'] if len(reads) > 1 and os.environ['SCREEN2'] else os.environ['SCREEN']
ia.tmux_out = tmux_out
ia.INPUT_POLL = 0
ia.host_identity = lambda tty: None
ia.wait_gone = lambda *a, **k: None
ia.await_handover = lambda tty: 'takeover: « handed over » read'
# Read once the wait is over: what he sent during it is in the conversation.
ia.conversation_of = lambda tty: 'conversation: read after %d prompt reads' % len(reads)
try:
    ia.cmd_takeover(ia.args_from_line('takeover', ['--tty', '/dev/ttys966', '--expect-title', 'Orch: x']))
finally:
    print('killed=%s' % ','.join(killed))" 2>&1; }
res=$(unsent_takeover "$PTYPED")
check "a takeover whose predecessor holds typed text refuses before the kill: window 0 is kept" "1|killed=|0" \
  "$(printf '%s\n' "$res" | grep -c '^ERROR: takeover: refused: the prompt on /dev/ttys966 still holds text .*His text: «je réponds')|$(printf '%s\n' "$res" | tail -1)|$(printf '%s\n' "$res" | grep -c '^took window 0')"
res=$(unsent_takeover "$PEMPTY")
check "and one whose prompt shows only the placeholder takes window 0 as before" "1|killed=@1" \
  "$(printf '%s\n' "$res" | grep -c '^took window 0')|$(printf '%s\n' "$res" | tail -1)"
res=$(TWAIT=10 unsent_takeover "$PTYPED" "$PEMPTY")
check "a takeover whose predecessor's text is sent during its wait waits, then takes window 0, its conversation read after the wait" \
  "1|1|1|killed=@1" \
  "$(printf '%s\n' "$res" | grep -c '^takeover: the prompt on /dev/ttys966 holds text the operator typed and has not sent: waiting up to 10s')|$(printf '%s\n' "$res" | grep -c '^conversation: read after 2 prompt reads$')|$(printf '%s\n' "$res" | grep -c '^took window 0')|$(printf '%s\n' "$res" | tail -1)"

# The close of a home tab, an orchestrator's or a coordinator's, reads window 0 of its server,
# where the host runs: text there keeps the server and every window, nothing ended.
hometab_close() { SCREEN="$1" ORCHESTRATOR_INPUT_WAIT=0 ORCHESTRATOR_STATE_DIR="$ESTATE" ipy "
import os
calls = []
ia.DRY_RUN = False
ia.pane_tab_tty = lambda tty: tty
ia.close_host_tty = lambda tty, strict=False: ('orch-suite', ([['0', '/dev/ttys905']], ''), '/dev/ttys905')
ia.host_clis_on = lambda tty, strict=False: ['4242']
ia.host_cli_cwd = lambda tty: None
ia.recorded_pids = lambda ttys: []
ia.name_lingering = lambda pids: None
ia.conversation_of = lambda tty: ''
def tmux_out(args, what):
    calls.append(' '.join(args))
    return os.environ['SCREEN']
ia.tmux_out = tmux_out
def close_home_tab(tty, socket, expect, listed, end_agents):
    calls.append('end ' + socket)
    print('closed 1 session on ' + tty)
ia.close_home_tab = close_home_tab
try:
    ia.cmd_close(ia.args_from_line('close', ['--tty', '/dev/ttys904', '--expect-title', 'Orch: x', '--keep-checkout']))
except SystemExit as e:
    print('exit=%s' % e.code)
print('calls=' + '|'.join(calls))" 2>&1; }
res=$(hometab_close "$PTYPED")
check "close of a home tab whose window 0 holds his text: refused on window 0's capture, the server and its windows kept" \
  "1|calls=-L orch-suite capture-pane -p -e -t home:0|exit=3" \
  "$(printf '%s\n' "$res" | grep -c '^ERROR: close: refused: the prompt on /dev/ttys904 still holds text .*His text: «je réponds ⏎ sur deux lignes»$')|$(printf '%s\n' "$res" | grep '^calls=')|$(printf '%s\n' "$res" | grep '^exit=')"
res=$(hometab_close "$PEMPTY")
check "and one whose window 0 shows the placeholder alone ends its server as before" \
  "closed 1 session on /dev/ttys904|calls=-L orch-suite capture-pane -p -e -t home:0|end orch-suite" \
  "$(printf '%s\n' "$res" | grep '^closed')|$(printf '%s\n' "$res" | grep '^calls=')"
# The close of an iTerm2 tab reads the app's screen through its API, styles included: his text
# refuses it, nothing closed; the placeholder alone closes it. Where the API cannot serve (the
# module missing, the app not answering), the prompt cannot be read: the close refuses, the
# reason and the way out on its line, and no rung below closes the tab over his text.
iterm_close() { MODE="$1" ORCHESTRATOR_INPUT_WAIT=0 ORCHESTRATOR_STATE_DIR="$ESTATE" ipy "
import asyncio, os
mode = os.environ['MODE']
closed = []
class Style:
    def __init__(self, faint): self.faint, self.inverse = faint, False
class Line:
    def __init__(self, cells): self.cells = cells
    def string_at(self, x): return self.cells[x][0]
    def style_at(self, x): return Style(self.cells[x][1]) if x < len(self.cells) else None
class Contents:
    def __init__(self, lines): self.lines, self.number_of_lines = lines, len(lines)
    def line(self, i): return self.lines[i]
R = Line([('─', False)] * 40)
box = Line([('❯', False), ('\u00a0', False)] + ([(c, False) for c in 'ma réponse'] if mode == 'typed' else [(c, True) for c in 'Try this']))
class Sess:
    async def async_get_screen_contents(self): return Contents([R, box, R])
async def find_tab(app, tty): return None, None, Sess()
class Api:
    @staticmethod
    async def async_get_app(connection): return None
ia.find_tab = find_tab
if mode == 'noapi':
    def api_ready(): raise ia.Unreachable('the iterm2 module is not installed for py; run /orchestrator:install')
    ia.api_ready = api_ready
else:
    ia.run = lambda go: asyncio.run(go(Api, None))
ia.as_close = lambda tty, expect: closed.append('applescript ' + tty)
ia.DRY_RUN = False
ia.pane_tab_tty = lambda tty: tty
ia.close_host_tty = lambda tty, strict=False: ('', None, tty)
ia.host_clis_on = lambda tty, strict=False: ['4242']
ia.host_cli_on = lambda tty: '4242'
ia.host_cli_cwd = lambda tty: None
ia.recorded_pids = lambda ttys: []
ia.name_lingering = lambda pids: None
ia.terminal_for = lambda tty: ia.ITERM
ia.close_tab = lambda tty, expect: closed.append(tty)
try:
    ia.cmd_close(ia.args_from_line('close', ['--tty', '/dev/ttys906', '--expect-title', 'Agent: x', '--keep-checkout']))
except SystemExit as e:
    print('exit=%s' % e.code)
print('closed=' + ','.join(closed))" 2>&1; }
res=$(iterm_close typed)
check "close of an iTerm2 tab whose prompt holds his text: refused, nothing closed" "1|exit=3|closed=" \
  "$(printf '%s\n' "$res" | grep -c '^ERROR: close: refused: the prompt on /dev/ttys906 still holds text .*His text: «ma réponse»$')|$(printf '%s\n' "$res" | grep '^exit=')|$(printf '%s\n' "$res" | grep '^closed=')"
res=$(iterm_close empty)
check "and one whose prompt shows the faint placeholder alone is closed as before" "closed 1 session on /dev/ttys906|closed=/dev/ttys906" \
  "$(printf '%s\n' "$res" | grep '^closed 1')|$(printf '%s\n' "$res" | grep '^closed=')"
res=$(iterm_close noapi)
check "where the app's API cannot serve, the close refuses with its reason and the way out, and no rung closes the tab" "1|exit=3|closed=" \
  "$(printf '%s\n' "$res" | grep -c '^ERROR: close: refused: the prompt on /dev/ttys906 cannot be read (the iterm2 module is not installed for py; run /orchestrator:install), .* Run this close again once he has sent or cleared it and the prompt can be read; .*: the tab is kept, nothing was closed$')|$(printf '%s\n' "$res" | grep '^exit=')|$(printf '%s\n' "$res" | grep '^closed=')"

echo "== iterm-agents: closing a home tab ends its server =="
# The operator closes the tab of an orchestrator's home session and expects the orchestrator
# and every agent window to end with it. With tmux's defaults the server outlived its only
# client, unseen. Once the home tab's client is proved attached, the server is told to exit
# when no client is left; before that moment (the detached start) it is not, and a takeover
# kills a window while the tab stays attached. A server and a client of the suite's own; the
# client runs on a pty whose master the probe holds, as the tab's terminal does, and closing
# that master is closing the tab.
if command -v tmux >/dev/null 2>&1; then
  HSRV="suite-home-$$"
  HMARK=$((3600 + $$ % 1000))
  printf '%s\n' 'import os, pty, sys, time' \
    'pid, fd = pty.fork()' \
    'if pid == 0:' \
    '    os.execvp(sys.argv[1], sys.argv[1:])' \
    'while True:' \
    '    try:' \
    '        os.read(fd, 4096)' \
    '    except OSError:' \
    '        time.sleep(0.2)' > "$WORK/ptyclient.py"
  hsrv() { env -u TMUX -u TMUX_PANE tmux -L "$HSRV" "$@"; }
  hpanes() { pgrep -fx "sleep $HMARK" | wc -l | tr -d ' '; }
  hserver() { hsrv has-session -t home 2>/dev/null && echo up || echo down; }
  # The server is started by the launcher's own make_home, as every home server is: armed
  # there, it would exit at once, no client being attached yet.
  ORCHESTRATOR_TMUX="$(command -v tmux)" ipy "ia.make_home('$HSRV', 'Orch: x', '$WORK', 'sleep $HMARK', 'suite')" >/dev/null 2>&1
  hsrv new-window -d -t home: -n 'Agent: a' "sleep $HMARK" 2>/dev/null
  hsrv new-window -d -t home: -n 'Agent: b' "sleep $HMARK" 2>/dev/null
  sleep 1
  check "a home server started detached is not ended for having no client yet" "up|3" "$(hserver)|$(hpanes)"
  TERM=xterm-256color "$py" "$WORK/ptyclient.py" tmux -L "$HSRV" attach -t home >/dev/null 2>&1 &
  hclient=$!
  i=0; while [ "$(hsrv list-clients 2>/dev/null | wc -l | tr -d ' ')" = 0 ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
  check "the client of the home tab attaches, and the server is armed" "1|True" \
    "$(hsrv list-clients 2>/dev/null | wc -l | tr -d ' ')|$(ORCHESTRATOR_TMUX="$(command -v tmux)" ipy "print(ia.arm_home('$HSRV', 'suite', ['$(hsrv list-clients -F '#{client_tty}' 2>/dev/null)']))")"
  # A takeover kills window 0 while the tab stays attached: the server stays.
  hsrv kill-window -t home:0 2>/dev/null
  sleep 1
  check "a takeover's kill of window 0 leaves the attached server running" "up|2" "$(hserver)|$(hpanes)"
  { kill "$hclient"; wait "$hclient"; } 2>/dev/null
  i=0; while [ "$(hserver)" = up ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
  sleep 0.5
  check "closing the tab ends the server and every window it held" "down|0" "$(hserver)|$(hpanes)"
  hsrv kill-server 2>/dev/null
  # Why the arm waits for the client: an owner that never attached would never leave, so an arm
  # with no tab of this machine is refused, and the server left as it was.
  hsrv new-session -d -s home "sleep $HMARK" 2>/dev/null
  harm=$(ORCHESTRATOR_TMUX="$(command -v tmux)" ipy "print(ia.arm_home('$HSRV', 'suite', []))" 2>/dev/null)
  check "armed before any client attaches, the arm is refused and the server left as it was" "False|up|" \
    "$harm|$(hserver)|$(hsrv show-options -sqv @home-owners 2>/dev/null)"
  hsrv kill-server 2>/dev/null
  pkill -fx "sleep $HMARK" 2>/dev/null
else
  echo "  skip a home server's end is not checked: no tmux"
fi
echo "== iterm-agents: a session a takeover moved to window 0 ends with the tab =="
# A takeover kills the predecessor's window 0 and moves the successor's window there, the tab still
# attached (cmd_takeover's move-window). The server stays armed: closing the tab then ends the moved
# session too, and every process the server held. A server and a client of the suite's own.
if command -v tmux >/dev/null 2>&1; then
  MVSRV="suite-move-$$"
  MVMARK=$((5600 + $$ % 1000))
  mvsrv() { env -u TMUX -u TMUX_PANE tmux -L "$MVSRV" "$@"; }
  mvalive() { n=0; for p in $1; do ps -p "$p" >/dev/null 2>&1 && n=$((n+1)); done; echo "$n"; }
  # The tab's client, a pty whose master the probe holds, written here too: this block needs no other.
  [ -f "$WORK/ptyclient.py" ] || printf '%s\n' 'import os, pty, sys, time' 'pid, fd = pty.fork()' 'if pid == 0:' \
    '    os.execvp(sys.argv[1], sys.argv[1:])' 'while True:' '    try:' '        os.read(fd, 4096)' '    except OSError:' \
    '        time.sleep(0.2)' > "$WORK/ptyclient.py"
  ORCHESTRATOR_TMUX="$(command -v tmux)" ipy "ia.make_home('$MVSRV', 'Orch: old', '$WORK', 'sleep $MVMARK', 'suite')" >/dev/null 2>&1
  mvsrv new-window -d -t home: -n 'Orch: new' "sleep $MVMARK" 2>/dev/null
  mvsrv new-window -d -t home: -n 'Agent: a' "sleep $MVMARK" 2>/dev/null
  TERM=xterm-256color "$py" "$WORK/ptyclient.py" tmux -L "$MVSRV" attach -t home >/dev/null 2>&1 &
  mvclient=$!
  i=0; while [ "$(mvsrv list-clients 2>/dev/null | wc -l | tr -d ' ')" = 0 ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
  ORCHESTRATOR_TMUX="$(command -v tmux)" ipy "ia.arm_home('$MVSRV', 'suite', ['$(mvsrv list-clients -F '#{client_tty}' 2>/dev/null)'])" >/dev/null 2>&1
  mvsrv kill-window -t home:0 2>/dev/null
  mvsrv move-window -d -s "home:1" -t "home:0" 2>/dev/null
  mvpids=$(mvsrv list-panes -s -t home -F '#{pane_pid}' 2>/dev/null | tr '\n' ' ')
  check "the successor's window is window 0, and the server still runs it beside the agent" "Orch: new|2" \
    "$(mvsrv display-message -p -t home:0 '#W' 2>/dev/null)|$(mvalive "$mvpids")"
  { kill "$mvclient"; wait "$mvclient"; } 2>/dev/null
  i=0; while mvsrv has-session -t home 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
  sleep 0.5
  check "closing the tab ends the server, the moved session and every window it held" "down|0" \
    "$(mvsrv has-session -t home 2>/dev/null && echo up || echo down)|$(mvalive "$mvpids")"
  mvsrv kill-server 2>/dev/null
else
  echo "  skip a moved session's end is not checked: no tmux"
fi
echo "== iterm-agents: a home server ends with its last tab of this machine, never with a view =="
# The operator's rule (2026-11-27): a server ends when the last client of its own machine leaves,
# never when a client attached over ssh from another machine (a remote view) leaves, and none runs
# with no client of its own machine. Local is read on the attaching client's own environment
# (SSH_CONNECTION, which sshd sets): here a viewer is a client started with it set, the real ssh
# attach being proved once on a throwaway server of a remote running tmux 3.4. Servers and
# clients of the suite's own, ended by it.
if command -v tmux >/dev/null 2>&1; then
  OWSRV="suite-owner-$$"
  OWMARK=$((7600 + $$ % 1000))
  owsrv() { env -u TMUX -u TMUX_PANE tmux -L "$OWSRV" "$@"; }
  owup() { owsrv has-session -t home 2>/dev/null && echo up || echo down; }
  owwait() { i=0; while [ "$(owup)" = up ] && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done; }
  [ -f "$WORK/ptyclient.py" ] || printf '%s\n' 'import os, pty, sys, time' 'pid, fd = pty.fork()' 'if pid == 0:' \
    '    os.execvp(sys.argv[1], sys.argv[1:])' 'while True:' '    try:' '        os.read(fd, 4096)' '    except OSError:' \
    '        time.sleep(0.2)' > "$WORK/ptyclient.py"
  owclient() { # <local|view>: a client of the server in a pty of its own; prints its pid
    if [ "$1" = view ]; then env SSH_CONNECTION="192.0.2.1 50000 192.0.2.2 22" TERM=xterm-256color "$py" "$WORK/ptyclient.py" tmux -L "$OWSRV" attach -t home >/dev/null 2>&1 &
    else env -u SSH_CONNECTION TERM=xterm-256color "$py" "$WORK/ptyclient.py" tmux -L "$OWSRV" attach -t home >/dev/null 2>&1 & fi
    echo $!
    n=$(owsrv list-clients 2>/dev/null | wc -l); i=0
    while [ "$(owsrv list-clients 2>/dev/null | wc -l)" -le "$n" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; }
  owgone() { { kill "$1"; wait "$1"; } 2>/dev/null; sleep 0.5; }
  owhome() { # a server made by the launcher, an agent window beside window 0, its tab attached and armed
    ORCHESTRATOR_TMUX="$(command -v tmux)" ipy "ia.make_home('$OWSRV', 'Orch: x', '$WORK', 'sleep $OWMARK', 'suite')" >/dev/null 2>&1
    owsrv new-window -d -t home: -n 'Agent: a' "sleep $OWMARK" 2>/dev/null
    owtab=$(owclient local)
    ORCHESTRATOR_TMUX="$(command -v tmux)" ipy "ia.arm_home('$OWSRV', 'suite', ['$(owsrv list-clients -F '#{client_tty}' 2>/dev/null)'])" >/dev/null 2>&1; }
  owhome
  owview=$(owclient view)
  check "a view attached over ssh is never an owner" "2|1" \
    "$(owsrv list-clients 2>/dev/null | wc -l | tr -d ' ')|$(owsrv show-options -sv @home-owners 2>/dev/null | wc -w | tr -d ' ')"
  owgone "$owview"
  check "the view leaving ends nothing: the server runs on, its windows with it" "up|2" "$(owup)|$(pgrep -fx "sleep $OWMARK" | wc -l | tr -d ' ')"
  owview=$(owclient view)
  owgone "$owtab"; owwait
  check "the tab of this machine leaving ends the server, a view still attached, and every window it held" "down|0" \
    "$(owup)|$(pgrep -fx "sleep $OWMARK" | wc -l | tr -d ' ')"
  owgone "$owview"; owsrv kill-server 2>/dev/null
  owhome
  owsecond=$(owclient local)
  check "a second client of this machine is an owner too" "2" "$(owsrv show-options -sv @home-owners 2>/dev/null | wc -w | tr -d ' ')"
  owgone "$owtab"
  check "the first leaving ends nothing while the second stays" "up" "$(owup)"
  owgone "$owsecond"; owwait
  check "the last of them leaving ends the server" "down" "$(owup)"
  owsrv kill-server 2>/dev/null
  # A restart suspends the arm for its run alone: no tab of this machine left, the server stays.
  owhome
  ORCHESTRATOR_TMUX="$(command -v tmux)" "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia, iterm_restart as r
r.ia = ia
print(r.read_server('$OWSRV')['armed'], end='|'); r.tmux('$OWSRV', *ia.HOME_DISARM); print(r.read_server('$OWSRV')['armed'])" > "$WORK/owdisarm" 2>&1
  owgone "$owtab"
  check "a restart's suspension is read and taken, and the server outlives its tab for the run" "True|False|up" "$(cat "$WORK/owdisarm")|$(owup)"
  owtab=$(owclient local)
  check "and a client that attaches while it is suspended arms nothing" "up|" "$(owup)|$(owsrv show-options -sqv @home-owners 2>/dev/null | tr -d ' ')"
  owgone "$owtab"; owsrv kill-server 2>/dev/null
  # A server armed the old way, by a launcher of before (exit-unattached on), keeps its arm and ends
  # with its last client, whoever it is, until it ends; the restart reads and suspends it too.
  ORCHESTRATOR_TMUX="$(command -v tmux)" ipy "ia.make_home('$OWSRV', 'Orch: x', '$WORK', 'sleep $OWMARK', 'suite')" >/dev/null 2>&1
  owtab=$(owclient local)
  owsrv set-option -s exit-unattached on
  check "a server armed the old way reads as armed" "True" \
    "$(ORCHESTRATOR_TMUX="$(command -v tmux)" ipy "import iterm_restart as r; r.ia = ia; print(r.read_server('$OWSRV')['armed'])" 2>/dev/null)"
  owgone "$owtab"; owwait
  check "and still ends with its last client" "down" "$(owup)"
  owsrv kill-server 2>/dev/null
  # The same rule through the launcher's own paths, on real hooks: the arm given an owner that left
  # before it, a launcher of before suspending the arm, the close of the owner's tab with an agent
  # (keep_home), and a restart's re-arm, done and failed. iTerm2, the agents' hosts and window 0's
  # session are stood in for; the server, its hooks and its clients are real.
  cat > "$WORK/owpaths.py" <<'PY'
import os, subprocess, sys, time
scripts, socket, pty, mark, work, case = sys.argv[1:7]
sys.path.insert(0, scripts)
import iterm_agent as ia, iterm_restart as r
r.ia = ia
def tm(*w): return subprocess.run(["tmux", "-L", socket, *w], capture_output=True, text=True).stdout
def clients(): return tm("list-clients", "-F", "#{client_tty}").split()
def client(view=False):
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE", "SSH_CONNECTION")}
    env["TERM"] = "xterm-256color"
    if view:
        env["SSH_CONNECTION"] = "192.0.2.1 50000 192.0.2.2 22"
    before = set(clients())
    p = subprocess.Popen([sys.executable, pty, "tmux", "-L", socket, "attach", "-t", "home"], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        new = set(clients()) - before
        if new:
            return p, new.pop()
        time.sleep(0.1)
    return p, ""
def leave(p):
    p.kill(); p.wait(); time.sleep(0.5)
def up():
    return subprocess.run(["tmux", "-L", socket, "has-session", "-t", "home"], capture_output=True).returncode == 0
def windows():
    return subprocess.run(["pgrep", "-fx", "sleep %s" % mark], capture_output=True, text=True).stdout.count("\n")
def home(arm=True):
    ia.make_home(socket, "Orch: x", work, "sleep %s" % mark, "suite")
    tm("new-window", "-d", "-t", "home:", "-n", "Agent: a", "sleep %s" % mark)
    tab = client()
    if arm:
        ia.arm_home(socket, "suite", [tab[1]])
    return tab
said = lambda *v: print("|".join(str(x) for x in v))
ia.trace_home = lambda *a: None
ia.live_homes = lambda: [socket] if up() else []
if case == "gone":
    # Its owner gone before the arm: the server ends, a view attached or none.
    for view in (True, False):
        tab = home(arm=False)
        seen = client(True) if view else None
        leave(tab[0])
        armed = ia.arm_home(socket, "suite", [tab[1]])
        time.sleep(0.5)
        said(armed, "up" if up() else "down", windows())
        if seen:
            leave(seen[0])
        tm("kill-server")
elif case == "older":
    # A launcher of before reads the arm on exit-unattached and suspends it by turning it off.
    tab = home()
    read = tm("show-options", "-sv", "exit-unattached").strip()
    tm("set-option", "-s", "exit-unattached", "off")
    leave(tab[0])
    kept = "up" if up() else "down"
    tab = client()
    tm("set-option", "-s", "exit-unattached", "on")
    leave(tab[0])
    said(read, kept, "up" if up() else "down")
elif case == "close":
    # The owner's tab closed by the launcher with an agent running: a new tab owns the server first,
    # then window 0 ends; once that tab leaves too, the server ends, a view still attached.
    tab = home()
    seen = client(True)
    made = {}
    class Tabs:
        def create(self, program, title, place, profile, made_):
            made_["p"], made["tty"] = client()
            made["p"] = made_["p"]
            return made["tty"], None
        def close(self, tty, why):
            leave(tab[0])
        def find(self, tty):
            return tty in clients()
        def close_made(self, made_):
            leave(made_["p"])
            return True
    ia.ITERM = Tabs()
    ia.window0_session = lambda what, s, listed=None, bench=False: (listed[0], "sid")
    ia.home_agents = lambda what, s, panes: [(i, t, "Agent: a") for i, t in panes if i != "0"]
    ia.host_identity = lambda tty: None
    ia.wait_gone = lambda tty, timeout=None: None
    out, sys.stdout = sys.stdout, open(os.devnull, "w")
    ia.keep_home(tab[1], socket, ia.home_panes(socket))
    sys.stdout = out
    kept = ("up" if up() else "down", ia.home_owners(socket) == [made["tty"]], windows())
    leave(made["p"])
    said(*(kept + ("up" if up() else "down", windows())))
    leave(seen[0])
elif case in ("rearm", "rearm-none"):
    tab = home()
    seen = client(True)
    tm(*ia.HOME_DISARM)
    leave(tab[0])
    suspended = "up" if up() else "down"
    new = client() if case == "rearm" else (None, "")
    run = r.Run.__new__(r.Run)
    run.s = {"disarmed": [socket], "servers": {socket: {"clients": [tab[1], seen[1]], "local": [tab[1]]}},
             "sessions": [], "moved": {}, "defects": []}
    ia.app_pid = lambda: "1"
    r.layout = lambda: [[[{"tty": new[1], "title": ""}]]] if new[1] else []
    run.rearm()
    owners = ia.home_owners(socket)
    if new[0]:
        leave(new[0])
    said(suspended, owners == ([new[1]] if new[1] else []), "up" if up() else "down", windows(), len(run.s["defects"]))
    leave(seen[0])
elif case == "partial":
    # Two tabs of this machine, one gone before the arm lists both: the live one alone owns it.
    tab = home(arm=False)
    other = client()
    leave(other[0])
    armed = ia.arm_home(socket, "suite", [tab[1], other[1]])
    time.sleep(0.5)
    said(armed, "up" if up() else "down", ia.home_owners(socket) == [tab[1]], windows())
    leave(tab[0])
elif case == "unread":
    # The arm taken, then the clients cannot be listed: no owner is dropped, nothing is ended.
    tab = home(arm=False)
    calls, real = [], ia.tmux_call
    def failing(args, env=None):
        calls.append(args)
        if "list-clients" in args:
            return subprocess.CompletedProcess(args, 1, "", "no answer")
        return real(args, env)
    ia.tmux_call = failing
    armed = ia.arm_home(socket, "suite", [tab[1]])
    ia.tmux_call = real
    said(armed, "up" if up() else "down", sum("-sF" in c or "kill-server" in c for c in calls), windows())
    leave(tab[0])
elif case == "remote":
    # A restart reads a view attached over ssh as remote on its client's own environment, and a
    # server armed the old way, which lists no owner, counts its tab alone as of this machine.
    tab = home(arm=False)
    seen = client(True)
    tm("set-option", "-s", "exit-unattached", "on")
    server = r.read_server(socket)
    said(server["remote"] == [seen[1]], r.local_clients(server) == [tab[1]])
    tm("set-option", "-s", "exit-unattached", "off")
    leave(seen[0]); leave(tab[0])
tm("kill-server")
PY
  owpaths() { ORCHESTRATOR_TMUX="$(command -v tmux)" ORCHESTRATOR_STATE_DIR="$WORK/owstate" "$py" "$WORK/owpaths.py" \
    "$ROOT/skills/iterm-agents/scripts" "$OWSRV" "$WORK/ptyclient.py" "$OWMARK" "$WORK" "$1" 2>/dev/null | paste -sd'~' -; }
  check "an owner that left before the arm leaves no server running: it ends, a view attached or none, every window with it" \
    "False|down|0~False|down|0" "$(owpaths gone)"
  check "a launcher of before reads the arm as armed, its suspension holds the server with no tab, and its re-arm ends it with its tab" \
    "on|up|down" "$(owpaths older)"
  check "closing the owner's tab with an agent hands the server to a new tab first, window 0 alone ended; that tab leaving ends it, a view attached" \
    "up|True|1|down|0" "$(owpaths close)"
  check "a restart's re-arm makes the tab of this machine alone an owner, a view never one, and the tab leaving ends the server" \
    "up|True|down|0|0" "$(owpaths rearm)"
  check "a re-arm with no tab of this machine left ends the server, a view attached, and says so: no server is left disarmed" \
    "up|True|down|0|1" "$(owpaths rearm-none)"
  check "an arm listing a tab gone beside a live one takes the gone one off and keeps the server, the live tab its one owner" \
    "True|up|True|2" "$(owpaths partial)"
  check "an arm whose clients cannot be listed after it drops no owner and ends nothing" "False|up|0|2" "$(owpaths unread)"
  if [ "$(uname)" = Darwin ]; then
    check "a restart reads a view as remote on its client's environment, and a server armed the old way has its tab alone as local" \
      "True|True" "$(owpaths remote)"
  else
    skip_case "a restart reads a view as remote on its client's environment" "a process's environment is read on macOS only"
  fi
  pkill -fx "sleep $OWMARK" 2>/dev/null
else
  echo "  skip a home server's owners are not checked: no tmux"
fi
echo "== iterm-agents: agents as windows of a home session =="
# Inside a tmux session the home command marked (`@orchestrator-home` = 1), an agent is a
# window of that session and every operation goes to tmux; anywhere else, a plain tab or a
# tmux session the operator made by hand, nothing changes. The suite stands a recorder in
# for tmux (ORCHESTRATOR_TMUX), as ORCHESTRATOR_PS_TABLE stands in for `ps`: it writes the
# argv of every call, one call per line and each word in brackets, and answers from the
# files beside it. The windows are tab-separated lines: session, index, window id, pane id,
# pane tty, window name, pane title. A window it makes joins the listing, its session joins
# the process table and writes its transcript (unless REC_NO_HOST says its session never
# starts); a window it kills leaves both, unless REC_KEEP_WINDOW keeps its pane listed or
# REC_KEEP_HOST keeps its host in the table (1 for every window, or one window's tty).
# While it makes a window, REC_RENAME_ON_NEW ('<window id> <name>') renames another and
# REC_GONE_ON_NEW (a window id) drops one from the listing, and REC_ADD_ON_NEW (a listing line,
# its fields separated by \t) adds one.
TR="$WORK/tmuxrec"; mkdir -p "$TR"
cat > "$TR/tmux" <<'SH'
#!/bin/bash
d=$(dirname "$0")
{ for a in "$@"; do printf '[%s]' "$a"; done; printf '\n'; } >> "$d/calls"
[ "$1" = -u ] && shift
case "$1" in
  show) [ -f "$d/mark" ] && cat "$d/mark"; exit 0 ;;
  display-message) if [ "${@: -1}" = '#{window_active}' ]; then printf '%s\n' "${REC_ACTIVE:-0}"; else printf '%s\n' "${REC_SESSION:-\$1}"; fi ;;
  list-panes)
    [ -n "${REC_PANES_RAW:-}" ] && { printf '%b' "$REC_PANES_RAW"; exit 0; }
    if [ "$2" = -a ]; then cat "$d/panes"; else awk -F'\t' -v s="$4" '$1 == s' "$d/panes"; fi ;;
  new-window)
    name=""; prev=""
    for a in "$@"; do [ "$prev" = -n ] && name="$a"; prev="$a"; done
    read -r win pane tty < "$d/new"
    # What changes elsewhere while the window is made: a window renamed, or one gone.
    [ -n "${REC_RENAME_ON_NEW:-}" ] && awk -F'\t' -v OFS='\t' -v w="${REC_RENAME_ON_NEW%% *}" -v n="${REC_RENAME_ON_NEW#* }" '$3 == w { $6 = n } 1' "$d/panes" > "$d/panes.tmp" && mv "$d/panes.tmp" "$d/panes"
    [ -n "${REC_GONE_ON_NEW:-}" ] && awk -F'\t' -v w="$REC_GONE_ON_NEW" '$3 != w' "$d/panes" > "$d/panes.tmp" && mv "$d/panes.tmp" "$d/panes"
    [ -n "${REC_ADD_ON_NEW:-}" ] && printf '%b\n' "$REC_ADD_ON_NEW" >> "$d/panes"
    [ -n "${REC_NEW_RAW:-}" ] && { printf '%s\n' "$REC_NEW_RAW"; exit 0; }
    printf '$1\t9\t%s\t%s\t%s\t%s\t%s\n' "$win" "$pane" "$tty" "$name" "$name" >> "$d/panes"
    if [ -z "${REC_NO_HOST:-}" ]; then
      printf '%s claude --name %s\n' "$tty" "$name" >> "$d/ps"
      mkdir -p "$d/projects/w"
      printf '{"permissionMode":"auto"}\n{"cwd":"%s"}\n' "$REC_CWD" > "$d/projects/w/$win.jsonl"
    fi
    cat "$d/new" ;;
  capture-pane)
    [ -n "${REC_CAPTURE_ERR:-}" ] && { echo "$REC_CAPTURE_ERR" >&2; exit 1; }
    cat "$d/screen"
    # What the operator does after the first read: the screen he leaves (sent or cleared).
    [ -f "$d/screen.next" ] && mv "$d/screen.next" "$d/screen" ;;
  kill-window)
    tty=$(awk -F'\t' -v w="$3" '$3 == w { print $5 }' "$d/panes")
    [ -z "${REC_KEEP_WINDOW:-}" ] && awk -F'\t' -v w="$3" '$3 != w' "$d/panes" > "$d/panes.tmp" && mv "$d/panes.tmp" "$d/panes"
    case "${REC_KEEP_HOST:-}" in 1|"$tty") ;; *) grep -v "^$tty " "$d/ps" > "$d/ps.tmp"; mv "$d/ps.tmp" "$d/ps" ;; esac
    [ -n "${REC_KILL_ERR:-}" ] && { echo "$REC_KILL_ERR" >&2; exit 1; }
    exit 0 ;;
  move-window)
    [ "$2" = -r ] && [ -n "${REC_RENUMBER_ERR:-}" ] && { echo "$REC_RENUMBER_ERR" >&2; exit 1; }
    [ "$2" = -r ] && [ -f "$d/panes.moved" ] && mv "$d/panes.moved" "$d/panes" ;;
esac
exit 0
SH
chmod +x "$TR/tmux"
# An osascript that records it was asked: the iTerm path reached is the only thing it says.
printf '#!/bin/bash\ncat >/dev/null\necho asked >> "%s"\nexit 1\n' "$TR/iterm-asked" > "$TR/osascript"
chmod +x "$TR/osascript"
TSOCK=/private/tmp/tmux-501/home
TSTATE="$WORK/tmuxstate"
reset_home() { # the home session: the orchestrator in window 0, two agents, a stranger's session
  rm -rf "$TSTATE" "$TR/projects" "$TR/calls" "$TR/panes.moved" "$TR/screen.next"
  mkdir -p "$TSTATE/chains"
  # Each host's prompt box, empty: a close reads it before the kill.
  printf '%s\n' "$PEMPTY" > "$TR/screen"
  printf '1\n' > "$TR/mark"
  printf '%s\n' '$1	0	@0	%0	/dev/ttys900	orch	✳ Orch: home' \
    '$1	1	@1	%1	/dev/ttys901	Agent: one	✳ Agent: one' \
    '$1	2	@2	%2	/dev/ttys902	Agent: two	⠂ Agent: two' \
    '$2	0	@3	%3	/dev/ttys950	other	✳ elsewhere' > "$TR/panes"
  printf '%s\n' '/dev/ttys900 claude --name Orch: home' '/dev/ttys901 claude --name Agent: one' \
    '/dev/ttys902 claude --name Agent: two' '/dev/ttys950 claude --name Agent: stranger' > "$TR/ps"
  printf '@4 %%4 /dev/ttys903\n' > "$TR/new"
  printf '{"tab_id":"tmux:%s:@1","tty":"/dev/ttys901","owner":"tmux:%s:%%0"}\n{"tab_id":"tmux:%s:@2","tty":"/dev/ttys902","owner":"tmux:%s:%%0"}\n' \
    "$TSOCK" "$TSOCK" "$TSOCK" "$TSOCK" > "$TSTATE/chains/ttys900.jsonl"
}
home() { # <subcommand and options>: the launcher, called from window 0 of the home session
  local pair=''; case "$1" in spawn|rotate) pair=$(needs_tier "$@") ;; esac
  CLAUDE_CODE_SESSION_ID="${CLAUDE_CODE_SESSION_ID-s-suite}" TMUX="$TSOCK,4242,1" TMUX_PANE=%0 ORCHESTRATOR_TMUX="${REC_TMUX:-$TR/tmux}" ORCHESTRATOR_OSASCRIPT="$TR/osascript" \
    ORCHESTRATOR_SAMPLE=/usr/bin/false ORCHESTRATOR_APP_PID=1 ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_STATE_DIR="$TSTATE" ORCHESTRATOR_LOGIN_SHELL=/bin/sh \
    ORCHESTRATOR_PS_TABLE="$TR/ps" ORCHESTRATOR_PROJECTS_DIR="$TR/projects" REC_CWD="$(cd "$WORK" && pwd -P)" \
    ORCHESTRATOR_CLOSE_TIMEOUT=1 ORCHESTRATOR_SPAWN_TIMEOUT=2 ORCHESTRATOR_MODE_TIMEOUT=3 \
    bash "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh" "$@" $pair; }
calls() { sed "s#$TSTATE#@STATE@#g; s#-[0-9]\{13\}\.#-@TIME@.#g" "$TR/calls" 2>/dev/null; }
asked() { [ -f "$TR/iterm-asked" ] && echo iterm || echo none; }
chainf() { cat "$TSTATE/chains/ttys900.jsonl" 2>/dev/null; }
FMT='#{session_id}	#{window_index}	#{window_id}	#{pane_id}	#{pane_tty}	#{window_name}	#{pane_title}'
SHOW='[-u][show][-qv][-t][%0][@orchestrator-home]'
SESS='[-u][display-message][-p][-t][%0][#{session_id}]'
LIST="[-u][list-panes][-s][-t][\$1][-F][$FMT]"

# The switch: the mark, read on the caller's own server, or the tab as today.
switch() { "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
print(type(ia.terminal()).__name__)"; }
reset_home
check "in a marked session, the terminal is tmux, read by asking for the mark on the caller's pane" \
  "TmuxTerminal|$SHOW" \
  "$(TMUX="$TSOCK,4242,1" TMUX_PANE=%0 ORCHESTRATOR_TMUX="$TR/tmux" switch)|$(calls)"
rm -f "$TR/mark" "$TR/calls"
check "a tmux session without the mark (one the operator made by hand) keeps the tab" "ItermTerminal|$SHOW" \
  "$(TMUX="$TSOCK,4242,1" TMUX_PANE=%0 ORCHESTRATOR_TMUX="$TR/tmux" switch)|$(calls)"
printf '0\n' > "$TR/mark"; rm -f "$TR/calls"
check "a mark that is not 1 keeps the tab" "ItermTerminal" \
  "$(TMUX="$TSOCK,4242,1" TMUX_PANE=%0 ORCHESTRATOR_TMUX="$TR/tmux" switch)"
printf '1\n' > "$TR/mark"; rm -f "$TR/calls"
check "outside tmux the tab is kept and tmux is never asked" "ItermTerminal|ItermTerminal|" \
  "$(unset TMUX TMUX_PANE; ORCHESTRATOR_TMUX="$TR/tmux" switch)|$(TMUX="$TSOCK,4242,1" ORCHESTRATOR_TMUX="$TR/tmux" switch)|$(calls)"
# Inside a tmux pane, a tmux that cannot answer is no « not a home session »: the launch dies
# saying why, and no tab is made in its place.
out=$(TMUX="$TSOCK,4242,1" TMUX_PANE=%0 ORCHESTRATOR_TMUX="$WORK/no-such-tmux" switch 2>&1)
check "a tmux that cannot be run dies naming the cause, never keeping the tab" "1|1|0" \
  "$(printf '%s' "$out" | grep -c '^ERROR: tmux: the home session.s mark cannot be read from pane %0 (.*binary absent)')|$(printf '%s\n' "$out" | grep -c '')|$(printf '%s' "$out" | grep -c 'ItermTerminal')"
rm -f "$TR/mark"
out=$(home list 2>&1)
check "and an unmarked session's listing goes to iTerm2, not to tmux" "iterm|$SHOW" "$(asked)|$(calls)"
rm -f "$TR/iterm-asked"

reset_home
rm -f "$TR/iterm-asked"
out=$(home list 2>/dev/null)
check "list: the home session's windows, in the shape the stop gate parses, the caller's own marked" \
  "w1/t0 | /dev/ttys900 | ✳ Orch: home | Orch: home | self⏎w1/t1 | /dev/ttys901 | ✳ Agent: one | Agent: one⏎w1/t2 | /dev/ttys902 | ⠂ Agent: two | Agent: two" \
  "$(printf '%s' "$out" | nl_join)"
check "list asks the mark, the session, then its panes, then the app for the tabs it did not make" \
  "${SHOW}⏎${SESS}⏎${LIST}|iterm" "$(calls | nl_join)|$(asked)"
rm -f "$TR/iterm-asked"

reset_home
out=$(home spawn --dir "$WORK" --title "Agent: three" --prompt p --right-of self --no-verify 2>"$WORK/tspawn.err")
check "spawn: a window of the home session, detached, named, its ids and tty printed back, the launch file as its program" \
  "/dev/ttys903|[-u][new-window][-d][-t][\$1:][-n][Agent: three][-P][-F][#{window_id} #{pane_id} #{pane_tty}][/bin/sh -l @STATE@/prompts/launch-Agent--three-@TIME@.sh]|none" \
  "$out|$(calls | grep -F '[new-window]')|$(asked)"
check "and the chain entry names the window by the server's socket and its id, owned by the caller's pane" \
  "{\"tab_id\": \"tmux:$TSOCK:@4\", \"tty\": \"/dev/ttys903\", \"owner\": \"tmux:$TSOCK:%0\"}" "$(chainf | tail -1)"
check "the window is made once, and nothing is placed: windows follow in launch order" "1|0" \
  "$(calls | grep -c '\[new-window\]')|$(calls | grep -c '\[move-window\]')"

reset_home
printf 'a\nb\nc\n\n\n' > "$TR/screen"
check "screen: the pane's capture with its scrollback, read from the bottom" \
  "b⏎c|[-u][capture-pane][-p][-t][%1][-S][-2]" \
  "$(home screen --tty /dev/ttys901 --lines 2 | nl_join)|$(calls | grep -F '[capture-pane]')"

reset_home
out=$(home close --tty /dev/ttys901 --expect-title "Agent: one" 2>&1)
check "close: the window killed by its id, proved gone from the process table, its chain entry dropped" \
  "closed 1 session on /dev/ttys901|[-u][kill-window][-t][@1]|0|0|1" \
  "$(printf '%s\n' "$out" | grep '^closed')|$(calls | grep -F '[kill-window]')|$(grep -c ttys901 "$TR/ps")|$(chainf | grep -c '@1')|$(chainf | grep -c '@2')"
# The window's prompt holds what the operator typed and has not sent: the close reads it on the
# pane's capture, styles included, and refuses at its bound with nothing killed; a rotation keeps
# its replacement and the old window both.
reset_home
printf '%s\n' "$PTYPED" > "$TR/screen"
out=$(ORCHESTRATOR_INPUT_WAIT=0 home close --tty /dev/ttys901 --expect-title "Agent: one" 2>&1); rc=$?
check "close: a window whose prompt holds typed text is refused, nothing killed, its host and chain entry kept" \
  "1|1|[-u][capture-pane][-p][-e][-t][%1]|0|1|1" \
  "$([ "$rc" -ne 0 ] && echo 1 || echo 0)|$(printf '%s' "$out" | grep -c 'close: refused: the prompt on /dev/ttys901 still holds text .*His text: «je réponds')|$(calls | grep -F '[capture-pane]')|$(calls | grep -c '\[kill-window\]')|$(grep -c ttys901 "$TR/ps")|$(chainf | grep -c '@1')"
reset_home
printf '%s\n' "$PTYPED" > "$TR/screen"
out=$(ORCHESTRATOR_INPUT_WAIT=0 home rotate --old-tty /dev/ttys901 --expect-title "Agent: one" --dir "$WORK" --title "Agent: one" --prompt p 2>&1); rc=$?
check "rotate: typed text in the old window keeps it, beside its replacement, which runs" "1|new-window|1|1" \
  "$([ "$rc" -ne 0 ] && echo 1 || echo 0)|$(calls | grep -oE '\[(new|kill)-window\]' | tr -d '[]' | tr '\n' ' ' | sed 's/ $//')|$(printf '%s' "$out" | grep -c 'rotate: the old session on /dev/ttys901 was not closed: its close refused before it ended anything')|$(grep -c ttys903 "$TR/ps")"
reset_home
printf '%s\n' "$PEMPTY" > "$TR/screen"
out=$(ORCHESTRATOR_INPUT_WAIT=0 home close --tty /dev/ttys901 --expect-title "Agent: one" 2>&1)
check "close: a window whose prompt shows only the host's faint placeholder is closed as before" "closed 1 session on /dev/ttys901|1" \
  "$(printf '%s\n' "$out" | grep '^closed')|$(calls | grep -c '\[kill-window\]')"
# He sends or clears his text during the wait: the close, which read it, waits, then kills.
reset_home
printf '%s\n' "$PTYPED" > "$TR/screen"; printf '%s\n' "$PEMPTY" > "$TR/screen.next"
out=$(ORCHESTRATOR_INPUT_WAIT=10 home close --tty /dev/ttys901 --expect-title "Agent: one" 2>&1)
check "close: a window whose prompt holds his text waits for it to be sent or cleared, then is closed" \
  "1|closed 1 session on /dev/ttys901|2|1|1" \
  "$(printf '%s\n' "$out" | grep -c '^close: the prompt on /dev/ttys901 holds text the operator typed and has not sent: waiting up to 10s')|$(printf '%s\n' "$out" | grep '^closed')|$(calls | grep -c '\[capture-pane\]')|$(calls | grep -c '\[kill-window\]')|$(printf '%s\n' "$out" | grep -c '^close: the operator sent or cleared what he typed in the prompt on /dev/ttys901')"
# A capture tmux refuses is a prompt that cannot be read: refused, nothing killed.
reset_home
out=$(REC_CAPTURE_ERR="can't find pane: %1" home close --tty /dev/ttys901 --expect-title "Agent: one" 2>&1); rc=$?
check "close: a window whose pane tmux fails to capture is refused, nothing killed, its host kept" "3|1|0|1" \
  "$rc|$(printf '%s' "$out" | grep -c 'close: refused: the prompt on /dev/ttys901 cannot be read (.*), so whether it holds text the operator typed and has not sent is not known')|$(calls | grep -c '\[kill-window\]')|$(grep -c ttys901 "$TR/ps")"
rm -f "$TR/screen"
reset_home
out=$(home close --tty /dev/ttys902 --expect-title "Agent: one" 2>&1)
check "a window whose name does not hold the expected words is not killed" "1|0" \
  "$(printf '%s' "$out" | grep -c "close: refused: the window on /dev/ttys902 is named 'Agent: two', which does not contain 'Agent: one'")|$(calls | grep -c '\[kill-window\]')"
reset_home
out=$(home close --tty /dev/ttys901 --expect-title '' 2>&1)
check "an empty title to expect is refused before anything is closed, a blank one too" "1|0|1|0" \
  "$(printf '%s' "$out" | grep -c 'close: refused: --expect-title is empty: give the title `list` printed for /dev/ttys901')|$(calls | grep -c '\[kill-window\]')|$(home close --tty /dev/ttys901 --expect-title '  ' 2>&1 | grep -c 'expect-title is empty')|$(calls | grep -c '\[kill-window\]')"
reset_home
out=$(home close --tty /dev/ttys950 2>&1)
check "nor is a window of another session" "1|0" \
  "$(printf '%s' "$out" | grep -c 'close: refused: /dev/ttys950 is a window of another tmux session')|$(calls | grep -c '\[kill-window\]')"
rm -f "$TR/iterm-asked"
out=$(home close --tty /dev/ttys999 2>&1)
check "and a tty no window of the server runs on is an iTerm2 tab's, asked of the app" "iterm|0|0" \
  "$(asked)|$(printf '%s' "$out" | grep -c 'no window of this home session runs on')|$(calls | grep -c '\[kill-window\]')"
rm -f "$TR/iterm-asked"

reset_home
printf '%s\n' '$1	0	@0	%0	/dev/ttys900	orch	✳ Orch: home' \
  '$1	1	@2	%2	/dev/ttys902	Agent: two	⠂ Agent: two' \
  '$1	2	@1	%1	/dev/ttys901	Agent: one	✳ Agent: one' > "$TR/panes.moved"
out=$(home move --tty /dev/ttys902 --left-of /dev/ttys901 2>&1)
check "move: before its anchor, without taking the operator's window, the indexes closed up after" \
  "moved /dev/ttys902 to position 1|[-u][move-window][-d][-b][-s][@2][-t][@1]⏎[-u][move-window][-r][-t][\$1]" \
  "$out|$(calls | grep -F '[move-window]' | nl_join)"
reset_home
out=$(home move --tty /dev/ttys901 --right-of /dev/ttys902 2>&1)
check "and after it, on --right-of" "[-u][move-window][-d][-a][-s][@1][-t][@2]" \
  "$(calls | grep -F '[move-window]' | head -1)"
for m in "--tty /dev/ttys900 --right-of /dev/ttys901|the window on /dev/ttys900 is window 0" \
         "--tty /dev/ttys901 --left-of /dev/ttys900|window 0 is the orchestrator" \
         "--tty /dev/ttys901 --leftmost|window 0 is the orchestrator" \
         "--tty /dev/ttys950 --right-of /dev/ttys901|/dev/ttys950 is a window of another tmux session" \
         "--tty /dev/ttys901 --right-of /dev/ttys950|/dev/ttys950 is a window of another tmux session"; do
  reset_home
  out=$(eval "home move ${m%%|*} --force" 2>&1)
  check "move refuses, moving nothing: ${m%%|*}" "1|0" \
    "$(printf '%s' "$out" | grep -c -- "${m#*|}")|$(calls | grep -c '\[move-window\]')"
done
reset_home
printf '{"tab_id":"tmux:%s:@9","tty":"/dev/ttys902","owner":"tmux:%s:%%0"}\n' "$TSOCK" "$TSOCK" > "$TSTATE/chains/ttys900.jsonl"
rm -f "$TR/calls"
out=$(home move --tty /dev/ttys902 --left-of /dev/ttys901 2>&1)
check "a window whose id the caller's chain does not hold is moved with a warning, the window and the indexes closed up" "1|2" \
  "$(printf '%s' "$out" | grep -c 'is not in this session.s chain: moved anyway')|$(calls | grep -c '\[move-window\]')"

reset_home
out=$(home rotate --old-tty /dev/ttys901 --expect-title "Agent: one" --dir "$WORK" --title "Agent: one" --prompt p 2>"$WORK/trot.err")
check "rotate: the replacement's window first, verified on the process table and its transcript, then the old window killed" \
  "/dev/ttys903⏎closed 1 session on /dev/ttys901|new-window kill-window|1|1" \
  "$(printf '%s' "$out" | nl_join)|$(calls | grep -oE '\[(new|kill)-window\]' | tr -d '[]' | tr '\n' ' ' | sed 's/ $//')|$(grep -c 'running on /dev/ttys903' "$WORK/trot.err")|$(grep -c 'mode auto read on the transcript' "$WORK/trot.err")"
check "and the chain trades the old window's entry for the new one's" "@2|@4" \
  "$(chainf | sed -n 's/.*:\(@[0-9]*\)".*/\1/p' | tr '\n' '|' | sed 's/|$//')"
reset_home
out=$(REC_NO_HOST=1 home spawn --dir "$WORK" --title "Agent: dud" --prompt p --right-of self 2>&1)
check "a window whose session never started is killed by its own id, and the chain is left as it was" \
  "1|[-u][kill-window][-t][@4]|2" \
  "$(printf '%s' "$out" | grep -c 'never started on /dev/ttys903 after 2s; the tab was closed')|$(calls | grep -F '[kill-window]')|$(chainf | wc -l | tr -d ' ')"
check "nothing of iTerm2 was asked by any of these, in a marked session" "none" "$(asked)"

# A rotation spawns the replacement first and closes the old window after, so whatever the close
# would refuse is refused before the spawn: the replacement would otherwise be left running
# beside the session it was meant to replace. Nothing is spawned and nothing is killed.
reset_home
out=$(home rotate --old-tty /dev/ttys950 --dir "$WORK" --title "Agent: rotated" --prompt p 2>&1)
rc=$?
check "rotate of a window of another tmux session is refused before anything is spawned or killed" "1|1|0|0" \
  "$(printf '%s' "$out" | grep -c 'rotate: refused: /dev/ttys950 is a window of another tmux session')|$([ "$rc" -ne 0 ] && echo 1 || echo 0)|$(calls | grep -c '\[new-window\]')|$(calls | grep -c '\[kill-window\]')"
reset_home
out=$(home rotate --old-tty /dev/ttys902 --expect-title "Agent: one" --dir "$WORK" --title "Agent: rotated" --prompt p 2>&1)
rc=$?
check "rotate of a window whose name does not hold the expected words is refused before anything is spawned or killed" "1|1|0|0" \
  "$(printf '%s' "$out" | grep -c "rotate: refused: the window on /dev/ttys902 is named 'Agent: two', which does not contain 'Agent: one'")|$([ "$rc" -ne 0 ] && echo 1 || echo 0)|$(calls | grep -c '\[new-window\]')|$(calls | grep -c '\[kill-window\]')"
# A tty a brief printed may be another agent's by the time the rotation runs: a window's name is
# fixed at its making, so a rotation of a window must say whose it expects, and is refused without.
reset_home
out=$(home rotate --old-tty /dev/ttys901 --dir "$WORK" --title "Agent: rotated" --prompt p 2>&1)
rc=$?
check "rotate of a window with no --expect-title is refused before anything is spawned or killed" "1|1|0|0" \
  "$(printf '%s' "$out" | grep -c "rotate: refused: --expect-title is required for a window of a home session: give the name .list. printed for /dev/ttys901")|$([ "$rc" -ne 0 ] && echo 1 || echo 0)|$(calls | grep -c '\[new-window\]')|$(calls | grep -c '\[kill-window\]')"
reset_home
out=$(home rotate --old-tty /dev/ttys900 --dir "$WORK" --title "Agent: rotated" --prompt p 2>&1)
rc=$?
check "rotate of window 0 stays refused before anything is spawned, through the check close shares" "1|1|0|0" \
  "$(printf '%s' "$out" | grep -c 'rotate: refused: the window on /dev/ttys900 is window 0')|$([ "$rc" -ne 0 ] && echo 1 || echo 0)|$(calls | grep -c '\[new-window\]')|$(calls | grep -c '\[kill-window\]')"
# What only the close can know comes after the spawn, and once spawned the replacement is never
# closed: two agents can be recovered by hand, none cannot. A close of the old session that
# refused, failed or raised, and a read of it that failed, end on one `rotate:` line that names
# both sessions and the step that finishes by hand, and the rotation exits non-zero; stdout
# carries the spawn's tty line, and the close's « closed » line only when the old one closed.
reset_home
out=$(REC_KEEP_WINDOW=1 REC_KEEP_HOST=1 REC_KILL_ERR="server busy" home rotate --old-tty /dev/ttys901 --expect-title "Agent: one" --dir "$WORK" --title "Agent: rotated" --prompt p 2>"$WORK/rot-err")
rc=$?; err=$(cat "$WORK/rot-err")
check "a close whose kill tmux refused keeps the replacement, and names the close of the old window that still stands, guarded on its name" "1|1|1|[-u][kill-window][-t][@1]|1|1|/dev/ttys903" \
  "$(printf '%s' "$err" | grep -c 'ERROR: close: tmux refused kill-window: server busy')|$(printf '%s' "$err" | grep -cF 'ERROR: rotate: the close of the old session on /dev/ttys901 failed; the replacement runs on /dev/ttys903 and is kept; its window or tab is still there, the same window @1 as before the spawn: close it with close --tty /dev/ttys901 --expect-title '"'"'Agent: one'"'"' --keep-checkout (its chain entry is left for that close)')|$([ "$rc" -ne 0 ] && echo 1 || echo 0)|$(calls | grep -F '[kill-window]' | paste -sd'|' -)|$(chainf | grep -c '@4')|$(chainf | grep -c '@1')|$out"
reset_home
out=$(REC_KEEP_HOST=1 home rotate --old-tty /dev/ttys901 --expect-title "Agent: one" --dir "$WORK" --title "Agent: rotated" --prompt p 2>"$WORK/rot-err")
rc=$?; err=$(cat "$WORK/rot-err")
check "a close that took the old window but not its host keeps the replacement, and names neither a kill of a host never identified nor a close of a window that is gone" "1|1|0|1|[-u][kill-window][-t][@1]|1|1|/dev/ttys903" \
  "$(printf '%s' "$err" | grep -c 'ERROR: close: the request was accepted but .* is still running on /dev/ttys901')|$(printf '%s' "$err" | grep -cF "ERROR: rotate: the close of the old session on /dev/ttys901 failed; the replacement runs on /dev/ttys903 and is kept; a host runs on /dev/ttys901, but the old one's pid was not read before the spawn, so it cannot be told from another session's: no kill is named; its window or tab is gone, and its chain entry is left")|$(printf '%s' "$err" | grep '^ERROR: rotate:' | grep -c 'close --tty /dev/ttys901')|$([ "$rc" -ne 0 ] && echo 1 || echo 0)|$(calls | grep -F '[kill-window]' | paste -sd'|' -)|$(chainf | grep -c '@4')|$(chainf | grep -c '@1')|$out"
# A window renamed during the spawn: the close refuses it by its name, before any kill, and the
# replacement stays beside it, its window never killed and its chain entry kept. The window is
# still the one read before the spawn (its id, not its name), so the line names its close.
reset_home
out=$(REC_RENAME_ON_NEW='@1 Agent: renamed' home rotate --old-tty /dev/ttys901 --expect-title "Agent: one" --dir "$WORK" --title "Agent: rotated" --prompt p 2>"$WORK/rot-err")
rc=$?; err=$(cat "$WORK/rot-err")
check "a close refused by its name before any kill keeps the replacement, and names the close of the old window that still stands, guarded on the name it has now" "1|1|1|0|1|1|/dev/ttys903" \
  "$(printf '%s' "$err" | grep -c "ERROR: close: refused: the window on /dev/ttys901 is named 'Agent: renamed'")|$(printf '%s' "$err" | grep -cF 'ERROR: rotate: the old session on /dev/ttys901 was not closed: its close refused before it ended anything; the replacement runs on /dev/ttys903 and is kept; its window or tab is still there, the same window @1 as before the spawn: close it with close --tty /dev/ttys901 --expect-title '"'"'Agent: renamed'"'"' --keep-checkout (its chain entry is left for that close)')|$([ "$rc" -ne 0 ] && echo 1 || echo 0)|$(calls | grep -c '\[kill-window\]')|$(chainf | grep -c '@4')|$(chainf | grep -c '@1')|$out"
# The old window gone during the spawn: it is read by its id before the spawn and looked for
# again before the close, so nothing is killed; the replacement is kept, and the one line names
# it and the host left behind.
reset_home
out=$(REC_GONE_ON_NEW=@1 home rotate --old-tty /dev/ttys901 --expect-title "Agent: one" --dir "$WORK" --title "Agent: rotated" --prompt p 2>"$WORK/rot-err")
rc=$?; err=$(cat "$WORK/rot-err")
check "an old window gone during the spawn keeps the replacement, and one line names it and the host left" "0|1|1|1|0|1|/dev/ttys903" \
  "$(printf '%s' "$err" | grep -c 'no window of this home session runs on /dev/ttys901')|$(printf '%s' "$err" | grep -c '^ERROR:')|$(printf '%s' "$err" | grep -cF "ERROR: rotate: the old session on /dev/ttys901 was not closed: its window or tab is gone since the spawn; the replacement runs on /dev/ttys903 and is kept; a host runs on /dev/ttys901, but the old one's pid was not read before the spawn, so it cannot be told from another session's: no kill is named; its window or tab is gone, and its chain entry is left")|$([ "$rc" -ne 0 ] && echo 1 || echo 0)|$(calls | grep -c '\[kill-window\]')|$(chainf | grep -c '@4')|$out"
# Another window given the old window's tty during the spawn is no « still there »: the old
# window is read by its id before the spawn, the window on its tty by the close is another's,
# and that one is neither closed nor named in a close step.
reset_home
out=$(REC_GONE_ON_NEW=@1 REC_ADD_ON_NEW='$1\t5\t@7\t%7\t/dev/ttys901\tstranger\t✳ Agent: stranger' home rotate --old-tty /dev/ttys901 --expect-title "Agent: one" --dir "$WORK" --title "Agent: rotated" --prompt p 2>"$WORK/rot-err")
rc=$?; err=$(cat "$WORK/rot-err")
check "a stranger on the old window's tty after the spawn is never closed, and no close of its tty is printed" "1|0|1|0|1|/dev/ttys903" \
  "$([ "$rc" -ne 0 ] && echo 1 || echo 0)|$(calls | grep -c '\[kill-window\]')|$(printf '%s' "$err" | grep -cF "ERROR: rotate: the old session on /dev/ttys901 was not closed: /dev/ttys901 now holds another session (window @7, named 'stranger'), not the window @1 read before the spawn; the replacement runs on /dev/ttys903 and is kept; ")|$(printf '%s' "$err" | grep -c 'close --tty /dev/ttys901')|$(chainf | grep -c '@4')|$out"
# The tab that shows the caller's own home server: the replacement would be a window of that
# server, and the close of the tab ends the server, the replacement and the caller with it.
# Refused before anything is spawned.
TSOCK_KEPT=$TSOCK; TSOCK=/private/tmp/tmux-501/orch-abcdef12
reset_home
printf '/dev/ttys960 tmux -L orch-abcdef12 attach\n' >> "$TR/ps"
out=$(home rotate --old-tty /dev/ttys960 --dir "$WORK" --title "Agent: rotated" --prompt p 2>&1)
rc=$?
check "rotate of the tab that shows the caller's own home server is refused before anything is spawned or killed" "1|1|0|0" \
  "$([ "$rc" -ne 0 ] && echo 1 || echo 0)|$(printf '%s' "$out" | grep -cF "ERROR: rotate: refused: /dev/ttys960 is the tab that shows this session's own home server orch-abcdef12, where the replacement would be made as a window: the close of that tab ends the server, the replacement and this session with it")|$(calls | grep -c '\[new-window\]')|$(calls | grep -c 'kill-')"
# A process table that cannot be read says nothing of which server the tab shows: the rotation
# is refused then, never let through as « not the caller's own server ».
out=$(TMUX="$TSOCK,4242,1" TMUX_PANE=%0 ORCHESTRATOR_PS_TABLE="$WORK/no-such-ps-table" "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
ia.refuse_own_home('rotate', '/dev/ttys960')
print('let through')" 2>&1)
check "rotate of a tab whose processes cannot be read is refused, never taken for another server's" "0|1" \
  "$(printf '%s' "$out" | grep -c 'let through')|$(printf '%s' "$out" | grep -cF "ERROR: rotate: refused: whether /dev/ttys960 shows this session's own home server orch-abcdef12 cannot be read (")"
TSOCK=$TSOCK_KEPT

# The same rule read on stubs that name pids: whatever the close of the old session did, the
# replacement is never closed (no close of it, no kill, its chain entry never dropped), and the
# line says what is left of the old session and how to end it.
cat > "$WORK/late_probe.py" <<'PYEOF'
import contextlib, io, os, signal, sys
sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
mode = sys.argv[2]
calls = []
class Tab(ia.Terminal):
    def close_made(self, made):
        calls.append("close_made %s" % made["tty"])
        return True
    def survives(self, stable_id):
        return False
for name in ("coord_name_on", "registered_coord_on", "audit_name_on"):
    setattr(ia, name, lambda tty: None)
ia.time.sleep = lambda s: None
ia.CLOSE_TIMEOUT = ia.TERM_GRACE = ia.KILL_GRACE = 0
# No signal leaves this probe, whatever pid it names.
ia.os.kill = lambda pid, sig: calls.append("kill %s" % pid)
# In « glyphs » the old tab's title is made of the host's activity glyph alone, in « quoted » it
# holds what a shell would run and a single quote, in « glyph-window » the old session is window
# @1 of a home session, named with a glyph alone, and in « glyphs-spaced » the tab's title is two
# glyphs with a space between them.
QUOTED = "Fix \"quotes\" $(id) `id` it's"
GLYPHS = {"glyphs": "✳", "glyphs-spaced": "✳ ✳"}
class WinTerm(ia.Terminal):
    def panes(self, every=False):
        return [ia.Pane("$1", "1", "@1", "%1", "/dev/ttys901", "✳", "✳ Agent: one")]
TITLES = {"glyphs": "✳", "glyphs-spaced": "✳ ✳", "quoted": QUOTED, "glyph-window": "✳"}
# A home tab (« home-same ») is read by the refusals as they are, over its server's stand-ins.
HOME = mode in ("home-recycled", "home-same")
if mode == "home-same":
    ia.home_of_tab = lambda tty, strict=False: "probe-home" if tty == "/dev/ttys901" else None
    ia.window0_session = lambda what, socket: None
else:
    ia.close_refusals = lambda what, tty, expect: (
        WinTerm() if mode == "glyph-window" else None, TITLES.get(mode, "Agent: one"),
        "@1" if mode == "glyph-window" else "")
ia.terminal_for = lambda tty: ia.ITERM
# The old session's prompt box, empty: its read is the close's own, before the kill.
ia.ITERM.prompt_lines = lambda tty: ['─' * 40, '❯\u00a0', '─' * 40]
# The app's id of the session on the old tab: the old one's before the spawn; after it, gone in
# « vanished » and once the close began in « sent-gone », another's in « stranger », and in
# « read-interrupt » a first read after the spawn interrupted.
spawned, reads = [], []
# In « untold-stranger » and « untold-late » the app gives no id for any tab.
UNTOLD = ("untold-stranger", "untold-late")
def session_id_on(tty, what):
    if mode in ("renamed", "glyphs", "glyphs-spaced", "quoted") + UNTOLD:
        return None
    if not spawned:
        return "S-OLD"
    reads.append(tty)
    if mode == "read-interrupt" and len(reads) == 1:
        raise KeyboardInterrupt()
    if mode in ("unread-stranger", "unread-unidentified"):
        return None
    if mode in ("unidentified", "unidentified-unread", "unknown-fate"):
        return ""
    if mode == "stranger":
        return "S-STRANGER"
    if mode == "vanished" or (mode == "sent-gone" and "cmd_close" in calls):
        return ""
    return "S-OLD"
ia.session_id_on = session_id_on
# The old tab: gone by the close in « vanished » and « sent-gone », there otherwise, and in
# « renamed », where the app gives no id for it, retitled by its host during the spawn.
def session_title(tty, what):
    if mode in ("sent-gone", "vanished"):
        return None
    if mode in GLYPHS:
        return GLYPHS[mode]
    if mode == "quoted":
        return QUOTED
    # A stranger titled like the old session, given its tty once its host ended.
    if mode in UNTOLD and ended():
        return "✳ Agent: one-fix"
    return "Renamed by its host" if mode == "renamed" and spawned else "Agent: one"
ia.session_title = session_title
# A home tab in « home-recycled » and « home-same »: its host runs in window 0 of its server, on
# /dev/ttys905.
def close_host_tty(tty, strict=False):
    if mode == "read-raises":
        raise ia.TmuxError("timed out after 5s")
    return None, None, "/dev/ttys905" if HOME else tty
ia.close_host_tty = close_host_tty
# In « unidentified », « unidentified-unread » and « unread-unidentified » no host of the old
# session is identified before the spawn.
ia.host_identity = lambda tty: None if mode in (
    "unidentified", "unidentified-unread", "unread-unidentified") else (
    ("4242", "S0") if tty in ("/dev/ttys901", "/dev/ttys905") else ("5555", "S1"))
# The old host: ended with its tab in « vanished », ended during the spawn in « home-recycled »,
# « unread-stranger » and « untold-stranger », once its close was tried in « untold-late », its
# fate unreadable in « unknown-fate », running otherwise.
def ended():
    return bool(spawned) and (mode == "untold-stranger" or (mode == "untold-late"
                                                            and "cmd_close" in calls))
def process_state(pid):
    if str(pid) == "4242" and mode in UNTOLD:
        return None if ended() else ("S0", "S+")
    if str(pid) == "4242" and mode == "unknown-fate":
        return ia.UNREADABLE
    if str(pid) == "4242":
        return None if mode in ("vanished", "home-recycled", "unread-stranger") else ("S0", "S+")
    return "S1", "S+"
ia.process_state = process_state
# In « home-recycled », « unread-stranger » and « unidentified » the process table itself is
# stood in for, and the readers built on it run as they are: what runs after the spawn on a tty
# the old host left is the replacement's host (6363) or a stranger's (7777).
CLIS = {"home-recycled": {"/dev/ttys905": ["6363"]}, "unread-stranger": {"/dev/ttys901": ["7777"]},
        "unidentified": {"/dev/ttys901": ["7777"]}, "unread-unidentified": {"/dev/ttys901": ["7777"]}}
if mode in UNTOLD:
    # Before the old host ended, it alone; after, the stranger (7777) alone.
    ia.host_clis_on = lambda tty, strict=False: (["7777"] if ended() else ["4242"]) if (
        tty == "/dev/ttys901") else []
elif mode in CLIS:
    ia.host_clis_on = lambda tty, strict=False: CLIS[mode].get(tty, [])
elif mode == "unidentified-unread":
    # A process table that cannot be read: nothing, or with `strict` the failure.
    def ps_rows(tty, strict=False):
        if strict:
            raise OSError("ps could not be run")
        return []
    ia.ps_rows = ps_rows
else:
    ia.host_cli_on = lambda tty: None if mode == "vanished" else ("4242" if tty == "/dev/ttys901" else "5555")
    ia.others_on = lambda tty, ended: []
ia.wait_gone = lambda tty, timeout=None: None
ia.chain_drop_tab = lambda tab_id: calls.append("drop %s" % tab_id)
# The replacement, or one handed the tty its old session ran on. In « create-sigterm »,
# « verify-interrupt » and « before-create » the spawn is the launcher's own, over a terminal
# that makes the tab: a SIGTERM lands in the middle of its creation, or the keyboard's interrupt
# once it is made, while the spawn waits for its host, or a SIGTERM before anything is made.
rep_tty = {"recycled": "/dev/ttys901", "pipe-recycled": "/dev/ttys901",
           "home-recycled": "/dev/ttys905"}.get(mode, "/dev/ttys903")
class Made(Tab):
    def owner(self, own):
        return "O-ME"
    def chain_anchor(self, own):
        return None
    def can_place(self, anchor, side):
        return True
    def create(self, command, title, place, chain, made):
        """In « create-raises », the app's call fails inside the creation, nothing handed back."""
        spawned.append(1)
        if mode == "create-raises":
            raise RuntimeError("the websocket closed")
        made.update(tab_id="T903", session_id="S-NEW")
        if mode == "create-sigterm":
            signal.raise_signal(signal.SIGTERM)
        return rep_tty, "T903"
    def close_made(self, made):
        """In « refuse-interrupt », the spawn's own close of the session it refused, interrupted;
        in « refuse-unclosed » and « pipe-refuse-unclosed », a close that fails."""
        calls.append("close_made %s" % made["tty"])
        if mode == "refuse-interrupt":
            raise KeyboardInterrupt()
        return mode not in ("refuse-unclosed", "pipe-refuse-unclosed")
def waits(tty):
    raise KeyboardInterrupt()
def launch_file(launch, title):
    signal.raise_signal(signal.SIGTERM)
class TmuxMade(ia.TmuxTerminal):
    """The tmux terminal as it is, its new-window client the stand-in PROBE_TMUX names."""
    def session(self):
        return "$1"
    def owner(self, own):
        return "O-ME"
    def chain_anchor(self, own):
        return None
    def can_place(self, anchor, side):
        return True
    def create(self, command, title, place, chain, made):
        spawned.append(1)
        return ia.TmuxTerminal.create(self, command, title, place, chain, made)
    def close_made(self, made):
        calls.append("close_made %s" % made.get("tty"))
        return True
TMUXED = ("group-sigint", "tmux-timeout", "tmux-killed", "tmux-window-left")
if mode in TMUXED:
    # The keyboard's interrupt raises here whatever the probe inherited: a suite started in the
    # background, or under nohup, hands its children SIGINT ignored.
    signal.signal(signal.SIGINT, signal.default_int_handler)
    # The probe leads a process group of its own, so the stand-in's interrupt to its group
    # reaches the probe and its children alone; with no group of its own, nothing is sent.
    try:
        os.setsid()
    except OSError:
        pass
    if os.getpgid(0) == os.getpid():
        os.environ["PROBE_PGID"] = str(os.getpid())
    ia.TMUX_BIN = os.environ["PROBE_TMUX"]
    ia.terminal = lambda *a, **k: TmuxMade()
    # Never started: a creation whose interrupt was lost ends on the spawn's own refusal.
    ia.cli_pid_on_tty = lambda tty: None
    ia.find_transcript = lambda dir_, epoch: ""
NEVER = ("refuse-interrupt", "refuse-unclosed", "refuse-closed", "pipe-refuse-unclosed",
         "refuse-closed-signal")
class ItermMade(ia.ItermTerminal):
    """The app's terminal as it is, over an app that shows no session on the anchor."""
    def owner(self, own):
        return "O-ME"
    def chain_anchor(self, own):
        return None
    def can_place(self, anchor, side):
        return True
class App:
    current_window = None
    windows = []
class Api:
    @staticmethod
    async def async_get_app(connection):
        spawned.append(1)
        return App()
    @staticmethod
    def run_until_complete(main):
        import asyncio
        asyncio.run(main(None))
if mode == "create-nothing":
    ia.terminal = lambda *a, **k: ItermMade()
    ia.api_ready = lambda: Api
    ia.backend_chain = lambda: ["api"]
elif mode in ("create-sigterm", "verify-interrupt", "before-create", "create-raises",
              "mode-interrupt") + NEVER:
    ia.terminal = lambda *a, **k: Made()
    ia.cli_pid_on_tty = waits
    if mode == "before-create":
        ia.write_launch_script = launch_file
    if mode == "mode-interrupt":
        # The replacement's host found, then an interrupt while its mode is read.
        ia.cli_pid_on_tty = lambda tty: "6363"
        def mode_read(*a, **k):
            raise KeyboardInterrupt()
        ia.verify_mode = mode_read
    if mode in NEVER:
        # A replacement that never starts: the spawn refuses it and closes it itself. Its
        # screen is stood in for: the app is never read.
        ia.screen_text = lambda made: "zsh: command not found: claude"
        ia.cli_pid_on_tty = lambda tty: None
        ia.find_transcript = lambda dir_, epoch: ""
    if mode == "refuse-closed-signal":
        # An interrupt the moment the rotation turns to the spawn's refusal, its close done.
        first, turns = ia.spawn_failed, []
        def failed(*a):
            turns.append(1)
            if len(turns) == 1:
                raise KeyboardInterrupt()
            return first(*a)
        ia.spawn_failed = failed
elif mode not in TMUXED:
    def spawn(argv, pair_from="", old_tty="", made=None):
        """The replacement made; in « pipe-recycled » and « pipe-refused » its tty printed on
        stdout, as the spawn prints it."""
        spawned.append(1)
        if mode in ("pipe-recycled", "pipe-refused"):
            print(rep_tty)
        return dict(tty=rep_tty, terminal=Tab(), tab_id="T903")
    ia.cmd_spawn = spawn
def sent(tty):
    ia.KILL_SENT.add(tty)
    ia.die("close: the request was accepted but 4242 is still running on %s" % tty)
def closed_tab(tty, expect):
    ia.KILL_SENT.add(tty)
ia.recorded_pids = lambda ttys: ["4242"]
def name_lingering(pids):
    raise OSError("close.log is read-only")
def raises(argv):
    calls.append("cmd_close")
    raise RuntimeError("app gone")
def refused_seeing_hangup(argv):
    """The close refused late, noting whether a hangup is still ignored while it runs."""
    calls.append("hup=%s" % ("ignored" if signal.getsignal(signal.SIGHUP) == signal.SIG_IGN
                             else "taken"))
    ia.die("close: refused late")
def interrupted(argv):
    """The close interrupted: by the keyboard, or by a signal this probe sends itself."""
    calls.append("cmd_close")
    if mode == "sent-interrupt":
        ia.KILL_SENT.add(argv.tty)
    if mode in ("sigterm", "sighup"):
        signal.raise_signal(signal.SIGTERM if mode == "sigterm" else signal.SIGHUP)
    raise KeyboardInterrupt()
if mode == "closed-then-raises":
    ia.close_tab = closed_tab
    ia.name_lingering = name_lingering
elif mode in ("closed-pipe", "pipe-real"):
    ia.close_tab = closed_tab
elif mode in ("interrupt", "sent-interrupt", "sigterm", "sighup", "second-signal"):
    ia.cmd_close = interrupted
    if mode == "second-signal":
        # A second signal the moment the rotation turns to its line: its second reading of a
        # recycled tty, the first being the one before the close.
        first, seen = ia.refuse_recycled, []
        def refuse_recycled(*a):
            seen.append(1)
            if len(seen) == 2:
                signal.raise_signal(signal.SIGTERM)
            return first(*a)
        ia.refuse_recycled = refuse_recycled
elif mode == "nohup":
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    ia.cmd_close = refused_seeing_hangup
elif mode in ("sent-gone", "sent-there"):
    ia.cmd_close = lambda argv: (calls.append("cmd_close"), sent(argv.tty))
elif mode == "raises":
    ia.cmd_close = raises
elif mode == "vanished":
    ia.cmd_close = lambda argv: (calls.append("cmd_close"), ia.die("close: no session found on %s" % argv.tty))
else:
    ia.cmd_close = lambda argv: (calls.append("cmd_close"), ia.die("close: refused late"))
class Out(io.StringIO):
    """A stdout whose reader went away once the close's « closed » line was written."""
    def flush(self):
        if mode == "closed-pipe" and "closed 1 session" in self.getvalue():
            raise BrokenPipeError(32, "Broken pipe")
rotate = ["--old-tty", "/dev/ttys901", "--dir", "/", "--title", "Agent: t", "--tier", "light", "--prompt", "p"]
if len(sys.argv) > 3:
    rotate = ["--old-tty", "/dev/ttys901", "--dir", sys.argv[3], "--title", "Agent: two",
              "--tier", "light", "--prompt", "p"]
if mode.startswith("pipe-"):
    # A real stdout whose reader is gone: the process's own exit status and its last words on
    # stderr are what is read, the interpreter's flush at exit included.
    r, w = os.pipe()
    os.close(r)
    os.dup2(w, 1)
    os.close(w)
    ia.cmd_rotate(ia.args_from_line('rotate', rotate))
handlers = [signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)]
out, err = Out(), io.StringIO()
code = 0
try:
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        ia.cmd_rotate(ia.args_from_line('rotate', rotate))
except SystemExit as e:
    code = e.code
print("exit=%s" % code)
print("spawned=%d" % len(spawned))
print("restored=%s" % ("yes" if handlers == [signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)] else "no"))
print("calls=%s" % ",".join(calls))
print("OUT:" + "|".join(out.getvalue().split("\n")).strip("|"))
print("ERR:" + " ".join(err.getvalue().split()))
# Every step the line prints (« with close --tty … », « with verify --tty … »), split as a shell
# splits it, up to its first word that is no option: the title it guards on comes back as one
# argument, exactly as it was read.
import json, re, shlex
def printed(text, command):
    found = []
    for at in re.finditer(r"(?<=with )%s --tty " % command, text):
        lex = shlex.shlex(text[at.start():], posix=True)
        lex.whitespace_split = True
        words = [lex.get_token()]
        try:
            while True:
                flag = lex.get_token()
                if not flag or not flag.startswith("--"):
                    break
                words.append(flag.rstrip(";,"))
                if flag != flag.rstrip(";,"):
                    break
                if flag != "--keep-checkout":
                    words.append(lex.get_token())
        except ValueError:
            pass
        found.append(words)
    return found
closes = printed(err.getvalue(), "close")
print("closes=%d" % len(closes))
print("kept=%d" % sum("--keep-checkout" in w for w in closes))
print("guarded=%d" % sum("--expect-title" in w for w in closes))
print("split=%s" % ("yes" if ["close", "--tty", "/dev/ttys901", "--expect-title", QUOTED,
                              "--keep-checkout"] in closes else "no"))
print("verifies=%s" % json.dumps(printed(err.getvalue(), "verify")))
PYEOF
lprobe() { ORCHESTRATOR_STATE_DIR="$WORK/latestate" "$py" "$WORK/late_probe.py" "$ROOT/skills/iterm-agents/scripts" "$1" 2>&1; }
KEPT='the replacement runs on /dev/ttys903 and is kept'
THERE="its window or tab is still there, the same session S-OLD as before the spawn: close it with close --tty /dev/ttys901 --expect-title 'Agent: one' --keep-checkout (its chain entry is left for that close); should that close refuse on a title rewritten since, end the old session alone with kill 4242, its host (pid 4242) read before the spawn, which still runs"
# A replacement whose start was not verified is checked before anything of the old session ends:
# by its host's pid when one is known, else by what list shows.
CHECKED='no host was seen on /dev/ttys903 as this line was written: check that the replacement runs there, which list shows, before ending the old session'
# Nothing of the replacement is touched: no close of it, no signal to its host, no chain drop.
untouched() { sfield "$1" calls | tr ',' '\n' | grep -cE '^(close_made|kill|drop) '; }
res=$(lprobe refused)
check "a close refused before it ended anything keeps the replacement, and names the close of the old tab still there" "1|cmd_close|0|1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(untouched "$res")|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was not closed: its close refused before it ended anything; $KEPT; $THERE")|$(printf '%s' "$res" | grep -c 'Traceback')"
res=$(lprobe vanished)
check "a tab that vanished during the spawn is found gone before any close, and keeps the replacement: nothing left to close" "1||0|1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(untouched "$res")|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was not closed: its window or tab is gone since the spawn; $KEPT; its window or tab and its host are gone: nothing left to close (its chain entry is left)")|$(sfield "$res" ERR | grep -c 'close --tty /dev/ttys901')"
# Another session on the old tab's tty after the spawn is not the old one: it is never closed,
# no close of its tty is printed, and only the old host, by the pid read before the spawn, is named.
res=$(lprobe stranger)
check "a stranger on the old tab's tty after the spawn is never closed, and gets no close step" "1||0|1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(untouched "$res")|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was not closed: /dev/ttys901 now holds another session (session S-STRANGER), not the session S-OLD read before the spawn; $KEPT; its host (pid 4242) still runs on /dev/ttys901, and no command of this tool ends it: end it with kill 4242; its window or tab is gone, and its chain entry is left; no close of /dev/ttys901 is to be made: it would end the session now on it")|$(sfield "$res" ERR | grep -c 'close --tty /dev/ttys901')"
res=$(lprobe sent-there)
check "a close that began ending the old session and failed keeps the replacement, its window still there" "1|cmd_close|0|1" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(untouched "$res")|$(sfield "$res" ERR | grep -cF "rotate: the close of the old session on /dev/ttys901 failed; $KEPT; $THERE")"
res=$(lprobe sent-gone)
check "and with its window gone and its host left, the line names the pid and the kill, never a close of the old tty" "1|cmd_close|0|1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(untouched "$res")|$(sfield "$res" ERR | grep -cF "rotate: the close of the old session on /dev/ttys901 failed; $KEPT; its host (pid 4242) still runs on /dev/ttys901, and no command of this tool ends it: end it with kill 4242; its window or tab is gone, and its chain entry is left")|$(sfield "$res" ERR | grep -c 'close --tty /dev/ttys901')"
res=$(lprobe raises)
check "a close that raises keeps the replacement, the error named, never a traceback" "1|cmd_close|0|1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(untouched "$res")|$(sfield "$res" ERR | grep -cF "rotate: the close of the old session on /dev/ttys901 failed (app gone); $KEPT; $THERE")|$(printf '%s' "$res" | grep -c 'Traceback')"
# A tab the app gives no id for is closed only while its title holds the one read before the
# spawn, and a host that rewrote it during the spawn makes that close refuse: the line keeps the
# guarded close and names the step that ends the old session alone whatever its title reads, a
# kill of the host by the pid read before the spawn.
res=$(lprobe renamed)
check "a close refused on a title rewritten since the spawn keeps its guarded step and names the old host's kill" "1|cmd_close|0|1|1" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(untouched "$res")|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was not closed: its close refused before it ended anything; $KEPT; a session titled 'Renamed by its host' is on /dev/ttys901, and the old one's id could not be read before the spawn (the app gave no id for it): close it with close --tty /dev/ttys901 --expect-title 'Agent: one' --keep-checkout, which closes it only while its title holds the old one's (its chain entry is left for that close); should that close refuse on a title rewritten since, end the old session alone with kill 4242, its host (pid 4242) read before the spawn, which still runs")|$(sfield "$res" ERR | grep -c 'kill 4242')"
# A tab the app gives no id for, whose title is made of glyphs alone: that title guards nothing,
# so it is no identity, and no close of it could ever be made once the replacement runs. Known
# before the spawn, it is refused then: nothing spawned, nothing closed.
res=$(lprobe glyphs)
check "a tab with no id and a title of glyphs alone is refused before the spawn" "1|0||1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" spawned)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -cF "rotate: refused: the session on /dev/ttys901 can be told from another neither by its id (the app gave no id for it) nor by its title ('✳'), which holds no word a close could be guarded on: nothing was spawned")|$(printf '%s' "$res" | grep -c 'Traceback')"
# And so is one whose title is glyphs with a space between them: no word is left to guard on.
res=$(lprobe glyphs-spaced)
check "a tab with no id and a title of spaced glyphs is refused before the spawn" "1|0||1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" spawned)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -cF "rotate: refused: the session on /dev/ttys901 can be told from another neither by its id (the app gave no id for it) nor by its title ('✳ ✳'), which holds no word a close could be guarded on: nothing was spawned")|$(printf '%s' "$res" | grep -c 'Traceback')"
# A window whose name is made of glyphs alone: its close step would guard nothing, so its host
# alone is named, by the pid read before the spawn.
res=$(lprobe glyph-window)
check "a window named with glyphs alone gets no close step, only its old host's kill" "1|0|1" \
  "$(sfield "$res" exit)|$(sfield "$res" ERR | grep -c 'close --tty')|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was not closed: its close refused before it ended anything; $KEPT; end the old session alone with kill 4242, its host (pid 4242) read before the spawn, which still runs; its window and its chain entry are left")"
# A title holding quotes, a single quote, a command substitution and backquotes: every step
# printed is safe to paste, its title coming back as one argument, exactly as it was read.
res=$(lprobe quoted)
check "a printed close step quotes the title for the shell: split, it gives the title back whole" "1|yes|0" \
  "$(sfield "$res" exit)|$(sfield "$res" split)|$(printf '%s' "$res" | grep -c 'Traceback')"
cat > "$WORK/zero_probe.py" <<'PYEOF'
import contextlib, io, re, shlex, sys
sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
name = 'Orch "home" $(id) `id`'
err = io.StringIO()
try:
    with contextlib.redirect_stderr(err):
        ia.refuse_window_zero("close", "/dev/ttys900", name)
except SystemExit:
    pass
step = re.search(r"takeover --tty \S+ --expect-title (?:'[^']*'|\"[^\"]*\")", err.getvalue())
print("yes" if step and shlex.split(step.group(0)) == ["takeover", "--tty", "/dev/ttys900",
                                                       "--expect-title", name] else "no")
PYEOF
check "the takeover step of window 0's refusal quotes the name for the shell" "yes" \
  "$("$py" "$WORK/zero_probe.py" "$ROOT/skills/iterm-agents/scripts" 2>&1)"
# The old session is read before the spawn, its host and its id: a read that fails then refuses
# the rotation, nothing spawned and nothing closed.
res=$(lprobe read-raises)
check "a read of the old session that raises before the spawn refuses the rotation, nothing spawned" "1|0||1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" spawned)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -cF "rotate: refused: the old session on /dev/ttys901 cannot be read before the spawn (timed out after 5s): nothing was spawned")|$(printf '%s' "$res" | grep -c 'Traceback')"
res=$(lprobe closed-then-raises)
check "a close that closed the old session and then raised says it closed, and what failed after" "1||closed 1 session on /dev/ttys901|1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" OUT)|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was closed, but what followed failed (close.log is read-only); $KEPT; nothing left to close")|$(sfield "$res" ERR | grep -c 'not closed')"
# A reader gone from stdout once the « closed » line was written is no failed close.
res=$(lprobe closed-pipe)
check "a broken pipe on the close's « closed » line is no failed close: the old session is said closed" "1|1|0|0" \
  "$(sfield "$res" exit)|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was closed, but what followed failed ([Errno 32] Broken pipe); $KEPT; nothing left to close")|$(sfield "$res" ERR | grep -c 'close of the old session on /dev/ttys901 failed')|$(printf '%s' "$res" | grep -c 'Traceback')"
# A stdout whose reader is gone, for real: the rotation exits 1 on its one line, and the
# interpreter's own flush at exit neither fails again nor changes that status.
"$py" "$WORK/late_probe.py" "$ROOT/skills/iterm-agents/scripts" pipe-real 2>"$WORK/pipe-err"
rc=$?
check "a broken pipe on the « closed » line exits 1 on the rotation's line, with nothing after it" "1|1|0|0" \
  "$rc|$(grep -cF "ERROR: rotate: the old session on /dev/ttys901 was closed, but what followed failed ([Errno 32] Broken pipe); $KEPT; nothing left to close" "$WORK/pipe-err")|$(grep -c 'Exception ignored' "$WORK/pipe-err")|$(grep -c 'BrokenPipeError' "$WORK/pipe-err")"
# And on the rotation's other lines once the spawn printed its tty: a replacement given the old
# session's tty, and a close refused. Each exits 1, as every line after the spawn does.
for m in "pipe-recycled|rotate: the replacement was given /dev/ttys901, the tty of the old session on /dev/ttys901" \
         "pipe-refused|rotate: the old session on /dev/ttys901 was not closed: its close refused before it ended anything"; do
  "$py" "$WORK/late_probe.py" "$ROOT/skills/iterm-agents/scripts" "${m%%|*}" 2>"$WORK/pipe-err"
  rc=$?
  check "a stdout whose reader is gone exits 1 on the line of ${m%%|*}, with nothing after it" "1|1|0|0" \
    "$rc|$(grep -cF "ERROR: ${m#*|}" "$WORK/pipe-err")|$(grep -c 'Exception ignored' "$WORK/pipe-err")|$(grep -c 'BrokenPipeError' "$WORK/pipe-err")"
done
# An interrupt once the replacement runs: the keyboard's, SIGTERM or SIGHUP, during the close or
# during the read before it. It ends on the same one line, exit 1, the replacement kept, and the
# handlers the rotation found are put back.
res=$(lprobe interrupt)
check "an interrupt during the close keeps the replacement and ends on the rotation's line" "1|cmd_close|0|1|yes|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(untouched "$res")|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was not closed: its close was interrupted by SIGINT before it ended anything; $KEPT; $THERE")|$(sfield "$res" restored)|$(printf '%s' "$res" | grep -c 'Traceback')"
for sig in sigterm sighup; do
  res=$(lprobe $sig)
  name=$(printf '%s' "$sig" | tr 'a-z' 'A-Z')
  check "and $name during the close, the same line" "1|cmd_close|1|yes" \
    "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was not closed: its close was interrupted by $name before it ended anything; $KEPT; $THERE")|$(sfield "$res" restored)"
done
res=$(lprobe sent-interrupt)
check "an interrupt after the close began says the close failed, the old tab's close named" "1|cmd_close|0|1" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(untouched "$res")|$(sfield "$res" ERR | grep -cF "rotate: the close of the old session on /dev/ttys901 failed (interrupted by SIGINT); $KEPT; $THERE")"
res=$(lprobe read-interrupt)
check "an interrupt before the close says the old session was not closed" "1||1|yes" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -cF "rotate: the rotation was interrupted by SIGINT after the spawn, before the close of the old session on /dev/ttys901, so it was not closed; $KEPT; $THERE")|$(sfield "$res" restored)"
# From before the replacement is made: an interrupt that lands while the terminal makes it, or
# once it is made and the spawn waits for its host, ends on the same one line, the replacement
# kept and named, the old session's close step given, and the handlers put back.
rprobe() { ORCHESTRATOR_STATE_DIR="$WORK/latestate" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_PS_TABLE=/dev/null \
  "$py" "$WORK/late_probe.py" "$ROOT/skills/iterm-agents/scripts" "$1" "$WORK" 2>&1; }
res=$(rprobe create-sigterm)
check "a SIGTERM while the terminal makes the replacement ends on the rotation's line once it is made, both named" "1|1||1|yes|0" \
  "$(sfield "$res" exit)|$(sfield "$res" spawned)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -cF "rotate: the rotation was interrupted by SIGTERM during the spawn, once its replacement was made on /dev/ttys903, so the old session on /dev/ttys901 was not closed; the replacement made on /dev/ttys903 is kept, though whether it started was not verified, and its chain entry may be missing; $CHECKED: $THERE")|$(sfield "$res" restored)|$(printf '%s' "$res" | grep -c 'Traceback')"
res=$(rprobe verify-interrupt)
check "an interrupt once the replacement is made, while the spawn waits for its host, ends on the same line" "1|1||1|yes|0" \
  "$(sfield "$res" exit)|$(sfield "$res" spawned)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -cF "rotate: the rotation was interrupted by SIGINT during the spawn, once its replacement was made on /dev/ttys903, so the old session on /dev/ttys901 was not closed; the replacement made on /dev/ttys903 is kept, though whether it started was not verified, and its chain entry may be missing; $CHECKED: $THERE")|$(sfield "$res" restored)|$(printf '%s' "$res" | grep -c 'Traceback')"
res=$(rprobe before-create)
check "and one before the replacement is made says nothing was spawned, the old session left as it was" "1|0||1|yes|0" \
  "$(sfield "$res" exit)|$(sfield "$res" spawned)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -cF "rotate: the rotation was interrupted by SIGTERM before its replacement was made: nothing was spawned, and the old session on /dev/ttys901 was left as it was")|$(sfield "$res" restored)|$(printf '%s' "$res" | grep -c 'Traceback')"
# A home tab still there, its close refused before it ended anything: its close ends the server
# and window 0's host with it, so that close is the step named, guarded on the title read before
# the spawn (read by the refusals as they are, no expected title given), and the kill of window
# 0's host only should that close refuse on a rewritten title.
res=$(lprobe home-same)
check "a home tab still there gets its guarded close, and its host's kill only should it refuse on a rewritten title" "1|cmd_close|1|1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -c 'kill')|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was not closed: its close refused before it ended anything; $KEPT; $THERE")|$(printf '%s' "$res" | grep -c 'Traceback')"
# An interrupt while the spawn closes the replacement it refused: the line says that close was
# under way, that whether it went through is not known, and that the old session was not touched.
res=$(ORCHESTRATOR_SPAWN_TIMEOUT=2 rprobe refuse-interrupt)
check "an interrupt during the spawn's own close of a refused replacement says so, the old session untouched" "1|1|close_made /dev/ttys903|1|0|0" \
  "$(sfield "$res" exit)|$(sfield "$res" spawned)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -cF "rotate: the rotation was interrupted by SIGINT while the spawn closed the replacement it made on /dev/ttys903, which it refused (claude never started on /dev/ttys903 after 2s): whether that close went through is not known: if list still shows a session on /dev/ttys903, close it with close --tty /dev/ttys903 --expect-title 'Agent: two' --keep-checkout; the old session on /dev/ttys901 was not touched")|$(sfield "$res" ERR | grep -c 'is kept')|$(printf '%s' "$res" | grep -c 'Traceback')"
# And one that lands once that close went through, before the rotation turned to its line, says
# what is known: the refused session was closed.
res=$(ORCHESTRATOR_SPAWN_TIMEOUT=2 rprobe refuse-closed-signal)
check "an interrupt once the spawn closed the replacement it refused says it was closed" "1|close_made /dev/ttys903,drop T903|1|0|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -cF "rotate: the spawn refused the replacement it made on /dev/ttys903 (claude never started on /dev/ttys903 after 2s) and closed it; the old session on /dev/ttys901 was not touched, and nothing is left to close")|$(sfield "$res" ERR | grep -c 'not known')|$(printf '%s' "$res" | grep -c 'Traceback')"
# A replacement that never started: what its screen showed, read before the close, ends the
# rotation's line, whatever became of that close.
SHOWN='The tab showed: zsh: command not found: claude\.'
res=$(ORCHESTRATOR_SPAWN_TIMEOUT=2 rprobe refuse-closed)
check "a rotation whose replacement never started says what its screen showed, the wait to raise named" "1|1" \
  "$(sfield "$res" ERR | grep -c "nothing is left to close\. $SHOWN")|$(sfield "$res" ERR | grep -c 'ORCHESTRATOR_SPAWN_TIMEOUT')"
res=$(ORCHESTRATOR_SPAWN_TIMEOUT=2 rprobe refuse-unclosed)
check "and so does one whose replacement could not be closed" "1|1" \
  "$(sfield "$res" ERR | grep -c "which still runs\. $SHOWN")|$(sfield "$res" closes)"
res=$(ORCHESTRATOR_SPAWN_TIMEOUT=2 rprobe refuse-interrupt)
check "and one interrupted while that replacement was being closed" "1" \
  "$(sfield "$res" ERR | grep -c "the old session on /dev/ttys901 was not touched\. $SHOWN")"
# The terminal's own children run apart from the launcher's process group while a rotation's
# replacement is made: an interrupt sent to the group (a Ctrl-C at the terminal) is held by the
# launcher until the creation returns, and does not kill the tmux client after the server made
# the window. The stand-in client interrupts the group, then answers the window it made.
printf 'import os, signal, sys\nif "new-window" in sys.argv:\n    if os.environ.get("PROBE_PGID"):\n        os.killpg(int(os.environ["PROBE_PGID"]), signal.SIGINT)\n    print("@4 %%4 /dev/ttys903")\n' > "$WORK/group-tmux.py"
printf '#!/bin/bash\nexec "%s" "%s" "$@"\n' "$py" "$WORK/group-tmux.py" > "$WORK/group-tmux"
chmod +x "$WORK/group-tmux"
res=$(PROBE_TMUX="$WORK/group-tmux" TMUX="$TSOCK,4242,1" TMUX_PANE=%0 ORCHESTRATOR_SPAWN_TIMEOUT=2 rprobe group-sigint)
check "a group interrupt while tmux makes the replacement is held until the window is made, and the line names both" "1|1||1|0|yes|0" \
  "$(sfield "$res" exit)|$(sfield "$res" spawned)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -cF "rotate: the rotation was interrupted by SIGINT during the spawn, once its replacement was made on /dev/ttys903, so the old session on /dev/ttys901 was not closed; the replacement made on /dev/ttys903 is kept, though whether it started was not verified, and its chain entry may be missing; $CHECKED: $THERE")|$(sfield "$res" ERR | grep -c 'refused new-window')|$(sfield "$res" restored)|$(printf '%s' "$res" | grep -c 'Traceback')"
# A replacement handed the tty its old session ran on: a close of that tty would end it.
res=$(lprobe recycled)
check "a replacement given the old session's tty is never closed, and nothing is: the line names both" "1||1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -cF 'rotate: the replacement was given /dev/ttys901, the tty of the old session on /dev/ttys901: that session is no longer on it, so nothing was closed, for a close --tty /dev/ttys901 would end the replacement; the replacement runs on /dev/ttys901 and is kept, and the chain entry of the old session is left')|$(printf '%s' "$res" | grep -c 'Traceback')"
# A pid is named for a kill only when it is the old host read before the spawn, by its pid and
# its start time, and still that process: what else runs on a tty the old session left, the
# replacement's host or a stranger's, is described and never named for a kill. The process table
# is stood in for here, and the readers built on it run as they are.
res=$(lprobe home-recycled)
check "a home tab whose window 0's tty went to the replacement: nothing closed, no kill named" "1||0|1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -cE 'kill [0-9]')|$(sfield "$res" ERR | grep -cF 'rotate: the replacement was given /dev/ttys905, the tty the host of the old session on /dev/ttys901 ran on: that host is no longer on it, so nothing was closed, for a kill of what runs on /dev/ttys905 would end the replacement; the replacement runs on /dev/ttys905 and is kept, and the tab on /dev/ttys901 and the chain entry of the old session are left')|$(printf '%s' "$res" | grep -c 'Traceback')"
res=$(lprobe unread-stranger)
check "a stranger on an unread tab whose old host ended is described, never named for a kill nor for a close" "1||0|0|1" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -c 'kill 7777')|$(sfield "$res" ERR | grep -c 'close --tty')|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 could not be read after the spawn (the app gave no id for the session on it), so it was not closed; the replacement runs on /dev/ttys903 and is kept; its host ended; another host runs on /dev/ttys901 now, not the one read before the spawn, and no step here ends it; whether its window or tab is still there could not be read (the app gave no id for the session on it), and another host runs on /dev/ttys901: no close of /dev/ttys901 is named; its chain entry is left")"
res=$(lprobe unidentified)
check "a host never identified before the spawn is never named for a kill" "1||0|1" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -c 'kill 7777')|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was not closed: its window or tab is gone since the spawn; the replacement runs on /dev/ttys903 and is kept; a host runs on /dev/ttys901, but the old one's pid was not read before the spawn, so it cannot be told from another session's: no kill is named; its window or tab is gone, and its chain entry is left")"
res=$(lprobe unidentified-unread)
check "with no host identified and a process table that cannot be read, whether a host runs is not known" "1|0|1" \
  "$(sfield "$res" exit)|$(sfield "$res" ERR | grep -c 'no host is listed')|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was not closed: its window or tab is gone since the spawn; $KEPT; whether a host runs on /dev/ttys901 is not known (the process table could not be read); its window or tab is gone, and its chain entry is left")"
res=$(lprobe unknown-fate)
check "an old host whose fate the process table cannot tell is named for a kill only at the start time read before the spawn" "1|1" \
  "$(sfield "$res" exit)|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was not closed: its window or tab is gone since the spawn; $KEPT; whether its host (pid 4242, started S0) still runs is not known (the process table could not be read): if pid 4242 still shows that start time, end it with kill 4242; its window or tab is gone, and its chain entry is left")"

# A tab the app gives no id for is known by its title alone, which a stranger given its tty may
# carry too (titles alike in a rotation): once the old host read before the spawn has ended, or
# another host is on its tty, nothing is closed and no close is named, the stranger described and
# never named for a kill.
UNTOLD_LEFT="its host ended; another host runs on /dev/ttys901 now, not the one read before the spawn, and no step here ends it; a session titled '✳ Agent: one-fix' is on /dev/ttys901, and the old one's id could not be read before the spawn (the app gave no id for it): nothing tells it from another session's, so no close of /dev/ttys901 is named; its chain entry is left"
res=$(lprobe untold-stranger)
check "a tab known by its title alone whose host ended during the spawn is never closed, a stranger on it never named" "1||0|0|1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" closes)|$(sfield "$res" ERR | grep -c 'kill 7777')|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was not closed: its tab is known by its title alone, and its host read before the spawn has ended; $KEPT; $UNTOLD_LEFT")|$(printf '%s' "$res" | grep -c 'Traceback')"
res=$(lprobe untold-late)
check "and one whose host ends once its close was tried gets no close step either" "1|cmd_close|0|0|1" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" closes)|$(sfield "$res" ERR | grep -c 'kill 7777')|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was not closed: its close refused before it ended anything; $KEPT; $UNTOLD_LEFT")"
# A session read by its id before the spawn and unread after it, whose host was not identified:
# a host now on its tty cannot be told from another session's, so no close is named.
res=$(lprobe unread-unidentified)
check "an unread tab with no host identified and a host on its tty gets no close step" "1|0|0|1" \
  "$(sfield "$res" exit)|$(sfield "$res" closes)|$(sfield "$res" ERR | grep -c 'kill 7777')|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 could not be read after the spawn (the app gave no id for the session on it), so it was not closed; $KEPT; a host runs on /dev/ttys901, but the old one's pid was not read before the spawn, so it cannot be told from another session's: no kill is named; whether its window or tab is still there could not be read (the app gave no id for the session on it), and nothing tells the session on /dev/ttys901 from another's: no close of /dev/ttys901 is named; its chain entry is left")"
# Every close step a line prints keeps the checkout, which the replacement works in, and is
# guarded on a title: split as a shell splits it, each carries --keep-checkout and --expect-title.
for m in refused raises renamed sent-there interrupt read-interrupt quoted home-same; do
  res=$(lprobe $m)
  n=$(sfield "$res" closes)
  check "every close step of $m keeps the checkout and is guarded" "1|1|1" \
    "$([ "${n:-0}" -ge 1 ] && echo 1 || echo 0)|$([ "$(sfield "$res" kept)" = "$n" ] && echo 1 || echo 0)|$([ "$(sfield "$res" guarded)" = "$n" ] && echo 1 || echo 0)"
done

# Whatever ends the spawn once its replacement may exist ends on one `rotate:` line that names
# both: the replacement's tty when it is known, else the window that may exist by its id or its
# name. No step ends the old session before a replacement's tty is known: the replacement carries
# the old session's title, and a step taken on what list shows under it could end the only agent.
NOSTEP="the old session is left as it was, and no step here ends it while no replacement's tty is known"
res=$(rprobe create-raises)
check "an error inside the creation ends on the rotation's line: a window may exist, the old session's step after a check" "1|1||1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" spawned)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -cF "rotate: the spawn failed while its replacement was being made (the websocket closed), so the old session on /dev/ttys901 was not closed; a window may exist, named 'Agent: two', which list shows; $NOSTEP")|$(printf '%s' "$res" | grep -c 'Traceback')"
printf 'import os, signal, sys, time\nif "new-window" in sys.argv:\n    if os.environ.get("PROBE_STALL"):\n        time.sleep(3)\n    else:\n        os.kill(os.getpid(), signal.SIGTERM)\n' > "$WORK/odd-tmux.py"
printf '#!/bin/bash\nexec "%s" "%s" "$@"\n' "$py" "$WORK/odd-tmux.py" > "$WORK/odd-tmux"
chmod +x "$WORK/odd-tmux"
res=$(PROBE_STALL=1 ORCHESTRATOR_PROBE_TIMEOUT=1 PROBE_TMUX="$WORK/odd-tmux" TMUX="$TSOCK,4242,1" TMUX_PANE=%0 rprobe tmux-timeout)
check "a tmux new-window that times out ends on the rotation's line, the window it may have made named" "1|1|1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" spawned)|$(sfield "$res" ERR | grep -cF "rotate: the spawn failed while its replacement was being made (tmux new-window: timed out after 1s), so the old session on /dev/ttys901 was not closed; a window may exist, named 'Agent: two', which list shows; $NOSTEP")|$(printf '%s' "$res" | grep -c 'Traceback')"
res=$(PROBE_TMUX="$WORK/odd-tmux" TMUX="$TSOCK,4242,1" TMUX_PANE=%0 rprobe tmux-killed)
check "a tmux client killed by a signal ends on the rotation's line, saying it was killed" "1|1|1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" spawned)|$(sfield "$res" ERR | grep -cF "rotate: the spawn failed while its replacement was being made (the tmux client of new-window was killed by SIGTERM, so whether tmux carried it out is not known: a window it was making may exist, and list shows it), so the old session on /dev/ttys901 was not closed; a window may exist, named 'Agent: two', which list shows; $NOSTEP")|$(printf '%s' "$res" | grep -c 'Traceback')"
# None of these names a step that ends the old session: no close of its tty, no kill of its host.
for m in create-raises tmux-killed; do
  if [ "$m" = tmux-killed ]; then
    res=$(PROBE_TMUX="$WORK/odd-tmux" TMUX="$TSOCK,4242,1" TMUX_PANE=%0 rprobe $m)
  else
    res=$(rprobe $m)
  fi
  check "a failed creation of $m names no step of the old session" "0|0" \
    "$(sfield "$res" closes)|$(sfield "$res" ERR | grep -c 'kill 4242')"
done
# A window tmux made and answered badly: its id is kept from the creation and named, and no step
# ends the old session; once killed, nothing of the replacement is left.
printf 'import os, sys\nif "new-window" in sys.argv:\n    print("@4 %%4")\nelif "kill-window" in sys.argv:\n    sys.exit(0 if os.environ.get("PROBE_KILL_OK") else 1)\n' > "$WORK/half-tmux.py"
printf '#!/bin/bash\nexec "%s" "%s" "$@"\n' "$py" "$WORK/half-tmux.py" > "$WORK/half-tmux"
chmod +x "$WORK/half-tmux"
res=$(PROBE_TMUX="$WORK/half-tmux" TMUX="$TSOCK,4242,1" TMUX_PANE=%0 rprobe tmux-window-left)
check "a window made then left by a failed creation is named by its id, and no step ends the old session" "1|1|0|0|0" \
  "$(sfield "$res" exit)|$(sfield "$res" ERR | grep -cF "rotate: the spawn failed while its replacement was being made (tmux made a window and answered '@4 %4', not its ids and tty), so the old session on /dev/ttys901 was not closed; the window @4 it made, named 'Agent: two', may still run, which list shows; $NOSTEP")|$(sfield "$res" closes)|$(sfield "$res" ERR | grep -c 'kill 4242')|$(printf '%s' "$res" | grep -c 'Traceback')"
res=$(PROBE_KILL_OK=1 PROBE_TMUX="$WORK/half-tmux" TMUX="$TSOCK,4242,1" TMUX_PANE=%0 rprobe tmux-window-left)
check "and once that window was killed, nothing of the replacement is left and the old session is untouched" "1|1|0|0" \
  "$(sfield "$res" exit)|$(sfield "$res" ERR | grep -cF "rotate: the spawn failed once tmux made the window @4 for its replacement (tmux made a window and answered '@4 %4', not its ids and tty), and that window was killed: nothing of the replacement is left, and the old session on /dev/ttys901 was left as it was")|$(sfield "$res" closes)|$(sfield "$res" ERR | grep -c 'kill 4242')"
# A creation that died before it made anything says so plainly, and names no step.
res=$(rprobe create-nothing)
check "a creation that made nothing says nothing was made, and names no step of the old session" "1|1|1|0|0|0" \
  "$(sfield "$res" exit)|$(sfield "$res" spawned)|$(sfield "$res" ERR | grep -cF "rotate: the spawn failed before its replacement was made (no session found on /dev/ttys900): nothing was made, and the old session on /dev/ttys901 was left as it was")|$(sfield "$res" closes)|$(sfield "$res" ERR | grep -c 'kill 4242')|$(printf '%s' "$res" | grep -c 'Traceback')"
# An unverified replacement whose host was found is checked by that host's pid: verify passes no
# other process on its tty.
res=$(rprobe mode-interrupt)
check "the check of an unverified replacement names its host's pid" "1|[[\"verify\", \"--tty\", \"/dev/ttys903\", \"--pid\", \"6363\"]]|1" \
  "$(sfield "$res" exit)|$(sfield "$res" verifies)|$(sfield "$res" ERR | grep -cF "rotate: the rotation was interrupted by SIGINT during the spawn, once its replacement was made on /dev/ttys903, so the old session on /dev/ttys901 was not closed; the replacement made on /dev/ttys903 is kept, though whether it started was not verified, and its chain entry may be missing; check that it runs with verify --tty /dev/ttys903 --pid 6363 before ending the old session: $THERE")"
# And every close step of a line written once the replacement's tty is known keeps the checkout
# and is guarded, the spawn's own refused replacement included.
for m in create-sigterm refuse-unclosed refuse-interrupt; do
  res=$(ORCHESTRATOR_SPAWN_TIMEOUT=2 rprobe $m)
  n=$(sfield "$res" closes)
  check "every close step of $m keeps the checkout and is guarded" "1|1|1" \
    "$([ "${n:-0}" -ge 1 ] && echo 1 || echo 0)|$([ "$(sfield "$res" kept)" = "$n" ] && echo 1 || echo 0)|$([ "$(sfield "$res" guarded)" = "$n" ] && echo 1 || echo 0)"
done
res=$(ORCHESTRATOR_SPAWN_TIMEOUT=2 rprobe refuse-unclosed)
check "a replacement the spawn refused and could not close is kept, and the line names both" "1|close_made /dev/ttys903|/dev/ttys903|1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" OUT)|$(sfield "$res" ERR | grep -cF "rotate: the spawn refused the replacement it made on /dev/ttys903 (claude never started on /dev/ttys903 after 2s) and could not close it, so the old session on /dev/ttys901 was not closed; the replacement made on /dev/ttys903 is kept, though it was refused, and its chain entry may be missing; $CHECKED: $THERE")|$(printf '%s' "$res" | grep -c 'Traceback')"
res=$(ORCHESTRATOR_SPAWN_TIMEOUT=2 rprobe refuse-closed)
check "a replacement the spawn refused and closed ends on the rotation's line, the old session untouched" "1|close_made /dev/ttys903,drop T903|1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -cF "rotate: the spawn refused the replacement it made on /dev/ttys903 (claude never started on /dev/ttys903 after 2s) and closed it; the old session on /dev/ttys901 was not touched, and nothing is left to close")|$(printf '%s' "$res" | grep -c 'Traceback')"
ORCHESTRATOR_STATE_DIR="$WORK/latestate" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_PS_TABLE=/dev/null ORCHESTRATOR_SPAWN_TIMEOUT=2 \
  "$py" "$WORK/late_probe.py" "$ROOT/skills/iterm-agents/scripts" pipe-refuse-unclosed "$WORK" 2>"$WORK/pipe-err"
rc=$?
check "the spawn's refusal is not lost to a stdout whose reader is gone: the rotation's line, exit 1" "1|1|0|0" \
  "$rc|$(grep -cF "ERROR: rotate: the spawn refused the replacement it made on /dev/ttys903 (claude never started on /dev/ttys903 after 2s) and could not close it" "$WORK/pipe-err")|$(grep -c 'Exception ignored' "$WORK/pipe-err")|$(grep -c 'BrokenPipeError' "$WORK/pipe-err")"
# A suite started with SIGINT ignored (in the background, under nohup) proves the same hold.
res=$( (trap '' INT; PROBE_TMUX="$WORK/group-tmux" TMUX="$TSOCK,4242,1" TMUX_PANE=%0 ORCHESTRATOR_SPAWN_TIMEOUT=2 rprobe group-sigint) )
check "and so it does when the run inherited SIGINT ignored" "1|1|1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" spawned)|$(sfield "$res" ERR | grep -cF "rotate: the rotation was interrupted by SIGINT during the spawn, once its replacement was made on /dev/ttys903, so the old session on /dev/ttys901 was not closed; the replacement made on /dev/ttys903 is kept, though whether it started was not verified, and its chain entry may be missing; $CHECKED: $THERE")|$(printf '%s' "$res" | grep -c 'Traceback')"
# A second signal while the rotation turns to its line is held, never a traceback.
res=$(lprobe second-signal)
check "a second signal as the rotation writes its line is held: the same line, no traceback" "1|1|yes|0" \
  "$(sfield "$res" exit)|$(sfield "$res" ERR | grep -cF "rotate: the old session on /dev/ttys901 was not closed: its close was interrupted by SIGINT before it ended anything; $KEPT; $THERE")|$(sfield "$res" restored)|$(printf '%s' "$res" | grep -c 'Traceback')"
# A hangup the caller ignores (nohup) stays ignored through the rotation.
res=$(lprobe nohup)
check "a hangup ignored by the caller stays ignored while the rotation closes" "1|hup=ignored|yes" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" restored)"
# A spawn option given with no value is refused as the rotation's, nothing spawned.
cat > "$WORK/tier_probe.py" <<'PYEOF'
import sys
sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
ia.cmd_spawn = lambda *a, **k: print("spawned")
try:
    ia.cmd_rotate(ia.args_from_line('rotate', ["--old-tty", "/dev/ttys901", "--dir", "/x", "--prompt", "p", "--tier"]))
except SystemExit as e:
    print("exit=%s" % e.code)
PYEOF
out=$("$py" "$WORK/tier_probe.py" "$ROOT/skills/iterm-agents/scripts" 2>&1)
check "rotate --tier with no value is refused on one line, exit 1, nothing spawned" "exit=1|1|0|0" \
  "$(printf '%s' "$out" | grep '^exit=')|$(printf '%s' "$out" | grep -cxF "ERROR: rotate: refused: the spawn's options cannot be read (argument --tier: expected one argument): nothing was spawned")|$(printf '%s' "$out" | grep -cx 'spawned')|$(printf '%s' "$out" | grep -c 'usage:')"
# Before the spawn, a process table that cannot be read says nothing of whether the old tab is a
# home tab: the rotation is refused, never let through as « not one ».
cat > "$WORK/home_probe.py" <<'PYEOF'
import sys
sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
def through(*a, **k):
    print("let through")
    sys.exit(0)
ia.terminal_for = through
ia.session_id_on = through
ia.host_identity = lambda tty: None
if sys.argv[2] == "refusals":
    ia.close_refusals("rotate", "/dev/ttys960", "")
else:
    ia.old_session("/dev/ttys960", None, "Agent: one", "", "")
PYEOF
out=$(ORCHESTRATOR_PS_TABLE="$WORK/no-such-ps-table" "$py" "$WORK/home_probe.py" "$ROOT/skills/iterm-agents/scripts" refusals 2>&1)
check "rotate's refusals read a home tab strictly: a process table that cannot be read refuses" "0|1" \
  "$(printf '%s' "$out" | grep -c 'let through')|$(printf '%s' "$out" | grep -cF "ERROR: rotate: refused: whether /dev/ttys960 shows a home server cannot be read (")"
out=$(ORCHESTRATOR_PS_TABLE="$WORK/no-such-ps-table" "$py" "$WORK/home_probe.py" "$ROOT/skills/iterm-agents/scripts" old 2>&1)
check "and so does its reading of the old session" "0|1" \
  "$(printf '%s' "$out" | grep -c 'let through')|$(printf '%s' "$out" | grep -cF "ERROR: rotate: refused: the old session on /dev/ttys960 cannot be read before the spawn (")"

# A home caller still reaches the iTerm2 tabs it did not make as windows (the coordinator's,
# an auditor's): a command naming a tty that is no pane of the server goes to the app.
for c in "close --tty /dev/ttys777" "screen --tty /dev/ttys777 --lines 5" \
         "move --tty /dev/ttys777 --right-of /dev/ttys901 --force"; do
  reset_home; rm -f "$TR/iterm-asked"
  out=$(home $c 2>&1)
  check "from a home session, ${c%% *} on an iTerm2 tab's tty goes to the app, tmux touching no window" "0|0" \
    "$(calls | grep -cE '\[(kill-window|capture-pane|move-window)\]')|$(printf '%s' "$out" | grep -c 'of this home session\|window of another tmux')"
  case "$c" in close*) check "and the app is what close asked" "iterm" "$(asked)";; esac
done
rm -f "$TR/iterm-asked"

# With TMUX and TMUX_PANE set, a tmux that fails is never « not a home session ».
printf '#!/bin/bash\necho x >> "%s/bad-calls"\necho "no server running on /tmp/x" >&2\nexit 1\n' "$TR" > "$TR/tmux-bad"
printf '#!/bin/bash\nsleep 5\n' > "$TR/tmux-slow"
chmod +x "$TR/tmux-bad" "$TR/tmux-slow"
reset_home; rm -f "$TR/bad-calls" "$TR/iterm-asked"
out=$(REC_TMUX="$TR/tmux-bad" home spawn --dir "$WORK" --title "Agent: bad" --prompt p --right-of self --no-verify 2>&1)
check "a tmux that refuses is asked once more, then dies naming the refusal, and no tab is made" "2|1|none" \
  "$(wc -l < "$TR/bad-calls" | tr -d ' ')|$(printf '%s' "$out" | grep -c 'ERROR: tmux: the home session.s mark cannot be read from pane %0 (refused: no server running')|$(asked)"
out=$(ORCHESTRATOR_PROBE_TIMEOUT=1 REC_TMUX="$TR/tmux-slow" home spawn --dir "$WORK" --title "Agent: slow" --prompt p --right-of self --no-verify 2>&1)
check "a tmux that times out dies naming the timeout, and no tab is made" "1|none" \
  "$(printf '%s' "$out" | grep -c '(timed out after 1s)')|$(asked)"

# An orchestrator's agents go into its home session, never into an iTerm2 tab. A caller that
# is an orchestrator outside its home (its rename asked and the move not yet made at the
# turn's end, or a move that never happened) is refused before the app is asked, and the
# refusal says how to get home. Whether the caller is one is read on the host session on its
# own tty: its name, else the orchestrator name --orchestrator gives while the session is not
# yet renamed. Any other caller keeps its tab.
OUTSTATE="$WORK/outsidestate"
outside() { # <ps line of the caller's tty> <spawn options>: a caller in a plain iTerm2 tab
  outside_raw "$1" --tier light --dir "$WORK" --title "Agent: out" --prompt p --right-of self --no-verify "${@:2}"; }
outside_raw() { # <ps line of the caller's tty> <every spawn option>
  local line="$1"; shift
  rm -rf "$OUTSTATE"; mkdir -p "$OUTSTATE/chains"; rm -f "$TR/iterm-asked"
  [ -n "${OUT_COORD:-}" ] && printf '%s\n' "$OUT_COORD" > "$OUTSTATE/coordinator.json"
  if [ -n "$line" ]; then printf '%s\n' "$line" > "$WORK/ps-outside.txt"; else : > "$WORK/ps-outside.txt"; fi
  # The app stands in as a recorder: its first call writes that it was asked and ends the run.
  env -u TMUX -u TMUX_PANE ORCHESTRATOR_TMUX="$TR/tmux" ORCHESTRATOR_SELF_TTY=/dev/ttys800 \
    ORCHESTRATOR_STATE_DIR="$OUTSTATE" ORCHESTRATOR_LOGIN_SHELL=/bin/sh ORCHESTRATOR_PS_TABLE="$WORK/ps-outside.txt" \
    "$py" -c "
import sys; sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
def asked(*args, **kwargs):
    open(sys.argv[2], 'a').write('asked\n')
    sys.exit(3)
for method in ('chain_state', 'can_place', 'create', 'find', 'identity'):
    setattr(ia.ITERM, method, asked)
ia.cmd_spawn(ia.args_from_line('spawn', sys.argv[3:]))" "$ROOT/skills/iterm-agents/scripts" "$TR/iterm-asked" "$@" 2>&1; }
OUTREFUSED="spawn: refused: this session is an orchestrator ('Orch: rev') outside its home session"
out=$(outside '/dev/ttys800 claude' --orchestrator "Orch: rev [52cb36]")
check "an orchestrator not yet moved home (named by --orchestrator, its rename pending) is refused, and iTerm2 is never asked" "1|1|none" \
  "$(printf '%s' "$out" | grep -c "$OUTREFUSED")|$(printf '%s' "$out" | grep -c 'end the turn: its end moves you into your home session')|$(asked)"
check "and nothing is left behind: no prompt file, no launch file, no chain" "0|0" \
  "$(ls "$OUTSTATE/prompts" 2>/dev/null | wc -l | tr -d ' ')|$(ls "$OUTSTATE/chains" | wc -l | tr -d ' ')"
out=$(outside '/dev/ttys800 claude --name Orch: rev')
check "an orchestrator named and still outside its home is refused, iTerm2 never asked" "1|none" \
  "$(printf '%s' "$out" | grep -c "$OUTREFUSED")|$(asked)"
out=$(outside '/dev/ttys800 claude --name Orch : rev')
check "a name in the former shape is an orchestrator's too" "1|none" \
  "$(printf '%s' "$out" | grep -c "$OUTREFUSED")|$(asked)"
out=$(outside '' --orchestrator "Orch: rev [52cb36]")
check "an operator's plain shell (no host session on its tty) keeps its tab" "0|iterm" \
  "$(printf '%s' "$out" | grep -c 'outside its home session')|$(asked)"
out=$(outside '/dev/ttys800 claude --name Coord: machine' --orchestrator "Orch: rev [52cb36]")
check "the coordinator keeps its tab" "0|iterm" "$(printf '%s' "$out" | grep -c 'outside its home session')|$(asked)"
out=$(outside '/dev/ttys800 claude --name Audit: rev' --orchestrator "Orch: rev [52cb36]")
check "an auditor keeps its tab" "0|iterm" "$(printf '%s' "$out" | grep -c 'outside its home session')|$(asked)"
out=$(ORCHESTRATOR_AUDITOR=1 outside '/dev/ttys800 claude' --orchestrator "Orch: rev [52cb36]")
check "an unnamed auditor session keeps its tab" "0|iterm" "$(printf '%s' "$out" | grep -c 'outside its home session')|$(asked)"
out=$(outside '/dev/ttys800 claude --name Agent: bench')
check "a session of another role, unnamed by --orchestrator, keeps its tab" "0|iterm" \
  "$(printf '%s' "$out" | grep -c 'outside its home session')|$(asked)"
out=$(outside '/dev/ttys800 claude' --orchestrator "Agent: x")
check "a host session with no role name and no orchestrator named keeps its tab" "0|iterm" \
  "$(printf '%s' "$out" | grep -c 'outside its home session')|$(asked)"
# A coordinator opened by hand, with no --name, is known by its own record.
out=$(OUT_COORD='{"name":"Coord: machine","tty":"/dev/ttys800"}' outside '/dev/ttys800 claude' --orchestrator "Orch: rev [52cb36]")
check "a coordinator opened by hand without a name, known by its record, keeps its tab" "0|iterm" \
  "$(printf '%s' "$out" | grep -c 'outside its home session')|$(asked)"
# What an orchestrator outside its home makes other than an agent stays as it was: its successor,
# a woken or an opened orchestrator are tabs, and a dry run prints its launch.
OUTORCH='/dev/ttys800 claude --name Orch: rev'
ORCHESTRATOR_PROJECTS_DIR="$WORK/projects" pair_transcript s-outside s-model high
out=$(CLAUDE_CODE_SESSION_ID=s-outside outside_raw "$OUTORCH" --dir "$WORK" --successor --prompt p --no-verify)
check "an orchestrator outside its home still spawns its successor as a tab" "0|iterm" \
  "$(printf '%s' "$out" | grep -c 'outside its home session')|$(asked)"
# A wake and an opening read their caller from the real process table: their dry runs show
# the home server and the tab that shows it.
for how in wake open; do
  out=$(ORCHESTRATOR_DRY_RUN=1 outside_raw "$OUTORCH" --dir "$WORK" --$how --title "Orch: woken" --model a-model --effort high --prompt p)
  check "and a --$how still makes its orchestrator a home shown in a tab right of it" "0|1|1" \
    "$(printf '%s' "$out" | grep -c 'outside its home session')|$(printf '%s' "$out" | grep -c '^home_server=orch-')|$(printf '%s' "$out" | grep -c '^home_tab=right of self$')"
done
out=$(ORCHESTRATOR_DRY_RUN=1 outside "$OUTORCH")
check "and its dry run of an agent prints the launch, as before" "0|1|none" \
  "$(printf '%s' "$out" | grep -c 'outside its home session')|$(printf '%s' "$out" | grep -c '^launch=')|$(asked)"
rm -f "$TR/iterm-asked"
reset_home
out=$(home spawn --dir "$WORK" --title "Agent: three" --prompt p --right-of self --no-verify --orchestrator "Orch: home [52cb36]" 2>&1)
check "an orchestrator in its home still gets a window, iTerm2 never asked" "/dev/ttys903|none" \
  "$(printf '%s' "$out" | tail -1)|$(asked)"

# The chain anchor reads; the launcher writes. Only the caller's entry whose window is gone is
# dropped: an iTerm2 tab's entry and another occupant's stay, and a listing with nothing in
# it proves nothing.
chain_mixed() {
  printf '%s\n' "{\"tab_id\": \"7\", \"tty\": \"/dev/ttys807\", \"owner\": \"tmux:$TSOCK:%0\"}" \
    "{\"tab_id\": \"tmux:$TSOCK:@9\", \"tty\": \"/dev/ttys909\", \"owner\": \"tmux:$TSOCK:%0\"}" \
    "{\"tab_id\": \"tmux:$TSOCK:@1\", \"tty\": \"/dev/ttys901\", \"owner\": \"tmux:$TSOCK:%0\"}" \
    "{\"tab_id\": \"tmux:$TSOCK:@8\", \"tty\": \"/dev/ttys908\", \"owner\": \"tmux:$TSOCK:%7\"}" > "$TSTATE/chains/ttys900.jsonl"
}
reset_home; chain_mixed
out=$(home spawn --dir "$WORK" --title "Agent: three" --prompt p --right-of self --no-verify 2>&1)
check "a spawn drops the caller's gone window and keeps an iTerm2 tab's entry and another owner's" "0|1|1|1|1|0" \
  "$(printf '%s' "$out" | grep -c '^ERROR')|$(chainf | grep -c '"tab_id": "7"')|$(chainf | grep -c '@1"')|$(chainf | grep -c '@8"')|$(chainf | grep -c '@4"')|$(chainf | grep -c '@9"')"
reset_home; chain_mixed
out=$(REC_PANES_RAW=' ' home spawn --dir "$WORK" --title "Agent: three" --prompt p --right-of self --no-verify 2>&1)
check "a listing with no pane in it prunes nothing" "4" "$(chainf | grep -c 'tab_id' | awk '{ print $1 - 1 }')"

# A listing that cannot be read is refused; one bad line among good ones is a warning.
reset_home
out=$(REC_PANES_RAW='garbage\nmore garbage\n' home list 2>&1)
check "a pane listing no line of which parses dies" "1" "$(printf '%s' "$out" | grep -c 'ERROR: tmux: the pane listing cannot be read: 2 line(s)')"
out=$(REC_PANES_RAW='$1\t0\t@0\t%0\t/dev/ttys900\torch\tOrch\ngarbage\n' home list 2>&1)
check "one unparsable line among good ones is one warning, the good ones still listed" "1|1" \
  "$(printf '%s' "$out" | grep -c '^tmux: 1 line(s) of the pane listing were skipped')|$(printf '%s' "$out" | grep -c '^w1/t0 | /dev/ttys900 ')"

# A window whose answer does not split is killed by its id before the death.
reset_home
out=$(REC_NEW_RAW='@7 %7' home spawn --dir "$WORK" --title "Agent: odd" --prompt p --right-of self --no-verify 2>&1)
check "a window made and answered in too few fields is killed by its id, then the spawn dies" "1|1" \
  "$(calls | grep -c '^\[-u\]\[kill-window\]\[-t\]\[@7\]$')|$(printf '%s' "$out" | grep -c 'ERROR: spawn: tmux made a window and answered')"
reset_home
out=$(REC_NEW_RAW='weird' home spawn --dir "$WORK" --title "Agent: odd" --prompt p --right-of self --no-verify 2>&1)
check "an answer with no window id kills nothing" "0" "$(calls | grep -c '\[kill-window\]')"

# A window already gone is closed; any other refusal is a failure with its message.
reset_home
out=$(REC_KILL_ERR="can't find window: @1" home close --tty /dev/ttys901 2>&1)
check "a window tmux cannot find is closed, and its chain entry dropped" "1|0" \
  "$(printf '%s' "$out" | grep -c '^closed 1 session on /dev/ttys901')|$(chainf | grep -c '@1"')"
reset_home
out=$(REC_KILL_ERR="server exited unexpectedly" home close --tty /dev/ttys901 2>&1)
check "any other refusal of the kill is a failure with its message" "1|1" \
  "$(printf '%s' "$out" | grep -c 'ERROR: close: tmux refused kill-window: server exited unexpectedly')|$(chainf | grep -c '@1"')"

# A move that fails after the first says what already happened.
reset_home
out=$(REC_RENUMBER_ERR="no such session" home move --tty /dev/ttys902 --left-of /dev/ttys901 2>&1)
check "a failed renumbering says the window was already moved, and where" "1" \
  "$(printf '%s' "$out" | grep -c 'ERROR: move: the window @2 was already moved before @1')"
reset_home
printf '%s\n' '$1	0	@0	%0	/dev/ttys900	orch	Orch' '$1	1	@1	%1	/dev/ttys901	Agent: one	one' > "$TR/panes.moved"
out=$(home move --tty /dev/ttys902 --left-of /dev/ttys901 2>&1)
check "a moved window missing from the listing afterwards dies with a message" "1" \
  "$(printf '%s' "$out" | grep -c 'ERROR: move: the window @2 was moved before @1, and is no longer in the session')"

# The session is never the current one by accident.
reset_home
out=$(REC_SESSION=garbage home spawn --dir "$WORK" --title "Agent: three" --prompt p --right-of self --no-verify 2>&1)
check "a session id that is none dies before any window is made" "1|0" \
  "$(printf '%s' "$out" | grep -c "ERROR: tmux: the session of pane %0 was answered 'garbage'")|$(calls | grep -c '\[new-window\]')"

# A close is proved on the window, the tty being recyclable.
reset_home
out=$(REC_KEEP_WINDOW=1 home close --tty /dev/ttys901 2>&1)
check "a window still in the server after its process is gone is a close that did not happen" "1|0" \
  "$(printf '%s' "$out" | grep -c 'ERROR: close: the request was accepted but tmux:.*:@1 is still there')|$(printf '%s' "$out" | grep -c '^closed')"

# An agent and an orchestrator's successor are windows: the successor takes the predecessor's
# window 0 in the same session, where the agents are. So are the successors of a coordinator and of
# an auditor in their own home session (below). An auditor, a woken or an opened orchestrator start
# in a home server of their own, shown by a tab.
reset_home; rm -f "$TR/iterm-asked"
ORCHESTRATOR_PROJECTS_DIR="$TR/projects" pair_transcript s-suite s-model high
out=$(home spawn --dir "$WORK" --successor --prompt p 2>"$WORK/tsucc.err")
check "a successor spawned from a home session is a window of that session under the caller's name, and iTerm2 is never asked" \
  "/dev/ttys903|[-u][new-window][-d][-t][\$1:][-n][Orch: home][-P][-F][#{window_id} #{pane_id} #{pane_tty}][/bin/sh -l @STATE@/prompts/launch-Orch--home-@TIME@.sh]|none" \
  "$out|$(calls | grep -F '[new-window]')|$(asked)"
check "the chain is handed over keyed on the successor's pane: its tty's file, the successor's tmux owner, never an app id" \
  "{\"tab_id\": \"tmux:$TSOCK:@1\", \"tty\": \"/dev/ttys901\", \"owner\": \"tmux:$TSOCK:%4\"}|{\"tab_id\": \"tmux:$TSOCK:@2\", \"tty\": \"/dev/ttys902\", \"owner\": \"tmux:$TSOCK:%4\"}|0|1" \
  "$(paste -sd'|' "$TSTATE/chains/ttys903.jsonl")|$(chainf | grep -c .)|$(grep -c 'chain of 2 agent(s) handed to the successor on /dev/ttys903' "$WORK/tsucc.err")"
rm -f "$TR/iterm-asked"

# The coordinator and an auditor run in a home server of their own, like an orchestrator (the
# operator's order, 2026-11-27): from window 0 there, the successor of each is a window of the same
# session, never an iTerm2 tab, and its takeover takes window 0, guarded by the role's name.
role_home() { # <window 0's name>: the home session of a coordinator or an auditor, an agent beside it
  reset_home
  printf '%s\n' "\$1	0	@0	%0	/dev/ttys900	$1	✳ $1" '$1	1	@1	%1	/dev/ttys901	Agent: one	✳ Agent: one' > "$TR/panes"
  printf '%s\n' "/dev/ttys900 claude --name $1" '/dev/ttys901 claude --name Agent: one' > "$TR/ps"
  rm -f "$TR/iterm-asked"; }
ORCHESTRATOR_PROJECTS_DIR="$TR/projects" pair_transcript s-suite s-model high
role_home "Coord: machine"
out=$(home spawn --dir "$WORK" --coordinator-successor --title "Coord: machine" --prompt p --no-verify 2>"$WORK/trole.err")
check "a coordinator's successor spawned from its home session is a window of it under its name, iTerm2 never asked" \
  "/dev/ttys903|[-u][new-window][-d][-t][\$1:][-n][Coord: machine][-P][-F][#{window_id} #{pane_id} #{pane_tty}][/bin/sh -l @STATE@/prompts/launch-Coord--machine-@TIME@.sh]|none|0" \
  "$out|$(calls | grep -F '[new-window]')|$(asked)|$(grep -c 'is not placed first' "$WORK/trole.err")"
role_home "Audit: tm"
out=$(home spawn --dir "$WORK" --successor --prompt p --no-verify 2>&1 | tail -1)
check "an auditor's successor spawned from its home session is a window of it under the auditor's name, iTerm2 never asked" \
  "/dev/ttys903|[-u][new-window][-d][-t][\$1:][-n][Audit: tm][-P][-F][#{window_id} #{pane_id} #{pane_tty}][/bin/sh -l @STATE@/prompts/launch-Audit--tm-@TIME@.sh]|none" \
  "$out|$(calls | grep -F '[new-window]')|$(asked)"
for who in "Coord: machine|Coord:" "Audit: tm|Audit: tm"; do
  name=${who%%|*}; expect=${who#*|}
  role_home "$name"
  printf '%s\n' "\$1	9	@4	%4	/dev/ttys903	$name	✳ $name" >> "$TR/panes"
  printf '/dev/ttys903 claude --name %s\n' "$name" >> "$TR/ps"
  rm -f "$TR/calls"
  out=$(TMUX="$TSOCK,4242,1" TMUX_PANE=%4 ORCHESTRATOR_TMUX="$TR/tmux" ORCHESTRATOR_OSASCRIPT="$TR/osascript" ORCHESTRATOR_SAMPLE=/usr/bin/false \
    ORCHESTRATOR_APP_PID=1 ORCHESTRATOR_SELF_TTY=/dev/ttys903 ORCHESTRATOR_STATE_DIR="$TSTATE" ORCHESTRATOR_PS_TABLE="$TR/ps" ORCHESTRATOR_CLOSE_TIMEOUT=1 \
    bash "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh" takeover --tty /dev/ttys900 --expect-title "$expect" 2>&1)
  check "the takeover of the ${name%%:*} successor kills window 0, its name checked, and moves the successor to index 0" \
    "1|[-u][kill-window][-t][@0]|[-u][move-window][-d][-s][@4][-t][\$1:0]|0" \
    "$(printf '%s' "$out" | grep -c '^took window 0: the predecessor.s window @0 on /dev/ttys900 was closed')|$(calls | grep -F '[kill-window]')|$(calls | grep -F '[move-window]')|$(grep -c ttys900 "$TR/ps")"
done
rm -f "$TR/iterm-asked"

# The successor's takeover, from its own window: the predecessor's window 0 killed, guarded by
# its name, proved gone, then the successor moved to index 0 without taking the operator's view.
heir() { # <subcommand and options>: the launcher, called from the successor's window
  TMUX="$TSOCK,4242,1" TMUX_PANE=%4 ORCHESTRATOR_TMUX="$TR/tmux" ORCHESTRATOR_OSASCRIPT="$TR/osascript" \
    ORCHESTRATOR_SAMPLE=/usr/bin/false ORCHESTRATOR_APP_PID=1 ORCHESTRATOR_SELF_TTY=/dev/ttys903 ORCHESTRATOR_STATE_DIR="$TSTATE" \
    ORCHESTRATOR_PS_TABLE="$TR/ps" ORCHESTRATOR_CLOSE_TIMEOUT=1 bash "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh" "$@"; }
reset_home
printf '%s\n' '$1	9	@4	%4	/dev/ttys903	Orch: home	✳ Orch: home' >> "$TR/panes"
printf '/dev/ttys903 claude --name Orch: home\n' >> "$TR/ps"
printf '%s\n' '$1	0	@0	%0	/dev/ttys900	Orch: home	✳ Orch: home' '$1	1	@1	%1	/dev/ttys901	Agent: one	✳ Agent: one' \
  '$1	2	@2	%2	/dev/ttys902	Agent: two	⠂ Agent: two' '$2	0	@3	%3	/dev/ttys950	other	✳ elsewhere' \
  '$1	9	@4	%4	/dev/ttys903	Orch: home	✳ Orch: home' > "$TR/panes"
rm -f "$TR/calls"
out=$(heir takeover --tty /dev/ttys900 --expect-title "Orch: home" 2>&1)
# No transcript of the predecessor is found here: the line says no « handed over » was read.
check "takeover kills window 0 by its id, proved gone, and moves the successor to index 0 detached" \
  "takeover: no transcript of the session on /dev/ttys900 was found: no « handed over » read
took window 0: the predecessor's window @0 on /dev/ttys900 was closed|[-u][kill-window][-t][@0]|[-u][move-window][-d][-s][@4][-t][\$1:0]|0|0" \
  "$out|$(calls | grep -F '[kill-window]')|$(calls | grep -F '[move-window]')|$(calls | grep -c '\[select-window\]')|$(grep -c ttys900 "$TR/ps")"
check "a takeover writes its dated line: the socket, the cause takeover and the predecessor's tty" "1" \
  "$(grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z home: window 0 of home ended: cause=takeover tty=/dev/ttys900$' "$TSTATE/close.log")"
# A TMUX value that names no socket gives the takeover no socket to write: no line, rather than a
# line that reads « window 0 of  ended ».
reset_home
printf '%s\n' '$1	0	@0	%0	/dev/ttys900	Orch: home	✳ Orch: home' '$1	9	@4	%4	/dev/ttys903	Orch: home	✳ Orch: home' > "$TR/panes"
printf '/dev/ttys903 claude --name Orch: home\n' >> "$TR/ps"
rm -f "$TR/calls"
out=$(TMUX=",4242,1" TMUX_PANE=%4 ORCHESTRATOR_TMUX="$TR/tmux" ORCHESTRATOR_OSASCRIPT="$TR/osascript" \
    ORCHESTRATOR_SAMPLE=/usr/bin/false ORCHESTRATOR_APP_PID=1 ORCHESTRATOR_SELF_TTY=/dev/ttys903 ORCHESTRATOR_STATE_DIR="$TSTATE" \
    ORCHESTRATOR_PS_TABLE="$TR/ps" ORCHESTRATOR_CLOSE_TIMEOUT=1 bash "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh" takeover --tty /dev/ttys900 --expect-title "Orch: home" 2>&1)
check "a takeover that knows no socket writes no line: the window is taken and close.log holds no empty name" "1|0" \
  "$(printf '%s' "$out" | grep -c '^took window 0:')|$(cat "$TSTATE/close.log" 2>/dev/null | grep -c 'window 0 of  ended')"
reset_home
printf '%s\n' '$1	0	@0	%0	/dev/ttys900	Orch: home	✳ Orch: home' '$1	9	@4	%4	/dev/ttys903	Orch: home	✳ Orch: home' > "$TR/panes"
printf '/dev/ttys903 claude --name Orch: home\n' >> "$TR/ps"
rm -f "$TR/calls"
out=$(REC_ACTIVE=1 heir takeover --tty /dev/ttys900 --expect-title "Orch: home" 2>&1)
check "and selects window 0 only when the operator was on it" "[-u][select-window][-t][@4]" "$(calls | grep -F '[select-window]')"
reset_home
printf '%s\n' '$1	0	@0	%0	/dev/ttys900	Orch: home	✳ Orch: home' '$1	1	@1	%1	/dev/ttys901	Agent: one	✳ Agent: one' '$1	9	@4	%4	/dev/ttys903	Orch: home	✳ Orch: home' > "$TR/panes"
rm -f "$TR/calls"
out=$(heir takeover --tty /dev/ttys900 --expect-title "Orch: other" 2>&1)
check "a window 0 whose name does not hold the expected words is not killed" "1|0" \
  "$(printf '%s' "$out" | grep -c "takeover: refused: the window on /dev/ttys900 is named 'Orch: home', which does not contain 'Orch: other'")|$(calls | grep -c '\[kill-window\]')"
rm -f "$TR/calls"
out=$(heir takeover --tty /dev/ttys901 2>&1)
check "an agent's window is not the predecessor's place" "1|0" \
  "$(printf '%s' "$out" | grep -c 'takeover: refused: the window on /dev/ttys901 is window 1, not window 0')|$(calls | grep -c '\[kill-window\]')"
rm -f "$TR/calls"
out=$(heir takeover --tty /dev/ttys903 2>&1)
check "nor is the successor's own window" "1|0" \
  "$(printf '%s' "$out" | grep -c "takeover: refused: /dev/ttys903 is this session's own window")|$(calls | grep -c '\[kill-window\]')"
# close is the wrong command for window 0 of a home session: refused before anything is killed
# or moved, and the refusal names takeover, the one command that puts a successor at index 0.
rm -f "$TR/calls"
out=$(heir close --tty /dev/ttys900 --expect-title "Orch: home" 2>&1)
rc=$?
check "close on window 0 of a home session is refused before anything is killed, and names takeover" "1|1|1|0|0" \
  "$(printf '%s' "$out" | grep -c 'close: refused: the window on /dev/ttys900 is window 0, the orchestrator.s place in this home session: a successor takes it with takeover --tty /dev/ttys900 --expect-title .Orch: home., which also puts its own window at index 0')|$(printf '%s' "$out" | grep -cF -e "--expect-title 'Orch: home',")|$([ "$rc" -ne 0 ] && echo 1 || echo 0)|$(calls | grep -c '\[kill-window\]')|$(calls | grep -c '\[move-window\]')"
# rotate closes the old window only after its replacement has spawned, so a close that refuses
# window 0 would leave the replacement running with nothing to close: the rotation refuses window
# 0 first, before anything is spawned or killed, with the refusal close gives and the same command.
rm -f "$TR/calls"
out=$(heir rotate --old-tty /dev/ttys900 --expect-title "Orch: home" --dir "$WORK" --title "Agent: rotated" --tier light --prompt p 2>&1)
rc=$?
check "rotate on window 0 of a home session is refused before anything is spawned or killed, and names takeover" "1|1|1|0|0" \
  "$(printf '%s' "$out" | grep -c 'rotate: refused: the window on /dev/ttys900 is window 0, the orchestrator.s place in this home session: a successor takes it with takeover --tty /dev/ttys900 --expect-title .Orch: home., which also puts its own window at index 0')|$(printf '%s' "$out" | grep -cF -e "--expect-title 'Orch: home',")|$([ "$rc" -ne 0 ] && echo 1 || echo 0)|$(calls | grep -c '\[new-window\]')|$(calls | grep -c '\[kill-window\]')"
# The coordinator's pause close is a close on a home tab's tty, which is not a pane of this
# server: it takes the home server's road, never window 0's refusal, and kills no window. The
# whole close (tab and server ended) is pinned beside the home close tests.
printf '/dev/ttys970 tmux -u -L orch-tsuite attach -t home\n' >> "$TR/ps"
rm -f "$TR/calls"
out=$(heir close --tty /dev/ttys970 2>&1)
check "a close on a home tab's tty is not window 0's refusal, and kills no window" "0|0" \
  "$(printf '%s' "$out" | grep -c 'close: refused: the window on')|$(calls | grep -c '\[kill-window\]')"
grep -v '^/dev/ttys970 ' "$TR/ps" > "$TR/ps.tmp" && mv "$TR/ps.tmp" "$TR/ps"
# The successor's takeover proves what it did before it takes the index: a host that outlives
# the kill, or a window still listed, stops it; the name guard is required; the chain entry of
# the predecessor's window goes with it.
takeover_setup() {
  reset_home
  printf '%s\n' '$1	0	@0	%0	/dev/ttys900	Orch: home	✳ Orch: home' '$1	1	@1	%1	/dev/ttys901	Agent: one	✳ Agent: one' \
    '$1	9	@4	%4	/dev/ttys903	Orch: home	✳ Orch: home' > "$TR/panes"
  printf '/dev/ttys903 %s --name Orch: home\n' "$(awk 'NR == 1 { print $2 }' "$TR/ps")" >> "$TR/ps"
  rm -f "$TR/calls"
}
takeover_setup
out=$(REC_KEEP_HOST=1 heir takeover --tty /dev/ttys900 --expect-title "Orch: home" 2>&1)
check "a host still on the tty after the kill stops the takeover: it dies and window 0 is not taken" "1|1|0" \
  "$(printf '%s' "$out" | grep -c 'takeover: the window @0 was killed and .* still runs on /dev/ttys900; window 0 was not taken')|$(calls | grep -c '\[kill-window\]')|$(calls | grep -c '\[move-window\]')"
takeover_setup
out=$(REC_KEEP_WINDOW=1 heir takeover --tty /dev/ttys900 --expect-title "Orch: home" 2>&1)
check "a window still listed by the server after the kill stops it too" "1|1|0" \
  "$(printf '%s' "$out" | grep -c 'takeover: the window @0 is still there; window 0 was not taken')|$(calls | grep -c '\[kill-window\]')|$(calls | grep -c '\[move-window\]')"
takeover_setup
out=$(heir takeover --tty /dev/ttys900 2>&1)
check "a takeover without the expected title is refused before anything is killed" "1|0|0" \
  "$(printf '%s' "$out" | grep -c 'takeover: --expect-title is required')|$(calls | grep -c '\[kill-window\]')|$(calls | grep -c '\[move-window\]')"
takeover_setup
printf '{"tab_id":"tmux:%s:@0","tty":"/dev/ttys905","owner":"tmux:%s:%%9"}\n{"tab_id":"tmux:%s:@7","tty":"/dev/ttys906","owner":"tmux:%s:%%9"}\n' "$TSOCK" "$TSOCK" "$TSOCK" "$TSOCK" > "$TSTATE/chains/ttys905.jsonl"
out=$(heir takeover --tty /dev/ttys900 --expect-title "Orch: home" 2>&1)
check "the chain entry naming the predecessor's window is dropped by the takeover, the others kept" "0|1" \
  "$(grep -c "tmux:$TSOCK:@0\"" "$TSTATE/chains/ttys905.jsonl" 2>/dev/null)|$(grep -c "tmux:$TSOCK:@7\"" "$TSTATE/chains/ttys905.jsonl" 2>/dev/null)"

rm -f "$TR/mark"
out=$(heir takeover --tty /dev/ttys900 2>&1)
check "outside a home session the takeover is refused, the tab being closed as before" "1" \
  "$(printf '%s' "$out" | grep -c 'takeover: refused: this session is not in a home session')"
printf '1\n' > "$TR/mark"

# `screen --lines N` returned the FIRST N lines of the tab, which on a tall terminal are
# blank: the blocked agent's prompt sat at the bottom and three reads out of four came back
# empty while the tooling reported success. Trailing blanks go, interior ones stay — a
# blank line between two of an agent's messages is part of what it is showing.
check "the screen is read from the bottom, trailing blanks dropped" '["b","c"]' \
  "$(last_n '["a","b","c","",""]' 2)"
check "a blank line inside the reading is kept" '["a","","b"]' \
  "$(last_n '["a","","b","",""]' 3)"
check "fewer lines than asked is the whole reading" '["a"]' \
  "$(last_n '["a",""]' 5)"
check "nothing but blanks reads as nothing" '[]' \
  "$(last_n '["","",""]' 3)"

# A dry run reads no transcript: there is no session to have come up in any mode, and the
# line says the check was skipped rather than passed.
check "the dry run skips the reading and says so" "1" \
  "$(shaped --title 'Agent: x' | grep -c '^mode_check=skipped$')"

echo "== iterm-agents: an orchestrator moves into its home session =="
# The one way an orchestrator gets a home session: at the end of the turn that named it, the
# module runs `home`, which starts a server of its own whose window 0 resumes the SAME
# conversation once the session has ended in its old tab, and opens a tab right of that one
# showing it. The launch is replayed from the process's own words, less what named the
# conversation. A recorder stands in for tmux and a terminal of the probe's own for iTerm2;
# the host's registry and the process's words are files of the suite's. The server is started
# with an environment of its own, so the recorder reads its answers from files, never from
# variables.
HR="$WORK/homerec"; mkdir -p "$HR"
cat > "$HR/tmux" <<'SH'
#!/bin/bash
d=$(dirname "$0")
{ for a in "$@"; do printf '[%s]' "$a"; done; printf '\n'; } >> "$d/calls"
printf '%s\n' "${TMUX_TMPDIR-unset}" >> "$d/tmpdir"
[ "$1" = -u ] && shift
[ "$1" = -L ] && shift 2
[ "$1" = -f ] && shift 2
case "$1" in
  show) [ -f "$d/mark" ] && cat "$d/mark"; exit 0 ;;
  show-options) [ -f "$d/owners" ] && cat "$d/owners"; exit 0 ;;
  # The arm lists its owners: refused when the case says so, else kept for show-options.
  set-option) if [ "$2" = -s ] && [ "$3" = @home-owners ]; then [ -f "$d/arm-err" ] && { cat "$d/arm-err" >&2; exit 1; }; printf '%s\n' "$4" > "$d/owners"; fi; exit 0 ;;
  new-session) printf '%s\n' "${CLAUDE_CONFIG_DIR-unset}" >> "$d/configdir"; [ -f "$d/new-err" ] && { cat "$d/new-err" >&2; exit 1; }; printf '%s\n' "${@: -1}" > "$d/window0"
    # The host a session starts writes its transcript: one the case staged is put in place now,
    # after the launcher took the launch's time.
    [ -f "$d/transcript" ] && cp "$d/transcript" "$(cat "$d/transcript-to")"; exit 0 ;;
  display-message) echo /dev/ttys960 ;;
  list-clients) [ -f "$d/clients" ] && cat "$d/clients"; exit 0 ;;
  has-session) exit 1 ;;
  kill-server) [ -f "$d/kill-err" ] && { cat "$d/kill-err" >&2; exit 1; }; exit 0 ;;
  list-windows) [ -f "$d/windows" ] && cat "$d/windows"; exit 0 ;;
  kill-window) [ -f "$d/kwin-err" ] && { cat "$d/kwin-err" >&2; exit 1; }; exit 0 ;;
  list-panes) [ -f "$d/panes-err" ] && { cat "$d/panes-err" >&2; exit 1; }; [ -f "$d/panes" ] && cat "$d/panes"; exit 0 ;;
  # Window 0's host shows its prompt box, empty: nothing the operator typed is waiting.
  capture-pane) printf '%s\n\xe2\x9d\xaf\xc2\xa0\n%s\n' "$(printf '─%.0s' {1..40})" "$(printf '─%.0s' {1..40})"; exit 0 ;;
esac
exit 0
SH
chmod +x "$HR/tmux"
HSID=abcdef12-3456-4789-8abc-def012345678
HCONF="$WORK/homeconfig"; mkdir -p "$HCONF/sessions"
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","name":"Agent: start"}\n' "$$" "$HSID" "$WORK" > "$HCONF/sessions/$$.json"
# The launch line asked for a-model at the host's default effort; the session runs on t-model
# at xhigh now, as its transcript says, and that is the pair the move resumes on.
pair_transcript "$HSID" t-model xhigh
HARGV='["/opt/x/host","--model","a-model","--permission-mode","auto","--settings","{\"k\":1}","--strict-mcp-config","--mcp-config","/m/a.json","--name","Agent: start","the first prompt"]'
homecmd() { # the launcher's `home`, from a plain tab outside tmux unless HTMUX names a pane's server
  env -u TMUX -u TMUX_PANE ${HTMUX:+TMUX="$HTMUX" TMUX_PANE=%0} CLAUDE_CONFIG_DIR="$HCONF" ORCHESTRATOR_HOST_ARGV="${HARGV_OVERRIDE:-$HARGV}" ORCHESTRATOR_TMUX="$HR/tmux" \
    ORCHESTRATOR_STATE_DIR="$WORK/homestate" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_LOGIN_SHELL=/bin/sh ORCHESTRATOR_HOST_CLI=/opt/x/host \
    "$@"; }
hcalls() { sed "s#$WORK#@WORK@#g; s#$ROOT#@ROOT@#g; s#-[0-9]\{13\}\.#-@TIME@.#g" "$HR/calls" 2>/dev/null; }
reset_homerec() { rm -f "$HR/calls" "$HR/tmpdir" "$HR/configdir" "$HR/mark" "$HR/clients" "$HR/window0" "$HR/kill-err" "$HR/panes-err" "$HR/panes" "$HR/windows" "$HR/kwin-err" "$HR/owners" "$HR/arm-err"; rm -rf "$WORK/homestate"; }

reset_homerec
out=$(homecmd env ORCHESTRATOR_DRY_RUN=1 bash "$AGENT" home --session "$HSID" --name "Orch: conv" --prompt "Go on" 2>&1)
check "the dry run names the server after the session, its conf, and window 0 after the orchestrator" \
  "orch-abcdef12|skills/iterm-agents/tmux/home.conf|Orch: conv|right of /dev/ttys900" \
  "$(sfield "$out" home_server)|$(sfield "$out" home_conf)|$(sfield "$out" home_window0)|$(sfield "$out" home_tab)"
HOSTLINE="/opt/x/host --model t-model --effort xhigh --permission-mode auto --settings '{\"k\":1}' --strict-mcp-config --mcp-config /m/a.json --resume $HSID 'Go on' --name 'Orch: conv'"
BYHAND=$("$py" -c 'import shlex,sys; print(shlex.quote(sys.argv[1]))' "cd $WORK && $HOSTLINE")
check "window 0 waits for the old process, runs the resume on the session's current model and effort, read on its transcript, and the launch's mode, settings and servers under its name, releases the old tab through a watcher once the resumed host is proved, and names the failure of a resume that fails" \
  "cd $WORK && i=0 && while kill -0 $$ 2>/dev/null; do if [ \$i -ge 600 ]; then echo 'the session did not end in its old place: it goes on there'; $ROOT/skills/iterm-agents/scripts/iterm-agent.sh home-release --abandon orch-abcdef12 >> $WORK/homestate/home-release.log 2>&1 || echo 'the home server could not be closed: close this tab by hand'; sleep 10; exit 1; fi; sleep 0.2; i=\$((i+1)); done; pane=\$(tty); $ROOT/skills/iterm-agents/scripts/iterm-agent.sh home-release --tty /dev/ttys900 --session-id '<old-tab-session-id>' --pane-tty \"\$pane\" --resumed $HSID >> $WORK/homestate/home-release.log 2>&1 & watcher=\$!; $HOSTLINE; rc=\$?; [ \$rc -eq 0 ] && exit 0; kill \$watcher 2>/dev/null; printf 'the resume of session %s failed (exit %s); resume it by hand: %s\\n' $HSID \"\$rc\" $BYHAND; exec \"\${SHELL:-/bin/sh}\" -l" \
  "$(sfield "$out" home_launch)"
check "and the dry run touched no tmux" "" "$(hcalls)"
# The move resumes on the plan the session runs on, read on its own process, whoever runs it: a
# stand-in `ps` says the session's environment holds a plan 2 directory, the caller's says another.
out=$(homecmd env ORCHESTRATOR_HOST_ENV='["HOME=/h","CLAUDE_CONFIG_DIR=/plan/two"]' ORCHESTRATOR_DRY_RUN=1 bash "$AGENT" home --session "$HSID" --name "Orch: conv" --prompt "Go on" 2>&1)
check "the move's home server starts on the session's own plan, not its runner's" "/plan/two" "$(sfield "$out" home_config)"
out=$(homecmd env ORCHESTRATOR_HOST_ENV='["HOME=/h"]' ORCHESTRATOR_DRY_RUN=1 bash "$AGENT" home --session "$HSID" --name "Orch: conv" --prompt "Go on" 2>&1)
check "and a session on plan 1 is moved on plan 1, its runner's variable dropped" "none" "$(sfield "$out" home_config)"
# A successor the launcher named passes no --name: the name is the session's own, read on its tty.
printf '/dev/ttys900 999991 /opt/x/host --resume x --name Orch: conv\n' > "$WORK/home-ps"
out=$(homecmd env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_PS_TABLE="$WORK/home-ps" bash "$AGENT" home --session "$HSID" --prompt "Go on" 2>&1)
check "a move given no name takes the session's own, read on its tty" "Orch: conv" "$(sfield "$out" home_window0)"
printf '/dev/ttys900 999991 /opt/x/host --resume x --name Agent: conv\n' > "$WORK/home-ps"
out=$(homecmd env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_PS_TABLE="$WORK/home-ps" bash "$AGENT" home --session "$HSID" --prompt "Go on" 2>&1)
check "and a session whose own name is no orchestrator's stays where it is" "1" "$(printf '%s' "$out" | grep -c '^stay: only an orchestrator')"
mv "$ORCHESTRATOR_PROJECTS_DIR/p/$HSID.jsonl" "$WORK/hsid-transcript.jsonl"
out=$(homecmd env ORCHESTRATOR_DRY_RUN=1 bash "$AGENT" home --session "$HSID" --name "Orch: conv" --prompt "Go on" 2>&1)
check "a session whose pair cannot be read stays where it is, and says why" "1|0" \
  "$(printf '%s' "$out" | grep -c "^stay: the session's model and effort cannot be read (no transcript for session $HSID")|$(printf '%s' "$out" | grep -c '^home_launch=')"
mv "$WORK/hsid-transcript.jsonl" "$ORCHESTRATOR_PROJECTS_DIR/p/$HSID.jsonl"

# An agent spawned by a caller that runs on a plugin directory runs on the same one: the
# caller's --plugin-dir options and the enabledPlugins entries of its --settings travel into
# the agent's launch, and nothing else of those settings.
PLUGARGV='["/opt/x/host","--plugin-dir","/p/pin","--plugin-dir","/p/two","--settings","{\"enabledPlugins\":{\"orchestrator@lounisbou\":false},\"env\":{\"K\":\"v\"}}","--name","Orch: f"]'
plugspawn() { # the caller's words in $1, then the spawn's own options
  local words="$1"; shift
  env CLAUDE_CONFIG_DIR="$HCONF" CLAUDE_CODE_SESSION_ID="$HSID" ORCHESTRATOR_HOST_ARGV="$words" ORCHESTRATOR_DRY_RUN=1 \
    ORCHESTRATOR_STATE_DIR="$WORK/homestate" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_LOGIN_SHELL=/bin/sh \
    ORCHESTRATOR_HOST_CLI=/opt/x/host bash "$AGENT" spawn --dir "$WORK" --title "Agent: plug" --prompt p $(needs_tier "$@") "$@"; }
out=$(plugspawn "$PLUGARGV" 2>&1)
check "an agent's launch carries the caller's plugin directories and its enabledPlugins entries, no other key of its settings" \
  "1|1|1|0" \
  "$(printf '%s' "$out" | grep -c -- "--plugin-dir /p/pin --plugin-dir /p/two ")|$(printf '%s' "$out" | grep -c '"enabledPlugins":{"orchestrator@lounisbou":false}')|$(printf '%s' "$out" | sed -n 's/^launch=//p' | grep -c -- '--settings')|$(printf '%s' "$out" | grep -c '"K":"v"')"
out=$(plugspawn '["/opt/x/host","--settings","{\"enabledPlugins\":{\"x@y\":false}}","--name","Orch: f"]' 2>&1)
check "a caller without a plugin directory gets the launch it always got" "0|0" \
  "$(printf '%s' "$out" | grep -c -- '--plugin-dir')|$(printf '%s' "$out" | grep -c 'enabledPlugins')"
out2=$(plugspawn '[]' 2>/dev/null; echo "exit=$?")
check "a caller whose launch cannot be read gets the launch it always got, said once on stderr, and is never refused" "1|1|0" \
  "$(printf '%s' "$out2" | grep -c '^exit=0$')|$(plugspawn '[]' 2>&1 >/dev/null | grep -c 'cannot be read')|$(printf '%s' "$out2" | grep -c -- '--plugin-dir')"

# A new orchestrator routed to the other plan keeps its caller's plugin directories: the caller's
# launch is read in the caller's own plan, which the routing then replaces.
RTHOME="$WORK/rthome"; mkdir -p "$RTHOME"; printf '/dev/ttys900 /opt/x/claude --name Coord: ops\n' > "$WORK/rt-ps"
out=$(HOME="$RTHOME" ORCHESTRATOR_PS_TABLE="$WORK/rt-ps" plugspawn "$PLUGARGV" --open --title 'Orch: routed' --plan 2 2>&1)
check "an opening routed to the other plan keeps the caller's plugin directories and enabledPlugins" "1|1|1" \
  "$(printf '%s' "$out" | grep -c -- "--plugin-dir /p/pin --plugin-dir /p/two ")|$(printf '%s' "$out" | grep -c '"enabledPlugins":{"orchestrator@lounisbou":false}')|$(printf '%s' "$out" | sed -n 's/^launch=//p' | grep -cF "export CLAUDE_CONFIG_DIR=$RTHOME/.claude-bis &&")"

# The move itself, over the recorder and a terminal standing in for iTerm2.
cat > "$WORK/home_probe.py" <<'PYEOF'
import contextlib, io, os, sys
sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
scenario = sys.argv[2]
calls = []
class FakeIterm(ia.Terminal):
    def identity(self, tty, fresh=False):
        calls.append("identity %s" % tty)
        return ("" , "") if scenario == "notab" else ("OLD-SESSION", "OLD-TAB")
    def create(self, command, title, place, chain, made):
        calls.append("create %s %s %s %s" % (place.at, place.anchor, place.side, title))
        made["session_id"] = "NEW-SESSION"
        if scenario == "tabfail":
            made["error"] = "the app refused"
            return None, ""
        open(os.path.join(sys.argv[3], "attach"), "w").write(command)
        return "/dev/ttys970", "NEW-TAB"
    def close_made(self, made):
        calls.append("close_made %s" % made.get("session_id")); return True
    def prompt_lines(self, tty):
        # A dialog in the box's place; an app that cannot show the screen.
        if scenario == "nobox": return ['Do you want to proceed?', '❯ 1. Yes', '  2. No']
        if scenario == "unreadable": raise ia.Unreachable("the API is not enabled")
        return ['─' * 40, '❯\u00a0' + ("je réponds" if scenario == "typed" else ""), '─' * 40]
ia.ITERM = FakeIterm()
ia.time.sleep = lambda s: None
ia.SPAWN_TIMEOUT = 0
out, err = io.StringIO(), io.StringIO()
code = 0
try:
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        ia.cmd_home(ia.args_from_line('home', ["--session", sys.argv[4], "--name", sys.argv[5], "--prompt", "Go on"]))
except SystemExit as e:
    code = e.code
print("exit=%s" % code)
print("calls=%s" % ",".join(calls))
print("OUT:" + " ".join(out.getvalue().split()))
print("ERR:" + " ".join(err.getvalue().split()))
PYEOF
hprobe() { homecmd "$py" "$WORK/home_probe.py" "$ROOT/skills/iterm-agents/scripts" "$1" "$HR" "$HSID" "${2:-Orch : conv}" 2>&1; }
reset_homerec; printf '/dev/ttys970\n' > "$HR/clients"
res=$(hprobe ok)
NEWS="[-u][-L][orch-abcdef12][-f][@ROOT@/skills/iterm-agents/tmux/home.conf][new-session][-d][-s][home][-n][Orch: conv][-c][@WORK@][/bin/sh -l @WORK@/homestate/prompts/home-Orch--conv-@TIME@.sh]"
check "the move starts the home server with its conf, window 0 named after the orchestrator, then reads window 0's tty and the tab's client, then arms the server to end with its tab, the tab its owner (the hooks elided), and reads that its owner is attached" \
  "0|$NEWS|[-u][-L][orch-abcdef12][display-message][-p][-t][home:0][#{pane_tty}]|[-u][-L][orch-abcdef12][list-clients][-F][#{client_tty}]|[-u][-L][orch-abcdef12][set-option][-s][@home-owners][ /dev/ttys970 ][;][set-hook]…[;][set-option][-s][exit-unattached][on]|[-u][-L][orch-abcdef12][list-clients][-F][#{client_tty}]|[-u][-L][orch-abcdef12][show-options][-sqv][@home-owners]|[-u][-L][orch-abcdef12][list-clients][-F][#{client_tty}]" \
  "$(sfield "$res" exit)|$(hcalls | sed 's/\[;\]\[set-hook\].*\[;\]\[set-option\]/[;][set-hook]…[;][set-option]/' | paste -sd'|' -)"
check "the old tab is read first, the new one is made right of it under the orchestrator's name, and the move says where" \
  "identity /dev/ttys900,create beside /dev/ttys900 right Orch: conv|moved: orch-abcdef12, shown on /dev/ttys970 wait: 120" \
  "$(sfield "$res" calls)|$(sfield "$res" OUT)"
check "window 0 closes the old tab by the id read before the move, and the new tab runs the client of the home server alone" \
  "1|1" \
  "$(grep -c "home-release --tty /dev/ttys900 --session-id OLD-SESSION " "$(ls "$WORK"/homestate/prompts/home-*.sh)")|$(grep -c "exec env -u TMUX -u TMUX_PANE $HR/tmux -u -L orch-abcdef12 attach -t home\$" "$(sed 's/^\/bin\/sh -l //' "$HR/attach")")"
# The move ends the session in its tab: his text in its prompt keeps the session there, nothing made.
reset_homerec; printf '/dev/ttys970\n' > "$HR/clients"
res=$(hprobe typed)
check "a move whose tab's prompt holds his text stays: no server, no tab, the old tab read alone" \
  "0|identity /dev/ttys900|OUT:stay: the prompt on /dev/ttys900 holds text, so the move, which ends the session there, would destroy what the operator typed and has not sent|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(printf '%s\n' "$res" | grep '^OUT:')|$(hcalls | grep -c 'new-session')"
# A screen with no prompt box (a dialog), or one that cannot be read, is not known empty: it stays too.
reset_homerec; printf '/dev/ttys970\n' > "$HR/clients"
res=$(hprobe nobox)
check "a move whose tab shows no prompt box stays: no server, no tab" \
  "0|identity /dev/ttys900|OUT:stay: the prompt on /dev/ttys900 shows no prompt box, so the move, which ends the session there, would destroy what the operator typed and has not sent|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(printf '%s\n' "$res" | grep '^OUT:')|$(hcalls | grep -c 'new-session')"
reset_homerec; printf '/dev/ttys970\n' > "$HR/clients"
res=$(hprobe unreadable)
check "a move whose tab's prompt cannot be read stays, the reason said: no server, no tab" \
  "0|identity /dev/ttys900|OUT:stay: the prompt on /dev/ttys900 cannot be read (the API is not enabled), so the move, which ends the session there, would destroy what the operator typed and has not sent|0" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(printf '%s\n' "$res" | grep '^OUT:')|$(hcalls | grep -c 'new-session')"
check "the server's environment is the operator's, without the caller's session or nesting marks" "none" \
  "$(homecmd env CLAUDECODE=1 ITERM_SESSION_ID=w0t0p0:X "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
e = ia.home_env()
print(','.join(k for k in ('CLAUDECODE', 'ITERM_SESSION_ID', 'ORCHESTRATOR_HOST_ARGV', 'ORCHESTRATOR_SELF_TTY') if k in e) or 'none')")"

# A second account (CLAUDE_CONFIG_DIR) is the session's own: the server is started with it, so the
# resume in window 0 and every window an agent is spawned in read the same account. The plan is
# read on the session's own process: the suite's stand-in gives it the account the session runs on.
reset_homerec; printf '/dev/ttys970\n' > "$HR/clients"
res=$(ORCHESTRATOR_HOST_ENV="[\"CLAUDE_CONFIG_DIR=$HCONF\"]" hprobe ok)
check "the home server is started with the session's CLAUDE_CONFIG_DIR" "$HCONF" "$(sort -u "$HR/configdir")"
reset_homerec
res=$(hprobe ok)
check "a tab that shows no client of the server is closed, the server ended, and the session stays" \
  "1|close_made NEW-SESSION|1|1" \
  "$(sfield "$res" exit)|$(sfield "$res" calls | tr ',' '\n' | grep close_made)|$(hcalls | grep -c '\[kill-server\]')|$(sfield "$res" ERR | grep -c 'shows no client of the home server orch-abcdef12')"
reset_homerec
res=$(hprobe tabfail)
check "a tab the app fails to make ends the server too" "1|1|1" \
  "$(sfield "$res" exit)|$(hcalls | grep -c '\[kill-server\]')|$(sfield "$res" ERR | grep -c 'the tab for the home server orch-abcdef12 failed: the app refused')"
reset_homerec; printf 'server busy\n' > "$HR/kill-err"
res=$(hprobe tabfail)
check "a kill-server that fails is reported: the server was NOT ended, and the message names its socket" "1|1|0" \
  "$(sfield "$res" exit)|$(sfield "$res" ERR | grep -c "the server was NOT ended: end it with $HR/tmux -L orch-abcdef12 kill-server")|$(sfield "$res" ERR | grep -c 'the server was ended')"
reset_homerec; printf 'server busy\n' > "$HR/kill-err"
res=$(hprobe ok)
check "so is it when the tab shows no client of the server" "1|1" \
  "$(sfield "$res" exit)|$(sfield "$res" ERR | grep -c "shows no client of the home server orch-abcdef12 after 0s; the tab was closed; the server was NOT ended: end it with $HR/tmux -L orch-abcdef12 kill-server")"
reset_homerec
res=$(hprobe notab)
check "a session that is no tab of the app's is not moved, and no server is started" "1|0|1" \
  "$(sfield "$res" exit)|$(hcalls | grep -c 'new-session')|$(sfield "$res" ERR | grep -c 'is not a tab of iTerm2.s (/dev/ttys900), so no tab can take its place; the session stays where it is')"
reset_homerec
printf 'duplicate session: home\n' > "$HR/new-err"
res=$(hprobe ok); rm -f "$HR/new-err"
check "a server already on the socket is refused by tmux, and no tab is made" "1|0|1" \
  "$(sfield "$res" exit)|$(sfield "$res" calls | grep -c create)|$(sfield "$res" ERR | grep -c 'tmux refused to start the home server orch-abcdef12: duplicate session: home')"
reset_homerec
res=$(HARGV_OVERRIDE='["/opt/x/host","--some-new-option","x"]' hprobe ok)
check "a launch with an option the move cannot replay stays where it is, before anything is made" "1|0|1" \
  "$(sfield "$res" exit)|$(hcalls | grep -c 'new-session')|$(sfield "$res" ERR | grep -c 'started with --some-new-option, an option the move does not know how to replay; the session stays')"
reset_homerec
res=$(HARGV_OVERRIDE='["/opt/x/host","-p","x"]' hprobe ok)
check "a printing session is never moved" "1|0" "$(sfield "$res" exit)|$(hcalls | grep -c 'new-session')"

# ORCHESTRATOR_HOME_NO_TAB is a test's: left in a shell it would end the old session and run the
# orchestrator in a server no tab shows. Without the test marker it is ignored, with one line.
reset_homerec; printf '/dev/ttys970\n' > "$HR/clients"
res=$(ORCHESTRATOR_HOME_NO_TAB=1 hprobe ok)
check "the no-tab variable without the test marker is ignored: a tab is made and shows the server, one line says so" \
  "0|create beside /dev/ttys900 right Orch: conv|moved: orch-abcdef12, shown on /dev/ttys970 wait: 120|1" \
  "$(sfield "$res" exit)|$(sfield "$res" calls | tr ',' '\n' | grep create)|$(sfield "$res" OUT)|$(sfield "$res" ERR | grep -o 'ORCHESTRATOR_HOME_NO_TAB is ignored' | wc -l | tr -d ' ')"
reset_homerec
res=$(ORCHESTRATOR_HOME_NO_TAB=1 ORCHESTRATOR_TEST_RUN=1 hprobe ok)
check "and with the marker the move makes the server and no tab" "0|0|moved: orch-abcdef12 (no tab: attach with $HR/tmux -L orch-abcdef12 attach) wait: 120" \
  "$(sfield "$res" exit)|$(sfield "$res" calls | tr ',' '\n' | grep -c create)|$(sfield "$res" OUT)"

# Window 0 runs the resume and does not exec it: the old tab is released by a watcher once the
# resumed host is proved, and a resume that fails leaves both tabs and says how to resume by
# hand. The launch is run for real, over a host and a launcher that are stand-ins.
RUNL="$WORK/runlaunch"; rm -rf "$RUNL"; mkdir -p "$RUNL"
printf '#!/bin/sh\necho "$@" >> "%s/host-args"\n[ "${STUB_RC:-0}" -eq 0 ] && : > "%s/host-ran"\nexit "${STUB_RC:-0}"\n' "$RUNL" "$RUNL" > "$RUNL/host"
printf '#!/bin/sh\ni=0\nwhile [ ! -f "%s/host-ran" ] && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done\n[ -f "%s/host-ran" ] && echo "$@" >> "%s/released"\nexit 0\n' "$RUNL" "$RUNL" "$RUNL" > "$RUNL/launcher"
chmod +x "$RUNL/host" "$RUNL/launcher"
reset_homerec
out=$(homecmd env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_HOST_CLI="$RUNL/host" bash "$AGENT" home --session "$HSID" --name "Orch: conv" --prompt "Go on" 2>&1)
sfield "$out" home_launch | sed "s#kill -0 $$ #kill -0 999999999 #; s#$ROOT/skills/iterm-agents/scripts/iterm-agent.sh#$RUNL/launcher#g" > "$RUNL/launch.sh"
mkdir -p "$WORK/homestate"
(cd "$RUNL" && STUB_RC=1 SHELL=/bin/echo sh "$RUNL/launch.sh" > "$RUNL/failed.out" 2>&1); sleep 1
check "a resume that fails leaves the old tab: the release is not run, the pane says what failed and how to resume by hand, and stays open" \
  "0|1|1|1" \
  "$([ -f "$RUNL/released" ] && echo 1 || echo 0)|$(grep -c "^the resume of session $HSID failed (exit 1); resume it by hand: cd $WORK && $RUNL/host .*--resume $HSID" "$RUNL/failed.out")|$(grep -c -- '^-l$' "$RUNL/failed.out")|$(wc -l < "$RUNL/host-args" | tr -d ' ')"
rm -f "$RUNL/released" "$RUNL/host-ran"
(cd "$RUNL" && STUB_RC=0 sh "$RUNL/launch.sh" > "$RUNL/ran.out" 2>&1); sleep 1
check "a resume that runs triggers the release, with the old tab's id, the pane's tty and the resumed session" "1" \
  "$(grep -c -- "^home-release --tty /dev/ttys900 --session-id <old-tab-session-id> --pane-tty .* --resumed $HSID\$" "$RUNL/released" 2>/dev/null)"

# A session that does not end in its old place within the wait: window 0 asks the launcher to close
# its server and tab (with the wait shortened to a second and the pause after it to none), then
# its pane ends; nothing is resumed and no old tab is released.
out=$(homecmd env ORCHESTRATOR_HOME_WAIT=1 ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_HOST_CLI="$RUNL/host" bash "$AGENT" home --session "$HSID" --name "Orch: conv" --prompt "Go on" 2>&1)
printf '#!/bin/sh\necho "$@" >> "%s/abandoned"\nexit 0\n' "$RUNL" > "$RUNL/launcher-abandon"; chmod +x "$RUNL/launcher-abandon"
sfield "$out" home_launch | sed "s#$ROOT/skills/iterm-agents/scripts/iterm-agent.sh#$RUNL/launcher-abandon#g; s#sleep 10;#sleep 0;#" > "$RUNL/launch-wait.sh"
rm -f "$RUNL/abandoned" "$RUNL/released" "$RUNL/host-args"
(cd "$RUNL" && sh "$RUNL/launch-wait.sh" > "$RUNL/waited.out" 2>&1); wait_exit=$?
check "an old session that does not end in the wait: window 0 says so, has the launcher close its server, resumes nothing and releases no tab" \
  "1|1|home-release --abandon orch-abcdef12|0|0" \
  "$wait_exit|$(grep -c 'the session did not end in its old place' "$RUNL/waited.out")|$(cat "$RUNL/abandoned" 2>/dev/null)|$([ -f "$RUNL/released" ] && echo 1 || echo 0)|$([ -f "$RUNL/host-args" ] && echo 1 || echo 0)"

# The abandon itself, over the recorder and a terminal of the probe's own: the clients of the
# server are read before it ends, the server is ended, and the tab that showed it is closed.
cat > "$WORK/abandon_probe.py" <<'PYEOF'
import contextlib, io, sys
sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
socket = sys.argv[2]
scenario = sys.argv[3] if len(sys.argv) > 3 else "ok"
calls = []
class FakeIterm(ia.Terminal):
    def find(self, tty): calls.append("find %s" % tty); return True
    def close(self, tty, expect):
        calls.append("close %s" % tty)
        if scenario == "vanished": sys.exit("no session on %s" % tty)
        return "NEW-SESSION"
ia.ITERM = FakeIterm()
ia.time.sleep = lambda s: None
out, err = io.StringIO(), io.StringIO()
code = 0
try:
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        ia.cmd_home_release(ia.args_from_line('home-release', ["--abandon", socket]))
except SystemExit as e:
    code = e.code
print("exit=%s" % code)
print("calls=%s" % ",".join(calls))
print("OUT:" + " ".join(out.getvalue().split()))
print("ERR:" + " ".join(err.getvalue().split()))
PYEOF
aprobe() { homecmd "$py" "$WORK/abandon_probe.py" "$ROOT/skills/iterm-agents/scripts" "$1" "${2:-ok}" 2>&1; }
reset_homerec; printf '/dev/ttys970\n' > "$HR/clients"
res=$(aprobe orch-abcdef12)
check "an abandoned move ends the home server and closes the tab that showed it" "0|find /dev/ttys970,close /dev/ttys970|1|1" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(hcalls | grep -c '\[kill-server\]')|$(sfield "$res" OUT | grep -c 'the server orch-abcdef12 was ended and 1 tab(s) closed')"
reset_homerec; printf '/dev/ttys970\n' > "$HR/clients"
res=$(aprobe orch-abcdef12 vanished)
check "a tab that cannot be closed is said, counted as not closed, and does not stop the abandon" "0|1|1" \
  "$(sfield "$res" exit)|$(sfield "$res" ERR | grep -c 'the tab on /dev/ttys970 could not be closed: close it by hand')|$(sfield "$res" OUT | grep -c 'and 0 tab(s) closed')"
reset_homerec; printf '/dev/ttys970\n' > "$HR/clients"; printf 'server busy\n' > "$HR/kill-err"
res=$(aprobe orch-abcdef12)
check "a server that is not ended is said, with the command that ends it, and the tab is still closed" "1|close /dev/ttys970|1" \
  "$(sfield "$res" exit)|$(sfield "$res" calls | tr ',' '\n' | grep close)|$(sfield "$res" ERR | grep -c "the home server orch-abcdef12 was NOT ended: end it with $HR/tmux -L orch-abcdef12 kill-server")"
reset_homerec
res=$(aprobe not-a-home)
check "a socket that is no home server's is refused, and nothing is ended" "1|0" \
  "$(sfield "$res" exit)|$(hcalls | grep -c '\[kill-server\]')"

# The release's own guards, over a terminal of the probe's own: the proof first, then the tab.
cat > "$WORK/release_probe.py" <<'PYEOF'
import asyncio, contextlib, io, os, sys
sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
scenario, resumed = sys.argv[2], sys.argv[3]
calls = []
class Sess:
    def __init__(self, sid): self.session_id = sid
    async def async_close(self, force=False): calls.append("close")
class Iterm2:
    @staticmethod
    async def async_get_app(connection): return None
async def fake_find_tab(app, tty):
    if scenario == "gone": return None, None, None
    return None, None, Sess("OTHER-SESSION" if scenario == "other" else "OLD-SESSION")
ia.find_tab = fake_find_tab
ia.run = lambda go: asyncio.run(go(Iterm2, None))
ia.time.sleep = lambda s: None
ia.SPAWN_TIMEOUT = 0
out, err = io.StringIO(), io.StringIO()
code = 0
try:
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        ia.cmd_home_release(ia.args_from_line('home-release', ["--tty", "/dev/ttys900", "--session-id", "OLD-SESSION",
                             "--pane-tty", "/dev/ttys961", "--resumed", resumed]))
except SystemExit as e:
    code = e.code
print("exit=%s" % code)
print("calls=%s" % ",".join(calls))
print("OUT:" + " ".join(out.getvalue().split()))
print("ERR:" + " ".join(err.getvalue().split()))
PYEOF
rprobe() { # <scenario> <resumed session> <ps table content>
  printf '%s' "$3" > "$WORK/release-ps"
  homecmd env ORCHESTRATOR_PS_TABLE="$WORK/release-ps" "$py" "$WORK/release_probe.py" "$ROOT/skills/iterm-agents/scripts" "$1" "$2" 2>&1; }
res=$(rprobe ok "$HSID" "/dev/ttys961 /opt/x/host --resume $HSID
")
check "the old tab is closed once a host runs on window 0's tty" "0|close|home-release: the tab on /dev/ttys900 was closed" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" OUT)"
res=$(rprobe ok "$HSID" "")
check "or once the host's registry has the resumed session alive" "0|close" "$(sfield "$res" exit)|$(sfield "$res" calls)"
res=$(rprobe ok "00000000-0000-4000-8000-000000000000" "")
check "no host on window 0 and no registry entry: the old tab is left open and the release says the resume never showed" "1||1" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -c "the resumed session 00000000-0000-4000-8000-000000000000 never showed on /dev/ttys961 after 0s; the tab on /dev/ttys900 is left open")"
res=$(rprobe ok "$HSID" "/dev/ttys900 /opt/x/host --name Orch: conv
/dev/ttys961 /opt/x/host --resume $HSID
")
check "a host still on the old tab's tty leaves it open" "1||1" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -c 'a host still runs on /dev/ttys900; the tab is left open')"
res=$(rprobe other "$HSID" "/dev/ttys961 /opt/x/host --resume $HSID
")
check "a tab whose session is another's by then is left open" "1||1" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" ERR | grep -c 'the tab on /dev/ttys900 is no longer the one the move left (OLD-SESSION); it is left open')"
res=$(rprobe gone "$HSID" "/dev/ttys961 /opt/x/host --resume $HSID
")
check "a tab already closed is said so, and nothing is closed twice" "0||home-release: the tab on /dev/ttys900 was already closed" \
  "$(sfield "$res" exit)|$(sfield "$res" calls)|$(sfield "$res" OUT)"

# Never for anyone but an orchestrator, never twice.
for who in "Coord: c" "Audit: a" "Agent: x"; do
  reset_homerec
  res=$(hprobe ok "$who")
  check "a session named '$who' stays where it is, and tmux is never asked" "0|1|" \
    "$(sfield "$res" exit)|$(sfield "$res" OUT | grep -c '^stay: only an orchestrator moves into a home session')|$(hcalls)"
done
reset_homerec; printf '1\n' > "$HR/mark"
res=$(HTMUX=/private/tmp/tmux-501/orch-x,1,0 hprobe ok)
check "an orchestrator already in a home session stays, asking only for the mark" \
  "0|stay: this session already runs in a home session|[-u][show][-qv][-t][%0][@orchestrator-home]" \
  "$(sfield "$res" exit)|$(sfield "$res" OUT)|$(hcalls)"
reset_homerec; printf '0\n' > "$HR/mark"
res=$(HTMUX=/private/tmp/tmux-501/mine,1,0 hprobe ok)
check "an orchestrator in a tmux session the operator made by hand moves" "1" \
  "$(hcalls | grep -c '\[new-session\]')"

# After a deploy: a successor whose home server was started from another deploy's conf stays in it
# whatever that conf is: no server is made, no tab opened, so no agent is ever moved out of its
# orchestrator's tab.
cat > "$WORK/redeploy_probe.py" <<'PYEOF'
import contextlib, io, sys
sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
calls = []
class FakeIterm(ia.Terminal):
    def identity(self, tty, fresh=False):
        calls.append("identity %s" % tty); return ("OLD-SESSION", "OLD-TAB")
    def create(self, command, title, place, chain, made):
        calls.append("create %s" % title); return "/dev/ttys970", "NEW-TAB"
ia.ITERM = FakeIterm()
# The server's own `-f`, read on its process, names another deploy's conf (ignored once `home` no
# longer reads it, and the reason a `home` that still did would move).
ia.server_conf = lambda: "/cfg/deploys/lounisbou/0ld/plugins/orchestrator/skills/iterm-agents/tmux/home.conf"
ia.start_home_follow = lambda *a: calls.append("follow")
out = io.StringIO()
code = 0
try:
    with contextlib.redirect_stdout(out):
        ia.cmd_home(ia.args_from_line('home', ["--session", sys.argv[2], "--prompt", "Go on"]))
except SystemExit as e:
    code = e.code
print("exit=%s" % code)
print("calls=%s" % ",".join(calls))
print("OUT:" + " ".join(out.getvalue().split()))
PYEOF
printf '/dev/ttys900 999991 /opt/x/host --resume x --name Orch: conv\n' > "$WORK/redeploy-ps"
reset_homerec; printf '1\n' > "$HR/mark"
res=$(HTMUX=/private/tmp/tmux-501/orch-oldserv,1,0 homecmd env ORCHESTRATOR_PS_TABLE="$WORK/redeploy-ps" \
  "$py" "$WORK/redeploy_probe.py" "$ROOT/skills/iterm-agents/scripts" "$HSID" 2>&1)
check "an orchestrator in a home server of another deploy stays in it: no server, no tab, no follower" \
  "0|stay: this session already runs in a home session||0" \
  "$(sfield "$res" exit)|$(sfield "$res" OUT)|$(sfield "$res" calls)|$(hcalls | grep -c '\[new-session\]')"

echo
[ -n "$failed" ] && printf '%s' "$failed"
[ "$skipped" -gt 0 ] && printf '%d skipped, each with its reason above\n' "$skipped"
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
