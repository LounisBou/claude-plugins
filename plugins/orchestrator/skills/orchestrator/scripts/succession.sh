#!/bin/bash
# succession.sh — the succession brief generated from the state, and its completeness check: succession.ts holds both and its usage.
exec node --no-warnings "$(dirname "$0")/succession.ts" "$@"
