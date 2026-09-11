---
description: Restore the previous status line and remove the tap's state directory
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/uninstall.sh:*), Read
---

Run `${CLAUDE_PLUGIN_ROOT}/uninstall.sh` and report its output to the user.

It restores the `statusLine` object saved at install time (or deletes the key
if there was none) and removes `~/.claude/claude-orchestrator/`, tap copy and
state files included. Tell the user to restart their session.

Say clearly what leaves with it, because two of those files are the operator's own
and no backup holds them: the tier map `models.json` — the bindings from `deep`,
`standard` and `light` to real model identifiers — the server catalogue `mcp.json`,
which names the servers this machine offers and the default set every agent gets,
and the prompts directory, which is the record of what every session was launched
with. Offer to copy the map and the catalogue aside before running the script. The tap copy, the context files and the terminal
tooling's environment are all rebuilt by `/orchestrator:install`; the bindings are
not.

$ARGUMENTS
