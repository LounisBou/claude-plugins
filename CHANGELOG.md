# Changelog

All notable changes are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.4.0 — 2026-10-14

### Added

- `bin/setup`: finds a Python 3.10 or newer already on the machine (`BUGS_BOT_PYTHON`, the one remembered
  before, `python3.14` … `python3.10` and `python3` on the `PATH`, pyenv's versions, Homebrew's prefixes,
  `uv python find`) and remembers it in `~/.bugs-bot/python`. Only when none is found does it install `uv`
  with its standalone installer into `~/.local/bin` (no root, no shell profile edited), then
  `uv python install 3.12`. The system Python is never changed; no virtual environment.
- `doctor`'s `interpreter` check: the remembered interpreter (or `BUGS_BOT_PYTHON`) exists.
- `/bugs-bot:install` (`bugs-bot install`), once per machine: Python through `bin/setup`, the fixed
  launcher, then exactly one `bugs-bot-pull` under PM2 and `pm2 save`. Run again, it restarts that one on
  the new launcher; a record on a versioned path or in another directory is replaced; a Pull running
  outside PM2 is reported, never doubled. It asks nothing (no platform, no token) and prints the allow
  rule `Bash(bugs-bot:*)` for the operator to add.
- `bugs-bot token --channel <kind> [--set]`: says whether the platform's token is in `~/.bugs-bot/.env`;
  `--set`, only when it is missing, reads it from a hidden prompt (or standard input) and writes it once,
  at mode 0600. The token never travels on a command line and is never printed.

### Changed

- `/bugs-bot:doctor` only checks and changes nothing: `--install-launcher` is gone, and each machine-level
  failure (Python, interpreter, launcher, Pull) points to `/bugs-bot:install`.
- `/bugs-bot:init` asks for the platform's token the first time this machine serves it: the operator runs
  `bugs-bot token --channel <kind> --set` in his own terminal. The README splits « Install (once per
  machine) » from « Per project ».
- The fixed launcher, and through it PM2's Pull, runs the remembered interpreter when `BUGS_BOT_PYTHON`
  is not set; so do `/bugs-bot:start` and the `bugs` tool. `doctor`'s PM2 remedy no longer asks for
  `BUGS_BOT_PYTHON`.

### Fixed

- On a new machine whose `python3` is older than 3.10, bugs-bot failed at start. The CLI now says that
  Python 3.10 or newer is needed and to run `/bugs-bot:install`, which finds or installs one.

## 0.3.0 — 2026-10-12

### Added

- A hooks module (`hooks/register.ts`), loaded where the host loads plugin modules. Where it does not
  load (`claude -p`, an older host), every command, the shell form and the measure file work as before.
- `/bugs-bot:start` runs its seven steps itself and answers with no model turn: the project file, the
  orchestrator's install directory from the host's record (`bugs-bot plugin-path`), its version read
  from its manifest, `ListAgents`, `agent-prompt`, the `--resident` spawn, then `list`, `move` and
  `verify`. A step it cannot read before the spawn hands the run to the markdown command; after the
  spawn nothing falls back, so a second agent is never launched.
- The `bugs` tool (`mcp__bugs-bot__bugs`): the CLI's commands, `wait` and the machine's own aside, with
  the arguments as a JSON list, so no shell quoting can cut a text posted to testers. It runs this
  plugin's own CLI, needs no launcher on the PATH, and honours the existing `Bash(bugs-bot:*)` grant:
  without one, reads pass and writes are put to the person.
- The `bugs` tool's `gate --measure` measures the session's own context and hands the CLI
  `--tokens` and `--window`; the orchestrator's measure file is read only before the session's first
  answer, and by the plain `bugs-bot gate --measure` where the module does not load.
- A guard on what reaches the group: a `reply`, `edit`, `post` or `done --reason`, through the shell or
  the tool, whose text holds a PR or ticket number, a commit hash, a branch, a path of the machine, a
  local host or a link to a host other than `deploy_url` is refused with the reason; a text built by
  `$(…)`, a backquote or a variable is refused as unreadable. A token the person typed in the session
  passes.
- A guard on the token file: a session's Read, Grep or shell line reaching `~/.bugs-bot/.env` (or
  `BUGS_BOT_ENV_FILE`) is refused, unless the person named `.env` in the session.

## 0.2.2 — 2026-10-12

### Fixed

- The newest installed copy of a plugin was guessed from the cache with `sort -V | tail -1`, but the host
  keeps every version side by side, plain and `<version>-<sha>` tagged, so the guess could be a stale
  copy. The fixed launcher and `/bugs-bot:start` now read `installPath` from the host's
  `installed_plugins.json`, through the new `bugs-bot plugin-path <name>`; the newest cached directory
  is only the fallback when the record is absent or unreadable.

## 0.2.1 — 2026-10-12

### Fixed

- `doctor`'s `orchestrator` check reads a version installed from a tag, which the host records with
  its commit after a dash (`0.49.1-2afa38391c2b`). It failed every such install as unreadable.

## 0.2.0 — 2026-10-10

### Changed

- `bugs-bot gate --measure` reads the orchestrator plugin's hooks module measure file
  (`<config dir>/claude-orchestrator/measure/<session id>.json`, one JSON line the module
  writes each turn) instead of running the plugin's retired `context-gauge.sh`. The command
  and its `gate_tokens=` / `context_tokens=` / `context_window=` / `handover=` line are
  unchanged; a partial, empty or absent file is one error line, exit 1. The plugin
  dependency now requires orchestrator `>=0.49`, the release whose module writes the file.
- `doctor`'s `orchestrator` check reads the active install from the host's
  `plugins/installed_plugins.json` and fails below 0.49. It no longer takes the last directory
  of the plugin cache, which keeps every version side by side.

## 0.1.5 — 2026-10-05

### Changed

- `/bugs-bot:start` spawns the project's agent with `--resident`. The agent sits idle by design
  while its own `bugs-bot wait` blocks, and that wait wakes it; the launcher's stop gate read it as
  an idle agent to read or relaunch, and no longer counts it as one. The orchestrator plugin's
  launcher must be 0.46.1 or newer, the first to know the flag: with an older one, `start` stops
  and asks for `claude plugin update orchestrator@lounisbou`, and never spawns without the flag.

## 0.1.4 — 2026-10-04

### Changed

- The agent writes to its launcher only to bring it information: no acknowledgement of a protocol
  phrase, no « where does each stand » round on restart (the reports never relayed are
  relayed as new reports by the first wait, as « Each new report » says), no launcher confirmation round, no handover line to the launcher (the
  predecessor–successor exchange stays). A launcher message outside the protocol table is answered
  only when it asks a question. The launcher's instructions (`skills/bugs-bot/SKILL.md`) follow.
- `bugs-bot wait` has a ceiling of 3300 seconds, under the host's one-hour prompt-cache lifetime
  (it was 7000), and exits 3 at that ceiling with no output; an event still exits 0. The agent
  re-arms on exit 3 with one tool call and no read of the output. An idle agent no longer rewrites
  its whole cache on every empty wake.
- `agent/AGENT.md` is shorter, 5361 words before and 4447 after: each rule stated once, the other
  places pointing to it. No rule changed.

## 0.1.3 — 2026-10-04

### Fixed

- `pm2.config.js` pins the working directory of `bugs-bot-pull` to the home directory. PM2 otherwise
  records the directory of the shell that ran `pm2 start`; a throwaway checkout there, once deleted,
  broke the next restart.
- `doctor`'s `pull` check also fails when PM2 recorded a working directory other than the home
  directory for `bugs-bot-pull`, with the remedy `cd ~ && pm2 delete bugs-bot-pull`, then
  `BUGS_BOT_PYTHON=<python 3.10+> pm2 start <plugin>/pm2.config.js && pm2 save`. When the versioned
  path is wrong too, one verdict names both and carries one remedy. The migration runbook's update
  steps start with `cd ~`.

## 0.1.2 — 2026-10-04

### Fixed

- PM2 runs Pull through the version-independent launcher `~/.local/bin/bugs-bot` instead of the
  versioned plugin directory, so a plugin update that prunes the old version no longer leaves
  `bugs-bot-pull` without a script on its next restart. The launcher honours `BUGS_BOT_PYTHON` for
  the interpreter; a machine re-installs it with `doctor --install-launcher` (`doctor`
  reports a launcher that differs).
- `doctor`'s `pull` check fails, with the remedy, when PM2 recorded a versioned path under
  `plugins/cache/lounisbou/bugs-bot/` for `bugs-bot-pull`, also when no Pull runs (a pruned version),
  and reads `pm2 jlist` after the lines PM2 prints when it starts its daemon. The remedy carries the
  interpreter: `bugs-bot doctor --install-launcher`, `pm2 delete bugs-bot-pull`, then
  `BUGS_BOT_PYTHON=<python 3.10+> pm2 start <plugin>/pm2.config.js && pm2 save`; the migration runbook
  lists these steps.

## 0.1.1 — 2026-10-03

### Fixed

- `bugs-bot wait` returns only when something is due: its default ceiling goes from 30 minutes to
  7000 seconds, just under the host's 2-hour limit on a background command, and the agent
  re-arms an empty exit with no text and no context measure, measuring only after a handled
  event. An idle agent no longer replays its whole context every half hour for nothing.

## 0.1.0 — 2026-10-02

First release: the single-project Telegram bug relay, made a generic Claude Code plugin.

### Added

- One bot, one Telegram group and one agent per project; a local project file `.bugs-bot.json`
  and a machine registry route each group's messages to its project's inbox.
- `bugs-bot pull --watch`, one long-polling process per machine, run by PM2 as `bugs-bot-pull`
  (`BUGS_BOT_PYTHON` picks its interpreter); the update offset is machine-wide.
- `/bugs-bot:init`, `/bugs-bot:start`, `/bugs-bot:remove`, `/bugs-bot:doctor` and the fixed
  `~/.local/bin/bugs-bot` launcher, so one allow rule, `Bash(bugs-bot:*)`, holds across versions.
- A generic agent: project facts injected into its startup prompt; a handover note
  (`handover write|read`) and per-person cards that keep threads and tone across a succession;
  follow-ups after `follow_up_hours`; `gate --measure` and `deployed`.
- `docs/migration/`: the script and runbook moving the previous single-project layout, the update
  offset copied exactly and the token written with mode 0600.
- `tests/e2e.sh`: two Telegram projects and one Slack project driven through `bin/bugs-bot` against a
  fake Bot API and a fake Slack API.
- `BUGS_BOT_API_ROOT`, to point the Telegram channel at that fake (end-to-end runs only).
- Slack beside Telegram, ONE channel per project chosen at `init` (`--channel slack`): the project
  file's `channel`, a registry keyed `<channel>:<chat_id>`, Slack read by polling
  (`conversations.history` since a cursor per channel, `conversations.replies` of the open reports'
  threads), a thread reply recorded on its report as an answer (`wait` prints `answer <id>`),
  HTTP 429 honouring `Retry-After`; Telegram's held request cut to 10 s while a Slack project is
  registered; `doctor` asks each registered platform whether it accepts its token.
- `BUGS_BOT_SLACK_API_ROOT`, to point the Slack channel at a fake (end-to-end runs only).
- Screenshots to reporters: `reply <id> "<text>" --image <path>` (repeatable) and `post … --image`,
  1 to 10 PNG, JPEG or WebP images of 10 MB at most, all checked before anything is sent; Telegram
  `sendPhoto` / `sendMediaGroup` (multipart built with the standard library), Slack's external upload
  (`files:write`); each image sent copied to the report's `sent/` and listed by `show`. The agent asks
  its launcher « capture <id> : … », looks at every image before sending it, and never sends one
  showing code, a terminal, a commit, an internal host, a local path, a token or another person's data.
- Edited messages: a tester's edit of a message already recorded (Telegram `edited_message`, Slack
  `message_changed`) replaces its text in the report — the report's own, or an answer's — under the
  project's lock, the previous text kept in the report's `edits`; `wait` prints `edited <id>` until
  `show` has printed it. An edit never creates a report, never sets or clears a wait, never changes a
  status or a reaction; the edit of a message no report records is ignored.

### Known limitations

- An edit of a message on Slack is not seen: Pull polls `conversations.history`, which never returns
  `message_changed` (an Events API and RTM event only). The report keeps the text first posted; edits
  are read on Telegram only. Detection comes with the live Slack test.
