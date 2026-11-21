---
description: Live sessions with their measured context fill
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh:*), Bash(ls:*), Bash(jq:*), Bash(date:*), Bash(cat:*), ListAgents
---

Show the orchestrator who is near the rotation gate.

The hooks module answers this command on the spot, with no model turn: one line per live
session from its store — name, role, context fill, age of its last measure — the sessions
past the gate first. The steps below run only when that answer fails.

1. Run `ListAgents`; keep the list.
2. For every file in `<module>/measure/*.json` (`<module>`: `module=` of `${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh roots`),
   print one row: session id (the file's name), `context_percent`,
   `context_tokens`, `context_window`, `model`, `updated_at`.
3. Keep the figures of your own, `<module>/measure/$CLAUDE_CODE_SESSION_ID.json`.
4. Present one table: session, context %, tokens, window, model, updated. Mark
   sessions past the gate — the smaller of 300,000 tokens (30 %) and 80 % of the reported window: 300,000 on 1,000,000; 160,000 on 200,000 — with ⚠: that is the pre-dispatch and mid-work
   gate.

$ARGUMENTS
