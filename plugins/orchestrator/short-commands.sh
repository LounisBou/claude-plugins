#!/usr/bin/env bash
# short-commands.sh — the short names' user commands: skills/orchestrator/scripts/short-commands.ts holds the writer and its usage.
. "$(dirname "$0")/skills/orchestrator/scripts/node-ts.sh"
node_ts_exec short-commands "$(dirname "$0")/skills/orchestrator/scripts/short-commands.ts" "$@"
