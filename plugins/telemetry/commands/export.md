---
description: Export the recorded session events to the logs repository, after their secret scan
allowed-tools: Bash(node --experimental-strip-types --no-warnings ${CLAUDE_PLUGIN_ROOT}/skills/telemetry/scripts/telemetry.ts export:*)
---

Run `node --experimental-strip-types --no-warnings ${CLAUDE_PLUGIN_ROOT}/skills/telemetry/scripts/telemetry.ts export --config "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"` and print its output as it is.
