#!/bin/bash
# method's suite: the plugin validates, and every reference the kernel names exists.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
fail=0
claude plugin validate "$HERE" >/dev/null || { echo "FAIL claude plugin validate"; fail=1; }
for ref in $(grep -o 'references/[a-z-]*\.md' "$HERE/skills/lifecycle/SKILL.md" | sort -u); do
  [ -f "$HERE/skills/lifecycle/$ref" ] || { echo "FAIL the kernel names $ref, which does not exist"; fail=1; }
done
[ "$fail" -eq 0 ] && echo "method: all checks passed"
exit "$fail"
