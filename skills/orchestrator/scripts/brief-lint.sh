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
# Check 9 also refuses a duty ordered after the delivery in an implementer brief: the
# phrases that keep a finished agent's tab idle (stand by, stay until merged, clean up
# after the merge).
#
# Check 11 holds an orchestrator succession brief (first line `# Orchestrator succession
# brief`) to 10,000 characters.
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

# The class of a brief is the role it declares at the start of a line. A review brief or a
# memo that QUOTES an implementer brief is not one, and read by the phrase anywhere it was
# held to sections it never carries.
is_class() { grep -q "^You are the $1" "$brief" 2>/dev/null; }

# 5. The implementer-only sections. A review or rotation brief carries neither, and
#    holding it to them would make this check noise nobody reads.
if is_class implementer; then
    [ "$nrefs" != 0 ] || say 1 "no orchestrator address: name the exact ListAgents name and reference"
    grep -q 'STOP and ask' "$brief" 2>/dev/null || say 1 "no STOP-and-ask clause closing the non-goals"
    grep -qi 'non-goals' "$brief" 2>/dev/null || say 1 "no non-goals list"
fi
[ "$nrefs" -le 1 ] || say 1 "more than one session reference ($refs): one address, no example beside it"

# 6. A review brief that never asks for the norms check to be REPORTED leaves the
#    orchestrator with nothing to record, and its readiness gate then refuses a head whose
#    round did read it. The rule lived in prose on both sides of the round and was skipped
#    twice in one day; the line the report must end on is mechanical, so it is read
#    here rather than discovered when the pull request cannot be declared ready.
if is_class 'REVIEW agent'; then
    grep -q 'norms-check:' "$brief" 2>/dev/null \
        || say 1 "no norms-check: report line: the round's report must end on 'norms-check: tool <head>' or 'norms-check: none <head>', which is what the orchestrator records"
fi

# The awk helpers shared by the checks that must not read a forbidding clause as an order.
# Both passes run under LC_ALL=C: under a UTF-8 locale a multibyte character (an em dash, a
# guillemet) before a phrase made the byte-offset arithmetic below blind to it.
AWK_CLAUSES='
    # Is the text before position p, from the start of its clause, forbidding?
    function negated(text, p,   head, q, start) {
        head = substr(text, 1, p - 1)
        start = 0
        for (q = 1; q < length(head); q++)
            if (substr(head, q, 1) ~ /[;.,:]/ && substr(head, q + 1, 1) ~ /[ \t]/) start = q
        head = substr(head, start + 1)
        return head ~ /(^|[^a-z])(never|no|nothing|not|forbidden|forbid|don.t|dont)([^a-z]|$)/
    }
    # Any occurrence of re in text not forbidden in its clause?
    function ordered(text, re,   off, rest) {
        off = 0; rest = text
        while (match(rest, re)) {
            if (!negated(text, off + RSTART)) return 1
            off += RSTART + RLENGTH - 1; rest = substr(rest, RSTART + RLENGTH)
        }
        return 0
    }
'

# 7. An agent that ends its turn waiting for a run loses the work: the single most
#    expensive failure mode observed. A clause that FORBIDS the background reads the
#    opposite way and must raise nothing — "don't", "do not", "never", "no", "not" and
#    "forbid(den)" name it — but only inside the trigger's own clause, before it: "never
#    skip tests; run the suite in the background" is an order. Clauses end on `;`, `.`,
#    `,` or `:` followed by a space, so a file name or a path is not cut in two. A tool
#    parameter set to false (`run_in_background: false`) is the opposite of an order. One
#    awk pass over the file, not a shell loop that forks a handful of processes per line:
#    the per-line version measurably slowed the suite, which lints the same templates
#    dozens of times over.
while IFS=$'\t' read -r bg_n bg_msg; do
    [ -n "${bg_n:-}" ] || continue
    say "$bg_n" "$bg_msg"
done < <(LC_ALL=C awk -v implementer="$(is_class implementer && echo 1 || echo 0)" "$AWK_CLAUSES"'
    BEGIN { infence = 0 }
    {
        line = $0
        lower = tolower(line)
        if (lower ~ /^[[:space:]]*```/) { infence = !infence; next }
        plain = lower
        gsub(/run_in_background`?[ \t]*[:=][ \t]*`?false/, "", plain)
        # The orchestrator arms `ci-watch.sh` in the background, once per pull request; an
        # agent never watches CI, so in an implementer brief the exception does not apply.
        if (!implementer) {
            while (match(plain, /ci-watch\.sh[^;.,]*(in the background|run_in_background)/)) {
                plain = substr(plain, 1, RSTART - 1) " " substr(plain, RSTART + RLENGTH)
            }
            while (match(plain, /(in the background|run_in_background)[^;.,]*ci-watch\.sh/)) {
                plain = substr(plain, 1, RSTART - 1) " " substr(plain, RSTART + RLENGTH)
            }
        }
        trigger = ""
        if (ordered(plain, "in the background")) trigger = "in the background"
        else if (ordered(plain, "run_in_background")) trigger = "run_in_background"
        if (trigger != "") {
            printf "%d\tinstructs a background run (%s): never end a turn waiting for one\n", NR, trigger
        }
        bg = 0
        if (infence && line ~ /[[:space:]]&[[:space:]]*$/ && !negated(lower, length(lower))) bg = 1
        if (ordered(lower, "`[^`]*[[:space:]]&[[:space:]]*`")) bg = 1
        if (bg) {
            printf "%d\ta command line ending in an ampersand: never end a turn waiting for a run\n", NR
        }
    }
' "$brief" 2>/dev/null || true)

# 9. An implementer's duties end at its delivery: the final report, then the stand-down.
#    A brief that orders anything after it (stand by, stay until merged, clean up after the
#    merge) leaves a finished tab idle for hours, and nothing refused those briefs or the
#    orchestrator's stop with those agents idle. Post-merge cleanup is the orchestrator's and
#    the sweep's; a red after delivery goes to a fresh session. A clause that FORBIDS the duty
#    ("never stand by") reads the opposite way and raises nothing, by the same rule as
#    check 7. One finding per phrase and line; the cleanup phrase covers its own "after merge".
#    A phrase quoted (backticks, guillemets) or inside a fence is a mention, not an order.
#    « until merged » is on the list: no agent waits for the merge, nor for the checks that
#    precede it (check 10).
if is_class implementer; then
    while IFS=$'\t' read -r pd_n pd_msg; do
        [ -n "${pd_n:-}" ] || continue
        say "$pd_n" "$pd_msg"
    done < <(LC_ALL=C awk "$AWK_CLAUSES"'
        # The text with every quoted span removed: a phrase in backticks or in guillemets (two
        # bytes each under the C locale) is mentioned, not ordered. An unclosed opener is kept.
        function cut(text, opener, closer,   a, rest, b) {
            while ((a = index(text, opener)) > 0) {
                rest = substr(text, a + length(opener))
                b = index(rest, closer)
                if (b == 0) break
                text = substr(text, 1, a - 1) " " substr(rest, b + length(closer))
            }
            return text
        }
        function unquoted(text) {
            return cut(cut(text, "`", "`"), "\302\253", "\302\273")
        }
        BEGIN {
            infence = 0
            n = 0
            phrase[++n] = "clean(-| )?up[^.;]*after (the )?merge"; name[n] = "cleanup after merge"
            phrase[++n] = "(^|[^a-z])after (the )?merge"; name[n] = "after merge"; plain[n] = 1
            phrase[++n] = "(^|[^a-z])once merged"; name[n] = "once merged"
            phrase[++n] = "(^|[^a-z])stand by([^a-z]|$)"; name[n] = "stand by"
            phrase[++n] = "(^|[^a-z])standing by([^a-z]|$)"; name[n] = "standing by"
            phrase[++n] = "(^|[^a-z])stay until merged"; name[n] = "stay until merged"
            phrase[++n] = "(^|[^a-z])until merged"; name[n] = "until merged"; subsumed[n] = 6
            phrase[++n] = "(^|[^a-z])stay available"; name[n] = "stay available"
        }
        {
            if ($0 ~ /^[[:space:]]*```/) { infence = !infence; next }
            if (infence) next
            lower = unquoted(tolower($0))
            cleanup = 0; told_it = 0
            for (i = 1; i <= n; i++) {
                if (plain[i] && cleanup) continue
                if (subsumed[i] && told_it == subsumed[i]) continue
                if (ordered(lower, phrase[i])) {
                    if (i == 1) cleanup = 1
                    told_it = i
                    printf "%d\tduty after delivery (%s): an implementer is stood down at its final report; post-merge work is the orchestrator'"'"'s and the sweep'"'"'s\n", NR, name[i]
                }
            }
        }
    ' "$brief" 2>/dev/null || true)
fi

# 10. An agent never waits on CI: the orchestrator keeps one background watch per pull
#     request (`ci-watch.sh`) and an agent's delivery ends at the push. An implementer brief
#     that orders a `gh pr checks` with `--watch`, or a `gh pr view` / `gh pr checks` inside a
#     loop around a sleep (on one line, or between a `for`/`while`/`until` and its `done`),
#     rebuilds the polling that took a quarter of an audited orchestration's time. A clause
#     that FORBIDS it reads the opposite way, by the rule of check 7; a mention inside a
#     fence is read like a command, since the loops are written there.
if is_class implementer; then
    while IFS=$'\t' read -r cw_n cw_msg; do
        [ -n "${cw_n:-}" ] || continue
        say "$cw_n" "$cw_msg"
    done < <(LC_ALL=C awk "$AWK_CLAUSES"'
        function loop_start(text) { return text ~ /(^|[;&|][[:space:]]*|^[[:space:]]*)(for|while|until)[[:space:]]/ }
        BEGIN {
            msg = "an agent waits on CI (%s): the orchestrator owns the one watch; the delivery ends at the push"
            depth = 0
        }
        {
            lower = tolower($0)
            if (lower ~ /^[[:space:]]*```/) next
            gh = (lower ~ /gh pr (view|checks)/); sleeps = (lower ~ /(^|[^a-z])sleep[[:space:]]/)
            if (ordered(lower, "gh pr checks[^;|&]*--watch")) {
                printf "%d\t" msg "\n", NR, "gh pr checks --watch"
            }
            if (depth == 0 && loop_start(lower) && gh && sleeps && lower ~ /done[[:space:]]*($|[^a-z])/) {
                if (!negated(lower, index(lower, "gh pr"))) printf "%d\t" msg "\n", NR, "a loop on gh pr view/checks"
                next
            }
            if (loop_start(lower) && lower !~ /done/) {
                if (depth == 0) { loop_n = NR; loop_gh = 0; loop_sleep = 0 }
                depth++
            }
            if (depth > 0) {
                loop_gh = loop_gh || gh; loop_sleep = loop_sleep || sleeps
                if (lower ~ /^[[:space:]]*done([^a-z]|$)/) {
                    depth--
                    if (depth == 0 && loop_gh && loop_sleep) printf "%d\t" msg "\n", loop_n, "a loop on gh pr view/checks"
                }
            }
        }
    ' "$brief" 2>/dev/null || true)
fi

# 8. Every session measures its own context from the gauge script, never an estimate;
#    self-estimates ran 13 points high in observed runs. An implementer, review, comments
#    or rotation brief — every class this lint tells apart by its own role line — must
#    cite it by an absolute path on ANY line: prose naming the tool before or after the
#    line that cites it is no finding. Whether that path exists is check 3's, and a
#    host-expanded variable or an unfilled `{{GAUGE}}` placeholder in its place is ALREADY
#    a finding above; this does not double either.
if is_class implementer || is_class 'REVIEW agent' || is_class 'COMMENTS agent' \
    || is_class 'ROTATION agent'; then
    gauge_line=$(grep -n 'context-gauge\.sh\|{{GAUGE}}' "$brief" 2>/dev/null | head -1)
    if [ -z "$gauge_line" ]; then
        say 1 "no absolute, existing path to context-gauge.sh: an agent brief must cite the plugin's installed copy, which is how context is measured rather than estimated"
    elif ! grep -qE '`/[^`]*context-gauge\.sh`' "$brief" 2>/dev/null \
        && ! grep -E 'context-gauge\.sh|\{\{GAUGE\}\}' "$brief" 2>/dev/null \
            | grep -qE '\{\{GAUGE\}\}|\$\{[A-Z]|\$[A-Z][A-Z0-9_]{2,}'; then
        say "${gauge_line%%:*}" "context-gauge.sh is not cited by an absolute path this machine can open"
    fi
fi

# 11. A succession brief is read whole by a session that has nothing else in its context yet:
#     past 10,000 characters it costs a successor what the live state was meant to save. The
#     class is read from the first line, as the template writes it. Characters, not bytes: the
#     continuation bytes of a multibyte character are dropped before counting.
succession_limit=10000
if head -n 1 "$brief" 2>/dev/null | grep -q '^# Orchestrator succession brief'; then
    chars=$(LC_ALL=C tr -d '\200-\277' < "$brief" | wc -c | tr -d ' ')
    [ "$chars" -le "$succession_limit" ] \
        || say 1 "succession brief is $chars characters, over the limit of $succession_limit: keep Live state to what is live and the rest as pointers"
fi

if [ "$findings" = 0 ]; then
    echo "brief-lint: $brief: 0 findings"
    exit 0
fi
printf 'brief-lint: %s: %s finding(s)\n' "$brief" "$findings" >&2
exit 1
