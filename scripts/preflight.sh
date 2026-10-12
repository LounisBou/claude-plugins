#!/usr/bin/env bash
# Refuse to run when a dependency is missing, so no skill degrades silently.
set -u

# Scopes the host merges, lowest precedence first: user, project, local. The
# override (used by the tests) replaces the user file only.
USER_SETTINGS="${PR_REVIEW_SETTINGS:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json}"
PROJECT_DIR=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

die() {
  printf 'error: %s\n' "$1" >&2
  printf 'fix:   %s\n' "$2" >&2
  exit "$3"
}

# ── System tools ──────────────────────────────────────────────
command -v python3 >/dev/null 2>&1 || die "python3 not found on PATH" "install python3 (3.9 or later)" 11

python3 - <<'PY' || die "python3 is older than 3.9" "install python3 3.9 or later" 11
import sys
sys.exit(0 if sys.version_info >= (3, 9) else 1)
PY

command -v curl >/dev/null 2>&1 || die "curl not found on PATH" "install curl" 11

# ── Repository ────────────────────────────────────────────────
remote=$(git remote get-url origin 2>/dev/null || echo "")
[ -n "$remote" ] || die "no git remote named origin" "run this from a GitHub repository clone" 13
case "$remote" in
  *github.com*) : ;;
  *) die "origin is not a github.com remote: $remote" "run this from a GitHub repository clone" 13 ;;
esac

# ── Plugin dependencies ───────────────────────────────────────
# The authority is enabledPlugins, not the presence of files under
# ~/.claude/plugins/cache: a plugin can sit on disk and be inert.
if [ "${PR_REVIEW_SKIP_PLUGINS:-0}" != "1" ]; then
  missing=$(python3 - "$USER_SETTINGS" "$PROJECT_DIR/.claude/settings.json" "$PROJECT_DIR/.claude/settings.local.json" <<'PY'
import json, sys
# One tuple per dependency: the keys that each satisfy it. The first key is the
# canonical name, reported when none of the alternatives is enabled, so a
# dependency is never named twice. The github plugin resolves under its own
# marketplace key and under the aggregate one -- exactly the pair
# resolve_github.py accepts -- and which key a machine carries depends on where
# it installed from. Demanding one exact key would refuse to start on every
# machine that already has the plugin under the other.
required = [
    ("pr-review-toolkit@claude-plugins-official",),
    ("github@lounisbou", "github@claude-github"),
]
# The later scope wins per plugin key. A file that is absent, unreadable, not
# JSON or of the wrong shape contributes nothing; it never hides another scope.
enabled = {}
for path in sys.argv[1:]:
    try:
        with open(path) as fh:
            data = json.load(fh)
        scope = data["enabledPlugins"] if isinstance(data, dict) else None
    except (OSError, ValueError, KeyError, TypeError):
        continue
    if isinstance(scope, dict):
        enabled.update(scope)
print(" ".join(
    group[0] for group in required
    if not any(enabled.get(key) is True for key in group)
))
PY
)
  py_status=$?
  # If the interpreter dies before printing (crash, killed, bad python3),
  # $missing is empty exactly like the "nothing is missing" case, and the
  # guard would otherwise PASS on no evidence at all -- in the one script
  # whose only job is to catch a missing dependency.
  if [ "$py_status" -ne 0 ]; then
    die "could not check plugin dependencies (python3 exited $py_status)" "check your python3 installation and try again" 10
  fi
  if [ -n "$missing" ]; then
    for dep in $missing; do
      printf 'error: required plugin not installed or not enabled: %s\n' "$dep" >&2
      printf 'fix:   /plugin install %s   then enable it in /plugin\n' "$dep" >&2
    done
    exit 10
  fi
fi

# ── GitHub token ──────────────────────────────────────────────
if [ "${PR_REVIEW_SKIP_AUTH:-0}" != "1" ]; then
  token="${GH_TOKEN:-$(gh auth token 2>/dev/null || echo "")}"
  [ -n "$token" ] || die "no GitHub token available" "gh auth login" 12
fi

exit 0
