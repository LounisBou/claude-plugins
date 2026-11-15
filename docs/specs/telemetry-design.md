# Telemetry: session events, collected locally, redacted, exported on demand

The `telemetry` plugin records what the sessions of this machine do (orchestrators,
coordinators, auditors, agents, reviewers, any other) so the method can be audited from data:
models, efforts, durations, context, tokens, cost, tools, refusals, questions, dispatches.
Phase 1 collects and exports. Phase 2 adds what phase 1 left to it (« Phase 2 », below) but for
the dispatch record's own rows; dashboards and analyses are not designed here.

## Where each fact comes from

Live, from the host's hooks (`hooks/register.ts`, a thin adapter over `hooks/collect.ts`),
for what no file holds after the fact: the decider of a refusal, a tool's duration, the context
fill and cost at each turn, a session's start latency, a spawn's link to its parent. After the
fact, from the host's own transcript (`<config>/projects/*/<session>.jsonl`), for what it
already holds: the title (`custom-title`), the effort of each answer, the models, the token
totals. The transcript is read at `session.end` to enrich that event, and by `backfill` for
sessions that ended before the plugin was installed; the daily sweep reads it for a session that
ended without a `session.end` (« Phase 2 »).

## Events (version 1, one JSON object per line)

Every line: `v`, `ts` (ISO, UTC), `event`, `session` (the host's session id); `agent` when the
fact happened in a subagent's loop.

`title` and `role` name the session that acted, from the host's `session_title` at the start, a
successful `rename_session` call, or one read of the first 8 KB of the transcript at the first main
turn's end, and are absent until one gives it; `tool_call.target` (`repo`, `pr`, `head` cut to 12
characters) names what a GitHub act (the `github` tool, a review or a record call, a Bash `gh` or `git push` line) names.

The kinds, each one's fields with their units and the hook or command line that writes it, are
declared once in `plugins/telemetry/hooks/schema.ts`. The writer accepts exactly the declared
kinds, and the export generates the logs repository's schema pages from the same list (« Index »).

`role` is read from the title by core's `parseSessionName` (`orchestrator`, `coordinator`,
`agent`, `auditor`), `reviewer` for a title starting with `Review`, else `other`. Merges and
readiness are the github tool's calls (`tool_call.command`: `pr-merge`, `pr-gate`,
`pr-ready`, `pr-readiness`).

## Phase 2

**Parent orchestrator and tier.** The launcher exports, in a session it spawns, the name of the
orchestrator it reports to (`ORCHESTRATOR_REPORTS_TO`, with `--orchestrator`) and the tier it was
launched on (`ORCHESTRATOR_TIER`, with `--tier`); core's `ENV` declares both. The module reads
them at `session.start` and every event of that session carries `parent` and `launch_tier`. A
session launched without `--orchestrator` has no `parent`, one launched by `--model` or on its
caller's own pair no `launch_tier`: the parent's `agent_spawned`, by title, is then the only link.

**A subagent's later runs.** Each end of a run of a subagent is an `agent_closed`, with `run`, its
rank from the spawn: the first is timed from the spawn, a later one (the child was sent a message
and ran again) from its own first turn. A child whose spawn the module did not see (a resumed
session) closes with no rank.

**The daily sweep.** `telemetry.ts sweep` reads what no hook hands the writer. When the writer
stores a `session_end` and no sweep was started that UTC day (`<config>/telemetry/sweep.json`),
it starts `sweep --auto` as a detached process, whatever `CLAUDE_LOGS_REPO` says. Over the last
seven day files:

- a session whose last event is a day old, with no `session_end` or summary at or after it, and
  whose transcript has not moved for a day either, gets the `session_summary` of its transcript
  (`source: sweep`), written at the later of the transcript's end and its last event; a session
  that runs again after it is summarized again once it has been idle a day;
- a settled question of the orchestrator's round gets a `question` event (`source: round_file`):
  its `id`, the asker as the event's `session`, `title` and `role`, who settled it (`by`), the
  number of choices, the recommended letter and the letter chosen (`other` for other words, `-`
  when it was withdrawn), and the wait. The round files (`round/<id>.json` and `round/archive/`
  under the orchestrator's module directory) are read through core's `parseRoundQuestion`, the
  contract for both of their forms (`docs/contracts.md`, « Round files »); no word of a question
  or an answer leaves them. A question settled before the window, or whose asker's session id is
  not the host's shape (a sender on another machine), is not recorded.

The store alone says what is done: nothing else is kept, so a sweep run twice writes nothing twice.

**Not done: the dispatch record's own rows.** The `dispatch` events are still read from the
`dispatch-record.sh` command lines. The record's owner publishes its writes in its journal (audit
events `step` and `link`: record, row, step, head, session), which carry neither the class, the
tier, the model, the effort nor every subcommand; the events come from the owner once its
published facts hold what the command line gives.

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
- `index/projects/<owner-name>/<machine>/<day>.json`: the same manifest per project, over the sessions
  whose `project` is that repository (`owner/name` of the session's git remote, read once at its
  start, the same from any worktree; the directory's last segment when it has no remote).

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
