#!/bin/bash
# ci-watch.sh — the one way to wait on a pull request's checks.
#
#   ci-watch.sh <pr> [--repo <owner/repo>] [--interval <s>] [--base-workflow <name>]... [--no-base]
#
# Meant to be started by the orchestrator with the host's background run (`run_in_background`,
# timeout 7 200 000 ms), once per pull request: a command that exits on the event costs no
# token while it waits, and its exit wakes the session. Nobody watches CI in the foreground
# and nobody loops on `gh pr view` or `gh pr checks` (design, « Waiting on CI »).
#
# What it does: reads the head once; waits, bounded, for checks to be registered on it (a
# push is seen before its checks, and « no checks reported » right then is not a red); runs
# `gh pr checks --watch --fail-fast`, its output in a log file under the state directory,
# never on stdout; reads the pull request once more when the watch returns. The watch ends once
# the checks it knows are done, maybe before a slower workflow's checks are registered: every
# workflow run of the head is read, each unfinished one watched to its end (`gh run watch`),
# and the checks watched again, until none is unfinished. The bound, CI_WATCH_REGISTER_WAIT, is
# no limit on how long a run may take: it bounds how long a run already watched may stay listed
# unfinished (the listing's lag), restarts at each run watched, and past it the watch is unread.
# Green with auto-merge enabled is not the end: the merge is coming, and nobody re-arms a watch after it,
# so the pull request is read again at the interval, bounded, until it merges.
#
# A pull request found merged, at either read, is followed onto its base branch: a flaky test
# green on the merge ref can still turn the base branch red, and nobody else watches that run.
# It reads the merge commit and the base branch, waits, bounded, for the push runs on that
# branch at that commit, and watches each to its end (`gh run watch --exit-status`, its output
# in a log file too), re-listing once they end so a run registered late is watched as well.
# A run cancelled there is no red: the branch's concurrency cancels it for a newer push, so the
# newest push run of the same workflow on that branch is followed instead, and its outcome is
# reported with its own sha. A cancelled run with no newer one is a red.
#
# stdout, one line, and the exit code the caller reads without opening the log:
#   ci-watch: green <pr> <head>                                 0  every workflow run of the head completed and
#                                                                  every check passed; with auto-merge: no merge
#                                                                  within the bound
#   ci-watch: red <pr> <head> <failing check names>             1
#                                                                  (a cancelled check is one, though the watch
#                                                                  exits 0 over it)
#   ci-watch: no-checks <pr> <head>                             2  none registered within the bound
#   ci-watch: moved <pr> <old head> <new head>                  3  re-arm on the new head
#   ci-watch: closed <pr> CLOSED                                4  closed without merge
#   ci-watch: closed <pr> MERGED                                4  merged, with --no-base only
#   ci-watch: unread <pr> <reason>                              5  gh failed, or a bad call
#   ci-watch: base-green <pr> <sha>                             0  merged, the base branch's runs green
#                                                                  (the sha of a cancelled run's successor)
#   ci-watch: base-red <pr> <sha> <run id> <failing job names>  6  the first red run on the base branch
#   ci-watch: base-no-run <pr> <sha> filtered=<n>               7  no push run within the bound
#
# `filtered` counts the push runs on that commit the workflow filter left out: above 0, a
# followed workflow is misnamed, and the operator is told.
#
# CI_WATCH_REGISTER_WAIT bounds the wait for registration, in seconds (default 180).
# CI_WATCH_MERGE_WAIT bounds the wait for an auto-merge after green, in seconds (default 1800),
# so that the whole watch stays inside the host's background bound.
# CI_WATCH_BASE_WAIT bounds the wait for a push run on the base branch, in seconds (default 600).
# Which workflows are followed there: `--base-workflow <name>` (repeatable), else
# CI_WATCH_BASE_WORKFLOWS (comma-separated names), else every push run on the merge commit.

set -uo pipefail

STATE_DIR="${ORCHESTRATOR_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-orchestrator}"
REGISTER_WAIT="${CI_WATCH_REGISTER_WAIT:-180}"
BASE_WAIT="${CI_WATCH_BASE_WAIT:-600}"
MERGE_WAIT="${CI_WATCH_MERGE_WAIT:-1800}"
usage="usage: ci-watch.sh <pr> [--repo <owner/repo>] [--interval <s>] [--base-workflow <name>]... [--no-base]"

pr="${1:-}"
say() { printf 'ci-watch: %s\n' "$*"; }
unread() { say "unread ${pr:--} $*"; exit 5; }

case "$pr" in ''|*[!0-9]*) pr=""; unread "$usage" ;; esac
shift
repo=(); interval=10; base=1; workflows=()
while [ $# -gt 0 ]; do
    [ "$1" = --no-base ] && { base=0; shift; continue; }
    [ $# -ge 2 ] || unread "$1 needs a value"
    case "$1" in
        --repo) repo=(-R "$2") ;;
        --interval) interval="$2" ;;
        --base-workflow) workflows+=("$2") ;;
        *) unread "unknown argument: $1 ($usage)" ;;
    esac
    shift 2
done
case "$interval" in ''|*[!0-9]*|0) unread "the interval is a positive number of seconds" ;; esac
case "$REGISTER_WAIT" in ''|*[!0-9]*) unread "CI_WATCH_REGISTER_WAIT is a number of seconds" ;; esac
case "$BASE_WAIT" in ''|*[!0-9]*) unread "CI_WATCH_BASE_WAIT is a number of seconds" ;; esac
case "$MERGE_WAIT" in ''|*[!0-9]*) unread "CI_WATCH_MERGE_WAIT is a number of seconds" ;; esac
if [ ${#workflows[@]} -eq 0 ] && [ -n "${CI_WATCH_BASE_WORKFLOWS:-}" ]; then
    IFS=, read -r -a workflows <<< "$CI_WATCH_BASE_WORKFLOWS"
fi

first_line() { head -n 1 | tr -d '\r'; }

# The pull request's `state`, `head` and `auto` (`auto` when auto-merge is enabled), one read.
read_pr() {
    local out err rest
    err=$(mktemp "${TMPDIR:-/tmp}/ci-watch.XXXXXX") || unread "cannot create a temporary file"
    out=$(gh pr view "$pr" ${repo[@]+"${repo[@]}"} --json state,headRefOid,autoMergeRequest \
        --jq '.state + " " + .headRefOid + (if .autoMergeRequest then " auto" else "" end)' 2>"$err")
    if [ $? -ne 0 ] || [ -z "$out" ]; then
        local why; why=$(first_line < "$err"); rm -f "$err"
        unread "gh pr view failed: ${why:-no answer}"
    fi
    rm -f "$err"
    state="${out%% *}"; rest="${out#* }"; head="${rest%% *}"
    auto=""; [ "$rest" = "$head" ] || auto="${rest#* }"
}

# Sets `log` to the log file of this pull request, `<suffix>` naming which watch writes it.
log_file() {
    mkdir -p "$STATE_DIR/ci-watch" 2>/dev/null || unread "cannot create $STATE_DIR/ci-watch"
    local slug="${repo[1]:-here}"
    log="$STATE_DIR/ci-watch/${slug//[^A-Za-z0-9._-]/_}-pr$pr$1.log"
}

# Is `<name>` a followed workflow? Every one is when none was named.
followed() {
    [ ${#workflows[@]} -eq 0 ] && return 0
    local w
    for w in "${workflows[@]}"; do [ "$w" = "$1" ] && return 0; done
    return 1
}

# The pull request is no longer open: closed without merge ends here; merged is followed onto
# the base branch's push runs at the merge commit, unless --no-base.
ended() {
    { [ "$state" = MERGED ] && [ "$base" = 1 ]; } || { say "closed $pr $state"; exit 4; }
    local err out sha at green branch deadline seen=" " left=" " new names i id name code jobs next
    err=$(mktemp "${TMPDIR:-/tmp}/ci-watch.XXXXXX") || unread "cannot create a temporary file"
    out=$(gh pr view "$pr" ${repo[@]+"${repo[@]}"} --json mergeCommit,baseRefName \
        --jq '(.mergeCommit.oid // "") + " " + .baseRefName' 2>"$err")
    if [ $? -ne 0 ]; then
        local why; why=$(first_line < "$err"); rm -f "$err"
        unread "gh pr view failed: ${why:-no answer}"
    fi
    rm -f "$err"
    sha="${out%% *}"; branch="${out#* }"
    [ -n "$sha" ] && [ -n "$branch" ] && [ "$branch" != "$out" ] \
        || unread "gh pr view failed: no merge commit or base branch read"
    log_file -base; : > "$log"
    deadline=$((SECONDS + BASE_WAIT))
    while :; do
        err=$(mktemp "${TMPDIR:-/tmp}/ci-watch.XXXXXX") || unread "cannot create a temporary file"
        out=$(gh run list ${repo[@]+"${repo[@]}"} --branch "$branch" --commit "$sha" --event push \
            --json databaseId,workflowName --jq '.[] | "\(.databaseId)\t\(.workflowName)"' 2>"$err")
        if [ $? -ne 0 ]; then
            local why; why=$(first_line < "$err"); rm -f "$err"
            unread "gh run list failed: ${why:-no answer}"
        fi
        rm -f "$err"
        new=(); names=()
        while IFS=$'\t' read -r id name; do
            [ -n "$id" ] || continue
            case "$seen" in *" $id "*) continue ;; esac
            if followed "$name"; then new+=("$id"); names+=("$name")
            else case "$left" in *" $id "*) ;; *) left="$left$id " ;; esac
            fi
        done <<< "$out"
        if [ ${#new[@]} -eq 0 ]; then
            # Every run listed has been watched green: one listing more found nothing new.
            [ "$seen" != " " ] && { say "base-green $pr ${green:-$sha}"; exit 0; }
            [ "$SECONDS" -ge "$deadline" ] && { set -- $left; say "base-no-run $pr $sha filtered=$#"; exit 7; }
            sleep "$interval"
            continue
        fi
        for i in "${!new[@]}"; do
            id="${new[$i]}"; name="${names[$i]}"; at="$sha"
            while :; do
                seen="$seen$id "
                gh run watch "$id" ${repo[@]+"${repo[@]}"} --exit-status --interval "$interval" >> "$log" 2>&1
                code=$?
                [ "$code" -eq 0 ] && break
                if [ "$(gh run view "$id" ${repo[@]+"${repo[@]}"} --json conclusion --jq .conclusion 2>/dev/null)" = cancelled ]; then
                    err=$(mktemp "${TMPDIR:-/tmp}/ci-watch.XXXXXX") || unread "cannot create a temporary file"
                    out=$(gh run list ${repo[@]+"${repo[@]}"} --branch "$branch" --workflow "$name" --event push \
                        --limit 1 --json databaseId,headSha --jq '.[] | "\(.databaseId) \(.headSha)"' 2>"$err")
                    if [ $? -ne 0 ]; then
                        local why; why=$(first_line < "$err"); rm -f "$err"
                        unread "gh run list failed: ${why:-no answer}"
                    fi
                    rm -f "$err"
                    next="${out%% *}"
                    case "$next" in ''|*[!0-9]*) next=0 ;; esac
                    # Only a newer run replaces it; the cancelled run itself listed means none came.
                    [ "$next" -gt "$id" ] && { id="$next"; at="${out#* }"; green="$at"; continue; }
                fi
                jobs=$(gh run view "$id" ${repo[@]+"${repo[@]}"} --json jobs \
                    --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out") | .name' \
                    2>/dev/null | paste -sd, - | sed 's/,/, /g')
                [ -n "$jobs" ] || unread "gh run watch $id exited $code with no failing job named (log: $log)"
                say "base-red $pr $at $id $jobs"
                exit 6
            done
        done
    done
}

read_pr
[ "$state" = OPEN ] || ended
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

log_file ""
gh pr checks "$pr" ${repo[@]+"${repo[@]}"} --watch --fail-fast --interval "$interval" > "$log" 2>&1
watch=$?

# One read, now that the watch returned: the pull request may have been closed or moved.
read_pr
[ "$state" = OPEN ] || ended
[ "$head" = "$first" ] || { say "moved $pr $first $head"; exit 3; }

# The watch returns once the checks it knows are done, and a slower workflow's checks may not
# be registered yet: every workflow run of the head is read, each one unfinished is watched to
# its end, and once none is, the checks are watched again, a late one read like the others.
# The bound restarts whenever a run is watched for the first time; a run already watched and
# still listed unfinished is polled within it.
deadline=$((SECONDS + REGISTER_WAIT)); seen=" "; waited=0
while [ "$watch" -eq 0 ]; do
    err=$(mktemp "${TMPDIR:-/tmp}/ci-watch.XXXXXX") || unread "cannot create a temporary file"
    pending=$(gh run list ${repo[@]+"${repo[@]}"} --commit "$head" --json databaseId,status \
        --jq '.[] | select(.status != "completed") | .databaseId' 2>"$err")
    if [ $? -ne 0 ]; then
        why=$(first_line < "$err"); rm -f "$err"
        unread "gh run list failed: ${why:-no answer}"
    fi
    rm -f "$err"
    if [ -n "$pending" ]; then
        waited=1; fresh=0
        for id in $pending; do
            case "$seen" in *" $id "*) continue ;; esac
            seen="$seen$id "; fresh=1
            gh run watch "$id" ${repo[@]+"${repo[@]}"} --interval "$interval" >> "$log" 2>&1
        done
        if [ "$fresh" = 1 ]; then
            # The run watches may have lasted long: a head moved or a pull request closed meanwhile
            # is said now, not after a checks watch has waited for the new head's checks.
            read_pr
            [ "$state" = OPEN ] || ended
            [ "$head" = "$first" ] || { say "moved $pr $first $head"; exit 3; }
            deadline=$((SECONDS + REGISTER_WAIT))
        else
            [ "$SECONDS" -ge "$deadline" ] && unread "workflow runs of the head still unfinished:" $pending
            sleep "$interval"
        fi
        continue
    fi
    [ "$waited" = 1 ] || break
    waited=0
    gh pr checks "$pr" ${repo[@]+"${repo[@]}"} --watch --fail-fast --interval "$interval" >> "$log" 2>&1
    watch=$?
    read_pr
    [ "$state" = OPEN ] || ended
    [ "$head" = "$first" ] || { say "moved $pr $first $head"; exit 3; }
done

if [ "$watch" -eq 0 ]; then
    # The watch exits 0 when no check is in the `fail` bucket, a cancelled one included: a check
    # whose job was never run is no green, so the buckets are read once before saying so.
    err=$(mktemp "${TMPDIR:-/tmp}/ci-watch.XXXXXX") || unread "cannot create a temporary file"
    buckets=$(gh pr checks "$pr" ${repo[@]+"${repo[@]}"} --json name,bucket \
        --jq '.[] | .bucket + "\t" + .name' 2>"$err")
    code=$?
    why=$(first_line < "$err"); rm -f "$err"
    { [ "$code" -eq 0 ] && [ -n "$buckets" ]; } || unread "gh pr checks failed: ${why:-no answer}"
    names=$(awk -F'\t' '$1 == "cancel" { print $2 }' <<< "$buckets" | paste -sd, - | sed 's/,/, /g')
    if [ -z "$names" ]; then
        if [ "$base" = 1 ] && [ "$auto" = auto ]; then
            # Auto-merge will merge: wait for it, bounded, and follow the base branch.
            deadline=$((SECONDS + MERGE_WAIT))
            while [ "$SECONDS" -lt "$deadline" ]; do
                sleep "$interval"
                read_pr
                [ "$state" = OPEN ] || ended
                [ "$head" = "$first" ] || { say "moved $pr $first $head"; exit 3; }
                [ "$auto" = auto ] || break
            done
        fi
        say "green $pr $head"; exit 0
    fi
else
    names=$(gh pr checks "$pr" ${repo[@]+"${repo[@]}"} --json name,bucket \
        --jq '.[] | select(.bucket == "fail" or .bucket == "cancel") | .name' 2>/dev/null | paste -sd, - | sed 's/,/, /g')
    [ -n "$names" ] || unread "gh pr checks --watch exited $watch with no failing check named (log: $log)"
fi
say "red $pr $head $names"
exit 1
