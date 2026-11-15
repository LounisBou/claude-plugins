#!/bin/bash
# e2e-host.sh - what the live-host scripts (pane-e2e.sh) decide before they drive a host, kept
# apart so run-tests.sh can hold it without a host. Sourced, never run.
#
#   e2e_plugin_args <plugin root> <copies dir>   fills E2E_PLUGIN_ARGS: the host's `--plugin-dir` flags
#   e2e_banner_ok <brand> <plan> <screen>   0 when the banner reads a subscription
#
# The host runs with the user's settings left out (`--setting-sources project`), and those
# settings are where `enabledPlugins` lives: a plugin the module's own `dependencies` name
# (method, github) is then "not installed", the host never loads the module, and the pane never
# draws. The module's dependencies are therefore loaded from this repository, beside the module
# and as copies, as `--plugin-dir` folders: the host takes a dependency from there as from an installed plugin.

# The plugin under test first, then each plugin its `plugin.json` lists under `dependencies`,
# found as a sibling folder of the same name and copied into `$2`: a host loads a `--plugin-dir`
# folder as one it writes in (its typings, a tsconfig.json), and a checkout of this repository
# must not carry what a run wrote. The plugin under test is the one folder loaded in place, its
# own `.gitignore` holding those files. A dependency with no sibling folder is an error (printed,
# return 1): a host started without it would load nothing and say nothing.
e2e_plugin_args() {
  local root="$1" copies="$2" name dir
  E2E_PLUGIN_ARGS=(--plugin-dir "$root")
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    dir="$root/../$name"
    [ -f "$dir/.claude-plugin/plugin.json" ] || {
      echo "refused: the plugin depends on '$name', which is not a sibling folder of $root" >&2
      return 1
    }
    rm -rf "${copies:?}/$name" && mkdir -p "$copies" && cp -R "$dir" "$copies/$name" || return 1
    E2E_PLUGIN_ARGS+=(--plugin-dir "$copies/$name")
  done < <(jq -r '.dependencies[]? | if type == "object" then .name else . end' "$root/.claude-plugin/plugin.json")
}

# The banner's product line reads `<model> · <Brand> <Plan>`: any plan is a subscription, and the
# API billing line anywhere on the screen is not. `$2`, when set, names the one plan accepted
# (escaped, so a name with a dot or a bracket matches itself). The `Claude Code v…` line above
# it names the program, not a plan, and is not matched: the plan follows the middle dot.
e2e_banner_ok() {
  local brand="$1" plan="$2" screen="$3" plan_re='[A-Z][A-Za-z0-9]*'
  [ -n "$plan" ] && plan_re=$(printf '%s' "$plan" | sed 's/[][\\.*^$(){}?+|\/-]/\\&/g')
  printf '%s\n' "$screen" | grep -qF 'API Usage Billing' && return 1
  printf '%s\n' "$screen" | head -12 | grep -qE "· $brand $plan_re( |$)"
}
