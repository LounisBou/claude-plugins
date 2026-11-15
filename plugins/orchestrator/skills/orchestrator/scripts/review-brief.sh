#!/bin/bash
# review-brief.sh — a review round's brief filled from its fields: review-brief.ts holds the command and its usage.
. "$(dirname "$0")/node-ts.sh"
node_ts_exec review-brief "$(dirname "$0")/review-brief.ts" "$@"
