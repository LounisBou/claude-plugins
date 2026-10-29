#!/bin/bash
# dispatch-record.sh - one row per dispatch, and the signal the routing rule needs.
#
#   dispatch-record.sh open    <record> --class <c> (--tier <deep|standard|light> | --model <alias> [--effort <level>]) [--label <text>] [--cascade] [--explore]
#   dispatch-record.sh round   <record> <id>
#   dispatch-record.sh review  <record> <id> --head <sha> --norms tool|none
#   dispatch-record.sh fixed   <record> <id> --head <sha>   (the one correction round, verified)
#   dispatch-record.sh surface <record> <id> (--ui <owner/repo>#<n> | --minor <reason> | --none)
#   dispatch-record.sh audit   <record> <id> --head <sha> --images <n> [--defect "<text>"]...
#   dispatch-record.sh ready   <record> <id> --head <sha> --e2e "<the E2E line>" [--e2e-waiver "<his words, dated>"]
#   dispatch-record.sh exempt  <record> --e2e "<his words, dated>"   (the operator exempts this session's pull requests from E2E)
#   dispatch-record.sh close   <record> <id> --verdict <text>
#   dispatch-record.sh escaped <record> <id>      (a defect got past this row's review)
#   dispatch-record.sh cost    <record> <id> --session <session id> [--recount]   (adds that session's measured cost)
#   dispatch-record.sh summary <record> [--open]
#   dispatch-record.sh goals   <record> init --spec <path>|none [--aim "<text>"] [--goal "<text>"]... [--replace]
#   dispatch-record.sh goals   <record> status | plan <G> --phase "<text>" | met <G> --evidence "<token>"...
#   dispatch-record.sh goals   <record> rule-out <G> --ruling "<his words>" | reopen <G> | check [--json]
#
# `open` prints the row id. `summary --open` prints only the open rows, for a takeover that
# has no use for the statistics. The record is JSON lines: appendable, greppable, and read back
# with the `jq` the rest of this plugin already needs.
#
# Why it exists: the routing rule says a tier drop that costs a second corrective round is
# reverted for its class. Nothing measured that, so the rule could only be applied from
# memory - and an economy nobody measures is one that always looks free, because its cost
# lands rounds later where nobody attributes it. `summary` names the classes where the
# drop did not pay, so the reversion is a reading rather than an impression.
#
# A green `ready` (head read, or corrected and verified) also prints one line naming the
# command that puts the `Ready` label, `pr-readiness <n> ready on <owner/repo>`, the pull
# request read from a `--ui` row; the orchestrator runs it with the github tool. This script
# never calls the network.
#
# `review` and `ready` carry the second rule the record is asked to hold: a pull request is
# ready only when a review session read ITS head (either side may abbreviate the other, from
# 7 characters) and the project's own norms check ran there - or when the head is the one
# correction round that review produced, which the orchestrator verified on the artifact.
# That rule was written in the rulebook and in the review brief, and was still broken twice
# in one day by a reader's opinion of the norms file standing in for the tool. A rule only
# prose carries is applied from memory, and memory forgets it; a project's own method is
# free to make `ready` refuse what this default only warns about.
#
# `fixed` and `ready` no longer die on a missing review, and `fixed` no longer dies on a
# second correction round: each records what it was given, prints a warning naming what is
# missing, and exits 0. Only this repository's own two locks - the push guard and the
# title-verified close - stay refusals a project's method cannot lift; this is not one of
# them.
#
# `surface` and `ready` carry a third: a pull request that changes what a user sees carries
# screenshots of it. The rule was in the rulebook, the phase brief and the review brief, and
# five front-office pull requests were still declared ready without one image - two
# « skipped, no data on the reference account », three never shot at all. So the row says,
# once, whether its pull request changes a frontend surface (`--ui`, naming the pull
# request), makes a change the orchestrator ruled minor (`--minor`, with the reason the
# operator will read), or changes none (`--none`); `ready` refuses a row that says nothing,
# and on a `--ui` row reads the pull request's description and refuses it when no image is
# there. The surface lives beside the review, not in it: a new review round must not erase
# it. This is a default refusal, unlike the two warnings above; a project with no frontend
# says `--none` on its rows.
#
# `audit` and `ready` carry a fourth: an image is looked at, not only counted. On one day three
# captures showing a defect - an off-centre icon in a control unlike its neighbours, a button
# pushed onto its own row past the edge of the controls above, an « after » image with stray
# text left in a search field - were each read by an orchestrator and passed, because every
# check asked only whether the images were there and showed the surface. So the orchestrator
# records its own audit of the images at a head: how many it opened (`--images`) and each
# defect it saw (`--defect`, once per defect; none means every image is clean). A new audit
# replaces the previous one, and a review round does not erase it. On a `--ui` row, `ready`
# refuses when no audit is recorded at the head in front of it or at the reviewed or fixed
# head the rules above accept, when the audit opened fewer images than the description
# carries, and when it recorded any defect: the defect is fixed, the capture retaken, and the
# images audited again. `--minor` and `--none` rows are not held to it. Whether the audit was
# honest stays the orchestrator's; the record makes it a step nobody can skip by forgetting.
#
# `ready` carries a fifth: a pull request says how it was proved end to end. A frontend pull
# request was once merged and deployed and did not work there; its only proof was a browser
# pass the implementer reported, nothing a reviewer could replay, and neither the report nor
# the « ready » said there was no E2E test. So `ready` takes the implementer's E2E line
# (`--e2e`), never the pull request's description, which holds its codified sections and
# nothing about E2E. A line that does not start with `E2E:` is refused: silence is not ready.
# `E2E: <test path(s)> — <command> — passed` passes. `E2E: none — <reason>` passes only with
# the operator's validation of that pull request ready without one (`--e2e-waiver`, his words
# and their date), or with his exemption of every pull request of this session, recorded once
# beside the record by `exempt`; then the orchestrator decides alone. Whether the reason holds
# is the review's and his, not the script's. The line is recorded on the row and printed for
# the operator.
#
# A pair row names the model alias and the effort it ran on, and `cost` adds each session's
# measured cost to it - the corrective rounds of a dispatch are part of what it cost. A
# session whose model has no price marks the row `cost_incomplete`, and the summary's
# `cost_avg` leaves it out rather than rank a pair on part of its cost. `--explore` marks a
# dispatch one notch below its class's pair: one that costs a corrective round, or lets a
# defect escape, freezes the class (`frozen=`); three that close in one round promote the
# lower pair (`promote=`). Rows written before pairs existed read as tier rows, unchanged.
#
# The record belongs to the PROJECT being built, not to this plugin: the default table
# ships here, a project's corrections belong with that project's state.
#
# Every subcommand also registers the record's absolute path under the host session that ran
# it, in `<state dir>/records/<CLAUDE_CODE_SESSION_ID>` (one path per line, no duplicate). An
# order noted « to plan after the round » in prose alone was lost once: nothing read it back.
# A row opened for it is read back by the stop gate (the module's own gate, over the Stop
# event), which refuses `waiting: done` while a registered row is open, and by `summary`,
# which lists the open rows. Registering never fails a command.
#
# `goals` keeps the spec's goals of the build in `goals.md`, beside the record (the grammar
# and the reasons are `goals.py`'s header). A build was once declared done against its plan
# while its plan had moved three of the spec's five goals « after the build », and no row was
# ever opened for them. So `open` refuses while no `goals.md` sits beside the record (a build
# with no spec says `goals <record> init --spec none`), warns on every open goal no phase
# carries, and the stop gate refuses `waiting: done` while a goal is open, lacks evidence, or
# was ruled out without the operator's words. `goals` registers the record even before its
# first row, so the gate finds the goals from the first command.

set -uo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
warn() { echo "WARNING: $*" >&2; }
command -v jq >/dev/null 2>&1 || die "jq is required"

cmd="${1:-}"; record="${2:-}"
[ -n "$cmd" ] || die "usage: dispatch-record.sh {open|round|review|fixed|surface|audit|ready|exempt|close|escaped|cost|summary|goals} <record> [...] (see header)"
[ -n "$record" ] || die "$cmd: a record path is required"

# The stop gate's state root — the one the module's gate (hooks/guards.ts over
# hooks/stop-gate.ts) resolves too — is shared here: the override first, else the config
# dir's claude-orchestrator, so the registry the gate reads and this script writes agree.
STATE_DIR="${ORCHESTRATOR_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-orchestrator}"
# What a session cost is measured by the routing skill's script, which reads the same state
# directory from the same environment.
ROUTING="$(cd "$(dirname "$0")/../../model-routing/scripts" && pwd)/routing.py"
EFFORTS="low medium high xhigh max"
GOALS_PY="$(cd "$(dirname "$0")" && pwd)/goals.py"
GOALS_FILE="$(dirname "$record")/goals.md"
E2E_EXEMPT_FILE="$record.e2e-exempt"
# A waiver or an exemption is the operator's words with their date, or it is nobody's.
DATED_RE='[0-9]{4}-[0-9]{2}-[0-9]{2}'
# `goals` registers a record that has no row yet: its goals are written before the first open.
REGISTER_ABSENT=0

# Run on exit, so a record `open` has just created is registered with its directory in place.
# Its status is the command's own: nothing here may change it.
register_record() {
    [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] || return 0
    [ -f "$record" ] || { [ "$REGISTER_ABSENT" = 1 ] && [ -d "$(dirname "$record")" ]; } || return 0
    local dir abs list
    dir=$(cd "$(dirname "$record")" 2>/dev/null && pwd -P) || return 0
    abs="$dir/$(basename "$record")"
    list="$STATE_DIR/records/${CLAUDE_CODE_SESSION_ID//[^A-Za-z0-9._-]/_}"
    mkdir -p "$STATE_DIR/records" 2>/dev/null || return 0
    grep -qxF "$abs" "$list" 2>/dev/null || printf '%s\n' "$abs" >> "$list" 2>/dev/null
    return 0
}
trap register_record EXIT

next_id() { if [ -f "$record" ]; then jq -s 'if length==0 then 1 else ([.[].id]|max)+1 end' "$record"; else echo 1; fi; }

require_row() {
    [ -f "$record" ] || die "$1: no such record: $record"
    [ "$(jq -s --argjson i "$2" '[.[]|select(.id==$i)]|length' "$record")" = 1 ] \
        || die "$1: no row with id $2 in $record"
}

# head_option <cmd> <args...>: the value of the one `--head` option these subcommands take.
head_option() {
    local sub="$1" head=""; shift
    while [ $# -gt 0 ]; do
        case "$1" in
            --head) head="$2"; shift 2 ;;
            *) die "$sub: unknown option $1" ;;
        esac
    done
    [ -n "$head" ] || die "$sub: --head is required"
    echo "$head"
}

# same_commit <recorded> <head>: either side may abbreviate the other; the shorter one must
# still identify a commit.
same_commit() {
    local short=$1 long=$2
    [ "${#short}" -le "${#long}" ] || { short=$2; long=$1; }
    [ "${#short}" -ge 7 ] || die "ready: head $short is too short to identify a commit (7 characters at least)"
    case "$long" in "$short"*) return 0 ;; *) return 1 ;; esac
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
    shift 2; class=""; tier=""; model=""; effort=""; label=""; cascade=false; explore=false
    while [ $# -gt 0 ]; do
        case "$1" in
            --class) class="$2"; shift 2 ;;
            --tier) tier="$2"; shift 2 ;;
            --model) model="$2"; shift 2 ;;
            --effort) effort="$2"; shift 2 ;;
            --label) label="$2"; shift 2 ;;
            # A deliberate bet one tier below the table's row. Marking it is what makes the
            # bet payable: unmarked, a cascade that failed is indistinguishable from a row
            # that simply needed two rounds, and nobody can tell an economy from a cost.
            --cascade) cascade=true; shift ;;
            # One notch below the class's pair, for one dispatch. Marked for the same
            # reason as a cascade: the summary freezes or promotes it from its own row.
            --explore) explore=true; shift ;;
            *) die "open: unknown option $1" ;;
        esac
    done
    [ -n "$class" ] || die "open: --class is required"
    [ -n "$tier" ] || [ -n "$model" ] || die "open: --tier or --model is required"
    [ -z "$tier" ] || case "$tier" in deep|standard|light) ;; *) die "open: unknown tier: $tier (expected deep, standard or light)" ;; esac
    [ -z "$effort" ] || case " $EFFORTS " in *" $effort "*) ;; *) die "open: unknown effort: $effort (expected low, medium, high, xhigh or max)" ;; esac
    [ -z "$effort" ] || [ -n "$model" ] || die "open: --effort needs --model"
    [ "$explore" = false ] || [ -n "$model" ] || die "open: --explore needs --model"
    # The spec's goals are written before the first dispatch, or done is measured against
    # the plan alone.
    [ -f "$GOALS_FILE" ] || die "open: no goals.md beside $record: write the spec's goals first, dispatch-record.sh goals $record init --spec <path>|none"
    unplanned=0
    while IFS= read -r g; do
        [ -n "$g" ] || continue
        warn "$g is in no phase and not ruled out: plan it or put it to the operator"
        unplanned=1
    done < <(python3 "$GOALS_PY" unplanned "$GOALS_FILE" 2>/dev/null)
    [ "$unplanned" = 0 ] || warn "$(python3 "$GOALS_PY" line "$GOALS_FILE" 2>/dev/null)"
    id=$(next_id)
    mkdir -p "$(dirname "$record")"
    jq -nc --argjson id "$id" --arg c "$class" --arg t "$tier" --arg l "$label" \
        --arg m "$model" --arg e "$effort" \
        --arg o "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson k "$cascade" --argjson x "$explore" \
        '{id:$id,opened:$o,class:$c,tier:$t,label:$l,rounds:0,state:"open",verdict:"",cascade:$k}
         + (if $m != "" then {model:$m,effort:$e,explore:$x,cost_usd:0,sessions:[],cost_incomplete:false} else {} end)' >> "$record"
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
fixed)
    # The correction round a review produced, verified by the orchestrator on the artifact
    # (the diff, the decisive tests). It lives inside the review it answers: a
    # correction belongs to the findings that ordered it. It counts as a round - the routing
    # signal reads what a dispatch cost. A row with no review recorded, or one already
    # carrying a correction round, is recorded anyway - a project's own method may still
    # forbid either; this default only warns, naming what is missing or what it overwrites.
    id="${3:-}"; [ -n "$id" ] || die "fixed: a row id is required"
    require_row fixed "$id"
    shift 3; head=$(head_option fixed "$@") || exit 1
    reviewed=$(jq -sr --argjson i "$id" '[.[]|select(.id==$i)][0].review.head // ""' "$record")
    [ -n "$reviewed" ] || warn "fixed: row $id has no review recorded: the correction round should answer a review round, recording it anyway"
    previous=$(jq -sr --argjson i "$id" '[.[]|select(.id==$i)][0].review.fixed.head // ""' "$record")
    [ -z "$previous" ] || warn "fixed: row $id already has its correction round at $previous: recording a second one anyway"
    rewrite 'if .id==$i then .rounds += 1 | .review.fixed={head:$h,at:$a} else . end' "$id" \
        --arg h "$head" --arg a "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ;;
surface)
    # Whether the row's pull request changes what a user sees. Recorded once, read by
    # `ready`; recording it again replaces it.
    id="${3:-}"; [ -n "$id" ] || die "surface: a row id is required"
    require_row surface "$id"
    shift 3; kind=""; pr=""; reason=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --ui) [ -z "$kind" ] || die "surface: give one of --ui, --minor or --none"; kind=ui; pr="${2:-}"; shift 2 ;;
            --minor) [ -z "$kind" ] || die "surface: give one of --ui, --minor or --none"; kind=minor; reason="${2:-}"; shift 2 ;;
            --none) [ -z "$kind" ] || die "surface: give one of --ui, --minor or --none"; kind=none; shift ;;
            *) die "surface: unknown option $1" ;;
        esac
    done
    [ -n "$kind" ] || die "surface: give one of --ui <owner/repo>#<n>, --minor <reason> or --none"
    if [ "$kind" = ui ]; then
        [[ "$pr" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[0-9]+$ ]] \
            || die "surface: --ui takes the pull request as <owner/repo>#<number>, got: ${pr:-nothing}"
    fi
    [ "$kind" != minor ] || [ -n "$reason" ] || die "surface: --minor needs the reason the operator will read"
    rewrite 'if .id==$i then .surface={kind:$k,pr:$p,reason:$r,at:$a} else . end' "$id" \
        --arg k "$kind" --arg p "$pr" --arg r "$reason" --arg a "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ;;
audit)
    # The orchestrator's own audit of the images on the row's pull request, at a head: how many
    # images it opened and each defect it saw. Read by `ready` on a `--ui` row; recording it
    # again replaces it whole, defects included.
    id="${3:-}"; [ -n "$id" ] || die "audit: a row id is required"
    require_row audit "$id"
    shift 3; head=""; images=""; defects='[]'
    while [ $# -gt 0 ]; do
        case "$1" in
            --head) head="${2:-}"; shift 2 ;;
            --images) images="${2:-}"; shift 2 ;;
            --defect)
                [ -n "${2:-}" ] || die "audit: --defect needs the defect, as the operator will read it"
                defects=$(jq -c --arg d "$2" '. + [$d]' <<<"$defects"); shift 2 ;;
            *) die "audit: unknown option $1" ;;
        esac
    done
    [ -n "$head" ] || die "audit: --head is required"
    [ "${#head}" -ge 7 ] || die "audit: head $head is too short to identify a commit (7 characters at least)"
    [[ "$images" =~ ^[1-9][0-9]*$ ]] || die "audit: --images takes the number of images you opened and audited, got: ${images:-nothing}"
    rewrite 'if .id==$i then .audit={head:$h,images:($n|tonumber),defects:$d,at:$a} else . end' "$id" \
        --arg h "$head" --arg n "$images" --argjson d "$defects" --arg a "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ;;
ready)
    # This row's last review read exactly this head (`review` records no review without
    # its norms value), or this head is the correction round that review produced
    # (`fixed`). What it cannot see - whether the findings were triaged, whether the
    # correction was verified, whether the operator approved - stays the orchestrator's,
    # and a green `ready` is not an approved pull request. A row with no review recorded
    # no longer stops it either: it warns, prints its reading of the row, and exits 0 - a
    # project's own method may still make this one refuse.
    id="${3:-}"; [ -n "$id" ] || die "ready: a row id is required"
    require_row ready "$id"
    shift 3; head=""; e2e=""; e2e_given=0; waiver=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --head) head="${2:-}"; shift 2 ;;
            --e2e) e2e="${2:-}"; e2e_given=1; shift 2 ;;
            --e2e-waiver) waiver="${2:-}"; shift 2 ;;
            *) die "ready: unknown option $1" ;;
        esac
    done
    [ -n "$head" ] || die "ready: --head is required"
    # The surface first, before any reading of the heads: a pull request with no screenshot
    # is not ready whatever was reviewed, and the no-review warning below must not let it by.
    kind=$(jq -sr --argjson i "$id" '[.[]|select(.id==$i)][0].surface.kind // ""' "$record")
    case "$kind" in
        "") die "ready: row $id does not say whether its pull request changes a frontend surface: record it with \`surface\` (--ui <owner/repo>#<n>, --minor <reason> or --none)" ;;
        ui)
            pr=$(jq -sr --argjson i "$id" '[.[]|select(.id==$i)][0].surface.pr' "$record")
            body=$(gh pr view "${pr##*#}" -R "${pr%#*}" --json body -q .body 2>/dev/null) \
                || die "ready: could not read the description of $pr: its screenshots are unverified, not ready"
            # A markdown image or an HTML one, which is what an uploaded attachment becomes.
            shots=$(printf '%s\n' "$body" | grep -oiE '!\[[^]]*\]\([^)]+\)|<img[[:space:]]' | wc -l | tr -d ' ')
            [ "$shots" -gt 0 ] || die "ready: $pr changes a frontend surface and its description carries no screenshot: not ready"
            # Counted is not looked at: the orchestrator's own audit of every image, at a head
            # the rules below accept, with no defect seen.
            audit=$(jq -sc --argjson i "$id" '[.[]|select(.id==$i)][0].audit // empty' "$record")
            [ -n "$audit" ] || die "ready: no audit of the images on $pr is recorded: open each one, audit it, and record it with \`audit <record> $id --head <sha> --images <n>\`: not ready"
            a_head=$(jq -r .head <<<"$audit"); a_images=$(jq -r .images <<<"$audit")
            a_ok=0
            for h in "$head" \
                "$(jq -sr --argjson i "$id" '[.[]|select(.id==$i)][0].review.head // ""' "$record")" \
                "$(jq -sr --argjson i "$id" '[.[]|select(.id==$i)][0].review.fixed.head // ""' "$record")"; do
                [ -n "$h" ] || continue
                if same_commit "$a_head" "$h"; then a_ok=1; break; fi
            done
            [ "$a_ok" = 1 ] || die "ready: the images on $pr were audited at $a_head, head is $head: audit them again at the head in front of you"
            [ "$a_images" -ge "$shots" ] || die "ready: the audit opened $a_images image(s), the description of $pr carries $shots: audit every image"
            n_defects=$(jq -r '.defects | length' <<<"$audit")
            [ "$n_defects" = 0 ] || die "ready: the audit of $pr recorded $n_defects defect(s): $(jq -r '.defects | join("; ")' <<<"$audit"). Fix each one, retake the capture, and audit again: not ready"
            surface_line="$shots screenshot(s) on $pr, audited clean at $a_head" ;;
        minor) surface_line="frontend change ruled minor: $(jq -sr --argjson i "$id" '[.[]|select(.id==$i)][0].surface.reason' "$record") - tell the operator this reason with the ready" ;;
        none) surface_line="no frontend surface" ;;
    esac
    # The E2E line, on every row, after the surface and before the heads, so that neither the
    # no-review warning nor a reviewed head lets a pull request through on silence.
    E2E_SHAPE="\`--e2e \"E2E: <test path(s)> — <command> — passed\"\` or \`--e2e \"E2E: none — <reason>\"\`"
    [ "$e2e_given" = 1 ] || die "ready: row $id gives no E2E line: pass the implementer's report line, $E2E_SHAPE; silence is not ready"
    [[ "$e2e" =~ ^E2E:[[:space:]]*[^[:space:]] ]] || die "ready: the E2E line must start with \`E2E:\` and say something, got: ${e2e:-nothing}; $E2E_SHAPE"
    e2e_kind=test; exempt_words=""
    shopt -s nocasematch
    if [[ "$e2e" =~ ^E2E:[[:space:]]*none([^[:alnum:]]|$) ]]; then
        e2e_kind=none
        [[ "$e2e" =~ ^E2E:[[:space:]]*none[[:space:]]*[—–:-][[:space:]]*[^[:space:]] ]] \
            || { shopt -u nocasematch; die "ready: \`E2E: none\` needs its reason: \`E2E: none — <reason>\`"; }
    fi
    shopt -u nocasematch
    if [ "$e2e_kind" = none ]; then
        [ ! -f "$E2E_EXEMPT_FILE" ] || exempt_words=$(jq -r '.words // ""' "$E2E_EXEMPT_FILE" 2>/dev/null)
        if [ -n "$waiver" ]; then
            [[ "$waiver" =~ $DATED_RE ]] || die "ready: --e2e-waiver takes the operator's words with their date (YYYY-MM-DD), got: $waiver"
            e2e_line="$e2e (the operator validated it ready without E2E: $waiver)"
        elif [ -n "$exempt_words" ]; then
            e2e_line="$e2e (this session's pull requests exempted from E2E by the operator: $exempt_words)"
        else
            die "ready: row $id has no E2E test and the operator has not validated it ready without one: tell him « $e2e », then record his validation with --e2e-waiver \"<his words, dated>\": not ready"
        fi
    else
        [ -z "$waiver" ] || die "ready: --e2e-waiver is for a pull request with no E2E test, and this line names one: $e2e"
        e2e_line="$e2e"
    fi
    rewrite 'if .id==$i then .e2e={line:$l,kind:$k,waiver:$w,exempt:$x,head:$h,at:$a} else . end' "$id" \
        --arg l "$e2e" --arg k "$e2e_kind" --arg w "$waiver" --arg x "$exempt_words" --arg h "$head" \
        --arg a "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    surface_line="$surface_line; $e2e_line"
    # The label is the orchestrator's to put, with the github tool, in the same move as its
    # ready: this prints the command and calls nothing. The pull request is the one the row
    # names (a `--ui` row); otherwise the placeholders stay for the orchestrator to fill.
    label_cmd="pr-readiness <n> ready on <owner/repo>"
    if [ "$kind" = ui ]; then label_cmd="pr-readiness ${pr##*#} ready on ${pr%#*}"; fi
    reviewed=$(jq -sr --argjson i "$id" '[.[]|select(.id==$i)][0].review.head // ""' "$record")
    norms=$(jq -sr --argjson i "$id" '[.[]|select(.id==$i)][0].review.norms // ""' "$record")
    fixed=$(jq -sr --argjson i "$id" '[.[]|select(.id==$i)][0].review.fixed.head // ""' "$record")
    if [ -z "$reviewed" ]; then
        warn "ready: no review recorded on row $id: dispatch a review round and record it with \`review\`"
        echo "ready: row $id has no review recorded yet; head $head is unverified; $surface_line"
        exit 0
    fi
    # In this shell, not in a substitution: `same_commit` dies on a head too short to
    # identify anything, and that refusal must stop the gate, not read as a mismatch.
    if same_commit "$reviewed" "$head"; then
        echo "ready: row $id reviewed at $head, norms check $norms; $surface_line"
        echo "$label_cmd"
    elif [ -n "$fixed" ] && same_commit "$fixed" "$head"; then
        echo "ready: row $id reviewed at $reviewed, corrected and verified at $head, norms check $norms; $surface_line"
        echo "$label_cmd"
    elif [ -n "$fixed" ]; then
        die "ready: last review read $reviewed, its correction $fixed, head is $head: the head in front of you has been neither read nor verified"
    else
        die "ready: last review read $reviewed, head is $head: the head in front of you has not been read"
    fi
    ;;
exempt)
    # The operator's exemption of every pull request of this session from E2E tests, in his
    # words and their date, recorded once beside the record; `ready` then accepts
    # `E2E: none — <reason>` without a waiver per pull request. Recording it again replaces it.
    shift 2; words=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --e2e) words="${2:-}"; shift 2 ;;
            *) die "exempt: unknown option $1" ;;
        esac
    done
    [ -n "$words" ] || die "exempt: --e2e \"<the operator's words, dated>\" is required"
    [[ "$words" =~ $DATED_RE ]] || die "exempt: --e2e takes the operator's words with their date (YYYY-MM-DD), got: $words"
    [ -f "$record" ] || die "exempt: no such record: $record"
    jq -nc --arg w "$words" --arg a "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{words:$w,at:$a}' > "$E2E_EXEMPT_FILE" \
        || die "exempt: could not write $E2E_EXEMPT_FILE"
    echo "exempt: every pull request of this session's record is exempted from E2E: $words"
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
cost)
    # What one session of this dispatch cost, added to the row: a dispatch's corrective
    # rounds are part of what it cost, and a pair is ranked on the whole of it.
    id="${3:-}"; [ -n "$id" ] || die "cost: a row id is required"
    require_row cost "$id"
    shift 3; session=""; force=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --session) session="$2"; shift 2 ;;
            # A row written before the `unpriced` list, incomplete with a figure already
            # counted, cannot say which of its sessions was the unpriced one: the caller names
            # it. Refused on any row that can say, or is not incomplete.
            --recount) force=1; shift ;;
            *) die "cost: unknown option $1" ;;
        esac
    done
    [ -n "$session" ] || die "cost: --session is required"
    # A session counted while its model had no price is counted again once it has one: the
    # row lists it under `unpriced`, and a row written before that list existed is read as all
    # unpriced when it is incomplete with nothing counted. A session counted with a figure is
    # never counted twice.
    recount=$(jq -sr --argjson i "$id" --arg s "$session" '[.[]|select(.id==$i)][0]
        | if ((.sessions // []) | index($s)) == null then "new"
          elif ((.unpriced // []) | index($s)) != null then "recount"
          elif .unpriced == null and .cost_incomplete == true and (.cost_usd // 0) == 0 then "recount"
          else "counted" end' "$record")
    if [ "$force" = 1 ]; then
        legacy=$(jq -sr --argjson i "$id" --arg s "$session" '[.[]|select(.id==$i)][0]
            | .unpriced == null and .cost_incomplete == true and ((.sessions // []) | index($s)) != null' "$record")
        [ "$legacy" = true ] || die "cost: --recount is for a row written before the unpriced list, incomplete, that counts session $session; row $id is not one"
        recount=named
    fi
    if [ "$recount" = counted ]; then
        warn "cost: session $session is already counted on row $id (a row written before the unpriced list takes --recount naming its unpriced session)"; exit 0
    fi
    alias=$(jq -sr --argjson i "$id" '[.[]|select(.id==$i)][0].model // ""' "$record")
    measured=$(python3 "$ROUTING" cost --session "$session" ${alias:+--alias "$alias"} --json) || die "cost: could not measure session $session"
    usd=$(printf '%s' "$measured" | jq -r '.cost_usd // "null"')
    # The legacy reading (incomplete, nothing counted, no list) names every counted session
    # unpriced, so the list is seeded from the sessions on the first recount.
    seed='.unpriced = (.unpriced // (if .cost_incomplete == true and (.cost_usd // 0) == 0 then (.sessions // []) else [] end))'
    # Named by --recount: that session alone is the row's unpriced one.
    [ "$recount" != named ] || seed='.unpriced = [$s]'
    if [ "$usd" = null ]; then
        warn "cost: session $session has an unpriced model: row $id is marked cost_incomplete"
        rewrite "if .id==\$i then $seed"' | .sessions = ((.sessions // []) - [$s] + [$s]) | .unpriced = (.unpriced - [$s] + [$s]) | .cost_incomplete=true else . end' "$id" --arg s "$session"
    else
        rewrite "if .id==\$i then $seed"' | .sessions = ((.sessions // []) - [$s] + [$s]) | .unpriced = (.unpriced - [$s]) | .cost_usd = ((.cost_usd // 0) + $u) | .cost_incomplete = (.unpriced | length > 0) else . end' "$id" \
            --arg s "$session" --argjson u "$usd"
    fi
    echo "cost: row $id +$usd (session $session)"
    ;;
summary)
    only_open=0
    case "${3:-}" in
        "") ;;
        --open) only_open=1 ;;
        *) die "summary: unknown argument ${3} (expected --open)" ;;
    esac
    [ -f "$record" ] || { echo "dispatch-record: no record at $record"; exit 0; }
    if [ "$only_open" = 1 ]; then
        jq -sr '.[] | select(.state == "open") | "open=\(.id) label=\(.label)"' "$record"
        exit $?
    fi
    # Every group is keyed by the row's pair when it has one and by its tier otherwise, so
    # a tier row prints `tier=<t>` exactly as it did before pairs existed.
    KEY='def key: if .model then "pair=" + .model + "/" + (.effort // "" | if . == "" then "default" else . end) else "tier=" + .tier end;'
    jq -sr "$KEY"'
      map(. + {key: key})
      | group_by(.class + " " + .key)
      | map({class: .[0].class, key: .[0].key, rows: .,
             n: length, closed: (map(select(.state=="closed"))|length),
             avg: (if length==0 then 0 else ((map(.rounds)|add) / length) end)})
      | map(. + {costs: (.rows | map(select(.state=="closed" and (.cost_incomplete|not) and (.cost_usd // 0) > 0)) | map(.cost_usd))})
      | sort_by(.class, .key)
      | (.[] | "class=\(.class) \(.key) dispatches=\(.n) closed=\(.closed) rounds_avg=\(.avg*10|round/10)"
               + (if (.costs|length) > 0 then " cost_avg=\((.costs|add/length)*10000|round/10000)" else "" end)),
        (.[] | select(.avg > 1) | "signal=\(.class) at \(.key|sub("^(tier|pair)=";"")) averages \(.avg*10|round/10) rounds: the drop did not pay, revert it for this class")
    ' "$record"
    jq -sr "$KEY"'
      map(select(.escaped == true))
      | map(. + {key: key})
      | group_by(.class + " " + .key)
      | map({class: .[0].class, key: .[0].key, n: length})
      | sort_by(.class, .key)
      | (.[] | "escapes=\(.class) at \(.key|sub("^(tier|pair)=";"")): \(.n) of \(.n) approved rows had a defect found later"),
        (.[] | "signal=double-read \(.class) at \(.key|sub("^(tier|pair)=";"")): an approval missed a defect. Give the next round a SECOND reader with a different lens, and keep a finding only when both see it")
    ' "$record"
    # A cascade pays when it closes in one round: the attempt cost nothing beyond itself.
    # Below half, the retries cost more than the tier they saved, which is the whole test.
    jq -sr "$KEY"'
      map(select(.cascade == true))
      | map(. + {key: key})
      | group_by(.class + " " + .key)
      | map({class: .[0].class, key: .[0].key,
             n: length, paid: (map(select(.rounds == 0))|length)})
      | sort_by(.class, .key)
      | (.[] | "cascade=\(.class) at \(.key|sub("^(tier|pair)=";"")): \(.paid) of \(.n) paid"),
        (.[] | select(.n >= 2 and .paid * 2 < .n)
             | "signal=stop cascading \(.class) at \(.key|sub("^(tier|pair)=";"")): \(.paid) of \(.n) paid, the retries cost more than the tier saved")
    ' "$record"
    # Exploration: one that cost a corrective round or let a defect escape freezes its
    # class for the build; three that closed in one round promote the lower pair.
    jq -sr "$KEY"'
      map(select(.explore == true and .state == "closed"))
      | map(. + {key: key})
      | group_by(.class)
      | (.[] | select(any(.[]; .rounds > 1 or .escaped == true)) | "frozen=\(.[0].class)"),
        (.[] | select(all(.[]; .rounds <= 1 and (.escaped != true)))
             | group_by(.key)[] | select(length >= 3)
             | "promote=\(.[0].class) \(.[0].key|sub("^pair=";""))")
    ' "$record"
    # The rows still open are work: deferred, in flight, or lost. A successor reads them as
    # such, never as history.
    jq -sr '.[] | select(.state == "open") | "open=\(.id) label=\(.label)"' "$record"
    ;;
goals)
    sub="${3:-}"; [ -n "$sub" ] || die "goals: a subcommand is required (init, status, plan, met, rule-out, reopen or check)"
    case "$sub" in init|status|plan|met|rule-out|reopen|check) ;; *) die "goals: unknown subcommand: $sub (expected init, status, plan, met, rule-out, reopen or check)" ;; esac
    shift 3
    REGISTER_ABSENT=1
    [ "$sub" != init ] || mkdir -p "$(dirname "$record")"
    python3 "$GOALS_PY" "$sub" "$GOALS_FILE" "$@"
    exit $?
    ;;
*) die "unknown subcommand: $cmd (expected open, round, review, fixed, surface, audit, ready, exempt, close, escaped, cost, summary or goals)" ;;
esac
