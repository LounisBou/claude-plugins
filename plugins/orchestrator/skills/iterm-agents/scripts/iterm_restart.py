"""`iterm-agent.sh restart`: iTerm2 stopped and started again with every session it shows kept.

Measured on two restarts (2026-11-21, 2026-11-22): a stop by SIGKILL leaves every job with
iTermServer, which the next iTerm2 attaches on the same ttys; the tabs' order and titles and the
app's ids are lost. So a session is known by its tty, pid and start time, and the home servers are
told first not to exit without a client. A process of its own session does it all after the snapshot.
"""
import contextlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import time

# The launcher's module (iterm_agent.py), which runs as the main program: set by `main`.
ia = None
STOP_WAIT, OPEN_WAIT, API_WAIT, TABS_WAIT, TITLE_WAIT, WORK_WAIT = 10, 20, 60, 30, 10, 120
SERVER_COMMAND = re.compile(r"^/.*/iTermServer-\S+( |\Z)")


class Stop(Exception):
    """A step that failed: the run ends there, its message a line of the report."""


def processes():
    """`{pid: (ppid, tty, command)}` of the machine; raises when `ps` cannot be read."""
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,tty=,command="], capture_output=True,
                         text=True, errors="replace", timeout=10, check=True).stdout
    rows = [line.split(None, 3) for line in out.splitlines()]
    return {r[0]: (r[1], "/dev/" + r[2] if r[2].startswith(("tty", "pts")) else "", r[3])
            for r in rows if len(r) == 4}


def output_of(*words):
    done = subprocess.run(words, capture_output=True, text=True, timeout=10)
    return done.stdout.strip() if done.returncode == 0 else ""


def open_app():
    """The app started without this environment, a session's, which every new tab would carry."""
    env = {k: os.environ[k] for k in ("HOME", "USER", "LOGNAME", "SHELL", "LANG") if k in os.environ}
    env.update(PATH="/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR=output_of("getconf", "DARWIN_USER_TEMP_DIR"),
               SSH_AUTH_SOCK=output_of("launchctl", "getenv", "SSH_AUTH_SOCK"))
    subprocess.run(["/usr/bin/open", "-b", "com.googlecode.iterm2"], capture_output=True, timeout=30,
                   env={k: v for k, v in env.items() if v})


def until(read, seconds):
    """`read()`'s first true answer within `seconds`, else its last one."""
    deadline = time.time() + seconds
    while True:
        value = read()
        if value or time.time() >= deadline:
            return value
        time.sleep(0.5)


def tmux(socket, *words):
    return ia.tmux_on(socket, words, "restart")


def read_server(socket):
    """Whether a home server exits with its last client, its clients' ttys, its panes' ttys."""
    return {"armed": tmux(socket, "show-options", "-sv", "exit-unattached").strip() == "on",
            "clients": tmux(socket, "list-clients", "-F", "#{client_tty}").split(),
            "panes": tmux(socket, "list-panes", "-a", "-F", "#{pane_tty}").split()}


def read_servers():
    return {socket: read_server(socket) for socket in ia.live_homes()}


def tab_title(socket):
    return tmux(socket, "display-message", "-p", "-t", ia.HOME_SESSION + ":", "#T").rstrip("\n")


def layout():
    return ia.app_layout()


def shown(windows):
    """`{tty: title}` of every session the app shows."""
    return {s["tty"]: s["title"] for tabs in windows or [] for tab in tabs for s in tab if s["tty"]}


SHELLS = ("zsh", "bash", "sh", "fish")


def shell_name(command):
    """The program's name of a command line, a login shell's leading dash dropped."""
    words = command.split()
    return os.path.basename(words[0]).lstrip("-") if words else ""


def age_of(seconds):
    return "%dm%02ds" % divmod(max(0, int(seconds)), 60)


def kept_windows(table, sessions, servers, lines):
    """The order the launcher kept, when the app does not answer, or None. A tab whose tty no process
    runs on is one closed since, and is dropped; when none is left, no order is known. A plain tab, a
    home server's client, or a shell of iTermServer's opened by hand since is put after the known ones,
    named once."""
    found = ia.kept_order()
    if found is None:
        return None
    windows, at = found
    alive = {tty for _, tty, _ in table.values() if tty}
    windows = [[tab for tab in ([s for s in tab if s["tty"] in alive] for tab in tabs) if tab]
               for tabs in windows]
    windows = [tabs for tabs in windows if tabs]
    if not windows:
        return None
    known = set(shown(windows))
    homes = {t for server in servers.values() for t in server["panes"] + server["clients"]}
    opened = {}
    for s in sessions:
        if not s["socket"] and s["tty"] not in known:
            opened.setdefault(s["tty"], s["name"])
    for server in servers.values():
        for c in server["clients"]:
            if c not in known:
                opened.setdefault(c, "")
    for pid, (_, tty, command) in sorted(table.items(), key=lambda item: item[1][1]):
        if tty and tty not in homes and tty not in known and shell_name(command) in SHELLS \
                and any(SERVER_COMMAND.match(table[a][2]) for a in ancestors(table, pid)):
            opened.setdefault(tty, "")
    for tty in opened:
        lines.append("kept order: %s opened since it, put after the known ones" % tty)
    windows[-1] += [[{"tty": tty, "title": title}] for tty, title in opened.items()]
    lines.append("order: kept order of %s, iTerm2 does not answer" % age_of(time.time() - at))
    return windows


def ancestors(table, pid):
    while pid in table and table[pid][0] != pid:
        pid = table[pid][0]
        if pid in table:
            yield pid


def written(sid):
    """How many bytes the session's transcripts hold, on the plan read."""
    return sum(map(os.path.getsize, ia.glob.glob(os.path.join(ia.PROJECTS_DIR, "*", "%s.jsonl" % sid))))


def resume_of(pid, config, record, prompt):
    """The line that starts the session again with `prompt`, on its own process's plan and
    plugin variables."""
    words, environment = ia.host_argv(pid), ia.host_environment(pid)
    sid, cwd = record.get("sessionId") or "", record.get("cwd") or ""
    if not words or environment is None or not sid or not os.path.isdir(cwd):
        raise ValueError("its launch, environment, session id or directory cannot be read")
    resume = ia.resume_words(words[1:], sid, record.get("name") or sid, prompt)
    with contextlib.suppress(ia.PairUnreadable):
        resume = ia.with_pair(resume, *ia.caller_pair(sid))
    kept = [e for e in environment if e.startswith("ORCHESTRATOR_") and e.split("=")[0] not in ia.HOME_ENV_DROPPED]
    line = (["env"] + (["CLAUDE_CONFIG_DIR=" + config] if config else ["-u", "CLAUDE_CONFIG_DIR"])
            + kept + [shutil.which(ia.HOST_CLI) or ia.HOST_CLI] + resume)
    return "cd %s && exec %s" % (ia.shq(cwd), " ".join(ia.shq(w) for w in line))


def resume_line(launcher, pid):
    """`resume-line`: prints the line that resumes the running session `pid`, for one whose
    orchestrator module is not loaded: its prompt has it call the model at once, which is when
    its transcript says whether the module came back."""
    global ia
    ia = launcher
    config = ia.process_config(pid) if pid else None
    if config is None:
        ia.die("resume-line: pid %s: its process cannot be read" % pid)
    with ia.on_plan(config):
        try:
            print(resume_of(pid, config, ia.host_registry(pid) or {},
                            "Your process was ended because its orchestrator module was not "
                            "loaded: this is your conversation resumed. Go on."))
        except ValueError as exc:
            ia.die("resume-line: pid %s: %s" % (pid, exc))


def read_sessions(table, servers, report, refused):
    """Every session of a home server or of iTerm2's tabs, a host another one started on its tty apart."""
    panes = {tty: socket for socket, server in servers.items() for tty in server["panes"]}
    names, sessions = ia.host_cli_names(), []
    hosts = {p: row for p, row in table.items() if row[1] and ia.is_host_process(p, row[2], names)}
    for pid, (_, tty, command) in sorted(hosts.items(), key=lambda item: item[1][1]):
        above = list(ancestors(table, pid))
        in_tab = any(SERVER_COMMAND.match(table[a][2]) for a in above)
        if any(a in hosts and hosts[a][1] == tty for a in above) or not (tty in panes or in_tab):
            continue
        state, config = ia.process_state(pid), ia.process_config(pid)
        with ia.on_plan(config or ""):
            record = ia.host_registry(pid) or {}
            name = record.get("name") or ia.session_name_on(tty) or command[:40]
            sid = record.get("sessionId") or ""
            session = {"pid": pid, "start": state[0] if isinstance(state, tuple) else "", "tty": tty,
                       "name": name, "status": record.get("status") or "-", "config": config or "",
                       "socket": panes.get(tty, ""), "resume": "", "id": sid,
                       "size": written(sid)}
            try:
                if not session["start"] or config is None:
                    raise ValueError("its process cannot be read")
                session["resume"] = resume_of(pid, config, record,
                                              "iTerm2 was restarted and your process ended with "
                                              "it: this is your conversation resumed. Read %s, "
                                              "then go on." % report)
            except ValueError as exc:
                # A home session is never started again by a restart: its line is only printed.
                if not session["socket"] or not session["start"] or config is None:
                    refused.append("%s on %s could not be proved or resumed: %s" % (name, tty, exc))
        sessions.append(session)
    return sessions


def snapshot(folder, keep):
    """`(state, refusals)`: what iTerm2 and the home servers show, and why it must not restart."""
    refused, lines = [], []
    pid = ia.app_pid()
    start = ia.process_state(pid) if pid else None
    try:
        table, servers = processes(), read_servers()
    except (OSError, subprocess.SubprocessError, SystemExit) as exc:
        return {"lines": lines}, ["the machine cannot be read: %r" % exc]
    if not isinstance(start, tuple):
        return {"lines": lines}, ["iTerm2 is not running, or its process cannot be read"]
    refused += ["set not to restore: %s" % k for k in ("OpenArrangementAtStartup", "OpenNoWindowsAtStartup")
                if output_of("defaults", "read", "com.googlecode.iterm2", k) == "1"]
    sessions = read_sessions(table, servers, os.path.join(folder, "report.md"), refused)
    try:
        windows = layout()
        if keep:
            ia.keep_order(windows)
        lines.append("order: live, read now")
    except (Exception, SystemExit) as exc:
        # The live read is the freshest; the order the launcher kept stands in when iTerm2 does not answer.
        windows = kept_windows(table, sessions, servers, lines)
        if windows is None:
            lines.append("order: unknown, iTerm2 does not answer (%s)" % type(exc).__name__)
    lines += ["server: %s is shown by no tab" % s for s in servers if not servers[s]["clients"]]
    lines += ["session: %s | %s | %s | pid %s | %s" % (s["socket"] or "plain tab, resumed if it dies",
              s["name"], s["tty"], s["pid"], s["status"]) for s in sessions]
    known = {s["tty"] for s in sessions} | {c for server in servers.values() for c in server["clients"]}
    lines += ["tab: %s holds no session" % tty for tty in sorted(set(shown(windows)) - known)]
    # iTermServer holds what outlives the app: a job that is the app's own child dies with it.
    for job, (_, tty, _) in table.items():
        above = list(ancestors(table, job))
        if tty and pid in above and not any(SERVER_COMMAND.match(table[a][2]) for a in above):
            refused.append("the process %s on %s is not held by iTermServer and would die" % (job, tty))
    return {"step": "snapshot", "closed": False, "app": [pid, start[0]], "servers": servers,
            "sessions": sessions, "windows": windows, "disarmed": [], "moved": {}, "lines": lines,
            "defects": []}, refused


def own_state(folder):
    """The state of a run under this machine's own root, None of anything else: its lines are run
    and its pid is killed, so a folder or a file placed by another, or through a link, is not read."""
    folder = os.path.realpath(folder)
    if os.path.dirname(folder) != runs_root():
        return None
    with contextlib.suppress(OSError, ValueError):
        fd = os.open(os.path.join(folder, "state.json"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, encoding="utf-8") as fh:
            there = os.fstat(fd)
            if (stat.S_ISREG(there.st_mode) and not there.st_mode & 0o077
                    and {there.st_uid, os.lstat(folder).st_uid} == {os.getuid()}):
                return json.load(fh)
    return None


def runs_root():
    return os.path.join(os.path.realpath(ia.STATE_DIR), "iterm-restart")


class Run:
    def __init__(self, folder, state):
        self.folder, self.s = folder, state
        # A later process only finishes the run: a session ended by its owner since is not resumed.
        self.first = state["step"] == "snapshot"

    def save(self, **values):
        self.s.update(values)
        ia.write_json(os.path.join(self.folder, "state.json"), self.s)

    def bad(self, line):
        self.s["defects"].append(line)

    def now(self, tty):
        """The tty that stands for one of the snapshot's: itself unless its tab was made again."""
        return self.s["moved"].get(tty, tty)

    def work(self):
        """Every step after the snapshot, and the report whatever happened."""
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        self.save(worker=[str(os.getpid()), ia.process_state(os.getpid())[0]], closed=False, defects=[])
        try:
            if self.first:
                self.disarm()
                self.stop()
            elif not ia.process_gone(*self.s["app"]):
                raise Stop("the last run ended before it stopped iTerm2")
            for step in (self.relaunch, self.tabs, self.order, self.titles, self.rearm, self.prove):
                self.save(step=step.__name__)
                step()
            # The order restored is the one the next restart keeps, when it is whole.
            if not self.s["defects"]:
                ia.keep_order()
        except (Exception, SystemExit) as exc:
            self.bad("%s: %s" % (self.s["step"], exc if isinstance(exc, Stop) else "%r, see the log" % exc))
            # Once the app is gone the servers stay disarmed, which keeps every session.
            if not ia.process_gone(*self.s["app"]):
                with contextlib.suppress(Exception, SystemExit):
                    self.rearm()
        self.report()
        return 1 if self.s["defects"] else 0

    def disarm(self):
        self.save(step="disarm")
        for _ in range(3):
            servers = read_servers()
            armed = [socket for socket in servers if servers[socket]["armed"]]
            for socket in armed:
                self.s["servers"].setdefault(socket, servers[socket])
                self.save(disarmed=sorted(set(self.s["disarmed"]) | {socket}))
                tmux(socket, "set-option", "-s", "exit-unattached", "off")
            if not armed:
                return
        raise Stop("a home server is still told to exit with its tab: iTerm2 was not stopped")

    def stop(self):
        pid, start = self.s["app"]
        if ia.process_state(pid)[0] != start:
            raise Stop("the iTerm2 of the snapshot (pid %s) is not the one running" % pid)
        self.save(step="stop")
        os.kill(int(pid), signal.SIGKILL)
        if not ia.wait_process_gone(pid, start, STOP_WAIT):
            raise Stop("iTerm2 (pid %s) still runs %ds after SIGKILL" % (pid, STOP_WAIT))

    def relaunch(self):
        """The app started and answering; no AppleScript, which could start it, while it is absent."""
        for _ in range(3):
            if not ia.app_pid():
                open_app()
                until(ia.app_pid, OPEN_WAIT)
        if not ia.app_pid():
            ia.osascript_run('display notification "iTerm2 did not start again: open it, every session runs on"')
            raise Stop("iTerm2 did not start again: open it, then run `restart`, which finishes this run")

        def answers():
            with contextlib.suppress(Exception, SystemExit):
                return [layout()]
        if not until(answers, API_WAIT):
            raise Stop("iTerm2 runs and did not answer in %ds" % API_WAIT)

    def make_tab(self, command):
        async def go(iterm2, connection):
            app = await iterm2.async_get_app(connection)
            if app.windows:
                tab = await app.windows[0].async_create_tab(command=command, select=False)
            else:
                tab = (await iterm2.Window.async_create(connection, command=command)).current_tab
            return await ia.tty_of(tab, connection)
        return ia.run(go) or ""

    def tabs(self):
        """Every tab back, or made again: a home server's, a dead plain session's by its resume line."""
        wanted = set(shown(self.s["windows"])) | {s["tty"] for s in self.s["sessions"] if not s["socket"]}
        wanted |= {c for server in self.s["servers"].values() for c in server["clients"]}
        until(lambda: {self.now(t) for t in wanted} <= set(shown(layout())), TABS_WAIT)
        for socket in ia.live_homes():
            for tty in self.s["servers"].get(socket, {"clients": []})["clients"]:
                if self.now(tty) not in shown(layout()):
                    new = self.make_tab(ia.attach_program(socket, tab_title(socket)))
                    if not new or not ia.client_on(socket, new):
                        self.bad("the home server %s runs and no tab shows it" % socket)
                    else:
                        self.s["moved"][tty] = new
        for s in self.s["sessions"] if self.first else []:
            if not s["socket"] and s["tty"] not in self.s["moved"] and ia.process_gone(s["pid"], s["start"]):
                new = self.make_tab("%s -l %s" % (ia.LOGIN_SHELL, ia.write_launch_script(
                    s["resume"], s["name"], "resume")))
                if new and until(lambda: ia.host_cli_on(new), ia.SPAWN_TIMEOUT):
                    self.s["moved"][s["tty"]] = new
        seen = shown(layout())
        for tty in sorted(t for t in wanted if self.now(t) not in seen):
            self.bad("no tab shows %s" % tty)

    def wanted_order(self):
        return [[[self.now(s["tty"]) for s in tab] for tab in tabs] for tabs in self.s["windows"] or []]

    def order(self):
        async def go(iterm2, connection):
            app, used = await iterm2.async_get_app(connection), set()
            for tabs in self.wanted_order():
                found = [await ia.find_tab(app, next((t for t in ttys if t), "")) for ttys in tabs]
                found = [(window, tab) for window, tab, _ in found if tab is not None]
                if found:
                    target = (next((w for w, _ in found if w.window_id not in used), None)
                              or await found[0][1].async_move_to_window())
                    used.add(target.window_id)
                    # The app's other tabs of that window stay after these.
                    await target.async_set_tabs([tab for _, tab in found])
        ia.run(go)

    def wrong_titles(self):
        """The home servers, then the plain tabs' ttys, whose tab does not show their title."""
        seen, stable = shown(layout()), ia.stable_title
        return ([socket for socket in ia.live_homes() for c in read_server(socket)["clients"]
                 if c in seen and stable(seen[c]) != stable(tab_title(socket))],
                [s["tty"] for s in self.s["sessions"] if not s["socket"] and s["tty"] in seen
                 and s["name"] not in seen[s["tty"]]])

    def titles(self):
        """tmux sends a title only when it changes, and the new app has none: the string is changed
        and put back. A plain tab's is written once on its tty, as the host writes it."""
        homes, plain = self.wrong_titles()
        for socket in homes:
            string = tmux(socket, "show-options", "-gv", "set-titles-string").rstrip("\n")
            tmux(socket, "set-option", "-g", "set-titles-string", string + " ")
            time.sleep(1)
            tmux(socket, "set-option", "-g", "set-titles-string", string)
        for s in [s for s in self.s["sessions"] if s["tty"] in plain]:
            with contextlib.suppress(OSError), open(s["tty"], "wb", buffering=0) as fh:
                fh.write(("\033]0;✳ %s\007" % re.sub(r"[\x00-\x1f\x7f]", "", s["name"])).encode())
        until(lambda: not any(self.wrong_titles()), TITLE_WAIT)
        for what in sum(self.wrong_titles(), []):
            self.bad("the title of %s is not back" % what)

    def rearm(self):
        """Each server a run disarmed, armed again once its client is on a tab of the app."""
        seen = set(shown(layout()))
        for socket in [s for s in self.s["disarmed"] if s in ia.live_homes()]:
            if not set(read_server(socket)["clients"]) & seen:
                self.bad("%s stays told not to exit: no tab shows it" % socket)
            elif not ia.arm_home(socket, "restart") or not read_server(socket)["armed"]:
                self.bad("%s could not be told again to exit with its tab" % socket)
            else:
                self.s["disarmed"].remove(socket)

    def worked(self, s):
        """Whether a session busy at the snapshot wrote since, or came to another status."""
        with ia.on_plan(s["config"]):
            status = (ia.host_registry(s["pid"]) or {}).get("status")
            return status not in (None, "busy") or written(s["id"]) > s["size"]

    def prove(self):
        busy = [s for s in self.s["sessions"] if s["status"] == "busy"]
        until(lambda: all(self.worked(s) for s in busy), WORK_WAIT)
        for s in self.s["sessions"]:
            if ia.process_gone(s["pid"], s["start"]):
                said = ("died and was resumed on %s" % self.now(s["tty"]) if s["tty"] in self.s["moved"]
                        else "STOPPED, its work with it")
                again = "" if s["tty"] in self.s["moved"] else "; resumed by: " + (s["resume"] or "no line could be read")
                self.bad("%s (pid %s, %s) %s%s" % (s["name"], s["pid"], s["tty"], said, again))
            elif s in busy and not self.worked(s):
                said = "alive, NO ACTIVITY seen in %ds" % WORK_WAIT
                self.bad("%s was working, and no activity of it is seen" % s["name"])
            else:
                said = "alive, %s" % ("working" if s in busy else "at rest as before")
            self.s["lines"].append("after: %s | %s | pid %s | %s" % (s["name"], s["tty"], s["pid"], said))
        now = [[[s["tty"] for s in tab] for tab in tabs] for tabs in layout()]
        for tabs in self.wanted_order():
            if not any(window[:len(tabs)] == tabs for window in now):
                self.bad("the tabs are not in their order: %s" % " ".join("+".join(t) for t in tabs))
        if self.s["windows"] is None:
            self.bad("the tabs' order was not known before the stop: check it")

    def report(self):
        lines = ["# iTerm2 restart: %s" % ("%d defect(s)" % len(self.s["defects"]) if self.s["defects"]
                                           else "done, everything proved"),
                 "Ended %s at the step %s." % (time.strftime("%Y-%m-%d %H:%M:%S %Z"), self.s["step"])]
        lines += ["- DEFECT %s" % d for d in self.s["defects"]]
        lines += ["- %s does not exit with its tab until the next `restart`; see it: %s -L %s attach -t %s"
                  % (s, ia.TMUX_BIN, s, ia.HOME_SESSION) for s in self.s["disarmed"]]
        with open(os.path.join(self.folder, "report.md"), "w", encoding="utf-8",
                  opener=lambda path, flags: os.open(path, flags, 0o600)) as fh:
            fh.write("\n".join(lines + ["- " + line for line in self.s["lines"]]) + "\n")
        self.save(closed=True)


def last_run():
    """`(folder, state)` of the newest run, or ("", None)."""
    root = runs_root()
    for name in sorted(os.listdir(root), reverse=True) if os.path.isdir(root) else []:
        state = own_state(os.path.join(root, name))
        if state:
            return os.path.join(root, name), state
    return "", None


def unfinished(state):
    """Whether the next `restart` finishes this run: its process died on the way, or iTerm2 did not
    start again. Any other run is over, and a server it left disarmed is the next one's to arm."""
    return state["step"] == "relaunch" if state["closed"] else state["step"] != "snapshot"


def under_way(state):
    return bool(state and not state["closed"] and state.get("worker") and not ia.process_gone(*state["worker"]))


def main(launcher, args):
    global ia
    ia = launcher
    if not ia.registered_coord_on(ia.self_tty() or ""):
        ia.die("restart: refused: only the registered coordinator restarts iTerm2")
    if args.run:
        state, parent = own_state(args.run), str(os.getppid())
        if not state or state.get("worker") != [parent, (ia.process_state(parent) or [""])[0]]:
            ia.die("restart: refused: --run is for the process a `restart` starts, on its own run")
        sys.exit(Run(os.path.realpath(args.run), state).work())
    last = folder, state = last_run()
    if under_way(state):
        ia.die("restart: refused: a restart is under way (%s)" % folder)
    if state and unfinished(state):
        print("restart: finishes the run %s, left at the step %s" % (folder, state["step"]))
    else:
        left = state["disarmed"] if state else []
        folder = os.path.join(runs_root(), time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
        state, refused = snapshot(folder, keep=not args.check)
        print("\n".join(state["lines"] + ["refused: " + r for r in refused]))
        if refused:
            ia.die("restart: refused: nothing was done")
        servers = state["servers"]
        state["disarmed"] = [s for s in left if s in servers and not servers[s]["armed"]]
    if args.check:
        return
    sys.stdout.flush()
    # Under way from here on: the worker writes its own pid over this one's.
    me, raced = str(os.getpid()), True
    with contextlib.suppress(RuntimeError), ia.path_lock(runs_root()):
        raced = last_run() != last
        if not raced:
            ia.write_json(os.path.join(folder, "state.json"),
                          dict(state, closed=False, worker=[me, ia.process_state(me)[0]]))
    if raced:
        ia.die("restart: refused: a restart is under way, started since this one read the machine")
    with open(os.path.join(folder, "log"), "a") as log:
        request = json.dumps(ia.request_of("restart", run=folder))
        code = subprocess.Popen([sys.executable, os.path.abspath(ia.__file__), "--request", request],
                                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True).wait()
    with contextlib.suppress(OSError), open(os.path.join(folder, "report.md"), encoding="utf-8") as fh:
        print(fh.read(), end="")
    print("report: %s" % os.path.join(folder, "report.md"))
    sys.exit(1 if code else 0)
