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

The kinds, each one's fields with their units and the hook or command line that writes it, are
declared once in `plugins/telemetry/hooks/schema.ts`. The writer accepts exactly the declared
kinds, and the export generates the logs repository's schema pages from the same list (« Index »).

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

No prompt, answer, message, tool output, file content, question text or option label in the
events: the least revealing default, until the operator rules otherwise. The operator's order of
2026-11-14 puts the raw transcripts, redacted, in the logs repository beside the events (below).
A Bash command line is kept redacted and cut to 400 characters; other tools keep their name and the enumerated arguments
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
   `docker login -p X` (on the command word, across escaped newlines and quoted arguments, in
   linear time); `KEY=value`, `KEY="a b"` or `key: value` where the key names a secret (`token`,
   `secret`, `pass`, `pwd`, `api_key`, …);
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

### Automatic export

The export needs no one to remember it. When the writer stores a `session_end`, it starts
`telemetry.ts export --auto` as a detached process, so the session's end is not held. That run
exports at most once per UTC day (`<config>/telemetry/auto.json` records the day of the last
export that finished); a failed one is retried no sooner than an hour later. It takes the lock
beside the clone (`<config>/telemetry/export.lock`) without waiting: sessions ending together
leave the export to the one that holds it, and the lock is re-read for the day under it. A
`/telemetry:export` takes the same lock and waits its turn. The last automatic run's lines are
in `<config>/telemetry/export.log`. With `CLAUDE_LOGS_REPO` unset the writer says so once, in the
session's log, and pushes nothing; it says so again if the variable is set and later unset. The
secret scan refuses the automatic export as it refuses the manual one.

### Index

Each export also writes `index/` in the logs repository, regenerated whole from the declared
kinds and the day files, so a reader (an auditor, the learning distiller) queries it without
reading every line:

- `index/README.md`: the layout and the list of kinds.
- `index/schema/<event>.md`: one page per declared kind, its fields, units and writers;
  `index/schema/manifest.md` for the manifest; `index/schema.json`, the same machine-readable.
  A kind added to the list in `hooks/schema.ts` joins the pages with no other edit.
- `index/<machine>/<day>.json`: the day's manifest, built by `lib/manifest.ts` from the day file:
  its sessions (role, models, title, project, cost, span, whether it ended), the pull requests,
  branches and dispatch rows its events name, the github tool's commands by count, and for each
  session the path of its redacted transcript in the repository.

Raw transcripts are exported, redacted (the operator's order of 2026-11-14: everything goes into
the logs repository, indexed like the rest). The export copies the transcript of each session the
day files name to `machines/<machine>/transcripts/<session>.jsonl`, after passing it through
`lib/redact.ts`: each line parsed, each string and each key redacted at any depth; a line that is
no JSON becomes a mark, never text (a value of `~/.env` sits in it as JSON wrote it, or cut short),
and the last line, while the host may still be writing it, waits for the next export. The values of
`~/.env` never reach the repository. The manifest names that copy, nothing of its content, and none
for a session whose transcript was skipped. A transcript that cannot be read or redacted, or is over
the size cap, is skipped and named in the result; one export takes up to a bound of transcript
bytes and the rest waits, so a first export of several GB never holds the day files back; a
transcript whose copy the repository holds and whose file is unchanged is not read again. The
export refreshes its lock before each git command and each transcript. The index is scanned as the day files are: a secret it would carry
refuses the export, nothing pushed.
