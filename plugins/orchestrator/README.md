# orchestrator

One session supervises implementer sessions instead of writing code itself:
it writes their briefs, reviews every delivery on the artifact rather than on
the report, rotates saturated agents, and hands over to a successor before its
own judgment degrades. This plugin packages that method, the terminal tab
tooling it needs on macOS, the briefs as templates, and a context gauge any
session can read without depending on a particular status bar.

## What you get

| Piece | What it does |
|---|---|
| skill `orchestrator` | The rulebook, started in a mode given as its argument: `build` (a spec delivered as pull requests; it loads the `method` plugin's `method:lifecycle`, which owns the lifecycle, done and the formats) or `investigate` (debugging or analysis: no goals, phases or ready gate); with no mode it asks once. Ten principles, then the references read at the moment of the action: phase and PR rules, the agent prompt recipe, the agents' lifecycle (the orchestrator launches, verifies, controls, terminates and replaces them), review on evidence, review rounds run in disposable sessions, what a round costs and the three ways to shorten it, context rotation, the orchestrator's own succession, shared-machine discipline. Its `workspace.sh` makes a clone per phase (`create`) and a pinned worktree per review round (`pin`, `--pr <n>` recording the pull request it reviews), deletes either together with the host's temporary directory it used (`delete`), and sweeps the leftovers whose pull request is merged or closed (`sweep`) — never a dirty tree, unpushed commits, a pin whose head is on no branch, or a directory a live process works in. |
| skill `iterm-agents` | `list`, `spawn`, `verify`, `resolve-tier`, `close`, `move`, `rotate` iTerm2 tabs running agent sessions, through the app's own API rather than by typing into a shell. Placement anchors on a tty or on `self` — after the caller's last open agent, so a window reads as launch order. The prompt goes to a file and the typed command stays short; the tab runs the launch through the operator's login shell, so the agent inherits the full PATH; spawn waits for the host CLI on the new tty and fails loudly otherwise; tty-exact close with a title guard, which also deletes the stood-down session's checkout once its process is proved gone (`--keep-checkout` opts out); spawn-and-verify before close on rotate. |
| skill `model-routing` | Which model/effort pair a dispatch gets: pay for judgment nothing downstream re-checks. A table by class of work, five readings for the cases off the table, escalation as a rotation, and the false-economy rule. Dispatches run on a measured model/effort pair, picked from the most specific table that has one. Its `routing.py` measures what a session cost, benches a project's merged pull requests on a grid of pairs, and calibrates a table per project, then per profile and globally. Measured tables stay in the operator's state directory and name models; only tier/effort defaults ship in the plugin. |
| skill `coordination` | The coordinator's role, outside every orchestration on one machine: answers from the facts, flags collisions to both sides, gates nothing, relays to the operator what is his. The orchestrator's and the auditor's skills say nothing of it. |
| `templates/` | Phase brief, rotation resume brief, orchestrator succession brief, review-agent brief, comments-agent brief, audit brief, with the sections the rulebook makes mandatory. |
| script `rhythm.sh` | An audit's net balance read from git alone: merges per week by conventional-commit type, and lines added and removed under product globs against instrument globs. |
| `/orchestrator:install` | Creates the state directory, unwires any tap a previous install left in front of your status line, prunes what the tap left behind, and writes the short names as user commands. Idempotent; refuses a host older than 2.1.287. |
| `/orchestrator-uninstall` | Restores the previous status line, removes the state directory and the short names' user commands. |
| `/orchestrator-status` | Live sessions and their context fill, the ones past the gate flagged. |
| `/orchestrator-supervision` | Opens the supervision pane, kept on screen with each session's fill and redrawn every 20 seconds while open, and within 2 seconds of a change in the round: the orchestrators in a coordinator session (`Coord:`) — those on another machine too, labelled `remote <machine>`: their module sends the row silently, only when the wait or a 5 % band of the fill changes, and the coordinator's module stores it without a model turn — its own agents in an orchestrator session (`Orch:`). In a coordinator it also opens by itself, once, at the end of its first turn, and shows under the rows the first open question of its round that carries choices (those without come after), with its lettered choices; otherwise only when typed, or when the operator asks in plain words to open or close the supervision, through the module's `supervision` tool. Typed again, it closes it. |
| `/orchestrator-succeed` | Runs the orchestrator succession. |
| module gate `prompt.submit` | The context gate enforced in-process by the hooks module: at or past the smaller of 300,000 tokens (30 %) and 80 % of the reported window: 300,000 on 1,000,000; 160,000 on 200,000 (`ORCHESTRATOR_CONTEXT_GATE`, `ORCHESTRATOR_CONTEXT_GATE_TOKENS`), every prompt of an orchestration session (named `Orch:`, `Agent:`, `Audit:` or `Coord:`) carries the line fitted to its role — succeed, or finish the unit and stop; unmeasured, it says so once. A session with no role name — started by hand and never renamed — gets neither line. A change of the model answering a session is said to the model in front of its next prompt, in every session. |
| module gate `tool.call` (Bash) | The kill guard enforced in-process by the hooks module, in sessions the launcher spawned only: a kill by name or pattern is refused, a kill by the recorded pid passes; the operator's own sessions are untouched. A forced push is refused by the forge (`/github:protect`). |
| module gate `tool.call` (Write, Edit, MultiEdit, Bash) | The tier map's guard: in a session of the orchestration (its name gives it a role), a write of `models.json` in the state directory is denied with the rule that the map is the operator's, unless the last prompt he typed in that session names the map or a tier. Reads pass. |
| module tools | Registered by the hooks module in every session: `declare_wait` (the turn's wait, above; an `operator` wait carries in `question` the full question block and is refused without it; one that asks the operator's consent to waive E2E on a pull request or to put a repository in or out of auto-merge names it in `consent`, and his answer is written as a consent record, `<config dir>/consents/<owner>/<name>/<entry>.json`, which the github plugin reads), `rename_session` (an orchestrator or coordinator takes its role name), `end_session`, `supervision` (the pane, below), `answered-by-message` (an orchestrator withdraws a question answered by a peer's message), `review` (an orchestrator records its review round's verdict at a pull request's head through github's record tool: pass, fail, or accepted with each point set aside and its reason), `move_send` and `move_probe` (« Moving an orchestrator to another machine », below). |
| hook `Stop` | The stop gate enforced in-process by the hooks module, in an orchestrator's session only (its name, launched or renamed, starts with `Orch:`). The turn declares what will wake it with the module's `declare_wait` tool (`operator`, `tool`, `done` or `deferred`, with what it blocks); a turn that declared nothing is still read by its last line (`waiting: …`). The stop is refused, at most once per turn (an operator wait that still holds no question block is refused on the re-fired stop too, twice at most, then let through with a notice to the coordinator), unless something will wake the orchestrator — a busy agent of its own, a command or monitor it started in the background still running (a `ci-watch.sh` among them; a `tool` wait is refused when nothing of its own runs), a blocking question for the operator (an `operator` wait, honoured before an idle agent's stand-down is asked; one that blocks « nothing », « none » or the like is refused, and never entered in a coordinator's round), or `waiting: done` with nothing left (no checkout, no agent, no open dispatch-record row, and every goal of the spec in the `goals.md` beside each registered record met with evidence on disk or ruled out in the operator's words) — or it has handed over: its last line `handed over`, or `waiting: done` once its successor's spawn succeeded or its `end_session` was accepted. Short of a declared blocking question, an idle agent of its own whose pull request is open or merged refuses the stop until it is stood down. Then each watched pull request of the session's repository whose ci-watch log shows checks pending or failing refuses the stop with the real state, once per watch (keyed on its log's first line): pending once, failing once per failing set — one with a `ci-watch.sh` process alive for it excepted, since that watch will wake the orchestrator. When its checks let the stop pass, it also runs `workspace.sh sweep` within what is left of its deadline, at most once per ten minutes, and logs each deletion. Its own failures let the stop pass and are logged in the module's log. |
| `deck.json` | The machine's supervision as one versioned file for programs outside the host (D3vDeck, the Stream Deck plugin): the coordinator, the orchestrators local and remote with their pull requests in flight, each agent under the orchestrator its chain names, the fill against the gate, the waits, the round's open questions and the sleepers, and each session's token use with its API-equivalent cost for the day and the week. Written by the hooks module in one rename under the state directory, on every change the pane would show and at least once a minute, so a reader can tell a live file from a frozen one. See « The deck file » below. |
| `/orchestrator-agents` | The running implementer agents with their measured context, the most urgent first, answered by the hooks module without a model turn; the ask of each agent and its verification on the artifact are the command body's steps, run by hand or when that answer fails. |
| `/orchestrator-progress` | The goals line of each record's `goals.md` (`goals met=m/n … open=…`), the dispatch rows still open and the record's tally, answered by the hooks module without a model turn; the full report — done, in flight, remaining, decisions pending, the orchestrator's own context — is the command body's steps, run by hand or when that answer fails. |
| `/orchestrator-decide` | Runs a decision round with the user: every open question back to back, one per message, in the method's question format (two to five choices, a free answer, an argued recommendation) — each ruling recorded at once; the rulings are relayed and the work launched when the wave ends, and a second wave is chained at once if the work raises new questions. |
| `/orchestrator-audit` | Launches, on the operator's word, an audit of the method: a session in a tab titled `Audit: <subject>`, beside the caller, on its model and under remote control, in no chain. It reads the stock — what the method has in place, what it costs, what it has yielded — and the net balance of product against instruments, then writes one report of at most five proposals, each « remove X » or « restore Y » with its expected gain and the figure that will check it. It tells the operator and stops: it orders nothing, applies nothing and messages no session. The operator decides, and closes its tab. |
| `/coordinator` | Starts, on the operator's word and in a session he opened, the machine's coordinator, for when he runs several orchestrations at once: a session outside every one of them, in the leftmost tab, titled `Coord: <subject>`. It tells each orchestrator it exists and may be asked, and asks each once to confirm the pull requests the facts give it. It reads the sessions, checkouts, heavy runs and open pull requests now, answers « whose pull request is this », « is anyone on this branch or file », « may I or must I wait » from them, flags a collision to both sides, relays to the operator what is his, carries his orders to all, and gates nothing. At the gate it hands over to its own successor. |
| `/coordinator-end` | Ends the coordinator on the operator's word only: every orchestrator is told, and the record is cleared, proved by a lookup that prints nothing. |
| `/coordinator-decide` | Runs, in the coordinator's tab, one decision round over the open questions of every orchestrator in its round, the urgent first, then within each level grouped by orchestrator, the groups ordered by their oldest wait; each ruling goes verbatim to the orchestrator that asked as soon as it is recorded. |
| `/orchestrator-sleeping` | The orchestrators the coordinator paused on the operator's word: name, slept since, directory, open pull requests, brief. `drop <name>` abandons one for good after one confirmation; its brief moves to `abandoned/`, its pull requests, branches and checkouts are left to the operator. |
| `/orchestrator-calibrate` | Calibrates a project's routing table on the operator's spend cap: `harvest`, `ready`, `bench --max-usd <cap>` and `calibrate`, in order, stopping at the first failure and reporting it. It refuses without a cap and never picks one, stops before anything runs when the `deep` tier (the judge) is unbound, and stops after `harvest` when the manifest has no test command or no test globs. Before the bench it states what it will spend at most and on what grid; after `calibrate` it shows the table and stops: `generalize` and `export` are the operator's to ask for. |

Each command is listed under its short name, which the installer writes as a user command
(`/orchestrator-install` writes them, `/orchestrator-uninstall` removes them); the plugin's own
form, `/orchestrator:<file>` (`/orchestrator:status`), reaches the same command. A file of
yours with the same name is left alone, and a plugin update rewrites the copies at the next
session start.

## Tests

`./tests/run-tests.sh` runs everywhere: no network, no terminal automation, isolated home
per case. `./tests/e2e.sh` plays one real round against a live terminal — a brief, a
session at a tier, a placed tab, a verified close — and is kept out of the default suite on
purpose, because it costs tokens and needs the app running.

## Install

From the `lounisbou` catalogue (this repository's root; its migration document says how it is
used before the cutover):

```
/plugin install orchestrator@lounisbou
/orchestrator-install
```

The plugin depends on `method` from the same catalogue, which `build` mode loads. The last
step creates the state directory, unwires any tap a previous install left in front of your
status line, writes the short names (`/coordinator`, `/orchestrator-status` and the rest) as
user commands, and needs the host at 2.1.287 or later (the hooks module's events). The gauge
itself needs no wiring: the module measures every session in-process, and a session restart
makes it take effect.

## Requirements

- `bash` 3.2 (the version macOS ships), `jq`
- `node` 22.18 or later: the scripts' launchers run their TypeScript directly
- `python3` for the tab tooling's environment
- for `model-routing`: bind `deep`, `standard` and `light` in
  `~/.claude/claude-orchestrator/models.json` (the installer creates it empty) to the
  host's family aliases, which it resolves to each family's latest model — never to a
  versioned identifier, which goes stale silently (the launcher warns when it finds one).
  The map is the last fallback, not the default: `routing.py pick` reads, class by class,
  the project's measured table, its profile's, the global one, the shipped defaults, and
  only then the tier table, through the map. Every class no table measures is decided by
  the map. Measured tables live in the state directory, never in the plugin, so a fresh
  install routes everything through the map until a project is calibrated (see « Calibrating
  a new project » in `skills/model-routing/SKILL.md`).
  With a tier unbound, the orchestrator picks the model, writes the choice and its reason in
  the brief, and tells you at the spawn. You bind the map yourself: a session of the
  orchestration is denied any write of it unless your last typed prompt names it or a tier.
- for `iterm-agents`: name in `~/.claude/claude-orchestrator/mcp.json` (the installer
  creates it empty) the servers this machine offers, in the host's own shape, and list
  the elementary ones under `default`. An agent gets that set plus what its spawn line
  adds; an empty catalogue means every session launches with no server at all.
- for `iterm-agents` only: macOS, iTerm2 with its API enabled (Preferences > General >
  Magic), and the environment `/orchestrator-install` builds under the state directory
  (~19 MB). One macOS approval, on the first connection. Tab placement needs no
  Accessibility grant and brings nothing to the front: the app reorders its own tabs

## How the gauge works

The hooks module measures every session in-process. After each turn the host
fires a measure event that carries the fill itself — tokens, window,
percentage, the model that answered — and the module writes one line to
`~/.claude/claude-orchestrator/measure/<session-id>.json`, the only file
external processes read: any tool of your own can read the figures the same way. `start`
keeps the session's first figure and, for a session the launcher opened, the brief it started
on and its size, so each start is measured.

```bash
cat ~/.claude/claude-orchestrator/measure/$CLAUDE_CODE_SESSION_ID.json
# {"context_tokens":91000,"context_window":250000,"context_percent":36.4,
#  "model":"...","updated_at":"...",
#  "start":{"tokens":42000,"at":"...","brief":"/path/to/brief.md","brief_bytes":6100}}
```

Past the gate —
the smaller of 300,000 tokens (30 %) and 80 % of the reported window: 300,000 on 1,000,000; 160,000 on 200,000 —
the context gate puts the role's line in front of every prompt of an
orchestration session (the host compacts where the operator's settings say; the plugin sets only the gates: agent 240,000, others 300,000);
`/orchestrator-status` answers the same figures for every session on the
machine, and for the orchestrators on other machines whose rows reached it. Measured beats estimated: in observed runs, agents' self-estimates
ran 13 points above the gauge.

## The deck file

`~/.claude/claude-orchestrator/deck.json` is the one contract between the module and a
program that draws the supervision elsewhere. Its shape is `hooks/deck.ts`'s `Deck`, and
`version` changes on any change a reader must know of.

```jsonc
{
  "version": 3, "generated_at": "…", "machine": "mbp",
  "coordinator": { "key": "sessions/…", "name": "Coord: …", "tty": "/dev/ttys001", "tmux": null, "repo": null,
                   "context": { "percent": 12, "tokens": 120000, "window": 1000000, "past_gate": false },
                   "waiting": null, "updated_at": "…",
                   "usage": { "day":  { "from": "2026-10-28T23:00:00.000Z",
                                        "tokens": { "input": 1200, "output": 34000, "cache_read": 5200000, "cache_write": 310000 },
                                        "cost_usd": 4.71 },
                              "week": { "from": "2026-10-25T23:00:00.000Z", "tokens": { "…": 0 }, "cost_usd": 22.9 },
                              "at": "…" } },
  "orchestrators": [ { "…the same fields…", "machine": null, "prs": ["owner/repo#12"],
                       "agents": [ { "…the same fields…" } ] } ],
  "unattached_agents": [],
  "sleeping": [ { "name": "Orch: …", "since": "…", "dir": "…", "prs": ["owner/repo#3 branch"] } ],
  "round": { "open": 3, "urgent": 1, "oldest_since": "…" },
  "usage_totals": { "day": { "…the same fields…" }, "week": { "…" }, "at": "…" },
  "usage_basis": { "currency": "USD", "prices": "api-list-equivalent", "timezone": "Europe/Paris" }
}
```

A remote orchestrator has `machine` set and `tty` null: there is no tab to focus on this
machine. `tmux` names a session's window in a home session (`<session>:@N.%N`), null elsewhere. `waiting.kind` is `operator` or `done`; `urgent` is true when the sender marked its
open question so. Orchestrators come sorted by name.

`usage` is what a session spent, read from its transcript and its subagents' transcripts:

- `day` starts at 00:00 Paris time of the current day, `week` at 00:00 Paris time on Monday
  of the current ISO week; `from` is that start as an ISO UTC instant. A message counts in a
  period by its transcript entry's timestamp.
- `tokens` are counts of tokens, one usage per message: `input` the fresh input,
  `output` the output, `cache_read` the cache reads, `cache_write` the cache writes (the
  5-minute and the 1-hour ones together).
- `cost_usd` is in US dollars at the API list prices of
  `~/.claude/claude-orchestrator/routing/prices.json`, under `routing.py cost`'s rule (the
  tiered price, the two cache-write durations priced apart). It is `null` when a message of
  the period ran on a model that file has no price for; the tokens still count.
- `at` is when the sums were read, an ISO UTC instant.

The machine runs on a subscription and nothing is billed per token: `cost_usd` is what the
same tokens would cost at API list prices, an equivalent, never a bill. `usage` is `null` for
a remote orchestrator and for a local session whose transcript is not found.
`usage_totals` sums the `usage` of every session the file lists, the coordinator included and
the remote ones excluded, its `at` the file's `generated_at`; a total's `cost_usd` is `null`
when any summed period's is. `usage_basis` names the currency, the price basis and the time
zone of the periods. Each session reads its own transcripts, never another session's, from
where its previous read stopped, so keeping the sums current costs the lines appended since;
the read runs beside the hook that starts it, never in its way, and the file is written again
when it completes. A session not read since a period began shows that period empty until its
next read. A new `at` alone is no reason to write the file again.

## The method in five lines

1. You orchestrate; you never implement. Implementers run in separate sessions, one agent, one phase, one draft PR stacked on the previous phase's branch head. Merges are never awaited.
2. Every brief is a file the fresh session can open, with contracts verbatim, a non-goals list ending in "STOP and ask", and state-verification commands.
3. Review on evidence: diff it yourself, re-run the one command that decides the verdict, treat every claim — cleanup claims included — as a claim. Heavy reading goes to a review session spawned for the round (its readers sized by you, from its own reading to several lenses, and it reports once); the verdict stays with you, and the session is closed when the round is judged.
4. Context is a gate at the smaller of 300,000 tokens (30 %) and 80 % of the reported window: 300,000 on 1,000,000; 160,000 on 200,000: never dispatch a phase to an agent past it, and an agent crossing it mid-work finishes the unit and stops. Rotation is a resume brief for a fresh session.
5. Succession is the orchestrator's to trigger, at a quiet moment, with a standing pointer-based brief; the successor verifies the state on the artifacts, re-identifies itself to the agents, confirms the takeover, then closes the predecessor's tab (in a home session, takes its window 0).

## Moving an orchestrator to another machine

One step: in the coordinator's tab, say which orchestrator goes to which machine, for example
« move Orch: belt to mac-b ». The coordinator relays the order to a live `Orch:` session on
that machine, and the orchestrator (or the coordinator, for one asleep) sends its files with
`move_send`; the module on each side does the rest without a model turn: the files cross as
checked chunks over the host's peer messages, never through git, land on the other machine
through the store, the source's copy is removed once the other side acknowledged it, and the
receiving orchestrator opens the arrival. Both machines run the same version of this plugin,
and every checkout the orchestrator works in is committed and pushed first: its code travels
by git. What travels and what each machine rebuilds is in `docs/state.md`, « What a move
carries ».

## Where agents run

An orchestrator's tab is a real terminal holding a tmux session of its own, its
home session: the orchestrator runs in window 0 and every agent it spawns is a
window after it, shown in a tab bar with one block per window and a state icon
after its name (busy ●, idle ○, asks ✋, done ✓, gate ⚠). There is nothing to
type for it: the orchestrator command moves its own tab into the home session
by itself. Click a block, or press `C-b n` / `C-b p`, to switch; `C-b C-b`
sends a Ctrl-B to the program in the pane. Closing the tab ends the server,
the orchestrator and every agent, once the tab's client is attached. The
auditor and the coordinator stay iTerm2 tabs.

Outside a home session an agent is an iTerm2 tab, and the orchestrator's tab
sits immediately left of its implementer's tab. A plain `spawn` appends at the
far right of the window, which is beside the orchestrator only when it happens
to be the last tab — so always name an anchor, and name the one you know:
`--right-of self` resolves the calling session's own tty from the process tree.
`--left-of <tty>` covers the mirror case, and `move` repairs the layout after
the fact.

## Uninstall

```
/orchestrator-uninstall     # or ./uninstall.sh
```

## License

MIT
