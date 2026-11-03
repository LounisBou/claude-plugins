#!/bin/bash
# iterm-agent.sh - the entry point. Resolves an interpreter and hands over to the
# implementation beside it, which drives iTerm2 through the app's own API.
#
#   iterm-agent.sh list
#   iterm-agent.sh spawn --dir <path> [--tier deep|standard|light | --model <id> | --inherit-model]
#                        [--effort low|medium|high|xhigh|max] [--permission-mode auto] [--title <t>]
#                        (--prompt <text> | --prompt-file <path> | --brief <path> --orchestrator <name>)
#                        [--left-of <tty> | --right-of <tty> | --right-of self | --successor] [--no-verify]
#                        [--gate-tokens <positive integer>] [--resident]
#                        [--keep-tool <name>] [--drop-tool <name>] [--keep-synced-skills]
#     --keep-tool / --drop-tool: take a tool out of, or add one to, the set the launch removes
#     from the session (§65). Both repeat; an empty name, or one name on both, is refused.
#     --keep-synced-skills: leave the account's synced skills in; the launch hides them otherwise.
#     --resident marks an agent meant to stay idle while a background command of its own
#     waits: the stop gate never counts it as idle. It is still closed when its purpose ends.
#     --gate-tokens sets THIS session's context gate, in tokens: the launch exports
#     ORCHESTRATOR_CONTEXT_GATE_TOKENS beside ORCHESTRATOR_SPAWNED. Absent, nothing is
#     exported and the default holds. With --brief, the startup prompt also says the gate.
#   iterm-agent.sh spawn --dir <path> --auditor --title "Audit : <subject>" (--prompt <text> | --prompt-file <path>)
#     the caller's auditor: left of the caller, its model, remote control on, no chain
#   iterm-agent.sh spawn --dir <path> --coordinator-successor --title "Coord : <subject>" (--prompt <text> | --prompt-file <path>)
#     the coordinator's own successor: first place of the caller's window, its model,
#     remote control on, no chain
#   iterm-agent.sh spawn --dir <path> --wake --title "Orch : <subject>" --model <id> [--effort <level>] [--resume <session id>] (--prompt <text> | --prompt-file <path>)
#     a paused orchestrator relaunched: its recorded name, model and effort, remote control on,
#     no chain, in window 0 of a home session of its own shown by a tab immediately right of
#     the caller; --resume brings back its recorded conversation
#     (--open makes its home session the same way, the server named after the id it is given)
#   iterm-agent.sh spawn --open --title "Orch : <subject>" --dir <path> [--tier <t> | --model <id> | --inherit-model] [--effort <level>] (--prompt <text> | --prompt-file <path>)
#     a new orchestrator opened on the operator's order, by a coordinator or an orchestrator
#     only: immediately right of the caller, the deep tier unless told, remote control on,
#     no chain. `--open` comes right after `spawn`: that is the form the rule every
#     `install.sh` run writes names
#   iterm-agent.sh home --session <id> --name "Orch : <subject>" [--prompt <text>]
#     run by the hooks module at the end of an orchestrator's naming turn: a home server of
#     its own (-L orch-<id>, -f the plugin's tmux/home.conf) whose window 0 resumes the same
#     session once it has ended in its tab, and a tab right of that one showing it. Prints
#     `moved: …` or `stay: <why>`; nothing is ended, and a failure leaves the session in place
#   iterm-agent.sh home-release --tty /dev/ttysNNN --session-id <app session id> --pane-tty /dev/ttysNNN --resumed <session id>
#     window 0's watcher closing the tab a moved orchestrator left, once the resumed host is
#     proved running on window 0's tty, guarded by that tab's own id
#   iterm-agent.sh takeover --tty /dev/ttysNNN --expect-title <substring>
#     a successor's close of its predecessor in their home session: the predecessor's window
#     0 killed and proved gone, then the successor's window moved to index 0
#   iterm-agent.sh tools [--transcript <path>]
#     what a session is given and what each item costs per call, from a transcript
#   iterm-agent.sh verify --tty /dev/ttysNNN [--pid <pid>]
#   iterm-agent.sh resolve-tier <deep|standard|light>
#   iterm-agent.sh close --tty /dev/ttysNNN [--expect-title <substring>] [--keep-checkout]
#     a tab that shows a home session ends its whole server first, every window of it proved
#     gone, and prints `home: ended the server <name> …, session <id>` after its first line
#   iterm-agent.sh move --tty /dev/ttysNNN (--left-of <tty> | --right-of <tty> | --right-of self | --leftmost)
#   iterm-agent.sh rotate --old-tty /dev/ttysNNN [--expect-title <s>] <spawn options...>
#   iterm-agent.sh trust prune [--apply]
#     list, then remove with --apply, the trust entries whose directory is gone
#
#   A startup prompt is REQUIRED on every spawn and rotate: the host writes a session's
#   transcript only once it has one, so a promptless launch is refused before any tab is
#   made — --no-verify does not lift it.
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
#     old session, so a spawn failure never leaves you with zero agents; it refuses
#     --no-verify, which would remove that check.
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
#   ORCHESTRATOR_TMUX            the tmux to run inside a home session (tmux)
#   ORCHESTRATOR_HOME_WAIT       seconds window 0 waits for a moved session to end in its tab (120)
#   ORCHESTRATOR_HOST_ARGV       a JSON list standing in for a process's own words (tests)
#   ORCHESTRATOR_HOME_NO_TAB     `home`, a wake and an open make the server and no tab (the live tests, which have none);
#                                honoured only beside ORCHESTRATOR_TEST_RUN, which the test scripts set and no launch does
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
