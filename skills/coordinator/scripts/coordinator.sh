#!/bin/bash
# coordinator.sh - the coordinator's address, and the claims orchestrations make before they dispatch.
#
#   coordinator.sh register --name "<name [ref]>" --tty /dev/ttysNNN   prints "registered <name>"
#   coordinator.sh clear                                              removes the record; none is no error
#   coordinator.sh lookup                                             the name while its session runs, else nothing
#   coordinator.sh declare --orchestrator "<name [ref]>" --tty /dev/ttysNNN --repo <abs path>
#                          [--branch <b>] [--pr <n>] [--checkout <abs path>] [--heavy <what>]
#                                                                     prints the declaration's id, c<N>
#   coordinator.sh release <id>                                       closes an open declaration
#   coordinator.sh conflicts <id>                                     overlaps, busy checkouts, stale claims,
#                                                                     heavy runs; exit 1 on an overlap or a busy checkout
#
# State: <state>/coordinator.json {"name","tty","started"}, and <state>/claims.jsonl, one
# declaration per line {"id","orchestrator","tty","repo","branch","pr","checkout","heavy",
# "opened","released"}; <state> is ORCHESTRATOR_STATE_DIR, else the plugin's directory under
# CLAUDE_CONFIG_DIR, else under ~/.claude, the launcher's own resolution. Writes to either
# file go through the lock directory <state>/coordinator.lock, waited for five seconds at
# most, then refused with the lock's path and its holder's pid; a lock is never broken
# automatically. No value holds a tab or a newline, and an existing path is stored resolved.
#
# Liveness: a session is alive when `iterm-agent.sh verify --tty <tty>` finds the host CLI
# on its tty; COORDINATOR_VERIFY names another command to run in its place, called as
# `<command> --tty <tty>` and read the same way, exit 0 alive; exit 1 with nothing on stderr
# is its « not running », and any other answer is an error, never « dead ». This script
# never parses the host's name itself. The busy check sees only the checkouts under the
# workspace root, as `workspace.sh list` does.
#
# Exit codes: 0; 1 on a refusal or a usage error, and from `conflicts` on an overlap or a
# busy checkout; 2 from `conflicts` when the id names no open declaration, so a mistyped id
# is read neither as « go » nor as « wait », and when the answer cannot be known: a ledger
# line that does not read, a liveness check that fails, a workspace list that fails.
#
# Why it exists: a coordinator is found through a file and its liveness through the process
# table, never through the file alone: a record left by a session that died would otherwise
# keep every orchestrator writing to nobody, and nothing downstream checks it again. The
# claims ledger and the overlap check are what let the coordinator answer « go » or « wait
# for X » on the facts, and they must hold when two orchestrations declare at the same
# instant; a check made in prose would be made from memory, and that is where two sessions
# end up pushing to the same branch.

set -uo pipefail

# fail_code: what die exits with; `conflicts` raises it to 2 once its arguments are read,
# so an answer it cannot know is never taken for « go » or « wait ».
fail_code=1
die() { echo "coordinator: $*" >&2; exit "$fail_code"; }
say() { echo "coordinator: $*" >&2; }
command -v jq >/dev/null 2>&1 || die "jq is required"

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STATE="${ORCHESTRATOR_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-orchestrator}"
RECORD="$STATE/coordinator.json"
CLAIMS="$STATE/claims.jsonl"
LOCK="$STATE/coordinator.lock"
LAUNCHER="$here/../../iterm-agents/scripts/iterm-agent.sh"
WORKSPACE="$here/../../orchestrator/scripts/workspace.sh"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# alive <tty>: the host CLI runs on that tty, read from the process table by the launcher.
# Only the check's own « not running », exit 1 and silent, reads as dead; a check that
# cannot run or fails dies, since a live session read as dead has its claim and its record
# taken. Its input is closed: it must not read the declarations `conflicts` loops over.
alive() {
    local err rc
    if [ -n "${COORDINATOR_VERIFY:-}" ]; then
        [ -f "$COORDINATOR_VERIFY" ] && [ -x "$COORDINATOR_VERIFY" ] \
            || die "the liveness command $COORDINATOR_VERIFY is missing or not executable"
        err=$("$COORDINATOR_VERIFY" --tty "$1" 2>&1 >/dev/null </dev/null)
    else
        [ -f "$LAUNCHER" ] || die "the launcher $LAUNCHER is missing"
        err=$(bash "$LAUNCHER" verify --tty "$1" 2>&1 >/dev/null </dev/null)
    fi
    rc=$?
    [ "$rc" = 0 ] && return 0
    [ "$rc" = 1 ] && [ -z "$err" ] && return 1
    die "the liveness check failed on $1: ${err:-exit $rc}"
}

# lock <operation>: take the lock directory or refuse after five seconds. mkdir is the one
# test-and-set the shell has; the lock is removed on exit only by the process that took it,
# so a refused caller never frees a lock another one holds. The holder writes its pid and
# its operation into the lock, so a refusal names who holds it and whether it still runs;
# a lock left by a dead holder is named for removal, never broken here, since a holder
# read as dead by mistake would then share the ledger with the next caller.
held=0
unlock() { [ "$held" = 1 ] && { rm -f "$LOCK/holder"; rmdir "$LOCK" 2>/dev/null; }; held=0; }
trap unlock EXIT
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
# never sees half of it. Called in the main shell, so its refusal is the script's exit.
write_atomic() {
    [ ! -d "$1" ] || die "cannot write $1: it is a directory"
    local tmp; tmp=$(mktemp "$STATE/.coordinator-XXXXXX") || die "cannot write into $STATE"
    printf '%s\n' "$2" > "$tmp" && mv "$tmp" "$1" || { rm -f "$tmp"; die "cannot write $1"; }
}

# abs_path <option> <value>: an absolute path without a trailing slash, so one checkout is
# one string whoever declares it; an existing directory is resolved, so a checkout reached
# through a symbolic link is the checkout it leads to.
abs_path() {
    case "$2" in /*) ;; *) die "$1 must be an absolute path: $2" ;; esac
    local p="$2"
    while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done
    if [ -d "$p" ]; then p=$(cd "$p" 2>/dev/null && pwd -P) || die "$1 cannot be resolved: $2"; fi
    printf '%s' "$p"
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
        local old_name old_tty
        old_name=$(jq -r '.name // ""' "$RECORD" 2>/dev/null)
        old_tty=$(jq -r '.tty // ""' "$RECORD" 2>/dev/null)
        if [ -n "$old_tty" ] && alive "$old_tty"; then
            die "refused: a live coordinator is recorded: $old_name on $old_tty"
        fi
        say "replaced a stale record: ${old_name:-an unreadable record}"
    fi
    local record
    record=$(jq -n --arg n "$name" --arg t "$tty" --arg s "$(now)" '{name:$n, tty:$t, started:$s}') \
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
    local name tty
    name=$(jq -r '.name // ""' "$RECORD" 2>/dev/null)
    tty=$(jq -r '.tty // ""' "$RECORD" 2>/dev/null)
    if [ -n "$name" ] && [ -n "$tty" ] && alive "$tty"; then
        echo "$name"
    else
        say "stale record: ${name:-an unreadable record} on ${tty:-no tty}"
    fi
}

cmd_declare() {
    local orch="" tty="" repo="" branch="" pr="" checkout="" heavy=""
    while [ $# -gt 0 ]; do
        [ $# -ge 2 ] || die "declare: $1 needs a value"
        case "$2" in *$'\t'* | *$'\n'*) die "declare: $1 must not hold a tab or a newline" ;; esac
        case "$1" in
            --orchestrator) orch="$2" ;;
            --tty) tty="$2" ;;
            --repo) repo=$(abs_path "declare: --repo" "$2") || exit 1 ;;
            --branch) branch="$2" ;;
            --pr) pr="$2" ;;
            --checkout) checkout=$(abs_path "declare: --checkout" "$2") || exit 1 ;;
            --heavy) heavy="$2" ;;
            *) die "declare: unknown option $1" ;;
        esac
        shift 2
    done
    [ -n "$orch" ] && [ -n "$tty" ] && [ -n "$repo" ] \
        || die "declare: --orchestrator, --tty and --repo are required"
    [ -z "$pr" ] || printf '%s' "$pr" | grep -qE '^[0-9]+$' || die "declare: --pr must be a number: $pr"
    lock declaration
    # The next id is one above the highest in the file, never a count of its lines: a
    # ledger pruned by hand would otherwise hand out an id already given.
    local n=1
    if [ -s "$CLAIMS" ]; then
        n=$(jq -s '[.[].id | ltrimstr("c") | tonumber] | (max // 0) + 1' "$CLAIMS") \
            || die "declare: cannot read $CLAIMS"
    fi
    jq -nc --arg id "c$n" --arg o "$orch" --arg t "$tty" --arg r "$repo" --arg b "$branch" \
        --arg p "$pr" --arg c "$checkout" --arg h "$heavy" --arg at "$(now)" '
        def opt: if . == "" then null else . end;
        {id:$id, orchestrator:$o, tty:$t, repo:$r, branch:($b|opt),
         pr:(if $p == "" then null else ($p|tonumber) end), checkout:($c|opt), heavy:($h|opt),
         opened:$at, released:null}' >> "$CLAIMS" || die "declare: cannot append to $CLAIMS"
    echo "c$n"
}

# open_claim <id>: the open declaration with that id, one line of JSON, or nothing; status 1
# when a line of the ledger does not read, since the id may sit after it.
open_claim() {
    [ -f "$CLAIMS" ] || return 0
    local found
    found=$(jq -c --arg i "$1" 'select(.id == $i and .released == null)' "$CLAIMS" 2>/dev/null) || return 1
    printf '%s' "$found"
}

cmd_release() {
    local id="${1:-}"
    [ -n "$id" ] && [ $# -eq 1 ] || die "release: usage: release <id>"
    lock release
    # Only an open declaration is closed: releasing one twice would move its closing time,
    # and the waiters it woke were woken by the first.
    local mine ledger
    mine=$(open_claim "$id") || die "release: cannot read $CLAIMS"
    [ -n "$mine" ] || die "no open declaration $id"
    # The whole ledger is read before it is rewritten: a line that does not read would
    # otherwise end the rewrite there and drop every line after it.
    ledger=$(jq -c --arg i "$id" --arg at "$(now)" \
        'if .id == $i and .released == null then .released = $at else . end' "$CLAIMS" 2>/dev/null) \
        || die "release: cannot read $CLAIMS"
    write_atomic "$CLAIMS" "$ledger"
}

cmd_conflicts() {
    local id="${1:-}"
    [ -n "$id" ] && [ $# -eq 1 ] || die "conflicts: usage: conflicts <id>"
    fail_code=2
    local mine others
    mine=$(open_claim "$id") || die "cannot read the ledger $CLAIMS"
    [ -n "$mine" ] || { say "no open declaration $id"; exit 2; }
    # A released declaration is never an overlap, and a declaration never overlaps itself.
    # The fields are joined raw: no value holds a tab, and a name is printed as declared.
    others=$(jq -r --argjson m "$mine" '
    select(.released == null and .id != $m.id)
    | [ .id, .tty, .orchestrator,
        ([ (if .branch != null and .repo == $m.repo and .branch == $m.branch then "branch" else empty end),
           (if .checkout != null and .checkout == $m.checkout then "checkout" else empty end),
           (if .pr != null and .repo == $m.repo and .pr == $m.pr then "pr" else empty end),
           (if .heavy != null and $m.heavy != null then "heavy" else empty end) ] | join(" ")) ]
    | join("\t")' "$CLAIMS" 2>/dev/null) || die "cannot read the ledger $CLAIMS"
    local found=0 oid otty oorch kind kinds
    # The other open declarations, one per line: id, tty, orchestrator, then the kinds of
    # overlap they share with this one, tab-separated.
    while IFS=$'\t' read -r oid otty oorch kinds; do
        [ -n "$oid" ] || continue
        # A claim whose orchestrator is gone blocks nobody: it is named so the coordinator
        # closes it, never counted as an overlap.
        if ! alive "$otty"; then
            echo "stale $oid $oorch"
            continue
        fi
        for kind in $kinds; do
            echo "overlap $kind $id $oid $oorch"
            found=1
        done
    done <<EOF
$others
EOF

    # The facts, re-read now. A checkout this declaration names, already held by another
    # branch in the workspace list, is busy whatever the ledger says.
    local checkout branch
    checkout=$(jq -r '.checkout // ""' <<< "$mine")
    branch=$(jq -r '.branch // ""' <<< "$mine")
    if [ -n "$checkout" ] && [ -n "$branch" ]; then
        local want path held checkouts
        checkouts=$(bash "$WORKSPACE" list) || die "workspace.sh list failed: the checkout's state is unknown"
        want=$( (cd "$checkout" 2>/dev/null && pwd -P) || printf '%s' "$checkout")
        while IFS='|' read -r path held _; do
            path=$(printf '%s' "$path" | sed 's/[[:space:]]*$//')
            held=$(printf '%s' "$held" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
            [ -n "$path" ] || continue
            [ "$( (cd "$path" 2>/dev/null && pwd -P) || printf '%s' "$path")" = "$want" ] || continue
            if [ "$held" != "$branch" ]; then
                echo "busy checkout $checkout"
                found=1
            fi
        done <<EOF
$checkouts
EOF
    fi

    # The heavy runs the process table shows: the plugin's suite and plugin evaluation
    # runs. Said, never counted as a conflict: the coordinator weighs them itself. The
    # bracketed patterns keep this very pipeline from matching its own command line.
    ps -Ao pid=,command= 2>/dev/null | awk -v self=$$ '
        $1 != self && ($0 ~ /run-tests[.]sh/ || $0 ~ /plugin[ ]eval/) {
            pid = $1; sub(/^[ \t]*[0-9]+[ \t]+/, ""); print "running " pid " " $0
        }'

    [ "$found" = 0 ]
}

cmd="${1:-}"
[ -n "$cmd" ] || die "usage: coordinator.sh {register|clear|lookup|declare|release|conflicts} ... (see header)"
shift
case "$cmd" in
    register) cmd_register "$@" ;;
    clear) cmd_clear "$@" ;;
    lookup) cmd_lookup "$@" ;;
    declare) cmd_declare "$@" ;;
    release) cmd_release "$@" ;;
    conflicts) cmd_conflicts "$@" ;;
    *) die "unknown subcommand: $cmd (expected register, clear, lookup, declare, release or conflicts)" ;;
esac
