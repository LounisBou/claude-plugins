# telemetry

Records what every session of the machine does, as redacted JSON lines, one file per UTC day under
`${CLAUDE_CONFIG_DIR:-~/.claude}/telemetry/events/`, and exports them, on demand and by itself once
a day, to a private repository named by the environment. The design, its events and its fields
(`hooks/schema.ts`), and what is deliberately not recorded: `docs/specs/telemetry-design.md` in the
repository.

## What it records

Session start and end (role from the title, model, effort, launch latency, time to the first
turn, duration, cost, context), each turn's end (duration, tokens, context, the session's
cumulative cost and the turn's own), each tool call (tool, MCP server, outcome, who refused it,
duration, a redacted Bash line), subagents (each of their runs) and launched sessions spawned and closed, questions put
to the operator and the letters chosen (the orchestrator's round questions with their id and asker, read once settled), and the dispatch record's writes (read from the events its script publishes in the orchestrator's journal). Every line names the session that acted (`title` and `role`, once the
module has learned them; `parent` and `launch_tier` in a session the orchestrator's launcher spawned for an orchestrator, on a tier) and each GitHub act the repository, pull request and head it names
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
  It also archives the files of closed work the orchestrator's module directory holds (`lib/archive.ts`), a day after the row closed,
  at `<project>/<YYYY-MM>/<machine>/<kind>/<name>` of the same repository: the brief of a closed
  dispatch row (the `Row:` line of its header), the report it asks for, the review index its verdict
  records and the reports its verdict names; the pull request ledger's archived lines of a month already
  over, and the round's archived questions of a month already over, copied only: the orchestrator's
  live readers (`recordedAsked`, the takeover's settled list) read them where they are, so they stay.
  A file goes through the same scan, JSON read as the text it stores and as its parsed strings (one with
  a hit stays where it is and is named, never its value), and leaves the machine only once the push that carries it is
  done and the repository holds its bytes. A file no closed row names, or one an open row names, is
  never touched, and nothing is deleted from the repository. The result says how many files were
  exported, removed from this machine and kept.
- `telemetry.ts export --auto [--foreground] --config <dir>`: the automatic export.
- `telemetry.ts check --config <dir>`: the scan of the day files, alone (the export scans the archive's files).
- `telemetry.ts backfill --config <dir> <transcript.jsonl>...`: one `session_summary` per past
  transcript.
- `telemetry.ts sweep [--auto] --config <dir>`: over the last seven day files, one
  `session_summary` (`source: sweep`) per session idle for a day that never reached its end, and one
  `question` event per settled question of the orchestrator's round, and one `dispatch` event per
  `dispatch` entry of the orchestrator's journal (`source: journal`, once per entry). A session's end starts it,
  detached, at most once a UTC day (`--auto`).
- `telemetry.ts report --config <dir> [--week <first day>] [--tool <owner/name>]...`: the weekly
  report, read-only, on the seven Paris days from `--week` (the seven ending today by default). It
  prints the spend of the tool against the products' and the unattributed (by repository, from the
  events, a session's directory naming its repository), with the tool's share held to its 20 % cap, each pull request merged with its delay
  (`gh`) and the cost of the sessions that name only it, questions and refusals per day (the round
  files, the events), the week's refusals per guard source (plugin and guard code, from the learning
  journals, which are where the code is kept, with a coverage line: its count against the role table's and the plugins that refused with no journal) and per role (orchestrator, coordinator, auditor, agent,
  other, from the role a session's events carry, a session of another role or of none counted as other), and the nine figures of the target: those no source holds (agents on every
  runnable line, merge to service, code per release) print `n/a` and why, never an estimate. The tool
  is the repository of the working directory unless `--tool` names it. It reads the orchestrator's
  record registry, round and measure files and the learning journals (`docs/contracts.md`, « Weekly report reads »). Three lines
  close it, the checks CI reports and does not block on, read from `npm run -s prompts -- --json` and
  `npm run -s rules -- --json` run in the working directory (the tooling's checkout): the prompt
  budgets by plugin (over or under), the duplicates against their ceiling, the rules held by prose
  alone. From any other directory they print `n/a` and why.

## Retention

The day files of events are kept for ever (a few MB a day, about a tenth of that packed), and the
raw transcripts 90 days in the logs repository (`docs/specs/learning-design.md`, question 9). Git never forgets, so dropping them is a rewrite of the
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

The export does not put them back: it leaves out a transcript last written over 90 days ago
(`MAX_TRANSCRIPT_AGE_DAYS` in `lib/export.ts`) and says how many, though the host keeps its file 365
days. A transcript the repository holds already, whose file has not changed, stays until a rewrite.

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
