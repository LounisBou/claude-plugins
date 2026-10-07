#!/usr/bin/env python3
"""draft_guard.py: which failing checks of a draft pull request are draft guards.

    draft_guard.py <owner/repo> <pr>

Some repositories run a job that fails on purpose while a pull request is a draft (a draft
guard). A failing check of a DRAFT pull request is one when the job that produced it tests
the draft flag (`pull_request.draft`) in its own definition. The stop gate and `ci-watch.sh`
read a red that is no red otherwise; no repository is named anywhere, and every other red of a
draft is still reported.

As a command: reads `isDraft`, then prints the failing check names (bucket `fail` or `cancel`)
that are NOT draft guards, one per line; a pull request that is not a draft prints every
failing name. Exit 0, or 5 with one line on stderr when `gh` fails.

As a module: `guards(repo, checks, cache_dir, gh)` returns the names of the failing checks
(bucket `fail`) of a draft pull request that are draft guards. `checks` is what
`gh pr checks --json name,bucket,link` returns; `gh` is a callable taking the argument list
and returning stdout, raising when `gh` fails. Per check: the run id of its link
(`/actions/runs/<run>/job/<job>`), the run's workflow path and head sha, that file at that
sha, the job named by the check's first segment (`a / b` reads `a`), and, when that job is
`uses: ./.github/workflows/<file>` (a local reusable workflow), the called file at the same
sha and its job named by the second segment. A job is a guard when its own block, the called
job's block for a reusable one, contains `pull_request.draft`. Anything unread, unmatched or
unparseable is NOT a guard: the default is the red reported, never a red lost.

The workflow files are read without a YAML library (the plugin ships no dependency): `jobs:`
at the left margin, then one key per job at the first indentation below it, a job's block
running to the next key of that indentation.

The cache lives in `cache_dir`, one file per repository, workflow path and head sha holding
the verdict per check name, so a head already classified costs no call; a run is bound to its
path and sha for good, and that binding is kept too (without it the run would be read again
to learn which entry to open). Entries older than seven days are removed whenever one is
written. A verdict that could not be read is never kept.
"""

import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from urllib.parse import quote

STATE_DIR = os.environ.get("ORCHESTRATOR_STATE_DIR") or os.path.join(
    os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude"),
    "claude-orchestrator",
)
CACHE_DIR = os.path.join(STATE_DIR, "draft-guard")
CACHE_MAX_AGE = 7 * 24 * 3600
CALL_TIMEOUT = 30
DRAFT_TEST = "pull_request.draft"
LINK_RUN = re.compile(r"/actions/runs/(\d+)(?:/|$)")
LOCAL_WORKFLOW = re.compile(r"^\./(\.github/workflows/[^/\s]+\.ya?ml)$")
SEGMENT_SEPARATOR = " / "


class Unread(Exception):
    """A read that failed: the caller treats the check as no guard."""


def run_gh(argv, tolerated=()):
    """stdout of `gh <argv>`; Unread when it cannot run or exits non-zero. `gh pr checks` exits
    1 on failing checks and 8 on pending ones, so for it the exit code alone is no error: the
    exit codes in `tolerated` are not, when they come with an answer."""
    try:
        done = subprocess.run(["gh"] + list(argv), capture_output=True, text=True,
                              timeout=CALL_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Unread("gh cannot run: %s" % exc)
    if done.returncode == 0 or (done.returncode in tolerated and done.stdout.strip()):
        return done.stdout
    why = (done.stderr.strip().splitlines() or ["no answer"])[0]
    if "no checks reported" in why:
        return "[]"
    raise Unread("gh %s failed: %s" % (" ".join(argv[:2]), why))


# --- the workflow file, read without a YAML library ----------------------------------------

def _indent(line):
    return len(line) - len(line.lstrip(" "))


def _content(line):
    """The line without its trailing comment; blank when it is only one."""
    quote_char = None
    for n, char in enumerate(line):
        if quote_char:
            quote_char = None if char == quote_char else quote_char
        elif char in "'\"":
            quote_char = char
        elif char == "#" and (n == 0 or line[n - 1] in " \t"):
            return line[:n].rstrip()
    return line.rstrip()


def _unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def jobs_of(text):
    """{job id: block lines} of a workflow file: the lines of each job under `jobs:`, comment
    lines left out."""
    lines = [_content(l) for l in text.splitlines()]
    start = next((n for n, l in enumerate(lines) if re.match(r"^jobs\s*:\s*$", l)), None)
    if start is None:
        return {}
    jobs, key_indent, current = {}, None, None
    for line in lines[start + 1:]:
        if not line.strip():
            continue
        depth = _indent(line)
        if depth == 0:
            break  # the next top-level key: `jobs:` is over
        if key_indent is None:
            key_indent = depth
        if depth == key_indent:
            match = re.match(r"^\s*([^\s:#][^:]*?)\s*:", line)
            current = _unquote(match.group(1)) if match else None
            if current is not None:
                jobs[current] = [line]
        elif depth > key_indent and current is not None:
            jobs[current].append(line)
    return jobs


def field(block, name):
    """The value of a direct child key (`name:`, `uses:`) of a job block, or None."""
    if len(block) < 2:
        return None
    child = next((_indent(l) for l in block[1:] if l.strip()), None)
    for line in block[1:]:
        if _indent(line) != child:
            continue
        match = re.match(r"^\s*%s\s*:\s*(.*)$" % re.escape(name), line)
        if match:
            return _unquote(match.group(1))
    return None


def find_job(jobs, wanted):
    """The block of the job whose id, or whose `name:`, is `wanted`; None when no job is."""
    if wanted in jobs:
        return jobs[wanted]
    for block in jobs.values():
        if field(block, "name") == wanted:
            return block
    return None


def tests_draft(block):
    return any(DRAFT_TEST in line for line in block)


def classify(name, read_file, path):
    """Is the check `name`, produced by a job of the workflow file `path`, a draft guard?
    `read_file(path)` returns a workflow file's text, or raises Unread."""
    segments = name.split(SEGMENT_SEPARATOR)
    block = find_job(jobs_of(read_file(path)), segments[0].strip())
    if block is None:
        return False
    uses = field(block, "uses")
    if uses is None:
        return tests_draft(block)
    local = LOCAL_WORKFLOW.match(uses)
    if not local or len(segments) < 2:
        return False
    called = find_job(jobs_of(read_file(local.group(1))), segments[1].strip())
    return called is not None and tests_draft(called)


# --- the cache -------------------------------------------------------------------------------

def _entry_path(cache_dir, kind, *parts):
    digest = hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()[:40]
    return os.path.join(cache_dir, "%s-%s.json" % (kind, digest))


def _load(path):
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _prune(cache_dir):
    cutoff = time.time() - CACHE_MAX_AGE
    for entry in os.listdir(cache_dir):
        full = os.path.join(cache_dir, entry)
        try:
            if os.path.isfile(full) and os.path.getmtime(full) < cutoff:
                os.remove(full)
        except OSError:
            pass


def _store(cache_dir, path, data):
    """Written whole and renamed in place; a cache that cannot be written is no cache."""
    try:
        os.makedirs(cache_dir, exist_ok=True)
        _prune(cache_dir)
        with open(path + ".tmp", "w") as fh:
            json.dump(data, fh)
        os.replace(path + ".tmp", path)
    except OSError:
        pass


# --- reading a check -------------------------------------------------------------------------

def run_of(link):
    match = LINK_RUN.search(link or "")
    return match.group(1) if match else None


def _api_json(gh, url):
    try:
        out = gh(["api", url])
        data = json.loads(out)
    except Unread:
        raise
    except Exception as exc:  # an injected gh may raise anything
        raise Unread("gh api %s failed: %s" % (url, exc))
    if not isinstance(data, dict):
        raise Unread("gh api %s: no object" % url)
    return data


def read_run(repo, run, cache_dir, gh):
    """(workflow path, head sha) of a run: a run never changes, so it is kept for good."""
    slot = _entry_path(cache_dir, "run", repo, run)
    kept = _load(slot)
    if kept.get("path") and kept.get("sha"):
        return kept["path"], kept["sha"]
    data = _api_json(gh, "repos/%s/actions/runs/%s" % (repo, run))
    path, sha = data.get("path"), data.get("head_sha")
    if not isinstance(path, str) or not isinstance(sha, str) or not path or not sha:
        raise Unread("run %s: no path or head sha" % run)
    path = path.split("@", 1)[0]  # a run of a reusable workflow may read `<path>@<ref>`
    _store(cache_dir, slot, {"path": path, "sha": sha})
    return path, sha


def read_file(repo, path, sha, gh):
    url = "repos/%s/contents/%s?ref=%s" % (repo, quote(path, safe="/"), quote(sha, safe=""))
    data = _api_json(gh, url)
    try:
        return base64.b64decode(data["content"]).decode("utf-8")
    except (KeyError, TypeError, ValueError):
        raise Unread("%s at %s: no readable content" % (path, sha))


def guards(repo, checks, cache_dir, gh):
    """The names of the failing checks (bucket `fail`) of a draft pull request that are draft
    guards. Anything unread, unmatched or unparseable is not one."""
    found = set()
    texts = {}

    def read_once(path, sha):
        if (path, sha) not in texts:
            texts[(path, sha)] = read_file(repo, path, sha, gh)
        return texts[(path, sha)]

    for check in checks if isinstance(checks, list) else []:
        try:
            if check.get("bucket") != "fail":
                continue
            name = check.get("name")
            run = run_of(check.get("link"))
            if not name or not run:
                continue
            path, sha = read_run(repo, run, cache_dir, gh)
            slot = _entry_path(cache_dir, "workflow", repo, path, sha)
            verdicts = _load(slot)
            if name not in verdicts:
                verdict = classify(name, lambda p: read_once(p, sha), path)
                verdicts[name] = verdict
                _store(cache_dir, slot, verdicts)
            if verdicts[name] is True:
                found.add(name)
        except Exception:  # unread, unmatched, unparseable: the red is reported
            continue
    return found


# --- the command -----------------------------------------------------------------------------

def failing_names(checks):
    return [c["name"] for c in checks if c.get("bucket") in ("fail", "cancel") and c.get("name")]


def main(argv):
    if len(argv) != 2 or "/" not in argv[0] or not argv[1].isdigit():
        print("usage: draft_guard.py <owner/repo> <pr>", file=sys.stderr)
        return 5
    repo, pr = argv
    try:
        draft = json.loads(run_gh(["pr", "view", pr, "-R", repo, "--json", "isDraft"]))["isDraft"]
        checks = json.loads(run_gh(["pr", "checks", pr, "-R", repo, "--json", "name,bucket,link"],
                                      tolerated=(1, 8)))
    except Unread as exc:
        print("draft_guard: %s" % exc, file=sys.stderr)
        return 5
    except (ValueError, KeyError, TypeError):
        print("draft_guard: gh answered with something else than the expected JSON", file=sys.stderr)
        return 5
    dropped = guards(repo, checks, CACHE_DIR, lambda a: run_gh(a)) if draft is True else set()
    for name in failing_names(checks):
        if name not in dropped:
            print(name)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
