#!/bin/bash
# workspace.sh — a checkout per phase, with the project's local material.
#
#   workspace.sh create <source-repo> <name> [--base <branch|origin/branch>]   prints the checkout's path
#   workspace.sh pin <source-repo> <name> <ref>                a detached worktree at that commit, nothing local; prints its path
#   workspace.sh delete <path> [--discard]                     refuses unpushed work unless told
#   workspace.sh list                                          one line per checkout under the root (a pin reads HEAD … pinned)
#
# Root: ORCHESTRATOR_WORKSPACES, else ~/dev/workspaces. A checkout lives at
# <root>/<basename of the source>/<name>.
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
[ -n "$cmd" ] || die "usage: workspace.sh {create|pin|delete|list} ... (see header)"
shift

# copy_tree <source-root> <checkout-root> <relative-path>: 1 when absent, 2 when the copy fails.
copy_tree() {
    local from="$1/$3" to="$2/$3"
    [ -e "$from" ] || return 1
    mkdir -p "$(dirname "$to")" || return 2
    cp -R "$from" "$to" || return 2
}

trim() { printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }

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
    #    the patterns mean what they mean to git; the files are copied one by one, so what
    #    is skipped is never read.
    if [ -d "$src/.claude/" ]; then
        local rules="$target/.git/workspace-rules" copied=0 skipped=0 f line l
        : > "$rules"
        if [ -f "$src/.git/info/exclude" ]; then
            while IFS= read -r line; do
                l="${line%/}"
                case "/${l#/}/" in "/.claude/"|"/**/.claude/") continue ;; esac
                printf '%s\n' "$line"
            done < "$src/.git/info/exclude" > "$rules"
        fi
        while IFS= read -r f; do
            [ -n "$f" ] || continue
            copy_tree "$src" "$target" "$f" || { rm -rf "$target"; die "create: copying the local settings directory failed at $f"; }
            copied=$((copied + 1))
        done <<EOF
$(git -C "$src" ls-files --others --exclude-from="$rules" -- "$src/.claude/")
EOF
        skipped=$(git -C "$src" ls-files --others --ignored --directory --exclude-from="$rules" -- "$src/.claude/" | grep -c .)
        rm -f "$rules"
        say "copied the local settings directory ($copied files, $skipped skipped by the exclude file)"
    fi

    # 2. What the exclude file keeps out of history, listed by git itself so the patterns
    #    are read the way git reads them and only present files are copied.
    local n=0
    if [ -f "$src/.git/info/exclude" ]; then
        while IFS= read -r f; do
            [ -n "$f" ] || continue
            case "/$f" in /.claude/*) continue ;; esac
            copy_tree "$src" "$target" "$f" || { rm -rf "$target"; die "create: copying $f failed"; }
            n=$((n + 1))
        done <<EOF
$(git -C "$src" ls-files --others --ignored --exclude-from="$src/.git/info/exclude")
EOF
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
    local src="" name="" ref=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --*) die "pin: unknown option $1" ;;
            *) if [ -z "$src" ]; then src="$1"; elif [ -z "$name" ]; then name="$1"; elif [ -z "$ref" ]; then ref="$1"; else die "pin: unexpected argument $1"; fi; shift ;;
        esac
    done
    [ -n "$src" ] && [ -n "$name" ] && [ -n "$ref" ] || die "pin: usage: pin <source-repo> <name> <ref>"
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
    local real root
    real=$(cd "$path" && pwd -P)
    mkdir -p "$ROOT_DIR" || die "delete: cannot read the root $ROOT_DIR"
    root=$(cd "$ROOT_DIR" && pwd -P)
    case "$real/" in "$root"/*/*/) ;; *) die "delete: refusing a path outside $root: $path" ;; esac
    if [ -f "$real/.git" ]; then
        # A pinned copy (§37): removed through git so the source forgets it. The second
        # guard is not « commits on no remote branch » — the shared refs would read the
        # source's — but « a head on no branch of the source »: a reader that committed in
        # its copy is the one way to lose work here, the pinned commit itself living in the source.
        if [ "$discard" = 0 ]; then
            [ -z "$(git -C "$real" status --porcelain 2>/dev/null)" ] || die "delete: the tree is dirty; pass --discard: $path"
            [ -n "$(git -C "$real" branch -a --contains HEAD 2>/dev/null)" ] || die "delete: the pin's head is on no branch of the source; pass --discard: $path"
            git -C "$real" worktree remove "$real" || die "delete: worktree remove failed: $real"
        else
            git -C "$real" worktree remove --force "$real" || die "delete: worktree remove failed: $real"
        fi
        echo "deleted $real"
        return 0
    fi
    if [ "$discard" = 0 ]; then
        [ -z "$(git -C "$real" status --porcelain 2>/dev/null)" ] || die "delete: the tree is dirty; commit and push, or pass --discard: $path"
        [ -z "$(git -C "$real" log --branches --not --remotes --oneline 2>/dev/null)" ] || die "delete: commits on no remote branch; push, or pass --discard: $path"
    fi
    rm -rf "$real" || die "delete: rm failed: $real"
    echo "deleted $real"
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

case "$cmd" in
    create) cmd_create "$@" ;;
    pin) cmd_pin "$@" ;;
    delete) cmd_delete "$@" ;;
    list) cmd_list "$@" ;;
    *) die "unknown command: $cmd" ;;
esac
