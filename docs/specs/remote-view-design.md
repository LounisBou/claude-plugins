# Remote view — the remote orchestrators shown on this Mac, never held by it

A study (row 525, 2026-11-27): the findings, each with the command that shows it, the design
chosen, the alternatives set aside, and the pull requests that build it. No code changes here.

## His words

2026-11-27, about 13:30Z, in the tab of `Orch: Claude plugins`:

« Est-ce que c'est possible qu'on travaille sur la possibilité d'avoir une fenêtre qui me permet, en
gros, un panel, un onglet item 2, là, comme mes orchestrateurs sur cette machine, mais pour les
orchestrateurs distants de cette machine. […] une session iterm dans laquelle il y a un tmux qui
tourne, où je peux voir l'orchestrateur et ses agents en sous-onglet en bas de page, mais que par
contre ce soit sur un orchestrateur et des agents qui, eux, tournent à distance. »

« Ok, donc lance l'étude. […] quelque chose de transparent. […] on pourrait partir en automatique,
hein. Dès qu'il y a un serveur qui tourne en distant, on pourrait juste l'ouvrir sur cette machine
pour le voir comme s'il tournait en local, mais il ne doit pas du tout être tenu en local, hein. Ça
veut dire qu'en gros, il ne doit rien se passer si je ferme cette machine, que je l'éteins, que je
ferme iTerm, que je ferme juste l'onglet qui m'affiche l'orchestrateur et ses agents. »

## The invariant

Nothing this Mac does or stops doing changes a remote orchestrator or its agents: closing a view
tab or window, quitting iTerm2, sleep, shutdown, network loss. A view is a tmux client and nothing
else; the remote home server's life is decided on the remote alone.

## Findings

Throwaway servers only (`-L remoteview-study`, `-L remoteview-study-armed`,
`-L remoteview-study-owner`), on IznoServer (macOS, tmux 3.4) and Minitech (macOS, tmux 3.8). This
Mac: iTerm2 3.7.9, tmux 3.8.

### 1. How remote orchestrators run today

They already run in home sessions, as here. The plugin's launcher, installed on each remote,
makes a home server per orchestrator (`-L orch-<8 hex>`, `home.conf`), window 0 the orchestrator,
one window per agent:

```
$ ssh izno 'zsh -lc "tmux -L orch-cdc52505 list-windows -a -F \"#{session_name}:#{window_index} #{window_name} #{pane_tty}\"; tmux -L orch-cdc52505 list-clients; tmux -L orch-cdc52505 show -sv exit-unattached"'
home:0 Orch: TorrentMate /dev/ttys002
home:1 Agent: TorrentMate Bugs /dev/ttys001
home:3 Agent: k3-v1-reads /dev/ttys004
/dev/ttys003: home [80x25 xterm-256color] (attached,UTF-8)
on
```

```
$ ssh geonative@<minitech> 'zsh -lc "… same for orch-79cd22ce and orch-5af6af6f …"'
server orch-79cd22ce
home:0 Orch: geo-git-flow /dev/ttys002
off
server orch-5af6af6f
home:0 Orch: refacto firmware /dev/ttys003
home:1 Agent: m5 link causes /dev/ttys004
home:2 Agent: m5o memory budget /dev/ttys005
off
```

- The server is a daemon (parent pid 1): it survives its tab. Minitech's two servers have no client
  at all (iTerm2 restarted after them, `iterm_restart.py` disarmed them), and run.
- IznoServer's server is **armed**: `exit-unattached on`, set by `arm_home`
  (`iterm_agent.py`) so that closing the orchestrator's tab ends it, the operator's order. Its one
  client is the remote's own iTerm2 tab.
- `tmux` is not on the PATH of a non-login ssh command on IznoServer (`zsh:1: command not found:
  tmux`); `zsh -lc` finds `/opt/homebrew/bin/tmux` on both hosts, and every view goes through it.
- The socket directory is `/private/tmp/tmux-501/` on both: an ssh command reaches the same servers
  with `-L <name>`.

So the remote side needs no new launcher: what it needs is that a viewer's departure can never end
a server (finding 2b).

### 2. Control mode over ssh

**a. It works, typing included.** Headless, from this Mac:

```
$ ( sleep 2; echo list-windows; echo "send-keys -t remoteview-study-1:1 -l 'hello'"; sleep 3 ) \
  | ssh -tt <host> 'zsh -lc "tmux -L remoteview-study -CC attach -t remoteview-study-1"'
%session-changed $0 remoteview-study-1
%output %0 tick 23\015\012
0: counter* (1 panes) [80x24] … @0 (active)
1: second (1 panes) [80x24] … @1
%output %1 hello
```

Same on both hosts (tmux 3.4 and 3.8). In iTerm2, a window launched with
`/bin/sh <file>` whose file holds `exec /usr/bin/ssh -t <host> 'zsh -lc "tmux -L remoteview-study
-CC attach -t remoteview-study-1"'` showed each tmux window natively; the client's flags read
`control-mode,wait-exit,new-layouts,pause-after=120`, and text written into the native session
reached the remote pane (`typed-from-iterm` in `capture-pane`). The command must go through a file:
handed raw, iTerm2 splits it into words itself and the quoted remote command is lost (the first
attempt ran a plain `tmux` on the remote's default socket, see « Left behind »).

By default iTerm2 opens each tmux window as a **separate native window**, not a tab, and keeps the
gateway `ssh` tab open beside them. Tabs in one window are its preference « Open tmux windows as »
(General › tmux), the gateway hidden by « Automatically bury the tmux client session ».

**b. A viewer leaving ends an armed server.** `exit-unattached on` exits the server when its last
client goes, whoever that client is:

```
$ ssh mini 'zsh -lc "tmux -L remoteview-study-armed new-session -d -s remoteview-study-armed \"sleep 100001\""'
$ ( sleep 10 ) | ssh -tt mini 'zsh -lc "tmux -L remoteview-study-armed -CC attach -t remoteview-study-armed"' & P=$!
$ ssh mini 'zsh -lc "tmux -L remoteview-study-armed set -s exit-unattached on; tmux -L remoteview-study-armed list-clients"'
/dev/ttys009: remoteview-study-armed [80x tmux-256color] (attached,focused,control-mode,UTF-8)
$ kill -9 $P
$ ssh mini 'zsh -lc "tmux -L remoteview-study-armed list-sessions; pgrep -fl \"sleep 100001\" || echo no-sleep-process"'
no server running on /private/tmp/tmux-501/remoteview-study-armed
no-sleep-process
```

On IznoServer this is a real path to loss: the Mac attaches, the remote's own tab is closed (the
server stays up, the Mac is still attached), then the Mac's view closes, sleeps or loses the
network, and the orchestrator and its agents end. **The invariant requires the arm to be scoped to
the owner's client.**

**c. The arm can be scoped to one client.** `client-detached` gives the client leaving in
`#{hook_client}` on both versions (`set-hook -g client-detached 'set -gF @det
"#{client_tty}|#{hook_client}"'` read back `|/dev/ttys007|`). Arming with the owner's tty only:

```
$ tmux -L remoteview-study-owner set-hook -g client-detached 'if -F "#{==:#{hook_client},/dev/ttys008}" kill-server'
  (owner on /dev/ttys008, a viewer on /dev/ttys009; the viewer's ssh killed)
after-viewer-left
remoteview-study-owner: 1 windows (created Fri Nov 27 14:36:52 2026) (attached)
  (the owner's ssh killed)
after-owner-left
no server running on /private/tmp/tmux-501/remoteview-study-owner
no-sleep-process
```

Same result on IznoServer (3.4) and Minitech (3.8). The operator's order (closing the
orchestrator's own tab ends it all) holds, and no viewer can end anything by leaving.

**d. Losing the view leaves the remote untouched.** The viewer's ssh killed with `-9` (iTerm2
quit, Mac shutdown, tab closed by the process): the client is gone at once, the session runs on
(`tick 22` then `tick 24` two seconds later, on both hosts). Network loss and sleep, simulated
by freezing the transport (`ssh -o ProxyCommand='nc %h %p'`, then `kill -STOP` on `nc`: no packet,
no FIN), polled every 15 seconds for five minutes:

```
14:42:39 clients= 1 tick 431   local ssh alive: 1
14:45:57 clients= 1 tick 626   local ssh alive: 1
14:46:12 clients= 0 tick 641   local ssh alive: 0     (ssh: « Timeout, server … not responding »)
14:46:58 clients= 0 tick 687   local ssh alive: 0
```

The counter never stopped (one tick a second throughout); the stale client stayed attached until
the Mac's ssh gave up (`ServerAliveInterval 60`, three misses), whose exit took the frozen `nc`
and its socket with it. A stale control client only pauses its own output
(`pause-after=120`: « output is paused once the pane is seconds behind in control mode »); the
programs in the panes are not blocked. The remotes' `sshd_config` sets no `ClientAliveInterval`
(defaults: `#ClientAliveInterval 0`, `#TCPKeepAlive yes`), so a dead viewer's session lingers until
TCP keep-alive drops it; harmless once the arm is scoped (2c).

**e. Closing a native tmux tab asks, and one answer kills.** Closing a tmux window in iTerm2 opens
« Terminer la fenêtre et ses processus, la masquer, ou se détacher de la session tmux ? »
(Masquer / Détacher la session tmux / Terminer / Annuler, with « Mémoriser mon choix »). Terminer
sends `kill-window -t @N` to the remote; the commands iTerm2 sends are in its binary:

```
$ strings /Applications/iTerm.app/Contents/MacOS/iTerm2 | grep -E 'kill-(window|pane|session)'
kill-pane -t "%%%d"
kill-session -t "$%d"
kill-window -t @%d
```

The advanced settings `ClosingTmuxTabKillsTmuxWindows` and `ClosingTmuxWindowKillsTmuxWindows`
(« Suppress kill/hide dialog when closing a tmux tab/window ») would make the close kill without
asking: they must stay unset. During the test the window `@1` of the throwaway session was gone a
few seconds after its native window was closed (the close by AppleScript raised that dialog on the
operator's screen; he answered Annuler); a test view is now ended by killing its own ssh, never by a
close.

**f. A server can refuse those kills.** A `command-alias` named like a command replaces it:

```
$ tmux -L remoteview-study set -s 'command-alias[100]' 'kill-window=display-message refused-kill-window'
$ tmux -L remoteview-study kill-window -t remoteview-study-1:1
command display-message: too many arguments (need at most 1)
$ tmux -L remoteview-study list-windows -F '#{window_index} #{window_id} #{window_name}'
0 @0 counter
1 @2 second
```

The alias holds for every client of that server, the launcher included, so the guard needs the
launcher's own kills to go another way (see the plan, (c)).

**g. Window size.** `window-size latest` (the remotes' setting) resizes every window to the client
active last: attaching from this Mac took the windows from 80x24 to 214x56, and the remote's own
tab sees them at that size until it is used again. The hosts redraw on the resize. `smallest` would
shrink the Mac's view to the remote's console tab; `latest` is kept.

### 3. Opening automatically

- The coordinator already knows the remote orchestrators: their module sends a row, stored in
  `store/remote/<name>` (`hooks/remote-row.ts`), with the machine's short host name:

  ```
  $ ls ~/.claude-shared/orchestrator-data/store/remote
  Orch__TorrentMate        (machine IznoServer, updated 2026-11-27T13:06:26Z)
  Orch__refacto_firmware   (machine mini-tech2, updated 2026-11-27T13:26:59Z)
  ```

  It lacks two things a view needs: the home server's socket (`orch-<id>`) and an ssh destination
  (`IznoServer` is `ssh izno`; `mini-tech2` has no alias, it is `geonative@<address>`).
- **Chosen:** the row carries the socket name (8 hex characters, no path, no secret), and a file
  on this Mac maps a machine label to an ssh destination. On a row whose socket has no live view,
  the coordinator's module opens one; a view is live when this Mac's process table holds an
  `ssh … -L <socket> -CC attach` for that destination, which also rules out duplicates. After a
  reboot the first round of the coordinator reopens each view whose row is fresh. A server gone on
  the remote ends its view by itself (the attach prints `no server running` and the tab's
  process exits).
- The view runs `tmux … -CC attach` only: never `new-session`, never `-A`, so a view never starts
  a server or a program on the remote. The remote command is fixed by the opener, never built from
  a row's text beyond the socket name checked against `^orch-[0-9a-f]{8}$`.

### 4. Security

- Key authentication: every command above ran with `-o BatchMode=yes`, no password asked. No
  credential is typed, no `~/.env` value leaves the Mac.
- No port opened: one outgoing ssh per view.
- `~/.ssh/config` sets `ForwardAgent yes` for `Host *`: the view's ssh passes
  `-o ForwardAgent=no -o ClearAllForwardings=yes`, so a view lends the remote nothing.

### 5. Costs, per view

Measured on an idle view (`ps -o rss,%cpu`): on this Mac, one `ssh` of 4 MB, 0 % CPU, plus the
iTerm2 sessions (one per remote window, with their scrollback); on the remote, one `tmux -CC
attach` client of 4.7 MB and one `sshd-session` pair of 21 MB, 0 % CPU. The output each pane
writes crosses the network once per view.

## Design

1. **On each remote, a viewer can never end a server**: the home server's arm becomes the
   `client-detached` hook scoped to the owner's tty (2c), in place of `exit-unattached on`. The
   remote's own tab keeps its meaning; a view, a lost view or a stale one changes nothing.
2. **Kills from a view are refused on the remote**: home servers alias `kill-window`, `kill-pane`
   and `kill-session` to a refusal (2f), and the launcher kills through a path the alias does not
   cover. Closing a tab on the Mac then hides it at worst, whatever is clicked.
3. **The Mac opens the views itself**: the remote row carries its socket; the coordinator's module
   opens one iTerm2 window per remote home server, `ssh -t <dest> 'zsh -lc "tmux -L <socket> -CC
   attach -t home"'` through a launch file, without taking focus, and reopens it after a reboot,
   never twice.
4. **The operator's iTerm2 is set once** (his consent): tmux windows as tabs of the attaching
   window, the gateway buried, and the close dialog answered « Masquer » with « Mémoriser mon
   choix ».

## Alternatives set aside

- **A view through a grouped session** (`new-session -t home`): windows are shared by the group, so
  `kill-window` from the view still kills the remote window, and a new session is something the
  view starts on the remote.
- **A read-only attach** (`attach -r`): safe, but nothing typed reaches the remote; he asked to work
  there as here.
- **A plain `ssh -t … tmux attach`** (no `-CC`): one tab with tmux's own bar, not native tabs; a
  fallback where iTerm2 is not the terminal.
- **Leaving remote servers disarmed** (`exit-unattached off` everywhere): drops his order that
  closing an orchestrator's own tab ends it.
- **Suppressing iTerm2's close dialog** (`ClosingTmuxTabKillsTmuxWindows`): it suppresses it toward
  Kill.
- **ssh polling of the remotes for `orch-*` sockets**: works without a row, but costs an ssh per
  host per round and learns nothing the row does not already bring.

## Plan of pull requests

| | Pull request | Size | Risk | E2E |
|---|---|---|---|---|
| (a) | `fix(orchestrator)`: a home server's arm scoped to its owner's client (`client-detached` hook on the tab's tty, in `arm_home`; `home-release`, `close`, `iterm_restart.py` read and clear the hook instead of `exit-unattached`) | M | High: every home server's end goes through it | `tests/tmux-e2e.sh`: an owner and a second client on a throwaway server; the second leaves, the server lives; the owner leaves, the server ends |
| (b) | `feat(orchestrator)`: remote views — the row carries its socket; a machine-to-destination file; the coordinator's module opens, deduplicates and reopens one window per remote home server | L | Medium: new process on this Mac, nothing on the remote | a fixture remote row and a local throwaway server reached by `ssh localhost`, the view opened once, reopened after its process is killed, never twice |
| (c) | `feat(orchestrator)`: home servers refuse `kill-window`, `kill-pane`, `kill-session` from their clients (command aliases in `home.conf`), the launcher's own close moved to an unaliased path | S | Medium: the launcher's close and takeover change path | `tests/tmux-e2e.sh`: a client's `kill-window` refused, the launcher's `close` still ends its window |
| (d) | `docs(orchestrator)`: the README's « Where agents run » gains the remote views, the iTerm2 settings to set once, and what a view never does | S | Low | none: documentation |

Order: (a) before (b), since a view opened on an armed remote is the loss of 2b; (c) is
independent.

## Questions for the operator

1. **The close dialog.** Recommended: answer it once « Masquer » with « Mémoriser mon choix »; the
   remote guard (c) covers a « Terminer » anyway.
2. **Tabs or windows.** Recommended: « Open tmux windows as: tabs in the attaching window », the
   gateway tab buried, so one window per remote orchestrator holds it and its agents.
3. **Which machines.** Recommended: IznoServer (`izno`) and Minitech (`geonative@<address>`), in a
   file of this Mac, the coordinator opening every orchestrator they run.

## Left behind

- On Minitech, the default tmux socket holds a session `0` (one idle `zsh`, created 14:37 CET), made
  by the first, badly quoted attach. Its removal (`tmux kill-session -t 0`) was refused to this
  session and is the operator's to order.
- Throwaway servers, ended by name at the study's end: see the report.
