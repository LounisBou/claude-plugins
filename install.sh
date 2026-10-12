#!/usr/bin/env bash
# Creates the state directory the module's artifacts live in and unwires the tap a
# previous install may have left in front of the status line.
#
# Idempotent: the tier map and server catalogue are created only when absent, a
# status line already free of the tap is left alone, and settings.json is backed up
# before any change.
#
#   ./install.sh              install / update
#   ./install.sh --dry-run    print what would happen, change nothing

set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STATE_DIR="$CONFIG_DIR/claude-orchestrator"
TAP_DEST="$STATE_DIR/statusline-tap.sh"
PREVIOUS="$STATE_DIR/statusline.previous.json"
SETTINGS="$CONFIG_DIR/settings.json"
BACKUP_DIR="$CONFIG_DIR/backups/claude-orchestrator-$(date +%Y%m%d-%H%M%S)"
HOST_FLOOR="2.1.287"

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

# The four spellings one stored command may give the tap's path, TAP_DEST's own among
# them: the unwrap matches the stored text verbatim so the command that followed the
# tap keeps the spelling it was written with. The spellings are built by concatenation —
# a backslash before a slash survives inside double quotes and would corrupt them.
tap_spellings() {
  local rel=${TAP_DEST#"$HOME"/}
  printf '%s\n' "$TAP_DEST" "\$HOME/$rel" "\${HOME}/$rel" "~/$rel"
}

# One jq program applied to settings.json, the file backed up first; a dry run says what
# it would do and touches nothing.
apply_settings() {
  local message=$1; shift
  if [ "$DRY" = "1" ]; then
    say "[dry-run] $message"
    return
  fi
  mkdir -p "$BACKUP_DIR"
  cp "$SETTINGS" "$BACKUP_DIR/settings.json.before"
  local tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/orchestrator-XXXXXX")
  jq "$@" "$SETTINGS" > "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$SETTINGS"
  say "$message"
}

# The inverse of the tap's own wrap. The command that followed the tap is the authority,
# kept exactly as written: the saved object dates from the day the tap was wired, and
# restoring its command would undo every change the operator made since, the portable
# home spelling among them. The saved object only fills the keys the line lacks, and is
# restored whole only when the tap was all the line held; with no saved object, such a
# line is removed.
#
# The outcome is left in UNWRAP: `unwired` (the tap was taken off the line, or would be in
# a dry run), `none` (no line runs the tap) or `skipped` (a line may still run it: the file
# did not parse, or the spelling is not one this code knows). The caller keeps the tap's
# copy only in the last case.
unwrap_statusline() {
  UNWRAP=skipped
  if [ ! -f "$SETTINGS" ]; then
    say "no $SETTINGS: nothing to unwire"
    UNWRAP=none; return
  fi
  if ! jq empty "$SETTINGS" 2>/dev/null; then
    # Named on stderr and skipped, not silently read as empty: a file that does not parse
    # may still hold the tap's wiring, and the operator must know the unwrap never ran.
    echo "  $SETTINGS does not parse as JSON: the status line was not unwired — the tap's wiring, if it is in there, is left as it is; fix the file and run this again." >&2
    return
  fi
  if ! jq -e 'has("statusLine")' "$SETTINGS" >/dev/null 2>&1; then
    say "no statusLine to unwire"
    UNWRAP=none; return
  fi
  local stored current rest="" matched=0 saved=0 t
  stored=$(jq -r '.statusLine.command // ""' "$SETTINGS")
  current=$(normalise_home "$stored")
  case "$current" in
    "$TAP_DEST"|"$TAP_DEST "*) ;;
    *) say "statusLine carries no tap, left untouched"; UNWRAP=none; return ;;
  esac
  while IFS= read -r t; do
    case "$stored" in
      "$t")   rest=""; matched=1; break ;;
      "$t "*) rest=${stored#"$t "}; matched=1; break ;;
    esac
  done < <(tap_spellings)
  if [ "$matched" != "1" ]; then
    say "statusLine carries no tap spelling this installer knows, left untouched"
    return
  fi
  [ -f "$PREVIOUS" ] && jq -e 'type == "object"' "$PREVIOUS" >/dev/null 2>&1 && saved=1
  if [ -n "$rest" ] && [ "$saved" = "1" ]; then
    apply_settings "statusLine.command → $rest" --arg cmd "$rest" --slurpfile prev "$PREVIOUS" \
      '.statusLine = ($prev[0] + .statusLine + {command: $cmd})'
  elif [ -n "$rest" ]; then
    apply_settings "statusLine.command → $rest" --arg cmd "$rest" '.statusLine.command = $cmd'
  elif [ "$saved" = "1" ]; then
    apply_settings "statusLine restored from the saved object" --slurpfile prev "$PREVIOUS" \
      '.statusLine = $prev[0]'
  else
    apply_settings "statusLine removed (the tap was all it held)" 'del(.statusLine)'
  fi
  UNWRAP=unwired
}

# True when <version> sorts below <floor>, component by component, missing components
# counting as zero. Both are dotted numerics; nothing else reaches it.
older_than_floor() {
  awk -v v="$1" -v f="$2" 'BEGIN {
    n = split(v, va, "."); m = split(f, fa, ".")
    for (i = 1; i <= n || i <= m; i++) {
      x = (i <= n ? va[i] + 0 : 0); y = (i <= m ? fa[i] + 0 : 0)
      if (x < y) exit 0
      if (x > y) exit 1
    }
    exit 1
  }'
}

# uninstall.sh sources this file for the definitions above and nothing else, so the two
# scripts share one unwrap and can never treat the same status line differently.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then return 0; fi

# --- prerequisites ----------------------------------------------------------

step "Prerequisites"

# The module's events and the fs API it reads are host 2.1.287 and later; an older
# host loads the plugin and silently runs none of it. The host's own name, with the
# launcher's default beside it (ORCHESTRATOR_HOST_CLI).
host_cli="${ORCHESTRATOR_HOST_CLI:-claude}"
host_version=$("$host_cli" --version 2>/dev/null | head -1 | grep -oE '[0-9]+([.][0-9]+)+' | head -1 || true)
if [ -z "$host_version" ]; then
  echo "  the host's version could not be read from '$host_cli --version'; this plugin needs $HOST_FLOOR or later." >&2
  exit 1
fi
if older_than_floor "$host_version" "$HOST_FLOOR"; then
  echo "  the host is $host_version; this plugin needs $HOST_FLOOR or later (the hooks module)." >&2
  exit 1
fi
say "host $host_version"

command -v jq >/dev/null 2>&1 || {
  echo "  jq is required (the installer edits settings.json with it)." >&2
  echo "  macOS: brew install jq — Debian/Ubuntu: sudo apt install jq" >&2
  exit 1
}
say "jq $(jq --version 2>/dev/null | sed 's/^jq-//')"

# --- state directory ----------------------------------------------------------

step "State directory"

# The measure file, the one channel external processes still read: one file per
# session, named by session id, written by the module on every gauge pass.
run "mkdir -p '$STATE_DIR/measure'"
say "measure directory ready: $STATE_DIR/measure"

# The tap's ctx/ directory: nothing reads it since the module measures the session itself.
if [ -d "$STATE_DIR/ctx" ]; then
  run "rm -rf '$STATE_DIR/ctx'"
  say "the tap's ctx/ removed"
else
  say "no ctx/ to remove"
fi

# A session writes its measure file when a turn ends, so an idle one — an agent waiting
# through a weekend, a quiet coordinator — keeps an old file it will read again in its next
# turn. Age alone proves nothing: a file is pruned only past a week AND when no live
# session owns it. The host's registry (sessions/<pid>.json) names each session's id; a
# registry file whose pid is gone frees that session's measure file.
live_sessions=""
for reg in "$CONFIG_DIR"/sessions/*.json; do
  [ -f "$reg" ] || continue
  pid=$(basename "$reg" .json)
  case "$pid" in ''|*[!0-9]*) continue ;; esac
  ps -p "$pid" >/dev/null 2>&1 || continue
  sid=$(jq -r '.sessionId // empty' "$reg" 2>/dev/null || true)
  [ -n "$sid" ] && live_sessions="$live_sessions $sid "
done
pruned=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$live_sessions" in *" $(basename "$f" .json) "*) continue ;; esac
  run "rm -f '$f'"
  pruned=$((pruned + 1))
done < <(find "$STATE_DIR/measure" -type f -name '*.json' -mtime +6 2>/dev/null)
say "measure files pruned (past a week, no live session): $pruned"

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

# --- settings.json: the tap unwired -------------------------------------------

step "settings.json"

unwrap_statusline

# --- the old pipeline's files -------------------------------------------------

step "Old pipeline files"

# The tap's copy and saved object, the shell gates' logs and the heads they kept: inert
# once no line runs the tap, and a stale saved object would only mislead a later unwrap.
# They stay while a status line may still point at the tap (a settings file that did not
# parse, a spelling not recognised). The module's own heads (.mheads) are never touched.
if [ "$UNWRAP" = "skipped" ]; then
  say "the status line may still run the tap: its files are kept"
else
  removed=0
  for f in "$TAP_DEST" "$PREVIOUS" "$STATE_DIR/context-gate.log" "$STATE_DIR/stop-gate.log" \
           "$STATE_DIR"/stop-gate/*.heads; do
    [ -f "$f" ] || continue
    run "rm -f '$f'"
    removed=$((removed + 1))
  done
  say "old pipeline files removed: $removed"
fi

step "Done."
say "Restart your session for the module to take effect."
exit 0
