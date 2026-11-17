---
name: telemetry
description: Use when asked to scan the recorded session events for secrets, to summarize past session transcripts into them (a backfill), or for the weekly report. The export is the /telemetry:export command.
---

# telemetry

```bash
node --experimental-strip-types --no-warnings <this skill's directory>/scripts/telemetry.ts <check|backfill [--calls]|report> --config "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" [<transcript.jsonl>...]
```

Print the output as it is. `check` names file, line and pattern of each finding, never the value. `report [--week <day>] [--tool <repo>]...` prints the week's cost, delay, questions and refusals.
