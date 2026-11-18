#!/bin/bash
# ci-watch.sh — the one way to wait on a pull request's checks.
#
#   ci-watch.sh <pr | owner/name#pr | pull request url> [--repo <owner/repo>] [--interval <s>] [--base-workflow <name>]... [--no-base]
#
# The repository is the one the target names (`owner/name#12`, or its URL), else `--repo`; the
# two must agree. With neither, it is the clone the command runs in: from any other directory,
# pass one of them, or the watch says `unread` and asks for `--repo`, and reads nothing.
#
# Meant to be started by the orchestrator with the host's background run (`run_in_background`,
# timeout 7 200 000 ms), once per pull request: a command that exits on the event costs no
# token while it waits, and its exit wakes the session. Nobody watches CI in the foreground
# and nobody loops on `gh pr view` or `gh pr checks` (design, « Waiting on CI »).
#
# What it does: reads the head once; waits, bounded, for checks to be registered on it (a
# push is seen before its checks, and « no checks reported » right then is not a red); runs
# `gh pr checks --watch --fail-fast` as a wait only (its exit code decides nothing), its output in a
# log file under the state directory, never on stdout, the arming session's id beside it
# (`<log>.session`, the key the stop gate tells a session its own watches by); reads the pull
# request once more when the watch returns. Then the github plugin's `pr-gate` decides (its engine,
# found where the host installed the plugin, or at the checkout the override names): it is the one
# reading of CI, and the watch counts nothing of its own. Its `ci.result` FAILURE is a `red` naming
# its `ci.failed`. While no failure is read, every workflow run of the head is read, each unfinished
# one watched to its end (`gh run watch`), the checks watched again, and the gate read again; once
# none is unfinished, the watch goes on while the gate's result is PENDING with a check running (a
# required check not yet reported counts as running), or with checks the base requires unread
# (`ci.unverified`), or speaks of another head. The bound, CI_WATCH_REGISTER_WAIT, restarts at each
# run watched; past it a run still listed unfinished is `unread`, and a gate still awaiting CI is
# `no-checks` (a head with a third-party check alone, before the repository's own run registers).
# Green is the gate's SUCCESS; any other settled result (nothing proved anything: every check
# skipped) is `no-checks` with the count skipped. A gate that cannot be read is `unread`.
# A draft pull request may carry a draft guard: a job that fails on purpose while the pull request
# is a draft, recognised by its definition testing the draft flag (`draft-guard.ts`, given the gate's
# answer). On a draft the watch runs without `--fail-fast`, and a failure whose every failing check
# is a guard is no red: the draft is green only when a passed check's job needs a guard
# (`draft-guard.ts --dependents`), else `no-checks` with the count skipped. A pull request that is
# no draft, or no longer one, keeps the path above exactly.
# Nor is a pull request GitHub reports as conflicting: it starts no workflow run, so what passed is an
# external check at most, and the suites never ran. It says `no-checks` with the word `conflicting`,
# before any wait for a merge: the head is rebased, never reported ready.
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
#   ci-watch: green <pr> <head> next: mcp__github__gh pr-gate {"pr": <pr>} [on <owner/repo>]
#                                                               0  every workflow run of the head completed and
#                                                                  the gate reads SUCCESS; with auto-merge: no
#                                                                  merge within the bound
#   ci-watch: red <pr> <head> <failing check names>             1  the gate reads FAILURE
#   ci-watch: no-checks <pr> <head>                             2  none registered within the bound, or a
#                                                                  required check still to come at its end
#   ci-watch: no-checks <pr> <head> conflicting                 2  the pull request conflicts with its base: its
#                                                                  suites never ran
#   ci-watch: no-checks <pr> <head> skipped=<n>                 2  every check done and the gate reads no
#                                                                  SUCCESS (each one skipped, or a draft guard);
#                                                                  with auto-merge: no merge within the bound
#   ci-watch: moved <pr> <old head> <new head>                  3  re-arm on the new head
#   ci-watch: closed <pr> CLOSED                                4  closed without merge
#   ci-watch: closed <pr> MERGED                                4  merged, with --no-base only
#   ci-watch: unread <pr> <reason>                              5  gh failed, or a bad call
#   ci-watch: base-green <pr> <sha>                             0  merged, the base branch's runs green
#                                                                  (the sha of a cancelled run's successor)
#   ci-watch: base-red <pr> <sha> <run id> <failing job names>  6  the first red run on the base branch
#   ci-watch: base-no-run <pr> <sha> filtered=<n>               7  no push run within the bound, on a watch
#                                                                  that entered on MERGED
#   ci-watch: merged <pr> <sha> no push run on <branch> filtered=<n>
#                                                               0  merged during the watch, no push run within
#                                                                  the bound
#
# `filtered` counts the push runs on that commit the workflow filter left out: above 0, a
# followed workflow is misnamed, and the operator is told.
#
# What the caller does, per line:
#   green: with auto-merge, nothing: the merge is coming, and a watch that sees auto-merge enabled
#     on green waits, bounded, for it and follows the base branch, so a green line there means no
#     merge came within the bound; otherwise report « ready » once the call the line ends with, the
#     github tool's read of the gate, has put `Ready` (it does when the pull request is ready).
#   red: read the failing job first; when its failure is outside what the pull request touches
#     (an unrelated flake, infrastructure), re-run the failed jobs once with
#     `gh run rerun <run-id> --failed`, after naming the failing job's cause in one line, read in
#     its log, and re-arm the watch. Only a second red, or a red in what the pull request touches,
#     is reported to the operator in one line, and you send the correction at once to the
#     implementer (resumed, or a fresh one, once its pull request was Ready).
#   moved: re-arm on the new head.
#   no-checks: ready on the suite's evidence; with auto-merge enabled, no merge came within the
#     bound either. `conflicting` is the exception: never ready, rebase the branch onto its base
#     and re-arm the watch.
#   closed: stop the work on it.
#   closed MERGED with --no-base, or merged by hand: start the watch again in the background: it
#     enters on MERGED and follows the base branch.
#   unread: re-arm once, then report; the same when the host's timeout ends the watch.
#   base-green: nothing.
#   merged: nothing; above filtered=0, a misnamed workflow, reported to the operator in one line.
#   base-red: read the failing job; a flake or an infrastructure fault is re-run once with
#     `gh run rerun <run-id> --failed`, after naming its cause in one line, and the watch re-armed;
#     any other red, or a second one, is reported to the operator in one line and fixed at once in
#     its own pull request, dispatched to a fresh session: a red base branch is never left standing.
#   base-no-run filtered=0: nothing, the project runs no push CI on that branch; above 0, a
#     misnamed workflow, reported to the operator in one line.
#
# CI_WATCH_REGISTER_WAIT bounds the wait for registration, in seconds (default 180).
# CI_WATCH_MERGE_WAIT bounds the wait for an auto-merge after green, in seconds (default 1800),
# so that the whole watch stays inside the host's background bound.
# CI_WATCH_BASE_WAIT bounds the wait for a push run on the base branch, in seconds (default 600).
# Which workflows are followed there: `--base-workflow <name>` (repeatable), else
# CI_WATCH_BASE_WORKFLOWS (comma-separated names), else every push run on the merge commit.
#
# The watch itself is ci-watch.ts, beside this launcher; this header documents both.

. "$(dirname "$0")/node-ts.sh"
node_ts_exec ci-watch "$(dirname "$0")/ci-watch.ts" "$@"
