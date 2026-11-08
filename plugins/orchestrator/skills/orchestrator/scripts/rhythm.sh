#!/bin/bash
# rhythm.sh — an audit's net balance, read from git alone: rhythm.ts holds the reading and its usage.
exec node --no-warnings "$(dirname "$0")/rhythm.ts" "$@"
