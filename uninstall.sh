#!/usr/bin/env bash
# Removes the status line: deletes the statusLine key from settings.json and
# removes the installed script. Settings and backups are left in place.

set -euo pipefail

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
DEST_DIR="$CONFIG_DIR/statusbar"
DEST="$DEST_DIR/statusline.sh"
SETTINGS="$CONFIG_DIR/settings.json"

say() { printf '  %s\n' "$*"; }

# settings.json is free text: a hand-written or templated statusLine.command
# can spell our script's path expanded, or as $HOME/…, ${HOME}/…, ~/… when
# CONFIG_DIR sits under $HOME (the default). List every spelling that
# resolves to $DEST so any of them is recognised as ours.
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

SPELLINGS=$(spellings_of "$DEST" "$HOME")

is_exactly_ours() {
  local cmd="$1" spelling
  while IFS= read -r spelling; do
    [ "$cmd" = "$spelling" ] && return 0
  done <<<"$SPELLINGS"
  return 1
}

wraps_ours() {
  local cmd="$1" spelling
  while IFS= read -r spelling; do
    case "$cmd" in *"$spelling"*) return 0 ;; esac
  done <<<"$SPELLINGS"
  return 1
}

strip_ours() {
  local cmd="$1" spelling
  while IFS= read -r spelling; do
    cmd="${cmd//$spelling/}"
  done <<<"$SPELLINGS"
  printf '%s' "$cmd"
}

current=""
[ -f "$SETTINGS" ] && current=$(jq -r '.statusLine.command // ""' "$SETTINGS")

if [ -z "$current" ] || ! wraps_ours "$current"; then
  say "settings.json does not point at this status line, left untouched"
elif is_exactly_ours "$current"; then
  # Only ours: the whole key is ours to remove.
  tmp=$(mktemp)
  jq 'del(.statusLine)' "$SETTINGS" > "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$SETTINGS"
  say "statusLine removed from settings.json"
else
  # Another tool wraps us ("<its command> <our path>"): drop only our
  # path and leave that tool's command and every other key as they are.
  stripped=$(strip_ours "$current")
  stripped=$(printf '%s' "$stripped" | tr -s '[:space:]' ' ')
  stripped="${stripped#"${stripped%%[![:space:]]*}"}"
  stripped="${stripped%"${stripped##*[![:space:]]}"}"
  if [ -z "$stripped" ]; then
    say "statusLine wraps only this status bar, with nothing left to run afterwards: left untouched"
  else
    tmp=$(mktemp)
    jq --arg cmd "$stripped" '.statusLine.command = $cmd' "$SETTINGS" > "$tmp"
    chmod 600 "$tmp"; mv "$tmp" "$SETTINGS"
    say "our path removed from statusLine, wrapper kept: $stripped"
  fi
fi

if [ -d "$DEST_DIR" ]; then
  rm -rf "$DEST_DIR"
  say "removed: $DEST_DIR"
fi

say "Kept: $CONFIG_DIR/statusline-config.txt and $CONFIG_DIR/backups/"
