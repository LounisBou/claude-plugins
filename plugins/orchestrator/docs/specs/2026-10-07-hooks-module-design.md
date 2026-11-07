# The hooks module — v0.49 design

Date: 2026-10-07
Status: approved design, pending implementation plan

## Why

Three of this plugin's mechanisms exist only because the host offered no in-process
API, and each one pays for that workaround every day:

- **The context gauge reads its own exhaust.** The status-line tap wraps
  `statusLine.command` in `settings.json`, writes one JSON file per session into
  `ctx/` (164 files at last count, one write per status-line render), and falls
  back to scanning the session transcript for the last `usage` block when a file
  is missing or stale. The tap also forces a cohabitation protocol with the
  status-bar plugin, preserved by hand on each install and uninstall of either
  side.
- **Every gate is a process spawn.** `context-gate.sh` (one `sed` chain and one
  `python3` per prompt), `push-guard.sh` (one `awk` tokeniser per Bash tool
  call), `stop-gate.sh` (one `python3` interpreter, 712 lines, per stop) each
  pay a cold start to answer a question the host already knows.
- **State is rebuilt by archaeology.** `coordinator.sh` reconstructs the
  machine's live state from the process table, `lsof` and `git`, because no
  session can see another.

The host now runs function hooks inside its own process: a plugin whose
`hooks/hooks.json` carries a `modules` array is a hooks module, its handlers
receive events (`session.measure`, `tool.call`, `prompt.submit`, `classic.Stop`,
`ui.render`) and an API (`$.session.usage()`, `$.store`, `$.ui`, `$.command`).
That removes the reason each workaround existed.

### Token study (measured 2026-10-07, 48 active sessions, 30 days)

Script results injected into conversations: 123,000 tokens. Of those,
`context-gauge.sh` called by hand — 50 calls, 45 in production — cost 14,500,
and one accidental `statusline-tap` run 1,900; both disappear. The tours behind
`/orchestrator:status|progress|agents` (command bodies 298/745/666 tokens, plus
`ls`/`jq`/`date`/gauge calls per listed session, plus the answer) cost roughly
10,000-20,000 and collapse to a store read of about 100 tokens. Skill bodies:
11 invocations of the orchestrator rulebook at 5,247 tokens each; the
`context-gauge` skill (590) is deleted, `Thresholds` and the coordination state
sections shrink by about 600. Listing cost falls by ~80-100 tokens for every
session on the machine (one skill and three commands leave the listing).

Direct saving: ~30,000-40,000 tokens per 30 days, plus everything a removed
tool result no longer re-reads on every later turn. The workflow scripts
(`dispatch-record.sh`, `workspace.sh`, `ci-watch.sh`, ~106,000 tokens) are
legitimate work and stay.

The structural rule this design follows: **facts move into the module, judgment
stays in the skill.** A sentence the model must remember is a sentence it can
rationalise away — measurement, thresholds, state and guards become code; when
to rotate, how to answer the operator, what to decide remain instructions.

## Goals

1. Replace the measurement pipeline: no tap, no `ctx/`, no transcript scan, no
   `statusline-tap.sh`.
2. Port the three gates to in-process handlers with identical semantics.
3. Give every session a live, shared state (`$.store`) and the coordinator a
   pane that reads it, retiring `coordinator.sh`'s reconstruction.
4. Make `status`, `progress` and `agents` instant commands that answer without
   a model turn.
5. Shrink the skills by the sections the module absorbs.

## Non-goals

- The iTerm spawn mechanism (`iterm-agents`) is untouched: sessions are still
  launched and laid out by the launcher.
- Workflow scripts (`workspace.sh`, `rhythm.sh`, `dispatch-record.sh`,
  `brief-lint.sh`, `ci-watch.sh`) remain scripts the skills call.
- `decide`, `audit`, `coordinator`, `coordinator-end`, `succeed` remain
  markdown commands: they are model workflows, not displays.
- The status-bar plugin keeps its sections; only the tap wiring goes away, which
  ends the wrapper cohabilitation protocol.
- No interaction buttons on the pane in v0.49 (display only).

## Architecture

```
hooks/
  hooks.json        gains "modules": ["./register.js"]; the four shell hooks
                    and their settings entries are removed in the same release
  register.js       entry point: mounts the four domains
  gauge.ts          measurement, band rendering, measure file, model drift
  guards.ts         prompt.submit, tool.call, classic.Stop, session naming
  supervision.ts    store schema, writes, coordinator pane
  commands.ts       instant commands reading the store
```

Hard cutover in one release (0.49.0): no dual system, no compatibility writes
beyond the one measure file. Each domain module carries its own `*.test.ts`,
run by the host's `plugin test`; the host's `plugin validate` runs in CI and lists the
events and API calls the module makes. Development happens against the checkout
with `--plugin-dir` (hot reload on save); installed copies are cached by
version, so releases bump the version as today.

## gauge.ts

- On `session.measure` (fires after each turn and on each percentage change of
  a plan limit): read `$.session.usage()` → `context.tokens`, `context.window`,
  `context.percent`, and `$.session.model()`.
- Double gate, unchanged from `Thresholds`: the gate trips at 80 percent of the
  window, or at 300,000 tokens on a window of 1,000,000 or more.
- Render an `AbovePrompt` band (`ui.render` with `component: 'AbovePrompt'`):
  fill gauge, token count, rotation threshold marker, warning color past the
  gate. Check `$.session.surfaces()` first; where nothing draws, the band is
  skipped — the gauge stays consumable through `/orchestrator:status` and the
  gate lines. One `$.ui.invalidate` per measure, far under the 10/s limit.
- Write the measure file `~/.claude/claude-orchestrator/measure/<session-id>.json`
  each turn: one line, `{ context_tokens, context_window, context_percent,
  model, updated_at }`. This is the only file channel that remains, because
  external processes cannot read the store. `$.fs.write` is not atomic;
  consumers keep tolerant parsing (a partial line reads as unmeasured, the next
  turn rewrites it). Delete the file on `session.end`.
- Model drift: compare `$.session.model()` against the previous turn's value in
  module memory; on change, announce once with the current message text. The
  `ctx/<id>.model` marker file disappears.

## guards.ts

- **Context gate** on `prompt.submit`. Scope and behavior identical to
  `context-gate.sh`: only sessions whose name starts with `Orch :`, `Agent :`,
  `Audit :` or `Coord :` are spoken to; the role line for each prefix is
  carried over verbatim; the gate trips on the double-gate rule above;
  injection rides the prompt's additional context. An unmeurable reading says
  so once per session, never blocks, and the first-prompt case (no measure
  before the first answered turn) stays silent.
- **Push guard** on `tool.call` filtered to the Bash tool, active only when
  `$.env.get('ORCHESTRATOR_SPAWNED')` is set. The awk tokeniser is ported to
  TypeScript in full — same specification: quote and separator handling,
  heredoc bodies, `$(...)` subcommands, arithmetic skipping, reserved words and
  wrappers (`env`, `timeout`, `sudo`, `xargs`, ...), git global options, and
  force detection (`--force` and abbreviations, `-f` alone or clustered,
  `--mirror`, `+<refspec>`, any `--force-with-lease` not of the form
  `=<branch>:<sha>`). The denial text is carried over verbatim. The port is
  pinned by the existing tokeniser fixtures, moved into its `.test.ts`.
- **Stop gate** on `classic.Stop` (the settings-hook event as a module event;
  `e` carries the same stdin JSON). Port `stop_gate.py`'s logic: hold a stop
  until something will wake the orchestrator (busy agent of its own, blocking
  question on the message's last line, nothing left to advance), put the open
  PRs' check state in front once per head, at most one refusal per turn
  (`stop_hook_active`). Check state comes from `ci-watch`'s precomputed data —
  the 10-second handler budget forbids synchronous network calls. Its own
  failures never block: log one line, let the stop pass.
- **Session naming**, a TypeScript port of `session_name.py`: the name is the
  launch name from the process table, else the last `custom-title` entry of the
  transcript, read from the end in blocks through `$.fs`. Shared by both gates.

## supervision.ts

- Store schema: key `sessions/<session-id>` → `{ role, name, repo,
  context_percent, context_tokens, window, model, busy, updated_at }`, written
  on every `session.measure` and turn transition, deleted on `session.end`.
- A dock pane (`$.ui.open`) for coordinator and orchestrator roles: one row per
  supervised session — name, role, fill percent against the gate, age — sorted
  by rotation urgency, refreshed on measure. Display only in v0.49.
- `coordinator.sh` stops reconstructing state from `ps`, `lsof` and `git`; the
  coordination skill reads the store.

## commands.ts

- `$.command.register` for `status`, `progress` and `agents`: instant, no model
  turn, readable while a turn is running. They read the store and print text.
  The three `commands/*.md` files are deleted in the same release, so the names
  do not collide.

## Migration — hard cutover, v0.49.0

Removed in one release:

| Removed | Replaced by |
| --- | --- |
| `statusline-tap.sh`, tap wiring in `settings.json` | the `AbovePrompt` band |
| `ctx/` (all files) | `$.session.usage()` per event |
| skills/context-gauge/ (the whole skill) | `gauge.ts` and the measure file |
| `context-gate.sh`, `push-guard.sh`, `stop-gate.sh`, `stop_gate.py`, `session_name.py` | `guards.ts` |
| `commands/status.md`, `progress.md`, `agents.md` | instant commands |

- `install.sh` requires host 2.1.287 or later, unwraps the tap from
  `settings.json`, and purges `ctx/` on upgrade; `uninstall.sh` drops the
  measure directory.
- Skills shrink: the `context-gauge` skill is deleted; `Thresholds` keeps the
  behavior and loses the measurement instructions (~350 tokens);
  `coordination`'s state sections lose the reconstruction story (~150);
  `Where the rest lives` is updated.
- **bugs-bot 0.2.0, coordinated release**: `gate.py` reads
  `measure/<session>.json` instead of executing `context-gauge.sh`; the
  `GAUGE_GLOB` cache-path search is deleted; its dependency floor becomes
  `orchestrator >= 0.49`.
- Marketplace manifest: single version bump, as for any release.

## Error handling

- Every handler registers a `.catch` that appends one line to the state
  directory's existing log. A failing handler never blocks — the current
  philosophy ("a gate that cannot measure lets the prompt through and says so")
  carries over unchanged.
- Handlers make no synchronous network calls; the 10-second budget is part of
  the design, not an afterthought.
- Where nothing draws (chat-panel surfaces, headless runs), handlers still run:
  gates protect, measures are written, commands answer as text.

## Testing

- One `.test.ts` per domain, run without a session by the host's `plugin test`:
  tokeniser fixtures ported from the shell suite (including the Unicode and
  heredoc cases), double-gate boundaries (79/80 percent, 299,999/300,000
  tokens, windows at and above 1,000,000), role lines per name prefix,
  unmeasured-once semantics, store round-trip and purge, command outputs.
- The host's `plugin validate` in CI: the static pass that lists events and API
  calls, so a renamed event or method fails the build, not the field.
- The 26 skill evals are updated where they referenced `context-gauge.sh` or
  the tap; trigger evals unchanged.
- README gains a line naming the host version the release was tested against.

## Risks

- **`classic.Stop` response semantics in a module** are documented for the
  event's stdin shape but the exact blocking contract must be verified against
  the generated types (`.claude-plugin/types/`) at implementation start.
  Contingency, not plan A: keep the `Stop` settings hook one release longer.
- **Tokeniser parity** (awk → TypeScript) is the highest-risk port; mitigated
  by the fixture suite, which stays the authority on what counts as a forced
  push.
- **The store is invisible to external processes** — by design; the measure
  file is the external channel, and bugs-bot is its only consumer today.
