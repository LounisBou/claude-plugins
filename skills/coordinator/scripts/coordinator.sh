#!/bin/bash
# coordinator.sh - the coordinator's own record, and what the machine shows now.
#
#   coordinator.sh register --name "<name [ref]>" --tty /dev/ttysNNN   prints "registered <name>"
#   coordinator.sh clear                                              removes the record; none is no error
#   coordinator.sh lookup                                             the name while its session runs, else nothing
#   coordinator.sh facts     the sessions, checkouts and heavy runs of every repository a session
#                            works in, then the collisions among them
#   coordinator.sh owners    each open pull request of those repositories, traced to its orchestrator
#
# facts prints, one per line:
#   session <pid> | <tty> | <title> | <orchestrator> | <repository> | <branch> | <directory>
#     (the repository reads « not a git tree » for a directory in none)
#   checkout <path> | <repository> | <branch>
#   heavy <pid> | <directory> | <command>
#   collision checkouts | <repository> | <branch> | <path>, <path>...
#   collision sessions | <repository> | <branch> | <pid> <title>, <pid> <title>...
#   collision heavy | <pid>, <pid>...
#   collision pr | <repository>#<n> | <branch> | <orchestrator>, <orchestrator>...
#   unread <source>: <why>     a source not read: the process table, the host's name, lsof,
#                              a pid's directory, a tree git failed on, a brief, the checkouts,
#                              the forge
# owners prints one line per open pull request and session found on its branch:
#   pr <repository>#<n> | <branch> | <orchestrator> | session <pid> in <directory>
#   pr <repository>#<n> | <branch> | unknown | session <pid> in <directory> names no orchestrator
#   pr <repository>#<n> | <branch> | unknown | session <pid> in <directory>: brief <path> cannot be read
# or one « unknown » line per pull request where the chain breaks or allows two answers:
#   pr <repository>#<n> | <branch> | unknown | no checkout on <branch>
#   pr <repository>#<n> | <branch> | unknown | no session in <checkout>, <checkout>...
#   pr <repository>#<n> | <branch> | unknown | no session in <checkout>..., beside a session in <checkout>...
#   pr <repository>#<n> | <branch> | unknown | sessions <pid>, <pid> in <directory> name different orchestrators: <o>, <o>
#   pr <repository>#<n> | <branch> | unknown | head branch in a fork, owned by <owner>
#
# The chain an owner is read along: the pull request's head branch, the checkouts on it, the
# host sessions working there, and the orchestrator each one names — itself when its title
# is `Orch : …`, else the address its brief gives (« orchestrator is the session **`…`** »,
# a relative brief read from the session's directory), else the one its startup prompt
# gives; « unknown » where the chain breaks or allows two answers. A repository is its
# origin's address without scheme, user or `.git`, so a checkout and its source are one
# repository; a detached checkout is on no branch. A session is a host CLI process with a
# terminal; the host's name is ORCHESTRATOR_HOST_CLI, else the launcher's own default.
#
# Sources, each replaceable for the suite: the process table (`ps`, or the file
# COORDINATOR_PS_TABLE, lines `<pid> <ppid> <tty> <command>`), the working directories
# (`lsof`, or COORDINATOR_CWDS, lines `<pid> <path>`), the checkouts (`workspace.sh list`),
# and the open pull requests (`gh pr list` in the repository, or COORDINATOR_FORGE, called
# as `<command> <repository directory>` and printing `<number> <head branch> <head>` lines,
# <head> `same` for a branch of the repository itself, `fork:<owner>` for a fork's).
#
# State: <state>/coordinator.json {"name","tty","started"}; <state> is ORCHESTRATOR_STATE_DIR,
# else the plugin's directory under CLAUDE_CONFIG_DIR, else under ~/.claude, the launcher's
# own resolution. A registration goes through the lock directory <state>/coordinator.lock,
# waited for five seconds at most, then refused with the lock's path and its holder's pid; a
# lock is never broken automatically.
#
# Liveness: a session is alive when `iterm-agent.sh verify --tty <tty>` finds the host CLI
# on its tty; COORDINATOR_VERIFY names another command to run in its place, called as
# `<command> --tty <tty>` and read the same way, exit 0 alive; exit 1 with nothing on stderr
# is its « not running », and any other answer is an error, never « dead ».
#
# Exit codes: 0; 1 on a refusal or a usage error, and from `facts` when it prints a
# collision; 2 from `facts` and `owners` when a source could not be read, so an answer that
# cannot be known is never read as « no collision ».
#
# Why it exists: two orchestrations step on each other through what is checked out, what
# runs and which pull request a branch carries, and all of it can be read now. Nobody
# declares anything to the coordinator, so nothing it answers rests on what an orchestrator
# remembered to say, and no orchestrator carries a duty toward it; a reading made in prose
# would be made from memory, and that is where two sessions end up pushing to one branch.

set -uo pipefail

die() { echo "coordinator: $*" >&2; exit 1; }
say() { echo "coordinator: $*" >&2; }
command -v jq >/dev/null 2>&1 || die "jq is required"

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STATE="${ORCHESTRATOR_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-orchestrator}"
RECORD="$STATE/coordinator.json"
LOCK="$STATE/coordinator.lock"
LAUNCHER="$here/../../iterm-agents/scripts/iterm-agent.sh"
LAUNCHER_PY="$here/../../iterm-agents/scripts/iterm_agent.py"
WORKSPACE="$here/../../orchestrator/scripts/workspace.sh"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# alive <tty>: the host CLI runs on that tty, read from the process table by the launcher.
# Only the check's own « not running », exit 1 and silent, reads as dead; a check that
# cannot run or fails dies, since a live coordinator read as dead has its record taken.
alive() {
    local err rc
    if [ -n "${COORDINATOR_VERIFY:-}" ]; then
        [ -f "$COORDINATOR_VERIFY" ] && [ -x "$COORDINATOR_VERIFY" ] \
            || die "the liveness command $COORDINATOR_VERIFY is missing or not executable"
        err=$("$COORDINATOR_VERIFY" --tty "$1" 2>&1 >/dev/null </dev/null)
    else
        [ -f "$LAUNCHER" ] || die "the launcher $LAUNCHER is missing"
        err=$(bash "$LAUNCHER" verify --tty "$1" 2>&1 >/dev/null </dev/null)
    fi
    rc=$?
    [ "$rc" = 0 ] && return 0
    [ "$rc" = 1 ] && [ -z "$err" ] && return 1
    die "the liveness check failed on $1: ${err:-exit $rc}"
}

# lock <operation>: take the lock directory or refuse after five seconds. mkdir is the one
# test-and-set the shell has; the lock is removed on exit only by the process that took it,
# so a refused caller never frees a lock another one holds. The holder writes its pid and
# its operation into the lock, so a refusal names who holds it and whether it still runs;
# a lock left by a dead holder is named for removal, never broken here.
held=0
unlock() { [ "$held" = 1 ] && { rm -f "$LOCK/holder"; rmdir "$LOCK" 2>/dev/null; }; held=0; }
trap unlock EXIT
trap 'exit 1' INT TERM HUP
lock() {
    mkdir -p "$STATE" 2>/dev/null || die "cannot create the state directory $STATE"
    [ -w "$STATE" ] || die "cannot write into the state directory $STATE"
    local tries=0
    until mkdir "$LOCK" 2>/dev/null; do
        [ -d "$LOCK" ] || die "cannot create the lock $LOCK"
        tries=$((tries + 1))
        [ "$tries" -lt 50 ] || die "refused: $(lock_holder): remove $LOCK"
        sleep 0.1
    done
    held=1
    echo "$$ $1" > "$LOCK/holder"
}

# lock_holder: who holds the lock, as far as its holder file says, and nothing guessed.
lock_holder() {
    local pid="" op="" state=dead
    { read -r pid op < "$LOCK/holder"; } 2>/dev/null
    printf '%s' "$pid" | grep -qE '^[0-9]+$' \
        || { printf "the coordinator's lock is held: %s names no holder" "$LOCK"; return; }
    ps -p "$pid" >/dev/null 2>&1 && state=running
    if [ -n "$op" ]; then printf 'a %s holds the lock' "$op"; else printf "the coordinator's lock is held"; fi
    printf ': %s held by pid %s (%s)' "$LOCK" "$pid" "$state"
}

# write_atomic <path> <content>: the content replaces the file in one rename, so a reader
# never sees half of it.
write_atomic() {
    [ ! -d "$1" ] || die "cannot write $1: it is a directory"
    local tmp; tmp=$(mktemp "$STATE/.coordinator-XXXXXX") || die "cannot write into $STATE"
    printf '%s\n' "$2" > "$tmp" && mv "$tmp" "$1" || { rm -f "$tmp"; die "cannot write $1"; }
}

cmd_register() {
    local name="" tty=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --name) name="${2:-}"; shift 2 || die "register: --name needs a value" ;;
            --tty) tty="${2:-}"; shift 2 || die "register: --tty needs a value" ;;
            *) die "register: unknown option $1" ;;
        esac
    done
    [ -n "$name" ] && [ -n "$tty" ] || die "register: usage: register --name \"<name [ref]>\" --tty /dev/ttysNNN"
    lock registration
    if [ -f "$RECORD" ]; then
        local old_name old_tty
        old_name=$(jq -r '.name // ""' "$RECORD" 2>/dev/null)
        old_tty=$(jq -r '.tty // ""' "$RECORD" 2>/dev/null)
        if [ -n "$old_tty" ] && alive "$old_tty"; then
            die "refused: a live coordinator is recorded: $old_name on $old_tty"
        fi
        say "replaced a stale record: ${old_name:-an unreadable record}"
    fi
    local record
    record=$(jq -n --arg n "$name" --arg t "$tty" --arg s "$(now)" '{name:$n, tty:$t, started:$s}') \
        || die "register: cannot build the record"
    write_atomic "$RECORD" "$record"
    echo "registered $name"
}

cmd_clear() {
    [ $# -eq 0 ] || die "clear: unexpected argument $1"
    rm -f "$RECORD" || die "clear: cannot remove $RECORD"
}

cmd_lookup() {
    [ $# -eq 0 ] || die "lookup: unexpected argument $1"
    [ -f "$RECORD" ] || return 0
    local name tty
    name=$(jq -r '.name // ""' "$RECORD" 2>/dev/null)
    tty=$(jq -r '.tty // ""' "$RECORD" 2>/dev/null)
    if [ -n "$name" ] && [ -n "$tty" ] && alive "$tty"; then
        echo "$name"
    else
        say "stale record: ${name:-an unreadable record} on ${tty:-no tty}"
    fi
}

# --- The facts. Every table below is tab-separated, one row per line, in $T. -------------

T=""
unread() { printf 'unread %s\n' "$*" >> "$T/unread"; }

# repo_of <directory>: "<toplevel>\t<repository>\t<branch>" of the git tree holding it.
# The repository is the origin's address with its scheme, user and `.git` removed, so the
# same remote reached over two protocols is one repository; no origin, the toplevel.
# Exit 3 when the directory is in no git tree; any other failure of git is said on stderr
# and exits 1, since a tree git could not read is on a branch nobody knows.
repo_of() {
    local top url branch rc
    top=$(LC_ALL=C git -C "$1" rev-parse --show-toplevel 2>"$T/git.err") || {
        grep -q 'not a git repository' "$T/git.err" && return 3
        echo "git failed on $1: $(head -1 "$T/git.err")" >&2; return 1; }
    top=$(cd "$top" 2>/dev/null && pwd -P) || { echo "cannot enter $1" >&2; return 1; }
    branch=$(LC_ALL=C git -C "$top" symbolic-ref --short -q HEAD 2>"$T/git.err"); rc=$?
    case "$rc" in
        0) ;;
        1) branch=HEAD ;;
        *) echo "git failed on $top: $(head -1 "$T/git.err")" >&2; return 1 ;;
    esac
    url=$(LC_ALL=C git -C "$top" remote get-url origin 2>"$T/git.err"); rc=$?
    case "$rc" in
        0) url=$(printf '%s' "$url" | sed -E 's#^[A-Za-z+]+://##; s#^[^@/]*@##; s#^([^/:]+):#\1/#; s#\.git$##; s#/+$##') ;;
        2) url="$top" ;;
        *) echo "git failed on $top: $(head -1 "$T/git.err")" >&2; return 1 ;;
    esac
    printf '%s\t%s\t%s\n' "$top" "$url" "$branch"
}

host_cli() {
    local name="${ORCHESTRATOR_HOST_CLI:-}"
    [ -n "$name" ] || name=$(sed -n 's/^HOST_CLI = os.environ.get("ORCHESTRATOR_HOST_CLI", "\([^"]*\)")$/\1/p' "$LAUNCHER_PY" 2>/dev/null)
    [ -n "$name" ] || die "the host's name is unknown: set ORCHESTRATOR_HOST_CLI"
    basename "$name"
}

# brief_orchestrator <command line> <directory>: sets orch to the orchestrator the session's
# brief names, else the one its startup prompt names, else « unknown » with the reason in
# why. A relative brief is the session's own, read from its directory; a brief that exists
# and cannot be read is unread, never a brief that names nobody.
brief_orchestrator() {
    local brief found
    orch=""; why="names no orchestrator"
    brief=$(printf '%s' "$1" | sed -n 's/.*Read and execute \([^ ]*\).*/\1/p' | sed 's/\.$//')
    case "$brief" in
        ""|/*) ;;
        *) if [ -n "$2" ]; then brief="$2/$brief"; else why="its brief $brief is relative to a directory not read"; brief=""; fi ;;
    esac
    if [ -n "$brief" ] && [ -e "$brief" ]; then
        if [ -f "$brief" ] && [ -r "$brief" ]; then
            found=$(grep -o 'rchestrator is the session \*\*`[^`]*`' "$brief" | head -1 | sed 's/.*`\(.*\)`$/\1/')
            [ -n "$found" ] && { orch="$found"; return; }
        else
            unread "brief $brief: cannot be read"
            why="brief $brief cannot be read"
        fi
    fi
    orch=$(printf '%s' "$1" | sed -n 's/.*[Yy]our orchestrator is \(Orch : [^][]*\[[0-9A-Za-z]*\]\).*/\1/p')
    [ -n "$orch" ] || orch=unknown
}

# read_facts: fills $T with sessions, places (checkouts and session trees), heavy runs and
# pull requests, for the repositories a session works in.
read_facts() {
    T=$(mktemp -d "${TMPDIR:-/tmp}/coordinator-XXXXXX") || die "cannot make a temporary directory"
    trap 'unlock; rm -rf "$T"' EXIT
    : > "$T/unread"; : > "$T/sessions"; : > "$T/places"; : > "$T/heavy"; : > "$T/prs"
    # With no host name no process is a session, and an empty list reads as « no collision ».
    local hostname
    hostname=$(host_cli 2>"$T/host.err") || { unread "sessions: $(sed 's/^coordinator: //' "$T/host.err" | head -1)"; hostname=""; }

    local table="$T/ps"
    if [ -n "${COORDINATOR_PS_TABLE:-}" ]; then
        cp "$COORDINATOR_PS_TABLE" "$table" 2>/dev/null || { unread "processes: $COORDINATOR_PS_TABLE cannot be read"; : > "$table"; }
    else
        ps -Ao pid=,ppid=,tty=,command= > "$table" 2>/dev/null || { unread "processes: ps failed"; : > "$table"; }
    fi

    # The host sessions: the first word of the command is the host CLI, and a terminal
    # holds it, and it is no evaluation run's. The heavy runs: the plugin's suites and
    # evaluation runs, each counted once at its top process, since a suite's subshells and
    # an evaluation's host process carry its command line too.
    awk -v host="$hostname" '
        function base(x) { sub(/.*\//, "", x); return x }
        { pid = $1; ppid = $2; tty = $3; cmd = $0
          sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]+[^ \t]+[ \t]+/, "", cmd)
          # What runs, past a `timeout <n>` and a shell given a script: a wrapper `sh -c`
          # that only names a suite in its text, or a `pgrep` looking for one, runs none.
          split(cmd, w, /[ \t]+/); i = 1
          if (base(w[i]) == "timeout") i += 2
          if (base(w[i]) ~ /^(ba|z)?sh$/ && w[i + 1] !~ /^-/) i++
          heavy[pid] = (w[i] ~ /(^|\/)(run-tests|e2e)[.]sh$/ || (base(w[i]) == host && w[i + 1] == "plugin" && w[i + 2] == "eval"))
          parent[pid] = ppid; line[pid] = cmd; order[++n] = pid
          first = cmd; sub(/[ \t].*/, "", first); sub(/.*\//, "", first)
          session[pid] = (first == host && tty != "??" && tty != "-"); ttyof[pid] = tty
        }
        END { for (i = 1; i <= n; i++) { p = order[i]
                if (heavy[p] && !heavy[parent[p]]) print "H\t" p "\t" line[p]
                else if (session[p] && !heavy[p]) print "S\t" p "\t" ttyof[p] "\t" line[p] } }' "$table" > "$T/procs"

    # The working directory of every session and heavy run, in one lsof call.
    local pids rc; pids=$(cut -f2 "$T/procs" | paste -sd, -)
    : > "$T/cwds"
    if [ -n "$pids" ]; then
        if [ -n "${COORDINATOR_CWDS:-}" ]; then
            awk '{ p = $1; sub(/^[0-9]+[ \t]+/, ""); print p "\t" $0 }' "$COORDINATOR_CWDS" > "$T/cwds" 2>/dev/null \
                || unread "directories: $COORDINATOR_CWDS cannot be read"
        elif command -v lsof >/dev/null 2>&1; then
            lsof -a -d cwd -p "$pids" -Fpn 2>"$T/lsof.err" | awk '/^p/ { p = substr($0, 2) } /^n/ { print p "\t" substr($0, 2) }' > "$T/cwds"
            rc=$?
            [ "$rc" = 0 ] || unread "directories: lsof failed: $(head -1 "$T/lsof.err" | grep . || echo "exit $rc")"
        else
            unread "directories: lsof is missing"
        fi
    fi

    # A pid with no directory, or a directory git could not read, is on no branch and would
    # drop out of every collision unsaid: each one is an unread line.
    local kind pid tty cmd cwd info top repo branch title orch why
    while IFS=$'\t' read -r kind pid tty cmd; do
        cwd=$(awk -F'\t' -v p="$pid" '$1 == p { print $2; exit }' "$T/cwds")
        if [ "$kind" = H ]; then
            # A heavy row has no tty column: its third field is the command.
            if [ -n "$cwd" ]; then info=$(repo_of "$cwd" 2>/dev/null) && cwd=$(printf '%s' "$info" | cut -f1)
            else unread "directory of heavy run $pid: no working directory read"; fi
            printf '%s\t%s\t%s\n' "$pid" "${cwd:--}" "$tty" >> "$T/heavy"
            continue
        fi
        top="${cwd:--}"; repo=-; branch=-
        if [ -z "$cwd" ]; then
            unread "directory of session $pid: no working directory read"
        else
            info=$(repo_of "$cwd" 2>"$T/repo.err"); rc=$?
            case "$rc" in
                0) IFS=$'\t' read -r top repo branch <<< "$info" ;;
                3) repo="not a git tree" ;;
                *) unread "directory of session $pid: $(head -1 "$T/repo.err")" ;;
            esac
        fi
        title=$(printf '%s' "$cmd" | sed -n 's/.* --name \(.*\)$/\1/p' | sed 's/ --remote-control .*//')
        case "$title" in
            "Orch : "*) orch="$title"; why=- ;;
            *) brief_orchestrator "$cmd" "$cwd" ;;
        esac
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$tty" "${title:--}" "$orch" "$repo" "$branch" "$top" "$why" >> "$T/sessions"
        [ "$branch" != - ] && printf '%s\t%s\t%s\n' "$top" "$repo" "$branch" >> "$T/places"
    done < "$T/procs"
    # The checkouts, of the repositories a session works in only: a checkout left over in
    # a repository nobody works in steps on nobody.
    local listing path
    if listing=$(bash "$WORKSPACE" list 2>"$T/ws.err"); then
        while IFS='|' read -r path _; do
            path=$(printf '%s' "$path" | sed 's/[[:space:]]*$//')
            [ -n "$path" ] || continue
            # The listing may spell a path through a symbolic link (/var for /private/var):
            # read under its real name, as a session's directory is.
            path=$(cd "$path" 2>/dev/null && pwd -P || printf '%s' "$path")
            info=$(repo_of "$path" 2>"$T/repo.err"); rc=$?
            if [ "$rc" = 3 ]; then unread "checkout $path: not a git tree"; continue; fi
            if [ "$rc" != 0 ]; then unread "checkout $path: $(head -1 "$T/repo.err")"; continue; fi
            IFS=$'\t' read -r top repo branch <<< "$info"
            cut -f5 "$T/sessions" | grep -qxF "$repo" || continue
            printf '%s\t%s\t%s\n' "$top" "$repo" "$branch" >> "$T/places"
        done <<< "$listing"
    else
        unread "checkouts: $(head -1 "$T/ws.err")"
    fi
    sort -u "$T/places" -o "$T/places"

    # The open pull requests, once per repository, read in the first tree found for it.
    local seen="" out
    while IFS=$'\t' read -r top repo branch; do
        case " $seen " in *" $repo "*) continue ;; esac
        seen="$seen $repo"
        if [ -n "${COORDINATOR_FORGE:-}" ]; then
            out=$("$COORDINATOR_FORGE" "$top" 2>"$T/forge.err" </dev/null)
        else
            out=$(cd "$top" && gh pr list --state open --limit 200 --json number,headRefName,isCrossRepository,headRepositoryOwner \
                --jq '.[] | "\(.number) \(.headRefName) \(if .isCrossRepository then "fork:\(.headRepositoryOwner.login)" else "same" end)"' \
                2>"$T/forge.err" </dev/null)
        fi
        if [ $? -ne 0 ]; then
            unread "forge $repo: $(head -1 "$T/forge.err")"
            continue
        fi
        printf '%s\n' "$out" | awk -v r="$repo" 'NF >= 2 { print r "\t" $1 "\t" $2 "\t" (NF >= 3 ? $3 : "-") }' >> "$T/prs"
    done < "$T/places"
}

# owners_table: repository, number, branch, orchestrator, evidence — one row per pull
# request and session found on its branch, or one « unknown » row where the chain allows
# two answers: a head in a fork (its branch name is no branch of ours), a checkout on the
# branch with no session beside one with a session, two orchestrators named in one checkout.
owners_table() {
    awk -F'\t' '
        function add(l, x) { return l == "" ? x : l ", " x }
        FILENAME == ARGV[1] { n++; s_pid[n] = $1; s_orch[n] = $4; s_repo[n] = $5; s_branch[n] = $6; s_top[n] = $7; s_why[n] = $8; next }
        FILENAME == ARGV[2] { k = $2 "\t" $3; np[k]++; p_top[k, np[k]] = $1; next }
        { lead = $1 "\t" $2 "\t" $3 "\t"
          if ($4 ~ /^fork:/) { print lead "unknown\thead branch in a fork, owned by " substr($4, 6); next }
          if ($4 != "same") { print lead "unknown\tthe forge gave no head repository"; next }
          k = $1 "\t" $3; busy = ""; idle = ""
          for (j = 1; j <= np[k]; j++) { t = p_top[k, j]; has = 0
              for (i = 1; i <= n; i++) if (s_top[i] == t && s_repo[i] == $1 && s_branch[i] == $3) has = 1
              if (has) busy = add(busy, t); else idle = add(idle, t) }
          if (busy == "") { print lead "unknown\t" (idle == "" ? "no checkout on " $3 : "no session in " idle); next }
          if (idle != "") { print lead "unknown\tno session in " idle ", beside a session in " busy; next }
          for (j = 1; j <= np[k]; j++) { t = p_top[k, j]; pids = ""; orchs = ""; c = 0; split("", seen)
              for (i = 1; i <= n; i++) if (s_top[i] == t && s_repo[i] == $1 && s_branch[i] == $3) {
                  pids = add(pids, s_pid[i]); if (!(s_orch[i] in seen)) { seen[s_orch[i]] = 1; c++; orchs = add(orchs, s_orch[i]) } }
              if (c > 1) { print lead "unknown\tsessions " pids " in " t " name different orchestrators: " orchs; continue }
              for (i = 1; i <= n; i++) if (s_top[i] == t && s_repo[i] == $1 && s_branch[i] == $3) {
                  if (s_orch[i] == "unknown") print lead "unknown\tsession " s_pid[i] " in " t (s_why[i] ~ /^names / ? " " : ": ") s_why[i]
                  else print lead s_orch[i] "\tsession " s_pid[i] " in " t }
          }
        }' "$T/sessions" "$T/places" "$T/prs"
}

# pr_collisions: a pull request of ours whose branch sessions of two orchestrators are on,
# read from the sessions themselves, so an « unknown » owner never hides it.
pr_collisions() {
    awk -F'\t' '
        FILENAME == ARGV[1] { if ($4 != "unknown") { k = $5 "\t" $6; if (!((k, $4) in seen)) { seen[k, $4] = 1; c[k]++; l[k] = (k in l) ? l[k] ", " $4 : $4 } } next }
        $4 == "same" { k = $1 "\t" $3; if (c[k] > 1) print "collision pr | " $1 "#" $2 " | " $3 " | " l[k] }' "$T/sessions" "$T/prs" | sort
}

finish() {
    cat "$T/unread"
    if [ -s "$T/unread" ]; then exit 2; fi
}

cmd_facts() {
    [ $# -eq 0 ] || die "facts: unexpected argument $1"
    read_facts
    awk -F'\t' '{ print "session " $1 " | " $2 " | " $3 " | " $4 " | " $5 " | " $6 " | " $7 }' "$T/sessions"
    # The checkout lines are the workspace's trees; a session's own clone is on its line.
    awk -F'\t' -v root="$( (cd "${ORCHESTRATOR_WORKSPACES:-$HOME/dev/workspaces}" 2>/dev/null && pwd -P) || true)" \
        'root != "" && index($1, root "/") == 1 { print "checkout " $1 " | " $2 " | " $3 }' "$T/places"
    awk -F'\t' '{ print "heavy " $1 " | " $2 " | " $3 }' "$T/heavy"

    {
        awk -F'\t' '$3 != "HEAD" && $3 != "-" { k = $2 "\t" $3; c[k]++; l[k] = (k in l) ? l[k] ", " $1 : $1 }
            END { for (k in c) if (c[k] > 1) { split(k, a, "\t"); print "collision checkouts | " a[1] " | " a[2] " | " l[k] } }' "$T/places" | sort
        awk -F'\t' '$5 != "-" && $6 != "HEAD" && $6 != "-" { k = $5 "\t" $6; c[k]++; v = $1 " " $3; l[k] = (k in l) ? l[k] ", " v : v }
            END { for (k in c) if (c[k] > 1) { split(k, a, "\t"); print "collision sessions | " a[1] " | " a[2] " | " l[k] } }' "$T/sessions" | sort
        awk -F'\t' '{ n++; l = (n > 1) ? l ", " $1 : $1 } END { if (n > 1) print "collision heavy | " l }' "$T/heavy"
        pr_collisions
    } > "$T/collisions"
    cat "$T/collisions"
    finish
    [ ! -s "$T/collisions" ]
}

cmd_owners() {
    [ $# -eq 0 ] || die "owners: unexpected argument $1"
    read_facts
    owners_table | awk -F'\t' '{ print "pr " $1 "#" $2 " | " $3 " | " $4 " | " $5 }'
    finish
}

cmd="${1:-}"
[ -n "$cmd" ] || die "usage: coordinator.sh {register|clear|lookup|facts|owners} ... (see header)"
shift
case "$cmd" in
    register) cmd_register "$@" ;;
    clear) cmd_clear "$@" ;;
    lookup) cmd_lookup "$@" ;;
    facts) cmd_facts "$@" ;;
    owners) cmd_owners "$@" ;;
    *) die "unknown subcommand: $cmd (expected register, clear, lookup, facts or owners)" ;;
esac
