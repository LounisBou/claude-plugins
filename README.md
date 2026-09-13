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
| skill `orchestrator` | The rulebook: phase and PR rules, the agent prompt recipe, the agents' lifecycle (the orchestrator launches, verifies, controls, terminates and replaces them), review on evidence, review rounds run in disposable sessions, what a round costs and the three ways to shorten it, context rotation, the orchestrator's own succession, shared-machine discipline. |
| skill `iterm-agents` | `list`, `spawn`, `verify`, `resolve-tier`, `close`, `move`, `rotate` iTerm2 tabs running agent sessions, through the app's own API rather than by typing into a shell. Placement anchors on a tty or on `self` — after the caller's last open agent, so a window reads as launch order. The prompt goes to a file and the typed command stays short; the tab runs the launch through the operator's login shell, so the agent inherits the full PATH; spawn waits for the host CLI on the new tty and fails loudly otherwise; tty-exact close with a title guard; spawn-and-verify before close on rotate. |
| skill `context-gauge` | A session's own context fill as a measured figure, from the status line payload when fresh, from the transcript otherwise. |
| skill `model-routing` | Which capability tier a dispatch gets: pay for judgment nothing downstream re-checks. A table by class of work, five readings for the cases off the table, escalation as a rotation, the false-economy rule, and budget pressure read from the quota figures. |
| `templates/` | Phase brief, rotation resume brief, orchestrator succession brief, review-agent brief, comments-agent brief, audit brief, with the sections the rulebook makes mandatory. |
| script `rhythm.sh` | An audit's rhythm figures read from git alone: merges per week by conventional-commit type, `feat` commits per week, lines under product globs against instrument globs, open entries of a Markdown register — and the one reading git does not hold, said rather than estimated. |
| `/orchestrator:install` | Wires the gauge's tap in front of your status line. Idempotent, reversible. |
| `/orchestrator:uninstall` | Restores the previous status line. |
| `/orchestrator:status` | Live sessions and their context fill, the ones past the 60% gate flagged. |
| `/orchestrator:succeed` | Runs the orchestrator succession. |
| hook `UserPromptSubmit` | The context gate enforced by the harness: at or past 60 % (`ORCHESTRATOR_CONTEXT_GATE`), every prompt carries the line that orders the succession or the stop; unmeasured, it says so once. |
| `/orchestrator:agents` | Each running implementer agent's progress with its measured context — asked, then verified on the artifact. |
| `/orchestrator:progress` | Where the build stands: done, in flight, remaining, decisions pending, and the orchestrator's own context. |
| `/orchestrator:decide` | Runs a decision round with the user: every open question one at a time — context, choices with their cost, one recommendation — each ruling recorded and relayed before the next; a question is re-presented in full after any interruption. |
| `/orchestrator:audit` | Launches an auditor of the orchestration: a read-only session in a tab titled `Audit : <subject>`, beside the orchestrator, on its model and under remote control, in no chain. It reads the deliveries, the orchestrator's conduct and what is due, reports to the operator in a report of fixed shape, and orders the orchestrator to tighten or loosen the method, each change with its measurement. |
| `/orchestrator:audit-end` | Ends the audit from either side: the auditor sends its report path and its orders and ends its turn; the orchestrator acknowledges them, closes the auditor's tab and clears the record. The report stays on disk for the next audit. |

## Tests

`./tests/run-tests.sh` runs everywhere: no network, no terminal automation, isolated home
per case. `./tests/e2e.sh` plays one real round against a live terminal — a brief, a
session at a tier, a placed tab, a verified close — and is kept out of the default suite on
purpose, because it costs tokens and needs the app running.

## Install

```
/plugin marketplace add LounisBou/claude-statusbar
/plugin install orchestrator@lounisbou
/orchestrator:install
```

The last step wraps your status line with the tap (see below) and needs a
session restart. Skip it if you only want the method and the tab tooling: the
gauge then answers from the transcript alone.

## Requirements

- `bash` 3.2 (the version macOS ships), `jq`
- `python3` for the gauge's transcript tier
- for `model-routing`: bind `deep`, `standard` and `light` in
  `~/.claude/claude-orchestrator/models.json` (the installer creates it empty) to the
  model identifiers your host accepts. Unbound tiers leave the choice to the host.
- for `iterm-agents`: name in `~/.claude/claude-orchestrator/mcp.json` (the installer
  creates it empty) the servers this machine offers, in the host's own shape, and list
  the elementary ones under `default`. An agent gets that set plus what its spawn line
  adds; an empty catalogue means every session launches with no server at all.
- for `iterm-agents` only: macOS, iTerm2 with its API enabled (Preferences > General >
  Magic), and the environment `/orchestrator:install` builds under the state directory
  (~19 MB). One macOS approval, on the first connection. Tab placement needs no
  Accessibility grant and brings nothing to the front: the app reorders its own tabs

## How the gauge works

The host exposes the exact context fill in one place: the JSON it sends to the
status line command on stdin (`context_window.used_percentage`, the 5-hour and
7-day quotas, and `session_id`). Hooks do not carry it, and a plugin cannot
declare a status line. So the installer prepends a tap to whatever status line
you already run:

```
statusLine.command = "~/.claude/claude-orchestrator/statusline-tap.sh <your previous command>"
```

The tap records the payload to `~/.claude/claude-orchestrator/ctx/<session-id>.json`
and hands it on untouched. It wraps, it never patches. Without a previous
command it prints a one-line `ctx: N% │ 5h: N% │ 7d: N%`.

The gauge reads that file when it is younger than two minutes and answers
`source=tap`. An idle session stops rendering its status line, so the file
ages; the gauge then scans the session's own transcript for the last `usage`
block (input plus cache tokens is the context sent on the last turn, within
half a point of the host's figure) and answers `source=transcript`. The window
size for that computation comes from the stale tap file, else `--window`, else
200000, and `context_window_source=` says which.

```bash
${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh
# context_percent=36.4
# context_tokens=91000
# context_window=250000
# five_hour_percent=3
# seven_day_percent=1
# source=tap
```

The session id defaults to `CLAUDE_CODE_SESSION_ID`, set by the host in every
session. Measured beats estimated: in observed runs, agents' self-estimates ran
13 points above the gauge.

## The method in five lines

1. You orchestrate; you never implement. Implementers run in separate sessions, one agent, one phase, one draft PR stacked on the previous phase's branch head. Merges are never awaited.
2. Every brief is a file the fresh session can open, with contracts verbatim, a non-goals list ending in "STOP and ask", state-verification commands, and the gauge invocation.
3. Review on evidence: diff it yourself, re-run the one command that decides the verdict, treat every claim — cleanup claims included — as a claim. Heavy reading goes to a review session spawned for the round (it fans out read-only readers and reports once); the verdict stays with you, and the session is closed when the round is judged.
4. Context is a gate at ~60%: never dispatch a phase to an agent past it, and an agent crossing it mid-work finishes the unit and stops. Rotation is a resume brief for a fresh session.
5. Succession is the orchestrator's to trigger, at a quiet moment, with a standing pointer-based brief; the successor verifies the state on the artifacts, re-identifies itself to the agents, confirms the takeover, then closes the predecessor's tab.

## Tab layout

The orchestrator's tab sits immediately left of its implementer's tab. A plain
`spawn` appends at the far right of the window, which is beside the orchestrator
only when it happens to be the last tab — so always name an anchor, and name the
one you know: `--right-of self` resolves the calling session's own tty from the
process tree. `--left-of <tty>` covers the mirror case, and `move` repairs the
layout after the fact.

## Tests

```bash
./tests/run-tests.sh
```

No network, no terminal automation, an isolated HOME per case: the tap (file
contents, byte-for-byte passthrough, exit status, invalid input, pruning), the
gauge (both tiers, window resolution, environment default, error paths), the
installer (wrapping, idempotence, restore, dry-run), the iTerm script's
argument validation, and a check that no product name survives in prose.

## Uninstall

```
/orchestrator:uninstall     # or ./uninstall.sh
```

## License

MIT
