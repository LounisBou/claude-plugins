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
skills/iterm-agents/scripts/iterm-agent.sh
skills/model-routing/SKILL.md        which capability tier a dispatch gets
skills/context-gauge/SKILL.md        how a session reads its own context fill
skills/context-gauge/scripts/context-gauge.sh
skills/context-gauge/scripts/statusline-tap.sh
templates/agent-phase-brief.md       one implementer, one phase, one PR
templates/agent-rotation-brief.md    resume brief for a fresh implementer
templates/orchestrator-succession-brief.md
commands/install.md                  wires the tap, creates the state directory
commands/uninstall.md                restores the previous status line
commands/status.md                   live sessions and their gauges
commands/succeed.md                  runs the orchestrator succession
install.sh, uninstall.sh
tests/run-tests.sh, tests/fixtures/
docs/design.md                       this document
README.md, LICENSE
```

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
- version: the plugin and marketplace manifests agree, and the number is ahead of every published tag.

## 8. Release

Version in `plugin.json` AND in both fields of `marketplace.json` — the same fact in
three places, so the suite checks they agree and that the number is ahead of every
published tag. Tag `orchestrator--v<version>` pushed with the code (the document
announced a `claude-orchestrator--v` prefix that no release has ever used). Install:

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

**decide** (0.4.2) is the decision round: the orchestrator collects every arbitration that is the user's — agents' STOPs, proposed owners, review findings without one — and puts them ONE AT A TIME, each with its context in plain words, two to four choices carrying their cost, one recommendation, then waits; the ruling is written back in one line, recorded where it lives, relayed to the agent it answers, and only then the next question comes. A question interrupted by anything else is re-presented in full, never referenced. Written after a day on which twelve arbitrations were put that way and every one was ruled in a minute, where batching them had stalled for hours.
