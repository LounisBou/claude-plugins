# telemetry

Records what every session of the machine does, as redacted JSON lines, one file per UTC day under
`${CLAUDE_CONFIG_DIR:-~/.claude}/telemetry/events/`, and exports them on demand to a private
repository named by the environment. The design, its events and its fields, and what is
deliberately not recorded: `docs/specs/telemetry-design.md` in the repository.

## What it records

Session start and end (role from the title, model, effort, launch latency, time to the first
turn, duration, cost, context), each turn's end (duration, tokens, context, cost), each tool call
(tool, MCP server, outcome, who refused it, duration, a redacted Bash line), subagents and
launched sessions spawned and closed, questions put to the operator and the letters chosen, and the
dispatch record's writes. No prompt, answer, message or tool output is kept.

## Commands

- `/telemetry:export`: scans every day file for secrets and refuses when one is found; otherwise
  commits the day files to `machines/<machine>/` of the repository `CLAUDE_LOGS_REPO` names (in the
  environment or in `~/.env`) and pushes `main`. Unset, it pushes nothing and says so.
- `telemetry.ts check --config <dir>`: the same scan, alone.
- `telemetry.ts backfill --config <dir> <transcript.jsonl>...`: one `session_summary` per past
  transcript.

## Redaction

Applied to every line before it is written, and run again by the export: the values of
`~/.env`, token shapes, `Authorization` and `Bearer` credentials, credentials in URLs, secret
assignments, and high-entropy runs. A match becomes `[REDACTED:<pattern>]`.

## Tests

`tests/run-tests.sh`: the scripts' tests, then the command line end to end against a scratch
repository.
