---
description: Show what the learning journals hold over the window, answered by code
allowed-tools: Bash(node --experimental-strip-types --no-warnings ${CLAUDE_PLUGIN_ROOT}/skills/learning/scripts/health.ts:*)
---

Run `node --experimental-strip-types --no-warnings ${CLAUDE_PLUGIN_ROOT}/skills/learning/scripts/health.ts --config "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"` and print its output as it is.
