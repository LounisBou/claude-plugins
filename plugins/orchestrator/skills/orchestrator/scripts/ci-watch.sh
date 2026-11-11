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
# never on stdout, the arming session's id beside it (`<log>.session`, the key the stop gate tells a
# session its own watches by); reads the pull request once more when the watch returns. The watch ends once
# the checks it knows are done, maybe before a slower workflow's checks are registered: every
# workflow run of the head is read, each unfinished one watched to its end (`gh run watch`),
# and the checks watched again, until none is unfinished. The bound, CI_WATCH_REGISTER_WAIT, is
# no limit on how long a run may take: it bounds how long a run already watched may stay listed
# unfinished (the listing's lag), restarts at each run watched, and past it the watch is unread.
# A draft pull request may carry a draft guard: a job that fails on purpose while the pull request
# is a draft, recognised by its definition testing the draft flag (`draft_guard.py`). A red whose
# every failing check is one is no red, so on a draft the watch runs without `--fail-fast` (it
# would stop on the guard before the real checks finish) and the failing names are classified
# when it returns: none left, the rest of the green path; some left, `red` naming only those. A
# pull request that is no draft, or no longer one, keeps the path above exactly.
# A green carries evidence: one check at least passed. A head whose checks all ended skipped, or
# failed as a draft guard — a draft whose every real job depends on its guard, or jobs each
# conditioned out — had nothing run, and says `no-checks` with the count skipped, never green.
# The count leaves the guards out, so a draft whose only checks are its guards says `skipped=0`.
# On a draft the watch settled on its guards, a check that depends on no guard (a secret scanner)
# is no evidence either: only a passed check whose job needs a guard counts (`draft_guard.py
# --dependents`), else `no-checks` with the count skipped.
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
#                                                                  every check passed, one at least; with
#                                                                  auto-merge: no merge within the bound
#   ci-watch: red <pr> <head> <failing check names>             1
#                                                                  (a cancelled check is one, though the watch
#                                                                  exits 0 over it)
#   ci-watch: no-checks <pr> <head>                             2  none registered within the bound
#   ci-watch: no-checks <pr> <head> skipped=<n>                 2  every check done and none passed: each one
#                                                                  skipped or a draft guard; with auto-merge: no
#                                                                  merge within the bound
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
# What the caller does, per line:
#   green: run the call the line ends with, the github tool's read of the gate, which puts `Ready`
#     when the four hold. Then, with auto-merge, nothing: the merge is coming, and a watch that sees
#     auto-merge enabled on green waits, bounded, for it and follows the base branch, so a green
#     line there means no merge came within the bound; otherwise report « ready » once `Ready` is on.
#   red: read the failing job first; when its failure is outside what the pull request touches
#     (an unrelated flake, infrastructure), re-run the failed jobs once with
#     `gh run rerun <run-id> --failed`, after naming the failing job's cause in one line, read in
#     its log, and re-arm the watch. Only a second red, or a red in what the pull request touches,
#     is reported to the operator in one line, and you dispatch the correction at once, to a fresh
#     session (the implementer was stood down at its delivery).
#   moved: re-arm on the new head.
#   no-checks: ready on the suite's evidence; with auto-merge enabled, no merge came within the
#     bound either.
#   closed: stop the work on it.
#   closed MERGED with --no-base, or merged by hand: start the watch again in the background: it
#     enters on MERGED and follows the base branch.
#   unread: re-arm once, then report; the same when the host's timeout ends the watch.
#   base-green: nothing.
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

exec node --no-warnings "$(dirname "$0")/ci-watch.ts" "$@"
