#!/bin/bash
# brief-lint.sh — refuse a brief before it is dispatched, not after the round.
#
#   brief-lint.sh <brief-path> [--expect-created <path>]...
#
# --expect-created names a path the brief tells its session to create, so it cannot exist
# yet (an audit's report); the path check accepts exactly that path as absent. Repeatable.
#
# Prints one line per finding and exits 1 when there is any; exits 0 and says so
# otherwise. Every check is mechanical: this reads the file, it does not judge the work.
#
# Why it exists: specification is the largest category of multi-agent failure, and a brief
# is the whole specification act. Two defects reached a live agent before anything read
# the file — a path built from a variable the agent's shell does not set, and a second
# session reference sitting beside the real one, inside the rule whose point is that there
# is exactly one address.
#
# What it CANNOT check: whether the scope is right, whether the contracts are the ones the
# next phase consumes, whether the tier fits the work. Those stay the orchestrator's, and
# a green lint is not an approved brief.

set -uo pipefail

usage="usage: brief-lint.sh <brief-path> [--expect-created <path>]..."
brief=""; expected=()
while [ $# -gt 0 ]; do
    case "$1" in
        --expect-created)
            [ -n "${2:-}" ] || { echo "brief-lint: --expect-created needs a path ($usage)" >&2; exit 1; }
            expected+=("$2")
            shift 2
            ;;
        *)
            [ -z "$brief" ] || { echo "brief-lint: one brief at a time ($usage)" >&2; exit 1; }
            brief="$1"
            shift
            ;;
    esac
done
[ -n "$brief" ] || { echo "$usage" >&2; exit 1; }
[ -f "$brief" ] || { echo "brief-lint: not a file: $brief" >&2; exit 1; }

findings=0
say() { printf '%s:%s: %s\n' "$brief" "$1" "$2"; findings=$((findings + 1)); }

# 1. A placeholder that survived instantiation is a hole the agent reads as literal text.
while IFS=: read -r n text; do
    [ -n "${n:-}" ] || continue
    say "$n" "unfilled placeholder $text"
done < <(grep -noE '\{\{[A-Za-z0-9_]+\}\}' "$brief" 2>/dev/null || true)

# 2. An upper-case variable reference does not expand in the shell of the session that
#    opens this file: it carries none of the environment the writer had. The brief must
#    hold the absolute path the orchestrator resolved while writing it. The check is
#    deliberately wider than the host's own variables — every one of them fails the same
#    way, and naming a list would date the moment the host gains another.
while IFS=: read -r n text; do
    [ -n "${n:-}" ] || continue
    say "$n" "unexpanded variable $text: the agent's shell carries none of your environment; write the resolved value"
done < <(grep -noE '\$\{[A-Z][A-Z0-9_]*[:-]*[^}]*\}|\$[A-Z][A-Z0-9_]{2,}' "$brief" 2>/dev/null || true)

# 3. Every absolute path the brief names must exist on the machine the agent runs on.
#    A prompt the next session cannot open by path does not exist. The one exception is a
#    path the brief tells its session to create — an audit's report — named with
#    --expect-created by the writer, exactly: every other absent path is still a finding.
is_expected() {
    local e
    for e in ${expected[@]+"${expected[@]}"}; do [ "$e" = "$1" ] && return 0; done
    return 1
}
while IFS= read -r line; do
    n=${line%%:*}; p=${line#*:}
    [ -n "${p:-}" ] || continue
    [ -e "$p" ] || is_expected "$p" || say "$n" "path does not exist: $p"
done < <(grep -noE '`/[^`]+`' "$brief" 2>/dev/null | sed 's/`//g' || true)

# 4. Exactly one session reference. Zero leaves the agent to discover its orchestrator,
#    which is a coin toss; two put a decoy beside the real address.
refs=$(grep -oE '\[[0-9a-f]{6}\]' "$brief" 2>/dev/null | sort -u | tr '\n' ' ')
nrefs=$(printf '%s' "$refs" | wc -w | tr -d ' ')

# 5. The implementer-only sections. A review or rotation brief carries neither, and
#    holding it to them would make this check noise nobody reads.
if grep -q 'You are the implementer' "$brief" 2>/dev/null; then
    [ "$nrefs" != 0 ] || say 1 "no orchestrator address: name the exact ListAgents name and reference"
    grep -q 'STOP and ask' "$brief" 2>/dev/null || say 1 "no STOP-and-ask clause closing the non-goals"
    grep -qi 'non-goals' "$brief" 2>/dev/null || say 1 "no non-goals list"
fi
[ "$nrefs" -le 1 ] || say 1 "more than one session reference ($refs): one address, no example beside it"

if [ "$findings" = 0 ]; then
    echo "brief-lint: $brief: 0 findings"
    exit 0
fi
printf 'brief-lint: %s: %s finding(s)\n' "$brief" "$findings" >&2
exit 1
