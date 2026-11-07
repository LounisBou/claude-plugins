#!/usr/bin/env python3
"""Triage a PR's open comments in one run: what is open, who replied last,
how much work remains, and which protocol tier that calls for.

Two ways in, one document out:

  triage.py --gh <path to the github plugin's engine/gh.py> [--pr N]
      fetches everything itself through the engine's command line (the route
      for a session where the github tool is not listed);

  triage.py --stdin
      reads the fetched responses as one JSON object on stdin (the route the
      plugin's module takes after fetching them through the github tool):
      {"pr": <pr-get or pr-status raw>, "issue_comments": [...],
       "reviews": [...], "threads": [...open-threads...],
       "issue_resolved": {...}, "reviews_resolved": {...}}

The document is JSON on stdout. A failure prints one `error:` line on stderr
and exits 1, never a traceback.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile


class TriageError(Exception):
    """A failure with its own message, printed as an `error:` line."""


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise TriageError(message)


# ── the pure part ─────────────────────────────────────────────────────────────

IMAGE_HOSTS = ("user-images.githubusercontent.com", "github.com/user-attachments")
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp")
URL = re.compile(r"https?://\S+")


def _list(value):
    return value if isinstance(value, list) else []


def _dict(value):
    return value if isinstance(value, dict) else {}


def pr_record(pr_raw):
    """pr-get answers a list (the PRs of the branch), pr-status one object."""
    if isinstance(pr_raw, list):
        return _dict(pr_raw[0]) if pr_raw else {}
    return _dict(pr_raw)


def is_minimized(node_id, resolved):
    # ".get" substitutes its default only for an ABSENT key: an id the batch
    # could not resolve comes back with "node": null, guarded like a missing one.
    entry = _dict(resolved.get(node_id)) if node_id else {}
    return bool(_dict(entry.get("node")).get("isMinimized"))


def images_of(body):
    urls = []
    for url in URL.findall(body or ""):
        url = url.rstrip(".,)")
        if url.lower().endswith(IMAGE_EXTS) or any(host in url for host in IMAGE_HOSTS):
            urls.append(url)
    return list(dict.fromkeys(urls))


def last_author(thread):
    nodes = _list(_dict(thread.get("comments")).get("nodes"))
    if not nodes:
        return ""
    # GitHub's GraphQL API sends "author": null for a deleted account.
    return _dict(_dict(nodes[-1]).get("author")).get("login", "") or ""


def first_comment(thread):
    nodes = _list(_dict(thread.get("comments")).get("nodes"))
    return _dict(nodes[0]) if nodes else {}


def tier_of(pending):
    if pending == 0:
        return "EXIT"
    return "FAST" if pending <= 2 else "FULL"


def triage(data):
    """The triage document for one PR, from the fetched responses."""
    pr = pr_record(data.get("pr"))
    number = pr.get("number")
    login = _dict(pr.get("user")).get("login", "") or ""
    if not number:
        return {"pr": None, "error": "no open pull request for this branch"}

    issue_resolved = _dict(data.get("issue_resolved"))
    reviews_resolved = _dict(data.get("reviews_resolved"))

    items = []
    auto_passed = 0
    for thread in _list(data.get("threads")):
        thread = _dict(thread)
        if thread.get("isResolved"):
            continue
        first = first_comment(thread)
        passed = bool(login) and last_author(thread) == login
        auto_passed += passed
        items.append({
            "type": "review-thread",
            "id": thread.get("id"),
            "path": thread.get("path"),
            "line": thread.get("line"),
            "author": _dict(first.get("author")).get("login", ""),
            "body": first.get("body") or "",
            "auto_passed": passed,
            "last_reply": (_dict(_list(_dict(thread.get("comments")).get("nodes"))[-1]).get("body") or "") if passed else None,
        })

    for comment in _list(data.get("issue_comments")):
        comment = _dict(comment)
        if is_minimized(comment.get("node_id"), issue_resolved):
            continue
        items.append({
            "type": "issue-comment",
            "id": comment.get("id"),
            "node_id": comment.get("node_id"),
            "author": _dict(comment.get("user")).get("login", ""),
            "body": comment.get("body") or "",
            "images": images_of(comment.get("body")),
            "auto_passed": False,
        })

    for review in _list(data.get("reviews")):
        review = _dict(review)
        # GitHub sends "body": null for a review with no text and "user": null
        # for a deleted account; the PR author's own reviews are not comments to
        # answer, and a review minimized on GitHub is resolved.
        if not (review.get("body") or "").strip():
            continue
        if (_dict(review.get("user")).get("login", "") or "") == login:
            continue
        if is_minimized(review.get("node_id"), reviews_resolved):
            continue
        items.append({
            "type": "review-body",
            "id": review.get("node_id"),
            "state": review.get("state"),
            "author": _dict(review.get("user")).get("login", ""),
            "body": review.get("body") or "",
            "auto_passed": False,
        })

    counts = {
        "review_threads": sum(1 for i in items if i["type"] == "review-thread" and not i["auto_passed"]),
        "issue_comments": sum(1 for i in items if i["type"] == "issue-comment"),
        "review_bodies": sum(1 for i in items if i["type"] == "review-body"),
        "auto_passed": auto_passed,
    }
    pending = counts["review_threads"] + counts["issue_comments"] + counts["review_bodies"]
    return {
        "pr": number,
        "title": pr.get("title") or "",
        "url": pr.get("html_url") or "",
        "description": pr.get("body") or "",
        "author": login,
        "pending": pending,
        "tier": tier_of(pending),
        "counts": counts,
        "announce": "PR #%s — %d open comment(s): %d review thread(s), %d issue comment(s), %d review body comment(s)."
        % (number, pending, counts["review_threads"], counts["issue_comments"], counts["review_bodies"]),
        "paths": sorted({i["path"] for i in items if i["type"] == "review-thread" and i.get("path")}),
        "items": items,
    }


# ── the fetching route ────────────────────────────────────────────────────────

def _gh(gh, *argv):
    try:
        run = subprocess.run(
            [sys.executable, gh] + list(argv), capture_output=True, timeout=120, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise TriageError("cannot run %s: %s" % (gh, exc))
    try:
        out = run.stdout.decode("utf-8")
        err = run.stderr.decode("utf-8")
    except UnicodeDecodeError:
        raise TriageError("gh.py %s wrote output that is not UTF-8" % argv[0])
    if run.returncode != 0:
        raise TriageError("gh.py %s exited %d: %s" % (argv[0], run.returncode, err.strip()))
    try:
        return json.loads(out) if out.strip() else None
    except ValueError:
        raise TriageError("gh.py %s did not answer JSON" % argv[0])


def _resolved(gh, ids, tmpdir, name):
    if not ids:
        return {}
    path = os.path.join(tmpdir, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(ids, fh)
    return _dict(_gh(gh, "comments-resolved-batch", path))


def fetch(gh, pr=None):
    if not os.path.isfile(gh):
        raise TriageError("not a file: %s" % gh)
    pr_raw = _gh(gh, "pr-status", str(pr)) if pr else _gh(gh, "pr-get")
    number = pr_record(pr_raw).get("number")
    data = {"pr": pr_raw}
    if not number:
        return data
    data["issue_comments"] = _list(_gh(gh, "pr-issue-comments", str(number)))
    data["reviews"] = _list(_gh(gh, "pr-reviews", str(number)))
    data["threads"] = _list(_gh(gh, "pr-threads", str(number), "--format", "open-threads"))
    with tempfile.TemporaryDirectory(prefix="pr-review-triage-") as tmpdir:
        data["issue_resolved"] = _resolved(
            gh, [c.get("node_id") for c in data["issue_comments"] if _dict(c).get("node_id")], tmpdir, "issues.json"
        )
        data["reviews_resolved"] = _resolved(
            gh, [r.get("node_id") for r in data["reviews"] if _dict(r).get("node_id")], tmpdir, "reviews.json"
        )
    return data


def main(argv):
    parser = _Parser(prog="triage.py")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--gh", help="path to the github plugin's engine/gh.py")
    source.add_argument("--stdin", action="store_true", help="read the fetched responses on stdin")
    parser.add_argument("--pr", type=int, default=None)
    try:
        args = parser.parse_args(argv)
        if args.stdin:
            try:
                data = json.loads(sys.stdin.read())
            except ValueError as exc:
                raise TriageError("stdin is not valid JSON: %s" % exc)
            if not isinstance(data, dict):
                raise TriageError("stdin must hold a JSON object")
        else:
            data = fetch(args.gh, args.pr)
        sys.stdout.write(json.dumps(triage(data), indent=2, ensure_ascii=False) + "\n")
        return 0
    except TriageError as exc:
        sys.stderr.write("error: %s\n" % exc)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
