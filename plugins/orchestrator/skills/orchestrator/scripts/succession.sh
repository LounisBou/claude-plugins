#!/bin/bash
# succession.sh — the takeover printed from the state alone: succession.ts holds it and its usage.
exec node --no-warnings "$(dirname "$0")/succession.ts" "$@"
