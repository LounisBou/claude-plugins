---
description: Show and change the status bar display settings
allowed-tools: Read(${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-config.txt), Edit(${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-config.txt), Bash(${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusbar/statusline.sh:*)
---

Help the user tune their status line.

1. Read `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-config.txt` and present the active settings.
2. Apply the user's request (`$ARGUMENTS`) by editing that file.

A setting changed in the host's `/config` menu is written over the file's line for it the next time the
session starts, so tell the user to use `/config` for a setting they have already changed there.

Every setting is `1` (shown) or `0` (hidden):

| Key | Effect |
|---|---|
| `SHOW_DIRECTORY` | current directory name |
| `SHOW_BRANCH` | git branch |
| `SHOW_GIT_STATUS` | `*` when dirty, `↑↓` ahead/behind, `{n}` stashes |
| `SHOW_PR` | number and state of the open PR |
| `SHOW_MODEL` | model name |
| `SHOW_SESSION_NAME` | session name set with `/rename` |
| `SHOW_CONTEXT` | percentage of context consumed |
| `SHOW_CONTEXT_TOKENS` | tokens next to that percentage, against the gate in an orchestration session |
| `SHOW_USAGE` | 5-hour quota |
| `SHOW_SEVEN_DAY` | 7-day quota |
| `SHOW_PROGRESS_BAR` | ten-block bar next to the quotas |
| `SHOW_RESET_TIME` | quota reset deadline |
| `RESET_COUNTDOWN` | `1` = time left (`2h13`), `0` = absolute time/date |
| `SHOW_LINES_CHANGED` | `+added/-removed` counter |

3. Show the result by replaying a sample payload:

```bash
printf '%s' '{"workspace":{"current_dir":"'"$PWD"'"},"model":{"display_name":"a-model"},"context_window":{"used_percentage":26},"rate_limits":{"five_hour":{"used_percentage":47,"resets_at":'"$(( $(date +%s) + 8010 ))"'}}}' | "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusbar/statusline.sh"
```

$ARGUMENTS
