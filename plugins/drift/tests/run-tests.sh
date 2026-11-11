#!/bin/bash
# drift's suite: the plugin validates, the command's tests pass (a fixture project built at
# several refs in a temporary repository), the browser tests pass (a fixture app captured at
# several refs), and the launcher reaches the command.
#
# Requires bash, git, node, npm and the claude CLI. The browser tests drive the shared Playwright
# install, which install.sh puts in place first: once per machine, a no-op once it is there.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
SCRIPTS="$HERE/skills/drift/scripts"
fail=0
claude plugin validate "$HERE" >/dev/null || { echo "FAIL claude plugin validate"; fail=1; }
node --no-warnings --test "$SCRIPTS"/lib/*.spec.ts "$SCRIPTS"/*.spec.ts || { echo "FAIL the command's tests"; fail=1; }
if "$HERE/install.sh"; then
  node --no-warnings --test "$SCRIPTS"/*.e2e.ts || { echo "FAIL the browser tests"; fail=1; }
else
  echo "FAIL install.sh: the browser tests need the shared Playwright install"
  fail=1
fi
out=$("$SCRIPTS/drift.sh" 2>&1)
code=$?
case "$code:$out" in
  "2:drift: usage: drift build"*) ;;
  *) echo "FAIL drift.sh without a command: exit $code, $out"; fail=1 ;;
esac
# A node too old to run drift.ts is a tool error, exit 2, never the 1 of « differ ».
fake=$(mktemp -d)
printf '#!/bin/sh\n[ "$1" = -p ] && echo 22.6.0 && exit 0\nexit 1\n' > "$fake/node"
chmod +x "$fake/node"
out=$(PATH="$fake:$PATH" "$SCRIPTS/drift.sh" build 2>&1)
code=$?
case "$code:$out" in
  "2:drift: node 22.6.0 is too old"*) ;;
  *) echo "FAIL drift.sh under an old node: exit $code, $out"; fail=1 ;;
esac
rm -rf "$fake"
[ "$fail" -eq 0 ] && echo "drift: all checks passed"
exit "$fail"
