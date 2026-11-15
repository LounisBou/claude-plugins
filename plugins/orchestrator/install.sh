#!/usr/bin/env bash
# install.sh — creates the state directory and the short commands: skills/orchestrator/scripts/install.ts holds it and its usage.
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$SRC/skills/orchestrator/scripts/node-ts.sh"
node_ts_exec install "$SRC/skills/orchestrator/scripts/install.ts" "$SRC" install "$@"
