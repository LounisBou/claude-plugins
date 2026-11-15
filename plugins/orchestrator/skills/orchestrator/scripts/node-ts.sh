# node-ts.sh — sourced by the launchers of the plugin's TypeScript commands, never run.
#
# `node_ts_exec <label> <script.ts> [args...]` runs the script with the first node that can run
# TypeScript without a flag (22.18, 23.6 or 24 and later). The `node` first on PATH may be older
# (a version manager's pinned 22.13 runs none of it), so each node of PATH is asked its version in
# turn, then the places in NODE_TS_FALLBACKS (default: Homebrew's and /usr/local's). None able:
# one line on stderr naming the versions found and what is needed, exit 1.

# The node executables to ask, one per line, in order: each PATH entry's, then the fallback places.
node_ts_candidates() {
  local dir IFS=:
  for dir in $PATH; do
    if [ -n "$dir" ] && [ -f "$dir/node" ] && [ -x "$dir/node" ]; then echo "$dir/node"; fi
  done
  IFS=' '
  for dir in ${NODE_TS_FALLBACKS-/opt/homebrew/bin/node /usr/local/bin/node}; do
    if [ -f "$dir" ] && [ -x "$dir" ]; then echo "$dir"; fi
  done
}

node_ts_exec() {
  local label=$1 script=$2 candidate version major minor tried=""
  shift 2
  while IFS= read -r candidate; do
    case "$tried" in *"($candidate)"*) continue ;; esac
    version=$("$candidate" -p 'process.versions.node' 2>/dev/null) || version=unknown
    IFS=. read -r major minor _ <<<"$version"
    case "$major.$minor" in
      *[!0-9.]* | . | *.) ;;
      *)
        if [ "$major" -ge 24 ] || { [ "$major" -eq 23 ] && [ "$minor" -ge 6 ]; } || { [ "$major" -eq 22 ] && [ "$minor" -ge 18 ]; }; then
          exec "$candidate" --no-warnings "$script" "$@"
        fi ;;
    esac
    tried="${tried:+$tried, }$version ($candidate)"
  done < <(node_ts_candidates)
  if [ -n "$tried" ]; then
    echo "$label: no node able to run TypeScript: found $tried; needs node 22.18, 23.6 or later" >&2
  else
    echo "$label: node not found: needs node 22.18, 23.6 or later" >&2
  fi
  exit 1
}
