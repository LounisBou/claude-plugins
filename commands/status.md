---
description: Live sessions with their measured context fill
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh:*), Bash(ls:*), Bash(jq:*), Bash(date:*), ListAgents
---

Show the orchestrator who is near the rotation gate.

1. Run `ListAgents` and keep the peer list.
2. For every file in `${CLAUDE_CONFIG_DIR:-~/.claude}/claude-orchestrator/ctx/*.json`
   younger than ten minutes, print one row: session id, `context_percent`,
   `context_used`, `context_total`, age in seconds (`date +%s` minus
   `updated_epoch`).
3. Run `${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh`
   for this session and keep its `context_percent=`, `context_tokens=`,
   `context_window=` and `source=` lines.
4. Present one table: session, context %, tokens, window, age, source. Mark
   sessions past the gate — 80 % of the window, or 300,000 tokens on a window of 1,000,000 tokens or more — with ⚠: that is the pre-dispatch and mid-work
   gate of the orchestrator skill, « Thresholds ».

Session ids are not agent names. If the user needs the mapping, ask each live
agent for its `CLAUDE_CODE_SESSION_ID` through `SendMessage`.

$ARGUMENTS
