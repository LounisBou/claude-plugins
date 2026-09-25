#!/bin/bash
# dispatch-record.sh - one row per dispatch, and the signal the routing rule needs.
#
#   dispatch-record.sh open    <record> --class <c> --tier <deep|standard|light> [--label <text>] [--cascade]
#   dispatch-record.sh round   <record> <id>
#   dispatch-record.sh review  <record> <id> --head <sha> --norms tool|none
#   dispatch-record.sh ready   <record> <id> --head <sha>
#   dispatch-record.sh close   <record> <id> --verdict <text>
#   dispatch-record.sh escaped <record> <id>      (a defect got past this row's review)
#   dispatch-record.sh summary <record>
#
# `open` prints the row id. The record is JSON lines: appendable, greppable, and read back
# with the `jq` the rest of this plugin already needs.
#
# Why it exists: the routing rule says a tier drop that costs a second corrective round is
# reverted for its class. Nothing measured that, so the rule could only be applied from
# memory - and an economy nobody measures is one that always looks free, because its cost
# lands rounds later where nobody attributes it. `summary` names the classes where the
# drop did not pay, so the reversion is a reading rather than an impression.
#
# `review` and `ready` carry the second rule the record is asked to hold: a pull request is
# ready only when a review session read ITS head (either side may abbreviate the other, from
# 7 characters) and the project's own norms check ran there.
# That rule was written in the rulebook and in the review brief, and was still broken three
# times in one day - twice by a reader's opinion of the norms file standing in for the tool,
# once by a corrective round the orchestrator verified alone. A rule only prose carries is
# applied from memory, and memory forgets it; `ready` is the refusal prose cannot make.
#
# The record belongs to the PROJECT being built, not to this plugin: the default table
# ships here, a project's corrections belong with that project's state.

set -uo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || die "jq is required"

cmd="${1:-}"; record="${2:-}"
[ -n "$cmd" ] || die "usage: dispatch-record.sh {open|round|review|ready|close|escaped|summary} <record> [...] (see header)"
[ -n "$record" ] || die "$cmd: a record path is required"

next_id() { if [ -f "$record" ]; then jq -s 'if length==0 then 1 else ([.[].id]|max)+1 end' "$record"; else echo 1; fi; }

require_row() {
    [ -f "$record" ] || die "$1: no such record: $record"
    [ "$(jq -s --argjson i "$2" '[.[]|select(.id==$i)]|length' "$record")" = 1 ] \
        || die "$1: no row with id $2 in $record"
}

# Rewriting the whole file keeps ONE row per dispatch: a record appending an event per
# round would make every read a reduction over history, and the history is not the fact.
rewrite() {
    local filter="$1" id="$2"; shift 2
    # Where TMPDIR says: the platform default can be a directory this shell may not
    # write to, and the record then fails on a path it never chose.
    local tmp; tmp=$(mktemp "${TMPDIR:-/tmp}/orchestrator-XXXXXX")
    jq -c "$filter" --argjson i "$id" "$@" "$record" > "$tmp" || { rm -f "$tmp"; die "could not update $record"; }
    mv "$tmp" "$record"
}

case "$cmd" in
open)
    shift 2; class=""; tier=""; label=""; cascade=false
    while [ $# -gt 0 ]; do
        case "$1" in
            --class) class="$2"; shift 2 ;;
            --tier) tier="$2"; shift 2 ;;
            --label) label="$2"; shift 2 ;;
            # A deliberate bet one tier below the table's row. Marking it is what makes the
            # bet payable: unmarked, a cascade that failed is indistinguishable from a row
            # that simply needed two rounds, and nobody can tell an economy from a cost.
            --cascade) cascade=true; shift ;;
            *) die "open: unknown option $1" ;;
        esac
    done
    [ -n "$class" ] || die "open: --class is required"
    case "$tier" in deep|standard|light) ;; *) die "open: unknown tier: $tier (expected deep, standard or light)" ;; esac
    id=$(next_id)
    mkdir -p "$(dirname "$record")"
    jq -nc --argjson id "$id" --arg c "$class" --arg t "$tier" --arg l "$label" \
        --arg o "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson k "$cascade" \
        '{id:$id,opened:$o,class:$c,tier:$t,label:$l,rounds:0,state:"open",verdict:"",cascade:$k}' >> "$record"
    echo "$id"
    ;;
round)
    id="${3:-}"; [ -n "$id" ] || die "round: a row id is required"
    require_row round "$id"
    rewrite 'if .id==$i then .rounds += 1 else . end' "$id"
    ;;
review)
    # A review round, and what it read. It replaces `round` for review rounds rather than
    # adding to it: a round that happened without leaving a head behind is exactly the round
    # this gate exists to refuse. Only the LAST review is kept - the question `ready` asks is
    # about the head in front of it now, and a history of heads answers a different one.
    id="${3:-}"; [ -n "$id" ] || die "review: a row id is required"
    require_row review "$id"
    shift 3; head=""; norms=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --head) head="$2"; shift 2 ;;
            # `tool` or `none`, and nothing else: `none` is a fact about the PROJECT - it
            # ships no norms check - never a round's verdict that reading the file by hand
            # was enough. A third value would be a record nobody can gate on.
            --norms) norms="$2"; shift 2 ;;
            *) die "review: unknown option $1" ;;
        esac
    done
    [ -n "$head" ] || die "review: --head is required"
    case "$norms" in
        tool|none) ;;
        "") die "review: --norms is required (tool when the project's norms check ran, none when it ships none)" ;;
        *) die "review: unknown norms value: $norms (expected tool, or none when the project ships no norms check)" ;;
    esac
    rewrite 'if .id==$i then .rounds += 1 | .review={head:$h,norms:$n,at:$a} else . end' "$id" \
        --arg h "$head" --arg n "$norms" --arg a "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ;;
ready)
    # The gate, and the whole of it: this row's last review read exactly this head (`review`
    # records no review without its norms value). No other condition, no policy: what it
    # cannot see - whether the findings were verified, whether the operator approved - stays
    # the orchestrator's, and a green `ready` is not an approved pull request.
    id="${3:-}"; [ -n "$id" ] || die "ready: a row id is required"
    require_row ready "$id"
    shift 3; head=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --head) head="$2"; shift 2 ;;
            *) die "ready: unknown option $1" ;;
        esac
    done
    [ -n "$head" ] || die "ready: --head is required"
    reviewed=$(jq -sr --argjson i "$id" '[.[]|select(.id==$i)][0].review.head // ""' "$record")
    norms=$(jq -sr --argjson i "$id" '[.[]|select(.id==$i)][0].review.norms // ""' "$record")
    [ -n "$reviewed" ] || die "ready: no review recorded on row $id: dispatch a review round and record it with \`review\`"
    # Either side may abbreviate the other; the shorter one must still identify a commit.
    short=$reviewed; long=$head; [ "${#short}" -le "${#long}" ] || { short=$head; long=$reviewed; }
    [ "${#short}" -ge 7 ] || die "ready: head $short is too short to identify a commit (7 characters at least)"
    case "$long" in
        "$short"*) ;;
        *) die "ready: last review read $reviewed, head is $head: the head in front of you has not been read" ;;
    esac
    echo "ready: row $id reviewed at $head, norms check $norms"
    ;;
close)
    id="${3:-}"; [ -n "$id" ] || die "close: a row id is required"
    require_row close "$id"
    shift 3; verdict=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --verdict) verdict="$2"; shift 2 ;;
            *) die "close: unknown option $1" ;;
        esac
    done
    [ -n "$verdict" ] || die "close: --verdict is required"
    rewrite 'if .id==$i then .state="closed" | .verdict=$v | .closed=$c else . end' "$id" \
        --arg v "$verdict" --arg c "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ;;
escaped)
    # An approval a later round contradicts. It is the only evidence available here of the
    # failure mode the published work warns about: a strong judge keeps false positives low
    # and false negatives moderate to high, so what it MISSES is what costs, and nothing
    # else in this record can see a miss.
    id="${3:-}"; [ -n "$id" ] || die "escaped: a row id is required"
    require_row escaped "$id"
    rewrite 'if .id==$i then .escaped=true else . end' "$id"
    ;;
summary)
    [ -f "$record" ] || { echo "dispatch-record: no record at $record"; exit 0; }
    jq -sr '
      group_by(.class + " " + .tier)
      | map({class: .[0].class, tier: .[0].tier,
             n: length, closed: (map(select(.state=="closed"))|length),
             avg: (if length==0 then 0 else ((map(.rounds)|add) / length) end)})
      | sort_by(.class, .tier)
      | (.[] | "class=\(.class) tier=\(.tier) dispatches=\(.n) closed=\(.closed) rounds_avg=\(.avg*10|round/10)"),
        (.[] | select(.avg > 1) | "signal=\(.class) at \(.tier) averages \(.avg*10|round/10) rounds: the drop did not pay, revert it for this class")
    ' "$record"
    jq -sr '
      map(select(.escaped == true))
      | group_by(.class + " " + .tier)
      | map({class: .[0].class, tier: .[0].tier, n: length})
      | sort_by(.class, .tier)
      | (.[] | "escapes=\(.class) at \(.tier): \(.n) of \(.n) approved rows had a defect found later"),
        (.[] | "signal=double-read \(.class) at \(.tier): an approval missed a defect. Give the next round a SECOND reader with a different lens, and keep a finding only when both see it")
    ' "$record"
    # A cascade pays when it closes in one round: the attempt cost nothing beyond itself.
    # Below half, the retries cost more than the tier they saved, which is the whole test.
    jq -sr '
      map(select(.cascade == true))
      | group_by(.class + " " + .tier)
      | map({class: .[0].class, tier: .[0].tier,
             n: length, paid: (map(select(.rounds == 0))|length)})
      | sort_by(.class, .tier)
      | (.[] | "cascade=\(.class) at \(.tier): \(.paid) of \(.n) paid"),
        (.[] | select(.n >= 2 and .paid * 2 < .n)
             | "signal=stop cascading \(.class) at \(.tier): \(.paid) of \(.n) paid, the retries cost more than the tier saved")
    ' "$record"
    ;;
*) die "unknown subcommand: $cmd (expected open, round, review, ready, close, escaped or summary)" ;;
esac
