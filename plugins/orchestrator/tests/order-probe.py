"""The tabs' order across the launcher's own commands (`spawn`, `close`, `rotate`, `verify`), over an
app of the probe's own: no iTerm2, no tmux and no process is touched.

    order-probe.py <scripts> <work> <scenario>

Prints the order of each window on screen, before and after, and what the commands said on stderr."""
import asyncio
import contextlib
import io
import json
import os
import subprocess
import sys

scripts, work, scenario = sys.argv[1:4]
os.environ["ORCHESTRATOR_STATE_DIR"] = os.path.join(work, "state")
os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(work, "cfg")
os.environ["ORCHESTRATOR_PROJECTS_DIR"] = os.path.join(work, "projects")
# Its own trust file: a spawn from `work` is refused unless the host trusts it, and neither the
# machine's file nor the caller's says so.
os.environ["ORCHESTRATOR_TRUST_FILE"] = os.path.join(work, "trust.json")
with open(os.environ["ORCHESTRATOR_TRUST_FILE"], "w", encoding="utf-8") as fh:
    json.dump({"projects": {os.path.realpath(work): {"hasTrustDialogAccepted": True}}}, fh)
sys.path.insert(0, scripts)
import iterm_agent as ia  # noqa: E402
import tab_order  # noqa: E402

# Each tab's session, by tty: the name its process carries.
names, plans, count = {}, {}, [0]


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
        # The plan its host runs on: the configuration directory of the launch that made it.
        plans[tty] = os.environ.get("CLAUDE_CONFIG_DIR", "")
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


# The real readers of a session's name, for the case that reads them over registries of its own.
real_readers = ia.session_name_on, ia.registry_name_on

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
ia.process_config = lambda pid: None
ia.host_identity = lambda tty: None
ia.wait_gone = lambda tty, timeout=None: None
ia.pane_tab_tty = lambda tty: tty
ia.close_host_tty = lambda tty, strict=False: ("", None, tty)
ia.host_cli_cwd = lambda tty: None
# Nothing typed in any prompt: the empty box a close reads where it finds a host on the tab.
ia.ITERM.prompt_lines = lambda tty: ["─" * 40, "❯\u00a0", "─" * 40]
ia.recorded_pids = lambda ttys: {}
ia.in_home_session = lambda: False
# A woken orchestrator's home server, stood in for: its tab is the app's.
ia.make_home = lambda socket, title, cwd, program, what: "/dev/pts9"
ia.client_on = lambda socket, tty: True
ia.arm_home = lambda socket, what, owners=(): True
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
    """One command as the entry runs it, the order kept after one that changes it. Each is a
    process of its own: the plan a command moved to ends with it."""
    plan = os.environ.get("CLAUDE_CONFIG_DIR", "")
    said = quiet(lambda: ia.COMMANDS[command](ia.args_from_line(command, list(words))))
    if command in ia.ORDER_CHANGERS:
        quiet(ia.keep_order)
    ia.use_config(plan)
    return said


def close(name):
    return launcher("close", "--tty", tab(name).tty, "--keep-checkout")


def wake(name, *more):
    made[0] = name
    return launcher("spawn", "--wake", "--title", name, "--dir", work, "--prompt", "p",
                    "--model", "m", "--effort", "medium", "--no-verify", *more)


def resume(name, session, *more):
    """A closed agent resumed outside a home session, on the pair its transcript holds."""
    made[0] = name
    os.makedirs(os.path.join(work, "projects", "p"), exist_ok=True)
    with open(os.path.join(work, "projects", "p", session + ".jsonl"), "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "api-request", "sessionId": session, "querySource": "repl_main_thread",
                             "params": {"model": "m", "output_config": {"effort": "low"}}}) + "\n")
    return launcher("spawn", "--resume", session, "--title", name, "--dir", work, "--prompt", "p",
                    "--no-verify", *more)


def pid_of(tty):
    """A pid no process can have, one a tab."""
    return str(4000000 + int(tty[-3:]))


def on_screen(tty):
    return any(t.tty == tty for w in app.windows for t in w.tabs)


def session_of(tty):
    return "s-%s" % tty[-3:]


def identified():
    """Each tab on screen runs a host whose registry gives it a session id of its own."""
    ia.host_cli_on = lambda tty: pid_of(tty) if on_screen(tty) else None
    ia.host_registry = lambda pid: {"sessionId": "s-%03d" % (int(pid) - 4000000)}


def tab_ids():
    return " ".join(t.tab_id for t in app.windows[0].tabs)


def entry(name, session="", tab_id=""):
    return {"name": name, "session": session, "tab": tab_id}


def kept(record):
    """Each window of a record, its entries by name, a closed one starred."""
    return " / ".join(" ".join(e["name"] + ("*" if e.get("gone") else "") for e in w["tabs"])
                      for w in record)


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
elif scenario == "renamed-neighbour":
    # A shell of the operator's, known by no session id, retitles itself after B was closed.
    window("w1", "Orch: A", "Sh: zsh", "Orch: B", "Orch: C")
    own[0] = tab("Orch: A").tty
    launcher("list")
    close("Orch: B")
    names[tab("Sh: zsh").tty] = "Sh: vim"
    launcher("list")
    print("before=%s" % screen())
    wake("Orch: B")
    print("after=%s" % screen())
elif scenario == "new-window-first":
    # B closed, then D dragged into a new window the app lists before the old one.
    window("w1", "Orch: A", "Orch: B", "Orch: C", "Orch: D")
    own[0] = tab("Orch: A").tty
    close("Orch: B")
    dragged = tab("Orch: D")
    app.windows[0].tabs.remove(dragged)
    app.windows.insert(0, Window("w2", [dragged]))
    launcher("list")
    print("before=%s" % screen())
    wake("Orch: B")
    print("after=%s" % screen())
elif scenario == "plans":
    # Two plans, a registry each, the names read by the launcher's own readers. The caller's tab
    # was opened by hand: its name is in the first plan's registry alone, its tab shows a summary.
    os.environ["HOME"] = os.path.join(work, "home")
    os.environ.pop("CLAUDE_CONFIG_DIR")
    ia.session_name_on, ia.registry_name_on = real_readers

    def rows(tty, strict=False):
        if not on_screen(tty):
            return []
        folder = os.path.join(plans[tty] or os.path.join(os.environ["HOME"], ia.PLAN1_DIRNAME), "sessions")
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, pid_of(tty) + ".json"), "w", encoding="utf-8") as fh:
            json.dump({"name": names[tty], "sessionId": "S" + tty}, fh)
        return [(pid_of(tty), ia.HOST_CLI)]

    async def summary(self, key):
        return {"tty": self.tty, "autoName": "Sum: " + self.tty}.get(key)

    ia.ps_rows = rows
    ia.host_cli_on = lambda tty: pid_of(tty) if on_screen(tty) else None
    ia.process_config = lambda pid: plans["/dev/ttys%03d" % (int(pid) - 4000000)]
    Session.async_get_variable = summary
    window("w1", "Coord: D", "Orch: B", "Orch: A", "Orch: C")
    drag("Orch: A", 0)
    drag("Orch: C", 2)
    own[0] = tab("Coord: D").tty
    launcher("list")
    print("before=%s" % screen())
    close("Orch: A")
    close("Orch: C")
    wake("Orch: A", "--plan", "2")
    wake("Orch: C", "--plan", "2")
    print("after=%s" % screen())
    # The plan each woken tab was made on, and the id kept for each tab of the first plan.
    print("made=%s" % " ".join(ia.plan_of_config(plans[tab(n).tty]) or "?" for n in ("Orch: A", "Orch: C")))
    ids = {e["name"]: e["session"] for w in ia.kept_places() for e in w["tabs"]}
    print("ids=%s" % " ".join(ids.get(n) or "-" for n in ("Coord: D", "Orch: B")))
elif scenario in ("refused-close", "verify-running", "verify-by-agent", "verify-pid"):
    # The host refused the successor its close: the predecessor ended itself, its tab left on a
    # shell, and the successor, made at the window's first place, proves that end with `verify`.
    window("w1", "Orch: A", "Coord: g", "Orch: B")
    first = tab("Coord: g")
    app.windows[0].tabs.insert(0, Tab("Coord: g"))
    successor = app.windows[0].tabs[0]
    own[0], registered[0] = successor.tty, first.tty
    if scenario == "verify-by-agent":
        names[successor.tty] = "Agent: x"
    running = scenario == "verify-running"
    ia.host_clis_on = lambda tty, strict=False: ["7"] if running or tty != first.tty else []
    print("before=%s" % tab_ids())
    launcher("verify", "--tty", first.tty, *(("--pid", "9") if scenario == "verify-pid" else ()))
    print("after=%s" % tab_ids())
    print("record=%s" % " / ".join(" ".join(e["tab"] for e in w["tabs"]) for w in ia.kept_places()))
elif scenario in ("resumed", "resumed-anchored"):
    window("w1", "Coord: c", "Agent: a", "Agent: b", "Agent: c")
    own[0] = tab("Coord: c").tty
    close("Agent: b")
    print("before=%s" % screen())
    anchor = ("--right-of", tab("Agent: c").tty) if scenario == "resumed-anchored" else ()
    resume("Agent: b", "s-resumed", *anchor)
    print("after=%s" % screen())
elif scenario == "resumed-namesake":
    # Another session of the same name still open is not the one resumed: it keeps its place.
    window("w1", "Coord: c", "Agent: b", "Agent: a")
    own[0] = tab("Coord: c").tty
    print("before=%s" % screen())
    resume("Agent: a", "s-other")
    print("after=%s" % screen())
elif scenario == "by-session":
    # Resumed under another title, a session is still the one closed: its id says so.
    identified()
    window("w1", "Coord: c", "Agent: a", "Agent: b", "Agent: c")
    own[0] = tab("Coord: c").tty
    session = session_of(tab("Agent: b").tty)
    close("Agent: b")
    print("before=%s" % screen())
    resume("Agent: b2", session)
    print("after=%s" % screen())
elif scenario == "renamed-open":
    # The open tab the closed one followed is renamed: its session id keeps it the same.
    identified()
    window("w1", "Coord: c", "Orch: A", "Orch: B", "Orch: C")
    own[0] = tab("Coord: c").tty
    launcher("list")
    close("Orch: B")
    names[tab("Orch: A").tty] = "Orch: A2"
    launcher("list")
    print("before=%s" % screen())
    wake("Orch: B")
    print("after=%s" % screen())
elif scenario == "moved-renamed":
    # A session renamed and moved to another window is open, not closed: no place is kept for it.
    one = tab_order.merge([], [{"window": "w1", "tabs": [entry("c", "", "1"), entry("a", "sid", "2")]}], 1)
    two = tab_order.merge(one, [{"window": "w1", "tabs": [entry("c", "", "1")]},
                                {"window": "w2", "tabs": [entry("a2", "sid", "3")]}], 2)
    print("record=%s" % kept(two))
elif scenario == "reused-ids":
    # The app started again gives out its tab ids anew: in a window of another id, one names no
    # earlier tab.
    one = tab_order.merge([], [{"window": "w1", "tabs": [
        entry("A", "a", "1"), entry("Sh: logs", "", "2"), entry("C", "c", "3")]}], 1)
    two = tab_order.merge(one, [{"window": "w9", "tabs": [
        entry("A", "a", "1"), entry("Sh: other", "", "2")]}], 2)
    print("record=%s" % kept(two))
elif scenario == "hand-move-then-close":
    # C dragged before A after B was closed, then A closed: B goes back after C, where the newer
    # reading leaves it. The order read before the drag would put it after A.
    window("w1", "Coord: c", "Orch: A", "Orch: B", "Orch: C")
    own[0] = tab("Coord: c").tty
    close("Orch: B")
    drag("Orch: C", 1)
    launcher("list")
    close("Orch: A")
    print("before=%s" % screen())
    wake("Orch: B")
    print("after=%s" % screen())
elif scenario == "restarted-unknown":
    # Everything closed: the new app's only tab is one the record never saw.
    said_after = []
    for round_, order in enumerate((("Orch: C", "Orch: A", "Orch: B"), ("Orch: B", "Orch: C", "Orch: A"))):
        ia.ORDER_FILE = os.path.join(ia.STATE_DIR, "order-%d.json" % round_)
        app.windows.clear()
        window("w1", "Orch: A", "Orch: B", "Orch: C")
        launcher("list")
        app.windows.clear()
        window("w2", "Coord: x")
        own[0] = tab("Coord: x").tty
        launcher("list")
        for name in order:
            wake(name)
        said_after.append(screen())
    print("after=%s" % "|".join(said_after))
elif scenario == "first-closed":
    # A tab that followed none goes back left of the one it preceded.
    window("w1", "Orch: A", "Orch: B", "Orch: C")
    own[0] = tab("Orch: C").tty
    print("before=%s" % screen())
    close("Orch: A")
    wake("Orch: A")
    print("after=%s" % screen())
elif scenario == "bad-record":
    # A record that does not read as one is dropped, and the places are kept again.
    os.makedirs(ia.STATE_DIR, exist_ok=True)
    with open(ia.ORDER_FILE, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "at": 1, "windows": [], "places": [{"window": 3, "tabs": "x"}]}, fh)
    window("w1", "Orch: A", "Orch: B", "Orch: C")
    own[0] = tab("Orch: C").tty
    print("before=%s" % screen())
    close("Orch: B")
    wake("Orch: B")
    print("after=%s" % screen())
elif scenario == "capped":
    # More closed tabs than a window keeps: the oldest are dropped, the last closed keeps its place.
    older = ["Orch: n%d" % i for i in range(tab_order.KEPT_GONE + 1)]
    window("w1", "Coord: c", *older, "Orch: z", "Orch: last")
    own[0] = tab("Coord: c").tty
    for name in older + ["Orch: last"]:
        close(name)
    print("gone=%d" % sum(1 for w in ia.kept_places() for e in w["tabs"] if e.get("gone")))
    wake("Orch: last")
    print("after=%s" % screen())
elif scenario == "kept-windows":
    # Of the windows left with no tab open, the newest are kept.
    record = []
    for n in range(1, tab_order.KEPT_WINDOWS + 3):
        record = tab_order.merge(record, [{"window": "w%d" % n, "tabs": [entry("s%d" % n, "", str(n))]}], n)
    record = tab_order.merge(record, [], 99)
    print("record=%s" % kept(record))
elif scenario == "locked":
    # Another process holds the record's lock: nothing is read and written over its change.
    ia.LOCK_WAIT_S = 0.2
    window("w1", "Orch: A")
    os.makedirs(ia.STATE_DIR, exist_ok=True)
    with open(ia.ORDER_FILE + ia.STORE["lock_suffix"], "w", encoding="utf-8") as fh:
        fh.write("1\n")
    quiet(lambda: ia.keep_order(ia.app_layout()))
    print("written=%s" % ("yes" if os.path.exists(ia.ORDER_FILE) else "no"))
elif scenario == "auditor-other":
    # An auditor that closes a tab of another name keeps its own place.
    window("w1", "Audit: x", "Orch: A", "Audit: y")
    own[0] = tab("Audit: x").tty
    print("before=%s" % tab_ids())
    launcher("close", "--tty", tab("Audit: y").tty, "--keep-checkout")
    print("after=%s" % tab_ids())
