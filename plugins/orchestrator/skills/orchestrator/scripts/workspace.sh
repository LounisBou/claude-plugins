#!/bin/bash
# workspace.sh — a checkout per phase, with the project's local material: workspace.ts holds the commands, their guards and their usage.
exec node --no-warnings "$(dirname "$0")/workspace.ts" "$@"
