#!/bin/bash
# goals.sh — the spec's goals of one build: goals.ts holds the grammar and its usage.
. "$(dirname "$0")/node-ts.sh"
node_ts_exec goals "$(dirname "$0")/goals.ts" "$@"
