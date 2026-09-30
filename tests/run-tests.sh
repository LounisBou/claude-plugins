#!/bin/bash
# Test suite. No network, no terminal automation, isolated HOME per case.
#
# Each case runs a script against a temporary state directory or a temporary
# HOME and compares its output or its side effects with an expected value.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ORCH_REFS="$ROOT/skills/orchestrator/references"
# Explicitly inside TMPDIR: the platform default lands in a directory a sandboxed
# shell may not write to, and the suite then runs with an empty path where it thinks
# it has a directory.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-XXXXXX")
[ -d "${WORK}" ] || { echo "cannot create a working directory under ${TMPDIR:-/tmp}" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

# The launcher refuses a directory the host has never opened, in a dry run as much as in a
# real one: "what would happen" includes being refused. The suite declares the precondition
# once, in a file of its own, so no test ever reads or writes the operator's configuration.
# The host CLI the suite reads the process table for, PINNED. It is read from the
# environment, and an operator's own shell carries it as an absolute path: the same suite
# was matching two different names on his machine and on a clean one, and only one of them
# matched the tables the suite itself writes. A test must not read differently depending on
# who runs it.
export ORCHESTRATOR_HOST_CLI=claude

export ORCHESTRATOR_TRUST_FILE="$WORK/suite-trust.json"
"$(command -v python3 || echo python3)" -c "
import json,os,sys
json.dump({'projects': {os.path.realpath(sys.argv[1]): {'hasTrustDialogAccepted': True}}},
          open(sys.argv[2], 'w'))" "$WORK" "$ORCHESTRATOR_TRUST_FILE"

# check <name> <expected> <actual>
check() {
  if [ "$2" = "$3" ]; then
    printf '  ok   %s\n' "$1"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n' "$1"
    printf '       expected: %s\n' "$(printf '%s' "$2" | tr '\n' '⏎')"
    printf '       actual:   %s\n' "$(printf '%s' "$3" | tr '\n' '⏎')"
    fail=$((fail + 1))
  fi
}

# check_status <name> <expected-exit-code> <command...>
check_status() {
  local name="$1" expected="$2"
  shift 2
  "$@" >/dev/null 2>&1
  local code=$?
  check "$name" "exit $expected" "exit $code"
}

# Read as presence, not as a count: a document may spell a literal on one line or on five,
# and a guard that pins the number breaks on a sentence that was merely rewritten.
spells() { grep -qF -- "$2" "$1" && echo yes || echo no; }
carries() { grep -qiF "$2" "$1" && echo yes || echo no; }

echo "== repository policy =="

# The product name appears only in load-bearing identifiers: host paths, host
# environment variables, the plugin name and the manifest directory (CLAUDE.md rule 2).
# Presence checks pin wording and were dropped; an absence sweep pins none, so it stays.
#
# The grep runs from INSIDE the repository, on a relative path. With an absolute one,
# every result line carries the repository's own path and the exemption for the plugin's
# name deletes the whole line whatever it said, so this check would report a clean
# repository without ever reading a single file.
policy_hits() {
  ( cd "$ROOT" && grep -rniI 'claude' . --exclude-dir=.git --exclude-dir=.claude --exclude-dir=plans \
      --exclude=plan.md --exclude=CLAUDE.md --exclude=run-tests.sh \
    | grep -viE '~/\.claude/|\$HOME/\.claude|CLAUDE_CONFIG_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_CODE_SESSION_ID|ORCHESTRATOR_HOST_CLI|claude-orchestrator|\.claude-plugin|/\.claude/|\.claude\.json|LounisBou/claude-statusbar' || true )
}
check "no vendor or product name in prose" "" "$(policy_hits)"

# The guard proves it can still SEE one: a file planted with a violation must show up in
# the very same function, or "no hits" proves nothing.
PROBE="$ROOT/.policy-probe-$$.md"
trap 'rm -rf "$WORK"; rm -f "$PROBE"' EXIT
printf 'PRODUCT NAME IN PROSE\n' | sed 's/PRODUCT NAME/Claude/' > "$PROBE"
seen=$(policy_hits | grep -c 'policy-probe' || true)
rm -f "$PROBE"
check "the policy guard can see a violation" "1" "$seen"

# The tiers exist so no model family name has to appear here.
hits=$(grep -rniIE '\b(opus|sonnet|haiku)\b' "$ROOT" --exclude-dir=.git --exclude-dir=.claude --exclude-dir=plans \
  --exclude=plan.md --exclude=CLAUDE.md --exclude=run-tests.sh || true)
check "no model family name in the plugin" "" "$hits"

# Nothing tied to one machine or one project enters the generic plugin: no absolute home
# path, no real session reference (the documented example is the six-hex placeholder
# a1b2c3), no path into a downstream project's tree.
hits=$(grep -rnIE '/Users/|/home/[a-z]|\[[0-9a-f]{6}\]|docs/reference/|BUGS\.md|IMPLEMENTATION\.md' "$ROOT" --exclude-dir=.git --exclude=.git --exclude-dir=.claude --exclude=plan.md --exclude=run-tests.sh \
  | grep -vE '\[a1b2c3\]' || true)
check "nothing project- or machine-specific in the plugin" "" "$hits"

# The namespace is the plugin's name, `orchestrator`: commands and skills are reached as
# /orchestrator:* and orchestrator:*. The former prefix must not come back in prose.
hits=$(grep -rnI 'claude-orchestrator:' "$ROOT" --exclude-dir=.git --exclude=run-tests.sh || true)
check "the old command namespace is gone" "" "$hits"

# The operator manages the usage budget; the plugin does not read it, report it or route on
# it (phase 3 ruling 4, reasserted 2026-09-30). No replacement sentence either.
hits=$(cd "$ROOT" && git grep -iE 'five_hour|seven_day|budget|rate_limits|quota|5-hour|7-day|five-hour|seven-day' -- skills/ commands/ templates/ hooks/ README.md docs/design.md || true)
check "no budget reference in the plugin" "" "$hits"

# A rotation closes the old tab by its tty, the stood-down acknowledgment being the guard:
# a title read before the ten-second spawn is stale after it, and the tab skill forbids
# --expect-title on a rotation. The orchestrator's text once said « tty + title guard ».
# The replacement lands at the end of the caller's chain, where --right-of self puts it.
lc="$ROOT/skills/orchestrator/references/lifecycle.md"
check "the rotation closes by tty with the acknowledgment as its guard" "1" \
  "$(grep -c 'closes the old tab by its tty — the stood-down acknowledgment is the guard, and a rotation takes no title guard' "$lc")"
check "the rotation names the replacement's place" "1" "$(grep -c 'rotate --right-of self` (it spawns the fresh session with the brief path as its startup prompt at the end of your chain' "$lc")"
check "no title guard left on a rotation" "0" "$(grep -c 'tty + title guard' "$lc")"

# Merging and undrafting a pull request are the operator's, on his clear and explicit request:
# they left every « decide and move » list and every list of what the orchestrator runs,
# the auditor's included. A list that names merges again hands them back to a session.
hits=$(cd "$ROOT" && git grep -nE 'merges, deploys|Opening, merging|merging and tagging' -- skills/ commands/ templates/ README.md || true)
check "no merge in a decide-and-move or orchestrator-runs list" "" "$hits"
check "the rulebook keeps merge and undraft the operator's" "1" \
  "$(grep -c 'Merging a pull request and taking it out of draft are the two exceptions' "$ROOT/skills/orchestrator/SKILL.md")"
check "the audit reference keeps merge and undraft out of its list" "1" \
  "$(grep -c 'Merging a pull request and taking it out of draft are in no such list, the auditor' "$ROOT/skills/orchestrator/references/audit.md")"
check "the audit brief keeps merge and undraft out of its list" "1" \
  "$(grep -c 'draft are in no such list: they are the operator.s, on his clear and explicit request' "$ROOT/templates/agent-audit-brief.md")"
check "the succession brief closes the predecessor's tab" "1" "$(grep -c 'CLOSE ITS TAB' "$ROOT/templates/orchestrator-succession-brief.md")"
# Ready is the operator's turn: the pull request stays in draft, rebased, and the squash-merge
# of a lower branch is replayed around, never through.
check "ready leaves the pull request in draft" "1" "$(grep -c "Ready is the operator's turn, and the pull request stays in draft" "$ROOT/skills/orchestrator/SKILL.md")"
check "ready includes the rebase and names the squash-merge trap" "1|1|1" \
  "$(grep -c "each pull request of a stack on the one below it" "$ROOT/skills/orchestrator/SKILL.md")|$(grep -c "git rebase --onto <main> <old head of the lower branch> <branch>" "$ORCH_REFS/review.md")|$(grep -c "the one force this rule allows" "$ORCH_REFS/review.md")"
check "the new excuses have their rows" "1|1|1" \
  "$(grep -c "The reviewer found it, so it goes in the correction round" "$ROOT/skills/orchestrator/SKILL.md")|$(grep -c "is green, I can take it out of draft" "$ROOT/skills/orchestrator/SKILL.md")|$(grep -c "a plain rebase on main will do" "$ROOT/skills/orchestrator/SKILL.md")"
check "the new red flags are listed" "1|1" \
  "$(grep -c "A second review round scheduled on a pull request you dispatched" "$ROOT/skills/orchestrator/SKILL.md")|$(grep -c "a force push other than a rebase" "$ROOT/skills/orchestrator/SKILL.md")"
check "the ungated pull request has its red flag" "1" "$(grep -c "A pull request you merged or took out of draft without his clear and explicit request; « ready » told to the operator before" "$ROOT/skills/orchestrator/SKILL.md")"
out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$WORK/istate2" bash "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh" spawn --dir "$WORK" --prompt p --left-of /dev/ttys001 --right-of self 2>&1 || true)
case "$out" in *"mutually exclusive"*) anchors="refused" ;; *) anchors="$out" ;; esac
check "two anchors are refused at spawn" "refused" "$anchors"

echo "== agent chain (dry run) =="
# The operator's rule: orchestrator, agent 1, agent 2, … in launch order. `--right-of self`
# used to mean « immediately right of my tab », which put every new agent BETWEEN the
# orchestrator and the previous one. The chain file names the last agent; `self` resolves
# to it. A dry run reads the chain and never writes it: there is no tab to record.
AGENT="$ROOT/skills/iterm-agents/scripts/iterm-agent.sh"
CHAINS="$WORK/istate/chains"; mkdir -p "$CHAINS"
chain_spawn() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$WORK/istate" ORCHESTRATOR_SELF_TTY=/dev/ttys900 bash "$AGENT" spawn --dir "$WORK" --title "Agent : chain" --prompt p "$@" 2>&1; }
out=$(chain_spawn --right-of self)
check "the dry run names the caller's tty" "1" "$(printf '%s' "$out" | grep -c '^self=/dev/ttys900$')"
check "no chain: self is the anchor" "1" "$(printf '%s' "$out" | grep -c '^anchor=self$')"
printf '{"tab_id":"t-1","tty":"/dev/ttys901"}\n{"tab_id":"t-2","tty":"/dev/ttys902"}\n' > "$CHAINS/ttys900.jsonl"
out=$(chain_spawn --right-of self)
check "a chain of two: the last is the anchor" "1" "$(printf '%s' "$out" | grep -c '^anchor=/dev/ttys902$')"
check "a dry run writes no chain" "2" "$(wc -l < "$CHAINS/ttys900.jsonl" | tr -d ' ')"
out=$(chain_spawn --right-of /dev/ttys555)
check "an explicit anchor ignores the chain" "1" "$(printf '%s' "$out" | grep -c '^anchor=/dev/ttys555$')"
out=$(chain_spawn --left-of self)
check "left of self ignores the chain" "1" "$(printf '%s' "$out" | grep -c '^anchor=self$')"
printf 'not json\n' > "$CHAINS/ttys900.jsonl"
out=$(chain_spawn --right-of self)
check "a corrupt chain reads as empty" "1" "$(printf '%s' "$out" | grep -c '^anchor=self$')"

# A tty is recycled; the chain file named after it survives its occupant. An entry names
# the session that wrote it, and a reader keeps only its own (§26).
printf '{"tab_id":"7","tty":"/dev/ttys907","owner":"S-OTHER"}\n{"tab_id":"8","tty":"/dev/ttys908","owner":"S-ME"}\n' > "$CHAINS/ttys900.jsonl"
out=$(ORCHESTRATOR_SELF_ID=S-ME chain_spawn --right-of self)
check "an entry of another session is skipped, an own one anchors" "1" "$(printf '%s' "$out" | grep -c '^anchor=/dev/ttys908$')"
out=$(ORCHESTRATOR_SELF_ID=S-NEW chain_spawn --right-of self)
check "a chain written by strangers anchors on self" "1" "$(printf '%s' "$out" | grep -c '^anchor=self$')"
printf '{"tab_id":"9","tty":"/dev/ttys909"}\n' > "$CHAINS/ttys900.jsonl"
out=$(ORCHESTRATOR_SELF_ID=S-ME chain_spawn --right-of self)
check "an entry with no owner is skipped once an owner is known" "1" "$(printf '%s' "$out" | grep -c '^anchor=self$')"

# A successor is not an agent: it takes the predecessor's place, immediately right of it,
# chain ignored, and takes the chain with it (§34). Dry: the anchor, and the file untouched.
printf '{"tab_id":"7","tty":"/dev/ttys907","owner":"S-OTHER"}\n{"tab_id":"8","tty":"/dev/ttys908","owner":"S-ME"}\n' > "$CHAINS/ttys900.jsonl"
before=$(cat "$CHAINS/ttys900.jsonl")
out=$(ORCHESTRATOR_SELF_ID=S-ME chain_spawn --successor)
check "a successor anchors on self, whatever the chain says" "1|1" \
  "$(printf '%s' "$out" | grep -c '^anchor=self$')|$(printf '%s' "$out" | grep -c '^successor=yes$')"
check "a dry successor spawn leaves the chain as it was" "$before" "$(cat "$CHAINS/ttys900.jsonl")"
check "a successor names its own anchor" "1|1" \
  "$(chain_spawn --successor --right-of self >/dev/null 2>&1; echo $?)|$(chain_spawn --successor --left-of /dev/ttys555 >/dev/null 2>&1; echo $?)"
# The hand-over itself, on the module: the predecessor's own entries move under the
# successor's tty and owner, its foreign entries stay, and a stale file on the successor's
# recycled tty is replaced, not appended to. Nothing to hand over hands over an empty chain.
py=$(command -v python3 || echo python3)
transfer() { ORCHESTRATOR_STATE_DIR="$WORK/istate" "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
print(m.chain_transfer('/dev/ttys900', 'S-ME', '/dev/ttys950', 'S-NEW'))" 2>&1; }
printf '{"tab_id":"7","tty":"/dev/ttys907","owner":"S-OTHER"}\n{"tab_id":"8","tty":"/dev/ttys908","owner":"S-ME"}\n{"tab_id":"9","tty":"/dev/ttys909","owner":"S-ME"}\n' > "$CHAINS/ttys900.jsonl"
printf '{"tab_id":"1","tty":"/dev/ttys901","owner":"S-DEAD"}\n' > "$CHAINS/ttys950.jsonl"
check "the hand-over moves the predecessor's own entries" "2" "$(transfer)"
check "under the successor's tty and owner, the stale file replaced" \
  '{"tab_id": "8", "tty": "/dev/ttys908", "owner": "S-NEW"}|{"tab_id": "9", "tty": "/dev/ttys909", "owner": "S-NEW"}' \
  "$(paste -sd'|' "$CHAINS/ttys950.jsonl")"
check "and leaves the predecessor only what was never its own" '{"tab_id": "7", "tty": "/dev/ttys907", "owner": "S-OTHER"}' \
  "$(cat "$CHAINS/ttys900.jsonl")"
check "a predecessor with no agents hands over an empty chain" "0|0" "$(transfer)|$(wc -l < "$CHAINS/ttys950.jsonl" | tr -d ' ')"

echo "== dispatch record =="

# The routing rule says a tier drop that costs a second corrective round is reverted for
# its class. Nothing measured that, so the rule could only ever be applied from memory —
# and an economy nobody measures is one that always looks free. One row per dispatch,
# and a summary that names the classes where the drop did not pay.
REC="$ROOT/skills/orchestrator/scripts/dispatch-record.sh"
R="$WORK/dispatch.jsonl"

id1=$(bash "$REC" open "$R" --class behaviour-phase --tier standard --label "phase 1")
check "open prints the row id" "1" "$id1"
check "the row is one line of json" "1" "$(wc -l < "$R" | tr -d ' ')"
check "the row carries what was asked" "behaviour-phase|standard|phase 1|0|open" \
  "$(jq -r '[.class,.tier,.label,.rounds,.state]|join("|")' "$R")"

bash "$REC" round "$R" "$id1" >/dev/null
bash "$REC" round "$R" "$id1" >/dev/null
check "a round is counted on the row" "2" "$(jq -r 'select(.id==1)|.rounds' "$R")"

bash "$REC" close "$R" "$id1" --verdict approved >/dev/null
check "closing records the verdict and the state" "approved|closed" "$(jq -r 'select(.id==1)|[.verdict,.state]|join("|")' "$R")"
check "closing does not add a row" "1" "$(wc -l < "$R" | tr -d ' ')"

id2=$(bash "$REC" open "$R" --class conversion-phase --tier light)
check "the second row gets the next id" "2" "$id2"
bash "$REC" close "$R" "$id2" --verdict approved >/dev/null
check "a dispatch closed without a round reads as one round" "1" "$(bash "$REC" summary "$R" | grep -c 'class=conversion-phase tier=light dispatches=1 closed=1 rounds_avg=0')"

# The signal, which is the whole point: a class whose average sits above one corrective
# round is a drop that did not pay, and the summary says so rather than leaving it to be
# noticed. Two dispatches of the same class, both needing two rounds.
for i in 1 2; do
  n=$(bash "$REC" open "$R" --class n-bis --tier light)
  bash "$REC" round "$R" "$n" >/dev/null; bash "$REC" round "$R" "$n" >/dev/null
  bash "$REC" close "$R" "$n" --verdict approved >/dev/null
done
check "a class that costs more than one round is signalled" "1" \
  "$(bash "$REC" summary "$R" | grep -c '^signal=n-bis at light averages 2 rounds')"
check "a class that closes in one round raises no signal" "0" \
  "$(bash "$REC" summary "$R" | grep -c 'signal=conversion-phase')"

# A cascade starts one tier BELOW the table's row, on classes where a failed attempt is
# cheap to detect and cheap to throw away. Marking the row is what makes the bet payable:
# without it, a cascade that failed looks exactly like a row that needed two rounds.
c1=$(bash "$REC" open "$R" --class review-lens --tier light --cascade)
check "a cascade row is marked" "true" "$(jq -r --argjson i "$c1" 'select(.id==$i)|.cascade' "$R")"
bash "$REC" close "$R" "$c1" --verdict approved >/dev/null
check "a cascade that closed in one round is reported as paid" "1" \
  "$(bash "$REC" summary "$R" | grep -c '^cascade=review-lens at light: 1 of 1 paid')"

c2=$(bash "$REC" open "$R" --class review-lens --tier light --cascade)
bash "$REC" round "$R" "$c2" >/dev/null
bash "$REC" close "$R" "$c2" --verdict escalated >/dev/null
check "a cascade that cost a round is not counted as paid" "1" \
  "$(bash "$REC" summary "$R" | grep -c '^cascade=review-lens at light: 1 of 2 paid')"
check "a cascade below half raises the stop signal" "0" \
  "$(bash "$REC" summary "$R" | grep -c 'stop cascading')"
c3=$(bash "$REC" open "$R" --class review-lens --tier light --cascade)
bash "$REC" round "$R" "$c3" >/dev/null
bash "$REC" close "$R" "$c3" --verdict escalated >/dev/null
check "a cascade paying less than half says to stop" "1" \
  "$(bash "$REC" summary "$R" | grep -c 'stop cascading review-lens at light')"
check "a class with no cascade row gets no cascade line" "0" \
  "$(bash "$REC" summary "$R" | grep -c '^cascade=conversion-phase')"

# What a review MISSED is the number the published work says to watch: strong judges keep
# false positives low and false negatives moderate to high — they let defects through. An
# approval that a later round contradicts is the only evidence of that available here.
e1=$(bash "$REC" open "$R" --class behaviour-phase --tier standard)
bash "$REC" close "$R" "$e1" --verdict approved >/dev/null
check "no escape, no line" "0" "$(bash "$REC" summary "$R" | grep -c '^escapes=behaviour-phase')"
bash "$REC" escaped "$R" "$e1" >/dev/null
check "an escape is recorded on the row" "true" "$(jq -r --argjson i "$e1" 'select(.id==$i)|.escaped' "$R")"
check "the escape is counted" "1" "$(bash "$REC" summary "$R" | grep -c '^escapes=behaviour-phase at standard: 1 of 1')"
check "one escape arms the second reader" "1" "$(bash "$REC" summary "$R" | grep -c 'signal=double-read behaviour-phase at standard')"
check_status "an escape on an unknown row is an error" 1 bash "$REC" escaped "$R" 99

check_status "an unknown row id is an error" 1 bash "$REC" round "$R" 99
check_status "an unknown tier is refused at open" 1 bash "$REC" open "$R" --class x --tier cheapest
check_status "open without a class is an error" 1 bash "$REC" open "$R" --tier deep
check_status "a summary of nothing is not an error" 0 bash "$REC" summary "$WORK/absent.jsonl"

# The gate. « Every agent-produced pull request gets its review and its norms check before
# its verdict » was written in the rulebook and in the review template, and was still broken
# twice in one day: two rounds replaced the project's norms tool by a hand reading of its
# norms file. A rule only prose carries is applied from memory. `review` records what a round
# actually read; `ready` refuses everything else.
G="$WORK/gate.jsonl"
g1=$(bash "$REC" open "$G" --class behaviour-phase --tier standard --label "gate")
check_status "ready refuses a row no review has touched" 1 bash "$REC" ready "$G" "$g1" --head aaa1111
check "and says which condition failed" "1" \
  "$(bash "$REC" ready "$G" "$g1" --head aaa1111 2>&1 | grep -c 'no review recorded')"

bash "$REC" review "$G" "$g1" --head aaa1111 --norms tool >/dev/null
check "a review records the head it read and its norms check" "aaa1111|tool" \
  "$(jq -r --argjson i "$g1" 'select(.id==$i)|[.review.head,.review.norms]|join("|")' "$G")"
check "a review counts as a round" "1" "$(jq -r --argjson i "$g1" 'select(.id==$i)|.rounds' "$G")"
check_status "ready passes at the head that review read" 0 bash "$REC" ready "$G" "$g1" --head aaa1111

# The head moves on every corrective round, and the review that read the previous one says
# nothing about this one. This is the case the orchestrator talked itself past.
check_status "ready refuses a head no review has read" 1 bash "$REC" ready "$G" "$g1" --head bbb2222
check "and names both heads" "1" \
  "$(bash "$REC" ready "$G" "$g1" --head bbb2222 2>&1 | grep -c 'last review read aaa1111, head is bbb2222')"

bash "$REC" review "$G" "$g1" --head bbb2222 --norms none >/dev/null
check "the row keeps the LAST review, and the round is counted" "bbb2222|none|2" \
  "$(jq -r --argjson i "$g1" 'select(.id==$i)|[.review.head,.review.norms,.rounds]|join("|")' "$G")"
check "a review adds no row" "1" "$(wc -l < "$G" | tr -d ' ')"
check_status "a project shipping no norms tool still passes the gate" 0 bash "$REC" ready "$G" "$g1" --head bbb2222

# `workspace.sh` prints short SHAs where a host API gives all forty: the same commit must not
# be refused for how it was spelled. Either side may abbreviate the other, from seven
# characters up; anything shorter identifies nothing, and no git call is made to check.
full=0123456789abcdef0123456789abcdef01234567
g2=$(bash "$REC" open "$G" --class behaviour-phase --tier standard --label "abbreviated")
bash "$REC" review "$G" "$g2" --head 0123456 --norms tool >/dev/null
check_status "a short recorded head accepts the full head of the same commit" 0 bash "$REC" ready "$G" "$g2" --head "$full"
bash "$REC" review "$G" "$g2" --head "$full" --norms tool >/dev/null
check_status "a full recorded head accepts the short head of the same commit" 0 bash "$REC" ready "$G" "$g2" --head 0123456
check_status "two heads sharing no prefix are refused" 1 bash "$REC" ready "$G" "$g2" --head fedcba9876543210fedcba9876543210fedcba98
check "and are named" "1" \
  "$(bash "$REC" ready "$G" "$g2" --head fedcba9 2>&1 | grep -c "last review read $full, head is fedcba9")"
check_status "a six-character head identifies nothing" 1 bash "$REC" ready "$G" "$g2" --head 012345
check "and says so" "1" "$(bash "$REC" ready "$G" "$g2" --head 012345 2>&1 | grep -c 'ready: head 012345 is too short')"

# The operator's process: ONE review round, the orchestrator's triage, ONE correction round
# the orchestrator verifies on the artifact, done. The correction moves the head, and the
# review that read the previous one must still let the pull request through at the head the
# orchestrator verified - once, and only after a review, or the gate stops meaning anything.
g3=$(bash "$REC" open "$G" --class behaviour-phase --tier standard --label "one fix")
check_status "fixed refuses a row no review has touched" 1 bash "$REC" fixed "$G" "$g3" --head ddd4444
check "and says a review comes first" "1" \
  "$(bash "$REC" fixed "$G" "$g3" --head ddd4444 2>&1 | grep -c 'fixed: no review recorded on row')"
check "a refused fix leaves no fixed head" "" "$(jq -r --argjson i "$g3" 'select(.id==$i)|.review.fixed.head // ""' "$G")"
bash "$REC" review "$G" "$g3" --head ccc3333 --norms tool >/dev/null
bash "$REC" fixed "$G" "$g3" --head ddd4444 >/dev/null
check "fixed records the head the orchestrator verified, and counts the round" "ccc3333|ddd4444|2" \
  "$(jq -r --argjson i "$g3" 'select(.id==$i)|[.review.head,.review.fixed.head,.rounds]|join("|")' "$G")"
check_status "ready passes at the fixed head" 0 bash "$REC" ready "$G" "$g3" --head ddd4444
check "and says which reading it rests on" "1" \
  "$(bash "$REC" ready "$G" "$g3" --head ddd4444 2>&1 | grep -c 'ready: row 3 reviewed at ccc3333, corrected and verified at ddd4444')"
check_status "the fixed head accepts its full spelling" 0 bash "$REC" ready "$G" "$g3" --head ddd4444abcdef
check_status "ready still passes at the reviewed head" 0 bash "$REC" ready "$G" "$g3" --head ccc3333
check_status "ready refuses a head neither reviewed nor fixed" 1 bash "$REC" ready "$G" "$g3" --head eee5555
check "and names all three heads" "1" \
  "$(bash "$REC" ready "$G" "$g3" --head eee5555 2>&1 | grep -c 'last review read ccc3333, its correction ddd4444, head is eee5555')"
check_status "a second correction round is refused" 1 bash "$REC" fixed "$G" "$g3" --head eee5555
check "and says there is one" "1" \
  "$(bash "$REC" fixed "$G" "$g3" --head eee5555 2>&1 | grep -c 'fixed: row 3 already has its correction round at ddd4444')"
check "a refused second fix leaves the first" "ddd4444|2" \
  "$(jq -r --argjson i "$g3" 'select(.id==$i)|[.review.fixed.head,.rounds]|join("|")' "$G")"
check_status "fixed without --head is an error" 1 bash "$REC" fixed "$G" "$g2"
check "and says the head is required" "1" "$(bash "$REC" fixed "$G" "$g2" 2>&1 | grep -c 'fixed: --head is required')"
check_status "fixed on an unknown row is an error" 1 bash "$REC" fixed "$G" 99 --head aaa1111
check_status "fixed on an unknown option is an error" 1 bash "$REC" fixed "$G" "$g2" --head aaa1111 --force

# `none` is a fact about the PROJECT, not a verdict a round may reach for: any third value
# is refused rather than recorded, because an unreadable record gates nothing.
check_status "a norms value that is neither tool nor none is refused" 1 bash "$REC" review "$G" "$g1" --head ccc333 --norms manual
check "a refused review leaves the row as it was" "bbb2222|none|2" \
  "$(jq -r --argjson i "$g1" 'select(.id==$i)|[.review.head,.review.norms,.rounds]|join("|")' "$G")"
check_status "review without --head is an error" 1 bash "$REC" review "$G" "$g1" --norms tool
check_status "review without --norms is an error" 1 bash "$REC" review "$G" "$g1" --head ccc333
check_status "ready without --head is an error" 1 bash "$REC" ready "$G" "$g1"
check "and says the head is required" "1" "$(bash "$REC" ready "$G" "$g1" 2>&1 | grep -c 'ready: --head is required')"
check_status "review on an unknown row is an error" 1 bash "$REC" review "$G" 99 --head aaa1111 --norms tool
check_status "ready on an unknown row is an error" 1 bash "$REC" ready "$G" 99 --head aaa1111
check "and names the row it did not find" "1" "$(bash "$REC" ready "$G" 99 --head aaa1111 2>&1 | grep -c 'ready: no row with id 99')"
check_status "review on an unknown option is an error" 1 bash "$REC" review "$G" "$g1" --head ccc333 --norms tool --force
check_status "an unknown subcommand is an error" 1 bash "$REC" bogus "$G"
check "and names the subcommands it expects" "1" \
  "$(bash "$REC" bogus "$G" 2>&1 | grep -c 'unknown subcommand: bogus (expected open, round, review, fixed, ready, close, escaped or summary)')"

echo "== workspace =="

# A clone carries what git tracks and nothing else; the checkout is made WITH the
# project's local material or a session in it behaves like a stranger's (§30). The source
# is a repository this section makes: a fake origin, a local settings directory, an
# exclude file naming one file, a manifest naming a present and an absent file, and a
# build tree that must never travel.
WS="$ROOT/skills/orchestrator/scripts/workspace.sh"
SRC="$WORK/wsrc/proj"
mkdir -p "$SRC" && ( cd "$SRC" && git init -q -b main && git config user.email t@local && git config user.name t \
  && echo tracked > README.md && git add -A && git commit -q -m "Set up" \
  && git remote add origin git@example.invalid:owner/proj.git \
  && mkdir -p ./.claude/agents ./.claude/worktrees/w1 node_modules/dep && echo '{}' > ./.claude/settings.local.json \
  && echo a > ./.claude/agents/a.md && echo w > ./.claude/worktrees/w1/f \
  && printf '.env\nabsent.txt\n# a comment\n' > ./.claude/workspace-manifest \
  && echo local > LOCAL.md && printf 'LOCAL.md\n/.claude/\n**/.claude/worktrees/\n' > .git/info/exclude \
  && echo secret > .env && echo '.env' > .gitignore && echo dep > node_modules/dep/index.js \
  && git add .gitignore && git commit -q -m "Ignore the environment file" )
export ORCHESTRATOR_WORKSPACES="$WORK/wsroot"
# Isolated from the operator's own global git config: a real machine may have
# core.excludesFile set (§40), and every case below must control exactly what `create`
# sees there, never the operator's actual settings. A path that does not exist is an
# empty "global" scope to git.
export GIT_CONFIG_GLOBAL="$WORK/no-global-gitconfig"
out=$(bash "$WS" create "$SRC" phase-1 --base main 2>"$WORK/ws.err")
check "create prints the checkout path under the root" "$WORK/wsroot/proj/phase-1" "$out"
C="$WORK/wsroot/proj/phase-1"
check "the checkout is on the base branch at the source's head" "main|$(git -C "$SRC" rev-parse HEAD)" \
  "$(git -C "$C" rev-parse --abbrev-ref HEAD 2>/dev/null)|$(git -C "$C" rev-parse HEAD 2>/dev/null)"
check "origin is the source's origin, not the source" "git@example.invalid:owner/proj.git" \
  "$(git -C "$C" remote get-url origin 2>/dev/null)"
check "the local settings directory is copied" "a" "$(cat "$C/.claude/agents/a.md" 2>/dev/null)"

# Inside the settings directory, what the exclude file names does not travel — the host
# writes its runtime block there (worktrees, checkpoints) and a whole-directory copy once
# carried 4 GB of worktrees into a checkout meant to hold a phase (§35). A pattern naming
# the directory whole is set aside: it says the directory stays out of history, which every
# copied file already does.
check "what the exclude file names inside it does not" "0" "$([ -e "$C/.claude/worktrees" ] && echo 1 || echo 0)"

# The operator's own local permission rules (a squash-merge, an undraft, a pinned-lease
# push) are his session's, never an agent's: `settings.local.json` never travels into a
# checkout, whatever the source's exclude file says about it.
check "the operator's local permissions never travel into a checkout" "0" \
  "$([ -e "$C/.claude/settings.local.json" ] && echo 1 || echo 0)"
check "and the copy says what it skipped and withheld" "1" \
  "$(grep -c 'settings directory (2 files, 1 skipped by the exclude file, 1 withheld' "$WORK/ws.err")"

check "the exclude file's file is copied" "local" "$(cat "$C/LOCAL.md" 2>/dev/null)"
check "the manifest's present file is copied and the absent one is said" "secret|1" \
  "$(cat "$C/.env" 2>/dev/null)|$(grep -c 'missing: absent.txt' "$WORK/ws.err")"
check "the build tree does not travel" "ok" "$([ -d "$C/.git" ] && [ ! -e "$C/node_modules" ] && echo ok || echo bad)"
check "no global excludes configured: the stderr line reads 0" "1" \
  "$(grep -c 'copied 0 files kept out by the global excludes' "$WORK/ws.err")"
check_status "create on an existing target refuses" 1 bash "$WS" create "$SRC" phase-1
check "and leaves it intact" "local" "$(cat "$C/LOCAL.md" 2>/dev/null)"
( cd "$C" && git config user.email t@local && git config user.name t && echo more >> README.md && git commit -q -am "Local work" )
check "list shows the checkout, clean and unpushed" "1" "$(bash "$WS" list 2>/dev/null | grep -c "/proj/phase-1 | main | [0-9a-f]* | clean | unpushed$")"
check_status "delete refuses an unpushed commit" 1 bash "$WS" delete "$C"
check_status "delete refuses a path outside the root" 1 bash "$WS" delete "$SRC"
check "delete with --discard removes the checkout" "deleted|0" \
  "$(bash "$WS" delete "$C" --discard 2>/dev/null | cut -d' ' -f1)|$([ -e "$C" ] && echo 1 || echo 0)"

# A source whose local branch lags its remote hands the phase a stale base unless the base
# can name the remote's head (§35). The origin here is a bare repository the source pushed
# to, then advanced from elsewhere, so origin/main is one commit ahead of main on the source.
BARE="$WORK/wsrc/origin.git"; git init -q --bare "$BARE"
SRC2="$WORK/wsrc/proj2"
mkdir -p "$SRC2" && ( cd "$SRC2" && git init -q -b main && git config user.email t@local && git config user.name t \
  && git remote add origin "$BARE" && echo one > README.md && git add -A && git commit -q -m "One" \
  && git push -q -u origin main 2>/dev/null )
ELSE="$WORK/wsrc/elsewhere"
git clone -q -b main "$BARE" "$ELSE" 2>/dev/null && ( cd "$ELSE" && git config user.email t@local && git config user.name t \
  && echo two >> README.md && git commit -q -am "Two" && git push -q origin main 2>/dev/null )
( cd "$SRC2" && git fetch -q origin 2>/dev/null )
ahead=$(git -C "$SRC2" rev-parse origin/main)
out=$(bash "$WS" create "$SRC2" phase-2 --base origin/main 2>"$WORK/ws2.err")
C2="$WORK/wsroot/proj2/phase-2"
check "a remote-tracking base checks out that branch at the remote's head" "main|$ahead|1" \
  "$(git -C "$C2" rev-parse --abbrev-ref HEAD 2>/dev/null)|$(git -C "$C2" rev-parse HEAD 2>/dev/null)|$([ "$ahead" != "$(git -C "$SRC2" rev-parse main)" ] && echo 1 || echo 0)"
check "and tracks it on the real origin" "origin/main|$BARE" \
  "$(git -C "$C2" rev-parse --abbrev-ref 'main@{upstream}' 2>/dev/null)|$(git -C "$C2" remote get-url origin 2>/dev/null)"
check "list shows it clean and pushed" "1" "$(bash "$WS" list 2>/dev/null | grep -c "/proj2/phase-2 | main | [0-9a-f]* | clean | pushed$")"
check_status "a base the source does not know is refused" 1 bash "$WS" create "$SRC2" phase-3 --base nope
check "and makes no checkout" "0|0" \
  "$([ -e "$WORK/wsroot/proj2/phase-3" ] && echo 1 || echo 0)|$(bash "$WS" create "$SRC2" phase-3 --base upstream/main >/dev/null 2>&1; [ -e "$WORK/wsroot/proj2/phase-3" ] && echo 1 || echo 0)"
bash "$WS" delete "$C2" >/dev/null 2>&1

# A reader's copy is a detached worktree under the root (§37): the code at the head and
# nothing local, made and removed through git so the source forgets it.
P="$WORK/wsroot/proj/round-1"
out=$(bash "$WS" pin "$SRC" round-1 main 2>"$WORK/ws3.err")
check "pin prints the path under the root and makes a detached worktree at the ref" "$P|file|HEAD|$(git -C "$SRC" rev-parse main)" \
  "$out|$([ -f "$P/.git" ] && echo file || echo other)|$(git -C "$P" rev-parse --abbrev-ref HEAD 2>/dev/null)|$(git -C "$P" rev-parse HEAD 2>/dev/null)"
check "nothing local travels into a pin, the tracked file does" "ok" \
  "$([ ! -e "$P/.claude" ] && [ ! -e "$P/LOCAL.md" ] && [ -f "$P/README.md" ] && echo ok || echo bad)"
check "list shows the pin as pinned" "1" "$(bash "$WS" list 2>/dev/null | grep -c "/proj/round-1 | HEAD | [0-9a-f]* | clean | pinned$")"
check "pin refuses an unknown ref and an existing target" "1|1" \
  "$(bash "$WS" pin "$SRC" round-9 nope >/dev/null 2>&1; echo $?)|$(bash "$WS" pin "$SRC" round-1 main >/dev/null 2>&1; echo $?)"
echo dirty >> "$P/README.md"
check "delete refuses a dirty pin, --discard removes it and the source forgets it" "1|deleted|0|0" \
  "$(bash "$WS" delete "$P" >/dev/null 2>&1; echo $?)|$(bash "$WS" delete "$P" --discard 2>/dev/null | cut -d' ' -f1)|$([ -e "$P" ] && echo 1 || echo 0)|$(git -C "$SRC" worktree list | grep -c round-1)"
P2="$WORK/wsroot/proj/round-2"
bash "$WS" pin "$SRC" round-2 "$(git -C "$SRC" rev-parse main)" >/dev/null 2>&1
check "a pin by commit id deletes clean without --discard" "deleted|0" \
  "$(bash "$WS" delete "$P2" 2>/dev/null | cut -d' ' -f1)|$(git -C "$SRC" worktree list | grep -c round-2)"

# The operator's global excludes file (core.excludesFile) is local material too (§40): the
# project's own instruction file travelled by hand on every live round because it is kept
# out of history by the OPERATOR's global excludes, never the repository's own. The case
# points core.excludesFile at a global excludes file of ITS OWN, through GIT_CONFIG_GLOBAL
# scoped to this one invocation — the operator's real ~/.gitconfig is never read.
echo notes > "$SRC/NOTES.local.md"
echo plain > "$SRC/plain.txt"
printf 'NOTES.local.md\nLOCAL.md\n' > "$WORK/global-excludes-file"
printf '[core]\n\texcludesFile = %s\n' "$WORK/global-excludes-file" > "$WORK/global-gitconfig"
out=$(GIT_CONFIG_GLOBAL="$WORK/global-gitconfig" bash "$WS" create "$SRC" phase-ge --base main 2>"$WORK/wsge.err")
GE="$WORK/wsroot/proj/phase-ge"
check "a file ignored only by the global excludes is copied and reads clean" "notes|" \
  "$(cat "$GE/NOTES.local.md" 2>/dev/null)|$(git -C "$GE" status --porcelain 2>/dev/null)"
check "a file ignored by nothing is absent from the checkout" "0" "$([ -e "$GE/plain.txt" ] && echo 1 || echo 0)"
check "a path both the repository's and the global excludes ignore is copied once" "local|1" \
  "$(cat "$GE/LOCAL.md" 2>/dev/null)|$(grep -c 'copied 1 files kept out by the global excludes' "$WORK/wsge.err")"

unset ORCHESTRATOR_WORKSPACES GIT_CONFIG_GLOBAL

echo "== brief lint =="

# The largest category of multi-agent failure is specification, and a brief is this
# plugin's whole specification act. Two defects reached a live agent before anything
# checked the file: a path built from a host variable the agent's shell does not set, and
# a second session reference sitting beside the real one. Both are mechanical; both are
# caught here, before the dispatch rather than after the round.
LINT="$ROOT/skills/orchestrator/scripts/brief-lint.sh"
B="$WORK/briefs"; mkdir -p "$B"

ok_brief() {  # a brief with nothing wrong in it
  cat > "$1" <<BRIEF
# scratch — Phase 1: thing

You are the implementer for this phase.

## 1. Required reading

1. Spec: \`$WORK/briefs\`

## 3. Scope

Non-goals:

- Nothing outside this list.
- If you believe something outside this list is needed, STOP and ask the orchestrator first.

## 6. Communication

- Your orchestrator is the session **\`project-70 [a1b2c3]\`** and no other session.
- Every report ends with your measured context: run \`$ROOT/skills/context-gauge/scripts/context-gauge.sh\`.
BRIEF
}

ok_brief "$B/good.md"
check_status "a complete brief passes" 0 bash "$LINT" "$B/good.md"
check "a complete brief says so" "brief-lint: $B/good.md: 0 findings" "$(bash "$LINT" "$B/good.md" 2>&1)"

ok_brief "$B/placeholder.md"; printf 'Branch: {{BRANCH}}\n' >> "$B/placeholder.md"
check_status "an unfilled placeholder is a finding" 1 bash "$LINT" "$B/placeholder.md"
check "the unfilled placeholder is named" "1" "$(bash "$LINT" "$B/placeholder.md" 2>&1 | grep -c 'unfilled placeholder {{BRANCH}}')"

ok_brief "$B/hostvar.md"; printf 'Run `${CLAUDE_PLUGIN_ROOT}/x.sh`\n' >> "$B/hostvar.md"
check_status "an unexpanded variable is a finding" 1 bash "$LINT" "$B/hostvar.md"
check "the unexpanded variable is named" "1" "$(bash "$LINT" "$B/hostvar.md" 2>&1 | grep -c 'unexpanded variable')"

ok_brief "$B/badpath.md"; printf 'Read `/nowhere/at/all/spec.md`\n' >> "$B/badpath.md"
check_status "a path that does not exist is a finding" 1 bash "$LINT" "$B/badpath.md"
check "the missing path is named" "1" "$(bash "$LINT" "$B/badpath.md" 2>&1 | grep -c '/nowhere/at/all/spec.md')"

ok_brief "$B/twoaddr.md"; printf 'For example `other-12 [9f9f9f]`.\n' >> "$B/twoaddr.md"
check_status "a second session reference is a finding" 1 bash "$LINT" "$B/twoaddr.md"
check "the second address is named" "1" "$(bash "$LINT" "$B/twoaddr.md" 2>&1 | grep -c 'more than one session reference')"

printf '# nothing\n\nYou are the implementer for this phase.\n' > "$B/noaddr.md"
check_status "an implementer brief without an address is a finding" 1 bash "$LINT" "$B/noaddr.md"
check "the missing address is named" "1" "$(bash "$LINT" "$B/noaddr.md" 2>&1 | grep -c 'no orchestrator address')"
check "the missing STOP clause is named" "1" "$(bash "$LINT" "$B/noaddr.md" 2>&1 | grep -c 'no STOP-and-ask clause')"
check "the missing non-goals are named" "1" "$(bash "$LINT" "$B/noaddr.md" 2>&1 | grep -c 'no non-goals')"

# A review or rotation brief is not an implementer brief: it carries no non-goals list,
# and holding it to one would make the check noise nobody reads. What it IS held to is the
# line its report must end on: a round that never reports its norms check leaves the
# orchestrator nothing to record, and the readiness gate then refuses a head whose round did
# read it. The rule lived in prose on both sides of the round and was skipped twice in one
# day, so the brief is read for it before the dispatch rather than after.
review_brief() { printf '# round 2\n\nYou are the REVIEW agent for this round.\n\nYour orchestrator is `p-1 [a1b2c3]`.\n\nGauge: run `%s`.\n' "$ROOT/skills/context-gauge/scripts/context-gauge.sh" > "$1"; }

review_brief "$B/review.md"
printf 'End the report with `norms-check: tool <head>` or `norms-check: none <head>`.\n' >> "$B/review.md"
check_status "a review brief is not held to the implementer sections" 0 bash "$LINT" "$B/review.md"

review_brief "$B/review-nogate.md"
check_status "a review brief with no norms-check line is a finding" 1 bash "$LINT" "$B/review-nogate.md"
check "the missing report line is named" "1" "$(bash "$LINT" "$B/review-nogate.md" 2>&1 | grep -c 'norms-check:')"
check "an implementer brief is not held to it" "0" "$(bash "$LINT" "$B/good.md" 2>&1 | grep -c 'norms-check')"
check "the shipped review template raises no norms-check finding" "0" \
  "$(bash "$LINT" "$ROOT/templates/agent-review-brief.md" 2>&1 | grep -c 'norms-check')"

check_status "a brief that does not exist is an error" 1 bash "$LINT" "$B/absent.md"
check_status "no argument is an error" 1 bash "$LINT"

# An instruction to run something in the background, `run_in_background`, or a command
# ending in ` &` costs an agent its turn: the host never wakes it back up, and the work is
# picked up hours later by hand. A clause that FORBIDS it reads the opposite way and must
# raise nothing, including when the forbidding word sits on the very same line.
ok_brief "$B/bg-phrase.md"; printf 'Run the coverage suite in the background while you continue.\n' >> "$B/bg-phrase.md"
check_status "an instruction to run in the background is a finding" 1 bash "$LINT" "$B/bg-phrase.md"
check "the background instruction is named" "1" "$(bash "$LINT" "$B/bg-phrase.md" 2>&1 | grep -c 'background')"

ok_brief "$B/bg-token.md"; printf 'Pass run_in_background: true to the tool call.\n' >> "$B/bg-token.md"
check_status "the run_in_background token is a finding" 1 bash "$LINT" "$B/bg-token.md"
check "the token is named" "1" "$(bash "$LINT" "$B/bg-token.md" 2>&1 | grep -c 'run_in_background')"

ok_brief "$B/bg-amp.md"; printf 'Start it with `long-task.sh &` and move on.\n' >> "$B/bg-amp.md"
check_status "a command ending in an ampersand is a finding" 1 bash "$LINT" "$B/bg-amp.md"
check "the trailing ampersand is named" "1" "$(bash "$LINT" "$B/bg-amp.md" 2>&1 | grep -c 'ending in')"

ok_brief "$B/bg-fence.md"; printf '```\nlong-task.sh &\n```\n' >> "$B/bg-fence.md"
check_status "a fenced command ending in an ampersand is a finding" 1 bash "$LINT" "$B/bg-fence.md"

ok_brief "$B/bg-neg1.md"; printf 'Never run anything in the background.\n' >> "$B/bg-neg1.md"
check_status "a clause forbidding the background is not a finding" 0 bash "$LINT" "$B/bg-neg1.md"

ok_brief "$B/bg-neg2.md"; printf 'There is no background run allowed here.\n' >> "$B/bg-neg2.md"
check_status "a clause naming no background run is not a finding" 0 bash "$LINT" "$B/bg-neg2.md"

ok_brief "$B/bg-neg3.md"; printf 'Never end a command with `&`.\n' >> "$B/bg-neg3.md"
check_status "a clause naming a forbidden ampersand is not a finding" 0 bash "$LINT" "$B/bg-neg3.md"

ok_brief "$B/bg-neg4.md"; printf 'Never run `sleep 5 &` under any circumstance.\n' >> "$B/bg-neg4.md"
check_status "a forbidding word on the same line as the ampersand raises nothing" 0 bash "$LINT" "$B/bg-neg4.md"

# The forbidding word counts only inside the trigger's own clause, before it: a line that
# forbids one thing and then orders a background run is an order. And a tool parameter set
# to false is the very opposite of one.
ok_brief "$B/bg-clause.md"; printf 'Never skip tests; run the suite in the background.\n' >> "$B/bg-clause.md"
check_status "a negation in an earlier clause does not cancel the trigger" 1 bash "$LINT" "$B/bg-clause.md"
ok_brief "$B/bg-dont.md"; printf -- "- Don't run the suite in the background.\n" >> "$B/bg-dont.md"
check_status "don't forbids the background" 0 bash "$LINT" "$B/bg-dont.md"
ok_brief "$B/bg-donot.md"; printf -- '- Do not start the coverage run in the background, ever.\n' >> "$B/bg-donot.md"
check_status "do not forbids the background" 0 bash "$LINT" "$B/bg-donot.md"
ok_brief "$B/bg-false.md"; printf -- '- Every call carries `run_in_background: false`.\n- Or `run_in_background = false`.\n' >> "$B/bg-false.md"
check_status "run_in_background set to false is not a finding" 0 bash "$LINT" "$B/bg-false.md"
ok_brief "$B/bg-second.md"; printf 'Never run the lint in the background, and run the suite in the background.\n' >> "$B/bg-second.md"
check_status "a second trigger on a line is read in its own clause" 1 bash "$LINT" "$B/bg-second.md"

check "the shipped templates raise no background finding" "0" \
  "$(for t in "$ROOT"/templates/*.md; do bash "$LINT" "$t" 2>&1; done | grep -cE 'background|run_in_background|ending in')"

# An agent brief (implementer or review — the two classes the lint already tells apart;
# comments and rotation briefs carry no marker of their own and are left out) without an
# absolute, existing path to context-gauge.sh cannot measure context: self-estimates ran 13
# points high in observed runs. A host-expanded variable in its place is ALREADY a finding
# (check 2) — this must not double it.
nogauge_brief() {
  cat > "$1" <<BRIEF
# scratch — Phase 1: thing

You are the implementer for this phase.

## 1. Required reading

1. Spec: \`$WORK/briefs\`

## 3. Scope

Non-goals:

- Nothing outside this list.
- If you believe something outside this list is needed, STOP and ask the orchestrator first.

## 6. Communication

- Your orchestrator is the session **\`project-70 [a1b2c3]\`** and no other session.
BRIEF
}
nogauge_brief "$B/nogauge.md"
check_status "an agent brief without a gauge path is a finding" 1 bash "$LINT" "$B/nogauge.md"
check "the missing gauge path is named" "1" "$(bash "$LINT" "$B/nogauge.md" 2>&1 | grep -c 'context-gauge.sh')"

gaugevar_brief() {
  cat > "$1" <<BRIEF
# scratch — Phase 1: thing

You are the implementer for this phase.

## 1. Required reading

1. Spec: \`$WORK/briefs\`

## 3. Scope

Non-goals:

- Nothing outside this list.
- If you believe something outside this list is needed, STOP and ask the orchestrator first.

## 6. Communication

- Your orchestrator is the session **\`project-70 [a1b2c3]\`** and no other session.
- Every report ends with your measured context: run \`\${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/scripts/context-gauge.sh\`.
BRIEF
}
gaugevar_brief "$B/gaugevar.md"
check_status "a variable in place of the gauge path is a finding" 1 bash "$LINT" "$B/gaugevar.md"
check "exactly one finding fires for the variable gauge path, not two" "1" \
  "$(bash "$LINT" "$B/gaugevar.md" 2>&1 | grep -c "^$B/gaugevar.md:")"

check "a review brief without a gauge path is also a finding" "1" \
  "$(printf '# round 2\n\nYou are the REVIEW agent for this round.\n\nYour orchestrator is \`p-1 [a1b2c3]\`.\n' > "$B/review-nogauge.md"; bash "$LINT" "$B/review-nogauge.md" 2>&1 | grep -c 'context-gauge.sh')"

# The gauge rule holds for every class the lint can tell apart, comments and rotation
# included: both sessions report their own context like any other (suite ruling 2).
check "a comments brief without a gauge path is also a finding" "1" \
  "$(printf '# round\n\nYou are the COMMENTS agent for this round.\n\nYour orchestrator is \`p-1 [a1b2c3]\`.\n' > "$B/comments-nogauge.md"; bash "$LINT" "$B/comments-nogauge.md" 2>&1 | grep -c 'context-gauge.sh')"

check "a rotation brief without a gauge path is also a finding" "1" \
  "$(printf '# resume\n\nYou are the ROTATION agent, replacing a previous implementer.\n\nYour orchestrator is \`p-1 [a1b2c3]\`.\n' > "$B/rotation-nogauge.md"; bash "$LINT" "$B/rotation-nogauge.md" 2>&1 | grep -c 'context-gauge.sh')"

# Any line may carry the path: prose naming the tool before or after the line that cites it
# is no finding, in either order, and a path cited inside a non-goal clause is cited.
GAUGEABS="$ROOT/skills/context-gauge/scripts/context-gauge.sh"
nogauge_brief "$B/gauge-prose-first.md"
printf -- '- Measure with context-gauge.sh, never an estimate.\n- Run `%s`.\n' "$GAUGEABS" >> "$B/gauge-prose-first.md"
check_status "a prose mention before the cited path is no finding" 0 bash "$LINT" "$B/gauge-prose-first.md"
nogauge_brief "$B/gauge-prose-after.md"
printf -- '- Run `%s`.\n- context-gauge.sh is the only source of the figure.\n' "$GAUGEABS" >> "$B/gauge-prose-after.md"
check_status "a prose mention after the cited path is no finding" 0 bash "$LINT" "$B/gauge-prose-after.md"
nogauge_brief "$B/gauge-nongoal.md"
printf -- '- Non-goal: never estimate the context instead of running `%s`.\n' "$GAUGEABS" >> "$B/gauge-nongoal.md"
check_status "a path cited inside a non-goal clause counts as cited" 0 bash "$LINT" "$B/gauge-nongoal.md"
nogauge_brief "$B/gauge-prose-only.md"; printf -- '- Measure with context-gauge.sh.\n' >> "$B/gauge-prose-only.md"
check "prose alone still leaves the path uncited, named at its line" "1" \
  "$(bash "$LINT" "$B/gauge-prose-only.md" 2>&1 | grep -c 'is not cited by an absolute path')"

# The class is the role declared at the start of a line, not the phrase anywhere: a review
# brief or a memo that quotes an implementer brief is not one.
review_brief "$B/review-quotes.md"
printf 'End the report with `norms-check: tool <head>`.\nThe phase brief opens with "You are the implementer for this phase." and the agent obeyed it.\n' >> "$B/review-quotes.md"
check_status "a review brief quoting the implementer line gets no implementer finding" 0 bash "$LINT" "$B/review-quotes.md"
printf '# memo\nThe brief said "You are the implementer for this phase." inline, and You are the REVIEW agent too.\n' > "$B/memo.md"
check_status "a memo quoting role lines inline is no agent brief" 0 bash "$LINT" "$B/memo.md"

check "the shipped templates raise no new gauge-path finding" "0" \
  "$(for t in "$ROOT"/templates/*.md; do bash "$LINT" "$t" 2>&1; done | grep -cE 'no absolute, existing path to context-gauge\.sh|is not cited by an absolute path')"

echo "== iterm-agents: a name read from the process table is held to the shape (§48) =="
# `ps` hands back a flat command line: the quoting that made a name one argument is gone,
# and a launch that puts its prompt AFTER --name leaves a boundary nothing can recover.
# The launcher puts --name LAST for exactly that reason; a session launched otherwise is
# read as unreadable rather than given a name invented by where the words happened to stop.
# Observed: three sessions listed as « Agent : mock layer Read and execute /Users/…/BRIEF.md.
# Your orchestrator is … » — a whole brief in the column that says who a session is.
namefile="$WORK/ps-names.txt"
name_of() { printf '%s\n' "$2" > "$namefile"
  ORCHESTRATOR_PS_TABLE="$namefile" "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
n = ia.session_name_on('$1')
print('(unreadable)' if n == ia.UNREADABLE_NAME else (n or '(none)'))"; }

check "the launcher's own shape, --name last, reads back whole" "Agent : phase 2" \
  "$(name_of /dev/ttys901 '/dev/ttys901 /opt/x/claude --permission-mode auto --name Agent : phase 2')"
check "a name followed by another option stops at it" "Orch : plugin family" \
  "$(name_of /dev/ttys901 '/dev/ttys901 /opt/x/claude --name Orch : plugin family --permission-mode auto')"
check "a prompt run into the name is not reported as a name" "(unreadable)" \
  "$(name_of /dev/ttys901 '/dev/ttys901 /opt/x/claude --name Agent : mock layer Read and execute /Users/izno/BRIEF.md. Your orchestrator is Orch : TM frontend')"
check "a name under another convention is still read back whole" "steward-successor" \
  "$(name_of /dev/ttys901 '/dev/ttys901 /opt/x/claude --name steward-successor')"
check "and the older role word too, so the successor's refusal can quote it" "Orchestrator : f" \
  "$(name_of /dev/ttys901 '/dev/ttys901 /opt/x/claude --name Orchestrator : f --permission-mode auto')"
check "no --name at all stays no name" "(none)" \
  "$(name_of /dev/ttys901 '/dev/ttys901 /opt/x/claude --permission-mode auto')"
# The listing says WHICH of the two it is: a session launched without a name and a session
# whose name cannot be read are different facts, and an orchestrator acts differently on them.
check "the row marks a name it could not read, and does not call it a default" "(name unreadable)" \
  "$("$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
print(ia.row_for(1, 1, '/dev/ttys901', 'x', ia.UNREADABLE_NAME, False, False).split(' | ')[3])")"
check "and a row with no name at all still says host default" "(host default)" \
  "$("$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
print(ia.row_for(1, 1, '/dev/ttys901', 'x', None, False, False).split(' | ')[3])")"

echo "== rhythm =="

# `rhythm.sh` (§52): the figures an audit reads its rhythm from, generic and derived from git
# alone. The fixture repository is built by a script with fixed dates and line counts, and
# every expected figure below is written in that script's header.
RREPO="$WORK/rhythm-repo"
bash "$ROOT/tests/fixtures/rhythm-repo.sh" "$RREPO" >/dev/null 2>&1
RHYTHM="$ROOT/skills/orchestrator/scripts/rhythm.sh"
rhythm() { bash "$RHYTHM" "$@" 2>&1; }
ROUT=$(rhythm "$RREPO" --since 2026-08-10 --product 'design/src/**' --instrument 'scripts/**' --instrument 'tests/**' --register register.md)
check "merges per week, typed by the pull request's title" \
  "week feat fix chore docs ci build test refactor other total|2026-W33 1 1 0 1 0 0 0 0 0 3|2026-W34 1 0 0 0 1 0 1 0 1 4" \
  "$(printf '%s\n' "$ROUT" | grep -E '^(week feat |2026-W[0-9]+ [0-9])' | paste -sd'|' -)"
check "nothing before --since is counted" "0" "$(printf '%s\n' "$ROUT" | grep -c 'W32')"
check "feat commits per week count the merged branch's own" "feat 2026-W33 2|feat 2026-W34 1" \
  "$(printf '%s\n' "$ROUT" | grep -E '^feat 2026-W' | paste -sd'|' -)"
check "lines under the product's globs against the instruments'" "product +21 -1|instrument +27 -0" \
  "$(printf '%s\n' "$ROUT" | grep -E '^(product|instrument) \+' | sed 's/  *(.*$//' | paste -sd'|' -)"
# A glob's `*` crosses directories, as in git's own pathspecs: under the `:(glob)` magic it
# did not, and a product written `src/*.ts` counted the directory's top-level files only —
# measured on a real repository at +738 where git read +40936. The nested file decides it.
check "a glob's * crosses directories, and the output says so" "product +21 -1|1" \
  "$(rhythm "$RREPO" --since 2026-08-10 --product 'design/src/*.ts' | grep '^product +' | sed 's/  *(.*$//')|$(printf '%s\n' "$ROUT" | grep -c 'git pathspecs, where \* crosses directories')"
# A register that writes its statuses as code (`open` in backticks) read as zero open entries
# on a real one holding a hundred. The backticks are stripped; the match stays exact. And the
# header is read at EVERY table: fixed on a leading vocabulary table headed Status, the column
# stayed there and the index was compared on its identifiers — « 1 open (open) » for 102.
# A table whose FIRST column is Status is that vocabulary: its `open` row defines a status.
check "open register entries are read in the Status column, exactly, backticks or not" "register register.md: 3 open (B-1, B-3, B-5)" \
  "$(printf '%s\n' "$ROUT" | grep '^register ')"
check "and the latency git cannot measure is said, not pretended" "1" \
  "$(printf '%s\n' "$ROUT" | grep -c '^operator question latency: not measurable from git$')"
check "without globs or a register, those readings say so" "1|1|0" \
  "$(rhythm "$RREPO" --since 2026-08-10 | grep -c '^product: no --product glob given$')|$(rhythm "$RREPO" --since 2026-08-10 | grep -c '^instrument: no --instrument glob given$')|$(rhythm "$RREPO" --since 2026-08-10 | grep -c '^register ')"
check "no --since, or no repository, is refused" "1|1" \
  "$(rhythm "$RREPO" >/dev/null 2>&1; echo $?)|$(rhythm "$WORK/not-a-repo-at-all" --since 2026-08-10 >/dev/null 2>&1; echo $?)"
# A bare date means its midnight (issue #52). git completes `--since=2026-08-12` with the
# current time of day, so an audit run on the day of its scope read zero merges where there
# were five. git's clock is pinned (GIT_TEST_DATE_NOW, 23:00 UTC on the fixture's merge day)
# so that the reading does not depend on the hour the suite runs at.
rhythm_late() { TZ=UTC GIT_TEST_DATE_NOW=1786575600 bash "$RHYTHM" "$@" 2>&1; }
check "a bare --since on the day of the last merge counts that merge" "2026-W33 0 0 0 1 0 0 0 0 0 1|feat 2026-W33 1" \
  "$(rhythm_late "$RREPO" --since 2026-08-12 | grep -E '^(2026-W33 [0-9]|feat 2026-W33 )' | paste -sd'|' -)"
check "a date with a time is passed as given, and the header says what was read" "0|1|1" \
  "$(rhythm_late "$RREPO" --since 2026-08-12T13:00:00 | grep -c '^2026-W33 ')|$(rhythm_late "$RREPO" --since 2026-08-12 | grep -c 'since 2026-08-12T00:00:00$')|$(rhythm_late "$RREPO" --since 2026-08-12T13:00:00 | grep -c 'since 2026-08-12T13:00:00$')"
check "the usage says that a bare date is read from its midnight" "1" \
  "$(rhythm "$RREPO" --bogus x | grep -c 'a bare YYYY-MM-DD means its midnight')"

echo "== triggering set =="

# A skill's description is judged on the rate its triggering set measures, so a case that
# names no skill, or grades another skill than its name says, or a side left with too few
# queries, would let a description be rewritten on a rate that measures nothing. A case
# must also be one that can fail: a prompt to run, a deciding grader that reads a Skill
# call with one coherent bound, a floor under every no-trigger case (a run that errors
# loads no skill either), an arm on every grader (a Skill grader with none goes unscored
# under the default ablation), and a prompt that names nothing of this plugin.
trigger_set_drift() {  # <trigger dir> <skills dir>: one line per problem
  python3 - "$1" "$2" <<'PY'
import glob, os, re, sys

cases, skills_dir = sys.argv[1], sys.argv[2]
skills = sorted(d for d in os.listdir(skills_dir) if os.path.isfile(os.path.join(skills_dir, d, 'SKILL.md')))
scripts = sorted(os.path.basename(f) for f in glob.glob(os.path.join(skills_dir, '*', 'scripts', '*')) if os.path.isfile(f))
named = re.compile(r'(?<![\w-])(%s)(?![\w-])|orchestrator:|%s' % (
    '|'.join(map(re.escape, skills)), '|'.join(map(re.escape, scripts)) or '(?!)'), re.I)

def frontmatter(text):
    lines = text.splitlines()
    return lines[1:lines.index('---', 1)] if lines[:1] == ['---'] and '---' in lines[1:] else []

count = {(s, k): 0 for s in skills for k in ('trigger', 'no-trigger')}
for case in sorted(d for d in os.listdir(cases) if os.path.isdir(os.path.join(cases, d))):
    m = re.fullmatch(r'(.+?)-(no-trigger|trigger)-\d{2}', case)
    if not m or m.group(1) not in skills:
        print('unknown:' + case)
        continue
    skill, kind = m.groups()
    bound = 'min: 1' if kind == 'trigger' else 'max: 0'
    graders = [open(g).read() for g in glob.glob(os.path.join(cases, case, 'graders', '*.md'))]
    prompt = os.path.join(cases, case, 'prompt.md')
    if not os.path.isfile(prompt):
        print('prompt:' + case)
    elif named.search(open(prompt).read().split('\n---\n', 1)[-1]):
        print('names:' + case)
    heads = [frontmatter(g) for g in graders]
    if any('arm: both' not in h for h in heads):
        print('arm:' + case)
    if kind == 'no-trigger' and not any('type: llm' in h and 'focus: last_message' in h for h in heads):
        print('floor:' + case)
    pair = ['min: 1'] if kind == 'trigger' else ['min: 0', 'max: 0']
    for g, h in zip(graders, heads):
        if '(orchestrator:)?' + skill + '\\""' in g and not (
                'type: tool_used' in h and 'tool: Skill' in h
                and [l for l in h if l.startswith(('min:', 'max:'))] == pair):
            print('shape:' + case)
    if not any('(orchestrator:)?' + skill + '\\""' in g and bound in g.splitlines() for g in graders):
        print('grader:' + case)
        continue
    count[(skill, kind)] += 1
for (skill, kind), n in sorted(count.items()):
    if n < 6:
        print('few:%s:%s:%d' % (skill, kind, n))
PY
}
check "every triggering case names an existing skill and can fail, and each skill has six cases of each kind" "" \
  "$(trigger_set_drift "$ROOT/trigger-evals" "$ROOT/skills")"

TSET="$WORK/trigger-evals"
cp -R "$ROOT/trigger-evals" "$TSET"
rm -rf "$TSET/context-gauge-trigger-01"
cp -R "$TSET/orchestrator-trigger-01" "$TSET/no-such-skill-trigger-01"
sed 's/max: 0/max: 1/' "$ROOT/trigger-evals/model-routing-no-trigger-01/graders/skill-not-loaded.md" \
  > "$TSET/model-routing-no-trigger-01/graders/skill-not-loaded.md"
sed 's/)?iterm-agents/)?model-routing/' "$ROOT/trigger-evals/iterm-agents-trigger-01/graders/skill-loaded.md" \
  > "$TSET/iterm-agents-trigger-01/graders/skill-loaded.md"
check "a case naming no skill, a grader of the wrong skill or bound, and a short side are each named" \
  "few:context-gauge:trigger:5|few:iterm-agents:trigger:5|few:model-routing:no-trigger:5|grader:iterm-agents-trigger-01|grader:model-routing-no-trigger-01|shape:model-routing-no-trigger-01|unknown:no-such-skill-trigger-01" \
  "$(trigger_set_drift "$TSET" "$ROOT/skills" | sort | tr '\n' '|' | sed 's/|$//')"

# One planted defect per requirement a case must meet to be able to fail.
FSET="$WORK/trigger-evals-shape"
cp -R "$ROOT/trigger-evals" "$FSET"
rm "$FSET/orchestrator-trigger-02/prompt.md"
sed -i.bak 's/^type: tool_used$/type: regex/' "$FSET/iterm-agents-trigger-02/graders/skill-loaded.md"
sed -i.bak 's/^tool: Skill$/tool: Read/' "$FSET/context-gauge-trigger-03/graders/skill-loaded.md"
sed -i.bak 's/^min: 1$/min: 1\
max: 3/' "$FSET/model-routing-trigger-04/graders/skill-loaded.md"
sed -i.bak '/^min: 0$/d' "$FSET/orchestrator-no-trigger-02/graders/skill-not-loaded.md"
rm "$FSET/context-gauge-no-trigger-02/graders/answered.md"
sed -i.bak '/^arm: both$/d' "$FSET/iterm-agents-no-trigger-03/graders/answered.md"
sed -i.bak '/^arm: both$/d' "$FSET/model-routing-no-trigger-04/graders/skill-not-loaded.md"
printf 'Use the model-routing skill for this.\n' >> "$FSET/orchestrator-no-trigger-05/prompt.md"
printf 'Then run /orchestrator:status.\n' >> "$FSET/iterm-agents-trigger-06/prompt.md"
printf 'Run rhythm.sh first.\n' >> "$FSET/context-gauge-trigger-04/prompt.md"
find "$FSET" -name '*.bak' -delete
check "a missing prompt, a grader of the wrong type, tool or bounds, a missing floor or arm, and a prompt naming the plugin are each named" \
  "arm:iterm-agents-no-trigger-03|arm:model-routing-no-trigger-04|floor:context-gauge-no-trigger-02|names:context-gauge-trigger-04|names:iterm-agents-trigger-06|names:orchestrator-no-trigger-05|prompt:orchestrator-trigger-02|shape:context-gauge-trigger-03|shape:iterm-agents-trigger-02|shape:model-routing-trigger-04|shape:orchestrator-no-trigger-02" \
  "$(trigger_set_drift "$FSET" "$ROOT/skills" | sort | tr '\n' '|' | sed 's/|$//')"

echo "== design layout =="

# The design document opens with a tree of the repository. Nothing kept it honest, so it
# lost the hooks, three commands, two briefs and the test fixture while still reading as
# current to whoever opens it next, and it once named a grader deleted from evals/ that
# stayed in the block just as long — the exact shape of a directive that outlives what it
# described, either way. Two-way: every tracked file must appear in the block, and every
# file the block names must still be tracked. The plan and spec directories are excluded
# because they are workflow artifacts, not shipped layout.
layout_of() { awk '/^## 2\. Layout/{f=1; next} f&&/^```$/{c++; if(c==2) exit; next} f&&c==1' "$1"; }
layout_paths() {  # <design file>: one path per layout entry; "a, b" lists several, a path
                   # followed by prose (space-separated, no comma before it) names only one
  layout_of "$1" | awk 'NF==0{next} {
    n = split($0, parts, ", ")
    for (i = 1; i <= n; i++) {
      split(parts[i], w, /[ \t]+/)
      print w[1]
      if (parts[i] != w[1]) break
    }
  }'
}
layout_drift() {  # <design file> <tracked-files, one per line>: prints every mismatch, both ways
  local design=$1 tracked=$2 f layout
  layout=$(layout_of "$design")
  for f in $(printf '%s\n' "$tracked" | grep -vE '^docs/superpowers/|^LICENSE$|^\.gitignore$'); do
    printf '%s' "$layout" | grep -qF "$f" || echo "missing:$f"
  done
  for f in $(layout_paths "$design"); do
    printf '%s\n' "$tracked" | grep -qxF "$f" || echo "stale:$f"
  done
}
TRACKED_FILES=$(cd "$ROOT" && git ls-files)
check "the design's layout matches the tracked files, both ways" "" "$(layout_drift "$ROOT/docs/design.md" "$TRACKED_FILES")"

DLSTALE="$WORK/design-layout-stale.md"
{ printf '## 2. Layout\n\n```\n'; layout_of "$ROOT/docs/design.md"; printf 'evals/gone-007/graders/gone.md   a grader deleted from evals/\n```\n'; } > "$DLSTALE"
check "a layout line naming a file no longer tracked falls the check, and only that one" "1|0" \
  "$(layout_drift "$DLSTALE" "$TRACKED_FILES" | grep -c '^stale:evals/gone-007/graders/gone\.md$')|$(layout_drift "$DLSTALE" "$TRACKED_FILES" | grep -vc '^stale:evals/gone-007/graders/gone\.md$')"

echo "== documentation links =="

# The design points at the skills instead of restating them, so a pointer that dangles is a
# rule the reader can no longer reach, and it reads as current. Every relative link in the
# documents resolves: a markdown link, a backticked `path#anchor`, and a backticked
# repository path, with the « heading » or bold paragraph lead named after it. Paths are
# read from the repository root, the file's own directory or its parent, and a skill's
# `references/` from any skill.
dead_links() {  # <root> <markdown file>...: prints one line per dead relative link
  python3 - "$@" <<'PY'
import os, re, sys

root = sys.argv[1]
ROOTS = ('README.md', 'docs/', 'skills/', 'commands/', 'templates/', 'evals/', 'tests/', 'hooks/', 'references/')


def heads(path):
    out = []
    fence = False
    for line in open(path, encoding='utf-8'):
        if line.startswith('```'):
            fence = not fence
        elif not fence and re.match(r'#{1,6} ', line):
            out.append(line.lstrip('#').strip().strip('#').strip())
        elif not fence:
            # a paragraph's bold lead is a place a pointer may name too
            out += [t.rstrip('.') for t in re.findall(r'^\*\*([^*]+)\*\*', line.lstrip('-0123456789. '))]
    return out


def slug(text):
    text = re.sub(r'[^\w\- ]', '', text.lower().replace('`', ''))
    return text.replace(' ', '-')


def resolve(src, target):
    target = target.replace('${CLAUDE_PLUGIN_ROOT}/', '')
    here = os.path.dirname(src)
    bases = [root, here, os.path.dirname(here)]
    if target.startswith('references/'):
        # a skill's own reference, named from a command, a template or the design
        bases += sorted(os.path.join(root, 'skills', d) for d in os.listdir(os.path.join(root, 'skills')))
    for base in bases:
        cand = os.path.normpath(os.path.join(base, target))
        if os.path.exists(cand):
            return cand
    return None


for src in sys.argv[2:]:
    rel = os.path.relpath(src, root)
    fence = False
    for n, line in enumerate(open(src, encoding='utf-8'), 1):
        if line.startswith('```'):
            fence = not fence
            continue
        if fence:
            continue
        found = []
        for m in re.finditer(r'(?<!!)\[[^\]]*\]\(([^)\s]+)\)', line):
            t = m.group(1)
            if not re.match(r'[a-z]+:', t) and not t.startswith('#'):
                path, _, anchor = t.partition('#')
                found.append((path, anchor, None))
        for m in re.finditer(r'`([^`\s]+)`((?:,| in) « ([^»]+) »)?', line):
            t, heading = m.group(1), m.group(3)
            path, _, anchor = t.partition('#')
            if re.search(r'[*<>{}|]|\$(?!\{CLAUDE_PLUGIN_ROOT\})', path) or not path.replace('${CLAUDE_PLUGIN_ROOT}/', '').startswith(ROOTS):
                continue
            if not (anchor or '/' in path or path.endswith('.md')):
                continue
            found.append((path, anchor, heading))
        for path, anchor, heading in found:
            target = resolve(src, path)
            if target is None:
                print(f'{rel}:{n}: {path}: no such file')
                continue
            if (anchor or heading) and os.path.isfile(target) and target.endswith('.md'):
                hs = heads(target)
                if anchor and anchor not in [slug(h) for h in hs]:
                    print(f'{rel}:{n}: {path}#{anchor}: no such heading')
                if heading and heading not in hs:
                    print(f'{rel}:{n}: {path}: no heading « {heading} »')
PY
}
DOCFILES=()
while IFS= read -r f; do DOCFILES+=("$ROOT/$f"); done < <(cd "$ROOT" && git ls-files -- README.md 'docs/*.md' 'skills/*.md' 'commands/*.md' 'templates/*.md')
check "no dead relative link in the documents" "" "$(dead_links "$ROOT" "${DOCFILES[@]}")"
LK="$WORK/links"; mkdir -p "$LK/docs"
printf '# B heading\n\n**A lead.** Text.\n' > "$LK/docs/b.md"
printf '# A\n\nSee [b](b.md#b-heading), `docs/b.md`, « B heading », `docs/b.md`, « A lead ».\nSee [gone](gone.md), [c](b.md#c-heading), `docs/b.md`, « Nowhere », `docs/none.md`.\n' > "$LK/docs/a.md"
check "the link check names each planted dead link and passes the live ones" "4|0" \
  "$(dead_links "$LK" "$LK/docs/a.md" | grep -c ':4: ')|$(dead_links "$LK" "$LK/docs/a.md" | grep -c ':3: ')"

# The scripts, the commands and this suite cite the design's decisions by section number,
# so a section that leaves the design strands every citation of it. Each number cited
# outside docs/ names a `## N.` heading of the design; templates/ is not read, because a
# brief's own sections are numbered too and its citations name them.
uncited_sections() {  # <design> <file>...: prints every cited section the design lacks
  local design=$1 f n; shift
  for f in "$@"; do
    grep -oE '§ ?[0-9]+' "$f" 2>/dev/null | tr -dc '0-9\n' | sort -u | while read -r n; do
      grep -q "^## $n\. " "$design" || echo "${f#"$ROOT"/} §$n"
    done
  done
}
SECFILES=()
while IFS= read -r f; do SECFILES+=("$ROOT/$f"); done < <(cd "$ROOT" && git ls-files | grep -vE '^(docs|templates)/')
check "every section number cited outside docs/ names a section of the design" "" \
  "$(uncited_sections "$ROOT/docs/design.md" "${SECFILES[@]}")"
printf 'see \302\2472 and \302\24799\n' > "$WORK/cites.txt"
printf '## 2. Layout\n' > "$WORK/design-two.md"
check "the section check names a planted citation the design lacks, and only that one" "1|1" \
  "$(uncited_sections "$WORK/design-two.md" "$WORK/cites.txt" | wc -l | tr -d ' ')|$(uncited_sections "$WORK/design-two.md" "$WORK/cites.txt" | grep -c '99$')"

echo "== version =="

# The same fact lives in three fields. A branch cut from a stale main set the plugin
# manifest BACKWARDS over a release that was already tagged and already advertised by the
# marketplace file, and nothing said a word: one file offered 0.6.1 while the other
# claimed 0.6.0.
pv=$(jq -r .version "$ROOT/.claude-plugin/plugin.json")
mv1=$(jq -r .metadata.version "$ROOT/.claude-plugin/marketplace.json")
mv2=$(jq -r '.plugins[0].version' "$ROOT/.claude-plugin/marketplace.json")
check "the two manifests agree on the version" "$pv|$pv" "$mv1|$mv2"

# ...and it must never fall BEHIND what is already published. Equal is the state of a
# freshly tagged release and ahead is the state of unreleased work: both are correct, and
# a guard demanding "strictly ahead" turns the suite red the moment the repository's own
# release procedure is followed. Only behind is the defect.
version_not_behind() {  # <version> <newest tag, empty when none>
  if [ -z "$2" ] || [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; then
    echo yes
  else
    echo "no ($1 is behind $2)"
  fi
}
# The comparison is proved on every state, not only on today's, so the rule holds when
# today's state changes.
check "a version ahead of the newest tag passes" "yes" "$(version_not_behind 0.7.0 0.6.1)"
check "a version equal to the newest tag passes" "yes" "$(version_not_behind 0.6.1 0.6.1)"
check "a version behind the newest tag fails" "no (0.6.0 is behind 0.6.1)" "$(version_not_behind 0.6.0 0.6.1)"
check "a double-digit version is compared as a number" "yes" "$(version_not_behind 0.10.0 0.9.0)"
check "no tags at all passes" "yes" "$(version_not_behind 0.1.0 "")"
# Both prefixes count. The first three releases were tagged `claude-orchestrator--v`
# before the plugin was renamed, and a pattern anchored on the short one cannot see them:
# a guard reading two thirds of the release history is one more guard that reads less
# than it claims.
newest_of() { printf '%s\n' "$@" | sed 's/^.*--v//' | sort -V | tail -1; }
check "the newest release is read across both historical prefixes" "0.7.0" \
  "$(newest_of claude-orchestrator--v0.1.2 orchestrator--v0.6.1 orchestrator--v0.7.0)"
check "a release under the old prefix is not invisible" "0.1.2" \
  "$(newest_of claude-orchestrator--v0.1.0 claude-orchestrator--v0.1.2)"
# Tags are local, so a clone without them reads as "no tags" and passes, rather than
# holding the suite on a fact it cannot read.
newest=$(cd "$ROOT" && git tag --list '*orchestrator--v*' 2>/dev/null | sed 's/^.*--v//' | sort -V | tail -1)
check "the version is not behind any published tag" "yes" "$(version_not_behind "$pv" "$newest")"

echo "== iterm-agents spawn (dry run) =="
# The prompt is never typed into the shell: a 3 000-character prompt with non-ASCII
# bytes, quotes and a backslash goes to a file byte for byte, the typed command stays
# short and reads that file, and none of it depends on the locale — the first launch
# with an inline prompt was truncated by AppleScript and never ran, and a `sed`
# under LC_ALL=C died on an em dash.
AGENT="$ROOT/skills/iterm-agents/scripts/iterm-agent.sh"
ISTATE="$WORK/istate"
long=$(printf 'x%.0s' $(seq 1 3000))
prompt="Read « this » — é \"quoted\" back\\slash $long"
out=$(LC_ALL=C ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : B-1 — é" --prompt "$prompt" 2>&1)
code=$?
check "dry-run spawn under LC_ALL=C exits 0" "0" "$code"
cmd=${out#*launch=}; cmd=${cmd%%$'\n'*}
file=${out#*prompt_file=}; file=${file%%$'\n'*}
check "the launch stays short whatever the prompt" "short" "$([ "${#cmd}" -lt 500 ] && echo short || echo "${#cmd} chars typed")"
check "the launch reads the prompt from its file" "1" "$(printf '%s' "$cmd" | grep -c '"\$(cat ')"
# The dry run names the file and writes none; the writer is driven directly for the bytes.
check "the prompt file holds the prompt byte for byte" "$prompt" \
  "$(LC_ALL=C ORCHESTRATOR_STATE_DIR="$ISTATE" "$(command -v python3)" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
print(open(ia.write_prompt_file(sys.argv[1], sys.argv[2]), encoding='utf-8').read(), end='')" "$prompt" "Agent : B-1 — é")"
check "the prompt file lives under the state directory" "yes" "$([ "${file#"$ISTATE"/prompts/}" != "$file" ] && echo yes || echo "$file")"
# §45: the prompt file carries its kind in its name, so the three files a launch leaves
# under prompts/ sort by kind like the two already did.
check "the prompt file's name carries its kind" "1" "$(basename "$file" | grep -c '^prompt-')"
check "the launch carries the decision mode" "1" "$(printf '%s' "$cmd" | grep -c -- '--permission-mode auto')"
check "no tier and no map: no model argument" "0" "$(printf '%s' "$cmd" | grep -c -- '--model')"
check "the launch changes into the working directory" "1" "$(printf '%s' "$cmd" | grep -c "^cd $WORK && ")"
# Every spawn marks the session as launcher-spawned: the push-guard hook is active only
# where this is set, and the operator's own sessions never carry it (phase 3 ruling 5).
check "the launch marks the session launcher-spawned" "1" "$(printf '%s' "$out" | grep -c 'export ORCHESTRATOR_SPAWNED=1')"
# Named absolutely even though the tab now runs a login shell: a dotfile that breaks PATH
# must not be able to kill the launch, and the session dies before its tty can be read
# when the name does not resolve.
check "the launch execs the CLI by absolute path" "1" "$(printf '%s' "$cmd" | grep -cE 'exec /[^ ]+/')"
# The tab runs the launch through a LOGIN shell, so the session inherits the operator's
# PATH — the package manager's binaries included — rather than the app's bare default.
# Observed: no spawned session could run `gh`, so none could open a pull request. The CLI
# is still named absolutely inside the launch: finding the program must not depend on the
# operator's dotfiles, only the session's environment does.
check "the tab runs the launch through a login shell" "1" "$(printf '%s' "$out" | grep -c '^program=.* -l <launch-file>$')"
check "the login shell is the operator's" "1" "$(env ORCHESTRATOR_LOGIN_SHELL=/bin/bash ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : shell" --prompt p 2>&1 | grep -c '^program=/bin/bash -l ')"
check "the launch text itself is unchanged by the shell" "1" "$(env ORCHESTRATOR_LOGIN_SHELL=/bin/bash ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : shell" --prompt p 2>&1 | sed -n 's/^launch=//p' | grep -cE '^cd .* && .* && exec /[^ ]+/')"

# The title is the session's NAME, not a tab label the shell overwrites: two sessions in one
# checkout otherwise share the host's stem and differ by a reference nobody reads at a
# glance (observed: an implementer listed under its orchestrator's own name). Non-ASCII
# bytes travel like the prompt does — quoted by the shell's own rules.
check "the launch names the session after its title" "1" "$(printf '%s' "$cmd" | grep -c -- "--name 'Agent : B-1 — é'")"
# The title is the operator's format and the launcher holds every spawn to it: a successor
# once came up as `steward-successor` in every listing, because the launcher took whatever
# was typed and the house format was nowhere (§39). The name is SHORT and it has two roles
# (§42): `Orch : <subject>` for an orchestrator and its successor, `Agent : <subject>` for
# anything an orchestrator spawns, the subject at most twenty-five characters — the
# operator read his window and could not tell one agent from another at a glance.
# `--title-free` is the escape for a probe that names its tab otherwise, and the dry run
# says when it is on.
shaped() {
  case " $* " in
    *" --prompt "*|*" --prompt-file "*) set -- "$@" ;;
    *) set -- --prompt p "$@" ;;
  esac
  ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" "$@" 2>&1
}
check "a shaped title names the session" "1" \
  "$(shaped --title 'Agent : x' | sed -n 's/^launch=//p' | grep -c -- "--name 'Agent : x'")"
check "and so does an orchestrator's" "1" \
  "$(shaped --title 'Orch : x' | sed -n 's/^launch=//p' | grep -c -- "--name 'Orch : x'")"
check "and so does a probe's" "1" \
  "$(shaped --title 'Agent : anchor' | sed -n 's/^launch=//p' | grep -c -- "--name 'Agent : anchor'")"
check "the dry run says which name it passes" "1" "$(shaped --title 'Agent : anchor' | grep -c '^name=Agent : anchor$')"
check "a title without the shape is refused, and the reason names the shape and the cap" "1|1" \
  "$(shaped --title foo >/dev/null 2>&1; echo $?)|$(shaped --title foo | grep -c 'a title reads "Orch : <subject>" or "Agent : <subject>", the subject at most 25 characters and neither starting nor ending with a space, got .foo.')"
# The older roles are the ones the operator could not read, so they are refused like any
# other unshaped title: the spelled-out role words are gone from the launcher, not merely
# from the documents.
check "an older role is refused too" "1|1" \
  "$(shaped --title 'Implementer : x' >/dev/null 2>&1; echo $?)|$(shaped --title 'Reviewer : 1' >/dev/null 2>&1; echo $?)"
# The cap is on the SUBJECT, which is what a listing shows beside every other name.
D42SUB25=$(printf 'x%.0s' $(seq 1 25))
D42SUB26=$(printf 'x%.0s' $(seq 1 26))
check "a subject of 25 characters is accepted, of 26 refused" "1|1" \
  "$(shaped --title "Agent : $D42SUB25" | sed -n 's/^launch=//p' | grep -c -- "--name 'Agent : $D42SUB25'")|$(shaped --title "Agent : $D42SUB26" >/dev/null 2>&1; echo $?)"
# §45: a subject neither starts nor ends on a space — a listing then shows a name that
# reads as empty, or one the operator cannot tell from its trimmed twin. Spaces inside the
# subject stay allowed, and the cap is unchanged.
check "a subject that is a single space is refused, and the reason names the space rule" "1|1" \
  "$(shaped --title 'Agent :  ' >/dev/null 2>&1; echo $?)|$(shaped --title 'Agent :  ' | grep -c 'neither starting nor ending with a space')"
check "a subject ending on a space is refused" "1|1" \
  "$(shaped --title 'Agent : x ' >/dev/null 2>&1; echo $?)|$(shaped --title 'Agent : x ' | grep -c 'neither starting nor ending with a space')"
check "a subject starting on a space is refused" "1|1" \
  "$(shaped --title 'Agent :  x' >/dev/null 2>&1; echo $?)|$(shaped --title 'Agent :  x' | grep -c 'neither starting nor ending with a space')"
check "a space inside the subject stays allowed" "1" \
  "$(shaped --title 'Agent : x y' | sed -n 's/^launch=//p' | grep -c -- "--name 'Agent : x y'")"
# A name is one line. The shape's end anchor also matches BEFORE a trailing newline in this
# language, so `Agent : x` followed by one passed it — and the guard the older code spent on
# a newline in a derived name was retired with that code, leaving nothing behind it. The
# title is written into the launch and read back out of the process table: a second line
# there is not a name, it is whatever follows one.
D42NL="Agent : x
"
check "a title carrying a trailing newline is refused" "1|1" \
  "$(shaped --title "$D42NL" >/dev/null 2>&1; echo $?)|$(shaped --title "$D42NL" | grep -c 'a title reads')"
check "the old default title is refused too" "1|1" \
  "$(shaped --title agent >/dev/null 2>&1; echo $?)|$(shaped --title agent | grep -c 'a title reads')"
check "no title: refused unless --title-free" "1|1" \
  "$(shaped >/dev/null 2>&1; echo $?)|$(shaped | grep -c "got ''")"
check "--title-free lets an unshaped title through, and says so" "1|1" \
  "$(shaped --title-free --title foo | sed -n 's/^launch=//p' | grep -c -- '--name foo')|$(shaped --title-free --title foo | grep -c '^title_free=yes$')"
check "--title-free with no title keeps the old default" "1" \
  "$(shaped --title-free | sed -n 's/^launch=//p' | grep -c -- '--name agent')"

# A value that starts with a dash reads as an option once past shq's "safe characters"
# gate — `--title-free --title=--evil` emitted `--name --evil` bare, and the host read
# `--evil` as its own option instead of the name's value. The value is force-quoted.
check "a dashed value is quoted, not read as an option" "1" \
  "$(shaped --title-free --title=--evil | sed -n 's/^launch=//p' | grep -c -- "--name '--evil'")"
check "a shaped title still reads as today" "1" \
  "$(shaped --title 'Agent : x' | sed -n 's/^launch=//p' | grep -c -- "--name 'Agent : x'")"

# `%r` renders a title with an apostrophe wrapped in double quotes instead of single ones,
# so the refusal's own literal quoting shifted with what the operator typed. `got '<title>'`
# is now the sentence whatever the title holds.
D5TITLE="it's not shaped"
check "the shape refusal always quotes with single quotes" "1" \
  "$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "$D5TITLE" --prompt p 2>&1 | grep -c "got '$D5TITLE'")"

# An agent's servers are CHOSEN, from a catalogue the operator owns (§42). Every launch
# used to carry the setting that enables all of the project's servers, so a fresh session
# never parked on the host's question about them; measured, that loaded a browser driver
# and a devtools bridge into every agent, about seventy megabytes each, used by none. The
# first answer — the strict flag on every launch, an all-or-nothing flag to put the setting
# back — was measured before it shipped and did not hold either: the setting never governed
# those two processes, and the strict flag drops every server of EVERY scope, so an agent
# under it had neither a documentation server nor a connector whatever its brief needed.
# So the launch is strict AND carries a configuration file written for that session, from
# named definitions the operator keeps in the catalogue with a default set.
CAT="$WORK/mcp-catalogue.json"
printf '{"servers":{"a":{"command":"a-cmd"},"b":{"command":"b-cmd"}},"default":["a"]}\n' > "$CAT"
NOCAT="$WORK/mcp-absent.json"; rm -f "$NOCAT"
mcpd() {
  case " $* " in
    *" --prompt "*|*" --prompt-file "*) set -- "$@" ;;
    *) set -- --prompt p "$@" ;;
  esac
  ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MCP_CATALOGUE="$CAT" \
  bash "$AGENT" spawn --dir "$WORK" --title 'Agent : x' "$@" 2>&1
}
nocat() {
  case " $* " in
    *" --prompt "*|*" --prompt-file "*) set -- "$@" ;;
    *) set -- --prompt p "$@" ;;
  esac
  ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MCP_CATALOGUE="$NOCAT" \
  bash "$AGENT" spawn --dir "$WORK" --title 'Agent : x' "$@" 2>&1
}
# The file the launch names is read back, not assumed: the launch line says a path, the
# content says which servers the session will actually load.
# A dry run writes no file, so the definitions a real launch would write are produced by
# the same writer, driven directly with the same catalogue and the same names.
mcp_keys() { ORCHESTRATOR_STATE_DIR="$WORK/mcp-written" ORCHESTRATOR_MCP_CATALOGUE="$CAT" "$py" -c "
import json, sys
sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
cat = ia.read_catalogue()
path = ia.write_mcp_file(ia.select_servers(sys.argv[1:], cat), cat, 'x')
print(','.join(json.load(open(path))['mcpServers'].keys()))" "$@"; }
mcp_file_of() { printf '%s' "$1" | sed -n 's/^mcp_file=//p'; }

check "the default set is loaded, from a file the launch names" "1|1|a|a" \
  "$(mcpd | sed -n 's/^launch=//p' | grep -c -- '--strict-mcp-config')|$(mcpd | sed -n 's/^launch=//p' | grep -c -- '--mcp-config ')|$(mcpd | sed -n 's/^mcp=//p')|$(mcp_keys)"
check "--mcp adds a catalogued server for the agent that needs it" "a,b|a,b" \
  "$(mcpd --mcp b | sed -n 's/^mcp=//p')|$(mcp_keys b)"
check "several names travel comma-separated or as repeated options, each once" "a,b|a,b|a,b|a,b" \
  "$(mcpd --mcp a,b | sed -n 's/^mcp=//p')|$(mcp_keys a,b)|$(mcpd --mcp a --mcp b | sed -n 's/^mcp=//p')|$(mcp_keys a b)"
check "--mcp none loads nothing, and writes no file" "none|none|0" \
  "$(mcpd --mcp none | sed -n 's/^mcp=//p')|$(mcpd --mcp none | sed -n 's/^mcp_file=//p')|$(mcpd --mcp none | sed -n 's/^launch=//p' | grep -c -- '--mcp-config')"
check "--mcp none among others still loads nothing" "none" \
  "$(mcpd --mcp b --mcp none | sed -n 's/^mcp=//p')"
# Asked for nothing, so nothing is needed to give it: `none` needs no catalogue, and says
# nothing on stderr either — that line is for a caller who said nothing at all.
check "--mcp none needs no catalogue, and says nothing" "0|0|none|" \
  "$(nocat --mcp none >/dev/null 2>&1; echo $?)|$(nocat --mcp none | sed -n 's/^launch=//p' | grep -c -- '--mcp-config')|$(nocat --mcp none | sed -n 's/^mcp=//p')|$(nocat --mcp none | grep 'no server catalogue' || true)"
# A name the catalogue does not hold is a typo or a server the operator has not written
# yet; either way the agent would come up without it and nobody would know until it
# reached for a tool. Refused before a tab exists, with the names there are.
check "a name the catalogue does not hold is refused, with the names it does" "1|1" \
  "$(mcpd --mcp c >/dev/null 2>&1; echo $?)|$(mcpd --mcp c | grep -c -- "--mcp 'c' is not in the catalogue $CAT (names: a, b)")"
check "--mcp with no catalogue is refused, and names the installer" "1|1" \
  "$(nocat --mcp b >/dev/null 2>&1; echo $?)|$(nocat --mcp b | grep -c -- "--mcp needs a server catalogue at $NOCAT; the installer creates one")"
# No catalogue and nothing asked is not a refusal: the launch is strict and loads nothing,
# which is what a machine without a catalogue can honestly give. It says so on stderr.
check "no catalogue and no --mcp: strict, no file, and a line on stderr" "1|0|none|1" \
  "$(nocat | sed -n 's/^launch=//p' | grep -c -- '--strict-mcp-config')|$(nocat | sed -n 's/^launch=//p' | grep -c -- '--mcp-config')|$(nocat | sed -n 's/^mcp=//p')|$(nocat | grep -c "^spawn: no server catalogue at $NOCAT: the session loads no server$")"
# A catalogue that does not read as one is not an empty catalogue: reading the two alike
# would send every agent out with no server while the caller believes it named some — the
# same reasoning the tier map's own refusal was written on.
BADCAT="$WORK/mcp-bad.json"; printf '["a","b"]\n' > "$BADCAT"
check "a catalogue that is not one is refused, and the refusal names the shape" "1|1" \
  "$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MCP_CATALOGUE="$BADCAT" bash "$AGENT" spawn --dir "$WORK" --title 'Agent : x' --prompt p >/dev/null 2>&1; echo $?)|$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MCP_CATALOGUE="$BADCAT" bash "$AGENT" spawn --dir "$WORK" --title 'Agent : x' --prompt p 2>&1 | grep -c -- "$BADCAT does not read as a server catalogue (a \"servers\" object and a \"default\" list)")"
# A default naming a server the catalogue does not hold is not caught by the shape check
# above (both fields still read as an object and a list): the launch would silently drop
# the unknown name and give the agent a set the operator never wrote. Refused instead, and
# a catalogue whose default names only held servers is unaffected.
BADDEF="$WORK/mcp-bad-default.json"
printf '{"servers":{"a":{"command":"a-cmd"}},"default":["a","zzz"]}\n' > "$BADDEF"
check "a default name absent from servers is refused; one fully held still launches" "1|1|1" \
  "$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MCP_CATALOGUE="$BADDEF" bash "$AGENT" spawn --dir "$WORK" --mcp a --title 'Agent : x' --prompt p >/dev/null 2>&1; echo $?)|$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MCP_CATALOGUE="$BADDEF" bash "$AGENT" spawn --dir "$WORK" --mcp a --title 'Agent : x' --prompt p 2>&1 | grep -c -- "the catalogue $BADDEF lists 'zzz' in default but not in servers")|$(mcpd | sed -n 's/^launch=//p' | grep -c -- '--mcp-config ')"
# Every asked name is checked against the catalogue BEFORE `none` short-circuits the
# selection: a typo beside `none` used to select nothing and say nothing, which is how a
# caller who mistyped one name among several would never learn it.
check "typo,none is refused naming typo; a,none still selects nothing" "1|1|none" \
  "$(mcpd --mcp typo,none >/dev/null 2>&1; echo $?)|$(mcpd --mcp typo,none | grep -c -- "--mcp 'typo' is not in the catalogue $CAT (names: a, b)")|$(mcpd --mcp a,none | sed -n 's/^mcp=//p')"
# The host's --mcp-config takes SEVERAL values, so whatever follows it is read as another
# file: the prompt placed there was read as one (« MCP config file not found: <the
# prompt> »). The pair is closed by --permission-mode, which takes exactly one.
check "the server file is followed by the decision mode, never by the prompt" "1|0" \
  "$(mcpd --prompt p | sed -n 's/^launch=//p' | grep -cE -- '--mcp-config [^ ]+ --permission-mode ')|$(mcpd --prompt p | sed -n 's/^launch=//p' | grep -c -- 'enableAllProjectMcpServers')"
check "the setting that enabled every project server is in no launch" "0|0|0" \
  "$(mcpd | sed -n 's/^launch=//p' | grep -c -- 'enableAllProjectMcpServers')|$(mcpd --mcp b | sed -n 's/^launch=//p' | grep -c -- 'enableAllProjectMcpServers')|$(nocat | sed -n 's/^launch=//p' | grep -c -- 'enableAllProjectMcpServers')"
# The file is written under the state directory, beside the prompt file and named like it.
check "the server file lives beside the prompt file, named like it" "yes|yes" \
  "$(f=$(mcp_file_of "$(mcpd)"); [ "${f#"$ISTATE"/prompts/mcp-}" != "$f" ] && echo yes || echo "$f")|$(f=$(mcp_file_of "$(mcpd)"); [ "${f%.json}" != "$f" ] && echo yes || echo "$f")"

# A successor carries the PREDECESSOR's name, read from the process table, and comes up
# under remote control: the operator drives his orchestrators from the host's remote
# client as well as from the tab, and an agent is driven by its orchestrator alone (§39).
# The table is a file here; a live run reads `ps`.
PSTAB="$WORK/ps-table.txt"
printf '/dev/ttys900 /opt/x/host --name Orch : f --permission-mode auto\n' > "$PSTAB"
PSNONAME="$WORK/ps-noname.txt"
printf '/dev/ttys900 /opt/x/host --permission-mode auto\n' > "$PSNONAME"
succ() {
  local t="$1"; shift
  case " $* " in
    *" --prompt "*|*" --prompt-file "*) set -- "$@" ;;
    *) set -- --prompt p "$@" ;;
  esac
  ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_PS_TABLE="$t" bash "$AGENT" spawn --dir "$WORK" "$@" 2>&1
}
check "a successor with no title takes the caller's session name" "1" \
  "$(succ "$PSTAB" --successor | sed -n 's/^launch=//p' | grep -c -- "--name 'Orch : f'")"
check "and comes up under remote control, under that name" "1" \
  "$(succ "$PSTAB" --successor | sed -n 's/^launch=//p' | grep -c -- "--remote-control 'Orch : f'")"
check "--no-remote-control drops the flag and keeps the name" "0|1" \
  "$(succ "$PSTAB" --successor --no-remote-control | sed -n 's/^launch=//p' | grep -c -- '--remote-control')|$(succ "$PSTAB" --successor --no-remote-control | sed -n 's/^launch=//p' | grep -c -- "--name 'Orch : f'")"
check "a plain spawn never carries remote control" "0" \
  "$(shaped --title 'Agent : x' | sed -n 's/^launch=//p' | grep -c -- '--remote-control')"
# The host starts remote control for every new session by default (a server-side rollout
# decides when nothing is set). An agent is driven by its orchestrator alone, so it comes
# up with the setting that turns that default off; only a successor carries the flag
# instead, never both.
check "a plain spawn carries the setting off, and no --remote-control" "1|0" \
  "$(shaped --title 'Agent : x' | sed -n 's/^launch=//p' | grep -c -- '--settings '\''{\"remoteControlAtStartup\":false}'\''')|$(shaped --title 'Agent : x' | sed -n 's/^launch=//p' | grep -c -- '--remote-control')"
check "a successor carries the flag, and not the setting" "1|0" \
  "$(succ "$PSTAB" --successor | sed -n 's/^launch=//p' | grep -c -- "--remote-control 'Orch : f'")|$(succ "$PSTAB" --successor | sed -n 's/^launch=//p' | grep -c -- '--settings')"
check "--successor --no-remote-control carries the setting" "1" \
  "$(succ "$PSTAB" --successor --no-remote-control | sed -n 's/^launch=//p' | grep -c -- '--settings '\''{\"remoteControlAtStartup\":false}'\''')"
check "a caller launched without a name cannot derive one" "1|1" \
  "$(succ "$PSNONAME" --successor >/dev/null 2>&1; echo $?)|$(succ "$PSNONAME" --successor | grep -c "needs the caller's session name")"
# The derived name is held to the SAME shape as a typed one (§42), which retires the
# length guard that stood here: a caller that the OLDER launcher named carries the prompt
# in its own process line, so the derivation copied a launch line instead of a name —
# measured live at 366 characters — and a caller named under the older convention
# (a role word spelled out in full) derives nothing either. Both are refused by the shape,
# and the refusal quotes the first forty characters: a launch line must not fill a terminal.
PSLONG="$WORK/ps-long.txt"
printf '/dev/ttys900 /opt/x/host --name Orchestrator : %s --permission-mode auto\n' "$(printf 'x%.0s' $(seq 1 185))" > "$PSLONG"
PSOLD="$WORK/ps-old.txt"
printf '/dev/ttys900 /opt/x/host --name Orchestrator : f --permission-mode auto\n' > "$PSOLD"
PSSHORT="$WORK/ps-short.txt"
printf '/dev/ttys900 /opt/x/host --name Orch : %s --permission-mode auto\n' "$(printf 'x%.0s' $(seq 1 25))" > "$PSSHORT"
PSLONGSUB="$WORK/ps-long-subject.txt"
printf '/dev/ttys900 /opt/x/host --name Orch : %s --permission-mode auto\n' "$(printf 'x%.0s' $(seq 1 26))" > "$PSLONGSUB"
# §39 changed this refusal's WORDS and not its verdict: a launch line is past anything a
# name can be, so it is not read back as one at all, and « does not read Orch : <subject> »
# was saying the wrong thing about a string nobody could read in the first place.
check "a derived name that is a launch line is refused as unreadable" "1|1" \
  "$(succ "$PSLONG" --successor >/dev/null 2>&1; echo $?)|$(succ "$PSLONG" --successor | grep -c "session name cannot be read from the process table")"
check "a caller named under the older convention derives nothing" "1|1" \
  "$(succ "$PSOLD" --successor >/dev/null 2>&1; echo $?)|$(succ "$PSOLD" --successor | grep -c "the caller's session name 'Orchestrator : f' does not read .Orch : <subject>.; pass --title .Orch : <subject>.")"
check "a derived subject of 25 characters still derives, of 26 is refused" "1|1" \
  "$(succ "$PSSHORT" --successor | sed -n 's/^launch=//p' | grep -c -- "--name 'Orch : $(printf 'x%.0s' $(seq 1 25))'")|$(succ "$PSLONGSUB" --successor >/dev/null 2>&1; echo $?)"
# An orchestrator's title is a successor's, and a plain anchor lands after the chain: the
# tab the operator found at the far right of his window, inheriting nothing (§39).
check "an orchestrator's title on a plain anchor is refused" "1|1" \
  "$(shaped --title 'Orch : f' --right-of self | grep -c "an orchestrator's title is a successor's")|$(shaped --title 'Orch : f' --left-of /dev/ttys555 | grep -c 'spawn it with --successor')"
# A successor is named after its caller by definition; --title-free asks for the ESCAPE
# from that shape, which does not apply to a name the launcher derives itself.
check "--successor with --title-free is refused" "1|1" \
  "$(succ "$PSTAB" --successor --title-free >/dev/null 2>&1; echo $?)|$(succ "$PSTAB" --successor --title-free | grep -c 'a successor is named after its caller, --title-free does not apply')"

# The process table is read through ONE function, and the suite replaces `ps` with a file.
name_on() { ORCHESTRATOR_PS_TABLE="$1" "$py" -c "
import sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
print(m.session_name_on(sys.argv[1]))" "$2"; }
check "the table gives the name the host process was launched with" "Orch : f" "$(name_on "$PSTAB" /dev/ttys900)"
check "a process launched without a name reads as none" "None" "$(name_on "$PSNONAME" /dev/ttys900)"
check "a tty the table does not name reads as none" "None" "$(name_on "$PSTAB" /dev/ttys555)"

# What the dry run could not see and the live round did: `ps` shows a command line with
# the shell's quoting gone, so whatever FOLLOWS --name runs into the name. The prompt sat
# there, and every spawned session's name column read the title followed by the whole
# brief. The prompt goes BEFORE the options now, so --name is followed by --remote-control
# or by nothing. Read end to end: the launch this dry run prints, turned into the line
# `ps` would show, fed back through the reader.
ps_line() { "$py" -c "
import shlex, sys
launch, prompt_file, tty = sys.argv[1], sys.argv[2], sys.argv[3]
argv = shlex.split(launch.split(' && ')[-1])[1:]
argv = [open(prompt_file).read().strip() if a.startswith('\$(cat ') else a for a in argv]
print('%s %s' % (tty, ' '.join(argv)))" "$1" "$2" "$3"; }
PROMPT_COLON="$WORK/prompt-colon.txt"
printf 'Read and execute /tmp/brief.md. Your orchestrator is Orch : plugin family [abc123].\n' > "$PROMPT_COLON"
d1launch=$(shaped --title 'Agent : x' --prompt-file "$PROMPT_COLON" | sed -n 's/^launch=//p')
ps_line "$d1launch" "$PROMPT_COLON" /dev/ttys900 > "$WORK/ps-launched.txt"
check "the name a spawn leaves in the process table is the title, and stops there" "Agent : x" \
  "$(name_on "$WORK/ps-launched.txt" /dev/ttys900)"
d1succ=$(succ "$PSTAB" --successor --prompt-file "$PROMPT_COLON" | sed -n 's/^launch=//p')
ps_line "$d1succ" "$PROMPT_COLON" /dev/ttys901 > "$WORK/ps-succ.txt"
check "and a successor's, with the remote-control flag behind it" "Orch : f" \
  "$(name_on "$WORK/ps-succ.txt" /dev/ttys901)"
check "the launch puts the prompt before the name" "1" \
  "$(printf '%s' "$d1launch" | grep -cE '"\$\(cat [^"]+\)" --name ')"

# The listing's row is formatted by a pure function, so its shape is read without an app.
# The tab title is the host's summary of the conversation and it moves; the name is fixed
# at launch, and it is what an orchestrator recognises its own agents by (§38).
row() { "$py" -c "
import sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
print(m.row_for(1, 2, '/dev/ttys900', sys.argv[1], None if sys.argv[2] == '-' else sys.argv[2],
                sys.argv[3] == 'self', sys.argv[4] == 'hidden'))" "$1" "$2" "$3" "$4"; }
check "the row carries the tab title, the session name and the caller's own mark" \
  'w1/t2 | /dev/ttys900 | ✳ T | Agent : x | self' "$(row '✳ T' 'Agent : x' self visible)"
check "a session launched without a name says so, and a hidden pane still says hidden" \
  'w1/t2 | /dev/ttys900 | ✳ T | (host default) | hidden' "$(row '✳ T' - other hidden)"

# `move` moves what is the caller's: its own tab, or a tab of its chain. An orchestrator
# that had never measured its own tty read the listing, took the last tab for its own and
# moved a stranger's session out of the way; the script obeyed (§38). --force is the
# operator's hand and the layout repair, and it says on stderr what it moved.
mv_() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME bash "$AGENT" move "$@" 2>&1; }
mkdir -p "$ISTATE/chains"
printf '{"tab_id":"1","tty":"/dev/ttys901","owner":"S-ME"}\n' > "$ISTATE/chains/ttys900.jsonl"
check "a tab of the caller's chain moves" "1" \
  "$(mv_ --tty /dev/ttys901 --left-of self | grep -c '^move=/dev/ttys901 left_of=/dev/ttys900$')"
check "the caller's own tab moves" "1" \
  "$(mv_ --tty /dev/ttys900 --left-of /dev/ttys555 | grep -c '^move=/dev/ttys900 left_of=/dev/ttys555$')"
printf '{"tab_id":"2","tty":"/dev/ttys902","owner":"S-ME"}\n' > "$ISTATE/chains/ttys900.jsonl"
check "a tab that is neither is refused, and the refusal names it" "1|1" \
  "$(mv_ --tty /dev/ttys901 --left-of self >/dev/null 2>&1; echo $?)|$(mv_ --tty /dev/ttys901 --left-of self | grep -c "move: refused: /dev/ttys901 is neither this session's tab nor in its chain (pass --force to move it anyway)")"
check "--force moves it and says what it moved" "0|1" \
  "$(mv_ --tty /dev/ttys901 --left-of self --force >/dev/null 2>&1; echo $?)|$(mv_ --tty /dev/ttys901 --left-of self --force | grep -c "^move: forced: /dev/ttys901 is not in this session's chain$")"

# `--leftmost` places a tab at the first place of its window, no neighbour tab named: a
# third form beside `--left-of` and `--right-of`, exclusive with both.
check "--leftmost moves the caller's own tab to the first place of its window" "1" \
  "$(mv_ --tty /dev/ttys900 --leftmost | grep -c '^move=/dev/ttys900 left_of=leftmost$')"
check "--leftmost is exclusive with --left-of and --right-of" "1|1" \
  "$(mv_ --tty /dev/ttys900 --leftmost --right-of self >/dev/null 2>&1; echo $?)|$(mv_ --tty /dev/ttys900 --leftmost --right-of self | grep -c -- '--leftmost is exclusive with --left-of and --right-of')"
check "no anchor at all is refused, naming all three forms" "1|1" \
  "$(mv_ --tty /dev/ttys900 >/dev/null 2>&1; echo $?)|$(mv_ --tty /dev/ttys900 | grep -c -- '--left-of, --right-of or --leftmost is required')"

# The guard that refuses a stranger's tab applies to `--leftmost` exactly as it does to
# `--left-of` and `--right-of`: the anchor form changes, not whose tab this is.
check "--leftmost refuses a tab out of the caller's chain, and the refusal names it" "1|1" \
  "$(mv_ --tty /dev/ttys901 --leftmost >/dev/null 2>&1; echo $?)|$(mv_ --tty /dev/ttys901 --leftmost | grep -c "move: refused: /dev/ttys901 is neither this session's tab nor in its chain (pass --force to move it anyway)")"
check "--force moves it leftmost too, and says what it moved" "0|1" \
  "$(mv_ --tty /dev/ttys901 --leftmost --force >/dev/null 2>&1; echo $?)|$(mv_ --tty /dev/ttys901 --leftmost --force | grep -c "^move: forced: /dev/ttys901 is not in this session's chain$")"

# An AUDITOR is neither a successor nor an agent (§52). It is placed immediately LEFT of
# its caller, the chain ignored — on the caller's model and under remote control under its
# own title; but it takes no chain and joins none: the orchestrator it audits keeps its
# agents, and the auditor is nobody's agent. Its title is REQUIRED and reads
# `Audit : <subject>`, a shape refused everywhere but under --auditor.
AUDSTATE="$WORK/audstate"; mkdir -p "$AUDSTATE/ctx" "$AUDSTATE/chains"
printf '{"session_id":"s-aud","model_id":"aud-model","updated_epoch":%s}\n' "$(date +%s)" > "$AUDSTATE/ctx/s-aud.json"
printf '{"tab_id":"7","tty":"/dev/ttys901","owner":"S-ME"}\n' > "$AUDSTATE/chains/ttys900.jsonl"
aud() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-aud bash "$AGENT" spawn --dir "$WORK" --prompt p "$@" 2>&1; }
audl() { aud "$@" | sed -n 's/^launch=//p'; }
AUDOUT=$(aud --auditor --title 'Audit : tm')
AUDLAUNCH=$(printf '%s' "$AUDOUT" | sed -n 's/^launch=//p')
check "an auditor is named by its title and comes up under remote control under it" "1|1" \
  "$(printf '%s' "$AUDLAUNCH" | grep -c -- "--name 'Audit : tm'")|$(printf '%s' "$AUDLAUNCH" | grep -c -- "--remote-control 'Audit : tm'")"
check "and without the setting that turns remote control off" "0" "$(printf '%s' "$AUDLAUNCH" | grep -c -- '--settings')"
check "an auditor runs on the caller's model with no flag to ask for it" "1" "$(printf '%s' "$AUDLAUNCH" | grep -c -- '--model aud-model')"
check "an auditor anchors on self, past no agent, and the dry run says what it is" "1|1|1" \
  "$(printf '%s' "$AUDOUT" | grep -c '^anchor=self$')|$(printf '%s' "$AUDOUT" | grep -c '^auditor=yes$')|$(printf '%s' "$AUDOUT" | grep -c '^successor=no$')"
check "an auditor sits on the LEFT of its caller; a successor and a plain anchor stay RIGHT" "left|right|right" \
  "$(printf '%s' "$AUDOUT" | sed -n 's/^side=//p')|$(aud --title 'Orch : f' --successor | sed -n 's/^side=//p')|$(aud --title 'Agent : x' --right-of self | sed -n 's/^side=//p')"
check "where a plain spawn from the same caller anchors after its last agent" "1" \
  "$(aud --title 'Agent : x' --right-of self | grep -c '^anchor=/dev/ttys901$')"
check "a chain is appended to by an agent, handed over by a successor, left alone by an auditor" "append|transfer|none" \
  "$(aud --title 'Agent : x' --right-of self | sed -n 's/^chain=//p')|$(aud --title 'Orch : f' --successor | sed -n 's/^chain=//p')|$(printf '%s' "$AUDOUT" | sed -n 's/^chain=//p')"
check "an auditor without a title is refused, and the reason names the shape" "1|1" \
  "$(aud --auditor >/dev/null 2>&1; echo $?)|$(aud --auditor | grep -c -- '--auditor needs --title "Audit : <subject>"')"
AUD25=$(printf 'x%.0s' $(seq 1 25)); AUD26=$(printf 'x%.0s' $(seq 1 26))
check "an auditor's subject of 25 characters is accepted, of 26 refused" "1|1" \
  "$(audl --auditor --title "Audit : $AUD25" | grep -c -- "--name 'Audit : $AUD25'")|$(aud --auditor --title "Audit : $AUD26" >/dev/null 2>&1; echo $?)"
check "an auditor under an agent's or an orchestrator's title is refused" "1|1|1" \
  "$(aud --auditor --title 'Agent : x' >/dev/null 2>&1; echo $?)|$(aud --auditor --title 'Orch : x' >/dev/null 2>&1; echo $?)|$(aud --auditor --title 'Agent : x' | grep -c "an auditor's title reads \"Audit : <subject>\"")"
check "an audit title is refused without --auditor: plain, anchored, free, successor" "1|1|1|1" \
  "$(aud --title 'Audit : x' | grep -c "an audit title is an auditor's")|$(aud --title 'Audit : x' --right-of self | grep -c "an audit title is an auditor's")|$(aud --title-free --title 'Audit : x' | grep -c "an audit title is an auditor's")|$(aud --successor --title 'Audit : x' | grep -c "an audit title is an auditor's")"
check "and that refusal exits 1" "1" "$(aud --title 'Audit : x' >/dev/null 2>&1; echo $?)"
for AUDFLAG in --successor '--right-of self' '--left-of /dev/ttys555' --title-free '--tier deep' '--model m' --no-remote-control; do
  # shellcheck disable=SC2086 # the flag and its value are two words on purpose
  check "an auditor refuses $AUDFLAG" "1|1" \
    "$(aud --auditor --title 'Audit : x' $AUDFLAG >/dev/null 2>&1; echo $?)|$(aud --auditor --title 'Audit : x' $AUDFLAG | grep -c "is not an auditor's")"
done
check "an auditor with no model on record is refused, naming the installer" "1" \
  "$(CLAUDE_CODE_SESSION_ID=s-aud-none ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" bash "$AGENT" spawn --dir "$WORK" --auditor --title 'Audit : x' --prompt p 2>&1 | grep -c 'orchestrator:install')"
check "--inherit-model beside --auditor asks for what is already implied" "1" \
  "$(audl --auditor --inherit-model --title 'Audit : x' | grep -c -- '--model aud-model')"

# `rotate` and `move` treat an auditor's tab as not the caller's to replace or place: it is
# read by its NAME in the process table, so a stale chain entry naming it moves nothing.
PSAUD="$WORK/ps-audit.txt"
printf '/dev/ttys950 /opt/x/claude --name Audit : tm\n/dev/ttys901 /opt/x/claude --name Agent : x\n' > "$PSAUD"
audrot() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" ORCHESTRATOR_PS_TABLE="$PSAUD" \
  bash "$AGENT" rotate --dir "$WORK" --title "Agent : rotated" --prompt p "$@" 2>&1; }
check "rotate refuses --auditor" "1" "$(audrot --old-tty /dev/ttys901 --auditor | grep -c -- '--auditor is not a rotation')"
AUDROT=$(audrot --old-tty /dev/ttys950)
check "rotate refuses an auditor's tab before it spawns anything" "0|1|1" \
  "$(printf '%s' "$AUDROT" | grep -c '^launch=')|$(printf '%s' "$AUDROT" | grep -c "rotate: refused: /dev/ttys950 is an auditor's tab ('Audit : tm')")|$(audrot --old-tty /dev/ttys950 >/dev/null 2>&1; echo $?)"
check "--force rotates it, and says so" "1|1" \
  "$(audrot --old-tty /dev/ttys950 --force | tail -1 | grep -c '^close=/dev/ttys950')|$(audrot --old-tty /dev/ttys950 --force | grep -c "^rotate: forced: /dev/ttys950 is an auditor's tab")"
check "an agent's tab still rotates without --force" "1" "$(audrot --old-tty /dev/ttys901 | tail -1 | grep -c '^close=/dev/ttys901')"
printf '{"tab_id":"8","tty":"/dev/ttys950","owner":"S-ME"}\n' >> "$AUDSTATE/chains/ttys900.jsonl"
audmv() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" ORCHESTRATOR_SELF_TTY="${AUDSELF:-/dev/ttys900}" \
  ORCHESTRATOR_SELF_ID=S-ME ORCHESTRATOR_PS_TABLE="$PSAUD" bash "$AGENT" move "$@" 2>&1; }
check "an auditor's tab is not moved, even with a stale chain entry naming it" "1|1" \
  "$(audmv --tty /dev/ttys950 --right-of self >/dev/null 2>&1; echo $?)|$(audmv --tty /dev/ttys950 --right-of self | grep -c "move: refused: /dev/ttys950 is an auditor's tab ('Audit : tm'), not this session's to place (pass --force to move it anyway)")"
check "--force moves it, and says so" "0|1" \
  "$(audmv --tty /dev/ttys950 --right-of self --force >/dev/null 2>&1; echo $?)|$(audmv --tty /dev/ttys950 --right-of self --force | grep -c "^move: forced: /dev/ttys950 is an auditor's tab")"
check "an auditor's tab is not moved leftmost either" "1|1" \
  "$(audmv --tty /dev/ttys950 --leftmost >/dev/null 2>&1; echo $?)|$(audmv --tty /dev/ttys950 --leftmost | grep -c "move: refused: /dev/ttys950 is an auditor's tab ('Audit : tm'), not this session's to place (pass --force to move it anyway)")"
check "--force moves it leftmost too, and says so" "0|1" \
  "$(audmv --tty /dev/ttys950 --leftmost --force >/dev/null 2>&1; echo $?)|$(audmv --tty /dev/ttys950 --leftmost --force | grep -c "^move: forced: /dev/ttys950 is an auditor's tab")"
check "an agent of the chain still moves" "1" "$(audmv --tty /dev/ttys901 --right-of self | grep -c '^move=/dev/ttys901 right_of=/dev/ttys900$')"
check "an auditor places its own tab" "1" \
  "$(AUDSELF=/dev/ttys950 audmv --tty /dev/ttys950 --right-of /dev/ttys900 | grep -c '^move=/dev/ttys950 right_of=/dev/ttys900$')"

# The COORDINATOR sits above every orchestrator on the machine. Its own successor is
# neither an auditor nor an agent: it lands at the FIRST place of the caller's window (not
# merely beside it), the chain ignored — on the caller's model and under remote control
# under its own title; it takes no chain and joins none. Its title is REQUIRED and reads
# `Coord : <subject>`, a shape refused everywhere but under --coordinator-successor.
CRDSTATE="$WORK/crdstate"; mkdir -p "$CRDSTATE/ctx" "$CRDSTATE/chains"
printf '{"session_id":"s-crd","model_id":"crd-model","updated_epoch":%s}\n' "$(date +%s)" > "$CRDSTATE/ctx/s-crd.json"
printf '{"tab_id":"7","tty":"/dev/ttys901","owner":"S-ME"}\n' > "$CRDSTATE/chains/ttys900.jsonl"
crd() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-crd bash "$AGENT" spawn --dir "$WORK" --prompt p "$@" 2>&1; }
crdl() { crd "$@" | sed -n 's/^launch=//p'; }
CRDOUT=$(crd --coordinator-successor --title 'Coord : ops')
CRDLAUNCH=$(printf '%s' "$CRDOUT" | sed -n 's/^launch=//p')
check "the coordinator's successor is named by its title and comes up under remote control under it" "1|1" \
  "$(printf '%s' "$CRDLAUNCH" | grep -c -- "--name 'Coord : ops'")|$(printf '%s' "$CRDLAUNCH" | grep -c -- "--remote-control 'Coord : ops'")"
check "and without the setting that turns remote control off" "0" "$(printf '%s' "$CRDLAUNCH" | grep -c -- '--settings')"
check "the coordinator's successor runs on the caller's model with no flag to ask for it" "1" "$(printf '%s' "$CRDLAUNCH" | grep -c -- '--model crd-model')"
check "it lands at the first place of the caller's window, joins no chain, and the dry run says what it is" "1|1|1|1" \
  "$(printf '%s' "$CRDOUT" | grep -c '^anchor=leftmost$')|$(printf '%s' "$CRDOUT" | grep -c '^side=left$')|$(printf '%s' "$CRDOUT" | grep -c '^coordinator_successor=yes$')|$(printf '%s' "$CRDOUT" | grep -c '^chain=none$')"
check "a coordinator-successor without a title is refused, and the reason names the shape" "1|1" \
  "$(crd --coordinator-successor >/dev/null 2>&1; echo $?)|$(crd --coordinator-successor | grep -c -- '--coordinator-successor needs --title "Coord : <subject>"')"
CRD25=$(printf 'x%.0s' $(seq 1 25)); CRD26=$(printf 'x%.0s' $(seq 1 26))
check "a coordinator's subject of 25 characters is accepted, of 26 refused" "1|1" \
  "$(crdl --coordinator-successor --title "Coord : $CRD25" | grep -c -- "--name 'Coord : $CRD25'")|$(crd --coordinator-successor --title "Coord : $CRD26" >/dev/null 2>&1; echo $?)"
check "a coordinator-successor under an agent's or an orchestrator's title is refused" "1|1|1" \
  "$(crd --coordinator-successor --title 'Agent : x' >/dev/null 2>&1; echo $?)|$(crd --coordinator-successor --title 'Orch : x' >/dev/null 2>&1; echo $?)|$(crd --coordinator-successor --title 'Agent : x' | grep -c "the coordinator's title reads \"Coord : <subject>\"")"
check "a Coord title is refused without --coordinator-successor: plain, anchored, free, successor" "1|1|1|1" \
  "$(crd --title 'Coord : x' | grep -c 'a "Coord :" title is the coordinator')|$(crd --title 'Coord : x' --right-of self | grep -c 'a "Coord :" title is the coordinator')|$(crd --title-free --title 'Coord : x' | grep -c 'a "Coord :" title is the coordinator')|$(crd --successor --title 'Coord : x' | grep -c 'a "Coord :" title is the coordinator')"
check "and that refusal exits 1" "1" "$(crd --title 'Coord : x' >/dev/null 2>&1; echo $?)"
for CRDFLAG in --successor --auditor '--left-of /dev/ttys555' '--right-of self' \
    --title-free '--tier deep' '--model m' --no-remote-control; do
  # shellcheck disable=SC2086 # the flag and its value are two words on purpose
  check "a coordinator-successor refuses $CRDFLAG" "1|1" \
    "$(crd --coordinator-successor --title 'Coord : x' $CRDFLAG >/dev/null 2>&1; echo $?)|$(crd --coordinator-successor --title 'Coord : x' $CRDFLAG | grep -c "is not a coordinator-successor's")"
done
check "a coordinator-successor with no model on record is refused, naming the installer" "1" \
  "$(CLAUDE_CODE_SESSION_ID=s-crd-none ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" bash "$AGENT" spawn --dir "$WORK" --coordinator-successor --title 'Coord : x' --prompt p 2>&1 | grep -c 'orchestrator:install')"
check "--inherit-model beside --coordinator-successor asks for what is already implied" "1" \
  "$(crdl --coordinator-successor --inherit-model --title 'Coord : x' | grep -c -- '--model crd-model')"

# `rotate` and `move` treat the coordinator's tab as not the caller's to replace or place,
# exactly like an auditor's: read by its NAME in the process table, so a stale chain entry
# naming it moves nothing.
PSCRD="$WORK/ps-coord.txt"
printf '/dev/ttys950 /opt/x/claude --name Coord : ops\n/dev/ttys901 /opt/x/claude --name Agent : x\n' > "$PSCRD"
crdrot() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" ORCHESTRATOR_PS_TABLE="$PSCRD" \
  bash "$AGENT" rotate --dir "$WORK" --title "Agent : rotated" --prompt p "$@" 2>&1; }
check "rotate refuses --coordinator-successor" "1" "$(crdrot --old-tty /dev/ttys901 --coordinator-successor | grep -c -- '--coordinator-successor is not a rotation')"
CRDROT=$(crdrot --old-tty /dev/ttys950)
check "rotate refuses the coordinator's tab before it spawns anything" "0|1|1" \
  "$(printf '%s' "$CRDROT" | grep -c '^launch=')|$(printf '%s' "$CRDROT" | grep -c "rotate: refused: /dev/ttys950 is the coordinator's tab ('Coord : ops')")|$(crdrot --old-tty /dev/ttys950 >/dev/null 2>&1; echo $?)"
check "--force rotates it, and says so" "1|1" \
  "$(crdrot --old-tty /dev/ttys950 --force | tail -1 | grep -c '^close=/dev/ttys950')|$(crdrot --old-tty /dev/ttys950 --force | grep -c "^rotate: forced: /dev/ttys950 is the coordinator's tab")"
check "an agent's tab still rotates without --force" "1" "$(crdrot --old-tty /dev/ttys901 | tail -1 | grep -c '^close=/dev/ttys901')"
printf '{"tab_id":"9","tty":"/dev/ttys950","owner":"S-ME"}\n' >> "$CRDSTATE/chains/ttys900.jsonl"
crdmv() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME ORCHESTRATOR_PS_TABLE="$PSCRD" bash "$AGENT" move "$@" 2>&1; }
check "the coordinator's tab is not moved, even with a stale chain entry naming it" "1|1" \
  "$(crdmv --tty /dev/ttys950 --right-of self >/dev/null 2>&1; echo $?)|$(crdmv --tty /dev/ttys950 --right-of self | grep -c "move: refused: /dev/ttys950 is the coordinator's tab ('Coord : ops'), not this session's to place (pass --force to move it anyway)")"
check "--force moves it, and says so" "0|1" \
  "$(crdmv --tty /dev/ttys950 --right-of self --force >/dev/null 2>&1; echo $?)|$(crdmv --tty /dev/ttys950 --right-of self --force | grep -c "^move: forced: /dev/ttys950 is the coordinator's tab")"
check "the coordinator's tab is not moved leftmost either" "1|1" \
  "$(crdmv --tty /dev/ttys950 --leftmost >/dev/null 2>&1; echo $?)|$(crdmv --tty /dev/ttys950 --leftmost | grep -c "move: refused: /dev/ttys950 is the coordinator's tab ('Coord : ops'), not this session's to place (pass --force to move it anyway)")"
check "--force moves it leftmost too, and says so" "0|1" \
  "$(crdmv --tty /dev/ttys950 --leftmost --force >/dev/null 2>&1; echo $?)|$(crdmv --tty /dev/ttys950 --leftmost --force | grep -c "^move: forced: /dev/ttys950 is the coordinator's tab")"
check "an agent of the chain still moves" "1" "$(crdmv --tty /dev/ttys901 --right-of self | grep -c '^move=/dev/ttys901 right_of=/dev/ttys900$')"
check "the coordinator's own tab moves leftmost, by itself" "1" \
  "$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys950 ORCHESTRATOR_SELF_ID=S-ME ORCHESTRATOR_PS_TABLE="$PSCRD" bash "$AGENT" move --tty /dev/ttys950 --leftmost | grep -c '^move=/dev/ttys950 left_of=leftmost$')"

# The coordinator's own rulebook and its two commands. The judgment is prose, so what is
# checked here is that each rule sits in the file read at its moment, and that every command
# line the prose hands the session is one the tooling runs: the succession's spawn line and
# the start's leftmost move are taken out of the text and run dry through the launcher, and
# the successor's brief, every placeholder filled, lints clean.
COORDSKILL="$ROOT/skills/coordination/SKILL.md"
COORDCMD="$ROOT/commands/coordinator.md"
COORDEND="$ROOT/commands/coordinator-end.md"
COORDTPL="$ROOT/templates/coordinator-succession-brief.md"
# A skill and a command of one plugin share one address, `orchestrator:<name>`, and the host
# resolves it to the command: a skill named like a command is never loaded by its name, and a
# command that says « load that skill first » loads itself. The coordinator's skill was first
# named like its start command, and a staged coordinator read the start steps as its rulebook.
name_collisions() {  # <skills dir> <commands dir>: one line per name both carry
  local s n
  for s in "$1"/*/SKILL.md; do
    n=$(sed -n 's/^name: //p' "$s" | head -1)
    [ -f "$2/$n.md" ] && echo "collision:$n"
    [ -f "$2/$(basename "$(dirname "$s")").md" ] && echo "collision:$(basename "$(dirname "$s")")"
  done | sort -u
}
check "no skill and no command of the plugin share a name" "" "$(name_collisions "$ROOT/skills" "$ROOT/commands")"
NCCMDS="$WORK/collision-commands"; mkdir -p "$NCCMDS"; cp "$ROOT"/commands/*.md "$NCCMDS"/; cp "$COORDCMD" "$NCCMDS/coordination.md"
check "a command planted under a skill's name falls the check, and names it" "collision:coordination" \
  "$(name_collisions "$ROOT/skills" "$NCCMDS")"
check "ready, reports and audit ready are relayed unjudged, and ready is not a merge" "yes|yes" \
  "$(spells "$COORDSKILL" 'are relayed as they are, unjudged')|$(spells "$COORDSKILL" '**« Ready » is not a merge.**')"
check "the predecessor forwards until handed over, and never closes its own tab" "yes|yes" \
  "$(spells "$COORDSKILL" '**Until « handed over », you answer nothing new.**')|$(spells "$COORDSKILL" 'You never close your own tab.')"
COORDSPAWN=$(grep -m1 -o 'iterm-agent.sh spawn --coordinator-successor.*' "$COORDSKILL" 2>/dev/null | sed -e 's/^iterm-agent.sh spawn //' \
  -e 's#<subject>#ops#' -e "s#<your working directory>#$WORK#" -e 's#<brief path>#/tmp/coord-brief.md#')
coordspawn() { eval "set -- $COORDSPAWN"; ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-crd bash "$AGENT" spawn "$@" 2>&1; }
COORDSPAWNOUT=$(if [ -n "$COORDSPAWN" ]; then coordspawn; else echo "no spawn line"; fi)
check "the skill's succession spawn line is one the launcher runs as the coordinator's successor" "1|1|1|1" \
  "$(printf '%s' "$COORDSPAWNOUT" | grep -c '^coordinator_successor=yes$')|$(printf '%s' "$COORDSPAWNOUT" | grep -c '^anchor=leftmost$')|$(printf '%s' "$COORDSPAWNOUT" | grep -c '^chain=none$')|$(printf '%s' "$COORDSPAWNOUT" | sed -n 's/^launch=//p' | grep -c -- "--name 'Coord : ops'")"

COORDLINE() { grep -n -m1 -F -- "$2" "$1" | cut -d: -f1; }
COORDMOVE=$(grep -m1 -o 'iterm-agent.sh move --tty <your tty> --leftmost' "$COORDCMD" 2>/dev/null | sed -e 's/^iterm-agent.sh move //' -e 's#<your tty>#/dev/ttys950#')
check "the command's move line puts the coordinator's own tab leftmost" "1" \
  "$(if [ -n "$COORDMOVE" ]; then eval "set -- $COORDMOVE"; ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys950 ORCHESTRATOR_SELF_ID=S-ME ORCHESTRATOR_PS_TABLE="$PSCRD" bash "$AGENT" move "$@" 2>&1 | grep -c '^move=/dev/ttys950 left_of=leftmost$'; else echo 0; fi)"

# The end runs on the operator's word only, never a session's own decision to stop.
check "the end runs on the operator's word only" "yes" "$(spells "$COORDEND" 'This command runs ONLY when the operator types it')"

# The successor's brief: register refuses while the predecessor runs, so the order is fixed —
# close, prove on ps, THEN register. Filled, it lints clean like every template.
check "the successor closes its predecessor's tab before it registers" "yes|1|yes" \
  "$(spells "$COORDTPL" 'close --tty {{PREDECESSOR_TTY}} --expect-title "Coord :"')|$([ "$(COORDLINE "$COORDTPL" 'close --tty {{PREDECESSOR_TTY}}')" -lt "$(COORDLINE "$COORDTPL" 'register --name')" ] 2>/dev/null && echo 1 || echo 0)|$(spells "$COORDTPL" '**THEN register**')"
check "it waits for handed over and proves the close on ps" "yes|yes" \
  "$(spells "$COORDTPL" '« takeover confirmed »')|$(spells "$COORDTPL" '`ps -t <that tty without /dev/>`')"
# Filled as the predecessor fills it: its own address, a subject, real paths. The brief holds
# exactly one session reference, the predecessor's, so a placeholder that lists sessions by
# their exact addresses would put a second one beside it and the lint would block the
# succession: the sessions to re-announce to come from the successor's own `ListAgents`.
COORDFILLED="$WORK/coordinator-brief-filled.md"
mkdir -p "$WORK/coord-fill/coordinator"; : > "$WORK/coord-fill/coordinator/queue.md"; : > "$WORK/coord-fill/gauge.sh"
if [ -f "$COORDTPL" ]; then
  sed -E -e 's#\{\{PREDECESSOR\}\}#Coord : ops [a1b2c3]#g' -e 's#\{\{PREDECESSOR_TTY\}\}#/dev/ttys950#g' -e 's#\{\{SUBJECT\}\}#ops#g' \
    -e "s#\{\{STATE_DIR\}\}#$WORK/coord-fill#g" -e "s#\{\{QUEUE_FILE\}\}#$WORK/coord-fill/coordinator/queue.md#g" \
    -e "s#\{\{COORDINATOR_SH\}\}#$ROOT/skills/coordinator/scripts/coordinator.sh#g" -e "s#\{\{ITERM_AGENT_SH\}\}#$AGENT#g" \
    -e "s#\{\{GAUGE\}\}#$WORK/coord-fill/gauge.sh#g" -e 's#\{\{SESSIONS\}\}#`Orch : api [k2m4p7]`, `Audit : ops [d4e5f6]`#g' \
    -e "s#\{\{[A-Z_]+\}\}#$WORK#g" "$COORDTPL" > "$COORDFILLED"
fi
check "the coordinator's succession brief, filled with a real predecessor's values, lints clean" "yes|0" \
  "$([ -s "$COORDFILLED" ] && echo yes || echo no)|$(bash "$ROOT/skills/orchestrator/scripts/brief-lint.sh" "$COORDFILLED" >/dev/null 2>&1; echo $?)"
check "after handed over, the predecessor forwards everything until its tab closes" "yes" \
  "$(spells "$COORDSKILL" 'From then until your tab closes, every message')"

# `/orchestrator:audit` (§52): the brief instantiated and linted, the auditor spawned with
# the launcher's own flag, verified on the artifact, recorded where `audit-end` finds it.
# The spawn line is not only spelled: it is taken out of the command and run dry through
# the launcher, so a command that drifts from the launcher's flags falls here.
AUDCMD="$ROOT/commands/audit.md"
AUDSPAWN=$(grep -m1 -o 'iterm-agent.sh spawn .*' "$AUDCMD" 2>/dev/null | sed -e 's/^iterm-agent.sh spawn //' -e 's/`.*$//' \
  -e "s#<repository>#$WORK#" -e 's#<subject>#tm#' -e 's#<brief path>#/tmp/audit-brief.md#')
audspawn() { eval "set -- $AUDSPAWN"; ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-aud bash "$AGENT" spawn "$@" 2>&1; }
AUDSPAWNOUT=$(if [ -n "$AUDSPAWN" ]; then audspawn; else echo "no spawn line"; fi)
check "the command's spawn line is one the launcher runs as an auditor" "1|1|1|1" \
  "$(printf '%s' "$AUDSPAWNOUT" | grep -c '^auditor=yes$')|$(printf '%s' "$AUDSPAWNOUT" | grep -c '^name=Audit : tm$')|$(printf '%s' "$AUDSPAWNOUT" | grep -c '^chain=none$')|$(printf '%s' "$AUDSPAWNOUT" | sed -n 's/^launch=//p' | grep -c -- "--permission-mode auto")"
check "and it carries neither a tier, nor a successor's flag, nor an anchor" "0" \
  "$(printf '%s' "$AUDSPAWN" | grep -cE -- '--tier|--successor|--right-of|--left-of')"

# The audit brief (§52): read-only everywhere, reporting to the operator, ordering the
# orchestrator with the measurement behind each change, and a report of a FIXED shape so
# that two audits compare. Filled, it lints clean: a template whose own text trips the lint
# would reach every auditor with a finding its orchestrator learned to ignore.
AUDBRIEF="$ROOT/templates/agent-audit-brief.md"
check "the auditor is read-only on every repository and every worktree" "yes|yes" \
  "$(spells "$AUDBRIEF" 'READ-ONLY on every repository and every worktree')|$(spells "$AUDBRIEF" 'no edit, no commit, no push, no merge, no label, no comment, no kill, no session ended')"
check "every claim carries its command, and the auditor never closes its own tab" "yes|yes" \
  "$(spells "$AUDBRIEF" 'Every claim carries the command that produces it')|$(spells "$AUDBRIEF" 'never close your own tab')"
AUDFILLED="$WORK/audit-brief-filled.md"
if [ -f "$AUDBRIEF" ]; then
  sed -E -e 's#\{\{ORCHESTRATOR_NAME\}\}#Orch : f [a1b2c3]#g' -e "s#\{\{[A-Z_]+\}\}#$WORK#g" "$AUDBRIEF" > "$AUDFILLED"
fi
check "the audit brief, every placeholder filled, lints clean" "yes|0" \
  "$([ -s "$AUDFILLED" ] && echo yes || echo no)|$(bash "$ROOT/skills/orchestrator/scripts/brief-lint.sh" "$AUDFILLED" >/dev/null 2>&1; echo $?)"
# The report path is one the auditor creates, so it cannot exist when the brief is linted:
# the first live audit brief read two findings by construction (issue #52). The command names
# that one path to the lint as created later, and the lint exempts exactly it — a second
# absent path in the same brief is still a finding.
AUDREPORT="$WORK/audits/2026-09-13-tm/REPORT.md"
AUDREAL="$WORK/audit-brief-real.md"
if [ -f "$AUDBRIEF" ]; then
  sed -E -e 's#\{\{ORCHESTRATOR_NAME\}\}#Orch : f [a1b2c3]#g' -e "s#\{\{REPORT_PATH\}\}#$AUDREPORT#g" -e "s#\{\{[A-Z_]+\}\}#$WORK#g" "$AUDBRIEF" > "$AUDREAL"
fi
check "an instantiated audit brief lints to zero with its report path expected, two findings without" "0|brief-lint: $AUDREAL: 0 findings|2" \
  "$(bash "$LINT" "$AUDREAL" --expect-created "$AUDREPORT" >/dev/null 2>&1; echo $?)|$(bash "$LINT" "$AUDREAL" --expect-created "$AUDREPORT" 2>&1)|$(bash "$LINT" "$AUDREAL" 2>/dev/null | grep -c "path does not exist: $AUDREPORT")"
cp "$AUDREAL" "$WORK/audit-brief-other.md" 2>/dev/null; printf 'Spec: `%s/nowhere.md`\n' "$WORK" >> "$WORK/audit-brief-other.md"
check "--expect-created exempts the path it names and no other" "1|0" \
  "$(bash "$LINT" "$WORK/audit-brief-other.md" --expect-created "$AUDREPORT" 2>/dev/null | grep -c "path does not exist: $WORK/nowhere.md")|$(bash "$LINT" "$WORK/audit-brief-other.md" --expect-created "$AUDREPORT" 2>/dev/null | grep -c "path does not exist: $AUDREPORT")"
check "--expect-created without a path is refused, and says so" "1|1" \
  "$(bash "$LINT" "$AUDREAL" --expect-created >/dev/null 2>&1; echo $?)|$(bash "$LINT" "$AUDREAL" --expect-created 2>&1 | grep -c -- '--expect-created needs a path')"

# `/orchestrator:audit-end` (§52), from either side. The auditor sends its report path and
# ends its turn, never its session; the orchestrator acknowledges, waits for « ended », and
# closes the auditor's tab under the audit title, proved on the process table. The close
# line is taken out of the command and run dry, like the audit's spawn line.
AUDEND="$ROOT/commands/audit-end.md"
check "the auditor sends its report path and never closes its own tab" "yes|yes|yes" \
  "$(spells "$AUDEND" '« audit-end: <report path> »')|$(spells "$AUDEND" 'Never close your own tab')|$(spells "$AUDEND" '« ended »')"
check "the close is proved on ps and ListAgents, and the record is cleared" "yes|yes|yes" \
  "$(spells "$AUDEND" 'ps -t')|$(spells "$AUDEND" 'ListAgents')|$(spells "$AUDEND" 'claude-orchestrator/audits/')"
# The rulebook carries the audit (§52): what an auditor is, what it may order, what the
# orchestrator owes it, and the two commands — the commands load the rulebook first, so a duty
# written only in a command is one an orchestrator reading the rulebook never meets.
# The audit's rules: its reference's section, and what the orchestrator owes an auditor at
# every message, which the rulebook carries itself.
AUDRULE=$(awk '/^## The audit$/{f=1; next} f&&/^## /{exit} f' "$ORCH_REFS/audit.md"; awk '/^## Carried at every step$/{f=1; next} f&&/^## /{exit} f' "$ROOT/skills/orchestrator/SKILL.md")
AUDRULEF="$WORK/rulebook-audit-section.md"; printf '%s\n' "$AUDRULE" > "$AUDRULEF"
check "the red flags carry the audit" "yes|yes" \
  "$(carries "$ROOT/skills/orchestrator/SKILL.md" "An auditor's ordered change neither applied nor refused with the ruling it crosses")|$(carries "$ROOT/skills/orchestrator/SKILL.md" "an auditor's tab still open after its « ended »")"

# The operator launches an audit and the operator ends it (issue #52). The first live run
# ended on the auditor's own decision: the brief told it to run audit-end « when the report
# is complete », and audit-end let the orchestrator run it « on your own decision ». The rule
# lives in the plugin's own texts — the two commands, the brief, the rulebook's section, the
# design's section and the README's entries — and nowhere else, so it is held here, on all of
# them: no phrase that hands the end to a session, and no sentence that launches, runs or
# ends an audit by its command without naming the operator.
AUDDESIGNF="$WORK/design-audit-section.md"
awk '/^## 52\. /{f=1; next} f&&/^## /{exit} f' "$ROOT/docs/design.md" > "$AUDDESIGNF"
AUDREADMEF="$WORK/readme-audit-rows.md"
grep -F '| `/orchestrator:audit' "$ROOT/README.md" > "$AUDREADMEF"
AUDWORD=("$AUDCMD" "$AUDEND" "$AUDBRIEF" "$AUDRULEF" "$AUDDESIGNF" "$AUDREADMEF")
check "no audit text hands the end of an audit to a session's own decision" "" \
  "$(grep -hniE 'own decision|own initiative|own accord|when the report is complete, run|in your own session|run (the command )?/?orchestrator:audit-end' "${AUDWORD[@]}" 2>/dev/null)"
audit_unowned() {  # prints every sentence that launches, runs or ends an audit by its command without the operator
  local f
  for f in "$@"; do
    tr '\n' ' ' < "$f" | awk -v f="${f##*/}" '{
      gsub(/dry run|run dry/, "")
      n = split($0, s, "[.;] |: ")
      for (i = 1; i <= n; i++) {
        t = tolower(s[i]); gsub(/audit-end/, "", t)
        if (s[i] ~ /orchestrator:audit/ && t ~ /(^|[^a-z])(runs?|launch(es|ed)?|relaunch(es)?|ends?|ended|types?|typed)([^a-z]|$)/ && s[i] !~ /operator/)
          print f ": " s[i]
      }
    }'
  done
}
check "every sentence that launches or ends an audit by its command names the operator" "" \
  "$(audit_unowned "${AUDWORD[@]}")"
check "audit-end runs only when the operator types it, and « audit ready » is not that word" "yes|yes|yes" \
  "$(spells "$AUDEND" 'ONLY when the operator types it')|$(spells "$AUDEND" '« audit ready: <report path> »')|$(spells "$AUDEND" '« audit ready » message is not the word')"
check "the auditor invites the operator to end the audit, and waits" "yes|yes|yes" \
  "$(spells "$AUDBRIEF" '« audit ready: {{REPORT_PATH}} »')|$(spells "$AUDBRIEF" 'the audit can be ended')|$(spells "$AUDBRIEF" 'you run no command and close nothing')"
check "the rulebook and the design say who launches and who ends, and name the defect" "yes|yes|yes|yes" \
  "$(carries "$AUDRULEF" 'the operator launches the audit and the operator ends it')|$(carries "$AUDRULEF" 'a session that ends an audit by itself is the defect')|$(carries "$AUDDESIGNF" 'the operator launches the audit and the operator ends it')|$(carries "$AUDDESIGNF" 'a session that ends an audit by itself is the defect')"
check "the README's two entries say whose word launches and ends the audit" "2" \
  "$(grep -c "the operator's word" "$AUDREADMEF")"

AUDCLOSE=$(grep -m1 -o 'iterm-agent.sh close .*' "$AUDEND" 2>/dev/null | sed -e 's/^iterm-agent.sh close //' -e 's/`.*$//' -e 's#<auditor tty>#/dev/ttys950#')
audclose() { eval "set -- $AUDCLOSE"; ORCHESTRATOR_DRY_RUN=1 bash "$AGENT" close "$@" 2>&1; }
check "its close line is one the launcher runs, guarded on the audit title" "close=/dev/ttys950 expect_title=Audit :" \
  "$(if [ -n "$AUDCLOSE" ]; then audclose; else echo 'no close line'; fi)"

printf 'a prompt\n' > "$file"
out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : prompt" --prompt-file "$file" 2>&1)
check "--prompt-file reuses the given file" "1" "$(printf '%s' "$out" | grep -c "prompt_file=$file")"
out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : prompt" --prompt "a prompt" 2>&1)
cmd=${out#*launch=}; cmd=${cmd%%$'\n'*}
check "--prompt: the server flag is still there" "1" "$(printf '%s' "$cmd" | grep -c -- '--strict-mcp-config')"
check_status "--prompt and --prompt-file together are refused" 1 env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --prompt x --prompt-file "$file"

# A launch with no startup prompt at all could never have its mode read (the host writes
# no transcript before a first prompt), so it is refused before any tab is made rather than
# spending the mode timeout finding that out.
check_status "a promptless spawn is refused before any tab is made" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : prompt"
noprompt=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : prompt" 2>&1)
check "and says why, before any dry-run launch line" "1|0" \
  "$(printf '%s' "$noprompt" | grep -c 'no startup prompt')|$(printf '%s' "$noprompt" | grep -c '^launch=')"
check_status "--no-verify does not lift the promptless refusal" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : prompt" --no-verify
check_status "a promptless rotation is refused the same way, the old session never touched" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  bash "$AGENT" rotate --old-tty /dev/ttys999 --dir "$WORK" --title "Agent : rotated"
rotnoprompt=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  bash "$AGENT" rotate --old-tty /dev/ttys999 --dir "$WORK" --title "Agent : rotated" 2>&1)
check "and no close of the old tty is even attempted" "0" "$(printf '%s' "$rotnoprompt" | grep -c '^close=')"
check_status "verify on a tty nobody has exits 1" 1 bash "$AGENT" verify --tty /dev/ttys999
check "screen without a tty says which option is missing" "ERROR: screen: --tty is required" \
  "$(bash "$AGENT" screen 2>&1 | head -1)"

# A directory the host has never opened stops the session on a workspace question whose
# highlighted answer is "exit". Nobody sits at that keyboard: the session waits for ever
# having never read its brief, or takes a stray keystroke and quits — and from outside both
# look like a launched agent, because the process is genuinely running. Caught before the
# tab exists, since afterwards it is found out from an agent that never answers.
py=$(command -v python3 || echo python3)
TRUSTF="$WORK/trust.json"; printf '{"projects":{}}' > "$TRUSTF"
UNTRUSTED="$WORK/untrusted"; mkdir -p "$UNTRUSTED"
check_status "an untrusted directory is refused before a tab is made" 1 \
  env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent : trust" --tier deep --prompt p
check "the refusal says how to proceed" "1" \
  "$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
     bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent : trust" --tier deep --prompt p 2>&1 | grep -c -- '--trust')"
check_status "--trust records it and proceeds" 0 \
  env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent : trust" --tier deep --trust --prompt p
check "the record now holds the directory" "true" \
  "$("$py" -c "import json,os,sys; d=json.load(open(sys.argv[1])); print(str(d['projects'].get(os.path.realpath(sys.argv[2]),{}).get('hasTrustDialogAccepted')).lower())" "$TRUSTF" "$UNTRUSTED")"
check_status "a directory already recorded needs no flag" 0 \
  env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent : trust" --tier deep --prompt p
check "the record keeps owner-only permissions" "600" \
  "$(stat -f '%OLp' "$TRUSTF" 2>/dev/null || stat -c '%a' "$TRUSTF")"

# A record that already says yes is not rewritten: the host writes this file too, and a
# rewrite for nothing is a window in which one of the two loses. The fixture is written
# compact on purpose — the launcher's own writer indents, so any rewrite changes the bytes.
compact="{\"projects\":{\"$(cd "$UNTRUSTED" && pwd -P)\":{\"hasTrustDialogAccepted\":true}}}"
printf '%s' "$compact" > "$TRUSTF"
out=$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
      bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent : trust" --tier deep --trust --prompt p 2>&1)
check "--trust on a recorded directory does not rewrite the record" "$compact" "$(cat "$TRUSTF")"
check "and the dry run says the record already held it" "1" "$(printf '%s' "$out" | grep -c '^trust=already$')"
check "--trust on an unrecorded directory says it recorded it" "1" \
  "$(printf '{"projects":{}}' > "$TRUSTF"; env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
     bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent : trust" --tier deep --trust --prompt p 2>&1 | grep -c '^trust=recorded$')"
# A record the launcher cannot read is a gate that cannot measure: it lets the launch
# through AND says so, instead of launching past a question nobody will see.
printf '{not json' > "$WORK/trust-garbage.json"
out=$(env ORCHESTRATOR_TRUST_FILE="$WORK/trust-garbage.json" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
      bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent : trust" --tier deep --prompt p 2>&1); code=$?
check "an unreadable record lets the launch through" "0" "$code"
check "and says so, naming the flag" "1|1" \
  "$(printf '%s' "$out" | grep -c 'cannot be read')|$(printf '%s' "$out" | grep -c '^trust=unread$')"
# The trust check runs BEFORE the prompt file is written: a refusal that already wrote one
# is a refusal that leaves a stray file under the state directory's prompts/.
D8STATE=$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-XXXXXX")
D8TRUST="$WORK/trust-d8.json"; printf '{"projects":{}}' > "$D8TRUST"
D8DIR="$WORK/untrusted-d8"; mkdir -p "$D8DIR"
env ORCHESTRATOR_TRUST_FILE="$D8TRUST" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$D8STATE" \
  bash "$AGENT" spawn --dir "$D8DIR" --title "Agent : trust" --prompt "hello" >/dev/null 2>&1
check "the trust refusal leaves no prompt file" "0" \
  "$(find "$D8STATE/prompts" -type f 2>/dev/null | wc -l | tr -d ' ')"
rm -rf "$D8STATE"
# Entries outlive their directories — a checkout per phase adds one per dispatch — and
# nothing removed them. prune lists; only --apply writes; the kept entry keeps its shape.
GONE="$WORK/gone-checkout"
"$py" -c "import json,sys; json.dump({'projects':{sys.argv[1]:{'hasTrustDialogAccepted':True,'allowedTools':['x']},sys.argv[2]:{'hasTrustDialogAccepted':True}}}, open(sys.argv[3],'w'))" \
  "$(cd "$UNTRUSTED" && pwd -P)" "$GONE" "$TRUSTF"
before=$(cat "$TRUSTF")
check "trust prune lists the gone entry, only it, and writes nothing" "$GONE|unchanged" \
  "$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" bash "$AGENT" trust prune 2>/dev/null)|$([ "$(cat "$TRUSTF")" = "$before" ] && echo unchanged || echo rewritten)"
check "trust prune --apply removes it and keeps the rest, owner-only" "1|0|600" \
  "$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" bash "$AGENT" trust prune --apply >/dev/null 2>&1; \
     "$py" -c "import json,sys; d=json.load(open(sys.argv[1]))['projects']; print('%d|%d' % (sys.argv[2] in d and d[sys.argv[2]].get('allowedTools')==['x'], sys.argv[3] in d))" "$TRUSTF" "$(cd "$UNTRUSTED" && pwd -P)" "$GONE")|$(stat -f '%OLp' "$TRUSTF" 2>/dev/null || stat -c '%a' "$TRUSTF")"
check "trust accepts prune and refuses another action" "0|1" \
  "$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" bash "$AGENT" trust prune >/dev/null 2>&1; echo $?)|$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" bash "$AGENT" trust wipe >/dev/null 2>&1; echo $?)"

# The title guard, on the part of a title that holds still. The first character is an
# activity glyph the session flips on its own — busy, then idle — and a rotation stands the
# old agent down before spending ten seconds on its replacement, so a title captured before
# and compared after is guaranteed to differ. The guard meant to make a close unambiguous
# refused every rotation instead.
title_in() { "$py" -c "
import sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
print('yes' if m.stable_title(sys.argv[1]) in m.stable_title(sys.argv[2]) else 'no')" "$1" "$2"; }
check "a title matches across an activity change" "yes" "$(title_in '◑ Lire et attendre' '✳ Lire et attendre')"
check "a captured prefix still matches" "yes" "$(title_in '◑ Lire' '✳ Lire et attendre')"
check "a plain title matches itself" "yes" "$(title_in 'Chat' 'Chat')"
check "a different title still does not match" "no" "$(title_in 'autre' '✳ Lire et attendre')"

# The shell of a fresh tab is read before anything is typed into it: a startup question
# waiting for a keystroke ate the first character of a command twice in one night.
# Twice: once before the first typing, once before the single retry.

echo "== iterm-agents spawn --brief (dry run) =="

# `spawn --brief` builds the startup prompt itself and lints the brief BEFORE any tab
# exists, so a specification defect is caught before the dispatch rather than after the
# round. `--brief` reuses the clean and the defective fixtures from the brief-lint section.
ORCHREF='project-70 [a1b2c3]'
# The brief's own directory, normalised the way `os.path.abspath` normalises it: the
# double slash the test's own $TMPDIR can carry is collapsed, but no symlink is resolved
# (unlike `pwd -P`, which would turn `/tmp` into `/private/tmp` and never match).
BABS=$(cd "$B" && pwd)
out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/good.md" --orchestrator "$ORCHREF" 2>&1)
check_status "a lint-clean brief spawns" 0 env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/good.md" --orchestrator "$ORCHREF"
check "the built prompt reads exactly" "1" \
  "$(printf '%s\n' "$out" | grep -Fc "prompt=Read and execute $BABS/good.md. Your orchestrator is $ORCHREF; handshake first, silence rule 15 min.")"
check "the lint verdict is shown" "1" "$(printf '%s\n' "$out" | grep -c '^lint=brief-lint: .*0 findings$')"

# A relative brief path still resolves to the absolute one the fresh session can open.
# A relative path goes through `os.getcwd()`, which the OS resolves PHYSICALLY (symlinks
# followed) — `pwd -P`, not the `pwd` used above for an already-absolute path, which
# `os.path.abspath` only normalises lexically and never touches a symlink in.
BPHYS=$(cd "$B" && pwd -P)
out=$(cd "$B" && ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief good.md --orchestrator "$ORCHREF" 2>&1)
check "a relative brief path resolves absolute in the prompt" "1" \
  "$(printf '%s\n' "$out" | grep -Fc "prompt=Read and execute $BPHYS/good.md.")"

check_status "--brief with --prompt is mutually exclusive" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/good.md" --orchestrator "$ORCHREF" --prompt x
check_status "--brief with --prompt-file is mutually exclusive" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/good.md" --orchestrator "$ORCHREF" --prompt-file "$B/good.md"
check_status "--brief without --orchestrator is refused" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/good.md"
check_status "a brief that does not exist refuses the spawn" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/absent.md" --orchestrator "$ORCHREF"

# A brief with a lint finding refuses the spawn and prints the finding — before any tab
# exists, and before a prompt file is written for a spawn that will never happen.
out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/placeholder.md" --orchestrator "$ORCHREF" 2>&1); code=$?
check "a brief with a lint finding refuses the spawn" "1" "$code"
check "the finding is printed" "1" "$(printf '%s\n' "$out" | grep -c 'unfilled placeholder')"

D9STATE=$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-XXXXXX")
ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$D9STATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/placeholder.md" --orchestrator "$ORCHREF" >/dev/null 2>&1
check "the lint refusal leaves no prompt file" "0" \
  "$(find "$D9STATE/prompts" -type f 2>/dev/null | wc -l | tr -d ' ')"
rm -rf "$D9STATE"

# A dry run touches nothing: a passing `spawn --brief`, a `--prompt` and a spawn with
# servers each name the files a real launch would write, and none is written.
D11STATE=$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-XXXXXX")
d11out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$D11STATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/good.md" --orchestrator "$ORCHREF" 2>&1)
check "a passing brief dry run writes nothing under the state directory" "0|1" \
  "$(find "$D11STATE" -type f | wc -l | tr -d ' ')|$(printf '%s\n' "$d11out" | grep -c "^prompt_file=$D11STATE/prompts/prompt-")"
ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$D11STATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : prompt" --prompt p >/dev/null 2>&1
check "a --prompt dry run writes nothing either" "0" "$(find "$D11STATE" -type f | wc -l | tr -d ' ')"
D11CAT="$D11STATE-cat.json"
printf '{"servers":{"a":{"command":"a-cmd"}},"default":["a"]}\n' > "$D11CAT"
d11out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$D11STATE" ORCHESTRATOR_MCP_CATALOGUE="$D11CAT" bash "$AGENT" spawn --dir "$WORK" --title "Agent : mcp" --prompt p 2>&1)
check "nor a dry run with servers, which still names its file" "0|1" \
  "$(find "$D11STATE" -type f | wc -l | tr -d ' ')|$(printf '%s\n' "$d11out" | grep -c "^mcp_file=$D11STATE/prompts/mcp-")"
rm -rf "$D11STATE" "$D11CAT"

echo "== model tiers =="

# The plugin binds capability tiers, never model names. `a-model` is the repository's
# placeholder for an identifier only the operator knows.
MAP="$WORK/models.json"
printf '{"deep":"a-model","standard":"b-model","light":""}\n' > "$MAP"

check "a bound tier resolves to its identifier" "a-model" \
  "$(env ORCHESTRATOR_MODELS_MAP="$MAP" bash "$AGENT" resolve-tier deep)"
check "an unbound tier resolves to nothing" "" \
  "$(env ORCHESTRATOR_MODELS_MAP="$MAP" bash "$AGENT" resolve-tier light)"
check_status "an unbound tier is not an error" 0 \
  env ORCHESTRATOR_MODELS_MAP="$MAP" bash "$AGENT" resolve-tier light
check_status "an unknown tier exits 1" 1 \
  env ORCHESTRATOR_MODELS_MAP="$MAP" bash "$AGENT" resolve-tier deepest
check "the environment overrides the map" "c-model" \
  "$(env ORCHESTRATOR_MODELS_MAP="$MAP" ORCHESTRATOR_TIER_DEEP=c-model bash "$AGENT" resolve-tier deep)"
# A tier bound to a versioned identifier went stale in silence: the family shipped a newer
# model and every agent at that tier ran the older one while the orchestrator ran the newer.
# The map is the operator's, so the launcher warns in one line and still launches (§57).
VMAP="$WORK/versioned.json"
printf '{"deep":"a-model-5-5","standard":"a-model","light":"a-model-4-5-20250101"}\n' > "$VMAP"
check "a versioned binding warns once, naming the tier, the id and the alias" "1|1" \
  "$(env ORCHESTRATOR_MODELS_MAP="$VMAP" bash "$AGENT" resolve-tier deep 2>&1 >/dev/null | grep -c .)|$(env ORCHESTRATOR_MODELS_MAP="$VMAP" bash "$AGENT" resolve-tier deep 2>&1 >/dev/null | grep -c 'tier deep is bound to the versioned identifier a-model-5-5, .* bind it to the family alias model instead')"
check "a dated binding warns too" "1" \
  "$(env ORCHESTRATOR_MODELS_MAP="$VMAP" bash "$AGENT" resolve-tier light 2>&1 >/dev/null | grep -c 'versioned identifier a-model-4-5-20250101')"
check "and still resolves to it" "a-model-5-5" \
  "$(env ORCHESTRATOR_MODELS_MAP="$VMAP" bash "$AGENT" resolve-tier deep 2>/dev/null)"
check "a family alias does not warn" "" \
  "$(env ORCHESTRATOR_MODELS_MAP="$VMAP" bash "$AGENT" resolve-tier standard 2>&1 >/dev/null)"
check "a versioned override warns once and still resolves to it" "1|a-model-5-5" \
  "$(env ORCHESTRATOR_MODELS_MAP="$MAP" ORCHESTRATOR_TIER_DEEP=a-model-5-5 bash "$AGENT" resolve-tier deep 2>&1 >/dev/null | grep -c 'versioned identifier a-model-5-5')|$(env ORCHESTRATOR_MODELS_MAP="$MAP" ORCHESTRATOR_TIER_DEEP=a-model-5-5 bash "$AGENT" resolve-tier deep 2>/dev/null)"
check "a versioned id with a variant suffix warns, the suffix kept on the alias" "1" \
  "$(env ORCHESTRATOR_MODELS_MAP="$MAP" ORCHESTRATOR_TIER_DEEP='a-model-5-5[1m]' bash "$AGENT" resolve-tier deep 2>&1 >/dev/null | grep -cF 'bind it to the family alias model[1m] instead')"
check "a versioned binding warns at spawn and still launches it" "1|1" \
  "$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$VMAP" bash "$AGENT" spawn --dir "$WORK" --title 'Agent : x' --prompt p --tier deep 2>&1 | grep -c 'versioned identifier')|$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$VMAP" bash "$AGENT" spawn --dir "$WORK" --title 'Agent : x' --prompt p --tier deep 2>/dev/null | grep -c -- '--model a-model-5-5 ')"
# A map the operator wrote and jq cannot read is NOT an unbound tier. Treating the two
# alike routes every dispatch to the host default while the orchestrator reports the tier
# it believes it asked for — a missing comma, and the whole routing is quietly advisory.
printf '%s' '{"deep":"a-model"' > "$WORK/broken.json"
check_status "a map that does not parse is refused" 1 \
  env ORCHESTRATOR_MODELS_MAP="$WORK/broken.json" bash "$AGENT" resolve-tier deep
: > "$WORK/empty-map.json"
check_status "an empty map file is refused" 1 \
  env ORCHESTRATOR_MODELS_MAP="$WORK/empty-map.json" bash "$AGENT" resolve-tier deep
printf '%s' '["deep","a-model"]' > "$WORK/array-map.json"
check_status "a map that is not an object is refused" 1 \
  env ORCHESTRATOR_MODELS_MAP="$WORK/array-map.json" bash "$AGENT" resolve-tier deep
# ...while a map that parses and simply binds nothing stays the ordinary "let the host
# choose" case, which is what the installer writes on a fresh machine.
printf '%s' '{}' > "$WORK/nobindings.json"
check_status "a map with no bindings is not an error" 0 \
  env ORCHESTRATOR_MODELS_MAP="$WORK/nobindings.json" bash "$AGENT" resolve-tier deep
check "a map with no bindings resolves to nothing" "" \
  "$(env ORCHESTRATOR_MODELS_MAP="$WORK/nobindings.json" bash "$AGENT" resolve-tier deep)"
# And the refusal has to stop the launch, not just print: same shape as the rotation that
# opened a tab for a tier that did not exist. --title and --prompt are required so this
# check fails on the map, not on the title or promptless refusals running ahead of it
# (verified: with the map made valid, this same call exits 0 and the check falls, as it
# must not with a broken one).
check_status "a broken map stops the spawn" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$WORK/broken.json" \
  bash "$AGENT" spawn --dir "$WORK" --title "Agent : x" --tier deep --prompt p

check "a missing map is an all-empty map" "" \
  "$(env ORCHESTRATOR_MODELS_MAP="$WORK/absent.json" bash "$AGENT" resolve-tier standard)"
check_status "a missing map is not an error" 0 \
  env ORCHESTRATOR_MODELS_MAP="$WORK/absent.json" bash "$AGENT" resolve-tier standard
check "resolve-tier wants exactly one tier" "ERROR: resolve-tier: exactly one tier is required (deep, standard or light)" \
  "$(bash "$AGENT" resolve-tier 2>&1)"

tcmd() {
  local out
  out=$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
    bash "$AGENT" spawn --dir "$WORK" --title "Agent : tier" --prompt p "$@" 2>&1)
  out=${out#*launch=}; printf '%s' "${out%%$'\n'*}"
}
check "a bound tier is typed as the model argument" "1" "$(tcmd --tier deep | grep -c -- '--model a-model')"
check "an unbound tier types no model argument" "0" "$(tcmd --tier light | grep -c -- '--model')"
check "an explicit model is typed as given" "1" "$(tcmd --model b-model | grep -c -- '--model b-model')"
check_status "--tier and --model together are refused" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
  bash "$AGENT" spawn --dir "$WORK" --tier deep --model b-model --prompt p
mkdir -p "$ISTATE/ctx"
printf '{"session_id":"s-inh","model_id":"a-model","updated_epoch":%s}\n' "$(date +%s)" > "$ISTATE/ctx/s-inh.json"
check "inherit-model types the calling session's model" "1" \
  "$(CLAUDE_CODE_SESSION_ID=s-inh ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Orch : heir" --inherit-model --prompt p 2>&1 | sed -n 's/^launch=//p' | grep -c -- '--model a-model')"
check "inherit-model with no tap file refuses and names the installer" "1" \
  "$(CLAUDE_CODE_SESSION_ID=s-none ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --inherit-model --prompt p 2>&1 | grep -c 'orchestrator:install')"
check "inherit-model is exclusive with a tier" "1" \
  "$(CLAUDE_CODE_SESSION_ID=s-inh ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --inherit-model --tier deep --prompt p 2>&1 | grep -c 'exclusive')"
check_status "an unknown tier is refused at spawn" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
  bash "$AGENT" spawn --dir "$WORK" --tier deepest --prompt p
# rotate performs a real close, so its forwarding is checked on the source, as the
# suite already checks that rotate inherits the spawn's verification.
check "rotate forwards the tier to the spawn" "1" \
  "$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
      bash "$AGENT" rotate --old-tty /dev/ttys999 --dir "$WORK" --title "Agent : rotated" --tier deep --prompt p 2>&1 | grep -c -- '--model a-model')"
check "rotate closes the old tab only after the spawn" "1" \
  "$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
      bash "$AGENT" rotate --old-tty /dev/ttys999 --dir "$WORK" --title "Agent : rotated" --tier deep --prompt p 2>&1 | tail -1 | grep -c '^close=/dev/ttys999')"
# The rotation's spawn receives every argument the rotation does not consume, --trust
# included — but the tab skill's line never said so, and a live rotation into a fresh
# checkout was refused on the trust question and redone by hand (§39). Read on the record
# the spawn writes, which is the only artifact that says the flag arrived.
ROTDIR="$WORK/rot-untrusted"; mkdir -p "$ROTDIR"
printf '{"projects":{}}' > "$TRUSTF"
check "rotate forwards --trust to the spawn, which records it" "true" \
  "$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
      bash "$AGENT" rotate --old-tty /dev/ttys999 --dir "$ROTDIR" --title "Agent : rotated" --tier deep --trust --prompt p >/dev/null 2>&1; \
     "$py" -c "import json,os,sys; d=json.load(open(sys.argv[1])); print(str(d['projects'].get(os.path.realpath(sys.argv[2]),{}).get('hasTrustDialogAccepted')).lower())" "$TRUSTF" "$ROTDIR")"
# The rotation forwards --mcp too: an agent that needed a server is replaced by one that
# still has it. It is not in the refused list below, and the dry run is where the
# forwarding is read (§42) — with the name, since the flag carries one now.
check "rotate forwards --mcp to the spawn, with its name" "a,b" \
  "$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" ORCHESTRATOR_MCP_CATALOGUE="$CAT" \
      bash "$AGENT" rotate --old-tty /dev/ttys999 --dir "$WORK" --title "Agent : rotated" --mcp b --prompt p 2>&1 | sed -n 's/^mcp=//p')"
# A rotation replaces an agent with a titled agent; a successor, an escape from the title
# shape, or a plain agent stripped of remote control are none of that — each is refused
# before the replacement is spawned.
rot_refuse() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" \
  rotate --old-tty /dev/ttys999 --dir "$WORK" --title "Agent : rotated" "$@" 2>&1; }
check "rotate refuses --successor" "1" \
  "$(rot_refuse --successor | grep -c -- '--successor is not a rotation')"
check "rotate refuses --title-free" "1" \
  "$(rot_refuse --title-free | grep -c -- '--title-free is not a rotation')"
check "rotate refuses --no-remote-control" "1" \
  "$(rot_refuse --no-remote-control | grep -c -- '--no-remote-control is not a rotation')"
# ...and forwarding is not enough: the refusal has to STOP the rotation. A tier that does
# not resolve once opened a real tab with no model at all, because the failure was swallowed
# crossing a shell substitution. The guard reads what comes LAST: an exit code alone would
# pass on that bug too, since the close that followed failed on its own.
rot=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
  bash "$AGENT" rotate --dir "$WORK" --old-tty /dev/ttys999 --tier bogus --prompt p 2>&1 || true)
check "an unresolvable tier stops the rotation, and nothing runs after it" \
  "ERROR: resolve-tier: unknown tier: bogus (expected deep, standard or light)" "$(printf '%s' "$rot" | tail -1)"

echo "== context gate hook =="
# A fake config dir with a tap file: at 85 % the hook orders the succession, at 30 % it
# prints nothing, and with no tap file it says « unmeasured » exactly once. The default gate
# is 80, not the old 60: a figure of 70 must stay under it and stay silent.
GH="$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-XXXXXX")"; mkdir -p "$GH/claude-orchestrator/ctx"
now=$(date +%s)
printf '{"session_id":"g-hi","context_percent":85,"updated_epoch":%s}\n' "$now" > "$GH/claude-orchestrator/ctx/g-hi.json"
printf '{"session_id":"g-lo","context_percent":30,"updated_epoch":%s}\n' "$now" > "$GH/claude-orchestrator/ctx/g-lo.json"
printf '{"session_id":"g-under","context_percent":70,"updated_epoch":%s}\n' "$now" > "$GH/claude-orchestrator/ctx/g-under.json"
gate() { printf '{"session_id":"%s"}' "$1" | CLAUDE_CONFIG_DIR="$GH" bash "$ROOT/hooks/context-gate.sh"; }
check "past the gate the hook orders the succession" "1" "$(gate g-hi | grep -c 'SUCCEEDS at the next quiet boundary')"
check "under the gate the hook is silent" "" "$(gate g-lo)"
check "the default gate is 80, not 60: 70 stays under it" "" "$(gate g-under)"
check "unmeasured says so once" "1" "$(gate g-none | grep -c 'unmeasured'; )"
check "unmeasured stays silent the second time" "" "$(gate g-none)"

# The model that answers can be switched under a session by the host's own fallback, and
# nothing showed it (§32). The gate keeps the last model it read and says a change once —
# a line the session cannot miss, where the status line showed nothing.
mkdir -p "$GH/projects/p"
printf '{"type":"assistant","message":{"model":"a-model","usage":{"input_tokens":1,"cache_creation_input_tokens":1,"cache_read_input_tokens":1}}}\n' > "$GH/projects/p/g-drift.jsonl"
printf '{"session_id":"g-drift","context_percent":30,"updated_epoch":%s}\n' "$now" > "$GH/claude-orchestrator/ctx/g-drift.json"
check "the first reading of the model is silent" "" "$(gate g-drift)"
printf '{"type":"assistant","message":{"model":"b-model","usage":{"input_tokens":1,"cache_creation_input_tokens":1,"cache_read_input_tokens":1}}}\n' >> "$GH/projects/p/g-drift.jsonl"
check "a changed model is said once, naming both" "1" "$(gate g-drift | grep -c 'MODEL DRIFT: this session now answers as b-model; it answered as a-model until now')"
check "and not again while it holds" "" "$(gate g-drift)"
rm -rf "$GH"

echo "== context threshold sweep =="
# The operator's ruling: every context limit is 80 %, the previous figure nowhere left as a
# context threshold, none at all. Same pattern as the repository-policy sweeps above, its
# \b rewritten as a portable non-digit lookaround: this git's -E engine does not honor \b
# (confirmed: it drops every \b-anchored match silently instead of erroring). This file is
# excluded from the swept tree: it necessarily carries the retired figure in the pattern
# below and in its own fixture. The three keywords (gate, threshold, context) are matched in
# both orders around the figure, and a bash default-value assignment on a GATE-named variable
# is matched in its three common spellings (:-, :=, =), case-insensitively, since a stray env
# default is as live a threshold as prose is.
OLD_FIGURE=60
THRESHOLD_RE="([^0-9]|^)${OLD_FIGURE} ?%|~${OLD_FIGURE}|sixty|(gate|threshold|context).{0,20}${OLD_FIGURE}|${OLD_FIGURE}.{0,20}(gate|threshold|context)|GATE ?(:-|:=|=) ?${OLD_FIGURE}"
check "no context threshold other than 80 % remains in the tracked tree" "" \
  "$(cd "$ROOT" && git grep -n -E -i "$THRESHOLD_RE" -- . ':!tests/run-tests.sh' 2>/dev/null)"

# Proof the sweep still catches a stale figure, planted only into a scratch copy — one file
# per spelling it must catch.
SWEEP="$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-sweep-XXXXXX")"
printf 'Mark sessions past %s%%\n' "$OLD_FIGURE" > "$SWEEP/note.md"
printf 'the threshold sits above %s still\n' "$OLD_FIGURE" > "$SWEEP/threshold-first.md"
printf 'the context reads %s during setup\n' "$OLD_FIGURE" > "$SWEEP/context-first.md"
printf 'GATE:-%s\n' "$OLD_FIGURE" > "$SWEEP/gate-default.sh"
printf 'export GATE:=%s\n' "$OLD_FIGURE" > "$SWEEP/gate-walrus.sh"
printf 'export GATE=%s\n' "$OLD_FIGURE" > "$SWEEP/gate-eq.sh"
printf 'export gate=%s\n' "$OLD_FIGURE" > "$SWEEP/gate-lower.sh"
check "the sweep catches a figure planted in a scratch copy" "1" \
  "$(grep -rn -E -i "$THRESHOLD_RE" "$SWEEP" | grep -c "past $OLD_FIGURE")"
check "the sweep catches the threshold-before-figure order" "1" \
  "$(grep -rn -E -i "$THRESHOLD_RE" "$SWEEP" | grep -c 'threshold sits above')"
check "the sweep catches the context-before-figure order" "1" \
  "$(grep -rn -E -i "$THRESHOLD_RE" "$SWEEP" | grep -c 'context reads')"
check "the sweep catches a GATE:- default" "1" \
  "$(grep -rn -E -i "$THRESHOLD_RE" "$SWEEP" | grep -c 'GATE:-60')"
check "the sweep catches a GATE:= assignment" "1" \
  "$(grep -rn -E -i "$THRESHOLD_RE" "$SWEEP" | grep -c 'GATE:=60')"
check "the sweep catches a GATE= assignment" "1" \
  "$(grep -rn -E -i "$THRESHOLD_RE" "$SWEEP" | grep -c 'export GATE=60')"
check "the sweep catches a lowercase gate= assignment" "1" \
  "$(grep -rn -E -i "$THRESHOLD_RE" "$SWEEP" | grep -c 'export gate=60')"
rm -rf "$SWEEP"

echo "== push guard hook =="
# Active only in a session the launcher spawned (ORCHESTRATOR_SPAWNED, set by build_command
# in the launch script): the operator's own sessions carry no such marker and are never
# touched. Refuses `git push` carrying `--force`, `-f`, a `+<refspec>`, or
# `--force-with-lease` without the `<branch>:<sha>` form (phase 3 ruling 5).
GUARD="$ROOT/hooks/push-guard.sh"
guard_payload() {  # tool_name command
  "$py" -c "import json,sys; json.dump({'tool_name': sys.argv[1], 'tool_input': {'command': sys.argv[2]}}, sys.stdout)" "$1" "$2"
}
guard() { guard_payload "$1" "$2" | env ORCHESTRATOR_SPAWNED="${3-}" bash "$GUARD"; }

check_status "a marked session refuses a forced push" 2 guard Bash "git push --force origin main" 1
check "the refusal names the flag it will accept" "1" \
  "$(guard Bash 'git push --force origin main' 1 2>&1 | grep -c -- '--force-with-lease=<branch>:<sha>')"
check_status "a marked session refuses -f" 2 guard Bash "git push -f origin main" 1
check_status "a marked session refuses a +refspec" 2 guard Bash "git push origin +feature:main" 1
check_status "a marked session refuses a bare --force-with-lease" 2 guard Bash "git push --force-with-lease origin main" 1
check_status "a marked session refuses --force-with-lease without a colon" 2 guard Bash "git push --force-with-lease=main origin main" 1
check_status "a marked session accepts --force-with-lease=<branch>:<sha>" 0 guard Bash "git push --force-with-lease=main:$(printf 'a%.0s' $(seq 1 40)) origin main" 1
check_status "a marked session accepts a plain push" 0 guard Bash "git push origin main" 1
check_status "a marked session accepts an unrelated command" 0 guard Bash "git status" 1
check_status "a forced push earlier in the line, unrelated to the push, is not read as forcing it" 0 \
  guard Bash "git fetch -f && git push origin main" 1

check_status "an unmarked session is untouched by a forced push" 0 guard Bash "git push --force origin main" ""
check_status "a non-Bash tool is untouched" 0 guard Write "git push --force origin main" 1

# A push is git in command position — bare or by an absolute path, behind git's own global
# options, assignments or a wrapper that runs it — then `push`. The first matching read
# `git push` as two adjacent words and let every one of these through.
SHA40=$(printf 'a%.0s' $(seq 1 40))
for c in "git -C /tmp/r push --force" "git -C . push --force-with-lease" "git -c x=y push -f" \
         "git --no-pager push -f" "/usr/bin/git push -f origin main" \
         "git --git-dir=/tmp/r/.git --work-tree /tmp/r push -f" "FOO=1 git push -f" \
         "timeout 60 git push --force origin main" "env -u X git push -f"; do
  check_status "refused: $c" 2 guard Bash "$c" 1
done
# `-f` inside a cluster of short flags is a force; `-o` takes a value, so what follows it
# is not a cluster member nor a refspec.
for c in "git push -uf origin main" "git push -fu origin main" "git push -vf" "git push -nf"; do
  check_status "refused: $c" 2 guard Bash "$c" 1
done
check_status "a push option's value is not a flag or a refspec" 0 guard Bash "git push -o +foo origin main" 1
check_status "nor when it is glued to -o" 0 guard Bash "git push -o+foo -v origin main" 1
# Quotes and shell punctuation are the shell's, not the flag's: unquoted, split on the
# operators, the words git receives are the ones read.
for c in "(cd x && git push -f)" "git push -f)" 'git push "-f"' 'git push origin "+main"' \
         "git push origin 'a:b' '+x'" 'git push -f`true`' "git push -f>out" "{ git push -f; }" \
         "git push origin main 2>/dev/null --force"; do
  check_status "refused: $c" 2 guard Bash "$c" 1
done
check_status "refused: a force behind a line continuation" 2 guard Bash 'git push \
  --force origin main' 1
# Every lease is read, not the first one: one unpinned lease beside a pinned one is a force.
check_status "refused: a pinned lease beside a bare one" 2 guard Bash "git push --force-with-lease=main:$SHA40 --force-with-lease origin main" 1
check_status "refused: a pinned lease beside one with no sha" 2 guard Bash "git push --force-with-lease=main:$SHA40 --force-with-lease=other origin main" 1
check_status "two pinned leases pass" 0 guard Bash "git push --force-with-lease=main:$SHA40 --force-with-lease=dev:$SHA40 origin main dev" 1
check_status "a pinned lease with its output redirected passes" 0 guard Bash "git push --force-with-lease=main:$SHA40 origin main 2>&1 | tail -3" 1
# The other forms that overwrite a remote: --mirror, and the abbreviations of --force git
# accepts.
for c in "git push --mirror origin" "git push --fo origin main" "git push --for origin main" "git push --forc origin main"; do
  check_status "refused: $c" 2 guard Bash "$c" 1
done
# Text about a push is not a push. The first matching refused a commit message that
# mentioned one: a quoted argument of another command, a heredoc body and a comment are
# the shell's data, never a command.
check_status "a commit message quoting a forced push passes" 0 guard Bash 'git commit -m "fix; git push -f later"' 1
check_status "a pull request body quoting a forced push passes" 0 guard Bash 'gh pr create --body "rebase && git push --force is refused"' 1
check_status "a heredoc body naming a forced push passes" 0 guard Bash "git commit -F - <<'EOF'
subject

git push --force
EOF" 1
check_status "a heredoc inside a quoted substitution, with a stray quote in it, passes" 0 guard Bash "git commit -m \"\$(cat <<'EOF'
say \"why; git push -f is refused
EOF
)\"" 1
check_status "a comment after a plain push passes" 0 guard Bash "git push origin main # --force" 1
check_status "and a forced push after a heredoc is still read" 2 guard Bash "cat <<EOF
text
EOF
git push -f" 1
check_status "a forced push inside a command substitution is read" 2 guard Bash 'echo "$(git push -f)"' 1
# The refusal is the host's documented denial: a plain reason on stderr, exit 2, ending on
# the way out for a command that only mentions a push.
refusal=$(guard Bash "git push -f" 1 2>&1 >/dev/null)
check "the refusal is plain text, not a JSON object" "0" "$(printf '%s' "$refusal" | grep -c '^{')"
check "the refusal ends on the way out" "1" \
  "$(printf '%s' "$refusal" | grep -c 'put text that mentions a push in a file (`git commit -F`, `gh … --body-file`)\.$')"
# The guard that cannot read its input says so and lets the call through: it never blocks
# every command of a session because a tool is missing.
NOJQ="$WORK/nojq-bin"; mkdir -p "$NOJQ"
guard_payload Bash "git push -f" > "$WORK/nojq-payload.json"
nojq_out=$(env PATH="$NOJQ" ORCHESTRATOR_SPAWNED=1 "$(command -v bash)" "$GUARD" < "$WORK/nojq-payload.json" 2>&1); nojq_code=$?
check "without jq a marked session is let through, with one warning line" "0|1|1" \
  "$nojq_code|$(printf '%s\n' "$nojq_out" | grep -c .)|$(printf '%s' "$nojq_out" | grep -c 'jq')"

echo "== the app, stubbed =="
# A pane behind a maximized sibling is in the tab's all_sessions and not in its sessions.
# The stub is the smallest app that tells the two apart; the live round reads the real one.
STUB='
import asyncio, sys
sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
class S:
    def __init__(s, sid, tty, name): s.session_id=sid; s.tty=tty; s.name=name; s.closed=False
    async def async_get_variable(s, k): return {"tty": s.tty, "autoName": s.name}.get(k)
    async def async_close(s, force=False): s.closed=True
class T:
    def __init__(s, tid, visible, hidden): s.tab_id=tid; s.sessions=visible; s.all_sessions=visible+hidden
    async def async_close(s, force=False): raise AssertionError("tab closed")
class W:
    def __init__(s, tabs): s.window_id="w"; s.tabs=tabs
class App:
    def __init__(s, wins): s.windows=wins
a=S("A","/dev/ttys801","visible one"); b=S("B","/dev/ttys802","hidden one")
app=App([W([T("1",[a],[b])])])
'
py=$(command -v python3 || echo python3)
check "a hidden pane is found by its tty" "B" \
  "$("$py" -c "$STUB
_,_,s=asyncio.run(ia.find_tab(app,'/dev/ttys802')); print(s.session_id)" "$ROOT/skills/iterm-agents/scripts")"
check "the listing marks a hidden pane" "w1/t1 | /dev/ttys802 | hidden one | (host default) | hidden" \
  "$("$py" -c "$STUB
print([r for r in asyncio.run(ia.list_rows(app)) if 'ttys802' in r][0])" "$ROOT/skills/iterm-agents/scripts")"
# ...and the caller's own row, and no other, so an orchestrator reads which tab is its own
# before it anchors, moves or closes anything (§38). The name beside the title is the one
# the host process was launched with; the stub's other pane was launched with none.
printf '/dev/ttys801 /opt/x/host --name Orch : f --permission-mode auto\n' > "$WORK/ps-stub.txt"
check "the listing marks the caller's own row, names it, and marks no other" \
  "w1/t1 | /dev/ttys801 | visible one | Orch : f | self|0" \
  "$(ORCHESTRATOR_SELF_TTY=/dev/ttys801 ORCHESTRATOR_PS_TABLE="$WORK/ps-stub.txt" "$py" -c "$STUB
rows=asyncio.run(ia.list_rows(app))
print('%s|%d' % ([r for r in rows if 'ttys801' in r][0], len([r for r in rows if 'ttys802' in r and '| self' in r])))" "$ROOT/skills/iterm-agents/scripts")"
# The caller is not always IN the app. A session running in another terminal — a multiplexer,
# a plain shell, a remote one — still has a tty, `self_tty` still resolves it, and the app has
# no session on it. The chain is the app's and cannot be kept for a caller the app does not
# know; that is a fact to state, not a reason to fail. Observed: a spawn from such a session
# died on `AttributeError: 'NoneType' object has no attribute 'session_id'`, a traceback where
# the answer was « your tab is not one of mine, so I kept no chain » (§49).
check "a caller the app does not know has no session id, and does not raise" "" \
  "$("$py" -c "$STUB
print(asyncio.run(ia.own_session_id(app, '/dev/ttys999')))" "$ROOT/skills/iterm-agents/scripts")"
check "a caller with no tty at all is the same answer" "" \
  "$("$py" -c "$STUB
print(asyncio.run(ia.own_session_id(app, '')))" "$ROOT/skills/iterm-agents/scripts")"
check "a caller the app does know hands back its session id" "A" \
  "$("$py" -c "$STUB
print(asyncio.run(ia.own_session_id(app, '/dev/ttys801')))" "$ROOT/skills/iterm-agents/scripts")"
check "close closes the session and leaves the tab" "hidden one|True" \
  "$("$py" -c "$STUB
t=asyncio.run(ia.close_session(app,'/dev/ttys802','hidden')); print('%s|%s' % (t, b.closed))" "$ROOT/skills/iterm-agents/scripts")"

# `move`'s guard, live, is the §26 reading: a tty is recycled minutes after a close and
# the chain file named after it outlives its occupant, so an entry whose tty now belongs
# to a stranger's tab must not make that tab movable. The owner is the session sitting on
# the caller's tty RIGHT NOW, read from the app; the match is on the TAB id. The dry run
# has no app and keeps ORCHESTRATOR_SELF_ID and the tty, which is what its checks seed.
MSTUB='
import asyncio, sys
sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
class S:
    def __init__(s, sid, tty): s.session_id=sid; s.tty=tty
    async def async_get_variable(s, k): return {"tty": s.tty}.get(k)
class T:
    def __init__(s, tid, sess): s.tab_id=tid; s.sessions=[sess]; s.all_sessions=[sess]
class W:
    def __init__(s, tabs): s.window_id="w"; s.tabs=tabs
class App:
    def __init__(s, wins): s.windows=wins
app=App([W([T("1",S("S-LIVE","/dev/ttys801")), T("2",S("S-AGENT","/dev/ttys802"))])])
'
owned() { ORCHESTRATOR_STATE_DIR="$ISTATE" "$py" -c "$MSTUB
print(asyncio.run(ia.move_is_owned(app, sys.argv[2], sys.argv[3])))" "$ROOT/skills/iterm-agents/scripts" "$1" "$2"; }
mkdir -p "$ISTATE/chains"
printf '{"tab_id":"2","tty":"/dev/ttys802","owner":"S-LIVE"}\n' > "$ISTATE/chains/ttys801.jsonl"
check "a tab the caller's session launched is its own to move" "True" "$(owned /dev/ttys802 /dev/ttys801)"
check "and so is its own tab" "True" "$(owned /dev/ttys801 /dev/ttys801)"
# The entry names the right tty and the WRONG tab: a recycled tty with a stranger on it.
printf '{"tab_id":"9","tty":"/dev/ttys802","owner":"S-LIVE"}\n' > "$ISTATE/chains/ttys801.jsonl"
check "a recycled tty in the chain does not make a stranger's tab movable" "False" "$(owned /dev/ttys802 /dev/ttys801)"
# The entry names the right tab and another session: a chain file that outlived its owner.
printf '{"tab_id":"2","tty":"/dev/ttys802","owner":"S-GONE"}\n' > "$ISTATE/chains/ttys801.jsonl"
check "an entry another session wrote is not the caller's to move" "False" "$(owned /dev/ttys802 /dev/ttys801)"

echo "== iterm-agents: iTerm2 answers, or it is said why (§46) =="
# Every reading here is about the fault that made the launcher unkillable: the app stopped
# dispatching AppleEvents, the library asked it for a cookie through an UNBOUNDED
# `osascript`, and the call never returned. The suite stands both halves up with stubs, so
# none of it needs a window server.
IBIN="$WORK/ibin"
mkdir -p "$IBIN"
# An `osascript` that never answers, the way the app behaves when its main thread is wedged.
printf '#!/bin/bash\ncat >/dev/null\nsleep 60\n' > "$IBIN/osascript-deaf"
# One that answers the way a healthy app does.
printf '#!/bin/bash\ncat >/dev/null\necho 3.7.0\n' > "$IBIN/osascript-live"
# One that fails the way a missing app does.
printf '#!/bin/bash\ncat >/dev/null\necho "execution error: iTerm2 got an error" >&2\nexit 1\n' > "$IBIN/osascript-broken"
chmod +x "$IBIN"/osascript-*

ipy() { "$py" -c "
import sys
sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
$1
"; }

check "a bounded osascript that never answers is killed and reported as a timeout" "timeout" \
  "$(ORCHESTRATOR_OSASCRIPT="$IBIN/osascript-deaf" ORCHESTRATOR_PROBE_TIMEOUT=2 \
     ipy "print(ia.osascript_run('x')[0])")"
check "the deaf probe leaves no osascript behind" "0" \
  "$(ORCHESTRATOR_OSASCRIPT="$IBIN/osascript-deaf" ORCHESTRATOR_PROBE_TIMEOUT=2 \
     ipy "
import subprocess
ia.osascript_run('x')
print(subprocess.run(['pgrep','-f','osascript-deaf'],capture_output=True,text=True).stdout.count('\n'))")"
check "a live app answers the preflight with its version" "True 3.7.0" \
  "$(ORCHESTRATOR_OSASCRIPT="$IBIN/osascript-live" ipy \
     "print('%s %s' % ia.app_responsive())")"
check "a wedged app fails the preflight as a timeout, not as an error" "False timeout" \
  "$(ORCHESTRATOR_OSASCRIPT="$IBIN/osascript-deaf" ORCHESTRATOR_PROBE_TIMEOUT=2 ipy \
     "print('%s %s' % ia.app_responsive())")"
check "a refusing app fails the preflight as an error" "False error" \
  "$(ORCHESTRATOR_OSASCRIPT="$IBIN/osascript-broken" ipy \
     "print('%s %s' % ia.app_responsive())")"

# The sample is the only reading that tells « busy » from « wedged in a modal loop », and the
# modal loop is the one an operator clears with one keystroke. The stack below is the real
# one, trimmed: a context menu left open by a single right-click.
check "a modal menu in the sample is named as the cause, with its remedy" "modal|Escape" \
  "$(ipy "
c = ia.cause_from_sample('''
 1931 -[NSView _showMenuForEvent:]  (in AppKit)
 1931 -[NSMenuTrackingSession startRunningMenuEventLoop:]  (in AppKit)
''')
print('%s|%s' % ('modal' if 'MODAL' in c else 'no', 'Escape' if 'Escape' in c else 'no'))")"
check "a sheet is named the same way" "modal" \
  "$(ipy "print('modal' if 'MODAL' in ia.cause_from_sample('1 -[NSApplication runModalForWindow:]') else 'no')")"
check "an unrecognised stack is not called a modal loop" "other" \
  "$(ipy "print('modal' if 'MODAL' in ia.cause_from_sample('1 mach_msg_trap (in libsystem_kernel.dylib)') else 'other')")"
check "no sample at all says so instead of guessing" "sampled" \
  "$(ipy "print('sampled' if 'sampled' in ia.cause_from_sample('') else 'no')")"

echo "== iterm-agents: a self-anchor the app cannot resolve is lost, not fatal (§51) =="
# Two refusals that look alike and are not. A NAMED anchor the app does not know is a tab
# the caller got wrong: refuse it. The caller's OWN tty, when the app has no session on it,
# means the caller is running in another terminal — « beside itself » has no meaning there,
# and refusing it blocks the one spawn that exists to bring that session back into the app.
# Measured: a session outside the app could not spawn its own successor at all, which is the
# succession the operator ordered precisely to end that state.
anchored() { "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
print('[%s]' % ia.anchor_after_probe($1, sys.argv[1], sys.argv[2]))" "$2" "$3" 2>/dev/null; }

check "an anchor the app knows is kept" "[/dev/ttys802]" \
  "$(anchored True /dev/ttys802 /dev/ttys801)"
check "the caller's own tty, unknown to the app, is dropped" "[]" \
  "$(anchored False /dev/ttys006 /dev/ttys006)"
check "and the drop is said, naming the tty" "said" \
  "$("$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
ia.anchor_after_probe(False, '/dev/ttys006', '/dev/ttys006')" 2>&1 | grep -c ttys006 | sed 's/^1$/said/')"
check_status "a NAMED anchor the app does not know is still a refusal" 1 \
  "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
ia.anchor_after_probe(False, '/dev/ttys802', '/dev/ttys801')"

echo "== iterm-agents: the fallback ladder (§46, §48) =="
# AppleScript is the fallback and the ONLY one: it drove this plugin before the API existed.
# A third rung in another terminal was built, in tmux, and struck out by the operator — a
# session that is not an iTerm2 tab is not an agent he can see, place or close in the window
# he reads. When BOTH rungs are down the app is wedged, which has a one-keystroke remedy, so
# the launcher names it and STOPS. Stopping loudly on a fault with a known remedy is the
# repair; routing around it into a terminal he never asked for is not.
check "the ladder is the api, then applescript, and nothing else" "api applescript" \
  "$(ipy "print(' '.join(ia.backend_chain()))")"
check "no terminal outside the app is offered as a rung" "api applescript" \
  "$(ipy "print(' '.join(ia.BACKENDS))")"
check "a named backend is the only rung tried" "applescript" \
  "$(ORCHESTRATOR_BACKEND=applescript ipy "print(' '.join(ia.backend_chain()))")"
check "the api can be named alone, for a caller that wants the failure" "api" \
  "$(ORCHESTRATOR_BACKEND=api ipy "print(' '.join(ia.backend_chain()))")"
check_status "an unknown backend is refused, not silently ignored" 1 \
  env ORCHESTRATOR_BACKEND=carrier-pigeon "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia; ia.backend_chain()"
check_status "and the rung that was struck out is refused by name" 1 \
  env ORCHESTRATOR_BACKEND=tmux "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia; ia.backend_chain()"
echo "== iterm-agents: a close is proved on the process table (§46) =="
# `close` printed « closed 1 session » on a session whose process was still running, and the
# operator read that line as a fact. The API's acknowledgement is that the request was taken,
# not that the session is gone; only the process table answers that.
printf '/dev/ttys901 /opt/x/claude --name Agent : survivor\n' > "$WORK/ps-alive.txt"
: > "$WORK/ps-empty.txt"
check "a session still in the process table is not reported closed" "still there" \
  "$(ORCHESTRATOR_PS_TABLE="$WORK/ps-alive.txt" ipy \
     "print('gone' if ia.wait_gone('/dev/ttys901', 1) is None else 'still there')")"
check "a session gone from the process table is reported closed" "gone" \
  "$(ORCHESTRATOR_PS_TABLE="$WORK/ps-empty.txt" ipy \
     "print('gone' if ia.wait_gone('/dev/ttys901', 1) is None else 'still there')")"
# The proof is about the host CLI and about nothing else. A tab holding only a shell has
# none to watch, the wait returns at once, and the close then rests on the app's word — true
# of the close and no evidence at all about an agent. Which of the two it was, is said.
check "a close with no agent to watch says its proof is the app's word" "said" \
  "$(ipy "print('said' if 'app' in ia.close_note('/dev/ttys901', None) else 'silent')")"
check "a close that watched an agent leave adds nothing" "" \
  "$(ipy "print(ia.close_note('/dev/ttys901', '4242'))")"
check "and what survived is named, so the operator reads which process held on" "claude" \
  "$(ORCHESTRATOR_PS_TABLE="$WORK/ps-alive.txt" ipy \
     "print('claude' if 'claude' in (ia.wait_gone('/dev/ttys901', 1) or '') else 'unnamed')")"

echo "== tap =="

TAP="$ROOT/skills/context-gauge/scripts/statusline-tap.sh"
# The payload shape is the one the host actually sends: context_window carries
# used_percentage, context_window_size and a current_usage breakdown.
PAYLOAD='{"session_id":"s-1","transcript_path":"/t/s-1.jsonl","context_window":{"used_percentage":36.4,"context_window_size":250000,"current_usage":{"input_tokens":1000,"cache_creation_input_tokens":2000,"cache_read_input_tokens":88000}},"rate_limits":{"five_hour":{"used_percentage":3,"resets_at":1788560000},"seven_day":{"used_percentage":1,"resets_at":1788900000}}}'
STATE="$WORK/state"

out=$(printf '%s' "$PAYLOAD" | ORCHESTRATOR_STATE_DIR="$STATE" bash "$TAP")
check "no wrapped command: one-line render, context only" "ctx: 36%" "$out"
check "file written with every field, no rate-limit field even though the payload carries one" \
  '{"session_id":"s-1","context_percent":36.4,"context_used":91000,"context_total":250000,"transcript_path":"/t/s-1.jsonl","model_id":null}' \
  "$(jq -c 'del(.updated_epoch)' "$STATE/ctx/s-1.json")"
out=$(printf '{"session_id":"s-early","context_window":{"used_percentage":0}}' | ORCHESTRATOR_STATE_DIR="$STATE" bash "$TAP")
check "early payload without usage or transcript: nulls, no crash" \
  '{"session_id":"s-early","context_percent":0,"context_used":null,"context_total":null,"transcript_path":null,"model_id":null}' \
  "$(jq -c 'del(.updated_epoch)' "$STATE/ctx/s-early.json")"
# The model in use travels with the context figures: a succession hands it to the
# successor, and the launch line is not it — the operator may have switched since (§27).
printf '{"session_id":"s-m","model":{"id":"a-model","display_name":"A"},"context_window":{"used_percentage":10}}' | ORCHESTRATOR_STATE_DIR="$STATE" bash "$TAP" >/dev/null
check "the tap records the model in use" "a-model" "$(jq -r '.model_id' "$STATE/ctx/s-m.json")"
rm -f "$STATE/ctx/s-m.json"
age=$(( $(date +%s) - $(jq '.updated_epoch' "$STATE/ctx/s-1.json") ))
check "updated_epoch is now" "recent" "$([ "$age" -lt 5 ] && echo recent || echo "$age s old")"

cat > "$WORK/echo.sh" <<'EOF'
#!/bin/bash
cat
exit 3
EOF
chmod +x "$WORK/echo.sh"
out=$(printf '%s' "$PAYLOAD" | ORCHESTRATOR_STATE_DIR="$STATE" bash "$TAP" "$WORK/echo.sh")
code=$?
check "payload passed byte-for-byte to the wrapped command" "$PAYLOAD" "$out"
check "wrapped command's exit status returned" "3" "$code"

out=$(printf 'not json' | ORCHESTRATOR_STATE_DIR="$STATE" bash "$TAP" "$WORK/echo.sh")
check "invalid stdin still reaches the wrapped command" "not json" "$out"
check "invalid stdin writes no file" "2" "$(ls "$STATE/ctx" | wc -l | tr -d ' ')"
out=$(printf '' | ORCHESTRATOR_STATE_DIR="$STATE" bash "$TAP")
check "empty stdin renders a placeholder" "ctx: ~" "$out"

touch -t 202001010000 "$STATE/ctx/old.json"
# The gate writes a marker beside the context files so it says "unmeasured" once per
# session rather than on every prompt. Nothing removed them: the sweep took `*.json` only,
# so the plugin pruned half of what it makes, and the markers outnumbered the files they
# sat beside — twenty-six of them on the machine this was found on, the oldest four days
# old. Kill what you start, delete what you build.
touch -t 202001010000 "$STATE/ctx/old.gate-unmeasured"
touch "$STATE/ctx/today.gate-unmeasured"
touch -t 202001010000 "$STATE/ctx/old.model"
printf '%s' "$PAYLOAD" | sed 's/s-1/s-2/' | ORCHESTRATOR_STATE_DIR="$STATE" bash "$TAP" >/dev/null
check "stale files pruned on a session's first render" "gone" "$([ -f "$STATE/ctx/old.json" ] && echo kept || echo gone)"
check "stale gate markers pruned with them" "gone" "$([ -f "$STATE/ctx/old.gate-unmeasured" ] && echo kept || echo gone)"
check "a marker from today is kept" "kept" "$([ -f "$STATE/ctx/today.gate-unmeasured" ] && echo kept || echo gone)"
check "stale model markers pruned with them" "gone" "$([ -f "$STATE/ctx/old.model" ] && echo kept || echo gone)"

echo "== gauge =="

GAUGE="$ROOT/skills/context-gauge/scripts/context-gauge.sh"
GSTATE="$WORK/gstate"
mkdir -p "$GSTATE/ctx" "$WORK/projects/p1"
cp "$ROOT/tests/fixtures/transcript.jsonl" "$WORK/projects/p1/g-1.jsonl"
printf '{"session_id":"g-1","context_percent":36.4,"context_used":91000,"context_total":250000,"transcript_path":null,"updated_epoch":%s}\n' \
  "$(date +%s)" > "$GSTATE/ctx/g-1.json"
gauge() { ORCHESTRATOR_STATE_DIR="$GSTATE" ORCHESTRATOR_TRANSCRIPTS_DIR="$WORK/projects" bash "$GAUGE" "$@"; }

# g-2 has no transcript under the projects directory: only the path recorded in
# its stale tap file can lead to it.
printf '{"session_id":"g-2","context_percent":36.4,"context_used":91000,"context_total":250000,"transcript_path":"%s","updated_epoch":0}\n' \
  "$WORK/projects/p1/g-1.jsonl" > "$GSTATE/ctx/g-2.json"
check "stale tap file: transcript found through its recorded path" "context_percent=36.0
context_tokens=90000
context_window=250000
context_window_source=tap-file
model=a-model
model_source=transcript
source=transcript" "$(gauge g-2)"

# A tap file carrying a rate-limit field (a payload from before this build, or a host
# that still sends one) is read for context and model alone — no five_hour_percent, no
# seven_day_percent, in either tier's output.
printf '{"session_id":"g-3","context_percent":36.4,"context_used":91000,"context_total":250000,"five_hour_percent":3,"seven_day_percent":1,"transcript_path":null,"updated_epoch":%s}\n' \
  "$(date +%s)" > "$GSTATE/ctx/g-3.json"
check "a tap file carrying a rate-limit field: no budget line in the output" "0" \
  "$(gauge g-3 | grep -cE '^(five_hour|seven_day)_percent=')"
rm -f "$GSTATE/ctx/g-3.json"

# No transcript reachable: the tap's declared model is the reading, said as the tap's.
printf '{"session_id":"g-4","context_percent":36.4,"context_used":91000,"context_total":250000,"transcript_path":null,"model_id":"t-model","updated_epoch":%s}\n' \
  "$(date +%s)" > "$GSTATE/ctx/g-4.json"
check "no transcript: the model comes from the tap, and says so" "model=t-model
model_source=tap" "$(gauge g-4 | grep '^model')"
rm -f "$GSTATE/ctx/g-4.json"

check "fresh tap file wins" "context_percent=36.4
context_tokens=91000
context_window=250000
model=a-model
model_source=transcript
source=tap" "$(gauge g-1)"

check "stale tap file: transcript with the file's window" "context_percent=36.0
context_tokens=90000
context_window=250000
context_window_source=tap-file
model=a-model
model_source=transcript
source=transcript" "$(gauge g-1 --max-age 0)"

rm "$GSTATE/ctx/g-1.json"
check "no tap file: --window" "context_percent=45.0
context_tokens=90000
context_window=200000
context_window_source=flag
model=a-model
model_source=transcript
source=transcript" "$(gauge g-1 --window 200000)"

check "session id from the environment, default window" "context_window_source=default" \
  "$(CLAUDE_CODE_SESSION_ID=g-1 gauge | grep context_window_source)"
check "assumed window carries a warning line" "1" "$(CLAUDE_CODE_SESSION_ID=g-1 gauge | grep -c '^warning=window assumed')"
check "known window carries no warning" "0" "$(gauge g-1 --window 200000 | grep -c '^warning=')"

check_status "nothing readable exits 1" 1 gauge nope
check_status "no session id exits 1" 1 env -u CLAUDE_CODE_SESSION_ID ORCHESTRATOR_STATE_DIR="$GSTATE" bash "$GAUGE"

echo "== the mode a session came up in (§43) =="
# Two agents stood on a permission prompt in tabs nobody watched. One carried
# `--permission-mode auto` on its process line and `default` in every entry of its
# transcript: the host accepted the flag and ignored it for that model. « The host CLI
# runs on the tty » is therefore not « the session is launched » — a session that runs and
# waits for a click is not — so the spawn reads the mode the session actually came up in.
# The reading itself needs a spawned session and belongs to the live round; what the suite
# reads is the pure functions it is built from, over fixture transcripts written here.
# Its own directory: the gauge's cases already keep fixtures under $WORK/projects, and two
# suites sharing a fixture tree is a check that passes on someone else's file.
PROJ="$WORK/mode-projects"
TGT="$WORK/mode-target"; mkdir -p "$TGT"
"$py" -c "
import json, os, sys, time
proj, tgt = sys.argv[1], os.path.realpath(sys.argv[2])
def write(path, cwd, modes):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as fh:
        # The shape the host writes: entries of several types, the mode on its own and the
        # working directory on another, and neither of them first — the mode arrives well
        # before the cwd, which is why the launcher polls for the cwd rather than the mode.
        fh.write(json.dumps({'type': 'last-prompt'}) + '\n')
        for m in modes:
            fh.write(json.dumps({'type': 'permission-mode', 'permissionMode': m}) + '\n')
        fh.write(json.dumps({'type': 'attachment', 'cwd': cwd}) + '\n')
    time.sleep(0.05)
# Written in this order, and the order is the fixture: a transcript is chosen by when it
# was CREATED, so creation order is what these checks read.
write(os.path.join(proj, 'p2', 'modeless.jsonl'), tgt, [])
write(os.path.join(proj, 'p1', 'older.jsonl'), tgt, ['auto'])
write(os.path.join(proj, 'p1', 'newer.jsonl'), tgt, ['acceptEdits', 'default'])
write(os.path.join(proj, 'p2', 'stranger.jsonl'), '/somewhere/else', ['default'])
" "$PROJ" "$TGT"

find_tr() { ORCHESTRATOR_PROJECTS_DIR="$PROJ" "$py" -c "
import os, sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
p = m.find_transcript(sys.argv[1], float(sys.argv[2]))
print(os.path.basename(p) if p else 'none')" "$1" "$2"; }
mode_of() { "$py" -c "
import sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
print(m.mode_of_transcript(sys.argv[1]) or 'none')" "$1"; }
refusal() { "$py" -c "
import sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
print(m.mode_refusal(sys.argv[1], sys.argv[2], sys.argv[3]))" "$1" "$2" "$3"; }
last_n() { "$py" -c "
import json, sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
print(json.dumps(m.last_lines(json.loads(sys.argv[1]), int(sys.argv[2])), separators=(',', ':')))" "$1" "$2"; }

# The mode is the FIRST one the transcript carries: the session announces what it came up
# in, and a later entry is the operator changing it by hand, which is not what the launch
# is being judged on. The newest fixture carries two, in that order.
check "the mode read is the first the transcript carries" "acceptEdits|auto|none" \
  "$(mode_of "$PROJ/p1/newer.jsonl")|$(mode_of "$PROJ/p1/older.jsonl")|$(mode_of "$PROJ/p2/modeless.jsonl")"
# Found by READING the entries, never by computing the host's directory slug: the slug is
# the host's own encoding of a path and this plugin has no business reproducing it.
# The newest transcript in the directory is the stranger's, and it is not the answer: the
# comparison is on the checkout the entries name, not on the clock alone.
check "the newest transcript naming THIS checkout wins, not the newest file" "newer.jsonl|stranger.jsonl" \
  "$(find_tr "$TGT" 0)|$("$py" -c "
import glob, os, sys
def born(p):
    st = os.stat(p)
    return getattr(st, 'st_birthtime', st.st_mtime)
print(os.path.basename(max(glob.glob(sys.argv[1] + '/*/*.jsonl'), key=born)))" "$PROJ")"
check "a checkout no transcript names has none" "none" \
  "$(find_tr "$WORK/mode-nobody" 0)"
check "nothing created since the launch is nothing to read" "none" \
  "$(find_tr "$TGT" 9999999999)"
check "the target's own directory is realpathed before the comparison" "newer.jsonl" \
  "$(find_tr "$TGT/." 0)"
# A transcript is chosen by when it was CREATED, never by when it was last written to: the
# host keeps writing to a session's transcript for as long as that session lives, so a file
# MODIFIED since the launch is very often an older session's — the caller's own, or the
# probe refused seconds earlier whose closing write landed after the next launch began.
# Measured live: two spawns into one checkout seconds apart, and the second read the first's
# mode; and a spawn into a checkout holding a live session read that session's.
PROJ2="$WORK/mode-projects-born"
TGT2="$WORK/mode-target-born"; mkdir -p "$TGT2"
SINCE=$("$py" -c "
import json, os, sys, time
proj, tgt = sys.argv[1], os.path.realpath(sys.argv[2])
def write(path, modes, mode_open='w'):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, mode_open) as fh:
        for m in modes:
            fh.write(json.dumps({'type': 'permission-mode', 'permissionMode': m}) + '\n')
        fh.write(json.dumps({'type': 'attachment', 'cwd': tgt}) + '\n')
stale = os.path.join(proj, 'p1', 'stale.jsonl')
fresh = os.path.join(proj, 'p1', 'fresh.jsonl')
write(stale, ['default'])
time.sleep(1.1)
since = time.time()
time.sleep(0.05)
write(fresh, ['acceptEdits'])
# The older session goes on writing: its modification time is now the newest of the two.
write(stale, ['default'], 'a')
print(since)" "$PROJ2" "$TGT2")
check "a transcript created before the launch is not this session's, however recently written" "fresh.jsonl|stale.jsonl" \
  "$(ORCHESTRATOR_PROJECTS_DIR="$PROJ2" "$py" -c "
import os, sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
p = m.find_transcript(sys.argv[1], float(sys.argv[2]))
print(os.path.basename(p) if p else 'none')" "$TGT2" "$SINCE")|$("$py" -c "
import glob, os, sys
print(os.path.basename(max(glob.glob(sys.argv[1] + '/*/*.jsonl'), key=os.path.getmtime)))" "$PROJ2")"

# The refusal names both modes and the model, because the repair depends on all three:
# the operator rebinds the tier, or spawns that agent in a mode the host does honour.
check "the refusal names both modes, the model, and the two repairs" \
  "spawn: refused: the session came up in mode 'default' and not 'auto' (model a-model): the host ignores the mode asked for this model; bind the tier to another model, or pass --permission-mode acceptEdits for an agent that only edits" \
  "$(refusal auto default a-model)"
check "with no model argument the refusal says so" \
  "spawn: refused: the session came up in mode 'default' and not 'auto' (model the host default): the host ignores the mode asked for this model; bind the tier to another model, or pass --permission-mode acceptEdits for an agent that only edits" \
  "$(refusal auto default "")"

# A refusal path that ends on a traceback is never an answer: `run()` catches nothing, so a
# close that raises while the caller is already dying on a refusal must not throw one on top.
closemade_raise() { "$py" -c "
import sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
def boom(coro_fn):
    raise RuntimeError('kaboom')
m.run = boom
print(m.close_made({'session_id': 'x'}))" 2>&1; }
closemade_ok() { "$py" -c "
import sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
m.run = lambda coro_fn: True
print(m.close_made({'session_id': 'x'}))"; }
# An exception with no message (`RuntimeError()`) has an empty str(), so splitlines() is an
# empty list: the branch written to say a failure must not throw an IndexError of its own
# reaching for [0].
closemade_raise_empty() { "$py" -c "
import sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
def boom(coro_fn):
    raise RuntimeError()
m.run = boom
print(m.close_made({'session_id': 'x'}))" 2>&1; }
check "a close that raises is said, not thrown, and returns False; one that works returns True" \
  "False|1|True|False|1" \
  "$(closemade_raise | tail -1)|$(closemade_raise | grep -c -- 'spawn: the refused session could not be closed: kaboom')|$(closemade_ok)|$(closemade_raise_empty | tail -1)|$(closemade_raise_empty | grep -c -- 'spawn: the refused session could not be closed: unknown error')"

# A named exception to "a gate that cannot measure lets the run through and says so" (§29):
# a session whose mode is unread may be parked on a dialog or hung at start, which the
# plugin already calls "not launched" — so the timeout no longer prints and lets the launch
# through, it refuses and closes the tab the spawn made, exactly like a mismatch. The
# polling loop itself (`find_transcript`/`mode_of_transcript`) is already covered above;
# what is new is the verdict once the loop ends, so it is tested through `verify_mode` with
# both stubbed and an injected no-op sleep — fixture driven, never a real tab.
unread_msg() { "$py" -c "
import sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
print(m.unread_refusal(sys.argv[1], sys.argv[2]))" "$1" "$2"; }
check "the unread refusal names the checkout, the timeout, and the remedy" "1|1|1|1" \
  "$(unread_msg /work/dir 20 | grep -c '^spawn: refused: no transcript for /work/dir')|$(unread_msg /work/dir 20 | grep -c 'parked on a dialog or hung at start')|$(unread_msg /work/dir 20 | grep -c 'the tab was closed')|$(unread_msg /work/dir 20 | grep -c 'ORCHESTRATOR_MODE_TIMEOUT')"

# `verify_mode` is the assembled decision the old inline block made: `path` of 'none' fakes
# a transcript that never appears (or one that never carries a mode, the same branch, per
# the closing round's ruling on an empty permissionMode); `timeout=1` with a no-op `sleep`
# makes one polling pass instant instead of a real wait.
verify_mode_run() { "$py" -c "
import sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
closed = []
m.close_made = lambda made: closed.append(made) or True
m.find_transcript = lambda d, since: (None if sys.argv[1] == 'none' else sys.argv[1])
m.mode_of_transcript = lambda p: sys.argv[2]
try:
    line = m.verify_mode('/checkout', 0, sys.argv[3], 'a-model', {'session_id': 'x'},
                          timeout=1, sleep=lambda s: None)
    print('ok=' + line)
except SystemExit as e:
    print('exit=%s' % e.code)
print('closed=%s' % bool(closed))" "$1" "$2" "$3"; }
out_unread=$(verify_mode_run none '' auto 2>/dev/null)
msg_unread=$(verify_mode_run none '' auto 2>&1 1>/dev/null)
check "an unread mode is refused, the made tab closed, the remedy said" "exit=1|True|1" \
  "$(printf '%s' "$out_unread" | sed -n '1p')|$(printf '%s' "$out_unread" | sed -n '2p' | sed 's/closed=//')|$(printf '%s' "$msg_unread" | grep -c 'parked on a dialog or hung at start')"
out_mismatch=$(verify_mode_run /checkout/t.jsonl default auto 2>/dev/null)
check "a mismatch is still refused, the made tab still closed" "exit=1|True" \
  "$(printf '%s' "$out_mismatch" | sed -n '1p')|$(printf '%s' "$out_mismatch" | sed -n '2p' | sed 's/closed=//')"
out_match=$(verify_mode_run /checkout/t.jsonl auto auto 2>/dev/null)
check "a readable matching mode still passes, and closes nothing" \
  "ok=spawn: mode auto read on the transcript|False" \
  "$(printf '%s' "$out_match" | sed -n '1p')|$(printf '%s' "$out_match" | sed -n '2p' | sed 's/closed=//')"

# `screen --lines N` returned the FIRST N lines of the tab, which on a tall terminal are
# blank: the blocked agent's prompt sat at the bottom and three reads out of four came back
# empty while the tooling reported success. Trailing blanks go, interior ones stay — a
# blank line between two of an agent's messages is part of what it is showing.
check "the screen is read from the bottom, trailing blanks dropped" '["b","c"]' \
  "$(last_n '["a","b","c","",""]' 2)"
check "a blank line inside the reading is kept" '["a","","b"]' \
  "$(last_n '["a","","b","",""]' 3)"
check "fewer lines than asked is the whole reading" '["a"]' \
  "$(last_n '["a",""]' 5)"
check "nothing but blanks reads as nothing" '[]' \
  "$(last_n '["","",""]' 3)"

# A dry run reads no transcript: there is no session to have come up in any mode, and the
# line says the check was skipped rather than passed.
check "the dry run skips the reading and says so" "1" \
  "$(shaped --title 'Agent : x' | grep -c '^mode_check=skipped$')"

echo "== install =="

H="$WORK/home"
mkdir -p "$H/.claude"
TAPDEST="$H/.claude/claude-orchestrator/statusline-tap.sh"
printf '{"statusLine":{"type":"command","command":"/x/bar.sh","padding":0},"other":1}\n' > "$H/.claude/settings.json"
env HOME="$H" bash "$ROOT/install.sh" >/dev/null 2>&1
check "existing command wrapped" "$TAPDEST /x/bar.sh" "$(jq -r '.statusLine.command' "$H/.claude/settings.json")"
check "other settings untouched" "1" "$(jq '.other' "$H/.claude/settings.json")"
check "previous statusLine saved" '{"type":"command","command":"/x/bar.sh","padding":0}' \
  "$(jq -c . "$H/.claude/claude-orchestrator/statusline.previous.json")"
check "tap copied and executable" "yes" "$([ -x "$TAPDEST" ] && echo yes || echo no)"
check "tier map created with three empty bindings" '{"deep":"","standard":"","light":""}' \
  "$(jq -c . "$H/.claude/claude-orchestrator/models.json")"
# The catalogue sits beside the tier map and is empty on a fresh install: the operator owns
# what his machine offers, and a plugin that guessed server definitions would hand every
# agent something nobody asked for (§42).
check "server catalogue created empty" '{"servers":{},"default":[]}' \
  "$(jq -c . "$H/.claude/claude-orchestrator/mcp.json")"
printf '{"deep":"a-model","standard":"","light":""}\n' > "$H/.claude/claude-orchestrator/models.json"
printf '{"servers":{"a":{"command":"a-cmd"}},"default":["a"]}\n' > "$H/.claude/claude-orchestrator/mcp.json"
catbefore=$(cat "$H/.claude/claude-orchestrator/mcp.json")
env HOME="$H" bash "$ROOT/install.sh" >/dev/null 2>&1
check "an existing tier map is never overwritten" "a-model" \
  "$(jq -r .deep "$H/.claude/claude-orchestrator/models.json")"
check "an existing catalogue is left byte for byte" "$catbefore" \
  "$(cat "$H/.claude/claude-orchestrator/mcp.json")"
check "the installer says which of the two it found" "1|1" \
  "$(env HOME="$H" bash "$ROOT/install.sh" 2>&1 | grep -c "server catalogue already present: $H/.claude/claude-orchestrator/mcp.json$")|$(env HOME="$H" bash "$ROOT/install.sh" 2>&1 | grep -c 'tier map already present')"
before=$(cat "$H/.claude/settings.json")
env HOME="$H" bash "$ROOT/install.sh" >/dev/null 2>&1
check "second run is a no-op" "$before" "$(cat "$H/.claude/settings.json")"
env HOME="$H" bash "$ROOT/uninstall.sh" >/dev/null 2>&1
check "uninstall restores the previous object" '{"type":"command","command":"/x/bar.sh","padding":0}' \
  "$(jq -c '.statusLine' "$H/.claude/settings.json")"
check "uninstall removes the state directory" "gone" "$([ -d "$H/.claude/claude-orchestrator" ] && echo kept || echo gone)"

H2="$WORK/home2"
mkdir -p "$H2/.claude"
printf '{}\n' > "$H2/.claude/settings.json"
env HOME="$H2" bash "$ROOT/install.sh" >/dev/null 2>&1
check "no statusLine: tap alone" "$H2/.claude/claude-orchestrator/statusline-tap.sh" \
  "$(jq -r '.statusLine.command' "$H2/.claude/settings.json")"
env HOME="$H2" bash "$ROOT/uninstall.sh" >/dev/null 2>&1
check "uninstall deletes the key it created" "null" "$(jq '.statusLine' "$H2/.claude/settings.json")"

H3="$WORK/home3"
mkdir -p "$H3/.claude"
printf '{"statusLine":{"type":"command","command":"/x/bar.sh"}}\n' > "$H3/.claude/settings.json"
env HOME="$H3" bash "$ROOT/install.sh" --dry-run >/dev/null 2>&1
check "dry-run changes nothing" "/x/bar.sh" "$(jq -r '.statusLine.command' "$H3/.claude/settings.json")"
check "dry-run creates no state directory" "none" "$([ -d "$H3/.claude/claude-orchestrator" ] && echo created || echo none)"
check "dry-run writes no tier map" "none" \
  "$([ -f "$H3/.claude/claude-orchestrator/models.json" ] && echo written || echo none)"
check "dry-run writes no catalogue, and says it would create one" "none|1" \
  "$([ -f "$H3/.claude/claude-orchestrator/mcp.json" ] && echo written || echo none)|$(env HOME="$H3" bash "$ROOT/install.sh" --dry-run 2>&1 | grep -c "\[dry-run\] server catalogue created: $H3/.claude/claude-orchestrator/mcp.json$")"

# A portable settings file spells the home as `$HOME` or `~`, and the host expands it when
# it runs the line; the installer compared the stored command to its expanded path and read
# such a file as unwired (live on the operator's machine, 11 September): a second run would
# wrap the tap twice, and uninstall would leave it. The fixture is wired by the installer
# itself, then rewritten the portable way, as the operator's configuration commit did.
for spelling in '$HOME' '~'; do
  H4="$WORK/home4"; rm -rf "$H4"; mkdir -p "$H4/.claude"
  printf '{"statusLine":{"type":"command","command":"/x/bar.sh","padding":0}}\n' > "$H4/.claude/settings.json"
  env HOME="$H4" bash "$ROOT/install.sh" >/dev/null 2>&1
  portable="$spelling/.claude/claude-orchestrator/statusline-tap.sh $spelling/.claude/statusbar/statusline.sh"
  jq --arg cmd "$portable" '.statusLine.command = $cmd' "$H4/.claude/settings.json" > "$H4/settings.tmp" \
    && mv "$H4/settings.tmp" "$H4/.claude/settings.json"
  before=$(cat "$H4/.claude/settings.json")
  out=$(env HOME="$H4" bash "$ROOT/install.sh" 2>&1)
  check "a command spelled with $spelling is read as already wired" "1" "$(printf '%s' "$out" | grep -c 'already wired')"
  check "and the settings file keeps its bytes ($spelling)" "$before" "$(cat "$H4/.claude/settings.json")"
  env HOME="$H4" bash "$ROOT/uninstall.sh" >/dev/null 2>&1
  check "uninstall restores through the $spelling spelling" '{"type":"command","command":"/x/bar.sh","padding":0}' \
    "$(jq -c '.statusLine' "$H4/.claude/settings.json")"
done

echo "== iterm-agents: the asyncio stderr filter (§29) =="

# The filter drops the library's own "Task exception was never retrieved" tracebacks —
# helper tasks ending on a socket our side closed, reported by the loop's default handler
# through this logger regardless of which loop owned the task — and passes every other
# record: a diagnosis the stream exists to carry is not of that shape. Read straight off
# the instance the module installed at import, never a stand-in built by the suite.
filter_probe() {
  "$py" -c "
import sys, logging
sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m


class ConnectionClosedError(Exception):
    pass


class OtherError(Exception):
    pass


def rec(msg, exc_cls):
    return logging.LogRecord('asyncio', logging.ERROR, 'probe.py', 1, msg, None,
                              (exc_cls, exc_cls(), None))


logger = logging.getLogger('asyncio')
filt = logger.filters[0]
print(filt.filter(rec('Task exception was never retrieved: boom', ConnectionClosedError)))
print(filt.filter(rec('Task exception was never retrieved: boom', OtherError)))
print(filt.filter(rec('some other diagnosis', ConnectionClosedError)))
print(len(logger.filters))
"
}
FILTOUT=$(filter_probe)
check "the filter drops the library's known noise" "False" "$(printf '%s\n' "$FILTOUT" | sed -n '1p')"
check "the filter passes the same message with another exception class" "True" \
  "$(printf '%s\n' "$FILTOUT" | sed -n '2p')"
check "the filter passes another message" "True" "$(printf '%s\n' "$FILTOUT" | sed -n '3p')"
check "exactly one filter instance is installed on the asyncio logger" "1" \
  "$(printf '%s\n' "$FILTOUT" | sed -n '4p')"

echo "== iterm script (argument validation, no automation) =="

ITERM="$ROOT/skills/iterm-agents/scripts/iterm-agent.sh"
check_status "close without --tty fails" 1 bash "$ITERM" close --expect-title x
check_status "move with identical ttys fails" 1 bash "$ITERM" move --tty /dev/ttys000 --left-of /dev/ttys000
check_status "spawn without --dir fails" 1 bash "$ITERM" spawn --title x
check_status "unknown subcommand fails" 1 bash "$ITERM" bogus
check "close error names the option" "ERROR: close: --tty is required" "$(bash "$ITERM" close 2>&1)"

echo "== coordinator =="

# The coordinator's record, its claims ledger and the overlap check are what nothing
# downstream re-checks: an orchestrator that reads a dead coordinator as alive speaks into
# the void, and one that reads a live one as dead talks over it. Every liveness answer here
# comes from the stub standing in for `iterm-agent.sh verify`, which reads a file of live
# ttys, so no real tab or session is ever needed; the state directory is a temporary one.
COORD="$ROOT/skills/coordinator/scripts/coordinator.sh"
CS="$WORK/coord-state"
CLIVE="$WORK/coord-live"
CWS="$WORK/coord-ws"
mkdir -p "$CS" "$CWS"
: > "$CLIVE"
cat > "$WORK/coord-verify" <<'EOF'
#!/bin/bash
[ "$1" = --tty ] && grep -qxF "$2" "$COORD_LIVE"
EOF
chmod +x "$WORK/coord-verify"
coord() {
  ORCHESTRATOR_STATE_DIR="$CS" COORDINATOR_VERIFY="$WORK/coord-verify" COORD_LIVE="$CLIVE" \
    ORCHESTRATOR_WORKSPACES="$CWS" bash "$COORD" "$@"
}
coord_status() { coord "$@" >/dev/null 2>&1; echo "exit $?"; }
live() { printf '%s\n' "$@" > "$CLIVE"; }
CREC="$CS/coordinator.json"
CLAIMS="$CS/claims.jsonl"

out=$(coord register --name "Coord : one [aaa111]" --tty /dev/ttys101 2>"$WORK/coord.err")
check "register prints what it recorded" "registered Coord : one [aaa111]" "$out"
check "register writes the name and the tty" "Coord : one [aaa111]|/dev/ttys101" \
  "$(jq -r '[.name,.tty]|join("|")' "$CREC" 2>/dev/null)"
check "register stamps the start in UTC" "1" \
  "$(jq -r '.started' "$CREC" 2>/dev/null | grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$')"
check "register leaves no lock behind" "0" "$([ -e "$CS/coordinator.lock" ] && echo 1 || echo 0)"

live /dev/ttys101
check "a second register is refused while the recorded one runs" "exit 1" \
  "$(coord_status register --name "Coord : two [bbb222]" --tty /dev/ttys102)"
check "the refusal names the live coordinator" \
  "coordinator: refused: a live coordinator is recorded: Coord : one [aaa111] on /dev/ttys101" \
  "$(coord register --name "Coord : two [bbb222]" --tty /dev/ttys102 2>&1 >/dev/null)"
check "a refused register leaves the live record alone" "Coord : one [aaa111]" "$(jq -r .name "$CREC")"

live
out=$(coord register --name "Coord : two [bbb222]" --tty /dev/ttys102 2>"$WORK/coord.err")
check "a record whose tty no longer runs the host is replaced" "registered Coord : two [bbb222]|/dev/ttys102" \
  "$out|$(jq -r .tty "$CREC")"
check "and the replacement is said" "coordinator: replaced a stale record: Coord : one [aaa111]" \
  "$(cat "$WORK/coord.err")"

# The record is written before it is announced: one that cannot be written is no
# registration, and one that cannot be read is replaced like a stale one.
cp "$CREC" "$WORK/coord-rec"
echo 'not json' > "$CREC"
out=$(coord register --name "Coord : r [r00001]" --tty /dev/ttys110 2>"$WORK/coord.err")
check "a corrupt record is replaced as an unreadable one" \
  "registered Coord : r [r00001]|coordinator: replaced a stale record: an unreadable record|Coord : r [r00001]" \
  "$out|$(cat "$WORK/coord.err")|$(jq -r .name "$CREC")"
rm -f "$CREC" && mkdir "$CREC"
out=$(coord register --name "Coord : r [r00001]" --tty /dev/ttys110 2>"$WORK/coord.err"); code=$?
check "a record that cannot be written is no registration" "|exit 1" "$out|exit $code"
check "and the failure is said" "coordinator: cannot write $CREC: it is a directory" "$(cat "$WORK/coord.err")"
rmdir "$CREC" && cp "$WORK/coord-rec" "$CREC"

# The lock: its holder records its pid and its operation inside it; the next caller waits
# five seconds, then refuses, naming the lock, its holder and whether it still runs, and
# never removes a lock it does not hold.
CLOCK="$CS/coordinator.lock"
mkdir "$CLOCK" && echo "$$ registration" > "$CLOCK/holder"
t0=$(date +%s)
out=$(coord register --name "Coord : three [ccc333]" --tty /dev/ttys103 2>&1 >/dev/null)
t1=$(date +%s)
check "a register that cannot take the lock is refused, naming the lock and its holder" \
  "coordinator: refused: a registration holds the lock: $CLOCK held by pid $$ (running): remove $CLOCK" "$out"
check "the refusal comes after five seconds, not one and not ten" "1" \
  "$([ $((t1 - t0)) -ge 4 ] && [ $((t1 - t0)) -le 8 ] && echo 1 || echo 0)"
check "the refused register leaves the other's lock in place" "1|$$ registration" \
  "$([ -d "$CLOCK" ] && echo 1 || echo 0)|$(cat "$CLOCK/holder")"
sh -c 'exit 0' & deadpid=$!; wait "$deadpid"
echo "$deadpid" > "$CLOCK/holder"
check "declare waits for the same lock, and a holder whose operation is unknown is not guessed" \
  "coordinator: refused: the coordinator's lock is held: $CLOCK held by pid $deadpid (dead): remove $CLOCK|exit 1" \
  "$(coord declare --orchestrator "Orch : a [a00001]" --tty /dev/ttys201 --repo /r 2>&1)|$(coord_status declare --orchestrator "Orch : a [a00001]" --tty /dev/ttys201 --repo /r)"
rm -f "$CLOCK/holder"
check "a lock with no holder recorded is refused all the same" \
  "coordinator: refused: the coordinator's lock is held: $CLOCK names no holder: remove $CLOCK" \
  "$(coord release c1 2>&1)"
rmdir "$CLOCK"

# A state directory that cannot be written is refused at once, not after five seconds.
CRO="$WORK/coord-ro"
mkdir -p "$CRO" && chmod 555 "$CRO"
t0=$(date +%s)
out=$(ORCHESTRATOR_STATE_DIR="$CRO" COORDINATOR_VERIFY="$WORK/coord-verify" COORD_LIVE="$CLIVE" \
  bash "$COORD" declare --orchestrator "Orch : a [a00001]" --tty /dev/ttys201 --repo /r 2>&1); code=$?
t1=$(date +%s)
check "an unwritable state directory is refused at once" \
  "coordinator: cannot write into the state directory $CRO|exit 1|1" \
  "$out|exit $code|$([ $((t1 - t0)) -le 2 ] && echo 1 || echo 0)"
chmod 755 "$CRO"

# Two registrations at the same instant: exactly one records itself, the other is refused.
coord clear
live /dev/ttys104 /dev/ttys105
coord register --name "Coord : four [ddd444]" --tty /dev/ttys104 > "$WORK/coord-r1" 2>&1 &
coord register --name "Coord : five [eee555]" --tty /dev/ttys105 > "$WORK/coord-r2" 2>&1 &
wait
check "two concurrent registers: one recorded, one refused" "1|1" \
  "$(cat "$WORK/coord-r1" "$WORK/coord-r2" | grep -c '^registered ')|$(cat "$WORK/coord-r1" "$WORK/coord-r2" | grep -c 'refused')"

check "clear removes the record" "exit 0|0" "$(coord_status clear)|$([ -e "$CREC" ] && echo 1 || echo 0)"
check "clear with no record is not an error" "exit 0" "$(coord_status clear)"

# lookup: the address only while its session lives; the file alone is never the answer.
check "lookup with no record prints nothing and says nothing" "|exit 0" \
  "$(coord lookup 2>&1)|$(coord_status lookup)"
live /dev/ttys106
coord register --name "Coord : six [fff666]" --tty /dev/ttys106 >/dev/null 2>&1
check "lookup prints the live coordinator's name" "Coord : six [fff666]" "$(coord lookup 2>/dev/null)"
live
check "lookup of a dead coordinator prints nothing" "|exit 0" "$(coord lookup 2>/dev/null)|$(coord_status lookup)"
check "and names the stale record on the error stream" "coordinator: stale record: Coord : six [fff666] on /dev/ttys106" \
  "$(coord lookup 2>&1 >/dev/null)"
coord clear

# declare: one line per declaration, ids from the highest in the file.
id1=$(coord declare --orchestrator "Orch : a [a00001]" --tty /dev/ttys201 --repo /r/one --branch feat/x \
  --pr 12 --checkout /w/one/x/ --heavy suite)
id2=$(coord declare --orchestrator "Orch : b [b00002]" --tty /dev/ttys202 --repo /r/one)
check "declare prints monotonic ids" "c1|c2" "$id1|$id2"
check "a declaration is one line with every field" \
  '["branch","checkout","heavy","id","opened","orchestrator","pr","released","repo","tty"]' \
  "$(sed -n 1p "$CLAIMS" | jq -c 'keys')"
check "the fields say what was declared" "c1|Orch : a [a00001]|/dev/ttys201|/r/one|feat/x|12|/w/one/x|suite|null" \
  "$(sed -n 1p "$CLAIMS" | jq -r '[.id,.orchestrator,.tty,.repo,.branch,(.pr|tostring),.checkout,.heavy,(.released|tostring)]|join("|")')"
check "an option not given is null" "null|null|null|null" \
  "$(sed -n 2p "$CLAIMS" | jq -r '[.branch,.pr,.checkout,.heavy]|map(tostring)|join("|")')"
check "opened is stamped in UTC" "1" \
  "$(sed -n 1p "$CLAIMS" | jq -r .opened | grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$')"
jq -c '.id="c9"' <<< "$(sed -n 2p "$CLAIMS")" >> "$CLAIMS"
check "the next id follows the highest in the file" "c10" \
  "$(coord declare --orchestrator "Orch : a [a00001]" --tty /dev/ttys201 --repo /r/one)"
check "declare without --repo is refused" "exit 1" \
  "$(coord_status declare --orchestrator "Orch : a [a00001]" --tty /dev/ttys201)"
check "declare with a relative repository is refused" "exit 1" \
  "$(coord_status declare --orchestrator "Orch : a [a00001]" --tty /dev/ttys201 --repo r/one)"
check "declare with a pull request that is not a number is refused" "coordinator: declare: --pr must be a number: x" \
  "$(coord declare --orchestrator "Orch : a [a00001]" --tty /dev/ttys201 --repo /r/one --pr x 2>&1)"
check "declare leaves no lock behind" "0" "$([ -e "$CLOCK" ] && echo 1 || echo 0)"
# The overlap check reads the ledger's fields tab-separated and one declaration per line.
check "declare refuses a tab in a value" "coordinator: declare: --orchestrator must not hold a tab or a newline|exit 1" \
  "$(coord declare --orchestrator "$(printf 'Orch\t: a [a00001]')" --tty /dev/ttys201 --repo /r/one 2>&1)|$(coord_status declare --orchestrator "$(printf 'Orch\t: a [a00001]')" --tty /dev/ttys201 --repo /r/one)"
check "declare refuses a newline in a value" "coordinator: declare: --branch must not hold a tab or a newline" \
  "$(coord declare --orchestrator "Orch : a [a00001]" --tty /dev/ttys201 --repo /r/one --branch "$(printf 'feat\nx')" 2>&1)"
check "declare refuses a newline in a path" "coordinator: declare: --repo must not hold a tab or a newline" \
  "$(coord declare --orchestrator "Orch : a [a00001]" --tty /dev/ttys201 --repo "$(printf '/r/one\nx')" 2>&1)"

rm -f "$CLAIMS"
for n in 1 2 3 4 5 6 7 8; do
  coord declare --orchestrator "Orch : p$n [p0000$n]" --tty /dev/ttys30$n --repo /r/par > "$WORK/coord-d$n" 2>&1 &
done
wait
check "eight concurrent declarations get eight distinct ids" "c1 c2 c3 c4 c5 c6 c7 c8|8" \
  "$(cat "$WORK"/coord-d? | sort -V | tr '\n' ' ' | sed 's/ $//')|$(jq -s 'length' "$CLAIMS")"

# release: closes an open declaration, and only one.
check "release closes an open declaration" "exit 0|1" \
  "$(coord_status release c3)|$(jq -r 'select(.id=="c3")|.released' "$CLAIMS" | grep -cE '^[0-9]{4}-.*Z$')"
check "release leaves the others open" "7" "$(jq -s '[.[]|select(.released==null)]|length' "$CLAIMS")"
check "releasing it twice is refused" "coordinator: no open declaration c3" "$(coord release c3 2>&1)"
check "releasing an unknown id is refused" "exit 1" "$(coord_status release c99)"
check "the next id still follows the highest" "c9" "$(coord declare --orchestrator "Orch : a [a00001]" --tty /dev/ttys201 --repo /r/par)"
coord release c4
check "release leaves no lock behind" "0" "$([ -e "$CLOCK" ] && echo 1 || echo 0)"

# A ledger with a line that does not read: release refuses and leaves every line as it
# was, rather than rewriting the ledger from what was read before the bad line.
echo '{"id":"c10", broken' >> "$CLAIMS"
printf '%s\n' "$(sed -n 1p "$CLAIMS" | jq -c '.id="c11"')" >> "$CLAIMS"
cp "$CLAIMS" "$WORK/coord-ledger"
check "release over a corrupt ledger is refused" "coordinator: release: cannot read $CLAIMS|exit 1" \
  "$(coord release c5 2>&1)|$(coord_status release c5)"
check "and leaves the ledger untouched" "" "$(diff "$WORK/coord-ledger" "$CLAIMS")"

# conflicts: A and B live, D dead; each case on a fresh ledger.
live /dev/ttys401 /dev/ttys402
dA() { coord declare --orchestrator "Orch : a [a00001]" --tty /dev/ttys401 "$@"; }
dB() { coord declare --orchestrator "Orch : b [b00002]" --tty /dev/ttys402 "$@"; }
dD() { coord declare --orchestrator "Orch : d [d00004]" --tty /dev/ttys404 "$@"; }
overlaps() { coord conflicts "$1" 2>/dev/null | grep -E '^(overlap|busy|stale) '; }

rm -f "$CLAIMS"; a=$(dA --repo /r/one --branch feat/x); b=$(dB --repo /r/one --branch feat/x)
check "same repository and branch is an overlap" "overlap branch $b $a Orch : a [a00001]|exit 1" \
  "$(overlaps "$b")|$(coord_status conflicts "$b")"
rm -f "$CLAIMS"; a=$(dA --repo /r/one --branch feat/x); b=$(dB --repo /r/two --branch feat/x)
check "the same branch name in another repository is not" "|exit 0" "$(overlaps "$b")|$(coord_status conflicts "$b")"
rm -f "$CLAIMS"; a=$(dA --repo /r/one --checkout /w/one/p1); b=$(dB --repo /r/two --checkout /w/one/p1/)
check "the same checkout is an overlap" "overlap checkout $b $a Orch : a [a00001]|exit 1" \
  "$(overlaps "$b")|$(coord_status conflicts "$b")"
rm -f "$CLAIMS"; a=$(dA --repo /r/one --pr 7); b=$(dB --repo /r/one --pr 7)
check "the same pull request is an overlap" "overlap pr $b $a Orch : a [a00001]|exit 1" \
  "$(overlaps "$b")|$(coord_status conflicts "$b")"
rm -f "$CLAIMS"; a=$(dA --repo /r/one --pr 7); b=$(dB --repo /r/two --pr 7)
check "the same number in another repository is not" "" "$(overlaps "$b")"
rm -f "$CLAIMS"; a=$(dA --repo /r/one --heavy suite); b=$(dB --repo /r/two --heavy evals)
check "two heavy runs are an overlap" "overlap heavy $b $a Orch : a [a00001]|exit 1" \
  "$(overlaps "$b")|$(coord_status conflicts "$b")"
rm -f "$CLAIMS"; a=$(dA --repo /r/one --branch feat/x --pr 7 --checkout /w/a --heavy suite)
b=$(dB --repo /r/two --branch feat/y --pr 8 --checkout /w/b)
check "nothing shared, no overlap" "|exit 0" "$(overlaps "$b")|$(coord_status conflicts "$b")"
rm -f "$CLAIMS"; a=$(dA --repo /r/one --branch feat/x); coord release "$a"; b=$(dB --repo /r/one --branch feat/x)
check "a released declaration is no overlap" "|exit 0" "$(overlaps "$b")|$(coord_status conflicts "$b")"
rm -f "$CLAIMS"; d=$(dD --repo /r/one --branch feat/x); b=$(dB --repo /r/one --branch feat/x)
check "an open declaration of a dead orchestrator is named stale, not an overlap" \
  "stale $d Orch : d [d00004]|exit 0" "$(overlaps "$b")|$(coord_status conflicts "$b")"
check "conflicts on an unknown id is neither go nor wait" "exit 2" "$(coord_status conflicts c99)"
coord release "$d"
check "conflicts on a released declaration is neither go nor wait" "exit 2" "$(coord_status conflicts "$d")"
check "conflicts leaves no lock behind" "0" "$([ -e "$CLOCK" ] && echo 1 || echo 0)"

# Every open declaration of a dead orchestrator is named, not only one that would overlap.
rm -f "$CLAIMS"; d=$(dD --repo /r/dead --branch feat/d --pr 99 --checkout /w/dead)
b=$(dB --repo /r/one --branch feat/x --pr 7 --checkout /w/one)
check "a dead orchestrator's unrelated declaration is named stale too" \
  "stale $d Orch : d [d00004]|exit 0" "$(overlaps "$b")|$(coord_status conflicts "$b")"

# Names are printed as they were declared, never escaped.
rm -f "$CLAIMS"; a=$(coord declare --orchestrator 'Orch : a\b [a00001]' --tty /dev/ttys401 --repo /r/one --pr 7)
b=$(dB --repo /r/one --pr 7)
check "an orchestrator's name is printed as declared" "overlap pr $b $a Orch : a\\b [a00001]" "$(overlaps "$b")"

# Paths: a checkout and its resolved form are one checkout, and a space is part of a path.
mkdir -p "$WORK/coord-real/co" "$WORK/coord sp/co x" && ln -s "$WORK/coord-real" "$WORK/coord-link"
CREAL=$(cd "$WORK/coord-real/co" && pwd -P)
rm -f "$CLAIMS"; a=$(dA --repo /r/one --checkout "$WORK/coord-link/co"); b=$(dB --repo /r/two --checkout "$CREAL")
check "a checkout reached through a symbolic link is the same checkout" \
  "overlap checkout $b $a Orch : a [a00001]|$CREAL" "$(overlaps "$b")|$(sed -n 1p "$CLAIMS" | jq -r .checkout)"
CSP=$(cd "$WORK/coord sp/co x" && pwd -P)
rm -f "$CLAIMS"; a=$(dA --repo /r/one --checkout "$WORK/coord sp/co x"); b=$(dB --repo /r/two --checkout "$CSP/")
check "a path with a space is kept whole" "overlap checkout $b $a Orch : a [a00001]|$CSP" \
  "$(overlaps "$b")|$(sed -n 1p "$CLAIMS" | jq -r .checkout)"

# A ledger line that does not read makes the answer unknown, never « go »: a declaration
# read before it would otherwise miss an overlap after it, and one after it would be
# called unknown.
rm -f "$CLAIMS"; a=$(dA --repo /r/one --branch feat/x)
echo '{"id":"c2", broken' >> "$CLAIMS"
printf '%s\n' "$(sed -n 1p "$CLAIMS" | jq -c '.id="c3" | .orchestrator="Orch : b [b00002]" | .tty="/dev/ttys402"')" >> "$CLAIMS"
check "conflicts over a corrupt ledger is neither go nor wait" "coordinator: cannot read the ledger $CLAIMS|exit 2" \
  "$(coord conflicts "$a" 2>&1)|$(coord_status conflicts "$a")"
check "an id after the bad line is not called unknown" "coordinator: cannot read the ledger $CLAIMS|exit 2" \
  "$(coord conflicts c3 2>&1)|$(coord_status conflicts c3)"

# Liveness: an error of the check is no « dead ». Its own « not running », exit 1 and
# silent, is the only answer read as dead.
rm -f "$CLAIMS"; a=$(dA --repo /r/one --branch feat/x); b=$(dB --repo /r/one --branch feat/x)
live /dev/ttys401 /dev/ttys402 /dev/ttys106
coord register --name "Coord : six [fff666]" --tty /dev/ttys106 >/dev/null 2>&1
cvar() { ORCHESTRATOR_STATE_DIR="$CS" COORD_LIVE="$CLIVE" ORCHESTRATOR_WORKSPACES="$CWS" COORDINATOR_VERIFY="$1" \
  bash "$COORD" "${@:2}"; }
cvar_status() { cvar "$@" >/dev/null 2>&1; echo "exit $?"; }
check "a missing liveness command is said, exit 1 from lookup" \
  "coordinator: the liveness command $WORK/no-verify is missing or not executable|exit 1" \
  "$(cvar "$WORK/no-verify" lookup 2>&1)|$(cvar_status "$WORK/no-verify" lookup)"
check "and from register, the record kept" "exit 1|Coord : six [fff666]" \
  "$(cvar_status "$WORK/no-verify" register --name "Coord : x [xxx000]" --tty /dev/ttys107)|$(jq -r .name "$CREC")"
check "and exit 2 from conflicts" "exit 2" "$(cvar_status "$WORK/no-verify" conflicts "$b")"
printf '#!/bin/bash\necho "cannot read the process table" >&2\nexit 1\n' > "$WORK/coord-verify-err"
chmod +x "$WORK/coord-verify-err"
check "a liveness check that fails is not read as dead" \
  "coordinator: the liveness check failed on /dev/ttys106: cannot read the process table|exit 1" \
  "$(cvar "$WORK/coord-verify-err" lookup 2>&1)|$(cvar_status "$WORK/coord-verify-err" lookup)"
check "nor as a stale claim" "|exit 2" \
  "$(cvar "$WORK/coord-verify-err" conflicts "$b" 2>/dev/null | grep '^stale')|$(cvar_status "$WORK/coord-verify-err" conflicts "$b")"
# The lock's holder writes its pid and its operation into it: read here from inside the
# lock, by a liveness check that register runs while it holds it.
printf '#!/bin/bash\ncat "$ORCHESTRATOR_STATE_DIR/coordinator.lock/holder" > "$COORD_PEEK"\nexit 1\n' > "$WORK/coord-verify-peek"
chmod +x "$WORK/coord-verify-peek"
COORD_PEEK="$WORK/coord-peek" cvar "$WORK/coord-verify-peek" register --name "Coord : seven [ggg777]" --tty /dev/ttys108 >/dev/null 2>&1
check "the lock's holder records its pid and its operation" "1" "$(grep -cE '^[0-9]+ registration$' "$WORK/coord-peek" 2>/dev/null)"
# A check that reads its standard input must not eat the declarations still to be read.
printf '#!/bin/bash\ncat >/dev/null\n[ "$1" = --tty ] && grep -qxF "$2" "$COORD_LIVE"\n' > "$WORK/coord-verify-cat"
chmod +x "$WORK/coord-verify-cat"
rm -f "$CLAIMS"; a=$(dA --repo /r/one --heavy suite); a2=$(dA --repo /r/two --heavy evals); b=$(dB --repo /r/three --heavy suite)
check "every other declaration is read whatever the check does with its input" \
  "overlap heavy $b $a Orch : a [a00001]|overlap heavy $b $a2 Orch : a [a00001]" \
  "$(cvar "$WORK/coord-verify-cat" conflicts "$b" 2>/dev/null | grep '^overlap' | tr '\n' '|' | sed 's/|$//')"
coord clear

# The facts, re-read now: a checkout already held by another branch, and the heavy runs
# the process table shows. This suite is one of them, so its own pid must be listed.
mkdir -p "$CWS/proj" && git init -q -b other "$CWS/proj/p1" \
  && git -C "$CWS/proj/p1" -c user.email=t@local -c user.name=t commit -q --allow-empty -m "Set up"
rm -f "$CLAIMS"; b=$(dB --repo /r/one --branch mine --checkout "$CWS/proj/p1")
check "a checkout held by another branch is busy" "busy checkout $(cd "$CWS/proj/p1" && pwd -P)|exit 1" \
  "$(overlaps "$b")|$(coord_status conflicts "$b")"
rm -f "$CLAIMS"; b=$(dB --repo /r/one --branch other --checkout "$CWS/proj/p1")
check "a checkout held by the declared branch is not" "|exit 0" "$(overlaps "$b")|$(coord_status conflicts "$b")"
check "a running suite is reported with its pid" "1" \
  "$(coord conflicts "$b" 2>/dev/null | grep -cE "^running $$ .*run-tests\.sh")"
check "a running suite alone is no conflict" "exit 0" "$(coord_status conflicts "$b")"
# A plugin evaluation run, stood in for by a process whose arguments carry the words, and
# stopped before the next check so nothing outlives the suite.
python3 -c 'import time; time.sleep(30)' plugin eval coord-fixture &
EVALPID=$!
check "a plugin evaluation run is reported with its pid" "1" \
  "$(coord conflicts "$b" 2>/dev/null | grep -cE "^running $EVALPID .*plugin eval coord-fixture")"
kill "$EVALPID" 2>/dev/null; wait "$EVALPID" 2>/dev/null

# The script's neighbours, in a copy of its tree: a workspace list that fails and a missing
# launcher make the answer unknown, never « go ».
CT="$WORK/coord-tree/skills"
mkdir -p "$CT/coordinator/scripts" "$CT/orchestrator/scripts"
cp "$COORD" "$CT/coordinator/scripts/"
printf '#!/bin/bash\necho "workspace: cannot read the root" >&2\nexit 1\n' > "$CT/orchestrator/scripts/workspace.sh"
ctree() { ORCHESTRATOR_STATE_DIR="$CS" COORD_LIVE="$CLIVE" ORCHESTRATOR_WORKSPACES="$CWS" bash "$CT/coordinator/scripts/coordinator.sh" "$@"; }
rm -f "$CLAIMS"; b=$(dB --repo /r/one --branch mine --checkout "$CWS/proj/p1")
check "a workspace list that fails is neither go nor wait" "coordinator: workspace.sh list failed: the checkout's state is unknown|exit 2" \
  "$(COORDINATOR_VERIFY="$WORK/coord-verify" ctree conflicts "$b" 2>&1 | grep '^coordinator: ')|$(COORDINATOR_VERIFY="$WORK/coord-verify" ctree conflicts "$b" >/dev/null 2>&1; echo "exit $?")"
a=$(dA --repo /r/two)
check "a missing launcher is said, exit 2 from conflicts" \
  "coordinator: the launcher <tree>/skills/coordinator/scripts/../../iterm-agents/scripts/iterm-agent.sh is missing|exit 2" \
  "$(COORDINATOR_VERIFY= ctree conflicts "$b" 2>&1 | sed 's|launcher .*/coord-tree/|launcher <tree>/|')|$(COORDINATOR_VERIFY= ctree conflicts "$b" >/dev/null 2>&1; echo "exit $?")"
check "an unknown subcommand is refused" "exit 1" "$(coord_status bogus)"

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
