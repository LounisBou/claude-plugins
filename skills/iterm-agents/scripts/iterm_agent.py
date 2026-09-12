#!/usr/bin/env python3
"""iTerm2 session management for the orchestrator, over the app's own API.

The bash entry point beside this file resolves an interpreter and hands over here.
Every subcommand keeps the name, the options, the output and the exit codes the shell
version had, because skills, commands and briefs call it by those.

Why the API rather than AppleScript. The old path TYPED the launch command into a fresh
shell, and everything expensive came from that: a command truncated past a few hundred
characters while the script reported success, a startup question eating the first
keystroke twice in one night, quoting that died on a non-ASCII byte under a C locale, and
a tab placement that needed Accessibility, the app in front, and a focus flicker per move.
`async_create_tab` takes the command and the index directly, so none of those exist here.

What did not change: the tty is still a claim, and the process on it is still the fact.
A spawn is not done until the host CLI is seen in `ps`.
"""

import argparse
import asyncio
import glob
import json
import logging
import os
import re
import subprocess
import sys
import time


class _AsyncioSocketNoise(logging.Filter):
    """Drops the library's own "Task exception was never retrieved" tracebacks (§29):
    getting the app object subscribes it to layout and focus notifications dispatched as
    tasks of their own, and the ones mid-flight when a step's connection closes end on that
    socket and are reported — by the loop's default exception handler, through this logger,
    regardless of which loop owned the task or when it is collected — as noise on every
    spawn. Every other record passes: a diagnosis the stream exists to carry is not of this
    shape."""

    def filter(self, record):
        if not record.getMessage().startswith("Task exception was never retrieved"):
            return True
        exc_info = record.exc_info
        if not exc_info or not exc_info[0]:
            return True
        return not exc_info[0].__name__.startswith("ConnectionClosed")


logging.getLogger("asyncio").addFilter(_AsyncioSocketNoise())

HOST_CLI = os.environ.get("ORCHESTRATOR_HOST_CLI", "claude")
STATE_DIR = os.environ.get("ORCHESTRATOR_STATE_DIR") or os.path.join(
    os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude"),
    "claude-orchestrator",
)
PROMPTS_DIR = os.path.join(STATE_DIR, "prompts")
CHAINS_DIR = os.path.join(STATE_DIR, "chains")
SELF_TTY = os.environ.get("ORCHESTRATOR_SELF_TTY", "")
# The app's session id of the caller, for a dry run that has no app to ask (§26).
SELF_ID = os.environ.get("ORCHESTRATOR_SELF_ID", "")
# The shell the tab runs the launch through. A LOGIN shell, so the session inherits the
# operator's environment — the package manager's binaries included — instead of the bare
# default the app hands a program run directly (§22). Non-interactive `-l` reads the
# profile files and not the interactive ones: the environment without the prompt.
LOGIN_SHELL = os.environ.get("ORCHESTRATOR_LOGIN_SHELL") or os.environ.get("SHELL") or "/bin/zsh"
MODELS_MAP = os.environ.get("ORCHESTRATOR_MODELS_MAP") or os.path.join(STATE_DIR, "models.json")
# The operator's server catalogue, beside the tier map and owned the same way: named
# definitions in the host's own shape, and a `default` list of the elementary ones every
# agent gets. The plugin writes an empty one at install and never guesses a definition —
# what a machine offers is the operator's to say (§42).
MCP_CATALOGUE = os.environ.get("ORCHESTRATOR_MCP_CATALOGUE") or os.path.join(STATE_DIR, "mcp.json")
SPAWN_TIMEOUT = int(os.environ.get("ORCHESTRATOR_SPAWN_TIMEOUT", "30"))
# Where the host keeps one directory per checkout and one transcript per session. The mode
# a session actually came up in is read there: the process line says what was ASKED for,
# and the two are not the same thing for every model (§43).
PROJECTS_DIR = os.environ.get("ORCHESTRATOR_PROJECTS_DIR") or os.path.expanduser("~/.claude/projects")
# A transcript appears about two seconds after the process starts; twenty is room for a
# slow machine, and a reading that never comes is not a refusal (§29).
MODE_TIMEOUT = int(os.environ.get("ORCHESTRATOR_MODE_TIMEOUT", "20"))
DRY_RUN = bool(os.environ.get("ORCHESTRATOR_DRY_RUN"))
TIERS = ("deep", "standard", "light")
# A title reads `Orch : <subject>` or `Agent : <subject>`: two roles, and a subject of at
# most twenty-five characters. It is the session's NAME (§24), so it is the operator's
# format or it is nothing an orchestrator can recognise in a listing — a successor once
# came up as `steward-successor` because the launcher took whatever was typed (§39). The
# roles are SHORT and the subject is capped because the operator read his window and could
# not tell one agent from another at a glance (§42); a derived name is held to the same
# shape, which is also what stops a successor coming up under a whole launch line — a
# session the older launcher named carries the prompt in its own process line, measured
# live at 366 characters. It ends on `\Z` and not on `$`, which in this language matches
# before a trailing newline as well: a name is one line, and the title travels through a
# launch file and back out of the process table, where a second line is not part of a name.
# The subject's first and last characters are not spaces either: a name that reads as
# empty, or as its trimmed twin, never reaches a listing (§45).
TITLE_SHAPE = re.compile(r"^(Orch|Agent) : \S(.{0,23}\S)?\Z")


def die(msg):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(1)


def created_at(path):
    """When a transcript was CREATED, where the platform records it.

    The host writes to a session's transcript for as long as that session lives, so « last
    modified » answers a different question: an older session in the same checkout is
    modified constantly, and so is the caller's own. Measured live: two spawns into one
    checkout seconds apart, and the second read the mode of the first — refused a moment
    earlier, its closing write landing after the second launch began; and a spawn into a
    checkout where a session was already running read that session's mode. Creation is the
    reading that answers « is this the session I just made ». A filesystem that does not
    record it leaves modification as the best available answer."""
    st = os.stat(path)
    return getattr(st, "st_birthtime", st.st_mtime)


def find_transcript(dir_, since):
    """The transcript of the session just launched into `dir_`, or None.

    Found by READING the entries, never by computing the host's directory slug: the slug is
    the host's own encoding of a path, and a plugin that reproduced it would be wrong the
    day the encoding changes. The file is the newest one CREATED since the launch whose
    first entry carrying `cwd` names this checkout — an older session in the same checkout
    is not the one this spawn made.

    The first entries carry no `cwd`: it arrives several entries in, after the one that
    carries the mode. So the caller polls on this function rather than on the mode — a
    transcript that exists but does not yet name its checkout is not yet an answer."""
    want = os.path.realpath(dir_)
    found = []
    for path in glob.glob(os.path.join(PROJECTS_DIR, "*", "*.jsonl")):
        try:
            born = created_at(path)
            if born < since:
                continue
            with open(path) as fh:
                for line in fh:
                    try:
                        entry = json.loads(line)
                    except Exception:
                        continue
                    if isinstance(entry, dict) and "cwd" in entry:
                        if entry["cwd"] == want:
                            found.append((born, path))
                        break
        except Exception:
            # A file being written while it is read is not a reason to refuse a launch.
            continue
    return max(found)[1] if found else None


def mode_of_transcript(path):
    """The mode the session announced when it came up: the FIRST `permissionMode` the
    transcript carries. A later one is the operator changing it by hand, which is not what
    the launch is being judged on."""
    try:
        with open(path) as fh:
            for line in fh:
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                if isinstance(entry, dict) and "permissionMode" in entry:
                    return entry["permissionMode"] or ""
    except Exception:
        return ""
    return ""


def mode_refusal(asked, got, model):
    """Both modes, the model, and the two repairs: which one applies depends on all three.
    The operator rebinds the tier, or spawns that agent in a mode the host does honour for
    that model — `acceptEdits` carried, and ran edits and allow-listed commands without a
    prompt, on the very model that ignored the decision mode (§43)."""
    return ("spawn: refused: the session came up in mode '%s' and not '%s' (model %s): the "
            "host ignores the mode asked for this model; bind the tier to another model, or "
            "pass --permission-mode acceptEdits for an agent that only edits"
            % (got, asked, model or "the host default"))


def last_lines(lines, n):
    """The last `n` lines of a reading, its trailing blanks dropped.

    `screen --lines N` returned the FIRST N lines of the tab, which on a tall terminal are
    blank: a blocked agent's prompt sits at the bottom, and three reads out of four came
    back empty while the tooling reported success. An interior blank stays — a blank line
    between two of an agent's messages is part of what it is showing."""
    trimmed = list(lines)
    while trimmed and trimmed[-1] == "":
        trimmed.pop()
    return trimmed[-n:] if n > 0 else []


def read_catalogue():
    """The catalogue, or None when there is no file.

    A file that does not read as one is NOT an empty catalogue: reading the two alike would
    send every agent out with no server while the caller believes it named some — the same
    reasoning `resolve_tier` refuses an unreadable tier map on."""
    if not os.path.isfile(MCP_CATALOGUE):
        return None
    try:
        with open(MCP_CATALOGUE) as fh:
            data = json.load(fh)
        if not isinstance(data, dict) or not isinstance(data.get("servers"), dict) \
                or not isinstance(data.get("default"), list):
            raise ValueError("shape")
    except Exception:
        die('spawn: refused: %s does not read as a server catalogue (a "servers" object '
            'and a "default" list)' % MCP_CATALOGUE)
    for name in data["default"]:
        if name not in data["servers"]:
            die("spawn: refused: the catalogue %s lists '%s' in default but not in servers"
                % (MCP_CATALOGUE, name))
    return data


def select_servers(asked, catalogue):
    """The names this session gets: the catalogue's default set plus every name asked for,
    in catalogue order and each once. `none` anywhere selects nothing — an agent that needs
    no server should not carry the default set to get none of it wrong.

    A refusal here happens before any file is written and before any tab exists: a name the
    catalogue does not hold is a typo or a server the operator has not written yet, and
    either way the agent would come up without it and nobody would know until it reached
    for a tool."""
    names = []
    for value in asked:
        names += [n.strip() for n in value.split(",") if n.strip()]
    asked_servers = [n for n in names if n != "none"]
    if catalogue is None:
        if asked_servers:
            die("spawn: refused: --mcp needs a server catalogue at %s; the installer "
                "creates one" % MCP_CATALOGUE)
        if "none" in names:
            # Asked for nothing, so nothing is needed to give it: no catalogue is required
            # and no line is printed — the caller said what it wants.
            return []
        # A caller that said nothing, on a machine that offers nothing: the launch goes
        # through and says so, rather than deciding in silence (§31).
        print("spawn: no server catalogue at %s: the session loads no server"
              % MCP_CATALOGUE, file=sys.stderr)
        return []
    servers = catalogue["servers"]
    # Every asked name is checked BEFORE `none` short-circuits the selection: a typo beside
    # `none` is still a typo, and a caller who mistyped one name among several should learn
    # it rather than get silently sent out with nothing.
    for name in asked_servers:
        if name not in servers:
            die("spawn: refused: --mcp '%s' is not in the catalogue %s (names: %s)"
                % (name, MCP_CATALOGUE, ", ".join(servers) or "none"))
    if "none" in names:
        return []
    wanted = set(catalogue["default"]) | set(names)
    return [name for name in servers if name in wanted]


def write_mcp_file(names, catalogue, title):
    """The selected definitions, in a file of this session's own, beside its prompt file.

    Inline JSON would do the same job and cost the process line its length: the host's
    `--mcp-config` takes SEVERAL values, so whatever follows it is read as another file —
    the prompt placed there was read as one — and the line `ps` shows is where a successor
    reads its predecessor's name from (§24)."""
    os.makedirs(PROMPTS_DIR, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", title)[:40] or "agent"
    path = os.path.join(PROMPTS_DIR, "mcp-%s-%d.json" % (safe, int(time.time() * 1000)))
    with open(path, "w") as fh:
        json.dump({"mcpServers": {n: catalogue["servers"][n] for n in names}}, fh, indent=2)
    return path


def need_iterm2():
    """Imported here, never at module scope: reading the tier map or a tty must work on a
    machine that has no window server, no iTerm2 and no venv."""
    try:
        import iterm2  # noqa: F401
    except ImportError:
        die(
            "the iterm2 module is not available. Create the plugin's environment with\n"
            "  /orchestrator:install\n"
            "or install it yourself: python3 -m venv "
            + os.path.join(STATE_DIR, "venv")
            + " && "
            + os.path.join(STATE_DIR, "venv", "bin", "pip")
            + " install iterm2"
        )
    return sys.modules["iterm2"]


# --- iTerm2 answers, or it is said why (§46) ---------------------------------------
#
# The fault this section exists for: one right-click left a context menu open in the app,
# and for four hours every AppleScript to it timed out while its terminals kept scrolling.
# A menu runs a NESTED, modal event loop; while one runs the main thread never returns to
# its default run loop mode and AppleEvents are NOT dispatched — they queue and expire on
# their own two-minute timeout, one after another, with nothing written to any log. The
# API library authenticates by asking the app for a cookie THROUGH AppleScript, in a
# subprocess it never bounds, so the launcher inherited an unkillable wait: `list`, `close`
# and `spawn` all hung, and a `close` printed « closed 1 session » over a session whose
# process was still running.
#
# Three answers, and each of them is a rule the rest of this file keeps:
#   - no AppleScript is ever run unbounded, here or anywhere else in this file;
#   - the app is asked the cheapest question there is BEFORE the library is entered, so a
#     wedged app is never asked for a cookie at all;
#   - when it does not answer, the cause is NAMED from a main-thread sample instead of the
#     caller being left to guess — the fault above is cleared by one keystroke, and saying
#     so is the difference between a minute and an afternoon.

# Where the AppleScripts go, what samples the app, and which app. All three are overridable
# so the suite can stand a wedged app and a healthy one side by side with no window server.
OSASCRIPT = os.environ.get("ORCHESTRATOR_OSASCRIPT") or "/usr/bin/osascript"
SAMPLE = os.environ.get("ORCHESTRATOR_SAMPLE") or "/usr/bin/sample"
APP_PID = os.environ.get("ORCHESTRATOR_APP_PID", "")
# The preflight's deadline: long for an app that answers in milliseconds, short against the
# two MINUTES an unanswered AppleEvent costs.
PROBE_TIMEOUT = int(os.environ.get("ORCHESTRATOR_PROBE_TIMEOUT", "8"))
# How long a close waits for the process to leave the table before it calls the close a
# failure. A host CLI takes a moment to unwind; ten seconds is room for that and nothing
# like room for a session that is not going.
CLOSE_TIMEOUT = int(os.environ.get("ORCHESTRATOR_CLOSE_TIMEOUT", "10"))
BACKENDS = ("api", "applescript")
# The rungs, in order. AppleScript is the fallback and the ONLY one: it drove this plugin
# before the API existed and it covers what the API alone does not — the module missing, the
# environment unbuilt, the API server switched off, a cookie refused.
#
# There is deliberately no third rung in another terminal (§48). One was built, in tmux, and
# the operator struck it out: a session that is not an iTerm2 tab is not an agent he can see,
# place or close in the window he reads, and a launcher that quietly hands him one has hidden
# the fault instead of repairing it. When BOTH rungs are down the app itself is wedged, and
# that has a one-keystroke remedy — so the launcher NAMES it and stops. Stopping loudly on a
# fault with a known remedy is the repair; routing around it is not.
DEFAULT_CHAIN = ("api", "applescript")

# Frames that mean the main thread is inside a nested modal loop: a context menu, the menu
# bar, a sheet, a modal dialog. Read from the live fault (a context menu) plus the shapes
# next to it in AppKit, because they all block the same way. A sheet check does NOT find a
# context menu — the previous diagnosis asked for sheets, got zero, and looked elsewhere
# for four hours.
MODAL_FRAMES = (
    "NSMenuTrackingSession",
    "_NSPopUpMenu",
    "_popUpContextMenu",
    "NSCarbonMenuImpl",
    "runModalSession",
    "runModalForWindow",
    "_NSModalSession",
    "NSMenuTrackingRunLoopMode",
)


class Unreachable(Exception):
    """A rung cannot serve, with the reason already worded for a human.

    `advice` is the half that is about the MACHINE rather than about the rung — the
    main-thread diagnosis and its remedy — and it travels apart so that three rungs failing
    over one wedged app say it once instead of three times."""

    def __init__(self, reason, advice=""):
        super().__init__(reason)
        self.advice = advice


def osascript_run(script, timeout=None):
    """One AppleScript under a deadline THIS process holds.

    Returns `("ok", text)`, `("timeout", "")` or `("error", message)`.

    The library's own runner calls `communicate()` with no timeout at all, which is how a
    single unanswered AppleEvent became an unkillable launcher. Here the child is ours: on
    the deadline it is killed and reaped, and the caller is told it timed out rather than
    waiting behind it. Every AppleScript in this file goes through here."""
    timeout = PROBE_TIMEOUT if timeout is None else timeout
    try:
        proc = subprocess.Popen([OSASCRIPT, "-"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except OSError as exc:
        return "error", str(exc)
    try:
        out, err = proc.communicate(script, timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.communicate(timeout=5)
        except Exception:
            pass
        return "timeout", ""
    if proc.returncode != 0:
        lines = [l for l in (err or "").strip().splitlines() if l.strip()]
        return "error", lines[-1] if lines else "osascript exited %d" % proc.returncode
    return "ok", (out or "").strip()


def app_pid():
    """The running app's pid as a string, or "". ORCHESTRATOR_APP_PID stands in for the
    lookup where there is no app to find."""
    if APP_PID:
        return APP_PID
    try:
        out = subprocess.run(["pgrep", "-x", "iTerm2"], capture_output=True,
                             text=True, timeout=10).stdout.split()
    except Exception:
        return ""
    return out[0] if out else ""


def app_responsive(timeout=None):
    """Is the app dispatching AppleEvents right now? `(True, version)` or `(False, reason)`.

    The cheapest question that proves the main thread is alive, asked BEFORE the API
    library is entered. It has to be asked from outside: the library's cookie request is a
    blocking read inside the connection's own setup, and no timeout this file could set
    would reach it. An app that cannot answer `version` in eight seconds is never asked for
    a cookie, and that is what makes the hang impossible rather than merely shorter."""
    status, text = osascript_run('tell application "iTerm2" to return version', timeout)
    if status == "ok" and text:
        return True, text
    return False, status


def cause_from_sample(text):
    """What a main-thread sample says about an app that will not answer, in one sentence.

    A sample is the only reading that tells « busy » from « wedged in a modal loop », and
    the modal loop is the one an operator clears with a single keystroke without restarting
    anything or opening any settings pane. The remedy travels with the cause because that
    is the part that was missing: the fault took four hours to find and one Escape to fix."""
    if not text.strip():
        return ("iTerm2 does not answer AppleEvents and its main thread could not be "
                "sampled. Check the app is still running.")
    if any(frame in text for frame in MODAL_FRAMES):
        return ("iTerm2's main thread is inside a MODAL event loop: a context menu, a menu "
                "or a dialog is open in the app. AppleEvents are not dispatched while one "
                "runs, so neither the API nor AppleScript can reach it. Dismiss it — press "
                "Escape in the iTerm2 window, or click elsewhere. No restart and no change "
                "of settings is needed, and no session is lost.")
    return ("iTerm2 is running but its main thread is not dispatching AppleEvents. Sample "
            "it to see what holds it: `sample %s 3`." % (app_pid() or "<iTerm2 pid>"))


_diagnosis = {}


def diagnose_app():
    """The sentence to print when the app will not answer. Never raises, never hangs.

    Read ONCE per run: an app does not change state between two rungs of the same ladder,
    and a sample costs a second and a half that would otherwise be spent per rung."""
    if "text" in _diagnosis:
        return _diagnosis["text"]
    _diagnosis["text"] = _diagnose_app()
    return _diagnosis["text"]


def _diagnose_app():
    pid = app_pid()
    if not pid:
        return "iTerm2 is not running."
    try:
        text = subprocess.run([SAMPLE, pid, "1"], capture_output=True,
                              text=True, timeout=30).stdout
    except Exception:
        text = ""
    return cause_from_sample(text)


def backend_chain():
    """The rungs to try, in order, for this run.

    ORCHESTRATOR_BACKEND names one and only that one — a caller debugging the API wants its
    failure, not a fallback that hides it. Anything else is refused rather than quietly
    read as the default: a misspelt backend that silently became `auto` would be a fallback
    nobody asked for, discovered the day it mattered."""
    asked = (os.environ.get("ORCHESTRATOR_BACKEND") or "auto").strip().lower()
    if asked in ("", "auto"):
        return DEFAULT_CHAIN
    if asked not in BACKENDS:
        die("unknown backend: %s (expected auto, %s)" % (asked, ", ".join(BACKENDS)))
    return (asked,)


def ps_rows(tty):
    """`(pid, command)` for every process on a tty, from `ps` or from the suite's stand-in.

    ORCHESTRATOR_PS_TABLE names a file that replaces `ps`, one `<tty> <command>` line per
    process; a table written to check a name carries no pid, so the pid is empty there. Both
    readers below are built on this, and so is the close's proof, because they were asking
    the process table the same question in three different ways."""
    short = tty.replace("/dev/", "")
    table = os.environ.get("ORCHESTRATOR_PS_TABLE", "")
    try:
        if table:
            with open(table) as fh:
                lines = [l.strip().split(None, 1) for l in fh if l.strip()]
            return [("", r[1]) for r in lines
                    if len(r) == 2 and r[0].replace("/dev/", "") == short]
        out = subprocess.run(["ps", "-t", short, "-o", "pid=,command="],
                             capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return []
    rows = []
    for line in out.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2:
            rows.append((parts[0], parts[1]))
    return rows


def host_cli_on(tty):
    """What the host CLI on a tty is — its pid, or its command line where the suite's table
    carries no pid — or None when it is not there. Truthy means « still running »."""
    pattern = re.compile(r"^(\S*/)?" + re.escape(HOST_CLI) + r"(\s|$)")
    for pid, command in ps_rows(tty):
        if pattern.match(command):
            return pid or command
    return None


def wait_gone(tty, timeout=None):
    """Wait for the host CLI to leave a tty. None when it is gone, otherwise what survived.

    `close` used to print « closed 1 session » as soon as the API acknowledged the request,
    and the operator read that line as a fact. It is not one: the acknowledgement says the
    request was TAKEN. The session whose close first exposed this kept running for minutes
    afterwards and had to be ended by hand, while the launcher had already reported success
    and moved on. The process table is the only thing that answers « is it gone »."""
    timeout = CLOSE_TIMEOUT if timeout is None else timeout
    deadline = time.time() + timeout
    while True:
        alive = host_cli_on(tty)
        if alive is None:
            return None
        if time.time() >= deadline:
            return alive
        time.sleep(0.3)


# --- the ladder: the rung that can serve, and it says which one did (§46) -----------

_api_probe = {}


def as_quote(s):
    """One AppleScript string literal. A path or a title with a quote in it is not a
    syntax error to be discovered on a live spawn."""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def api_ready():
    """The library, or `Unreachable` saying why this rung cannot be used.

    Two gates, in the order that costs least: the module has to be installed, and the app
    has to be ANSWERING. The second is the one that matters, and it is asked from outside
    the library on purpose — see `app_responsive`. A successful probe is remembered for the
    life of this process, because a single run asks several times and an app that answered
    a moment ago is answering; a failure is never cached, so a menu dismissed between two
    calls is seen immediately."""
    try:
        import iterm2  # noqa: F401
    except ImportError:
        raise Unreachable(
            "the iterm2 module is not installed for %s; run /orchestrator:install"
            % sys.executable)
    if not _api_probe.get("ok"):
        ok, reason = app_responsive()
        if not ok:
            raise Unreachable(
                "iTerm2 did not answer a version request within %ds (%s)"
                % (PROBE_TIMEOUT, reason), diagnose_app())
        _api_probe["ok"] = True
    return sys.modules["iterm2"]


def served_by(what, rungs):
    """Run `what` on the first rung that can serve it, and SAY which one did.

    `rungs` maps a backend name to a callable; a name absent from it does not serve this
    command and is skipped with a word. Every fall is reported on stderr with the reason
    the rung above refused, because a fallback nobody is told about is a tool that behaves
    differently on two machines for reasons nobody can see."""
    chain = backend_chain()
    troubles = []
    advice = []
    for name in chain:
        fn = rungs.get(name)
        if fn is None:
            troubles.append("%s does not serve %s" % (name, what))
            continue
        try:
            value = fn()
        except Unreachable as exc:
            troubles.append("%s: %s" % (name, exc))
            if exc.advice and exc.advice not in advice:
                advice.append(exc.advice)
            continue
        if troubles:
            print("%s: served by the %s rung. %s"
                  % (what, name, said(troubles, advice)), file=sys.stderr)
        return value
    die("%s: no terminal backend could serve this. %s" % (what, said(troubles, advice)))


def said(troubles, advice):
    return "; ".join(troubles) + ("." if troubles else "") + \
        ("".join(" " + a for a in advice))


# --- the AppleScript rung ----------------------------------------------------------
#
# It survives what the API alone does not: the module missing, the environment unbuilt,
# the API server switched off, a cookie refused. It does NOT survive a wedged main thread
# — it needs the same run loop — which is exactly why there is a rung below it.

def as_run(script, what):
    status, text = osascript_run(script, PROBE_TIMEOUT)
    if status == "timeout":
        raise Unreachable("iTerm2 did not answer %s within %ds" % (what, PROBE_TIMEOUT),
                          diagnose_app())
    if status == "error":
        raise Unreachable("iTerm2 refused %s: %s" % (what, text))
    return text


def as_list():
    rows = as_run('''
        set out to ""
        tell application "iTerm2"
          set wi to 0
          repeat with w in windows
            set wi to wi + 1
            set ti to 0
            repeat with t in tabs of w
              set ti to ti + 1
              repeat with s in sessions of t
                set out to out & wi & " " & ti & " " & (tty of s) & " " & (name of s) & linefeed
              end repeat
            end repeat
          end repeat
        end tell
        return out''', "a listing")
    lines = []
    for line in rows.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 3:
            continue
        wi, ti, tty = parts[:3]
        title = parts[3] if len(parts) > 3 else ""
        lines.append(row_for(int(wi), int(ti), tty, title, session_name_on(tty), False, False))
    return lines


def as_close(tty, expect):
    name = as_run('''
        tell application "iTerm2"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if (tty of s) is %s then
                  set n to name of s
                  close s
                  return n
                end if
              end repeat
            end repeat
          end repeat
        end tell
        return ""''' % as_quote(tty), "a close")
    if not name:
        die("close: no session found on %s" % tty)
    # The guard is the API rung's own, applied here too: a rung that closed what the rung
    # above would have refused is a fallback that is not the same tool.
    if expect and stable_title(expect) not in stable_title(name):
        die("close: refused: session on %s is titled '%s', which does not contain '%s'"
            % (tty, name, expect))
    return name


def as_spawn(command):
    return as_run('''
        tell application "iTerm2"
          if (count of windows) is 0 then
            set w to (create window with default profile command %s)
            return tty of current session of current tab of w
          end if
          tell current window
            set t to (create tab with default profile command %s)
            return tty of current session of t
          end tell
        end tell''' % (as_quote(command), as_quote(command)), "a new tab")



# --- the tier map ----------------------------------------------------------------

def resolve_tier(tier):
    """A tier in, the identifier the operator bound to it out. An unbound tier returns the
    empty string and succeeds: the caller reads that as "let the host choose", which is a
    better answer than a name this plugin has no business carrying."""
    if tier not in TIERS:
        die("resolve-tier: unknown tier: %s (expected deep, standard or light)" % tier)
    override = os.environ.get("ORCHESTRATOR_TIER_" + tier.upper())
    if override:
        return override
    if not os.path.isfile(MODELS_MAP):
        return ""
    try:
        with open(MODELS_MAP) as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            raise ValueError("not an object")
    except Exception:
        # A map that does not parse is NOT an unbound tier. Reading the two alike sends
        # every dispatch to the host's default while the caller reports the tier it
        # believes it asked for: one missing comma, and the routing is advisory in silence.
        die("resolve-tier: %s does not read as a tier map (invalid JSON, empty, or not an object)" % MODELS_MAP)
    value = data.get(tier) or ""
    return "" if value is None else str(value)


def inherited_model():
    """The model the CALLING session runs on now, from the context tap's record — not the
    launch line, which the operator may have moved away from. A succession must not guess
    a model and the operator forbids a default (§27)."""
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    path = os.path.join(STATE_DIR, "ctx", sid + ".json") if sid else "<CLAUDE_CODE_SESSION_ID unset>"
    model = ""
    try:
        with open(path) as fh:
            model = json.load(fh).get("model_id") or ""
    except Exception:
        pass
    if not model:
        die("spawn: --inherit-model: no model recorded for this session (%s) — the context "
            "tap must be installed and rendering: /orchestrator:install, then restart" % path)
    return model


# --- ps, which the API does not answer -------------------------------------------

def cli_pid_on_tty(tty):
    """The pid of the host CLI on a tty, or None. The API knows tabs; only the process
    table knows whether the thing we launched is actually running."""
    return host_cli_on(tty)


# What a row shows for a session that WAS launched with a name the process table cannot
# give back. Distinct from None, which means no name was given at all: an orchestrator acts
# differently on the two, and a listing that merged them would be lying about one of them.
UNREADABLE_NAME = "\x00unreadable"
# Past this, a reconstruction is not a name but the launch line behind it. The same forty
# characters the successor's refusal already quotes, for the same reason: measured live at
# 366 characters, and a launch line must not fill a terminal.
NAME_READABLE_MAX = 40


def session_name_on(tty):
    """The name the host session on a tty was launched with (`--name`).

    None when none was given, `UNREADABLE_NAME` when one was and the table cannot give it
    back, the name itself otherwise.

    The tab title is the host's summary of the conversation and it is rewritten as the
    session works: a listing showing one of those named nothing an orchestrator could
    recognise, which is how a stranger's tab was taken for one's own (§38). The name is
    fixed at launch, and the API does not carry it, so it is read from the process table.

    ORCHESTRATOR_PS_TABLE names a file that stands in for `ps`, one line per process,
    `<tty> <command>`. The suite sets it; a live run never does.

    **`ps` hands back a FLAT command line**: the quoting that made the name one argument is
    gone, and the words after `--name` run on until the next option or the end of the line.
    The launcher puts `--name` last precisely so that the end of the line is the end of the
    name (§42). A launch that does otherwise — a prompt placed after it — leaves a boundary
    nothing here can recover.

    The bound is LENGTH, not shape. A name under another convention is still a name and is
    still what the operator sees, so `Orchestrator : f` reads back whole and the shape check
    stays where it belongs, on the successor that derives from it (§39); what cannot be a
    name at all is a reconstruction longer than any name — the forty characters this file
    already refuses to let a launch line fill a terminal with. Observed on three sessions a
    hand-rolled launch had made: the listing's « who is this session » column carried a
    whole brief path and the sentence naming another orchestrator (§48). A name invented by
    wherever the words happened to stop would be worse than saying it cannot be read: it is
    a name an orchestrator would then address."""
    for _, command in ps_rows(tty):
        words = command.split()
        if "--name" not in words:
            continue
        name = []
        for word in words[words.index("--name") + 1:]:
            if word.startswith("--"):
                break
            name.append(word)
        if not name:
            continue
        joined = " ".join(name)
        return joined if len(joined) <= NAME_READABLE_MAX else UNREADABLE_NAME
    return None


def self_tty():
    """This process's controlling tty, found by walking up the process tree: the caller
    that wants a tab beside ITS OWN should not have to know which tab that is.

    ORCHESTRATOR_SELF_TTY overrides the walk, so the chain can be tested where there is no
    terminal."""
    if SELF_TTY:
        return SELF_TTY
    pid = os.getpid()
    for _ in range(12):
        try:
            out = subprocess.run(["ps", "-p", str(pid), "-o", "ppid=,tty="],
                                 capture_output=True, text=True, timeout=10).stdout.strip()
        except Exception:
            return None
        if not out:
            return None
        ppid, tty = (out.split() + ["", ""])[:2]
        if tty and tty not in ("??", "-"):
            return "/dev/" + tty
        pid = int(ppid)
        if pid <= 1:
            return None
    return None


# --- the chain: an orchestrator's agents, in launch order -------------------------

def chain_path(tty):
    return os.path.join(CHAINS_DIR, os.path.basename(tty) + ".jsonl")


def chain_read(tty):
    """The chain as a list of {"tab_id", "tty"}; empty when absent or unreadable. A chain
    that cannot be read anchors on the orchestrator itself, which is where the first agent
    went before the chain existed."""
    try:
        with open(chain_path(tty)) as fh:
            lines = [l for l in fh.read().splitlines() if l.strip()]
        entries = [json.loads(l) for l in lines]
        return [e for e in entries if isinstance(e, dict) and e.get("tab_id") and e.get("tty")]
    except Exception:
        return []


def chain_write(tty, entries):
    os.makedirs(CHAINS_DIR, exist_ok=True)
    path = chain_path(tty)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        for e in entries:
            fh.write(json.dumps({"tab_id": e["tab_id"], "tty": e["tty"],
                                 "owner": e.get("owner", "")}) + "\n")
    os.replace(tmp, path)


def chain_append(tty, tab_id, new_tty, owner):
    chain_write(tty, chain_read(tty) + [{"tab_id": tab_id, "tty": new_tty, "owner": owner}])


def chain_transfer(old_tty, old_owner, new_tty, new_owner):
    """The predecessor's agents become the successor's (§34).

    A successor spawned after the last agent, and appended to the predecessor's chain as
    if it were one, inherited nothing: its own file was empty or a dead session's, so its
    first `--right-of self` landed left of the agents it had just taken over. The entries
    the predecessor wrote move under the successor's tty and session id; what the
    predecessor's file held from other occupants of its tty stays there; whatever a
    recycled tty's file held on the successor's side is replaced, never appended to."""
    entries = chain_read(old_tty)
    moved = chain_owned(entries, old_owner)
    kept = [e for e in entries if e not in moved]
    chain_write(new_tty, [{"tab_id": e["tab_id"], "tty": e["tty"], "owner": new_owner}
                          for e in moved])
    chain_write(old_tty, kept)
    return len(moved)


def chain_owned(entries, owner):
    """The entries this session wrote. A tty is recycled minutes after a close and the
    chain file named after it outlives its occupant: a successor on the same tty once
    inherited an entry naming its predecessor's tab, still open, and anchored on it. With
    no owner known (a dry run without ORCHESTRATOR_SELF_ID) nothing is filtered."""
    if not owner:
        return entries
    return [e for e in entries if e.get("owner") == owner]


def chain_drop_tab(tab_id):
    """Every chain, every entry naming this tab. `close` does not know which orchestrator
    the tab belonged to, and a tab id names exactly one tab."""
    if not os.path.isdir(CHAINS_DIR):
        return
    for name in os.listdir(CHAINS_DIR):
        if not name.endswith(".jsonl"):
            continue
        tty = "/dev/" + name[:-len(".jsonl")]
        entries = chain_read(tty)
        kept = [e for e in entries if e["tab_id"] != tab_id]
        if len(kept) != len(entries):
            chain_write(tty, kept)


async def move_is_owned(app, tty, own):
    """Whether the tab on `tty` is the caller's own tab or one its session launched.

    Matched on the TAB id, never on the tty: a tty is recycled minutes after a close and
    the chain file named after it outlives its occupant, so an entry whose tty now belongs
    to a stranger's tab must not make that tab movable — the reading §26 already gave the
    anchor. The owner is the session sitting on the caller's tty right now, read from the
    app, which is the only thing that says who is there. A caller whose own tab cannot be
    read owns nothing here: moving a stranger's tab is the harm this guard exists for, and
    `--force` is how the operator overrides it."""
    if not own:
        return False
    if tty == own:
        return True
    _, tab, _ = await find_tab(app, tty)
    _, _, own_sess = await find_tab(app, own)
    if tab is None or own_sess is None:
        return False
    mine = {e["tab_id"] for e in chain_owned(chain_read(own), own_sess.session_id)}
    return tab.tab_id in mine


async def chain_anchor(app, own_tty):
    """The tty of the last agent still open in the orchestrator's window, or None.

    Checked on tab id, never on tty: a tty is recycled minutes after a close, and an entry
    whose tty now belongs to a stranger's tab must not anchor a launch on it. Entries whose
    tab is gone are dropped on this read."""
    win, _, own_sess = await find_tab(app, own_tty)
    if win is None:
        return None
    live = {t.tab_id: t for t in win.tabs}
    entries = chain_read(own_tty)
    kept = [e for e in chain_owned(entries, own_sess.session_id) if e["tab_id"] in live]
    if len(kept) != len(entries):
        chain_write(own_tty, kept)
    for e in reversed(kept):
        tty = await tty_of(live[e["tab_id"]])
        if tty:
            return tty
    return None


# --- the API ---------------------------------------------------------------------

def run(coro_fn):
    """Drive the API, having first PROVED the app answers.

    The preflight is the whole repair: the library authenticates by asking the app for a
    cookie through an `osascript` it never bounds, so once the app stops dispatching
    AppleEvents nothing inside this call can ever return, and no timeout set here could
    reach it. Asking `version` from outside, under our own deadline, is what turns an
    unkillable wait into a sentence (§46)."""
    iterm2 = api_ready()
    result = {}

    async def main(connection):
        result["value"] = await coro_fn(iterm2, connection)

    iterm2.run_until_complete(main)
    return result.get("value")


async def tab_index_of(app, window, tab_id):
    """Always re-read the app after a mutation: the window object caches its tab list, and
    a reorder read back through the stale copy looks like a reorder that did not happen."""
    for w in app.windows:
        if w.window_id == window.window_id:
            ids = [t.tab_id for t in w.tabs]
            return (ids.index(tab_id) if tab_id in ids else None), w
    return None, window


async def tty_of(tab, connection=None, tries=10):
    """The tty of a tab's current session, waited for rather than assumed.

    A tab comes back from creation before its session is necessarily attached to the object
    handed over: `current_session` reads None, and the attribute error that follows names
    nothing useful. It is a race, so it is intermittent — the first probes never saw it, and
    a rotation found it on the fourth spawn of one run. Where a connection is available the
    app is re-fetched, because the tab we hold may be the stale copy."""
    for attempt in range(tries):
        sess = tab.current_session
        if sess is not None:
            try:
                return await sess.async_get_variable("tty")
            except Exception:
                pass
        await asyncio.sleep(0.3)
        if connection is not None:
            import iterm2 as _i
            fresh = await _i.async_get_app(connection)
            for w in fresh.windows:
                for t in w.tabs:
                    if t.tab_id == tab.tab_id:
                        tab = t
    return None


async def own_session_id(app, tty):
    """The app's id for the session on the caller's own tty, or "" when it has none.

    The caller is not always IN the app. A session running in another terminal — a
    multiplexer, a plain shell, a remote one — still has a tty, `self_tty` still resolves
    it, and the app simply has no session on it. The chain is the app's and cannot be kept
    for a tab the app does not know: that is a fact to state once, not a reason to fail.
    Before this, the lookup indexed straight into the result and a spawn from such a session
    died on `AttributeError: 'NoneType' object has no attribute 'session_id'` — a traceback
    where the answer was « your terminal is not one of mine, so I kept no chain » (§49)."""
    if not tty:
        return ""
    _, _, sess = await find_tab(app, tty)
    return sess.session_id if sess is not None else ""


async def find_tab(app, tty):
    """A session behind a maximized sibling is in all_sessions and not in sessions (§25)."""
    for w in app.windows:
        for t in w.tabs:
            for s in t.all_sessions:
                if await s.async_get_variable("tty") == tty:
                    return w, t, s
    return None, None, None


async def anchor_position(app, anchor, side):
    """The window that holds `anchor` and the index a new tab takes to sit on `side` of it.

    Every window is searched, not the one in front: the window in front is whatever the
    operator is looking at, and a launch happens precisely when they are looking elsewhere.
    The first implementation took `app.current_window` and searched only its tabs, so an
    anchor in another window was not found and the tab was appended to the wrong one, with
    the script reporting success. (None, None) when the anchor is not there."""
    win, tab, _ = await find_tab(app, anchor)
    if tab is None:
        return None, None
    idx, win = await tab_index_of(app, win, tab.tab_id)
    if idx is None:
        return None, None
    return win, idx + (1 if side == "right" else 0)


# --- subcommands -----------------------------------------------------------------

def row_for(w, t, tty, title, name, is_self, hidden):
    """One listing row, formatted and nothing else, so its shape is read without an app.

    The session name sits beside the tab title because they answer different questions:
    the title says what the session is doing right now, the name says who it is. A caller
    launched by hand carries no name, and `(host default)` says that rather than leaving
    a column an orchestrator would read as a name."""
    if name == UNREADABLE_NAME:
        shown = "(name unreadable)"
    else:
        shown = name or "(host default)"
    row = "w%d/t%d | %s | %s | %s" % (w, t, tty, title, shown)
    if is_self:
        row += " | self"
    if hidden:
        row += " | hidden"
    return row


async def list_rows(app):
    """One row per session, hidden panes included and marked. A pane behind a maximized
    sibling is what the host extension's review views make of an agent's tab; a listing
    that dropped it made a live agent unfindable and unclosable (§25).

    The caller's own row is marked `self`, read the way `--right-of self` reads it, so an
    orchestrator knows which tab is its own BEFORE it anchors, moves or closes anything —
    the reading a layout repair once went without (§38)."""
    own = self_tty() or ""
    lines = []
    for wi, w in enumerate(app.windows, 1):
        for ti, t in enumerate(w.tabs, 1):
            visible = {s.session_id for s in t.sessions}
            for s in t.all_sessions:
                tty = await s.async_get_variable("tty")
                title = await s.async_get_variable("autoName") or ""
                lines.append(row_for(wi, ti, tty, title, session_name_on(tty),
                                     bool(own) and tty == own, s.session_id not in visible))
    return lines


def cmd_list(_argv):
    async def go(iterm2, connection):
        app = await iterm2.async_get_app(connection)
        return await list_rows(app)

    rows = served_by("list", {"api": lambda: run(go), "applescript": as_list})
    for line in rows or []:
        print(line)


def write_prompt_file(prompt, title):
    os.makedirs(PROMPTS_DIR, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", title)[:40] or "agent"
    path = os.path.join(PROMPTS_DIR, "prompt-%s-%d.txt" % (safe, int(time.time() * 1000)))
    with open(path, "w") as fh:
        fh.write(prompt)
    return path


def build_command(dir_, title, model, mode, prompt_file, remote_control="", mcp_file=""):
    """The command iTerm2 runs in the new tab. It is HANDED to the app, never typed, so
    its length and its bytes stop being a hazard. No model argument at all when neither a
    tier nor an explicit identifier says which: the host's own default is the right
    answer, and a name hardcoded here would be a routing decision taken for every
    operator."""
    # The ABSOLUTE path, resolved from the environment the orchestrator has. The tab runs
    # the launch through a login shell now (§22), so a bare name would usually resolve —
    # but finding the program must not depend on the operator's dotfiles: a profile that
    # breaks PATH would kill the launch, and the session would die before its tty could be
    # read, which is how the first spawn under the bare default died.
    import shutil
    cli_path = shutil.which(HOST_CLI) or HOST_CLI
    parts = ["cd %s" % shq(dir_),
             "printf '\\033]0;%%s\\007' %s" % shq(title),
             None]
    cli = [shq(cli_path)]
    if model:
        cli += ["--model", shq(model)]
    # The launch is strict ALWAYS, and hands the session a configuration file of its own
    # when it has servers to load (§42). Strict alone would leave an agent with no server
    # of any scope — not the project's, but not the operator's or the account's either,
    # which is what the first answer to this section got wrong; the file puts back exactly
    # the ones the orchestrator chose. The pair goes BEFORE --permission-mode: the host's
    # --mcp-config takes several values, so whatever follows it is read as another file,
    # and the prompt placed there was read as one.
    cli += ["--strict-mcp-config"]
    if mcp_file:
        cli += ["--mcp-config", shq(mcp_file)]
    cli += ["--permission-mode", shq(mode)]
    # An agent is driven by its orchestrator alone (§39): remote control comes up OFF for
    # everyone but a successor, which the operator also drives from the host's remote
    # client. The setting and the flag below are mutually exclusive — only a successor
    # carries the flag, and it carries no such setting.
    if not remote_control:
        cli += ["--settings", shq('{"remoteControlAtStartup":false}')]
    # The prompt goes BEFORE the options that follow it, and --name is the LAST of them or
    # next to last. `ps` shows a command line with the shell's quoting gone, so whatever
    # follows --name runs into the name: with the prompt there, every spawned session's
    # name read the title followed by the whole brief, and the listing that was meant to
    # say who a session is said that instead. The host takes the prompt before its options.
    if prompt_file:
        cli.append('"$(cat %s)"' % shq(prompt_file))
    # The title is the session's name: the host shows it in its prompt, its resume picker
    # and the terminal title, and applies a variant when a live session already holds it.
    # Without it two sessions in one checkout share the host's stem and differ only by a
    # reference (§24).
    cli += ["--name", shq(title)]
    # Only a successor gets it: the operator drives his orchestrators from the host's
    # remote client as well as from the tab, and an agent is driven by its orchestrator
    # alone (§39). A first instantiation is the operator's own hand, and his launch line.
    if remote_control:
        cli += ["--remote-control", shq(remote_control)]
    parts[2] = "exec " + " ".join(cli)
    return " && ".join(parts)


def write_launch_script(command, title):
    """The launch goes to a FILE and the app is asked to run `<login shell> -l <file>`.

    The app executes what it is given as the session's program, splitting it into words
    itself: a compound command handed over raw is not run by any shell, the session dies
    the moment it is born, and the tty read a breath later belongs to nothing — observed
    as SESSION_NOT_FOUND on the first live spawn. Quoting the whole thing for that
    tokenizer is the same losing game the typed version played. A path has no quoting."""
    os.makedirs(PROMPTS_DIR, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", title)[:40] or "agent"
    path = os.path.join(PROMPTS_DIR, "launch-%s-%d.sh" % (safe, int(time.time() * 1000)))
    with open(path, "w") as fh:
        fh.write("#!/bin/sh\n" + command + "\n")
    return path


def shq(s):
    """`shlex.quote` treats `-` as a safe character and leaves a value starting with it
    bare — `--title-free --title=--evil` then emitted `--name --evil`, which the host read
    as its own option instead of the name's value. Force the quotes whenever the first
    character is a dash, whatever `shlex.quote` would otherwise decide."""
    import shlex
    q = shlex.quote(s)
    if s.startswith("-") and q == s:
        q = "'" + s.replace("'", "'\\''") + "'"
    return q


TRUST_FILE = os.environ.get("ORCHESTRATOR_TRUST_FILE") or os.path.join(os.path.expanduser("~"), ".claude.json")


def directory_is_trusted(path):
    """Whether the host will open this directory without asking.

    A directory it has never seen stops the session on a workspace-trust question whose
    highlighted answer is "exit". Nobody sits at that keyboard: the session either waits
    for ever, having never read its brief, or takes a stray keystroke and quits. Both look
    like a launched agent from outside, because the process is genuinely running."""
    try:
        with open(TRUST_FILE) as fh:
            data = json.load(fh)
    except Exception:
        return None  # unknown: the record is not readable, so do not claim either way
    entry = (data.get("projects") or {}).get(os.path.realpath(path)) or \
            (data.get("projects") or {}).get(path)
    if entry is None:
        return False
    return bool(entry.get("hasTrustDialogAccepted"))


def grant_directory_trust(path):
    """Record the trust the operator would otherwise be asked for, for ONE directory.

    Only ever for a checkout the orchestrator prepared itself, which is why it takes an
    explicit flag: preparing the environment is the orchestrator's housekeeping, and
    granting trust to a tree it did not prepare is not."""
    real = os.path.realpath(path)
    try:
        with open(TRUST_FILE) as fh:
            data = json.load(fh)
    except FileNotFoundError:
        data = {}
    except Exception as exc:
        die("spawn: cannot read %s to grant trust: %s" % (TRUST_FILE, exc))
    projects = data.setdefault("projects", {})
    entry = projects.setdefault(real, {})
    entry["hasTrustDialogAccepted"] = True
    tmp = TRUST_FILE + ".orchestrator-tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, TRUST_FILE)


def anchor_after_probe(found, anchor, own):
    """The anchor to use once the app has been asked whether it knows it.

    Two refusals that look alike and are not. A NAMED anchor the app does not know is a tab
    the caller got wrong, and refusing it is right. The caller's OWN tty is a different
    reading: when the app has no session on it, the caller is running in ANOTHER TERMINAL —
    a multiplexer, a plain shell, a remote one — and « place the new tab beside me » has no
    meaning there. Nobody named a wrong tab; there is simply no tab.

    Refusing that case blocked the one spawn that exists to end it. A session outside the app
    could not spawn its own successor at all — `--successor` anchors on self — so the
    succession ordered precisely to bring such a session back into the app was the one thing
    it could not do (§51). The anchor is dropped, the new tab lands where the app puts it,
    and the reason is said."""
    if found:
        return anchor
    if anchor and anchor == own:
        print("spawn: this session is not a tab of the app's (%s), so the new tab cannot be "
              "placed beside it; it lands where the app puts it." % own, file=sys.stderr)
        return ""
    die("spawn: no session found on %s" % anchor)


def cmd_spawn(argv):
    p = argparse.ArgumentParser(prog="spawn", add_help=False)
    p.add_argument("--dir")
    p.add_argument("--model", default="")
    p.add_argument("--tier", default="")
    p.add_argument("--inherit-model", dest="inherit", action="store_true")
    p.add_argument("--permission-mode", dest="mode", default="auto")
    p.add_argument("--title", default="")
    p.add_argument("--title-free", dest="title_free", action="store_true", default=False)
    p.add_argument("--no-remote-control", dest="remote_control", action="store_false", default=True)
    p.add_argument("--prompt", default="")
    p.add_argument("--prompt-file", dest="prompt_file", default="")
    p.add_argument("--left-of", dest="left_of", default="")
    p.add_argument("--right-of", dest="right_of", default="")
    p.add_argument("--no-verify", dest="verify", action="store_false", default=True)
    p.add_argument("--trust", action="store_true", default=False)
    p.add_argument("--successor", action="store_true", default=False)
    p.add_argument("--mcp", action="append", default=[])
    args, unknown = p.parse_known_args(argv)
    if unknown:
        die("spawn: unknown option %s" % unknown[0])
    if not args.dir:
        die("spawn: --dir is required")
    if args.left_of and args.right_of:
        die("spawn: --left-of and --right-of are mutually exclusive")
    if args.successor and (args.left_of or args.right_of):
        die("spawn: --successor names its own anchor, immediately right of this session; "
            "drop --left-of and --right-of")
    if args.successor and args.title_free:
        die("spawn: refused: a successor is named after its caller, --title-free does not "
            "apply")
    if args.title.startswith("Orch :") and (args.left_of or args.right_of):
        # A plain anchor lands AFTER the chain (§21), so a successor spawned there is the
        # far-right tab the operator found, inheriting nothing. --successor places it and
        # hands the chain over; the title says which of the two this is.
        die("spawn: refused: an orchestrator's title is a successor's; spawn it with "
            "--successor, which places it and hands it the chain")
    if not os.path.isdir(args.dir):
        die("spawn: directory not found: %s" % args.dir)
    if args.prompt and args.prompt_file:
        die("spawn: --prompt and --prompt-file are exclusive")
    if args.tier and args.model:
        die("spawn: --tier and --model are mutually exclusive")
    if args.inherit and (args.tier or args.model):
        die("spawn: --inherit-model is exclusive with --tier and --model")
    model = args.model
    if args.tier:
        model = resolve_tier(args.tier)
        if model is None:
            die("spawn: cannot resolve tier: %s" % args.tier)
    if args.inherit:
        model = inherited_model()
    # The anchor first, before a prompt file is written or a trust record changed: an
    # anchor that is not there is a refusal, and a refusal must leave nothing behind.
    side = "right" if args.right_of else "left"
    anchor = args.right_of or args.left_of
    own = self_tty() or ""
    # The title, before a prompt file is written or a trust record changed: it is the
    # session's name, and a refusal on it must leave nothing behind either.
    title = args.title
    if args.title_free:
        # The escape, for a probe or a test that names its tab otherwise. `agent` was the
        # old default and it stays one HERE, where the caller has said the shape is not
        # wanted, and nowhere else.
        title = title or "agent"
    elif args.successor and not title:
        # A successor carries the predecessor's own name, so every brief that cites an
        # orchestrator by name still cites this one; the host applies its variant when a
        # live session already holds it, which is where the reference comes from (§39).
        title = session_name_on(own) or ""
        if not title:
            die("spawn: refused: --successor without --title needs the caller's session "
                "name, and this session was launched without one; pass "
                '--title "Orch : <subject>"')
        if title == UNREADABLE_NAME:
            die("spawn: refused: the caller's session name cannot be read from the process "
                "table — a launch that places its prompt after --name loses the boundary "
                'between the two; pass --title "Orch : <subject>"')
        if not TITLE_SHAPE.match(title):
            # The derived name answers to the same shape as a typed one: a caller named
            # under an older convention derives nothing, and neither does one whose name
            # is a whole launch line. Only the first forty characters are quoted back —
            # the rest of a launch line has no business filling a terminal.
            die("spawn: refused: the caller's session name '%s' does not read "
                '"Orch : <subject>"; pass --title "Orch : <subject>"' % title[:40])
    elif not TITLE_SHAPE.match(title):
        die("spawn: refused: a title reads \"Orch : <subject>\" or \"Agent : <subject>\", "
            "the subject at most 25 characters and neither starting nor ending with a "
            "space, got '%s' (pass --title-free for a tab named otherwise)" % title)
    if args.successor:
        # A successor is not an agent: immediately right of this session, the chain
        # ignored, and it takes the chain with it once its session can be read (§34).
        side, anchor = "right", "self"
    if anchor == "self":
        if not own and not DRY_RUN:
            die("spawn: --right-of self: cannot resolve this session's own tty")
        anchor = own or "self"
        if side == "right" and own and not args.successor:
            # After the orchestrator's LAST agent, not immediately after the orchestrator:
            # orchestrator, agent 1, agent 2, … in launch order.
            if DRY_RUN:
                chain = chain_owned(chain_read(own), SELF_ID)
                anchor = chain[-1]["tty"] if chain else "self"
            else:
                async def last(iterm2, connection):
                    app = await iterm2.async_get_app(connection)
                    return await chain_anchor(app, own)
                anchor = run(last) or own
    if anchor and anchor != "self" and not DRY_RUN:
        async def probe(iterm2, connection):
            app = await iterm2.async_get_app(connection)
            win, _ = await anchor_position(app, anchor, side)
            return win is not None
        anchor = anchor_after_probe(run(probe), anchor, own)
    # BEFORE the tab exists, and BEFORE the prompt file is written: a refusal on the trust
    # question must leave nothing behind — a prompt file written ahead of it survived every
    # refusal and piled up under the state directory's prompts/ for a directory that was
    # never launched into.
    trusted = directory_is_trusted(args.dir)
    if trusted is True:
        # Never rewrite a record that already says yes: the host writes this file too, and
        # a rewrite for nothing is a window in which one of the two loses an entry.
        trust_state = "already"
    elif args.trust:
        grant_directory_trust(args.dir)
        trust_state = "recorded"
    elif trusted is None:
        # A gate that cannot measure lets the launch through AND says so (§31).
        trust_state = "unread"
        print("spawn: the trust record %s cannot be read, so whether the host trusts %s is "
              "unknown; launching anyway. Pass --trust for a checkout you prepared, or open "
              "the directory once yourself." % (TRUST_FILE, os.path.realpath(args.dir)),
              file=sys.stderr)
    else:
        die("spawn: the host has not been told to trust %s, so the session would stop on "
            "its workspace question and never read its brief. Pass --trust for a checkout "
            "you prepared, or open the directory once yourself." % os.path.realpath(args.dir))

    # After the trust check and before the prompt file, in the order a refusal wants: the
    # catalogue and the names are read first, so a refusal on either leaves no file behind.
    catalogue = read_catalogue()
    servers = select_servers(args.mcp, catalogue)
    mcp_file = write_mcp_file(servers, catalogue, title) if servers else ""

    prompt_file = args.prompt_file
    if prompt_file and not os.path.isfile(prompt_file):
        die("spawn: prompt file not found: %s" % prompt_file)
    if args.prompt:
        prompt_file = write_prompt_file(args.prompt, title)

    remote_control = title if (args.successor and args.remote_control) else ""
    launch = build_command(args.dir, title, model, args.mode, prompt_file, remote_control,
                           mcp_file)

    if DRY_RUN:
        print("launch=%s" % launch)
        print("prompt_file=%s" % prompt_file)
        print("self=%s" % own)
        print("anchor=%s" % ("self" if anchor == own else anchor))
        print("trust=%s" % trust_state)
        print("successor=%s" % ("yes" if args.successor else "no"))
        print("name=%s" % title)
        print("title_free=%s" % ("yes" if args.title_free else "no"))
        print("mcp=%s" % (",".join(servers) or "none"))
        print("mcp_file=%s" % (mcp_file or "none"))
        print("remote_control=%s" % ("yes" if remote_control else "no"))
        print("mode_check=skipped")
        print("program=%s -l <launch-file>" % LOGIN_SHELL)
        return

    script = write_launch_script(launch, title)
    command = "%s -l %s" % (LOGIN_SHELL, script)

    made = {}

    async def go(iterm2, connection):
        app = await iterm2.async_get_app(connection)
        index = None
        if anchor:
            # Resolved again on a fresh app: the probe above ran on another connection,
            # and a window object is a cached copy (§14).
            win, index = await anchor_position(app, anchor, side)
            if win is None:
                die("spawn: no session found on %s" % anchor)
        else:
            win = app.current_window
            if win is None:
                die("spawn: iTerm2 has no current window")
        own_sess_id = await own_session_id(app, own)
        # select=False: the operator is working in another tab, and a spawn that pulls the
        # window to the new one interrupts them every time an agent is launched.
        tab = await win.async_create_tab(command=command, index=index, select=False)
        new = await tty_of(tab, connection)
        # Kept for the mode reading below: a refusal closes the session THIS spawn made,
        # by its own id, never by a tty another session could hold by then.
        made["tab_id"] = tab.tab_id
        made["session_id"] = tab.current_session.session_id if tab.current_session else ""
        if own and new and args.successor:
            new_sess = None
            for _ in range(10):
                fresh = await iterm2.async_get_app(connection)
                _, _, new_sess = await find_tab(fresh, new)
                if new_sess is not None:
                    break
                await asyncio.sleep(0.3)
            if new_sess is None:
                # A gate that cannot measure lets the launch through and says so.
                print("spawn: the successor's session on %s could not be read, so the chain "
                      "stays with %s; place its next agent with --right-of <last agent tty>."
                      % (new, own), file=sys.stderr)
            else:
                n = chain_transfer(own, own_sess_id, new, new_sess.session_id)
                print("spawn: chain of %d agent(s) handed to the successor on %s" % (n, new),
                      file=sys.stderr)
        elif own and new:
            chain_append(own, tab.tab_id, new, own_sess_id)
        return new

    def fallback_tab(make):
        """A real iTerm2 tab, made without the API. It places nothing and keeps no chain:
        the app's AppleScript exposes `index` in its dictionary but does not implement it
        (`-1728` on every form, measured on 3.7.0), and the only placement left there drives
        the menu bar through the accessibility layer — a grant, the app brought to the front
        and a focus flicker per move, which is what the API replaced. A tab that lands in the
        wrong place is an agent that runs; a placement bought at that price is not. Said out
        loud rather than assumed."""
        if anchor:
            print("spawn: this rung cannot place a tab; the new session lands where the "
                  "terminal puts it, not beside %s." % anchor, file=sys.stderr)
        return make()

    # Before the tab exists, so no transcript older than this launch can be taken for its.
    launch_epoch = time.time()
    new_tty = served_by("spawn", {
        "api": lambda: run(go),
        "applescript": lambda: fallback_tab(lambda: as_spawn(command)),
    })
    if not new_tty:
        die("spawn: the terminal returned no tty for the new tab")

    if args.verify:
        waited = 0
        pid = None
        while waited < SPAWN_TIMEOUT:
            pid = cli_pid_on_tty(new_tty)
            if pid:
                break
            time.sleep(1)
            waited += 1
        if not pid:
            die("spawn: %s never started on %s after %ss" % (HOST_CLI, new_tty, SPAWN_TIMEOUT))
        print("spawn: %s running on %s (pid %s)" % (HOST_CLI, new_tty, pid), file=sys.stderr)
        # « The host CLI runs on the tty » is not « the session is launched »: a session
        # that runs and waits for a click is not. The mode asked for is carried on the
        # process line and honoured for some models and not others, so the mode the session
        # actually came up in is read on its own transcript (§43).
        waited, mode = 0, ""
        while waited < MODE_TIMEOUT:
            path = find_transcript(args.dir, launch_epoch)
            if path:
                mode = mode_of_transcript(path)
                if mode:
                    break
            time.sleep(1)
            waited += 1
        if not mode:
            # A gate that cannot measure holds nothing, and says so (§29).
            print("spawn: no transcript for %s after %ss: the session's mode is unread"
                  % (args.dir, MODE_TIMEOUT), file=sys.stderr)
        elif mode != args.mode:
            close_made(made)
            die(mode_refusal(args.mode, mode, model))
        else:
            print("spawn: mode %s read on the transcript" % mode, file=sys.stderr)
    print(new_tty)


def cmd_screen(argv):
    """What a tab is showing, right now.

    An agent that has not shaken hands is inspected, not waited for — and inspecting it
    means reading what it is stopped on. The typed-command era read this through a
    scripting bridge; dropping that bridge dropped the reading with it, and the round that
    followed spent its sessions parked on a question nobody could see."""
    p = argparse.ArgumentParser(prog="screen", add_help=False)
    p.add_argument("--tty", dest="tty")
    p.add_argument("--lines", type=int, default=40)
    args, _ = p.parse_known_args(argv)
    if not args.tty:
        die("screen: --tty is required")

    async def go(iterm2, connection):
        app = await iterm2.async_get_app(connection)
        _, _, sess = await find_tab(app, args.tty)
        if sess is None:
            die("screen: no session found on %s" % args.tty)
        contents = await sess.async_get_screen_contents()
        every = [contents.line(i).string.rstrip()
                 for i in range(contents.number_of_lines)]
        return last_lines(every, args.lines)

    for line in run(go) or []:
        print(line)


def cmd_verify(argv):
    p = argparse.ArgumentParser(prog="verify", add_help=False)
    p.add_argument("--tty", dest="tty")
    args, _ = p.parse_known_args(argv)
    if not args.tty:
        die("verify: --tty is required")
    pid = cli_pid_on_tty(args.tty)
    if not pid:
        sys.exit(1)
    print("%s running on %s (pid %s)" % (HOST_CLI, args.tty, pid))


def stable_title(name):
    """A session's title without its leading activity glyph.

    The first character reflects whether the session is busy and flips on its own — `◑`
    while it works, `✳` once it idles. A rotation stands the old agent down and then takes
    ten seconds to bring up its replacement, so a title captured before it and compared
    after it is guaranteed to differ: the guard meant to make a close unambiguous refused
    every rotation instead. Both sides are stripped, so a caller that captured the glyph
    still matches."""
    return name.lstrip().lstrip("".join(c for c in name if not (c.isalnum() or c.isspace()))).strip()


def close_made(made):
    """Close the session a spawn just made, by its own id.

    A refusal after the tab exists must leave no tab: an agent nobody can use, in a window
    the operator reads, is worse than a spawn that failed. The id and not the tty, because
    a tty is a claim about a moment and the session is the thing that was created.

    The call is wrapped: `run()` catches nothing, and a refusal path that ends on a
    traceback is never an answer — the caller dies with `mode_refusal(...)` either way, so
    a close that fails must be SAID, not thrown."""
    session_id = made.get("session_id") or ""
    if not session_id:
        return False

    async def go(iterm2, connection):
        app = await iterm2.async_get_app(connection)
        for window in app.windows:
            for tab in window.tabs:
                for sess in tab.sessions:
                    if sess.session_id == session_id:
                        await sess.async_close(force=True)
                        chain_drop_tab(tab.tab_id)
                        return True
        return False

    try:
        return bool(run(go))
    except Exception as exc:
        print("spawn: the refused session could not be closed: %s"
              % (str(exc).splitlines() or ["unknown error"])[0], file=sys.stderr)
        return False


async def close_session(app, tty, expect):
    """Close the SESSION on that tty, never its tab: with the host extension in use the
    tab also holds the review pane the operator is reading, and a session closed alone
    leaves its siblings; when it was the last one the app removes the tab itself (§25)."""
    _, tab, sess = await find_tab(app, tty)
    if tab is None:
        die("close: no session found on %s" % tty)
    name = await sess.async_get_variable("autoName") or ""
    if expect and stable_title(expect) not in stable_title(name):
        die("close: refused: session on %s is titled '%s', which does not contain '%s'"
            % (tty, name, expect))
    await sess.async_close(force=True)
    chain_drop_tab(tab.tab_id)
    return name


def close_note(tty, was_running):
    """What the close's proof is worth, or "" when it is worth what it says.

    `wait_gone` watches the HOST CLI and nothing else, which is the process the fault was
    about. A tab holding only a shell has none, so the wait returns at once and the close
    is reported on the app's word alone — true of the close, and no evidence whatever about
    an agent. Saying which of the two happened costs one line and stops the stronger claim
    being read into the weaker case."""
    if was_running is None:
        return ("close: no %s was running on %s, so this close is the app's word, not a "
                "reading of the process table." % (HOST_CLI, tty))
    return ""


def cmd_close(argv):
    p = argparse.ArgumentParser(prog="close", add_help=False)
    p.add_argument("--tty", dest="tty")
    p.add_argument("--expect-title", dest="expect", default="")
    args, _ = p.parse_known_args(argv)
    if not args.tty:
        die("close: --tty is required")
    if DRY_RUN:
        print("close=%s expect_title=%s" % (args.tty, args.expect))
        return

    # Read BEFORE the close: what the proof below is a proof ABOUT.
    was_running = host_cli_on(args.tty)

    async def go(iterm2, connection):
        app = await iterm2.async_get_app(connection)
        return await close_session(app, args.tty, args.expect)

    served_by("close", {"api": lambda: run(go),
                        "applescript": lambda: as_close(args.tty, args.expect)})
    # The close is not what was asked for, it is what the process table shows. The line
    # below used to print the moment the request was acknowledged, over a session that
    # kept running for minutes and had to be ended by hand (§46).
    survivor = wait_gone(args.tty)
    if survivor is not None:
        die("close: the request was accepted but %s is still running on %s after %ds. "
            "The session was NOT closed." % (survivor, args.tty, CLOSE_TIMEOUT))
    note = close_note(args.tty, was_running)
    if note:
        print(note, file=sys.stderr)
    # The first line is the contract every skill, command and brief parses; the reading
    # that qualifies it goes to stderr rather than changing it.
    print("closed 1 session on %s" % args.tty)


def cmd_move(argv):
    p = argparse.ArgumentParser(prog="move", add_help=False)
    p.add_argument("--tty", dest="tty")
    p.add_argument("--left-of", dest="left_of", default="")
    p.add_argument("--right-of", dest="right_of", default="")
    p.add_argument("--force", action="store_true", default=False)
    args, _ = p.parse_known_args(argv)
    if not args.tty:
        die("move: --tty is required")
    if not args.left_of and not args.right_of:
        die("move: --left-of or --right-of is required")
    if args.left_of and args.right_of:
        die("move: --left-of and --right-of are mutually exclusive")
    own = self_tty() or ""
    anchor = args.right_of or args.left_of
    if anchor == "self":
        anchor = own
    if anchor == args.tty:
        die("move: --tty and its anchor are the same session")
    def guard(is_ours):
        """A session the caller did not launch is not its to place. An orchestrator that
        had never measured its own tty read the listing, took the last tab for its own and
        moved a stranger's session out from between itself and its agents; the script
        obeyed, because `move` moved anything it was told to (§38)."""
        if is_ours:
            return
        if not args.force:
            die("move: refused: %s is neither this session's tab nor in its chain "
                "(pass --force to move it anyway)" % args.tty)
        # --force is the operator's hand and the layout repair, and it says what it moved:
        # a forced move is the one an orchestrator has to be able to find afterwards.
        print("move: forced: %s is not in this session's chain" % args.tty, file=sys.stderr)

    if DRY_RUN:
        # No app, so no session id and no tab id: the dry run reads the chain the way the
        # rest of the dry run does, on ORCHESTRATOR_SELF_ID and the tty.
        guard(args.tty == own
              or args.tty in [e["tty"] for e in chain_owned(chain_read(own), SELF_ID)])
        print("move=%s %s=%s" % (args.tty, "right_of" if args.right_of else "left_of", anchor))
        return

    async def go(iterm2, connection):
        app = await iterm2.async_get_app(connection)
        win, tab, _ = await find_tab(app, args.tty)
        if tab is None:
            die("move: no session found on %s" % args.tty)
        guard(await move_is_owned(app, args.tty, own))
        tabs = list(win.tabs)
        target = None
        for i, t in enumerate(tabs):
            if await tty_of(t) == anchor:
                target = t
                break
        if target is None:
            die("move: no session found on %s" % anchor)
        tabs.remove(tab)
        at = tabs.index(target) + (1 if args.right_of else 0)
        tabs.insert(at, tab)
        await win.async_set_tabs(tabs)
        # Re-read the APP, not the window we already hold: both carry a cached tab list,
        # and a reorder read back through either looks like a reorder that never happened
        # — or, worse, reports the position the tab used to have.
        fresh = await iterm2.async_get_app(connection)
        idx, _ = await tab_index_of(fresh, win, tab.tab_id)
        return idx

    idx = run(go)
    print("moved %s to position %s" % (args.tty, idx))


def cmd_rotate(argv):
    p = argparse.ArgumentParser(prog="rotate", add_help=False)
    p.add_argument("--old-tty", dest="old_tty")
    p.add_argument("--expect-title", dest="expect", default="")
    args, rest = p.parse_known_args(argv)
    if not args.old_tty:
        die("rotate: --old-tty is required")
    # A rotation replaces an agent with a titled agent; none of these are that. A successor
    # is spawned with `spawn --successor`, not smuggled through the replacement a rotation
    # makes.
    for flag in ("--successor", "--title-free", "--no-remote-control"):
        if flag in rest:
            die("rotate: refused: %s is not a rotation's (a rotation replaces an agent with "
                "a titled agent; a successor is spawned with spawn --successor)" % flag)
    # The spawn verifies the replacement is RUNNING before anything is closed: a rotation
    # that killed the old agent on a spawn that never started would leave zero agents,
    # which is the one outcome this order exists to prevent.
    cmd_spawn(rest)
    close_args = ["--tty", args.old_tty]
    if args.expect:
        close_args += ["--expect-title", args.expect]
    cmd_close(close_args)


def cmd_resolve_tier(argv):
    if len(argv) != 1:
        die("resolve-tier: exactly one tier is required (deep, standard or light)")
    print(resolve_tier(argv[0]))


def cmd_trust(argv):
    """`trust prune [--apply]`: the record's entries whose directory no longer exists.

    A trust entry outlives its directory, and a checkout per phase adds one per dispatch,
    so the record only grows. An entry for a directory that is gone holds nothing the host
    can use. Listing is the default; only --apply writes, with the same temporary file,
    replace and owner-only mode as the writer that made the entries."""
    p = argparse.ArgumentParser(prog="trust", add_help=False)
    p.add_argument("action", nargs="?", default="")
    p.add_argument("--apply", action="store_true", default=False)
    args, unknown = p.parse_known_args(argv)
    if unknown or args.action != "prune":
        die("trust: usage: trust prune [--apply]")
    try:
        with open(TRUST_FILE) as fh:
            data = json.load(fh)
    except Exception as exc:
        die("trust: cannot read %s: %s" % (TRUST_FILE, exc))
    projects = data.get("projects") or {}
    gone = sorted(path for path in projects if not os.path.isdir(path))
    for path in gone:
        print(path)
    if not args.apply:
        print("trust: %d of %d entries name a directory that no longer exists; pass --apply "
              "to remove them" % (len(gone), len(projects)), file=sys.stderr)
        return
    for path in gone:
        del projects[path]
    tmp = TRUST_FILE + ".orchestrator-tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, TRUST_FILE)
    print("trust: removed %d entries, %d kept" % (len(gone), len(projects)), file=sys.stderr)


COMMANDS = {
    "list": cmd_list, "spawn": cmd_spawn, "verify": cmd_verify, "close": cmd_close,
    "move": cmd_move, "rotate": cmd_rotate, "resolve-tier": cmd_resolve_tier,
    "screen": cmd_screen, "trust": cmd_trust,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        die("usage: iterm-agent.sh {list|spawn|verify|screen|resolve-tier|close|move|rotate|trust} [options] (see header)")
    COMMANDS[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    main()
