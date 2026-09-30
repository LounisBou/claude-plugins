#!/bin/bash
# rhythm.sh — the net balance of a repository, read from git alone, for an audit.
#
#   rhythm.sh <repo> --since <date> [--product <glob>...] [--instrument <glob>...]
#
# Prints, for the default branch since the date:
#   - merges per week: the branch's first-parent commits, each typed by its conventional-commit
#     type — a merge commit by the pull request title its body carries, any other commit by its
#     subject; a title with no type counts as `other`;
#   - lines added and removed under the --product globs and under the --instrument globs, over
#     the branch's non-merge commits (a merge commit would count its branch a second time);
#     the globs are git's plain pathspecs, where `*` crosses directories.
#
# The default branch is the remote's HEAD when the clone knows it, else `main`, else
# `master`, else the branch checked out. Weeks are ISO weeks of the committer date. A bare
# `--since YYYY-MM-DD` means that day's midnight; a date with a time is passed to git as given.
#
# Why it exists: an audit weighs what the method added against what the product gained, and
# compares that with the previous audit; a comparison needs the same figures computed the
# same way twice (design §52).

set -uo pipefail

die() { echo "rhythm: $*" >&2; exit 1; }
usage="usage: rhythm.sh <repo> --since <date> [--product <glob>...] [--instrument <glob>...] (a bare YYYY-MM-DD means its midnight; a date with a time is passed to git as given)"

repo="${1:-}"
[ -n "$repo" ] || die "$usage"
shift
since=""; product=(); instrument=()
while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || die "$1 needs a value"
    case "$1" in
        --since) since="$2" ;;
        --product) product+=("$2") ;;
        --instrument) instrument+=("$2") ;;
        *) die "unknown argument: $1 ($usage)" ;;
    esac
    shift 2
done
[ -n "$since" ] || die "--since <date> is required"
# A bare date means its midnight. git completes `--since=2026-09-13` with the current time of
# day, and an audit run on the day of its scope read zero merges where there were five.
if [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    since="${since}T00:00:00"
fi
git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository: $repo"

branch=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
if [ -z "$branch" ]; then
    for candidate in main master; do
        if git -C "$repo" rev-parse --verify --quiet "refs/heads/$candidate" >/dev/null; then
            branch=$candidate
            break
        fi
    done
fi
[ -n "$branch" ] || branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD)

TYPES="feat fix chore docs ci build test refactor"

echo "rhythm: $repo on $branch since $since"

echo "merges per week (first-parent commits on $branch, typed by their pull request's title):"
# One record per commit, fields split on control characters: a body runs over several lines
# and a subject may hold any printable character.
git -C "$repo" log "$branch" --first-parent --since="$since" --date=format:%G-W%V \
    --format='%x1e%cd%x1f%P%x1f%s%x1f%b' |
awk -v types="$TYPES" '
BEGIN { RS = "\036"; FS = "\037"; n = split(types, T, " "); print "week " types " other total" }
NF >= 3 {
    week = $1; title = $3
    if (split($2, parents, " ") > 1) {
        lines = split($4, L, "\n")
        for (i = 1; i <= lines; i++) if (L[i] ~ /[^ \t]/) { title = L[i]; break }
    }
    type = "other"
    for (i = 1; i <= n; i++) if (title ~ ("^" T[i] "(\\([^)]*\\))?!?:")) { type = T[i]; break }
    count[week, type]++; total[week]++
    if (!(week in seen)) { seen[week] = 1; weeks[++w] = week }
}
END {
    for (i = 2; i <= w; i++) { v = weeks[i]; j = i - 1; while (j > 0 && weeks[j] > v) { weeks[j + 1] = weeks[j]; j-- } weeks[j + 1] = v }
    for (i = 1; i <= w; i++) {
        row = weeks[i]
        for (k = 1; k <= n; k++) row = row " " (count[weeks[i], T[k]] + 0)
        print row " " (count[weeks[i], "other"] + 0) " " total[weeks[i]]
    }
}'

# lines <label> [<glob>...]: added and removed under the globs, over non-merge commits.
lines() {
    local label="$1"
    shift
    if [ $# -eq 0 ]; then
        echo "$label: no --$label glob given"
        return
    fi
    # Plain pathspecs, not the `:(glob)` magic: under it `*` stops at a slash, and a product
    # written `src/*.ts` counted its directory's top-level files alone — +738 lines on a real
    # repository where git's own reading of the same tree was +40936.
    git -C "$repo" log "$branch" --since="$since" --no-merges --numstat --format= -- "$@" |
        awk -v label="$label" -v globs="$*" \
            '$1 ~ /^[0-9]+$/ { a += $1; d += $2 } END { printf "%s +%d -%d  (%s)\n", label, a, d, globs }'
}
echo "lines since $since (non-merge commits on $branch; globs are git pathspecs, where * crosses directories):"
lines product ${product[@]+"${product[@]}"}
lines instrument ${instrument[@]+"${instrument[@]}"}
