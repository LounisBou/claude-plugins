---
description: Live sessions with their measured context fill
allowed-tools: Bash(ls:*), Bash(jq:*), Bash(date:*), Bash(cat:*), ListAgents
---

Show the orchestrator who is near the rotation gate.

The hooks module answers this command on the spot, with no model turn: one line per live
session from its store — name, role, context fill and the age of its last measure — the
sessions past the gate first. The steps below run only when that answer fails, and the
host then runs this body as a prompt.

1. Run `ListAgents` and keep the peer list.
2. For every file in `${CLAUDE_CONFIG_DIR:-~/.claude}/claude-orchestrator/measure/*.json`,
   print one row: session id (the file's name), `context_percent`,
   `context_tokens`, `context_window`, `model`, `updated_at` as read.
3. Read your own session's measure file —
   `${CLAUDE_CONFIG_DIR:-~/.claude}/claude-orchestrator/measure/$CLAUDE_CODE_SESSION_ID.json`,
   one JSON line the module writes on every gauge pass — and keep its figures.
4. Present one table: session, context %, tokens, window, model, updated. Mark
   sessions past the gate — the smaller of 300,000 tokens (30 %) and 80 % of the reported window: 300,000 on 1,000,000, 533,000 or 400,000; 160,000 on 200,000 — with ⚠: that is the pre-dispatch and mid-work
   gate of the orchestrator skill, « Thresholds ».

Session ids are not agent names. If the user needs the mapping, ask each live
agent for its `CLAUDE_CODE_SESSION_ID` through `SendMessage`.

$ARGUMENTS
