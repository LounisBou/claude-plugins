# claude-orchestrator — design

Status: validated · Scope: a host plugin that packages the orchestration method, the terminal tab tooling and a context gauge that any session can read.

## 1. Goal

One session supervises implementer sessions instead of writing code itself: it writes their briefs, reviews every delivery on the artifact, rotates saturated agents and hands over to a successor before its own judgment degrades. This plugin ships that method as skills, the tab tooling the method needs on macOS, the briefs as templates, and a context gauge that does not depend on any particular status bar.

Everything here was extracted from a working setup: the skills existed as loose files in the user's config directory, the gauge was a patch inside an installed status-bar script, and the briefs were rewritten by hand for every phase. The plugin makes them installable, versioned and independent of that machine.

## 2. Layout

```
.claude-plugin/plugin.json           name claude-orchestrator, semver, MIT
.claude-plugin/marketplace.json      single-plugin marketplace, source "./"
skills/orchestrator/SKILL.md         the rulebook
skills/iterm-agents/SKILL.md         tab management on macOS
skills/iterm-agents/scripts/iterm-agent.sh   entry point: resolves an interpreter
skills/iterm-agents/scripts/iterm_agent.py   the implementation, over the app API
skills/orchestrator/scripts/brief-lint.sh   refuses a brief before it is dispatched
skills/orchestrator/scripts/dispatch-record.sh  one row per dispatch, and the routing signal
skills/model-routing/SKILL.md        which capability tier a dispatch gets
skills/context-gauge/SKILL.md        how a session reads its own context fill
skills/context-gauge/scripts/context-gauge.sh
skills/context-gauge/scripts/statusline-tap.sh
templates/agent-phase-brief.md       one implementer, one phase, one PR
templates/agent-rotation-brief.md    resume brief for a fresh implementer
templates/agent-review-brief.md      one review round, read-only, one lens per reader
templates/agent-comments-brief.md    one pass over a pull request's open threads
templates/orchestrator-succession-brief.md
commands/install.md                  wires the tap, creates the state directory
commands/uninstall.md                restores the previous status line
commands/status.md                   live sessions, their gauges, the routing pressure
commands/succeed.md                  runs the orchestrator succession
commands/agents.md                   each running implementer's progress
commands/progress.md                 where the build stands
commands/decide.md                   the decision round, one arbitration at a time
hooks/hooks.json                     declares the context gate on UserPromptSubmit
hooks/context-gate.sh                the gate the harness enforces, not the model
install.sh, uninstall.sh
tests/run-tests.sh
tests/e2e.sh                         one real round: a tab, a session, a close
tests/fixtures/transcript.jsonl      a transcript tail for the gauge's computed tier
docs/design.md                       this document
README.md, LICENSE
```

The suite checks this block against the tracked files: it had already lost the hooks,
three commands, two briefs and the fixture while still reading as current.

Skills reach their scripts through `${CLAUDE_PLUGIN_ROOT}`; a relative path does not resolve from a skill. Skills are invoked as `orchestrator:<skill>`.

## 3. Context gauge

### 3.1 Why two tiers

The host exposes the exact context fill in one place only: the JSON it writes to the status line command's stdin (`context_window.used_percentage`, `context_window.context_window_size`, a `current_usage` token breakdown, the 5-hour and 7-day quotas, `session_id` and `transcript_path` — field names read from a captured payload, not from documentation). Hooks do not carry it, and a plugin cannot declare a status line. A session can also compute its fill from its own transcript: the last `usage` block's input plus cache tokens is the context sent on the last turn, within half a point of the host's figure. The transcript needs the window size, which the payload carries as `context_window_size`.

So the gauge has a harness-exact tier fed by a status-line tap, and a computed tier from the transcript that needs no wiring at all. An idle session stops rendering its status line, so its tap file ages; the gauge then falls back to the transcript and says so.

### 3.2 The tap

`statusline-tap.sh [wrapped command...]` reads the payload from stdin, writes one file per session, then feeds the untouched payload to the wrapped command and exits with its status. With no wrapped command it prints a one-line `ctx: N% │ 5h: N% │ 7d: N%` so a user without a status bar still sees something.

The file is `${CLAUDE_CONFIG_DIR:-~/.claude}/claude-orchestrator/ctx/<session-id>.json`:

```json
{"session_id": "...", "context_percent": 36.4, "context_used": 91000, "context_total": 250000,
 "five_hour_percent": 3, "five_hour_resets_at": 1788560000,
 "seven_day_percent": 1, "seven_day_resets_at": 1788900000,
 "transcript_path": "/path/to/session.jsonl", "updated_epoch": 1788553115}
```

`context_used` is the sum of `current_usage`'s input, cache-creation and cache-read tokens; `context_total` is `context_window_size`; `transcript_path` lets the gauge open the transcript without guessing its location. One `jq` call parses the payload; missing fields become `null`. The file is written to a temporary name then renamed, so a reader never sees a partial file. Invalid or empty stdin writes nothing and still runs the wrapped command. On the first render of a session (no file yet) the tap deletes files older than one day, so ended sessions do not accumulate.

### 3.3 The gauge

`context-gauge.sh [session-id] [--window N] [--max-age S]` prints `key=value` lines:

```
context_percent=36.4
context_tokens=91000
context_window=250000
five_hour_percent=3
seven_day_percent=1
source=tap            # or transcript
```

The two quota figures are printed in BOTH tiers, and read `unavailable` when the payload
never carried them or when the answer comes from the transcript, which has no trace of
them. They are never omitted: the callers that read this output are told to keep those
lines, and a missing line is one a reader takes for zero — "no budget pressure" exactly
when the pressure cannot be measured.

The session id defaults to `CLAUDE_CODE_SESSION_ID`, which the host sets in every session's environment. The tap file is used when younger than `--max-age` (default 120 s). Otherwise the transcript — the path recorded in the tap file when there is one, else `<config>/projects/*/<session-id>.jsonl` — is scanned backwards for the last `usage` block. The window for that computation comes, in order, from the stale tap file's `context_total`, `--window`, or the default 200000, and `context_window_source=` names which. No tap file and no transcript is an error with exit 1.

### 3.4 Install and uninstall

`install.sh` copies the tap to `<config>/claude-orchestrator/statusline-tap.sh` (a stable path: the plugin cache path changes with every version), creates `ctx/`, then rewrites `statusLine.command` in `<config>/settings.json` as `<tap path> <previous command>`. The previous `statusLine` object is saved to `<config>/claude-orchestrator/statusline.previous.json` and `settings.json` is backed up under `<config>/backups/claude-orchestrator-<stamp>/`. Idempotent: a command already starting with the tap path is left alone. With no `statusLine` at all, the command becomes the tap alone. `--dry-run` prints and changes nothing.

`uninstall.sh` restores the saved `statusLine` (or deletes the key if there was none) and removes the state directory. The tap copy goes with it.

Requirements: `jq` for the tap and the installer, `python3` for the transcript scan, bash 3.2.

## 4. Skills

**orchestrator** is the rulebook as it stands, with three edits: script invocations go through the plugin root, briefs are instantiated from `templates/`, and the gauge is described by pointing at the `context-gauge` skill. Every project-specific fact is removed; the skill states the rule and leaves the project's policy (where briefs live, whether tests are committed, what the durable-artifact policy forbids) to the brief the orchestrator writes.

**iterm-agents** keeps `list`, `spawn`, `close`, `move`, `rotate`, with `--left-of` on `spawn` and `rotate`, and gains `verify`. Since 0.4.0 `spawn` writes the prompt to a file under the state directory and types a short command that reads it — a prompt typed by AppleScript is truncated past a few hundred characters and the command never runs — waits for the new tab's shell to be at a prompt (answering a startup yes/no question with « n », since 0.4.1) before typing, then waits for the host CLI on the new tty, re-types once if the shell is idle without it, and fails loudly if it never appears; quoting uses the shell's substitutions, never `sed`, which dies on a non-ASCII byte under a C locale. The layout convention is stated: the orchestrator's tab sits immediately left of its implementer's tab. The spawn prompt is a one-line "Read and execute <path>" naming the orchestrator's address.

**context-gauge** documents how a session reads its own fill, what each `source=` means, and the duty the orchestrator puts in every brief: report the measured figure, never an estimate.

## 5. Templates

Three Markdown briefs with `{{PLACEHOLDER}}` markers, each carrying the sections the orchestrator skill makes mandatory:

- **agent-phase-brief**: required reading, environment with state-verification commands, scope with contracts verbatim and a non-goals list ending in the STOP-and-ask clause, method, forbidden list, communication protocol with the gauge invocation, delivery, resource envelope.
- **agent-rotation-brief**: phase state, branch state, remaining scope, decisions marked non-reopenable, same protocol.
- **orchestrator-succession-brief**: pointer-based (project state file, spec, plan, runbook, briefs directory), the successor's ordered first task (read, verify on artifacts, re-identify to live agents, confirm takeover, close the predecessor's tab), and the standing user rules that bind the successor.

A brief is written to a path the fresh session can open on its machine, never only into a session's context.

## 6. Commands

- `install` and `uninstall` run the scripts of §3.4 and report.
- `status` lists tap files younger than ten minutes with session id, context percent and age, next to the live-session list the host provides, so an orchestrator sees at a glance who is near the rotation gate.
- `succeed` executes the succession the orchestrator skill describes: refresh the standing brief from the template, spawn the successor with `--left-of` the implementer's tty, wait for the takeover confirmation, answer nothing new meanwhile.

## 7. Tests

`tests/run-tests.sh`, bash, no network, no terminal automation, isolated `HOME` per case:

- gauge: fresh tap file → `source=tap`; stale tap file plus fixture transcript → `source=transcript` with the window taken from the file; transcript only with `--window`; nothing → exit 1; session id from the environment variable.
- tap: file written with every field; payload passed byte-for-byte to the wrapped command and its exit status returned; no wrapped command → the one-line render; invalid stdin → no file, wrapped command still run; stale files pruned on first render.
- install: wraps an existing command, is idempotent on a second run, handles a settings file without `statusLine`, `--dry-run` changes nothing; uninstall restores the previous object exactly.
- iterm script: argument validation paths (`--tty` required, differing ttys) fail before any automation call.
- repository policy: the prose contains no vendor or product name outside the load-bearing identifiers, no model family name anywhere, nothing machine- or project-specific — and the guard proves it can still SEE a violation, through a probe planted and removed by the same function, because it once masked every hit behind the repository's own path.
- model tiers: a bound tier resolves, an unbound one resolves to nothing without erring, an unknown one is refused, the environment overrides the map, a map that does not parse stops the caller instead of passing for an unbound tier, and a rotation whose tier cannot resolve stops before anything else runs.
- version: the plugin and marketplace manifests agree, and the number never falls behind a published tag — the comparison itself is proved on ahead, equal, behind, a double-digit component and no tags at all, so the rule holds when the repository state changes.

## 8. Release

Version in `plugin.json` AND in both fields of `marketplace.json` — the same fact in
three places, so the suite checks they agree and that the number never falls
BEHIND a published tag (equal is a tagged release, ahead is unreleased work; only behind
is the defect). Tag `orchestrator--v<version>` pushed with the code — the prefix
since 0.4.1; the first three releases used `claude-orchestrator--v`, before the plugin
was renamed, and the suite reads both when it checks the version against what is
published. Install:

```
/plugin marketplace add LounisBou/claude-orchestrator
/plugin install claude-orchestrator@claude-orchestrator
/orchestrator:install
```

## 9. Out of scope

Windows and Linux terminal automation (the iterm-agents skill is macOS only; the other two skills and the gauge work anywhere the host runs). A hook-based gauge: no hook event carries context usage. Editing the user's status line script: the tap wraps it, never patches it.

## 10. Model routing

**0.7.0.** Every session the orchestrator dispatched ran at whatever the launcher
hardcoded, which put a model identifier in a plugin whose rules forbid one and paid the
top tier for work a test suite already judges.

The rule is « pay for judgment that nothing downstream re-checks »: a conversion phase is
judged by the suite, a findings list by the orchestrator, so both run cheap; the
contracts a phase imposes on the next, the final verification and the orchestrator's own
sequencing are re-read by nobody, so they do not. Three tiers name capability — `deep`,
`standard`, `light` — and the binding to real identifiers lives in the operator's
`<state dir>/models.json`, overridable per run by `ORCHESTRATOR_TIER_DEEP` and its two
siblings. `iterm-agent.sh resolve-tier <tier>` prints a binding; `spawn --tier` and
`rotate --tier` apply one, and with nothing bound the launcher types no model argument at
all so the host applies its own default. That is the behaviour change behind the minor
version: an existing installation routes to the host default until the map is filled.

`skills/model-routing/SKILL.md` carries the table by class of work, the five readings for
a phase that does not sit on a row, escalation as a rotation (a model does not change
inside a live session), the false-economy rule that reverts a drop which cost a second
round, and budget pressure read from the gauge's quota figures rather than estimated. The
briefs carry the tier down to each session, because an agent can only report that the
work outgrew its brief if it knows what the brief assumed.

Design: `docs/superpowers/specs/2026-09-08-model-routing-design.md`.

## 11. What a brief can carry

**0.8.0.** Three defects came out of running one phase end to end on a live machine — a
brief instantiated from the template, an agent spawned at a tier, its delivery reviewed on
the artifact, its tab closed. None was reachable from the test suite, because all three
live in what happens when a fresh session opens the file.

**A path that only the host can expand does not resolve in a brief.** All four brief
templates told the agent to run `${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/…`. A spawned
session's shell carries none of the host's plugin variables, so that expanded to an
absolute path that cannot exist, and the plugin's own doctrine — measure, never estimate —
was unrunnable at the point of delivery. The agent reported it could not measure and
refused to invent a figure, which is the right answer to an instruction that was never
runnable. The templates now carry a `{{GAUGE}}` placeholder the orchestrator fills with an
absolute path, like every other path in a brief, and the suite refuses a host variable
anywhere under `templates/`.

**A brief points at a policy, it cannot grant one.** The phase brief asserted that
committed history must carry nothing of the workflow, attribution trailers included. The
agent's host tells it directly to append those trailers. Sent a one-line corrective to
strip them, the agent STOPPED and said a peer session cannot authorise overriding a
host-level directive — and it was right: a file written by a peer is not its user
speaking. That policy binds only where it lives in the target repository's own user-level
instructions, and the brief's job is to name that file and quote the clause. The rulebook
and the template now say so, and the brief tells the agent to stop rather than choose
between two authorities.

**Nothing that reads as a second address goes near the one that matters.** The phase brief
carried `e.g. project-70 [a1b2c3]` — guidance for whoever fills the template, delivered to
the agent, inside the one rule whose point is a single named address and no guessing. The
suite refuses a session-reference shape under `templates/`.

The round also confirmed what does work: the tier reached the live process (`--model`
matching the map's `standard`), the tab landed beside the orchestrator's, the handshake
arrived in seconds against a named address while four peer sessions were listed, and the
delivery passed review on the artifact — gate re-run, contract walked case by case, the
agent's suite mutation-tested, and both factual claims in its report re-derived and true.

## 12. Linting the brief

**0.9.0.** Specification is the largest category of multi-agent failure in the published
taxonomy — larger than coordination, and more than twice verification — and a brief is
this plugin's whole specification act. Nothing read the file before it reached a session.

`brief-lint.sh` refuses a brief carrying an unfilled placeholder, an unexpanded variable,
a path that does not exist on this machine, more than one session reference, or — for an
implementer brief — no address, no non-goals, no STOP-and-ask clause. Every one of those
has reached a live agent at least once; the last round supplied two of them, and the
script was verified against the brief that agent actually received rather than against a
fixture: it names both and exits 1.

It reads what a script can read. Whether the scope is right, whether the contracts are the
ones the next phase consumes, whether the tier fits the work — those stay the
orchestrator's, and the skill says so where it tells you to run it, because a guard whose
limits are unstated is one people trust past them.

## 13. Measuring what the routing rule assumes

**0.10.0.** The routing rule says a tier drop that costs a second corrective round is
reverted for its class. Nothing measured that, so it could only be applied from memory —
and a rule applied from memory always finds the drop was free, because its cost lands
rounds later where nobody attributes it.

`dispatch-record.sh` keeps one row per dispatch as JSON lines — class, tier, rounds,
verdict — with `open`, `round`, `close` and `summary`. The row is rewritten in place
rather than appended per event: a record of events would make every read a reduction over
history, and the history is not the fact. `summary` prints a line per class and tier, then
the one the rule exists for: `signal=<class> at <tier> averages N rounds: the drop did not
pay, revert it for this class`.

The record lives with the PROJECT being built. The default table ships here; a project's
corrections belong to that project's state, where status lives once.

## 14. The terminal tooling speaks the app's own API

**0.11.0.** Every expensive launch bug this plugin carried came from one decision: the
command was TYPED into a fresh shell. Typed, it could be truncated past a few hundred
characters while the script reported success; typed, a startup question ate its first
keystroke twice in one night; typed, it had to be quoted for AppleScript, which died on a
non-ASCII byte under a C locale. And placement drove a menu through System Events, which
needed an Accessibility grant, the app in front, and a focus flicker per move.

The app has an API. `async_create_tab` takes the command and the index directly, so none
of that exists here: the launch is handed over, the tab is born where it belongs, and
`async_set_tabs` reorders without touching a menu. Two macOS approvals become one.

The surface is unchanged — same subcommands, options, messages and exit codes — because
skills, commands and briefs call it by those. `iterm-agent.sh` is now a launcher that
resolves an interpreter and hands over to `iterm_agent.py`; the module the app needs is
imported only by the subcommands that talk to it, so reading the tier map or a tty works
on a machine with no environment and no window server.

Three things the live probe found that no documentation says:

- **The tab gets no login shell.** The app runs the launch as the session's program, with
  a bare default PATH that does not contain the package manager's bin directory. The first
  spawn died instantly and reported a tty belonging to nothing. The launch now names the
  CLI by absolute path, resolved from the orchestrator's own environment.
- **The app splits the command into words itself**, so a compound command handed over raw
  is run by no shell at all. The launch goes to a file and the app is asked to run
  `/bin/sh <file>`: a path has no quoting, and quoting for someone else's tokenizer is the
  losing game the typed version already played.
- **A window's tab list is a cached copy.** A reorder read back through the object already
  held reports the position the tab used to have. Re-fetch the app after any mutation.

The environment is the installer's: `python3 -m venv` under the state directory plus the
app's module, 19 MB. Recent macOS refuses to install into a package-managed interpreter,
and a plugin has no business writing into one it did not create. Without it the tooling
refuses to run and says how to build it.

Cost paid: seventeen guards that read the old implementation's source are gone, replaced
by checks that read what the launch SAYS. That is a gain — a guard reading an
implementation is green on the day the implementation changes shape and wrong the day
after.

## 15. The round the suite cannot play

**0.12.0.** `run-tests.sh` proves the plumbing and cannot touch the choreography: it
forbids terminal automation, so the acts the tooling exists for — placing a tab, verifying
a session, killing it — were held by argument checks and by reading the implementation's
own source. Every defect the last two rounds found lived in exactly that gap.

`tests/e2e.sh` plays one real round: a brief instantiated from the template and linted, a
dispatch recorded, a session spawned at a tier, the tab placed against its anchor, the
title guard exercised, the tab closed, the process confirmed gone, the record closed. It
asserts the one thing no dry run can — that the tier named at dispatch is the model the
LIVE PROCESS carries — and it exercises the brief lint, the dispatch record and the tab
tooling together, which nothing else does.

It is deliberately NOT part of the default suite. It drives the terminal, it starts a
session that costs tokens, and it needs the app running with its API enabled: a suite that
cannot run in a checkout with no window server is a suite people stop running. It skips
itself off macOS and stops with a clear reason when the tooling cannot reach the app.

It does not talk to the agent. Handshakes, verdicts and reviews need judgment and stay the
orchestrator's; this holds the mechanism underneath them.

**decide** (0.4.2) is the decision round: the orchestrator collects every arbitration that is the user's — agents' STOPs, proposed owners, review findings without one — and puts them ONE AT A TIME, each with its context in plain words, two to four choices carrying their cost, one recommendation, then waits; the ruling is written back in one line, recorded where it lives, relayed to the agent it answers, and only then the next question comes. A question interrupted by anything else is re-presented in full, never referenced. Written after a day on which twelve arbitrations were put that way and every one was ruled in a minute, where batching them had stalled for hours.
