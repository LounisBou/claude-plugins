#!/bin/bash
# lens-model.sh — the model of a review's readers, from the diff's class: lens-model.ts holds the command and its usage.
. "$(dirname "$0")/node-ts.sh"
node_ts_exec lens-model "$(dirname "$0")/lens-model.ts" "$@"
