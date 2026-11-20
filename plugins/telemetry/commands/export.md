---
description: Export the session events
allowed-tools: Bash(node --experimental-strip-types --no-warnings ${CLAUDE_PLUGIN_ROOT}/skills/telemetry/scripts/telemetry.ts export:*)
---

Run `node --experimental-strip-types --no-warnings ${CLAUDE_PLUGIN_ROOT}/skills/telemetry/scripts/telemetry.ts export --config "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"`; print its output.
