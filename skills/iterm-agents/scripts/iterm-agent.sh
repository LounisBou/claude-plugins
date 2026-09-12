#!/bin/bash
# iterm-agent.sh - the entry point. Resolves an interpreter and hands over to the
# implementation beside it, which drives iTerm2 through the app's own API.
#
#   iterm-agent.sh list
#   iterm-agent.sh spawn --dir <path> [--tier deep|standard|light | --model <id> | --inherit-model]
#                        [--permission-mode auto] [--title <t>]
#                        [--prompt <text> | --prompt-file <path>]
#                        [--left-of <tty> | --right-of <tty> | --right-of self | --successor] [--no-verify]
#   iterm-agent.sh verify --tty /dev/ttysNNN
#   iterm-agent.sh resolve-tier <deep|standard|light>
#   iterm-agent.sh close --tty /dev/ttysNNN [--expect-title <substring>]
#   iterm-agent.sh move --tty /dev/ttysNNN (--left-of <tty> | --right-of <tty> | --right-of self)
#   iterm-agent.sh rotate --old-tty /dev/ttysNNN [--expect-title <s>] <spawn options...>
#   iterm-agent.sh trust prune [--apply]
#     list, then remove with --apply, the trust entries whose directory is gone
#
# Interpreter: the environment the installer builds, when it is there; otherwise any
# python3. The module iTerm2 needs is imported only by the subcommands that talk to the
# app, so reading the tier map or a tty works on a machine with no environment and no
# window server at all.
#
# Safety model:
#   - `close` targets a tty (unique per session). With --expect-title, the session's
#     current title must contain it or the close is refused.
#   - `rotate` spawns the replacement FIRST and verifies it is running, then closes the
#     old session, so a spawn failure never leaves you with zero agents.
#   - `spawn` HANDS the command to the app rather than typing it into a shell. Everything
#     the typed path cost is gone with it: a command truncated past a few hundred
#     characters while the script reported success, a startup question eating the first
#     keystroke, quoting that died on a non-ASCII byte under a C locale.
#   - `spawn` types no model argument at all when neither a tier nor an explicit
#     identifier says which: the host applies its own default rather than a name this
#     plugin would be choosing for every operator.
#   - The tty a spawn prints is a claim; the process on it is the fact. `spawn` waits for
#     the host CLI in `ps` and fails loudly if it never appears.
#   - `move` reorders through the app. It needs no Accessibility grant, does not bring
#     iTerm2 to the front and flickers no focus, which the menu-driven version all did.
#
# Environment:
#   ORCHESTRATOR_HOST_CLI        the CLI to launch in a spawned tab
#   ORCHESTRATOR_STATE_DIR       prompt files, the environment and the tier map live here
#   ORCHESTRATOR_SPAWN_TIMEOUT   seconds to wait for the CLI process on the new tty (30)
#   ORCHESTRATOR_PYTHON          an interpreter to use instead of the resolved one
#   ORCHESTRATOR_MODELS_MAP      the tier map to read
#   ORCHESTRATOR_TIER_DEEP       override the map's binding for one run
#   ORCHESTRATOR_TIER_STANDARD   idem
#   ORCHESTRATOR_TIER_LIGHT      idem
#   ORCHESTRATOR_DRY_RUN         `spawn` prints what it would ask for and touches nothing
#   ORCHESTRATOR_BACKEND         auto (default: api, then applescript) or one of
#                                api|applescript, to pin a single rung
#   ORCHESTRATOR_PROBE_TIMEOUT   seconds the app has to answer before a rung gives up (8)
#   ORCHESTRATOR_CLOSE_TIMEOUT   seconds a close waits for the process to leave the tty (10)
#
# When iTerm2 does not answer:
#   - no AppleScript here is ever unbounded, the library's own cookie request included: the
#     app is asked for its version under a deadline THIS process holds before the API
#     library is entered, because the library's authentication is a blocking read no
#     timeout inside the call could reach;
#   - the cause is NAMED from a main-thread sample. The one that cost four hours — a
#     context menu left open, which runs a nested event loop in which AppleEvents are not
#     dispatched at all — is cleared by pressing Escape, with no restart and no settings
#     change and no session lost;
#   - the command falls to AppleScript, which drove this plugin before the API existed, and
#     SAYS which rung served it. There is no rung outside the app: an agent is an iTerm2
#     tab, always. When both are down the app is wedged, and the launcher names it and
#     stops rather than handing back a terminal nobody asked for.

set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
state="${ORCHESTRATOR_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-orchestrator}"

if [ -n "${ORCHESTRATOR_PYTHON:-}" ]; then
    python="$ORCHESTRATOR_PYTHON"
elif [ -x "$state/venv/bin/python" ]; then
    python="$state/venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
    python=python3
else
    echo "ERROR: python3 is required" >&2
    exit 1
fi

exec "$python" "$here/iterm_agent.py" "$@"
