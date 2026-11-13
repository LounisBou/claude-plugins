---
name: telemetry
description: Use when asked to scan the recorded session events for secrets, or to summarize past session transcripts into them (a backfill). The export is the /telemetry:export command.
---

# telemetry

```bash
node --experimental-strip-types --no-warnings <this skill's directory>/scripts/telemetry.ts check --config "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
node --experimental-strip-types --no-warnings <this skill's directory>/scripts/telemetry.ts backfill --config "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" <transcript.jsonl>...
```

Print the output as it is. `check` names file, line and pattern of each finding, never the value.
