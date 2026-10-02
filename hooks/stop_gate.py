"""stop_gate.py - the stop gate's checks, run by stop-gate.sh on the host's Stop event.

Reads the host's payload on stdin (`session_id`, `cwd`, `last_assistant_message`,
`stop_hook_active`, `transcript_path`). Refuses a stop by printing
`{"decision": "block", "reason": …}`; lets it pass by printing nothing. Acts only in an
orchestrator's session, one whose name starts with `Orch :`. That scope is decided first,
from the session's own tty and its name, before any call to the launcher: the name is the
one the session was launched with (`--name`, read from the process table by the launcher's
own code) or, when it was launched without one, the last `custom-title` entry the host
wrote into the transcript when the session was renamed. The launcher's listing is read only
for a session that is an orchestrator.

Check 1, what will wake you. The stop passes when an agent of this orchestrator is busy
(its idle notice will wake the orchestrator), when the message ends on the machine line
`waiting: operator — blocks: <what it blocks>`, or when it ends on `waiting: done` and the
facts agree: no checkout of the project in `workspace.sh list`, no agent of this
orchestrator still there, and no row still open in the dispatch records the session
registered (a decision deferred « to plan after the round » opens a row; the row is the
memory). The message's last line is matched after normalisation: markup, a quote or a bullet
mark, the dash, the case and the spacing a model writes it with are all read as the line.
The agents of this orchestrator are the entries of the chain the
launcher keeps for its tty, those its own session wrote (`chain_owned`, the session read
from ITERM_SESSION_ID, the same id the launcher stores as the owner). An agent's state is
the activity glyph its tab title carries in the listing: `✳` idle, a spinner glyph busy, no
glyph at all no agent running there.

Check 2, the real CI state, runs only when Check 1 let the stop pass. Each open pull
request of the operator's own (`--author @me`) in the session's repository whose head differs from the head this hook last
reported for this session is read with `gh pr checks`; any check pending or failing refuses
the stop once with the real state, and the head is recorded so the same head never refuses
twice. A head whose check list is still empty (a push seen before its checks are registered)
is not green but unread: it is not recorded. It reads facts, never the words of the message:
a list of claim words fails open on any rewording and in any language.

The sweep, run last and never part of the decision. Once the checks have let the stop pass,
an orchestrator's stop also runs `workspace.sh sweep` — the checkouts and host temporary
directories whose purpose is over — with what is left of the hook's deadline, minus a margin,
at most once per ten minutes (a stamp file in the state directory). A refused stop runs none:
the host reads the decision at the hook's exit, and a refusal never waits on a sweep. Each
deletion is logged; a sweep that fails or overruns is logged and never changes the outcome
of the stop.

The whole hook runs under one deadline, checked between external calls: past it the stop
passes and one line is logged.

Its own failures never block: a missing tool, an unreadable listing or a network error lets
the stop pass and appends one line to `<state>/stop-gate.log`, beside one line per refusal
and per `blocks:` stop. The figures that say whether the gate earns its cost are read there.

WHY A HOOK. « Never end a turn on announced work » and « a fact you did not read is a fact
you do not state » existed as rules and did not hold: an orchestrator announced an agent and
ended its turn with none running, and twice stated a pull request's checks before they had
finished. Both happen at one moment, the stop, and the harness holds that moment.
"""

import datetime
import json
import os
import re
import signal
import subprocess
import sys
import time

from session_name import Unread, launcher, session_name

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LAUNCHER_DIR = os.path.join(ROOT, "skills", "iterm-agents", "scripts")
LAUNCHER = os.path.join(LAUNCHER_DIR, "iterm-agent.sh")
WORKSPACE = os.path.join(ROOT, "skills", "orchestrator", "scripts", "workspace.sh")
# The launcher's own resolution: the chains it keeps live there.
STATE_DIR = os.environ.get("ORCHESTRATOR_STATE_DIR") or os.path.join(
    os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude"),
    "claude-orchestrator",
)
LOG = os.path.join(STATE_DIR, "stop-gate.log")
HEADS_DIR = os.path.join(STATE_DIR, "stop-gate")
# Where dispatch-record.sh registers the records a session touched, one file per session id.
RECORDS_DIR = os.path.join(STATE_DIR, "records")

ORCH_ROLE = "Orch :"
IDLE_GLYPH = "✳"
# The machine line once normalised (see `normalise`): the dash between « operator » and
# « blocks: » may be any a model reaches for, and the spacing around it is free. A hyphen
# inside the reason is the reason's own and is kept.
MACHINE_LINE = re.compile(r"^waiting:\s*(?:operator\s*(?:—|–|--|-)\s*blocks:\s*(.+)|(done))$",
                          re.IGNORECASE)
LOOKS_DECLARED = re.compile(r"\bblocks\b\W*\w", re.IGNORECASE)
MARKUP = "`*_ \t"
# Every external call is bounded: a stop the hook holds on its own wait is a failure too.
CALL_TIMEOUT = 30
# And so is the hook as a whole, checked between its external calls.
DEADLINE = float(os.environ.get("ORCHESTRATOR_STOP_GATE_DEADLINE") or 20)
STARTED = time.monotonic()
# The sweep runs at most this often, whichever orchestrator stops: one stamp, in the state directory.
SWEEP_STAMP = os.path.join(STATE_DIR, "sweep.stamp")
SWEEP_EVERY = float(os.environ.get("ORCHESTRATOR_SWEEP_INTERVAL") or 600)
# What the sweep leaves of the hook's deadline for the hook's own exit.
SWEEP_MARGIN = 3.0

# The machine line is shown as plain text and the reason says where it goes: a line copied
# with its backticks was the first way it failed.
NOTHING = ("Nothing will wake you: no agent of yours is running. Launch what you announced, "
           "or, if a question truly blocks, end with the line "
           "waiting: operator — blocks: <what it blocks>, or with waiting: done. "
           "The line goes as the message's last line, no markup.")
MALFORMED = ("Your last line is not the machine line: end the message with the line "
             "waiting: operator — blocks: <what it blocks>, or with waiting: done, "
             "as the message's last line, no markup.")
IDLE_ONE = "%s is idle: its notice was spent. Read its report or relaunch it."
IDLE_MANY = "%s are idle: their notices were spent. Read their reports or relaunch them."
QUESTION = ("Your question blocks nothing declared: advance everything that can advance; "
            "its answer will come in a later turn.")
NOT_DONE_ONE = "Not done: %s is still there. Finish it, or say what blocks it."
NOT_DONE_MANY = "Not done: %s are still there. Finish them, or say what blocks them."
ROW_ONE = "Not done: row %s is open. Dispatch it, close it, or say what blocks it."
ROW_MANY = "Not done: rows %s are open. Dispatch them, close them, or say what blocks them."
CI_STATE = ("#%s at %s: %d checks pending (%s), %d failing (%s). Report this state as it is, "
            "or wait for the end in one call: `timeout 590 gh pr checks %s --watch`.")


def log(who, *fields):
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = " | ".join([stamp, who or "-"] + [" ".join(str(f).split()) for f in fields])
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(LOG, "a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def run(argv, cwd=None, what=None):
    """stdout, stderr and the exit code of a bounded call; Unread when it cannot run."""
    what = what or os.path.basename(argv[0])
    if time.monotonic() - STARTED > DEADLINE:
        raise Unread("the overall deadline of %gs passed before %s" % (DEADLINE, what))
    try:
        done = subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                              timeout=CALL_TIMEOUT)
    except FileNotFoundError:
        raise Unread("%s is not installed" % what)
    except subprocess.TimeoutExpired:
        raise Unread("%s did not answer within %ds" % (what, CALL_TIMEOUT))
    except OSError as exc:
        raise Unread("%s cannot run: %s" % (what, exc))
    return done.stdout, done.stderr, done.returncode


def first_line(text):
    return (text.strip().splitlines() or [""])[0]


# --- the listing ------------------------------------------------------------------------

def parse_row(line):
    """`w1/t2 | <tty> | <title> | <name>[ | self][ | hidden]`, the launcher's `row_for`."""
    parts = line.split(" | ")
    if len(parts) < 4:
        return None
    while len(parts) > 4 and parts[-1] in ("self", "hidden"):
        parts.pop()
    return {"tty": parts[1], "title": " | ".join(parts[2:-1]), "name": parts[-1]}


def listing():
    out, err, code = run(["bash", LAUNCHER, "list"], what="the launcher's listing")
    if code != 0:
        raise Unread("the launcher's listing failed: %s" % first_line(err))
    return [r for r in (parse_row(l) for l in out.splitlines()) if r]


def activity(title):
    """`idle`, `busy`, or None when the title carries no host activity glyph: a shell
    left behind by an agent that exited, or a stranger's tab on a recycled tty."""
    glyph = (title.split(" ", 1) or [""])[0]
    if glyph == IDLE_GLYPH:
        return "idle"
    if len(glyph) == 1 and ord(glyph) > 127 and not glyph.isalnum():
        return "busy"
    return None


def label(row):
    name = row["name"]
    if name and not name.startswith("("):
        return name
    return row["title"] or row["tty"]


# --- check 1 ----------------------------------------------------------------------------

def own_agents(rows, own_tty, who):
    """(label, idle|busy) for each agent of this orchestrator whose tab runs one."""
    iterm_agent = launcher()
    owner = os.environ.get("ITERM_SESSION_ID", "").rpartition(":")[2]
    if not owner:
        # `chain_owned` filters nothing without an owner: every entry of the tty's chain, a
        # previous occupant's included, would count. No entry is the safe count.
        log(who, "error", "ITERM_SESSION_ID is not set: no chain entry is counted")
        return []
    entries = iterm_agent.chain_owned(iterm_agent.chain_read(own_tty), owner)
    by_tty = {r["tty"]: r for r in rows}
    agents = []
    for entry in entries:
        row = by_tty.get(entry["tty"])
        state = activity(row["title"]) if row else None
        if state:
            agents.append((label(row), state))
    return agents


def normalise(line):
    """The message's last line as the machine line would read, whatever the markup a model
    wrote it in: backticks, bold or italics, a quote or a bullet mark, surrounding spaces,
    one trailing period. The dash, the case and the spacing inside the line are the pattern's;
    the reason is untouched."""
    line = line.strip()
    while True:
        before = line
        line = line.strip(MARKUP)
        if line.startswith(">"):
            line = line[1:]
        elif re.match(r"[-*]\s", line):
            line = line[1:]
        elif line.endswith("."):
            line = line[:-1]
        if line == before:
            return line


def machine_line(message):
    lines = [l for l in message.splitlines() if l.strip()]
    return normalise(lines[-1]) if lines else ""


def open_rows(session_id):
    """`<id> (<label>)` for each row still open in the dispatch records this session
    registered (`dispatch-record.sh` writes `<state>/records/<session id>`, one path a line).
    No file, an unreadable record or a line that is no row: no row."""
    rows = []
    try:
        with open(os.path.join(RECORDS_DIR, re.sub(r"[^A-Za-z0-9._-]", "_", session_id))) as fh:
            records = [l.strip() for l in fh if l.strip()]
    except OSError:
        return rows
    for record in records:
        try:
            with open(record) as fh:
                for line in fh:
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(row, dict) and row.get("state") == "open":
                        rows.append("%s (%s)" % (row.get("id"), row.get("label") or "no label"))
        except OSError:
            continue
    return rows


def project_checkouts(cwd):
    """The checkouts `workspace.sh` made of the session's project: <root>/<project>/<name>."""
    out, _, code = run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], what="git")
    top = out.strip() if code == 0 else os.path.realpath(cwd)
    project = os.path.basename(top)
    out, err, code = run(["bash", WORKSPACE, "list"], what="workspace.sh list")
    if code != 0:
        raise Unread("workspace.sh list failed: %s" % first_line(err))
    found = []
    for line in out.splitlines():
        path = line.split(" | ", 1)[0].strip()
        if path and path != top and os.path.basename(os.path.dirname(path)) == project:
            found.append(path)
    return found


def check_wake(rows, own_tty, message, cwd, who, session_id):
    """None when something will wake the orchestrator, else (case, reason)."""
    agents = own_agents(rows, own_tty, who)
    if any(state == "busy" for _, state in agents):
        return None
    last = machine_line(message)
    matched = MACHINE_LINE.match(last)
    if matched and matched.group(1):
        log(who, "check1", "blocks", matched.group(1))
        return None
    if matched:
        left = project_checkouts(cwd) + [name for name, _ in agents]
        deferred = open_rows(session_id)
        if not left and not deferred:
            return None
        reasons = []
        if left:
            reasons.append((NOT_DONE_ONE if len(left) == 1 else NOT_DONE_MANY) % ", ".join(left))
        if deferred:
            reasons.append((ROW_ONE if len(deferred) == 1 else ROW_MANY) % ", ".join(deferred))
        return "not-done", " ".join(reasons)
    if agents:
        form = IDLE_ONE if len(agents) == 1 else IDLE_MANY
        return "idle-agents", form % ", ".join(name for name, _ in agents)
    if last.lower().startswith("waiting") and LOOKS_DECLARED.search(last):
        return "malformed-machine-line", MALFORMED
    if last.lower().startswith("waiting:") or last.endswith("?"):
        return "question-without-blocks", QUESTION
    return "nothing-will-wake", NOTHING


# --- check 2 ----------------------------------------------------------------------------

def heads_path(session_id):
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", session_id)
    return os.path.join(HEADS_DIR, safe + ".heads")


def read_heads(path):
    heads = {}
    try:
        with open(path) as fh:
            for line in fh:
                parts = line.split()
                if len(parts) == 2:
                    heads[parts[0]] = parts[1]
    except OSError:
        pass
    return heads


def write_heads(path, heads):
    try:
        os.makedirs(HEADS_DIR, exist_ok=True)
        with open(path + ".tmp", "w") as fh:
            for number in sorted(heads, key=int):
                fh.write("%s %s\n" % (number, heads[number]))
        os.replace(path + ".tmp", path)
    except OSError as exc:
        raise Unread("the reported heads cannot be written: %s" % exc)


def gh_json(argv, cwd, tolerated=()):
    """The JSON `gh` printed. `gh pr checks` exits 8 on pending and 1 on failing checks,
    so the exit code alone is no error: the output is."""
    out, err, code = run(["gh"] + argv, cwd=cwd)
    if any(t in err for t in tolerated):
        return []
    try:
        return json.loads(out)
    except ValueError:
        raise Unread("gh %s failed (exit %d): %s" % (" ".join(argv[:2]), code, first_line(err)))


def check_ci(cwd, session_id):
    """The refusal lines, one per pull request whose new head has checks pending or failing."""
    if not session_id:
        raise Unread("no session id: the reported heads cannot be kept")
    # The operator's own pull requests: the check exists for the reports an orchestrator
    # makes about the work it pushes, not for every open pull request of the repository.
    prs = gh_json(["pr", "list", "--state", "open", "--author", "@me", "--limit", "200",
                   "--json", "number,headRefOid"], cwd)
    path = heads_path(session_id)
    reported = read_heads(path)
    heads, lines = {}, []
    for pr in prs:
        number, head = str(pr["number"]), pr["headRefOid"]
        if reported.get(number) == head:
            heads[number] = head
            continue
        checks = gh_json(["pr", "checks", number, "--json", "name,bucket"], cwd,
                         tolerated=("no checks reported",))
        pending = [c["name"] for c in checks if c.get("bucket") == "pending"]
        failing = [c["name"] for c in checks if c.get("bucket") in ("fail", "cancel")]
        # No check yet is a push seen before its checks were registered, not a green head:
        # unread, so unrecorded, and read again at the next stop.
        if checks:
            heads[number] = head
        if pending or failing:
            lines.append(CI_STATE % (number, head[:7], len(pending), ", ".join(pending),
                                     len(failing), ", ".join(failing), number))
    write_heads(path, heads)
    return lines


# --- the sweep --------------------------------------------------------------------------

def sweep_due():
    """True when no sweep ran within SWEEP_EVERY seconds."""
    try:
        return time.time() - os.path.getmtime(SWEEP_STAMP) >= SWEEP_EVERY
    except OSError:
        return True


def sweep(who):
    """Run `workspace.sh sweep` within what is left of the deadline, and log what it did.

    Nothing here may refuse or delay a stop beyond the deadline: every failure is a log line.
    The stamp is written before the run, so a sweep that hangs is not retried by every stop."""
    try:
        left = DEADLINE - (time.monotonic() - STARTED) - SWEEP_MARGIN
        if left < 1 or not sweep_due():
            return
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(SWEEP_STAMP, "w") as fh:
            fh.write("%d\n" % time.time())
        proc = subprocess.Popen(["bash", WORKSPACE, "sweep", "--deadline", str(int(left))],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                start_new_session=True)
        try:
            out, err = proc.communicate(timeout=left + 1.5)
        except subprocess.TimeoutExpired:
            # TERM first, so the sweep's own exit trap removes its working directory.
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(proc.pid, sig)
                except OSError:
                    pass
                try:
                    proc.communicate(timeout=1)
                    break
                except subprocess.TimeoutExpired:
                    continue
            log(who, "sweep", "error", "did not finish within %ds" % int(left + 1.5))
            return
        for line in out.splitlines():
            if line.startswith("deleted "):
                log(who, "sweep", "deleted", line[len("deleted "):])
        if proc.returncode != 0:
            log(who, "sweep", "error", "exit %d: %s" % (proc.returncode, first_line(err)))
    except Exception as exc:
        log(who, "sweep", "error", "%s: %s" % (type(exc).__name__, exc))


# --- the stop ---------------------------------------------------------------------------

def refuse(reason):
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
    sys.stdout.flush()


def gate(payload):
    if payload.get("stop_hook_active"):
        return
    session_id = payload.get("session_id") or ""
    cwd = payload.get("cwd") or os.getcwd()
    message = payload.get("last_assistant_message") or ""
    who = session_id
    try:
        # The scope first, from the session itself: the launcher's listing is a call to the
        # terminal, and every agent's, auditor's and hand-started session would pay it.
        own, name = session_name(payload)
        if not own:
            log(who, "error", "the session's own tty cannot be read")
            return
        if not name:
            log(who, "error", "the session's name cannot be read on %s" % own)
            return
        if not name.startswith(ORCH_ROLE):
            return
        who = name
        refused = False
        try:
            rows = listing()
            held = check_wake(rows, own, message, cwd, who, session_id)
            if held:
                log(who, "check1", held[0])
                refuse(held[1])
                refused = True
                return
            lines = check_ci(cwd, session_id)
            if lines:
                log(who, "check2", "ci-not-finished", " ; ".join(l.split(". Report")[0] for l in lines))
                refuse("\n".join(lines))
                refused = True
        finally:
            # After the checks have let the stop pass — or could not read and so let it pass.
            # Never after a refusal: the host reads the decision at the hook's exit, and the
            # session it holds must not wait on a sweep.
            if not refused:
                sweep(who)
    except Unread as exc:
        log(who, "error", str(exc))


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError as exc:
        log("", "error", "the payload is not JSON: %s" % exc)
        return
    if not isinstance(payload, dict):
        log("", "error", "the payload is not an object")
        return
    try:
        gate(payload)
    except Exception as exc:
        log(payload.get("session_id") or "", "error", "%s: %s" % (type(exc).__name__, exc))


if __name__ == "__main__":
    main()
