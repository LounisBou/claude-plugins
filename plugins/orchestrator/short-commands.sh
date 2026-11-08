#!/usr/bin/env bash
# short-commands.sh — the short names' user commands: skills/orchestrator/scripts/short-commands.ts holds the writer and its usage.
exec node --no-warnings "$(dirname "$0")/skills/orchestrator/scripts/short-commands.ts" "$@"
