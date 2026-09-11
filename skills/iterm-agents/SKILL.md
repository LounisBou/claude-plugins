---
name: iterm-agents
description: Use when a session on macOS must manage iTerm2 tabs running agent sessions — spawn a fresh agent tab with a startup prompt and verify it is running, close a stood-down agent's tab, list sessions, place a tab next to another, or replace a context-saturated agent with a fresh one (rotation).
---

# iTerm agent tabs

## Overview

`${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh` drives iTerm2 through the app's own API so an orchestrator can spawn, verify, close, move and rotate implementer sessions without the user touching the keyboard. The launch is HANDED to the app, never typed into a shell. Closing a tab KILLS its session — treat close as destructive and follow the safety order below. **Spawning is the orchestrator's act, not the user's**: the brief is written, the session is spawned in the same move, and the spawn is verified on the process, never on the script's word.

## Quick reference

```bash
SCRIPT=${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh

$SCRIPT list
    # w1/t3 | /dev/ttys000 | ✳ chaining the PRs | Orch : plugin family | self
    # w1/t4 | /dev/ttys004 | ◐ reading the brief | Agent : phase 2
    # w1/t5 | /dev/ttys007 | ◐ Chat | (host default) | hidden   ← behind a maximized sibling pane
    # tab title, then the session's NAME (its --name, `(host default)` when it was launched
    # without one), then `self` on YOUR OWN tab. Read self before you anchor, move or close.

$SCRIPT spawn --dir <workdir> [--tier deep|standard|light | --inherit-model] [--permission-mode auto] \
    --title "Agent : <subject>" --prompt "Read and execute <brief-path>. Your orchestrator is <name [ref]>." [--right-of self | --successor] [--mcp <name>]
    # --title has a SHAPE — `Orch : <subject>` for an orchestrator and its successor,
    # `Agent : <subject>` for anything you spawn, the subject at most 25 characters —
    # because it is the session's name in every listing and the operator reads that listing.
    # Anything else is refused; `--title-free` is the escape for a probe that names its tab
    # otherwise, and only under `--title-free` does no title mean `agent` — without it, a
    # spawn with no title is refused.
    # The session's servers are CHOSEN. The launch is always strict, and carries a file
    # the launcher writes for that session from the operator's catalogue,
    # <state dir>/mcp.json (ORCHESTRATOR_MCP_CATALOGUE overrides the path): named
    # definitions in the host's own shape, and a `default` list every agent gets.
    # --mcp <name> adds a catalogued server for the agent that needs it — repeatable,
    # or comma-separated — and --mcp none gives the session no server at all. A name the
    # catalogue does not hold is refused before a tab exists, naming the ones it holds;
    # with no catalogue at all a plain spawn launches with nothing and says so on stderr.
    # Say in the agent's brief which servers it was given: it cannot see the file.
    # An agent comes up with remote control off; only a successor comes up under it (§39).
    # The spawn then reads the mode the session came up in, on its own transcript, and
    # refuses a session that came up in another one — closing the tab it just made and
    # naming both modes, the model, and the two repairs: rebind the tier, or pass
    # --permission-mode acceptEdits for an agent that only edits. A transcript that has
    # not appeared within ORCHESTRATOR_MODE_TIMEOUT (20s) lets the launch through and says
    # the mode is unread. --no-verify skips it, with the CLI check.
    # writes the prompt to a file under the plugin's state directory, writes the launch
    # to a second file, asks the app to run it in a new tab AT AN INDEX, WAITS until the
    # host CLI is running on the new tty (30 s, ORCHESTRATOR_SPAWN_TIMEOUT), and prints
    # the tty on its last line. `--prompt-file <path>` uses a file you already wrote.
    # --inherit-model types the calling session's current model (from the context tap); for a successor.
    # --tier resolves through the operator's map (<state dir>/models.json, or
    # ORCHESTRATOR_TIER_DEEP/_STANDARD/_LIGHT). An unbound tier and no --tier at all both
    # type no model argument: the host chooses. `resolve-tier <tier>` prints the binding.
    # --successor: the new session takes yours — immediately right of you, chain ignored, your chain handed to it (§34).
    #   With no --title it takes YOUR OWN name, read from the process table, so every brief
    #   that cites you still cites it; and it comes up under remote control under that name
    #   (--no-remote-control drops that). A session the older launcher named carries its
    #   prompt in its own process line, so the derivation refuses it and the title is typed
    #   by hand instead, and so is a name under an older convention, which no longer
    #   derives. An `Orch :` title with --right-of/--left-of
    #   is refused: a plain anchor lands after your chain, which is not a successor's place.

$SCRIPT verify --tty /dev/ttysNNN
    # succeeds with the pid when the host CLI runs on that tty; exit 1 otherwise

$SCRIPT screen --tty /dev/ttysNNN [--lines 40]
    # what that tab is showing right now — how you inspect an agent that has not
    # shaken hands, instead of waiting for one that is stopped on a question.
    # the last N lines, trailing blanks dropped: a tall terminal is blank at the top and
    # the prompt an agent is stopped on sits at the bottom.

$SCRIPT close --tty /dev/ttysNNN --expect-title <substring>
    # tty-exact; refuses if the session's current title does not contain the substring

$SCRIPT move --tty /dev/ttysNNN (--right-of self | --right-of /dev/ttysMMM | --left-of /dev/ttysMMM) [--force]
    # places a tab immediately beside another (same window); idempotent, verified after the move.
    # `self` is the calling session's own tty, found by walking up the process tree.
    # Refuses a --tty that is neither your own tab nor one of your chain: a session you did
    # not launch is not yours to place. --force moves it anyway and says so on stderr.

$SCRIPT rotate --dir <workdir> --old-tty <tty> [--trust] [--tier <tier>] [--expect-title <s>] \
    [--title <t>] [--prompt <text> | --prompt-file <path>] [--right-of self | --left-of <tty>] [--mcp <name>]
    # spawns the replacement FIRST and verifies it is running, then closes the old tab
    # every argument it does not consume reaches the spawn, `--trust` and `--mcp <name>`
    # included: an agent that needed a server is replaced by one that still has it.

$SCRIPT trust prune [--apply]      # entries of the trust record whose directory is gone; --apply removes them
```

`ORCHESTRATOR_DRY_RUN=1` makes `spawn`, `close` and `move` print what they would ask the app for — the launch, the prompt file, the anchor — touching no terminal. It is the test suite's door, and yours when a launch looks wrong; `rotate` walks its whole order through it.

## Tab layout convention

**The orchestrator's tab sits immediately LEFT of its implementer agent's tab.**

A plain `spawn` appends at the FAR RIGHT of the window. That is beside the orchestrator only when the orchestrator happens to be the last tab — in a window that also holds unrelated sessions, the new agent lands past them and the layout is silently wrong. Observed: an agent spawned two tabs away from its orchestrator, with a stranger's session between them, because the plain form was read as « fine for an agent ».

So **always name an anchor**, and name the one you actually know:

- spawning an implementer: `--right-of self` — after your LAST still-open agent, or your own tab when you have none. The launcher keeps the chain (`chains/<your tty>.jsonl` under the state directory) and the order reads left to right as launch order: you, agent 1, agent 2, … A closed agent leaves the chain; a tty is never trusted across a close, the chain is checked on the app's tab id, and on the session that wrote the entry — a tty is recycled and its chain file outlives its occupant, so a new session on an old tty reads only its own entries.
- spawning your successor: `--successor` — immediately right of your own tab, the chain ignored, so it lands between you and your first agent; the launcher hands it your chain (your agents' entries move under its tty and session) and writes it into no chain, because a successor is not an agent. It closes your tab once the takeover is confirmed and ends up immediately left of your first agent, and its `--right-of self` resolves to your last agent from then on.
- `--left-of <tty>` remains for the case where the anchor you know is on the other side.
- `move` repairs the layout after the fact, with the same three forms.

## Safety order for a launch

1. The brief exists at a path the fresh session can open on this machine.
2. `spawn` with the one-line prompt naming the brief's path and the orchestrator's exact `ListAgents` name and reference — nothing the brief already says — and with `--right-of self`, so the tab lands beside yours rather than at the end of a window you do not own.
3. Read the result: the script has already waited for the host CLI on the new tty, but the artifact decides — `list` (the tab), `verify --tty` (the process), `ListAgents` (the peer session, a few seconds later).
4. **No startup dialog may stand between the launch and the brief.** Two are known: the workspace-trust question, refused before the tab exists unless `--trust` says the directory is one you prepared; and the question about servers. The launch is strict and carries a configuration file written for that session, so the host asks nothing and loads exactly what the file names — the catalogue's default set, plus whatever `--mcp` added; a fresh session parked on « enable these MCP servers? » never reads its brief and nobody sits at that keyboard. Any other startup question the launch cannot pre-answer (a trust prompt, a migration notice) is read in the tab's contents and answered by the orchestrator through the tab — a session stuck on a dialog is not launched, whatever the script printed.
5. Wait for the handshake. An agent that has not messaged within minutes is inspected, not waited for: `verify` for the process, `list` for the tab, and the tab's own screen through the app if you need to read what it is stuck on.

## Tab hygiene

**A finished agent's tab is closed, not left open.** The approval that closes a phase stands the agent down and closes its tab in the same move (`list`, `close --tty --expect-title`, `ps`). An implementer stays through the review round of its own delivery and the N-bis that round produces, and is stood down at the verdict; there is no « standing by » tab after it: a later fixup goes to a fresh session with a resume brief, which costs one cold start and keeps the window readable. The only tabs open at any time are the orchestrator's and its running implementers'.

**One agent = one tab, never a pane.** A pane shares a tab's title and its fate; the tooling closes sessions, but a layout the operator reads is not a place to put an agent.

## Safety order for a live rotation

1. The old agent must have STOOD DOWN (message it; wait for its acknowledgment) — never close a tab whose session may still be writing. **In a rotation this acknowledgment IS the guard**, not the title.
2. `list` to confirm the tty is the one you mean.
3. `rotate`, which spawns the replacement and verifies it is running before the old one is gone. **Do not pass `--expect-title` to a rotation.** A rotation spends ten seconds bringing up the replacement, and a working session rewrites its own title to say what it is doing: a title read before the spawn and compared after it is a string that was true a moment ago. Refusing on it turned a safeguard into a rotation that never completed. The tty is the identity; a stood-down agent that acknowledged is what makes closing it safe.
4. Verify with `list` (the old tab gone, the new one present) AND `ListAgents` (new peer session visible, old one gone) before reporting the rotation done.

`--expect-title` remains right for a STANDALONE `close`, where you read the title from `list` seconds before and nothing runs in between.

## Caveats (all observed)

- **A directory the host has never opened stops the session on a workspace question**, whose
  highlighted answer is « exit ». Nobody sits at that keyboard: the session waits for ever
  having never read its brief, or takes a stray keystroke and quits — and from outside both
  look like a launched agent, because the process genuinely runs. `spawn` refuses such a
  launch before making a tab, and `--trust` records the answer for ONE directory, which is
  right for a checkout the orchestrator prepared itself and wrong for anything else. The
  record is the host's own, `~/.claude.json`, and writing to it is why the flag is explicit
  rather than automatic. It never rewrites an entry that already says yes, and a record it
  cannot read is said on stderr rather than launched past in silence; entries outlive their
  directories — `trust prune` lists them, `--apply` removes them.
- **A spawn never takes the operator's focus.** The tab is created unselected: someone is
  working in another tab, and a launch that pulls the window across interrupts them every
  time an agent starts.
- **A tier nobody bound is not an error.** `spawn` then types no model argument and the host
  applies its default, so a half-filled map never silently routes deep work to a cheap model —
  it routes it to whatever the operator's host already runs. Read the map with `resolve-tier`
  before dispatching a wave, not after it comes back wrong.
- **The tab gets no login shell, so it gets no PATH of yours.** The app runs the launch as
  the session's program. The first live spawn through this path died instantly and reported
  a tty belonging to nothing, because the CLI lives in a package manager's bin directory that
  a bare default PATH does not contain. The launch names the CLI by ABSOLUTE path, resolved
  from the orchestrator's own environment.
- **The app splits the command into words itself.** A compound command handed over raw is run
  by no shell at all. The launch goes to a FILE and the app is asked to run `/bin/sh <file>`:
  a path has no quoting, and quoting for someone else's tokenizer is the losing game the
  typed version already played.
- **A window's tab list is a cached copy.** Read a reorder back through the object you already
  held and it looks like a reorder that never happened — or reports the position the tab used
  to have. Re-fetch the app after any mutation.
- **The title is the session's name, and the launcher holds it to the shape.** `--title` is passed to the host as the session's name (shown in its prompt, its resume picker, the terminal title, and applied with a variant when a live session already holds it), so it reads `Orch : <subject>` for an orchestrator and its successor or `Agent : <subject>` for anything an orchestrator spawns — an implementer, a review session, a comments agent, a probe, the subject saying which and at most 25 characters — and anything else, the spelled-out roles of the older convention and the old bare `agent` included, is refused before a tab exists. A successor spawned with a typed name once came up as that name in every listing while the house format was nowhere. `--title-free` is the escape and the dry run says when it is on. The tab title still reflects the session's current task for `--expect-title`: read it from `list` seconds before closing.
- **A fresh tab is titled « Chat » before the session names itself.** The host's own first title stands for a few seconds, so a `list` taken immediately after a spawn shows it in the title column while the name column is already right — which is the column to read when you are looking for a session rather than for what it is doing.
- **`move` places what is yours, and `list` says which tab that is.** An orchestrator launched by hand had never measured its own tty, read the listing, took the last tab for its own and moved a stranger's session out from between itself and its agents; the script obeyed, because `move` moved anything it was told to. It now refuses a tty that is neither your own tab nor one of your chain, and `list` marks your row `self`. `--force` is the operator's hand and the layout repair, and it says on stderr what it moved.
- **The tab is born in the anchor's window, whichever window is in front.** With two windows open, a
  spawn anchored on a tab of the second once landed at the end of the first — the window in front —
  and reported success. The anchor is now searched across every window, and an anchor that is not
  there is refused before a tab exists (`spawn: no session found on <tty>`). A spawn with no anchor
  still appends to the window in front: that is one more reason to always name one.
- **The tab runs the launch through a login shell** (`ORCHESTRATOR_LOGIN_SHELL`, else `SHELL`, else `/bin/zsh`), so the agent inherits the operator's PATH, the package manager's binaries included. Before that, no spawned session could run `gh`: the app hands a program run directly a bare default PATH. The CLI is still named absolutely inside the launch, so a profile that breaks PATH cannot kill it.
- **The first character of a title is an activity glyph, and it flips on its own** — one shape
  while the session works, another once it idles. `--expect-title` compares titles with that
  glyph stripped from both sides, because a rotation stands the old agent down and then spends
  ten seconds bringing up its replacement: a title captured before and compared after is
  guaranteed to differ, and the guard written to make a close unambiguous refused every
  rotation instead. Match on words, never on the glyph.
- **tty numbers are recycled**: a freshly closed `/dev/ttys000` can be reassigned to the next
  spawned tab. Never reuse a stored tty across a close — re-`list` every time.
- **The app's API must be enabled** (Preferences > General > Magic > Enable Python API), and the
  first connection asks macOS for permission once. `move` needs no Accessibility grant any more,
  does not bring the app to the front, and flickers no focus: the menu-driven version did all three.
- **The environment is the installer's, not yours.** `/orchestrator:install` builds it under the
  state directory; recent macOS refuses to install into a package-managed interpreter, and a
  plugin has no business writing into one it did not create. Without it the tooling refuses to
  run and says how to build it. `ORCHESTRATOR_PYTHON` overrides the choice.
- The spawned session takes a few seconds to appear in `ListAgents`; `list` shows the tab
  immediately, `verify` the process as soon as the CLI has started.
- **Verify a close with `list` + `ps`, not with the exit code**: the artifact, not the message,
  says whether the session is dead. A killed session leaves its process visible for a second or two.
- Prompt and launch files accumulate under the state directory's `prompts/`; they are small and
  they are the record of what each session was launched with. Delete a wave's when its review is
  closed, like any other artifact you produced.
- **A pane behind a maximized sibling is still a session, and it is listed as `hidden`.** The
  host extension's « Chat / Diff / Code Review » bar opens each view as a sibling pane of the
  agent's tab and maximizes the one shown, so an agent with a review open is hidden and its
  tab shows the review. The tool reads hidden panes like visible ones; `close --tty` closes
  that SESSION alone and leaves the review pane and the tab. Before this, a hidden agent was
  unfindable and unclosable while `ListAgents` showed it alive.

## Common mistakes

- Handing the user a brief path and an invocation to paste: the orchestrator spawns.
- Trusting the printed tty: the process on it is the fact; `verify`, `list`, `ListAgents`, then the handshake.
- Closing by title alone or by tab position: only `--tty` + `--expect-title` is unambiguous.
- Spawning without an anchor and assuming the tab landed beside you: it lands at the end of the window. Pass `--right-of self`.
- Spawning into a directory the host has never opened, and reading the running process as a launched agent: it is stopped on a question, and `screen --tty` is how you see that.
- Rotating before the old agent acknowledged stand-down: risks killing an uncommitted write, and the acknowledgment is the rotation's only real guard.
- Reading « alive in ListAgents, absent from list » as a dead session: it was the hidden-pane defect, fixed in 0.21.1; if it recurs, it is a new defect to measure, not a rule.
- Passing `--expect-title` to a rotation: the title will have moved by the time the close runs, and the rotation simply never completes.
- Storing a tty and using it after any close happened in between (recycling).
