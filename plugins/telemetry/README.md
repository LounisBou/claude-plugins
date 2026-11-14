# telemetry

Records what every session of the machine does, as redacted JSON lines, one file per UTC day under
`${CLAUDE_CONFIG_DIR:-~/.claude}/telemetry/events/`, and exports them, on demand and by itself once
a day, to a private repository named by the environment. The design, its events and its fields
(`hooks/schema.ts`), and what is deliberately not recorded: `docs/specs/telemetry-design.md` in the
repository.

## What it records

Session start and end (role from the title, model, effort, launch latency, time to the first
turn, duration, cost, context), each turn's end (duration, tokens, context, cost), each tool call
(tool, MCP server, outcome, who refused it, duration, a redacted Bash line), subagents and
launched sessions spawned and closed, questions put to the operator and the letters chosen, and the
dispatch record's writes. No prompt, answer, message or tool output is kept in the events; the
session's transcript, which holds them, is exported beside them, redacted (see Commands).

## Commands

- `/telemetry:export`: scans every day file for secrets and refuses when one is found; otherwise
  commits the day files to `machines/<machine>/` of the repository `CLAUDE_LOGS_REPO` names (in the
  environment or in `~/.env`), with the raw transcript of each session they name, redacted, in
  `machines/<machine>/transcripts/<session>.jsonl`, and the generated `index/` (a schema page per
  event kind and a manifest per day, pointing at those transcripts), and pushes `main`.
  Unset, it pushes nothing and says so. The export also runs by itself: a session's end starts it,
  detached, at most once a UTC day, one at a time per machine.
- `telemetry.ts export --auto [--foreground] --config <dir>`: the automatic export.
- `telemetry.ts check --config <dir>`: the same scan, alone.
- `telemetry.ts backfill --config <dir> <transcript.jsonl>...`: one `session_summary` per past
  transcript.

## Redaction

Applied to every line before it is written, and run again by the export: the values of
`~/.env`, token shapes, `Authorization` and `Bearer` credentials, credentials in URLs, secret
options and assignments, and high-entropy runs, at any depth, each whole value before it is cut.
The export passes each transcript through the same redaction before it leaves the machine: every
line is parsed and each of its strings redacted, so a value of `~/.env` is masked wherever it sits
in a message. A match becomes `[REDACTED:<pattern>]`. An `~/.env` that exists but cannot be read refuses every
write and export.

## Tests

`tests/run-tests.sh`: the scripts' tests, then the command line end to end against a scratch
repository.
