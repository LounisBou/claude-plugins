#!/bin/bash
# draft-guard.sh — which failing checks of a draft pull request are draft guards: draft-guard.ts holds the reading and its usage.
. "$(dirname "$0")/node-ts.sh"
node_ts_exec draft-guard "$(dirname "$0")/draft-guard.ts" "$@"
