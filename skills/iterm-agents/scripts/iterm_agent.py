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
import json
import os
import re
import subprocess
import sys
import time

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
SPAWN_TIMEOUT = int(os.environ.get("ORCHESTRATOR_SPAWN_TIMEOUT", "30"))
DRY_RUN = bool(os.environ.get("ORCHESTRATOR_DRY_RUN"))
TIERS = ("deep", "standard", "light")
# A title reads `<Role> : <what>`: a capital, anything without a colon, a spaced colon,
# then something. It is the session's NAME (§24), so it is the operator's format or it is
# nothing an orchestrator can recognise in a listing — a successor once came up as
# `steward-successor` because the launcher took whatever was typed (§39).
TITLE_SHAPE = re.compile(r"^[A-Z][^:]* : \S")


def die(msg):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(1)


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
    short = tty.replace("/dev/", "")
    try:
        out = subprocess.run(["ps", "-t", short, "-o", "pid=,command="],
                             capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return None
    for line in out.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and re.match(r"^(\S*/)?" + re.escape(HOST_CLI) + r"(\s|$)", parts[1]):
            return parts[0]
    return None


def session_name_on(tty):
    """The name the host session on a tty was launched with (`--name`), or None.

    The tab title is the host's summary of the conversation and it is rewritten as the
    session works: a listing showing one of those named nothing an orchestrator could
    recognise, which is how a stranger's tab was taken for one's own (§38). The name is
    fixed at launch, and the API does not carry it, so it is read from the process table.

    ORCHESTRATOR_PS_TABLE names a file that stands in for `ps`, one line per process,
    `<tty> <command>`. The suite sets it; a live run never does.

    `ps` hands back a flat command line, so a name with spaces is read up to the next
    option — which is what the host was given and what it shows."""
    short = tty.replace("/dev/", "")
    table = os.environ.get("ORCHESTRATOR_PS_TABLE", "")
    try:
        if table:
            with open(table) as fh:
                rows = [l.strip().split(None, 1) for l in fh if l.strip()]
            commands = [r[1] for r in rows if len(r) == 2 and r[0].replace("/dev/", "") == short]
        else:
            commands = subprocess.run(["ps", "-t", short, "-o", "command="],
                                      capture_output=True, text=True, timeout=10).stdout.splitlines()
    except Exception:
        return None
    for command in commands:
        words = command.split()
        if "--name" not in words:
            continue
        name = []
        for word in words[words.index("--name") + 1:]:
            if word.startswith("--"):
                break
            name.append(word)
        if name:
            return " ".join(name)
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
    iterm2 = need_iterm2()
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
    row = "w%d/t%d | %s | %s | %s" % (w, t, tty, title, name or "(host default)")
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

    for line in run(go) or []:
        print(line)


def write_prompt_file(prompt, title):
    os.makedirs(PROMPTS_DIR, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", title)[:40] or "agent"
    path = os.path.join(PROMPTS_DIR, "%s-%d.txt" % (safe, int(time.time() * 1000)))
    with open(path, "w") as fh:
        fh.write(prompt)
    return path


def build_command(dir_, title, model, mode, prompt_file, remote_control=""):
    """The command iTerm2 runs in the new tab. It is HANDED to the app, never typed, so
    its length and its bytes stop being a hazard. No model argument at all when neither a
    tier nor an explicit identifier says which: the host's own default is the right
    answer, and a name hardcoded here would be a routing decision taken for every
    operator."""
    settings = '{"enableAllProjectMcpServers":true}'
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
    cli += ["--permission-mode", shq(mode), "--settings", shq(settings)]
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
    import shlex
    return shlex.quote(s)


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
    if args.title.startswith("Orchestrator :") and (args.left_of or args.right_of):
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
                '--title "Orchestrator : <feature>"')
    elif not TITLE_SHAPE.match(title):
        die('spawn: refused: a title reads "<Role> : <what>", got %r '
            "(pass --title-free for a tab named otherwise)" % title)
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
        if not run(probe):
            die("spawn: no session found on %s" % anchor)
    prompt_file = args.prompt_file
    if prompt_file and not os.path.isfile(prompt_file):
        die("spawn: prompt file not found: %s" % prompt_file)
    if args.prompt:
        prompt_file = write_prompt_file(args.prompt, title)

    # BEFORE the tab exists: a session stopped on the trust question is not launched,
    # whatever the tty says, and finding that out afterwards means finding it out from an
    # agent that never answers.
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

    remote_control = title if (args.successor and args.remote_control) else ""
    launch = build_command(args.dir, title, model, args.mode, prompt_file, remote_control)

    if DRY_RUN:
        print("launch=%s" % launch)
        print("prompt_file=%s" % prompt_file)
        print("self=%s" % own)
        print("anchor=%s" % ("self" if anchor == own else anchor))
        print("trust=%s" % trust_state)
        print("successor=%s" % ("yes" if args.successor else "no"))
        print("name=%s" % title)
        print("title_free=%s" % ("yes" if args.title_free else "no"))
        print("program=%s -l <launch-file>" % LOGIN_SHELL)
        return

    script = write_launch_script(launch, title)
    command = "%s -l %s" % (LOGIN_SHELL, script)

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
        own_sess_id = (await find_tab(app, own))[2].session_id if own else ""
        # select=False: the operator is working in another tab, and a spawn that pulls the
        # window to the new one interrupts them every time an agent is launched.
        tab = await win.async_create_tab(command=command, index=index, select=False)
        new = await tty_of(tab, connection)
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

    new_tty = run(go)
    if not new_tty:
        die("spawn: iTerm2 returned no tty for the new tab")

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
        n = min(args.lines, contents.number_of_lines)
        return [contents.line(i).string.rstrip() for i in range(n)]

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

    async def go(iterm2, connection):
        app = await iterm2.async_get_app(connection)
        return await close_session(app, args.tty, args.expect)

    run(go)
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
