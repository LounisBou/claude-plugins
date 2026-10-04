# Changelog

All notable changes are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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
