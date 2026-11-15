#!/bin/bash
# brief-lint.sh — flags a brief before it is dispatched: brief-lint.ts holds the checks and their usage.
. "$(dirname "$0")/node-ts.sh"
node_ts_exec brief-lint "$(dirname "$0")/brief-lint.ts" "$@"
