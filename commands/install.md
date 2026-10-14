---
description: Set this machine up for bugs-bot, once — Python, the fixed launcher and the single Pull process under PM2
allowed-tools: Bash(sh ${CLAUDE_PLUGIN_ROOT}/bin/setup install:*)
---

Set this machine up, once. It asks nothing: the platform (Telegram or Slack),
its bot token and the group belong to each project, through `/bugs-bot:init`.

1. Run the one line:

   ```
   sh ${CLAUDE_PLUGIN_ROOT}/bin/setup install
   ```

   It finds a Python 3.10 or newer already on the machine (`python3.14` …
   `python3.10` and `python3` on the PATH, pyenv's versions, Homebrew's
   prefixes, `uv python find`) and remembers it in `~/.bugs-bot/python`. Only
   when there is none does it install `uv` into `~/.local/bin` (no root, no shell
   profile edited) and then Python 3.12 with `uv python install`: say so when its
   lines show it did. The system Python is never changed.

   Then, through that Python, it installs the fixed launcher `~/.local/bin/bugs-bot`
   and leaves exactly one `bugs-bot-pull` under PM2, saved with `pm2 save`: started
   when there is none, restarted on the new launcher when there is one, replaced
   when PM2 recorded it on a versioned path or in another directory. It never
   starts a second Pull: one running outside PM2 is reported, not doubled.
2. Report each line as printed. On `FAIL  pull`, give its remedy as printed (PM2
   missing: `npm install -g pm2`, then `/bugs-bot:install` again).
3. When it prints `todo  allow rule`, give the operator that one line: he adds
   `Bash(bugs-bot:*)` himself, through `/permissions → Allow → Bash(bugs-bot:*)`.
   A session cannot change its own permissions.
4. Then point him to `/bugs-bot:init` in each project's repository.

Running it again is safe: the launcher is replaced and Pull restarted, never doubled.
