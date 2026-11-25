"""`restart` over a machine of the probe's own: the app, its tabs, the home servers and the process
table, all stood in for; no process is signalled and no tmux is run.

    restart-probe.py <scripts> <work> <scenario> [--check]     the whole command, its process included
    restart-probe.py <scripts> <work> titles <socket> <tty>    the titles step over a real tmux server

Prints the exit code, the acts in order, the tabs' order, what is armed and what is alive."""
import asyncio
import contextlib
import io
import json
import os
import signal
import subprocess
import sys

scripts, work, scenario = sys.argv[1:4]
for key, value in (("ORCHESTRATOR_STATE_DIR", "state"), ("CLAUDE_CONFIG_DIR", "cfg")):
    os.environ[key] = os.path.join(work, value)
HOST = os.environ["ORCHESTRATOR_HOST_CLI"] = "claude"
os.environ["ORCHESTRATOR_HOST_ARGV"] = json.dumps([HOST, "--model", "m", "first prompt"])
os.environ["ORCHESTRATOR_HOST_ENV"] = json.dumps(
    ["CLAUDE_CONFIG_DIR=" + os.environ["CLAUDE_CONFIG_DIR"], "ORCHESTRATOR_AUDITOR=1", "SECRET=x"])
sys.path.insert(0, scripts)
import iterm_agent as ia  # noqa: E402
import iterm_restart as r  # noqa: E402

r.ia = ia
if scenario == "titles":
    socket, tty = sys.argv[4:6]
    outer = lambda *w: subprocess.run(["tmux", "-L", "outer", *w], capture_output=True, text=True).stdout
    r.layout = lambda: [[[{"tty": tty, "title": outer("display-message", "-p", "#{pane_title}").strip()}]]]
    run = r.Run.__new__(r.Run)
    run.s = {"sessions": [], "defects": []}
    print("before=%s" % r.layout()[0][0][0]["title"])
    run.titles()
    print("after=%s defects=%s" % (r.layout()[0][0][0]["title"], run.s["defects"]))
    sys.exit()


class Clock:
    now = 0.0
    def time(self): return Clock.now
    def sleep(self, seconds): Clock.now += max(seconds, 0.01)
    stamps = 0
    def strftime(self, fmt, *_):
        Clock.stamps += 1
        return "STAMP%d" % Clock.stamps
    def gmtime(self): return None


ia.time = r.time = Clock()
acts = []
APP, NEW_APP = "100", "200"
alive = {APP: "app-start", "11": "s", "12": "s", "21": "s", "31": "s", "41": "s", "900": "s"}
hosts = {"11": "/dev/ttys011", "12": "/dev/ttys012", "21": "/dev/ttys021", "31": "/dev/ttys031",
         "41": "/dev/ttys041"}
names = {"11": "Orch: a", "12": "Agent: a1", "21": "Orch: b", "31": "Coord: c", "41": "Audit: d"}
status = {"11": "idle", "12": "busy", "21": "waiting", "31": "shell", "41": "idle"}
servers = {"orch-a": {"armed": "on", "clients": ["/dev/ttys001"], "hosts": ["11", "12"], "string": "#T"},
           "orch-b": {"armed": "on", "clients": ["/dev/ttys002"], "hosts": ["21"], "string": "#T"}}
for kept in {"kept-disarmed": ["orch-b"], "interrupted-kept": ["orch-a", "orch-b"]}.get(scenario, []):
    servers[kept]["armed"] = "off"
if scenario == "unshown":
    servers["orch-b"].update(armed="off", clients=[])
if scenario == "no-stop-elsewhere":
    servers["orch-b"]["clients"] = ["/dev/ttys095"]
os.makedirs(os.path.join(work, "cfg", "sessions"), exist_ok=True)
os.makedirs(os.path.join(work, "cfg", "projects", "p"), exist_ok=True)
os.environ["ORCHESTRATOR_PROJECTS_DIR"] = ""


def record(pid, what):
    with open(os.path.join(work, "cfg", "sessions", pid + ".json"), "w") as fh:
        json.dump({"pid": int(pid), "sessionId": "sid-" + pid, "cwd": work, "name": names[pid],
                   "status": what}, fh)


for pid in hosts:
    record(pid, status[pid])
transcript = os.path.join(work, "cfg", "projects", "p", "sid-12.jsonl")
open(transcript, "w").close()


class Session:
    def __init__(self, tty, title): self.tty, self.title, self.session_id = tty, title, "id" + tty
    async def async_get_variable(self, key):
        return {"tty": self.tty, "autoName": self.title}.get(key)


class Tab:
    def __init__(self, tty, title):
        self.tab_id, self.all_sessions = "tab" + tty, [Session(tty, title)]
        self.sessions = self.all_sessions
    @property
    def current_session(self): return self.sessions[0]
    async def async_move_to_window(self):
        home = next(w for w in windows if self in w.tabs)
        home.tabs.remove(self)
        windows.append(Window([self]))
        return windows[-1]


class Window:
    count = 0
    def __init__(self, tabs):
        Window.count += 1
        self.window_id, self.tabs = "w%d" % Window.count, tabs
    async def async_set_tabs(self, tabs):
        for w in windows:
            w.tabs = [t for t in w.tabs if t not in tabs]
        self.tabs = list(tabs) + self.tabs
        windows[:] = [w for w in windows if w.tabs]
    async def async_create_tab(self, command=None, select=True):
        assert select is False
        tab = new_tab(command)
        self.tabs.append(tab)
        return tab
    @staticmethod
    async def async_create(connection, command=None):
        windows.append(Window([new_tab(command)]))
        windows[-1].current_tab = windows[-1].tabs[0]
        return windows[-1]


windows = [Window([Tab("/dev/ttys031", "✳ Coord: c"), Tab("/dev/ttys001", "✳ Orch: a")]),
           Window([Tab("/dev/ttys041", "✳ Audit: d"), Tab("/dev/ttys002", "✳ Orch: b"),
                   Tab("/dev/ttys050", "shell")])]


def new_tab(command):
    with open(command.split()[-1]) as fh:
        text = fh.read().replace("'", "")
    socket = next((s for s in servers if " %s " % s in text), None)
    if socket:
        acts.append("attach " + socket)
        if scenario != "elsewhere":
            servers[socket]["clients"].append("/dev/ttys090")
        return Tab("/dev/ttys090", "✳ " + title_of(socket))
    acts.append("resume " + ("with its role" if "ORCHESTRATOR_AUDITOR=1" in text and "SECRET" not in text
                             and "--resume sid-41" in text and "first prompt" not in text else text))
    hosts["42"], alive["42"] = "/dev/ttys091", "s"
    return Tab("/dev/ttys091", "✳ Audit: d")


title_of = lambda socket: names[servers[socket]["hosts"][0]]


class App:
    @property
    def windows(self): return windows


class Api:
    Window = Window
    async def async_get_app(self, connection): return App()


TAB = lambda tty: {"tty": tty, "title": ""}
# What the launcher kept, per scenario: the probe's tabs in their order, less those opened by hand since
# (frozen-hand: a shell tab; frozen-login: a plain tab with its shell; frozen-client: a home client), or
# with a tab closed since (frozen-dead: a tty no process runs on), or with no tab alive (the others).
WHOLE = [[[TAB("/dev/ttys031")], [TAB("/dev/ttys001")]], [[TAB("/dev/ttys041")], [TAB("/dev/ttys002")], [TAB("/dev/ttys050")]]]
KEPT = {"frozen-kept": WHOLE,
        "frozen-hand": [[[TAB("/dev/ttys031")], [TAB("/dev/ttys001")]], [[TAB("/dev/ttys041")], [TAB("/dev/ttys002")]]],
        "frozen-login": [[[TAB("/dev/ttys031")], [TAB("/dev/ttys001")]], [[TAB("/dev/ttys002")], [TAB("/dev/ttys050")]]],
        "frozen-client": [[[TAB("/dev/ttys031")], [TAB("/dev/ttys001")]], [[TAB("/dev/ttys041")], [TAB("/dev/ttys050")]]],
        "frozen-dead": [[[TAB("/dev/ttys031")], [TAB("/dev/ttys001")]], [[TAB("/dev/ttys041")], [TAB("/dev/ttys002")], [TAB("/dev/ttys050")], [TAB("/dev/ttys880")]]],
        "frozen-plain": [[[TAB("/dev/ttys031")], [TAB("/dev/ttys001")]], [[TAB("/dev/ttys002")], [TAB("/dev/ttys050")]]],
        "frozen-empty": [],
        "frozen-stale": [[[TAB("/dev/ttys880")], [TAB("/dev/ttys881")]]]}
FROZEN = ("wedged",) + tuple(KEPT)


def run(coro):
    if scenario == "mute":
        signal.pause()
    if APP not in alive and NEW_APP not in alive or scenario in FROZEN and APP in alive \
            or scenario == "deaf" and NEW_APP in alive:
        raise RuntimeError("iTerm2 does not answer")
    ia.ANSWERED = True
    return asyncio.run(coro(Api(), None))


def drop_client(socket):
    """Its last client gone, a home server told to exit with it exits, every session with it."""
    servers[socket]["clients"] = []
    if servers[socket]["armed"] == "on":
        for pid in servers.pop(socket)["hosts"]:
            alive.pop(pid)


def kill(pid, sig):
    acts.append("kill %s armed=%s" % (pid, "+".join(s for s in servers if servers[s]["armed"] == "on")))
    if scenario.startswith("no-stop"):
        return
    alive.pop(str(pid))
    if scenario in ("lost-client", "elsewhere"):
        drop_client("orch-b")
    if scenario == "elsewhere":
        servers["orch-b"]["clients"] = ["/dev/ttys095"]
    if scenario == "dead-tab":
        alive.pop("41")
    if scenario == "dead-agent":
        alive.pop("12")


def open_app():
    acts.append("open")
    if scenario.startswith("no-start"):
        return
    alive[NEW_APP] = "new%d" % len(acts)
    back = [t for w in windows for t in w.tabs]
    back = [t for t in back if not (scenario in ("lost-client", "elsewhere") and t.tab_id == "tab/dev/ttys002"
                                    or scenario == "dead-tab" and t.tab_id == "tab/dev/ttys041")]
    for tab in back:
        tab.sessions[0].title = "tmux" if tab.sessions[0].tty in ("/dev/ttys001", "/dev/ttys002") else HOST
    # One window, the tabs in another order, and one the app opened by itself.
    windows[:] = [Window(list(reversed(back)) + [Tab("/dev/ttys060", "zsh")])]
    if scenario != "no-work":
        with open(transcript, "a") as fh:
            fh.write("{}\n")


def tmux_call(args, env=None):
    socket, words = args[1], args[2:]
    server = servers.get(socket)
    out, code = "", 0
    if server is None or scenario == "refused" and words[:2] == ["set-option", "-s"] and socket == "orch-b" \
            and words[-1] == "off":
        code = 1
    elif words[0] == "show-options":
        out = server["armed"] if words[1] == "-sv" else server["string"]
    elif words[0] == "list-clients":
        out = "\n".join(server["clients"])
    elif words[0] == "list-panes":
        out = "\n".join(hosts[p] for p in server["hosts"])
    elif words[0] == "display-message":
        out = "✳ " + title_of(socket)
    elif words[1] == "-s":
        acts.append("%s %s" % ("arm" if words[-1] == "on" else "disarm", socket))
        # Taken with no error and no effect.
        if not (socket == "orch-b" and scenario in {"off": ("stuck",), "on": ("arm-lost", "stale")}[words[-1]]):
            server["armed"] = words[-1]
    else:
        if server["string"] != words[-1] and not (scenario == "untitled" and socket == "orch-b"):
            for s in (t.sessions[0] for w in windows for t in w.tabs):
                if s.tty in server["clients"]:
                    s.title = "✳ " + title_of(socket)
        server["string"] = words[-1]
    return subprocess.CompletedProcess(args, code, out, "refused")


def process_state(pid):
    return (alive[str(pid)], "S") if str(pid) in alive else ("me", "S") if int(pid) == os.getpid() else None


def processes():
    rows = {"1": ("0", "", "/sbin/launchd"), APP: ("1", "", "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            "900": ("1", "", "/x/Library/Application Support/iTerm2/iTermServer-3.7.9 /x/iterm2-daemon-1.socket"),
            "12001": ("12", "/dev/ttys012", HOST + " -p nested"), "77": ("1", "/dev/ttys077", HOST + " elsewhere"),
            # The clients of the home servers and the plain shell, each a process on its tty.
            "1001": ("1", "/dev/ttys001", "tmux -L orch-a attach"), "1002": ("1", "/dev/ttys002", "tmux -L orch-b attach"),
            # A plain tab's shell under iTermServer, and a shell of no iTerm2 at all.
            "1050": ("900", "/dev/ttys050", "-zsh"), "1099": ("1", "/dev/ttys099", "-zsh")}
    if scenario == "frozen-login":
        # The plain tab Audit: d, its shell and its host, both on its tty.
        rows["1041"] = ("900", "/dev/ttys041", "-zsh")
    if scenario == "own-child":
        rows["88"] = (APP, "/dev/ttys088", "-zsh")
    for pid, tty in hosts.items():
        rows[pid] = ("900" if pid in ("31", "41") else "1", tty, HOST + " --name x")
    return rows


class Worker:
    """The command's process, run here."""
    def __init__(self, argv, **options):
        self.request = json.loads(argv[-1])
        assert options["start_new_session"] and self.request["command"] == "restart"
    def wait(self):
        global scenario, second
        folder = self.request["options"]["run"]
        if scenario.startswith(("interrupted", "half")):
            return Interrupted(os.path.join(folder, "state.json"))()
        if scenario == "reused":
            alive[APP] = "another"
        if scenario == "window":
            scenario = "ok"
            second = restart()
        return restart(run=folder)[0]


class Interrupted:
    """The process ends once iTerm2 is stopped, with no word."""
    def __init__(self, state): self.folder = os.path.dirname(state)
    def __call__(self):
        run = r.Run(self.folder, r.own_state(self.folder))
        run.save(worker=["900" if scenario == "interrupted-running" else "77777", "s"], closed=False)
        run.disarm()
        if scenario == "half":
            run.save(step="stop")
        else:
            run.stop()
        return 1


real_run = ia.run
ia.run, ia.tmux_call, ia.process_state = run, tmux_call, process_state
ia.live_homes = lambda: sorted(servers)
ia.app_pid = lambda: next((p for p in (APP, NEW_APP) if p in alive), "")
ia.kernel_procargs = lambda pid: ([HOST], json.loads(os.environ["ORCHESTRATOR_HOST_ENV"]))
ia.self_tty = lambda: "/dev/ttys999" if scenario in ("stranger", "run-stranger") else "/dev/ttys031"
ia.registered_coord_on = lambda tty: "Coord: c" if tty == "/dev/ttys031" else None
ia.host_cli_on = lambda tty: next((p for p, t in hosts.items() if t == tty and p in alive), None)
ia.osascript_run = lambda script, timeout=None: acts.append("notify") or ("ok", "")
ia.ps_rows = lambda tty, strict=False: []
if scenario == "unreadable":
    ia.host_argv = lambda pid: None
if scenario == "unreadable-home":
    argv_of = ia.host_argv
    ia.host_argv = lambda pid: None if pid == "12" else argv_of(pid)
r.processes, r.open_app = processes, open_app
r.output_of = lambda *words: "1" if scenario == "no-restore" and words[-1] == "OpenNoWindowsAtStartup" else ""
own_os = {"kill": kill, "getppid": os.getpid}
if scenario == "run-owner":
    own_os["getuid"] = lambda: os.getuid() + 1
r.os = type("Os", (), {"__getattr__": lambda self, key: own_os.get(key) or getattr(os, key)})()
r.subprocess = type("Sub", (), {"__getattr__": lambda self, key: Worker if key == "Popen"
                                else getattr(subprocess, key)})()
written = []
real_open = open


def fake_open(path, *args, **options):
    """A tty the probe's tabs are on: what is written there sets the tab's title."""
    if not str(path).startswith("/dev/ttys"):
        return real_open(path, *args, **options)

    class Tty(io.BytesIO):
        def write(self, data):
            for s in (t.sessions[0] for w in windows for t in w.tabs):
                if s.tty == path and scenario != "untitled":
                    s.title = data.decode().removeprefix("\033]0;").removesuffix("\007")
    return Tty()


r.open = fake_open


second = None
real_snapshot = r.snapshot
taken = lambda folder: real_snapshot(folder, keep=False)


def restart(*words, run=""):
    out, err, code = io.StringIO(), io.StringIO(), 0
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            r.main(ia, ia.args_of("restart", {"check": "--check" in words, "run": run}))
    except SystemExit as exc:
        code = exc.code or 0
    return code, out.getvalue(), err.getvalue()


def placed():
    """A run ready for its process, written where the scenario says; its folder."""
    own, elsewhere = os.path.join(r.runs_root(), "RUN"), os.path.join(work, "elsewhere")
    state, _ = taken(own)
    state["worker"] = ["900", "s"] if scenario == "run-typed" else [str(os.getpid()), "me"]
    at = elsewhere if scenario in ("run-outside", "run-link", "run-folder-link") else own
    ia.write_json(os.path.join(at, "state.json"), state)
    if scenario == "run-link":
        os.makedirs(own)
        os.symlink(os.path.join(elsewhere, "state.json"), os.path.join(own, "state.json"))
    if scenario == "run-folder-link":
        os.makedirs(os.path.dirname(own))
        os.symlink(elsewhere, own)
    if scenario == "run-shared":
        os.chmod(os.path.join(own, "state.json"), 0o640)
    return elsewhere if scenario == "run-outside" else own


def raced(folder, keep):
    """Another `restart` writes its run while this one reads the machine."""
    read = taken(folder)
    ia.write_json(os.path.join(r.runs_root(), "OTHER", "state.json"),
                  dict(read[0], step="relaunch", worker=["900", "s"]))
    return read


if scenario == "raced":
    r.snapshot = raced
if scenario == "locked":
    os.makedirs(os.path.join(work, "state"))
    real_open(r.runs_root() + ia.STORE["lock_suffix"], "w").close()
if scenario in KEPT:
    # The order the launcher kept at its last read, 95 seconds before the stop.
    ia.write_json(ia.ORDER_FILE, {"version": 1, "at": -95, "windows": KEPT[scenario]})
if scenario == "mute":
    # A read the app never answers is cut at its deadline: nothing kept, the call returns.
    ia.LAYOUT_WAIT, ia.ANSWERED = 1, True
    ia.keep_order()
    print("mute=%s" % ("present" if os.path.exists(ia.ORDER_FILE) else "absent"))
    sys.exit()
if scenario == "real-run":
    # The launcher's own run(), over a library that answers, then one that raises: the order is kept
    # only after a call the app answered.
    class FakeIterm(Api):
        def run_until_complete(self, main): asyncio.run(main(None))
    class FailingIterm(Api):
        def run_until_complete(self, main): raise RuntimeError("iTerm2 does not answer")
    ia.run, ia.LAYOUT_WAIT = real_run, 5
    ia.api_ready = lambda: FakeIterm()
    ia.app_layout()
    ia.keep_order()
    answered = "present" if os.path.exists(ia.ORDER_FILE) else "absent"
    if os.path.exists(ia.ORDER_FILE):
        os.remove(ia.ORDER_FILE)
    ia.ANSWERED, ia.api_ready = False, lambda: FailingIterm()
    with contextlib.suppress(RuntimeError):
        ia.app_layout()
    ia.keep_order()
    print("real=%s,%s" % (answered, "present" if os.path.exists(ia.ORDER_FILE) else "absent"))
    sys.exit()
if scenario == "empty-keep":
    # A read with no tab replaces no order kept, in either form of empty read.
    ia.write_json(ia.ORDER_FILE, {"version": 1, "at": 0, "windows": KEPT["frozen-kept"]})
    before = real_open(ia.ORDER_FILE).read()
    ia.keep_order([])
    ia.keep_order([[]])
    print("empty=%s" % ("kept" if real_open(ia.ORDER_FILE).read() == before else "overwritten"))
    sys.exit()
if scenario == "dispatch":
    # Which commands keep the order, on what evidence: each step starts with no kept order and no
    # earlier call of the app in this process.
    def step(command, reads, dry=False):
        if os.path.exists(ia.ORDER_FILE):
            os.remove(ia.ORDER_FILE)
        ia.ANSWERED, ia.DRY_RUN = False, dry
        ia.COMMANDS[command] = (lambda args: ia.app_layout()) if reads else (lambda args: None)
        sys.argv = ["iterm_agent.py", "--request", json.dumps({"version": ia.LAUNCHER_ARGS["version"], "command": command, "options": {}})]
        try:
            ia.main()
        except SystemExit:
            pass
        ia.DRY_RUN = False
        return "present" if os.path.exists(ia.ORDER_FILE) else "absent"
    print("dispatch=" + ",".join([step("spawn", True), step("close", True), step("move", True),
                                  step("rotate", True), step("home", True), step("list", True),
                                  step("home-release", True), step("verify", True),
                                  step("spawn", False), step("close", True, dry=True)]))
    sys.exit()
code, out, err = restart(run=placed()) if scenario.startswith("run-") else restart(*sys.argv[4:])
if scenario.startswith(("interrupted", "half", "no-start", "stale")):
    print("first=%s|%s|%s" % (code, ",".join(acts), "+".join(s for s in sorted(servers) if servers[s]["armed"] == "on")))
    if not scenario.startswith("interrupted"):
        del acts[:]
    if scenario in ("stale", "no-start-gone"):
        # The auditor's session closed by its owner since, its tab with it.
        del hosts["41"]
        alive.pop("41")
        for w in windows:
            w.tabs = [t for t in w.tabs if t.sessions[0].tty != "/dev/ttys041"]
    scenario = "again"
    code, out, err = restart()
if second:
    print("second=%s|%s" % (second[0], " ".join(second[2].split())))
print("exit=%s" % code)
print("acts=%s" % ",".join(acts))
print("tabs=%s" % "/".join(" ".join(t.sessions[0].tty[-3:] for t in w.tabs) for w in windows))
print("titles=%s" % ",".join(t.sessions[0].title for w in windows for t in w.tabs))
print("armed=%s" % "+".join(s for s in sorted(servers) if servers[s]["armed"] == "on"))
print("alive=%s" % " ".join(sorted(p for p in hosts if p in alive)))
print("OUT:" + "~".join(out.strip().splitlines()))
print("ERR:" + " ".join(err.split()))
