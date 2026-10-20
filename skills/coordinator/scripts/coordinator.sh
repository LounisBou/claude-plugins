#!/bin/bash
# coordinator.sh - the coordinator's own record, and what the machine shows now.
#
#   coordinator.sh register --name "<name [ref]>" --tty /dev/ttysNNN   prints "registered <name>"
#   coordinator.sh clear                                              removes the record; none is no error
#   coordinator.sh lookup                                             the name while its session runs, else nothing
#   coordinator.sh facts     the sessions, checkouts and heavy runs of every repository a session
#                            works in, then the collisions among them
#   coordinator.sh owners    each open pull request of those repositories, traced to its orchestrator
#   coordinator.sh sleep --name "Orch : <subject>" --brief <path> --dir <path> --model <id>
#                        [--effort <level>] [--pr "<repository>#<n> <branch>"]... [--checkout <path>]...
#                            records a paused orchestrator as sleeping, once its tab is closed;
#                            prints "sleeping <name>"
#   coordinator.sh sleeping  one line per sleeping orchestrator; nothing when none sleeps
#   coordinator.sh wake-done --name "Orch : <subject>"   removes the record of one woken, its
#                            spawn verified; prints "woken <name>"
#   coordinator.sh drop --name "Orch : <subject>"        abandons one for good: removes its record
#                            and moves its brief into an abandoned/ directory beside it
#   coordinator.sh round     the round's entries still to be ruled: the open ones, then the withdrawn
#   coordinator.sh round-close <id> --answer "<text>"   closes one entry with the answer relayed;
#                            prints "closed <id>"
#
# facts prints, one per line:
#   session <pid> | <tty> | <title> | <orchestrator> | <repository> | <branch> | <directory>
#     (the repository reads « not a git tree » for a directory in none)
#   checkout <path> | <repository> | <branch>
#   heavy <pid> | <directory> | <command>
#   waiting <orchestrator> | operator since <UTC time> | blocks: <what it blocks>
#   waiting <orchestrator> | done since <UTC time>
#     (an orchestrator whose last turn ended on its machine line, read from the wait file the
#     hooks module keeps for its live session; the module also enters that wait in the round once)
#   remote <orchestrator> | on <machine> | updated <UTC time> | context <tokens> (<percent>%) | repository <owner/name or none> | prs <owner/name#n>, ... or none | <wait>
#     (an orchestrator on another machine, its row as the hooks module received it; <wait> is
#     « operator since <UTC time or ?> | blocks: <what it blocks> », « done since <UTC time or ?> »
#     or « working »; a row is kept while updated within 24 hours and no local session names it)
#   collision checkouts | <repository> | <branch> | <path>, <path>...
#   collision sessions | <repository> | <branch> | <pid> <title>, <pid> <title>...
#   collision heavy | <pid>, <pid>...
#   collision pr | <repository>#<n> | <branch> | <orchestrator>, <orchestrator>...
#     (a remote row listing the pull request counts as one more orchestrator on it)
#   unread <source>: <why>     a source not read: the process table, the host's name, lsof,
#                              a pid's directory, a tree git failed on, a brief, the checkouts,
#                              the forge, a remote row that is no JSON row
# sleeping prints, one per sleeping orchestrator, in the order they went to sleep:
#   sleeping <name> | since <UTC time> | <directory> | prs <repository>#<n> <branch>, ... or none
#     | checkouts <path>, ... or none | brief <path> | model <id> | effort <level or default>
# round prints, for each entry whose status is open, then for each answered one (chosen in the
# coordinator's pane and sent to the asking orchestrator), then for each withdrawn one, a line
#   round <id> | <operator or done> | from <sender> | since <UTC time> | blocks: <what it blocks, or -> | <status>
# followed by the question's lines, each indented by four spaces. The entries are read from
# <state>/round/<id>.json, one JSON entry per file, written whole by the hooks module at the end
# of a turn of an orchestrator on this machine (hooks/round.ts); a file that does not parse is
# skipped. Each set is in the round's order: grouped by sender, the groups by their earliest
# wait, each in the order its waits began. An answered entry's lines end on
#     answered from the pane at <UTC time>: <letter> : <choice text>
# and those of an entry its sender withdrew (its later turn ended on another machine line) on
#     withdrawn by the sender at <UTC time>: its later turn waits on something else
# round-close rewrites the entry with status closed and the answer {text, by "coordinator", at},
# in one rename, and refuses an id with no entry.
# drop prints "dropped <name>", then "brief moved to <path>" (or "brief <path> was already
# gone"), then "left untouched: <each pull request and checkout, or none>" — the pull requests,
# their branches and the checkouts are the operator's to close, never this script's.
#
# owners prints one line per open pull request and session found on its branch:
#   pr <repository>#<n> | <branch> | <orchestrator> | session <pid> in <directory>
#   pr <repository>#<n> | <branch> | unknown | session <pid> in <directory> names no orchestrator
#   pr <repository>#<n> | <branch> | unknown | session <pid> in <directory>: brief <path> cannot be read
# or one « unknown » line per pull request where the chain breaks or allows two answers:
#   pr <repository>#<n> | <branch> | unknown | no checkout on <branch>
#   pr <repository>#<n> | <branch> | unknown | no session in <checkout>, <checkout>...
#   pr <repository>#<n> | <branch> | unknown | no session in <checkout>..., beside a session in <checkout>...
#   pr <repository>#<n> | <branch> | unknown | sessions <pid>, <pid> in <directory> name different orchestrators: <o>, <o>
#   pr <repository>#<n> | <branch> | unknown | head branch in a fork, owned by <owner>
# except that an « unknown » pull request a remote row lists is that row's orchestrator, and
# one a sleeping orchestrator's record lists is its:
#   pr <repository>#<n> | <branch> | <orchestrator> | remote on <machine>, updated <UTC time>
#   pr <repository>#<n> | <branch> | <name> | sleeping since <UTC time>
# A remote row's pull request in a repository this machine did not read keeps the branch « - »,
# and says so; one absent from its repository's open list is not printed (it is no longer open):
#   pr <owner/name>#<n> | - | <orchestrator> | remote on <machine>, updated <UTC time>, not read on the forge here
#
# The chain an owner is read along: the pull request's head branch, the checkouts on it, the
# host sessions working there, and the orchestrator each one names — itself when its title
# is `Orch : …`, else the address its brief gives (« orchestrator is the session **`…`** »,
# a relative brief read from the session's directory), else the one its startup prompt
# gives; « unknown » where the chain breaks or allows two answers. A repository is its
# origin's address without scheme, user or `.git`, so a checkout and its source are one
# repository; a detached checkout is on no branch. A session is a host CLI process with a
# terminal; the host's name is ORCHESTRATOR_HOST_CLI, else the launcher's own default.
#
# Sources, each replaceable for the suite: the process table (`ps`, or the file
# COORDINATOR_PS_TABLE, lines `<pid> <ppid> <tty> <command>`), the working directories
# (`lsof`, or COORDINATOR_CWDS, lines `<pid> <path>`), the checkouts (`workspace.sh list`),
# and the open pull requests (`gh pr list` in the repository, or COORDINATOR_FORGE, called
# as `<command> <repository directory>` and printing `<number> <head branch> <head>` lines,
# <head> `same` for a branch of the repository itself, `fork:<owner>` for a fork's), and the
# remote rows (`store/remote` under the config dir: one JSON row per file, written by the hooks
# module as it receives them from orchestrators on other machines; read here, never written).
#
# State: <state>/coordinator.json {"name","tty","started","pid"}; <state> is ORCHESTRATOR_STATE_DIR,
# else the plugin's directory under CLAUDE_CONFIG_DIR, else under ~/.claude, the launcher's
# own resolution. A registration goes through the lock directory <state>/coordinator.lock,
# waited for five seconds at most, then refused with the lock's path and its holder's pid; a
# lock is never broken automatically.
#
# The sleeping orchestrators: <state>/sleeping.json, an array of {"name","brief","dir","model",
# "effort","slept","prs","checkouts"}, written in one rename under the same lock as a
# registration — sleep, wake-done and drop each take it — and kept apart from the
# coordinator's own record, so it outlives a coordinator's succession and its end alike. A
# sleeping orchestrator is the operator's to wake or drop: nothing here acts on its own.
#
# Liveness: a session is alive when `iterm-agent.sh verify --tty <tty> --pid <pid>` finds that
# process as the host CLI on its tty, so another host CLI on a reused tty reads as dead. The
# record's pid is the host CLI's on the tty at registration, read from the « (pid N) » of
# `verify --tty <tty>`; a record with no pid, written before it was kept, is read by its tty
# alone. COORDINATOR_VERIFY names another command to run in its place, called as
# `<command> --tty <tty>` (printing « ... (pid N) » when it runs) or `<command> --tty <tty>
# --pid <pid>` (exit 0 only when that pid runs there), read the same way: exit 0 alive; exit 1
# with nothing on stderr is its « not running », and any other answer is an error, never « dead ».
#
# Exit codes: 0; 1 on a refusal or a usage error, and from `facts` when it prints a
# collision; 2 from `facts` and `owners` when a source could not be read, so an answer that
# cannot be known is never read as « no collision ».
#
# Why it exists: two orchestrations step on each other through what is checked out, what
# runs and which pull request a branch carries, and all of it can be read now. Nobody
# declares anything to the coordinator, so nothing it answers rests on what an orchestrator
# remembered to say, and no orchestrator carries a duty toward it; a reading made in prose
# would be made from memory, and that is where two sessions end up pushing to one branch.

set -uo pipefail

die() { echo "coordinator: $*" >&2; exit 1; }
say() { echo "coordinator: $*" >&2; }
command -v jq >/dev/null 2>&1 || die "jq is required"

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STATE="${ORCHESTRATOR_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-orchestrator}"
RECORD="$STATE/coordinator.json"
# Mirrors REMOTE_STALE_AFTER_MS in hooks/remote-row.ts: a remote row is kept for a day after its
# updated_at, and the module deletes it past that bound.
REMOTE_STALE_AFTER_S=86400
SLEEPING="$STATE/sleeping.json"
LOCK="$STATE/coordinator.lock"
T_ERR=$(mktemp "${TMPDIR:-/tmp}/coordinator-err-XXXXXX") || { echo "coordinator: cannot make a temporary file" >&2; exit 1; }
VERIFIED=""
LAUNCHER="$here/../../iterm-agents/scripts/iterm-agent.sh"
LAUNCHER_PY="$here/../../iterm-agents/scripts/iterm_agent.py"
WORKSPACE="$here/../../orchestrator/scripts/workspace.sh"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# verify <tty> [<pid>]: asks the launcher (or COORDINATOR_VERIFY) whether the host CLI runs on
# that tty, and with a pid whether that very process is it; its stdout goes to $VERIFIED.
# Only the check's own « not running », exit 1 and silent, returns 1; a check that cannot run
# or fails dies, since a live coordinator read as dead has its record taken.
verify() {
    local err rc out args=(--tty "$1")
    [ -z "${2:-}" ] || args+=(--pid "$2")
    if [ -n "${COORDINATOR_VERIFY:-}" ]; then
        [ -f "$COORDINATOR_VERIFY" ] && [ -x "$COORDINATOR_VERIFY" ] \
            || die "the liveness command $COORDINATOR_VERIFY is missing or not executable"
        out=$("$COORDINATOR_VERIFY" "${args[@]}" 2>"$T_ERR" </dev/null)
    else
        [ -f "$LAUNCHER" ] || die "the launcher $LAUNCHER is missing"
        out=$(bash "$LAUNCHER" verify "${args[@]}" 2>"$T_ERR" </dev/null)
    fi
    rc=$?
    err=$(cat "$T_ERR")
    VERIFIED="$out"
    [ "$rc" = 0 ] && return 0
    [ "$rc" = 1 ] && [ -z "$err" ] && return 1
    die "the liveness check failed on $1: ${err:-exit $rc}"
}

# alive <tty> [<pid>]: the host CLI runs on that tty, and when the record named a process,
# that same process does: another host CLI on a reused tty is not the recorded session. A
# record with no pid, written before the pid was kept, is read by its tty alone.
alive() { verify "$1" "${2:-}"; }

# tty_pid <tty>: the pid of the host CLI on that tty, read from the check's « (pid N) »;
# empty when nothing runs there or the check names no pid. A tty that runs a host CLI whose
# check names no pid is said on stderr, in one line, since the record written from it is
# read by its tty alone.
tty_pid() {
    local pid
    verify "$1" || return 0
    pid=$(printf '%s' "$VERIFIED" | sed -n 's/.*(pid \([0-9][0-9]*\)).*/\1/p' | head -1)
    [ -n "$pid" ] || say "no process id found on $1: the record is written without one"
    printf '%s' "$pid"
}

# lock <operation>: take the lock directory or refuse after five seconds. mkdir is the one
# test-and-set the shell has; the lock is removed on exit only by the process that took it,
# so a refused caller never frees a lock another one holds. The holder writes its pid and
# its operation into the lock, so a refusal names who holds it and whether it still runs;
# a lock left by a dead holder is named for removal, never broken here.
held=0
unlock() { [ "$held" = 1 ] && { rm -f "$LOCK/holder"; rmdir "$LOCK" 2>/dev/null; }; held=0; }
trap 'unlock; rm -f "$T_ERR"' EXIT
trap 'exit 1' INT TERM HUP
lock() {
    mkdir -p "$STATE" 2>/dev/null || die "cannot create the state directory $STATE"
    [ -w "$STATE" ] || die "cannot write into the state directory $STATE"
    local tries=0
    until mkdir "$LOCK" 2>/dev/null; do
        [ -d "$LOCK" ] || die "cannot create the lock $LOCK"
        tries=$((tries + 1))
        [ "$tries" -lt 50 ] || die "refused: $(lock_holder): remove $LOCK"
        sleep 0.1
    done
    held=1
    echo "$$ $1" > "$LOCK/holder"
}

# lock_holder: who holds the lock, as far as its holder file says, and nothing guessed.
lock_holder() {
    local pid="" op="" state=dead
    { read -r pid op < "$LOCK/holder"; } 2>/dev/null
    printf '%s' "$pid" | grep -qE '^[0-9]+$' \
        || { printf "the coordinator's lock is held: %s names no holder" "$LOCK"; return; }
    ps -p "$pid" >/dev/null 2>&1 && state=running
    if [ -n "$op" ]; then printf 'a %s holds the lock' "$op"; else printf "the coordinator's lock is held"; fi
    printf ': %s held by pid %s (%s)' "$LOCK" "$pid" "$state"
}

# write_atomic <path> <content>: the content replaces the file in one rename, so a reader
# never sees half of it.
write_atomic() {
    [ ! -d "$1" ] || die "cannot write $1: it is a directory"
    local tmp; tmp=$(mktemp "$STATE/.coordinator-XXXXXX") || die "cannot write into $STATE"
    printf '%s\n' "$2" > "$tmp" && mv "$tmp" "$1" || { rm -f "$tmp"; die "cannot write $1"; }
}

cmd_register() {
    local name="" tty=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --name) name="${2:-}"; shift 2 || die "register: --name needs a value" ;;
            --tty) tty="${2:-}"; shift 2 || die "register: --tty needs a value" ;;
            *) die "register: unknown option $1" ;;
        esac
    done
    [ -n "$name" ] && [ -n "$tty" ] || die "register: usage: register --name \"<name [ref]>\" --tty /dev/ttysNNN"
    lock registration
    if [ -f "$RECORD" ]; then
        local old_name old_tty old_pid
        old_name=$(jq -r '.name // ""' "$RECORD" 2>/dev/null)
        old_tty=$(jq -r '.tty // ""' "$RECORD" 2>/dev/null)
        old_pid=$(jq -r '.pid // ""' "$RECORD" 2>/dev/null)
        if [ -n "$old_tty" ] && alive "$old_tty" "$old_pid"; then
            die "refused: a live coordinator is recorded: $old_name on $old_tty"
        fi
        say "replaced a stale record: ${old_name:-an unreadable record}"
    fi
    local record pid
    pid=$(tty_pid "$tty")
    record=$(jq -n --arg n "$name" --arg t "$tty" --arg s "$(now)" --arg p "$pid" \
        '{name:$n, tty:$t, started:$s} + (if $p == "" then {} else {pid:($p | tonumber)} end)') \
        || die "register: cannot build the record"
    write_atomic "$RECORD" "$record"
    echo "registered $name"
}

cmd_clear() {
    [ $# -eq 0 ] || die "clear: unexpected argument $1"
    rm -f "$RECORD" || die "clear: cannot remove $RECORD"
}

cmd_lookup() {
    [ $# -eq 0 ] || die "lookup: unexpected argument $1"
    [ -f "$RECORD" ] || return 0
    local name tty pid
    name=$(jq -r '.name // ""' "$RECORD" 2>/dev/null)
    tty=$(jq -r '.tty // ""' "$RECORD" 2>/dev/null)
    pid=$(jq -r '.pid // ""' "$RECORD" 2>/dev/null)
    if [ -n "$name" ] && [ -n "$tty" ] && alive "$tty" "$pid"; then
        echo "$name"
    else
        say "stale record: ${name:-an unreadable record} on ${tty:-no tty}"
    fi
}

# --- The sleeping orchestrators. ---------------------------------------------------------

# The launcher's own shape for an orchestrator's title: the name a wake spawns it under, so a
# record the launcher would refuse at the wake is refused here, at the pause.
ORCH_NAME_SHAPE='^Orch : [^ ](.{0,23}[^ ])?$'

# sleeping_read: the record's array on stdout, [] when there is none; an unreadable record
# dies, since a sleeping orchestrator read as absent is one the operator loses.
sleeping_read() {
    [ -e "$SLEEPING" ] || { echo '[]'; return 0; }
    jq -c 'if type == "array" then . else error("not an array") end' "$SLEEPING" 2>/dev/null \
        || die "the sleeping record $SLEEPING cannot be read: remove or repair it"
}

# name_option <subcommand> <args...>: the one --name the subcommand takes.
name_option() {
    local sub="$1" name=""; shift
    while [ $# -gt 0 ]; do
        case "$1" in
            --name) name="${2:-}"; shift 2 || die "$sub: --name needs a value" ;;
            *) die "$sub: unknown option $1" ;;
        esac
    done
    [ -n "$name" ] || die "$sub: usage: $sub --name \"Orch : <subject>\""
    printf '%s' "$name"
}

cmd_sleep() {
    local name="" brief="" dir="" model="" effort="" prs='[]' checkouts='[]'
    while [ $# -gt 0 ]; do
        case "$1" in
            --name) name="${2:-}"; shift 2 || die "sleep: --name needs a value" ;;
            --brief) brief="${2:-}"; shift 2 || die "sleep: --brief needs a value" ;;
            --dir) dir="${2:-}"; shift 2 || die "sleep: --dir needs a value" ;;
            --model) model="${2:-}"; shift 2 || die "sleep: --model needs a value" ;;
            --effort) effort="${2:-}"; shift 2 || die "sleep: --effort needs a value" ;;
            --pr) [ -n "${2:-}" ] || die "sleep: --pr needs a value"
                  prs=$(jq -c --arg v "$2" '. + [$v]' <<< "$prs"); shift 2 ;;
            --checkout) [ -n "${2:-}" ] || die "sleep: --checkout needs a value"
                  checkouts=$(jq -c --arg v "$2" '. + [$v]' <<< "$checkouts"); shift 2 ;;
            *) die "sleep: unknown option $1" ;;
        esac
    done
    [ -n "$name" ] && [ -n "$brief" ] && [ -n "$dir" ] && [ -n "$model" ] \
        || die 'sleep: usage: sleep --name "Orch : <subject>" --brief <path> --dir <path> --model <id> [--effort <level>] [--pr "<repository>#<n> <branch>"]... [--checkout <path>]...'
    printf '%s' "$name" | grep -qE "$ORCH_NAME_SHAPE" && ! printf '%s' "$name" | grep -qE ' \[[0-9A-Za-z]+\]$' \
        || die "sleep: refused: the name reads \"Orch : <subject>\", without its reference, the subject at most 25 characters, got '$name'"
    case "$brief" in /*) ;; *) die "sleep: refused: the brief's path must be absolute, got $brief" ;; esac
    [ -f "$brief" ] && [ -r "$brief" ] || die "sleep: refused: the brief $brief cannot be read: a wake starts on it"
    case "$dir" in /*) ;; *) die "sleep: refused: the directory must be absolute, got $dir" ;; esac
    [ -d "$dir" ] || die "sleep: refused: the directory $dir does not exist: a wake starts in it"
    case "$effort" in ""|low|medium|high|xhigh|max) ;; *) die "sleep: refused: unknown effort $effort (low, medium, high, xhigh or max)" ;; esac
    lock sleep
    local all
    all=$(sleeping_read) || exit 1
    jq -e --arg n "$name" 'any(.[]; .name == $n)' <<< "$all" >/dev/null \
        && die "sleep: refused: $name is already sleeping"
    all=$(jq -c --arg n "$name" --arg b "$brief" --arg d "$dir" --arg m "$model" --arg e "$effort" \
        --arg s "$(now)" --argjson p "$prs" --argjson c "$checkouts" \
        '. + [{name:$n, brief:$b, dir:$d, model:$m, effort:$e, slept:$s, prs:$p, checkouts:$c}]' <<< "$all") \
        || die "sleep: cannot build the record"
    write_atomic "$SLEEPING" "$all"
    echo "sleeping $name"
}

cmd_sleeping() {
    [ $# -eq 0 ] || die "sleeping: unexpected argument $1"
    local all
    all=$(sleeping_read) || exit 1
    jq -r '.[] | "sleeping \(.name) | since \(.slept) | \(.dir) | prs \(if (.prs | length) > 0 then (.prs | join(", ")) else "none" end) | checkouts \(if (.checkouts | length) > 0 then (.checkouts | join(", ")) else "none" end) | brief \(.brief) | model \(.model) | effort \(if .effort == "" then "default" else .effort end)"' <<< "$all"
}

# remove_sleeping <name> <subcommand>: the array without that name, or a refusal when it
# does not sleep. Called under the lock.
remove_sleeping() {
    local all
    all=$(sleeping_read) || exit 1
    jq -e --arg n "$1" 'any(.[]; .name == $n)' <<< "$all" >/dev/null \
        || die "$2: refused: $1 is not sleeping (coordinator.sh sleeping lists who is)"
    jq -c --arg n "$1" 'map(select(.name != $n))' <<< "$all"
}

cmd_wake_done() {
    local name rest
    name=$(name_option wake-done "$@") || exit 1
    lock wake
    rest=$(remove_sleeping "$name" wake-done) || exit 1
    write_atomic "$SLEEPING" "$rest"
    echo "woken $name"
}

cmd_drop() {
    local name all one rest brief dest left
    name=$(name_option drop "$@") || exit 1
    lock drop
    all=$(sleeping_read) || exit 1
    rest=$(remove_sleeping "$name" drop) || exit 1
    one=$(jq -c --arg n "$name" 'first(.[] | select(.name == $n))' <<< "$all")
    brief=$(jq -r '.brief' <<< "$one")
    # The brief is moved, never deleted: a drop typed by a slip loses nothing.
    if [ -f "$brief" ]; then
        dest="$(dirname "$brief")/abandoned/$(date -u +%Y%m%dT%H%M%SZ)-$(basename "$brief")"
        mkdir -p "$(dirname "$dest")" 2>/dev/null && mv "$brief" "$dest" \
            || die "drop: cannot move the brief $brief into $(dirname "$dest"): nothing was dropped"
    fi
    write_atomic "$SLEEPING" "$rest"
    echo "dropped $name"
    if [ -n "${dest:-}" ]; then echo "brief moved to $dest"; else echo "brief $brief was already gone"; fi
    left=$(jq -r '[.prs[], .checkouts[]] | if length > 0 then join(", ") else "none" end' <<< "$one")
    echo "left untouched: $left"
}

# --- The facts. Every table below is tab-separated, one row per line, in $T. -------------

T=""
unread() { printf 'unread %s\n' "$*" >> "$T/unread"; }

# repo_of <directory>: "<toplevel>\t<repository>\t<branch>" of the git tree holding it.
# The repository is the origin's address with its scheme, user and `.git` removed, so the
# same remote reached over two protocols is one repository; no origin, the toplevel.
# Exit 3 when the directory is in no git tree; any other failure of git is said on stderr
# and exits 1, since a tree git could not read is on a branch nobody knows.
repo_of() {
    local top url branch rc
    top=$(LC_ALL=C git -C "$1" rev-parse --show-toplevel 2>"$T/git.err") || {
        grep -q 'not a git repository' "$T/git.err" && return 3
        echo "git failed on $1: $(head -1 "$T/git.err")" >&2; return 1; }
    top=$(cd "$top" 2>/dev/null && pwd -P) || { echo "cannot enter $1" >&2; return 1; }
    branch=$(LC_ALL=C git -C "$top" symbolic-ref --short -q HEAD 2>"$T/git.err"); rc=$?
    case "$rc" in
        0) ;;
        1) branch=HEAD ;;
        *) echo "git failed on $top: $(head -1 "$T/git.err")" >&2; return 1 ;;
    esac
    url=$(LC_ALL=C git -C "$top" remote get-url origin 2>"$T/git.err"); rc=$?
    case "$rc" in
        0) url=$(printf '%s' "$url" | sed -E 's#^[A-Za-z+]+://##; s#^[^@/]*@##; s#^([^/:]+):#\1/#; s#\.git$##; s#/+$##') ;;
        2) url="$top" ;;
        *) echo "git failed on $top: $(head -1 "$T/git.err")" >&2; return 1 ;;
    esac
    printf '%s\t%s\t%s\n' "$top" "$url" "$branch"
}

host_cli() {
    local name="${ORCHESTRATOR_HOST_CLI:-}"
    [ -n "$name" ] || name=$(sed -n 's/^HOST_CLI = os.environ.get("ORCHESTRATOR_HOST_CLI", "\([^"]*\)")$/\1/p' "$LAUNCHER_PY" 2>/dev/null)
    [ -n "$name" ] || die "the host's name is unknown: set ORCHESTRATOR_HOST_CLI"
    basename "$name"
}

# brief_orchestrator <command line> <directory>: sets orch to the orchestrator the session's
# brief names, else the one its startup prompt names, else « unknown » with the reason in
# why. A relative brief is the session's own, read from its directory; a brief that exists
# and cannot be read is unread, never a brief that names nobody.
brief_orchestrator() {
    local brief found
    orch=""; why="names no orchestrator"
    brief=$(printf '%s' "$1" | sed -n 's/.*Read and execute \([^ ]*\).*/\1/p' | sed 's/\.$//')
    case "$brief" in
        ""|/*) ;;
        *) if [ -n "$2" ]; then brief="$2/$brief"; else why="its brief $brief is relative to a directory not read"; brief=""; fi ;;
    esac
    if [ -n "$brief" ] && [ -e "$brief" ]; then
        if [ -f "$brief" ] && [ -r "$brief" ]; then
            found=$(grep -o 'rchestrator is the session \*\*`[^`]*`' "$brief" | head -1 | sed 's/.*`\(.*\)`$/\1/')
            [ -n "$found" ] && { orch="$found"; return; }
        else
            unread "brief $brief: cannot be read"
            why="brief $brief cannot be read"
        fi
    fi
    orch=$(printf '%s' "$1" | sed -n 's/.*[Yy]our orchestrator is \(Orch : [^][]*\[[0-9A-Za-z]*\]\).*/\1/p')
    [ -n "$orch" ] || orch=unknown
}

# read_facts: fills $T with sessions, places (checkouts and session trees), heavy runs and
# pull requests, for the repositories a session works in.
read_facts() {
    T=$(mktemp -d "${TMPDIR:-/tmp}/coordinator-XXXXXX") || die "cannot make a temporary directory"
    trap 'unlock; rm -rf "$T"; rm -f "$T_ERR"' EXIT
    : > "$T/unread"; : > "$T/sessions"; : > "$T/places"; : > "$T/heavy"; : > "$T/prs"; : > "$T/read_repos"
    # With no host name no process is a session, and an empty list reads as « no collision ».
    local hostname
    hostname=$(host_cli 2>"$T/host.err") || { unread "sessions: $(sed 's/^coordinator: //' "$T/host.err" | head -1)"; hostname=""; }

    local table="$T/ps"
    if [ -n "${COORDINATOR_PS_TABLE:-}" ]; then
        cp "$COORDINATOR_PS_TABLE" "$table" 2>/dev/null || { unread "processes: $COORDINATOR_PS_TABLE cannot be read"; : > "$table"; }
    else
        ps -Ao pid=,ppid=,tty=,command= > "$table" 2>/dev/null || { unread "processes: ps failed"; : > "$table"; }
    fi

    # The host sessions: the first word of the command is the host CLI, and a terminal
    # holds it, and it is no evaluation run's. The heavy runs: the plugin's suites and
    # evaluation runs, each counted once at its top process, since a suite's subshells and
    # an evaluation's host process carry its command line too.
    awk -v host="$hostname" '
        function base(x) { sub(/.*\//, "", x); return x }
        { pid = $1; ppid = $2; tty = $3; cmd = $0
          sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]+[^ \t]+[ \t]+/, "", cmd)
          # What runs, past a `timeout <n>` and a shell given a script: a wrapper `sh -c`
          # that only names a suite in its text, or a `pgrep` looking for one, runs none.
          split(cmd, w, /[ \t]+/); i = 1
          if (base(w[i]) == "timeout") i += 2
          if (base(w[i]) ~ /^(ba|z)?sh$/ && w[i + 1] !~ /^-/) i++
          heavy[pid] = (w[i] ~ /(^|\/)(run-tests|e2e)[.]sh$/ || (base(w[i]) == host && w[i + 1] == "plugin" && w[i + 2] == "eval"))
          parent[pid] = ppid; line[pid] = cmd; order[++n] = pid
          first = cmd; sub(/[ \t].*/, "", first); sub(/.*\//, "", first)
          session[pid] = (first == host && tty != "??" && tty != "-"); ttyof[pid] = tty
        }
        END { for (i = 1; i <= n; i++) { p = order[i]
                if (heavy[p] && !heavy[parent[p]]) print "H\t" p "\t" line[p]
                else if (session[p] && !heavy[p]) print "S\t" p "\t" ttyof[p] "\t" line[p] } }' "$table" > "$T/procs"

    # The working directory of every session and heavy run, in one lsof call.
    local pids rc; pids=$(cut -f2 "$T/procs" | paste -sd, -)
    : > "$T/cwds"
    if [ -n "$pids" ]; then
        if [ -n "${COORDINATOR_CWDS:-}" ]; then
            awk '{ p = $1; sub(/^[0-9]+[ \t]+/, ""); print p "\t" $0 }' "$COORDINATOR_CWDS" > "$T/cwds" 2>/dev/null \
                || unread "directories: $COORDINATOR_CWDS cannot be read"
        elif command -v lsof >/dev/null 2>&1; then
            lsof -a -d cwd -p "$pids" -Fpn 2>"$T/lsof.err" | awk '/^p/ { p = substr($0, 2) } /^n/ { print p "\t" substr($0, 2) }' > "$T/cwds"
            rc=$?
            [ "$rc" = 0 ] || unread "directories: lsof failed: $(head -1 "$T/lsof.err" | grep . || echo "exit $rc")"
        else
            unread "directories: lsof is missing"
        fi
    fi

    # A pid with no directory, or a directory git could not read, is on no branch and would
    # drop out of every collision unsaid: each one is an unread line.
    local kind pid tty cmd cwd info top repo branch title orch why
    while IFS=$'\t' read -r kind pid tty cmd; do
        cwd=$(awk -F'\t' -v p="$pid" '$1 == p { print $2; exit }' "$T/cwds")
        if [ "$kind" = H ]; then
            # A heavy row has no tty column: its third field is the command.
            if [ -n "$cwd" ]; then info=$(repo_of "$cwd" 2>/dev/null) && cwd=$(printf '%s' "$info" | cut -f1)
            else unread "directory of heavy run $pid: no working directory read"; fi
            printf '%s\t%s\t%s\n' "$pid" "${cwd:--}" "$tty" >> "$T/heavy"
            continue
        fi
        top="${cwd:--}"; repo=-; branch=-
        if [ -z "$cwd" ]; then
            unread "directory of session $pid: no working directory read"
        else
            info=$(repo_of "$cwd" 2>"$T/repo.err"); rc=$?
            case "$rc" in
                0) IFS=$'\t' read -r top repo branch <<< "$info" ;;
                3) repo="not a git tree" ;;
                *) unread "directory of session $pid: $(head -1 "$T/repo.err")" ;;
            esac
        fi
        title=$(printf '%s' "$cmd" | sed -n 's/.* --name \(.*\)$/\1/p' | sed 's/ --remote-control .*//')
        case "$title" in
            "Orch : "*) orch="$title"; why=- ;;
            *) brief_orchestrator "$cmd" "$cwd" ;;
        esac
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$tty" "${title:--}" "$orch" "$repo" "$branch" "$top" "$why" >> "$T/sessions"
        [ "$branch" != - ] && printf '%s\t%s\t%s\n' "$top" "$repo" "$branch" >> "$T/places"
    done < "$T/procs"
    # The checkouts, of the repositories a session works in only: a checkout left over in
    # a repository nobody works in steps on nobody.
    local listing path
    if listing=$(bash "$WORKSPACE" list 2>"$T/ws.err"); then
        while IFS='|' read -r path _; do
            path=$(printf '%s' "$path" | sed 's/[[:space:]]*$//')
            [ -n "$path" ] || continue
            # The listing may spell a path through a symbolic link (/var for /private/var):
            # read under its real name, as a session's directory is.
            path=$(cd "$path" 2>/dev/null && pwd -P || printf '%s' "$path")
            info=$(repo_of "$path" 2>"$T/repo.err"); rc=$?
            if [ "$rc" = 3 ]; then unread "checkout $path: not a git tree"; continue; fi
            if [ "$rc" != 0 ]; then unread "checkout $path: $(head -1 "$T/repo.err")"; continue; fi
            IFS=$'\t' read -r top repo branch <<< "$info"
            cut -f5 "$T/sessions" | grep -qxF "$repo" || continue
            printf '%s\t%s\t%s\n' "$top" "$repo" "$branch" >> "$T/places"
        done <<< "$listing"
    else
        unread "checkouts: $(head -1 "$T/ws.err")"
    fi
    sort -u "$T/places" -o "$T/places"

    # The open pull requests, once per repository, read in the first tree found for it.
    local seen="" out
    while IFS=$'\t' read -r top repo branch; do
        case " $seen " in *" $repo "*) continue ;; esac
        seen="$seen $repo"
        if [ -n "${COORDINATOR_FORGE:-}" ]; then
            out=$("$COORDINATOR_FORGE" "$top" 2>"$T/forge.err" </dev/null)
        else
            out=$(cd "$top" && gh pr list --state open --limit 200 --json number,headRefName,isCrossRepository,headRepositoryOwner \
                --jq '.[] | "\(.number) \(.headRefName) \(if .isCrossRepository then "fork:\(.headRepositoryOwner.login)" else "same" end)"' \
                2>"$T/forge.err" </dev/null)
        fi
        if [ $? -ne 0 ]; then
            unread "forge $repo: $(head -1 "$T/forge.err")"
            continue
        fi
        printf '%s\n' "$repo" >> "$T/read_repos"
        printf '%s\n' "$out" | awk -v r="$repo" 'NF >= 2 { print r "\t" $1 "\t" $2 "\t" (NF >= 3 ? $3 : "-") }' >> "$T/prs"
    done < "$T/places"
    remote_rows
}

# remote_rows: the rows the hooks module received from orchestrators on other machines, one
# JSON row per file in its remote directory (under the config dir, beside the waits). A file
# name holding `.tmp-` is skipped, and a file that is no JSON row is unread. A row is kept
# while its updated_at is at most 24 hours old (the module's REMOTE_STALE_AFTER_MS) and no
# local session names it as title or orchestrator (local wins, as the module's pane does); a
# stale row is skipped silently, since the module deletes it and this script never does. Each
# kept row is one line of $T/remote; the pull requests it lists go to $T/remote_prs, matched to
# a repository read here by its address without the host, and kept only when that repository's
# open list has them. A pull request in a repository not read here keeps branch « - ».
remote_rows() {
    local store="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-orchestrator/store/remote"
    local now file row name at
    : > "$T/remote"; : > "$T/remote_prs"
    [ -d "$store" ] || return 0
    now=$(date -u +%s)
    { awk -F'\t' '{ print $3; print $4 }' "$T/sessions"; } > "$T/names"
    while IFS= read -r file; do
        case "$(basename "$file")" in *.tmp-*) continue ;; esac
        row=$(jq -r 'if type == "object" and (.name | type == "string") and (.updated_at | type == "string")
            then [.name, (.machine // ""), .updated_at, (.context_tokens // 0), (.context_percent // 0), (.repo // ""),
                  ((.prs // []) | join(" ")), (.waiting // ""), (.blocks // ""), (.waiting_since // ""),
                  ((.updated_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601?) // "")] | @tsv
            else error("not a JSON row") end' "$file" 2>/dev/null) \
            || { unread "remote $file: not a JSON row"; continue; }
        name=$(printf '%s' "$row" | cut -f1)
        at=$(printf '%s' "$row" | cut -f11)
        [ -n "$at" ] || continue
        [ $((now - at)) -le "$REMOTE_STALE_AFTER_S" ] || continue
        grep -qxF -- "$name" "$T/names" && continue
        printf '%s\n' "$row" >> "$T/remote"
    done < <(find "$store" -maxdepth 1 -type f | sort)
    awk -F'\t' '
        function owner_name(a) { sub(/^[^\/]+\//, "", a); return a }
        FILENAME == ARGV[1] { if (!(owner_name($0) in on)) on[owner_name($0)] = $0; next }
        FILENAME == ARGV[2] { open[$1 "\t" $2] = $3; next }
        {   n = split($7, list, " ")
            for (i = 1; i <= n; i++) {
                h = index(list[i], "#"); r = substr(list[i], 1, h - 1); num = substr(list[i], h + 1)
                if (r in on) {
                    if (!((on[r] "\t" num) in open)) continue
                    key = on[r]; branch = open[on[r] "\t" num]
                } else { key = r; branch = "-" }
                print key "\t" num "\t" branch "\t" $1 "\t" $2 "\t" $3
            }
        }' "$T/read_repos" "$T/prs" "$T/remote" > "$T/remote_prs"
}

# remote_lines: one line per kept remote row, after the waiting lines.
remote_lines() {
    awk -F'\t' '{
        since = ($10 == "") ? "?" : $10
        if ($8 == "operator") wait = "operator since " since " | blocks: " $9
        else if ($8 == "done") wait = "done since " since
        else wait = "working"
        repo = ($6 == "") ? "none" : $6
        prs = $7; gsub(/ /, ", ", prs); if (prs == "") prs = "none"
        print "remote " $1 " | on " $2 " | updated " $3 " | context " $4 " (" $5 "%) | repository " repo " | prs " prs " | " wait
    }' "$T/remote"
}

# owners_table: repository, number, branch, orchestrator, evidence — one row per pull
# request and session found on its branch, or one « unknown » row where the chain allows
# two answers: a head in a fork (its branch name is no branch of ours), a checkout on the
# branch with no session beside one with a session, two orchestrators named in one checkout.
owners_table() {
    awk -F'\t' '
        function add(l, x) { return l == "" ? x : l ", " x }
        FILENAME == ARGV[1] { n++; s_pid[n] = $1; s_orch[n] = $4; s_repo[n] = $5; s_branch[n] = $6; s_top[n] = $7; s_why[n] = $8; next }
        FILENAME == ARGV[2] { k = $2 "\t" $3; np[k]++; p_top[k, np[k]] = $1; next }
        { lead = $1 "\t" $2 "\t" $3 "\t"
          if ($4 ~ /^fork:/) { print lead "unknown\thead branch in a fork, owned by " substr($4, 6); next }
          if ($4 != "same") { print lead "unknown\tthe forge gave no head repository"; next }
          k = $1 "\t" $3; busy = ""; idle = ""
          for (j = 1; j <= np[k]; j++) { t = p_top[k, j]; has = 0
              for (i = 1; i <= n; i++) if (s_top[i] == t && s_repo[i] == $1 && s_branch[i] == $3) has = 1
              if (has) busy = add(busy, t); else idle = add(idle, t) }
          if (busy == "") { print lead "unknown\t" (idle == "" ? "no checkout on " $3 : "no session in " idle); next }
          if (idle != "") { print lead "unknown\tno session in " idle ", beside a session in " busy; next }
          for (j = 1; j <= np[k]; j++) { t = p_top[k, j]; pids = ""; orchs = ""; c = 0; split("", seen)
              for (i = 1; i <= n; i++) if (s_top[i] == t && s_repo[i] == $1 && s_branch[i] == $3) {
                  pids = add(pids, s_pid[i]); if (!(s_orch[i] in seen)) { seen[s_orch[i]] = 1; c++; orchs = add(orchs, s_orch[i]) } }
              if (c > 1) { print lead "unknown\tsessions " pids " in " t " name different orchestrators: " orchs; continue }
              for (i = 1; i <= n; i++) if (s_top[i] == t && s_repo[i] == $1 && s_branch[i] == $3) {
                  if (s_orch[i] == "unknown") print lead "unknown\tsession " s_pid[i] " in " t (s_why[i] ~ /^names / ? " " : ": ") s_why[i]
                  else print lead s_orch[i] "\tsession " s_pid[i] " in " t }
          }
        }' "$T/sessions" "$T/places" "$T/prs"
}

# pr_collisions: a pull request of ours whose branch sessions of two orchestrators are on,
# read from the sessions themselves, so an « unknown » owner never hides it. A remote row
# listing a pull request counts as one more orchestrator on it; a pull request of a repository
# not read here has no branch, so only the remote rows count on it. Names are counted once.
pr_collisions() {
    awk -F'\t' '
        FILENAME == ARGV[1] { if ($4 != "unknown") { b = $5 "\t" $6; sb[b, ++ns[b]] = $4 } next }
        FILENAME == ARGV[2] { if ($4 == "same") for (i = 1; i <= ns[$1 "\t" $3]; i++) print $1 "#" $2 "\t" $3 "\t" sb[$1 "\t" $3, i]; next }
        { print $1 "#" $2 "\t" $3 "\t" $4 }' "$T/sessions" "$T/prs" "$T/remote_prs" \
    | sort -u \
    | awk -F'\t' '
        function flush() { if (n > 1) print "collision pr | " cur " | " br " | " list; n = 0; list = "" }
        $1 != cur { flush(); cur = $1; br = $2 }
        { n++; list = (n > 1) ? list ", " $3 : $3 }
        END { flush() }' | sort
}

# remote_pr_lines: the pull requests a remote row lists in a repository not read here, one line
# each: its owner and name, branch « - », the orchestrator and the row's machine and stamp.
remote_pr_lines() {
    awk -F'\t' '$3 == "-" { print "pr " $1 "#" $2 " | - | " $4 " | remote on " $5 ", updated " $6 ", not read on the forge here" }' "$T/remote_prs"
}

# waiting_rows: the orchestrators waiting at the end of their turn, from the hooks module's
# store (its waits directory under the config dir, one JSON wait per orchestrator session,
# written by the module's relay alone), each kept while its pid is in the process table
# read above. Display only: a file unread is no line.
waiting_rows() {
    local store="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-orchestrator/store/waits"
    [ -d "$store" ] || return 0
    find "$store" -type f -exec cat {} + 2>/dev/null \
        | jq -R -r 'fromjson? | select(.waiting == "operator" or .waiting == "done")
            | [(.pid // "" | tostring), (.name // "unnamed"), .waiting, (.waiting_since // "?"), (.blocks // "")] | @tsv' 2>/dev/null \
        | awk -F'\t' 'FILENAME == ARGV[1] { live[$1] = 1; next }
            $1 in live { if ($3 == "operator") print "waiting " $2 " | operator since " $4 " | blocks: " $5
                         else print "waiting " $2 " | done since " $4 }' <(awk '{ print $1 }' "$T/ps") -
}

# --- The round. ----------------------------------------------------------------------------

ROUND="$STATE/round"

# round_entries: every entry file of the round that parses as one entry, one compact JSON per
# line. Each file is read whole and alone, so one that does not parse costs only itself.
round_entries() {
    [ -d "$ROUND" ] || return 0
    local f
    for f in "$ROUND"/*.json; do
        [ -f "$f" ] || continue
        jq -s -c 'select(length == 1) | .[0] | select(type == "object" and (.id | type) == "string"
            and (.from | type) == "string" and (.since | type) == "string" and (.status | type) == "string"
            and (.kind | type) == "string" and (.question | type) == "string")' "$f" 2>/dev/null
    done
}

# live_sessions: the sessions files of the hooks module's store (under the config dir, as
# waiting_rows resolves it), as a JSON array of file names. The module names a file after the
# session id with every character outside A-Za-z0-9._- replaced by an underscore.
live_sessions() {
    local store="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-orchestrator/store/sessions"
    [ -d "$store" ] || { echo '[]'; return 0; }
    find "$store" -type f -exec basename {} \; 2>/dev/null | jq -R -s -c 'split("\n") | map(select(. != ""))'
}

cmd_round() {
    [ $# -eq 0 ] || die "round: unexpected argument $1"
    # An entry whose sender's sessions file is absent keeps its place, and its header says the
    # sender is gone: the session ended with its question still open.
    round_entries | jq -s -r --argjson live "$(live_sessions)" '
        # The round order (hooks/round.ts openEntries): grouped by sender, the groups by their
        # earliest wait, each in the order its waits began.
        def ordered: (sort_by(.since) | reduce .[] as $e ({}; if has($e.from) then . else .[$e.from] = $e.since end)) as $first
            | sort_by([$first[.from], .from, .since, .id]);
        # The sender is gone when its sessions file is absent; an entry naming no session is not judged.
        def gone: .session | if type == "string" and . != "" then gsub("[^A-Za-z0-9._-]"; "_") as $key | $live | any(. == $key) | not else false end;
        # The open entries, then those the operator answered from the pane, then the withdrawn.
        ([("open", "answered", "withdrawn") as $status | map(select(.status == $status)) | ordered] | add)[]
        | (if gone then " | sender gone" else "" end) as $gone
        | "round \(.id) | \(.kind) | from \(.from) | since \(.since) | blocks: \(.blocks // "-") | \(.status)\($gone)",
          (.question | select(. != "") | split("\n")[] | "    " + .),
          (select(.status == "answered") | "    answered from the pane at \(.answer.at // "?"): \(.answer.text // "")"),
          (select(.status == "withdrawn" and .answer.by? == "sender") | "    withdrawn by the sender at \(.answer.at // "?"): its later turn waits on something else")'
}

cmd_round_close() {
    local id="${1:-}" answer="" has_answer=0
    [ -n "$id" ] && shift || die 'round-close: usage: round-close <id> --answer "<text>"'
    while [ $# -gt 0 ]; do
        case "$1" in
            --answer) [ $# -ge 2 ] || die "round-close: --answer needs a value"; answer="$2"; has_answer=1; shift 2 ;;
            *) die "round-close: unknown option $1" ;;
        esac
    done
    [ "$has_answer" = 1 ] || die 'round-close: usage: round-close <id> --answer "<text>"'
    # An id names a file of the round, never a path: the module's ids are sanitised the same way.
    printf '%s' "$id" | grep -qE '^[A-Za-z0-9._-]+$' && [ "$id" != . ] && [ "$id" != .. ] \
        || die "round-close: no entry $id in $ROUND"
    local path="$ROUND/$id.json" closed tmp
    closed=$(jq -c --arg id "$id" --arg text "$answer" --arg at "$(now)" \
        'select(type == "object" and .id == $id) | .status = "closed" | .answer = {text: $text, by: "coordinator", at: $at}' \
        "$path" 2>/dev/null) && [ -n "$closed" ] || die "round-close: no entry $id in $ROUND"
    # As the module writes it: a temporary file beside it, then one rename.
    tmp=$(mktemp "$path.tmp-XXXXXX") || die "round-close: cannot write into $ROUND"
    printf '%s\n' "$closed" > "$tmp" && mv -f "$tmp" "$path" || { rm -f "$tmp"; die "round-close: cannot write $path"; }
    echo "closed $id"
}

finish() {
    cat "$T/unread"
    if [ -s "$T/unread" ]; then exit 2; fi
}

cmd_facts() {
    [ $# -eq 0 ] || die "facts: unexpected argument $1"
    read_facts
    awk -F'\t' '{ print "session " $1 " | " $2 " | " $3 " | " $4 " | " $5 " | " $6 " | " $7 }' "$T/sessions"
    # The checkout lines are the workspace's trees; a session's own clone is on its line.
    awk -F'\t' -v root="$( (cd "${ORCHESTRATOR_WORKSPACES:-$HOME/dev/workspaces}" 2>/dev/null && pwd -P) || true)" \
        'root != "" && index($1, root "/") == 1 { print "checkout " $1 " | " $2 " | " $3 }' "$T/places"
    awk -F'\t' '{ print "heavy " $1 " | " $2 " | " $3 }' "$T/heavy"
    waiting_rows
    remote_lines

    {
        awk -F'\t' '$3 != "HEAD" && $3 != "-" { k = $2 "\t" $3; c[k]++; l[k] = (k in l) ? l[k] ", " $1 : $1 }
            END { for (k in c) if (c[k] > 1) { split(k, a, "\t"); print "collision checkouts | " a[1] " | " a[2] " | " l[k] } }' "$T/places" | sort
        awk -F'\t' '$5 != "-" && $6 != "HEAD" && $6 != "-" { k = $5 "\t" $6; c[k]++; v = $1 " " $3; l[k] = (k in l) ? l[k] ", " v : v }
            END { for (k in c) if (c[k] > 1) { split(k, a, "\t"); print "collision sessions | " a[1] " | " a[2] " | " l[k] } }' "$T/sessions" | sort
        awk -F'\t' '{ n++; l = (n > 1) ? l ", " $1 : $1 } END { if (n > 1) print "collision heavy | " l }' "$T/heavy"
        pr_collisions
    } > "$T/collisions"
    cat "$T/collisions"
    finish
    [ ! -s "$T/collisions" ]
}

cmd_owners() {
    [ $# -eq 0 ] || die "owners: unexpected argument $1"
    read_facts
    # A sleeping orchestrator has no session, so the chain breaks on each of its pull
    # requests: the ones its record lists are its own, never « unknown » and never chased.
    local asleep
    asleep=$(sleeping_read 2>"$T/sleeping.err") || { unread "sleeping: $(sed 's/^coordinator: //' "$T/sleeping.err" | head -1)"; asleep='[]'; }
    jq -r '.[] | .name as $n | .slept as $s | .prs[] | [(split(" ")[0]), $n, $s] | @tsv' <<< "$asleep" > "$T/asleep"
    # A remote row listing an « unknown » pull request names its orchestrator, before a sleeping
    # record would; a pull request the remote rows list in a repository not read here comes last.
    owners_table | awk -F'\t' '
        FILENAME == ARGV[1] { who[$1] = $2; since[$1] = $3; next }
        FILENAME == ARGV[2] { if ($3 != "-") { k = $1 "#" $2; c = ++rc[k]; rl[k, c] = "pr " k " | " $3 " | " $4 " | remote on " $5 ", updated " $6 } next }
        { k = $1 "#" $2
          if ($4 == "unknown" && (k in rc)) { if (!(k in said)) { said[k] = 1; for (j = 1; j <= rc[k]; j++) print rl[k, j] } }
          else if ($4 == "unknown" && (k in who)) { if (!(k in said)) { said[k] = 1; print "pr " k " | " $3 " | " who[k] " | sleeping since " since[k] } }
          else print "pr " k " | " $3 " | " $4 " | " $5 }' "$T/asleep" "$T/remote_prs" -
    remote_pr_lines
    finish
}

cmd="${1:-}"
[ -n "$cmd" ] || die "usage: coordinator.sh {register|clear|lookup|facts|owners|sleep|sleeping|wake-done|drop|round|round-close} ... (see header)"
shift
case "$cmd" in
    register) cmd_register "$@" ;;
    clear) cmd_clear "$@" ;;
    lookup) cmd_lookup "$@" ;;
    facts) cmd_facts "$@" ;;
    owners) cmd_owners "$@" ;;
    sleep) cmd_sleep "$@" ;;
    sleeping) cmd_sleeping "$@" ;;
    wake-done) cmd_wake_done "$@" ;;
    drop) cmd_drop "$@" ;;
    round) cmd_round "$@" ;;
    round-close) cmd_round_close "$@" ;;
    *) die "unknown subcommand: $cmd (expected register, clear, lookup, facts, owners, sleep, sleeping, wake-done, drop, round or round-close)" ;;
esac
