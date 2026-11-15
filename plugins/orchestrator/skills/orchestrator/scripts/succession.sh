#!/bin/bash
# succession.sh — the takeover printed from the state alone: succession.ts holds it and its usage.
. "$(dirname "$0")/node-ts.sh"
node_ts_exec succession "$(dirname "$0")/succession.ts" "$@"
