"""The forge's copy of what the ready gate reads on a machine: one commit status a record kind, the check plan and
the exemption, under one context prefix (core's forge-status contract). CI is not theirs to judge:
the gate's CI reading leaves them out. A record's description is record.py's (status_of), the plan's and the
exemption's the hooks module's (core's forge-status.ts); problem() checks its shape, post() posts it."""

import json
import os

from . import http

_CORE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "core")
with open(os.path.join(_CORE, "forge-status.json"), encoding="utf-8") as _fh:
    _FORGE = json.load(_fh)
with open(os.path.join(_CORE, "pr-record.json"), encoding="utf-8") as _fh:
    _KINDS = json.load(_fh)["kinds"]

PREFIX = _FORGE["prefix"]
NAMES = tuple(_KINDS) + (_FORGE["plan"], _FORGE["exemption"])
STATES = tuple(sorted(set(_FORGE["states"].values())))
DESCRIPTION_MAX = _FORGE["description_max"]
VERSION_MARK = "v%d " % _FORGE["version"]


def is_readiness(context):
    """Whether a status context is one of the gate's copies, not a CI check."""
    return isinstance(context, str) and context.startswith(PREFIX)


def without_readiness(statuses):
    """A combined status (GET …/commits/<sha>/status) without the gate's copies."""
    if not isinstance(statuses, dict):
        return statuses
    kept = [s for s in statuses.get("statuses") or [] if not (isinstance(s, dict) and is_readiness(s.get("context")))]
    return dict(statuses, statuses=kept)


def problem(name, state, description):
    """Why a status cannot be posted, or None."""
    if name not in NAMES:
        return "the context is one of %s, got: %s" % (", ".join(NAMES), name)
    if state not in STATES:
        return "the state is one of %s, got: %s" % (", ".join(STATES), state)
    if not description.startswith(VERSION_MARK) or len(description) > DESCRIPTION_MAX:
        return "the description is %s<at> <body>, at most %d characters" % (VERSION_MARK, DESCRIPTION_MAX)
    return None


def refusal(exc):
    """Why GitHub refused a post: its HTTP status, when it answered one, and its message."""
    if exc.status is None or "(HTTP %s)" % exc.status in exc.message:
        return exc.message
    return "HTTP %s: %s" % (exc.status, exc.message)


def post(owner, name, sha, what, state, description):
    """Post the status that copies `what` at the commit `sha`; GitHub's answer."""
    return http.rest(
        "POST", "/repos/%s/%s/statuses/%s" % (owner, name, sha),
        {"state": state, "context": PREFIX + what, "description": description},
    )
