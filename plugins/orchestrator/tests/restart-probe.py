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
import subprocess
import sys

scripts, work, scenario = sys.argv[1:4]
for key, value in (("ORCHESTRATOR_STATE_DIR", "state"), ("CLAUDE_CONFIG_DIR", "cfg")):
    os.environ[key] = os.path.join(work, value)
os.environ["ORCHESTRATOR_HOST_ARGV"] = json.dumps(["claude", "--model", "m", "first prompt"])
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
    def strftime(self, fmt, *_): return "STAMP"
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


def run(coro):
    if APP not in alive and NEW_APP not in alive or scenario == "wedged" and APP in alive \
            or scenario == "deaf" and NEW_APP in alive:
        raise RuntimeError("iTerm2 does not answer")
    return asyncio.run(coro(Api(), None))


def drop_client(socket):
    """Its last client gone, a home server told to exit with it exits, every session with it."""
    servers[socket]["clients"] = []
    if servers[socket]["armed"] == "on":
        for pid in servers.pop(socket)["hosts"]:
            alive.pop(pid)


def kill(pid, sig):
    acts.append("kill %s armed=%s" % (pid, "+".join(s for s in servers if servers[s]["armed"] == "on")))
    if scenario == "no-stop":
        return
    alive.pop(APP)
    if scenario == "lost-client":
        drop_client("orch-b")
    if scenario == "dead-tab":
        alive.pop("41")
    if scenario == "dead-agent":
        alive.pop("12")


def open_app():
    acts.append("open")
    if scenario == "no-start" and not os.path.exists(os.path.join(work, "start")):
        return
    alive[NEW_APP] = "new"
    back = [t for w in windows for t in w.tabs]
    back = [t for t in back if not (scenario == "lost-client" and t.tab_id == "tab/dev/ttys002"
                                    or scenario == "dead-tab" and t.tab_id == "tab/dev/ttys041")]
    for tab in back:
        tab.sessions[0].title = "tmux" if tab.sessions[0].tty in ("/dev/ttys001", "/dev/ttys002") else "claude"
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
        server["armed"] = words[-1]
    else:
        if server["string"] != words[-1]:
            for s in (t.sessions[0] for w in windows for t in w.tabs):
                if s.tty in server["clients"]:
                    s.title = "✳ " + title_of(socket)
        server["string"] = words[-1]
    return subprocess.CompletedProcess(args, code, out, "refused")


def process_state(pid):
    return (alive[str(pid)], "S") if str(pid) in alive else ("me", "S") if int(pid) == os.getpid() else None


def processes():
    rows = {"1": ("0", "", "/sbin/launchd"), APP: ("1", "", "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            "900": ("1", "", "/Users/x/Library/Application Support/iTerm2/iTermServer-3.7.9 /x/iterm2-daemon-1.socket"),
            "12001": ("12", "/dev/ttys012", "claude -p nested"), "77": ("1", "/dev/ttys077", "claude elsewhere")}
    if scenario == "own-child":
        rows["88"] = (APP, "/dev/ttys088", "-zsh")
    for pid, tty in hosts.items():
        rows[pid] = ("900" if pid in ("31", "41") else "1", tty, "claude --name x")
    return rows


class Worker:
    """The command's process, run here."""
    def __init__(self, argv, **options):
        self.request = json.loads(argv[-1])
        assert options["start_new_session"] and self.request["command"] == "restart"
    def wait(self):
        if scenario.startswith("interrupted"):
            state = os.path.join(self.request["options"]["run"], "state.json")
            return Interrupted(state)()
        return r.Run(self.request["options"]["run"]).work()


class Interrupted:
    """The process ends once iTerm2 is stopped, with no word."""
    def __init__(self, state): self.folder = os.path.dirname(state)
    def __call__(self):
        run = r.Run(self.folder)
        run.save(worker=["77777", "s"], closed=False)
        run.disarm()
        run.stop()
        return 1


ia.run, ia.tmux_call, ia.process_state = run, tmux_call, process_state
ia.live_homes = lambda: sorted(servers)
ia.app_pid = lambda: next((p for p in (APP, NEW_APP) if p in alive), "")
ia.kernel_procargs = lambda pid: (["claude"], json.loads(os.environ["ORCHESTRATOR_HOST_ENV"]))
ia.self_tty = lambda: "/dev/ttys999" if scenario == "stranger" else "/dev/ttys031"
ia.registered_coord_on = lambda tty: "Coord: c" if tty == "/dev/ttys031" else None
ia.host_cli_on = lambda tty: next((p for p, t in hosts.items() if t == tty and p in alive), None)
ia.osascript_run = lambda script, timeout=None: acts.append("notify") or ("ok", "")
ia.ps_rows = lambda tty, strict=False: []
if scenario == "unreadable":
    ia.host_argv = lambda pid: None
r.processes, r.open_app = processes, open_app
r.output_of = lambda *words: "1" if scenario == "no-restore" and words[-1] == "OpenNoWindowsAtStartup" else ""
r.os = type("Os", (), {"__getattr__": lambda self, key: kill if key == "kill" else getattr(os, key)})()
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
                if s.tty == path:
                    s.title = data.decode().removeprefix("\033]0;").removesuffix("\007")
    return Tty()


r.open = fake_open


def restart(*words):
    out, err, code = io.StringIO(), io.StringIO(), 0
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            r.main(ia, ia.args_of("restart", {"check": "--check" in words, "run": ""}))
    except SystemExit as exc:
        code = exc.code or 0
    return code, out.getvalue(), err.getvalue()


code, out, err = restart(*sys.argv[4:])
if scenario.startswith("interrupted"):
    print("first=%s" % ",".join(acts))
    scenario = "again"
    code, out, err = restart()
if scenario == "no-start":
    print("first=%s|%s|%s" % (code, ",".join(acts), "+".join(s for s in servers if servers[s]["armed"] == "on")))
    real_open(os.path.join(work, "start"), "w").close()
    del acts[:]
    code, out, err = restart()
print("exit=%s" % code)
print("acts=%s" % ",".join(acts))
print("tabs=%s" % "/".join(" ".join(t.sessions[0].tty[-3:] for t in w.tabs) for w in windows))
print("titles=%s" % ",".join(t.sessions[0].title for w in windows for t in w.tabs))
print("armed=%s" % "+".join(s for s in sorted(servers) if servers[s]["armed"] == "on"))
print("alive=%s" % " ".join(sorted(p for p in hosts if p in alive)))
print("OUT:" + "~".join(out.strip().splitlines()))
print("ERR:" + " ".join(err.split()))
