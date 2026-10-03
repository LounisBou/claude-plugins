---
description: Check this machine's bugs-bot setup and install the fixed `bugs-bot` launcher
allowed-tools: Bash(python3 ${CLAUDE_PLUGIN_ROOT}/bin/bugs-bot doctor:*), Bash(bugs-bot:*)
---

Check the setup and report the verdict.

1. If `bugs-bot` is not yet on the PATH (the first run), the launcher does not
   exist: run it through the plugin itself, which also installs the launcher:

   ```
   python3 ${CLAUDE_PLUGIN_ROOT}/bin/bugs-bot doctor --install-launcher
   ```

   Later runs are `bugs-bot doctor`. An installed launcher whose text differs (an update changed it) is
   replaced by `bugs-bot doctor --install-launcher`, not by a plain `bugs-bot doctor`.
2. Report each line as printed (`ok` or `FAIL`, the check and its detail), then
   what to do about each failure:
   - `python`: Python 3.10 or newer is needed.
   - `token`: `TELEGRAM_BOT_TOKEN` goes in `~/.bugs-bot/.env`; never print it.
   - `slack token`: `SLACK_BOT_TOKEN` (`xoxb-…`) goes in the same file; never print it.
   - `telegram bot` / `slack bot`: the platform refused the token (Telegram's
     `getMe`, Slack's `auth.test`): the operator puts a valid one in the file.
   - `registry`: the file `~/.bugs-bot/projects.json` is damaged; say so, do not
     edit it.
   - `pull`: exactly one Pull process must run, under PM2; none or two is a fault. When it says PM2
     recorded a versioned path, print its remedy as given: the operator runs `bugs-bot doctor
     --install-launcher`, then `pm2 delete bugs-bot-pull`, then `pm2 start` of the plugin's
     `pm2.config.js` with `BUGS_BOT_PYTHON` set to a Python 3.10+, then `pm2 save`.
   - `orchestrator`: install the orchestrator plugin; `/bugs-bot:start` needs it.
   - `launcher`: run the first-run line above; a launcher that differs is replaced by
     `bugs-bot doctor --install-launcher`.
   - `allow rule`: the operator adds `Bash(bugs-bot:*)` himself, through
     `/permissions → Allow → Bash(bugs-bot:*)`. A session cannot change its own
     permissions, and doctor never edits a settings file: print the line for him.
3. The exit code is 0 only when every check passes.
