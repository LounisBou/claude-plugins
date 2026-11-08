#!/usr/bin/env bash
# /pr-review:install, and /pr-review:doctor with --check.
#
# Without --check it first gives the machine a GitHub login the skills can use. That login is
# the github plugin's, a dependency of this one: its install.sh installs gh and signs in, each
# step skipped when already satisfied, and keeps the token in gh's credential store. This script
# only finds that plugin, through the resolver its skills use, and runs it; GH_TOKEN set in the
# environment needs nothing.
#
# Then, and alone with --check, it runs the preflight every skill runs, which writes nothing.
# Removing the plugin is the uninstall; gh and its login stay, because they are the user's own.
set -u

ROOT=$(cd "$(dirname "$0")" && pwd)

die() {
  printf 'error: %s\n' "$1" >&2
  printf 'fix:   %s\n' "$2" >&2
  exit "$3"
}

github_login() {
  [ -n "${GH_TOKEN:-}" ] && return 0
  local gh_root
  # The resolver prints its own error: and fix: lines; the github plugin is what is missing.
  gh_root=$(python3 "$ROOT/scripts/resolve_github.py") || exit 12
  [ -f "$gh_root/install.sh" ] \
    || die "the github plugin at $gh_root has no install.sh" "/plugin install github@lounisbou" 12
  bash "$gh_root/install.sh"
}

check_only=0
[ "${1:-}" = "--check" ] && check_only=1

code=0
if [ "$check_only" -eq 0 ] && [ "${PR_REVIEW_SKIP_AUTH:-0}" != "1" ]; then
  # A subshell, so a die in the login stops the login and not the report.
  ( github_login )
  code=$?
fi

# Capture the preflight's own exit code. `if cmd; then ...; fi` with no else
# branch leaves $? at 0 when the condition fails, so reading it after the fi
# would report success for a failed check — in the one script whose whole job
# is to report that failure.
if [ "$code" -eq 0 ]; then
  bash "$ROOT/scripts/preflight.sh" --deps-only
  code=$?
fi

if [ "$code" -eq 0 ]; then
  echo "pr-review: all dependencies satisfied."
  echo
  echo "Skills available:"
  echo "  /pr-review:start-review       walk through review feedback one item at a time"
  echo "  /pr-review:process-comments   work through a PR's comments interactively"
  echo "  /pr-review:auto-fix-loop      review, fix and re-review until clean"
  echo
  echo "GitHub tool: provided by the github plugin dependency"
  exit 0
fi

echo "pr-review: not ready. Fix the item above, then run /pr-review:install again." >&2
exit "$code"
