#!/usr/bin/env bash
# Wires the context tap in front of the current status line and creates the state directory.
#
# Idempotent: a command already starting with the tap copy is left alone. The previous
# statusLine object is saved for uninstall, and settings.json is backed up before any change.
#
#   ./install.sh              install / update
#   ./install.sh --dry-run    print what would happen, change nothing

set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STATE_DIR="$CONFIG_DIR/claude-orchestrator"
TAP_SRC="$SRC/skills/context-gauge/scripts/statusline-tap.sh"
TAP_DEST="$STATE_DIR/statusline-tap.sh"
PREVIOUS="$STATE_DIR/statusline.previous.json"
SETTINGS="$CONFIG_DIR/settings.json"
BACKUP_DIR="$CONFIG_DIR/backups/claude-orchestrator-$(date +%Y%m%d-%H%M%S)"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

say()  { printf '  %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
run()  { if [ "$DRY" = "1" ]; then printf '  [dry-run] %s\n' "$*"; else eval "$@"; fi; }

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

# --- prerequisites ----------------------------------------------------------

step "Prerequisites"

command -v jq >/dev/null 2>&1 || {
  echo "  jq is required (the tap parses the status line payload with it)." >&2
  echo "  macOS: brew install jq — Debian/Ubuntu: sudo apt install jq" >&2
  exit 1
}
say "jq $(jq --version 2>/dev/null | sed 's/^jq-//')"

if command -v python3 >/dev/null 2>&1; then
  say "python3 $(python3 --version 2>&1 | cut -d' ' -f2)"
else
  say "python3 not found: the gauge's transcript tier will be unavailable"
fi

# --- state directory and tap ------------------------------------------------

step "State directory"

run "mkdir -p '$STATE_DIR/ctx'"

# The tier map: three capability tiers, bound by the operator to identifiers this
# plugin must not name. An empty binding means "let the host choose", so a fresh
# install routes exactly as it did before anything is written here.
MODELS_MAP="$STATE_DIR/models.json"
if [ "$DRY" = "1" ]; then
  say "[dry-run] tier map created: $MODELS_MAP"
elif [ -f "$MODELS_MAP" ]; then
  say "tier map already present: $MODELS_MAP"
else
  printf '{"deep": "", "standard": "", "light": ""}\n' > "$MODELS_MAP"
  say "tier map created: $MODELS_MAP"
fi
say "bind deep, standard and light there to the identifiers this host accepts;"
say "an unbound tier leaves the choice to the host."

# The server catalogue, beside the tier map and owned the same way: the named server
# definitions this machine offers, and the default set every agent gets. Empty on a fresh
# install — what a machine offers is the operator's to say, and a plugin that guessed a
# definition would hand every agent something nobody asked for.
MCP_CATALOGUE="$STATE_DIR/mcp.json"
if [ "$DRY" = "1" ]; then
  say "[dry-run] server catalogue created: $MCP_CATALOGUE"
elif [ -f "$MCP_CATALOGUE" ]; then
  say "server catalogue already present: $MCP_CATALOGUE"
else
  printf '{"servers": {}, "default": []}\n' > "$MCP_CATALOGUE"
  say "server catalogue created: $MCP_CATALOGUE"
fi
say "name there the servers this machine offers, in the host's own shape, and list the"
say "elementary ones in default; an agent gets that set, plus what its spawn line adds."

# The environment the tab tooling needs. It drives the terminal through the app's own
# API rather than by typing into a shell, which is where every expensive launch bug came
# from. A private environment rather than the operator's interpreter: recent macOS
# refuses `pip install` into a package-managed Python, and a plugin has no business
# writing into one it did not create.
step "Terminal tooling environment"
VENV="$STATE_DIR/venv"
if [ "$(uname -s)" != "Darwin" ]; then
  say "not macOS: the tab tooling is skipped, the other skills work anywhere"
elif [ "$DRY" = "1" ]; then
  say "[dry-run] python3 -m venv $VENV && pip install iterm2"
elif [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c 'import iterm2' 2>/dev/null; then
  say "environment already usable: $VENV"
elif command -v python3 >/dev/null 2>&1; then
  python3 -m venv "$VENV" >/dev/null 2>&1 || say "could not create $VENV"
  if [ -x "$VENV/bin/pip" ] && "$VENV/bin/pip" install -q --disable-pip-version-check iterm2 >/dev/null 2>&1; then
    say "environment ready: $VENV"
  else
    say "could not install the terminal module into $VENV"
    say "the tab tooling will refuse to run and say so; everything else works"
  fi
else
  say "python3 not found: the tab tooling will refuse to run and say so"
fi
say "iTerm2 must have its API enabled (Preferences > General > Magic > Enable Python API)"
if [ -f "$TAP_DEST" ] && cmp -s "$TAP_SRC" "$TAP_DEST"; then
  say "tap already up to date: $TAP_DEST"
else
  # A copy at a stable path: the plugin's own path changes with every version,
  # and settings.json must keep pointing at a tap that exists.
  run "install -m 755 '$TAP_SRC' '$TAP_DEST'"
  say "tap installed: $TAP_DEST"
fi

# --- settings.json ----------------------------------------------------------

step "settings.json"

if [ ! -f "$SETTINGS" ]; then
  if [ "$DRY" = "1" ]; then say "[dry-run] create $SETTINGS"
  else printf '{}\n' > "$SETTINGS"; chmod 600 "$SETTINGS"; fi
fi
if [ -f "$SETTINGS" ]; then
  jq empty "$SETTINGS" 2>/dev/null || { echo "  $SETTINGS is not valid JSON, aborting." >&2; exit 1; }
  current=$(jq -r '.statusLine.command // ""' "$SETTINGS")
else
  current=""
fi

stored="$current"
current=$(normalise_home "$stored")
case "$current" in
  "$TAP_DEST"|"$TAP_DEST "*)
    say "already wired: $stored"
    ;;
  *)
    if [ -n "$stored" ]; then new="$TAP_DEST $stored"; else new="$TAP_DEST"; fi
    if [ "$DRY" = "1" ]; then
      say "[dry-run] statusLine.command → $new"
    else
      mkdir -p "$BACKUP_DIR"
      cp "$SETTINGS" "$BACKUP_DIR/settings.json.before"
      jq -c '.statusLine // null' "$SETTINGS" > "$PREVIOUS"
      tmp=$(mktemp "${TMPDIR:-/tmp}/orchestrator-XXXXXX")
      jq --arg cmd "$new" \
        '.statusLine = ((.statusLine // {padding: 0}) + {type: "command", command: $cmd})' \
        "$SETTINGS" > "$tmp"
      chmod 600 "$tmp"; mv "$tmp" "$SETTINGS"
      say "statusLine.command → $new"
      say "previous statusLine saved: $PREVIOUS"
    fi
    ;;
esac

# --- verification -----------------------------------------------------------

step "Verification"

if [ "$DRY" = "1" ]; then
  say "[dry-run] probe not executed"
else
  probe='{"session_id":"install-probe","context_window":{"used_percentage":12,"used":24000,"total":200000}}'
  rendered=$(printf '%s' "$probe" | bash "$TAP_DEST") || { echo "  the tap failed to run" >&2; exit 1; }
  [ -f "$STATE_DIR/ctx/install-probe.json" ] || { echo "  the tap wrote no file" >&2; exit 1; }
  rm -f "$STATE_DIR/ctx/install-probe.json"
  say "tap renders: $rendered"
fi

step "Done."
say "Restart your session for the tap to take effect."
exit 0
