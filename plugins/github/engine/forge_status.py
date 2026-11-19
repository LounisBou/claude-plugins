#!/usr/bin/env python3
"""Post one copy of what the ready gate reads, a record, the check plan or the exemption, as a commit status at a
pull request's head, as REFERENCE.md « Records » describes it.

The one writer of the readiness/ statuses: the hooks module runs it after a record is written and from its
reconciler, which copies the statuses the other machine posted back into this one's records. It prints the context
posted, and exits 2 on a usage error and 1 when GitHub refuses, with one error: line.
"""

import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ghlib import errors, forge  # noqa: E402

USAGE_EXIT = 2
_SHA = re.compile(r"^[0-9a-f]{40}$")
_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


class UsageError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def __init__(self, *args, **kwargs):
        kwargs.setdefault("allow_abbrev", False)
        super().__init__(*args, **kwargs)

    def error(self, message):
        raise UsageError(message)


def build_parser():
    parser = _Parser(prog="forge_status.py", description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument("--head", required=True, help="the full 40-hex head sha")
    parser.add_argument("--what", required=True, help="the record kind, plan or exemption")
    parser.add_argument("--state", required=True)
    parser.add_argument("--description", required=True)
    return parser


def main(argv):
    try:
        args = build_parser().parse_args(argv)
        if not _REPO.match(args.repo) or any(part in (".", "..") for part in args.repo.split("/")):
            raise UsageError("--repo expects owner/name, got: " + args.repo)
        if not _SHA.match(args.head):
            raise UsageError("--head must be the full 40-character lowercase sha, got: " + args.head)
        wrong = forge.problem(args.what, args.state, args.description)
        if wrong:
            raise UsageError(wrong)
    except UsageError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return USAGE_EXIT
    owner, name = args.repo.split("/")
    try:
        forge.post(owner, name, args.head, args.what, args.state, args.description)
    except errors.GhError as exc:
        print("error: cannot post %s%s at %s: %s" % (forge.PREFIX, args.what, args.head[:7], exc.message), file=sys.stderr)
        return 1
    except OSError as exc:
        print("error: cannot post %s%s at %s: %s" % (forge.PREFIX, args.what, args.head[:7], exc), file=sys.stderr)
        return 1
    print("%s%s %s at %s of %s" % (forge.PREFIX, args.what, args.state, args.head[:7], args.repo))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
