#!/usr/bin/env python3
"""Write one pull request record: a review, a norms check, an end-to-end run or
the light CI's tests run at one head commit, as REFERENCE.md « Records » describes it.

The one writer of ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pr-records/. Each record
is one JSON file under <owner>/<name>/<head>/, written under a temporary name
in that directory and then renamed, so a reader never sees half a file. It
prints the file's path, and exits 2 on a usage error with one error: line.
With --status it writes nothing and prints the status that copies the record on
the forge: its writer posts that status first, then writes the record at the
instant the status gives (--at).
"""

import argparse
import datetime
import json
import os
import re
import sys
import tempfile

# The record contract is core's: the same data file every TypeScript reader loads; and its status's, core's forge-status.
_CORE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "core")
with open(os.path.join(_CORE, "pr-record.json"), encoding="utf-8") as _fh:
    _CONTRACT = json.load(_fh)
with open(os.path.join(_CORE, "forge-status.json"), encoding="utf-8") as _fh:
    _FORGE = json.load(_fh)

VERSION = _CONTRACT["version"]
KINDS = tuple(_CONTRACT["kinds"])
RESULTS = tuple(_CONTRACT["results"])
WAIVABLE = _CONTRACT["waivable"]
NOT_APPLICABLE = _CONTRACT["not_applicable"]
ACCEPTANCE = _CONTRACT["acceptance"]
SCRIPTED = _CONTRACT["scripted"]
DETAIL_MAX = _CONTRACT["detail_max"]
USAGE_EXIT = 2
# How far ahead of now a record's --at may be: two machines' clocks apart (the reconciler's AHEAD_MS).
AHEAD_S = 300

_HEAD = re.compile(_CONTRACT["patterns"]["head"])
_PART = re.compile(_CONTRACT["patterns"]["repo_part"])
_PRODUCER = re.compile(_CONTRACT["patterns"]["producer"])
_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


class UsageError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def __init__(self, *args, **kwargs):
        kwargs.setdefault("allow_abbrev", False)
        super().__init__(*args, **kwargs)

    def error(self, message):
        raise UsageError(message)


def build_parser():
    parser = _Parser(prog="record.py", description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument("--pr", required=True, type=int)
    parser.add_argument("--head", required=True, help="the full 40-hex head sha")
    parser.add_argument("--kind", required=True, choices=KINDS)
    parser.add_argument("--result", required=True, choices=RESULTS)
    parser.add_argument("--producer", required=True, help="the producer's slug, [a-z0-9-]")
    parser.add_argument("--detail", default="")
    parser.add_argument("--session", default=None, help="defaults to CLAUDE_CODE_SESSION_ID")
    parser.add_argument("--at", default=None,
                        help="the instant of a record copied from the forge, or of one whose status was posted first, UTC to the second; defaults to now")
    parser.add_argument("--status", action="store_true",
                        help="write nothing: print the status that copies the record on the forge, as one JSON object")
    return parser


def validate(args):
    """The record's fields, or a UsageError naming the first one wrong."""
    parts = args.repo.split("/")
    if len(parts) != 2 or not all(_PART.match(p) and p not in (".", "..") for p in parts):
        raise UsageError("--repo expects owner/name, got: " + args.repo)
    if args.pr < 1:
        raise UsageError("--pr expects a pull request number, got: %d" % args.pr)
    if not _HEAD.match(args.head):
        raise UsageError("--head must be the full 40-character sha, got: " + args.head)
    if not _PRODUCER.match(args.producer):
        raise UsageError("--producer must match [a-z0-9-]+, got: " + args.producer)
    if len(args.detail) > DETAIL_MAX:
        raise UsageError("--detail is %d characters, at most %d" % (len(args.detail), DETAIL_MAX))
    if args.result == "waived":
        if args.kind not in WAIVABLE:
            raise UsageError("only an %s record can be waived" % " or ".join(WAIVABLE))
        if not args.detail.strip():
            raise UsageError("a waiver needs a --detail carrying the operator's answer")
    if args.result == "not-applicable":
        if args.kind != NOT_APPLICABLE:
            raise UsageError("only an %s record can be not applicable" % NOT_APPLICABLE)
        if not args.detail.strip():
            raise UsageError("a not applicable record needs a --detail giving its reason")
    if args.result == ACCEPTANCE["result"] and args.kind != ACCEPTANCE["kind"]:
        raise UsageError("only a %s record can be %s" % (ACCEPTANCE["kind"], ACCEPTANCE["result"]))
    if args.kind == SCRIPTED["kind"]:
        if args.producer != SCRIPTED["producer"]:
            raise UsageError("a %s record is written by %s alone" % (SCRIPTED["kind"], SCRIPTED["tool"]))
        if args.result not in SCRIPTED["results"]:
            raise UsageError("a %s record is %s" % (SCRIPTED["kind"], " or ".join(SCRIPTED["results"])))
    session = args.session if args.session is not None else os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    at = getattr(args, "at", None)
    if at is not None:
        try:
            if not _INSTANT.match(at):
                raise ValueError(at)
            datetime.datetime.strptime(at, "%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            raise UsageError("--at expects an instant in UTC to the second, 2026-11-19T10:00:00Z, got: " + at)
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    # A record dated ahead would outlast every later one of its kind, here and on the forge.
    if at is not None and at > (now + datetime.timedelta(seconds=AHEAD_S)).strftime("%Y-%m-%dT%H:%M:%SZ"):
        raise UsageError("--at may not be ahead of now by more than %d seconds, got: %s" % (AHEAD_S, at))
    return {
        "v": VERSION,
        "repo": args.repo.lower(),
        "pr": args.pr,
        "head": args.head.lower(),
        "kind": args.kind,
        "result": args.result,
        "producer": args.producer,
        "detail": args.detail,
        "session": session,
        "at": at if at is not None else now.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def status_of(record):
    """The commit status that copies a record at its head (core's forge-status contract), posted before the record
    is written: what it copies, its state and its description."""
    description = "v%d %s %s %s" % (_FORGE["version"], record["at"], record["result"], record["producer"])
    return {"what": record["kind"], "state": _FORGE["states"][record["result"]], "description": description}


def records_root():
    config = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(config, "pr-records")


def write(record):
    """Write the record under its head's directory and return its path."""
    directory = os.path.join(records_root(), record["repo"], record["head"])
    os.makedirs(directory, exist_ok=True)
    stamp = record["at"].replace("-", "").replace(":", "")
    path = os.path.join(directory, "%s.%s.%s.json" % (record["kind"], stamp, record["producer"]))
    # A dot name: a reader listing the directory skips it until the rename.
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(record, fh, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return path


def main(argv):
    try:
        args = build_parser().parse_args(argv)
        record = validate(args)
    except UsageError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return USAGE_EXIT
    if args.status:
        print(json.dumps(status_of(record), sort_keys=True))
        return 0
    try:
        print(write(record))
    except OSError as exc:
        print("error: cannot write the record: %s" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
