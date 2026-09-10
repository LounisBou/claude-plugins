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
MODELS_MAP = os.environ.get("ORCHESTRATOR_MODELS_MAP") or os.path.join(STATE_DIR, "models.json")
SPAWN_TIMEOUT = int(os.environ.get("ORCHESTRATOR_SPAWN_TIMEOUT", "30"))
DRY_RUN = bool(os.environ.get("ORCHESTRATOR_DRY_RUN"))
TIERS = ("deep", "standard", "light")


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


def self_tty():
    """This process's controlling tty, found by walking up the process tree: the caller
    that wants a tab beside ITS OWN should not have to know which tab that is."""
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


async def tty_of(tab):
    return await tab.current_session.async_get_variable("tty")


async def find_tab(app, tty):
    for w in app.windows:
        for t in w.tabs:
            for s in t.sessions:
                if await s.async_get_variable("tty") == tty:
                    return w, t, s
    return None, None, None


# --- subcommands -----------------------------------------------------------------

def cmd_list(_argv):
    async def go(iterm2, connection):
        app = await iterm2.async_get_app(connection)
        lines = []
        for wi, w in enumerate(app.windows, 1):
            for ti, t in enumerate(w.tabs, 1):
                for s in t.sessions:
                    tty = await s.async_get_variable("tty")
                    name = await s.async_get_variable("autoName") or ""
                    lines.append("w%d/t%d | %s | %s" % (wi, ti, tty, name))
        return lines

    for line in run(go) or []:
        print(line)


def write_prompt_file(prompt, title):
    os.makedirs(PROMPTS_DIR, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", title)[:40] or "agent"
    path = os.path.join(PROMPTS_DIR, "%s-%d.txt" % (safe, int(time.time() * 1000)))
    with open(path, "w") as fh:
        fh.write(prompt)
    return path


def build_command(dir_, title, model, mode, prompt_file):
    """The command iTerm2 runs in the new tab. It is HANDED to the app, never typed, so
    its length and its bytes stop being a hazard. No model argument at all when neither a
    tier nor an explicit identifier says which: the host's own default is the right
    answer, and a name hardcoded here would be a routing decision taken for every
    operator."""
    settings = '{"enableAllProjectMcpServers":true}'
    # The ABSOLUTE path, resolved from the environment the orchestrator has. The app runs
    # this as the session's program, not through a login shell, so the tab inherits a bare
    # default PATH — one that does not contain the package manager's bin directory where
    # the CLI actually lives. The typed version never met this because it typed into a
    # login shell that was already running. Unresolved, the script exits at once, the
    # session dies with it, and the spawn fails as a tty that belongs to nothing.
    import shutil
    cli_path = shutil.which(HOST_CLI) or HOST_CLI
    parts = ["cd %s" % shq(dir_),
             "printf '\\033]0;%%s\\007' %s" % shq(title),
             None]
    cli = [shq(cli_path)]
    if model:
        cli += ["--model", shq(model)]
    cli += ["--permission-mode", shq(mode), "--settings", shq(settings)]
    if prompt_file:
        cli.append('"$(cat %s)"' % shq(prompt_file))
    parts[2] = "exec " + " ".join(cli)
    return " && ".join(parts)


def write_launch_script(command, title):
    """The launch goes to a FILE and the app is asked to run `/bin/sh <file>`.

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


def cmd_spawn(argv):
    p = argparse.ArgumentParser(prog="spawn", add_help=False)
    p.add_argument("--dir")
    p.add_argument("--model", default="")
    p.add_argument("--tier", default="")
    p.add_argument("--permission-mode", dest="mode", default="auto")
    p.add_argument("--title", default="agent")
    p.add_argument("--prompt", default="")
    p.add_argument("--prompt-file", dest="prompt_file", default="")
    p.add_argument("--left-of", dest="left_of", default="")
    p.add_argument("--right-of", dest="right_of", default="")
    p.add_argument("--no-verify", dest="verify", action="store_false", default=True)
    args, unknown = p.parse_known_args(argv)
    if unknown:
        die("spawn: unknown option %s" % unknown[0])
    if not args.dir:
        die("spawn: --dir is required")
    if args.left_of and args.right_of:
        die("spawn: --left-of and --right-of are mutually exclusive")
    if not os.path.isdir(args.dir):
        die("spawn: directory not found: %s" % args.dir)
    if args.prompt and args.prompt_file:
        die("spawn: --prompt and --prompt-file are exclusive")
    if args.tier and args.model:
        die("spawn: --tier and --model are mutually exclusive")
    model = args.model
    if args.tier:
        model = resolve_tier(args.tier)
        if model is None:
            die("spawn: cannot resolve tier: %s" % args.tier)
    prompt_file = args.prompt_file
    if prompt_file and not os.path.isfile(prompt_file):
        die("spawn: prompt file not found: %s" % prompt_file)
    if args.prompt:
        prompt_file = write_prompt_file(args.prompt, args.title)

    launch = build_command(args.dir, args.title, model, args.mode, prompt_file)

    if DRY_RUN:
        print("launch=%s" % launch)
        print("prompt_file=%s" % prompt_file)
        print("anchor=%s" % (args.right_of or args.left_of or ""))
        return

    script = write_launch_script(launch, args.title)
    command = "/bin/sh " + script

    anchor = args.right_of or args.left_of
    if anchor == "self":
        anchor = self_tty() or ""

    async def go(iterm2, connection):
        app = await iterm2.async_get_app(connection)
        win = app.current_window
        if win is None:
            die("spawn: iTerm2 has no current window")
        index = None
        if anchor:
            for i, t in enumerate(win.tabs):
                if await tty_of(t) == anchor:
                    index = i + 1 if args.right_of else i
                    break
        tab = await win.async_create_tab(command=command, index=index)
        return await tty_of(tab)

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
        _, tab, sess = await find_tab(app, args.tty)
        if tab is None:
            die("close: no session found on %s" % args.tty)
        name = await sess.async_get_variable("autoName") or ""
        if args.expect and args.expect not in name:
            die("close: refused: session on %s is titled '%s', which does not contain '%s'"
                % (args.tty, name, args.expect))
        await tab.async_close(force=True)
        return name

    run(go)
    print("closed 1 session on %s" % args.tty)


def cmd_move(argv):
    p = argparse.ArgumentParser(prog="move", add_help=False)
    p.add_argument("--tty", dest="tty")
    p.add_argument("--left-of", dest="left_of", default="")
    p.add_argument("--right-of", dest="right_of", default="")
    args, _ = p.parse_known_args(argv)
    if not args.tty:
        die("move: --tty is required")
    if not args.left_of and not args.right_of:
        die("move: --left-of or --right-of is required")
    if args.left_of and args.right_of:
        die("move: --left-of and --right-of are mutually exclusive")
    anchor = args.right_of or args.left_of
    if anchor == "self":
        anchor = self_tty() or ""
    if anchor == args.tty:
        die("move: --tty and its anchor are the same session")
    if DRY_RUN:
        print("move=%s %s=%s" % (args.tty, "right_of" if args.right_of else "left_of", anchor))
        return

    async def go(iterm2, connection):
        app = await iterm2.async_get_app(connection)
        win, tab, _ = await find_tab(app, args.tty)
        if tab is None:
            die("move: no session found on %s" % args.tty)
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


COMMANDS = {
    "list": cmd_list, "spawn": cmd_spawn, "verify": cmd_verify, "close": cmd_close,
    "move": cmd_move, "rotate": cmd_rotate, "resolve-tier": cmd_resolve_tier,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        die("usage: iterm-agent.sh {list|spawn|verify|resolve-tier|close|move|rotate} [options] (see header)")
    COMMANDS[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    main()
