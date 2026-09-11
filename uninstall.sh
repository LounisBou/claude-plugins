#!/usr/bin/env bash
# Restores the status line that preceded the tap and removes the state directory.
#
#   ./uninstall.sh            restore
#   ./uninstall.sh --dry-run  print what would happen, change nothing

set -euo pipefail

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STATE_DIR="$CONFIG_DIR/claude-orchestrator"
TAP_DEST="$STATE_DIR/statusline-tap.sh"
PREVIOUS="$STATE_DIR/statusline.previous.json"
SETTINGS="$CONFIG_DIR/settings.json"
BACKUP_DIR="$CONFIG_DIR/backups/claude-orchestrator-$(date +%Y%m%d-%H%M%S)"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

say() { printf '  %s\n' "$*"; }

# A stored command may spell the home as `$HOME`, `${HOME}` or `~` — a settings file kept
# in a repository and meant for more than one machine does — while TAP_DEST is expanded.
# The comparison is made on the expanded spelling; what is stored is never rewritten (§33).
normalise_home() {
  case "$1" in
    '$HOME/'*)   printf '%s' "$HOME/${1#\$HOME/}" ;;
    '${HOME}/'*) printf '%s' "$HOME/${1#\$\{HOME\}/}" ;;
    '~/'*)       printf '%s' "$HOME/${1#\~/}" ;;
    *)           printf '%s' "$1" ;;
  esac
}

if [ -f "$SETTINGS" ]; then
  current=$(jq -r '.statusLine.command // ""' "$SETTINGS" 2>/dev/null || echo "")
  current=$(normalise_home "$current")
  case "$current" in
    "$TAP_DEST"|"$TAP_DEST "*)
      if [ "$DRY" = "1" ]; then
        say "[dry-run] statusLine restored from $PREVIOUS"
      else
        mkdir -p "$BACKUP_DIR"
        cp "$SETTINGS" "$BACKUP_DIR/settings.json.before"
        tmp=$(mktemp "${TMPDIR:-/tmp}/orchestrator-XXXXXX")
        if [ -f "$PREVIOUS" ] && [ "$(cat "$PREVIOUS")" != "null" ]; then
          jq --slurpfile prev "$PREVIOUS" '.statusLine = $prev[0]' "$SETTINGS" > "$tmp"
        else
          jq 'del(.statusLine)' "$SETTINGS" > "$tmp"
        fi
        chmod 600 "$tmp"; mv "$tmp" "$SETTINGS"
        say "statusLine restored"
      fi
      ;;
    *)
      say "statusLine does not point at the tap, left untouched"
      ;;
  esac
fi

if [ -d "$STATE_DIR" ]; then
  if [ "$DRY" = "1" ]; then say "[dry-run] rm -rf $STATE_DIR"
  else rm -rf "$STATE_DIR"; say "removed $STATE_DIR (tap, context files, prompts, tier map)"; fi
fi

say "Done. Restart your session."
exit 0
