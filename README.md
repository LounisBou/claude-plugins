# bugs-bot

Testers of a project post bug reports and questions in a Telegram group or a Slack channel. One agent session per
project relays each new bug to the session that launched it (its **launcher**, usually the
project's orchestrator), answers the group's questions from the project's own documentation,
talks to the testers warmly, and tags every report as the launcher handles it. This plugin
packages that, generic across projects: one bot, one group per project, one agent per project,
on one machine.

## What you get

| Piece | What it does |
|---|---|
| `bugs-bot pull --watch` | The one process per machine that reads the bot's updates (Telegram, long polling) and each registered Slack channel (polled every ~10 s) and files each message of a registered group into its project's inbox. A reply in a Slack report's thread is recorded on that report (`answer <id>` wakes the agent). Media groups are one report, a 👀 reaction acknowledges it, a message of an unregistered group is dropped and logged. Run by PM2 as `bugs-bot-pull`. |
| `bugs-bot <command>` | The agent's and the launcher's only interface: `list`, `show`, `reply` (`--mention`, `--awaits`, `--follow-up`, `--image`), `edit`, `taken`, `fixed`, `done`, `escalated`, `post`, `triage`, `wait`, `pending`, `overdue`, `person`, `person-note`, `handover write\|read`, `gate`, `deployed`, `agent-prompt`, `backfill-authors`. |
| `/bugs-bot:init` | Binds the repository to its Telegram group or Slack channel (one per project): asks a few questions, finds the group among the bot's pending updates (or in Pull's log of dropped chats) or among the Slack channels the app is in, writes `.bugs-bot.json` (kept out of git through `.git/info/exclude`) and registers the project. Re-run: updates, never duplicates. |
| `/bugs-bot:start` | Launches the project's agent in a tab right of your session, which becomes its launcher. Needs the orchestrator plugin. |
| `/bugs-bot:remove` | Unregisters the project: Pull stops routing its group. Its data and project file are kept. |
| `/bugs-bot:doctor` | Installs the fixed `~/.local/bin/bugs-bot` launcher and checks the machine: python3, each registered channel's token (and that its platform accepts it), registry, Pull running exactly once, the orchestrator plugin, the allow rule. |
| skill `bugs-bot` | The protocol for launchers (what the agent says, and the words that answer it) and for the agent (talking to a reporter, the voice). |
| `agent/AGENT.md` | The agent's instructions. They name no project: its facts come in the startup prompt, from the project file. |

## Install

```
/plugin marketplace add LounisBou/claude-statusbar
/plugin install bugs-bot@lounisbou
/bugs-bot:doctor
```

`/bugs-bot:doctor` installs the launcher, then tells what is left. Every command an agent or a
launcher runs is the plain `bugs-bot <command>`, so **one allow rule holds across every version**
of the plugin. A session may not edit its own permissions: add the rule yourself.

```
/permissions → Allow → Bash(bugs-bot:*)
```

Then start Pull, once per machine (never two: Telegram hands a bot's updates to one consumer):

```
pm2 start <plugin directory>/pm2.config.js && pm2 save
```

PM2 runs `python3` from its own `PATH`; set `BUGS_BOT_PYTHON` to an interpreter (3.10 or newer,
the pyenv binary itself rather than its shim) before the `pm2 start` to choose another.

## Setting up Telegram (the operator, once)

1. Create the bot with **@BotFather** and put its token in `~/.bugs-bot/.env`:
   `TELEGRAM_BOT_TOKEN=...` (mode 0600). The token is read by one module only and never printed.
2. The bot must see every message of the group, not only commands: in BotFather,
   `/setprivacy` → *Disable*, **or** make the bot an administrator of the group. After changing the
   privacy mode, remove the bot from the group and add it again, or Telegram keeps the old mode.
3. Create one group per project, add the bot, and post one message in it.
4. In the project's repository, run `/bugs-bot:init`, then `/bugs-bot:start`.

## Setting up Slack (the operator, once)

1. Create one Slack app for the workspace with a bot user and the bot token scopes
   `channels:history`, `groups:history`, `channels:read`, `groups:read`, `chat:write`,
   `reactions:write`, `files:read`, `files:write` (screenshots sent to reporters), `users:read`. Install it and put its bot token in
   `~/.bugs-bot/.env`: `SLACK_BOT_TOKEN=xoxb-...` (mode 0600). Read by one module only, never printed.
2. Invite the app into each project's channel (`/invite @<app>`).
3. In the project's repository, run `/bugs-bot:init` and choose Slack, then `/bugs-bot:start`.

Slack is read by polling (no Socket Mode, no Events API): each Pull round reads every registered
channel since its cursor and the threads of its open reports; while a Slack project is registered
Telegram's held request is cut to 10 s, so both are read in the same process. HTTP 429 is honoured
(`Retry-After`). `BUGS_BOT_SLACK_API_ROOT` points the Slack channel at a fake (end-to-end runs only).

## Requirements

- `python3` 3.10 or newer; the standard library only.
- PM2, for Pull.
- for `/bugs-bot:start` and the agent's handover: the `orchestrator` plugin (its iTerm launcher
  and context gauge), on macOS with iTerm2.

## Where things live

| What | Where |
|---|---|
| Project file | `<repository>/.bugs-bot.json`, local, never versioned |
| Registry | `~/.bugs-bot/projects.json` (`<channel>:<chat id>` → project, repository) |
| Machine state | `~/.bugs-bot/state.json` (the update offset), `unregistered.json` |
| A project's data | `~/.bugs-bot/<project>/` — `inbox/`, `people/`, `state.json`, `handover.md` |
| Token | `~/.bugs-bot/.env` |

Overrides, for tests and for the end-to-end run: `BUGS_BOT_HOME`, `BUGS_BOT_ENV_FILE`,
`BUGS_BOT_CLAUDE_DIR`, `BUGS_BOT_LAUNCHER_DIR`, `BUGS_BOT_GAUGE`, `BUGS_BOT_API_ROOT` (a fake Bot
API; production never sets it).

## Migrating from the single-project skill

`docs/migration/tm_bugs_to_bugs_bot.py` moves the previous layout (inbox, people, update offset,
token) into a bugs home, and `docs/migration/RUNBOOK.md` gives the steps, rehearsal first. It
refuses to run over a non-empty project directory.

## Tests

```
python3 -m pytest -q      # no network, no PM2, no real ~/.bugs-bot: every location is overridden
sh tests/e2e.sh           # two projects through bin/bugs-bot against a fake Bot API on loopback; prints E2E OK
```

The end-to-end script starts its fake server on a free port of 127.0.0.1 and kills it on every
way out — success, failure, signal. `E2E_FORCE_FAIL=1 sh tests/e2e.sh` fails half-way on purpose to
show it.

## License

MIT.
