# Telemetry: session events, collected locally, redacted, exported on demand

The `telemetry` plugin records what the sessions of this machine do (orchestrators,
coordinators, auditors, agents, reviewers, any other) so the method can be audited from data:
models, efforts, durations, context, tokens, cost, tools, refusals, questions, dispatches.
Phase 1 collects and exports; dashboards and analyses are phase 2.

## Where each fact comes from

Live, from the host's hooks (`hooks/register.ts`, a thin adapter over `hooks/collect.ts`),
for what no file holds after the fact: the decider of a refusal, a tool's duration, the context
fill and cost at each turn, a session's start latency, a spawn's link to its parent. After the
fact, from the host's own transcript (`<config>/projects/*/<session>.jsonl`), for what it
already holds: the title (`custom-title`), the effort of each answer, the models, the token
totals. The transcript is read at `session.end` to enrich that event, and by `backfill` for
sessions that ended before the plugin was installed or ended without a `session.end`.

## Events (version 1, one JSON object per line)

Every line: `v`, `ts` (ISO, UTC), `event`, `session` (the host's session id); `agent` when the
fact happened in a subagent's loop.

| Event | Fields | Source |
|---|---|---|
| `session_start` | `cwd`, `project`, `model`, `interactive`, `surface`, `spawned` (launched by the orchestrator), `startup_ms` (launch to `session.start`) | `session.start`, `$.session.usage().startedAt` |
| `first_turn` | `since_start_ms`, `since_launch_ms` (the « started after 5 minutes ») | the first main `turn.start` |
| `turn_end` | `turn`, `reason`, `duration_ms`, `model`, `tokens` {`in`,`out`,`cache_read`,`cache_write`}, `context_tokens`, `window`, `cost_usd` (the session's, cumulative) | `turn.complete`, `$.session.usage()` |
| `tool_call` | `tool`, `mcp_server`, `mcp_tool`, `tool_use_id`, `outcome` (`ok`, `error`, `refused`), `decided_by` (`user`, `auto_mode`, `safety`, `rule`, `hook`, `plugin`, `plugin:<name>`), `check` {`decision`,`rule`,`hook`,`plugin`,`setting`}, `duration_ms` (permission wait included), `bash` {`head`, `heads`, `line`}, `skill`, `subagent_type`, `command` (an MCP tool's `command` argument) | `tool.call` around `next`, `tool.check` when not `allow` |
| `agent_spawned` | `kind` `subagent`: `child`, `subagent_type`, `model`, `requested_model`, `background`, `provider`, `description`; `kind` `session`: `title`, `role`, `tier`, `model`, `effort`, `permission_mode` | `agent.spawn`; the launcher's `iterm-agent.sh spawn` command line |
| `agent_closed` | `kind`, `child` and `duration_ms` (subagent's first run end), or `title` (launcher's `close`) | `turn.complete` of the child; `iterm-agent.sh close` |
| `question` | `source` (`ask_user`, `round`), `count`, `headers`, `options`, `chosen` (letters), `wait_ms`; for a round, `kind` | `AskUserQuestion`; `mcp__orchestrator__declare_wait` |
| `dispatch` | `sub` (`open`, `round`, `review`, `ready`, `close`, `cost`, …), `record` (file name), `row`, `class`, `tier`, `model`, `effort`, `head`, `verdict` | the `dispatch-record.sh` command line |
| `session_end` | `reason`, `duration_ms`, `turns`, `cost_usd`, `context_tokens`, `window`; enriched: `title`, `role`, `effort`, `models`, `first_turn_ms`, `totals` | `session.end`, then the transcript |
| `session_summary` | the enrichment of `session_end`, plus `cwd`, `started`, `ended`, `tools`, `errors`, `refusals` by decider | `backfill <transcript>` |

`role` is read from the title by core's `parseSessionName` (`orchestrator`, `coordinator`,
`agent`, `auditor`), `reviewer` for a title starting with `Review`, else `other`. Merges and
readiness are the github tool's calls (`tool_call.command`: `pr-merge`, `pr-gate`,
`pr-ready`, `pr-readiness`).

**Left for phase 2**: the parent orchestrator and tier on the child's own events (the child's
environment carries them under `ORCHESTRATOR_*` names core does not declare; today the link is
the parent's `agent_spawned` by title); the round's id, asker and chosen letter (in the
orchestrator's private `round/` files: a contract to add); the dispatch record's own rows; a
subagent's later runs as closes; collection of sessions that never reach `session.end` except
by `backfill`.

## What is not recorded (secrets win over « toutes les données »)

No prompt, answer, message, tool output, file content, question text or option label: the
least revealing default, until the operator rules otherwise. A Bash command line is kept
redacted and cut to 400 characters; other tools keep their name and the enumerated arguments
named above; free text kept (a spawn's description, a verdict) is redacted and cut to 80. The
events carry these fields whole: the writer redacts each whole value, then cuts it (never inside
a mark), so a secret straddling a limit leaves nothing of itself.

## Local store

`<config>/telemetry/events/<YYYY-MM-DD>.jsonl`, the day in UTC, append-only, each append under
core's lock of that file. The module buffers its events in memory and hands them to
`telemetry.ts append` at the end of each main turn, at `session.end`, and past 100 events: one
process per turn, not per call. A hook only observes: it fails open and never delays the call
beyond its own bookkeeping.

## Redaction

`telemetry.ts append` redacts every line before it is written; `check` runs the same scan over
the stored files. When `~/.env` exists but cannot be read, every subcommand refuses, nothing
written or pushed, its reason on stderr; only a missing file means no env secret. The identifiers
of an event's top level (`v`, `ts`, `event`, `session`, `agent`, `child`, `turn`, `tool_use_id`)
are also held to their shape, replaced whole when they do not fit, and spared only the entropy
guess; a nested field of the same name is plain text. Every string, at any depth, is scanned
for, in order:

1. the values of `~/.env` (8 characters or more; a quoted value is what its quotes hold, a
   comment after them dropped) and any `KEY=value` of its keys;
2. private key blocks, and token shapes: GitHub, Anthropic, OpenAI, AWS, Slack, Google,
   Stripe, Telegram bot, npm, JWT;
3. `Authorization:` headers on their whole value, and `Bearer` / `Basic` credentials;
4. credentials in a URL (`scheme://user:pass@`, `scheme://token@`) and secret query parameters;
5. `curl -u user:pass`; `--password X`, `--token=X` and the like; `mysql -pX`, `sshpass -p X`,
   `docker login -p X`; `KEY=value`, `KEY="a b"` or `key: value` where the key names a secret
   (`token`, `secret`, `pass`, `pwd`, `api_key`, …);
6. high entropy: a run of `[A-Za-z0-9+=_-]` whose longest part between `-`, `_` and `.` is 20
   characters or more, with a letter and a digit and 3.5 bits per character, or both cases and
   4.1 bits. A canonical UUID is kept: it is how sessions are joined.

Each match becomes `[REDACTED:<pattern>]`; the value never reaches a log, the terminal or a
model. A field that is exactly one such mark scans clean, so a stored line passes `check`.

## Export

`/telemetry:export` (answered by the module, no model turn) writes the buffered events, then runs
`telemetry.ts export`; when that write fails it says so and exports nothing. The
repository is read at run time from `CLAUDE_LOGS_REPO`, in the environment or in `~/.env`;
nothing names it in this repository. Unset, the export pushes nothing and says so in one line.
Otherwise it runs `check` over every day file and refuses, naming file, line and pattern (never
the value), when one finding remains; then it clones the repository into
`<config>/telemetry/export/` (once, its `origin` set again to the variable's value at each run), copies the day files to `machines/<machine>/`, commits
them and pushes to `main`, which the first push creates; a commit a refused push left behind is
pushed by the next export. Git's own output is redacted, the
repository's address included in each form git prints (without its credentials, without `.git`,
its path), before it is printed.
