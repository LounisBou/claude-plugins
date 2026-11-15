#!/usr/bin/env bash
# uninstall.sh — removes the state directory and the short commands: skills/orchestrator/scripts/install.ts holds it and its usage.
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$SRC/skills/orchestrator/scripts/node-ts.sh"
node_ts_exec uninstall "$SRC/skills/orchestrator/scripts/install.ts" "$SRC" uninstall "$@"
