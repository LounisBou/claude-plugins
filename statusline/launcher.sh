#!/bin/bash
# Stable entry point registered in settings.json. It runs the status line
# script of the plugin install the host currently has active, so a plugin
# update takes effect without re-running install.sh. When that install cannot
# be found, it falls back to the copy made at install time.

config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

active=$(jq -r '[.plugins // {} | to_entries[] | select(.key | startswith("claude-statusbar@"))
                 | .value[0].installPath // empty] | first // empty' \
         "$config_dir/plugins/installed_plugins.json" 2>/dev/null)

if [ -n "$active" ] && [ -f "$active/statusline/statusline.sh" ]; then
  exec bash "$active/statusline/statusline.sh"
fi
exec bash "$here/statusline-core.sh"
