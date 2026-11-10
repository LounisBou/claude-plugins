#!/bin/bash
# drift's suite: the plugin validates, the command's tests pass (a fixture project built at
# several refs in a temporary repository), and the launcher reaches the command.
#
# Requires bash, git, node and the claude CLI.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
SCRIPTS="$HERE/skills/drift/scripts"
fail=0
claude plugin validate "$HERE" >/dev/null || { echo "FAIL claude plugin validate"; fail=1; }
node --no-warnings --test "$SCRIPTS"/lib/*.spec.ts "$SCRIPTS"/*.spec.ts || { echo "FAIL the command's tests"; fail=1; }
out=$("$SCRIPTS/drift.sh" 2>&1)
code=$?
case "$code:$out" in
  "2:drift: usage: drift build"*) ;;
  *) echo "FAIL drift.sh without a command: exit $code, $out"; fail=1 ;;
esac
[ "$fail" -eq 0 ] && echo "drift: all checks passed"
exit "$fail"
