#!/bin/bash
# rhythm.sh — an audit's net balance, read from git alone: rhythm.ts holds the reading and its usage.
. "$(dirname "$0")/node-ts.sh"
node_ts_exec rhythm "$(dirname "$0")/rhythm.ts" "$@"
