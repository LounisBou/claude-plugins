"""session_name.py - the one reading of a session's name, shared by the hooks.

Reads the host's payload on stdin (`transcript_path` is the field used) and prints the
session's name on one line, or nothing. It never fails: any error prints nothing and exits 0.
A miss (an exception, or a name the launcher knows exists and cannot read, with no rename in
the transcript) is appended as one line to `<state dir>/context-gate.log`; a session with no
name at all is the normal case and is not logged.

The name is the one the session was launched with (`--name`, read from the process table by
the launcher's own code) or, when it was launched without one, the last `custom-title` entry
the host wrote into the transcript when the session was renamed. The role of a session is the
prefix of that name (`Orch :`, `Agent :`, `Audit :`, `Coord :`).

Imported by hooks/stop_gate.py; run as a script by hooks/context-gate.sh.
"""

import datetime
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# Resolved as the stop gate resolves it.
STATE_DIR = os.environ.get("ORCHESTRATOR_STATE_DIR") or os.path.join(
    os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude"),
    "claude-orchestrator",
)
LOG = os.path.join(STATE_DIR, "context-gate.log")
LAUNCHER_DIR = os.path.join(ROOT, "skills", "iterm-agents", "scripts")
# Read from the end of a transcript in blocks this size.
TRANSCRIPT_BLOCK = 65536
TITLE_ENTRY = re.compile(rb'"type"\s*:\s*"custom-title"')


class Unread(Exception):
    """A source the hook could not read. The stop passes and the log says which."""


def launcher():
    """The launcher's own module: the chain and the session's tty are read by its code."""
    sys.path.insert(0, LAUNCHER_DIR)
    try:
        import iterm_agent
    except Exception as exc:
        raise Unread("the launcher's module cannot be loaded: %s" % exc)
    return iterm_agent


def title_in(path):
    """The session's last `/rename`: the value of the LAST `custom-title` entry of the
    transcript, unquoted, or None. The transcript is read from its end in blocks and only
    the one line that matched is parsed: it can be large, and every line before it is
    nobody's business."""
    try:
        with open(path, "rb") as fh:
            pos = fh.seek(0, os.SEEK_END)
            carry = b""
            while pos > 0:
                step = min(TRANSCRIPT_BLOCK, pos)
                pos -= step
                fh.seek(pos)
                lines = (fh.read(step) + carry).split(b"\n")
                # Unless this block starts the file, its first line is cut: kept for the next read.
                carry = lines.pop(0) if pos > 0 else b""
                for line in reversed(lines):
                    if TITLE_ENTRY.search(line):
                        return unquoted(json.loads(line).get("customTitle"))
    except (OSError, ValueError, AttributeError):
        return None
    return None


def unquoted(title):
    if not isinstance(title, str):
        return None
    return title.strip().strip("\"'").strip() or None


def read_name(payload):
    """(own tty, name, unreadable): `unreadable` is true when the launcher knows the session
    was given a name and the process table cannot give it back."""
    module = launcher()
    own = module.self_tty()
    if not own:
        return None, None, False
    name = module.session_name_on(own)
    unreadable = name == module.UNREADABLE_NAME
    if unreadable:
        name = None
    return own, name or title_in(payload.get("transcript_path") or ""), unreadable


def session_name(payload):
    """(own tty, name): the name the session was launched with, else its last rename.
    The first is read by the launcher's own code, the same reading its listing prints."""
    own, name, _ = read_name(payload)
    return own, name


def log(who, message):
    """One line in the context gate's log, same shape as the stop gate's. Never fails."""
    try:
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        line = " | ".join([stamp, who or "-", " ".join(str(message).split())])
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(LOG, "a") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


def main():
    who = None
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        payload = payload if isinstance(payload, dict) else {}
        who = payload.get("session_id")
        _, name, unreadable = read_name(payload)
        if name:
            print(" ".join(name.split()))
        elif unreadable:
            log(who, "the session's name is unreadable in the process table and the "
                     "transcript carries no rename")
    except BaseException as exc:
        log(who if isinstance(who, str) else None, "the name could not be read: %s" % exc)


if __name__ == "__main__":
    main()
