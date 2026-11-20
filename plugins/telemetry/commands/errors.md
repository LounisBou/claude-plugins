---
description: Failed calls, grouped
allowed-tools: Bash(node --experimental-strip-types --no-warnings ${CLAUDE_PLUGIN_ROOT}/skills/telemetry/scripts/telemetry.ts errors:*)
---

Run `node --experimental-strip-types --no-warnings ${CLAUDE_PLUGIN_ROOT}/skills/telemetry/scripts/telemetry.ts errors --config "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" $ARGUMENTS`; print its output.
