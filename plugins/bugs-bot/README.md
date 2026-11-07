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
| `bugs-bot <command>` | The agent's and the launcher's only interface: `list`, `show`, `reply` (`--mention`, `--awaits`, `--follow-up`, `--image`), `edit`, `delete`, `taken`, `fixed`, `done`, `escalated`, `post`, `triage`, `wait`, `pending`, `overdue`, `unask`, `person`, `person-note`, `person-lang`, `handover write\|read`, `gate`, `deployed`, `agent-prompt`, `backfill-authors`. |
| `/bugs-bot:init` | Binds the repository to its Telegram group or Slack channel (one per project): asks a few questions, the platform's bot token the first time this machine serves that platform (typed by you in your own terminal, hidden, written to `~/.bugs-bot/.env` at mode 0600), finds the group among the bot's pending updates (or in Pull's log of dropped chats) or among the Slack channels the app is in, writes `.bugs-bot.json` (kept out of git through `.git/info/exclude`) and registers the project. Re-run: updates, never duplicates. |
| `/bugs-bot:start` | Launches the project's agent in a tab right of your session, which becomes its launcher. Needs the orchestrator plugin. |
| `/bugs-bot:remove` | Unregisters the project: Pull stops routing its group. Its data and project file are kept. |
| `/bugs-bot:install` | Once per machine: finds a Python 3.10 or newer (installs one with `uv` only when there is none) and remembers it, installs the fixed `~/.local/bin/bugs-bot` launcher, and leaves exactly one `bugs-bot-pull` under PM2, saved (restarted on a re-run, never doubled). Asks nothing; prints the allow rule for you to add. |
| `/bugs-bot:doctor` | Checks the machine and changes nothing: Python and the remembered interpreter, each registered channel's token (and that its platform accepts it), registry, Pull running exactly once, the orchestrator plugin at 0.49 or later, the launcher, the allow rule. Points to `/bugs-bot:install` for whatever is missing at the machine level. |
| hooks module | Where the host loads plugin modules: `/bugs-bot:start` runs its steps itself, with no model turn; the `bugs` tool (`mcp__bugs-bot__bugs`) runs the CLI with its arguments as a list, no shell quoting, and measures `gate --measure` from the session itself; a guard refuses a group post naming a PR, a commit, a branch, a local path or a host other than the deployment URL, and any read of the token file. Where modules do not load (`claude -p`, an older host), the markdown command, the shell form and the orchestrator's measure file do the same work. |
| skill `bugs-bot` | The protocol for launchers (what the agent says, and the words that answer it) and for the agent (talking to a reporter, the voice). |
| `agent/AGENT.md` | The agent's instructions. They name no project: its facts come in the startup prompt, from the project file. |

## Install (once per machine)

```
/plugin marketplace add LounisBou/claude-plugins-marketplace
/plugin install bugs-bot@lounisbou
/bugs-bot:install
```

`/bugs-bot:install` asks nothing: the platform, its token and the group belong to each project. It:

1. finds a Python 3.10 or newer and remembers it (see [Python](#python));
2. installs the fixed launcher `~/.local/bin/bugs-bot`. PM2 runs that launcher, not a path inside the
   plugin's versioned directory, so a plugin update does not break the saved process;
3. leaves exactly one Pull, `bugs-bot-pull`, under PM2 (never two: Telegram hands a bot's updates to one
   consumer), started from `pm2.config.js` with the home directory as its working directory, then runs
   `pm2 save`. Run again, it restarts that one on the new launcher; a record on a versioned path or in
   another directory is replaced; a Pull running outside PM2 is reported, not doubled. It needs PM2
   (`npm install -g pm2`);
4. prints the one allow rule to add when it is missing. Every command an agent or a launcher runs is the
   plain `bugs-bot <command>`, so **one rule holds across every version** of the plugin. A session may
   not edit its own permissions: add it yourself.

```
/permissions → Allow → Bash(bugs-bot:*)
```

`/bugs-bot:doctor` checks all this later and changes nothing.

The launcher runs the interpreter remembered in `~/.bugs-bot/python`, read at every start, so PM2's Pull
runs it too. `BUGS_BOT_PYTHON`, set before the `pm2 start`, still wins (the pyenv binary itself rather
than its shim).

## Per project

In the project's repository, run `/bugs-bot:init`, then `/bugs-bot:start`. `init` asks the project's
questions and where its group is (Telegram or Slack). The first time this machine serves that platform,
its bot token is missing from `~/.bugs-bot/.env`: `init` asks you, once, to run
`bugs-bot token --channel <telegram|slack> --set` in a terminal of your own. It reads the token with a
hidden prompt and writes it at mode 0600; the token never goes through the session, a command line or
any output. Then `init` binds the group.

## Python

bugs-bot needs Python 3.10 or newer and the standard library only: no virtual environment.
`/bugs-bot:install` runs `sh <plugin>/bin/setup install`, which looks for one already on the machine, in
this order: `BUGS_BOT_PYTHON`, the one remembered before, `python3.14` … `python3.10` and `python3` on
the `PATH`, pyenv's versions, Homebrew's prefixes, `uv python find '>=3.10'`. Only when none is found
does it install `uv` (its standalone installer, into `~/.local/bin`, no root, no shell profile edited)
and then Python 3.12 with `uv python install 3.12`. The interpreter it found or installed is remembered
in `~/.bugs-bot/python`; the launcher, PM2's Pull and the hooks module run it. The system Python is
never changed. Run on an older Python, the CLI says to run `/bugs-bot:install` instead of failing at
start.

## Setting up Telegram (the operator, once)

1. Create the bot with **@BotFather**. Keep its token for the first `/bugs-bot:init` of a Telegram
   project, which has you type it into `bugs-bot token --channel telegram --set`
   (`TELEGRAM_BOT_TOKEN` in `~/.bugs-bot/.env`, mode 0600). Read by one module only, never printed.
2. The bot must see every message of the group, not only commands: in BotFather,
   `/setprivacy` → *Disable*, **or** make the bot an administrator of the group. After changing the
   privacy mode, remove the bot from the group and add it again, or Telegram keeps the old mode.
3. Create one group per project, add the bot, and post one message in it.
4. In the project's repository, run `/bugs-bot:init`, then `/bugs-bot:start`.

## Setting up Slack (the operator, once)

1. Create one Slack app for the workspace with a bot user and the bot token scopes
   `channels:history`, `groups:history`, `channels:read`, `groups:read`, `chat:write`,
   `reactions:write`, `files:read`, `files:write` (screenshots sent to reporters), `users:read`. Install it and keep its bot token
   (`xoxb-…`) for the first `/bugs-bot:init` of a Slack project, which has you type it into
   `bugs-bot token --channel slack --set` (`SLACK_BOT_TOKEN` in `~/.bugs-bot/.env`, mode 0600). Read by
   one module only, never printed.
2. Invite the app into each project's channel (`/invite @<app>`).
3. In the project's repository, run `/bugs-bot:init` and choose Slack, then `/bugs-bot:start`.

Slack is read by polling (no Socket Mode, no Events API): each Pull round reads every registered
channel since its cursor and the threads of its open reports; while a Slack project is registered
Telegram's held request is cut to 10 s, so both are read in the same process. HTTP 429 is honoured
(`Retry-After`). `BUGS_BOT_SLACK_API_ROOT` points the Slack channel at a fake (end-to-end runs only).

## Known limitations

- **An edit on Slack is not seen.** A tester who edits a message on Telegram updates its report
  (`edited <id>`); on Slack, Pull reads `conversations.history`, which never returns
  `message_changed` (an Events API and RTM event only), so the report keeps the text first
  posted. Its detection comes with the live Slack test.

## Requirements

- Python 3.10 or newer (found or installed by `/bugs-bot:install`, see [Python](#python)); the standard library only.
- PM2, for Pull.
- for `/bugs-bot:start` and the agent's handover: the `orchestrator` plugin (its iTerm launcher
  and the hooks module that measures the agent's context), on macOS with iTerm2.

## Where things live

| What | Where |
|---|---|
| Project file | `<repository>/.bugs-bot.json`, local, never versioned |
| Registry | `~/.bugs-bot/projects.json` (`<channel>:<chat id>` → project, repository) |
| Machine state | `~/.bugs-bot/state.json` (the update offset), `unregistered.json` |
| A project's data | `~/.bugs-bot/<project>/` — `inbox/`, `people/`, `state.json`, `handover.md` |
| Token | `~/.bugs-bot/.env` |

Overrides, for tests and for the end-to-end run: `BUGS_BOT_HOME`, `BUGS_BOT_ENV_FILE`,
`BUGS_BOT_CLAUDE_DIR`, `BUGS_BOT_LAUNCHER_DIR`, `BUGS_BOT_API_ROOT` (a fake Bot
API; production never sets it).

## Migrating from the single-project skill

`docs/migration/tm_bugs_to_bugs_bot.py` moves the previous layout (inbox, people, update offset,
token) into a bugs home, and `docs/migration/RUNBOOK.md` gives the steps, rehearsal first. It
refuses to run over a non-empty project directory.

## Tests

```
python3 -m pytest -q      # no network, no PM2, no real ~/.bugs-bot: every location is overridden
claude plugin test .      # the hooks module, against the host's own engine, every child and file faked
claude plugin validate .  # the manifest and what the module hooks
sh tests/e2e.sh           # two Telegram projects and one Slack project through bin/bugs-bot against a fake Bot API and a fake Slack API on loopback; prints E2E OK
```

The end-to-end script starts its fake servers on free ports of 127.0.0.1 and kills them on every
way out — success, failure, signal. `E2E_FORCE_FAIL=1 sh tests/e2e.sh` fails half-way on purpose to
show it. It also shadows `ps` with an empty process table, so a real Pull running on the machine
does not change its result.

## License

MIT.
