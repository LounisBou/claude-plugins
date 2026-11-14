"""Turn an API response into the shape a skill wants to read."""

import json
import re

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



# ---- The compact defaults: what a reader of the command needs, the full object under --json. ----

_LINE_MAX = 80


def _first_line(text, limit=_LINE_MAX):
    """The first non-empty line of a text, cut at limit characters."""
    for line in str(text or "").splitlines():
        line = line.strip()
        if line:
            return line if len(line) <= limit else line[: limit - 1] + "…"
    return ""


def _cell(value):
    """A table cell: no pipe, no line break."""
    return str(value if value is not None else "?").replace("|", "/").replace("\n", " ")


def _nwo_of(url):
    """owner/name out of a GitHub API or web URL, or empty."""
    match = re.search(r"/repos/([^/]+/[^/]+)", url or "") or re.search(r"github\.com/([^/]+/[^/]+)", url or "")
    return match.group(1) if match else ""


def _items(obj):
    return obj if isinstance(obj, list) else ([obj] if isinstance(obj, dict) else [])


def _pr_line(pull):
    nwo = ((pull.get("base") or {}).get("repo") or {}).get("full_name") or _nwo_of(pull.get("html_url"))
    state = "merged" if pull.get("merged_at") else pull.get("state", "")
    if pull.get("draft"):
        state += ", draft"
    labels = ", ".join(label.get("name", "") for label in pull.get("labels") or [])
    return "%s#%s: %s [%s] %s -> %s%s | %s" % (
        nwo,
        pull.get("number"),
        _first_line(pull.get("title"), 100),
        state,
        (pull.get("head") or {}).get("ref", "?"),
        (pull.get("base") or {}).get("ref", "?"),
        " | labels: " + labels if labels else "",
        (pull.get("user") or {}).get("login", "?"),
    )


def _pr_lines(obj):
    pulls = _items(obj)
    return "\n".join(["%d pull request%s" % (len(pulls), "" if len(pulls) == 1 else "s")] + [_pr_line(p) for p in pulls])


def _checks_summary(obj):
    ci = gate_ci(
        obj.get("statuses"),
        obj.get("check_runs", []),
        bool(obj.get("draft")),
        obj.get("workflows"),
        obj.get("workflow_runs"),
    )
    lines = ["checks: %s (%d total, %d running, %d failed, %d skipped)" % (
        ci["result"], ci["total"], ci["running"], len(ci["failed"]), len(ci["skipped"]))]
    if ci["failed"]:
        lines.append("failed: " + ", ".join(ci["failed"]))
    if ci["skipped"]:
        lines.append("skipped: " + ", ".join(ci["skipped"]))
    return "\n".join(lines)


def _review_comments(obj):
    comments = [c for c in _items(obj) if isinstance(c, dict)]
    lines = ["%d review comment%s" % (len(comments), "" if len(comments) == 1 else "s")]
    for comment in comments:
        number = (comment.get("pull_request_url") or "").rsplit("/", 1)[-1]
        line = comment.get("line") or comment.get("original_line") or "?"
        lines.append("%s | %s | %s:%s | %s | %s" % (
            comment.get("id", "?"),
            "%s#%s" % (_nwo_of(comment.get("pull_request_url")), number) if number.isdigit() else "-",
            _cell(comment.get("path")),
            line,
            (comment.get("user") or {}).get("login", "?"),
            _cell(_first_line(comment.get("body"))),
        ))
    return "\n".join(lines)


def _reviews_summary(obj):
    reviews = [r for r in _items(obj) if isinstance(r, dict)]
    lines = ["%d review%s" % (len(reviews), "" if len(reviews) == 1 else "s")]
    for review in reviews:
        lines.append("%s | %s | %s | %s" % (
            review.get("id", "?"),
            review.get("state", "?"),
            (review.get("user") or {}).get("login", "?"),
            _cell(_first_line(review.get("body"))),
        ))
    return "\n".join(lines)


def _files_summary(obj):
    files = [f for f in _items(obj) if isinstance(f, dict)]
    added = sum(int(f.get("additions") or 0) for f in files)
    removed = sum(int(f.get("deletions") or 0) for f in files)
    lines = ["%d file%s, +%d -%d" % (len(files), "" if len(files) == 1 else "s", added, removed)]
    for entry in files:
        name = entry.get("filename", "?")
        if entry.get("previous_filename"):
            name = "%s -> %s" % (entry["previous_filename"], name)
        lines.append("%s %s +%d -%d" % (entry.get("status", "?"), name, int(entry.get("additions") or 0), int(entry.get("deletions") or 0)))
    return "\n".join(lines)


def _commits_summary(obj):
    commits = [c for c in _items(obj) if isinstance(c, dict)]
    lines = ["%d commit%s" % (len(commits), "" if len(commits) == 1 else "s")]
    for commit in commits:
        info = commit.get("commit") or {}
        lines.append("%s | %s | %s" % (
            str(commit.get("sha", "?"))[:7],
            (commit.get("author") or {}).get("login") or (info.get("author") or {}).get("name", "?"),
            _cell(_first_line(info.get("message"))),
        ))
    return "\n".join(lines)


def _issue_line(issue):
    nwo = _nwo_of(issue.get("repository_url")) or _nwo_of(issue.get("html_url"))
    labels = ", ".join(label.get("name", "") for label in issue.get("labels") or [])
    return "%s#%s: %s [%s] %s%s" % (
        nwo,
        issue.get("number"),
        _first_line(issue.get("title"), 100),
        issue.get("state", "?") + (", pr" if issue.get("pull_request") else ""),
        (issue.get("user") or {}).get("login", "?"),
        " | labels: " + labels if labels else "",
    )


def _issue_lines(obj):
    issues = [i for i in (obj.get("items") if isinstance(obj, dict) else _items(obj)) or [] if isinstance(i, dict)]
    total = obj.get("total_count") if isinstance(obj, dict) else None
    head = "%d issue%s" % (len(issues), "" if len(issues) == 1 else "s")
    if total is not None and total != len(issues):
        head += " of %s" % total
    return "\n".join([head] + [_issue_line(i) for i in issues])


def _issue_detail(obj):
    issue = _first(obj) or {}
    body = (issue.get("body") or "").strip()
    return _issue_line(issue) + ("\n\n" + body if body else "") + "\n" + issue.get("html_url", "")


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
    "pr-lines": _pr_lines,
    "checks-summary": _checks_summary,
    "review-comments": _review_comments,
    "reviews-summary": _reviews_summary,
    "files-summary": _files_summary,
    "commits-summary": _commits_summary,
    "issue-lines": _issue_lines,
    "issue-detail": _issue_detail,
}

# What a read answers when no --format and no --json is given: the few lines its caller reads. A
# command not listed answers its object. `--json` (or `--format raw`) gives the full object.
DEFAULT_FORMATS = {
    "pr-get": "pr-lines",
    "pr-list": "pr-lines",
    "pr-checks": "checks-summary",
    "pr-threads": "thread-summary",
    "pr-comments": "review-comments",
    "pr-issue-comments": "issue-comments-summary",
    "pr-reviews": "reviews-summary",
    "pr-files": "files-summary",
    "pr-commits": "commits-summary",
    "issue-view": "issue-detail",
    "issue-list": "issue-lines",
    "issue-search": "issue-lines",
    "repo-review-comments": "review-comments",
}


def default_format(command, as_json):
    """The format a read takes when none is named."""
    return "raw" if as_json else DEFAULT_FORMATS.get(command, "raw")


def render(name, obj):
    if obj is None:
        return ""
    handler = _FORMATTERS.get(name)
    if handler is None:
        raise errors.UsageError(
            "unknown --format %r; known: %s" % (name, ", ".join(sorted(_FORMATTERS)))
        )
    return handler(obj)
