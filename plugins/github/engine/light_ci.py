#!/usr/bin/env python3
"""The light CI of a stacked pull request, as REFERENCE.md « Light CI » describes it.

run --pr N: from a clean checkout of the pull request's head, runs the repository's
`prepare` then `command` (argument lists, no shell, each under its timeout) as its
project file declares them, and writes the tests record of the command's exit code at
that head (record.py, producer light-ci), once its status is on the forge. status: what the project file holds; with no file,
the repository has no light CI.

The project file is ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/light-ci/<owner>-<name>.json:
{"command": [...], "prepare": [...], "timeoutSeconds": 600, "decided": {"at", "words"}},
or {"off": "<the operator's words>", "at": "<when>"}. `{base}` in a word stands for the
merge base of the pull request's base and its head.

Each answer is one line on stdout. Exit 0: run wrote its record (pass or fail), status
answered; 1: nothing written, one error: line on stderr; 2: a usage error.
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import record  # noqa: E402
from ghlib import errors, forge, http, repo  # noqa: E402

PRODUCER = record.SCRIPTED["producer"]
KIND = record.SCRIPTED["kind"]
USAGE_EXIT = 2
DEFAULT_TIMEOUT = 600
MAX_TIMEOUT = 3600
GIT_TIMEOUT = 60
BASE = "{base}"
_SHA = re.compile(r"^[0-9a-f]{40}$")


class Failure(Exception):
    """Nothing is written: the one error line to print."""


class _Parser(argparse.ArgumentParser):
    def __init__(self, *args, **kwargs):
        kwargs.setdefault("allow_abbrev", False)
        super().__init__(*args, **kwargs)

    def error(self, message):
        raise record.UsageError(message)


def build_parser():
    parser = _Parser(prog="light_ci.py", description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    run = sub.add_parser("run", help="run the repository's command and record its tests at the head")
    run.add_argument("--pr", required=True, type=int)
    run.add_argument("--repo", help="owner/name, overriding the origin remote")
    run.add_argument("--session", default=None, help="defaults to CLAUDE_CODE_SESSION_ID")
    run.add_argument("--budget", type=int, default=None,
                     help="seconds the whole run may take (the tool's host limit); a run it cuts records nothing")
    status = sub.add_parser("status", help="what the repository's project file holds")
    status.add_argument("--repo", help="owner/name, overriding the origin remote")
    return parser


# ---- the project file ----

def config_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def project_path(owner, name):
    return os.path.join(config_dir(), "light-ci", "%s-%s.json" % (owner.lower(), name.lower()))


def _argv(value, key):
    if not isinstance(value, list) or not value or not all(isinstance(w, str) and w for w in value):
        raise Failure("%s is a non-empty list of words, got: %s" % (key, json.dumps(value)))
    return value


def read_project(path):
    """("missing", None), ("off", {words, at}), ("configured", {command, prepare, timeout, decided}), or a
    Failure naming what in the file breaks the format."""
    if not os.path.exists(path):
        return "missing", None
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        raise Failure("cannot read %s: %s" % (path, exc))
    if not isinstance(data, dict):
        raise Failure("%s holds no object" % path)
    if isinstance(data.get("off"), str) and data["off"].strip():
        return "off", {"words": data["off"].strip(), "at": str(data.get("at") or "undated")}
    if "command" not in data:
        raise Failure("%s holds neither command nor off" % path)
    command = _argv(data["command"], "command")
    prepare = _argv(data["prepare"], "prepare") if data.get("prepare") is not None else None
    timeout = data.get("timeoutSeconds", DEFAULT_TIMEOUT)
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 0 < timeout <= MAX_TIMEOUT:
        raise Failure("timeoutSeconds is a whole number of seconds from 1 to %d, got: %s" % (MAX_TIMEOUT, json.dumps(timeout)))
    decided = data.get("decided") if isinstance(data.get("decided"), dict) else {}
    return "configured", {"command": command, "prepare": prepare, "timeout": timeout, "decided": decided}


# ---- git ----

def git(*args):
    try:
        done = subprocess.run(["git"] + list(args), capture_output=True, text=True, timeout=GIT_TIMEOUT, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Failure("git %s failed: %s" % (" ".join(args), exc))
    return done.returncode, done.stdout.strip(), done.stderr.strip()


def local_head():
    code, out, err = git("rev-parse", "HEAD")
    if code != 0 or not _SHA.match(out.lower()):
        raise Failure("the checkout has no commit to read: %s" % (err or "git rev-parse HEAD exited %d" % code))
    return out.lower()


def clean_tree():
    code, out, err = git("status", "--porcelain", "-uno")
    if code != 0:
        raise Failure("git status failed: %s" % (err or "exit %d" % code))
    return out == ""


def merge_base(base):
    """The merge base of origin/<base> and HEAD, origin/<base> fetched first when it can be."""
    git("fetch", "--quiet", "origin", base)
    code, out, err = git("merge-base", "origin/" + base, "HEAD")
    if code != 0 or not _SHA.match(out.lower()):
        raise Failure("no merge base of origin/%s and HEAD: %s" % (base, err or "exit %d" % code))
    return out.lower()


# ---- running ----

def substituted(words, base_sha):
    return [w.replace(BASE, base_sha) if base_sha else w for w in words]


def execute(words, timeout, log):
    """(exit code or None on a timeout, seconds): the words run as a program, no shell, its output to the log.
    The program leads a session of its own, so a timeout ends it and every process it started, not the program
    alone (npm, pest --parallel and docker leave children behind)."""
    started = time.monotonic()
    try:
        proc = subprocess.Popen(words, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    except OSError as exc:
        raise Failure("cannot run %s: %s" % (words[0], exc))
    try:
        code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        code = None
    finally:
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                proc.kill()
            proc.wait()
    return code, time.monotonic() - started


# The test counts runners print, the most specific first: Pest and PHPUnit, Jest and Vitest, node --test, pytest, bun.
_COUNTS = (
    re.compile(r"Tests:\s+(?:\d+ \w+, )*?(\d+) total"),
    re.compile(r"Tests:\s+(\d+) passed"),
    re.compile(r"OK \((\d+) tests?"),
    re.compile(r"Tests: (\d+), Assertions"),
    re.compile(r"Tests\s+(\d+) passed"),
    re.compile(r"^[#ℹ] tests (\d+)$", re.M),
    re.compile(r"=+ (\d+) passed"),
    re.compile(r"^\s*(\d+) pass$", re.M),
)


def test_count(text):
    for pattern in _COUNTS:
        found = pattern.findall(text)
        if found:
            return int(found[-1])
    return None


def detail_of(words, code, seconds, count, timeout):
    outcome = "timed out after %ds" % timeout if code is None else "exit %d" % code
    parts = [" ".join(words), outcome, "%ds" % round(seconds)]
    if count is not None:
        parts.append("%d tests" % count)
    text = " — ".join(parts)
    if len(text) > record.DETAIL_MAX:
        text = "…" + text[-(record.DETAIL_MAX - 1):]
    return text


def pull_of(owner, name, number):
    try:
        pull = http.rest("GET", "/repos/%s/%s/pulls/%s" % (owner, name, number))
    except errors.GhError as exc:
        raise Failure("cannot read %s/%s#%s: %s" % (owner, name, number, exc.message))
    if not isinstance(pull, dict) or not _SHA.match(str((pull.get("head") or {}).get("sha") or "").lower()):
        raise Failure("%s/%s#%s has no head to read" % (owner, name, number))
    return pull


def run(args):
    owner, name = repo.owner_repo()
    nwo = "%s/%s" % (owner, name)
    pull = pull_of(owner, name, args.pr)
    if pull.get("merged_at") or pull.get("state") != "open":
        raise Failure("%s#%d is %s" % (nwo, args.pr, "merged" if pull.get("merged_at") else pull.get("state")))
    head = pull["head"]["sha"].lower()
    base = (pull.get("base") or {}).get("ref") or ""
    here = local_head()
    if here != head:
        raise Failure("the checkout is at %s, the head of %s#%d is %s: run it from a checkout of the head" % (here[:7], nwo, args.pr, head[:7]))
    if not clean_tree():
        raise Failure("the tracked files have changes: the tests run on a clean checkout of the head")
    path = project_path(owner, name)
    state, project = read_project(path)
    if state == "missing":
        raise Failure("%s has no light CI: no %s; its stacked pull requests are ready on their review" % (nwo, path))
    if state == "off":
        raise Failure("light CI is off for %s (%s: %s): the gate reads its stacked pull requests on their review" % (nwo, project["at"], project["words"]))
    words = project["command"] + (project["prepare"] or [])
    base_sha = merge_base(base) if any(BASE in w for w in words) else ""
    command = substituted(project["command"], base_sha)
    deadline = time.monotonic() + args.budget if args.budget else None

    def allowed():
        # The project's timeout, or what the budget leaves when that is less: (seconds, whether the budget cut it).
        if deadline is None:
            return project["timeout"], False
        left = int(deadline - time.monotonic())
        return (left, True) if left < project["timeout"] else (project["timeout"], False)

    def cut(what):
        return Failure("%s stopped at the tool's budget of %ds, nothing recorded: a light CI runs within it" % (what, args.budget))

    fd, log_path = tempfile.mkstemp(prefix="light-ci-%s-%s-%d-" % (owner.lower(), name.lower(), args.pr), suffix=".log")
    with os.fdopen(fd, "w+", encoding="utf-8", errors="replace") as log:
        if project["prepare"]:
            prepare = substituted(project["prepare"], base_sha)
            limit, budgeted = allowed()
            code, _ = execute(prepare, max(limit, 1), log)
            if code is None and budgeted:
                raise cut("prepare")
            if code != 0:
                why = "timed out after %ds" % limit if code is None else "exited %d" % code
                raise Failure("prepare %s %s, no tests run, nothing recorded; output: %s" % (" ".join(prepare), why, log_path))
        log.flush()
        limit, budgeted = allowed()
        if limit < 1:
            raise cut("the run")
        code, seconds = execute(command, limit, log)
        if code is None and budgeted:
            raise cut("the tests")
        log.flush()
        log.seek(0)
        count = test_count(log.read())
    if local_head() != head:
        raise Failure("the checkout moved off %s while the tests ran: nothing recorded" % head[:7])
    result = "pass" if code == 0 else "fail"
    detail = detail_of(command, code, seconds, count, project["timeout"])
    session = args.session if args.session is not None else os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    fields = argparse.Namespace(repo=nwo, pr=args.pr, head=head, kind=KIND, result=result, producer=PRODUCER,
                                detail=detail, session=session)
    try:
        tests = record.validate(fields)
    except record.UsageError as exc:
        raise Failure("cannot write the tests record: %s" % exc)
    # Its status reaches the forge before the record is written: the other machine reads it there. A failure keeps the
    # run's outcome in its line, so the tests are not run again only to learn it.
    status = record.status_of(tests)
    outcome = "tests %s at %s: %s; output %s" % (result, head[:7], detail, log_path)
    try:
        forge.post(owner, name, head, status["what"], status["state"], status["description"])
    except errors.GhError as exc:
        raise Failure("cannot post the tests record to the forge, nothing recorded: %s (%s)" % (forge.refusal(exc), outcome))
    except OSError as exc:
        raise Failure("cannot post the tests record to the forge, nothing recorded: %s (%s)" % (exc, outcome))
    try:
        written = record.write(tests)
    except OSError as exc:
        raise Failure("cannot write the tests record (its status is on the forge): %s (%s)" % (exc, outcome))
    print("tests %s at %s of %s#%d: %s; output %s; record %s" % (result, head[:7], nwo, args.pr, detail, log_path, written))
    return 0


# ---- status ----

def status(args):
    owner, name = repo.owner_repo()
    nwo = "%s/%s" % (owner, name)
    path = project_path(owner, name)
    try:
        state, project = read_project(path)
    except Failure as exc:
        print("%s: invalid (%s); %s" % (nwo, exc, path))
        return 0
    if state == "configured":
        decided = project["decided"].get("at")
        print("%s: configured: %s%s; %s" % (nwo, " ".join(project["command"]), " (decided %s)" % decided if decided else "", path))
    elif state == "off":
        print("%s: off: %s, %s; %s" % (nwo, project["words"], project["at"], path))
    else:
        print("%s: none: its stacked pull requests are ready on their review; %s" % (nwo, path))
    return 0


def main(argv):
    try:
        args = build_parser().parse_args(argv)
        if args.repo:
            if not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", args.repo):
                raise record.UsageError("--repo expects owner/name, got: " + args.repo)
            repo.set_override(args.repo)
        if args.action == "run" and args.pr < 1:
            raise record.UsageError("--pr expects a pull request number, got: %d" % args.pr)
        if args.action == "run" and args.budget is not None and args.budget < 1:
            raise record.UsageError("--budget expects a number of seconds, got: %d" % args.budget)
        return run(args) if args.action == "run" else status(args)
    except record.UsageError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return USAGE_EXIT
    except errors.GhError as exc:
        print("error: " + exc.message, file=sys.stderr)
        return 1
    except Failure as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
