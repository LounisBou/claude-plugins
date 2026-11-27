"""The tabs' order across the launcher's own commands (`spawn`, `close`, `rotate`), over an app of
the probe's own: no iTerm2, no tmux and no process is touched.

    order-probe.py <scripts> <work> <scenario>

Prints the order of each window on screen, before and after, and what the commands said on stderr."""
import asyncio
import contextlib
import io
import os
import subprocess
import sys

scripts, work, scenario = sys.argv[1:4]
os.environ["ORCHESTRATOR_STATE_DIR"] = os.path.join(work, "state")
os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(work, "cfg")
sys.path.insert(0, scripts)
import iterm_agent as ia  # noqa: E402

# Each tab's session, by tty: the name its process carries.
names, count = {}, [0]


class Session:
    def __init__(self, tty): self.tty, self.session_id = tty, "S" + tty
    async def async_get_variable(self, key):
        return {"tty": self.tty, "autoName": names.get(self.tty, "")}.get(key)
    async def async_close(self, force=False):
        for window in app.windows:
            window.tabs = [t for t in window.tabs if self not in t.sessions]
        app.windows[:] = [w for w in app.windows if w.tabs]


class Tab:
    def __init__(self, name):
        count[0] += 1
        self.tab_id, tty = "t%d" % count[0], "/dev/ttys%03d" % count[0]
        names[tty] = name
        self.sessions = self.all_sessions = [Session(tty)]

    @property
    def current_session(self): return self.sessions[0]

    @property
    def tty(self): return self.sessions[0].tty


class Window:
    def __init__(self, wid, tabs): self.window_id, self.tabs = wid, tabs

    async def async_create_tab(self, command=None, index=None, select=True):
        tab = Tab(made[0])
        self.tabs.insert(len(self.tabs) if index is None else index, tab)
        return tab

    async def async_set_tabs(self, tabs):
        moves.append([names[t.tty] for t in tabs])
        if deaf[0]:
            deaf[0] -= 1
            return
        for window in app.windows:
            window.tabs = [t for t in window.tabs if t not in tabs]
        self.tabs = list(tabs) + self.tabs


class App:
    def __init__(self): self.windows = []
    @property
    def current_window(self): return self.windows[0]


class Api:
    async def async_get_app(self, connection): return app


app, made, moves, deaf = App(), [""], [], [0]


def window(wid, *titles):
    app.windows.append(Window(wid, [Tab(t) for t in titles]))


def tab(name):
    return next(t for w in app.windows for t in w.tabs if names[t.tty] == name)


def drag(name, at):
    """The operator's hand: the tab put at an index of its window, with no launcher command."""
    w = next(w for w in app.windows if tab(name) in w.tabs)
    moved = tab(name)
    w.tabs.remove(moved)
    w.tabs.insert(at, moved)


def screen():
    return " / ".join(" ".join(names[t.tty].split(" ", 1)[1] for t in w.tabs) for w in app.windows)


def run(coro_fn):
    ia.ANSWERED = True
    return asyncio.run(coro_fn(Api(), None))


# The caller is the tab on `own`; every host is gone as soon as its tab is.
own = [""]
ia.run = run
ia.backend_chain = lambda: ("api",)
ia.served_by = lambda what, rungs: rungs["api"]()
ia.self_tty = lambda: own[0]
ia.home_of_tab = lambda tty, strict=False: ""
ia.session_name_on = lambda tty: names.get(tty, "")
ia.registry_name_on = ia.session_name_on
ia.audit_name_on = lambda tty: names.get(tty) if names.get(tty, "").startswith("Audit:") else None
ia.coord_name_on = lambda tty: names.get(tty) if names.get(tty, "").startswith("Coord:") else None
ia.registered_coord_on = lambda tty: ia.coord_name_on(tty) if registered[0] == tty else None
registered = [""]
ia.host_cli_on = lambda tty: None
ia.host_identity = lambda tty: None
ia.wait_gone = lambda tty, timeout=None: None
ia.pane_tab_tty = lambda tty: tty
ia.close_host_tty = lambda tty, strict=False: ("", None, tty)
ia.host_cli_cwd = lambda tty: None
ia.recorded_pids = lambda ttys: {}
ia.in_home_session = lambda: False
# A woken orchestrator's home server, stood in for: its tab is the app's.
ia.make_home = lambda socket, title, cwd, program, what: "/dev/pts9"
ia.client_on = lambda socket, tty: True
ia.arm_home = lambda socket, what: True
ia.start_home_watch = lambda socket, tty: None
ia.sleeper_config = lambda title: None
ia.opener_name = lambda: "Coord: c"


def quiet(call):
    out, err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            call()
    except SystemExit as exc:
        if exc.code:
            print("died=%s" % " ".join(err.getvalue().split()))
    return err.getvalue()


def launcher(command, *words):
    """One command as the entry runs it, the order kept after it."""
    said = quiet(lambda: ia.COMMANDS[command](ia.args_from_line(command, list(words))))
    quiet(ia.keep_order)
    return said


def close(name):
    return launcher("close", "--tty", tab(name).tty, "--keep-checkout")


def wake(name, *more):
    made[0] = name
    return launcher("spawn", "--wake", "--title", name, "--dir", work, "--prompt", "p",
                    "--model", "m", "--effort", "medium", "--no-verify", *more)


def said(text):
    return " ".join(line for line in text.splitlines() if "could not be put" in line)


if scenario == "replaced-live":
    # A window A B C D whose C is replaced while it still runs.
    window("w1", "Orch: A", "Orch: B", "Orch: C", "Orch: D")
    own[0] = tab("Orch: A").tty
    old = tab("Orch: C")
    print("before=%s" % screen())
    wake("Orch: C")
    names[old.tty] = "Orch: old"
    launcher("close", "--tty", old.tty, "--keep-checkout")
    print("after=%s" % screen())
elif scenario == "batch":
    # The operator's own order, D A C B: A and C moved across plans, closed then woken, by the
    # coordinator on D.
    window("w1", "Coord: D", "Orch: B", "Orch: A", "Orch: C")
    for name, at in (("Orch: A", 1), ("Orch: C", 2)):
        drag(name, at)
    own[0] = tab("Coord: D").tty
    print("before=%s" % screen())
    close("Orch: A")
    close("Orch: C")
    wake("Orch: A")
    print("between=%s" % screen())
    wake("Orch: C")
    print("after=%s" % screen())
elif scenario in ("repaired", "unrepaired"):
    window("w1", "Coord: c", "Orch: A", "Orch: B", "Orch: C")
    own[0] = tab("Coord: c").tty
    print("before=%s" % screen())
    close("Orch: B")
    # The app takes the move and does nothing, once or every time.
    deaf[0] = 1 if scenario == "repaired" else 9
    err = wake("Orch: B")
    print("after=%s" % screen())
    print("moves=%d" % len(moves))
    print("said=%s" % said(err))
elif scenario == "paused":
    window("w1", "Orch: A", "Orch: B", "Orch: C")
    own[0] = tab("Orch: C").tty
    print("before=%s" % screen())
    close("Orch: B")
    wake("Orch: B")
    print("after=%s" % screen())
elif scenario == "all-closed":
    # A B C closed for a restart; the new app gives its window a new id and holds the
    # coordinator's tab alone. Reopened in another order.
    window("w1", "Coord: c", "Orch: A", "Orch: B", "Orch: C")
    own[0] = tab("Coord: c").tty
    launcher("list")
    print("before=%s" % screen())
    app.windows.clear()
    window("w2", "Coord: c")
    own[0] = tab("Coord: c").tty
    for name in ("Orch: C", "Orch: A", "Orch: B"):
        wake(name)
    print("after=%s" % screen())
elif scenario == "hand-move":
    window("w1", "Coord: c", "Orch: A", "Orch: B", "Orch: C")
    own[0] = tab("Coord: c").tty
    close("Orch: B")
    # After the close, the operator drags C before A, and the launcher reads the window.
    drag("Orch: C", 1)
    launcher("list")
    print("before=%s" % screen())
    wake("Orch: B")
    print("after=%s" % screen())
elif scenario in ("coordinator", "duplicate", "auditor"):
    # A successor opened by hand lands at the window's end; its close of the predecessor gives
    # it the predecessor's place. A coordinator closing a duplicate keeps its own.
    role = "Audit: x" if scenario == "auditor" else "Coord: g"
    window("w1", role, "Orch: A", "Orch: B")
    first = tab(role)
    names[first.tty] = role
    app.windows[0].tabs.append(Tab(role))
    last = app.windows[0].tabs[-1]
    if scenario == "duplicate":
        own[0], registered[0], target = first.tty, first.tty, last.tty
    else:
        own[0], registered[0], target = last.tty, first.tty, first.tty
    print("before=%s" % " ".join(t.tab_id for t in app.windows[0].tabs))
    launcher("close", "--tty", target, "--keep-checkout")
    print("after=%s" % " ".join(t.tab_id for t in app.windows[0].tabs))
elif scenario == "rotate":
    # The replacement is made at the end of its orchestrator's group, then takes the old tab's
    # place; the close that follows is the rotation's own.
    window("w1", "Coord: c", "Agent: a", "Agent: b", "Agent: c")
    own[0] = tab("Coord: c").tty
    old = tab("Agent: a")
    app.windows[0].tabs.append(Tab("Agent: a2"))
    new = app.windows[0].tabs[-1]
    print("before=%s" % screen())
    ia.refuse_recycled = lambda *a: None
    ia.presence = lambda session: ("there", "")
    quiet(lambda: ia.finish_rotation(
        {"tty": new.tty, "terminal": ia.ITERM},
        {"tty": old.tty, "window": "", "session": "S" + old.tty, "title": "", "expect": "",
         "host": None}, None))
    print("after=%s" % screen())
elif scenario == "home-identity":
    # A home tab is known by its server and its window 0's name, whatever its title follows.
    ia.home_of_tab = lambda tty, strict=False: "orch-abc"
    ia.tmux_call = lambda words, env=None: subprocess.CompletedProcess(words, 0, "Orch: h\n", "")
    entry = ia.seen_session({"tty": "/dev/ttys001", "title": "◐ Agent: z", "tab": "t1"})
    print("entry=%s|%s" % (entry["name"], entry["session"]))
