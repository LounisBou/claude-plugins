"""Pull request reads, plus opening and merging one."""

import base64
import binascii
import hashlib
import os
import re
import subprocess
import sys
import time
from urllib.parse import quote

from . import bodies, errors, fmt, http, meta, repo


def _current_branch():
    return subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True, check=False
    ).stdout.strip()


def auth_check(args):
    return http.rest("GET", "/user")


def pr_get(args):
    owner, name = repo.owner_repo()
    if args.pr is not None:
        if args.branch:
            raise errors.UsageError("pass either --pr or --branch, not both")
        try:
            pull = http.rest("GET", "/repos/%s/%s/pulls/%s" % (owner, name, args.pr))
        except errors.NotFound:
            raise errors.NotFound("no pull request #%s in %s/%s" % (args.pr, owner, name))
        # The same shape as for a branch, so every formatter reads both alike.
        return [pull]
    branch = args.branch or _current_branch()
    if not branch:
        raise errors.UsageError("cannot determine the branch; pass --branch")
    return http.rest(
        "GET", "/repos/%s/%s/pulls?head=%s:%s" % (owner, name, owner, quote(branch, safe=""))
    )


def pr_list(args):
    owner, name = repo.owner_repo()
    return http.rest("GET", "/repos/%s/%s/pulls?state=open" % (owner, name), paginate=True)


def pr_status(args):
    owner, name = repo.owner_repo()
    pull = http.rest("GET", "/repos/%s/%s/pulls/%s" % (owner, name, args.pr))
    if args.json or args.format:
        return pull
    # The few lines by default; the full pull request with --json, or under a --format that reads it.
    sha = (pull.get("head") or {}).get("sha") or ""
    statuses = http.rest("GET", "/repos/%s/%s/commits/%s/status" % (owner, name, sha))
    runs = http.rest("GET", "/repos/%s/%s/commits/%s/check-runs?per_page=100" % (owner, name, sha))
    workflows, suite_runs = _suite_workflows(owner, name, sha)
    args.format = "pr-summary"
    return {
        "pull": pull,
        "ci": fmt.gate_ci(
            statuses, (runs or {}).get("check_runs") or [], bool(pull.get("draft")), workflows, suite_runs,
            *_required_checks(owner, name, _base(pull)),
        ),
    }


def _suite_workflows(owner, name, sha):
    """The workflow of each check suite at a head, {suite id as a string: workflow
    id}, and its workflow run, {suite id as a string: run id}, from the Actions
    runs. (None, None) when the call fails: the gate then counts every run rather
    than guess which belong together."""
    try:
        data = http.rest("GET", "/repos/%s/%s/actions/runs?head_sha=%s&per_page=100" % (owner, name, sha))
    except errors.GhError as exc:
        print("error: cannot read the Actions runs of %s: %s" % (sha, exc.message), file=sys.stderr)
        return None, None
    except OSError as exc:
        print("error: cannot read the Actions runs of %s: %s" % (sha, exc), file=sys.stderr)
        return None, None
    placed = [
        run
        for run in (data or {}).get("workflow_runs") or []
        if run.get("check_suite_id") is not None and run.get("workflow_id") is not None
    ]
    workflows = {str(run["check_suite_id"]): run["workflow_id"] for run in placed}
    suite_runs = {str(run["check_suite_id"]): run.get("id") for run in placed}
    return workflows, suite_runs


def _required_checks(owner, name, base):
    """(contexts, unverified): the status check contexts the base branch requires, from its
    rulesets and its branch protection, read apart, and the reads that failed. A check GitHub
    has not created yet at a head is in neither list of runs, so only this names it. No contexts
    and nothing unverified when the pull request names no base. A failed read says why on stderr
    and is named in unverified, one entry per read: the gate never reads green over it, and the
    contexts the other read gave are kept."""
    if not base:
        return set(), []
    branch = quote(base, safe="")
    unverified = []

    def read(what, path, **kw):
        try:
            return http.rest("GET", "/repos/%s/%s/%s" % (owner, name, path), **kw)
        except (errors.GhError, OSError) as exc:
            why = exc.message if isinstance(exc, errors.GhError) else exc
            print("error: cannot read the checks %s requires: %s" % (base, why), file=sys.stderr)
            unverified.append("%s of %s: %s" % (what, base, why))
            return None

    rules = read("rulesets", "rules/branches/%s" % branch, paginate=True) or []
    protection = (read("branch protection", "branches/%s" % branch) or {}).get("protection") or {}
    required = set()
    for rule in rules:
        if isinstance(rule, dict) and rule.get("type") == "required_status_checks":
            checks = (rule.get("parameters") or {}).get("required_status_checks") or []
            required |= {c.get("context") for c in checks if isinstance(c, dict) and c.get("context")}
    status = protection.get("required_status_checks") or {}
    required |= {c for c in status.get("contexts") or [] if isinstance(c, str) and c}
    required |= {c.get("context") for c in status.get("checks") or [] if isinstance(c, dict) and c.get("context")}
    return required, unverified


def _base(pull):
    return (pull.get("base") or {}).get("ref") or ""


def _stacked(owner, name, pull):
    """Whether the pull request is stacked: its base is the head branch of another open pull request of
    the repository, and no long-lived branch: neither the default branch nor one under branch protection or a
    ruleset (main, develop, staging and their kind, which a release pull request heads too). A read that fails
    says why on stderr and reads as not stacked: the gate then asks what the bottom pull request needs, the most."""
    base = _base(pull)
    if not base or base == ((pull.get("base") or {}).get("repo") or {}).get("default_branch"):
        return False
    branch = quote(base, safe="")
    try:
        pulls = http.rest(
            "GET", "/repos/%s/%s/pulls?state=open&head=%s&per_page=100" % (owner, name, quote(owner + ":" + base, safe=""))
        )
        number = pull.get("number")
        if not any(isinstance(p, dict) and p.get("number") != number for p in pulls or []):
            return False
        if (http.rest("GET", "/repos/%s/%s/branches/%s" % (owner, name, branch)) or {}).get("protected"):
            return False
        return not (http.rest("GET", "/repos/%s/%s/rules/branches/%s" % (owner, name, branch), paginate=True) or [])
    except (errors.GhError, OSError) as exc:
        why = exc.message if isinstance(exc, errors.GhError) else exc
        print("error: cannot read whether %s is a stacked base: %s" % (base, why), file=sys.stderr)
        return False


def pr_checks(args):
    owner, name = repo.owner_repo()
    pull = http.rest("GET", "/repos/%s/%s/pulls/%s" % (owner, name, args.pr))
    sha = (pull.get("head") or {}).get("sha", "")
    statuses = http.rest("GET", "/repos/%s/%s/commits/%s/status" % (owner, name, sha))
    runs = http.rest("GET", "/repos/%s/%s/commits/%s/check-runs?per_page=100" % (owner, name, sha))
    workflows, suite_runs = _suite_workflows(owner, name, sha)
    required, unverified = _required_checks(owner, name, _base(pull))
    return {
        "statuses": statuses,
        "check_runs": runs.get("check_runs", []),
        "draft": bool(pull.get("draft")),
        "workflows": workflows,
        "workflow_runs": suite_runs,
        "required": sorted(required),
        "unverified": unverified,
    }


def pr_gate(args):
    owner, name = repo.owner_repo()
    try:
        pull = http.rest("GET", "/repos/%s/%s/pulls/%s" % (owner, name, args.pr))
    except errors.NotFound:
        raise errors.NotFound("no pull request #%s in %s/%s" % (args.pr, owner, name))
    sha = (pull.get("head") or {}).get("sha") or ""
    if not _FULL_SHA.fullmatch(sha):
        raise errors.ApiError("pull request %s has no head sha" % args.pr)
    statuses = http.rest("GET", "/repos/%s/%s/commits/%s/status" % (owner, name, sha))
    runs = http.rest("GET", "/repos/%s/%s/commits/%s/check-runs?per_page=100" % (owner, name, sha))
    workflows, suite_runs = _suite_workflows(owner, name, sha)
    state = "merged" if pull.get("merged_at") else pull.get("state", "")
    return {
        "repo": ("%s/%s" % (owner, name)).lower(),
        "pr": pull.get("number", args.pr),
        "state": state,
        "draft": bool(pull.get("draft")),
        "head": sha.lower(),
        "labels": [label.get("name", "") for label in pull.get("labels") or []],
        # The pull request's commit count at this head, read in the same answer as the head.
        "commits": pull.get("commits"),
        "base": _base(pull),
        "stacked": _stacked(owner, name, pull),
        "ci": fmt.gate_ci(
            statuses, (runs or {}).get("check_runs") or [], bool(pull.get("draft")), workflows, suite_runs,
            *_required_checks(owner, name, _base(pull)),
        ),
    }


# The most files GitHub lists for a commit on one page: a commit that reaches it may hold more.
_COMMIT_FILES_MAX = 300
# The most commits of a pull request read on one page: one that reaches it may hold more.
_PR_COMMITS_MAX = 100
_HUNK_HEADER = re.compile(r"^@@ [^@]* @@.*$", re.M)


def diff_fingerprint(files):
    """The fingerprint of one commit's diff, as GitHub lists its files: the same diff gives the
    same value wherever its hunks stand and in whatever order its files come, as
    `git patch-id --stable` does, but whitespace counts. A file whose patch GitHub leaves out
    (a binary, a diff too large) counts by its blob. None when it changes no file."""
    parts = []
    for entry in files:
        patch = entry.get("patch")
        body = _HUNK_HEADER.sub("@@", patch) if isinstance(patch, str) else "blob " + str(entry.get("sha") or "")
        head = "%s %s %s" % (entry.get("status") or "", entry.get("previous_filename") or "", entry.get("filename") or "")
        parts.append(hashlib.sha256((head + "\n" + body).encode("utf-8")).hexdigest())
    if not parts:
        return None
    return hashlib.sha256("\n".join(sorted(parts)).encode("utf-8")).hexdigest()


def pr_fingerprint(args):
    """The fingerprint of the pull request's own commits at a head: the k commits ending at that
    head along first parents, k the pull request's commit count (or --count), each by its diff,
    in order. A rewrite below them (a rebase, a parent branch rewritten) leaves it as it is."""
    if not _FULL_SHA.fullmatch(args.head):
        raise errors.UsageError("the head must be the full 40-character sha, got: %s" % args.head)
    owner, name = repo.owner_repo()
    count = args.count
    if count is None:
        commits = http.rest("GET", "/repos/%s/%s/pulls/%s/commits?per_page=%d" % (owner, name, args.pr, _PR_COMMITS_MAX))
        count = len(commits) if isinstance(commits, list) else 0
        if count >= _PR_COMMITS_MAX:
            raise errors.ApiError("pull request %s has %d commits or more" % (args.pr, _PR_COMMITS_MAX))
    if not 0 < count < _PR_COMMITS_MAX:
        raise errors.ApiError("pull request %s counts %d commits" % (args.pr, count))
    prints = []
    sha = args.head.lower()
    for _ in range(count):
        if not sha:
            raise errors.ApiError("%s has fewer than %d commits along its first parents" % (args.head[:7], count))
        commit = http.rest("GET", "/repos/%s/%s/commits/%s" % (owner, name, sha))
        parents = [p.get("sha", "") for p in commit.get("parents") or []] if isinstance(commit, dict) else []
        files = commit.get("files") if isinstance(commit, dict) else None
        if not isinstance(files, list):
            raise errors.ApiError("commit %s lists no files" % sha[:7])
        if len(parents) > 1:
            raise errors.ApiError("commit %s is a merge" % sha[:7])
        if len(files) >= _COMMIT_FILES_MAX:
            raise errors.ApiError("commit %s reaches %d files, more may be left out" % (sha[:7], len(files)))
        prints.append(diff_fingerprint(files) or "empty")
        sha = parents[0].lower() if parents else ""
    fingerprint = hashlib.sha256("\n".join(reversed(prints)).encode("utf-8")).hexdigest()
    return {"head": args.head.lower(), "commits": count, "fingerprint": fingerprint}


def pr_diff(args):
    owner, name = repo.owner_repo()
    result = http.rest(
        "GET",
        "/repos/%s/%s/pulls/%s" % (owner, name, args.pr),
        accept="application/vnd.github.v3.diff",
    )
    # A diff media type always answers in plain text. Anything else means the
    # response was not what was asked for, and an empty diff would read as
    # "no changes" rather than as a failure.
    if not isinstance(result, str):
        raise errors.ApiError("expected a plain-text diff, got %s" % type(result).__name__)
    return {"diff": result}


def pr_files(args):
    owner, name = repo.owner_repo()
    return http.rest("GET", "/repos/%s/%s/pulls/%s/files" % (owner, name, args.pr), paginate=True)


def pr_commits(args):
    owner, name = repo.owner_repo()
    return http.rest("GET", "/repos/%s/%s/pulls/%s/commits" % (owner, name, args.pr), paginate=True)


def file_at_ref(args):
    owner, name = repo.owner_repo()
    data = http.rest(
        "GET",
        "/repos/%s/%s/contents/%s?ref=%s"
        % (owner, name, quote(args.path, safe="/"), quote(args.ref, safe="")),
    )
    # A directory path makes this endpoint answer with a JSON array, not an object.
    if not isinstance(data, dict):
        raise errors.UsageError("%s is a directory, not a file" % args.path)

    raw = data.get("content") or ""
    binary = False
    if data.get("encoding") == "base64":
        try:
            payload = base64.b64decode(raw)
        except (ValueError, binascii.Error) as exc:
            raise errors.ApiError("cannot decode %s: %s" % (args.path, exc))
        try:
            raw = payload.decode("utf-8")
        except UnicodeDecodeError:
            # Do not decode with "replace": that turns a binary file into
            # replacement characters, exits 0 and looks like a successful read
            # while the content is destroyed. Hand back the base64 and say so.
            raw = base64.b64encode(payload).decode("ascii")
            binary = True
    return {"path": args.path, "ref": args.ref, "content": raw, "binary": binary}


def pr_create(args):
    owner, name = repo.owner_repo()
    payload = {
        "title": args.title,
        "head": args.head or _current_branch(),
        "base": args.base,
        "body": bodies.read(args.body_file) if args.body_file else "",
    }
    if not payload["head"]:
        raise errors.UsageError("cannot determine the head branch; pass --head")
    if args.draft:
        payload["draft"] = True
    created = http.rest("POST", "/repos/%s/%s/pulls" % (owner, name), payload)
    # A new pull request has no record at its head, so it is never ready: Not Ready, draft or not.
    if isinstance(created, dict) and created.get("number"):
        meta.follow_readiness(owner, name, created["number"], "not-ready")
    return created


_MERGE_POLL = 3
_FULL_SHA = re.compile(r"[0-9a-fA-F]{40}")
# What pr-merge --sha takes: exactly the 40 hex characters of a head, no trailing newline.
_MERGE_SHA = re.compile(r"[0-9a-fA-F]{40}")


def pr_merge(args):
    owner, name = repo.owner_repo()
    payload = {"merge_method": args.method}
    if args.sha:
        # A short or malformed sha would come back from GitHub as a moved head,
        # which reads as a race rather than as a typo.
        if not _MERGE_SHA.fullmatch(args.sha):
            raise errors.UsageError("--sha must be the full 40-character head sha")
        payload["sha"] = args.sha
    try:
        return http.rest("PUT", "/repos/%s/%s/pulls/%s/merge" % (owner, name, args.pr), payload)
    except errors.AuthError as exc:
        # GitHub answers 403 for a PR that is part of a stack and names the
        # asynchronous endpoint. That refusal is the only one followed: any
        # other 403 is a real refusal and surfaces as it is.
        if not _is_stacked_refusal(exc):
            raise
    return _merge_async(owner, name, args.pr, payload)


def _is_stacked_refusal(exc):
    text = exc.message.lower()
    return "stacked" in text and "asynchronous merge" in text


def _merge_wait():
    raw = os.environ.get("GH_MERGE_WAIT", "60")
    try:
        seconds = float(raw)
    except ValueError:
        seconds = -1
    if seconds < 0:
        raise errors.UsageError("GH_MERGE_WAIT must be a number of seconds, got %r" % raw)
    return seconds


def _async_state(base, uuid):
    try:
        status = http.rest("GET", "%s/merge-async/%s" % (base, uuid))
    except errors.GhError:
        # The status read is a shortcut to an early failure, not the authority:
        # the PR's own merged_at decides, so a status that does not answer, or
        # answers with any error, leaves the wait to the PR and its timeout.
        return None
    return status.get("status") if isinstance(status, dict) else None


def _merge_async(owner, name, number, payload):
    wait = _merge_wait()
    base = "/repos/%s/%s/pulls/%s" % (owner, name, number)
    accepted = http.rest("PUT", base + "/merge-async", payload)
    details = accepted.get("details") if isinstance(accepted, dict) else None
    uuid = details.get("uuid") if isinstance(details, dict) else None
    if not uuid:
        raise errors.ApiError(
            "merge-async did not return a uuid under details; read the PR with pr-status %s" % number
        )

    deadline = time.monotonic() + wait
    while True:
        pull = http.rest("GET", base)
        if pull.get("merged_at"):
            return {
                "merged": True,
                "sha": pull.get("merge_commit_sha"),
                "message": "Pull Request merged asynchronously",
                "uuid": uuid,
            }
        if _async_state(base, uuid) == "failed":
            raise errors.ApiError("the asynchronous merge failed (uuid %s)" % uuid)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise errors.ApiError(
                "timed out after %g seconds without seeing PR %s merged (uuid %s); "
                "read it with pr-status %s" % (wait, number, uuid, number)
            )
        time.sleep(min(_MERGE_POLL, remaining))


def register(subparsers):
    parser = subparsers.add_parser("auth-check", help="verify the token works")
    parser.set_defaults(handler=auth_check)

    parser = subparsers.add_parser("pr-get", help="get the PR for a branch, or by its number")
    parser.add_argument("--branch", default=None, help="defaults to the current branch")
    parser.add_argument("--pr", type=int, default=None, help="the PR's number, in place of a branch")
    parser.set_defaults(handler=pr_get)

    parser = subparsers.add_parser("pr-list", help="list open PRs")
    parser.set_defaults(handler=pr_list)

    parser = subparsers.add_parser("pr-status", help="get PR state")
    parser.add_argument("pr", type=int)
    parser.set_defaults(handler=pr_status)

    parser = subparsers.add_parser("pr-gate", help="state, head, labels and CI, as the ready guard reads them")
    parser.add_argument("pr", type=int)
    parser.set_defaults(handler=pr_gate)

    parser = subparsers.add_parser("pr-fingerprint", help="the fingerprint of the pull request's own commits at a head")
    parser.add_argument("pr", type=int)
    parser.add_argument("head")
    parser.add_argument("--count", type=int, default=None, help="the commits to take, by default the pull request's")
    parser.set_defaults(handler=pr_fingerprint)

    parser = subparsers.add_parser("pr-checks", help="combined status and check runs")
    parser.add_argument("pr", type=int)
    parser.set_defaults(handler=pr_checks)

    for cmd, handler in (("pr-diff", pr_diff), ("pr-files", pr_files), ("pr-commits", pr_commits)):
        parser = subparsers.add_parser(cmd)
        parser.add_argument("pr", type=int)
        parser.set_defaults(handler=handler)

    parser = subparsers.add_parser("file-at-ref", help="read a file at a ref")
    parser.add_argument("path")
    parser.add_argument("ref")
    parser.set_defaults(handler=file_at_ref)

    parser = subparsers.add_parser("pr-create", help="open a PR from the current branch")
    parser.add_argument("--title", required=True)
    parser.add_argument("--body-file", dest="body_file", default=None)
    parser.add_argument("--base", default="main")
    parser.add_argument("--head", default=None, help="defaults to the current branch")
    parser.add_argument("--draft", action="store_true", help="open as a draft (the house default)")
    parser.set_defaults(handler=pr_create)

    parser = subparsers.add_parser("pr-merge", help="merge a PR")
    parser.add_argument("pr", type=int)
    parser.add_argument("--method", default="merge", choices=("merge", "squash", "rebase"))
    parser.add_argument(
        "--sha", default=None, help="full head sha that was verified; the merge is refused if the head moved"
    )
    parser.set_defaults(handler=pr_merge)
