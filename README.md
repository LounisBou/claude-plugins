# claude-orchestrator

One session supervises implementer sessions instead of writing code itself:
it writes their briefs, reviews every delivery on the artifact rather than on
the report, rotates saturated agents, and hands over to a successor before its
own judgment degrades. This plugin packages that method, the terminal tab
tooling it needs on macOS, the briefs as templates, and a context gauge any
session can read without depending on a particular status bar.

## What you get

| Piece | What it does |
|---|---|
| skill `orchestrator` | The rulebook: phase and PR rules, the agent prompt recipe, the agents' lifecycle (the orchestrator launches, verifies, controls, terminates and replaces them), review on evidence, review rounds run in disposable sessions, what a round costs and the three ways to shorten it, context rotation, the orchestrator's own succession, shared-machine discipline. Its `workspace.sh` makes a clone per phase (`create`) and a pinned worktree per review round (`pin`, `--pr <n>` recording the pull request it reviews), deletes either together with the host's temporary directory it used (`delete`), and sweeps the leftovers whose pull request is merged or closed (`sweep`) — never a dirty tree, unpushed commits, a pin whose head is on no branch, or a directory a live process works in. |
| skill `iterm-agents` | `list`, `spawn`, `verify`, `resolve-tier`, `close`, `move`, `rotate` iTerm2 tabs running agent sessions, through the app's own API rather than by typing into a shell. Placement anchors on a tty or on `self` — after the caller's last open agent, so a window reads as launch order. The prompt goes to a file and the typed command stays short; the tab runs the launch through the operator's login shell, so the agent inherits the full PATH; spawn waits for the host CLI on the new tty and fails loudly otherwise; tty-exact close with a title guard, which also deletes the stood-down session's checkout once its process is proved gone (`--keep-checkout` opts out); spawn-and-verify before close on rotate. |
| skill `model-routing` | Which model/effort pair a dispatch gets: pay for judgment nothing downstream re-checks. A table by class of work, five readings for the cases off the table, escalation as a rotation, and the false-economy rule. Dispatches run on a measured model/effort pair, picked from the most specific table that has one. Its `routing.py` measures what a session cost, benches a project's merged pull requests on a grid of pairs, and calibrates a table per project, then per profile and globally. Measured tables stay in the operator's state directory and name models; only tier/effort defaults ship in the plugin. |
| skill `coordination` | The coordinator's role, outside every orchestration on one machine: answers from the facts, flags collisions to both sides, gates nothing, relays to the operator what is his. The orchestrator's and the auditor's skills say nothing of it. |
| `templates/` | Phase brief, rotation resume brief, orchestrator succession brief, review-agent brief, comments-agent brief, audit brief, with the sections the rulebook makes mandatory. |
| script `rhythm.sh` | An audit's net balance read from git alone: merges per week by conventional-commit type, and lines added and removed under product globs against instrument globs. |
| `/orchestrator:install` | Creates the state directory, unwires any tap a previous install left in front of your status line, and prunes what the tap left behind. Idempotent; refuses a host older than 2.1.287. |
| `/orchestrator:uninstall` | Restores the previous status line and removes the state directory. |
| `/orchestrator:status` | Live sessions and their context fill, the ones past the gate flagged. |
| `/orchestrator:supervision` | Opens the supervision pane, kept on screen with each session's fill and redrawn every 20 seconds while open: the orchestrators in a coordinator session (`Coord :`), its own agents in an orchestrator session (`Orch :`). Only when typed: no session opens it on its own; typed again, it closes it. |
| `/orchestrator:succeed` | Runs the orchestrator succession. |
| module gate `prompt.submit` | The context gate enforced in-process by the hooks module: at or past 300,000 tokens (30 %) on a window of 1,000,000 tokens or more, the common case, and 80 % of a smaller window (`ORCHESTRATOR_CONTEXT_GATE`, `ORCHESTRATOR_CONTEXT_GATE_TOKENS`, `ORCHESTRATOR_LARGE_WINDOW`), every prompt of an orchestration session (named `Orch :`, `Agent :`, `Audit :` or `Coord :`) carries the line fitted to its role — succeed, or finish the unit and stop; unmeasured, it says so once. A session with no role name — started by hand and never renamed — gets neither line. A change of the model answering a session is said to the model in front of its next prompt, in every session. |
| module gate `tool.call` (Bash) | The push guard enforced in-process by the hooks module, in sessions the launcher spawned only: a `git push` that forces is refused unless its lease is pinned (`--force-with-lease=<branch>:<sha>`); the operator's own sessions are untouched. |
| hook `Stop` | The stop gate enforced in-process by the hooks module, in an orchestrator's session only (its name, launched or renamed, starts with `Orch :`): the stop is refused, at most once per turn, unless something will wake the orchestrator — a busy agent of its own, a `ci-watch.sh` it started still running, a blocking question declared on the message's last line (`waiting: operator — blocks: <what it blocks>`, honoured before an idle agent's stand-down is asked), or `waiting: done` with nothing left (no checkout, no agent, no open dispatch-record row) — or it has handed over: its last line `handed over`, or `waiting: done` once its successor's spawn succeeded or its `end_session` was accepted. Short of a declared blocking question, an idle agent of its own whose pull request is open or merged refuses the stop until it is stood down. Then each watched pull request of the session's repository whose ci-watch log shows checks pending or failing refuses the stop with the real state, once per watch (keyed on its log's first line): pending once, failing once per failing set — one with a `ci-watch.sh` process alive for it excepted, since that watch will wake the orchestrator. When its checks let the stop pass, it also runs `workspace.sh sweep` within what is left of its deadline, at most once per ten minutes, and logs each deletion. Its own failures let the stop pass and are logged in the module's log. |
| `/orchestrator:agents` | The running implementer agents with their measured context, the most urgent first, answered by the hooks module without a model turn; the ask of each agent and its verification on the artifact are the command body's steps, run by hand or when that answer fails. |
| `/orchestrator:progress` | The dispatch rows still open and the record's tally, answered by the hooks module without a model turn; the full report — done, in flight, remaining, decisions pending, the orchestrator's own context — is the command body's steps, run by hand or when that answer fails. |
| `/orchestrator:decide` | Runs a decision round with the user: every open question back to back, one per message — context, choices with their cost, one recommendation — each ruling recorded at once; the rulings are relayed and the work launched when the wave ends, and a second wave is chained at once if the work raises new questions. |
| `/orchestrator:audit` | Launches, on the operator's word, an audit of the method: a session in a tab titled `Audit : <subject>`, beside the caller, on its model and under remote control, in no chain. It reads the stock — what the method has in place, what it costs, what it has yielded — and the net balance of product against instruments, then writes one report of at most five proposals, each « remove X » or « restore Y » with its expected gain and the figure that will check it. It tells the operator and stops: it orders nothing, applies nothing and messages no session. The operator decides, and closes its tab. |
| `/orchestrator:coordinator` | Starts, on the operator's word and in a session he opened, the machine's coordinator, for when he runs several orchestrations at once: a session outside every one of them, in the leftmost tab, titled `Coord : <subject>`. It tells each orchestrator it exists and may be asked, and asks each once to confirm the pull requests the facts give it. It reads the sessions, checkouts, heavy runs and open pull requests now, answers « whose pull request is this », « is anyone on this branch or file », « may I or must I wait » from them, flags a collision to both sides, relays to the operator what is his, carries his orders to all, and gates nothing. At the gate it hands over to its own successor. |
| `/orchestrator:coordinator-end` | Ends the coordinator on the operator's word only: every orchestrator is told, and the record is cleared, proved by a lookup that prints nothing. |

## Tests

`./tests/run-tests.sh` runs everywhere: no network, no terminal automation, isolated home
per case. `./tests/e2e.sh` plays one real round against a live terminal — a brief, a
session at a tier, a placed tab, a verified close — and is kept out of the default suite on
purpose, because it costs tokens and needs the app running.

## Install

```
/plugin marketplace add LounisBou/claude-plugins-marketplace
/plugin install orchestrator@lounisbou
/orchestrator:install
```

The last step creates the state directory, unwires any tap a previous install
left in front of your status line, and needs the host at 2.1.287 or later (the
hooks module's events). The gauge itself needs no wiring: the module measures
every session in-process, and a session restart makes it take effect.

This release was tested against the host at 2.1.295.

## Upgrade from 0.48

A slash command runs the `install.sh` of the plugin version the session loaded. Run
`/orchestrator:install` before 0.49.0 is delivered and restarted into, and the 0.48
installer runs instead: it finds its tap "already wired" and keeps it, so nothing is
unwired and nothing is purged, yet the run looks like success. The order is therefore:

1. Merge the release pull request (#162).
2. Push the tag `orchestrator--v0.49.0`.
3. Merge the bugs-bot release (its #27), then the two catalogue pull requests (#21, #22).
4. Update the catalogue, then both plugins:

   ```
   /plugin marketplace update lounisbou
   /plugin update orchestrator@lounisbou
   /plugin update bugs-bot@lounisbou
   ```

5. Restart the session, so the slash command resolves to the 0.49.0 installer.
6. Run `/orchestrator:install`. It takes the tap off the status line and keeps the
   command that followed it exactly as written, `$HOME` or `~` spelling included. It then
   removes the old pipeline's files and the measure files of sessions that ended over a
   week ago.
7. Restart every running session: until it restarts, a session keeps the hooks of the
   version it loaded.

## Requirements

- `bash` 3.2 (the version macOS ships), `jq`
- `python3` for the tab tooling's environment
- for `model-routing`: bind `deep`, `standard` and `light` in
  `~/.claude/claude-orchestrator/models.json` (the installer creates it empty) to the
  host's family aliases, which it resolves to each family's latest model — never to a
  versioned identifier, which goes stale silently (the launcher warns when it finds one).
  With a tier unbound, the orchestrator picks the model, writes the choice and its reason in
  the brief, and tells you at the spawn.
- for `iterm-agents`: name in `~/.claude/claude-orchestrator/mcp.json` (the installer
  creates it empty) the servers this machine offers, in the host's own shape, and list
  the elementary ones under `default`. An agent gets that set plus what its spawn line
  adds; an empty catalogue means every session launches with no server at all.
- for `iterm-agents` only: macOS, iTerm2 with its API enabled (Preferences > General >
  Magic), and the environment `/orchestrator:install` builds under the state directory
  (~19 MB). One macOS approval, on the first connection. Tab placement needs no
  Accessibility grant and brings nothing to the front: the app reorders its own tabs

## How the gauge works

The hooks module measures every session in-process. After each turn the host
fires a measure event that carries the fill itself — tokens, window,
percentage, the model that answered — and the module writes one line to
`~/.claude/claude-orchestrator/measure/<session-id>.json`, the only file
external processes read: the launcher's `--inherit-model` takes the model from
it, and any tool of your own can read the figures the same way.

```bash
cat ~/.claude/claude-orchestrator/measure/$CLAUDE_CODE_SESSION_ID.json
# {"context_tokens":91000,"context_window":250000,"context_percent":36.4,
#  "model":"...","updated_at":"..."}
```

Past the gate —
300,000 tokens (30 %) on a window of 1,000,000 tokens or more, the common case, and 80 % of a smaller window —
the context gate puts the role's line in front of every prompt of an
orchestration session, and a band above the prompt shows the fill;
`/orchestrator:status` answers the same figures for every session on the
machine. Measured beats estimated: in observed runs, agents' self-estimates
ran 13 points above the gauge.

## The method in five lines

1. You orchestrate; you never implement. Implementers run in separate sessions, one agent, one phase, one draft PR stacked on the previous phase's branch head. Merges are never awaited.
2. Every brief is a file the fresh session can open, with contracts verbatim, a non-goals list ending in "STOP and ask", and state-verification commands.
3. Review on evidence: diff it yourself, re-run the one command that decides the verdict, treat every claim — cleanup claims included — as a claim. Heavy reading goes to a review session spawned for the round (its readers sized by you, from its own reading to several lenses, and it reports once); the verdict stays with you, and the session is closed when the round is judged.
4. Context is a gate at 300,000 tokens (30 %) on a window of 1,000,000 tokens or more, the common case, and 80 % of a smaller window: never dispatch a phase to an agent past it, and an agent crossing it mid-work finishes the unit and stops. Rotation is a resume brief for a fresh session.
5. Succession is the orchestrator's to trigger, at a quiet moment, with a standing pointer-based brief; the successor verifies the state on the artifacts, re-identifies itself to the agents, confirms the takeover, then closes the predecessor's tab.

## Tab layout

The orchestrator's tab sits immediately left of its implementer's tab. A plain
`spawn` appends at the far right of the window, which is beside the orchestrator
only when it happens to be the last tab — so always name an anchor, and name the
one you know: `--right-of self` resolves the calling session's own tty from the
process tree. `--left-of <tty>` covers the mirror case, and `move` repairs the
layout after the fact.

## Uninstall

```
/orchestrator:uninstall     # or ./uninstall.sh
```

## License

MIT
