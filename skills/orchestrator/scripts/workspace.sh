#!/bin/bash
# workspace.sh — a checkout per phase, with the project's local material.
#
#   workspace.sh create <source-repo> <name> [--base <branch|origin/branch>]   prints the checkout's path
#   workspace.sh pin <source-repo> <name> <ref> [--pr <n>]     a detached worktree at that commit, nothing local; prints its path
#   workspace.sh delete <path> [--discard]                     refuses unpushed work unless told; also removes the host's
#                                                              temporary directory of the path when no live process uses it
#   workspace.sh sweep [--deadline <seconds>] [--dry-run]      the leftovers, decided on facts: one line per item,
#                                                              "deleted <path>" | "kept <path>: <reason>" (a dry run says "would delete")
#   workspace.sh list                                          one line per checkout under the root (a pin reads HEAD … pinned)
#
# Root: ORCHESTRATOR_WORKSPACES, else ~/dev/workspaces. A checkout lives at
# <root>/<basename of the source>/<name>.
#
# Host temporary area: ORCHESTRATOR_HOST_TMP, else /private/tmp/claude-<uid>. The host keeps
# one directory per working directory a session ran in, named after that path with every
# character that is not a letter or a digit turned into `-` (`/a/.b_c` is `-a--b-c`; see
# `encode`); it holds the session's scratch. It leaves with its checkout (design §61).
#
# The one safety rule over every deletion here: never a dirty tree, unpushed commits (on a
# branch or on a detached head) or a stash, a pin whose head is on no branch, or a directory a
# live process has as its working directory (`lsof`, bounded; a process table that cannot be
# read is a refusal, never a « nothing there »; so is a checkout git cannot read).
# `--discard` overrides every guard on the checkout itself, a live process inside it included.
# It never overrides the guard on a host temporary directory, which `delete` and `sweep` both
# keep while a live process works in the directory it is named after or below it (a session's
# host directory is named after the directory the session started in, not after its scratch),
# or inside the host directory itself.
#
# Manifest: <repo>/.claude/workspace-manifest, one repository-relative path per line, `#`
# starts a comment; an absent path is said on stderr and skipped, and a path leaving the
# repository is refused.
#
# Why it exists: a git worktree writes into its source repository, so no single sandbox
# path contains it; a clone does, and a clone per phase makes the one-writer rule a fact
# instead of a queue. But a clone carries what git tracks and nothing else — not the
# project's local settings directory, not what its exclude file keeps out of history, not
# an environment file — so a session in it behaved like a stranger's. The copy is part of
# making the checkout, not a step after it (design §30).
#
# The script never writes the host's trust record (that is `spawn --trust`), never
# launches anything, and never touches the source. A pin writes nothing into the source
# but its worktree metadata.

set -uo pipefail

die() { echo "workspace: $*" >&2; exit 1; }
say() { echo "workspace: $*" >&2; }

ROOT_DIR="${ORCHESTRATOR_WORKSPACES:-$HOME/dev/workspaces}"

cmd="${1:-}"
[ -n "$cmd" ] || die "usage: workspace.sh {create|pin|delete|sweep|list} ... (see header)"
shift

# copy_list <source-root> <checkout-root> <relative-path>...: every path in one pass, each kept
# at its place under the root; non-zero when the copy fails. One process per file made a create
# listing 3,421 files run over four minutes at heavy system CPU on a shared server.
copy_list() {
    local from="$1" to="$2"
    shift 2
    [ $# -gt 0 ] || return 0
    printf '%s\0' "$@" | (cd "$from" && tar --null -cf - -T -) | tar -xf - -C "$to"
}

# copy_tree <source-root> <checkout-root> <relative-path>: 1 when absent, 2 when the copy fails.
copy_tree() {
    local from="$1/$3" to="$2/$3"
    [ -e "$from" ] || return 1
    mkdir -p "$(dirname "$to")" || return 2
    cp -R "$from" "$to" || return 2
}

trim() { printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }

HOST_TMP="${ORCHESTRATOR_HOST_TMP:-/private/tmp/claude-$(id -u)}"

# encode <path>: the name the host gives a directory's temporary directory — every character
# that is not a letter or a digit turned into `-`, the host's own rule, read on its live
# entries (`/srv/me/.cfg` is `-srv-me--cfg`). The one spelling every comparison uses.
encode() { printf '%s\n' "$1" | tr -c 'A-Za-z0-9\n' '-'; }

# bounded <seconds> <command...>: the command, killed when the time is spent.
bounded() {
    local secs="$1"; shift
    if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"
    elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"
    elif command -v perl >/dev/null 2>&1; then perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
    else "$@"
    fi
}

# default_branch <repo>: the repository's default branch as `origin/<name>`, from origin/HEAD
# alone. No network and no guess: the sweep runs inside the stop gate, on a deadline, and a
# branch guessed wrong would be kept as the default when it is not. Unset, it prints nothing,
# so a comparison against it never matches. (rhythm.sh reads the same ref, then asks the
# remote, then guesses; it has no deadline.)
default_branch() { git -C "$1" symbolic-ref --short -q refs/remotes/origin/HEAD 2>/dev/null; }

# The working directory of every live process, read once per run. An unreadable table is
# not an empty one: with nothing known, nothing is deleted.
CWD_LIST=""
CWD_READ=0
read_cwds() {
    [ "$CWD_READ" = 1 ] && return 0
    local out rc
    out=$(bounded 20 lsof -a -d cwd -Fn 2>/dev/null); rc=$?
    [ -n "$out" ] || return 1
    if [ "$rc" -eq 124 ] || [ "$rc" -ge 128 ]; then return 1; fi
    CWD_LIST=$(printf '%s\n' "$out" | sed -n 's/^n//p')
    CWD_READ=1
}

# live_inside <real-dir>: 0 and the path when a live process works in or under the directory,
# 1 when none does, 2 when the process table cannot be read.
live_inside() {
    read_cwds || return 2
    local dir="$1" c
    while IFS= read -r c; do
        [ -n "$c" ] || continue
        case "$c/" in "$dir"/*) printf '%s\n' "$c"; return 0 ;; esac
    done <<EOF
$CWD_LIST
EOF
    return 1
}

# The host's name (`encode`) of every live process's working directory and of each of its
# ancestors up to the root. A session's host directory is named after the directory the
# session STARTED in, while its cwd is wherever it works now — that directory or below it —
# and never the host directory itself: a session started in <root>/p/c1/sub and working in
# <root>/p/c1/sub/x keeps `…-p-c1-sub`, and `…-p-c1` with it.
LIVE_NAMES=""
LIVE_NAMES_READ=0
read_live_names() {
    [ "$LIVE_NAMES_READ" = 1 ] && return 0
    read_cwds || return 1
    LIVE_NAMES=$(printf '%s\n' "$CWD_LIST" \
        | awk '{ p = $0; while (p != "" && p != "/") { print p; sub(/\/[^\/]*$/, "", p) } }' \
        | tr -c 'A-Za-z0-9\n' '-' | sort -u)
    LIVE_NAMES_READ=1
}

# host_dir_live <host-dir>: 0 with LIVE_WHY when a live process may still use the host's
# temporary directory — it works in the directory the host directory is named after or below
# it, or inside the host directory itself; 1 when none does; 2 when the process table cannot
# be read.
LIVE_WHY=""
host_dir_live() {
    local t="$1"
    LIVE_WHY="the process table cannot be read"
    read_live_names || return 2
    if printf '%s\n' "$LIVE_NAMES" | grep -qxF -- "$(basename "$t")"; then
        LIVE_WHY="a live process works in the directory it is named after"; return 0
    fi
    live_inside "$(cd "$t" && pwd -P)" >/dev/null || return $?
    LIVE_WHY="a live process works inside"
}

# git_read <dir> <git arguments...>: GOUT holds the output; on a failure, REASON says git
# cannot read the checkout. A read that fails knows nothing, so it never reads as clean.
GOUT=""
git_read() {
    local d="$1" why
    shift
    GOUT=$(git -C "$d" "$@" 2>/dev/null) && return 0
    why=$(git -C "$d" "$@" 2>&1 >/dev/null | head -n 1)
    REASON="git cannot read the checkout: ${why:-git $1 failed}"
    return 1
}

# refusal <real-path>: sets REASON to why the checkout or pin may not be deleted, or to "".
REASON=""
refusal() {
    local real="$1" r
    REASON=""
    git_read "$real" status --porcelain || return
    [ -z "$GOUT" ] || { REASON="the tree is dirty"; return; }
    if [ -f "$real/.git" ]; then
        git_read "$real" for-each-ref --count=1 --contains HEAD refs/heads refs/remotes || return
        [ -n "$GOUT" ] || { REASON="the pin's head is on no branch of the source"; return; }
    else
        # HEAD as well as the branches: a commit on a detached head is on none of them. A
        # stash is on none either. (A pin shares its source's stash, so it is not asked there.)
        git_read "$real" log HEAD --branches --not --remotes --oneline || return
        [ -z "$GOUT" ] || { REASON="commits on no remote branch"; return; }
        git_read "$real" for-each-ref --count=1 refs/stash || return
        [ -z "$GOUT" ] || { REASON="a stash is held"; return; }
    fi
    live_inside "$real" >/dev/null; r=$?
    case "$r" in
        0) REASON="a live process has its working directory inside" ;;
        2) REASON="the process table cannot be read" ;;
    esac
}

# The trashes: a removal first moves its directory into one, in a single rename (each trash
# lives beside what it takes, so on its filesystem), then removes it there. A removal killed
# half way leaves its remains in the trash, never a partial checkout at its path that reads
# as dirty for ever; `sweep` empties the trashes first. Their names start with a dot, so no
# loop over the root or the host's area ever reads them as a checkout or an orphan.
host_trash() { printf '%s\n' "$HOST_TMP/.workspace-trash"; }
root_trash() { printf '%s\n' "$(cd "$ROOT_DIR" && pwd -P)/.trash"; }

# trash_remove <dir> <trash>: 1 when the move failed and nothing was touched; 0 once the
# directory has left its path, its remains, if any, said and left to the next sweep.
trash_remove() {
    local dir="$1" trash="$2" t
    mkdir -p "$trash" && t=$(mktemp -d "$trash/XXXXXX") || return 1
    mv -- "$dir" "$t/" 2>/dev/null || { rmdir "$t" 2>/dev/null; return 1; }
    rm -rf -- "$t" 2>/dev/null
    [ ! -e "$t" ] || say "the trash keeps $t: the next sweep empties it"
    return 0
}

# remove_host_tmp <path>...: the host's temporary directory of each spelling of a deleted
# checkout, unless a live process uses it (`host_dir_live`). Each removal is said and proved.
remove_host_tmp() {
    local p name dir r seen="
"
    case "$HOST_TMP" in /?*) ;; *) return 0 ;; esac
    for p in "$@"; do
        name=$(encode "$p")
        case "$name" in ""|"-") continue ;; esac
        case "$seen" in *"
$name
"*) continue ;; esac
        seen="$seen$name
"
        dir="$HOST_TMP/$name"
        if [ ! -d "$dir" ] || [ -L "$dir" ]; then continue; fi
        host_dir_live "$dir"; r=$?
        [ "$r" = 1 ] || { say "kept host temporary directory $dir: $LIVE_WHY"; continue; }
        trash_remove "$dir" "$(host_trash)"
        if [ -e "$dir" ]; then say "kept host temporary directory $dir: it could not be removed"; else echo "deleted $dir"; fi
    done
}

cmd_create() {
    local src="" name="" base=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --base) base="${2:-}"; shift 2 ;;
            --*) die "create: unknown option $1" ;;
            *) if [ -z "$src" ]; then src="$1"; elif [ -z "$name" ]; then name="$1"; else die "create: unexpected argument $1"; fi; shift ;;
        esac
    done
    [ -n "$src" ] && [ -n "$name" ] || die "create: usage: create <source-repo> <name> [--base <ref>]"
    git -C "$src" rev-parse --show-toplevel >/dev/null 2>&1 || die "create: not a git repository: $src"
    src=$(git -C "$src" rev-parse --show-toplevel)
    printf '%s' "$name" | grep -qE '^[A-Za-z0-9._-]+$' || die "create: name must match [A-Za-z0-9._-]+: $name"
    [ -n "$base" ] || base=$(git -C "$src" rev-parse --abbrev-ref HEAD)
    # A base is a local branch of the source, or an origin/ remote-tracking ref of it: a
    # source whose local branch lags its remote would otherwise hand the phase a stale base
    # with no way to name the fresh one (§35). Only origin/, because the checkout's origin
    # is pointed at the source's origin and nothing else; the remote's head is fetched into
    # the checkout below, since a clone carries only what the source's local branches reach.
    local remote_branch=""
    if git -C "$src" rev-parse --verify --quiet "refs/heads/$base" >/dev/null; then
        :
    elif [ "${base#origin/}" != "$base" ] && git -C "$src" rev-parse --verify --quiet "refs/remotes/$base" >/dev/null; then
        remote_branch="${base#origin/}"
    else
        die "create: the source has no branch or origin/ remote-tracking ref $base"
    fi
    local target="$ROOT_DIR/$(basename "$src")/$name"
    [ ! -e "$target" ] || die "create: already exists, delete it first: $target"
    mkdir -p "$(dirname "$target")" || die "create: cannot create $(dirname "$target")"
    if [ -n "$remote_branch" ]; then
        git clone --quiet --no-checkout "$src" "$target" 2>/dev/null || { rm -rf "$target"; die "create: clone failed from $src"; }
    else
        git clone --quiet --branch "$base" "$src" "$target" 2>/dev/null || { rm -rf "$target"; die "create: clone failed from $src"; }
    fi

    # origin is the real remote, so the implementer's push reaches it; a source without
    # one yields a checkout without one, and says so.
    local url
    url=$(git -C "$src" remote get-url origin 2>/dev/null || true)
    if [ -n "$url" ]; then
        git -C "$target" remote set-url origin "$url" || { rm -rf "$target"; die "create: cannot point origin at $url"; }
    else
        git -C "$target" remote remove origin >/dev/null 2>&1
        say "the source has no origin; the checkout has none either"
    fi

    if [ -n "$remote_branch" ]; then
        [ -n "$url" ] || { rm -rf "$target"; die "create: --base $base needs the source to have an origin"; }
        git -C "$target" fetch --quiet origin "$remote_branch" 2>/dev/null || { rm -rf "$target"; die "create: cannot fetch $remote_branch from $url"; }
        # -B, not -b: a --no-checkout clone already made the local branch the source's HEAD
        # names, and -b would refuse it.
        git -C "$target" checkout --quiet -B "$remote_branch" "origin/$remote_branch" 2>/dev/null || { rm -rf "$target"; die "create: cannot check out $remote_branch from origin/$remote_branch"; }
    fi

    # 1. The project's local settings directory — minus what the source's exclude file
    #    names INSIDE it. The host writes a runtime block into every repository's exclude
    #    file (worktrees, checkpoints, a mailbox), and a copy of the directory whole once
    #    carried two full worktrees, 4 GB, each with a `.git` pointing at the source (§35).
    #    A pattern naming the directory whole is set aside: it says the directory stays out
    #    of history, which every copied file already does. Git reads the reduced file, so
    #    the patterns mean what they mean to git; the listed files are copied in one pass, so
    #    what is skipped is never read.
    #    `settings.local.json` is withheld whatever the exclude file says about it: the
    #    permission rules it holds are the operator's own session's, never an agent's, so
    #    they never reach a checkout (the operator's ruling, 2026-09-29).
    if [ -d "$src/.claude/" ]; then
        local rules="$target/.git/workspace-rules" copied=0 skipped=0 withheld=0 f line l list=()
        : > "$rules"
        if [ -f "$src/.git/info/exclude" ]; then
            while IFS= read -r line; do
                l="${line%/}"
                case "/${l#/}/" in "/.claude/"|"/**/.claude/") continue ;; esac
                printf '%s\n' "$line"
            done < "$src/.git/info/exclude" > "$rules"
        fi
        while IFS= read -r -d '' f; do
            [ -n "$f" ] || continue
            case "/$f" in
                /.claude/settings.local.json) withheld=$((withheld + 1)); continue ;;
            esac
            list+=("$f")
        done < <(git -C "$src" ls-files -z --others --exclude-from="$rules" -- "$src/.claude/")
        copy_list "$src" "$target" ${list[@]+"${list[@]}"} || { rm -rf "$target"; die "create: copying the local settings directory failed"; }
        copied=${#list[@]}
        skipped=$(git -C "$src" -c core.quotePath=false ls-files --others --ignored --directory --exclude-from="$rules" -- "$src/.claude/" | grep -c .)
        rm -f "$rules"
        say "copied the local settings directory ($copied files, $skipped skipped by the exclude file, $withheld withheld: the operator's own settings.local.json never travels into a checkout)"
    fi

    # 2. What the exclude file keeps out of history, listed by git itself so the patterns
    #    are read the way git reads them and only present files are copied.
    local n=0 list=()
    if [ -f "$src/.git/info/exclude" ]; then
        while IFS= read -r -d '' f; do
            [ -n "$f" ] || continue
            case "/$f" in /.claude/*) continue ;; esac
            list+=("$f")
        done < <(git -C "$src" ls-files -z --others --ignored --exclude-from="$src/.git/info/exclude")
        copy_list "$src" "$target" ${list[@]+"${list[@]}"} || { rm -rf "$target"; die "create: copying the excluded files failed"; }
        n=${#list[@]}
    fi
    say "copied $n excluded files"

    # What was copied is kept out of the checkout's own history the way the source keeps
    # it out of its own: otherwise every checkout reads dirty from birth, and `delete`
    # refuses it for work that is not work.
    {
        echo "# workspace.sh: the source's local material, copied in, never committed"
        [ -f "$src/.git/info/exclude" ] && cat "$src/.git/info/exclude"
        [ -d "$src/.claude/" ] && echo "/.claude/"
    } >> "$target/.git/info/exclude"

    # 2b. What the OPERATOR's global excludes file keeps out of the source. The project's
    #    own instruction file travelled by hand on every live run of this family: it is
    #    kept out of history by core.excludesFile, not by the repository's own exclude
    #    file, so step 2 above never lists it (§40). A `~` in the configured path is
    #    expanded the way git expands it; a path already copied by step 1 or 2 is skipped
    #    here so it is copied once and counted once.
    local global_excludes
    global_excludes=$(git -C "$src" config --get core.excludesFile 2>/dev/null || true)
    [ -n "$global_excludes" ] || global_excludes="${XDG_CONFIG_HOME:-$HOME/.config}/git/ignore"
    case "$global_excludes" in
        "~") global_excludes="$HOME" ;;
        "~/"*) global_excludes="$HOME/${global_excludes#\~/}" ;;
    esac
    local gn=0
    list=()
    if [ -s "$global_excludes" ]; then
        while IFS= read -r -d '' f; do
            [ -n "$f" ] || continue
            case "/$f" in /.claude/*) continue ;; esac
            [ -e "$target/$f" ] && continue
            list+=("$f")
        done < <(git -C "$src" ls-files -z --others --ignored --exclude-from="$global_excludes")
        copy_list "$src" "$target" ${list[@]+"${list[@]}"} || { rm -rf "$target"; die "create: copying the files kept out by the global excludes failed"; }
        gn=${#list[@]}
        {
            echo "# workspace.sh: the operator's global excludes"
            cat "$global_excludes"
        } >> "$target/.git/info/exclude"
    fi
    say "copied $gn files kept out by the global excludes"

    # 3. The optional manifest: one relative path per line, a file or a directory. Absent
    #    is said and skipped (a manifest serves more than one machine); leaving the
    #    repository is refused; build trees never travel.
    local manifest="$src/.claude/workspace-manifest" copied=0 missing=""
    if [ -f "$manifest" ]; then
        while IFS= read -r f || [ -n "$f" ]; do
            f=$(trim "${f%%#*}")
            [ -n "$f" ] || continue
            case "$f" in /*|..|../*|*/..|*/../*) rm -rf "$target"; die "create: manifest path leaves the repository: $f" ;; esac
            case "$f" in .git|.git/*|node_modules|node_modules/*|vendor|vendor/*) say "manifest: never copied: $f"; continue ;; esac
            if copy_tree "$src" "$target" "$f"; then copied=$((copied + 1)); echo "/$f" >> "$target/.git/info/exclude"; else missing="$missing $f"; fi
        done < "$manifest"
        if [ -n "$missing" ]; then say "manifest: $copied copied, missing:$missing"; else say "manifest: $copied copied, 0 missing"; fi
    fi

    echo "$target"
}

cmd_pin() {
    local src="" name="" ref="" pr="" pr_given=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --pr) pr="${2:-}"; pr_given=1; shift 2 ;;
            --*) die "pin: unknown option $1" ;;
            *) if [ -z "$src" ]; then src="$1"; elif [ -z "$name" ]; then name="$1"; elif [ -z "$ref" ]; then ref="$1"; else die "pin: unexpected argument $1"; fi; shift ;;
        esac
    done
    [ -n "$src" ] && [ -n "$name" ] && [ -n "$ref" ] || die "pin: usage: pin <source-repo> <name> <ref> [--pr <n>]"
    if [ "$pr_given" = 1 ]; then
        printf '%s' "$pr" | grep -qE '^[0-9]+$' || die "pin: --pr needs a pull request number: $pr"
    fi
    git -C "$src" rev-parse --show-toplevel >/dev/null 2>&1 || die "pin: not a git repository: $src"
    src=$(git -C "$src" rev-parse --show-toplevel)
    printf '%s' "$name" | grep -qE '^[A-Za-z0-9._-]+$' || die "pin: name must match [A-Za-z0-9._-]+: $name"
    local sha
    sha=$(git -C "$src" rev-parse --verify --quiet "$ref^{commit}") || die "pin: the source does not know $ref"
    local target="$ROOT_DIR/$(basename "$src")/$name"
    [ ! -e "$target" ] || die "pin: already exists, delete it first: $target"
    mkdir -p "$(dirname "$target")" || die "pin: cannot create $(dirname "$target")"
    # A detached worktree, and nothing else: a reader's copy carries the code at the head
    # and none of the local material — least of all the orchestrator's briefs and state
    # file — and writes nothing but its metadata into the source, which is the
    # orchestrator's own checkout (§37). A worktree shares the source's remotes.
    git -C "$src" worktree add --quiet --detach "$target" "$sha" 2>/dev/null || { rm -rf "$target"; die "pin: worktree add failed at $sha"; }
    # The pull request this pin reviews, in the worktree's own git dir: `git worktree remove`
    # takes it away with the pin, and `sweep` reads it to know when the review is over.
    if [ -n "$pr" ]; then
        printf '%s\n' "$pr" > "$(git -C "$target" rev-parse --absolute-git-dir)/workspace-pr" || { git -C "$src" worktree remove --force "$target" 2>/dev/null; die "pin: cannot record pull request $pr"; }
    fi
    say "pinned $(git -C "$src" rev-parse --short "$sha") from $ref"
    echo "$target"
}

cmd_delete() {
    local path="" discard=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --discard) discard=1; shift ;;
            --*) die "delete: unknown option $1" ;;
            *) [ -z "$path" ] || die "delete: unexpected argument $1"; path="$1"; shift ;;
        esac
    done
    [ -n "$path" ] || die "delete: usage: delete <path> [--discard]"
    [ -d "$path" ] || die "delete: no such checkout: $path"
    local real root logical
    real=$(cd "$path" && pwd -P)
    logical=$(cd "$path" && pwd)
    mkdir -p "$ROOT_DIR" || die "delete: cannot read the root $ROOT_DIR"
    root=$(cd "$ROOT_DIR" && pwd -P)
    case "$real/" in "$root"/*/*/) ;; *) die "delete: refusing a path outside $root: $path" ;; esac
    # The guards, shared with `sweep` (see `refusal`). For a pin (§37) the second one is not
    # « commits on no remote branch » — the shared refs would read the source's — but « a head
    # on no branch of the source »: a reader that committed in its copy is the one way to lose
    # work here, the pinned commit itself living in the source. It is asked of the refs, not of
    # `git branch --contains`, which lists the detached head itself and so never came back empty. A live process inside is read
    # last, and `--discard` is the operator's word over all of them.
    if [ "$discard" = 0 ]; then
        refusal "$real"
        [ -z "$REASON" ] || die "delete: $REASON (pass --discard to remove it anyway): $path"
    fi
    local common=""
    # A pin's source is read before the pin leaves: the source forgets it through git once
    # it is gone (`worktree remove` of a path that no longer exists drops the metadata).
    [ ! -f "$real/.git" ] || common=$(git -C "$real" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
        || die "delete: cannot read the pin's source: $real"
    trash_remove "$real" "$root/.trash" || die "delete: cannot move into the trash: $real"
    if [ -n "$common" ]; then
        git --git-dir="$common" worktree remove --force "$real" 2>/dev/null \
            || say "the source still lists the worktree $real; \`git worktree prune\` in it drops it"
    fi
    [ ! -e "$real" ] || die "delete: still there after the removal: $real"
    echo "deleted $real"
    remove_host_tmp "$real" "$logical"
}

cmd_list() {
    [ -d "$ROOT_DIR" ] || return 0
    local d br head state pushed
    for d in "$ROOT_DIR"/*/*/; do
        [ -e "$d/.git" ] || continue
        d="${d%/}"
        br=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)
        head=$(git -C "$d" rev-parse --short HEAD 2>/dev/null)
        if [ -z "$(git -C "$d" status --porcelain 2>/dev/null)" ]; then state=clean; else state=dirty; fi
        if [ -f "$d/.git" ]; then pushed=pinned
        elif [ -z "$(git -C "$d" log --branches --not --remotes --oneline 2>/dev/null)" ]; then pushed=pushed; else pushed=unpushed; fi
        echo "$d | $br | $head | $state | $pushed"
    done
}

# --- sweep: the leftovers, decided on facts (design §61) ------------------------------------

SWEEP_TMP=""
SWEEP_T0=0
SWEEP_DEADLINE=""
SWEEP_DRY=0

# spent: the deadline is over (always false without one).
spent() { [ -n "$SWEEP_DEADLINE" ] && [ $((SECONDS - SWEEP_T0)) -ge "$SWEEP_DEADLINE" ]; }

# keep <path> <reason>: one line per item left in place.
keep() { echo "kept $1: $2"; }

# The pull requests of each repository outlive a sweep: a list is the slow part of it (a call
# per repository, seconds each), and a sweep cut by the stop gate's deadline restarted from
# nothing every time. One file per origin in the state directory (the stop gate's own
# resolution), read again after thirty minutes; a failed or cut call is never written.
STATE_DIR="${ORCHESTRATOR_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-orchestrator}"
PRS_CACHE="$STATE_DIR/sweep-prs"
PRS_FRESH_MINUTES=30

# load_prs <checkout>: PRS_FILE holds the repository's pull requests, read once per origin
# whatever the number of checkouts; returns 1 with PRS_WHY when they cannot be read. A
# failure is remembered and said once for the repository, and nothing is deleted for it.
PRS_FILE=""
PRS_WHY=""
load_prs() {
    local d="$1" url key secs=60 why cached
    url=$(git -C "$d" remote get-url origin 2>/dev/null) || { PRS_WHY="the checkout has no origin to ask"; return 1; }
    key=$(printf '%s' "$url" | cksum | cut -d' ' -f1)
    PRS_FILE="$SWEEP_TMP/prs-$key.json"
    cached="$PRS_CACHE/$key.json"
    if [ -f "$SWEEP_TMP/prs-$key.bad" ]; then PRS_WHY=$(cat "$SWEEP_TMP/prs-$key.bad"); return 1; fi
    [ -f "$PRS_FILE" ] && return 0
    if [ -n "$(find "$cached" -mmin -"$PRS_FRESH_MINUTES" 2>/dev/null)" ] && cp "$cached" "$PRS_FILE" 2>/dev/null \
        && python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$PRS_FILE" 2>/dev/null; then
        return 0
    fi
    if [ -n "$SWEEP_DEADLINE" ]; then
        secs=$((SWEEP_DEADLINE - (SECONDS - SWEEP_T0)))
        [ "$secs" -ge 1 ] || secs=1
        [ "$secs" -le 60 ] || secs=60
    fi
    # --limit: the default lists thirty, and a merged pull request older than that would
    # read as « no pull request » and never be swept. Two hundred, not a thousand: the long
    # list was most of a sweep's time, and a merged pull request past it reads as « no pull
    # request », which keeps the checkout — the safe side.
    if ! ( cd "$d" && bounded "$secs" gh pr list --state all --limit 200 --json headRefName,state,headRefOid,number ) > "$PRS_FILE" 2> "$SWEEP_TMP/gh.err" \
        || ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$PRS_FILE" 2>/dev/null; then
        why=$(head -n 1 "$SWEEP_TMP/gh.err" 2>/dev/null)
        [ -n "$why" ] || why="no readable answer"
        rm -f "$PRS_FILE"
        printf '%s\n' "$why" > "$SWEEP_TMP/prs-$key.bad"
        PRS_WHY="$why"
        say "sweep: cannot read the pull requests of $url ($why); nothing is deleted for it"
        return 1
    fi
    mkdir -p "$PRS_CACHE" 2>/dev/null && cp "$PRS_FILE" "$cached.$$" 2>/dev/null && mv -f "$cached.$$" "$cached" 2>/dev/null \
        || rm -f "$cached.$$" 2>/dev/null
    return 0
}

# branch_pr <json> <branch>: "none", "open <n>", "over <n> <STATE> <head commit>..." (merged or
# closed, the head of each such pull request) or "unknown".
branch_pr() {
    python3 - "$1" "$2" <<'PY'
import json, sys
prs = [p for p in json.load(open(sys.argv[1])) if p.get("headRefName") == sys.argv[2]]
if not prs:
    print("none")
elif any(p.get("state") == "OPEN" for p in prs):
    print("open", min(p["number"] for p in prs if p.get("state") == "OPEN"))
elif all(p.get("state") in ("MERGED", "CLOSED") for p in prs):
    last = max(prs, key=lambda p: p["number"])
    print("over", last["number"], last["state"], *[p.get("headRefOid", "") for p in prs])
else:
    print("unknown")
PY
}

# number_pr <json> <n>: "none", or "<STATE> <head commit>".
number_pr() {
    python3 - "$1" "$2" <<'PY'
import json, sys
prs = [p for p in json.load(open(sys.argv[1])) if str(p.get("number")) == sys.argv[2]]
print("none" if not prs else "%s %s" % (prs[0].get("state"), prs[0].get("headRefOid", "")))
PY
}

# sweep_decide <dir> <real>: prints "delete <reason>" or "keep <reason>".
sweep_decide() {
    local d="$1" real="$2" br facts n gd rec head default state oid about
    if [ -f "$real/.git" ]; then
        gd=$(git -C "$real" rev-parse --absolute-git-dir 2>/dev/null)
        rec=""
        [ -f "$gd/workspace-pr" ] && rec=$(tr -dc '0-9' < "$gd/workspace-pr")
        [ -n "$rec" ] || { echo "keep no recorded pull request for this pin"; return; }
        load_prs "$real" || { echo "keep pull requests unreadable: $PRS_WHY"; return; }
        facts=$(number_pr "$PRS_FILE" "$rec")
        case "$facts" in
            none) echo "keep pull request #$rec is not in the repository's list" ;;
            MERGED*|CLOSED*) echo "delete pull request #$rec is ${facts%% *}" ;;
            OPEN*)
                head=$(git -C "$real" rev-parse HEAD 2>/dev/null)
                if [ "${facts#OPEN }" = "$head" ]; then echo "keep pinned to the current head of open pull request #$rec"
                else echo "delete the head of pull request #$rec moved off the pinned commit"; fi ;;
            *) echo "keep pull request #$rec is in state ${facts%% *}" ;;
        esac
        return
    fi
    br=$(git -C "$real" symbolic-ref --short -q HEAD 2>/dev/null)
    [ -n "$br" ] || { echo "keep no branch checked out, so no pull request to match"; return; }
    # A long-lived branch is matched by name by pull requests that are not about it (a fork's
    # own `main`): it is never swept on a name.
    default=$(default_branch "$real")
    case "$br" in main|master|develop|trunk) echo "keep on $br, a long-lived branch"; return ;; esac
    [ "origin/$br" != "$default" ] || { echo "keep on $br, the repository's default branch"; return; }
    load_prs "$real" || { echo "keep pull requests unreadable: $PRS_WHY"; return; }
    facts=$(branch_pr "$PRS_FILE" "$br")
    case "$facts" in
        none) echo "keep no pull request for branch $br" ;;
        open*) n="${facts#open }"; echo "keep pull request #$n for branch $br is open" ;;
        over*)
            # The pull request must be about THIS commit: its head, or a descendant of the
            # clone's head the clone can see. A clone past the pull request's head holds work
            # the pull request never carried.
            set -- $facts
            n="$2"; state="$3"; shift 3
            head=$(git -C "$real" rev-parse HEAD 2>/dev/null)
            about=0
            for oid in "$@"; do
                [ -n "$oid" ] || continue
                if [ "$oid" = "$head" ]; then about=1; break; fi
                if git -C "$real" cat-file -e "$oid^{commit}" 2>/dev/null && git -C "$real" merge-base --is-ancestor "$head" "$oid" 2>/dev/null; then about=1; break; fi
            done
            if [ "$about" = 1 ]; then echo "delete the pull request #$n of branch $br is $state"
            else echo "keep the head is not the one of pull request #$n ($state): the branch moved past it"; fi ;;
        *) echo "keep the pull requests of branch $br are in no state this sweep decides on" ;;
    esac
}

# sweep_one <dir>: decide, then delete (or say what would be) and prove it.
sweep_one() {
    local d="$1" real verdict reason out rc
    real=$(cd "$d" && pwd -P)
    verdict=$(sweep_decide "$d" "$real")
    reason="${verdict#* }"
    case "$verdict" in
        delete\ *) ;;
        *) keep "$real" "$reason"; return ;;
    esac
    refusal "$real"
    [ -z "$REASON" ] || { keep "$real" "$REASON"; return; }
    if [ "$SWEEP_DRY" = 1 ]; then echo "would delete $real: $reason"; return; fi
    out=$(cmd_delete "$real" 2>"$SWEEP_TMP/delete.err"); rc=$?
    [ ! -s "$SWEEP_TMP/delete.err" ] || cat "$SWEEP_TMP/delete.err" >&2
    if [ "$rc" -ne 0 ] || [ -e "$real" ]; then keep "$real" "the delete did not complete ($(head -n 1 "$SWEEP_TMP/delete.err" | sed 's/^workspace: //'))"; return; fi
    printf '%s\n' "$out"
}

# sweep_orphans <real-root>: host temporary directories named after a checkout of a project
# under the root that matches no existing directory and no live process — what was left by
# checkouts deleted before the host's directory went with them.
sweep_orphans() {
    local root="$1" prefixes="" known="$SWEEP_TMP/known" d real t name r p hit
    : > "$known"
    # A directory that still exists under the root, a project's own or a checkout, is not an
    # orphan's: only what is named after nothing there is. And only a name under an EXISTING
    # project is a candidate: the encoded root followed by `-` is also the name of a sibling of
    # the root (`<root>-old/x`, `<root>_2/x`), which is not this script's to judge.
    for d in "$ROOT_DIR"/*/; do
        [ -d "$d" ] || continue
        real=$(cd "$d" && pwd -P)
        encode "$real" >> "$known"
        prefixes="$prefixes$(encode "$real")-
"
    done
    for d in "$ROOT_DIR"/*/*/; do
        [ -d "$d" ] || continue
        real=$(cd "$d" && pwd -P)
        encode "$real" >> "$known"
    done
    [ -d "$HOST_TMP" ] || return 0
    case "$HOST_TMP" in /?*) ;; *) return 0 ;; esac
    for t in "$HOST_TMP"/"$(encode "$root")"-*; do
        if [ ! -d "$t" ] || [ -L "$t" ]; then continue; fi
        name=$(basename "$t")
        hit=0
        while IFS= read -r p; do
            [ -n "$p" ] || continue
            case "$name" in "$p"?*) hit=1; break ;; esac
        done <<EOF
$prefixes
EOF
        [ "$hit" = 1 ] || continue
        grep -qxF -- "$name" "$known" && continue
        spent && { say "sweep: deadline of ${SWEEP_DEADLINE}s spent; the rest waits for the next sweep"; return 1; }
        host_dir_live "$t"; r=$?
        [ "$r" = 1 ] || { keep "$t" "$LIVE_WHY"; continue; }
        if [ "$SWEEP_DRY" = 1 ]; then echo "would delete $t: no checkout, no live process"; continue; fi
        trash_remove "$t" "$(host_trash)"
        if [ -e "$t" ]; then keep "$t" "it could not be removed"; else echo "deleted $t"; fi
    done
    return 0
}

# sweep_trash: what removals cut short left in the trashes, emptied before anything else.
sweep_trash() {
    local t
    for t in "$(root_trash)"/* "$(host_trash)"/*; do
        [ -e "$t" ] || [ -L "$t" ] || continue
        spent && { say "sweep: deadline of ${SWEEP_DEADLINE}s spent; the rest waits for the next sweep"; return 1; }
        if [ "$SWEEP_DRY" = 1 ]; then echo "would delete $t: left in the trash by a removal cut short"; continue; fi
        chmod -R u+w -- "$t" 2>/dev/null
        rm -rf -- "$t" 2>/dev/null
        if [ -e "$t" ]; then keep "$t" "it could not be removed"; else echo "deleted $t"; fi
    done
}

cmd_sweep() {
    SWEEP_DEADLINE=""; SWEEP_DRY=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --deadline) SWEEP_DEADLINE="${2:-}"; shift 2 || true ;;
            --dry-run) SWEEP_DRY=1; shift ;;
            *) die "sweep: usage: sweep [--deadline <seconds>] [--dry-run]" ;;
        esac
    done
    if [ -n "$SWEEP_DEADLINE" ]; then
        printf '%s' "$SWEEP_DEADLINE" | grep -qE '^[0-9]+(\.[0-9]+)?$' || die "sweep: --deadline needs a number of seconds: $SWEEP_DEADLINE"
        SWEEP_DEADLINE="${SWEEP_DEADLINE%%.*}"
    fi
    SWEEP_T0=$SECONDS
    [ -d "$ROOT_DIR" ] || return 0
    local root d
    root=$(cd "$ROOT_DIR" && pwd -P)
    SWEEP_TMP=$(mktemp -d "${TMPDIR:-/tmp}/workspace-sweep-XXXXXX") || die "sweep: cannot create a working directory"
    trap 'rm -rf -- "${SWEEP_TMP:?}"' EXIT
    # The trashes, then the orphans — local and cheap — then the checkouts, which ask the
    # pull requests: a sweep cut by its deadline has done the cheap part first.
    sweep_trash || return 0
    sweep_orphans "$root" || return 0
    for d in "$ROOT_DIR"/*/*/; do
        [ -e "$d/.git" ] || continue
        d="${d%/}"
        if spent; then say "sweep: deadline of ${SWEEP_DEADLINE}s spent; the rest waits for the next sweep"; return 0; fi
        sweep_one "$d"
    done
}

case "$cmd" in
    create) cmd_create "$@" ;;
    pin) cmd_pin "$@" ;;
    delete) cmd_delete "$@" ;;
    sweep) cmd_sweep "$@" ;;
    list) cmd_list "$@" ;;
    *) die "unknown command: $cmd" ;;
esac
