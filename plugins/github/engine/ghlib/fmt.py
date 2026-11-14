"""Turn an API response into the shape a skill wants to read."""

import json

from . import errors


def _first(obj):
    if isinstance(obj, list):
        return obj[0] if obj else None
    return obj


class Lines(str):
    """Plain text lines a subcommand prints as they are, not as JSON."""


def _raw(obj):
    if isinstance(obj, Lines):
        return str(obj)
    return json.dumps(obj, indent=2, sort_keys=True)


def _error_check(obj):
    if isinstance(obj, dict) and "message" in obj and "documentation_url" in obj:
        raise errors.ApiError(obj["message"])
    return ""


def _pr_number(obj):
    item = _first(obj)
    return str(item["number"]) if item and "number" in item else ""


def _pr_url(obj):
    item = _first(obj)
    return item.get("html_url", "") if item else ""


def _pr_merge_status(obj):
    item = _first(obj) or {}
    if item.get("merged"):
        return "merged"
    return "open" if item.get("state") == "open" else "closed"


def _is_id(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _stale_suites(workflows, suite_runs, runs):
    """The check suites of a workflow run older than the latest run of its
    workflow, the greatest run id: a re-run keeps its run id, so it stays the
    latest. A suite whose run id is not an integer is never stale, nor any suite
    of a workflow whose latest run has no check run among runs (queued, waiting
    or failed at startup): it proves nothing yet, so it hides nothing."""
    latest = {}
    for suite, run_id in (suite_runs or {}).items():
        workflow = workflows.get(suite)
        if workflow is not None and _is_id(run_id):
            latest[workflow] = max(latest.get(workflow, run_id), run_id)
    checked = {str((run.get("check_suite") or {}).get("id")) for run in runs}
    proven = {
        workflows.get(suite)
        for suite, run_id in (suite_runs or {}).items()
        if suite in checked and _is_id(run_id) and run_id == latest.get(workflows.get(suite))
    }
    return {
        suite
        for suite, run_id in (suite_runs or {}).items()
        if workflows.get(suite) in proven and _is_id(run_id) and run_id < latest[workflows.get(suite)]
    }


def _latest_runs(runs, workflows, suite_runs=None):
    """The latest run of each check. A check is its name, its app (app.id, or
    app.slug when that is all the payload carries; no app, the name alone) and
    its workflow: every Actions run shares one app, so a job of one workflow
    would hide the same-named job of another. workflows maps a check suite id
    (as a string) to its workflow id. A run whose suite is not there keys on its
    own check suite, so it is only deduplicated with re-runs of that suite, never
    merged with another workflow's run; a run with no suite keys on its name and
    app. With no mapping at all (None: the call failed) no run is placed, so none
    is dropped. The latest is the greatest id, which grows with creation:
    started_at is kept by a re-run, so a re-run of an old run would pass for the
    newest. A run without an integer id, or tied on the greatest id, is kept:
    nothing here may hide a failure or a running run. A skipped or neutral run
    of an older workflow run (suite_runs maps a check suite id to its workflow
    run id) counts as nothing: it proved nothing, and the latest workflow run of
    its workflow, which has check runs, speaks for it."""
    if workflows is None:
        return list(runs)
    stale = _stale_suites(workflows, suite_runs, runs)
    kept = []
    groups = {}
    for run in runs:
        app = run.get("app") or {}
        suite = (run.get("check_suite") or {}).get("id")
        unproven = run.get("status") == "completed" and run.get("conclusion") in ("skipped", "neutral")
        if unproven and str(suite) in stale:
            continue
        key = (run.get("name"), app.get("id", app.get("slug")), workflows.get(str(suite)))
        if key[2] is None and suite is not None:
            key = key[:2] + (("suite", suite),)
        if _is_id(run.get("id")):
            groups.setdefault(key, []).append(run)
        else:
            kept.append(run)
    for group in groups.values():
        newest = max(run["id"] for run in group)
        kept.extend(run for run in group if run["id"] == newest)
    return kept


def gate_ci(statuses, runs, draft, workflows=None, suite_runs=None):
    """CI at one head, as the ready guard reads it. Only the latest run of each
    check counts, and none skipped or neutral in an older workflow run. A completed check passes
    on success, and on neutral out of draft. A skipped one, and on a draft a
    neutral one, did not prove anything: not green. Any other conclusion is a
    failure, named by its check. A check still running is not green. No check
    at all is not green either: CI has not started on that head, so the result
    is PENDING."""
    commit_statuses = (statuses or {}).get("statuses") or []
    runs = _latest_runs(runs, workflows, suite_runs)
    passing = ("success",) if draft else ("success", "neutral")
    unproven = ("skipped", "neutral") if draft else ("skipped",)
    completed = [run for run in runs if run.get("status") == "completed"]
    failed = [
        run.get("name", "?") for run in completed if run.get("conclusion") not in passing + unproven
    ] + [status.get("context", "?") for status in commit_statuses if status.get("state") in ("failure", "error")]
    running = [run for run in runs if run.get("status") != "completed"] + [
        status for status in commit_statuses if status.get("state") == "pending"
    ]
    skipped = [run.get("name", "?") for run in completed if run.get("conclusion") in unproven]
    if failed:
        result = "FAILURE"
    elif running or skipped or not (runs or commit_statuses):
        result = "PENDING"
    else:
        result = "SUCCESS"
    return {
        "result": result,
        "failed": failed,
        "running": len(running),
        "skipped": skipped,
        "total": len(runs) + len(commit_statuses),
    }


def _checks_status(obj):
    # "statuses" is the combined-status API's own response: {"state": ...,
    # "statuses": [{"state": ..., "context": ...}, ...]}. Its inner list is
    # what legacy commit statuses (as opposed to check runs) actually live in.
    # The verdict is the ready guard's, the one pr-gate reads.
    ci = gate_ci(
        obj.get("statuses"),
        obj.get("check_runs", []),
        bool(obj.get("draft")),
        obj.get("workflows"),
        obj.get("workflow_runs"),
    )
    return json.dumps({"result": ci["result"], "failed_checks": ci["failed"]}, sort_keys=True)


def _pr_summary(obj):
    pull = obj.get("pull") or {}
    ci = obj.get("ci") or {}
    mergeable = pull.get("mergeable")
    mergeable = "unknown" if mergeable is None else str(bool(mergeable)).lower()
    state = "merged" if pull.get("merged_at") else pull.get("state", "")
    labels = [label.get("name", "") for label in pull.get("labels") or []]
    checks = "%s (%d total, %d running, failed: %s)" % (
        ci.get("result"), ci.get("total", 0), ci.get("running", 0), ", ".join(ci.get("failed") or []) or "none"
    )
    return "\n".join([
        "pr %s: %s%s" % (pull.get("number"), state, ", draft" if pull.get("draft") else ""),
        "mergeable: %s" % mergeable,
        "head: %s" % (pull.get("head") or {}).get("sha", ""),
        "labels: %s" % (", ".join(labels) or "none"),
        "checks: %s" % checks,
    ])


def _threads(obj, resolved):
    items = obj if isinstance(obj, list) else obj.get("threads", [])
    return json.dumps([t for t in items if bool(t.get("isResolved")) is resolved], sort_keys=True)


def _thread_summary(obj):
    items = json.loads(_threads(obj, False))
    if not items:
        return "No open review threads."
    lines = ["| thread | file | line | author |", "|---|---|---|---|"]
    for thread in items:
        first = ((thread.get("comments") or {}).get("nodes") or [{}])[0]
        lines.append(
            "| %s | %s | %s | %s |"
            % (
                thread.get("id", "?"),
                thread.get("path", "?"),
                thread.get("line", "?"),
                (first.get("author") or {}).get("login", "?"),
            )
        )
    return "\n".join(lines)


def _resolve_status(obj):
    thread = (obj.get("resolveReviewThread") or {}).get("thread") or {}
    if thread.get("isResolved"):
        return "resolved"
    thread = (obj.get("unresolveReviewThread") or {}).get("thread") or {}
    if thread and not thread.get("isResolved"):
        return "unresolved"
    raise errors.ApiError("thread was not resolved")


def _issue_comments_summary(obj):
    if not isinstance(obj, list) or not obj:
        return "No issue comments."
    lines = ["| id | author | first line |", "|---|---|---|"]
    for comment in obj:
        body = (comment.get("body") or "").strip().splitlines()
        lines.append(
            "| %s | %s | %s |"
            % (
                comment.get("id", "?"),
                (comment.get("user") or {}).get("login", "?"),
                body[0][:60] if body else "",
            )
        )
    return "\n".join(lines)


def _pr_details(obj):
    item = _first(obj) or {}
    return json.dumps(
        {
            "number": item.get("number"),
            "title": item.get("title"),
            "state": item.get("state"),
            "draft": item.get("draft"),
            "head": (item.get("head") or {}).get("ref"),
            "base": (item.get("base") or {}).get("ref"),
            "url": item.get("html_url"),
        },
        sort_keys=True,
    )


def _login(obj):
    item = _first(obj)
    return (item or {}).get("login") or ""


def _comment_bodies(obj):
    if not isinstance(obj, list):
        return ""
    return "\n---\n".join((c.get("body") or "") for c in obj if isinstance(c, dict))


def _pending_review_summary(obj):
    review = (obj or {}).get("review")
    if not review:
        return "none"
    comments = (obj or {}).get("comments") or []
    lines = [
        "id %s" % review.get("id"),
        "node_id %s" % review.get("node_id"),
        "state %s" % review.get("state"),
        "comments %d" % len(comments),
        "",
        "| path | line | commit_id |",
        "|---|---|---|",
    ]
    for comment in comments:
        if not isinstance(comment, dict):
            continue
        # A pending review's comments carry position, not line; show whichever
        # GitHub sent so the table is never blank.
        line = comment.get("line")
        if line is None:
            line = comment.get("position")
        if line is None:
            line = "?"
        lines.append("| %s | %s | %s |" % (comment.get("path") or "?", line, comment.get("commit_id") or "?"))
    return "\n".join(lines)


_FORMATTERS = {
    "raw": _raw,
    "error-check": _error_check,
    "pr-number": _pr_number,
    "pr-url": _pr_url,
    "pr-merge-status": _pr_merge_status,
    "pr-details": _pr_details,
    "pr-summary": _pr_summary,
    "checks-status": _checks_status,
    "open-threads": lambda obj: _threads(obj, False),
    "resolved-threads": lambda obj: _threads(obj, True),
    "thread-summary": _thread_summary,
    "resolve-status": _resolve_status,
    "issue-comments-summary": _issue_comments_summary,
    "login": _login,
    "pending-review-summary": _pending_review_summary,
    "comment-bodies": _comment_bodies,
}


def render(name, obj):
    if obj is None:
        return ""
    handler = _FORMATTERS.get(name)
    if handler is None:
        raise errors.UsageError(
            "unknown --format %r; known: %s" % (name, ", ".join(sorted(_FORMATTERS)))
        )
    return handler(obj)
