---
description: Use to scan events for secrets, backfill transcripts, or print the weekly report.
---

Run `node --experimental-strip-types --no-warnings <this skill's directory>/scripts/telemetry.ts <check|backfill [--calls]|report> --config "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" [<transcript.jsonl>...]`; print its output.
