---
name: iterm-agents
description: Use when a session on macOS must manage iTerm2 tabs running agent sessions — spawn a fresh agent tab with a startup prompt and verify it is running, close a stood-down agent's tab, list sessions, place a tab next to another, or replace a context-saturated agent with a fresh one (rotation).
---

# iTerm agent tabs

## Overview

`${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh` drives iTerm2 through the app's own API so an orchestrator can spawn, verify, close, move and rotate implementer sessions without the user touching the keyboard. The launch is HANDED to the app, never typed into a shell. Closing a tab KILLS its session — treat close as destructive and follow the safety order below. **Spawning is the orchestrator's act, not the user's**: the brief is written, the session is spawned in the same move, and the spawn is verified on the process, never on the script's word.

Its commands are `list`, `spawn`, `verify`, `screen`, `close`, `move`, `rotate`, `resolve-tier` and `trust prune`. **Before typing any of them, read `references/commands.md`** — each command's synopsis, flags and refusals, and how the launcher builds a tab; **when one fails, hangs or says on stderr that a fallback served it, read its « When iTerm2 does not answer »**. `references/incidents.md` tells, by rule id, the incident behind a rule — read it when a rule's reason is in question.

## Reading the tabs

`list` prints each tab's title, the session's name, and `self` on your own tab. Read self before you anchor, move or close.

- **tty numbers are recycled**: a freshly closed `/dev/ttys000` can be reassigned to the next spawned tab. Never reuse a stored tty across a close — re-`list` every time.
- **A fresh tab is titled « Chat » before the session names itself.** The host's own first title stands for a few seconds, so a `list` taken immediately after a spawn shows it in the title column while the name column is already right — which is the column to read when you are looking for a session rather than for what it is doing.
- The spawned session takes a few seconds to appear in `ListAgents`; `list` shows the tab immediately, `verify` the process as soon as the CLI has started.

## An agent is an iTerm2 tab, always

A session that is not a tab in the window the operator reads is not an agent he can see, place or close, and a launcher that hands him one has hidden the fault rather than repaired it. **Never spawn an agent outside iTerm2** — not through tmux, not through `screen`, not by hand. When both rungs are down, the app itself is wedged, and that has a one-keystroke remedy: the launcher names it and stops. Stopping loudly on a fault whose remedy is known IS the repair.

**One agent = one tab, never a pane.** A pane shares a tab's title and its fate; the tooling closes sessions, but a layout the operator reads is not a place to put an agent.

## Tab layout convention

**The orchestrator's tab sits immediately LEFT of its implementer agent's tab.**

A plain `spawn` appends at the FAR RIGHT of the window. That is beside the orchestrator only when the orchestrator happens to be the last tab — in a window that also holds unrelated sessions, the new agent lands past them and the layout is silently wrong.

So **always name an anchor**, and name the one you actually know:

- spawning an implementer: `--right-of self` — after your LAST still-open agent, or your own tab when you have none. The launcher keeps the chain (`chains/<your tty>.jsonl` under the state directory) and the order reads left to right as launch order: you, agent 1, agent 2, … A closed agent leaves the chain; a tty is never trusted across a close, the chain is checked on the app's tab id, and on the session that wrote the entry — a tty is recycled and its chain file outlives its occupant, so a new session on an old tty reads only its own entries.
- spawning your successor: `--successor` — immediately right of your own tab, the chain ignored, so it lands between you and your first agent; the launcher hands it your chain (your agents' entries move under its tty and session) and writes it into no chain, because a successor is not an agent. It closes your tab once the takeover is confirmed and ends up immediately left of your first agent, and its `--right-of self` resolves to your last agent from then on.
- `--left-of <tty>` remains for the case where the anchor you know is on the other side.
- `move` repairs the layout after the fact, with the same three forms, plus `--leftmost` for the first place of a window — but for `move`, `self` is your own tab, never the end of your chain: `move --tty <tty> --right-of self` puts that tab immediately right of yours, `move --tty <tty> --leftmost` puts it at the first place of its window; it places only what is yours, `self` or your chain; any other tab needs `--force`.

## Safety order for a launch

1. The brief exists at a path the fresh session can open on this machine. Say in the agent's brief which servers it was given: it cannot see the file.
2. `spawn --brief <path> --orchestrator "<name [ref]>"`, with `--right-of self` so the tab lands beside yours rather than at the end of a window you do not own. `--brief` lints the brief before any tab exists; a finding no longer refuses the spawn, it prints as a warning on stderr and the launch goes on, prompt built either way — the brief's path and your exact `ListAgents` name and reference, nothing the brief already says. You never hand-build that prompt. A startup prompt is not optional: `spawn` (and `rotate`, which spawns) refuses, before any tab is made, a launch carrying none of `--brief`, `--prompt` or `--prompt-file` — the host writes no transcript before a first prompt, so a promptless session's mode could never be read.
3. Read the result: the script has already waited for the host CLI on the new tty, but the artifact decides — `list` (the tab), `verify --tty` (the process), `ListAgents` (the peer session, a few seconds later).
4. **No startup dialog may stand between the launch and the brief.** Two are known: the workspace-trust question, refused before the tab exists unless `--trust` says so — right for a checkout you prepared yourself and wrong for anything else; and the question about servers. The launch is strict by default and carries a configuration file written for that session, so the host asks nothing and loads exactly what the file names — the catalogue's default set, plus whatever `--mcp` added; a fresh session parked on « enable these MCP servers? » never reads its brief and nobody sits at that keyboard. `--account-connectors` drops strict for that one spawn so it also loads every connector of the operator's account — not one of them, all of them — and the launch pre-answers the project's own server dialog for it too, so it never parks on that question either; off unless asked, and the default launch is unaffected. Any other startup question the launch cannot pre-answer (a trust prompt, a migration notice) is read in the tab's contents and answered by the orchestrator through the tab — a session stuck on a dialog is not launched, whatever the script printed.
5. Rely on that verification and on the host's idle notice, not on a first message. An agent idle before its work is reported is inspected, not waited for: `verify` for the process, `list` for the tab, and `screen --tty` for what that tab is showing right now — how you tell an agent stopped on a question from one at work.

**A tier nobody bound is not an error.** `spawn` then types no model argument and the host applies its default, so a half-filled map never silently routes deep work to a cheap model — it routes it to whatever the operator's host already runs. Read the map with `resolve-tier` before dispatching a wave, not after it comes back wrong. When the tier the work needs is unbound, the orchestrator picks the model it judges fit (`--model <name>`, or the host's default on purpose), writes the choice and its reason in the brief, and tells the operator in one line at the spawn (`orchestrator:model-routing`).

## Tab hygiene

**A finished agent's tab is closed, not left open.** The approval that closes a phase stands the agent down and closes its tab in the same move (`list`, `close --tty --expect-title`, `ps`). An implementer is stood down at the verification of its delivery, never kept through its review round, unless its next phase is dispatched to it at that verification; a review finding goes to a fresh session with a resume brief, which costs one cold start and keeps the window readable. The only tabs open at any time are the orchestrator's and its running implementers'. `close --tty` on a hidden agent closes its session alone — its tab and its review pane stay open (`references/commands.md`, the hidden-pane entry).

**A tab is closed by its tty with `--expect-title`, never by title alone or by tab position** — the title read from `list` seconds before (« Safety order for a live rotation » says why a rotation takes none). The first character of a title is an activity glyph that flips on its own. Match on words, never on the glyph.

**A close is proved on the process table, never on the app's acknowledgement.** The API answering a close request says the request was TAKEN, not that the session is gone. Verify a close with `list` + `ps`, not with the exit code: the artifact, not the message, says whether the session is dead. A killed session leaves its process visible for a second or two.

Prompt and launch files accumulate under the state directory's `prompts/`; they are small and they are the record of what each session was launched with. Delete a wave's when its review is closed, like any other artifact you produced.

## Safety order for a live rotation

1. The old agent must have STOOD DOWN (message it; wait for its acknowledgment) — never close a tab whose session may still be writing. **In a rotation this acknowledgment IS the guard**, not the title.
2. `list` to confirm the tty is the one you mean.
3. `rotate`, which spawns the replacement and verifies it is running before the old one is gone. **Do not pass `--expect-title` to a rotation.** A rotation spends ten seconds bringing up the replacement, and a working session rewrites its own title to say what it is doing: a title read before the spawn and compared after it is a string that was true a moment ago. Refusing on it turned a safeguard into a rotation that never completed. The tty is the identity; a stood-down agent that acknowledged is what makes closing it safe.
4. Verify with `list` (the old tab gone, the new one present) AND `ListAgents` (new peer session visible, old one gone) before reporting the rotation done.

`--expect-title` remains right for a STANDALONE `close`, where you read the title from `list` seconds before and nothing runs in between.

## Common mistakes

- Handing the user a brief path and an invocation to paste: the orchestrator spawns (Overview).
- Trusting the printed tty: launch steps 3 and 5.
- Closing by title alone or by tab position: « Tab hygiene ».
- Spawning without an anchor: « Tab layout convention ».
- Reading a process that runs in a directory the host never opened as a launched agent: it is stopped on a question — launch steps 4 and 5.
- Rotating before the old agent acknowledged stand-down, or passing `--expect-title` to a rotation: rotation steps 1 and 3.
- Storing a tty and using it after any close happened in between: « Reading the tabs ».
