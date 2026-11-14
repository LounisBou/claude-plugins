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
dispatch record's writes. Every line names the session that acted (`title` and `role`, once the
module has learned them) and each GitHub act the repository, pull request and head it names
(`target`). No prompt, answer, message or tool output is kept in the events; the
session's transcript, which holds them, is exported beside them, redacted (see Commands).

## Commands

- `/telemetry:export`: scans every day file for secrets and refuses when one is found; otherwise
  commits the day files to `machines/<machine>/` of the repository `CLAUDE_LOGS_REPO` names (in the
  environment or in `~/.env`), with the raw transcript of each session they name, redacted, in
  `machines/<machine>/transcripts/<session>.jsonl`, and the generated `index/` (a schema page per
  event kind and a manifest per day, pointing at those transcripts, and the same manifest per project at
  `index/projects/<owner-name>/<machine>/<day>.json`), and pushes `main`. A session's project is the
  `owner/name` of its git remote, the same from any worktree (the directory's name when it has none).
  Unset, it pushes nothing and says so. The export also runs by itself: a session's end starts it,
  detached, at most once a UTC day, one at a time per machine.
- `telemetry.ts export --auto [--foreground] --config <dir>`: the automatic export.
- `telemetry.ts check --config <dir>`: the same scan, alone.
- `telemetry.ts backfill --config <dir> <transcript.jsonl>...`: one `session_summary` per past
  transcript.

## Retention

The operator's answer of 2026-11-14 (`docs/specs/learning-design.md`, question 9): the day files of
events are kept for ever (a few MB a day, about a tenth of that packed), and the raw transcripts
90 days in the logs repository. Git never forgets, so dropping them is a rewrite of the
repository, once a year, and the operator's act: no command, hook or schedule does it.

### Yearly rewrite

Once a year, from a clone of the repository `CLAUDE_LOGS_REPO` names, with no export running:

1. List the transcripts older than 90 days: those under `machines/<machine>/transcripts/` whose
   last commit is more than 90 days old (`git log -1 --format=%cs -- <path>`).
2. Rewrite the history without them (`git filter-repo --invert-paths --path <file> …`, or
   `--paths-from-file` with the list), keeping the day files and `index/`. A pointer to a
   transcript that is gone is missing evidence to the retrospective.
3. Check that the day files are all still there, then force-push `main`, and expire the old objects
   (`git reflog expire --expire=now --all && git gc --prune=now --aggressive`) in every clone,
   the machine's own included.

Known limit: the export copies a transcript the repository does not hold whenever the host still
has its file and a day file names its session, and the host keeps each file 365 days. Until the
export itself leaves out the transcripts older than 90 days, which it does not yet, the next export
puts back the dropped ones younger than 365 days, and the rewrite frees only the older ones.

The host keeps its own copy of each transcript 365 days (`cleanupPeriodDays`), which this does
not touch. The yearly size to expect: about 6 GB packed at 365 days, about 1.6 GB at 90.

## Redaction

Applied to every line before it is written, and run again by the export: the values of
`~/.env`, token shapes, `Authorization` and `Bearer` credentials, credentials in URLs, secret
options and assignments, and high-entropy runs, at any depth, each whole value before it is cut.
The export passes each transcript through the same redaction before it leaves the machine: every
line is parsed and each of its strings and keys redacted, so a value of `~/.env` is masked wherever
it sits in a message. A line that is no JSON becomes `[REDACTED:not-json]`; the last line, while the
host is still writing it, waits for the next export. A transcript that cannot be read or redacted, or
is over `MAX_TRANSCRIPT_BYTES`, is skipped and named in the result, its manifest entry null. One
export takes at most `MAX_RUN_BYTES` of transcripts (both in `lib/export.ts`): the rest is said and
waits for the next, and a transcript already pushed whose file has not changed is not read again.
A match becomes `[REDACTED:<pattern>]`. An `~/.env` that exists but cannot be read refuses every
write and export.

## Tests

`tests/run-tests.sh`: the scripts' tests, then the command line end to end against a scratch
repository.
