#!/usr/bin/env bash
# Takes the tap off the status line, keeping the command that followed it, and removes the
# state directory.
#
#   ./uninstall.sh            restore
#   ./uninstall.sh --dry-run  print what would happen, change nothing

set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# The paths, the dry-run flag, say() and the unwrap, from install.sh itself: the one unwrap
# both scripts run, so the two treat one status line the same way. The command that
# followed the tap is kept as written, never dropped and never replaced by an older saved
# one. Sourced, install.sh defines and returns; it installs nothing.
# shellcheck source=install.sh
. "$SRC/install.sh"

unwrap_statusline

# While a status line may still run the tap (a settings file that did not parse, a
# spelling not recognised), its copy and saved object stay: removing them would break
# the line on top of the settings file. Everything else goes.
if [ -d "$STATE_DIR" ]; then
  if [ "$UNWRAP" = "skipped" ]; then
    if [ "$DRY" = "1" ]; then say "[dry-run] empty $STATE_DIR but for the tap's copy and saved object"
    else
      find "$STATE_DIR" -mindepth 1 -maxdepth 1 ! -name statusline-tap.sh ! -name statusline.previous.json \
        -exec rm -rf {} +
      say "emptied $STATE_DIR but for the tap's copy and saved object: the status line may still run it"
    fi
  elif [ "$DRY" = "1" ]; then say "[dry-run] rm -rf $STATE_DIR"
  else rm -rf "$STATE_DIR"; say "removed $STATE_DIR (measure files, the module's log with its rotation and lock, prompts, tier map)"; fi
fi

say "Done. Restart your session."
exit 0
