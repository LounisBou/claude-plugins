#!/usr/bin/env bash
# Installs the status line into ~/.claude and registers it in settings.json.
#
# Idempotent: re-running updates the script without duplicating anything.
# Nothing is deleted without being copied to ~/.claude/backups/ first.
#
#   ./install.sh              install / update
#   ./install.sh --dry-run    print what would happen, change nothing

set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
DEST_DIR="$CONFIG_DIR/statusbar"
DEST="$DEST_DIR/statusline.sh"
CONFIG="$CONFIG_DIR/statusline-config.txt"
SETTINGS="$CONFIG_DIR/settings.json"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$CONFIG_DIR/backups/statusbar-$STAMP"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

say()  { printf '  %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
run()  { if [ "$DRY" = "1" ]; then printf '  [dry-run] %s\n' "$*"; else eval "$@"; fi; }

# settings.json is free text: a hand-written or templated statusLine.command
# can spell our script's path expanded, or as $HOME/…, ${HOME}/…, ~/… when
# CONFIG_DIR sits under $HOME (the default). List every spelling that
# resolves to $DEST so a wrapped command is recognised regardless of which
# one it uses.
spellings_of() {
  local dest="$1" home="$2" suffix
  printf '%s\n' "$dest"
  case "$dest" in
    "$home"/*)
      suffix="${dest#"$home"/}"
      printf '%s\n' "\$HOME/$suffix"
      printf '%s\n' "\${HOME}/$suffix"
      printf '%s\n' "~/$suffix"
      ;;
  esac
}

already_wired() {
  local cmd="$1" spelling
  while IFS= read -r spelling; do
    case "$cmd" in *"$spelling"*) return 0 ;; esac
  done <<<"$SPELLINGS"
  return 1
}

SPELLINGS=$(spellings_of "$DEST" "$HOME")

# --- prerequisites ----------------------------------------------------------

step "Prerequisites"

command -v jq >/dev/null 2>&1 || {
  echo "  jq is required (the status line parses its stdin payload in a single jq call)." >&2
  echo "  macOS: brew install jq — Debian/Ubuntu: sudo apt install jq" >&2
  exit 1
}
say "jq $(jq --version 2>/dev/null | sed 's/^jq-//')"

# macOS ships bash 3.2; the target script is written for it, so we only check
# that a bash exists at all.
command -v bash >/dev/null 2>&1 || { echo "  bash not found" >&2; exit 1; }
say "bash ${BASH_VERSION%%(*}"

[ -d "$CONFIG_DIR" ] || run "mkdir -p '$CONFIG_DIR'"

# ---------------------------------------------------------------------------
# Migration: removal of the web session-cookie mechanism.
#
# An earlier generation of this status line fetched the 5-hour quota by
# calling the vendor's web API with a session cookie, and a SessionStart hook
# reopened an input dialog whenever that cookie looked dead. Two facts make
# the whole arrangement obsolete and actively harmful:
#
#   1. The data is native. The host now places `rate_limits.five_hour` and
#      `rate_limits.seven_day` straight into the JSON payload it sends to the
#      status line on stdin. No secret is required.
#   2. The validity check could never have worked. That web API sits behind a
#      bot challenge: it answers HTTP 403 carrying `cf-mitigated: challenge`
#      to any non-browser client — with a valid cookie exactly as with a
#      bogus one. The code treated 403 as 401, i.e. "session expired". The
#      verdict was structurally always the same, the cookie was never
#      actually evaluated, and the dialog came back forever.
#
# So the hook and its scripts go. Files are moved, not deleted: the cookie is
# still a secret, and when to erase it is the owner's call.
#
# The names below are the literal on-disk artifacts of that superseded
# mechanism. They are matched verbatim because that is what migration needs.
# ---------------------------------------------------------------------------

LEGACY_FILES=(
  "claude-usage-key.sh"
  "fetch-claude-usage.py"
  "usage-credentials"
  ".cache/usage-key-declined"
  ".cache/usage.json"
)
LEGACY_HOOK_PATTERN="usage-key"

step "Migration: legacy session-cookie mechanism"

legacy_found=0
for name in "${LEGACY_FILES[@]}"; do
  f="$CONFIG_DIR/$name"
  [ -e "$f" ] || continue
  legacy_found=1
  run "mkdir -p '$BACKUP_DIR'"
  run "mv '$f' '$BACKUP_DIR/'"
  say "moved $(basename "$f") → backups/statusbar-$STAMP/"
done

if [ -f "$SETTINGS" ]; then
  # Drops hooks (on any event) whose command matches the legacy pattern, then
  # the groups left empty, then the events left empty.
  hook_hit=$(jq --arg pat "$LEGACY_HOOK_PATTERN" \
             '[.hooks // {} | to_entries[] | .value[]? | .hooks[]?
               | select((.command // "") | test($pat))] | length' \
             "$SETTINGS" 2>/dev/null || echo 0)
  if [ "${hook_hit:-0}" -gt 0 ]; then
    legacy_found=1
    say "$hook_hit legacy hook(s) removed from settings.json"
    if [ "$DRY" = "0" ]; then
      mkdir -p "$BACKUP_DIR"
      cp "$SETTINGS" "$BACKUP_DIR/settings.json.before"
      tmp=$(mktemp)
      jq --arg pat "$LEGACY_HOOK_PATTERN" '.hooks |= (
            with_entries(
              .value |= ( map(.hooks |= map(select((.command // "") | test($pat) | not)))
                        | map(select((.hooks | length) > 0)) )
            )
            | with_entries(select((.value | length) > 0))
          )
          | if (.hooks | length) == 0 then del(.hooks) else . end' \
        "$SETTINGS" > "$tmp"
      chmod 600 "$tmp"; mv "$tmp" "$SETTINGS"
    fi
  fi
fi

[ "$legacy_found" = "0" ] && say "nothing to migrate (clean install)"

# --- script -----------------------------------------------------------------

step "Script"

run "mkdir -p '$DEST_DIR'"
if [ -f "$DEST" ] && cmp -s "$SRC/statusline/statusline.sh" "$DEST"; then
  say "already up to date: $DEST"
else
  run "install -m 755 '$SRC/statusline/statusline.sh' '$DEST'"
  say "installed: $DEST"
fi

# The old install lived at the root of the config directory; archive it so no
# leftover settings.json can keep pointing at a frozen copy.
if [ -f "$CONFIG_DIR/statusline-command.sh" ]; then
  run "mkdir -p '$BACKUP_DIR'"
  run "mv '$CONFIG_DIR/statusline-command.sh' '$BACKUP_DIR/'"
  say "archived the previous statusline-command.sh"
fi

# --- settings ---------------------------------------------------------------

step "Settings"

if [ -f "$CONFIG" ]; then
  say "kept: $CONFIG"
else
  run "cp '$SRC/statusline/statusline-config.default.txt' '$CONFIG'"
  say "created: $CONFIG"
fi

# --- settings.json ----------------------------------------------------------

step "settings.json"

if [ "$DRY" = "1" ]; then
  say "[dry-run] statusLine → $DEST"
else
  [ -f "$SETTINGS" ] || { printf '{}\n' > "$SETTINGS"; chmod 600 "$SETTINGS"; }
  jq empty "$SETTINGS" 2>/dev/null || {
    echo "  $SETTINGS is not valid JSON, aborting." >&2; exit 1; }

  # Another tool (the context gauge's tap) can turn statusLine.command into
  # "<tap script> <previous command>". If it already carries our path, wrapped
  # or not, the wiring is done: overwriting it would drop the tap.
  current=$(jq -r '.statusLine.command // ""' "$SETTINGS")
  if [ -n "$current" ] && already_wired "$current"; then
    say "statusLine already wired to this status bar: $current"
  else
    mkdir -p "$BACKUP_DIR"
    [ -f "$BACKUP_DIR/settings.json.before" ] || cp "$SETTINGS" "$BACKUP_DIR/settings.json.before"
    tmp=$(mktemp)
    jq --arg cmd "$DEST" '.statusLine = {type: "command", command: $cmd, padding: 0}' \
       "$SETTINGS" > "$tmp"
    chmod 600 "$tmp"; mv "$tmp" "$SETTINGS"
    say "statusLine → $DEST"
  fi
fi

# --- verification -----------------------------------------------------------

step "Verification"

if [ "$DRY" = "1" ]; then
  say "[dry-run] render not executed"
else
  now=$(date +%s)
  probe="{\"workspace\":{\"current_dir\":\"$PWD\"},\"model\":{\"display_name\":\"a-model\"},
          \"context_window\":{\"used_percentage\":26},
          \"rate_limits\":{\"five_hour\":{\"used_percentage\":47,\"resets_at\":$((now + 8010))},
                           \"seven_day\":{\"used_percentage\":50,\"resets_at\":$((now + 259200))}}}"
  rendered=$(printf '%s' "$probe" | bash "$DEST") || {
    echo "  the script failed to run" >&2; exit 1; }
  [ -n "$rendered" ] || { echo "  empty render, something is wrong" >&2; exit 1; }
  printf '%s\n' "$rendered" | sed 's/^/  /'
fi

step "Done."
say "Restart your session for the bar to show up."

# An `if` block, not a trailing `&&` chain: as the last statement of the
# script, a false condition would become the exit status and report a clean
# install as a failure.
if [ "$legacy_found" = "1" ] && [ "$DRY" = "0" ]; then
  say ""
  say "Migration applied. The previous files are in:"
  say "  $BACKUP_DIR"
  say "That folder holds your old web session cookie: delete it whenever you"
  say "like (rm -rf), and revoke the cookie by signing out on the web if it matters."
fi

exit 0
