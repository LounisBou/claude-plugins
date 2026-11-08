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
import collections
import glob
import json
import logging
import os
import re
import subprocess
import sys
import uuid
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


def tmux_owner():
    """The chain owner of a caller inside a tmux pane, or "" outside one.

    Every window of a tmux server inherits the server's ITERM_SESSION_ID, so the app's
    session id names no one session there; the pane does. The owner is
    `tmux:<socket path>:<pane id>`, the socket being the first comma-separated field of TMUX.
    The hooks module states the same rule (stop-gate.ts, `chainOwner`)."""
    tmux, pane = os.environ.get("TMUX", ""), os.environ.get("TMUX_PANE", "")
    return "tmux:%s:%s" % (tmux.split(",")[0], pane) if tmux and pane else ""


# The caller's chain owner, for a dry run that has no app to ask (§26).
SELF_ID = tmux_owner() or os.environ.get("ORCHESTRATOR_SELF_ID", "")
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
# The host's effort levels. A tier may bind one with its model: effort moves token spend
# as much as the model family does.
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# The effort an agent's tier runs at when the operator's map binds the tier a model alone
# (decision 3 of docs/agent-dispatches.md, dated there). The deep tier has none of its own:
# it runs at the effort its calling orchestrator runs at now, read on that orchestrator's
# transcript. An effort the map binds wins over both.
SHIPPED_TIER_EFFORTS = {"standard": "high", "light": "medium"}
EFFORT_LIST = "low, medium, high, xhigh or max"
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
# An auditor's title, and ONLY an auditor's (§52). An auditor reads an orchestrator's method
# and results; it is neither that orchestrator's successor nor one of its agents, and the
# operator tells the three apart in his window by the role word. So `Audit :` is accepted
# under --auditor alone and refused everywhere else, the way `Orch :` is refused on a plain
# anchor: a title is a claim about what a session is, and the launcher holds it to that.
AUDIT_TITLE_SHAPE = re.compile(r"^Audit : \S(.{0,23}\S)?\Z")
AUDIT_ROLE = "Audit :"
# An auditor's NAME, as a succession derives it from the caller: the strict title above, or
# one whose role word carries a qualifier, « Audit neutre : <subject> », the name an auditor
# the operator launches by hand may take. Accepted only where the name is read, never typed:
# a typed audit title is still the strict one, under --auditor alone.
AUDIT_NAME_SHAPE = re.compile(r"^Audit(?: [^\s:]+)* : \S(.{0,23}\S)?\Z")
# The coordinator's own successor's title, and ONLY that spawn's. The coordinator sits above
# every orchestrator on the machine, so the operator tells its tab apart from an auditor's or
# an agent's the same way: by the role word. `Coord :` is accepted under
# --coordinator-successor alone and refused everywhere else, the way `Audit :` is refused
# outside --auditor.
COORD_TITLE_SHAPE = re.compile(r"^Coord : \S(.{0,23}\S)?\Z")
COORD_ROLE = "Coord :"
# The four roles a title names, in the order a listing shows them. A title that reads none
# of them (a probe's, a hand-named tab) has no role and gets the narrowest tool set.
ROLE_WORDS = ("Orch", "Coord", "Audit", "Agent")
ROLE_PREFIX = re.compile(r"^(%s) :" % "|".join(ROLE_WORDS))
# What a session is not given, whatever its role: tools no session has ever called, each
# one a schema the host sends on EVERY call (§65). Artifact is removed by name and never
# through the host's `enableArtifact` setting, which also drops the « Scratchpad
# directory » line every agent brief relies on.
LEAN_REMOVED = ("Artifact", "SendFeedback", "Workflow", "ScheduleWakeup", "ReportFindings")
# The module registers these in every session, and only a session that moves an orchestrator
# between machines calls them: an orchestrator, or the coordinator that orders the move.
MOVE_TOOLS = ("mcp__orchestrator__move_send", "mcp__orchestrator__move_probe",
              "mcp__orchestrator__end_session")
MOVE_ROLES = ("Orch", "Coord")
# The host's own switches for what it adds to a session's context on its own. The first is
# internal and undocumented, the second too: a probe proves each on the host version that
# ships with a change to this list, and a launcher test keeps the keys passed.
TOTAL_TOKENS_ENV = "CLAUDE_CODE_TOTAL_TOKENS_REMINDER"
SILENT_TURN_ENV = "CLAUDE_CODE_SILENT_TURN_REMINDER"
# The gate an agent runs under, below the 300 thousand default of an orchestrator. The host's
# compaction window is the operator's to set in his own settings, never the launcher's.
AGENT_GATE_TOKENS = 240000
# The skills the account syncs from the web app are listed under this prefix, thirteen of
# them on this machine, about 2.1 thousand tokens on every call, and no session has invoked
# one. The host's `syncClaudeAiSkills: false`, passed in a launch's own --settings, hides
# them for that invocation only and moves nothing: the same key in the operator's user
# settings would move the synced directory to the trash.
SYNCED_SKILLS_PREFIX = "anthropic-skills:"
SYNCED_SKILLS_SETTING = "syncClaudeAiSkills"
# Tokens per character of a tool schema, measured on this host: 19,429 tokens for the 87,706
# characters the first probe removed (the P0/P1 pair of the token analysis, 2026-10-18).
TOKENS_PER_CHAR = 0.2215


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


def unread_refusal(dir_, timeout):
    """What was checked, for how long, why it may have happened, and what to look at next.
    A named exception to "a gate that cannot measure lets the run through and says so"
    (§29): a session whose mode is unread may be parked on a dialog or hung at start, which
    the plugin already calls "not launched" (§43) — so the tab this spawn made is closed
    rather than left for the operator to find blank; whether that close happened is said
    after this text, by `refuse_made`."""
    return ("spawn: refused: no transcript for %s carrying a mode after %ss: the session may "
            "be parked on a dialog or hung at start. Read it next time with `screen` before "
            "retrying, or raise ORCHESTRATOR_MODE_TIMEOUT if the machine is only slow"
            % (dir_, timeout))


def verify_mode(dir_, launch_epoch, asked_mode, model, made, timeout=None, sleep=time.sleep):
    """Poll for the session's own transcript and the first mode it carries, up to `timeout`
    seconds (MODE_TIMEOUT by default); the line to print once it is read and matches.

    A mode that never gets read is now refused exactly like a mismatch: the tab this spawn
    made is closed and the process dies on the same exit status, because a session nobody
    can read is a session waiting for a click, which is not launched either (§43)."""
    timeout = MODE_TIMEOUT if timeout is None else timeout
    waited, mode = 0, ""
    while waited < timeout:
        path = find_transcript(dir_, launch_epoch)
        if path:
            mode = mode_of_transcript(path)
            if mode:
                break
        sleep(1)
        waited += 1
    if not mode:
        refuse_made(made, unread_refusal(dir_, timeout))
    elif mode != asked_mode:
        refuse_made(made, mode_refusal(asked_mode, mode, model))
    return "spawn: mode %s read on the transcript" % mode


def transcript_of(session_id):
    """`(path, size)` of a session's transcript, by its id, or ("", 0)."""
    for path in glob.glob(os.path.join(PROJECTS_DIR, "*", "%s.jsonl" % session_id)):
        try:
            return path, os.path.getsize(path)
        except OSError:
            continue
    return "", 0


def verify_resumed(session_id, offset, asked_mode, model, made, timeout=None, sleep=time.sleep):
    """The mode a resumed session came up in, read on what its transcript gained since the
    launch (`offset`, its size then): the first mode it carries is the conversation's first
    launch's, not this one's. Refused like a spawn's reading (§43)."""
    timeout = MODE_TIMEOUT if timeout is None else timeout
    waited, mode = 0, ""
    while waited < timeout:
        path, _ = transcript_of(session_id)
        if path:
            try:
                with open(path) as fh:
                    fh.seek(offset)
                    for line in fh:
                        try:
                            entry = json.loads(line)
                        except Exception:
                            continue
                        if isinstance(entry, dict) and entry.get("permissionMode"):
                            mode = entry["permissionMode"]
                            break
            except OSError:
                pass
            if mode:
                break
        sleep(1)
        waited += 1
    if not mode:
        refuse_made(made, "spawn: refused: the transcript of session %s gained no entry carrying "
                    "a mode after %ss: the resume may be parked on a dialog or hung at start"
                    % (session_id, timeout))
    elif mode != asked_mode:
        refuse_made(made, mode_refusal(asked_mode, mode, model))
    return "spawn: mode %s read on the resumed transcript" % mode


def closed_clause(closed, tty):
    """What became of the tab a refused spawn made — only what is true of it."""
    if closed:
        return "the tab was closed"
    if tty:
        return "the tab on %s was NOT closed: close it with close --tty %s" % (tty, tty)
    return "the tab was NOT closed: find it with list and close it"


def refuse_made(made, msg):
    """Refuse a spawn whose tab exists: close that tab, print its tty on stdout, and die
    saying whether the close happened.

    A refusal used to say « the tab was closed » whatever the close did, and the « never
    started » refusal closed nothing at all and kept the tty to its stderr line: the
    operator was told of a failure over a tab still open, possibly holding a running agent
    nobody would now stop."""
    closed = close_made(made)
    tty = made.get("tty") or ""
    if tty:
        print(tty)
        sys.stdout.flush()
    die("%s; %s" % (msg, closed_clause(closed, tty)))


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


def state_file_path(kind, title, ext):
    """Where a launch keeps a file of its own: under the state directory's prompts/, the
    kind first so the files sort by kind, then the title and the time."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", title)[:40] or "agent"
    return os.path.join(PROMPTS_DIR, "%s-%s-%d.%s" % (kind, safe, int(time.time() * 1000), ext))


def write_mcp_file(names, catalogue, title):
    """The selected definitions, in a file of this session's own, beside its prompt file.

    Inline JSON would do the same job and cost the process line its length: the host's
    `--mcp-config` takes SEVERAL values, so whatever follows it is read as another file —
    the prompt placed there was read as one — and the line `ps` shows is where a successor
    reads its predecessor's name from (§24)."""
    os.makedirs(PROMPTS_DIR, exist_ok=True)
    path = state_file_path("mcp", title, "json")
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
# Once that wait is over, how long a host is given to die of SIGTERM before it is sent
# SIGKILL, and then to leave the table after SIGKILL.
TERM_GRACE = int(os.environ.get("ORCHESTRATOR_TERM_GRACE", "5"))
KILL_GRACE = int(os.environ.get("ORCHESTRATOR_KILL_GRACE", "5"))
BACKENDS = ("api", "applescript")
# The rungs, in order. AppleScript is the fallback and the ONLY one: it drove this plugin
# before the API existed and it covers what the API alone does not — the module missing, the
# environment unbuilt, the API server switched off, a cookie refused.
#
# There is deliberately no third rung in another terminal (§48). One was built, in tmux, and
# the operator struck it out: an agent is a window of its orchestrator's home session or an
# iTerm2 tab, and no OTHER terminal is a rung, since a session elsewhere is not one he can see,
# place or close in the window he reads. A launcher that quietly hands him one has hidden
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

    ORCHESTRATOR_PS_TABLE names a file that replaces `ps`, one `<tty> [<pid>] <command>`
    line per process; a table written to check a name carries no pid, so the pid is empty
    there, and one written to check the host's registry carries it as an all-digit second
    field. Both readers below are built on this, and so is the close's proof, because they
    were asking the process table the same question in three different ways."""
    short = tty.replace("/dev/", "")
    table = os.environ.get("ORCHESTRATOR_PS_TABLE", "")
    try:
        if table:
            rows = []
            with open(table) as fh:
                for l in fh:
                    r = l.strip().split(None, 1)
                    if len(r) != 2 or r[0].replace("/dev/", "") != short:
                        continue
                    rest = r[1].split(None, 1)
                    if len(rest) == 2 and rest[0].isdigit():
                        rows.append((rest[0], rest[1]))
                    else:
                        rows.append(("", r[1]))
            return rows
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


def host_config_dir():
    """The host's configuration directory, where its session registry lives."""
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def host_registry(pid):
    """The host's own record of the session a pid runs, as a dict, or None.

    The host writes `<config dir>/sessions/<pid>.json` for every session it runs and keeps
    the session's current name there. It is the one reading of « this process is the host »
    that does not depend on how the process was started: a wrapper that `exec`s the binary,
    a session typed as a bare command, a launch through a path the operator never set."""
    if not pid or not str(pid).isdigit():
        return None
    try:
        with open(os.path.join(host_config_dir(), "sessions", "%s.json" % pid)) as fh:
            entry = json.load(fh)
    except Exception:
        return None
    return entry if isinstance(entry, dict) else None


def host_cli_names():
    """The program names the host CLI answers to in the process table: the basename of
    HOST_CLI, and the basename of what it resolves to once PATH and every link are
    followed."""
    import shutil
    names = {os.path.basename(HOST_CLI)}
    try:
        names.add(os.path.basename(os.path.realpath(shutil.which(HOST_CLI) or HOST_CLI)))
    except Exception:
        pass
    return {n for n in names if n}


def is_host_process(pid, command, names=None):
    """Whether one process-table row is the host session.

    Matched on the full HOST_CLI path, this missed every session the operator typed as a
    bare command whenever HOST_CLI was set to an absolute path, and every session a wrapper
    started by `exec`: a live session read « not running », and every spawn through the
    wrapper died « never started » after its tab existed. A row is the host when the host
    registered its pid, or when its program's basename is HOST_CLI's or the basename of
    what HOST_CLI resolves to."""
    if host_registry(pid) is not None:
        return True
    words = command.split()
    if not words:
        return False
    return os.path.basename(words[0]) in (names if names is not None else host_cli_names())


def host_clis_on(tty):
    """Every host CLI on a tty, in table order: each one's pid, or its command line where the
    suite's table carries no pid. A session that runs a nested host CLI shows two."""
    names = host_cli_names()
    return [pid or command for pid, command in ps_rows(tty) if is_host_process(pid, command, names)]


def host_cli_on(tty):
    """What the first host CLI on a tty is — its pid, or its command line where the suite's
    table carries no pid — or None when it is not there. Truthy means « still running »."""
    every = host_clis_on(tty)
    return every[0] if every else None


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


# --- the end of the host a close closes ---------------------------------------------
#
# The app's close used to be the whole of it: the tab went, the terminal hung up the tty, the
# host saw the hangup and exited. Then a close was accepted, the tab went, and the host ran on
# for a day: the terminal's session-keeping daemon still held the tty's master side, so no
# hangup came, and the host, blocked since the close (a child it started then was never
# reaped), ignored the SIGTERM sent by hand. Four sessions survived that way, a predecessor
# among them, so a succession left two orchestrators. The launcher now ends the host itself:
# the process read BEFORE the close, named by its pid AND its start time (a pid is handed out
# again), is waited for, then sent SIGTERM, then SIGKILL, each step logged, and a close is
# reported only once the process table shows that process gone. The title guard stays first:
# the terminal refuses a session whose title does not match before anything is read or sent.

UNREADABLE = "unreadable"


def process_state(pid):
    """`(start time, state)` of a process from the real process table, None when the table
    has no such pid (an empty answer, exit 1), UNREADABLE when it could not be read (a
    timeout, an error, an answer that does not parse): a table that did not answer says
    nothing about the pid."""
    try:
        done = subprocess.run(["ps", "-o", "stat=,lstart=", "-p", str(pid)],
                              capture_output=True, text=True, timeout=10)
    except Exception:
        return UNREADABLE
    out = done.stdout.strip()
    if not out:
        return None if done.returncode == 1 else UNREADABLE
    parts = out.split(None, 1)
    if done.returncode != 0 or len(parts) != 2:
        return UNREADABLE
    return parts[1].strip(), parts[0]


def host_identity(tty):
    """`(pid, start time)` of the first host on a tty, read before a close, or None when no
    host with a readable pid is there (the suite's tables without pids, a shell)."""
    pid = host_cli_on(tty)
    if not pid or not str(pid).isdigit():
        return None
    state = process_state(pid)
    if not state or state == UNREADABLE:
        return None
    return str(pid), state[0]


def process_gone(pid, start):
    """Whether the process `pid` started at `start` is gone: no longer in the table, its pid
    held by a process started at another time, or exited and only waiting for its parent to
    reap it (a zombie, or the « exiting » state the terminal's daemon leaves unreaped). A
    table that could not be read does not say it is gone."""
    state = process_state(pid)
    if state == UNREADABLE:
        return False
    if state is None or state[0] != start:
        return True
    # The table prints the exiting state as `?Es`, `UE` or `SE`: an `E` among the flags after
    # the state letter. A `Z` as the state letter is a zombie.
    flags = state[1].lstrip("?")
    return flags[:1] in ("Z", "E") or "E" in flags[1:]


def module_dir():
    """The hooks module's own directory, where its store lives: ORCHESTRATOR_MODULE_DIR when
    set, as the module reads it."""
    return (os.environ.get("ORCHESTRATOR_MODULE_DIR")
            or os.path.join(host_config_dir(), "claude-orchestrator"))


# --- the session's row in the hooks module's store -----------------------------------
#
# One file per session under the module's store (hooks/supervision.ts, SessionRow). The
# module's measure writes it while the session's host runs; the launcher writes it only before
# that host starts or once it is gone (row_write), so the two never write one row at once and
# no lock is needed. Both write it alike: the same key, the same compact JSON line, a
# temporary file beside it renamed into place, so no reader meets a row caught mid-write.

# The module's empty row (writeSession), in its key order: what a patch merges into when the
# session has no row yet.
ROW_BASE = (("role", None), ("name", None), ("repo", None), ("context_percent", 0),
            ("context_tokens", 0), ("window", 0), ("model", ""), ("busy", False),
            ("updated_at", ""))
ROW_WHEN = ("birth", "end")
_ROW_KEY_SAFE = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
_BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def row_key(sid):
    """The row's key in the store, the module's sessionKey: `sessions/<id>`, each character
    outside A-Za-z0-9._- replaced by an underscore. The module replaces UTF-16 code units, so
    a character beyond the Basic Multilingual Plane is two underscores here as there: one id,
    one file, whichever side names it."""
    return "sessions/" + "".join(
        c if c in _ROW_KEY_SAFE else ("__" if ord(c) > 0xFFFF else "_") for c in sid)


def _row_path(sid):
    return os.path.join(module_dir(), "store", row_key(sid))


def row_read(sid):
    """The session's row as a dict, or None when it is absent, unreadable, no JSON object, or
    lacks the string stamp the module judges its age by (parseSessionRow): a row caught
    mid-write, or truncated by a session's end, is no row."""
    try:
        with open(_row_path(sid), encoding="utf-8") as fh:
            row = json.loads(fh.read())
    except (OSError, ValueError):
        return None
    return row if isinstance(row, dict) and isinstance(row.get("updated_at"), str) else None


def _row_json(value):
    """A value as the module's JSON.stringify spells it: an integral float as an integer (`3`,
    never `3.0`), a float that is no finite number as null."""
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return None
        return int(value) if value.is_integer() and abs(value) < 1e21 else value
    if isinstance(value, dict):
        return {k: _row_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_row_json(v) for v in value]
    return value


def _row_now():
    """Now as the module's toISOString writes it: UTC, to the millisecond, `Z`."""
    ms = int(time.time() * 1000)
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms // 1000)) + ".%03dZ" % (ms % 1000)


def row_write(sid, patch, when):
    """Merge `patch` into the session's row and write it as the module does (writeSession):
    over the row found, else over the module's empty row; stamped with the patch's own
    `updated_at`, else the write's time; one compact JSON line into a temporary file named as
    the module names its own (writeAtomic), then renamed into place. True when written.

    `when` is "birth", before the session's host starts, or "end", once it is gone: the
    launcher never writes a row a running host owns. A row whose pid runs live on its tty
    (runs_live) is refused, False, and so is a row naming a pid when the process table cannot
    be read, which proves no death. So is, said on stderr, a row file that holds no row the
    module parses or whose state cannot be read: only a file known absent, or known empty (the
    module's end when its removal fails, deleteSession), is written as no row. A write
    that fails is False, said on stderr, the temporary file it made removed, never one another
    writer holds under the same name."""
    if when not in ROW_WHEN:
        raise ValueError("row_write: when is birth or end, not %r" % (when,))
    path = _row_path(sid)
    found = row_read(sid)
    if found is None:
        try:
            unread = os.stat(path).st_size > 0
        except OSError as exc:
            unread = not isinstance(exc, FileNotFoundError)
        if unread:
            print("row: the row %s could not be read, left as it is" % path, file=sys.stderr)
            return False
    pid = str((found or {}).get("pid") or "")
    if pid and runs_live(process_table(), pid, found.get("tty")):
        return False
    row = dict(ROW_BASE if found is None else found)
    row.update(patch)
    row["updated_at"] = patch["updated_at"] if patch.get("updated_at") is not None else _row_now()
    text = json.dumps(_row_json(row), ensure_ascii=False, separators=(",", ":")) + "\n"
    tmp = "%s.tmp-%d-%s" % (path, int(time.time() * 1000),
                            "".join(_BASE36[b % 36] for b in os.urandom(6)))
    made = False
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "x", encoding="utf-8") as fh:
            made = True
            fh.write(text)
        os.replace(tmp, path)
    except (OSError, UnicodeError) as exc:
        if made:
            try:
                os.remove(tmp)
            except OSError:
                pass
        print("row: the row %s could not be written: %s" % (path, exc), file=sys.stderr)
        return False
    return True


def process_table():
    """Every process on the machine by pid, each with its state flags and its tty
    (`{"stat": ..., "tty": ...}`), the module's livePids over one `ps -A -o pid=,stat=,tty=`;
    None when the listing failed or listed no pid — unknown, never « none alive ». A line
    carrying the pid alone has no state and no tty.

    ORCHESTRATOR_PS_TABLE names the suite's stand-in for `ps` (ps_rows), one
    `<tty> [<pid>] <command>` line per process: each line with a pid gives that pid its tty
    and no state, the others are skipped."""
    table = {}
    stand_in = os.environ.get("ORCHESTRATOR_PS_TABLE", "")
    try:
        if stand_in:
            with open(stand_in) as fh:
                for l in fh:
                    r = l.split()
                    if len(r) >= 3 and r[1].isdigit():
                        table[r[1]] = {"stat": None, "tty": r[0].replace("/dev/", "", 1)}
            return table or None
        done = subprocess.run(["ps", "-A", "-o", "pid=,stat=,tty="],
                              capture_output=True, text=True, timeout=5)
    except Exception:
        return None
    if done.returncode != 0:
        return None
    for line in done.stdout.splitlines():
        parts = line.split()
        if parts and parts[0].isdigit():
            table[parts[0]] = {"stat": parts[1] if len(parts) > 1 else None,
                               "tty": parts[2] if len(parts) > 2 else None}
    return table or None


def runs_live(table, pid, tty=None):
    """Whether `pid` still runs a session, the module's runsLive: listed in `table`
    (process_table), neither exiting (an `E` among its flags) nor a zombie (state `Z`), and,
    when `tty` is given and the table knows the process's tty, on that tty. A table that could
    not be read (None) proves no death: True, as every reader of the module takes it."""
    if table is None:
        return True
    listed = table.get(str(pid))
    if listed is None:
        return False
    flags = (listed.get("stat") or "").lstrip("?")
    if flags.startswith("Z") or "E" in flags:
        return False
    if not tty or listed.get("tty") is None:
        return True
    return listed["tty"] == (tty[5:] if tty.startswith("/dev/") else tty)


def recorded_pids(ttys):
    """The host pids the hooks module's store records for sessions on `ttys`, in file order.

    Read BEFORE a close: the row names the session's own host, which the close's proof
    reads by tty alone. A host whose tab went under the terminal's session-keeping daemon
    stays listed for hours, exiting and never reaped, its tty released: the tty's proof
    passed, and the pane drew the session as live. A row unreadable is no row."""
    shorts = {t.replace("/dev/", "") for t in ttys if t}
    store = os.path.join(module_dir(), "store", "sessions")
    try:
        names = sorted(os.listdir(store))
    except OSError:
        return []
    pids = []
    for name in names:
        # A temporary file is a row write in flight (row_write, the module's writeAtomic).
        if ".tmp-" in name:
            continue
        try:
            with open(os.path.join(store, name)) as fh:
                row = json.loads(fh.read())
        except (OSError, ValueError):
            continue
        if not isinstance(row, dict):
            continue
        pid, tty = str(row.get("pid") or ""), str(row.get("tty") or "")
        if pid.isdigit() and tty.replace("/dev/", "") in shorts and pid not in pids:
            pids.append(pid)
    return pids


def name_lingering(pids):
    """Name on stderr, and in close.log, every pid of `pids` the process table still lists,
    with its state: a close proved on its tty that leaves its host behind says so. A table
    that could not be read names nothing. The close's outcome is not changed."""
    for pid in pids:
        state = process_state(pid)
        if state and state != UNREADABLE:
            close_log("close", "pid %s lingers (%s)" % (pid, state[1]))


def close_log(what, line, echo=True):
    """Say one step of a host's end on stderr (unless `echo` is off) and append it,
    timestamped, to close.log in the state directory, where a close that went wrong is read
    afterwards."""
    if echo:
        print("%s: %s" % (what, line), file=sys.stderr)
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(os.path.join(STATE_DIR, "close.log"), "a") as fh:
            fh.write("%s %s: %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                      what, line))
    except OSError:
        pass


def wait_process_gone(pid, start, timeout):
    """Wait up to `timeout` seconds for a process to be gone; True when it is."""
    deadline = time.time() + timeout
    while not process_gone(pid, start):
        if time.time() >= deadline:
            return False
        time.sleep(0.2)
    return True


# Why the last end_host of a pid returned False, where it is not « still running after SIGKILL ».
_END_FAILURES = {}


def end_failure(pid, tty):
    """The tail of the message of a host that was not ended: what the launcher did and saw, so
    that a signal never sent is not reported as sent."""
    return _END_FAILURES.get(str(pid)) or "after SIGTERM and SIGKILL"


def end_host(pid, start, tty, what):
    """End the host `pid` started at `start`, once its session's close was accepted: waited
    for, then SIGTERM, then SIGKILL. True once the process table shows it gone. A process
    whose identity no longer matches is not signalled: it is gone, and its pid another's.
    When it returns False, `end_failure` says why."""
    import signal
    _END_FAILURES.pop(str(pid), None)
    if wait_process_gone(pid, start, CLOSE_TIMEOUT):
        return True
    close_log(what, "host %s (started %s) still running on %s after %ds"
              % (pid, start, tty, CLOSE_TIMEOUT))
    for sig, grace in ((signal.SIGTERM, TERM_GRACE), (signal.SIGKILL, KILL_GRACE)):
        if process_gone(pid, start):
            return True
        if process_state(pid) == UNREADABLE:
            # The identity cannot be checked: nothing is signalled, and nothing is reported ended.
            close_log(what, "the process table could not be read for %s: not signalled" % pid)
            _END_FAILURES[str(pid)] = ("and its entry in the process table could not be read, "
                                       "so nothing was signalled")
            return False
        try:
            os.kill(int(pid), sig)
        except ProcessLookupError:
            return True
        except OSError as exc:
            close_log(what, "%s to %s refused: %s" % (sig.name, pid, exc))
            # Read again: the host may have gone while the signal was refused.
            if process_gone(pid, start):
                return True
            _END_FAILURES[str(pid)] = "and %s was refused (%s)" % (sig.name, exc)
            return False
        close_log(what, "%s sent to %s" % (sig.name, pid))
        if wait_process_gone(pid, start, grace):
            close_log(what, "host %s gone after %s" % (pid, sig.name))
            return True
    close_log(what, "host %s still running after SIGKILL and %ds" % (pid, KILL_GRACE))
    return False


def others_on(tty, ended):
    """Host CLIs still on a tty once the host `ended` is proved gone, that one left out: the
    stand-in table keeps listing a process the real one has dropped."""
    return [p for p in host_clis_on(tty) if str(p) != str(ended)]


# --- the checkout a close leaves behind (§61) --------------------------------------

WORKSPACE_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                            "orchestrator", "scripts", "workspace.sh")


def host_cli_cwd(tty):
    """The working directory of the host CLI on a tty, or None when it cannot be read.

    ORCHESTRATOR_CWD_TABLE names a file that replaces the process table's answer, one
    `<tty> <cwd>` line per session, because a suite has no live session to ask. Read BEFORE
    a close: once the session is gone there is no process to ask."""
    short = tty.replace("/dev/", "")
    table = os.environ.get("ORCHESTRATOR_CWD_TABLE", "")
    if table:
        try:
            with open(table) as fh:
                for line in fh:
                    parts = line.strip().split(None, 1)
                    if len(parts) == 2 and parts[0].replace("/dev/", "") == short:
                        return parts[1]
        except OSError:
            pass
        return None
    pid = host_cli_on(tty)
    if not pid or not str(pid).isdigit():
        return None
    try:
        out = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
                             capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return None
    for line in out.splitlines():
        if line.startswith("n"):
            return line[1:]
    return None


def checkout_of(cwd):
    """The checkout or pin under the workspaces root that a directory is in, or None.

    A checkout lives at <root>/<project>/<name>; a session that `cd`'d into a subdirectory is
    still in that checkout. The orchestrator's own checkout is never under the root, so it is
    never one."""
    root = os.environ.get("ORCHESTRATOR_WORKSPACES") or os.path.expanduser("~/dev/workspaces")
    try:
        root = os.path.realpath(root)
        real = os.path.realpath(cwd)
    except (OSError, ValueError):
        return None
    if not real.startswith(root + os.sep):
        return None
    parts = real[len(root) + 1:].split(os.sep)
    if len(parts) < 2:
        return None
    path = os.path.join(root, parts[0], parts[1])
    return path if os.path.exists(os.path.join(path, ".git")) else None


def delete_checkout(path):
    """Ask `workspace.sh delete` (never --discard) to remove a checkout and report it on
    stderr. A refusal is not an error of the close: it says why the checkout stays."""
    try:
        done = subprocess.run(["bash", WORKSPACE_SH, "delete", path],
                              capture_output=True, text=True, timeout=120)
    except Exception as exc:
        print("close: kept checkout %s: workspace.sh did not run: %s" % (path, exc),
              file=sys.stderr)
        return
    if done.returncode != 0 or os.path.exists(path):
        reason = (done.stderr.strip().splitlines() or ["unknown"])[-1]
        reason = re.sub(r"^workspace: (delete: )?", "", reason)
        reason = re.sub(r" \(pass --discard.*$", "", reason)
        print("close: kept checkout %s: %s" % (path, reason), file=sys.stderr)
        return
    first = True
    for line in done.stdout.splitlines():
        if line.startswith("deleted "):
            what = "deleted checkout " if first else "deleted "
            print("close: %s%s" % (what, line[len("deleted "):]), file=sys.stderr)
            first = False
    for line in done.stderr.splitlines():
        print("close: " + re.sub(r"^workspace: ", "", line), file=sys.stderr)


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


def as_close_script(tty, closing):
    """The script that finds the session on `tty` and returns its name, closing it first
    only when `closing` is set."""
    return '''
        tell application "iTerm2"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if (tty of s) is %s then
                  set n to name of s
                  %s
                  return n
                end if
              end repeat
            end repeat
          end repeat
        end tell
        return ""''' % (as_quote(tty), "close s" if closing else "")


def as_close(tty, expect):
    # The guard is the API rung's own, applied here too: a rung that closed what the rung
    # above would have refused is a fallback that is not the same tool. The title is read
    # first and compared in Python, and the close is sent only once it matches, so a refused
    # title closes nothing.
    if expect:
        name = as_run(as_close_script(tty, False), "a title read")
        if not name:
            die("close: no session found on %s" % tty)
        if stable_title(expect) not in stable_title(name):
            die("close: refused: session on %s is titled '%s', which does not contain '%s'"
                % (tty, name, expect))
    name = as_run(as_close_script(tty, True), "a close")
    if not name:
        die("close: no session found on %s" % tty)
    return name


def as_spawn(command):
    # `create tab` selects the tab it makes, where the API rung creates it unselected: the
    # operator's tab is remembered and selected again, so a launch does not pull them away.
    # A new window has no tab to go back to. The re-selection is guarded: the agent's tab
    # already runs, so the operator's tab closing meanwhile must not fail the spawn.
    return as_run('''
        tell application "iTerm2"
          if (count of windows) is 0 then
            set w to (create window with default profile command %s)
            return tty of current session of current tab of w
          end if
          set w to current window
          tell w
            set prev to current tab
            set t to (create tab with default profile command %s)
            set newTty to tty of current session of t
            try
              select prev
            end try
            return newTty
          end tell
        end tell''' % (as_quote(command), as_quote(command)), "a new tab")



# --- the tier map ----------------------------------------------------------------

def resolve_tier_pair(tier):
    """A tier in, the (model, effort) the operator bound to it out; either may be empty.
    An unbound tier returns ("", "") and succeeds: the caller reads that as "let the host
    choose", which is a better answer than a name this plugin has no business carrying.
    A binding is a model, `model/effort`, or an object {"model": ..., "effort": ...}; with
    no effort, none is typed and the host applies its own.
    """
    if tier not in TIERS:
        die("resolve-tier: unknown tier: %s (expected deep, standard or light)" % tier)
    value = os.environ.get("ORCHESTRATOR_TIER_" + tier.upper())
    if not value:
        if not os.path.isfile(MODELS_MAP):
            return "", ""
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
    if isinstance(value, dict):
        model, effort = str(value.get("model") or ""), str(value.get("effort") or "")
        if not model:
            die("resolve-tier: tier %s is bound to an object without a model" % tier)
    else:
        model, _, effort = str(value).partition("/")
    if effort and effort not in EFFORTS:
        die("resolve-tier: tier %s has an unknown effort: %s (expected %s)" % (tier, effort, EFFORT_LIST))
    warn_versioned(tier, model)
    return model, effort


def resolve_tier(tier):
    """The tier's binding as one word: `model`, `model/effort`, or empty when unbound."""
    model, effort = resolve_tier_pair(tier)
    return model + ("/" + effort if effort and model else "")


def warn_versioned(tier, value):
    """A versioned identifier goes stale without a sign: the family ships a newer model and
    the tier keeps launching the old one, while a family alias is resolved by the host to its
    latest. The map is the operator's, so this warns and launches; it never refuses or
    rewrites. Versioned reads as trailing numeric dash segments, a version or a date, and the
    alias is the last segment before them. A bracketed variant suffix is set aside before
    reading the version and carried over to the alias."""
    base, suffix = re.fullmatch(r"(.*?)(\[[^\]]*\])?", value).groups()
    parts = base.split("-")
    n = len(parts)
    while n > 0 and re.fullmatch(r"\d+(\.\d+)*", parts[n - 1]):
        n -= 1
    if 0 < n < len(parts):
        print("WARNING: tier %s is bound to the versioned identifier %s, which goes stale when "
              "a newer model ships; bind it to the family alias %s instead"
              % (tier, value, parts[n - 1] + (suffix or "")), file=sys.stderr)


# What the host may name in place of a model it could not read: a sentinel, never a model to
# type, and typed as `--model` it starts the successor on a guess or not at all.
UNAVAILABLE_MODEL = "unavailable"
# What marks the main thread's requests in a transcript: the host logs every request it
# sends with its pair, and only these are the session's own conversation; a compaction, a
# title or a subagent sends its own requests, on pairs of their own.
MAIN_THREAD = "repl_main_thread"


class PairUnreadable(Exception):
    """A session's model and effort could not be read: the message names the transcript read,
    or where it was looked for, and what was missing."""


def read_pair(session_id):
    """`(model, effort, path)` of the session `session_id` NOW: the last main-thread request
    its transcript holds, its `params.model` and `params.output_config.effort`.

    The transcript, and not the launch line, the measure file or the host's settings: the
    host writes each request there with its pair as it sends it, so the reading follows a
    `/model` or an `/effort` typed since the launch, exists for a session launched by hand or
    without the plugin, and is current within the turn that asks (the measure file is
    written only when a turn ends). It is the host's own format, not a documented one: so
    nothing here falls back on anything. No transcript, no main-thread request, no model or
    no effort, and PairUnreadable says which, naming the file."""
    if not session_id:
        raise PairUnreadable("no session id to read a pair for (CLAUDE_CODE_SESSION_ID unset)")
    # The newest of its transcripts: a session resumed from another checkout has one under
    # each, and its requests go to the one written last.
    path = transcript_of_session(session_id)
    if not path:
        raise PairUnreadable("no transcript for session %s under %s" % (session_id, PROJECTS_DIR))
    last = None
    try:
        with open(path, errors="replace") as fh:
            for line in fh:
                # Most lines are not requests: the cheap test first, the parse only for those.
                if MAIN_THREAD not in line or "api-request" not in line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if (isinstance(entry, dict) and entry.get("type") == "api-request"
                        and entry.get("querySource") == MAIN_THREAD):
                    last = entry
    except OSError as exc:
        raise PairUnreadable("%s cannot be read (%s)" % (path, exc.strerror or exc))
    if last is None:
        raise PairUnreadable("%s holds no main-thread request" % path)
    params = last.get("params") if isinstance(last.get("params"), dict) else {}
    model = params.get("model")
    config = params.get("output_config") if isinstance(params.get("output_config"), dict) else {}
    effort = config.get("effort")
    if not isinstance(model, str) or model.strip() in ("", UNAVAILABLE_MODEL):
        raise PairUnreadable("%s: its last main-thread request names no model" % path)
    if effort not in EFFORTS:
        raise PairUnreadable("%s: its last main-thread request names no effort (got %r, "
                             "expected %s)" % (path, effort, EFFORT_LIST))
    return model.strip(), effort, path


def caller_pair(session_id):
    """`(model, effort)` the session `session_id` runs on now (read_pair); raises
    PairUnreadable with the transcript path and what was missing."""
    model, effort, _ = read_pair(session_id)
    return model, effort


def own_pair(what):
    """`(model, effort, path)` of the CALLING session, or a refusal of `what` saying why: a
    succession must not guess a pair, and none is a default (decision 3)."""
    try:
        return read_pair(os.environ.get("CLAUDE_CODE_SESSION_ID", ""))
    except PairUnreadable as exc:
        die("spawn: refused: %s runs on your live model and effort, and they cannot be read: "
            "%s" % (what, exc))


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


# Both kinds a name may arrive wrapped in: the straight ones a shell leaves, the curly ones
# a typed rename can carry.
NAME_QUOTES = "\"'\u201c\u201d\u2018\u2019"


def registry_name_on(tty):
    """The name the host registry holds for the session on a tty, or None.

    A rename — the host's own command, or the module's tool — changes the registry and never
    the process line: read from argv alone, an orchestrator renamed by hand listed as
    « (host default) », its successor was refused for having no name, and a coordinator that
    named itself was not one to `rotate`."""
    for pid, _ in ps_rows(tty):
        entry = host_registry(pid)
        if entry is None:
            continue
        name = entry.get("name")
        if isinstance(name, str):
            name = name.strip().strip(NAME_QUOTES).strip()
            if name:
                return name
    return None


def session_name_on(tty):
    """The name of the host session on a tty: the one the host registry holds, else the one
    it was launched with (`--name`).

    None when neither gives one, `UNREADABLE_NAME` when a launch name was given and the
    table cannot give it back, the name itself otherwise.

    The tab title is the host's summary of the conversation and it is rewritten as the
    session works: a listing showing one of those named nothing an orchestrator could
    recognise, which is how a stranger's tab was taken for one's own (§38). The name is
    fixed at launch, and the API does not carry it, so it is read from the process table.

    ORCHESTRATOR_PS_TABLE names a file that stands in for `ps`, one line per process,
    `<tty> [<pid>] <command>`. The suite sets it; a live run never does.

    **`ps` hands back a FLAT command line**: the quoting that made the name one argument is
    gone, and the words after `--name` run on until the next option or the end of the line.
    The launcher puts `--name` last precisely so that the end of the line is the end of the
    name (§48). A launch that does otherwise — a prompt placed after it — leaves a boundary
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
    registered = registry_name_on(tty)
    if registered:
        return registered
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


def live_host_ttys():
    """The ttys a host session runs on, from one reading of the whole process table (or the
    suite's stand-in for it); None when the table cannot be read, which proves nothing."""
    table = os.environ.get("ORCHESTRATOR_PS_TABLE", "")
    rows = []
    try:
        if table:
            with open(table) as fh:
                for l in fh:
                    r = l.strip().split(None, 1)
                    if len(r) != 2:
                        continue
                    rest = r[1].split(None, 1)
                    if len(rest) == 2 and rest[0].isdigit():
                        rows.append((r[0], rest[0], rest[1]))
                    else:
                        rows.append((r[0], "", r[1]))
        else:
            done = subprocess.run(["ps", "-A", "-o", "tty=,pid=,command="],
                                  capture_output=True, text=True, timeout=10)
            if done.returncode != 0 or not done.stdout.strip():
                return None
            for line in done.stdout.splitlines():
                parts = line.strip().split(None, 2)
                if len(parts) == 3:
                    rows.append(tuple(parts))
    except Exception:
        return None
    names = host_cli_names()
    return {"/dev/" + tty.replace("/dev/", "") for tty, pid, command in rows
            if tty not in ("??", "-") and is_host_process(pid, command, names)}


_PRUNED = []


def orchestrator_host_on(tty, live):
    """Whether a host that can be an orchestrator runs on `tty`: a live host whose name does
    not read as an agent's, an auditor's or the coordinator's. A host with no readable name
    counts, so that a name the table cannot give back never costs a chain."""
    if tty not in live:
        return False
    role = ROLE_PREFIX.match(session_name_on(tty) or "")
    return role is None or role.group(1) == "Orch"


def chain_owner_lives(tty, live):
    """Whether the owner of the chain file named after `tty` still runs: an orchestrator host
    on that tty, or the tmux client of a home server on it whose window 0 holds one. A tty is
    recycled within minutes, so an agent's tty carrying some host proves nothing about the
    orchestrator that wrote the file."""
    if orchestrator_host_on(tty, live):
        return True
    socket = home_of_tab(tty)
    if not socket:
        return False
    panes, _ = home_panes(socket)
    return any(index == "0" and orchestrator_host_on(pane, live) for index, pane in panes or [])


def chain_prune(keep):
    """Remove the chain files whose owner no longer runs, once per run. The owner is the tty
    the file is named after: a file is kept while an orchestrator host runs there (or the
    client of a home server whose window 0 holds one), whatever its agents' ttys carry now.
    Those piled up under dead and recycled ttys, and a file kept because one of its agents'
    ttys had been recycled by a stranger was read, and rewritten, as a live chain.
    `keep`, the file being written and the caller's own, are never touched, nor is anything
    when the process table cannot be read."""
    if _PRUNED or not os.path.isdir(CHAINS_DIR):
        return
    _PRUNED.append(True)
    live = live_host_ttys()
    if live is None:
        return
    for name in os.listdir(CHAINS_DIR):
        if not name.endswith(".jsonl"):
            continue
        tty = "/dev/" + name[:-len(".jsonl")]
        if tty in keep:
            continue
        if not chain_owner_lives(tty, live):
            try:
                os.remove(chain_path(tty))
            except OSError:
                pass


def chain_write(tty, entries):
    os.makedirs(CHAINS_DIR, exist_ok=True)
    chain_prune({tty, self_tty() or ""})
    path = chain_path(tty)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        for e in entries:
            line = {"tab_id": e["tab_id"], "tty": e["tty"], "owner": e.get("owner", "")}
            if is_resident(e):
                line["resident"] = True
            fh.write(json.dumps(line) + "\n")
    os.replace(tmp, path)


def is_resident(entry):
    """Whether the agent was spawned with --resident: meant to stay idle while a background
    command of its own waits. An entry written before the mark existed is not resident."""
    return entry.get("resident") is True


def chain_append(tty, tab_id, new_tty, owner, resident=False):
    chain_write(tty, chain_read(tty) + [{"tab_id": tab_id, "tty": new_tty, "owner": owner,
                                         "resident": resident}])


def chain_transfer(old_tty, old_owner, new_tty, new_owner, merge=False):
    """The predecessor's agents become the successor's (§34).

    A successor spawned after the last agent, and appended to the predecessor's chain as
    if it were one, inherited nothing: its own file was empty or a dead session's, so its
    first `--right-of self` landed left of the agents it had just taken over. The entries
    the predecessor wrote move under the successor's tty and session id; whatever a recycled
    tty's file held on the successor's side is replaced, never appended to. A takeover
    (`merge`) comes after the successor has launched agents of its own: they are kept, and the
    predecessor's follow them. The predecessor's file is removed: its tty's other occupants
    are gone, and a file left behind is a chain no live session owns."""
    moved = chain_owned(chain_read(old_tty), old_owner)
    own = chain_owned(chain_read(new_tty), new_owner) if merge and new_owner else []
    have = {e["tab_id"] for e in own}
    chain_write(new_tty, own + [{"tab_id": e["tab_id"], "tty": e["tty"], "owner": new_owner,
                                 "resident": is_resident(e)}
                                for e in moved if e["tab_id"] not in have])
    if old_tty != new_tty:
        try:
            os.remove(chain_path(old_tty))
        except OSError:
            pass
    return len(moved)


def chain_owned(entries, owner):
    """The entries this session wrote. A tty is recycled minutes after a close and the
    chain file named after it outlives its occupant: a successor on the same tty once
    inherited an entry naming its predecessor's tab, still open, and anchored on it. With
    no owner known (a dry run without ORCHESTRATOR_SELF_ID) nothing is filtered."""
    if not owner:
        return entries
    return [e for e in entries if e.get("owner") == owner]


def chain_effect(successor, auditor, coordinator_successor=False, auditor_successor=False,
                 wake=False, open_=False):
    """What a spawn does to its caller's chain: `append`, `transfer` or `none`.

    An agent joins the chain, so the next agent lands after it. A successor takes the
    chain, because it takes the predecessor's place (§34). An auditor does neither (§52):
    the orchestrator it audits keeps its agents, and the auditor is nobody's agent — written
    into the chain, it would become the anchor the orchestrator's next agent lands after,
    and the operator's window would read the audit as part of the build. The coordinator's
    successor is the same kind of nobody's-agent: it takes over no orchestrator's build, so
    it joins none of them. An auditor's successor is the auditor again: it has no chain to
    take, and written into one it would be the anchor the orchestrator's next agent lands
    after. A woken orchestrator is nobody's agent either: its caller only relaunched it, and
    its own agents, stood down before it slept, left no chain to take. Nor is an orchestrator
    opened on the operator's order: it starts a build of its own."""
    if auditor_successor or wake or open_:
        return "none"
    if successor:
        return "transfer"
    if auditor or coordinator_successor:
        return "none"
    return "append"


def audit_name_on(tty):
    """The name of the session on a tty when it is an auditor's, None otherwise.

    Read by NAME in the process table, never by the chain: an auditor is written into no
    chain, so « not in the chain » cannot tell it from a stranger's tab, and a stale entry
    on a recycled tty could make it look like an agent (§52)."""
    name = session_name_on(tty)
    if name and name != UNREADABLE_NAME and title_role(name) == "Audit":
        return name
    return None


def coord_name_on(tty):
    """The name of the session on a tty when it is the coordinator's, None otherwise.

    Read by NAME, exactly like an auditor's tab: the coordinator is written into no chain
    either, so a stale chain entry on a recycled tty must not be read as its own."""
    name = session_name_on(tty)
    if name and name != UNREADABLE_NAME and name.startswith(COORD_ROLE):
        return name
    return None


def registered_coord_on(tty):
    """The coordinator's name when the coordinator's own record places it on this tty, None
    otherwise.

    The record is the one `coordinator.sh register` writes, under the same state directory.
    A coordinator opened by hand that named itself through a rename carries no `--name`, and
    a host registry that cannot be read leaves it nameless here too: the record still says
    which tty it holds, so a rotation that would close it is refused on that."""
    try:
        with open(os.path.join(STATE_DIR, "coordinator.json")) as fh:
            record = json.load(fh)
    except Exception:
        return None
    if not isinstance(record, dict) or record.get("tty") != tty:
        return None
    name = record.get("name")
    return name if isinstance(name, str) and name else COORD_ROLE


def opener_name():
    """The name the calling session reads, for the rule that only a coordinator or an
    orchestrator opens an orchestrator tab: the host registry or launch name, else the
    coordinator's own record; empty when neither gives one."""
    caller = session_name_on(self_tty() or "") or ""
    if caller == UNREADABLE_NAME:
        caller = ""
    if not caller:
        caller = registered_coord_on(self_tty() or "") or ""
    return caller


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


def chain_repoint_tab(old_tab_id, new_tab_id, new_tty):
    """Every chain, every entry naming the old tab now names the new one; returns how many.

    A resident agent's succession hands over the agent's OWN chain (`chain_transfer`), but
    the entry naming the agent's tab sits in its orchestrator's chain, written when the
    orchestrator spawned it. Left alone it names a tab about to be closed — and once the
    tty is recycled, a stranger's — as the orchestrator's resident agent. Owner and the
    resident mark are kept; no other entry and no file that holds none is touched."""
    if not os.path.isdir(CHAINS_DIR):
        return 0
    count = 0
    for name in os.listdir(CHAINS_DIR):
        if not name.endswith(".jsonl"):
            continue
        tty = "/dev/" + name[:-len(".jsonl")]
        entries = chain_read(tty)
        hit = [e for e in entries if e["tab_id"] == old_tab_id]
        if not hit:
            continue
        for e in hit:
            e["tab_id"] = new_tab_id
            e["tty"] = new_tty
        chain_write(tty, entries)
        count += len(hit)
    return count


async def move_is_owned(app, tty, own, owner=None):
    """Whether the tab on `tty` is the caller's own tab or one its session launched.

    Matched on the TAB id, never on the tty: a tty is recycled minutes after a close and
    the chain file named after it outlives its occupant, so an entry whose tty now belongs
    to a stranger's tab must not make that tab movable — the reading §26 already gave the
    anchor. The owner is the caller's chain owner (`own_session_id`): the session sitting on
    the caller's tty right now, read from the app, or the tmux pane the caller runs in, which
    the app does not know. A caller whose owner cannot be read owns nothing here: moving a
    stranger's tab is the harm the warning that replaces the refusal exists to trace."""
    if not own:
        return False
    if tty == own:
        return True
    _, tab, _ = await find_tab(app, tty)
    if tab is None:
        return False
    if owner is None:
        owner = await own_session_id(app, own)
    if not owner:
        return False
    mine = {e["tab_id"] for e in chain_owned(chain_read(own), owner)}
    return tab.tab_id in mine


async def chain_anchor(app, own_tty, owner=None):
    """The tty of the last agent still open in the orchestrator's window, or None.

    Checked on tab id, never on tty: a tty is recycled minutes after a close, and an entry
    whose tty now belongs to a stranger's tab must not anchor a launch on it. Entries whose
    tab is gone are dropped on this read. A caller the app has no tab for (a tmux pane) has
    no window of its own: its agents are looked for in every window, by the owner its pane
    names, and a caller with no owner at all anchors on nothing."""
    if owner is None:
        owner = await own_session_id(app, own_tty)
    win, own_tab, _ = await find_tab(app, own_tty)
    windows = [win] if win is not None else (app.windows if owner else [])
    if not windows:
        return None
    live = {t.tab_id: t for w in windows for t in w.tabs}
    entries = chain_read(own_tty)
    kept = [e for e in chain_owned(entries, owner) if e["tab_id"] in live]
    if len(kept) != len(entries):
        chain_write(own_tty, kept)
    group = None
    if win is not None:
        group = chain_group(win.tabs, own_tab.tab_id, {e["tab_id"] for e in kept})
    for e in reversed(kept):
        tty = await tty_of(live[e["tab_id"]])
        if tty:
            if group is not None and e["tab_id"] not in group:
                # This agent was moved away from its orchestrator, or the tabs between
                # them are someone else's: after it, the new agent would sit beside another
                # orchestrator. The last agent still in the group anchors instead, and with
                # none there, directly right of the caller keeps the group whole.
                continue
            return tty
    return None


def chain_group(tabs, own_tab_id, mine):
    """The tab ids of the caller's group: the run of the caller's own agents immediately
    right of its tab, in the window's order. Empty when the caller's tab is not in `tabs`."""
    ids = [t.tab_id for t in tabs]
    if own_tab_id not in ids:
        return set()
    group = set()
    for tab_id in ids[ids.index(own_tab_id) + 1:]:
        if tab_id not in mine:
            break
        group.add(tab_id)
    return group


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
    app is re-fetched, because the tab we hold may be the stale copy.

    The tty itself is set by the app once the session's job is forked, after the tab is handed
    back: on a busy app the first read is empty (measured live), and a tab read once was a home
    tab refused for « no tty » while its session was starting. An empty read is waited out too.
    """
    for attempt in range(tries):
        sess = tab.current_session
        if sess is not None:
            try:
                tty = await sess.async_get_variable("tty")
                if tty:
                    return tty
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
    if tmux_owner():
        return tmux_owner()
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


def tab_of_row(rows, tty):
    """(window, tab) a listing names `tty` in, or None. The tab, not the row: a hidden pane
    shares its tab's number, and « left of » is a statement about tabs."""
    for row in rows:
        fields = [f.strip() for f in row.split("|")]
        if len(fields) >= 2 and fields[1] == tty:
            w, _, t = fields[0].partition("/")
            return int(w[1:]), int(t[1:])
    return None


def placed_left_of(rows, tty, anchor):
    """True when `tty`'s tab is the one immediately before `anchor`'s, in the same window."""
    mine, theirs = tab_of_row(rows, tty), tab_of_row(rows, anchor)
    return bool(mine and theirs and mine[0] == theirs[0] and mine[1] == theirs[1] - 1)


def settle_auditor(read, move, auditor, caller):
    """Read the real tab order, repair once, read again: (line, exit code).

    The auditor lands immediately left of its caller by construction when the terminal's API
    answers, and nowhere in particular when it does not (§52); a launch reported as done
    with the tab elsewhere is the operator finding it by hand. So the order is READ, and a
    wrong one is repaired by the launcher's own move, never by a relaunch. Still wrong
    after that, the line names both ttys and the remedy, and the session stays: an auditor
    that runs misplaced is moved, not killed.

    `read` returns None when it could not read, and the line then says what was NOT read —
    an order nobody saw is not an order found wrong. `move` returns False when the terminal
    cannot serve a move at all, and the line then offers no `move` command that cannot work."""
    rows = read()
    if rows is None:
        return unverified_line(auditor), 1
    if placed_left_of(rows, auditor, caller):
        return "", 0
    served = move(auditor, caller)
    rows = read()
    if rows is None:
        return unverified_line(auditor), 1
    if placed_left_of(rows, auditor, caller):
        return "", 0
    mine, theirs = tab_of_row(rows, auditor), tab_of_row(rows, caller)
    if mine and theirs and mine[0] != theirs[0]:
        return ("spawn: the auditor on %s is in another window than its orchestrator on %s; "
                "see iterm-agent.sh list" % (auditor, caller)), 1
    if served is False:
        return ("spawn: the auditor on %s is not immediately left of %s, and could not be "
                "moved because the terminal's API is not available; read iterm-agent.sh list "
                "and move the tab by hand only if it is misplaced" % (auditor, caller)), 1
    return ("spawn: the auditor on %s is not immediately left of %s; repair it with: "
            "iterm-agent.sh move --tty %s --left-of %s" % (auditor, caller, auditor, caller)), 1


def unverified_line(auditor):
    return ("spawn: could not read the tab order, so the auditor's place on %s is unverified; "
            "check with: iterm-agent.sh list" % auditor)


async def move_left_of(iterm2, connection, tty, anchor):
    """Put `tty`'s tab immediately before `anchor`'s in their window, on a fresh app: the
    window object a caller holds is a cached copy (§14). Silent when either is not in one
    window, which the caller's next reading turns into the sentence.

    The anchor is found the way `anchor_position` finds it, by any of its panes: a caller in
    a split tab whose current pane is another one is still in its tab, and `tty_of` reads
    only the current pane."""
    app = await iterm2.async_get_app(connection)
    win, tab, _ = await find_tab(app, tty)
    if tab is None:
        return
    target_win, target, _ = await find_tab(app, anchor)
    if target is None or target_win.window_id != win.window_id or target.tab_id == tab.tab_id:
        return
    tabs = [t for t in win.tabs if t.tab_id != tab.tab_id]
    tabs.insert([t.tab_id for t in tabs].index(target.tab_id), tab)
    await win.async_set_tabs(tabs)


def repair_auditor_place(auditor, caller, term=None):
    """§52: read the listing `list` prints, repair with the launcher's own move, read again.

    Nothing in here may end the launch: the session is up and its tty is what the caller
    reads next. A reading or a move that fails, for whatever reason, is said on stderr in
    one line and the second reading decides; a repair that itself breaks leaves the place
    unverified, and says so. The reading and the move go through the terminal that made the
    auditor's session."""
    term = term or terminal()

    def note(what, exc):
        reason = (" ".join(str(exc).split()) or type(exc).__name__) if exc else ""
        print("spawn: %s%s" % (what, ": " + reason if reason else ""), file=sys.stderr)

    def read():
        try:
            return term.rows()
        except SystemExit:
            return None
        except Exception as exc:
            note("the tab order of the auditor on %s could not be read" % auditor, exc)
            return None

    def move(tty, anchor):
        try:
            term.move_left_of(tty, anchor)
        except SystemExit:
            return False
        except Exception as exc:
            note("the auditor on %s could not be moved" % tty, exc)
        return True

    try:
        return settle_auditor(read, move, auditor, caller)
    except Exception as exc:
        note("the auditor's place on %s could not be settled" % auditor, exc)
        return unverified_line(auditor), 1


# --- the terminal seam ---------------------------------------------------------------
#
# Everything the launcher asks of the terminal goes through ONE object: find a session by its
# tty, make one, list them, read a screen, close one, put one elsewhere, and say who owns a
# chain. The subcommands below call `terminal()` and never the app, so a second terminal can
# stand beside the iTerm one by implementing the same methods; the choice is made in
# `terminal()` and nowhere else.
#
# A chain entry's `tab_id` is whatever the terminal hands back for the session it made. The
# launcher stores it, compares it and writes it as an opaque string; only the terminal that
# issued it reads it as anything more. The chain FILE is the launcher's: a terminal reads it
# to answer, and never writes an entry or drops one — the subcommand that made or closed the
# session does, once it knows the outcome.
#
# `made` is what a refusal needs to close a session a spawn made, filled as soon as each part
# is known. Its keys every terminal shares: `tty`, `tab_id` (the stable id `create` returns),
# `error` (what failed once the session existed) and `terminal` (the one that made it, set by
# the caller). Any other key belongs to the terminal that wrote it and is read by it alone.

# Where `create` puts a new session. `at` is `beside` (on `side` of the session on `anchor`),
# `first` (the first place of the window holding `anchor`) or `anywhere` (where the terminal
# puts it). `read_back` says the caller reads the placement back and repairs it itself (an
# auditor's, §52), so a terminal that cannot place it need not say so.
Place = collections.namedtuple("Place", "at anchor side read_back")


class Terminal:
    """What the launcher needs of a terminal. Every method answers for the terminal it is."""

    def find(self, tty):
        """Whether a session sits on `tty`."""
        raise NotImplementedError

    def can_place(self, anchor, side):
        """Whether a new session can be put on `side` of the one on `anchor`."""
        raise NotImplementedError

    def owner(self, own):
        """The chain owner the caller on `own` writes its entries under — the id its hooks
        read for the same session — or "" when none names it."""
        raise NotImplementedError

    def identity(self, tty, fresh=False):
        """`(chain owner, stable id)` of the session on `tty`, ("", "") when there is none.
        `fresh`: the session was made a moment ago, and a terminal that attaches a new
        session late is given the time to."""
        raise NotImplementedError

    def chain_anchor(self, own):
        """The tty of the caller's last agent still open beside it, or None."""
        raise NotImplementedError

    def chain_state(self, own):
        """`(chain_anchor, entries to write or None)`: a terminal never writes the chain, so
        what its reading of the live sessions keeps is handed to the launcher, which does."""
        return self.chain_anchor(own), None

    def survives(self, stable_id):
        """Whether the session `close` returned `stable_id` for is still there, asked of the
        terminal itself; False where the process table is the only proof there is."""
        return False

    def create(self, command, title, place, chain, made):
        """Make a session named `title` running `command` at `place`: (its tty, its stable id).

        `chain` is what the spawn will do to its caller's chain once the session is verified,
        `append`, `transfer` or "" for nothing, so a terminal that can keep no chain says so
        before it makes anything. A tty is None when the session was made and then could not
        be read, the reason being in `made["error"]`; a stable id is "" when the terminal
        cannot name the session, and then no chain entry can be written for it."""
        raise NotImplementedError

    def rows(self):
        """One listing line per session, in the shape `row_for` writes."""
        raise NotImplementedError

    def screen(self, tty, lines):
        """The last `lines` lines the session on `tty` shows."""
        raise NotImplementedError

    def close(self, tty, expect):
        """Close the session on `tty`, after checking its name holds `expect`: its stable id,
        or "" when the terminal cannot name what it closed."""
        raise NotImplementedError

    def close_made(self, made):
        """Close the session a spawn just made; True only when it was closed."""
        raise NotImplementedError

    def owns(self, tty, own):
        """Whether the session on `tty` is the caller's own or one its chain holds, matched on
        the stable id; None when no session sits on `tty`."""
        raise NotImplementedError

    def move(self, tty, anchor, right, leftmost):
        """Put the session on `tty` beside `anchor` (or first); its new position."""
        raise NotImplementedError

    def move_left_of(self, tty, anchor):
        """Put the session on `tty` immediately before `anchor`'s, quietly."""
        raise NotImplementedError


class ItermTerminal(Terminal):
    """iTerm2: the API rung and, where the API does not serve, the AppleScript rung.

    Its own key in `made`: `session_id`, the app's id of the session it made."""

    def find(self, tty):
        async def probe(iterm2, connection):
            app = await iterm2.async_get_app(connection)
            win, _, _ = await find_tab(app, tty)
            return win is not None
        return bool(run(probe))

    def can_place(self, anchor, side):
        async def probe(iterm2, connection):
            app = await iterm2.async_get_app(connection)
            win, _ = await anchor_position(app, anchor, side)
            return win is not None
        return run(probe)

    def owner(self, own):
        async def owner(iterm2, connection):
            return await own_session_id(await iterm2.async_get_app(connection), own)
        return run(owner) or ""

    def identity(self, tty, fresh=False):
        async def ids(iterm2, connection):
            # Read on a FRESH app each time: the tab handed back by a creation may be the
            # stale copy whose `current_session` is still None.
            for attempt in range(10 if fresh else 1):
                app = await iterm2.async_get_app(connection)
                _, tab, sess = await find_tab(app, tty)
                if sess is not None:
                    return sess.session_id, tab.tab_id
                if fresh:
                    await asyncio.sleep(0.3)
            return "", ""
        return run(ids) or ("", "")

    def chain_anchor(self, own):
        async def last(iterm2, connection):
            app = await iterm2.async_get_app(connection)
            return await chain_anchor(app, own)
        return run(last)

    def create(self, command, title, place, chain, made):
        async def go(iterm2, connection):
            app = await iterm2.async_get_app(connection)
            index = None
            if place.at == "first":
                # No neighbour tab to resolve against: the target is the caller's own window,
                # at its very first place, whatever tab happens to sit there today.
                win, _, _ = await find_tab(app, place.anchor)
                if win is None:
                    die("spawn: no session found on %s" % place.anchor)
                index = 0
            elif place.at == "beside":
                # Resolved again on a fresh app: the probe above ran on another connection,
                # and a window object is a cached copy (§14).
                win, index = await anchor_position(app, place.anchor, place.side)
                if win is None:
                    die("spawn: no session found on %s" % place.anchor)
            else:
                win = app.current_window
                if win is None:
                    die("spawn: iTerm2 has no current window")
            # select=False: the operator is working in another tab, and a spawn that pulls the
            # window to the new one interrupts them every time an agent is launched.
            tab = await win.async_create_tab(command=command, index=index, select=False)
            # Kept for every refusal: it closes the session THIS spawn made, by its own id,
            # never by a tty another session could hold by then.
            made["tab_id"] = tab.tab_id
            try:
                new = await tty_of(tab, connection)
                made["tty"] = new or ""
                # The session is read on a FRESH app: the tab handed back by the creation may
                # be the stale copy whose `current_session` is still None, and an id read
                # there is an empty one — a refusal that then closes nothing.
                new_sess = None
                for _ in range(10 if new else 0):
                    fresh = await iterm2.async_get_app(connection)
                    _, _, new_sess = await find_tab(fresh, new)
                    if new_sess is not None:
                        break
                    await asyncio.sleep(0.3)
                made["session_id"] = (new_sess.session_id if new_sess is not None else
                                      tab.current_session.session_id if tab.current_session
                                      else "")
            except Exception as exc:
                # The tab exists: whatever failed after it, the refusal closes it.
                made["error"] = (str(exc).splitlines() or [type(exc).__name__])[0]
                return None
            return new

        def fallback_tab(make):
            """A real iTerm2 tab, made without the API. It places nothing and keeps no chain:
            the app's AppleScript exposes `index` in its dictionary but does not implement it
            (`-1728` on every form, measured on 3.7.0), and the only placement left there
            drives the menu bar through the accessibility layer — a grant, the app brought to
            the front and a focus flicker per move, which is what the API replaced. A tab that
            lands in the wrong place is an agent that runs; a placement bought at that price
            is not. Said out loud rather than assumed — the placement and the chain both."""
            if place.at != "anywhere" and not place.read_back:
                print("spawn: this rung cannot place a tab; the new session lands where the "
                      "terminal puts it, not beside %s."
                      % ("leftmost" if place.at == "first" else place.anchor), file=sys.stderr)
            if chain:
                print("spawn: this rung keeps no chain, so the chain was not updated (the %s "
                      "was skipped)%s." % (chain, "; your agents stay in your own chain"
                                           if chain == "transfer" else ""), file=sys.stderr)
            return make()

        new_tty = served_by("spawn", {
            "api": lambda: run(go),
            "applescript": lambda: fallback_tab(lambda: as_spawn(command)),
        })
        return new_tty, made.get("tab_id", "")

    def rows(self):
        async def rows(iterm2, connection):
            return await list_rows(await iterm2.async_get_app(connection))
        return served_by("list", {"api": lambda: run(rows), "applescript": as_list})

    def screen(self, tty, lines):
        async def go(iterm2, connection):
            app = await iterm2.async_get_app(connection)
            _, _, sess = await find_tab(app, tty)
            if sess is None:
                die("screen: no session found on %s" % tty)
            contents = await sess.async_get_screen_contents()
            every = [contents.line(i).string.rstrip()
                     for i in range(contents.number_of_lines)]
            return last_lines(every, lines)
        return run(go)

    def close(self, tty, expect):
        async def go(iterm2, connection):
            app = await iterm2.async_get_app(connection)
            _, tab, _ = await find_tab(app, tty)
            await close_session(app, tty, expect)
            return tab.tab_id
        # The AppleScript rung names no tab, so what it closed drops no chain entry.
        return served_by("close", {"api": lambda: run(go),
                                   "applescript": lambda: as_close(tty, expect) and ""})

    def close_made(self, made):
        """By the session's own id, never a tty another session could hold by then. The tab's
        id stands in when the session's could not be read; the tty only when the AppleScript
        rung made the tab, which hands back nothing else, and then seconds after it did.

        The call is wrapped: `run()` catches nothing, and a refusal path that ends on a
        traceback is never an answer — the caller dies with its refusal either way, so a
        close that fails must be SAID, not thrown."""
        session_id = made.get("session_id") or ""
        tab_id = made.get("tab_id") or ""
        tty = made.get("tty") or ""
        if not session_id and not tab_id:
            if not tty:
                return False
            try:
                return bool(as_close(tty, ""))
            except (Exception, SystemExit) as exc:
                print("spawn: the refused session could not be closed: %s"
                      % (str(exc).splitlines() or ["unknown error"])[0], file=sys.stderr)
                return False

        async def go(iterm2, connection):
            app = await iterm2.async_get_app(connection)
            for window in app.windows:
                for tab in window.tabs:
                    hit = [sess for sess in tab.sessions
                           if (session_id and sess.session_id == session_id)
                           or (not session_id and tab.tab_id == tab_id)]
                    if hit:
                        for sess in hit:
                            await sess.async_close(force=True)
                        return True
            return False

        try:
            return bool(run(go))
        except Exception as exc:
            print("spawn: the refused session could not be closed: %s"
                  % (str(exc).splitlines() or ["unknown error"])[0], file=sys.stderr)
            return False

    def owns(self, tty, own):
        async def owned(iterm2, connection):
            app = await iterm2.async_get_app(connection)
            _, tab, _ = await find_tab(app, tty)
            if tab is None:
                return None
            return await move_is_owned(app, tty, own)
        return run(owned)

    def move(self, tty, anchor, right, leftmost):
        async def go(iterm2, connection):
            app = await iterm2.async_get_app(connection)
            win, tab, _ = await find_tab(app, tty)
            if tab is None:
                die("move: no session found on %s" % tty)
            tabs = list(win.tabs)
            if leftmost:
                tabs.remove(tab)
                at = 0
            else:
                target = None
                for i, t in enumerate(tabs):
                    if await tty_of(t) == anchor:
                        target = t
                        break
                if target is None:
                    die("move: no session found on %s" % anchor)
                tabs.remove(tab)
                at = tabs.index(target) + (1 if right else 0)
            tabs.insert(at, tab)
            await win.async_set_tabs(tabs)
            # Re-read the APP, not the window we already hold: both carry a cached tab list,
            # and a reorder read back through either looks like a reorder that never happened
            # — or, worse, reports the position the tab used to have.
            fresh = await iterm2.async_get_app(connection)
            idx, _ = await tab_index_of(fresh, win, tab.tab_id)
            return idx
        return run(go)

    def move_left_of(self, tty, anchor):
        return served_by("move", {"api": lambda: run(
            lambda iterm2, connection: move_left_of(iterm2, connection, tty, anchor))})


ITERM = ItermTerminal()


class NoTab:
    """What made a woken or opened orchestrator that no tab shows (ORCHESTRATOR_HOME_NO_TAB, in
    a test run): a refusal has its server to end and nothing in the app to close."""
    def close_made(self, made):
        return True


NO_TAB = NoTab()


# --- a home session's windows ----------------------------------------------------------
#
# Inside a tmux session the home command marked, an agent is a window of that session, the
# orchestrator sitting in window 0: the operator's tab stays a real terminal, and his agents
# are one keystroke away in the same tab. Every call goes to the caller's own server, the one
# its TMUX names, and is answered on the window's own ids: a pane's tty is recycled within a
# minute of a window's death, measured, and a window id is never reused in a server's life.

# The tmux to run, overridable so the suite can stand a recorder in for it.
TMUX_BIN = os.environ.get("ORCHESTRATOR_TMUX") or "tmux"
# The session option the home command sets on the session it makes.
HOME_MARK = "@orchestrator-home"
# One line per pane, tab-separated; the title is last because the host rewrites it freely.
PANE_FORMAT = "\t".join(("#{session_id}", "#{window_index}", "#{window_id}", "#{pane_id}",
                         "#{pane_tty}", "#{window_name}", "#{pane_title}"))
Pane = collections.namedtuple("Pane", "session index window pane tty name title")


class TmuxError(Exception):
    """A tmux call that never finished: the cause, in words."""


def tmux_call(args, env=None):
    """One tmux call, in UTF-8 whatever the caller's locale says: under a C locale tmux
    hands back every byte past ASCII as `_`, the host's activity glyph included, and stores
    a window name given with one the same way (measured). The finished call, or a TmuxError
    saying why tmux could not be run: it timed out, or its binary is absent or not
    runnable. `env` replaces the caller's environment, for a call that starts a server."""
    try:
        return subprocess.run([TMUX_BIN, "-u"] + list(args), capture_output=True, text=True,
                              timeout=PROBE_TIMEOUT, env=env)
    except subprocess.TimeoutExpired:
        raise TmuxError("timed out after %ds" % PROBE_TIMEOUT)
    except OSError as exc:
        raise TmuxError("%s could not be run (%s)" % (
            TMUX_BIN, "binary absent" if isinstance(exc, FileNotFoundError)
            else exc.strerror or type(exc).__name__))


def tmux_refusal(done):
    """What a finished tmux call that failed said: its last stderr line, else its exit code."""
    lines = [l for l in (done.stderr or "").strip().splitlines() if l.strip()]
    return lines[-1] if lines else "exit %d" % done.returncode


def tmux_out(args, what):
    """What tmux printed for one call, or a death that says what it refused."""
    try:
        done = tmux_call(args)
    except TmuxError as exc:
        die("%s: tmux %s: %s" % (what, args[0], exc))
    if done.returncode != 0:
        die("%s: tmux refused %s: %s" % (what, args[0], tmux_refusal(done)))
    return done.stdout


def in_home_session():
    """Whether the caller runs in a session the home command marked, asked of the caller's
    own pane on its own server. A pane outside tmux (no TMUX or TMUX_PANE) and a session the
    operator made by hand are « no »: their spawns stay tabs, exactly as before.

    A caller that IS in a tmux pane and whose tmux cannot answer — a timeout, a refusal, a
    binary gone — is no « no »: the answer is unknown, and a tab spawned on an unknown would
    leave the home session's agents scattered over two terminals. The call is made once more,
    then the launch dies saying why."""
    if not (os.environ.get("TMUX") and os.environ.get("TMUX_PANE")):
        return False
    cause = ""
    for _ in range(2):
        try:
            done = tmux_call(["show", "-qv", "-t", os.environ["TMUX_PANE"], HOME_MARK])
        except TmuxError as exc:
            cause = str(exc)
            continue
        if done.returncode == 0:
            return done.stdout.strip() == "1"
        cause = "refused: %s" % tmux_refusal(done)
    die("tmux: the home session's mark cannot be read from pane %s (%s); no iTerm2 tab is "
        "made in its place" % (os.environ["TMUX_PANE"], cause))


class TmuxTerminal(Terminal):
    """The windows of the caller's home session. A window takes the next free index and is
    never selected, so the operator's view stays where he put it; window 0 is the
    orchestrator's, and is neither placed before nor moved.

    Its own key in `made`: `window`, the tmux id of the window it made."""

    def __init__(self):
        self.socket = os.environ.get("TMUX", "").split(",")[0]
        self.pane = os.environ.get("TMUX_PANE", "")
        self._session = None

    def stable_id(self, window):
        """A window id qualified by its server: `@1` exists in every server."""
        return "tmux:%s:%s" % (self.socket, window)

    def session(self):
        """The id of the session the caller's pane is in: the home session."""
        if self._session is None:
            found = tmux_out(["display-message", "-p", "-t", self.pane,
                              "#{session_id}"], "tmux").strip()
            # An empty id, or one that is no session's, would be passed on as `-t ':'`: the
            # CURRENT session, which is whichever the operator last looked at.
            if not found.startswith("$"):
                die("tmux: the session of pane %s was answered '%s', not a session id"
                    % (self.pane, found))
            self._session = found
        return self._session

    def panes(self, every=False):
        """The home session's panes, or with `every` the whole server's."""
        where = ["-a"] if every else ["-s", "-t", self.session()]
        found, unread = [], []
        listing = tmux_out(["list-panes"] + where + ["-F", PANE_FORMAT], "tmux")
        for line in listing.splitlines():
            fields = line.split("\t", 6)
            if len(fields) == 7:
                found.append(Pane(*fields))
            elif line.strip():
                unread.append(line)
        if unread and not found:
            die("tmux: the pane listing cannot be read: %d line(s), none with the %d fields "
                "asked for (first: '%s')" % (len(unread), len(Pane._fields), unread[0]))
        if unread:
            print("tmux: %d line(s) of the pane listing were skipped, not in the %d fields "
                  "asked for (first: '%s')" % (len(unread), len(Pane._fields), unread[0]),
                  file=sys.stderr)
        return found

    def lookup(self, tty):
        """The home session's pane on `tty`, or None."""
        for pane in self.panes():
            if pane.tty == tty:
                return pane
        return None

    def window_of(self, tty, what):
        """The home session's pane on `tty`, or a death that says where the tty is instead:
        a window of another session is not this home session's to read, close or move."""
        pane = self.lookup(tty)
        if pane is not None:
            return pane
        for other in self.panes(every=True):
            if other.tty == tty:
                die("%s: refused: %s is a window of another tmux session (%s), not of this "
                    "home session" % (what, tty, other.session))
        die("%s: no window of this home session runs on %s" % (what, tty))

    def find(self, tty):
        return self.lookup(tty) is not None

    def can_place(self, anchor, side):
        return self.lookup(anchor) is not None

    def owner(self, own):
        return tmux_owner()

    def identity(self, tty, fresh=False):
        pane = self.lookup(tty)
        if pane is None:
            return "", ""
        return "tmux:%s:%s" % (self.socket, pane.pane), self.stable_id(pane.window)

    def chain_state(self, own):
        """`(anchor tty, entries to write)`, checked on the window id, never the tty, like
        the iTerm anchor. A terminal never writes the chain: the entries are the launcher's
        to write, and are None when nothing is to change. Only an entry the caller wrote, whose
        id is a tmux window's and whose window is gone, is dropped: an entry another occupant
        wrote, or one naming an iTerm2 tab, is not this listing's to judge. A listing with
        no pane in it proves nothing, and drops nothing."""
        panes = self.panes()
        live = {}
        for pane in panes:
            live.setdefault(self.stable_id(pane.window), pane.tty)
        owner = tmux_owner()
        entries = chain_read(own)
        mine = chain_owned(entries, owner)

        def gone(entry):
            return (entry in mine and entry["tab_id"].startswith("tmux:")
                    and entry["tab_id"] not in live)
        kept = [e for e in entries if not gone(e)] if panes else entries
        anchor = None
        for entry in reversed(chain_owned(kept, owner)):
            if entry["tab_id"] in live:
                anchor = live[entry["tab_id"]]
                break
        return anchor, (kept if len(kept) != len(entries) else None)

    def chain_anchor(self, own):
        return self.chain_state(own)[0]

    def create(self, command, title, place, chain, made):
        # Named with -n: unnamed, tmux renames the window after the program it runs, which
        # reads the host's version number. -d: the operator's window stays the current one.
        if place.at == "first" or (place.at == "beside" and place.side == "left"):
            print("spawn: a window of a home session takes the next free index; the new "
                  "session is not placed %s." % ("first" if place.at == "first" else
                                                 "left of %s" % place.anchor), file=sys.stderr)
        out = tmux_out(["new-window", "-d", "-t", self.session() + ":", "-n", title, "-P",
                        "-F", "#{window_id} #{pane_id} #{pane_tty}", command], "spawn")
        fields = out.split()
        if len(fields) != 3:
            # A window whose id was answered exists, whatever else was: killed before the
            # death, so a refusal leaves no window running a session nobody will start.
            if fields and fields[0].startswith("@"):
                try:
                    done = tmux_call(["kill-window", "-t", fields[0]])
                    killed = done.returncode == 0
                except TmuxError:
                    killed = False
                print("spawn: the window %s %s" % (fields[0], "was killed" if killed else
                                                   "could not be killed"), file=sys.stderr)
            die("spawn: tmux made a window and answered '%s', not its ids and tty"
                % out.strip())
        window, _, tty = fields
        made.update(window=window, tab_id=self.stable_id(window), tty=tty)
        return tty, made["tab_id"]

    def rows(self):
        own = self_tty() or ""
        panes = self.panes()
        return [row_for(1, int(p.index), p.tty, p.title, session_name_on(p.tty),
                        bool(own) and p.tty == own, False) for p in panes] + \
            orphan_lines([("w1/t%s" % p.index, p.tty, self.stable_id(p.window)) for p in panes])

    def screen(self, tty, lines):
        pane = self.window_of(tty, "screen")
        out = tmux_out(["capture-pane", "-p", "-t", pane.pane, "-S", "-%d" % max(lines, 0)],
                       "screen")
        return last_lines([l.rstrip() for l in out.split("\n")], lines)

    def close(self, tty, expect):
        """Guarded on the window's name, fixed at its making, rather than on a title the
        host rewrites as it works. Window 0 is the orchestrator's place: only a takeover puts
        a successor there, so a close of it is refused before anything is killed."""
        pane = self.window_of(tty, "close")
        if pane.index == "0":
            refuse_window_zero("close", tty, pane.name)
        if expect and stable_title(expect) not in stable_title(pane.name):
            die("close: refused: the window on %s is named '%s', which does not contain '%s'"
                % (tty, pane.name, expect))
        self.kill(pane.window, "close")
        return self.stable_id(pane.window)

    def kill(self, window, what):
        """Kill a window by its id. A window tmux cannot find is already closed, which is
        what was asked; any other refusal dies with its message."""
        try:
            done = tmux_call(["kill-window", "-t", window])
        except TmuxError as exc:
            die("%s: tmux kill-window: %s" % (what, exc))
        if done.returncode == 0:
            return
        refusal = tmux_refusal(done)
        if "can't find window" in refusal:
            print("%s: window %s was already gone" % (what, window), file=sys.stderr)
            return
        die("%s: tmux refused kill-window: %s" % (what, refusal))

    def survives(self, stable_id):
        """Whether the window is still in the server's panes: the proof a close is made on,
        a pane's tty being recycled within a minute of a window's death."""
        return any(self.stable_id(p.window) == stable_id for p in self.panes(every=True))

    def close_made(self, made):
        """By the window's own id, never a tty another window could hold by then."""
        window = made.get("window") or ""
        if not window:
            return False
        try:
            self.kill(window, "spawn")
        except SystemExit:
            print("spawn: the refused session's window %s could not be killed" % window,
                  file=sys.stderr)
            return False
        return True

    def owns(self, tty, own):
        # A tty no window of this session runs on is not None here: the death says where it
        # is instead, another session's window or none at all.
        pane = self.window_of(tty, "move")
        if tty == own:
            return True
        mine = {e["tab_id"] for e in chain_owned(chain_read(own), tmux_owner())}
        return self.stable_id(pane.window) in mine

    def move(self, tty, anchor, right, leftmost):
        """Before or after the anchor's window, the session's indexes closed up after; -d
        keeps the operator's window current, which a bare move takes (measured)."""
        source = self.window_of(tty, "move")
        if source.index == "0":
            die("move: refused: the window on %s is window 0, the orchestrator's, and it is "
                "not moved" % tty)
        if leftmost:
            die("move: refused: the first place of a home session is window 0, and window 0 "
                "is the orchestrator's")
        target = self.window_of(anchor, "move")
        if target.index == "0" and not right:
            die("move: refused: window 0 is the orchestrator's: nothing is placed before it")
        tmux_out(["move-window", "-d", "-a" if right else "-b", "-s", source.window,
                  "-t", target.window], "move")
        try:
            tmux_out(["move-window", "-r", "-t", self.session()], "move")
        except SystemExit:
            die("move: the window %s was already moved %s %s, but the session's indexes could "
                "not be closed up after it" % (source.window, "after" if right else "before",
                                                target.window))
        for pane in self.panes():
            if pane.window == source.window:
                return int(pane.index)
        die("move: the window %s was moved %s %s, and is no longer in the session's listing"
            % (source.window, "after" if right else "before", target.window))

    def move_left_of(self, tty, anchor):
        self.move(tty, anchor, False, False)


_chosen = {}


def terminal(agent=True):
    """The terminal this launcher drives: the one place that chooses.

    A caller in a home session gets its windows; any other gets iTerm2. Only an agent's
    spawn and an orchestrator's successor are windows (`agent` True): the successor takes the
    predecessor's window 0 in the same session, where its agents are. The auditor, the
    coordinator's successor and a woken or opened orchestrator are made as tabs (`agent`
    False). The mark is read once per run."""
    if not agent:
        return ITERM
    if "terminal" not in _chosen:
        _chosen["terminal"] = TmuxTerminal() if in_home_session() else ITERM
    return _chosen["terminal"]


def terminal_for(tty):
    """The terminal a command that names a tty acts on: found by the target, not by the
    caller. A home caller still has iTerm2 tabs it did not make as windows — the
    coordinator's, an auditor's, a woken orchestrator's — and a close, a read or a move of
    one goes to the app, as before. A tty that is a pane of the caller's own server is a
    window; any other tty is a tab."""
    chosen = terminal()
    if isinstance(chosen, TmuxTerminal) and not any(p.tty == tty for p in
                                                    chosen.panes(every=True)):
        return ITERM
    return chosen


def refuse_window_zero(what, tty, name):
    """The refusal of a close or a rotation of window 0 of a home session, said before anything
    is killed or spawned: only a takeover puts a successor at index 0, and it is named."""
    die("%s: refused: the window on %s is window 0, the orchestrator's place in this home "
        "session: a successor takes it with takeover --tty %s --expect-title \"%s\", which also "
        "puts its own window at index 0" % (what, tty, tty, name))


# --- the orchestrator's home session ------------------------------------------------

# Read by home servers alone, through -f: the operator's own tmux setup is never touched.
HOME_CONF = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                                          "tmux", "home.conf"))
HOME_SESSION = "home"
# One server per orchestrator, named after its session id: a server's death ends one
# orchestration and its agents, never every orchestration of the machine.
HOME_SOCKET_PREFIX = "orch-"
LAUNCHER_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "iterm-agent.sh")
# How long window 0 waits for the session it resumes to end in its old place.
HOME_WAIT = int(os.environ.get("ORCHESTRATOR_HOME_WAIT", "120"))
# What a home server is started with: the operator's own variables, never the caller's whole
# environment, which is a host's (a session's id, its nesting marks) and would pass to every
# window of the server.
HOME_ENV_KEPT = ("HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
                 "TMPDIR", "TMUX_TMPDIR", "CLAUDE_CONFIG_DIR")
# The suite's stand-ins: a test's, never a home server's.
HOME_ENV_DROPPED = ("ORCHESTRATOR_DRY_RUN", "ORCHESTRATOR_SELF_TTY", "ORCHESTRATOR_SELF_ID",
                    "ORCHESTRATOR_PS_TABLE", "ORCHESTRATOR_CWD_TABLE", "ORCHESTRATOR_HOST_ARGV",
                    "ORCHESTRATOR_HOME_NO_TAB", "ORCHESTRATOR_NEW_SESSION_ID",
                    "ORCHESTRATOR_TEST_RUN")
# Set by the suite and by the live test script, never by a launch: ORCHESTRATOR_HOME_NO_TAB
# is honoured only beside it. Left in a shell alone, it would move an orchestrator into a
# server no tab shows.
TEST_MARK = "ORCHESTRATOR_TEST_RUN"
_no_tab_said = []


def home_no_tab():
    """Whether a move, a wake or an open makes its server and no tab: asked for by
    ORCHESTRATOR_HOME_NO_TAB and allowed by the test marker. The variable without the marker
    is ignored, with one line on stderr."""
    if not os.environ.get("ORCHESTRATOR_HOME_NO_TAB"):
        return False
    if os.environ.get(TEST_MARK):
        return True
    if not _no_tab_said:
        _no_tab_said.append(True)
        print("home: ORCHESTRATOR_HOME_NO_TAB is ignored: it is honoured only in a test run "
              "(%s set); a tab will show the home server" % TEST_MARK, file=sys.stderr)
    return False
# The host's options, by what each takes, for the resume of a running session: its launch is
# replayed, less what named the conversation or its first prompt. An option this table does
# not know refuses the move: replayed blind, it could swallow the resume's own words.
HOST_ONE_VALUE = {
    "--agent", "--agents", "--append-system-prompt", "--append-system-prompt-file",
    "--autocompact", "--debug-file", "--effort", "--fallback-model", "--input-format",
    "--json-schema", "--max-budget-usd", "--model", "--output-format", "--permission-mode",
    "--permission-prompts", "--permission-prompt-tool", "--plugin-dir", "--plugin-url",
    "--remote-control-session-name-prefix", "--setting-sources", "--settings",
    "--system-prompt", "--system-prompt-file", "--system-prompt-snapshot"}
HOST_MANY_VALUES = {"--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools",
                    "--disallowed-tools", "--mcp-config", "--tools", "--betas", "--file"}
HOST_OPTIONAL_VALUE = {"--remote-control", "--debug", "-d", "--prompt-suggestions"}
HOST_FLAGS = {"--allow-dangerously-skip-permissions", "--dangerously-skip-permissions",
              "--strict-mcp-config", "--verbose", "--ide", "--chrome", "--no-chrome",
              "--ax-screen-reader", "--brief", "--disable-slash-commands",
              "--exclude-dynamic-system-prompt-sections", "--forward-subagent-text",
              "--include-hook-events", "--include-partial-messages", "--restricted",
              "--safe-mode", "--bare"}
# Dropped, the resume naming the conversation and the name itself.
HOST_DROPPED_ONE = {"--name", "-n", "--session-id"}
HOST_DROPPED_OPTIONAL = {"--resume", "-r"}
HOST_DROPPED_FLAGS = {"--continue", "-c", "--fork-session"}
# A session started so has no terminal of its own to move, or a place the move would lose.
HOST_REFUSED = {"-p", "--print", "--bg", "--background", "--cloud", "--desktop", "--tmux",
                "--worktree", "-w", "--teleport", "--from-pr", "--environment",
                "--no-session-persistence"}


PLUGIN_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                                            "..", ".."))


def plugin_path(path):
    """A path of the plugin's, as the plugin's root reads it: the same on every machine."""
    return os.path.relpath(path, PLUGIN_ROOT)


def home_socket(session_id):
    """The home server's socket name: the orchestrator's session id, its first characters."""
    return HOME_SOCKET_PREFIX + re.sub(r"[^0-9A-Za-z]", "", session_id)[:8]


def home_env():
    """The environment a home server starts with, and so every window it makes: the
    operator's own variables and this plugin's settings, the suite's stand-ins left out."""
    env = {k: v for k, v in os.environ.items()
           if k in HOME_ENV_KEPT or (k.startswith("ORCHESTRATOR_") and k not in HOME_ENV_DROPPED)}
    env["TERM"] = "xterm-256color"
    return env


def resume_words(args, session_id, name, prompt):
    """The words that resume `session_id` under `name` with `prompt`, from the words its
    running process was started with (`args`, its program left out): the same options, the
    model, the effort, the mode, the settings and the servers among them, less what named a
    conversation or carried a first prompt. Raises ValueError naming an option it cannot
    replay."""
    kept, i = [], 0
    while i < len(args):
        word = args[i]
        i += 1
        if not word.startswith("-") or word == "-":
            continue  # the first prompt: the conversation holds it already
        option, eq, _ = word.partition("=")
        if option in HOST_REFUSED:
            raise ValueError("the session was started with %s, which a home session does not "
                             "replay" % option)
        if option in HOST_DROPPED_FLAGS:
            continue
        if option in HOST_DROPPED_ONE or option in HOST_DROPPED_OPTIONAL:
            if not eq and i < len(args) and (option in HOST_DROPPED_ONE
                                              or not args[i].startswith("-")):
                i += 1
            continue
        if option in HOST_FLAGS:
            kept.append(word)
        elif option in HOST_ONE_VALUE:
            kept.append(word)
            if not eq:
                if i >= len(args):
                    raise ValueError("%s has no value" % option)
                kept.append(args[i])
                i += 1
        elif option in HOST_OPTIONAL_VALUE:
            kept.append(word)
            if not eq and i < len(args) and not args[i].startswith("-"):
                kept.append(args[i])
                i += 1
        elif option in HOST_MANY_VALUES:
            kept.append(word)
            while not eq and i < len(args) and not args[i].startswith("-"):
                kept.append(args[i])
                i += 1
        else:
            raise ValueError("the session was started with %s, an option the move does not "
                             "know how to replay" % option)
    return kept + ["--resume", session_id] + ([prompt] if prompt else []) + ["--name", name]


def with_pair(words, model, effort):
    """`words` with every `--model` and `--effort` they carry replaced by `model` and `effort`,
    typed first."""
    kept, i = [], 0
    while i < len(words):
        option, eq, _ = words[i].partition("=")
        if option in ("--model", "--effort"):
            i += 1 if eq else 2
            continue
        kept.append(words[i])
        i += 1
    return ["--model", model, "--effort", effort] + kept


def host_argv(pid):
    """The words the process `pid` was started with, its program first, read from the kernel
    (`ps` joins them with spaces, and a value holding one could not be told from two), or
    None. ORCHESTRATOR_HOST_ARGV, a JSON list, stands in for the suite."""
    stand_in = os.environ.get("ORCHESTRATOR_HOST_ARGV")
    if stand_in:
        return json.loads(stand_in)
    if sys.platform != "darwin":
        return None
    import ctypes
    import ctypes.util
    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    ctl_kern, kern_argmax, kern_procargs2 = 1, 8, 49
    argmax = ctypes.c_int(0)
    size = ctypes.c_size_t(ctypes.sizeof(argmax))
    if libc.sysctl((ctypes.c_int * 2)(ctl_kern, kern_argmax), 2, ctypes.byref(argmax),
                   ctypes.byref(size), None, 0) != 0:
        return None
    buf = ctypes.create_string_buffer(argmax.value)
    size = ctypes.c_size_t(argmax.value)
    if libc.sysctl((ctypes.c_int * 3)(ctl_kern, kern_procargs2, int(pid)), 3, buf,
                   ctypes.byref(size), None, 0) != 0:
        return None
    raw = buf.raw[:size.value]
    argc = int.from_bytes(raw[:4], sys.byteorder)
    # The executable's path, its padding, then the words.
    _, _, rest = raw[4:].partition(b"\0")
    words = rest.lstrip(b"\0").split(b"\0")[:argc]
    return [w.decode("utf-8", "replace") for w in words] if len(words) == argc else None


def session_record(session_id):
    """`(pid, record)` of the running process the host registered for `session_id`, or
    (None, None)."""
    folder = os.path.join(host_config_dir(), "sessions")
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return None, None
    for entry in names:
        pid = entry[:-len(".json")] if entry.endswith(".json") else ""
        record = host_registry(pid)
        if not record or record.get("sessionId") != session_id:
            continue
        try:
            os.kill(int(pid), 0)
        except (OSError, ValueError):
            continue
        return pid, record
    return None, None


def tmux_on(socket, args, what):
    """One call to the home server `socket`: what it printed, or a death saying what tmux
    refused."""
    return tmux_out(["-L", socket] + list(args), what)


def make_home(socket, title, cwd, program, what):
    """Start the home server `socket` with its session, window 0 named `title` running
    `program` in `cwd`; the tty of window 0. A server already there is refused by tmux
    itself (its session already exists), and the death says so."""
    try:
        done = tmux_call(["-L", socket, "-f", HOME_CONF, "new-session", "-d", "-s",
                          HOME_SESSION, "-n", title, "-c", cwd, program], env=home_env())
    except TmuxError as exc:
        die("%s: tmux new-session: %s" % (what, exc))
    if done.returncode != 0:
        die("%s: tmux refused to start the home server %s: %s"
            % (what, socket, tmux_refusal(done)))
    tty = tmux_on(socket, ["display-message", "-p", "-t", HOME_SESSION + ":0",
                           "#{pane_tty}"], what).strip()
    if not tty.startswith("/dev/"):
        die("%s: the home server %s answered '%s' for window 0's tty; %s"
            % (what, socket, tty, ended_clause(socket)))
    return tty


# How long the watcher waits for a server that is not there yet before it gives up: a server
# is up by the time its watcher starts.
HOME_WATCH_UP = 3


def home_end_marker(socket):
    """The file a launcher command leaves before it ends the home server `socket`: the
    server's watcher then knows the end was traced by that command and says nothing."""
    return os.path.join(STATE_DIR, "home-ended", socket)


def trace_home(socket, ended, cause, tty):
    """One dated line in close.log for an end of a home server, or of its window 0: what
    ended, on which socket, from which cause, on which tty."""
    close_log("home", "%s %s ended: cause=%s tty=%s" % (ended, socket, cause, tty or "-"),
              echo=False)


def unmark_home(socket):
    """Take back the file `kill_watched_home` left: the server was not ended, so its watcher
    still has an end to say."""
    try:
        os.remove(home_end_marker(socket))
    except OSError:
        pass


def trace_home_unproved(socket, cause, why, tty):
    """One dated line for an end of a home server that was asked and not proved: the kill went
    out, and what was left to see says why the end cannot be called done."""
    close_log("home", "server %s end not proved: cause=%s tty=%s (%s)"
              % (socket, cause, tty or "-", why), echo=False)


def home_socket_path(socket):
    """The file tmux listens on for the server `socket`, where tmux itself puts it."""
    return os.path.join(os.environ.get("TMUX_TMPDIR") or "/tmp", "tmux-%d" % os.getuid(), socket)


def home_answers(socket):
    """Whether the server `socket` still answers on its file: asked of the file itself, so
    no tmux is run."""
    import socket as sockets
    probe = sockets.socket(sockets.AF_UNIX)
    try:
        probe.connect(home_socket_path(socket))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def remove_exited_home_socket(socket):
    """Remove the socket file tmux left behind for the server `socket`, once nothing answers
    there: asked again right before the remove, since a server restarted on the same name
    since the last probe owns the file."""
    if home_answers(socket):
        return
    try:
        os.remove(home_socket_path(socket))
    except OSError:
        pass


def kill_home(socket):
    """End the home server `socket`, every window it holds with it; True when tmux did. The
    socket file goes with it once nothing answers there: tmux leaves it behind on a kill
    (measured on 3.8)."""
    try:
        ended = tmux_call(["-L", socket, "kill-server"]).returncode == 0
    except TmuxError:
        return False
    if ended and not home_answers(socket):
        try:
            os.remove(home_socket_path(socket))
        except OSError:
            pass
    return ended


def kill_watched_home(socket):
    """End the home server `socket` that a watcher watches, and leave the file that tells the
    watcher this command traces the end: taken back when tmux did not end the server, so the
    next real end is not silent. True when tmux ended it."""
    try:
        os.makedirs(os.path.dirname(home_end_marker(socket)), exist_ok=True)
        open(home_end_marker(socket), "w").close()
    except OSError:
        pass
    ended = kill_home(socket)
    if not ended:
        unmark_home(socket)
    return ended


def ended_clause(socket):
    """End the home server `socket` and say what became of it — only what is true."""
    if kill_home(socket):
        return "the server was ended"
    return ("the server was NOT ended: end it with %s -L %s kill-server" % (TMUX_BIN, socket))


def attach_program(socket, title):
    """What the iTerm2 tab of a home session runs: the tmux client of its server, as a launch
    file through the login shell like every tab the launcher makes (§22)."""
    import shutil
    command = ("printf '\\033]0;%%s\\007' %s && exec env -u TMUX -u TMUX_PANE %s -u -L %s "
               "attach -t %s" % (shq(title), shq(shutil.which(TMUX_BIN) or TMUX_BIN),
                                 shq(socket), HOME_SESSION))
    return "%s -l %s" % (LOGIN_SHELL, write_launch_script(command, title, "attach"))


def client_on(socket, tty):
    """Whether a client of the home server `socket` runs on `tty`, waited for: the proof the
    tab shows the home session."""
    deadline = time.time() + SPAWN_TIMEOUT
    while True:
        try:
            done = tmux_call(["-L", socket, "list-clients", "-F", "#{client_tty}"])
            if done.returncode == 0 and tty in done.stdout.split():
                return True
        except TmuxError:
            pass
        if time.time() >= deadline:
            return False
        time.sleep(0.3)


def open_home_tab(socket, title, anchor, what):
    """The iTerm2 tab that shows the home server, right of `anchor`, proved by its client:
    `(its tty, what was made)`. Any failure ends the server and closes the tab, then dies:
    a home session nobody can see is not left running."""
    made = {"terminal": ITERM}
    place = Place("beside", anchor, "right", False) if anchor else Place("anywhere", "",
                                                                         "right", False)
    try:
        tty, _ = ITERM.create(attach_program(socket, title), title, place, "", made)
    except SystemExit:
        if not kill_home(socket):
            print("%s: the server %s was NOT ended: end it with %s -L %s kill-server"
                  % (what, socket, TMUX_BIN, socket), file=sys.stderr)
        raise
    if made.get("error") or not tty:
        closed = ITERM.close_made(made)
        die("%s: the tab for the home server %s %s; %s; %s"
            % (what, socket, "failed: %s" % made["error"] if made.get("error")
               else "returned no tty", closed_clause(closed, tty), ended_clause(socket)))
    if not client_on(socket, tty):
        closed = ITERM.close_made(made)
        die("%s: the tab on %s shows no client of the home server %s after %ds; %s; %s"
            % (what, tty, socket, SPAWN_TIMEOUT, closed_clause(closed, tty),
               ended_clause(socket)))
    if not arm_home(socket, what):
        closed = ITERM.close_made(made)
        die("%s: the home server %s could not be told to exit with its tab, so closing the tab "
            "would not end it; %s; %s" % (what, socket, closed_clause(closed, tty),
                                         ended_clause(socket)))
    start_home_watch(socket, tty)
    return tty, made


def arm_home(socket, what):
    """Tell the home server `socket` to exit once no client is attached: closing its tab then
    ends the server, its orchestrator and every agent window (the operator's order: the tab's
    close ends them all). Called only once the tab's client is proved attached. Set at the
    start, the option would end the server before its tab attached; a takeover kills a window
    with the tab still attached, and a server shown by no tab is never armed. True when tmux
    took the option."""
    try:
        done = tmux_call(["-L", socket, "set-option", "-s", "exit-unattached", "on"])
    except TmuxError as exc:
        print("%s: tmux set-option: %s" % (what, exc), file=sys.stderr)
        return False
    if done.returncode != 0:
        print("%s: tmux refused exit-unattached: %s" % (what, tmux_refusal(done)),
              file=sys.stderr)
        return False
    return True


def start_home_watch(socket, tty):
    """Start the watcher of the home server `socket`, shown by the tab `tty`: the server
    exits by itself when its tab closes, with no launcher command to say so, and the watcher
    is what writes that end. It outlives this command and ends with the server."""
    try:
        os.makedirs(os.path.dirname(home_end_marker(socket)), exist_ok=True)
        if os.path.exists(home_end_marker(socket)):
            os.remove(home_end_marker(socket))
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "home-watch", "--socket",
                          socket, "--tty", tty], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    except OSError as exc:
        print("home: the end of the server %s will not be traced: %s" % (socket, exc),
              file=sys.stderr)


def cmd_home_watch(argv):
    """Wait for the home server to end, then write its end when no launcher command did:
    run in the background by the start of a home tab, never by hand."""
    p = argparse.ArgumentParser(prog="home-watch", add_help=False)
    p.add_argument("--socket", default="")
    p.add_argument("--tty", default="")
    args, _ = p.parse_known_args(argv)
    if not args.socket:
        die("home-watch: --socket is required")
    poll = float(os.environ.get("ORCHESTRATOR_HOME_WATCH_POLL", "0.5"))

    def alive():
        return home_answers(args.socket)
    deadline = time.time() + HOME_WATCH_UP
    while not alive():
        if time.time() >= deadline:
            return
        time.sleep(poll)
    while alive():
        time.sleep(poll)
    # The server exited by itself and nothing answered on its file: tmux leaves it behind.
    remove_exited_home_socket(args.socket)
    marker = home_end_marker(args.socket)
    if os.path.exists(marker):
        os.remove(marker)
        return
    trace_home(args.socket, "server", "exit-unattached (its tab closed; no launcher command "
               "ended it)", args.tty)


def home_of_tab(tty):
    """The home server whose client runs on the tab `tty`, or "": read from the client's own
    command line, which names its server with -L."""
    for _, command in ps_rows(tty):
        words = command.split()
        if not words or os.path.basename(words[0]) != os.path.basename(TMUX_BIN):
            continue
        for i, word in enumerate(words[:-1]):
            if word == "-L" and words[i + 1].startswith(HOME_SOCKET_PREFIX):
                return words[i + 1]
    return ""


def home_panes(socket):
    """The panes of the home server `socket`: `([(window index, tty)], "")`, or `(None, why)`
    when the server cannot be listed."""
    try:
        done = tmux_call(["-L", socket, "list-panes", "-a", "-F",
                          "#{window_index} #{pane_tty}"])
    except TmuxError as exc:
        return None, "tmux could not be asked (%s)" % exc
    if done.returncode != 0:
        return None, "tmux refused to list its panes (%s)" % tmux_refusal(done)
    return [l.split() for l in done.stdout.splitlines() if len(l.split()) == 2], ""


def end_home(socket, what, listed=None, tab=""):
    """End a home server and prove it: no host left on any of its windows' ttys, and no tmux
    server left on its socket. `(session id of window 0, the ttys it held)`. A server whose
    window 0 session id cannot be read is NOT ended, and the death says why: a pause that
    recorded no session would wake a fresh conversation, the orchestrator's own lost. `listed`
    is `home_panes`' answer, when the caller has asked already. `tab` is the tab's tty, for the
    line that says an end was not proved."""
    panes, why = listed if listed is not None else home_panes(socket)
    session_id = ""
    if panes is not None:
        why = "no host of window 0 was found on the server"
        for index, tty in panes:
            if index == "0":
                pid = cli_pid_on_tty(tty)
                record = host_registry(pid) if pid else None
                session_id = (record or {}).get("sessionId", "")
                if session_id:
                    break
                why = "window 0 on %s runs no host whose session can be read" % tty
    # A server answering with no pane at all holds no conversation to lose.
    if not session_id and (panes is None or panes):
        die("%s: refused: the session of the orchestrator in window 0 of the home server %s "
            "cannot be read: %s; the server was NOT ended and the orchestrator stays where it "
            "is: its conversation would be lost" % (what, socket, why))
    ttys = [tty for _, tty in panes or []]
    # Read before the server is ended, as for a tab: a host the end of its pane does not end
    # is ended by its pid and start time.
    hosts = {tty: host_identity(tty) for tty in ttys}
    kill_watched_home(socket)

    def survives(tty):
        host = hosts.get(tty)
        if not host:
            return wait_gone(tty) is not None
        return not end_host(host[0], host[1], tty, what) or bool(others_on(tty, host[0]))
    survivors = [tty for tty in ttys if survives(tty)]
    if survivors:
        trace_home_unproved(socket, what, "a host still runs on %s" % ", ".join(survivors), tab)
        die("%s: the home server %s was asked to end, and a host still runs on %s"
            % (what, socket, ", ".join(survivors)))
    deadline = time.time() + CLOSE_TIMEOUT
    while True:
        try:
            alive = tmux_call(["-L", socket, "has-session"]).returncode == 0
        except TmuxError:
            alive = False
        if not alive:
            break
        if time.time() >= deadline:
            unmark_home(socket)
            trace_home_unproved(socket, what, "the server still answers", tab)
            die("%s: the home server %s still answers after %ds" % (what, socket, CLOSE_TIMEOUT))
        time.sleep(0.3)
    return session_id, ttys


def iterm_title(tty):
    """The name iTerm2 shows for the session on `tty`, or None when it has none there."""
    async def go(iterm2, connection):
        app = await iterm2.async_get_app(connection)
        _, _, sess = await find_tab(app, tty)
        return None if sess is None else (await sess.async_get_variable("autoName") or "")
    return run(go)


def close_home_tab(tty, socket, expect, listed=None):
    """Close a tab that shows a home session: its title checked first, then the server
    ended, every window of it proved gone, then the tab if it outlived its client. Prints
    the close's contract line, then the server and the session window 0 ran, which a pause
    records for the wake."""
    if expect:
        name = iterm_title(tty)
        if name is None:
            die("close: no session found on %s" % tty)
        if stable_title(expect) not in stable_title(name):
            die("close: refused: session on %s is titled '%s', which does not contain '%s'"
                % (tty, name, expect))
    session_id, ttys = end_home(socket, "close", listed, tty)
    trace_home(socket, "server", "close", tty)
    deadline = time.time() + CLOSE_TIMEOUT
    while ITERM.find(tty):
        if time.time() >= deadline:
            ITERM.close(tty, "")
            break
        time.sleep(0.3)
    print("closed 1 session on %s" % tty)
    print("home: ended the server %s and its %d window(s)%s"
          % (socket, len(ttys), ", session %s" % session_id if session_id else ""))
    sys.stdout.flush()


def cmd_takeover(argv):
    """A successor's close of its predecessor inside their home session: the predecessor's
    window 0 killed, guarded by its name and proved on the process table and the server, then
    the successor's own window moved to index 0 without taking the operator's view; window 0
    is selected only if the operator was on it."""
    p = argparse.ArgumentParser(prog="takeover", add_help=False)
    p.add_argument("--tty", default="")
    p.add_argument("--expect-title", dest="expect", default="")
    args, unknown = p.parse_known_args(argv)
    if unknown:
        die("takeover: unknown option %s" % unknown[0])
    if not args.tty:
        die("takeover: --tty is required")
    if not in_home_session():
        die("takeover: refused: this session is not in a home session; close the predecessor's "
            "tab with close --tty")
    term = TmuxTerminal()
    own = self_tty() or ""
    mine = term.window_of(own, "takeover")
    pred = term.window_of(args.tty, "takeover")
    if pred.window == mine.window:
        die("takeover: refused: %s is this session's own window" % args.tty)
    if pred.index != "0":
        die("takeover: refused: the window on %s is window %s, not window 0: the predecessor's "
            "is the orchestrator's place" % (args.tty, pred.index))
    if not args.expect:
        die("takeover: --expect-title is required: the predecessor's window is killed only "
            "when its name holds the title `list` printed")
    if stable_title(args.expect) not in stable_title(pred.name):
        die("takeover: refused: the window on %s is named '%s', which does not contain '%s'"
            % (args.tty, pred.name, args.expect))
    viewed = tmux_out(["display-message", "-p", "-t", pred.window, "#{window_active}"],
                      "takeover").strip() == "1"
    # Read once the name is checked and before the kill: the process the succession ends,
    # and the owner its chain entries carry, which the pane gone no longer names.
    host = host_identity(args.tty)
    own_owner = tmux_owner()
    pred_owner = ("tmux:%s:%s" % (os.environ.get("TMUX", "").split(",")[0], pred.pane)
                  if own_owner else "")
    term.kill(pred.window, "takeover")
    if host:
        if not end_host(host[0], host[1], args.tty, "takeover"):
            die("takeover: the window %s was killed and %s still runs on %s, %s; window 0 was "
                "not taken" % (pred.window, host[0], args.tty, end_failure(host[0], args.tty)))
        others = others_on(args.tty, host[0])
        survivor = others[0] if others else None
    else:
        survivor = wait_gone(args.tty)
    if survivor is not None:
        die("takeover: the window %s was killed and %s still runs on %s; window 0 was not taken"
            % (pred.window, survivor, args.tty))
    if term.survives(term.stable_id(pred.window)):
        die("takeover: the window %s is still there; window 0 was not taken" % pred.window)
    home = os.path.basename(os.environ.get("TMUX", "").split(",")[0])
    if home:
        trace_home(home, "window 0 of", "takeover", args.tty)
    chain_drop_tab(term.stable_id(pred.window))
    # The predecessor's agents follow it to its successor: what it launched after the
    # succession's spawn handed its chain over would otherwise be nobody's.
    if pred_owner and own_owner:
        chain_transfer(args.tty, pred_owner, own, own_owner, merge=True)
    tmux_out(["move-window", "-d", "-s", mine.window, "-t", "%s:0" % term.session()], "takeover")
    if viewed:
        tmux_out(["select-window", "-t", mine.window], "takeover")
    print("took window 0: the predecessor's window %s on %s was closed" % (pred.window, args.tty))


def cmd_home(argv):
    """Move a running orchestrator into a home session of its own, in its own place: a home
    server whose window 0 resumes the same conversation once the session has ended where it
    runs now, and a tab right of the caller's that shows it. Run by the hooks module at the
    end of the turn that named the session; prints `moved: <server>` (the module then ends
    the session, and window 0 closes the old tab once the session is gone) or `stay: <why>`.
    Nothing is ended here, and any failure leaves the session running where it is."""
    p = argparse.ArgumentParser(prog="home", add_help=False)
    p.add_argument("--session", default="")
    p.add_argument("--name", default="")
    p.add_argument("--prompt", default="")
    args, unknown = p.parse_known_args(argv)
    if unknown:
        die("home: unknown option %s" % unknown[0])
    if not args.session:
        die("home: --session is required")
    if not args.name.startswith("Orch : ") or not TITLE_SHAPE.match(args.name):
        print("stay: only an orchestrator moves into a home session, and this session is "
              "named '%s'" % args.name[:40])
        return
    if in_home_session():
        print("stay: this session already runs in a home session")
        return
    pid, record = session_record(args.session)
    if not pid:
        die("home: no running process of session %s is in the host's registry; the session "
            "stays where it is" % args.session)
    words = host_argv(pid)
    if not words:
        die("home: the launch of process %s cannot be read; the session stays where it is"
            % pid)
    try:
        resume = resume_words(words[1:], args.session, args.name, args.prompt)
    except ValueError as exc:
        die("home: %s; the session stays where it is" % exc)
    # The launch line says what was asked at the launch; a `/model` or an `/effort` typed
    # since is on the transcript alone. The move resumes on the pair the session runs on now.
    try:
        model, effort = caller_pair(args.session)
    except PairUnreadable as exc:
        print("stay: the session's model and effort cannot be read (%s)" % exc)
        return
    resume = with_pair(resume, model, effort)
    cwd = record.get("cwd") or ""
    if not os.path.isdir(cwd):
        die("home: the session's directory '%s' is not there; the session stays where it is"
            % cwd)
    import shlex
    import shutil
    cli = shutil.which(HOST_CLI) or HOST_CLI
    socket = home_socket(args.session)
    own = self_tty() or ""
    no_tab = home_no_tab()
    # The old tab's own session id, read before anything is made: once the session ends, its
    # title is the shell's, and the id is what names that tab and no other.
    old_id = ""
    if not no_tab and not DRY_RUN:
        try:
            old_id, _ = ITERM.identity(own)
        except Exception as exc:
            die("home: this session's tab cannot be read (%s); the session stays where it is"
                % (str(exc).splitlines() or [type(exc).__name__])[0])
        if not old_id:
            die("home: this session is not a tab of iTerm2's (%s), so no tab can take its "
                "place; the session stays where it is" % own)
    if DRY_RUN and not no_tab:
        old_id = "<old-tab-session-id>"
    resume_line = " ".join(shlex.quote(w) for w in [cli] + resume)
    # The old tab is released by a watcher of the launcher, started beside the resume and
    # closing it only once the resumed host is proved running on this pane: a resume that
    # fails leaves both tabs, and the pane says so and stays open.
    release = ("pane=$(tty); %s home-release --tty %s --session-id %s --pane-tty \"$pane\" "
               "--resumed %s >> %s 2>&1 & watcher=$!; "
               % (shq(LAUNCHER_SH), shq(own), shq(old_id), shq(args.session),
                  shq(os.path.join(STATE_DIR, "home-release.log")))) if old_id else ""
    launch = ("cd %s && i=0 && while kill -0 %s 2>/dev/null; do "
              "if [ $i -ge %d ]; then echo 'the session did not end in its old place: it "
              "goes on there'; sleep 10; exit 1; fi; sleep 0.2; i=$((i+1)); done; "
              "%s%s; rc=$?; [ $rc -eq 0 ] && exit 0; %sprintf 'the resume of session %%s failed "
              "(exit %%s); resume it by hand: %%s\\n' %s \"$rc\" %s; "
              "exec \"${SHELL:-/bin/sh}\" -l"
              % (shq(cwd), pid, HOME_WAIT * 5, release, resume_line,
                 "kill $watcher 2>/dev/null; " if old_id else "", shq(args.session),
                 shq("cd %s && %s" % (shq(cwd), resume_line))))
    if DRY_RUN:
        print("home_server=%s" % socket)
        print("home_conf=%s" % plugin_path(HOME_CONF))
        print("home_window0=%s" % args.name)
        print("home_launch=%s" % launch)
        print("home_tab=%s" % ("none" if no_tab else "right of %s" % own))
        return
    program = "%s -l %s" % (LOGIN_SHELL, write_launch_script(launch, args.name, "home"))
    make_home(socket, args.name, cwd, program, "home")
    if no_tab:
        print("moved: %s (no tab: attach with %s -L %s attach)" % (socket, TMUX_BIN, socket))
        return
    tty, _ = open_home_tab(socket, args.name, own, "home")
    print("moved: %s, shown on %s" % (socket, tty))


def resumed_host_running(pane_tty, session_id):
    """Whether the resumed host runs: its process on window 0's tty, or the host's registry
    entry for the session id naming a live process."""
    if host_cli_on(pane_tty) is not None:
        return True
    pid, _ = session_record(session_id)
    return bool(pid)


def cmd_home_release(argv):
    """Close the tab a moved orchestrator left, once its resumed session is proved running:
    run by a watcher of window 0, beside the resume. Guarded by the proof (the resumed host on
    window 0's tty, or in the host's registry), by the tab's own session id, read before the
    move, and by the process table: a tab with a host still on it, or whose session is
    another's by then, is left as it is."""
    p = argparse.ArgumentParser(prog="home-release", add_help=False)
    p.add_argument("--tty", default="")
    p.add_argument("--session-id", dest="session_id", default="")
    p.add_argument("--pane-tty", dest="pane_tty", default="")
    p.add_argument("--resumed", default="")
    args, _ = p.parse_known_args(argv)
    if not args.tty or not args.session_id or not args.pane_tty or not args.resumed:
        die("home-release: --tty, --session-id, --pane-tty and --resumed are required")
    if host_cli_on(args.tty) is not None:
        die("home-release: a host still runs on %s; the tab is left open" % args.tty)
    deadline = time.time() + SPAWN_TIMEOUT
    while not resumed_host_running(args.pane_tty, args.resumed):
        if time.time() >= deadline:
            die("home-release: the resumed session %s never showed on %s after %ds; the tab on "
                "%s is left open" % (args.resumed, args.pane_tty, SPAWN_TIMEOUT, args.tty))
        time.sleep(0.3)

    async def go(iterm2, connection):
        app = await iterm2.async_get_app(connection)
        _, _, sess = await find_tab(app, args.tty)
        if sess is None:
            return "gone"
        if sess.session_id != args.session_id:
            return "other"
        await sess.async_close(force=True)
        return "closed"
    said = run(go)
    if said == "other":
        die("home-release: the tab on %s is no longer the one the move left (%s); it is left "
            "open" % (args.tty, args.session_id))
    print("home-release: the tab on %s was %s" % (args.tty, "already closed" if said == "gone"
                                                  else "closed"))


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


def chain_holders():
    """Every chain entry's tab id, mapped to the tty of the chain file that holds it."""
    held = {}
    if not os.path.isdir(CHAINS_DIR):
        return held
    for name in sorted(os.listdir(CHAINS_DIR)):
        if name.endswith(".jsonl"):
            tty = "/dev/" + name[:-len(".jsonl")]
            for e in chain_read(tty):
                held.setdefault(e["tab_id"], tty)
    return held


def orphan_lines(listed):
    """One line per listed agent whose orchestrator has ended, saying whose it was.

    An orchestrator that ended before any successor took its chain leaves agents whose tabs
    no live session claims, and nothing on screen tells whose they are. `listed` is
    `(place, tty, stable id)` per row. The line holds no ` | `, so a reader of the rows (the
    stop gate's) skips it."""
    held, lines = chain_holders(), []
    live = live_host_ttys()
    if live is None:
        # An unreadable process table proves nothing: reading it as « nobody runs » named
        # every orchestrator ended.
        return lines
    for place, tty, stable in listed:
        holder = held.get(stable)
        if not holder:
            continue
        if holder not in live:
            lines.append("orphan: %s (%s) is an agent of the orchestrator on %s, which has "
                         "ended" % (tty, place, holder))
    return lines


async def list_rows(app):
    """One row per session, hidden panes included and marked. A pane behind a maximized
    sibling is what the host extension's review views make of an agent's tab; a listing
    that dropped it made a live agent unfindable and unclosable (§25).

    The caller's own row is marked `self`, read the way `--right-of self` reads it, so an
    orchestrator knows which tab is its own BEFORE it anchors, moves or closes anything —
    the reading a layout repair once went without (§38)."""
    own = self_tty() or ""
    lines, listed = [], []
    for wi, w in enumerate(app.windows, 1):
        for ti, t in enumerate(w.tabs, 1):
            visible = {s.session_id for s in t.sessions}
            for s in t.all_sessions:
                tty = await s.async_get_variable("tty")
                title = await s.async_get_variable("autoName") or ""
                lines.append(row_for(wi, ti, tty, title, session_name_on(tty),
                                     bool(own) and tty == own, s.session_id not in visible))
                listed.append(("w%d/t%d" % (wi, ti), tty, t.tab_id))
    lines += orphan_lines(listed)
    return lines


def cmd_list(_argv):
    chosen = terminal()
    for line in chosen.rows() or []:
        print(line)
    if chosen is not ITERM:
        # The tabs a home caller did not make as windows are still its to see: the
        # coordinator's, an auditor's. An app that cannot answer does not hide the windows.
        try:
            lines = ITERM.rows() or []
        except SystemExit:
            print("list: the iTerm2 tabs could not be listed; only the home session's windows "
                  "are shown", file=sys.stderr)
            return
        for line in lines:
            print(line)


def write_prompt_file(prompt, title):
    os.makedirs(PROMPTS_DIR, exist_ok=True)
    path = state_file_path("prompt", title, "txt")
    with open(path, "w") as fh:
        fh.write(prompt)
    return path


def title_role(title):
    """`Orch`, `Coord`, `Audit` or `Agent` when the title names one, else empty. A qualified
    auditor's name (« Audit neutre : <subject> ») is an auditor's too."""
    found = ROLE_PREFIX.match(title)
    if found:
        return found.group(1)
    return "Audit" if AUDIT_NAME_SHAPE.match(title) else ""


def default_removed(role):
    """The tools a session of this role is not given unless its spawn keeps them. Only an
    orchestrator and the coordinator keep the three that move an orchestrator."""
    return LEAN_REMOVED + (() if role in MOVE_ROLES else MOVE_TOOLS)


def removed_tools(title, keep=(), drop=()):
    """The default set for this title's role, less what the spawn keeps, plus what it drops;
    each name once, in the order they were first given."""
    names = [n for n in default_removed(title_role(title)) if n not in keep]
    for name in drop:
        if name not in names:
            names.append(name)
    return names


_plugin_dir_said = []


def caller_plugin_launch(plugin_set=False):
    """`(plugin_dirs, enabled_plugins)` of the calling host's own launch: each `--plugin-dir`
    it was started with, and the `enabledPlugins` entries of its `--settings`. A session run
    on a plugin directory is tested on it, and an agent it spawns would otherwise load the
    installed plugin, whose hooks write none of what the tested one writes. Empty for a caller
    that is not a registered host session or has no plugin directory, which leaves the launch
    as it always was. A launch that cannot be read is said once on stderr and also leaves it
    so: a spawn is never refused for it.

    `plugin_set` is an auditor's successor's: it keeps its predecessor's plugin set with or
    without a plugin directory, as it keeps its pair. An auditor the operator runs without
    the plugin stays neutral across its successions."""
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    pid, record = session_record(sid) if sid else (None, None)
    if not pid:
        return [], {}
    words = host_argv(pid)
    if not words:
        if not _plugin_dir_said:
            _plugin_dir_said.append(True)
            print("spawn: the launch of process %s cannot be read, so the agent does not "
                  "inherit its plugin directory" % pid, file=sys.stderr)
        return [], {}
    args = words[1:]
    cwd = record.get("cwd") or ""
    dirs, settings_words = [], []
    i = 0
    while i < len(args):
        option, eq, value = args[i].partition("=")
        i += 1
        if option not in ("--plugin-dir", "--settings"):
            continue
        if not eq:
            if i >= len(args):
                break
            value = args[i]
            i += 1
        if option == "--settings":
            settings_words.append(value)
        elif value:
            dirs.append(value if os.path.isabs(value) or not cwd
                        else os.path.normpath(os.path.join(cwd, value)))
    if not dirs and not plugin_set:
        return [], {}
    enabled = {}
    for word in settings_words:
        try:
            parsed = json.loads(word)
        except ValueError:
            try:
                with open(word) as fh:
                    parsed = json.load(fh)
            except (OSError, ValueError):
                continue
        plugins = parsed.get("enabledPlugins") if isinstance(parsed, dict) else None
        if isinstance(plugins, dict):
            enabled.update(plugins)
    return dirs, enabled


def host_cuts(role):
    """The settings that stop the host adding to a session what nobody reads there. An agent
    is read by its orchestrator alone, so it loses the away recap and the silent-turn
    reminder too; every other role is read by the operator, who keeps both, and only the
    token countdown goes (its figure is not the gate the module measures)."""
    env = {TOTAL_TOKENS_ENV: "off"}
    cuts = {}
    if role == "Agent":
        cuts["awaySummaryEnabled"] = False
        env[SILENT_TURN_ENV] = "0"
    cuts["env"] = env
    return cuts


def build_command(dir_, title, model, mode, prompt_file, remote_control="", mcp_file="",
                  account_connectors=False, gate_tokens=0, effort="", keep_tools=(),
                  drop_tools=(), keep_synced_skills=False, session=(), plugin_dirs=(),
                  caller_plugins=None, reports_to=""):
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
             # Marks this session as launcher-spawned: the module's push guard (hooks/guards.ts)
             # is active only where this is set, and the operator's own sessions never carry it.
             "export ORCHESTRATOR_SPAWNED=1",
             "printf '\\033]0;%%s\\007' %s" % shq(title),
             None]
    if title_role(title) == "Audit":
        # A marker the session carries in its own environment. The auditor's name is read
        # from the process table, which cannot give it back for a session launched without
        # one, and that session must still be known for an auditor.
        parts.insert(2, "export ORCHESTRATOR_AUDITOR=1")
    if reports_to:
        # The orchestrator the brief names, read by the hooks module's relay when no chain
        # names a live owner for this session's tty: a chain outlives its owner's tab, and an
        # orchestrator relaunched without --successor leaves its agents in a dead one.
        parts.insert(2, "export ORCHESTRATOR_REPORTS_TO=%s" % shq(reports_to))
    if not gate_tokens and title_role(title) == "Agent":
        gate_tokens = AGENT_GATE_TOKENS
    if gate_tokens:
        # The session's own context gate, read from the environment by the module's context
        # gate and its band. Exported when asked for, and for an agent by default: absent,
        # the module's own default holds.
        parts.insert(2, "export ORCHESTRATOR_CONTEXT_GATE_TOKENS=%d" % gate_tokens)
    cli = [shq(cli_path)]
    if model:
        cli += ["--model", shq(model)]
    # Right after the model, which it qualifies; none typed leaves the host's own default.
    if effort:
        cli += ["--effort", shq(effort)]
    # The plugin directories the caller runs on, ahead of the many-valued options below.
    for plugin_dir in plugin_dirs:
        cli += ["--plugin-dir", shq(plugin_dir)]
    # The lean tool set (§65). `--disallowedTools` takes several values like `--mcp-config`,
    # so whatever follows it is read as another tool name: it goes before another option and
    # never last, ahead of the strict flag and the server file so that pair stays closed by
    # `--permission-mode`.
    removed = removed_tools(title, keep_tools, drop_tools)
    if removed:
        cli += ["--disallowedTools"] + [shq(name) for name in removed]
    # The launch is strict by DEFAULT, and hands the session a configuration file of its
    # own when it has servers to load (§42). Strict alone would leave an agent with no
    # server of any scope — not the project's, but not the operator's or the account's
    # either, which is what the first answer to this section got wrong; the file puts back
    # exactly the ones the orchestrator chose. `--account-connectors` drops strict for ONE
    # chosen spawn, so the session also loads the account's own connectors — the ones
    # sessions the operator opens by hand already load, and which strict excludes from
    # every other spawn — while the chosen servers below still travel exactly as before.
    # The pair goes BEFORE --permission-mode: the host's --mcp-config takes several values,
    # so whatever follows it is read as another file, and the prompt placed there was read
    # as one.
    if not account_connectors:
        cli += ["--strict-mcp-config"]
    if mcp_file:
        cli += ["--mcp-config", shq(mcp_file)]
    cli += ["--permission-mode", shq(mode)]
    # The session an orchestrator's home server is named after: the one it resumes, or the id
    # a new one is given, so the server's name is known before the session starts.
    cli += [shq(word) for word in session]
    # An agent is driven by its orchestrator alone (§39): remote control comes up OFF for
    # everyone but a successor and an auditor, which the operator also drives from the
    # host's remote client (§52). The setting and the flag below are mutually exclusive —
    # only those two carry the flag, and they carry no such setting.
    settings = {}
    if not remote_control:
        settings["remoteControlAtStartup"] = False
    # Dropping strict reopens the project's own "enable these MCP servers?" dialog that
    # strict had made moot — a fresh session parked on it never reads its brief, and nobody
    # sits at that keyboard (§42's own reasoning). Pre-answered here, for this spawn only,
    # the way every launch pre-answered it before the catalogue existed.
    if account_connectors:
        settings["enableAllProjectMcpServers"] = True
    if not keep_synced_skills:
        settings[SYNCED_SKILLS_SETTING] = False
    # The caller's enabledPlugins, so the tested plugin stays the one that loads (or, for an
    # auditor's successor, the plugin set its predecessor ran on). Under the launcher's own
    # entries for the same plugin, and no other key of the caller's settings.
    if caller_plugins:
        settings["enabledPlugins"] = dict(caller_plugins, **settings.get("enabledPlugins", {}))
    settings.update(host_cuts(title_role(title)))
    cli += ["--settings", shq(json.dumps(settings, separators=(",", ":")))]
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
    # Only a successor and an auditor get it: the operator drives his orchestrators and
    # their auditors from the host's remote client as well as from the tab, and an agent is
    # driven by its orchestrator alone (§39, §52). A first instantiation is the operator's
    # own hand, and his launch line.
    if remote_control:
        cli += ["--remote-control", shq(remote_control)]
    parts[-1] = "exec " + " ".join(cli)
    return " && ".join(parts)


def write_launch_script(command, title, kind="launch"):
    """The launch goes to a FILE and the app is asked to run `<login shell> -l <file>`.

    The app executes what it is given as the session's program, splitting it into words
    itself: a compound command handed over raw is not run by any shell, the session dies
    the moment it is born, and the tty read a breath later belongs to nothing — observed
    as SESSION_NOT_FOUND on the first live spawn. Quoting the whole thing for that
    tokenizer is the same losing game the typed version played. A path has no quoting."""
    os.makedirs(PROMPTS_DIR, exist_ok=True)
    path = state_file_path(kind, title, "sh")
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


def tier_pair(tier, effort_flag, bound):
    """`(model, effort, source)` of an agent's tier: the model of the map's binding `bound`
    (what resolve_tier_pair answered for it), with the effort of the flag, else the
    binding's, else the plugin's shipped effort for the tier, else, for the deep tier, the
    calling orchestrator's own live effort, whose transcript the source then names."""
    model, effort = bound
    if effort_flag:
        return model, effort_flag, "flag"
    if not effort:
        effort = SHIPPED_TIER_EFFORTS.get(tier, "")
    if not effort:
        _, effort, path = own_pair("the deep tier's agent")
        return model, effort, "tier %s, effort from transcript %s" % (tier, path)
    return model, effort, "tier %s" % tier


def pair_of_launch(args, auditor_successor, pair_from=""):
    """`(model, effort, source)` the launch types, for every way in (decision 3). An empty
    model and effort is the host's default, typed as nothing, and only an opening or a wake
    with nothing to read gets it."""
    succession = (args.successor or auditor_successor or args.auditor
                  or args.coordinator_successor or args.inherit)
    if succession:
        # A succession of any role runs on its caller's live pair, with or without the flag:
        # the successor of an orchestrator or of an auditor, an auditor, the coordinator's
        # successor, and an agent spawned with --inherit-model.
        model, effort, path = args.caller_pair or own_pair(
            "a successor, an auditor or an inheriting spawn")
        return model, effort, "transcript %s" % path
    if args.wake:
        if args.resume:
            try:
                model, effort, path = read_pair(args.resume)
                return model, effort, "transcript %s" % path
            except PairUnreadable as exc:
                print("spawn: the resumed session's pair cannot be read (%s)" % exc,
                      file=sys.stderr)
        if args.model:
            return args.model, args.effort, "record"
        return "", "", "host default"
    if args.tier:
        return tier_pair(args.tier, args.effort, args.tier_bound)
    if args.model:
        if not args.effort:
            die("spawn: refused: --model needs --effort: an agent's effort is the "
                "orchestrator's to name")
        return args.model, args.effort, pair_from or "flag"
    if args.open_:
        return "", "", "host default"
    die("spawn: refused: an agent needs --tier or --model (with --effort): an agent's model "
        "and effort are its orchestrator's to name")


def cmd_spawn(argv, pair_from=""):
    """`pair_from` is a rotation's: the source of the model and effort it passes on as flags,
    read on the rotated agent's transcript, so the launch says where they came from."""
    p = argparse.ArgumentParser(prog="spawn", add_help=False)
    p.add_argument("--dir")
    p.add_argument("--model", default="")
    p.add_argument("--tier", default="")
    p.add_argument("--effort", default="")
    p.add_argument("--inherit-model", dest="inherit", action="store_true")
    p.add_argument("--permission-mode", dest="mode", default="auto")
    p.add_argument("--title", default="")
    p.add_argument("--title-free", dest="title_free", action="store_true", default=False)
    p.add_argument("--no-remote-control", dest="remote_control", action="store_false", default=True)
    p.add_argument("--prompt", default="")
    p.add_argument("--prompt-file", dest="prompt_file", default="")
    p.add_argument("--brief", default="")
    p.add_argument("--orchestrator", default="")
    p.add_argument("--left-of", dest="left_of", default="")
    p.add_argument("--right-of", dest="right_of", default="")
    p.add_argument("--no-verify", dest="verify", action="store_false", default=True)
    p.add_argument("--trust", action="store_true", default=False)
    p.add_argument("--successor", action="store_true", default=False)
    p.add_argument("--auditor", action="store_true", default=False)
    p.add_argument("--coordinator-successor", dest="coordinator_successor",
                    action="store_true", default=False)
    p.add_argument("--resident", action="store_true", default=False)
    p.add_argument("--wake", action="store_true", default=False)
    p.add_argument("--open", dest="open_", action="store_true", default=False)
    p.add_argument("--resume", default="")
    p.add_argument("--mcp", action="append", default=[])
    p.add_argument("--account-connectors", dest="account_connectors",
                    action="store_true", default=False)
    p.add_argument("--gate-tokens", dest="gate_tokens", default=None)
    p.add_argument("--keep-tool", dest="keep_tool", action="append", default=[])
    p.add_argument("--drop-tool", dest="drop_tool", action="append", default=[])
    p.add_argument("--keep-synced-skills", dest="keep_synced_skills", action="store_true",
                   default=False)
    args, unknown = p.parse_known_args(argv)
    if unknown:
        die("spawn: unknown option %s" % unknown[0])
    # A name is read without its surrounding whitespace: padded, it would match no tool of the
    # host and be kept or dropped as another name, without a word.
    args.keep_tool = [name.strip() for name in args.keep_tool]
    args.drop_tool = [name.strip() for name in args.drop_tool]
    # First of the refusals, before anything is read or made: a name that is empty would be
    # passed to the host as an empty argument, and the same name on both sides has no answer.
    for flag, names in (("--keep-tool", args.keep_tool), ("--drop-tool", args.drop_tool)):
        if any(not name for name in names):
            die("spawn: refused: %s needs a tool name, and got an empty one" % flag)
    both = [name for name in args.keep_tool if name in args.drop_tool]
    if both:
        die("spawn: refused: '%s' is given to both --keep-tool and --drop-tool" % both[0])
    gate_tokens = 0
    if args.gate_tokens is not None:
        if not re.fullmatch(r"[0-9]+", args.gate_tokens) or int(args.gate_tokens) < 1:
            die("spawn: --gate-tokens must be a positive integer of tokens, got '%s'"
                % args.gate_tokens)
        gate_tokens = int(args.gate_tokens)
    if not args.dir:
        die("spawn: --dir is required")
    if args.left_of and args.right_of:
        die("spawn: --left-of and --right-of are mutually exclusive")
    if args.resident and (args.successor or args.auditor or args.coordinator_successor):
        die("spawn: refused: --resident marks an agent of your chain; a successor, an auditor "
            "or a coordinator's successor is written into no chain as an agent")
    if args.coordinator_successor:
        # A coordinator's successor is placed, named, modelled and reached ONE way: at the
        # first place of the caller's window, "Coord : <subject>", the caller's model, remote
        # control on. Each of these would quietly replace one of those terms with the
        # launcher's default, so each is refused rather than obeyed; the placement is its own,
        # so it takes no anchor either. Checked BEFORE the auditor's own block, so a caller
        # naming both flags reads which one was theirs to give up.
        for flag, given in (("--successor", args.successor), ("--auditor", args.auditor),
                            ("--left-of", args.left_of), ("--right-of", args.right_of),
                            ("--title-free", args.title_free), ("--tier", args.tier),
                            ("--model", args.model), ("--effort", args.effort),
                            ("--no-remote-control", not args.remote_control)):
            if given:
                die("spawn: refused: %s is not a coordinator-successor's: it lands at the "
                    "first place of your window, reads \"Coord : <subject>\", runs on your "
                    "model and effort and comes up under remote control" % flag)
        if not args.title:
            die('spawn: refused: --coordinator-successor needs --title "Coord : <subject>"')
        if not COORD_TITLE_SHAPE.match(args.title):
            die("spawn: refused: the coordinator's title reads \"Coord : <subject>\", the "
                "subject at most 25 characters and neither starting nor ending with a space, "
                "got '%s'" % args.title)
    elif args.title.startswith(COORD_ROLE):
        die("spawn: refused: a \"Coord :\" title is the coordinator's; spawn it with "
            "--coordinator-successor, which places it at the first place of your window, "
            "keeps it out of every chain and brings it up under remote control on your model")
    if args.wake:
        # A paused orchestrator relaunched on the operator's word: under its own recorded
        # name, on its recorded model and effort, immediately right of its caller, in no
        # chain, under remote control like any orchestrator. It succeeds a session already
        # gone, so it takes no successor's chain and derives no name from its caller.
        for flag, given in (("--successor", args.successor), ("--auditor", args.auditor),
                            ("--coordinator-successor", args.coordinator_successor),
                            ("--left-of", args.left_of), ("--right-of", args.right_of),
                            ("--title-free", args.title_free), ("--tier", args.tier),
                            ("--inherit-model", args.inherit), ("--resident", args.resident),
                            ("--no-remote-control", not args.remote_control)):
            if given:
                die("spawn: refused: %s is not a wake's: a woken orchestrator runs under its "
                    "recorded name, model and effort, lands immediately right of you, joins "
                    "no chain and comes up under remote control" % flag)
        if (not args.title.startswith("Orch : ") or not TITLE_SHAPE.match(args.title)
                or re.search(r" \[[0-9A-Za-z]+\]\Z", args.title)):
            die('spawn: refused: --wake needs the recorded name, --title "Orch : <subject>" '
                "without its reference, got '%s'" % args.title)
        # A record is a model with its effort, or nothing: a model alone would start the
        # orchestrator at an effort nobody chose. With nothing, the resumed transcript's pair
        # or the host's default applies, and nothing is asked of the operator at a wake.
        if bool(args.model) != bool(args.effort):
            die("spawn: refused: --wake takes the recorded model with its recorded effort, "
                "--model <id> --effort <level>, or neither: a wake never guesses the effort, "
                "nor the model, its orchestrator ran on")
    if args.resume and not args.wake:
        die("spawn: refused: --resume is a wake's: it names the session a paused orchestrator "
            "resumes")
    if args.resume and not re.fullmatch(r"[0-9A-Za-z-]+", args.resume):
        die("spawn: refused: --resume needs a session id, letters, digits and hyphens, got '%s'"
            % args.resume)
    if (args.open_ or args.wake) and not DRY_RUN and (os.environ.get("ORCHESTRATOR_SELF_TTY")
                                                      or os.environ.get("ORCHESTRATOR_PS_TABLE")):
        # --open and --wake read their caller from the real process table: the two stand-ins
        # the suite sets would let any session name itself an orchestrator or the coordinator.
        die("spawn: refused: %s reads its caller from the real process table, and "
            "ORCHESTRATOR_SELF_TTY or ORCHESTRATOR_PS_TABLE would stand in for it: both "
            "are for tests and dry runs" % ("--open" if args.open_ else "--wake"))
    if args.open_:
        # A new orchestrator opened on the operator's order, by the coordinator or by an
        # orchestrator the coordinator relayed that order to on another machine: under its own
        # name, right of its caller, in no chain, under remote control like any orchestrator.
        # Only a coordinator or an orchestrator opens one: an agent never does. Its pair is
        # the one the order names, or the host's default: a tier, or the caller's own pair,
        # would be a pair nobody ordered.
        for flag, given in (("--successor", args.successor), ("--auditor", args.auditor),
                            ("--coordinator-successor", args.coordinator_successor),
                            ("--wake", args.wake), ("--tier", args.tier),
                            ("--inherit-model", args.inherit), ("--left-of", args.left_of),
                            ("--right-of", args.right_of), ("--title-free", args.title_free),
                            ("--resident", args.resident), ("--brief", args.brief),
                            ("--orchestrator", args.orchestrator),
                            ("--no-remote-control", not args.remote_control)):
            if given:
                die("spawn: refused: %s is not an opening's: an opened orchestrator runs under "
                    "its own name, on the model and the effort its order names or the host's "
                    "default, lands immediately right of you, joins no chain, reads its "
                    "brief from its prompt and comes up under remote control" % flag)
        if bool(args.model) != bool(args.effort):
            # The operator's order names a model and an effort, or neither and the host's
            # default for the session applies: half a pair is a guess at the other half.
            die("spawn: refused: an opening types the model and the effort the order names, "
                "--model <id> --effort <level>, or neither (the host's default applies)")
        if (not args.title.startswith("Orch : ") or not TITLE_SHAPE.match(args.title)
                or re.search(r" \[[0-9A-Za-z]+\]\Z", args.title)):
            die('spawn: refused: --open needs the new orchestrator\'s name, --title '
                '"Orch : <subject>" without a reference, got \'%s\'' % args.title)
        caller = opener_name()
        if not (caller.startswith("Orch : ") or caller.startswith(COORD_ROLE)):
            die("spawn: refused: --open is a coordinator's or an orchestrator's, and this "
                "session reads '%s': an agent never opens an orchestrator"
                % (caller[:40] or "no name"))
    if args.auditor:
        # An auditor is placed, named, modelled and reached ONE way (§52): immediately left
        # of its caller, `Audit : <subject>`, the caller's model, remote control on. Each of
        # these would quietly replace one of those terms with the launcher's default, so
        # each is refused rather than obeyed.
        for flag, given in (("--successor", args.successor), ("--right-of", args.right_of),
                            ("--left-of", args.left_of), ("--title-free", args.title_free),
                            ("--tier", args.tier), ("--model", args.model),
                            ("--effort", args.effort),
                            ("--no-remote-control", not args.remote_control)):
            if given:
                die("spawn: refused: %s is not an auditor's: an auditor lands immediately "
                    "left of its caller, reads \"Audit : <subject>\", runs on the caller's "
                    "model and effort and comes up under remote control" % flag)
        if not args.title:
            die('spawn: refused: --auditor needs --title "Audit : <subject>"')
        if not AUDIT_TITLE_SHAPE.match(args.title):
            die("spawn: refused: an auditor's title reads \"Audit : <subject>\", the subject "
                "at most 25 characters and neither starting nor ending with a space, got '%s'"
                % args.title)
    elif args.title.startswith(AUDIT_ROLE) or AUDIT_NAME_SHAPE.match(args.title):
        die("spawn: refused: an audit title is an auditor's; spawn it with --auditor, which "
            "places it beside you, keeps it out of every chain and brings it up under remote "
            "control on your model")
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
    if args.title.startswith("Orch :") and not (args.successor or args.open_ or args.wake):
        # A plain spawn under an orchestrator's name landed at the window's end and was
        # written into its caller's chain as an agent: an auditor's relaunch of an
        # orchestrator became the auditor's agent. An orchestrator tab has three ways in.
        die("spawn: refused: an orchestrator's tab is opened only as a successor "
            "(--successor), an opened orchestrator (--open) or a woken one (--wake)")
    if args.title.startswith("Orch :") and not args.open_:
        # --open already refuses every caller but a coordinator or an orchestrator. An
        # auditor's one successor is its own audit session, `--successor` without a title.
        # Read on the session's role, not on the `Audit :` prefix: an auditor named
        # otherwise ("Audit neutre : ...") carries no such prefix and still is no orchestrator.
        # An orchestrator, the coordinator and a plain agent are not read as auditors here.
        caller = session_name_on(self_tty() or "")
        if caller == UNREADABLE_NAME or (caller and (caller.startswith("Orch : ")
                                                     or caller.startswith(COORD_ROLE)
                                                     or title_role(caller) == "Agent"
                                                     or registered_coord_on(self_tty() or ""))):
            caller = None
        if not caller and os.environ.get("ORCHESTRATOR_AUDITOR") == "1":
            caller = "unnamed"
        if caller:
            die("spawn: refused: this session is not an orchestrator's or a coordinator's "
                "('%s'): it opens no orchestrator tab with --wake or an Orch title, and "
                "--open is a coordinator's or an orchestrator's; its only successor is its "
                "own audit session, --successor without --title" % caller[:40])
    if args.wake:
        # --open's caller rule, after the auditor's own refusal above has had its say.
        caller = opener_name()
        if not (caller.startswith("Orch : ") or caller.startswith(COORD_ROLE)):
            die("spawn: refused: --wake is a coordinator's or an orchestrator's, and this "
                "session reads '%s': an agent never wakes an orchestrator"
                % (caller[:40] or "no name"))
    if not os.path.isdir(args.dir):
        die("spawn: directory not found: %s" % args.dir)
    if args.prompt and args.prompt_file:
        die("spawn: --prompt and --prompt-file are exclusive")
    if args.brief and (args.prompt or args.prompt_file):
        die("spawn: --brief and --prompt/--prompt-file are mutually exclusive")
    if args.brief and not args.orchestrator:
        die('spawn: --brief without --orchestrator is refused: pass --orchestrator '
            '"<name [ref]>"')
    brief_prompt = ""
    lint_verdict = ""
    if args.brief:
        # Before any tab exists: a brief is this plugin's whole specification act, and the
        # two defects that reached a live agent before anything read the file are exactly
        # what the lint catches. A finding no longer refuses the spawn — it is printed on
        # stderr as a warning and the launch goes on; a project's own method may still make
        # it a refusal.
        if not os.path.isfile(args.brief):
            die("spawn: brief not found: %s" % args.brief)
        brief_abs = os.path.abspath(args.brief)
        lint_sh = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                                "orchestrator", "scripts", "brief-lint.sh")
        lint = subprocess.run(["bash", lint_sh, brief_abs], stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT)
        lint_verdict = lint.stdout.decode("utf-8", "replace").strip()
        if lint.returncode != 0:
            sys.stderr.write("spawn: warning: brief-lint found findings in %s\n" % brief_abs)
            sys.stderr.write(lint_verdict + "\n")
        brief_prompt = ("Read and execute %s. Your orchestrator is %s."
                        % (brief_abs, args.orchestrator))
        if gate_tokens:
            # So a brief's "past 300,000" is read against the session's real gate. The brief
            # itself is not rewritten. The gate is the smaller of the option and the window's
            # percentage gate: the line says so, or a small-window session would be told a
            # gate that never trips. The literal breaks before its percent sign: the suite's
            # sweep for a gate stated without its token half reads source lines, and this one
            # states both halves.
            brief_prompt += (" Your context gate is the smaller of %d tokens and 80"
                             " %% of the reported window." % gate_tokens)
    if not (brief_prompt or args.prompt or args.prompt_file):
        # The host writes a session's transcript only once it has a first prompt (§29): a
        # promptless launch has no transcript to read a mode on, so verify_mode's own
        # refusal always fires, tab and all, for a launch that could never have passed it.
        # Refused here instead, before any tab is made, and --no-verify does not lift it —
        # a session nobody can read is not one that skipping the read makes readable.
        die("spawn: refused: no startup prompt: the host writes no transcript before a "
            "first prompt, so the session's mode cannot be read; give the brief with "
            "--prompt or --prompt-file")
    if args.tier and args.model:
        die("spawn: --tier and --model are mutually exclusive")
    if args.inherit and (args.tier or args.model):
        die("spawn: --inherit-model is exclusive with --tier and --model")
    if args.inherit and args.effort:
        die("spawn: --inherit-model reads the caller's effort with its model; drop --effort")
    if args.effort and args.effort not in EFFORTS:
        die("spawn: unknown effort: %s (expected %s)" % (args.effort, EFFORT_LIST))
    # The tier is resolved before the anchor and the title are checked, as it always was: a
    # tier that does not resolve is refused first, and carrying the pair must not change
    # which refusal comes first. Read once, so a map's warning is said once.
    args.tier_bound = resolve_tier_pair(args.tier) if args.tier else None
    # So is the caller's pair, for the launches that always read it there: an inheriting
    # agent, an auditor and the coordinator's successor.
    args.caller_pair = (own_pair("a successor, an auditor or an inheriting spawn")
                        if args.inherit or args.auditor or args.coordinator_successor
                        else None)
    # The anchor first, before a prompt file is written or a trust record changed: an
    # anchor that is not there is a refusal, and a refusal must leave nothing behind.
    side = "right" if args.right_of else "left"
    anchor = args.right_of or args.left_of
    own = self_tty() or ""
    # The title, before a prompt file is written or a trust record changed: it is the
    # session's name, and a refusal on it must leave nothing behind either.
    title = args.title
    auditor_successor = False
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
        if AUDIT_NAME_SHAPE.match(title):
            # An auditor kept on past its report succeeds at its gate (§9.4): its successor
            # carries its name, as an orchestrator's does. Only a DERIVED audit title gets
            # here; a typed one was refused above, so `Audit :` is still no one's to claim.
            # The qualified form (« Audit neutre : <subject> ») is an auditor's name too.
            auditor_successor = True
        elif not TITLE_SHAPE.match(title):
            # The derived name answers to the same shape as a typed one: a caller named
            # under an older convention derives nothing, and neither does one whose name
            # is a whole launch line. Only the first forty characters are quoted back —
            # the rest of a launch line has no business filling a terminal.
            die("spawn: refused: the caller's session name '%s' does not read "
                '"Orch : <subject>"; pass --title "Orch : <subject>"' % title[:40])
    elif not args.auditor and not args.coordinator_successor and not TITLE_SHAPE.match(title):
        die("spawn: refused: a title reads \"Orch : <subject>\" or \"Agent : <subject>\", "
            "the subject at most 25 characters and neither starting nor ending with a "
            "space, got '%s' (pass --title-free for a tab named otherwise)" % title)
    if args.successor:
        # A successor is not an agent: immediately right of this session, the chain
        # ignored, and it takes the chain with it once its session can be read (§34).
        side, anchor = "right", "self"
    elif args.auditor:
        # An auditor is placed immediately LEFT of this session, the chain ignored, and
        # takes nothing with it (§52) — the operator's layout: the auditor beside its
        # orchestrator on the left, agents and successor on the right.
        side, anchor = "left", "self"
    elif args.wake or args.open_:
        side, anchor = "right", "self"
    elif args.coordinator_successor:
        # The coordinator's successor is placed at the FIRST place of the caller's window,
        # not immediately beside it: unlike an auditor or a successor, no other tab anchors
        # it, so the sentinel below is resolved against the caller's own window, never
        # against a neighbour tab.
        side, anchor = "left", "leftmost"
    effect = chain_effect(args.successor, args.auditor, args.coordinator_successor,
                          auditor_successor, args.wake, args.open_)
    defaulted = effect == "append" and not anchor
    if defaulted:
        # An agent given no place sits in its orchestrator's group, to its right: unanchored,
        # it landed at the window's end, beside whoever sat there, and was still written into
        # the caller's chain.
        side, anchor = "right", "self"
    # Chosen once, and only for a launch that reaches a terminal: a dry run asks none. Only an
    # agent joins its caller's chain and only a successor takes it, and only those two may be
    # windows of a home session.
    term = None if DRY_RUN else terminal(agent=effect in ("append", "transfer"))
    if auditor_successor:
        for flag, given in (("--tier", args.tier), ("--model", args.model),
                            ("--effort", args.effort),
                            ("--no-remote-control", not args.remote_control)):
            if given:
                die("spawn: refused: %s is not an auditor's successor's: it runs on your "
                    "model and effort and comes up under remote control under your name" % flag)
    if args.successor:
        # A succession of any role runs on its caller's live pair (decision 3): a tier, a
        # model or an effort beside it would replace the predecessor's with another.
        for flag, given in (("--tier", args.tier), ("--model", args.model),
                            ("--effort", args.effort)):
            if given:
                die("spawn: refused: %s is not a successor's: a successor runs on your live "
                    "model and effort, read on your transcript" % flag)
    model, effort, pair_source = pair_of_launch(args, auditor_successor, pair_from)
    if anchor == "self" and defaulted and not own and not DRY_RUN:
        # The default must not turn a spawn that worked into a refusal: a caller with no
        # readable tty (a plain shell) gets the old placement, and is told why. An explicit
        # --right-of self keeps dying below.
        print("spawn: this session's own tty cannot be resolved, so the new tab cannot be "
              "placed right of it; it lands at the window's end.", file=sys.stderr)
        anchor = ""
    if anchor == "self":
        if not own and not DRY_RUN:
            die("spawn: --right-of self: cannot resolve this session's own tty")
        anchor = own or "self"
        if side == "right" and own and effect == "append":
            # After the orchestrator's LAST agent, not immediately after the orchestrator:
            # orchestrator, agent 1, agent 2, … in launch order.
            if DRY_RUN:
                chain = chain_owned(chain_read(own), SELF_ID)
                anchor = chain[-1]["tty"] if chain else "self"
            else:
                anchor, kept = term.chain_state(own)
                anchor = anchor or own
                if kept is not None:
                    chain_write(own, kept)
    elif anchor == "leftmost":
        if not own and not DRY_RUN:
            die("spawn: --coordinator-successor: cannot resolve this session's own tty")
        if not DRY_RUN:
            if not term.find(own):
                # Same reading as anchor_after_probe's for "self": the caller is running
                # outside the app (a multiplexer, a plain shell), so there is no window to
                # place a first tab of — the new tab lands where the app puts it instead.
                print("spawn: this session is not a tab of the app's (%s), so the new tab "
                      "cannot be placed at the first place of your window; it lands where "
                      "the app puts it." % own, file=sys.stderr)
                anchor = ""
    if (args.wake or args.open_) and home_no_tab():
        # No tab shows the server: there is no place to probe, and the app is never asked.
        anchor = ""
    if anchor and anchor not in ("self", "leftmost") and not DRY_RUN:
        anchor = anchor_after_probe(term.can_place(anchor, side), anchor, own)
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
    # A dry run touches nothing: it names the file a real spawn would write, and writes none.
    mcp_file = ""
    if servers:
        mcp_file = (state_file_path("mcp", title, "json") if DRY_RUN
                    else write_mcp_file(servers, catalogue, title))

    prompt_file = args.prompt_file
    if prompt_file and not os.path.isfile(prompt_file):
        die("spawn: prompt file not found: %s" % prompt_file)
    prompt = brief_prompt or args.prompt
    if prompt:
        prompt_file = (state_file_path("prompt", title, "txt") if DRY_RUN
                       else write_prompt_file(prompt, title))

    remote_control = title if ((args.successor and args.remote_control) or args.auditor
                                or args.coordinator_successor or args.wake
                                or args.open_) else ""
    # A woken or opened orchestrator starts in window 0 of a home session of its own, shown by
    # a tab right of the caller's: its server is named after its session, the one it resumes
    # or the id it is given.
    home = args.wake or args.open_
    session_words, socket = (), ""
    if home:
        if args.resume:
            session_words = ("--resume", args.resume)
        else:
            new_id = (os.environ.get("ORCHESTRATOR_NEW_SESSION_ID")
                      or ("<new-session-id>" if DRY_RUN else str(uuid.uuid4())))
            session_words = ("--session-id", new_id)
        socket = home_socket(session_words[1]) if not session_words[1].startswith("<") \
            else HOME_SOCKET_PREFIX + "<new>"
    plugin_dirs, caller_plugins = caller_plugin_launch(auditor_successor)
    launch = build_command(args.dir, title, model, args.mode, prompt_file, remote_control,
                           mcp_file, args.account_connectors, gate_tokens, effort,
                           args.keep_tool, args.drop_tool, args.keep_synced_skills,
                           session_words, plugin_dirs, caller_plugins, args.orchestrator)

    if DRY_RUN:
        print("launch=%s" % launch)
        print("effort=%s" % (effort or "none"))
        print("pair_source=%s" % pair_source)
        print("prompt_file=%s" % prompt_file)
        if args.brief:
            print("prompt=%s" % brief_prompt)
            print("lint=%s" % lint_verdict)
        print("self=%s" % own)
        print("anchor=%s" % ("self" if anchor == own else anchor))
        print("side=%s" % side)
        print("trust=%s" % trust_state)
        print("successor=%s" % ("yes" if args.successor else "no"))
        print("auditor=%s" % ("yes" if args.auditor else "no"))
        print("coordinator_successor=%s" % ("yes" if args.coordinator_successor else "no"))
        print("wake=%s" % ("yes" if args.wake else "no"))
        print("open=%s" % ("yes" if args.open_ else "no"))
        print("chain=%s" % effect)
        if effect != "none" and tmux_owner():
            print("chain_owner=%s" % tmux_owner())
        print("resident=%s" % ("yes" if args.resident else "no"))
        print("name=%s" % title)
        print("title_free=%s" % ("yes" if args.title_free else "no"))
        print("mcp=%s" % (",".join(servers) or "none"))
        print("mcp_file=%s" % (mcp_file or "none"))
        print("account_connectors=%s" % ("yes" if args.account_connectors else "no"))
        print("synced_skills=%s" % ("kept" if args.keep_synced_skills else "removed"))
        print("tools_removed=%s" % (",".join(removed_tools(title, args.keep_tool,
                                                           args.drop_tool)) or "none"))
        print("remote_control=%s" % ("yes" if remote_control else "no"))
        print("mode_check=skipped")
        print("program=%s -l <launch-file>" % LOGIN_SHELL)
        if home:
            print("home_server=%s" % socket)
            print("home_conf=%s" % plugin_path(HOME_CONF))
            print("home_window0=%s" % title)
            print("home_tab=%s" % ("right of %s" % ("self" if anchor == own else anchor)
                                   if anchor else "where the app puts it"))
        return

    script = write_launch_script(launch, title)
    command = "%s -l %s" % (LOGIN_SHELL, script)
    print("spawn: model %s, effort %s, from %s" % (model or "the host's default",
                                                    effort or "the host's default", pair_source),
          file=sys.stderr)

    made = {"terminal": term}
    if anchor == "leftmost":
        place = Place("first", own, side, args.auditor)
    elif anchor:
        place = Place("beside", anchor, side, args.auditor)
    else:
        place = Place("anywhere", "", side, args.auditor)

    # Before the tab exists, so no transcript older than this launch can be taken for its.
    launch_epoch = time.time()
    _, resumed_from = transcript_of(args.resume) if args.resume else ("", 0)
    if home:
        # The host runs in window 0 and the tab shows the server: what is verified is window
        # 0's tty, and a refusal ends the server with the tab.
        pane_tty = make_home(socket, title, args.dir, command, "spawn")
        if home_no_tab():
            made = {"terminal": NO_TAB, "home": socket, "tty": pane_tty}
            print("spawn: home server %s, window 0 on %s, no tab: attach with %s -L %s attach"
                  % (socket, pane_tty, TMUX_BIN, socket), file=sys.stderr)
        else:
            tab_tty, made = open_home_tab(socket, title, place.anchor, "spawn")
            made.update(home=socket, tty=pane_tty)
            print("spawn: home server %s, window 0 on %s, shown in the tab on %s"
                  % (socket, pane_tty, tab_tty), file=sys.stderr)
        new_tty, tab_id = pane_tty, ""
    else:
        # The stable id is written into the chain only once the session is verified running:
        # a spawn that dies unverified must leave the chain as it found it, and a successor
        # that never started must not take the predecessor's agents.
        new_tty, tab_id = term.create(command, title, place,
                                      effect if own and effect != "none" else "", made)
    if made.get("error"):
        refuse_made(made, "spawn: the tab was made, then the terminal failed: %s"
                    % made["error"])
    if not new_tty:
        refuse_made(made, "spawn: the terminal returned no tty for the new tab")
    made.setdefault("tty", new_tty)

    # Before the verification below, which may wait or die: an auditor's place is settled as
    # soon as its tab exists, and said on stdout, where the orchestrator reads the launch.
    misplaced = 0
    if args.auditor:
        line, misplaced = repair_auditor_place(new_tty, own, term)
        if line:
            print(line)

    if args.verify:
        waited = 0
        pid = None
        while waited < SPAWN_TIMEOUT:
            pid = cli_pid_on_tty(new_tty)
            if pid:
                break
            time.sleep(1)
            waited += 1
        if pid:
            print("spawn: %s running on %s (pid %s)" % (HOST_CLI, new_tty, pid), file=sys.stderr)
        else:
            # The process table is one reading of « it started », not the only one: a session
            # that wrote its transcript in the launch directory since the launch has started,
            # whatever its process line says. Declaring it dead there closed a working agent.
            transcript = find_transcript(args.dir, launch_epoch)
            if not transcript:
                refuse_made(made, "spawn: %s never started on %s after %ss"
                            % (HOST_CLI, new_tty, SPAWN_TIMEOUT))
            print("spawn: no process on %s matched %s, but the session wrote %s since the "
                  "launch: it started" % (new_tty, HOST_CLI, transcript), file=sys.stderr)
        # « The host CLI runs on the tty » is not « the session is launched »: a session
        # that runs and waits for a click is not. The mode asked for is carried on the
        # process line and honoured for some models and not others, so the mode the session
        # actually came up in is read on its own transcript (§43).
        if args.resume:
            print(verify_resumed(args.resume, resumed_from, args.mode, model, made),
                  file=sys.stderr)
        else:
            print(verify_mode(args.dir, launch_epoch, args.mode, model, made), file=sys.stderr)
    apply_chain_plan(term, own, new_tty, tab_id, effect, args.resident)
    print(new_tty)
    if misplaced:
        sys.exit(misplaced)


def cmd_screen(argv):
    """What a tab is showing, right now.

    An agent that has gone quiet is inspected, not waited for — and inspecting it
    means reading what it is stopped on. The typed-command era read this through a
    scripting bridge; dropping that bridge dropped the reading with it, and the round that
    followed spent its sessions parked on a question nobody could see."""
    p = argparse.ArgumentParser(prog="screen", add_help=False)
    p.add_argument("--tty", dest="tty")
    p.add_argument("--lines", type=int, default=40)
    args, _ = p.parse_known_args(argv)
    if not args.tty:
        die("screen: --tty is required")

    for line in terminal_for(args.tty).screen(args.tty, args.lines) or []:
        print(line)


def cmd_verify(argv):
    p = argparse.ArgumentParser(prog="verify", add_help=False)
    p.add_argument("--tty", dest="tty")
    p.add_argument("--pid", dest="pid", type=int)
    args, _ = p.parse_known_args(argv)
    if not args.tty:
        die("verify: --tty is required")
    # A home session's tab carries only the tmux client: its host runs in window 0 of the
    # server that client shows, so that is where the host is read.
    host_tty = args.tty
    socket = home_of_tab(args.tty)
    if socket:
        panes, _ = home_panes(socket)
        host_tty = next((tty for index, tty in panes or [] if index == "0"), args.tty)
    every = host_clis_on(host_tty)
    # With --pid, only that process counts, whichever host CLI of the tty it is: another one
    # on a reused tty is « not running ».
    if args.pid is None:
        pid = every[0] if every else None
    else:
        pid = str(args.pid) if str(args.pid) in every else None
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
    """Close the session a spawn just made, by its own id; True only when it was closed.

    A refusal after the tab exists must leave no tab: an agent nobody can use, in a window
    the operator reads, is worse than a spawn that failed. The close goes through the
    terminal that made it, and any chain entry naming the session goes with it."""
    closed = (made.get("terminal") or terminal()).close_made(made)
    if made.get("home"):
        # The home server goes with its tab: every window of it, the session in window 0.
        watched = made.get("terminal") is not NO_TAB
        ended = kill_watched_home(made["home"]) if watched else kill_home(made["home"])
        if ended and watched:
            trace_home(made["home"], "server", "spawn-failed", made.get("tty"))
        closed = ended and closed
    if closed and made.get("tab_id"):
        chain_drop_tab(made["tab_id"])
    return closed


def apply_chain_plan(term, own, new, tab_id, effect, resident):
    """Write what a verified spawn does to the chain (§34): an agent appended to its
    caller's, or a successor handed the caller's agents and the entry naming the caller's tab.

    Called only once the session is verified running, or at once under --no-verify. The
    stable id is the one `create` returned, and the owners are asked of the terminal that
    made the session: an id it could not name writes nothing, the terminal having said why. A
    caller the terminal has no owner for writes nothing either: an empty owner reads every
    entry of a chain file, a recycled tty's strangers included, and a transfer would hand
    them all over."""
    if not own or effect == "none" or not tab_id:
        return
    own_owner = term.owner(own)
    if not own_owner:
        print("spawn: this session is not a tab of the app's (%s), so no session id names "
              "its chain entries; the chain was not updated (the %s was skipped)."
              % (own, effect), file=sys.stderr)
        return
    if effect == "append":
        chain_append(own, tab_id, new, own_owner, resident)
        return
    new_owner, _ = term.identity(new, fresh=True)
    if not new_owner:
        # A gate that cannot measure lets the launch through and says so.
        print("spawn: the successor's session on %s could not be read, so the chain "
              "stays with %s; place its next agent with --right-of <last agent tty>."
              % (new, own), file=sys.stderr)
        return
    n = chain_transfer(own, own_owner, new, new_owner)
    print("spawn: chain of %d agent(s) handed to the successor on %s" % (n, new),
          file=sys.stderr)
    # The caller's own entry in its orchestrator's chain follows the successor.
    _, own_tab_id = term.identity(own)
    if not own_tab_id:
        print("spawn: your own tab on %s could not be read, so no chain entry "
              "naming it was re-pointed to the successor." % own, file=sys.stderr)
        return
    repointed = chain_repoint_tab(own_tab_id, tab_id, new)
    if repointed:
        print("spawn: the entry naming your tab in %d chain(s) now names the "
              "successor on %s" % (repointed, new), file=sys.stderr)


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
    return name


def close_note(tty, was_running):
    """What the close's proof is worth, or "" when it is worth what it says.

    `wait_gone` watches the HOST CLI and nothing else, which is the process the fault was
    about. A tab holding only a shell has none, so the wait returns at once and the close
    is reported on the app's word alone — true of the close, and no evidence whatever about
    an agent. Saying which of the two happened costs one line and stops the stronger claim
    being read into the weaker case."""
    if was_running is None:
        return ("close: no process matching %s was found on %s, so this close is the app's "
                "word, not a reading of the process table." % (HOST_CLI, tty))
    return ""


def close_tab(tty, expect):
    """The ordinary close of a tab or a window, proved on the process table and, where the
    terminal can name what it closed, on the terminal; prints the contract line."""
    term = terminal_for(tty)
    # Read before the close: once it is accepted, nothing else names the process to end.
    host = host_identity(tty)
    closed_id = term.close(tty, expect)
    # The close is not what was asked for, it is what the process table shows. The line
    # below used to print the moment the request was acknowledged, over a session that
    # kept running for minutes and had to be ended by hand (§46).
    if host:
        if not end_host(host[0], host[1], tty, "close"):
            die("close: the request was accepted but %s is still running on %s, %s. The "
                "session was NOT closed." % (host[0], tty, end_failure(host[0], tty)))
        others = others_on(tty, host[0])
        survivor = others[0] if others else None
    else:
        survivor = wait_gone(tty)
    if survivor is not None:
        die("close: the request was accepted but %s is still running on %s after %ds. "
            "The session was NOT closed." % (survivor, tty, CLOSE_TIMEOUT))
    # A tty is not the session: it can be handed to another within a minute. The terminal
    # that can name what it closed proves that too.
    if closed_id and term.survives(closed_id):
        die("close: the request was accepted but %s is still there after the process on %s "
            "ended. The session was NOT closed." % (closed_id, tty))
    # Dropped once the process is proved gone, never before: a session that survived its
    # close is still the agent its chain names.
    if closed_id:
        chain_drop_tab(closed_id)


def cmd_close(argv):
    p = argparse.ArgumentParser(prog="close", add_help=False)
    p.add_argument("--tty", dest="tty")
    p.add_argument("--expect-title", dest="expect", default="")
    p.add_argument("--keep-checkout", dest="keep_checkout", action="store_true", default=False)
    args, _ = p.parse_known_args(argv)
    if not args.tty:
        die("close: --tty is required")
    if DRY_RUN:
        print("close=%s expect_title=%s" % (args.tty, args.expect))
        return

    # A tab that shows a home session runs no host of its own: the orchestrator runs in window
    # 0 of the server behind it, and that pane is what the proof below is about.
    socket = home_of_tab(args.tty)
    listed = home_panes(socket) if socket else None
    host_tty = args.tty
    if listed and listed[0]:
        host_tty = next((tty for index, tty in listed[0] if index == "0"), args.tty)
    # Read BEFORE the close: what the proof below is a proof ABOUT.
    was_running = host_cli_on(host_tty)
    # And the same for the checkout the session works in: once it is gone nothing says where.
    checkout = None
    if not args.keep_checkout:
        cwd = host_cli_cwd(host_tty)
        checkout = checkout_of(cwd) if cwd else None
    # And the host pids the hooks module's store records on it: the close's proof reads the
    # tty, and these are named afterwards when the process table still lists them.
    recorded = recorded_pids({host_tty, args.tty})

    note = close_note(host_tty, was_running)
    if socket:
        # Closing the tab alone would end the client and leave the server running unseen, its
        # orchestrator and agents with it. The server is ended, every window it holds, and
        # proved gone; then the tab, if it outlived its client. It prints the close's
        # contract line itself.
        close_home_tab(args.tty, socket, args.expect, listed)
        if note:
            print(note, file=sys.stderr)
    else:
        close_tab(args.tty, args.expect)
        if note:
            print(note, file=sys.stderr)
        # The first line is the contract every skill, command and brief parses; the reading
        # that qualifies it goes to stderr rather than changing it.
        print("closed 1 session on %s" % args.tty)
        sys.stdout.flush()
    name_lingering(recorded)
    # The session's purpose is over and its process is proved gone: its checkout goes with
    # it, unless it holds work (`workspace.sh delete` refuses that, and says why).
    if checkout:
        delete_checkout(checkout)


def cmd_move(argv):
    p = argparse.ArgumentParser(prog="move", add_help=False)
    p.add_argument("--tty", dest="tty")
    p.add_argument("--left-of", dest="left_of", default="")
    p.add_argument("--right-of", dest="right_of", default="")
    p.add_argument("--leftmost", action="store_true", default=False)
    p.add_argument("--force", action="store_true", default=False)
    args, _ = p.parse_known_args(argv)
    if not args.tty:
        die("move: --tty is required")
    if not args.left_of and not args.right_of and not args.leftmost:
        die("move: --left-of, --right-of or --leftmost is required")
    if args.leftmost and (args.left_of or args.right_of):
        die("move: --leftmost is exclusive with --left-of and --right-of")
    if args.left_of and args.right_of:
        die("move: --left-of and --right-of are mutually exclusive")
    own = self_tty() or ""
    # No anchor to resolve for --leftmost: the target is a place in the tab's own window,
    # never a neighbour tab, so "leftmost" stands in as the printed field's sentinel below.
    anchor = "leftmost" if args.leftmost else (args.right_of or args.left_of)
    if anchor == "self":
        anchor = own
    if not args.leftmost and anchor == args.tty:
        die("move: --tty and its anchor are the same session")
    def guard(is_ours):
        """A session the caller did not launch is not its to place. An orchestrator that
        had never measured its own tty read the listing, took the last tab for its own and
        moved a stranger's session out from between itself and its agents; the script
        obeyed, because `move` moved anything it was told to (§38).

        An auditor's tab, and the coordinator's, are read first, by their NAME: each is in
        no chain, so each is nobody's to place but its own session's, whatever a stale chain
        entry on its tty says (§52)."""
        coord = ((coord_name_on(args.tty) or registered_coord_on(args.tty))
                 if args.tty != own else None)
        if coord:
            if not args.force:
                die("move: refused: %s is the coordinator's tab ('%s'), not this session's "
                    "to place (pass --force to move it anyway)" % (args.tty, coord))
            print("move: forced: %s is the coordinator's tab ('%s')" % (args.tty, coord),
                  file=sys.stderr)
            return
        audit = audit_name_on(args.tty) if args.tty != own else None
        if audit:
            if not args.force:
                die("move: refused: %s is an auditor's tab ('%s'), not this session's to "
                    "place (pass --force to move it anyway)" % (args.tty, audit))
            print("move: forced: %s is an auditor's tab ('%s')" % (args.tty, audit),
                  file=sys.stderr)
            return
        if is_ours:
            return
        # Warned, not refused: the move still happens, and the warning (stderr and close.log)
        # is what an orchestrator finds afterwards when it looks for a tab moved out of place.
        close_log("move", "warning: %s is not in this session's chain: moved anyway" % args.tty)

    if DRY_RUN:
        # No app, so no session id and no tab id: the dry run reads the chain the way the
        # rest of the dry run does, on ORCHESTRATOR_SELF_ID and the tty.
        guard(args.tty == own
              or args.tty in [e["tty"] for e in chain_owned(chain_read(own), SELF_ID)])
        print("move=%s %s=%s" % (args.tty, "right_of" if args.right_of else "left_of", anchor))
        return

    # The guard rules BEFORE anything moves: a refusal must find the layout as it was.
    term = terminal_for(args.tty)
    owned = term.owns(args.tty, own)
    if owned is None:
        die("move: no session found on %s" % args.tty)
    guard(owned)
    idx = term.move(args.tty, anchor, bool(args.right_of), args.leftmost)
    print("moved %s to position %s" % (args.tty, idx))


def rotated_session(tty):
    """The session id of the host on `tty`, from the host's own registry of its pid, or
    empty."""
    pid = host_cli_on(tty)
    record = host_registry(pid) if pid and str(pid).isdigit() else None
    sid = record.get("sessionId") if record else ""
    return sid if isinstance(sid, str) else ""


def cmd_pair(argv):
    """The calling session's model and effort now, read on its transcript (read_pair):
    `model=<m> effort=<e>`, or exit 1 with the reason. Read-only: an orchestrator answers a
    pause with it, and a move's record is filled from it, rather than declaring either."""
    if argv:
        die("pair: takes no argument; it reads the calling session's own transcript")
    try:
        model, effort = caller_pair(os.environ.get("CLAUDE_CODE_SESSION_ID", ""))
    except PairUnreadable as exc:
        die("pair: %s" % exc)
    print("model=%s effort=%s" % (model, effort))


def cmd_rotate(argv):
    p = argparse.ArgumentParser(prog="rotate", add_help=False)
    p.add_argument("--old-tty", dest="old_tty")
    p.add_argument("--expect-title", dest="expect", default="")
    p.add_argument("--force", action="store_true", default=False)
    args, rest = p.parse_known_args(argv)
    if not args.old_tty:
        die("rotate: --old-tty is required")
    # A rotation replaces an agent with a titled agent; none of these are that. A successor
    # is spawned with `spawn --successor`, not smuggled through the replacement a rotation
    # makes, and neither is an auditor or the coordinator's own successor.
    for flag in ("--successor", "--auditor", "--coordinator-successor", "--wake", "--open",
                 "--title-free", "--no-remote-control"):
        if flag in rest:
            die("rotate: refused: %s is not a rotation's (a rotation replaces an agent with "
                "a titled agent; a successor is spawned with spawn --successor)" % flag)
    # The verification is the rotation's whole guarantee: without it the old agent is closed
    # on a replacement nobody saw start, and a replacement that never started leaves none.
    if "--no-verify" in rest:
        die("rotate: refused: --no-verify is not a rotation's (the old agent is closed only "
            "once its replacement is verified running)")
    # Nor is the tab it closes the coordinator's or an auditor's: neither is an agent of the
    # caller's, and a rotation that closed one would end an audit nobody ended, or drop the
    # machine's coordinator, without anyone having asked for either (§52). Read before the
    # spawn, so a refusal leaves no replacement behind.
    coord = coord_name_on(args.old_tty) or registered_coord_on(args.old_tty)
    if coord:
        if not args.force:
            die("rotate: refused: %s is the coordinator's tab ('%s'): the coordinator is "
                "not an agent and is not rotated (pass --force to rotate it anyway)"
                % (args.old_tty, coord))
        print("rotate: forced: %s is the coordinator's tab ('%s')" % (args.old_tty, coord),
              file=sys.stderr)
    audit = audit_name_on(args.old_tty)
    if audit:
        if not args.force:
            die("rotate: refused: %s is an auditor's tab ('%s'): an auditor is not an agent "
                "and is not rotated (pass --force to rotate it anyway)" % (args.old_tty, audit))
        print("rotate: forced: %s is an auditor's tab ('%s')" % (args.old_tty, audit),
              file=sys.stderr)
    # Window 0 of a home session is the orchestrator's place. The close below refuses it, but
    # only after the replacement has spawned, which would leave that replacement running with
    # nothing to close the old window: the refusal is read here, before the spawn.
    chosen = terminal()
    if isinstance(chosen, TmuxTerminal):
        pane = chosen.lookup(args.old_tty)
        if pane is not None and pane.index == "0":
            refuse_window_zero("rotate", args.old_tty, pane.name)
    # A rotation is a succession: given no pair, the replacement runs on the ROTATED agent's
    # live model and effort, read on that agent's transcript — not on its tier's, which its
    # orchestrator may have escalated since. A tier, or a model with its effort, is the
    # orchestrator naming the pair, and the spawn types it as named.
    pair_from = ""
    named = ("--tier", "--model", "--effort", "--inherit-model")
    if not any(word.partition("=")[0] in named for word in rest):
        sid = rotated_session(args.old_tty)
        try:
            model, effort, path = read_pair(sid)
        except PairUnreadable as exc:
            die("rotate: refused: the agent on %s runs on a model and an effort that cannot be "
                "read (%s); pass --tier, or --model with --effort" % (args.old_tty, exc))
        rest = rest + ["--model", model, "--effort", effort]
        pair_from = "transcript %s" % path
    # The spawn verifies the replacement is RUNNING before anything is closed: a rotation
    # that killed the old agent on a spawn that never started would leave zero agents,
    # which is the one outcome this order exists to prevent.
    cmd_spawn(rest, pair_from)
    # The replacement works in the same checkout: a rotation deletes nothing.
    close_args = ["--tty", args.old_tty, "--keep-checkout"]
    if args.expect:
        close_args += ["--expect-title", args.expect]
    cmd_close(close_args)


def cmd_resolve_tier(argv):
    if len(argv) != 1:
        die("resolve-tier: exactly one tier is required (deep, standard or light)")
    print(resolve_tier(argv[0]))


def transcript_of_session(sid):
    """The transcript the host keeps for a session id, or None: one directory per checkout,
    and the file is named by the id, so the id alone finds it wherever the session ran."""
    if not re.fullmatch(r"[0-9A-Za-z._-]+", sid):
        return None
    dated = []
    for path in glob.glob(os.path.join(PROJECTS_DIR, "*", sid + ".jsonl")):
        try:
            dated.append((os.path.getmtime(path), path))
        except OSError:
            # Removed between the listing and the read of its time: not a transcript any more.
            continue
    return max(dated)[1] if dated else None


def read_offered(path):
    """What the host gave the session at start, read from its transcript: the schemas it
    sends on every call (`loaded`), the names it lists until one is searched for
    (`deferred`), and the skill, agent-type and server-instruction lines it adds to the
    context. Each item is its name and its size in characters.

    The first snapshot that carries tools is the session's own: a later one is the same
    session after a tool changed. Anything the transcript lacks is simply absent."""
    offered = {"loaded": {}, "deferred": {}, "skills": {}, "agent-types": {}, "mcp": {}}
    kinds = ("prompt_snapshot", "deferred_tools", "skill_listing", "agent_listing_delta",
             "mcp_instructions_delta")
    with open(path, errors="replace") as fh:
        for line in fh:
            if not any(kind in line for kind in kinds):
                continue
            try:
                entry = json.loads(line)
            except Exception:
                continue
            att = entry.get("attachment") if isinstance(entry, dict) else None
            if not isinstance(att, dict):
                continue
            kind = att.get("type")
            if kind == "prompt_snapshot" and att.get("tools") and not offered["loaded"]:
                for tool in att["tools"]:
                    if isinstance(tool, dict) and tool.get("name"):
                        offered["loaded"][tool["name"]] = len(json.dumps(tool, ensure_ascii=False))
            elif kind == "deferred_tools_delta":
                for name in att.get("addedNames") or []:
                    offered["deferred"][name] = len(name)
                for name in att.get("removedNames") or []:
                    offered["deferred"].pop(name, None)
            elif kind == "skill_listing" and not offered["skills"]:
                # A name may itself hold a colon (`plugin:skill`); the line's own separator is
                # a colon followed by a space.
                for found in re.finditer(r"^- (\S+?): .*?(?=^- \S+?: |\Z)",
                                         att.get("content") or "", re.S | re.M):
                    offered["skills"][found.group(1)] = len(found.group(0))
            elif kind == "agent_listing_delta":
                for item in att.get("addedLines") or []:
                    found = re.match(r"- (\S+?): ", item)
                    if found:
                        offered["agent-types"][found.group(1)] = len(item)
            elif kind == "mcp_instructions_delta":
                for block in att.get("addedBlocks") or []:
                    found = re.match(r"## (.+)", block)
                    if found:
                        offered["mcp"][found.group(1).strip()] = len(block)
    return offered


def tool_rows(offered, catalogue):
    """The listing, one `kind | name | characters | tokens | roles` row per item. A `?` is a
    figure this transcript cannot give: a name the default removes from at least one role
    (the five unused tools from every role, the three that move an orchestrator from every
    role but `Orch` and `Coord`) is listed even when the reader's own session lacks it (a
    lean caller never received it), and a catalogue server has no size unless this session
    loaded it. The last field names the roles whose default removes the item, `-` when none
    does."""
    removed = {role: set(default_removed(role)) for role in ROLE_WORDS}

    def roles(name):
        if name.startswith(SYNCED_SKILLS_PREFIX):
            return ",".join(ROLE_WORDS)
        return ",".join(role for role in ROLE_WORDS if name in removed[role]) or "-"

    def row(kind, name, chars):
        if chars is None:
            size, tokens = "?", "?"
        else:
            size, tokens = str(chars), str(int(round(chars * TOKENS_PER_CHAR)))
        return " | ".join([kind, name, size, tokens, roles(name) if kind != "mcp" else "-"])

    rows = []
    for kind in ("loaded", "deferred", "skills", "agent-types"):
        items = dict(offered[kind])
        if kind == "loaded":
            every = set().union(*removed.values()) | set(MOVE_TOOLS)
            missing = sorted(every - set(offered["loaded"]) - set(offered["deferred"]))
        else:
            missing = []
        rows += [row(kind, name, chars) for name, chars in
                 sorted(items.items(), key=lambda item: (-item[1], item[0]))]
        rows += [row(kind, name, None) for name in missing]
    if catalogue:
        # The catalogue's order, the default set first: what a spawn gets with no `--mcp`,
        # then what `--mcp <name>` adds.
        order = list(catalogue["default"]) + [n for n in catalogue["servers"]
                                              if n not in catalogue["default"]]
        rows += [row("mcp", name, offered["mcp"].get(name)) for name in order]
    return rows


def cmd_tools(argv):
    """`tools [--transcript <path>]`: what a session on this machine is given and what each
    item costs on every call, read from a transcript and nothing launched (§65). By default
    the caller's own, found through the session id the host sets in its environment."""
    p = argparse.ArgumentParser(prog="tools", add_help=False)
    p.add_argument("--transcript", default="")
    args, unknown = p.parse_known_args(argv)
    if unknown:
        die("tools: unknown option %s" % unknown[0])
    path = args.transcript
    if not path:
        sid = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
        if not sid:
            die("tools: no transcript to read: CLAUDE_CODE_SESSION_ID is unset; pass "
                "--transcript <path>")
        path = transcript_of_session(sid)
        if not path:
            die("tools: no transcript for session %s under %s; pass --transcript <path>"
                % (sid, PROJECTS_DIR))
    if not os.path.isfile(path):
        die("tools: transcript not found: %s" % path)
    for line in tool_rows(read_offered(path), read_catalogue()):
        print(line)


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
    "screen": cmd_screen, "trust": cmd_trust, "tools": cmd_tools,
    "home": cmd_home, "home-release": cmd_home_release, "takeover": cmd_takeover,
    "home-watch": cmd_home_watch, "pair": cmd_pair,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        die("usage: iterm-agent.sh {list|spawn|verify|screen|resolve-tier|pair|close|move|rotate|trust|tools|home|home-release|takeover} [options] (see header)")
    COMMANDS[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    main()
