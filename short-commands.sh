#!/usr/bin/env bash
# Writes the plugin's short names as user commands: `/coordinator`, `/orchestrator-status` and
# the rest, one file per row of short-names.tsv in the host's user commands directory.
#
#   ./short-commands.sh install   [--dry-run] [--dir <path>]   write the absent, rewrite its own
#   ./short-commands.sh uninstall [--dry-run] [--dir <path>]   remove its own
#   ./short-commands.sh sync      [--dir <path>]               rewrite its own that differ
#
# Each file is its plugin command copied whole, with the plugin root spelled out where the
# plugin command says ${CLAUDE_PLUGIN_ROOT} (the host expands no plugin variable in a user
# command) and a marker line after the opening `---`. The marker is what makes a file this
# plugin's: a file of the same name without it is the operator's, never written, never removed.
# `sync` is the module's pass at each session start: after a plugin update the copies still
# name the earlier version's root, and it rewrites them, never creating one the operator removed.
#
# The directory: --dir, else ORCHESTRATOR_COMMANDS_DIR, else the config dir's commands/.

set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MAP="$SRC/short-names.tsv"
MARKER='installed-by: claude-orchestrator'

mode=${1:-}
[ $# -gt 0 ] && shift
DRY=0
DEST="${ORCHESTRATOR_COMMANDS_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/commands}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --dir) DEST="$2"; shift 2 ;;
    *) echo "  unknown option: $1 (expected --dry-run, --dir <path>)" >&2; exit 2 ;;
  esac
done
case "$mode" in
  install|uninstall|sync) ;;
  *) echo "usage: short-commands.sh install|uninstall|sync [--dry-run] [--dir <path>]" >&2; exit 2 ;;
esac

say() { printf '  %s%s\n' "$([ "$DRY" = 1 ] && echo '[dry-run] ')" "$*"; }

# The copy of one plugin command: the marker after the opening line, the root substituted as
# plain text (a root holding `&` or `#` is no pattern to awk's index).
render() {
  awk -v m="$MARKER" -v root="$SRC" -v var='${CLAUDE_PLUGIN_ROOT}' '
    NR == 2 { print m }
    { out = ""; line = $0
      while ((i = index(line, var)) > 0) { out = out substr(line, 1, i - 1) root; line = substr(line, i + length(var)) }
      print out line }' "$1"
}

# A file is this plugin's when its frontmatter carries the marker line.
ours() {
  awk -v m="$MARKER" 'NR == 1 { if ($0 != "---") exit 1; next } /^---$/ { exit 1 } $0 == m { found = 1; exit 0 } END { exit !found }' "$1" 2>/dev/null
}

write() {  # <target> <plugin command>
  local tmp
  tmp=$(mktemp "$DEST/.short-XXXXXX")
  render "$2" > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$1"
}

if [ "$mode" = sync ] && [ ! -d "$DEST" ]; then exit 0; fi
[ "$mode" = install ] && [ "$DRY" = 0 ] && mkdir -p "$DEST"

while IFS=$'\t' read -r short file; do
  [ -n "$short" ] || continue
  target="$DEST/$short.md"
  plugin_cmd="$SRC/commands/$file.md"
  [ -f "$plugin_cmd" ] || { echo "  no plugin command $plugin_cmd for /$short" >&2; continue; }
  if { [ -e "$target" ] || [ -L "$target" ]; } && ! ours "$target"; then
    [ "$mode" = sync ] || say "kept: $target is not this plugin's (no « $MARKER » line), left as it is"
    continue
  fi
  case "$mode" in
    uninstall)
      [ -e "$target" ] || continue
      [ "$DRY" = 1 ] || rm -f "$target"
      say "short command removed: $target" ;;
    install|sync)
      if [ ! -e "$target" ]; then
        [ "$mode" = sync ] && continue
        [ "$DRY" = 1 ] || write "$target" "$plugin_cmd"
        say "short command written: $target"
      elif render "$plugin_cmd" | cmp -s - "$target"; then
        [ "$mode" = sync ] || say "short command up to date: $target"
      else
        [ "$DRY" = 1 ] || write "$target" "$plugin_cmd"
        say "short command rewritten: $target"
      fi ;;
  esac
done < "$MAP"
exit 0
