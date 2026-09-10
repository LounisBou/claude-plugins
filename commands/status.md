---
description: Live sessions with their measured context fill
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh:*), Bash(ls:*), Bash(jq:*), Bash(date:*), ListAgents
---

Show the orchestrator who is near the rotation gate.

1. Run `ListAgents` and keep the peer list.
2. For every file in `${CLAUDE_CONFIG_DIR:-~/.claude}/claude-orchestrator/ctx/*.json`
   younger than ten minutes, print one row: session id, `context_percent`,
   age in seconds (`date +%s` minus `updated_epoch`).
3. Run `${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh`
   for this session and keep its `context_percent=`, `five_hour_percent=`,
   `seven_day_percent=` and `source=` lines.
4. Present one table: session, context %, age, source. Mark sessions past 60%
   with ⚠: that is the pre-dispatch and mid-work gate of the orchestrator skill.
5. Print the routing pressure under the table, from the two quota figures:
   none below 70 % on both; « one tier down, except the orchestrator, the
   contract-defining phases and the final verification » at or above 70 % on
   either; « no new dispatch, finish what is in flight » at or above 90 %.
   Both figures read `unavailable` when they cannot be measured (the answer
   came from the transcript, or the payload never carried them); say the
   pressure is unavailable rather than assuming none — a pressure nobody
   measured never holds a dispatch, and never clears one either. The rule is `orchestrator:model-routing`.

Session ids are not agent names. If the user needs the mapping, ask each live
agent for its `CLAUDE_CODE_SESSION_ID` through `SendMessage`.

$ARGUMENTS
