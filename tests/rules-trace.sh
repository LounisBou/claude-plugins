#!/bin/bash
# rules-trace.sh — prove that no rule of the inventory vanished silently.
#
#   rules-trace.sh sources <inventory> [--ref <git-ref>]
#   rules-trace.sh targets <inventory>
#
# sources: every 'path:line' of every row exists at <ref> (default HEAD): a regular file at
#          that commit, a single line number (no range) within its length.
# targets: every row whose fate is keep, merge-> or move-> has its signature found by a
#          fixed-string search in its target, in the working tree, exactly once. Rows
#          awaiting a ruling (drop?, contradiction?, script-candidate?) and rows whose drop
#          was ruled (drop) are skipped. Each
#          merge-> names an existing row other than itself, and that row is not a merge
#          itself: a merged rule points at its final anchor.
#
# Both modes read the same rows and refuse the same malformed ones: a table line of an
# inventory table (one whose header cell is 'id') that is not an id-shaped row at the start
# of its line, a row that does not split into nine cells, a fate outside the seven shapes.
#
# Paths are relative to the root of the repository the command runs in. Prints one line
# per failing row, '<id> <reason> <target>', then 'ok=<n> missing=<n> skipped=<n>'.
# Exits 0 when missing=0, 1 otherwise, 2 on a usage error or an unreadable inventory, or an
# inventory with no row at all.
#
# Why it exists: the directives are rewritten phase after phase, and a rule deleted in a
# rewrite leaves no trace a reviewer can see. The inventory names each rule with a literal
# excerpt of its target; this makes "every rule is still somewhere" a command, not a claim.
# The excerpt must be unique in its target and at least six words long (a word carries a
# letter or a digit), and must not be a whole bold lead-in or a heading line, or a generic
# phrase would keep matching elsewhere after the rule itself is gone.

set -uo pipefail

usage="usage: rules-trace.sh sources <inventory> [--ref <git-ref>] | rules-trace.sh targets <inventory>"
fail_usage() { echo "rules-trace: $1 ($usage)" >&2; exit 2; }

mode="${1:-}"
inventory="${2:-}"
ref="HEAD"
case "$mode" in
    sources|targets) ;;
    *) fail_usage "unknown or missing mode" ;;
esac
[ -n "$inventory" ] || fail_usage "missing inventory"
shift 2
while [ $# -gt 0 ]; do
    case "$1" in
        --ref)
            [ "$mode" = sources ] || fail_usage "--ref applies to sources only"
            [ -n "${2:-}" ] || fail_usage "--ref needs a value"
            ref="$2"
            shift 2
            ;;
        *) fail_usage "unexpected argument: $1" ;;
    esac
done
[ -f "$inventory" ] && [ -r "$inventory" ] || { echo "rules-trace: cannot read inventory: $inventory" >&2; exit 2; }

root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
if [ "$mode" = sources ]; then
    git -C "$root" rev-parse --verify -q "$ref^{commit}" >/dev/null \
        || { echo "rules-trace: unknown git ref: $ref" >&2; exit 2; }
fi

# One record per row of an inventory table, fields joined by a separator that is no
# whitespace (an empty cell must stay a field): id, sources, fate, target, signature, the
# row's cell count, and 'bad' when the id is not an id at the start of its line. An
# inventory table is a run of table lines whose first line, the header, opens with 'id';
# the legend tables of the file are not. A separator line is no row. An escaped '\|' is
# folded to a placeholder before splitting, so it never opens a new cell.
SEP=$'\035'
rows() {
    awk -v sep="$SEP" '
        /^[ \t]*\|/ {
            line = $0
            gsub(/\\\|/, "\037", line)
            n = split(line, cell, "|")
            for (i = 1; i <= n; i++) {
                gsub(/^[ \t]+|[ \t]+$/, "", cell[i])
                gsub("\037", "|", cell[i])
            }
            if (!intable) { intable = 1; inv = (cell[2] == "id"); next }
            if (!inv || cell[2] ~ /^:?-+:?$/) next
            id = cell[2]
            gsub(/[ \t]+/, "_", id)
            if (id == "") id = "-"
            shape = ($0 ~ /^\|/ && cell[2] ~ /^[A-Z][A-Z0-9-]*-[0-9][0-9][0-9]$/) ? "ok" : "bad"
            # A well-formed row splits into nine cells between an empty first and last.
            printf "%s%s%s%s%s%s%s%s%s%s%d%s%s\n", id, sep, cell[4], sep, cell[8], sep, cell[9], sep, cell[10], sep, n - 2, sep, shape
            next
        }
        { intable = 0 }
    ' "$inventory"
}

# The same records with the reason the row fails as a member of the whole inventory, or
# nothing: a repeated id, a merge onto itself, onto no row, onto a merge row.
annotate() {
    awk -F"$SEP" -v OFS="$SEP" '
        { rec[NR] = $0; if ($7 == "ok" && $6 == 9 && !($1 in fate)) fate[$1] = $3 }
        END {
            for (r = 1; r <= NR; r++) {
                split(rec[r], f, FS)
                why = ""
                if (f[7] == "ok" && f[6] == 9) {
                    if (seen[f[1]]++) why = "duplicate-id"
                    else if (f[3] ~ /^merge->[A-Z][A-Z0-9-]*-[0-9][0-9][0-9]$/) {
                        to = substr(f[3], 8)
                        if (to == f[1]) why = "self-merge"
                        else if (!(to in fate)) why = "unknown-merge:" to
                        else if (fate[to] ~ /^merge->/) why = "merge-chain:" to
                    }
                }
                print rec[r], why
            }
        }
    '
}

ok=0; missing=0; skipped=0
report() { printf '%s %s %s\n' "$1" "$2" "$3"; missing=$((missing + 1)); }

# Line count of <path> at <ref>, or nothing when it is not a regular file there (absent, or
# a directory). awk counts a last line that carries no newline, which 'wc -l' would not.
lines_at() {
    [ "$(git -C "$root" cat-file -t "$ref:$1" 2>/dev/null)" = blob ] || return 1
    git -C "$root" show "$ref:$1" | awk 'END { print NR }'
}

# Number of words of a signature: the whitespace-separated tokens that carry a letter or a
# digit. A lone dash or a bullet is punctuation, and padding a signature with it would pass
# a phrase of five words for one of six.
word_count() {
    local w n=0 words
    read -ra words <<< "$1"
    for w in ${words[@]+"${words[@]}"}; do
        [[ "$w" == *[[:alnum:]]* ]] && n=$((n + 1))
    done
    echo "$n"
}

# A signature that is one whole bold span (the lead-in of a paragraph) or a heading line is
# a label, not a rule's own sentence: the target keeps it through any rewrite of the rule.
heading_re='^#{1,6}[[:space:]]'
is_weak() {
    local inner
    if [[ "$1" == '**'*'**' ]]; then
        inner="${1#\*\*}"; inner="${inner%\*\*}"
        [[ "$inner" == *'**'* ]] || return 0
    fi
    [[ "$1" =~ $heading_re ]]
}

data=$(rows | annotate)
[ -n "$data" ] || { echo "rules-trace: no row in inventory: $inventory" >&2; exit 2; }

# The fate is one of seven shapes: 'merge->' takes a row id, 'move->' a path, a trailing '?'
# marks a proposal, and only three of those exist; 'drop' is a removal the operator ruled,
# skipped like a proposal since its text is gone or about to go. Anything else, a stray '?'
# included, is a typo that would silently skip or silently pass its row.
fate_kind() {
    case "$1" in
        keep) echo keep ;;
        drop|drop\?|contradiction\?|script-candidate\?) echo proposal ;;
        merge-\>*) [[ "$1" =~ ^merge-\>[A-Z][A-Z0-9-]*-[0-9][0-9][0-9]$ ]] && echo merge ;;
        move-\>*\?) ;;
        move-\>?*) echo move ;;
    esac
    return 0
}

while IFS="$SEP" read -r id sources fate target signature cells shape why; do
    if [ "$shape" != ok ]; then
        report "$id" "malformed-id" "${target:--}"
        continue
    fi
    if [ "$cells" != 9 ]; then
        report "$id" "malformed-row:$cells-cells" "${target:--}"
        continue
    fi
    kind=$(fate_kind "$fate")
    if [ -z "$kind" ]; then
        report "$id" "unknown-fate:$fate" "${target:--}"
        continue
    fi

    if [ "$mode" = sources ]; then
        bad=""
        [ -n "$sources" ] || bad="no-sources"
        IFS=',' read -ra refs <<< "$sources"
        for s in ${refs[@]+"${refs[@]}"}; do
            s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"
            [ -n "$s" ] || continue
            path="${s%:*}"; line="${s##*:}"
            if [ "$path" = "$s" ] || ! [[ "$line" =~ ^[1-9][0-9]*$ ]]; then
                bad="${bad:+$bad,}bad-source:$s"
            elif ! len=$(lines_at "$path"); then
                bad="${bad:+$bad,}no-file:$s"
            elif [ "$line" -gt "$len" ]; then
                bad="${bad:+$bad,}past-end:$s"
            fi
        done
        if [ -n "$bad" ]; then report "$id" "$bad" "$target"; else ok=$((ok + 1)); fi
        continue
    fi

    if [ -n "$why" ]; then
        report "$id" "$why" "${target:--}"
        continue
    fi
    if [ "$kind" = proposal ]; then
        skipped=$((skipped + 1))
        continue
    fi
    if [ -z "$target" ] || [ ! -f "$root/$target" ]; then
        report "$id" "no-target" "${target:--}"
        continue
    fi
    if [ "$(word_count "$signature")" -lt 6 ]; then
        report "$id" "short-signature" "$target"
        continue
    fi
    if is_weak "$signature"; then
        report "$id" "weak-signature" "$target"
        continue
    fi
    # Occurrences, not matching lines: the same excerpt twice on one line is not unique.
    count=$(grep -oF -e "$signature" "$root/$target" | wc -l | tr -d ' ')
    case "$count" in
        1) ok=$((ok + 1)) ;;
        0) report "$id" "absent" "$target" ;;
        *) report "$id" "not-unique:$count" "$target" ;;
    esac
done <<< "$data"

echo "ok=$ok missing=$missing skipped=$skipped"
[ "$missing" -eq 0 ]
