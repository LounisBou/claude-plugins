---
description: Install or update the two-line status bar
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/install.sh:*), Read
disable-model-invocation: true
---

Run `${CLAUDE_PLUGIN_ROOT}/install.sh` and report its output to the user.

The script is idempotent: it copies the status line script into
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusbar/`, creates `statusline-config.txt` there if missing,
writes the `statusLine` key into `settings.json` there, and migrates an
install of the old session-cookie mechanism.

Nothing is deleted: migrated files are moved to
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/backups/statusbar-<timestamp>/`.

Once it finishes, tell the user to restart their session for the bar to appear.

$ARGUMENTS
