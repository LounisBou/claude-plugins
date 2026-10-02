# Changelog

All notable changes are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — unreleased

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
- `tests/e2e.sh`: two projects driven through `bin/bugs-bot` against a fake Bot API.
- `BUGS_BOT_API_ROOT`, to point the Telegram channel at that fake (end-to-end runs only).
- Slack beside Telegram, ONE channel per project chosen at `init` (`--channel slack`): the project
  file's `channel`, a registry keyed `<channel>:<chat_id>`, Slack read by polling
  (`conversations.history` since a cursor per channel, `conversations.replies` of the open reports'
  threads), a thread reply recorded on its report as an answer (`wait` prints `answer <id>`),
  HTTP 429 honouring `Retry-After`; Telegram's held request cut to 10 s while a Slack project is
  registered; `doctor` asks each registered platform whether it accepts its token.
- `BUGS_BOT_SLACK_API_ROOT`, to point the Slack channel at a fake (end-to-end runs only).
