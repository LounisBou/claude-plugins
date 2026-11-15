#!/bin/bash
# workspace.sh — a checkout per phase, with the project's local material: workspace.ts holds the commands, their guards and their usage.
. "$(dirname "$0")/node-ts.sh"
node_ts_exec workspace "$(dirname "$0")/workspace.ts" "$@"
