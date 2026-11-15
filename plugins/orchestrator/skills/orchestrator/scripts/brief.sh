#!/bin/bash
# brief.sh — the briefs printed from the state: brief.ts holds the commands and their usage.
. "$(dirname "$0")/node-ts.sh"
node_ts_exec brief "$(dirname "$0")/brief.ts" "$@"
