---
description: Check this machine's bugs-bot setup; it changes nothing
allowed-tools: Bash(bugs-bot:*)
---

Check the setup and report the verdict. Doctor only reads: it installs, starts
and writes nothing. Whatever is missing at the machine level is set up by
`/bugs-bot:install`; a project's token and group by `/bugs-bot:init`.

1. If `bugs-bot` is not on the PATH, this machine was never installed: say so,
   point the operator to `/bugs-bot:install`, and stop. Otherwise run:

   ```
   bugs-bot doctor
   ```

2. Report each line as printed (`ok` or `FAIL`, the check and its detail), then
   what to do about each failure:
   - `python`, `interpreter`, `launcher`, `pull`: `/bugs-bot:install`. It finds or
     installs a Python 3.10+, installs the launcher, and leaves exactly one
     `bugs-bot-pull` under PM2 (a record on a versioned path or in a throwaway
     directory is replaced). When `pull` names two processes, say which pids:
     the operator stops the one PM2 does not run.
   - `token`: `TELEGRAM_BOT_TOKEN` is missing from `~/.bugs-bot/.env`:
     `/bugs-bot:init` asks for it the first time a project uses Telegram (the
     operator runs `bugs-bot token --channel telegram --set` in his own terminal).
     Never print it.
   - `slack token`: `SLACK_BOT_TOKEN` (`xoxb-…`), the same way, with
     `--channel slack`. Never print it.
   - `telegram bot` / `slack bot`: the platform refused the token (Telegram's
     `getMe`, Slack's `auth.test`): the operator replaces it in the file.
   - `registry`: the file `~/.bugs-bot/projects.json` is damaged; say so, do not
     edit it.
   - `orchestrator`: install the orchestrator plugin, 0.49 or later (`/plugin marketplace update lounisbou`, `/plugin update orchestrator@lounisbou`, then restart); `/bugs-bot:start` needs it, and `gate --measure` reads the measure file 0.49 writes.
   - `allow rule`: the operator adds `Bash(bugs-bot:*)` himself, through
     `/permissions → Allow → Bash(bugs-bot:*)`. A session cannot change its own
     permissions, and doctor never edits a settings file: print the line for him.
3. The exit code is 0 only when every check passes.
