#!/bin/bash
# rhythm.sh — the rhythm of a repository, read from git alone, for an audit.
#
#   rhythm.sh <repo> --since <date> [--product <glob>...] [--instrument <glob>...] [--register <path>]
#
# Prints, for the default branch since the date:
#   - merges per week: the branch's first-parent commits, each typed by its conventional-commit
#     type — a merge commit by the pull request title its body carries, any other commit by its
#     subject; a title with no type counts as `other`;
#   - feat commits per week: every commit reachable on the branch, merged branches included;
#   - lines added and removed under the --product globs and under the --instrument globs, over
#     the branch's non-merge commits (a merge commit would count its branch a second time);
#   - the open entries of a Markdown register: the rows whose Status cell reads `open`;
#   - and the one reading an audit wants that git does not hold — the latency between the
#     operator's questions and their answers — said, never estimated.
#
# The default branch is the remote's HEAD when the clone knows it, else `main`, else
# `master`, else the branch checked out. Weeks are ISO weeks of the committer date.
#
# Why it exists: an audit compares itself with the previous one, and a comparison needs the
# same figures computed the same way twice. A count typed from a pull request list is a
# number nobody can re-derive (design §52).

set -uo pipefail

die() { echo "rhythm: $*" >&2; exit 1; }
usage="usage: rhythm.sh <repo> --since <date> [--product <glob>...] [--instrument <glob>...] [--register <path>]"

repo="${1:-}"
[ -n "$repo" ] || die "$usage"
shift
since=""; register=""; product=(); instrument=()
while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || die "$1 needs a value"
    case "$1" in
        --since) since="$2" ;;
        --product) product+=("$2") ;;
        --instrument) instrument+=("$2") ;;
        --register) register="$2" ;;
        *) die "unknown argument: $1 ($usage)" ;;
    esac
    shift 2
done
[ -n "$since" ] || die "--since <date> is required"
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

echo "feat commits per week (every commit on $branch, merged branches included):"
git -C "$repo" log "$branch" --since="$since" --date=format:%G-W%V --format='%cd %s' |
    awk '$2 ~ /^feat(\([^)]*\))?!?:/ { c[$1]++ } END { for (w in c) print "feat " w " " c[w] }' | sort

# lines <label> [<glob>...]: added and removed under the globs, over non-merge commits.
lines() {
    local label="$1"
    shift
    if [ $# -eq 0 ]; then
        echo "$label: no --$label glob given"
        return
    fi
    local specs=() glob
    for glob in "$@"; do specs+=(":(glob)$glob"); done
    git -C "$repo" log "$branch" --since="$since" --no-merges --numstat --format= -- "${specs[@]}" |
        awk -v label="$label" -v globs="$*" \
            '$1 ~ /^[0-9]+$/ { a += $1; d += $2 } END { printf "%s +%d -%d  (%s)\n", label, a, d, globs }'
}
echo "lines since $since (non-merge commits on $branch):"
lines product ${product[@]+"${product[@]}"}
lines instrument ${instrument[@]+"${instrument[@]}"}

if [ -n "$register" ]; then
    file="$register"
    [ -f "$file" ] || file="$repo/$register"
    [ -f "$file" ] || die "register not found: $register"
    # The Status column is found by its header, so a Title cell that happens to read `open`
    # is not an open entry; the match is exact, so `reopened` is not one either.
    awk -v name="$register" '
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    /^[ \t]*\|/ {
        n = split($0, c, "|")
        if (col == 0) { for (i = 2; i < n; i++) if (tolower(trim(c[i])) == "status") { col = i; break }; next }
        if (trim(c[2]) ~ /^:?-+:?$/) next
        if (trim(c[col]) == "open") { open++; ids = ids (open > 1 ? ", " : "") trim(c[2]) }
    }
    END {
        if (col == 0) { print "register " name ": no Status column"; exit }
        printf "register %s: %d open%s\n", name, open, (open ? " (" ids ")" : "")
    }' "$file"
fi

echo "operator question latency: not measurable from git"
