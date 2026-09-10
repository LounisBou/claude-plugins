#!/bin/bash
# iterm-agent.sh — iTerm2 session management for the orchestrator (macOS).
# Lets an orchestrator session list, spawn, verify, close and rotate implementer-agent
# tabs. Closing is tty-exact and refuses ambiguity by construction.
#
# Usage:
#   iterm-agent.sh list
#   iterm-agent.sh spawn --dir <path> [--tier deep|standard|light | --model <id>] [--permission-mode auto] [--title <t>]
#                        [--prompt <text> | --prompt-file <path>]
#                        [--left-of /dev/ttysNNN | --right-of /dev/ttysNNN | --right-of self] [--no-verify]
#   iterm-agent.sh verify --tty /dev/ttysNNN
#   iterm-agent.sh prompt-state            (reads a tab's contents on stdin; prints question|ready|busy)
#   iterm-agent.sh resolve-tier <deep|standard|light>   (prints the operator's bound identifier, empty when unbound)
#   iterm-agent.sh close --tty /dev/ttysNNN [--expect-title <substring>]
#   iterm-agent.sh move --tty /dev/ttysNNN (--left-of /dev/ttysMMM | --right-of /dev/ttysMMM | --right-of self)
#   iterm-agent.sh rotate --dir <path> --old-tty /dev/ttysNNN [--tier deep|standard|light | --model <id>] [--permission-mode auto]
#                         [--title <t>] [--prompt <text> | --prompt-file <path>] [--expect-title <substring>]
#                         [--left-of /dev/ttysMMM | --right-of /dev/ttysMMM | --right-of self]
#
# Safety model:
#   - `close` targets a tty (unique per session). If --expect-title is given, the
#     session's current title must contain it, or the close is refused.
#   - `rotate` spawns the replacement FIRST, then closes the old session, so a
#     spawn failure never leaves you with zero agents.
#   - `spawn` types a model argument only when one is known: a tier the operator has
#     bound, or an explicit `--model`. With neither, the host applies its own default
#     rather than a name this plugin would be choosing for everyone.
#   - `spawn` never types the prompt into the shell. It writes it to a file under
#     the plugin's state directory and types a SHORT command that reads the file
#     (`"$(cat <file>)"`) as the host CLI's initial-prompt argument. A prompt typed
#     by AppleScript is truncated past a few hundred characters and the command
#     never runs — observed once, with the tab left on a half-typed line and the
#     script reporting success.
#   - `spawn` opens the tab, WAITS for its shell to be at a prompt — answering a startup
#     question such as oh-my-zsh's « Would you like to update? [Y/n] » with « n », because that
#     question ate the first keystroke of a typed command and `cd` ran as `d` — types the
#     command, and re-types it ONCE if the CLI has not started while the shell sits at a prompt.
#   - `spawn` then VERIFIES: it waits until the host CLI is running on the new tty
#     (ORCHESTRATOR_SPAWN_TIMEOUT seconds, 30 by default) and fails loudly, with
#     the tab's last lines, if it is not. The printed tty is a claim; the process
#     on it is the fact.
#   - Quoting for AppleScript is done with the shell's own substitutions, never
#     with `sed`: under a C locale `sed` dies on a non-ASCII byte (« RE error:
#     illegal byte sequence ») and a title with an em dash aborted a launch.
#   - `move` places a tab immediately left or right of another one (same window). A
#     caller that wants a tab beside ITS OWN passes `--right-of self`: naming the
#     neighbour on the other side means naming a tab the caller does not know, and a
#     window holding unrelated tabs then swallows the difference. iTerm2's
#     AppleScript dictionary cannot reorder tabs, so it drives the Window > Tab >
#     Move Tab menu through System Events; that needs iTerm2 frontmost for the
#     duration of the move, and the previously frontmost app is restored after.
#
# Environment:
#   ORCHESTRATOR_HOST_CLI        the CLI to launch in a spawned tab (default: claude)
#   ORCHESTRATOR_STATE_DIR       where prompt files are kept (default: <config dir>/claude-orchestrator)
#   ORCHESTRATOR_SPAWN_TIMEOUT   seconds to wait for the CLI process on the new tty (default: 30)
#   ORCHESTRATOR_DRY_RUN         when set, `spawn` prints what it would type and touches no terminal
#   ORCHESTRATOR_MODELS_MAP      the tier map to read (default: <state dir>/models.json)
#   ORCHESTRATOR_TIER_DEEP       override the map's binding for one run
#   ORCHESTRATOR_TIER_STANDARD   idem
#   ORCHESTRATOR_TIER_LIGHT      idem

set -euo pipefail

# The host CLI to launch in a spawned tab; override for a wrapper or a renamed binary.
HOST_CLI="${ORCHESTRATOR_HOST_CLI:-claude}"
STATE_DIR="${ORCHESTRATOR_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-orchestrator}"
PROMPTS_DIR="$STATE_DIR/prompts"
# The operator's tier map. The plugin ships no model identifier: `deep`, `standard`
# and `light` name capability, and only this file says what each one runs on.
MODELS_MAP="${ORCHESTRATOR_MODELS_MAP:-$STATE_DIR/models.json}"
SPAWN_TIMEOUT="${ORCHESTRATOR_SPAWN_TIMEOUT:-30}"
DRY_RUN="${ORCHESTRATOR_DRY_RUN:-}"

die() { echo "ERROR: $*" >&2; exit 1; }

resolve_tier() {
    # A tier in, the identifier the operator bound to it out. An unbound tier prints
    # nothing and succeeds: the caller reads that as "let the host choose", which is a
    # better answer than a name this plugin has no business carrying.
    local tier="${1:-}" var value=""
    case "$tier" in
        deep|standard|light) ;;
        *) die "resolve-tier: unknown tier: $tier (expected deep, standard or light)" ;;
    esac
    # An environment override wins over the file, so one run can be routed differently
    # without editing a map every other session reads.
    var="ORCHESTRATOR_TIER_$(printf '%s' "$tier" | tr '[:lower:]' '[:upper:]')"
    eval "value=\${$var:-}"
    if [ -z "$value" ] && [ -f "$MODELS_MAP" ]; then
        command -v jq >/dev/null 2>&1 || die "resolve-tier: jq is required to read $MODELS_MAP"
        value=$(jq -r --arg t "$tier" '.[$t] // ""' "$MODELS_MAP" 2>/dev/null || true)
        [ "$value" = "null" ] && value=""
    fi
    printf '%s\n' "$value"
}

cmd_resolve_tier() {
    [ $# -eq 1 ] || die "resolve-tier: exactly one tier is required (deep, standard or light)"
    resolve_tier "$1"
}

osa() { osascript -e "$1"; }

applescript_quote() {
    # Escape backslashes then double quotes for embedding in an AppleScript string.
    # Shell substitutions only: they are byte-safe whatever the locale.
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '%s' "$s"
}

write_prompt_file() {
    # Writes a prompt to a durable file and prints its path. The state directory
    # survives reboots, unlike a temporary directory; the file is kept, so a
    # launch can be re-read after the fact.
    local prompt="$1" title="$2" slug path
    mkdir -p "$PROMPTS_DIR"
    slug=$(printf '%s' "$title" | LC_ALL=C tr -c 'A-Za-z0-9' '-' | cut -c1-40)
    path="$PROMPTS_DIR/$(date +%Y%m%d-%H%M%S)-$$-${slug:-agent}.txt"
    printf '%s' "$prompt" > "$path"
    printf '%s' "$path"
}

cli_pid_on_tty() {
    # Prints the pid of the host CLI running on a tty, or nothing.
    local tty="${1#/dev/}" cli
    cli=$(basename "$HOST_CLI")
    ps -t "$tty" -o pid= -o comm= 2>/dev/null | awk -v cli="$cli" '
        { name = $2; sub(".*/", "", name); if (name == cli) { print $1; exit } }'
}

shell_prompt_state() {
    # Classifies a tab's contents (stdin): `question` when a startup prompt is waiting for a
    # keystroke — oh-my-zsh's « Would you like to update? [Y/n] » ate the first character of a
    # typed command twice in one night, turning `cd` into `d` and running nothing —, `ready` when
    # the last non-empty line ends in a shell prompt, `busy` otherwise.
    local last
    last=$(grep -v '^[[:space:]]*$' | tail -1 | sed 's/[[:space:]]*$//')
    case "$last" in
        *"[Y/n]"|*"[y/N]"|*"[Y/n]:"|*"[y/N]:"|*"(y/n)"|*"(Y/n)"|*"[yes/no]") echo question ;;
        # A prompt symbol at the END (`$`, `%`, `#`, `>`) or, for the themes that put it first
        # and follow it with the directory, at the START (`➜`, `❯`, `→`).
        *"$"|*"%"|*"#"|*">"|"➜"*|"❯"*|"→"*) echo ready ;;
        *) echo busy ;;
    esac
}

tab_contents() {
    # The whole screen of the session on a tty (one AppleScript read).
    local qtty
    qtty=$(applescript_quote "$1")
    osa "
    tell application \"iTerm2\"
        repeat with w in windows
            repeat with t in tabs of w
                repeat with s in sessions of t
                    if (tty of s) is \"$qtty\" then return contents of s
                end repeat
            end repeat
        end repeat
        return \"\"
    end tell" 2>/dev/null || true
}

write_to_tty() {
    # Types one line into the session on a tty.
    local qtty qtext
    qtty=$(applescript_quote "$1")
    qtext=$(applescript_quote "$2")
    osa "
    tell application \"iTerm2\"
        repeat with w in windows
            repeat with t in tabs of w
                repeat with s in sessions of t
                    if (tty of s) is \"$qtty\" then
                        tell s to write text \"$qtext\"
                        return \"ok\"
                    end if
                end repeat
            end repeat
        end repeat
        error \"No session found on $qtty.\"
    end tell" >/dev/null
}

await_shell_ready() {
    # Waits for the new tab's shell to be at a prompt; answers a waiting yes/no question with
    # « n » so the command typed next is read whole. Bounded by ORCHESTRATOR_SHELL_TIMEOUT (8 s).
    local tty="$1" waited=0 limit="${ORCHESTRATOR_SHELL_TIMEOUT:-8}" state
    while [ "$waited" -lt "$limit" ]; do
        state=$(tab_contents "$tty" | shell_prompt_state)
        case "$state" in
            ready) return 0 ;;
            question) write_to_tty "$tty" "n"; sleep 1 ;;
            *) sleep 1 ;;
        esac
        waited=$((waited + 1))
    done
    return 0
}

tab_tail() {
    # The last non-empty lines of the session on a tty, for a failure message.
    local qtty
    qtty=$(applescript_quote "$1")
    osa "
    tell application \"iTerm2\"
        repeat with w in windows
            repeat with t in tabs of w
                repeat with s in sessions of t
                    if (tty of s) is \"$qtty\" then return contents of s
                end repeat
            end repeat
        end repeat
        return \"\"
    end tell" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -6 || true
}

cmd_list() {
    osa '
    tell application "iTerm2"
        set output to ""
        set windowIndex to 0
        repeat with w in windows
            set windowIndex to windowIndex + 1
            set tabIndex to 0
            repeat with t in tabs of w
                set tabIndex to tabIndex + 1
                repeat with s in sessions of t
                    set output to output & "w" & windowIndex & "/t" & tabIndex & " | " & (tty of s) & " | " & (name of s) & linefeed
                end repeat
            end repeat
        end repeat
        return output
    end tell'
}

cmd_verify() {
    # Succeeds, printing the pid, when the host CLI is running on the tty; exits 1 otherwise.
    local target_tty=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --tty) target_tty="$2"; shift 2 ;;
            *) die "verify: unknown option $1" ;;
        esac
    done
    [ -n "$target_tty" ] || die "verify: --tty is required"
    local pid
    pid=$(cli_pid_on_tty "$target_tty")
    if [ -n "$pid" ]; then
        echo "$HOST_CLI running on $target_tty (pid $pid)"
    else
        echo "no $HOST_CLI process on $target_tty" >&2
        return 1
    fi
}

cmd_spawn() {
    # The decision mode defaults to the operator's own: a successor or a replacement agent
    # spawned into a stricter mode stops at its first permission prompt in a tab nobody is
    # watching, and the build stalls exactly where the rotation was meant to keep it moving.
    local dir="" model="" tier="" mode="auto" title="agent" prompt="" prompt_file="" left_of="" right_of="" verify=1
    while [ $# -gt 0 ]; do
        case "$1" in
            --dir) dir="$2"; shift 2 ;;
            --model) model="$2"; shift 2 ;;
            --tier) tier="$2"; shift 2 ;;
            --permission-mode) mode="$2"; shift 2 ;;
            --title) title="$2"; shift 2 ;;
            --prompt) prompt="$2"; shift 2 ;;
            --prompt-file) prompt_file="$2"; shift 2 ;;
            --left-of) left_of="$2"; shift 2 ;;
            --right-of) right_of="$2"; shift 2 ;;
            --no-verify) verify=0; shift ;;
            *) die "spawn: unknown option $1" ;;
        esac
    done
    [ -n "$dir" ] || die "spawn: --dir is required"
    [ -z "$left_of" ] || [ -z "$right_of" ] || die "spawn: --left-of and --right-of are mutually exclusive"
    [ -d "$dir" ] || die "spawn: directory not found: $dir"
    [ -z "$prompt" ] || [ -z "$prompt_file" ] || die "spawn: --prompt and --prompt-file are exclusive"
    [ -z "$tier" ] || [ -z "$model" ] || die "spawn: --tier and --model are mutually exclusive"
    [ -z "$tier" ] || model=$(resolve_tier "$tier")
    if [ -n "$prompt_file" ]; then
        [ -f "$prompt_file" ] || die "spawn: prompt file not found: $prompt_file"
    elif [ -n "$prompt" ]; then
        prompt_file=$(write_prompt_file "$prompt" "$title")
    fi

    # The tab title is set through the shell escape sequence before the session starts,
    # so `close --expect-title` has something stable to check. The prompt is never
    # part of the typed line: the shell reads it from the file at launch.
    # Project MCP servers are pre-approved on the command line: a fresh session that
    # stops on the "enable these MCP servers?" dialog never reads its brief, and
    # nobody is at that keyboard to answer.
    local settings='{"enableAllProjectMcpServers":true}'
    local shellcmd="cd $(printf '%q' "$dir") && printf '\\033]0;%s\\007' $(printf '%q' "$title") && $HOST_CLI"
    # No model argument at all when neither a tier nor an explicit identifier says which:
    # the host's own default is the right answer, and a name hardcoded here would be a
    # routing decision taken by the plugin for every operator.
    if [ -n "$model" ]; then
        shellcmd="$shellcmd --model $(printf '%q' "$model")"
    fi
    shellcmd="$shellcmd --permission-mode $(printf '%q' "$mode") --settings $(printf '%q' "$settings")"
    if [ -n "$prompt_file" ]; then
        shellcmd="$shellcmd \"\$(cat $(printf '%q' "$prompt_file"))\""
    fi

    local qcmd new_tty
    qcmd=$(applescript_quote "$shellcmd")
    if [ -n "$DRY_RUN" ]; then
        printf 'shellcmd=%s\n' "$shellcmd"
        printf 'applescript=%s\n' "$qcmd"
        printf 'prompt_file=%s\n' "$prompt_file"
        return 0
    fi
    # THE TAB FIRST, THE COMMAND SECOND, AND ONLY ONCE THE SHELL IS AT A PROMPT. A command
    # typed into a shell still starting is read by whatever is asking at that moment: a
    # startup question took the first keystroke and the rest ran as a different word.
    new_tty=$(osa "
    tell application \"iTerm2\"
        tell current window
            set newTab to (create tab with default profile)
            tell current session of newTab
                return tty
            end tell
        end tell
    end tell")
    [ -n "$new_tty" ] || die "spawn: iTerm2 returned no tty for the new tab"
    await_shell_ready "$new_tty"
    write_to_tty "$new_tty" "$shellcmd"

    if [ "$verify" = 1 ]; then
        local waited=0 pid="" retried=0
        while [ "$waited" -lt "$SPAWN_TIMEOUT" ]; do
            pid=$(cli_pid_on_tty "$new_tty")
            [ -n "$pid" ] && break
            # ONE RETRY, when the shell is back at a prompt with nothing running: the typed
            # line was eaten or mangled. A second failure is reported, not retried again.
            if [ "$retried" = 0 ] && [ "$waited" -ge 4 ] && \
               [ "$(tab_contents "$new_tty" | shell_prompt_state)" = ready ]; then
                echo "spawn: $HOST_CLI not running on $new_tty after ${waited}s and the shell is at a prompt — typing the command once more" >&2
                await_shell_ready "$new_tty"
                write_to_tty "$new_tty" "$shellcmd"
                retried=1
            fi
            sleep 1
            waited=$((waited + 1))
        done
        if [ -z "$pid" ]; then
            echo "ERROR: spawn: no $HOST_CLI process on $new_tty after ${SPAWN_TIMEOUT}s — the typed command did not run. Last lines of the tab:" >&2
            tab_tail "$new_tty" | sed 's/^/    /' >&2
            [ -n "$prompt_file" ] && echo "The prompt is kept at $prompt_file." >&2
            exit 1
        fi
        echo "spawn: $HOST_CLI running on $new_tty (pid $pid)" >&2
    fi
    if [ -n "$right_of" ]; then
        cmd_move --tty "$new_tty" --right-of "$right_of" >&2
    elif [ -n "$left_of" ]; then
        cmd_move --tty "$new_tty" --left-of "$left_of" >&2
    fi
    echo "$new_tty"
}

# The tty this script is running on, found by walking up the process tree: the
# immediate shell is often detached ("??"), the session's own process is not.
# `--right-of self` exists so a caller can place a tab beside its own without
# having to name the neighbour on the other side, which it has no way to know.
resolve_self_tty() {
    local pid=$$ tty=""
    local hops=0
    while [ "$pid" -gt 1 ] && [ "$hops" -lt 12 ]; do
        tty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
        case "$tty" in
            ttys*) printf '/dev/%s\n' "$tty"; return 0 ;;
        esac
        pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
        [ -n "$pid" ] || break
        hops=$((hops + 1))
    done
    die "could not resolve this session's own tty for --right-of self"
}

cmd_move() {
    local target_tty="" anchor_tty="" side=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --tty) target_tty="$2"; shift 2 ;;
            --left-of) anchor_tty="$2"; side="left"; shift 2 ;;
            --right-of) anchor_tty="$2"; side="right"; shift 2 ;;
            *) die "move: unknown option $1" ;;
        esac
    done
    [ -n "$target_tty" ] || die "move: --tty is required"
    [ -n "$anchor_tty" ] || die "move: --left-of or --right-of is required"
    [ "$anchor_tty" != "self" ] || anchor_tty=$(resolve_self_tty)
    [ "$target_tty" != "$anchor_tty" ] || die "move: --tty and the anchor must differ"

    local qtarget qanchor
    qtarget=$(applescript_quote "$target_tty")
    qanchor=$(applescript_quote "$anchor_tty")
    # Moves needed, per side. Crossing the anchor shifts it by one, so the count is
    # not symmetric: coming from the right, "left of" must cross and "right of" must
    # stop one short; coming from the left it is the mirror. Wrong arithmetic here
    # moves zero tabs and the verification below catches it — it did, once.
    local offset=-1 word="left" gt_adjust=0 lt_adjust=-1
    if [ "$side" = "right" ]; then offset=1; word="right"; gt_adjust=-1; lt_adjust=0; fi
    osa "
    on positions()
        tell application \"iTerm2\"
            set targetPos to 0
            set anchorPos to 0
            set targetWin to 0
            set anchorWin to 0
            set targetTab to missing value
            set winIndex to 0
            repeat with w in windows
                set winIndex to winIndex + 1
                set tabIndex to 0
                repeat with t in tabs of w
                    set tabIndex to tabIndex + 1
                    repeat with s in sessions of t
                        if (tty of s) is \"$qtarget\" then
                            set targetPos to tabIndex
                            set targetWin to winIndex
                            set targetTab to t
                        end if
                        if (tty of s) is \"$qanchor\" then
                            set anchorPos to tabIndex
                            set anchorWin to winIndex
                        end if
                    end repeat
                end repeat
            end repeat
            if targetPos is 0 then error \"No session found on $qtarget.\"
            if anchorPos is 0 then error \"No session found on $qanchor.\"
            if targetWin is not anchorWin then error \"Sessions $qtarget and $qanchor are in different windows.\"
            return {targetPos, anchorPos, targetTab}
        end tell
    end positions

    on moveOnce(direction)
        tell application \"System Events\" to tell process \"iTerm2\"
            click menu item (\"Move Tab \" & direction) of menu \"Move Tab\" of menu item \"Move Tab\" of menu \"Tab\" of menu item \"Tab\" of menu \"Window\" of menu bar item \"Window\" of menu bar 1
        end tell
        delay 0.2
    end moveOnce

    set {targetPos, anchorPos, targetTab} to positions()
    if targetPos is (anchorPos + ($offset)) then return \"already $word of $qanchor\"

    tell application \"System Events\" to set previousApp to name of first application process whose frontmost is true
    tell application \"iTerm2\"
        activate
        select targetTab
    end tell
    delay 0.3
    if targetPos > anchorPos then
        repeat (targetPos - anchorPos + ($gt_adjust)) times
            moveOnce(\"Left\")
        end repeat
    else
        repeat (anchorPos - targetPos + ($lt_adjust)) times
            moveOnce(\"Right\")
        end repeat
    end if
    if previousApp is not \"iTerm2\" then
        try
            tell application previousApp to activate
        end try
    end if

    set {targetPos, anchorPos, targetTab} to positions()
    if targetPos is not (anchorPos + ($offset)) then error \"Move failed: $qtarget is at tab \" & targetPos & \", $qanchor at tab \" & anchorPos & \".\"
    return \"moved $qtarget to tab \" & targetPos & \", $word of $qanchor\"
    "
}

cmd_close() {
    local target_tty="" expect_title=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --tty) target_tty="$2"; shift 2 ;;
            --expect-title) expect_title="$2"; shift 2 ;;
            *) die "close: unknown option $1" ;;
        esac
    done
    [ -n "$target_tty" ] || die "close: --tty is required"

    local qtty qtitle
    qtty=$(applescript_quote "$target_tty")
    qtitle=$(applescript_quote "$expect_title")
    osa "
    tell application \"iTerm2\"
        set matches to 0
        set target to missing value
        repeat with w in windows
            repeat with t in tabs of w
                repeat with s in sessions of t
                    if (tty of s) is \"$qtty\" then
                        if \"$qtitle\" is not \"\" and (name of s) does not contain \"$qtitle\" then
                            error \"Refused: session on $qtty is titled '\" & (name of s) & \"', which does not contain '$qtitle'.\"
                        end if
                        set matches to matches + 1
                        set target to s
                    end if
                end repeat
            end repeat
        end repeat
        if matches is 0 then error \"No session found on $qtty.\"
        close target
        return \"closed \" & matches & \" session on $qtty\"
    end tell"
}

cmd_rotate() {
    local dir="" model="" tier="" mode="auto" title="agent" prompt="" prompt_file="" old_tty="" expect_title="" left_of="" right_of=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --dir) dir="$2"; shift 2 ;;
            --model) model="$2"; shift 2 ;;
            --tier) tier="$2"; shift 2 ;;
            --permission-mode) mode="$2"; shift 2 ;;
            --title) title="$2"; shift 2 ;;
            --prompt) prompt="$2"; shift 2 ;;
            --prompt-file) prompt_file="$2"; shift 2 ;;
            --old-tty) old_tty="$2"; shift 2 ;;
            --expect-title) expect_title="$2"; shift 2 ;;
            --left-of) left_of="$2"; shift 2 ;;
            --right-of) right_of="$2"; shift 2 ;;
            *) die "rotate: unknown option $1" ;;
        esac
    done
    [ -n "$old_tty" ] || die "rotate: --old-tty is required"

    # The spawn verifies the replacement is RUNNING before anything is closed: a
    # rotation that killed the old agent on a spawn that never started would
    # leave zero agents, which is the one outcome this order exists to prevent.
    local new_tty
    new_tty=$(cmd_spawn --dir "$dir" --permission-mode "$mode" --title "$title" \
        ${tier:+--tier "$tier"} ${model:+--model "$model"} \
        ${prompt:+--prompt "$prompt"} ${prompt_file:+--prompt-file "$prompt_file"} ${left_of:+--left-of "$left_of"} ${right_of:+--right-of "$right_of"})
    echo "spawned replacement on $new_tty"

    local close_args=(--tty "$old_tty")
    [ -n "$expect_title" ] && close_args+=(--expect-title "$expect_title")
    cmd_close "${close_args[@]}"
}

case "${1:-}" in
    list)   shift; cmd_list "$@" ;;
    spawn)  shift; cmd_spawn "$@" ;;
    verify) shift; cmd_verify "$@" ;;
    prompt-state) shift; shell_prompt_state ;;
    resolve-tier) shift; cmd_resolve_tier "$@" ;;
    close)  shift; cmd_close "$@" ;;
    move)   shift; cmd_move "$@" ;;
    rotate) shift; cmd_rotate "$@" ;;
    *) die "usage: iterm-agent.sh {list|spawn|verify|resolve-tier|close|move|rotate} [options] (see header)" ;;
esac
