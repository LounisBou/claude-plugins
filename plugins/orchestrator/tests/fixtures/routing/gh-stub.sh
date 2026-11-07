#!/bin/bash
# A forge stub: `pr view <n> --json title,body,mergeCommit` answers from STUB_MERGE.
[ "$1 $2" = "pr view" ] || { echo "stub: unsupported: $*" >&2; exit 1; }
# STUB_MISSING_PR names a pull request whose merge commit the clone does not hold.
[ "$3" = "${STUB_MISSING_PR:-}" ] && STUB_MERGE=0123456789abcdef0123456789abcdef01234567
printf '{"title":"Add the greeting","body":"Make hello print a greeting.\\n\\n```diff\\n+secret\\n```\\nDone.","mergeCommit":{"oid":"%s"}}\n' "$STUB_MERGE"
