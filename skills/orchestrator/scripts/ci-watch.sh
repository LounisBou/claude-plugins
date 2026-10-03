#!/bin/bash
# ci-watch.sh — the one way to wait on a pull request's checks.
#
#   ci-watch.sh <pr> [--repo <owner/repo>] [--interval <s>]
#
# Meant to be started by the orchestrator with the host's background run (`run_in_background`,
# timeout 7 200 000 ms), once per pull request: a command that exits on the event costs no
# token while it waits, and its exit wakes the session. Nobody watches CI in the foreground
# and nobody loops on `gh pr view` or `gh pr checks` (design, « Waiting on CI »).
#
# What it does: reads the head once; waits, bounded, for checks to be registered on it (a
# push is seen before its checks, and « no checks reported » right then is not a red); runs
# `gh pr checks --watch --fail-fast`, its output in a log file under the state directory,
# never on stdout; reads the pull request once more when the watch returns.
#
# stdout, one line, and the exit code the caller reads without opening the log:
#   ci-watch: green <pr> <head>                         0
#   ci-watch: red <pr> <head> <failing check names>     1
#   ci-watch: no-checks <pr> <head>                     2  none registered within the bound
#   ci-watch: moved <pr> <old head> <new head>          3  re-arm on the new head
#   ci-watch: closed <pr> <MERGED|CLOSED>               4
#   ci-watch: unread <pr> <reason>                      5  gh failed, or a bad call
#
# CI_WATCH_REGISTER_WAIT bounds the wait for registration, in seconds (default 180).

set -uo pipefail

STATE_DIR="${ORCHESTRATOR_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-orchestrator}"
REGISTER_WAIT="${CI_WATCH_REGISTER_WAIT:-180}"
usage="usage: ci-watch.sh <pr> [--repo <owner/repo>] [--interval <s>]"

pr="${1:-}"
say() { printf 'ci-watch: %s\n' "$*"; }
unread() { say "unread ${pr:--} $*"; exit 5; }

case "$pr" in ''|*[!0-9]*) pr=""; unread "$usage" ;; esac
shift
repo=(); interval=10
while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || unread "$1 needs a value"
    case "$1" in
        --repo) repo=(-R "$2") ;;
        --interval) interval="$2" ;;
        *) unread "unknown argument: $1 ($usage)" ;;
    esac
    shift 2
done
case "$interval" in ''|*[!0-9]*|0) unread "the interval is a positive number of seconds" ;; esac
case "$REGISTER_WAIT" in ''|*[!0-9]*) unread "CI_WATCH_REGISTER_WAIT is a number of seconds" ;; esac

first_line() { head -n 1 | tr -d '\r'; }

# `<STATE> <head>` of the pull request, one read.
read_pr() {
    local out err
    err=$(mktemp "${TMPDIR:-/tmp}/ci-watch.XXXXXX") || unread "cannot create a temporary file"
    out=$(gh pr view "$pr" ${repo[@]+"${repo[@]}"} --json state,headRefOid \
        --jq '.state + " " + .headRefOid' 2>"$err")
    if [ $? -ne 0 ] || [ -z "$out" ]; then
        local why; why=$(first_line < "$err"); rm -f "$err"
        unread "gh pr view failed: ${why:-no answer}"
    fi
    rm -f "$err"
    state="${out%% *}"; head="${out#* }"
}

read_pr
[ "$state" = OPEN ] || { say "closed $pr $state"; exit 4; }
first="$head"

# Wait, bounded, for checks to be registered on the head.
deadline=$((SECONDS + REGISTER_WAIT))
while :; do
    err=$(mktemp "${TMPDIR:-/tmp}/ci-watch.XXXXXX") || unread "cannot create a temporary file"
    count=$(gh pr checks "$pr" ${repo[@]+"${repo[@]}"} --json name --jq length 2>"$err")
    code=$?
    why=$(first_line < "$err"); none=0
    case "$why" in *"no checks reported"*) none=1 ;; esac
    rm -f "$err"
    if [ "$none" = 0 ]; then
        # Any other failure, or an answer that is no number, is a gh failure.
        [ "$code" -eq 0 ] || unread "gh pr checks failed: ${why:-no answer}"
        case "$count" in ''|*[!0-9]*) unread "gh pr checks failed: ${why:-an answer that is no count}" ;; esac
        [ "$count" -gt 0 ] && break
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then say "no-checks $pr $first"; exit 2; fi
    sleep "$interval"
done

mkdir -p "$STATE_DIR/ci-watch" 2>/dev/null || unread "cannot create $STATE_DIR/ci-watch"
slug="${repo[1]:-here}"
log="$STATE_DIR/ci-watch/${slug//[^A-Za-z0-9._-]/_}-pr$pr.log"
gh pr checks "$pr" ${repo[@]+"${repo[@]}"} --watch --fail-fast --interval "$interval" > "$log" 2>&1
watch=$?

# One read, now that the watch returned: the pull request may have been closed or moved.
read_pr
[ "$state" = OPEN ] || { say "closed $pr $state"; exit 4; }
[ "$head" = "$first" ] || { say "moved $pr $first $head"; exit 3; }

[ "$watch" -eq 0 ] && { say "green $pr $head"; exit 0; }

names=$(gh pr checks "$pr" ${repo[@]+"${repo[@]}"} --json name,bucket \
    --jq '.[] | select(.bucket == "fail" or .bucket == "cancel") | .name' 2>/dev/null | paste -sd, - | sed 's/,/, /g')
[ -n "$names" ] || unread "gh pr checks --watch exited $watch with no failing check named (log: $log)"
say "red $pr $head $names"
exit 1
