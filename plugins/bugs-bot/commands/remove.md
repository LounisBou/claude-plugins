---
description: Unregister this project so Pull stops routing its group (data and project file are kept)
allowed-tools: Bash(bugs-bot:*)
---

Release this repository's group from the bot.

1. Run `bugs-bot remove` (add `--project <id>` when the current directory is not
   inside the project's repository).
2. Report what it printed: the registry entry is removed, and the data directory
   under `~/.bugs-bot/` and `.bugs-bot.json` are kept, so a later
   `/bugs-bot:init` picks the project up again with its reports and people.

Nothing is deleted. If the operator wants the data or the file gone, say where
they are and let him remove them himself.
