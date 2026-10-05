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

# The dispatch record registers itself under the host's session id when it has one. A suite
# run from inside a session must not write into that operator's own state directory.
unset CLAUDE_CODE_SESSION_ID

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
# environment variables, the plugin name, the manifest directory and the host's per-user
# temporary area, a path the host imposes (CLAUDE.md rule 2).
# Presence checks pin wording and were dropped; an absence sweep pins none, so it stays.
#
# The grep runs from INSIDE the repository, on a relative path. With an absolute one,
# every result line carries the repository's own path and the exemption for the plugin's
# name deletes the whole line whatever it said, so this check would report a clean
# repository without ever reading a single file.
policy_hits() {
  ( cd "$ROOT" && grep -rniI 'claude' . --exclude-dir=.git --exclude-dir=.claude --exclude-dir=plans \
      --exclude=plan.md --exclude=CLAUDE.md --exclude=run-tests.sh \
    | grep -viE '~/\.claude/|\$HOME/\.claude|CLAUDE_CONFIG_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_CODE_SESSION_ID|ORCHESTRATOR_HOST_CLI|claude-orchestrator|\.claude-plugin|/\.claude/|\.claude\.json|LounisBou/claude-statusbar|LounisBou/claude-plugins-marketplace|/tmp/claude-' || true )
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
check "a project's instantiation rule no longer carves out succession" "0" \
  "$(grep -c 'governs the FIRST instantiation, never the succession' "$lc")"

# Merging and undrafting a pull request are the operator's, on his clear and explicit request:
# they left every « decide and move » list and every list of what the orchestrator runs,
# and the auditor applies nothing. A list that names merges again hands them back to a session.
hits=$(cd "$ROOT" && git grep -nE 'merges, deploys|Opening, merging|merging and tagging' -- skills/ commands/ templates/ README.md || true)
check "no merge in a decide-and-move or orchestrator-runs list" "" "$hits"
check "the rulebook keeps merge and undraft the operator's by default" "1" \
  "$(grep -c 'By default, merging a pull request and taking it out of draft are his, on his clear and' "$ROOT/skills/orchestrator/SKILL.md")"
check "a project's own method may decide otherwise on merge and undraft" "1" \
  "$(grep -c "project's own method may decide otherwise — auto-merge, pull requests that ship ready rather" "$ROOT/skills/orchestrator/SKILL.md")"
check "the coordinator keeps merge and undraft the operator's by default" "1" \
  "$(grep -c "Merging and undrafting are his by default; where a project's own method decides otherwise, that" "$ROOT/skills/coordination/SKILL.md")"
check "the audit brief merges nothing" "1" \
  "$(grep -c 'no label, no merge' "$ROOT/templates/agent-audit-brief.md")"
# Two locks hold whatever is said — the push guard and the title-verified close — and
# nothing else the launcher refuses is written as an absolute. Read with the rulebook's
# line breaks folded.
check "only the two locks hold whatever is said, never routed around" "1" \
  "$(tr '\n' ' ' < "$ROOT/skills/orchestrator/SKILL.md" | tr -s ' ' | grep -oF -- "Two locks hold whatever is said, never routed around: the push guard, and the tab close verified by its title." | wc -l | tr -d ' ')"
check "the succession brief closes the predecessor's tab" "1" "$(grep -c 'CLOSE ITS TAB' "$ROOT/templates/orchestrator-succession-brief.md")"
# Every agent that works in a checkout keeps its scratch where the close takes it.
check "the phase, review and comments briefs keep scratch in the session's host scratchpad" "yes|yes|yes" \
  "$(for t in phase review comments; do carries "$ROOT/templates/agent-$t-brief.md" "lives in your own session's host scratchpad directory"; done | paste -sd'|' -)"
# An orchestrator's context grows after its takeover mostly by the reports it reads: every
# agent's report is capped, the « wrong or doubtful » line excepted, and no brief still
# orders the long report with named sections.
check "the phase, rotation, comments and review briefs cap the report" "yes|yes|yes|yes" \
  "$(for t in phase rotation comments review; do spells "$ROOT/templates/agent-$t-brief.md" 'is never cut to fit the cap'; done | paste -sd'|' -)"
check "no agent brief orders a report with named sections" "no|no|no|no" \
  "$(for t in phase rotation comments review; do carries "$ROOT/templates/agent-$t-brief.md" 'named sections'; done | paste -sd'|' -)"
check "the review brief writes each finding on one line of at most 200 characters" "yes" \
  "$(spells "$ROOT/templates/agent-review-brief.md" 'each finding is ONE line of at most 200 characters')"
# The cap leaves the machine line where the orchestrator's gate reads it: last.
check "the review report still ends with the norms-check line" "yes" \
  "$(sed -n '/^## 4\. Report shape/,/^## 5\./p' "$ROOT/templates/agent-review-brief.md" | grep -v '^## 5\.' | grep -v '^$' | tail -1 | grep -qF 'End the report with one machine line and nothing after it: `norms-check:' && echo yes || echo no)"
# The comments agent's assessments are rendered to the operator item by item: the 3-line cap
# would cut the reviewer's words out of them.
check "the comments brief exempts each per-thread assessment from the 3-line cap" "yes" \
  "$(spells "$ROOT/templates/agent-comments-brief.md" "except the per-thread assessments: each is sent in full, the reviewer's words included")"
# The cap asks for context_tokens in the final report; the gauge line must not forbid it there.
check "the phase, comments and rotation briefs report context_tokens in the final report" "yes|yes|yes" \
  "$(for t in phase comments rotation; do spells "$ROOT/templates/agent-$t-brief.md" 'your context_tokens in the final report'; done | paste -sd'|' -)"
check "the phase, comments and rotation gauge lines report the context in the final report" "yes|yes|yes" \
  "$(for t in phase comments rotation; do spells "$ROOT/templates/agent-$t-brief.md" 'when the orchestrator asks, and in the final report'; done | paste -sd'|' -)"
# review.md asks for each finding's proposed fix; the one-line finding keeps it as its last field.
check "the review brief's finding line ends with the proposed fix" "yes" \
  "$(spells "$ROOT/templates/agent-review-brief.md" '`[severity] file:line — the claim — the evidence in a few words — proposed fix`')"
check "the comments brief's end report carries the threads and their outcomes" "yes" \
  "$(spells "$ROOT/templates/agent-comments-brief.md" 'threads and their outcomes')"
# A predecessor started by hand lists as `(host default)`; the host refuses closing a session the
# plugin did not launch unless the operator's word is already in the conversation, so the successor
# asks him up front, before « takeover confirmed ». Step 4 is read with its line breaks folded for
# the parts, and by line number for the order: the ask comes before the line that sends the
# confirmation.
SUCC="$ROOT/templates/orchestrator-succession-brief.md"
SUCC4=$(awk '/^4\. /{f=1} /^5\. /{f=0} f' "$SUCC" | tr '\n' ' ' | tr -s ' ')
succ4_has() { printf '%s' "$SUCC4" | grep -oF -- "$1" | wc -l | tr -d ' '; }
check "the succession brief holds the up-front close question by its parts" "1|1|1|1" \
  "$(succ4_has 'BEFORE "takeover confirmed" is sent')|$(succ4_has '(host default)')|$(succ4_has 'asks him to close it himself or to say « close it »')|$(succ4_has 'A predecessor with a name is closed as below, nothing asked')"
SUCC_ASK=$(grep -n -m1 -F -- 'asks him to close it himself or to say « close it »' "$SUCC" | cut -d: -f1)
SUCC_CONFIRM=$(grep -n -m1 -F -- 'Then message the predecessor "takeover confirmed"' "$SUCC" | cut -d: -f1)
check "the succession brief asks before it sends « takeover confirmed »" "1" \
  "$([ -n "$SUCC_ASK" ] && [ -n "$SUCC_CONFIRM" ] && [ "$SUCC_ASK" -lt "$SUCC_CONFIRM" ] && echo 1 || echo 0)"
# The lifecycle reference says the same in one sentence: the ask stands in front of the message
# that confirms the takeover, not behind it.
check "the lifecycle puts the close question before « takeover confirmed »" "1" \
  "$(tr '\n' ' ' < "$ORCH_REFS/lifecycle.md" | tr -s ' ' | awk '{ a = index($0, "to close it himself or to say « close it »"); b = index($0, "message the predecessor \"takeover confirmed\""); print (a > 0 && b > 0 && a < b) ? 1 : 0 }')"
# Ready is the operator's turn: the pull request stays in draft, rebased, and the squash-merge
# of a lower branch is replayed around, never through.
check "ready leaves the pull request in draft" "1" "$(grep -c "Ready is the operator's turn, and the pull request stays in draft" "$ORCH_REFS/review.md")"
check "ready includes the rebase and names the squash-merge trap" "1|1|1" \
  "$(grep -c "each pull request of a stack on the one below it" "$ORCH_REFS/review.md")|$(grep -c "git rebase --onto <main> <old head of the lower branch> <branch>" "$ORCH_REFS/review.md")|$(grep -c "the one force this rule allows" "$ORCH_REFS/review.md")"
check "the undraft and the plain rebase have their rows" "1|1" \
  "$(grep -c "is green, I can take it out of draft" "$ORCH_REFS/review.md")|$(grep -c "a plain rebase on main will do" "$ORCH_REFS/review.md")"
check "the force push has its red flag" "1" \
  "$(grep -c "a force push other than a rebase" "$ROOT/skills/orchestrator/SKILL.md")"
check "the ungated pull request has its red flag" "1" "$(grep -c "A pull request you merged or took out of draft without his clear and explicit request, unless the project's own method decides the merge or the undraft; « ready » told to the operator before" "$ROOT/skills/orchestrator/SKILL.md")"
# The rulebook is loaded whole at every start and every takeover: its size is bounded, and what
# only one step needs lives in the reference that step names.
check "the orchestrator rulebook stays at 21,000 bytes or fewer" "yes" \
  "$([ "$(wc -c < "$ROOT/skills/orchestrator/SKILL.md" | tr -d ' ')" -le 21000 ] && echo yes || echo no)"
# The directives rule moved out of the rulebook; the trigger that makes a session read it stays.
check "the rulebook says when to read the directives rule: a ruling arrives or a defect is about to be repaired" "yes" \
  "$(spells "$ROOT/skills/orchestrator/SKILL.md" 'when a ruling arrives or a defect is about to be repaired, read `references/briefs.md`')"
check "the phase rules and the prerequisites live in the briefs reference" "yes|yes|yes|yes" \
  "$(spells "$ORCH_REFS/briefs.md" '## Phase & PR rules')|$(spells "$ORCH_REFS/briefs.md" '**One kind of change per phase.**')|$(spells "$ORCH_REFS/briefs.md" '**One writer per checkout, and a checkout per phase.**')|$(spells "$ORCH_REFS/briefs.md" '**Every figure in the plan carries the command that produces it**')"
check "the directives rule and the guard live in the briefs reference" "yes|yes" \
  "$(spells "$ORCH_REFS/briefs.md" '## When a decision changes, the directives change in the same move')|$(spells "$ORCH_REFS/briefs.md" '**A guard over your own directives is the one instrument you may write yourself**')"
check "environment preparation, pipelining and the tab-close row live in the lifecycle reference" "yes|yes|yes" \
  "$(spells "$ORCH_REFS/lifecycle.md" '**Environment preparation is orchestrator housekeeping**')|$(spells "$ORCH_REFS/lifecycle.md" 'An agent may pipeline only when PR N+1 is dispatched to that same agent')|$(spells "$ORCH_REFS/lifecycle.md" 'The agent acknowledged its stand-down, the tab can close')"
check "the one-round rule, depth versus scope and the publishing rule live in the review reference" "yes|yes|yes" \
  "$(spells "$ORCH_REFS/review.md" '**One review round, one correction round, and you close it.**')|$(spells "$ORCH_REFS/review.md" '**Depth vs scope**')|$(spells "$ORCH_REFS/review.md" 'a thread closed by a change is answered by the change')"
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
# A RESIDENT agent stays idle by design while a background command of its own waits: the
# stop gate must not count it as an agent to read or relaunch. `--resident` marks its entry;
# an entry written before the mark existed reads as not resident, and a hand-over keeps it.
check "--resident is said by the dry run, and its absence too" "1|1" \
  "$(chain_spawn --resident | grep -c '^resident=yes$')|$(chain_spawn | grep -c '^resident=no$')"
check "--resident is an agent's only: a successor or an auditor joins no chain to mark" "1|1" \
  "$(chain_spawn --resident --successor | grep -c 'spawn: refused: --resident marks an agent of your chain')|$(chain_spawn --resident --auditor --title 'Audit : x' | grep -c 'spawn: refused: --resident marks an agent of your chain')"
append() { ORCHESTRATOR_STATE_DIR="$WORK/istate" "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
m.chain_append('/dev/ttys900', sys.argv[1], sys.argv[2], 'S-ME', resident=sys.argv[3] == 'yes')
print('|'.join(str(m.is_resident(e)) for e in m.chain_read('/dev/ttys900')))" "$@" 2>&1; }
printf '{"tab_id":"8","tty":"/dev/ttys908","owner":"S-ME"}\n' > "$CHAINS/ttys900.jsonl"
check "a resident agent's entry carries the mark, a plain one's and an older one's do not" "False|True|False" \
  "$(append 9 /dev/ttys909 yes >/dev/null; append 10 /dev/ttys910 no)"
check "the mark is written only where it is set" \
  '{"tab_id": "8", "tty": "/dev/ttys908", "owner": "S-ME"}|{"tab_id": "9", "tty": "/dev/ttys909", "owner": "S-ME", "resident": true}|{"tab_id": "10", "tty": "/dev/ttys910", "owner": "S-ME"}' \
  "$(paste -sd'|' "$CHAINS/ttys900.jsonl")"
check "a hand-over keeps the mark" '{"tab_id": "9", "tty": "/dev/ttys909", "owner": "S-NEW", "resident": true}' \
  "$(transfer >/dev/null; sed -n 2p "$CHAINS/ttys950.jsonl")"

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

# The open rows are work, not history: `summary` lists them, so a successor reading the
# record sees what was deferred and never dispatched.
RO="$WORK/open-rows.jsonl"
bash "$REC" open "$RO" --class behaviour-phase --tier standard --label "plan after the round" >/dev/null
bash "$REC" open "$RO" --class n-bis --tier light --label "second" >/dev/null
bash "$REC" close "$RO" 2 --verdict ruled-out >/dev/null
check "summary lists the open rows with their id and label, and only them" "open=1 label=plan after the round" \
  "$(bash "$REC" summary "$RO" | grep '^open=')"

# Every subcommand registers its record under the session, by absolute path, once. The
# state directory is the hook's: the hook reads the same file for the same session id.
RS="$WORK/rec-state"; RD="$WORK/rec-dir"; mkdir -p "$RD"
RR="$RD/dispatch.jsonl"
rec_with() {  # <session id> <args...>, run from the record's directory with a relative path
  local sid="$1"; shift
  ( cd "$RD" && CLAUDE_CODE_SESSION_ID="$sid" ORCHESTRATOR_STATE_DIR="$RS" bash "$REC" "$@" 2>/dev/null )
}
rec_with s-open open dispatch.jsonl --class n-bis --tier light --label l >/dev/null
RDREAL="$(cd "$RD" && pwd -P)"
check "open registers the record by its absolute path" "$RDREAL/dispatch.jsonl" "$(cat "$RS/records/s-open" 2>/dev/null)"
rec_with s-round round dispatch.jsonl 1
rec_with s-review review dispatch.jsonl 1 --head abcdef1234 --norms none
rec_with s-fixed fixed dispatch.jsonl 1 --head abcdef1234
rec_with s-ready ready dispatch.jsonl 1 --head abcdef1234 >/dev/null
rec_with s-escaped escaped dispatch.jsonl 1
rec_with s-summary summary dispatch.jsonl >/dev/null
rec_with s-close close dispatch.jsonl 1 --verdict ok
for sid in s-round s-review s-fixed s-ready s-escaped s-summary s-close; do
  check "${sid#s-} registers the record" "$RDREAL/dispatch.jsonl" "$(cat "$RS/records/$sid" 2>/dev/null)"
done
rec_with s-open summary dispatch.jsonl >/dev/null; rec_with s-open round dispatch.jsonl 1; ( cd "$RD" && CLAUDE_CODE_SESSION_ID=s-open ORCHESTRATOR_STATE_DIR="$RS" bash "$REC" summary "$RR" >/dev/null )
check "a record is registered once, whichever way its path is spelled" "1" "$(grep -c . "$RS/records/s-open")"
rec_with s-open open "$WORK/second.jsonl" --class n-bis --tier light >/dev/null
check "a second record is added on its own line" "2" "$(grep -c . "$RS/records/s-open")"
RS2="$WORK/rec-state-none"
( cd "$RD" && env -u CLAUDE_CODE_SESSION_ID ORCHESTRATOR_STATE_DIR="$RS2" bash "$REC" summary dispatch.jsonl >/dev/null 2>&1 )
check "without a session id nothing is registered" "no" "$([ -e "$RS2" ] && echo yes || echo no)"
check "a state directory that cannot be written never fails the command" "0|class=n-bis" \
  "$(cd "$RD" && out=$(CLAUDE_CODE_SESSION_ID=s-x ORCHESTRATOR_STATE_DIR=/dev/null/nope bash "$REC" summary dispatch.jsonl 2>/dev/null); echo "$?|$(printf '%s' "$out" | head -1 | cut -c1-11)")"
check "a failing command keeps its own exit code" "1" "$(cd "$RD" && CLAUDE_CODE_SESSION_ID=s-y ORCHESTRATOR_STATE_DIR="$RS" bash "$REC" close dispatch.jsonl 99 --verdict ok >/dev/null 2>&1; echo $?)"

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
# actually read; a row `ready` cannot see a review on no longer stops it, it warns and says
# so — this default a project may still tighten in its own method, the way it may tighten
# anything else this file no longer refuses.
G="$WORK/gate.jsonl"
g1=$(bash "$REC" open "$G" --class behaviour-phase --tier standard --label "gate")
check_status "ready warns, it does not refuse, a row no review has touched" 0 bash "$REC" ready "$G" "$g1" --head aaa1111
check "and names what is missing" "1" \
  "$(bash "$REC" ready "$G" "$g1" --head aaa1111 2>&1 | grep -c 'no review recorded on row')"
check "ready still prints its reading of the row" "1" \
  "$(bash "$REC" ready "$G" "$g1" --head aaa1111 2>/dev/null | grep -c 'ready: row 1 has no review recorded yet; head aaa1111 is unverified')"

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
# orchestrator verified. `fixed` no longer refuses a row with no review, or a second
# correction round: it warns and records anyway, the way a project's own method may still
# forbid either.
g3=$(bash "$REC" open "$G" --class behaviour-phase --tier standard --label "one fix")
fout=$(bash "$REC" fixed "$G" "$g3" --head ddd4444 2>&1); fcode=$?
check "fixed warns, it does not refuse, a row no review has touched" "0" "$fcode"
check "and says a review is missing" "1" "$(printf '%s\n' "$fout" | grep -c 'fixed: row 3 has no review recorded')"
check "the correction round is recorded anyway" "ddd4444|1" \
  "$(jq -r --argjson i "$g3" 'select(.id==$i)|[.review.fixed.head,.rounds]|join("|")' "$G")"

# A proper review round replaces the whole `.review` object — the out-of-order fix it
# carried does not survive it, which is the point: a review is the row's fresh read.
bash "$REC" review "$G" "$g3" --head ccc3333 --norms tool >/dev/null
check "the review starts the row fresh" "ccc3333|tool||2" \
  "$(jq -r --argjson i "$g3" 'select(.id==$i)|[.review.head,.review.norms,(.review.fixed.head // ""),.rounds]|join("|")' "$G")"
bash "$REC" fixed "$G" "$g3" --head ddd4444 >/dev/null
check "fixed records the head the orchestrator verified, and counts the round" "ccc3333|ddd4444|3" \
  "$(jq -r --argjson i "$g3" 'select(.id==$i)|[.review.head,.review.fixed.head,.rounds]|join("|")' "$G")"
check_status "ready passes at the fixed head" 0 bash "$REC" ready "$G" "$g3" --head ddd4444
check "and says which reading it rests on" "1" \
  "$(bash "$REC" ready "$G" "$g3" --head ddd4444 2>&1 | grep -c 'ready: row 3 reviewed at ccc3333, corrected and verified at ddd4444')"
check_status "the fixed head accepts its full spelling" 0 bash "$REC" ready "$G" "$g3" --head ddd4444abcdef
check_status "ready still passes at the reviewed head" 0 bash "$REC" ready "$G" "$g3" --head ccc3333
check_status "ready refuses a head neither reviewed nor fixed" 1 bash "$REC" ready "$G" "$g3" --head eee5555
check "and names all three heads" "1" \
  "$(bash "$REC" ready "$G" "$g3" --head eee5555 2>&1 | grep -c 'last review read ccc3333, its correction ddd4444, head is eee5555')"
sout=$(bash "$REC" fixed "$G" "$g3" --head eee5555 2>&1); scode=$?
check "a second correction round warns, it does not refuse" "0" "$scode"
check "and names the one it already had" "1" "$(printf '%s\n' "$sout" | grep -c 'fixed: row 3 already has its correction round at ddd4444')"
check "the second fix overwrites the first" "eee5555|4" \
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

# File names git would quote and octal-escape by default (core.quotePath): an accented letter,
# a space, a quote, a newline. This is a fixture whose purpose is to check Unicode handling,
# so the accented names are deliberate. Each listing is read NUL-separated and the file is
# copied byte for byte.
USRC="$WORK/wsrc/uni"
NL=$'\n'
mkdir -p "$USRC" && ( cd "$USRC" && git init -q -b main && git config user.email t@local && git config user.name t \
  && echo tracked > README.md && git add -A && git commit -q -m "Set up" \
  && git remote add origin git@example.invalid:owner/uni.git \
  && mkdir -p .claude \
  && echo accent > ".claude/été.md" && echo space > ".claude/a b.md" \
  && echo quote > ".claude/q\"uote.md" && echo newline > ".claude/nl${NL}name.md" \
  && echo excluded > "café.txt" && printf 'café.txt\n/.claude/\n' > .git/info/exclude )
uout=$(bash "$WS" create "$USRC" unicode --base main 2>"$WORK/ws-uni.err")
UC="$WORK/wsroot/uni/unicode"
check "create succeeds on a source holding non-ASCII file names" "$UC" "$uout"
check "the settings directory's accented name is copied" "accent" "$(cat "$UC/.claude/été.md" 2>/dev/null)"
check "a name with a space is copied" "space" "$(cat "$UC/.claude/a b.md" 2>/dev/null)"
check "a name with a quote is copied" "quote" "$(cat "$UC/.claude/q\"uote.md" 2>/dev/null)"
check "a name with a newline is copied" "newline" "$(cat "$UC/.claude/nl${NL}name.md" 2>/dev/null)"
check "an excluded path with an accented name is copied" "excluded" "$(cat "$UC/café.txt" 2>/dev/null)"
check "and the copy counts them" "1" "$(grep -c 'settings directory (4 files' "$WORK/ws-uni.err")"
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

echo "== workspace: temporary directories are cleaned once their purpose is over =="
# A checkout is deleted when its purpose is over — its stood-down session closed, its pull
# request merged or closed — and the host's per-directory temporary area goes with it. The
# one safety rule over every deletion: never a dirty tree, unpushed commits, a pin whose head
# is on no branch, or a directory a live process has as its working directory. Everything
# here runs on temporary repositories, a fake `gh`, and a host temporary area of its own.
WC="$WORK/wc"
mkdir -p "$WC/bin" "$WC/bin-nolsof" "$WC/hosttmp" "$WC/src"
export ORCHESTRATOR_HOST_TMP="$WC/hosttmp"
export ORCHESTRATOR_WORKSPACES="$WORK/wcroot"
# The sweep caches each repository's pull requests in the state directory: one of the suite's own.
export ORCHESTRATOR_STATE_DIR="$WC/state"
rp() { ( cd "$1" && pwd -P ); }
mkdir -p "$WORK/wcroot"
WCR=$(rp "$WORK/wcroot")
# The host's name of a directory: every character that is not a letter or a digit turned into `-`.
enc() { local p; p=$(rp "$1"); printf '%s' "$p" | tr -c 'A-Za-z0-9' '-'; }
# A commit made through an empty `-C` path would land in the repository the suite runs from.
gc() { [ "${1:-}" = -C ] && [ -z "${2:-}" ] && return 1; git -c user.email=t@local -c user.name=t "$@"; }
exists() { [ -e "$1" ] && echo 1 || echo 0; }

for n in 1 2 3; do
  suffix=""; [ "$n" -gt 1 ] && suffix=$n
  trunk=main; [ "$n" = 3 ] && trunk=stable
  git init -q --bare "$WC/origin$suffix.git"
  mkdir -p "$WC/src/proj$suffix" && ( cd "$WC/src/proj$suffix" && git init -q -b $trunk \
    && echo one > README.md && git add -A && gc commit -q -m "One" \
    && git remote add origin "$WC/origin$suffix.git" && git push -q origin $trunk 2>/dev/null )
done
WCSRC="$WC/src/proj"; WCSRC2="$WC/src/proj2"; WCSRC3="$WC/src/proj3"

# A fake `gh`: one JSON file per origin, named after the origin's last path part, and one
# line per `pr list` call so the number of calls per repository can be counted.
cat > "$WC/bin/gh" <<EOF
#!/bin/bash
[ -f "$WC/gh-offline" ] && { echo "gh: you are not logged in" >&2; exit 1; }
[ "\$1 \$2" = "pr list" ] || exit 1
echo "\$(pwd -P) \$*" >> "$WC/gh-calls"
cat "$WC/prs-\$(basename "\$(git remote get-url origin)").json"
EOF
printf '#!/bin/bash\nexit 1\n' > "$WC/bin-nolsof/lsof"
chmod +x "$WC/bin/gh" "$WC/bin-nolsof/lsof"
wcgh() { env PATH="$WC/bin:$PATH" "$@"; }

# A process whose working directory is a given directory, until `release`.
LIVE=""
hold() {
  ( cd "$1" && exec sleep 60 ) & LIVE="$LIVE $!"
  local i=0 want; want=$(rp "$1")
  while [ $i -lt 50 ]; do
    lsof -a -p "${LIVE##* }" -d cwd -Fn 2>/dev/null | grep -qxF "n$want" && return 0
    sleep 0.1; i=$((i + 1))
  done
}
release() { local p; for p in $LIVE; do kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; done; LIVE=""; }

# mkclone <source> <name> <branch> [dirty|unpushed]: a checkout on a pushed branch.
mkclone() {
  local c
  c=$(bash "$WS" create "$1" "$2" --base main 2>/dev/null) || return 1
  git -C "$c" checkout -q -b "$3" && echo "$2" > "$c/$2.txt" && git -C "$c" add -A && gc -C "$c" commit -q -m "Work on $2"
  [ "${4:-}" = unpushed ] || git -C "$c" push -q origin "$3" 2>/dev/null
  [ "${4:-}" = dirty ] && echo more >> "$c/$2.txt"
  rp "$c"
}
# wcpin <args of pin>: the pin's real path.
wcpin() { local p; p=$(bash "$WS" pin "$@" 2>/dev/null) && rp "$p"; }
# scratch <checkout>: the host's temporary directory of a checkout, with something in it.
scratch() { local h="$ORCHESTRATOR_HOST_TMP/$(enc "$1")"; mkdir -p "$h/scratchpad/s1"; echo x > "$h/scratchpad/s1/f"; echo "$h"; }

echo "-- delete takes the host's temporary directory with it"
CA=$(mkclone "$WCSRC" del-a feat/del-a); HA=$(scratch "$CA")
out=$(bash "$WS" delete "$CA" 2>/dev/null)
check "delete removes the checkout and its host temporary directory, and says both" "2|0|0" \
  "$(printf '%s\n' "$out" | grep -c '^deleted ')|$(exists "$CA")|$(exists "$HA")"

CB=$(mkclone "$WCSRC" del-b feat/del-b); HB=$(scratch "$CB")
hold "$HB/scratchpad"
out=$(bash "$WS" delete "$CB" 2>"$WC/del-b.err")
release
check "a live process inside the host temporary directory keeps it, and it is said" "0|1|1" \
  "$(exists "$CB")|$(exists "$HB")|$(grep -c 'kept host temporary directory' "$WC/del-b.err")"
rm -rf "$HB"

CC=$(mkclone "$WCSRC" del-c feat/del-c); HC=$(scratch "$CC")
hold "$CC"
bash "$WS" delete "$CC" >/dev/null 2>"$WC/del-c.err"; code=$?
release
check "a live process inside the checkout refuses the delete and keeps both" "1|1|1" "$code|$(exists "$CC")|$(exists "$HC")"
check "and the refusal names the live process" "1" "$(grep -c 'live process' "$WC/del-c.err")"
env PATH="$WC/bin-nolsof:$PATH" bash "$WS" delete "$CC" >/dev/null 2>"$WC/del-c2.err"; code=$?
check "a process table that cannot be read refuses the delete, nothing is assumed" "1|1" "$code|$(exists "$CC")"
bash "$WS" delete "$CC" >/dev/null 2>&1
rm -rf "$HC"

CD=$(mkclone "$WCSRC" del-d feat/del-d dirty); HD=$(scratch "$CD")
bash "$WS" delete "$CD" >/dev/null 2>&1; code=$?
check "a dirty tree keeps the checkout and its host temporary directory" "1|1|1" "$code|$(exists "$CD")|$(exists "$HD")"
bash "$WS" delete "$CD" --discard >/dev/null 2>&1
check "--discard removes the dirty tree and takes the host directory with it" "0|0" "$(exists "$CD")|$(exists "$HD")"

CE=$(mkclone "$WCSRC" del-e feat/del-e unpushed); HE=$(scratch "$CE")
bash "$WS" delete "$CE" >/dev/null 2>&1; code=$?
check "unpushed commits keep the checkout and its host temporary directory" "1|1|1" "$code|$(exists "$CE")|$(exists "$HE")"
bash "$WS" delete "$CE" --discard >/dev/null 2>&1

# A commit on a detached head is on no branch at all, and a stash is on none either: the
# branches alone never see them.
CF=$(mkclone "$WCSRC" del-f feat/del-f)
git -C "$CF" checkout -q --detach && echo f > "$CF/detached.txt" && git -C "$CF" add -A && gc -C "$CF" commit -q -m "On a detached head"
bash "$WS" delete "$CF" >/dev/null 2>"$WC/del-f.err"; code=$?
check "a commit on a detached head keeps the checkout, and says why" "1|1|1" \
  "$code|$(exists "$CF")|$(grep -c 'commits on no remote branch' "$WC/del-f.err")"
bash "$WS" delete "$CF" --discard >/dev/null 2>&1
CG=$(mkclone "$WCSRC" del-g feat/del-g)
echo more >> "$CG/del-g.txt" && git -C "$CG" stash -q
bash "$WS" delete "$CG" >/dev/null 2>"$WC/del-g.err"; code=$?
check "a stash keeps the checkout, and says why" "1|1|1" \
  "$code|$(exists "$CG")|$(grep -c 'a stash is held' "$WC/del-g.err")"
bash "$WS" delete "$CG" --discard >/dev/null 2>&1

# A git that cannot read the checkout knows nothing of its state: never « clean and pushed ».
CH=$(mkclone "$WCSRC" del-h feat/del-h)
echo garbage > "$CH/.git/HEAD"
bash "$WS" delete "$CH" >/dev/null 2>"$WC/del-h.err"; code=$?
check "a checkout git cannot read is kept, with git's own first line" "1|1|1" \
  "$code|$(exists "$CH")|$(grep -c 'git cannot read the checkout: .' "$WC/del-h.err")"
bash "$WS" delete "$CH" --discard >/dev/null 2>&1

# The host spells every character that is not a letter or a digit as `-`, not only `/`.
CI=$(mkclone "$WCSRC" del.i_x feat/del-i)
HI="$ORCHESTRATOR_HOST_TMP/$(enc "$WCR")-proj-del-i-x"; mkdir -p "$HI/scratchpad"
out=$(bash "$WS" delete "$CI" 2>/dev/null)
check "a checkout named with a dot and an underscore takes its host directory, spelled as the host spells it" "0|0|1" \
  "$(exists "$CI")|$(exists "$HI")|$(printf '%s\n' "$out" | grep -cxF "deleted $HI")"

echo "-- a removal goes through a trash, so one cut short leaves nothing at the checkout's path"
# A sweep killed in the middle of a removal left a partial checkout that read as dirty for
# ever. The checkout is moved into a trash under the root in one rename, then removed; what
# a removal leaves there (here, a directory it may not write into) the next sweep empties.
CJ=$(mkclone "$WCSRC" del-j feat/del-j); HJ=$(scratch "$CJ")
mkdir -p "$CJ/locked" && echo x > "$CJ/locked/f" && chmod a-w "$CJ/locked"
out=$(bash "$WS" delete "$CJ" --discard 2>"$WC/del-j.err"); code=$?
check "a removal that cannot complete leaves nothing at the checkout's path, says so, and keeps the rest in the trash" "0|0|0|1|1|1" \
  "$code|$(exists "$CJ")|$(exists "$HJ")|$(printf '%s\n' "$out" | grep -cxF "deleted $CJ")|$(ls "$WCR/.trash" 2>/dev/null | grep -c .)|$(grep -c 'the trash keeps' "$WC/del-j.err")"
chmod -R u+w "$WCR/.trash" "$CJ" 2>/dev/null
mkdir -p "$ORCHESTRATOR_HOST_TMP/.workspace-trash/zz/x/scratchpad"
git init -q "$WCR/.trash/zy"
check "list ignores the trash" "0" "$(bash "$WS" list 2>/dev/null | grep -c trash)"
out=$(wcgh bash "$WS" sweep --dry-run 2>/dev/null)
check "a dry run says what it would empty from the trashes and empties nothing" "3|2|1" \
  "$(printf '%s\n' "$out" | grep -c '^would delete .*trash')|$(ls "$WCR/.trash" | grep -c .)|$(ls "$ORCHESTRATOR_HOST_TMP/.workspace-trash" | grep -c .)"
out=$(wcgh bash "$WS" sweep 2>/dev/null)
check "a sweep empties a leftover trash first, and never takes it for a checkout or an orphan" "3|0|0|1" \
  "$(printf '%s\n' "$out" | grep -c '^deleted .*trash')|$(ls "$WCR/.trash" | grep -c .)|$(ls "$ORCHESTRATOR_HOST_TMP/.workspace-trash" | grep -c .)|$(printf '%s\n' "$out" | head -1 | grep -c trash)"

echo "-- pin --pr records the pull request the pin reviews"
PINA=$(wcpin "$WCSRC" pin-a main --pr 7)
PINB=$(wcpin "$WCSRC" pin-b main)
check "pin --pr writes the number in the worktree's own git dir; a pin without it writes none" "7|0" \
  "$(cat "$(git -C "$PINA" rev-parse --absolute-git-dir)/workspace-pr" 2>/dev/null)|$(exists "$(git -C "$PINB" rev-parse --absolute-git-dir)/workspace-pr")"
check "pin --pr needs a number, and makes no worktree without one" "1|0" \
  "$(bash "$WS" pin "$WCSRC" pin-c main --pr seven >/dev/null 2>&1; echo $?)|$(exists "$WORK/wcroot/proj/pin-c")"
check "list is unchanged by the record" "1|1" \
  "$(bash "$WS" list 2>/dev/null | grep -c '/proj/pin-a | HEAD | [0-9a-f]* | clean | pinned$')|$(bash "$WS" list 2>/dev/null | grep -c '/proj/pin-b | HEAD | [0-9a-f]* | clean | pinned$')"
HPA=$(scratch "$PINA")
bash "$WS" delete "$PINA" >/dev/null 2>&1
check "deleting a pin takes its host temporary directory too" "0|0" "$(exists "$PINA")|$(exists "$HPA")"
check "and its source forgets it" "0" "$(git -C "$WCSRC" worktree list | grep -c '/pin-a ')"
bash "$WS" delete "$PINB" >/dev/null 2>&1

echo "-- sweep decides on facts"
MAIN_SHA=$(git -C "$WCSRC" rev-parse main)
C_MERGED=$(mkclone "$WCSRC" s-merged feat/merged)
C_CLOSED=$(mkclone "$WCSRC" s-closed feat/closed)
C_OPEN=$(mkclone "$WCSRC" s-open feat/open)
C_NOPR=$(mkclone "$WCSRC" s-nopr feat/nopr)
C_DIRTY=$(mkclone "$WCSRC" s-dirty feat/dirty dirty)
C_UNPUSHED=$(mkclone "$WCSRC" s-unpushed feat/unpushed unpushed)
C_LIVE=$(mkclone "$WCSRC" s-live feat/live)
C_P2=$(mkclone "$WCSRC2" s-p2 feat/p2)
C_MAIN=$(mkclone "$WCSRC" s-main feat/s-main); git -C "$C_MAIN" checkout -q main
C_STABLE=$(rp "$(bash "$WS" create "$WCSRC3" s-stable --base stable 2>/dev/null)")
C_PAST=$(mkclone "$WCSRC" s-past feat/past)
C_BEHIND=$(mkclone "$WCSRC" s-behind feat/behind)
echo second > "$C_BEHIND/second.txt" && git -C "$C_BEHIND" add -A && gc -C "$C_BEHIND" commit -q -m "Second" && git -C "$C_BEHIND" push -q origin feat/behind 2>/dev/null
BEHIND_TIP=$(git -C "$C_BEHIND" rev-parse HEAD)
git -C "$C_BEHIND" reset -q --hard HEAD~1
head_of() { git -C "$1" rev-parse HEAD; }
P_MERGED=$(wcpin "$WCSRC" p-merged main --pr 7)
P_MOVED=$(wcpin "$WCSRC" p-moved main --pr 8)
P_SAME=$(wcpin "$WCSRC" p-same main --pr 9)
P_NOREC=$(wcpin "$WCSRC" p-norec main)
P_NOBRANCH=$(wcpin "$WCSRC" p-nobranch main --pr 10)
gc -C "$P_NOBRANCH" commit -q --allow-empty -m "Commit on no branch"
cat > "$WC/prs-origin.git.json" <<EOF
[{"number":1,"state":"MERGED","headRefName":"feat/merged","headRefOid":"$(head_of "$C_MERGED")"},
 {"number":2,"state":"CLOSED","headRefName":"feat/closed","headRefOid":"$(head_of "$C_CLOSED")"},
 {"number":3,"state":"OPEN","headRefName":"feat/open","headRefOid":"$(head_of "$C_OPEN")"},
 {"number":4,"state":"MERGED","headRefName":"feat/dirty","headRefOid":"$(head_of "$C_DIRTY")"},
 {"number":5,"state":"MERGED","headRefName":"feat/unpushed","headRefOid":"$(head_of "$C_UNPUSHED")"},
 {"number":6,"state":"MERGED","headRefName":"feat/live","headRefOid":"$(head_of "$C_LIVE")"},
 {"number":7,"state":"MERGED","headRefName":"feat/seven","headRefOid":"111"},
 {"number":8,"state":"OPEN","headRefName":"feat/eight","headRefOid":"0000000000000000000000000000000000000000"},
 {"number":9,"state":"OPEN","headRefName":"feat/nine","headRefOid":"$MAIN_SHA"},
 {"number":10,"state":"MERGED","headRefName":"feat/ten","headRefOid":"222"},
 {"number":11,"state":"MERGED","headRefName":"main","headRefOid":"$(head_of "$C_MAIN")"},
 {"number":12,"state":"MERGED","headRefName":"feat/past","headRefOid":"$(git -C "$C_PAST" rev-parse HEAD~1)"},
 {"number":13,"state":"MERGED","headRefName":"feat/behind","headRefOid":"$BEHIND_TIP"}]
EOF
cat > "$WC/prs-origin3.git.json" <<EOF
[{"number":1,"state":"MERGED","headRefName":"stable","headRefOid":"$(head_of "$C_STABLE")"}]
EOF
cat > "$WC/prs-origin2.git.json" <<EOF
[{"number":1,"state":"MERGED","headRefName":"feat/p2","headRefOid":"$(head_of "$C_P2")"}]
EOF
for d in "$C_MERGED" "$C_CLOSED" "$C_OPEN" "$C_NOPR" "$C_DIRTY" "$C_UNPUSHED" "$C_LIVE" "$C_P2" "$C_MAIN" "$C_STABLE" "$C_PAST" "$C_BEHIND" "$P_MERGED" "$P_MOVED" "$P_SAME" "$P_NOREC" "$P_NOBRANCH"; do scratch "$d" >/dev/null; done
# The orphans of checkouts deleted before this change: the encoded root, an existing project,
# then a name that matches no checkout. Those that must stay: one past the root's name without
# the separator, one outside the root, two of a sibling of the root sharing its name as a
# prefix (`<root>-old/x`, `<root>_2/x`), and two a live session still uses. A session's host
# directory is named after the directory it STARTED in, never after its own scratch: one
# session works in that very directory, a checkout's subdirectory; another started in a
# subdirectory and works further below it now.
ENCR=$(enc "$WCR")
mkdir -p "$WORK/wcroot/plain" "$C_OPEN/sub" "$C_NOPR/sub/deeper"
H_SRC="$ORCHESTRATOR_HOST_TMP/$(enc "$C_OPEN/sub")"; H_BELOW="$ORCHESTRATOR_HOST_TMP/$(enc "$C_NOPR/sub")"
mkorphans() {
  mkdir -p "$ORCHESTRATOR_HOST_TMP/$ENCR-proj/scratchpad" "$ORCHESTRATOR_HOST_TMP/$ENCR-plain/scratchpad"
  mkdir -p "$ORCHESTRATOR_HOST_TMP/$ENCR-proj-gone/scratchpad" "$ORCHESTRATOR_HOST_TMP/${ENCR}2-x/scratchpad" \
    "$ORCHESTRATOR_HOST_TMP/-elsewhere-thing/scratchpad" "$H_SRC/scratchpad" "$H_BELOW/scratchpad" \
    "$ORCHESTRATOR_HOST_TMP/$ENCR-old-x/scratchpad" "$ORCHESTRATOR_HOST_TMP/$ENCR-2-x/scratchpad"
}
mkorphans
nitems() { bash "$WS" list 2>/dev/null | grep -c .; }
# gone | past the root's name | outside | live at its source | live below its source | <root>-old | <root>_2
tmpstate() { printf '%s|%s|%s|%s|%s|%s|%s' "$(exists "$ORCHESTRATOR_HOST_TMP/$ENCR-proj-gone")" "$(exists "$ORCHESTRATOR_HOST_TMP/${ENCR}2-x")" \
  "$(exists "$ORCHESTRATOR_HOST_TMP/-elsewhere-thing")" "$(exists "$H_SRC")" "$(exists "$H_BELOW")" \
  "$(exists "$ORCHESTRATOR_HOST_TMP/$ENCR-old-x")" "$(exists "$ORCHESTRATOR_HOST_TMP/$ENCR-2-x")"; }
hold "$C_LIVE"
hold "$C_OPEN/sub"
hold "$C_NOPR/sub/deeper"
BEFORE=$(nitems)
: > "$WC/gh-calls"

out=$(wcgh bash "$WS" sweep --dry-run 2>"$WC/sweep-dry.err"); code=$?
check "a dry run exits 0 and deletes nothing, checkouts or host directories" "0|$BEFORE|1|1|1|1|1|1|1" "$code|$(nitems)|$(tmpstate)"
check "a dry run prints its decisions: six deletions and the orphan, none done" "7|0" \
  "$(printf '%s\n' "$out" | grep -c '^would delete ')|$(printf '%s\n' "$out" | grep -c '^deleted ')"
check "the pull requests are read once per repository, never once per checkout; a long-lived branch asks none" "2" "$(grep -c 'pr list' "$WC/gh-calls")"
check "and with the fields the decision reads, two hundred at most" "2|2" \
  "$(grep -c -- '--json headRefName,state,headRefOid,number' "$WC/gh-calls")|$(grep -c -- '--limit 200 ' "$WC/gh-calls")"
# The orphans are local and cheap, the pull requests a call per repository: a sweep cut by its
# deadline has done the orphans first.
first_ckt=$(printf '%s\n' "$out" | grep -n "^[a-z ]* $WCR/proj" | head -1 | cut -d: -f1)
last_tmp=$(printf '%s\n' "$out" | grep -n "^[a-z ]* $ORCHESTRATOR_HOST_TMP/" | tail -1 | cut -d: -f1)
check "the orphans are decided before any checkout" "1" "$([ -n "$last_tmp" ] && [ -n "$first_ckt" ] && [ "$last_tmp" -lt "$first_ckt" ] && echo 1 || echo 0)"
CACHED=$(ls "$ORCHESTRATOR_STATE_DIR/sweep-prs" 2>/dev/null | grep -c .)
: > "$WC/gh-calls"
wcgh bash "$WS" sweep --dry-run >/dev/null 2>&1
check "the lists are cached in the state directory, one file per origin; a second sweep asks gh nothing" "2|0" "$CACHED|$(grep -c . "$WC/gh-calls")"
touch -t 200001010000 "$ORCHESTRATOR_STATE_DIR"/sweep-prs/*
wcgh bash "$WS" sweep --dry-run >/dev/null 2>&1
check "a list older than thirty minutes is asked again" "2" "$(grep -c . "$WC/gh-calls")"
rm -rf "$ORCHESTRATOR_STATE_DIR/sweep-prs"

out=$(wcgh bash "$WS" sweep --deadline 0 2>"$WC/sweep-dl.err"); code=$?
check "a spent deadline stops cleanly before the next item: nothing deleted, said" "0|$BEFORE|1" \
  "$code|$(nitems)|$(grep -c 'deadline' "$WC/sweep-dl.err")"

: > "$WC/gh-offline"
out=$(wcgh bash "$WS" sweep 2>"$WC/sweep-off.err"); code=$?
rm -f "$WC/gh-offline"
check "gh unreachable: no checkout deleted, each repository says so once, the items are kept with the reason" "0|$BEFORE|2|1" \
  "$code|$(nitems)|$(grep -c 'cannot read the pull requests' "$WC/sweep-off.err")|$(printf '%s\n' "$out" | grep -c "^kept $C_MERGED: .*pull requests")"
check "and a failed call is never cached" "0" "$(ls "$ORCHESTRATOR_STATE_DIR/sweep-prs" 2>/dev/null | grep -c .)"
mkorphans

out=$(wcgh bash "$WS" sweep 2>"$WC/sweep.err"); code=$?
check "sweep exits 0" "0" "$code"
check "a clone whose pull request is merged or closed is deleted" "0|0|0" "$(exists "$C_MERGED")|$(exists "$C_CLOSED")|$(exists "$C_P2")"
check "a pin whose pull request is merged, or whose head moved on the pull request, is deleted" "0|0" "$(exists "$P_MERGED")|$(exists "$P_MOVED")"
check "their host temporary directories went with them" "0|0|0" \
  "$(exists "$ORCHESTRATOR_HOST_TMP/$ENCR-proj-s-merged")|$(exists "$ORCHESTRATOR_HOST_TMP/$ENCR-proj-s-closed")|$(exists "$ORCHESTRATOR_HOST_TMP/$ENCR-proj-p-merged")"
check "a clone with an open pull request is kept, with its reason" "1|1" \
  "$(exists "$C_OPEN")|$(printf '%s\n' "$out" | grep -c "^kept $C_OPEN: .*open")"
check "a clone with no pull request is kept, with its reason" "1|1" \
  "$(exists "$C_NOPR")|$(printf '%s\n' "$out" | grep -c "^kept $C_NOPR: .*no pull request")"
check "a dirty tree is kept even when its pull request is merged" "1|1" \
  "$(exists "$C_DIRTY")|$(printf '%s\n' "$out" | grep -c "^kept $C_DIRTY: .*dirty")"
check "unpushed commits are kept even when the pull request is merged" "1|1" \
  "$(exists "$C_UNPUSHED")|$(printf '%s\n' "$out" | grep -c "^kept $C_UNPUSHED: .*no remote branch")"
check "a clone on a long-lived branch is never swept on a name a pull request shares" "1|1" \
  "$(exists "$C_MAIN")|$(printf '%s\n' "$out" | grep -c "^kept $C_MAIN: .*long-lived")"
check "a clone on the repository's default branch is kept whatever its name" "1|1" \
  "$(exists "$C_STABLE")|$(printf '%s\n' "$out" | grep -c "^kept $C_STABLE: .*default branch")"
check "a clone past the head of its merged pull request keeps the work the pull request never carried" "1|1" \
  "$(exists "$C_PAST")|$(printf '%s\n' "$out" | grep -c "^kept $C_PAST: .*moved past")"
check "a clone behind the head of its merged pull request holds nothing the pull request lacks: deleted" "0" "$(exists "$C_BEHIND")"
check "a live process inside is kept even when the pull request is merged" "1|1" \
  "$(exists "$C_LIVE")|$(printf '%s\n' "$out" | grep -c "^kept $C_LIVE: .*live process")"
check "a pin on the current head of an open pull request is kept" "1|1" \
  "$(exists "$P_SAME")|$(printf '%s\n' "$out" | grep -c "^kept $P_SAME: ")"
check "a pin with no record is kept, with its reason" "1|1" \
  "$(exists "$P_NOREC")|$(printf '%s\n' "$out" | grep -c "^kept $P_NOREC: .*no recorded pull request")"
check "a pin whose head is on no branch is kept even when its pull request is merged" "1|1" \
  "$(exists "$P_NOBRANCH")|$(printf '%s\n' "$out" | grep -c "^kept $P_NOBRANCH: .*no branch")"
check "every deletion is printed and proved by the path's absence" "6|0" \
  "$(printf '%s\n' "$out" | grep -c "^deleted $WCR/proj")|$(printf '%s\n' "$out" | grep '^deleted ' | sed 's/^deleted //' | while read -r p; do [ -e "$p" ] && echo present; done | grep -c present)"
check "an orphan is removed; one past the root's name and one outside it are not" "0|1|1" "$(tmpstate | cut -d'|' -f1-3)"
check "a live session working in the directory a host directory is named after keeps it" "1" "$(tmpstate | cut -d'|' -f4)"
check "and so does one that started in a checkout's subdirectory and works below it now" "1" "$(tmpstate | cut -d'|' -f5)"
check "a sibling of the root sharing its name as a prefix is never a candidate" "1|1" "$(tmpstate | cut -d'|' -f6-7)"
check "the host directory of a directory that still exists under the root is not an orphan's" "1|1" \
  "$(exists "$ORCHESTRATOR_HOST_TMP/$ENCR-proj")|$(exists "$ORCHESTRATOR_HOST_TMP/$ENCR-plain")"
check "the host directory of a kept checkout stays" "1|1" \
  "$(exists "$ORCHESTRATOR_HOST_TMP/$(enc "$C_OPEN")")|$(exists "$ORCHESTRATOR_HOST_TMP/$(enc "$C_NOPR")")"
release
rm -rf "$H_SRC" "$H_BELOW" "$ORCHESTRATOR_HOST_TMP/${ENCR}2-x" "$ORCHESTRATOR_HOST_TMP/-elsewhere-thing" "$ORCHESTRATOR_HOST_TMP/$ENCR-old-x" "$ORCHESTRATOR_HOST_TMP/$ENCR-2-x"
for d in "$C_OPEN" "$C_NOPR" "$C_UNPUSHED" "$C_LIVE" "$C_MAIN" "$C_STABLE" "$C_PAST" "$P_SAME" "$P_NOREC"; do bash "$WS" delete "$d" --discard >/dev/null 2>&1; done
bash "$WS" delete "$C_DIRTY" --discard >/dev/null 2>&1
bash "$WS" delete "$P_NOBRANCH" --discard >/dev/null 2>&1
check "the temporary fixtures are gone and nothing is left under the root" "0" "$(nitems)"
rm -rf "$ORCHESTRATOR_HOST_TMP"/* "$WC/gh-calls" "$ORCHESTRATOR_STATE_DIR"

unset ORCHESTRATOR_WORKSPACES GIT_CONFIG_GLOBAL ORCHESTRATOR_HOST_TMP ORCHESTRATOR_STATE_DIR

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

# An implementer's duties end at its delivery. A brief that orders anything after the final
# report keeps a finished agent's tab idle; each phrase is a finding in an implementer brief,
# none in a review brief, none when the clause forbids it.
for phrase in 'After merge, delete your branch.' 'Once merged, report the sha.' 'Stand by for questions.' \
              'Keep standing by.' 'Stay until merged.' 'Stay available for the review.' \
              'Wait: after the merge, tidy up.' 'Do the cleanup after merge.'; do
  ok_brief "$B/duty.md"; printf '%s\n' "$phrase" >> "$B/duty.md"
  check_status "a post-delivery duty is a finding: $phrase" 1 bash "$LINT" "$B/duty.md"
  check "and it is named: $phrase" "1" "$(bash "$LINT" "$B/duty.md" 2>&1 | grep -c 'duty after delivery')"
  review_brief "$B/duty-review.md"; printf 'End the report with `norms-check: tool <head>`.\n%s\n' "$phrase" >> "$B/duty-review.md"
  check_status "the same phrase in a review brief is not one: $phrase" 0 bash "$LINT" "$B/duty-review.md"
done
ok_brief "$B/duty-clean.md"; printf 'Do the cleanup after merge.\n'  >> "$B/duty-clean.md"
check "a cleanup after merge is ONE finding, not two" "1" "$(bash "$LINT" "$B/duty-clean.md" 2>&1 | grep -c 'duty after delivery')"
ok_brief "$B/duty-two.md"; printf 'Stand by; stay available.\n' >> "$B/duty-two.md"
check "two phrases on a line are two findings" "2" "$(bash "$LINT" "$B/duty-two.md" 2>&1 | grep -c 'duty after delivery')"
ok_brief "$B/duty-Caps.md"; printf 'STAND BY for review.\n' >> "$B/duty-Caps.md"
check "the phrases are read case-insensitively" "1" "$(bash "$LINT" "$B/duty-Caps.md" 2>&1 | grep -c 'duty after delivery')"
ok_brief "$B/duty-forbid.md"; printf 'Never stand by; no cleanup after merge, and do not stay available.\n' >> "$B/duty-forbid.md"
check_status "a clause that forbids the duty is not one" 0 bash "$LINT" "$B/duty-forbid.md"
ok_brief "$B/duty-fp.md"; printf 'Example `/tmp/claude-501/x`, see `skills/a.sh:12`, run /implement:phase; the stand-down follows.\n' >> "$B/duty-fp.md"
check "paths, slash commands, file:line suffixes and the stand-down are no duty" "0" "$(bash "$LINT" "$B/duty-fp.md" 2>&1 | grep -c 'duty after delivery')"
# Nobody waits on CI in the foreground, and an agent never waits on it at all: an implementer
# brief that orders a `gh pr checks` watch, a loop of `gh pr view`/`gh pr checks` around a
# sleep, or a wait « until merged » is a finding; a clause that forbids it is not one.
for phrase in 'Watch it with `gh pr checks 12 --watch --fail-fast`.' 'Run timeout 590 gh pr checks <n> --watch.' \
              'for i in $(seq 1 120); do gh pr view 12 --json state; sleep 30; done' \
              'while true; do gh pr checks 12; sleep 60; done'; do
  ok_brief "$B/ciw.md"; printf '%s\n' "$phrase" >> "$B/ciw.md"
  check_status "a CI wait is a finding: $phrase" 1 bash "$LINT" "$B/ciw.md"
  check "and it is named: $phrase" "1" "$(bash "$LINT" "$B/ciw.md" 2>&1 | grep -c 'waits on CI')"
done
ok_brief "$B/ciw-loop.md"; printf '```bash\nfor i in $(seq 1 120); do\n  gh pr view 12 --json state\n  gh pr checks 12\n  sleep 30\ndone\n```\n' >> "$B/ciw-loop.md"
check "a loop over several lines, in a fence, is one finding" "1" "$(bash "$LINT" "$B/ciw-loop.md" 2>&1 | grep -c 'waits on CI')"
ok_brief "$B/ciw-noloop.md"; printf '```bash\nfor n in 1 2 3; do\n  gh pr view $n --json state\ndone\ngh pr checks 12\n```\n' >> "$B/ciw-noloop.md"
check "a loop with no sleep, and a single read of the checks, are no wait" "0" "$(bash "$LINT" "$B/ciw-noloop.md" 2>&1 | grep -c 'waits on CI')"
ok_brief "$B/ciw-forbid.md"; printf 'Never run `gh pr checks 12 --watch`; do not loop on `gh pr view` with a sleep.\n' >> "$B/ciw-forbid.md"
check_status "a clause that forbids the wait is not one" 0 bash "$LINT" "$B/ciw-forbid.md"
review_brief "$B/ciw-review.md"; printf 'End the report with `norms-check: tool <head>`.\nRun `gh pr checks 12 --watch`.\n' >> "$B/ciw-review.md"
check_status "the same command in a review brief is not one" 0 bash "$LINT" "$B/ciw-review.md"
for phrase in 'Wait until merged.' 'Poll until MERGED.'; do
  ok_brief "$B/ciw-until.md"; printf '%s\n' "$phrase" >> "$B/ciw-until.md"
  check "a wait until the merge is a post-delivery duty: $phrase" "1" "$(bash "$LINT" "$B/ciw-until.md" 2>&1 | grep -c 'duty after delivery')"
done
ok_brief "$B/duty-stay.md"; printf 'Stay until merged.\n' >> "$B/duty-stay.md"
check "stay until merged stays ONE finding" "1" "$(bash "$LINT" "$B/duty-stay.md" 2>&1 | grep -c 'duty after delivery')"
# The orchestrator, and only it, starts the watch in the background: not a finding outside an
# implementer brief, still one in it, and any other background run is one everywhere.
printf '# memo\n\nStart `ci-watch.sh 12` with `run_in_background`.\n' > "$B/ciw-orch.md"
check_status "ci-watch.sh in the background is no finding outside an implementer brief" 0 bash "$LINT" "$B/ciw-orch.md"
ok_brief "$B/ciw-agent.md"; printf 'Start `ci-watch.sh 12` with `run_in_background`.\n' >> "$B/ciw-agent.md"
check_status "in an implementer brief it still is" 1 bash "$LINT" "$B/ciw-agent.md"
printf '# memo\n\nStart `ci-watch.sh 12` with `run_in_background`, and run the suite in the background.\n' > "$B/ciw-orch2.md"
check_status "a second background run on the line is still one" 1 bash "$LINT" "$B/ciw-orch2.md"
printf '# memo\n\nRun the suite in the background.\n' > "$B/ciw-orch3.md"
check_status "another background run outside an implementer brief is still one" 1 bash "$LINT" "$B/ciw-orch3.md"
PHASEFILLED="$B/phase-filled.md"
sed -e 's/{{[A-Z_]*}}/x/g' -e '1s/.*/# scratch/' "$ROOT/templates/agent-phase-brief.md" > "$PHASEFILLED"
check "the repository's own phase template, filled, holds no post-delivery duty" "0" \
  "$(bash "$LINT" "$PHASEFILLED" 2>&1 | grep -c 'duty after delivery')"
# The clause awk must read a line the same way under any locale: a multibyte character before
# the phrase (an em dash, a guillemet) made it blind under a UTF-8 locale, so both passes run
# under LC_ALL=C. The locale is set here, not inherited from the runner.
ok_brief "$B/loc-duty.md"; printf 'Report \xe2\x80\x94 \xc2\xab then stand by for questions.\n' >> "$B/loc-duty.md"
check "check 9 sees a duty after a multibyte character under a UTF-8 locale" "1" \
  "$(LC_ALL=fr_FR.UTF-8 bash "$LINT" "$B/loc-duty.md" 2>&1 | grep -c 'duty after delivery')"
ok_brief "$B/loc-bg.md"; printf 'Report \xe2\x80\x94 \xc2\xab then run it in the background.\n' >> "$B/loc-bg.md"
check "check 7 sees a background order after a multibyte character under a UTF-8 locale" "1" \
  "$(LC_ALL=fr_FR.UTF-8 bash "$LINT" "$B/loc-bg.md" 2>&1 | grep -c 'background')"
# A phrase QUOTED is a mention, not an order: inside backticks, inside guillemets, or on a line
# inside a fence. The same phrase left bare on the same line is still read. Run under a UTF-8
# locale, where the guillemets are multibyte.
for quoted in 'The old clause « stand by » is removed.' 'The old clause `stand by` is removed.' \
              'The old clause « after merge » and `once merged` are removed.'; do
  ok_brief "$B/q.md"; printf '%s\n' "$quoted" >> "$B/q.md"
  check "a quoted phrase is not a duty: $quoted" "0" \
    "$(LC_ALL=fr_FR.UTF-8 bash "$LINT" "$B/q.md" 2>&1 | grep -c 'duty after delivery')"
done
ok_brief "$B/q-fence.md"; printf '```\nStand by for questions.\n```\n' >> "$B/q-fence.md"
check "a phrase inside a fence is not a duty" "0" \
  "$(LC_ALL=fr_FR.UTF-8 bash "$LINT" "$B/q-fence.md" 2>&1 | grep -c 'duty after delivery')"
ok_brief "$B/q-bare.md"; printf 'The clause « stand by » is removed; once merged, stand by.\n' >> "$B/q-bare.md"
check "the same phrase unquoted on the same line is still a duty" "2" \
  "$(LC_ALL=fr_FR.UTF-8 bash "$LINT" "$B/q-bare.md" 2>&1 | grep -c 'duty after delivery')"
ok_brief "$B/q-bare2.md"; printf 'The clause `stand by` is removed; stand by anyway.\n' >> "$B/q-bare2.md"
check "a bare phrase after a backticked one is still a duty" "1" \
  "$(LC_ALL=fr_FR.UTF-8 bash "$LINT" "$B/q-bare2.md" 2>&1 | grep -c 'duty after delivery')"
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
ok_brief "$B/bg-nothing.md"; printf 'NOTHING runs in the background.\n' >> "$B/bg-nothing.md"
check_status "nothing forbids the background" 0 bash "$LINT" "$B/bg-nothing.md"
ok_brief "$B/bg-run-it.md"; printf 'Run it in the background.\n' >> "$B/bg-run-it.md"
check_status "run it in the background is still a finding" 1 bash "$LINT" "$B/bg-run-it.md"

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

# `rhythm.sh` (§52): the net balance an audit reads, generic and derived from git
# alone. The fixture repository is built by a script with fixed dates and line counts, and
# every expected figure below is written in that script's header.
RREPO="$WORK/rhythm-repo"
bash "$ROOT/tests/fixtures/rhythm-repo.sh" "$RREPO" >/dev/null 2>&1
RHYTHM="$ROOT/skills/orchestrator/scripts/rhythm.sh"
rhythm() { bash "$RHYTHM" "$@" 2>&1; }
ROUT=$(rhythm "$RREPO" --since 2026-08-10 --product 'design/src/**' --instrument 'scripts/**' --instrument 'tests/**')
check "merges per week, typed by the pull request's title" \
  "week feat fix chore docs ci build test refactor other total|2026-W33 1 1 0 1 0 0 0 0 0 3|2026-W34 1 0 0 0 1 0 1 0 1 4" \
  "$(printf '%s\n' "$ROUT" | grep -E '^(week feat |2026-W[0-9]+ [0-9])' | paste -sd'|' -)"
check "nothing before --since is counted" "0" "$(printf '%s\n' "$ROUT" | grep -c 'W32')"
check "lines under the product's globs against the instruments'" "product +21 -1|instrument +27 -0" \
  "$(printf '%s\n' "$ROUT" | grep -E '^(product|instrument) \+' | sed 's/  *(.*$//' | paste -sd'|' -)"
# A glob's `*` crosses directories, as in git's own pathspecs: under the `:(glob)` magic it
# did not, and a product written `src/*.ts` counted the directory's top-level files only —
# measured on a real repository at +738 where git read +40936. The nested file decides it.
check "a glob's * crosses directories, and the output says so" "product +21 -1|1" \
  "$(rhythm "$RREPO" --since 2026-08-10 --product 'design/src/*.ts' | grep '^product +' | sed 's/  *(.*$//')|$(printf '%s\n' "$ROUT" | grep -c 'git pathspecs, where \* crosses directories')"
check "without globs, those readings say so" "1|1" \
  "$(rhythm "$RREPO" --since 2026-08-10 | grep -c '^product: no --product glob given$')|$(rhythm "$RREPO" --since 2026-08-10 | grep -c '^instrument: no --instrument glob given$')"
check "no --since, or no repository, is refused" "1|1" \
  "$(rhythm "$RREPO" >/dev/null 2>&1; echo $?)|$(rhythm "$WORK/not-a-repo-at-all" --since 2026-08-10 >/dev/null 2>&1; echo $?)"
# A bare date means its midnight (issue #52). git completes `--since=2026-08-12` with the
# current time of day, so an audit run on the day of its scope read zero merges where there
# were five. git's clock is pinned (GIT_TEST_DATE_NOW, 23:00 UTC on the fixture's merge day)
# so that the reading does not depend on the hour the suite runs at.
rhythm_late() { TZ=UTC GIT_TEST_DATE_NOW=1786575600 bash "$RHYTHM" "$@" 2>&1; }
check "a bare --since on the day of the last merge counts that merge" "2026-W33 0 0 0 1 0 0 0 0 0 1" \
  "$(rhythm_late "$RREPO" --since 2026-08-12 | grep -E '^2026-W33 [0-9]' | paste -sd'|' -)"
check "a date with a time is passed as given, and the header says what was read" "0|1|1" \
  "$(rhythm_late "$RREPO" --since 2026-08-12T13:00:00 | grep -c '^2026-W33 ')|$(rhythm_late "$RREPO" --since 2026-08-12 | grep -c 'since 2026-08-12T00:00:00$')|$(rhythm_late "$RREPO" --since 2026-08-12T13:00:00 | grep -c 'since 2026-08-12T13:00:00$')"
check "the usage says that a bare date is read from its midnight" "1" \
  "$(rhythm "$RREPO" --bogus x | grep -c 'a bare YYYY-MM-DD means its midnight')"

# The default branch when the clone never learned origin/HEAD (`git init` + `remote add` +
# `fetch`): the remote's own answer is asked, and the reading is said on stderr. `trunk-x` is
# in no fallback list; the origin is a local bare repository, so no network is needed.
RBARE="$WORK/rhythm-origin.git"
RCLONE="$WORK/rhythm-clone"
rm -rf "$RBARE" "$RCLONE"
git clone -q --bare "$RREPO" "$RBARE" 2>/dev/null
git -C "$RBARE" branch -q trunk-x main && git -C "$RBARE" symbolic-ref HEAD refs/heads/trunk-x
git init -q "$RCLONE" && git -C "$RCLONE" remote add origin "$RBARE" && git -C "$RCLONE" fetch -q origin 2>/dev/null
# A recent git sets origin/HEAD on the first fetch; the clones this covers never had it.
git -C "$RCLONE" remote set-head origin -d >/dev/null 2>&1
git -C "$RCLONE" checkout -q -b elsewhere origin/main~1 2>/dev/null
rhythm_split() { bash "$RHYTHM" "$@" 2>"$WORK/rhythm.err"; }
check "origin/HEAD unset: the remote's own default branch is read" "rhythm: $RCLONE on origin/trunk-x since 2026-08-10T00:00:00" \
  "$(rhythm_split "$RCLONE" --since 2026-08-10 | head -1)"
check "and the reading is said on stderr, in one line" "rhythm: origin/HEAD is unset; read origin/trunk-x from the remote" \
  "$(cat "$WORK/rhythm.err")"
git -C "$RCLONE" remote set-head origin trunk-x >/dev/null 2>&1
rhythm_split "$RCLONE" --since 2026-08-10 >/dev/null
check "origin/HEAD set: nothing on stderr" "0" "$(wc -c < "$WORK/rhythm.err" | tr -d ' ')"
git -C "$RCLONE" remote set-head origin -d >/dev/null 2>&1
git -C "$RCLONE" remote set-url origin "$WORK/no-such-origin.git"
rhythm_split "$RCLONE" --since 2026-08-10 | head -1 | grep -q ' on elsewhere since ' && g=elsewhere || g=other
check "the remote unreachable: the fallback is used and said as a guess" "elsewhere|rhythm: origin/HEAD is unset and the remote did not answer; guessed elsewhere" \
  "$g|$(cat "$WORK/rhythm.err")"
# The remote answers, but with a name this clone has neither as origin/<name> nor as a local
# branch (never fetched): the line must not say that the remote did not answer.
RBARE2="$WORK/rhythm-origin2.git"
RCLONE2="$WORK/rhythm-clone2"
rm -rf "$RBARE2" "$RCLONE2"
git clone -q --bare "$RREPO" "$RBARE2" 2>/dev/null
git -C "$RBARE2" branch -q trunk-y main && git -C "$RBARE2" symbolic-ref HEAD refs/heads/trunk-y
git init -q "$RCLONE2" && git -C "$RCLONE2" remote add origin "$RBARE2"
git -C "$RCLONE2" fetch -q origin main 2>/dev/null
git -C "$RCLONE2" checkout -q -b work origin/main 2>/dev/null
rhythm_split "$RCLONE2" --since 2026-08-10 >/dev/null
check "the remote names a branch the clone lacks: said as such, not as silence" "rhythm: origin/HEAD is unset; the remote names trunk-y, which this clone does not have; guessed work" \
  "$(cat "$WORK/rhythm.err")"

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

# --account-connectors: one CHOSEN spawn loads the account's connectors — the ones sessions
# the operator opens by hand already load, and which --strict-mcp-config (§42) excludes from
# every spawn since it drops every scope but the file the catalogue writes. The flag drops
# strict for that spawn only; the catalogue's chosen servers still travel exactly as before.
# Dropping strict reopens the project's own "enable these MCP servers?" dialog that
# --strict-mcp-config had made moot, so it is pre-answered again, the way every launch
# pre-answered it before the catalogue existed (`enableAllProjectMcpServers`, confirmed
# against the host's own settings shape — `enabledMcpjsonServers` / `disabledMcpjsonServers`
# sit beside it there). Without the flag nothing changes: byte-identical to every other spawn.
check "without the flag, the launch is unchanged: strict, no project-server setting" "1|0" \
  "$(mcpd | sed -n 's/^launch=//p' | grep -c -- '--strict-mcp-config')|$(mcpd | sed -n 's/^launch=//p' | grep -c -- 'enableAllProjectMcpServers')"
check "--account-connectors drops --strict-mcp-config" "0" \
  "$(mcpd --account-connectors | sed -n 's/^launch=//p' | grep -c -- '--strict-mcp-config')"
check "--account-connectors still hands over the chosen servers' file, unchanged" "1|a" \
  "$(mcpd --account-connectors | sed -n 's/^launch=//p' | grep -c -- '--mcp-config ')|$(mcpd --account-connectors | sed -n 's/^mcp=//p')"
check "--account-connectors pre-answers the project's own server dialog" "1" \
  "$(mcpd --account-connectors | sed -n 's/^launch=//p' | grep -Fc -- '"enableAllProjectMcpServers":true')"
check "--account-connectors merges into the one --settings JSON already on the launch" "1" \
  "$(mcpd --account-connectors | sed -n 's/^launch=//p' | grep -Fc -- "--settings '{\"remoteControlAtStartup\":false,\"enableAllProjectMcpServers\":true}'")"
check "the dry run says the option is on, and off by default" "1|1" \
  "$(mcpd --account-connectors | grep -c '^account_connectors=yes$')|$(mcpd | grep -c '^account_connectors=no$')"
# No catalogue at all: still drops strict and still pre-answers, and still writes no file —
# the option changes strict and the setting, nothing about server SELECTION.
check "--account-connectors with no catalogue still drops strict and pre-answers" "0|0|1" \
  "$(nocat --account-connectors | sed -n 's/^launch=//p' | grep -c -- '--strict-mcp-config')|$(nocat --account-connectors | sed -n 's/^launch=//p' | grep -c -- '--mcp-config ')|$(nocat --account-connectors | sed -n 's/^launch=//p' | grep -Fc -- '"enableAllProjectMcpServers":true')"

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

# An auditor kept on past its report succeeds at its gate (§9.4, §52): `spawn --successor` from
# a session named `Audit : <subject>` derives that name like it does for `Orch :`, lands
# immediately right of the caller (so, once the predecessor's tab is closed, in the auditor's
# own place left of its orchestrator), runs on the caller's model under remote control, and
# takes and hands no chain: an auditor has none, and written into one it would anchor an
# orchestrator's next agent.
PSAUDTAB="$WORK/ps-audit-succ.txt"
printf '/dev/ttys900 /opt/x/host --name Audit : tm --permission-mode auto\n' > "$PSAUDTAB"
audsucc() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-aud ORCHESTRATOR_PS_TABLE="${AUDPS:-$PSAUDTAB}" \
  bash "$AGENT" spawn --dir "$WORK" --prompt p "$@" 2>&1; }
AUDSUCCOUT=$(audsucc --successor --inherit-model --permission-mode auto)
AUDSUCCLAUNCH=$(printf '%s' "$AUDSUCCOUT" | sed -n 's/^launch=//p')
check "an auditor's successor takes the caller's name and comes up under remote control under it" "1|1|0" \
  "$(printf '%s' "$AUDSUCCLAUNCH" | grep -c -- "--name 'Audit : tm'")|$(printf '%s' "$AUDSUCCLAUNCH" | grep -c -- "--remote-control 'Audit : tm'")|$(printf '%s' "$AUDSUCCLAUNCH" | grep -c -- '--settings')"
check "it runs on the caller's model, with the flag or without" "1|1" \
  "$(printf '%s' "$AUDSUCCLAUNCH" | grep -c -- '--model aud-model')|$(audsucc --successor | sed -n 's/^launch=//p' | grep -c -- '--model aud-model')"
check "it lands immediately right of the caller, past no agent of any chain" "right|1" \
  "$(printf '%s' "$AUDSUCCOUT" | sed -n 's/^side=//p')|$(printf '%s' "$AUDSUCCOUT" | grep -c '^anchor=self$')"
check "it takes and hands no chain, and is not an auditor's spawn" "none|yes|no" \
  "$(printf '%s' "$AUDSUCCOUT" | sed -n 's/^chain=//p')|$(printf '%s' "$AUDSUCCOUT" | sed -n 's/^successor=//p')|$(printf '%s' "$AUDSUCCOUT" | sed -n 's/^auditor=//p')"
check "an orchestrator's successor from the same state still hands the chain over" "transfer" \
  "$(succ "$PSTAB" --successor | sed -n 's/^chain=//p')"
check "a typed audit title is still refused beside --successor, and a 26-character subject is refused" "1|1" \
  "$(audsucc --successor --title 'Audit : x' | grep -c "an audit title is an auditor's")|$(printf '/dev/ttys900 /opt/x/host --name Audit : %s --permission-mode auto\n' "$AUD26" > "$WORK/ps-audit-long.txt"; AUDPS="$WORK/ps-audit-long.txt"; audsucc --successor >/dev/null 2>&1; echo $?)"
# The 25-character subject is the longest an auditor's title takes: it is ACCEPTED as a
# successor, under the caller's name, right of it, in no chain. That half falls with the auditor
# branch removed, which the refusal of 26 alone does not (it fails either title shape).
printf '/dev/ttys900 /opt/x/host --name Audit : %s --permission-mode auto\n' "$AUD25" > "$WORK/ps-audit-25.txt"
AUD25OUT=$(AUDPS="$WORK/ps-audit-25.txt"; audsucc --successor)
check "a 25-character subject is accepted as a successor: the caller's name, right of it, in no chain" "1|right|none" \
  "$(printf '%s' "$AUD25OUT" | grep -c "^name=Audit : $AUD25\$")|$(printf '%s' "$AUD25OUT" | sed -n 's/^side=//p')|$(printf '%s' "$AUD25OUT" | sed -n 's/^chain=//p')"
# An auditor's successor runs on the caller's model and comes up under remote control under its
# name: a tier, a model or no remote control beside --successor is refused, one flag at a time.
for AUDSUCCFLAG in "--tier standard" "--model a-model" "--no-remote-control"; do
  check "an auditor's successor refuses ${AUDSUCCFLAG%% *}, and says so" "1|1" \
    "$(audsucc --successor $AUDSUCCFLAG >/dev/null 2>&1; echo $?)|$(audsucc --successor $AUDSUCCFLAG | grep -c -- "spawn: refused: ${AUDSUCCFLAG%% *} is not an auditor's successor's")"
done

# An auditor lands where it was told only if the terminal's API answered; the API-less rung
# places nothing, and any other cause leaves the tab elsewhere with the launch reported as
# done. So the launcher READS the order the listing prints, repairs once with its own move,
# reads again, and says so on stdout, exiting non-zero, when it is still wrong. The decision
# is a pure function of what was read, so the suite drives it with a scripted listing.
settle() { "$py" -c "
import sys; sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
AUD, CALLER = '/dev/ttys950', '/dev/ttys900'
def rows(*order):
    return [m.row_for(1, i, tty, 't', None, False, False) for i, tty in enumerate(order, 1)]
RIGHT = rows('/dev/ttys800', AUD, CALLER, '/dev/ttys901')
WRONG = rows(AUD, '/dev/ttys800', CALLER, '/dev/ttys901')
OTHER_WINDOW = [m.row_for(2, 1, AUD, 't', None, False, False), m.row_for(1, 2, CALLER, 't', None, False, False)]
HIDDEN = [m.row_for(1, 1, AUD, 't', None, False, False), m.row_for(1, 2, '/dev/ttys777', 't', None, False, False),
          m.row_for(1, 2, CALLER, 't', None, False, True)]  # the caller is a hidden pane of tab 2
scenario = sys.argv[1]
reads, moves = [], []
if scenario == 'placed': seq = [RIGHT]
elif scenario == 'repaired': seq = [WRONG, RIGHT]
elif scenario == 'stuck': seq = [WRONG, WRONG]
elif scenario == 'unread': seq = [None]
elif scenario == 'unread-after-move': seq = [WRONG, None]
elif scenario == 'unserved': seq = [WRONG, WRONG]
elif scenario == 'elsewhere': seq = [OTHER_WINDOW, OTHER_WINDOW]
else:
    seq = None
if seq is None:
    print(m.placed_left_of({'window': OTHER_WINDOW, 'hidden': HIDDEN}[scenario], AUD, CALLER))
    sys.exit(0)
def read():
    reads.append(1)
    return seq[min(len(reads), len(seq)) - 1]
def move(tty, anchor):
    moves.append((tty, anchor))
    return False if scenario == 'unserved' else True
line, code = m.settle_auditor(read, move, AUD, CALLER)
print('%d|%d|%s|%d|%s' % (len(reads), len(moves), ','.join('%s>%s' % t for t in moves), code, line))
" "$1"; }
check "an auditor already immediately left of its caller is read once and moved never" "1|0||0|" "$(settle placed)"
check "a misplaced auditor is moved --left-of its caller, then read again, and nothing is said" \
  "2|1|/dev/ttys950>/dev/ttys900|0|" "$(settle repaired)"
check "an auditor still misplaced after one move is said on one line naming both ttys and the remedy, exit 1" \
  "2|1|/dev/ttys950>/dev/ttys900|1|spawn: the auditor on /dev/ttys950 is not immediately left of /dev/ttys900; repair it with: iterm-agent.sh move --tty /dev/ttys950 --left-of /dev/ttys900" \
  "$(settle stuck)"
check "a listing that cannot be read is said unverified, with the way to read it, and the session stays" \
  "1|0||1|spawn: could not read the tab order, so the auditor's place on /dev/ttys950 is unverified; check with: iterm-agent.sh list" \
  "$(settle unread)"
check "a listing lost after the move is unverified too, not reported as misplaced" \
  "2|1|/dev/ttys950>/dev/ttys900|1|spawn: could not read the tab order, so the auditor's place on /dev/ttys950 is unverified; check with: iterm-agent.sh list" \
  "$(settle unread-after-move)"
check "a move the terminal cannot serve says its API is not available, and offers no move command" \
  "2|1|/dev/ttys950>/dev/ttys900|1|spawn: the auditor on /dev/ttys950 is not immediately left of /dev/ttys900, and could not be moved because the terminal's API is not available; read iterm-agent.sh list and move the tab by hand only if it is misplaced" \
  "$(settle unserved)"
check "an auditor in another window than its caller says so, since a move cannot cross windows" \
  "2|1|/dev/ttys950>/dev/ttys900|1|spawn: the auditor on /dev/ttys950 is in another window than its orchestrator on /dev/ttys900; see iterm-agent.sh list" \
  "$(settle elsewhere)"
check "the same tab number in another window is not left of the caller" "False" "$(settle window)"
check "a caller that is a hidden pane is placed by its tab: the auditor in the tab before it counts" "True" \
  "$(settle hidden)"

# The move finds its anchor by ANY pane of a tab, as the anchor probe does, and never across
# windows: a caller in a split tab whose current pane is another pane is still in its tab.
mvleft() { "$py" -c "
import asyncio, sys
sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
class S:
    def __init__(self, tty): self.tty = tty; self.session_id = tty
    async def async_get_variable(self, name): return self.tty
class T:
    def __init__(self, tab_id, *ttys): self.tab_id = tab_id; self.all_sessions = [S(x) for x in ttys]; self.current_session = self.all_sessions[-1]
class W:
    def __init__(self, window_id, *tabs): self.window_id = window_id; self.tabs = list(tabs); self.set = None
    async def async_set_tabs(self, tabs): self.set = [t.tab_id for t in tabs]
class App:
    def __init__(self, *windows): self.windows = windows
class API:
    def __init__(self, app): self.app = app
    async def async_get_app(self, connection): return self.app
AUD, CALLER = '/dev/ttys950', '/dev/ttys900'
split = T('c', CALLER, '/dev/ttys777')  # the caller's pane is hidden: another pane is current
if sys.argv[1] == 'split':
    w = W('w1', T('a', AUD), T('b', '/dev/ttys800'), split); api = API(App(w))
else:
    w = W('w1', T('a', AUD), T('b', '/dev/ttys800')); api = API(App(w, W('w2', split)))
asyncio.run(m.move_left_of(api, None, AUD, CALLER))
print(w.set)
" "$1"; }
check "an auditor moves immediately before a caller whose current pane is another pane of its tab" \
  "['b', 'a', 'c']" "$(mvleft split)"
check "a caller in another window moves nothing: a move does not cross windows" "None" "$(mvleft window)"

# The wiring is a decision of its own: the repair is called, the line goes to STDOUT, the tty
# is printed whatever the repair did, and the exit follows. The suite drives `cmd_spawn`
# itself with the terminal stubbed under it — the real `served_by`, `repair_auditor_place`
# and `settle_auditor` — and reads what a caller reads: stdout, stderr and the exit code.
AUDTRUST="$WORK/aud-trust.json"; printf '{"projects":{}}\n' > "$AUDTRUST"
spawn_aud() { # <scenario> [backend]: prints the exit code; stdout and stderr land in files
  ORCHESTRATOR_STATE_DIR="$AUDSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_SELF_ID=S-ME \
  CLAUDE_CODE_SESSION_ID=s-aud ORCHESTRATOR_BACKEND="${2:-api}" ORCHESTRATOR_TRUST_FILE="$AUDTRUST" \
  AUD_OUT="$WORK/aud-spawn.out" AUD_ERR="$WORK/aud-spawn.err" "$py" -c "
import contextlib, sys
sys.path.insert(0,'$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
AUD, CALLER = '/dev/ttys950', '/dev/ttys900'
def rows(*order):
    return [m.row_for(1, i, tty, 't', None, False, False) for i, tty in enumerate(order, 1)]
RIGHT = rows('/dev/ttys800', AUD, CALLER)
WRONG = rows(AUD, '/dev/ttys800', CALLER)
scenario = sys.argv[1]
readings = {'misplaced': [WRONG, WRONG], 'unread': ['boom'], 'move-fails': [WRONG, RIGHT],
            'api-less': [WRONG, WRONG], 'broken': [['wx/t1 | /dev/ttys950 | t | n']]}[scenario]
reads = []
def next_reading():
    reads.append(1)
    item = readings[min(len(reads), len(readings)) - 1]
    if item == 'boom':
        raise RuntimeError('the listing failed')
    return item
def stub_run(fn):
    if fn.__name__ == 'probe': return True
    if fn.__name__ == 'go': return AUD
    if fn.__name__ == 'rows': return next_reading()
    if scenario == 'move-fails': raise RuntimeError('set_tabs refused')
m.run = stub_run
m.as_spawn = lambda command: AUD
m.as_list = next_reading
code = 0
with open('$WORK/aud-spawn.out', 'w') as out, open('$WORK/aud-spawn.err', 'w') as err, \
     contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
    try:
        m.cmd_spawn(['--dir', '$WORK', '--prompt', 'p', '--auditor', '--title', 'Audit : tm',
                     '--trust', '--no-verify'])
    except SystemExit as exc:
        code = exc.code or 0
print(code)
" "$1"; }
check "a misplaced auditor: the line on stdout, the tty still printed, exit 1" "1|1|1" \
  "$(spawn_aud misplaced)|$(grep -c 'is not immediately left of /dev/ttys900; repair it with: iterm-agent.sh move --tty /dev/ttys950 --left-of /dev/ttys900' "$WORK/aud-spawn.out")|$(grep -c '^/dev/ttys950$' "$WORK/aud-spawn.out")"
check "a listing that cannot be read: one line on stderr, the unverified line, the tty printed, exit 1" "1|1|1|1" \
  "$(spawn_aud unread)|$(grep -c 'could not be read: the listing failed' "$WORK/aud-spawn.err")|$(grep -c "the auditor's place on /dev/ttys950 is unverified; check with: iterm-agent.sh list" "$WORK/aud-spawn.out")|$(grep -c '^/dev/ttys950$' "$WORK/aud-spawn.out")"
check "an exception in the move: one line on stderr, the tty printed, the second reading decides" "0|1|1|0" \
  "$(spawn_aud move-fails)|$(grep -c 'could not be moved' "$WORK/aud-spawn.err")|$(grep -c '^/dev/ttys950$' "$WORK/aud-spawn.out")|$(grep -c 'Traceback' "$WORK/aud-spawn.err")"
check "a repair that itself breaks: one line on stderr, the unverified line, the tty printed, exit 1" "1|1|1|1" \
  "$(spawn_aud broken)|$(grep -c 'could not be settled' "$WORK/aud-spawn.err")|$(grep -c 'is unverified' "$WORK/aud-spawn.out")|$(grep -c '^/dev/ttys950$' "$WORK/aud-spawn.out")"
check "the API-less rung: no placement warning on stderr, the API-not-available line, the tty, exit 1" "1|0|1|1" \
  "$(spawn_aud api-less applescript)|$(grep -c 'cannot place a tab' "$WORK/aud-spawn.err")|$(grep -c "could not be moved because the terminal's API is not available" "$WORK/aud-spawn.out")|$(grep -c '^/dev/ttys950$' "$WORK/aud-spawn.out")"

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

# The launcher's documentation names the move --leftmost form; the coordinator's placement
# is explained where it is used, the start command and the successor's brief, so a session
# that loads the launcher's skill, the orchestrator's or a brief template reads nothing of
# the coordinator. The entry point's header still lists both forms.
ITERMSKILL="$ROOT/skills/iterm-agents/SKILL.md"
ITERMCMDS="$ROOT/skills/iterm-agents/references/commands.md"
ITERMSH="$ROOT/skills/iterm-agents/scripts/iterm-agent.sh"
check "the launcher's skill and command reference document move --leftmost" "yes|yes" \
  "$(spells "$ITERMSKILL" '--leftmost')|$(spells "$ITERMCMDS" '--leftmost')"
check "no orchestrator, launcher or brief-template text names the coordinator" "" \
  "$(cd "$ROOT" && grep -rln -i 'coordinat' skills/orchestrator skills/iterm-agents/SKILL.md skills/iterm-agents/references templates/agent-*.md templates/orchestrator-succession-brief.md commands/decide.md commands/succeed.md commands/audit.md)"
check "the start command and the successor's brief explain the coordinator's placement" "yes|yes|yes|yes" \
  "$(spells "$ROOT/commands/coordinator.md" '--coordinator-successor --title')|$(spells "$ROOT/commands/coordinator.md" 'refuse a tab whose session is named `Coord :` unless `--force`')|$(spells "$ROOT/templates/coordinator-succession-brief.md" '`--coordinator-successor`, which opens at the FIRST place of the window')|$(spells "$ROOT/templates/coordinator-succession-brief.md" 'refuse a `Coord :`')"
check "the entry point's header lists both new forms" "yes|yes" \
  "$(spells "$ITERMSH" '--coordinator-successor')|$(spells "$ITERMSH" '--leftmost')"

# The coordinator's own rulebook and its two commands. The judgment is prose, so what is
# checked here is that every command line the prose hands the session is one the tooling
# runs — the succession's spawn line and the start's leftmost move are taken out of the text
# and run dry through the launcher, and the successor's brief, filled, lints clean — and that
# the irreversible acts stay guarded: a merge is never the coordinator's, and a tab is closed
# only by title, the predecessor's, before the successor registers.
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
check "both coordinator commands and the successor's brief load the coordination skill" "yes|yes|yes" \
  "$(spells "$COORDCMD" 'described in `orchestrator:coordination`')|$(spells "$COORDEND" 'described in `orchestrator:coordination`')|$(spells "$COORDTPL" '`orchestrator:coordination` FIRST')"
check "each coordinator command carries its description and its allowed tools" "1|1|1|1" \
  "$(sed -n '1,5p' "$COORDCMD" | grep -c '^description: ')|$(sed -n '1,5p' "$COORDCMD" | grep -c '^allowed-tools: .*coordinator\.sh')|$(sed -n '1,5p' "$COORDEND" | grep -c '^description: ')|$(sed -n '1,5p' "$COORDEND" | grep -c '^allowed-tools: .*coordinator\.sh')"
check "a merge is the operator's, relayed and never decided by the coordinator" "yes" \
  "$(spells "$COORDSKILL" 'You never decide it and never offer to')"
check "the coordinator never closes its own tab" "yes" "$(spells "$COORDSKILL" 'never close your own tab')"
COORDSPAWN=$(grep -m1 -o 'iterm-agent.sh spawn --coordinator-successor.*' "$COORDSKILL" 2>/dev/null | sed -e 's/^iterm-agent.sh spawn //' \
  -e 's#<subject>#ops#' -e "s#<your working directory>#$WORK#" -e 's#<brief path>#/tmp/coord-brief.md#')
coordspawn() { eval "set -- $COORDSPAWN"; ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-crd bash "$AGENT" spawn "$@" 2>&1; }
COORDSPAWNOUT=$(if [ -n "$COORDSPAWN" ]; then coordspawn; else echo "no spawn line"; fi)
check "the skill's succession spawn line is one the launcher runs as the coordinator's successor" "1|1|1|1" \
  "$(printf '%s' "$COORDSPAWNOUT" | grep -c '^coordinator_successor=yes$')|$(printf '%s' "$COORDSPAWNOUT" | grep -c '^anchor=leftmost$')|$(printf '%s' "$COORDSPAWNOUT" | grep -c '^chain=none$')|$(printf '%s' "$COORDSPAWNOUT" | sed -n 's/^launch=//p' | grep -c -- "--name 'Coord : ops'")"

# The start registers under the name the host lists, after the rename, and places its tab.
COORDLINE() { grep -n -m1 -F -- "$2" "$1" | cut -d: -f1; }
check "the start hands the rename line before it registers" "1" \
  "$([ "$(COORDLINE "$COORDCMD" '/rename "Coord : <subject>"')" -lt "$(COORDLINE "$COORDCMD" 'coordinator.sh register --name')" ] 2>/dev/null && echo 1 || echo 0)"
COORDMOVE=$(grep -m1 -o 'iterm-agent.sh move --tty <your tty> --leftmost' "$COORDCMD" 2>/dev/null | sed -e 's/^iterm-agent.sh move //' -e 's#<your tty>#/dev/ttys950#')
check "the command's move line puts the coordinator's own tab leftmost" "1" \
  "$(if [ -n "$COORDMOVE" ]; then eval "set -- $COORDMOVE"; ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys950 ORCHESTRATOR_SELF_ID=S-ME ORCHESTRATOR_PS_TABLE="$PSCRD" bash "$AGENT" move "$@" 2>&1 | grep -c '^move=/dev/ttys950 left_of=leftmost$'; else echo 0; fi)"

# The end clears only the recorded coordinator's record: run from the wrong tab it would end
# a coordinator nobody asked to end.
check "the end checks this session is the recorded coordinator before it clears" "1" \
  "$([ "$(COORDLINE "$COORDEND" '**This session is the recorded coordinator.**')" -lt "$(COORDLINE "$COORDEND" 'coordinator.sh clear')" ] 2>/dev/null && echo 1 || echo 0)"

# The successor's brief: register refuses while the predecessor runs, so the order is fixed —
# close by title, prove on ps, THEN register. Filled, it lints clean like every template.
check "the successor closes its predecessor's tab by title before it registers" "yes|1|yes" \
  "$(spells "$COORDTPL" 'close --tty {{PREDECESSOR_TTY}} --expect-title "Coord :"')|$([ "$(COORDLINE "$COORDTPL" 'close --tty {{PREDECESSOR_TTY}}')" -lt "$(COORDLINE "$COORDTPL" 'register --name')" ] 2>/dev/null && echo 1 || echo 0)|$(spells "$COORDTPL" '`ps -t <that tty without /dev/>`')"
COORDFILLED="$WORK/coordinator-brief-filled.md"
mkdir -p "$WORK/coord-fill/coordinator"; : > "$WORK/coord-fill/coordinator/notes.md"; : > "$WORK/coord-fill/gauge.sh"
if [ -f "$COORDTPL" ]; then
  sed -E -e 's#\{\{PREDECESSOR\}\}#Coord : ops [a1b2c3]#g' -e 's#\{\{PREDECESSOR_TTY\}\}#/dev/ttys950#g' -e 's#\{\{SUBJECT\}\}#ops#g' \
    -e "s#\{\{STATE_DIR\}\}#$WORK/coord-fill#g" -e "s#\{\{NOTES_FILE\}\}#$WORK/coord-fill/coordinator/notes.md#g" \
    -e "s#\{\{COORDINATOR_SH\}\}#$ROOT/skills/coordinator/scripts/coordinator.sh#g" -e "s#\{\{ITERM_AGENT_SH\}\}#$AGENT#g" \
    -e "s#\{\{GAUGE\}\}#$WORK/coord-fill/gauge.sh#g" -e "s#\{\{[A-Z_]+\}\}#$WORK#g" "$COORDTPL" > "$COORDFILLED"
fi
check "the coordinator's succession brief, filled with a real predecessor's values, lints clean" "yes|0" \
  "$([ -s "$COORDFILLED" ] && echo yes || echo no)|$(bash "$ROOT/skills/orchestrator/scripts/brief-lint.sh" "$COORDFILLED" >/dev/null 2>&1; echo $?)"

# `/orchestrator:audit` (§52): the brief instantiated and linted, the auditor spawned with
# the launcher's own flag and verified on the artifact. The spawn line is not only spelled:
# it is taken out of the command and run dry through the launcher, so a command that drifts
# from the launcher's flags falls here.
AUDCMD="$ROOT/commands/audit.md"
check "the audit command says at its top that it runs on the operator's word" "1" \
  "$(awk 'NR>1 && /^---$/{f=1; next} f && NF {print; exit}' "$AUDCMD" | grep -c "on the operator's word")"
check "it instantiates the audit brief template and lints it with the report path expected" "yes|yes" \
  "$(spells "$AUDCMD" 'templates/agent-audit-brief.md')|$(spells "$AUDCMD" 'brief-lint.sh <brief path> --expect-created <report path>')"
AUDSPAWN=$(grep -m1 -o 'iterm-agent.sh spawn .*' "$AUDCMD" 2>/dev/null | sed -e 's/^iterm-agent.sh spawn //' -e 's/`.*$//' \
  -e "s#<repository>#$WORK#" -e 's#<subject>#tm#' -e 's#<brief path>#/tmp/audit-brief.md#')
audspawn() { eval "set -- $AUDSPAWN"; ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-aud bash "$AGENT" spawn "$@" 2>&1; }
AUDSPAWNOUT=$(if [ -n "$AUDSPAWN" ]; then audspawn; else echo "no spawn line"; fi)
check "the command's spawn line is one the launcher runs as an auditor" "1|1|1|1" \
  "$(printf '%s' "$AUDSPAWNOUT" | grep -c '^auditor=yes$')|$(printf '%s' "$AUDSPAWNOUT" | grep -c '^name=Audit : tm$')|$(printf '%s' "$AUDSPAWNOUT" | grep -c '^chain=none$')|$(printf '%s' "$AUDSPAWNOUT" | sed -n 's/^launch=//p' | grep -c -- "--permission-mode auto")"
check "and it carries neither a tier, nor a successor's flag, nor an anchor" "0" \
  "$(printf '%s' "$AUDSPAWN" | grep -cE -- '--tier|--successor|--right-of|--left-of')"

# The audit brief (§52), filled, lints clean: a template whose own text trips the lint would
# reach every auditor with a finding its caller learned to ignore. The report path is one the
# auditor creates, so it cannot exist when the brief is linted (issue #52): the command names
# it to the lint as created later, and the lint exempts exactly it — a second absent path in
# the same brief is still a finding.
AUDBRIEF="$ROOT/templates/agent-audit-brief.md"
check "the auditor writes nothing but its report, and the operator closes its tab" "1|1" \
  "$(grep -c 'commit, no push, no comment, no label, no merge' "$AUDBRIEF")|$(grep -c 'He closes this tab' "$AUDBRIEF")"
# An auditor kept on past its report may succeed (§9.4): §2 lets it write the succession brief
# besides the report and message its own successor and predecessor only, and nothing else; §4
# names the template and the spawn line, which the launcher runs as an auditor's succession.
check "the audit brief still forbids every other file, a commit, a push and any other session" "1|1|1" \
  "$(grep -c '^(no method file, no register, no script), no commit, no push' "$AUDBRIEF")|$(grep -c 'You order nothing and apply nothing' "$AUDBRIEF")|$(grep -c 'message no session other than your own' "$AUDBRIEF")"
check "and carries the succession: the template, the spawn line in full, the operator told" "1|1|1" \
  "$(grep -c 'SUCCESSION_TEMPLATE}}. beside the report' "$AUDBRIEF")|$(grep -c -- '--successor --inherit-model --permission-mode auto --prompt "Read and execute ' "$AUDBRIEF")|$(grep -c 'He closes this tab' "$AUDBRIEF")"
# The predecessor tells the operator BEFORE it hands over, as /orchestrator:succeed orders it:
# « handed over » is its last message, nothing follows it.
check "the audit brief has the predecessor tell the operator, then wait, then hand over as its last message" "1|1|0" \
  "$(grep -c 'Tell the operator in one line that you are handing over' "$AUDBRIEF")|$(grep -c 'handed over » as your last message' "$AUDBRIEF")|$(grep -c 'Then tell the operator' "$AUDBRIEF")"
AUDBRIEFSPAWN=$(grep -m1 -o '{{ITERM_AGENT_SH}} spawn .*' "$AUDBRIEF" 2>/dev/null | sed -e 's/^{{ITERM_AGENT_SH}} spawn //' -e 's/`.*$//' \
  -e 's#{{REPOSITORY}}#'"$WORK"'#' -e 's#<succession brief path>#/tmp/audit-succession-brief.md#')
audbriefspawn() { eval "set -- $AUDBRIEFSPAWN"; audsucc "$@"; }
AUDBRIEFSPAWNOUT=$(if [ -n "$AUDBRIEFSPAWN" ]; then audbriefspawn; else echo "no spawn line"; fi)
check "the brief's spawn line is one the launcher runs as an auditor's succession" "1|none|1" \
  "$(printf '%s' "$AUDBRIEFSPAWNOUT" | grep -c '^name=Audit : tm$')|$(printf '%s' "$AUDBRIEFSPAWNOUT" | sed -n 's/^chain=//p')|$(printf '%s' "$AUDBRIEFSPAWNOUT" | sed -n 's/^launch=//p' | grep -c -- "--permission-mode auto")"
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
AUDREPORT="$WORK/audits/2026-09-13-tm.md"
AUDREAL="$WORK/audit-brief-real.md"
if [ -f "$AUDBRIEF" ]; then
  sed -E -e "s#\{\{REPORT_PATH\}\}#$AUDREPORT#g" -e "s#\{\{[A-Z_]+\}\}#$WORK#g" "$AUDBRIEF" > "$AUDREAL"
fi
check "an instantiated audit brief lints to zero with its report path expected, one finding without" "0|brief-lint: $AUDREAL: 0 findings|1" \
  "$(bash "$LINT" "$AUDREAL" --expect-created "$AUDREPORT" >/dev/null 2>&1; echo $?)|$(bash "$LINT" "$AUDREAL" --expect-created "$AUDREPORT" 2>&1)|$(bash "$LINT" "$AUDREAL" 2>/dev/null | grep -c "path does not exist: $AUDREPORT")"
cp "$AUDREAL" "$WORK/audit-brief-other.md" 2>/dev/null; printf 'Spec: `%s/nowhere.md`\n' "$WORK" >> "$WORK/audit-brief-other.md"
check "--expect-created exempts the path it names and no other" "1|0" \
  "$(bash "$LINT" "$WORK/audit-brief-other.md" --expect-created "$AUDREPORT" 2>/dev/null | grep -c "path does not exist: $WORK/nowhere.md")|$(bash "$LINT" "$WORK/audit-brief-other.md" --expect-created "$AUDREPORT" 2>/dev/null | grep -c "path does not exist: $AUDREPORT")"
check "--expect-created without a path is refused, and says so" "1|1" \
  "$(bash "$LINT" "$AUDREAL" --expect-created >/dev/null 2>&1; echo $?)|$(bash "$LINT" "$AUDREAL" --expect-created 2>&1 | grep -c -- '--expect-created needs a path')"
# Every placeholder of the brief is one the command says how to fill.
check "the brief's placeholders are the ones the command fills" \
  "{{ITERM_AGENT_SH}} {{PREVIOUS_REPORT}} {{PROJECT}} {{READING}} {{RECORDS}} {{REPORT_PATH}} {{REPOSITORY}} {{RHYTHM}} {{SINCE}} {{SUBJECT}} {{SUCCESSION_TEMPLATE}}" \
  "$(grep -oE '\{\{[A-Z_]+\}\}' "$AUDBRIEF" | sort -u | paste -sd' ' -)"
# The auditor's succession brief: modelled on the coordinator's, short, with the audit's terms
# kept and the predecessor exchange the only message allowed.
AUDSUCCTPL="$ROOT/templates/auditor-succession-brief.md"
check "the auditor's succession brief exists, with its placeholders" \
  "{{ITERM_AGENT_SH}} {{OPERATOR_WORK}} {{PREDECESSOR_TTY}} {{PREDECESSOR}} {{PROJECT}} {{REPORT_PATH}} {{REPOSITORY}} {{SUBJECT}} {{SUCCESSION_TEMPLATE}}" \
  "$(grep -oE '\{\{[A-Z_]+\}\}' "$AUDSUCCTPL" 2>/dev/null | sort -u | paste -sd' ' -)"
check "it makes the successor confirm, wait for « handed over », close the tab by title, prove it, tell the operator" "1|1|1|1|1" \
  "$(grep -c 'takeover confirmed' "$AUDSUCCTPL" 2>/dev/null)|$(grep -c 'its « handed over ». Until' "$AUDSUCCTPL" 2>/dev/null)|$(grep -c -- 'close --tty {{PREDECESSOR_TTY}} --expect-title "Audit : {{SUBJECT}}"' "$AUDSUCCTPL" 2>/dev/null)|$(grep -c 'ps -t ' "$AUDSUCCTPL" 2>/dev/null)|$(grep -c 'Tell the operator' "$AUDSUCCTPL" 2>/dev/null)"
check "and keeps the audit's terms: one report, not rewritten, nothing applied, no session messaged but the predecessor" "1|1|1" \
  "$(grep -c 'not to rewrite' "$AUDSUCCTPL" 2>/dev/null)|$(grep -c 'apply nothing' "$AUDSUCCTPL" 2>/dev/null)|$(grep -c 'no session messaged' "$AUDSUCCTPL" 2>/dev/null)"
# A successor can succeed again: it restates the spawn line in full and finds its own name,
# reference and tty first, as the coordinator's successor does.
check "the auditor's succession brief can itself succeed: the spawn line in full, and a « find yourself » step" "1|1|1" \
  "$(grep -c -- '{{ITERM_AGENT_SH}} spawn --dir {{REPOSITORY}} --successor --inherit-model --permission-mode auto --prompt "Read and execute ' "$AUDSUCCTPL" 2>/dev/null)|$(grep -c 'Find yourself' "$AUDSUCCTPL" 2>/dev/null)|$(grep -c '{{SUCCESSION_TEMPLATE}}' "$AUDSUCCTPL" 2>/dev/null | awk '{print ($1>0)}')"
AUDSUCCFILLED="$WORK/audit-succession-filled.md"
[ -f "$AUDSUCCTPL" ] && sed -E -e "s#\{\{[A-Z_]+\}\}#$WORK#g" "$AUDSUCCTPL" > "$AUDSUCCFILLED"
check "the auditor's succession brief, every placeholder filled, lints clean" "yes|0" \
  "$([ -s "$AUDSUCCFILLED" ] && echo yes || echo no)|$(bash "$ROOT/skills/orchestrator/scripts/brief-lint.sh" "$AUDSUCCFILLED" >/dev/null 2>&1; echo $?)"
# The code cites §52: the section it cites exists.
check "the design document has the audit's numbered section" "1" \
  "$(grep -c '^## 52\. The audit of an orchestrator$' "$ROOT/docs/design.md")"

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
  "$(printf '%s\n' "$out" | grep -Fc "prompt=Read and execute $BABS/good.md. Your orchestrator is $ORCHREF.")"
check "the lint verdict is shown" "1" "$(printf '%s\n' "$out" | grep -c '^lint=brief-lint: .*0 findings$')"

# A relative brief path still resolves to the absolute one the fresh session can open.
# A relative path goes through `os.getcwd()`, which the OS resolves PHYSICALLY (symlinks
# followed) — `pwd -P`, not the `pwd` used above for an already-absolute path, which
# `os.path.abspath` only normalises lexically and never touches a symlink in.
BPHYS=$(cd "$B" && pwd -P)
out=$(cd "$B" && ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief good.md --orchestrator "$ORCHREF" 2>&1)
check "a relative brief path resolves absolute in the prompt" "1" \
  "$(printf '%s\n' "$out" | grep -Fc "prompt=Read and execute $BPHYS/good.md.")"

# `--gate-tokens <N>` sets ONE session's context gate at launch: the launch exports the
# variable beside ORCHESTRATOR_SPAWNED, so the hooks and the status line the host starts
# inherit it. Without the option nothing is exported and the 300,000 default holds.
gspawn() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : gate" "$@" 2>&1; }
out=$(gspawn --prompt p --gate-tokens 200000)
check "--gate-tokens exports the gate in the launch" "1" "$(printf '%s\n' "$out" | grep -c '^launch=.*export ORCHESTRATOR_CONTEXT_GATE_TOKENS=200000 && ')"
check "without --gate-tokens nothing is exported" "0" "$(gspawn --prompt p | grep -c 'ORCHESTRATOR_CONTEXT_GATE_TOKENS')"
for bad in 0 -5 abc 1.5 ""; do
  badout=$(gspawn --prompt p --gate-tokens "$bad"); badcode=$?
  check "--gate-tokens '$bad' is refused, nothing launched" "1|0|1" \
    "$(printf '%s\n' "$badout" | grep -c 'spawn: --gate-tokens must be a positive integer')|$(printf '%s\n' "$badout" | grep -c '^launch=')|$([ "$badcode" != 0 ] && echo 1 || echo 0)"
done
out=$(gspawn --brief "$B/good.md" --orchestrator "$ORCHREF" --gate-tokens 200000)
check "with --brief the startup prompt says the gate" "1" \
  "$(printf '%s\n' "$out" | grep -Fc "prompt=Read and execute $BABS/good.md. Your orchestrator is $ORCHREF. Your context gate is 200000 tokens on a window of 1,000,000 tokens or more; below, 80 % of the window.")"
check "without --gate-tokens the startup prompt says no gate" "0" \
  "$(gspawn --brief "$B/good.md" --orchestrator "$ORCHREF" | grep -c 'Your context gate')"
out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_PS_TABLE=/dev/null bash "$AGENT" rotate --old-tty /dev/ttys901 --dir "$WORK" --title "Agent : gate" --prompt p --gate-tokens 200000 2>&1)
check "rotate passes --gate-tokens to the replacement" "1" "$(printf '%s\n' "$out" | grep -c '^launch=.*export ORCHESTRATOR_CONTEXT_GATE_TOKENS=200000 && ')"

check_status "--brief with --prompt is mutually exclusive" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/good.md" --orchestrator "$ORCHREF" --prompt x
check_status "--brief with --prompt-file is mutually exclusive" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/good.md" --orchestrator "$ORCHREF" --prompt-file "$B/good.md"
check_status "--brief without --orchestrator is refused" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/good.md"
check_status "a brief that does not exist refuses the spawn" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/absent.md" --orchestrator "$ORCHREF"

# A brief with a lint finding no longer refuses the spawn: the finding prints as a
# warning on stderr and the launch goes on, prompt built and all.
out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/placeholder.md" --orchestrator "$ORCHREF" 2>&1); code=$?
check "a brief with a lint finding still spawns" "0" "$code"
# Twice in the combined stream: once in the stderr warning, once in the dry run's own
# "lint=" introspection field, which a refusal used to make unreachable.
check "the finding is printed" "2" "$(printf '%s\n' "$out" | grep -c 'unfilled placeholder')"
check "the finding is a warning on stderr, and the launch still built a prompt" "1|1" \
  "$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/placeholder.md" --orchestrator "$ORCHREF" 2>&1 1>/dev/null | grep -c 'unfilled placeholder')|$(printf '%s\n' "$out" | grep -c '^prompt=Read and execute')"

D9STATE=$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-XXXXXX")
ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$D9STATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : brief" --brief "$B/placeholder.md" --orchestrator "$ORCHREF" >/dev/null 2>&1
check "a dry run still writes no prompt file, warning or not" "0" \
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
# rotate forwards --account-connectors like any other spawn option: a replaced agent that
# needed the account's connectors is replaced by one that still has them.
check "rotate forwards --account-connectors to the spawn" "0" \
  "$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" ORCHESTRATOR_MCP_CATALOGUE="$CAT" \
      bash "$AGENT" rotate --old-tty /dev/ttys999 --dir "$WORK" --title "Agent : rotated" --account-connectors --prompt p 2>&1 | sed -n 's/^launch=//p' | grep -c -- '--strict-mcp-config')"
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
# prints nothing, and past the first turn with no tap file it says « unmeasured » exactly
# once. The default gate is 80, not the old 60: a figure of 70 must stay under it and stay
# silent.
GH="$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-XXXXXX")"; mkdir -p "$GH/claude-orchestrator/ctx" "$GH/transcripts"
now=$(date +%s)
printf '{"session_id":"g-hi","context_percent":85,"updated_epoch":%s}\n' "$now" > "$GH/claude-orchestrator/ctx/g-hi.json"
printf '{"session_id":"g-lo","context_percent":30,"updated_epoch":%s}\n' "$now" > "$GH/claude-orchestrator/ctx/g-lo.json"
printf '{"session_id":"g-under","context_percent":70,"updated_epoch":%s}\n' "$now" > "$GH/claude-orchestrator/ctx/g-under.json"
# The first prompt's own transcript carries no assistant entry yet; the shape appears
# only once a turn has answered — this is what tells the hook its first chance came.
printf '{"type":"user","message":{"role":"user","content":"hi"}}\n' > "$GH/transcripts/no-turn.jsonl"
printf '{"type":"user","message":{"role":"user","content":"hi"}}\n{"type":"assistant","message":{"role":"assistant","content":"hey"}}\n' > "$GH/transcripts/past-turn.jsonl"
# The gate speaks only to orchestration sessions: it reads the session's name the way the
# stop gate does (the process table's `--name`, else the transcript's last rename), and the
# suite's stand-in for `ps` is a file. Unless a check says otherwise the session is an
# orchestrator.
gh_ps() { printf '/dev/ttys900 host-cli %s\n' "$1" > "$GH/ps"; }
gh_ps '--name Orch : f [a1b2c3]'
GH_ENV=(CLAUDE_CONFIG_DIR="$GH" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_PS_TABLE="$GH/ps")
gate() { printf '{"session_id":"%s"}' "$1" | env "${GH_ENV[@]}" bash "$ROOT/hooks/context-gate.sh"; }
gate_t() { printf '{"session_id":"%s","transcript_path":"%s"}' "$1" "$2" | env "${GH_ENV[@]}" bash "$ROOT/hooks/context-gate.sh"; }
check "past the gate the hook orders the succession" "1" "$(gate g-hi | grep -c 'Succeed at the next quiet boundary')"
check "under the gate the hook is silent" "" "$(gate g-lo)"
check "the default gate is 80, not 60: 70 stays under it" "" "$(gate g-under)"
check "unmeasured with no transcript at all prints nothing yet" "" "$(gate g-none)"
check "unmeasured with a transcript but no turn answered yet prints nothing" "" "$(gate_t g-none2 "$GH/transcripts/no-turn.jsonl")"
check "unmeasured past the first turn says so once" "1" "$(gate_t g-turn "$GH/transcripts/past-turn.jsonl" | grep -c 'unmeasured')"
check "unmeasured stays silent the second time" "" "$(gate_t g-turn "$GH/transcripts/past-turn.jsonl")"

# « Unmeasured » is a finding about the tap, so it fires only when the tap has not fed the
# session. The status line renders after a turn, so a prompt that follows a pause, or a long
# turn, meets a tap file older than the gauge's freshness window: the file is there and
# carries the window, the gauge reads the transcript's last usage against it, and that is a
# measure, not a failure. A first render with no figure yet (`context_percent` null) is the
# same case. The gate says what it read, so the reader is not sent to reinstall a working tap.
printf '{"type":"user","message":{"role":"user","content":"hi"}}\n{"type":"assistant","message":{"role":"assistant","model":"a-model","usage":{"input_tokens":1,"cache_creation_input_tokens":100000,"cache_read_input_tokens":249999}}}\n' > "$GH/transcripts/used-350k.jsonl"
printf '{"type":"user","message":{"role":"user","content":"hi"}}\n{"type":"assistant","message":{"role":"assistant","model":"a-model","usage":{"input_tokens":1,"cache_creation_input_tokens":1000,"cache_read_input_tokens":1000}}}\n' > "$GH/transcripts/used-2k.jsonl"
stale=$((now - 3600))
printf '{"session_id":"g-stale-hi","context_percent":12,"context_used":120000,"context_total":1000000,"transcript_path":"%s","updated_epoch":%s}\n' "$GH/transcripts/used-350k.jsonl" "$stale" > "$GH/claude-orchestrator/ctx/g-stale-hi.json"
printf '{"session_id":"g-stale-lo","context_percent":12,"context_used":120000,"context_total":1000000,"transcript_path":"%s","updated_epoch":%s}\n' "$GH/transcripts/used-2k.jsonl" "$stale" > "$GH/claude-orchestrator/ctx/g-stale-lo.json"
printf '{"session_id":"g-null-hi","context_percent":null,"context_used":null,"context_total":1000000,"transcript_path":"%s","updated_epoch":%s}\n' "$GH/transcripts/used-350k.jsonl" "$now" > "$GH/claude-orchestrator/ctx/g-null-hi.json"
stale_hi="$(gate_t g-stale-hi "$GH/transcripts/used-350k.jsonl")"
check "a stale tap file with the window: the transcript's figure trips the gate" "1" \
  "$(printf '%s\n' "$stale_hi" | grep -c 'this session is at 350,000 tokens (gate 300,000 on a 1M window)')"
check "a stale tap file with the window: no « unmeasured » line" "0" \
  "$(printf '%s\n' "$stale_hi" | grep -c 'unmeasured')"
check "a stale tap file with the window: no marker is left" "" "$(ls "$GH/claude-orchestrator/ctx" | grep 'g-stale-hi.gate-unmeasured')"
check "a stale tap file under the gate is silent" "" "$(gate_t g-stale-lo "$GH/transcripts/used-2k.jsonl")"
check "a stale tap file under the gate leaves no marker" "" "$(ls "$GH/claude-orchestrator/ctx" | grep 'g-stale-lo.gate-unmeasured')"
check "a first render with no figure yet: the transcript's figure trips the gate" "1" \
  "$(gate_t g-null-hi "$GH/transcripts/used-350k.jsonl" | grep -c 'this session is at 350,000 tokens')"
# The words say what was read, and only that. No tap file now does not prove a broken
# install: the tap prunes files older than a day on another session's first render, so a
# session paused that long has none. The line says so and names the install as the repair
# only if the status line shows nothing. A tap file present is worded the same whether it
# lacks the window or carries it and the transcript could not be read.
none_words="$(gate_t g-words-none "$GH/transcripts/past-turn.jsonl")"
check "no tap file: the line says there is none now, and why it may be" "1" \
  "$(printf '%s\n' "$none_words" | grep -c 'unmeasured: no tap file for this session now (never written, or pruned after a day without a render)')"
check "no tap file: the install is the repair only if the status line shows nothing" "1" \
  "$(printf '%s\n' "$none_words" | grep -c '/orchestrator:install is the repair only if the status line shows nothing')"
check "no tap file: the line does not assert the tap is not feeding the session" "0" \
  "$(printf '%s\n' "$none_words" | grep -c 'not feeding')"
printf '{"session_id":"g-words-nowin","context_percent":null,"context_used":null,"context_total":null,"updated_epoch":%s}\n' "$now" > "$GH/claude-orchestrator/ctx/g-words-nowin.json"
words="$(gate_t g-words-nowin "$GH/transcripts/past-turn.jsonl")"
check "a tap file with no figure: the line says the file is there" "1" \
  "$(printf '%s\n' "$words" | grep -c 'unmeasured: the tap file is present but the gauge could not read a figure from it (the next status line render may fill it)')"
check "a tap file with no figure: the line does not send the reader to reinstall" "0" \
  "$(printf '%s\n' "$words" | grep -c '/orchestrator:install')"
# The file carries the window, the transcript has no usage block yet: the old words claimed
# there was no window size, which is false here.
printf '{"session_id":"g-words-win","context_percent":null,"context_used":null,"context_total":1000000,"transcript_path":"%s","updated_epoch":%s}\n' "$GH/transcripts/past-turn.jsonl" "$now" > "$GH/claude-orchestrator/ctx/g-words-win.json"
words_win="$(gate_t g-words-win "$GH/transcripts/past-turn.jsonl")"
check "a tap file with the window, transcript unreadable: the line is the neutral one" "1" \
  "$(printf '%s\n' "$words_win" | grep -c 'unmeasured: the tap file is present but the gauge could not read a figure from it')"
check "a tap file with the window, transcript unreadable: no claim about the window size" "0" \
  "$(printf '%s\n' "$words_win" | grep -c 'no window size')"

# On a window of 1,000,000 tokens or more the gate is a count, 300,000 tokens, not a share:
# 80 % of 1M lets a session replay up to 800k of cached context on every turn. Smaller
# windows keep 80 %. The line names the figure that tripped it.
tap() { printf '{"session_id":"%s","context_percent":%s,"context_used":%s,"context_total":%s,"updated_epoch":%s}\n' \
  "$1" "$2" "$3" "$4" "$now" > "$GH/claude-orchestrator/ctx/$1.json"; }
tap g-1m-under 29 299999 1000000
tap g-1m-at 30 300000 1000000
tap g-200k-under 79 158000 200000
tap g-200k-at 80 160000 200000
check "on a 1M window, 299,999 tokens stays under the gate" "" "$(gate g-1m-under)"
check "on a 1M window, 300,000 tokens trips it, naming the tokens" "1" \
  "$(gate g-1m-at | grep -c 'this session is at 300,000 tokens (gate 300,000 on a 1M window)\. Succeed at the next quiet boundary')"
check "on a 200k window, 79 % stays under the gate" "" "$(gate g-200k-under)"
check "on a 200k window, 80 % trips it, naming the percent" "1" \
  "$(gate g-200k-at | grep -c 'this session is at 80% (gate 80%)\. Succeed at the next quiet boundary')"
gate_env() { local sid="$1"; shift; printf '{"session_id":"%s"}' "$sid" | env "${GH_ENV[@]}" "$@" bash "$ROOT/hooks/context-gate.sh"; }
check "ORCHESTRATOR_CONTEXT_GATE_TOKENS raises the token gate" "" \
  "$(gate_env g-1m-at ORCHESTRATOR_CONTEXT_GATE_TOKENS=300001)"
check "ORCHESTRATOR_CONTEXT_GATE_TOKENS lowers it" "1" \
  "$(gate_env g-1m-under ORCHESTRATOR_CONTEXT_GATE_TOKENS=299999 | grep -c 'at 299,999 tokens (gate 299,999 on a 1M window)')"
check "ORCHESTRATOR_LARGE_WINDOW above the window puts it back on the percent gate" "" \
  "$(gate_env g-1m-at ORCHESTRATOR_LARGE_WINDOW=1000001)"
check "ORCHESTRATOR_LARGE_WINDOW at 200k holds a 200k window to the tokens" "1" \
  "$(gate_env g-200k-under ORCHESTRATOR_LARGE_WINDOW=200000 ORCHESTRATOR_CONTEXT_GATE_TOKENS=150000 | grep -c 'at 158,000 tokens (gate 150,000 on a 200,000 window)')"
check "ORCHESTRATOR_CONTEXT_GATE still moves the percent gate" "1" \
  "$(gate_env g-200k-under ORCHESTRATOR_CONTEXT_GATE=79 | grep -c 'at 79% (gate 79%)')"

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
# A line per role, and nothing for a session the operator started by hand: the role is the
# prefix of the session's name, `Orch :`, `Agent :`, `Audit :` or `Coord :`.
role_line() { gh_ps "--name $1"; gate g-hi; }
check "an orchestrator is told to succeed, without asking" "1" \
  "$(role_line 'Orch : f [a1b2c3]' | grep -c '^CONTEXT GATE: this session is at 85% (gate 80%)\. Succeed at the next quiet boundary — run /orchestrator:succeed: spawn the successor in the operator.s decision mode, then tell the user; do not ask\.$')"
check "an agent is told to finish its unit, report its context, and stop" "1" \
  "$(role_line 'Agent : one [b2c3d4]' | grep -c '^CONTEXT GATE: this session is at 85% (gate 80%)\. Finish the unit in progress, report to your orchestrator with your measured context, and stop; no new phase is dispatched to you\.$')"
# An auditor has two branches in one line: no report yet, or nothing the operator gave it after
# the report, it writes the one report and stops; work he gave it after the report still in
# hand, it succeeds with the auditor's succession template, at a path it can open.
check "an auditor is told to write its one report and stop, or to succeed when work after it is in hand" "1|1|1" \
  "$(role_line 'Audit : method [c3d4e5]' | grep -c '^CONTEXT GATE: this session is at 85% (gate 80%)\. Report not written, or nothing the operator gave you after it: write the one report with what you have read, and stop\. Work he gave you after the report still in hand: succeed — ')|$(role_line 'Audit : method [c3d4e5]' | grep -c 'succeed — /.*/templates/auditor-succession-brief\.md; tell him before you hand over\.$')|$(f=$(role_line 'Audit : method [c3d4e5]' | sed -n 's/.*succeed — \(\/[^;]*\); tell him before you hand over\.$/\1/p'); [ "$f" = "$ROOT/templates/auditor-succession-brief.md" ] && echo 1 || echo 0)"
check "the coordinator is told to succeed when no relay is in flight" "1" \
  "$(role_line 'Coord : machine' | grep -c '^CONTEXT GATE: this session is at 85% (gate 80%)\. With no relay in flight, succeed as skills/coordination/SKILL\.md « Your context » says, then tell the operator\.$')"
check "each role gets exactly one line" "1|1|1|1" \
  "$(for n in 'Orch : f' 'Agent : one' 'Audit : m' 'Coord : machine'; do role_line "$n" | grep -c .; done | paste -sd'|' -)"
for n in 'Orch : f [a1b2c3]' 'Agent : one [b2c3d4]' 'Audit : method [c3d4e5]' 'Coord : machine'; do
  gh_ps "--name $n"
  check "below the gate, $n hears nothing" "" "$(gate g-lo)"
done

# A hand-started session is out of scope: no gate line, no « unmeasured » line, no drift
# line, and no marker written.
for n in 'my scratch session' 'Orchestra' 'orch : lower' 'Orch: nospace'; do
  gh_ps "--name $n"
  check "a session named « $n » gets nothing at the gate" "" "$(gate g-hi)"
  check "a session named « $n » gets nothing when unmeasured" "" "$(gate_t g-turn-hand "$GH/transcripts/past-turn.jsonl")"
done
gh_ps ''
check "a session with no readable name gets nothing at the gate" "" "$(gate g-hi)"
check "a session with no readable name gets nothing when unmeasured" "" "$(gate_t g-turn-hand2 "$GH/transcripts/past-turn.jsonl")"
check "and the unmeasured marker is not written for it" "" "$(ls "$GH/claude-orchestrator/ctx" | grep 'g-turn-hand')"
printf '{"type":"assistant","message":{"model":"a-model","usage":{"input_tokens":1,"cache_creation_input_tokens":1,"cache_read_input_tokens":1}}}\n' > "$GH/projects/p/g-drift2.jsonl"
printf '{"session_id":"g-drift2","context_percent":30,"updated_epoch":%s}\n' "$now" > "$GH/claude-orchestrator/ctx/g-drift2.json"
gh_ps '--name Orch : f [a1b2c3]'
gate g-drift2 > /dev/null
printf '{"type":"assistant","message":{"model":"b-model","usage":{"input_tokens":1,"cache_creation_input_tokens":1,"cache_read_input_tokens":1}}}\n' >> "$GH/projects/p/g-drift2.jsonl"
gh_ps '--name my scratch session'
check "a hand-started session gets nothing on a model change" "" "$(gate g-drift2)"
check "and its model marker is left as it was" "a-model" "$(cat "$GH/claude-orchestrator/ctx/g-drift2.model")"
gh_ps '--name Orch : f [a1b2c3]'

# A name read from the transcript's last rename is in scope, the launcher's own first.
gh_ps ''
printf '%s\n' '{"type":"custom-title","customTitle":"my scratch"}' '{"type":"custom-title","customTitle":"Agent : one [b2c3d4]"}' > "$GH/transcripts/renamed.jsonl"
check "a name read from the transcript's last custom-title is in scope" "1" \
  "$(gate_t g-hi "$GH/transcripts/renamed.jsonl" | grep -c 'Finish the unit in progress')"
printf '%s\n' '{"type":"custom-title","customTitle":"Agent : one [b2c3d4]"}' '{"type":"custom-title","customTitle":"my scratch"}' > "$GH/transcripts/renamed.jsonl"
check "renamed away from a role, the session is out of scope" "" "$(gate_t g-hi "$GH/transcripts/renamed.jsonl")"
gh_ps '--name Orch : f [a1b2c3]'

# The reading as a script: the name on one line, or nothing, and never a failure.
sn() { local out; out="$(printf '%s' "$1" | env "${GH_ENV[@]}" "$py" "$ROOT/hooks/session_name.py")"; echo "$out|$?"; }
check "session_name.py prints the launcher's name" "Orch : f [a1b2c3]|0" "$(sn '{"session_id":"x"}')"
gh_ps ''
check "session_name.py prints the transcript's last rename when the launcher has none" "Agent : one [b2c3d4]|0" \
  "$(printf '%s\n' '{"type":"custom-title","customTitle":"Agent : one [b2c3d4]"}' > "$GH/transcripts/sn.jsonl"; sn "{\"transcript_path\":\"$GH/transcripts/sn.jsonl\"}")"
check "session_name.py prints nothing, exit 0, when no name is readable" "|0" "$(sn '{"session_id":"x"}')"
check "session_name.py prints nothing, exit 0, on a payload that is no JSON" "|0" "$(sn 'not json {{{')"
check "session_name.py prints nothing, exit 0, on an empty payload" "|0" "$(sn '')"
check "session_name.py prints nothing, exit 0, on a payload that is no object" "|0" "$(sn '[1,2]')"

# A name with irregular spacing is printed normalised, and a normalised name is in scope.
printf '%s\n' '{"type":"custom-title","customTitle":"Orch  :  f"}' > "$GH/transcripts/spacing.jsonl"
check "session_name.py prints a name with irregular spacing normalised" "Orch : f|0" \
  "$(sn "{\"transcript_path\":\"$GH/transcripts/spacing.jsonl\"}")"
check "a name with irregular spacing is in scope for the gate" "1" \
  "$(gate_t g-hi "$GH/transcripts/spacing.jsonl" | grep -c 'Succeed at the next quiet boundary')"

# The reading's misses are logged, one line each, and never fail the script: a session whose
# name cannot be read would otherwise go dark with no trace. A session with no name at all is
# the normal case and leaves nothing.
GLOG="$GH/claude-orchestrator/context-gate.log"
longname='Orch : a name run into the prompt that follows it, far past any name'
check "no name at all: nothing is logged" "" \
  "$(gh_ps ''; rm -f "$GLOG"; sn '{"session_id":"x"}' >/dev/null; cat "$GLOG" 2>/dev/null)"
gh_ps "--name $longname"
printf '%s\n' '{"type":"user"}' > "$GH/transcripts/no-rename.jsonl"
rm -f "$GLOG"
unread_payload="$(printf '{"session_id":"s-unread","transcript_path":"%s"}' "$GH/transcripts/no-rename.jsonl")"
check "an unreadable name with no rename in the transcript: nothing printed, exit 0" "|0" \
  "$(sn "$unread_payload")"
check "and it is logged, one line, naming the session and the miss" "1|1" \
  "$(echo "$(grep -c . "$GLOG")|$(grep -c ' | s-unread | .*unreadable' "$GLOG")")"
check "an unreadable name that the transcript renames is not a miss: nothing logged" "" \
  "$(rm -f "$GLOG"; sn "{\"transcript_path\":\"$GH/transcripts/spacing.jsonl\"}" >/dev/null; cat "$GLOG" 2>/dev/null)"
# The launcher's module out of reach: the script copied where its sibling tree is absent.
mkdir -p "$GH/bare/hooks"; cp "$ROOT/hooks/session_name.py" "$GH/bare/hooks/"
rm -f "$GLOG"
check "a launcher that cannot be loaded: nothing printed, exit 0" "|0" \
  "$(out="$(printf '{"session_id":"s-nolaunch"}' | env "${GH_ENV[@]}" "$py" "$GH/bare/hooks/session_name.py")"; echo "$out|$?")"
check "and it is logged, naming the session and the module" "1|1" \
  "$(echo "$(grep -c . "$GLOG")|$(grep -c ' | s-nolaunch | .*cannot be loaded' "$GLOG")")"
# The log lives where the stop gate's does, and a log that cannot be written never fails the script.
rm -f "$GLOG"
check "ORCHESTRATOR_STATE_DIR moves the log" "1" \
  "$(printf '{"session_id":"s-moved"}' | env "${GH_ENV[@]}" ORCHESTRATOR_STATE_DIR="$GH/moved" "$py" "$GH/bare/hooks/session_name.py"; grep -c 's-moved' "$GH/moved/context-gate.log")"
: > "$GH/not-a-dir"
check "a log that cannot be written: nothing printed, exit 0" "|0" \
  "$(out="$(printf '{"session_id":"s-ro"}' | env "${GH_ENV[@]}" ORCHESTRATOR_STATE_DIR="$GH/not-a-dir/x" "$py" "$GH/bare/hooks/session_name.py")"; echo "$out|$?")"
check "the hook still says nothing for the session whose miss it logged" "" "$(gate g-hi)"
# The interpreter is started without its site import: about a hundred milliseconds, on every prompt.
check "the hook runs the reading with python3 -S" "1" "$(grep -c 'python3 -S "\$HERE/session_name\.py"' "$ROOT/hooks/context-gate.sh")"
gh_ps '--name Orch : f [a1b2c3]'
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
check "no context threshold other than the gate's rule remains in the tracked tree" "" \
  "$(cd "$ROOT" && git grep -n -E -i "$THRESHOLD_RE" -- . ':!tests/run-tests.sh' 2>/dev/null)"

# The gate is 80 % of the window, or 300,000 tokens on a window of 1,000,000 tokens or
# more. A line that states 80 % without the token half is a gate a large-window session
# would read as its own: every such line carries the rule whole, in the same words.
GATE_RULE='80 % of the window, or 300,000 tokens on a window of 1,000,000 tokens or more'
BARE_RE='([^0-9,.]|^)80 ?%|~ ?80([^0-9]|$)'
check "every line stating the 80 % gate states the token gate with it" "" \
  "$(cd "$ROOT" && git grep -n -E "$BARE_RE" -- skills hooks templates commands README.md docs/design.md | grep -v -F "$GATE_RULE")"
check "the rule is stated in « Thresholds »" "1" \
  "$(grep -c -F "**The gate is $GATE_RULE.**" "$ROOT/skills/orchestrator/SKILL.md")"

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
printf 'the gate is %s; GATE_TOKENS:-300000; LARGE_WINDOW:-1000000\n' "$GATE_RULE" > "$SWEEP/new-rule.md"
printf 'Mark sessions past 80%%\n' > "$SWEEP/bare-eighty.md"
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
check "the sweep lets the new rule's figures through" "" \
  "$(grep -rn -E -i "$THRESHOLD_RE" "$SWEEP/new-rule.md")"
check "a bare 80 % is caught, the rule stated whole is not" "1" \
  "$(grep -rn -E "$BARE_RE" "$SWEEP" | grep -v -F "$GATE_RULE" | grep -c 'bare-eighty')"
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

echo "== ci-watch =="
# The one way to wait on CI: a script an orchestrator starts in the background, that exits on
# the end of the checks with one line and a code. A fake `gh` on PATH answers from files:
# `view` (one `<STATE> <head> [auto]` line per call, the last one repeated, `auto` when the
# pull request has auto-merge enabled), `reg` (one answer per
# registration read: a count, `none` or `fail`), `failing` (the names read after a red) and
# `watch-code` (what the watch exits with, its output a marker that must never reach stdout).
# A merged pull request is followed onto its base branch: `merge` (`<sha> <base>`), `runs`
# (one answer per run list: `<id>:<workflow>` pairs joined by `;`, or `-` for none),
# `run-codes` (`<id> <code> [<conclusion>]` lines, what each run watch exits with, 0 by default,
# and the run's conclusion, read from the code when not given) and `jobs` (`<name>:<conclusion>`
# lines). `gh run view` answers with the run as JSON and runs the script's own --jq filter on it.
# `newest` answers the read of a workflow's newest push run on the branch, one `<id> <sha>` line
# per call, the last one repeated.
CW="$WORK/ci-watch"
CWB="$CW/bin"; CWS="$CW/state"
mkdir -p "$CWB" "$CWS"
cat > "$CWB/gh" <<EOF
#!/bin/bash
echo "\$*" >> "$CW/gh-calls"
nth() {  # <file> <counter>: the nth line of <file> for the nth call, the last one repeated
  local n total
  n=\$(( \$(cat "$CW/\$2" 2>/dev/null || echo 0) + 1 )); echo "\$n" > "$CW/\$2"
  total=\$(grep -c '' "\$1" 2>/dev/null || echo 0)
  [ "\$total" -gt 0 ] || return 1
  [ "\$n" -le "\$total" ] || n="\$total"
  sed -n "\${n}p" "\$1"
}
case "\$1 \$2" in
  "pr view")
    case "\$*" in
      *mergeCommit*) [ -f "$CW/merge" ] || { echo "gh: HTTP 404" >&2; exit 1; }
                     cat "$CW/merge" ;;
      *) [ -f "$CW/view" ] || { echo "gh: HTTP 502" >&2; exit 1; }
         nth "$CW/view" view-n ;;
    esac ;;
  "run list")
    case "\$*" in
      *--workflow*) r=\$(nth "$CW/newest" newest-n) || { echo "gh: HTTP 502" >&2; exit 1; }
                    [ "\$r" = - ] || echo "\$r" ;;
      *) r=\$(nth "$CW/runs" runs-n) || { echo "gh: HTTP 502" >&2; exit 1; }
         [ "\$r" = - ] || printf '%s\n' "\$r" | tr ';' '\n' | tr ':' '\t' ;;
    esac ;;
  "run watch") echo "RUN-WATCH-MARKER"
               c=\$(awk -v id="\$3" '\$1 == id { print \$2 }' "$CW/run-codes" 2>/dev/null)
               exit "\${c:-0}" ;;
  "run view") # the run as JSON, the caller's own --jq run on it
              rc=\$(awk -v id="\$3" '\$1 == id { print \$2 }' "$CW/run-codes" 2>/dev/null)
              c=\$(awk -v id="\$3" '\$1 == id { print \$3 }' "$CW/run-codes" 2>/dev/null)
              [ -n "\$c" ] || { [ "\${rc:-0}" = 0 ] && c=success || c=failure; }
              j=\$(cat "$CW/jobs" 2>/dev/null | jq -Rn '[inputs | select(length > 0) | split(":") | {name: .[0], conclusion: .[1]}]')
              f=.; while [ \$# -gt 0 ]; do [ "\$1" = --jq ] && f="\$2"; shift; done
              jq -nr --arg c "\$c" --argjson j "\$j" '{conclusion: \$c, jobs: \$j}' | jq -r "\$f" ;;
  "pr checks")
    case "\$*" in
      *--watch*) echo "WATCH-OUTPUT-MARKER"; exit "\$(cat "$CW/watch-code" 2>/dev/null || echo 0)" ;;
      *"--json name,bucket"*) cat "$CW/failing" 2>/dev/null; exit 1 ;;
      *"--json name"*) r=\$(nth "$CW/reg" reg-n)
         case "\$r" in
           none) echo "no checks reported on the 'feat' branch" >&2; exit 1 ;;
           fail) echo "error connecting to api.github.com" >&2; exit 1 ;;
           *) echo "\$r" ;;
         esac ;;
    esac ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$CWB/gh"
HA=aaaa1111bbbb2222cccc3333dddd4444eeee5555
HB=bbbb2222cccc3333dddd4444eeee5555ffff6666
CWSCRIPT="$ROOT/skills/orchestrator/scripts/ci-watch.sh"
# cw <view lines> <reg lines> <watch code> <failing> [args...]: the script's stdout|exit code
cw() {
  local view="$1" reg="$2" code="$3" failing="$4" out rc
  shift 4
  rm -f "$CW"/gh-calls "$CW"/view "$CW"/reg "$CW"/failing "$CW"/watch-code "$CW"/view-n "$CW"/reg-n \
    "$CW"/merge "$CW"/runs "$CW"/runs-n "$CW"/run-codes "$CW"/jobs "$CW"/newest "$CW"/newest-n
  [ -z "${CW_MERGE:-}" ] || printf '%b\n' "$CW_MERGE" > "$CW/merge"
  [ -z "${CW_RUNS:-}" ] || printf '%b\n' "$CW_RUNS" > "$CW/runs"
  [ -z "${CW_RUN_CODES:-}" ] || printf '%b\n' "$CW_RUN_CODES" > "$CW/run-codes"
  [ -z "${CW_JOBS:-}" ] || printf '%b\n' "$CW_JOBS" > "$CW/jobs"
  [ -z "${CW_NEWEST:-}" ] || printf '%b\n' "$CW_NEWEST" > "$CW/newest"
  [ -z "$view" ] || printf '%b\n' "$view" > "$CW/view"
  [ -z "$reg" ] || printf '%b\n' "$reg" > "$CW/reg"
  [ -z "$failing" ] || printf '%b\n' "$failing" > "$CW/failing"
  printf '%s\n' "$code" > "$CW/watch-code"
  out=$(env PATH="$CWB:$PATH" ORCHESTRATOR_STATE_DIR="$CWS" CI_WATCH_REGISTER_WAIT="${CW_WAIT:-2}" \
    CI_WATCH_BASE_WAIT="${CW_BASE_WAIT:-2}" CI_WATCH_MERGE_WAIT="${CW_MERGE_WAIT:-4}" CI_WATCH_BASE_WORKFLOWS="${CW_BASE_WORKFLOWS:-}" bash "$CWSCRIPT" "$@" 2>/dev/null); rc=$?
  printf '%s|%s' "$out" "$rc"
}
check "ci-watch exists" "yes" "$([ -f "$CWSCRIPT" ] && echo yes || echo no)"
check "green: one line, exit 0" "ci-watch: green 7 $HA|0" \
  "$(cw "OPEN $HA" "2" 0 "" 7 --interval 1)"
check "the watch's own output never reaches stdout, it lands in a log file" "1|0" \
  "$(grep -rl WATCH-OUTPUT-MARKER "$CWS" 2>/dev/null | wc -l | tr -d ' ')|$(cw "OPEN $HA" "2" 0 "" 7 --interval 1 | grep -c WATCH-OUTPUT-MARKER)"
check "red: the failing names are on the line, exit 1" "ci-watch: red 7 $HA test, e2e|1" \
  "$(cw "OPEN $HA" "2" 1 "test\ne2e" 7 --interval 1)"
check "no checks within the bound: exit 2" "ci-watch: no-checks 7 $HA|2" \
  "$(cw "OPEN $HA" "none" 0 "" 7 --interval 1)"
check "and the watch never started" "0" "$(grep -c -e '--watch' "$CW/gh-calls")"
check "checks registered after the first read (a fresh push) are waited for, not read as red" "ci-watch: green 7 $HA|0" \
  "$(cw "OPEN $HA" "none\n2" 0 "" 7 --interval 1)"
check "moved: the head differs when the watch returns, exit 3" "ci-watch: moved 7 $HA $HB|3" \
  "$(cw "OPEN $HA\nOPEN $HB" "2" 1 "test" 7 --interval 1)"
check "closed without merge: exit 4, naming the state" "ci-watch: closed 7 CLOSED|4" \
  "$(cw "OPEN $HA\nCLOSED $HA" "2" 0 "" 7 --interval 1)"
check "and no base branch run is looked for" "0" "$(grep -c '^run ' "$CW/gh-calls")"
check "already closed at the first read: exit 4" "ci-watch: closed 7 CLOSED|4" \
  "$(cw "CLOSED $HA" "2" 0 "" 7 --interval 1)"
check "and nothing is watched" "0" "$(grep -c -e '--watch' "$CW/gh-calls")"
# Merged: the same watch follows the push run of the merge commit on the base branch.
HM=cccc3333dddd4444eeee5555ffff6666aaaa1111
check "merged then green on the base branch: exit 0" "ci-watch: base-green 7 $HM|0" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI" cw "OPEN $HA\nMERGED $HA" "2" 0 "" 7 --interval 1)"
# Two lists: the one that finds the run, and the one after its watch that finds nothing new.
check "the push runs are read on the base branch at the merge commit" "2|2|1" \
  "$(grep -c '^run list' "$CW/gh-calls")|$(grep -c "^run list --branch main --commit $HM --event push" "$CW/gh-calls")|$(grep -c '^run watch 101 --exit-status' "$CW/gh-calls")"
check "the run watch's output never reaches stdout, it lands in a log file" "1|0" \
  "$(grep -rl RUN-WATCH-MARKER "$CWS" 2>/dev/null | wc -l | tr -d ' ')|$(CW_MERGE="$HM main" CW_RUNS="101:CI" cw "MERGED $HA" "2" 0 "" 7 --interval 1 | grep -c RUN-WATCH-MARKER)"
check "already merged at the first read: the base branch is followed, the checks never watched" "ci-watch: base-green 7 $HM|0|0" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI" cw "MERGED $HA" "2" 0 "" 7 --interval 1)|$(grep -c -e '--watch' "$CW/gh-calls")"
check "merged then red: the run and its failing jobs on the line, exit 6" "ci-watch: base-red 7 $HM 101 test, lint|6" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI" CW_RUN_CODES="101 1" CW_JOBS="build:success\ntest:failure\ndocs:skipped\nlint:failure" cw "OPEN $HA\nMERGED $HA" "2" 0 "" 7 --interval 1)"
check "merged with no push run within the bound: exit 7, none filtered out" "ci-watch: base-no-run 7 $HM filtered=0|7" \
  "$(CW_BASE_WAIT=1 CW_MERGE="$HM main" CW_RUNS="-" cw "MERGED $HA" "2" 0 "" 7 --interval 1)"
# A misnamed workflow: every push run is left out, and the line says how many, each run once.
check "a filter that matches nothing says how many runs it left out" "ci-watch: base-no-run 7 $HM filtered=2|7" \
  "$(CW_BASE_WAIT=1 CW_MERGE="$HM main" CW_RUNS="101:CI;102:Slow" cw "MERGED $HA" "2" 0 "" 7 --base-workflow Ci --interval 1)"
check "a push run registered after the first read is waited for" "ci-watch: base-green 7 $HM|0" \
  "$(CW_MERGE="$HM main" CW_RUNS="-\n101:CI" cw "MERGED $HA" "2" 0 "" 7 --interval 1)"
check "a run registered while another was watched is watched too" "ci-watch: base-red 7 $HM 102 e2e|6" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI\n101:CI;102:Slow" CW_RUN_CODES="102 1" CW_JOBS="unit:success\ne2e:failure" cw "MERGED $HA" "2" 0 "" 7 --interval 1)"
check "every push run is followed when no workflow is named" "ci-watch: base-red 7 $HM 102 e2e|6" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI;102:Slow" CW_RUN_CODES="102 1" CW_JOBS="unit:success\ne2e:failure" cw "MERGED $HA" "2" 0 "" 7 --interval 1)"
# A base run cancelled by the branch's concurrency, for a newer push, is not a red: the newest
# push run of the same workflow on that branch is followed instead, and reported with its sha.
HN=dddd4444eeee5555ffff6666aaaa1111bbbb2222
HO=eeee5555ffff6666aaaa1111bbbb2222cccc3333
check "a cancelled base run is not a red: the newer run is followed, green with its own sha" "ci-watch: base-green 7 $HN|0" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI" CW_RUN_CODES="101 1 cancelled" CW_NEWEST="103 $HN" cw "MERGED $HA" "2" 0 "" 7 --interval 1)"
check "the newer run is read for the same workflow on the base branch, and watched" "1|1" \
  "$(grep -c '^run list --branch main --workflow CI --event push' "$CW/gh-calls")|$(grep -c '^run watch 103 --exit-status' "$CW/gh-calls")"
check "the newer run red: its run, its sha and its failing jobs on the line" "ci-watch: base-red 7 $HN 103 test|6" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI" CW_RUN_CODES="101 1 cancelled\n103 1" CW_JOBS="build:success\ntest:failure" CW_NEWEST="103 $HN" cw "MERGED $HA" "2" 0 "" 7 --interval 1)"
check "a newer run cancelled in turn is followed on to the next" "ci-watch: base-green 7 $HO|0" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI" CW_RUN_CODES="101 1 cancelled\n103 1 cancelled" CW_NEWEST="103 $HN\n104 $HO" cw "MERGED $HA" "2" 0 "" 7 --interval 1)"
check "a cancelled run with no newer one is reported red, its cancelled jobs named" "ci-watch: base-red 7 $HM 101 test|6" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI" CW_RUN_CODES="101 1 cancelled" CW_JOBS="build:success\ntest:cancelled" CW_NEWEST="101 $HM" cw "MERGED $HA" "2" 0 "" 7 --interval 1)"
check "a run red at the merge commit keeps its sha when another run was replaced" "ci-watch: base-red 7 $HM 102 test|6" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI;102:Slow" CW_RUN_CODES="101 1 cancelled\n102 1" CW_JOBS="test:failure" CW_NEWEST="103 $HN" cw "MERGED $HA" "2" 0 "" 7 --interval 1)"
check "the repository is passed on to every gh call that follows a cancelled run" "0" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI" CW_RUN_CODES="101 1 cancelled" CW_NEWEST="103 $HN" cw "MERGED $HA" "2" 0 "" 7 --repo o/r --interval 1 >/dev/null; grep -vc -e '-R o/r' "$CW/gh-calls")"
check "a named workflow filters out another" "ci-watch: base-green 7 $HM|0" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI;102:Slow" CW_RUN_CODES="102 1" CW_JOBS="unit:success\ne2e:failure" cw "MERGED $HA" "2" 0 "" 7 --base-workflow CI --interval 1)"
check "and the other run is never watched" "0" "$(grep -c '^run watch 102' "$CW/gh-calls")"
check "the workflows can be named in the environment, comma-separated" "ci-watch: base-green 7 $HM|0" \
  "$(CW_BASE_WORKFLOWS="Lint,CI" CW_MERGE="$HM main" CW_RUNS="101:CI;102:Slow" CW_RUN_CODES="102 1" CW_JOBS="unit:success\ne2e:failure" cw "MERGED $HA" "2" 0 "" 7 --interval 1)"
check "a workflow name can be repeated on the command line" "ci-watch: base-red 7 $HM 102 e2e|6" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI;102:Slow" CW_RUN_CODES="102 1" CW_JOBS="unit:success\ne2e:failure" cw "MERGED $HA" "2" 0 "" 7 --base-workflow Slow --base-workflow CI --interval 1)"
# Green with auto-merge enabled: the merge is coming, so the watch waits for it and follows the
# base branch, instead of ending on a green nobody re-arms after.
check "green with auto-merge: the merge is waited for, then the base branch followed" "ci-watch: base-green 7 $HM|0" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI" cw "OPEN $HA\nOPEN $HA auto\nOPEN $HA auto\nMERGED $HA" "2" 0 "" 7 --interval 1)"
check "auto-merge is read with the state, once per interval until the merge" "4" "$(grep -c '^pr view 7 --json state,headRefOid,autoMergeRequest' "$CW/gh-calls")"
check "green with auto-merge, then red on the base branch: exit 6" "ci-watch: base-red 7 $HM 101 test|6" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI" CW_RUN_CODES="101 1" CW_JOBS="test:failure" cw "OPEN $HA\nOPEN $HA auto\nMERGED $HA" "2" 0 "" 7 --interval 1)"
check "green with auto-merge, not merged within the bound: green, exit 0" "ci-watch: green 7 $HA|0" \
  "$(CW_MERGE_WAIT=1 cw "OPEN $HA\nOPEN $HA auto" "2" 0 "" 7 --interval 1)"
check "green with auto-merge, then the head moves: exit 3" "ci-watch: moved 7 $HA $HB|3" \
  "$(cw "OPEN $HA\nOPEN $HA auto\nOPEN $HB auto" "2" 0 "" 7 --interval 1)"
check "green with auto-merge, then closed without merge: exit 4" "ci-watch: closed 7 CLOSED|4" \
  "$(cw "OPEN $HA\nOPEN $HA auto\nCLOSED $HA" "2" 0 "" 7 --interval 1)"
check "green with auto-merge, then auto-merge disabled: green, exit 0" "ci-watch: green 7 $HA|0" \
  "$(cw "OPEN $HA\nOPEN $HA auto\nOPEN $HA" "2" 0 "" 7 --interval 1)"
check "green with auto-merge and --no-base: green at once, the merge not waited for" "ci-watch: green 7 $HA|0|2" \
  "$(cw "OPEN $HA\nOPEN $HA auto\nMERGED $HA" "2" 0 "" 7 --no-base --interval 1)|$(grep -c '^pr view' "$CW/gh-calls")"
check "--no-base: merged exits at once, exit 4" "ci-watch: closed 7 MERGED|4" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI" cw "OPEN $HA\nMERGED $HA" "2" 0 "" 7 --no-base --interval 1)"
check "and no base branch run is looked for" "0" "$(grep -c '^run ' "$CW/gh-calls")"
check "unread: the merge commit cannot be read, exit 5" "ci-watch: unread 7 gh pr view failed: gh: HTTP 404|5" \
  "$(cw "MERGED $HA" "2" 0 "" 7 --interval 1)"
check "unread: the base branch's runs cannot be read, exit 5" "ci-watch: unread 7 gh run list failed: gh: HTTP 502|5" \
  "$(CW_MERGE="$HM main" cw "MERGED $HA" "2" 0 "" 7 --interval 1)"
check "unread: a red run with no failing job named, exit 5" "5" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI" CW_RUN_CODES="101 1" cw "MERGED $HA" "2" 0 "" 7 --interval 1 | sed 's/.*|//')"
check "unread: the pull request cannot be read, exit 5" "ci-watch: unread 7 gh pr view failed: gh: HTTP 502|5" \
  "$(cw "" "2" 0 "" 7 --interval 1)"
check "unread: the registration read fails, exit 5" "ci-watch: unread 7 gh pr checks failed: error connecting to api.github.com|5" \
  "$(cw "OPEN $HA" "fail" 0 "" 7 --interval 1)"
check "unread: the watch fails with no failing check named, exit 5" "5" \
  "$(cw "OPEN $HA" "2" 4 "" 7 --interval 1 | sed 's/.*|//')"
check "the repository is passed on to every gh call" "0" \
  "$(cw "OPEN $HA" "2" 0 "" 7 --repo o/r --interval 1 >/dev/null; grep -vc -e '-R o/r' "$CW/gh-calls")"
check "the repository is passed on to every gh call of the base branch's follow" "0" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI" cw "MERGED $HA" "2" 0 "" 7 --repo o/r --interval 1 >/dev/null; grep -vc -e '-R o/r' "$CW/gh-calls")"
check "the interval is passed on to the watch" "1" \
  "$(cw "OPEN $HA" "2" 0 "" 7 --interval 3 >/dev/null; grep -c -e '--watch --fail-fast --interval 3' "$CW/gh-calls")"
check "no loop on gh pr view: two reads in all, before and after the watch" "2" \
  "$(cw "OPEN $HA" "2" 0 "" 7 --interval 1 >/dev/null; grep -c '^pr view' "$CW/gh-calls")"
check "without a pull request number: exit 5" "5" "$(cw "OPEN $HA" "2" 0 "" | sed 's/.*|//')"
check "an unknown argument: exit 5" "5" "$(cw "OPEN $HA" "2" 0 "" 7 --bogus | sed 's/.*|//')"

echo "== stop gate hook =="
# An orchestrator's stop is held until something will wake it (Check 1) and until the real
# state of its open pull requests' checks has been put in front of it once per head
# (Check 2). The hook is run from a tree of its own, beside a fake launcher whose `list`
# prints the listing file and a fake `workspace.sh list` printing the checkouts file; a
# fake `gh` on PATH answers from files and records each `pr checks` call.
SG="$WORK/stop-gate"
# The hook spells its own path normalised; the suite's temporary directory may end in a slash.
SGW="$(printf '%s' "$SG" | sed 's|//|/|g')/skills/orchestrator/scripts/ci-watch.sh"
SGB="$SG/bin"; SGS="$SG/state"; SGP="$SG/sgproj"
mkdir -p "$SG/hooks" "$SG/skills/iterm-agents/scripts" "$SG/skills/orchestrator/scripts" "$SGB" "$SGS/chains" "$SGP"
cp "$ROOT/hooks/stop-gate.sh" "$ROOT/hooks/stop_gate.py" "$ROOT/hooks/session_name.py" "$SG/hooks/" 2>/dev/null
cp "$ROOT/skills/iterm-agents/scripts/iterm_agent.py" "$SG/skills/iterm-agents/scripts/"
printf '#!/bin/bash\n[ "$1" = list ] || exit 1\ncat "%s/listing" 2>/dev/null || { echo "list: no terminal backend could serve this" >&2; exit 1; }\n' "$SG" \
  > "$SG/skills/iterm-agents/scripts/iterm-agent.sh"
# `sweep` records its arguments and answers from files: its lines, its stderr, its exit
# code, and a sleep to be killed in.
cat > "$SG/skills/orchestrator/scripts/workspace.sh" <<EOF
#!/bin/bash
case "\$1" in
  list) cat "$SG/checkouts" 2>/dev/null || { echo "workspace: cannot read the root" >&2; exit 1; } ;;
  sweep) echo "\$*" >> "$SG/sweep-args"
         [ -f "$SG/sweep-sleep" ] && sleep "\$(cat "$SG/sweep-sleep")"
         cat "$SG/sweep-out" 2>/dev/null
         [ -f "$SG/sweep-err" ] && cat "$SG/sweep-err" >&2
         exit "\$(cat "$SG/sweep-code" 2>/dev/null || echo 0)" ;;
  *) exit 1 ;;
esac
EOF
cat > "$SGB/gh" <<EOF
#!/bin/bash
[ -f "$SG/gh-offline" ] && { echo "error connecting to api.github.com" >&2; exit 1; }
case "\$1 \$2" in
  "pr list") echo "\$*" >> "$SG/gh-args"; cat "$SG/prs" 2>/dev/null || echo "[]" ;;
  "pr checks") echo "\$3" >> "$SG/gh-calls"; cat "$SG/checks-\$3"; [ -f "$SG/checks-\$3.code" ] && exit "\$(cat "$SG/checks-\$3.code")" ;;
  "pr view") echo "\$3" >> "$SG/gh-views"; [ -f "$SG/view-sleep" ] && sleep "\$(cat "$SG/view-sleep")"
             cat "$SG/view-\${3//\//_}" 2>/dev/null || { echo "no pull requests found for branch \\"\$3\\"" >&2; exit 1; } ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$SGB/gh" "$SG/skills/iterm-agents/scripts/iterm-agent.sh" "$SG/skills/orchestrator/scripts/workspace.sh"
# The one process-table read of check 2 (`ps -axo command`) answers from a file and counts
# its calls; every other `ps` is the real one. Made where check 2 starts: a case of check 1
# replaces and removes the `ps` of the suite.
sg_fake_ps() {
cat > "$SGB/ps" <<EOF
#!/bin/bash
if [ "\$*" = "-axo command" ]; then
  echo x >> "$SG/ps-calls"
  [ -f "$SG/ps-fail" ] && { echo "ps: operation not permitted" >&2; exit 1; }
  cat "$SG/ps-live" 2>/dev/null
  exit 0
fi
exec /bin/ps "\$@"
EOF
chmod +x "$SGB/ps"
}
git -C "$SGP" init -q 2>/dev/null

ORCHROW='w1/t1 | /dev/ttys900 | ✳ Orch : f | Orch : f [a1b2c3] | self'
sg_listing() { printf '%s\n' "$ORCHROW" "$@" > "$SG/listing"; }
sg_chain() {  # <tty> <owner> ...: the chain of the orchestrator's tty, in launch order
  : > "$SGS/chains/ttys900.jsonl"
  while [ $# -gt 0 ]; do
    printf '{"tab_id": "t-%s", "tty": "%s", "owner": "%s"}\n' "${1##*/}" "$1" "$2" >> "$SGS/chains/ttys900.jsonl"
    shift 2
  done
}
# The session's name is read from the process table the way the launcher reads it (`--name`):
# the suite's stand-in for `ps` is a file, and the session's own tty is given.
sg_ps() { printf '/dev/ttys900 host-cli %s\n' "$1" > "$SG/ps"; }
sg_reset() { rm -f "$SG/prs" "$SG/gh-views" "$SG/cwds" "$SG"/view-* "$SG/gh-calls" "$SG/gh-args" "$SG/gh-offline" "$SG"/checks-* "$SG/transcript" "$SGS/stop-gate.log" "$SG/ps-live" "$SG/ps-calls" "$SG/ps-fail"; rm -rf "$SGS/stop-gate" "$SGS/records"; rm -f "$SG"/sweep-* "$SGS/sweep.stamp"; : > "$SG/checkouts"; sg_ps '--name Orch : f [a1b2c3]'; sg_listing; sg_chain; }
# sg <message> [stop_hook_active] [session id]: the hook's stdout. SG_TRANSCRIPT names the
# payload's transcript, SG_ITERM stands in for ITERM_SESSION_ID, SG_DEADLINE for the hook's.
sg() {
  "$py" -c 'import json,sys; d={"session_id": sys.argv[4], "cwd": sys.argv[1], "last_assistant_message": sys.argv[2], "stop_hook_active": sys.argv[3] == "true"}
if sys.argv[5]: d["transcript_path"] = sys.argv[5]
json.dump(d, sys.stdout)' \
    "$SGP" "$1" "${2:-false}" "${3:-sg-1}" "${SG_TRANSCRIPT:-}" \
    | env PATH="$SGB:$PATH" ORCHESTRATOR_STATE_DIR="$SGS" ITERM_SESSION_ID="${SG_ITERM-w0t0p0:S-ME}" \
        ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_PS_TABLE="$SG/ps" ORCHESTRATOR_CWD_TABLE="$SG/cwds" \
        ORCHESTRATOR_STOP_GATE_DEADLINE="${SG_DEADLINE:-20}" bash "$SG/hooks/stop-gate.sh" 2>/dev/null
}
reason() { "$py" -c 'import json,sys; d=json.load(sys.stdin); print(d["decision"] + "|" + d["reason"])' 2>/dev/null; }
sglog() { cat "$SGS/stop-gate.log" 2>/dev/null; }
BUSY='w1/t2 | /dev/ttys901 | ◐ Agent : one | Agent : one [b2c3d4]'
IDLE='w1/t2 | /dev/ttys901 | ✳ Agent : one | Agent : one [b2c3d4]'

echo "-- check 1: what will wake you"
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
check "a busy agent of this orchestrator lets the stop pass, silently" "" "$(sg 'I launched the phase.')"
check "a stop that passes writes nothing to the log" "" "$(sglog)"
sg_reset; sg_listing "$BUSY" 'w1/t3 | /dev/ttys902 | ✳ Agent : two | Agent : two [c3d4e5]'
sg_chain /dev/ttys902 S-ME /dev/ttys901 S-ME
check "one busy agent among idle ones suffices" "" "$(sg 'Waiting on agent one.')"

sg_reset
check "no agent and no machine line: refused, nothing will wake you" \
  "block|Nothing will wake you: no agent of yours is running. Launch what you announced, or, if a question truly blocks, end with the line waiting: operator — blocks: <what it blocks>, or with waiting: done. The line goes as the message's last line, no markup." \
  "$(sg 'I am launching the phase 3 agent now.' | reason)"
check "the refusal is logged: session name, check, case" "1" \
  "$(sglog | grep -c '| Orch : f \[a1b2c3\] | check1 | nothing-will-wake$')"
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-OTHER
check "a busy agent of another orchestrator is never counted" "block|Nothing will wake you" \
  "$(sg 'Waiting.' | reason | cut -c1-27)"
sg_reset; sg_chain /dev/ttys905 S-ME
check "a chain entry whose tab is gone is no agent" "block|Nothing will wake you" "$(sg 'Waiting.' | reason | cut -c1-27)"
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
check "without ITERM_SESSION_ID no chain entry is counted: the busy agent does not hold the stop" "block|Nothing will wake you" \
  "$(SG_ITERM= sg 'Waiting.' | reason | cut -c1-27)"
check "and the log says why" "1" "$(sglog | grep -c '| Orch : f \[a1b2c3\] | error | ITERM_SESSION_ID is not set: no chain entry is counted$')"
sg_reset; sg_listing 'w1/t2 | /dev/ttys901 | -zsh | (host default)'; sg_chain /dev/ttys901 S-ME
check "a tab with no activity glyph runs no agent" "block|Nothing will wake you" "$(sg 'Waiting.' | reason | cut -c1-27)"

sg_reset; sg_listing "$IDLE"; sg_chain /dev/ttys901 S-ME
check "only idle agents: refused, the agent named" \
  "block|Agent : one [b2c3d4] is idle: its notice was spent. Read its report or relaunch it." \
  "$(sg 'Waiting on agent one.' | reason)"
check "the idle refusal is logged" "1" "$(sglog | grep -c '| check1 | idle-agents$')"
# A resident agent (spawned with --resident) is idle by design while its background command
# waits: never an agent to read or relaunch. Today's refusal holds for the same agent unmarked.
sg_reset; sg_listing "$IDLE"
printf '{"tab_id": "t-ttys901", "tty": "/dev/ttys901", "owner": "S-ME", "resident": true}\n' > "$SGS/chains/ttys900.jsonl"
check "a resident idle agent and nothing else: the stop passes" "" "$(sg 'Waiting on agent one.')"
# It lifts the last fallback only: another idle agent beside it is still refused.
sg_reset; sg_listing "$IDLE" 'w1/t3 | /dev/ttys902 | ✳ Agent : two | Agent : two [c3d4e5]'
printf '{"tab_id": "t-ttys901", "tty": "/dev/ttys901", "owner": "S-ME", "resident": true}\n{"tab_id": "t-ttys902", "tty": "/dev/ttys902", "owner": "S-ME"}\n' > "$SGS/chains/ttys900.jsonl"
check "a resident idle agent beside another idle agent: refused on the other one" \
  "block|Agent : two [c3d4e5] is idle: its notice was spent. Read its report or relaunch it." \
  "$(sg 'Waiting on agent two.' | reason)"
sg_reset; sg_listing "$IDLE"
printf '{"tab_id": "t-ttys901", "tty": "/dev/ttys901", "owner": "S-ME", "resident": false}\n' > "$SGS/chains/ttys900.jsonl"
check "the same agent not resident: refused as before" \
  "block|Agent : one [b2c3d4] is idle: its notice was spent. Read its report or relaunch it." \
  "$(sg 'Waiting on agent one.' | reason)"

# An own agent idle with its pull request OPEN or MERGED has delivered: nothing will wake the
# orchestrator for it and its tab is only left behind. The refusal reads the agent's branch
# (its tab's process working directory, that checkout's branch) and asks `gh pr view` once.
SGA="$SG/agent-checkout"; rm -rf "$SGA"; mkdir -p "$SGA"; git -C "$SGA" init -q 2>/dev/null; git -C "$SGA" symbolic-ref HEAD refs/heads/feat/one
IDLE2='w1/t3 | /dev/ttys902 | ✳ Agent : two | Agent : two [c3d4e5]'
sg_idle_pr() {  # <state> [number]: agent one idle, its checkout on feat/one, its pull request in <state>
  sg_reset; sg_listing "$IDLE"; sg_chain /dev/ttys901 S-ME
  printf '/dev/ttys901 %s\n' "$SGA" > "$SG/cwds"
  printf '{"number": %s, "state": "%s"}\n' "${2:-12}" "$1" > "$SG/view-feat_one"
}
sg_idle_pr OPEN
check "an idle agent with its pull request open: refused, agent and pull request named" \
  "block|Idle with its pull request open or merged: Agent : one [b2c3d4] (pull request #12, OPEN). Stand it down now — or, if it waits on a question you have not answered, answer it." \
  "$(sg 'Waiting on agent one.' | reason)"
check "the refusal is logged" "1" "$(sglog | grep -c '| check1 | idle-delivered$')"
sg_idle_pr MERGED 13
check "an idle agent with its pull request merged: refused" "block|Idle with its pull request open or merged: Agent : one [b2c3d4] (pull request #13, MERGED). Stand it down now — or, if it waits on a question you have not answered, answer it." \
  "$(sg 'Waiting on agent one.' | reason)"
sg_idle_pr OPEN
check "a machine line declaring a block does not lift it" "block|Idle with its pull request open or merged" \
  "$(sg 'Which base?

waiting: operator — blocks: the base' | reason | cut -c1-47)"
check "waiting: done does not lift it" "block|Idle with its pull request open or merged" "$(sg 'All done.

waiting: done' | reason | cut -c1-47)"
sg_idle_pr OPEN; sg_listing "$IDLE" 'w1/t3 | /dev/ttys902 | ◐ Agent : two | Agent : two [c3d4e5]'; sg_chain /dev/ttys901 S-ME /dev/ttys902 S-ME
check "a busy agent beside it does not lift it" "block|Idle with its pull request open or merged" "$(sg 'Waiting on agent two.' | reason | cut -c1-47)"
check "and the busy one costs no read" "1" "$(wc -l < "$SG/gh-views" | tr -d ' ')"
sg_idle_pr CLOSED
check "an idle agent with its pull request closed keeps today's refusal" "block|Agent : one [b2c3d4] is idle: its notice was spent. Read its report or relaunch it." \
  "$(sg 'Waiting on agent one.' | reason)"
sg_idle_pr OPEN; rm -f "$SG/view-feat_one"
check "an idle agent with no pull request keeps today's refusal" "block|Agent : one [b2c3d4] is idle: its notice was spent. Read its report or relaunch it." \
  "$(sg 'Waiting on agent one.' | reason)"
sg_idle_pr OPEN; rm -f "$SG/cwds"
check "an idle agent whose working directory cannot be read keeps today's refusal" "block|Agent : one [b2c3d4] is idle: its notice was spent. Read its report or relaunch it." \
  "$(sg 'Waiting on agent one.' | reason)"
check "and no gh call was made for it" "0" "$(cat "$SG/gh-views" 2>/dev/null | wc -l | tr -d ' ')"
sg_idle_pr OPEN; printf 'not json\n' > "$SG/view-feat_one"
check "a read that fails to parse counts as no pull request" "block|Agent : one [b2c3d4] is idle: its notice was spent. Read its report or relaunch it." \
  "$(sg 'Waiting on agent one.' | reason)"
sg_idle_pr OPEN; sg_listing "$IDLE" "$IDLE2"; sg_chain /dev/ttys901 S-ME /dev/ttys902 S-ME
printf '/dev/ttys901 %s\n/dev/ttys902 %s\n' "$SGA" "$SGA" > "$SG/cwds"; printf '2\n' > "$SG/view-sleep"
check "a read past the deadline counts as no pull request, never a crash: only the agent read in time is named" \
  "block|Idle with its pull request open or merged: Agent : one [b2c3d4] (pull request #12, OPEN). Stand it down now — or, if it waits on a question you have not answered, answer it.|1" \
  "$(SG_DEADLINE=1 sg 'Waiting.' | reason)|$(wc -l < "$SG/gh-views" | tr -d ' ')"
check "and the late read is a log line" "1" "$(sglog | grep -c '| error | pull request of /dev/ttys902 unread: the overall deadline of 1s passed before the launcher'"'"'s reads$')"
# With the deadline already passed, `pull_request_of` reads nothing: not the launcher's process
# table and working directory (`host_cli_cwd`, its own calls), not git, not gh.
check "a passed deadline: no launcher read, no gh call, one log line, no pull request" "None|0|0|1" \
  "$(ORCHESTRATOR_STATE_DIR="$SGS" "$py" -c "
import sys, time; sys.path.insert(0, '$SG/hooks'); sys.path.insert(0, '$SG/skills/iterm-agents/scripts')
import stop_gate as g
reads = dict(launcher=0, run=0)
class L:
    def host_cli_cwd(self, tty): reads['launcher'] += 1; return '/'
g.launcher = lambda: L()
def fake_run(*a, **k): reads['run'] += 1; return '', '', 1
g.run = fake_run
logged = []
g.log = lambda *f: logged.append(f)
g.STARTED = time.monotonic() - 1000
print(g.pull_request_of('/dev/ttys901', 'w'), reads['launcher'], reads['run'], len(logged), sep='|')")"
sg_idle_pr OPEN; sg_listing "$IDLE" "$IDLE2"; sg_chain /dev/ttys901 S-ME /dev/ttys902 S-ME
printf '/dev/ttys901 %s\n/dev/ttys902 %s\n' "$SGA" "$SGA" > "$SG/cwds"
check "two idle agents: one read each, both named" "block|Idle with its pull request open or merged: Agent : one [b2c3d4] (pull request #12, OPEN), Agent : two [c3d4e5] (pull request #12, OPEN). Stand it down now — or, if it waits on a question you have not answered, answer it.|2" \
  "$(sg 'Waiting.' | reason)|$(wc -l < "$SG/gh-views" | tr -d ' ')"

sg_reset
check "a question with no blocks: refused" \
  "block|Your question blocks nothing declared: advance everything that can advance; its answer will come in a later turn." \
  "$(sg 'Should I merge #12 now?' | reason)"
check "a machine line naming the operator without blocks: is a question that blocks nothing" \
  "block|Your question blocks nothing declared" "$(sg 'Merge #12?
waiting: operator' | reason | cut -c1-43)"
check "the question refusal is logged" "2" "$(sglog | grep -c '| check1 | question-without-blocks$')"

sg_reset; printf '/ws/sgproj/phase-4 | feat/p4 | abc1234 | clean | pushed\n' > "$SG/checkouts"
check "a blocking question with its machine line lets the stop pass, silently, a phase in flight or not" "" \
  "$(sg 'Which base for phase 4, main or the release branch?

waiting: operator — blocks: the base of phase 4

')"
check "the blocks: stop is logged with its reason" "1" \
  "$(sglog | grep -c '| Orch : f \[a1b2c3\] | check1 | blocks | the base of phase 4$')"
check "a question followed by a fenced block, then the machine line, lets the stop pass" "" \
  "$(sg 'Which base for phase 4?

```
git log --oneline -1 origin/main
```

waiting: operator — blocks: the base of phase 4')"
check "a machine line that is not the last non-empty line does not count" "block|Your question blocks nothing declared" \
  "$(sg 'waiting: operator — blocks: the base
Which base?' | reason | cut -c1-43)"
check "a blocks: line with nothing after it does not count" "block|Your question blocks nothing declared" \
  "$(sg 'waiting: operator — blocks: ' | reason | cut -c1-43)"

# The model writes the line the way it writes everything: with markup, a dash of its own
# choosing, an indent. Matched after normalisation, one check per variant the review listed.
sg_variant() {  # <name> <last line>
  sg_reset
  check "the machine line $1 lets the stop pass" "" "$(sg "$(printf 'Which base?\n\n%s' "$2")")"
}
sg_variant "in backticks" '`waiting: operator — blocks: the base`'
sg_variant "in bold" '**waiting: operator — blocks: the base**'
sg_variant "in italics" '_waiting: operator — blocks: the base_'
sg_variant "capitalised" 'Waiting: operator — blocks: the base'
sg_variant "indented" '    waiting: operator — blocks: the base'
sg_variant "quoted" '> waiting: operator — blocks: the base'
sg_variant "as a dash bullet" '- waiting: operator — blocks: the base'
sg_variant "as a star bullet" '* waiting: operator — blocks: the base'
sg_variant "with a hyphen" 'waiting: operator - blocks: the base'
sg_variant "with an en dash" 'waiting: operator – blocks: the base'
sg_variant "with a double dash" 'waiting: operator -- blocks: the base'
sg_variant "with a spaceless dash" 'waiting: operator—blocks: the base'
sg_variant "with doubled spaces" 'waiting:  operator  —  blocks:  the base'
sg_variant "with no space after blocks:" 'waiting: operator — blocks:phase 4'
sg_variant "ending on a period" 'waiting: operator — blocks: the base.'
sg_reset
check "a done line ending on a period lets the stop pass" "" "$(sg 'All merged.
waiting: done.')"
check "a done line in bold lets the stop pass" "" "$(sg '**Waiting: done**')"
sg_reset
check "a hyphen inside the reason is kept: the line is read once" "1" \
  "$(sg 'Which?
waiting: operator - blocks: the pre-merge review' >/dev/null; sglog | grep -c '| check1 | blocks | the pre-merge review$')"
check "a line that declares blocks: but is not the machine line is told the form, never « blocks nothing declared »" \
  "block|Your last line is not the machine line: end the message with the line waiting: operator — blocks: <what it blocks>, or with waiting: done, as the message's last line, no markup." \
  "$(sg 'Which base?
waiting: operator blocks: the base' | reason)"
check "and it is logged under its own case" "1" "$(sglog | grep -c '| check1 | malformed-machine-line$')"

sg_reset
check "done, no checkout, no agent: the stop passes, silently" "" "$(sg 'All merged.
waiting: done')"
check "a done stop writes no log line" "" "$(sglog)"
sg_reset; printf '/ws/sgproj/phase-4 | feat/p4 | abc1234 | clean | pushed\n/ws/other/x | main | def5678 | clean | pushed\n' > "$SG/checkouts"
check "done against a checkout of the project: refused, the checkout named" \
  "block|Not done: /ws/sgproj/phase-4 is still there. Finish it, or say what blocks it." \
  "$(sg 'waiting: done' | reason)"
check "the not-done refusal is logged" "1" "$(sglog | grep -c '| check1 | not-done$')"
sg_reset; printf '/ws/other/x | main | def5678 | clean | pushed\n' > "$SG/checkouts"
check "a checkout of another project does not hold done" "" "$(sg 'waiting: done')"
sg_reset; sg_listing "$IDLE"; sg_chain /dev/ttys901 S-ME
check "done against an agent still there: refused, the agent named" \
  "block|Not done: Agent : one [b2c3d4] is still there. Finish it, or say what blocks it." \
  "$(sg 'waiting: done' | reason)"

# Deferred work: an order noted « to plan after the round » in prose only is lost. Every
# dispatch-record command registers its record under the session; a `done` stop refuses
# while a row of those records is open.
SGREC="$SG/dispatch.jsonl"
sg_rec() { CLAUDE_CODE_SESSION_ID=sg-1 ORCHESTRATOR_STATE_DIR="$SGS" bash "$ROOT/skills/orchestrator/scripts/dispatch-record.sh" "$@"; }
sg_reset; rm -f "$SGREC"
rowA=$(sg_rec open "$SGREC" --class behaviour-phase --tier standard --label "plan the docs round")
check "done against an open dispatch-record row: refused, the row named" \
  "block|Not done: row 1 (plan the docs round) is open. Dispatch it, close it, or say what blocks it." \
  "$(sg 'waiting: done' | reason)"
check "the open-row refusal is logged" "1" "$(sglog | grep -c '| check1 | not-done$')"
rowB=$(sg_rec open "$SGREC" --class n-bis --tier light --label "second fix")
check "several open rows: the plural form" \
  "block|Not done: rows 1 (plan the docs round), 2 (second fix) are open. Dispatch them, close them, or say what blocks them." \
  "$(sg 'waiting: done' | reason)"
sg_rec close "$SGREC" 1 --verdict ruled-out >/dev/null
check "a closed row is no longer held against done" \
  "block|Not done: row 2 (second fix) is open. Dispatch it, close it, or say what blocks it." \
  "$(sg 'waiting: done' | reason)"
sg_rec close "$SGREC" 2 --verdict approved >/dev/null
check "every row closed: done passes" "" "$(sg 'waiting: done')"
sg_rec open "$SGREC" --class n-bis --tier light --label "third" >/dev/null
check "another session's records are not read" "" "$(sg 'waiting: done' false sg-other)"
rm -rf "$SGS/records"
check "no records file: no rows" "" "$(sg 'waiting: done')"
sg_reset; mkdir -p "$SGS/records"; printf '/nowhere/dispatch.jsonl\n' > "$SGS/records/sg-1"
check "a registered record that is gone: no rows" "" "$(sg 'waiting: done')"
sg_reset; rm -f "$SGREC"; sg_rec open "$SGREC" --class n-bis --tier light --label "left open" >/dev/null
sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
check "open rows hold done only: a busy agent still lets the stop pass" "" "$(sg 'Waiting on the agent.')"
sg_reset; rm -f "$SGREC"; sg_rec open "$SGREC" --class n-bis --tier light --label "left open" >/dev/null; printf '/ws/sgproj/phase-4 | feat/p4 | abc1234 | clean | pushed\n' > "$SG/checkouts"
check "a checkout and an open row: both are said" \
  "block|Not done: /ws/sgproj/phase-4 is still there. Finish it, or say what blocks it. Not done: row 1 (left open) is open. Dispatch it, close it, or say what blocks it." \
  "$(sg 'waiting: done' | reason)"
sg_reset; rm -f "$SGREC"; sg_rec open "$SGREC" --class n-bis --tier light --label "left open" >/dev/null
sg_listing "$IDLE"
printf '{"tab_id": "t-ttys901", "tty": "/dev/ttys901", "owner": "S-ME", "resident": true}\n' > "$SGS/chains/ttys900.jsonl"
check "a resident idle agent does not lift done: the open row still refuses" \
  "block|Not done: row 1 (left open) is open. Dispatch it, close it, or say what blocks it." \
  "$(sg 'waiting: done' | reason)"
rm -f "$SGREC"

echo "-- scope, loop guard, own failures"
sg_reset
check "the loop guard: a stop already refused once in this turn passes" "" "$(sg 'I am launching it.' true)"
sg_ps '--name Agent : one [b2c3d4]'
check "an agent's session is untouched" "" "$(sg 'I am launching it.')"
sg_ps '--name Coord : m [a1b2c3]'
check "the coordinator's session is untouched" "" "$(sg 'I am launching it.')"
check "an untouched session writes no log line" "" "$(sglog)"
# The listing is only read for an orchestrator: the scope is decided from the session's own
# tty and its name, before any call to the launcher.
rm -f "$SG/listing"
check "a session that is not an orchestrator never reads the listing: no error logged" "" "$(sg 'I am launching it.'; sglog)"
sg_reset
sg_ps ''
check "a session started by hand, without the name, is untouched" "" "$(sg 'I am launching it.')"
check "and the log says its name could not be read" "1|1" \
  "$(sglog | grep -c .)|$(sglog | grep -c "| sg-1 | error | the session's name cannot be read on /dev/ttys900$")"
sg_reset; : > "$SG/ps"
check "a tty the process table does not know is untouched, the name logged unreadable" "1" \
  "$(sg 'I am launching it.' >/dev/null; sglog | grep -c "| error | the session's name cannot be read on /dev/ttys900$")"
# The own tty comes from the launcher's walk; a `ps` that answers nothing gives none.
sg_reset; printf '#!/bin/bash\nexit 1\n' > "$SGB/ps"; chmod +x "$SGB/ps"
check "a session whose own tty cannot be read passes" "" \
  "$("$py" -c 'import json,sys; json.dump({"session_id": "sg-1", "cwd": sys.argv[1], "last_assistant_message": "x", "stop_hook_active": False}, sys.stdout)' "$SGP" \
    | env -u ORCHESTRATOR_SELF_TTY PATH="$SGB:$PATH" ORCHESTRATOR_STATE_DIR="$SGS" ITERM_SESSION_ID="w0t0p0:S-ME" bash "$SG/hooks/stop-gate.sh" 2>/dev/null)"
check "and the log says the tty could not be read" "1" "$(sglog | grep -c "| sg-1 | error | the session's own tty cannot be read$")"
rm -f "$SGB/ps"

echo "-- scope by the /rename name"
# The host writes the rename into the transcript as a `custom-title` entry, the value
# sometimes quoted. The launcher's `--name` comes first; the transcript's LAST entry only
# when the launcher gives none.
sg_reset; sg_ps ''
printf '%s\n' '{"type":"user","message":"hi"}' '{"type":"custom-title","customTitle":"Orch : f [a1b2c3]"}' '{"type":"assistant","message":"ok"}' > "$SG/transcript"
check "no launcher name, a renamed session: the transcript's title scopes the gate in" "block|Nothing will wake you" \
  "$(SG_TRANSCRIPT="$SG/transcript" sg 'I am launching it.' | reason | cut -c1-27)"
printf '%s\n' '{"type":"custom-title","customTitle":"\"Orch : f [a1b2c3]\""}' > "$SG/transcript"
check "a quoted title is unquoted" "block|Nothing will wake you" \
  "$(SG_TRANSCRIPT="$SG/transcript" sg 'I am launching it.' | reason | cut -c1-27)"
printf '%s\n' '{"type":"custom-title","customTitle":"Orch : f [a1b2c3]"}' '{"type":"custom-title","customTitle":"my scratch session"}' > "$SG/transcript"
check "the LAST title wins: renamed away from Orch, the session is untouched" "" \
  "$(SG_TRANSCRIPT="$SG/transcript" sg 'I am launching it.')"
printf '%s\n' '{"type":"custom-title","customTitle":"my scratch session"}' '{"type":"custom-title","customTitle":"Orch : f [a1b2c3]"}' > "$SG/transcript"
check "the LAST title wins: renamed to Orch, the session is gated" "block|Nothing will wake you" \
  "$(SG_TRANSCRIPT="$SG/transcript" sg 'I am launching it.' | reason | cut -c1-27)"
sg_ps '--name Agent : one [b2c3d4]'
check "the launcher's name comes first: an agent renamed to Orch stays untouched" "" \
  "$(SG_TRANSCRIPT="$SG/transcript" sg 'I am launching it.')"
sg_ps ''
check "a transcript with no title: untouched, the log says the name is unreadable" "" \
  "$(printf '%s\n' '{"type":"user"}' > "$SG/transcript"; SG_TRANSCRIPT="$SG/transcript" sg 'I am launching it.')"
check "a transcript that cannot be read is no title" "" "$(SG_TRANSCRIPT="$SG/absent" sg 'I am launching it.')"
# Not parsed whole: a line that is no JSON, elsewhere in the file, changes nothing.
printf '%s\n' 'not json at all {{{' '{"type":"custom-title","customTitle":"Orch : f [a1b2c3]"}' 'tail garbage ][' > "$SG/transcript"
check "only the title line is parsed: garbage around it is harmless" "block|Nothing will wake you" \
  "$(SG_TRANSCRIPT="$SG/transcript" sg 'I am launching it.' | reason | cut -c1-27)"
# A title line cut by a read block (64 KiB from the end) is still found whole.
"$py" - "$SG/transcript" <<'PYEOF'
import sys
title = b'{"type":"custom-title","customTitle":"Orch : f [a1b2c3]"}\n'
block = 65536
pad = block - len(title) // 2
open(sys.argv[1], "wb").write(b'{"type":"user"}\n' + title + b"x" * (pad - 1) + b"\n")
PYEOF
check "a title line straddling a read block is found whole" "block|Nothing will wake you" \
  "$(SG_TRANSCRIPT="$SG/transcript" sg 'I am launching it.' | reason | cut -c1-27)"
"$py" - "$SG/transcript" <<'PYEOF'
import sys
title = b'{"type":"custom-title","customTitle":"Orch : f [a1b2c3]"}\n'
open(sys.argv[1], "wb").write(title + (b'{"type":"user","message":"' + b"y" * 4000 + b'"}\n') * 100)
PYEOF
check "a title far from the end of a large transcript is found" "block|Nothing will wake you" \
  "$(SG_TRANSCRIPT="$SG/transcript" sg 'I am launching it.' | reason | cut -c1-27)"
sg_reset
sg_reset; rm -f "$SG/listing"
check "an unreadable listing lets the stop pass, exit 0" "|0" "$(sg 'I am launching it.'; echo "|$?")"
check "and appends one line to the log, naming the listing" "1|1" \
  "$(sglog | grep -c .)|$(sglog | grep -c "| Orch : f \[a1b2c3\] | error | the launcher's listing failed: list: no terminal backend could serve this$")"
sg_reset; rm -f "$SG/checkouts"
check "an unreadable checkout list lets a done stop pass" "" "$(sg 'waiting: done')"
check "and logs it" "1" "$(sglog | grep -c '| error | ')"

echo "-- check 2: the real CI state, once per head"
sg_fake_ps
# A head is recorded with its state: pending once a stop has refused it while pending, done
# once its checks have all finished. A pending head refuses once, and again only when a
# check turns red.
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
printf '[{"number": 12, "headRefOid": "abc1234def5678abc1234def5678abc1234def56"}]\n' > "$SG/prs"
printf '[{"name": "build", "bucket": "pending"}, {"name": "lint", "bucket": "pending"}, {"name": "test", "bucket": "pass"}]\n' > "$SG/checks-12"
echo 8 > "$SG/checks-12.code"
check "pending checks on a new head: refused with the real state" \
  "block|#12 at abc1234: 2 checks pending (build, lint), 0 failing (). Report this state as it is; to wait for the end, start \`$SGW 12\` with \`run_in_background\` (timeout 7200000), never in the foreground." \
  "$(sg 'The reds are fixed, CI is green.' | reason)"
check "the CI refusal is logged" "1" "$(sglog | grep -c '| check2 | ci-not-finished | #12 at abc1234')"
check "the pending head is recorded as pending" "12 abc1234def5678abc1234def5678abc1234def56 pending" "$(cat "$SGS/stop-gate/sg-1.heads" 2>/dev/null)"
check "a pending head already refused, nothing failing: the stop passes, silently" "" "$(sg 'The reds are fixed, CI is green.')"
check "and the checks are still read at each stop" "2" "$(grep -c . "$SG/gh-calls")"
check "and the head stays pending" "12 abc1234def5678abc1234def5678abc1234def56 pending" "$(cat "$SGS/stop-gate/sg-1.heads")"
check "another session is told once as well" "block|#12 at abc1234" "$(sg 'CI is green.' false sg-2 | reason | cut -c1-20)"
printf '[{"name": "build", "bucket": "pass"}, {"name": "lint", "bucket": "pass"}, {"name": "test", "bucket": "pass"}]\n' > "$SG/checks-12"
echo 0 > "$SG/checks-12.code"
check "pending, pending, then green: the stop passes" "" "$(sg 'CI is green.')"
check "and the finished head is recorded as done" "12 abc1234def5678abc1234def5678abc1234def56 done" "$(cat "$SGS/stop-gate/sg-1.heads")"
check "one refusal for this session, one for the other" "2" "$(sglog | grep -c '| check2 | ci-not-finished | #12 at abc1234')"

# A pending head with a `ci-watch.sh <n>` process alive is being waited for: it does not
# refuse the stop. One read of the process table serves every pull request of the check.
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
printf '[{"number": 12, "headRefOid": "abc1234def5678abc1234def5678abc1234def56"}, {"number": 13, "headRefOid": "1234abcd5678ef901234abcd5678ef901234abcd"}]\n' > "$SG/prs"
printf '[{"name": "build", "bucket": "pending"}]\n' > "$SG/checks-12"
printf '[{"name": "build", "bucket": "pending"}]\n' > "$SG/checks-13"
printf 'bash %s/skills/orchestrator/scripts/ci-watch.sh 12 --interval 10\ngh pr checks 12 --watch --fail-fast\n' "$SG" > "$SG/ps-live"
check "pending checks with a live watch for one pull request: only the other is refused" \
  "block|#13 at 1234abc: 1 checks pending (build), 0 failing ()" "$(sg 'Pushed.' | reason | sed 's/\. Report.*//')"
check "the process table is read once for both" "1" "$(grep -c . "$SG/ps-calls")"
check "the watched head is not recorded, so it is told once if the watch dies" "13 1234abcd5678ef901234abcd5678ef901234abcd pending" "$(cat "$SGS/stop-gate/sg-1.heads")"
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
printf '[{"number": 12, "headRefOid": "abc1234def5678abc1234def5678abc1234def56"}]\n' > "$SG/prs"
printf '[{"name": "build", "bucket": "pending"}]\n' > "$SG/checks-12"
printf '/bin/bash %s/skills/orchestrator/scripts/ci-watch.sh 12\n' "$SG" > "$SG/ps-live"
check "a live watch: the stop passes, silently" "" "$(sg 'Pushed.')"
rm -f "$SG/ps-live"
check "the watch gone: one refusal, naming the background command" \
  "block|#12 at abc1234: 1 checks pending (build), 0 failing (). Report this state as it is; to wait for the end, start \`$SGW 12\` with \`run_in_background\` (timeout 7200000), never in the foreground." \
  "$(sg 'Pushed.' | reason)"
check "and never twice for that head" "" "$(sg 'Pushed.')"
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
printf '[{"number": 12, "headRefOid": "abc1234def5678abc1234def5678abc1234def56"}]\n' > "$SG/prs"
printf '[{"name": "build", "bucket": "pending"}]\n' > "$SG/checks-12"
printf 'bash %s/skills/orchestrator/scripts/ci-watch.sh 120\nvim ci-watch.sh 12\ngrep ci-watch.sh 12\n' "$SG" > "$SG/ps-live"
check "a watch of pull request 120 and an editor open on the script are no watch of 12" "block|#12 at abc1234" "$(sg 'Pushed.' | reason | cut -c1-20)"
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
printf '[{"number": 12, "headRefOid": "abc1234def5678abc1234def5678abc1234def56"}]\n' > "$SG/prs"
printf '[{"name": "build", "bucket": "pending"}]\n' > "$SG/checks-12"
: > "$SG/ps-fail"
check "a process table that cannot be read counts as no watch: refused" "block|#12 at abc1234" "$(sg 'Pushed.' | reason | cut -c1-20)"
check "and the failure is logged" "1" "$(sglog | grep -c '| error | ps ')"
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
printf '[{"number": 7, "headRefOid": "0011223344556677889900112233445566778899"}]\n' > "$SG/prs"
printf '[{"name": "test", "bucket": "fail"}, {"name": "lint", "bucket": "pending"}]\n' > "$SG/checks-7"
printf 'bash %s/skills/orchestrator/scripts/ci-watch.sh 7\n' "$SG" > "$SG/ps-live"
check "a failing check refuses even with a live watch: a red is treated" "block|#7 at 0011223: 1 checks pending (lint), 1 failing (test)" \
  "$(sg 'Waiting.' | reason | sed 's/\. Report.*//')"
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
printf '[{"number": 3, "headRefOid": "aaaa1111bbbb2222cccc3333dddd4444eeee5555"}]\n' > "$SG/prs"
printf '[{"name": "test", "bucket": "pass"}]\n' > "$SG/checks-3"
sg 'CI is green.' >/dev/null
check "no pending head: the process table is not read" "0" "$(grep -c . "$SG/ps-calls" 2>/dev/null || echo 0)"

# Pending, then one check turns red while another is still pending: refused again with the
# red named, once; the finished red is the same failure and does not refuse a third time.
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
printf '[{"number": 9, "headRefOid": "9999aaaabbbbccccddddeeeeffff000011112222"}]\n' > "$SG/prs"
printf '[{"name": "build", "bucket": "pending"}, {"name": "test", "bucket": "pending"}]\n' > "$SG/checks-9"
check "pending then red: the first stop is refused" "block|#9 at 9999aaa: 2 checks pending (build, test), 0 failing ()" \
  "$(sg 'Waiting for CI.' | reason | sed 's/\. Report.*//')"
check "the second stop, still pending, nothing failing: passes" "" "$(sg 'Waiting for CI.')"
printf '[{"name": "build", "bucket": "pending"}, {"name": "test", "bucket": "fail"}]\n' > "$SG/checks-9"
echo 1 > "$SG/checks-9.code"
check "a check turning red while another is pending: refused, naming the red" "block|#9 at 9999aaa: 1 checks pending (build), 1 failing (test)" \
  "$(sg 'Waiting for CI.' | reason | sed 's/\. Report.*//')"
check "and the head stays pending, the failure remembered" "9 9999aaaabbbbccccddddeeeeffff000011112222 pending test" "$(cat "$SGS/stop-gate/sg-1.heads")"
check "the same failure never refuses twice while pending" "" "$(sg 'Waiting for CI.')"
printf '[{"name": "build", "bucket": "pass"}, {"name": "test", "bucket": "fail"}]\n' > "$SG/checks-9"
check "the red finished: the same failure, no third refusal" "" "$(sg 'Waiting for CI.')"
check "and the head is recorded as done" "9 9999aaaabbbbccccddddeeeeffff000011112222 done" "$(cat "$SGS/stop-gate/sg-1.heads")"
check "one refusal for the pending head, one for the red: two in all" "2" "$(sglog | grep -c '| check2 | ci-not-finished | #9 at 9999aaa')"

# A line written by the previous version has two fields and reads as done.
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
printf '[{"number": 12, "headRefOid": "abc1234def5678abc1234def5678abc1234def56"}]\n' > "$SG/prs"
printf '[{"name": "build", "bucket": "pending"}]\n' > "$SG/checks-12"
mkdir -p "$SGS/stop-gate"; printf '12 abc1234def5678abc1234def5678abc1234def56\n' > "$SGS/stop-gate/sg-1.heads"
check "a two-field heads line reads as done: silent, no checks call" "|0" "$(sg 'Pushed.')|$(cat "$SG/gh-calls" 2>/dev/null | grep -c .)"
check "and is kept" "12 abc1234def5678abc1234def5678abc1234def56 done" "$(cat "$SGS/stop-gate/sg-1.heads")"

check "only the operator's own pull requests are listed" "pr list --state open --author @me --limit 200 --json number,headRefOid" \
  "$(head -1 "$SG/gh-args")"

# A push is seen before its checks are registered: `gh pr checks` then answers an empty
# list. That head is not green, it is unread, and it is not recorded.
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
printf '[{"number": 5, "headRefOid": "5555666677778888999900001111222233334444"}]\n' > "$SG/prs"
printf '[]\n' > "$SG/checks-5"
check "a head with no checks yet passes, silently" "" "$(sg 'Pushed.')"
check "and is not recorded" "" "$(cat "$SGS/stop-gate/sg-1.heads" 2>/dev/null)"
printf '[{"name": "build", "bucket": "pending"}]\n' > "$SG/checks-5"
check "the same head, its checks now pending: refused" "block|#5 at 5555666: 1 checks pending (build), 0 failing ()" \
  "$(sg 'Pushed.' | reason | sed 's/\. Report.*//')"
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
printf '[{"number": 7, "headRefOid": "0011223344556677889900112233445566778899"}]\n' > "$SG/prs"
printf '[{"name": "test", "bucket": "fail"}, {"name": "e2e", "bucket": "cancel"}, {"name": "lint", "bucket": "pass"}]\n' > "$SG/checks-7"
echo 1 > "$SG/checks-7.code"
check "failing checks: refused with the real state" \
  "block|#7 at 0011223: 0 checks pending (), 2 failing (test, e2e). Report this state as it is; to wait for the end, start \`$SGW 7\` with \`run_in_background\` (timeout 7200000), never in the foreground." \
  "$(sg 'Only the known red remains.' | reason)"
check "failing checks on a finished head: recorded" "7 0011223344556677889900112233445566778899 done" "$(cat "$SGS/stop-gate/sg-1.heads")"
check "and the same head never refuses twice" "1|" "$(grep -c . "$SG/gh-calls")|$(sg 'Only the known red remains.')"
printf '[{"number": 7, "headRefOid": "99887766554433221100aabbccddeeff00112233"}]\n' > "$SG/prs"
check "a head moved by anyone is reported again" "block|#7 at 9988776" "$(sg 'Pushed.' | reason | cut -c1-19)"

sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
printf '[{"number": 3, "headRefOid": "aaaa1111bbbb2222cccc3333dddd4444eeee5555"}]\n' > "$SG/prs"
printf '[{"name": "test", "bucket": "pass"}, {"name": "docs", "bucket": "skipping"}]\n' > "$SG/checks-3"
check "all checks finished and passing: the stop passes, silently" "" "$(sg 'CI is green.')"
check "the green head is recorded" "3 aaaa1111bbbb2222cccc3333dddd4444eeee5555 done" "$(cat "$SGS/stop-gate/sg-1.heads")"
check "a green stop writes no log line" "" "$(sglog)"
sg 'CI is green.' >/dev/null
check "a head that has not moved costs no checks call" "1" "$(grep -c . "$SG/gh-calls")"

sg_reset; sg_listing "$IDLE"; sg_chain /dev/ttys901 S-ME
printf '[{"number": 12, "headRefOid": "abc1234def5678abc1234def5678abc1234def56"}]\n' > "$SG/prs"
printf '[{"name": "build", "bucket": "pending"}]\n' > "$SG/checks-12"
sg 'Waiting.' >/dev/null
check "Check 2 runs only when Check 1 let the stop pass" "0" "$(cat "$SG/gh-calls" 2>/dev/null | grep -c .)"

sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME; : > "$SG/gh-offline"
check "gh offline: the stop passes" "" "$(sg 'CI is green.')"
check "and the failure is logged" "1" "$(sglog | grep -c '| error | ')"
# One deadline for the whole hook: a slow listing leaves no time for the next call.
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
printf '[{"number": 12, "headRefOid": "abc1234def5678abc1234def5678abc1234def56"}]\n' > "$SG/prs"
printf '[{"name": "build", "bucket": "pending"}]\n' > "$SG/checks-12"
printf '#!/bin/bash\n[ "$1" = list ] || exit 1\nsleep 2\ncat "%s/listing"\n' "$SG" > "$SG/skills/iterm-agents/scripts/iterm-agent.sh"
check "past the overall deadline the stop passes, the next call never made" "" "$(SG_DEADLINE=1 sg 'CI is green.')"
check "and one line says so" "1|0" "$(sglog | grep -c '| error | the overall deadline of 1s passed before gh')|$(cat "$SG/gh-calls" 2>/dev/null | grep -c .)"
check "within the deadline the same hook refuses" "block|#12 at abc1234" "$(sg 'CI is green.' | reason | cut -c1-20)"
printf '#!/bin/bash\n[ "$1" = list ] || exit 1\ncat "%s/listing" 2>/dev/null || { echo "list: no terminal backend could serve this" >&2; exit 1; }\n' "$SG" \
  > "$SG/skills/iterm-agents/scripts/iterm-agent.sh"
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
check "gh absent: the stop passes" "" \
  "$("$py" -c 'import json,sys; json.dump({"session_id": "sg-1", "cwd": sys.argv[1], "last_assistant_message": "x", "stop_hook_active": False}, sys.stdout)' "$SGP" \
    | env PATH="/usr/bin:/bin" ORCHESTRATOR_STATE_DIR="$SGS" ITERM_SESSION_ID="w0t0p0:S-ME" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_PS_TABLE="$SG/ps" bash "$SG/hooks/stop-gate.sh" 2>/dev/null)"
check "and the missing tool is logged" "1" "$(sglog | grep -c '| error | ')"
NOPY="$SG/nopy-bin"; mkdir -p "$NOPY"; ln -sf "$(command -v mkdir)" "$(command -v date)" "$NOPY/"
sg_reset; printf '{"session_id": "sg-1", "stop_hook_active": false}' > "$SG/nopy-payload.json"
check "without python3 the stop passes, exit 0" "|0" \
  "$(env PATH="$NOPY" ORCHESTRATOR_STATE_DIR="$SGS" "$(command -v bash)" "$SG/hooks/stop-gate.sh" < "$SG/nopy-payload.json" 2>/dev/null; echo "|$?")"
check "and the missing interpreter is logged" "1" "$(sglog | grep -c '| - | error | python3 is not installed$')"

check "the phase brief template ends the delivery at the push, no CI watch" "yes|no|no" \
  "$(spells "$ROOT/templates/agent-phase-brief.md" 'The delivery ends at the push')|$(spells "$ROOT/templates/agent-phase-brief.md" 'gh pr checks')|$(spells "$ROOT/templates/agent-phase-brief.md" 'in the foreground')"
check "the standing rules say an agent never waits on CI" "yes|no" \
  "$(spells "$ROOT/skills/orchestrator/references/briefs.md" '**An agent never waits on CI.**')|$(spells "$ROOT/skills/orchestrator/references/briefs.md" 'timeout 590 gh pr checks <n> --watch')"
check "the orchestrator skill arms one background watch per pull request" "yes|yes|yes" \
  "$(spells "$ORCH_REFS/review.md" 'start `ci-watch.sh <n>`')|$(spells "$ORCH_REFS/review.md" 'with `run_in_background` and a timeout of 7 200 000 ms: one per pull request, never two')|$(spells "$ORCH_REFS/review.md" 'Moved: re-arm on the new head')"
check "and reads each ending: red, no checks, closed, unread" "yes|yes|yes|yes" \
  "$(spells "$ORCH_REFS/review.md" 'dispatch the correction at once, to a fresh session')|$(spells "$ORCH_REFS/review.md" 'No checks: ready on the suite')|$(spells "$ORCH_REFS/review.md" 'Closed: stop the work on it')|$(spells "$ORCH_REFS/review.md" 'Unread, or the timeout: re-arm once, then report')"
check "a merged pull request's base branch run is followed, and a red one never left standing" "yes|yes|yes|yes" \
  "$(spells "$ORCH_REFS/review.md" "Merged: the same watch follows the base branch's run")|$(spells "$ORCH_REFS/review.md" 'a red base branch is never left standing')|$(spells "$ORCH_REFS/review.md" 'fixed at once in its own pull request, dispatched to a fresh session')|$(spells "$ORCH_REFS/review.md" 'Base-no-run with `filtered=0`: nothing')"
check "a filter that matches nothing is reported as a misnamed workflow" "yes" \
  "$(spells "$ORCH_REFS/review.md" '`filtered` above 0 means a misnamed workflow, the filter leaving out every run there was, reported to the operator in one line')"
check "after a merge by hand the watch is started again, and enters on MERGED" "yes" \
  "$(spells "$ORCH_REFS/review.md" 'after you merge a pull request yourself, or the operator does, start `ci-watch.sh <n>` again in the background — it enters on MERGED and follows the base branch')"
check "green with auto-merge: the watch waits for the merge, and nobody waits outside it" "yes|no" \
  "$(spells "$ORCH_REFS/review.md" 'a watch that sees auto-merge enabled on green does not exit: it waits, bounded, for the merge and follows the base branch')|$(spells "$ORCH_REFS/review.md" 'nobody waits for MERGED')"
check "a base run cancelled for a newer push is not read as a red" "yes" \
  "$(spells "$ORCH_REFS/review.md" 'A base run cancelled for a newer push is no red: the watch follows the newest run of that workflow on the branch and reports it with its own sha')"
check "never a foreground watch, a loop on gh pr view or a wait for MERGED" "yes" "$(spells "$ORCH_REFS/review.md" 'never a loop on `gh pr view` or `gh pr checks`, never a wait for MERGED')"
check "the orchestrator skill no longer re-reads the checks at each idle notice" "no" "$(spells "$ORCH_REFS/review.md" 'At every idle notice of an agent with a pull request, re-read its checks')"
check "the orchestrator skill merges a green head only where the method opts into auto-merge" "yes" "$(spells "$ORCH_REFS/review.md" "in a project whose method opts into auto-merge, nothing")"
check "and by default it reports ready" "yes" "$(spells "$ORCH_REFS/review.md" 'otherwise report « ready » as above')"
check "the orchestrator skill points to the review reference for the watch" "yes" "$(spells "$ROOT/skills/orchestrator/SKILL.md" 'read `references/review.md`, « Checks, in one background watch », and start the watch')"
check "the lifecycle never rotates an agent, nor spawns a session, to watch CI" "yes|yes" \
  "$(spells "$ORCH_REFS/lifecycle.md" 'is stood down, never rotated, and no session is spawned to watch CI')|$(spells "$ORCH_REFS/lifecycle.md" 'An agent whose remaining work is waiting on CI is not rotated')"
check "no date or hour is written from memory, and a journal line carries no hour" "yes|yes|yes|no|no" \
  "$(spells "$ROOT/skills/orchestrator/SKILL.md" '**No date or hour is written from memory.**')|$(spells "$ROOT/skills/orchestrator/SKILL.md" 'A state or journal line carries no hour')|$(spells "$ROOT/skills/orchestrator/SKILL.md" 'a dispatch record'"'"'s `opened` is `dispatch-record.sh`'"'"'s to write, never typed')|$(spells "$ROOT/skills/orchestrator/SKILL.md" 'date +%H:%M')|$(spells "$ROOT/skills/orchestrator/SKILL.md" 'A time in a state or journal line is read from the clock')"
check "a time a message must carry is a command's output or the event's own timestamp, pasted" "yes|yes" \
  "$(spells "$ROOT/skills/orchestrator/SKILL.md" '`date -u +%FT%TZ`')|$(spells "$ROOT/skills/orchestrator/SKILL.md" "the event's own git or \`gh\` timestamp, pasted, never typed")"
check "a brief is named by its subject, never by a date" "yes|yes" \
  "$(spells "$ORCH_REFS/briefs.md" '`<briefs dir>/<subject>.md`')|$(spells "$ROOT/skills/orchestrator/SKILL.md" 'a brief or a memory is named by its subject only, never by a date')"
check "the audit brief is named by its subject, with no date" "yes|no" \
  "$(spells "$ROOT/commands/audit.md" 'audit-<subject>-brief.md')|$(spells "$ROOT/commands/audit.md" 'audit-<date>')"
check "the audit report keeps a dated name whose date is date +%F run at launch, never typed" "yes|yes" \
  "$(spells "$ROOT/commands/audit.md" '`<briefs dir>/audits/<date>-<subject>.md`, where `<date>` is the output of `date +%F` run now, never typed')|$(spells "$ROOT/commands/audit.md" "the previous report's file name, which a command wrote")"
check "the coordinator's succession brief is named with no date" "yes|no" \
  "$(spells "$ROOT/skills/coordination/SKILL.md" '<state dir>/coordinator/succession-brief.md')|$(spells "$ROOT/skills/coordination/SKILL.md" 'succession-<date>')"
check "a relayed ruling is dated by a command, pasted, never from memory" "yes|no" \
  "$(spells "$ROOT/commands/decide.md" 'the ruling verbatim, dated (`date -u +%FT%TZ`, pasted),')|$(spells "$ROOT/commands/decide.md" 'the ruling verbatim, dated,')"
check "a red outside what the pull request touches is re-run once before any correction" "yes|yes" \
  "$(spells "$ORCH_REFS/review.md" 'when its failure is outside what the pull request touches')|$(spells "$ORCH_REFS/review.md" 'Only a second red, or a red in what the pull request touches')"
check "the re-run is the failed jobs, once, after the failing job's cause is named in one line" "yes|yes" \
  "$(spells "$ORCH_REFS/review.md" 're-run the failed jobs once with `gh run rerun <run-id> --failed`')|$(spells "$ORCH_REFS/review.md" 'after naming the failing job'"'"'s cause in one line (the flake or the infrastructure fault, read in its log)')"
check "the design carries the re-run of a red outside what the pull request touches" "yes|yes" \
  "$(spells "$ROOT/docs/design.md" 'a red outside what the pull request touches is re-run once (failed jobs) and the watch re-armed')|$(spells "$ROOT/docs/design.md" 'a second red, or a red in what it touches, is reported and corrected')"
check "a mechanical base merge is the orchestrator's, in place; one that decides behaviour is a correction" "yes|yes" \
  "$(spells "$ORCH_REFS/review.md" 'conflicts are mechanical (no behaviour decided) is yours, done in place in a checkout and never by a spawned session')|$(spells "$ORCH_REFS/review.md" 'one that decides behaviour goes to a correction session')"
check "succession prunes the state file and archives the finished journal" "yes|yes" \
  "$(spells "$ORCH_REFS/lifecycle.md" 'Prune the state file before you hand over')|$(spells "$ORCH_REFS/lifecycle.md" 'the finished journal moves to an archive file')"
check "the succession brief inherits a pruned state file and does not load the archive" "yes|no" \
  "$(spells "$SUCC" 'pruned by your predecessor to what is live, its finished journal archived in a file you are not asked to load')|$(spells "$SUCC" 'read the archive')"
# A successor confirmed its takeover at 75k to 97k tokens because step 1 ordered the spec, the plan,
# the runbook, the state file and the briefs directory read whole. At takeover it needs what is live,
# which its predecessor writes into the brief; the rest is read by the section a task touches.
SUCC1=$(awk '/^1\. /{f=1} /^2\. /{f=0} f' "$SUCC" | tr '\n' ' ' | tr -s ' ')
succ1_has() { printf '%s' "$SUCC1" | grep -oF -- "$1" | wc -l | tr -d ' '; }
check "step 1 of the succession brief orders no whole read of the spec, plan, runbook, state file or briefs directory" "0|0|0|0|0" \
  "$(succ1_has '{{SPEC}}')|$(succ1_has '{{PLAN}}')|$(succ1_has '{{RUNBOOK}}')|$(succ1_has '{{STATE_FILE}}')|$(succ1_has '{{BRIEFS_DIR}}')"
check "step 1 reads the rulebook and this brief, and nothing else whole" "1|1" \
  "$(succ1_has 'the rulebook')|$(succ1_has 'THIS brief')"
SUCC_STANDING=$(awk '/^## Standing context/{f=1} f' "$SUCC" | tr '\n' ' ' | tr -s ' ')
check "the spec, plan, runbook, state file and briefs directory are pointers read by section, never whole" "1|1|1|1|1|1|1" \
  "$(for p in '{{SPEC}}' '{{PLAN}}' '{{RUNBOOK}}' '{{STATE_FILE}}' '{{BRIEFS_DIR}}' "grep -n" "sed -n"; do printf '%s' "$SUCC_STANDING" | grep -qF -- "$p" && echo 1 || echo 0; done | paste -sd'|' -)"
LIVE_H='## Live state — written by your predecessor at the handover'
LIVE_N=$(grep -n -m1 -F -- "$LIVE_H" "$SUCC" | cut -d: -f1)
FIRST_N=$(grep -n -m1 -F -- '## Your first task' "$SUCC" | cut -d: -f1)
check "the succession brief carries a Live state section before the first task" "1" \
  "$([ -n "$LIVE_N" ] && [ -n "$FIRST_N" ] && [ "$LIVE_N" -lt "$FIRST_N" ] && echo 1 || echo 0)"
LIVE_BODY=$(awk -v h="$LIVE_H" '$0==h{f=1;next} /^## /{f=0} f' "$SUCC")
check "the Live state section carries its five placeholders" "1|1|1|1|1" \
  "$(for p in '{{LIVE_ROWS}}' '{{LIVE_PULL_REQUESTS}}' '{{LIVE_AGENTS}}' '{{LIVE_RULINGS}}' '{{LIVE_NEXT_STEP}}'; do printf '%s' "$LIVE_BODY" | grep -cF -- "$p"; done | paste -sd'|' -)"
check "the Live state section replaces reading the journal, which is read by section for a question it leaves open" "yes|yes" \
  "$(printf '%s' "$LIVE_BODY" | tr '\n' ' ' | tr -s ' ' | grep -qF 'replaces reading the journal' && echo yes || echo no)|$(printf '%s' "$LIVE_BODY" | tr '\n' ' ' | tr -s ' ' | grep -qF 'by its section' && echo yes || echo no)"
SUCC5=$(awk '/^5\. /{f=1} /^## /{f=0} f' "$SUCC" | tr '\n' ' ' | tr -s ' ')
check "step 5 announces the successor's own measured context from the gauge" "1|1" \
  "$(printf '%s' "$SUCC5" | grep -oF 'context_tokens=' | wc -l | tr -d ' ')|$(printf '%s' "$SUCC5" | grep -oF '{{GAUGE}}' | wc -l | tr -d ' ')"
# Every successor measures its takeover at the same point, the turn that sends « takeover
# confirmed », so one orchestration's takeover figures compare from one succession to the next:
# step 4 runs the gauge in that turn, before the message, and step 5 reports that reading only.
check "step 4 runs the gauge in the « takeover confirmed » turn, immediately before the message" "1|1" \
  "$(succ4_has 'In the turn that sends « takeover confirmed », run `{{GAUGE}}` immediately before the message and keep its `context_tokens=` line')|$(printf '%s' "$SUCC4" | awk '{ a = index($0, "run `{{GAUGE}}` immediately before the message"); b = index($0, "Then message the predecessor \"takeover confirmed\""); print (a > 0 && b > 0 && a < b) ? 1 : 0 }')"
check "step 5 reports the context kept at « takeover confirmed », never a later reading" "1|1" \
  "$(printf '%s' "$SUCC5" | grep -oF 'your own measured context at « takeover confirmed »' | wc -l | tr -d ' ')|$(printf '%s' "$SUCC5" | grep -oF 'the one you kept in that turn, never a later reading' | wc -l | tr -d ' ')"
# The successor also keeps its first turn's reading: the gap between it and the « takeover
# confirmed » reading is what the takeover's verification costs.
check "step 1 runs the gauge in the successor's first tool call and keeps its reading as « first turn »" "1|1|1" \
  "$(printf '%s' "$SUCC1" | grep -oF 'Your FIRST tool call, ahead of any skill load, runs `{{GAUGE}}`: keep its `context_tokens=` line as your « first turn » figure' | wc -l | tr -d ' ')|$(printf '%s' "$SUCC1" | grep -oF '{{GAUGE}}' | wc -l | tr -d ' ')|$(printf '%s' "$SUCC1" | awk '{ a = index($0, "{{GAUGE}}"); b = index($0, "Read the rulebook"); print (a > 0 && b > 0 && a < b) ? 1 : 0 }')"
check "step 5 reports both figures, « first turn » and « at takeover confirmed », on one line" "1|1" \
  "$(printf '%s' "$SUCC5" | grep -oF 'both on one line: « first turn » and « at takeover confirmed »' | wc -l | tr -d ' ')|$(printf '%s' "$SUCC5" | grep -oF 'the line kept in step 1' | wc -l | tr -d ' ')"
check "the design names both figures and why: their gap is the takeover's verification cost" "yes|yes" \
  "$(spells "$ROOT/docs/design.md" 'its first turn and the turn that sends « takeover confirmed »')|$(spells "$ROOT/docs/design.md" "the gap between them is what the takeover's verification costs")"
check "the design says why the takeover is measured in the « takeover confirmed » turn" "yes" \
  "$(spells "$ROOT/docs/design.md" 'so that its figures compare from one succession to the next')"
# The predecessor fills the section before the spawn, and keeps the whole brief short.
check "succeed.md and the lifecycle reference have the predecessor fill Live state and hold the brief to 10,000 characters" "yes|yes|yes|yes" \
  "$(spells "$ROOT/commands/succeed.md" 'Live state')|$(spells "$ROOT/commands/succeed.md" '10,000 characters')|$(spells "$ORCH_REFS/lifecycle.md" 'Live state')|$(spells "$ORCH_REFS/lifecycle.md" '10,000 characters')"
# The brief is standing: after its first use the section holds the last handover, not placeholders.
check "succeed.md and the lifecycle reference have the predecessor overwrite the previous Live state, never append" "yes|yes" \
  "$(spells "$ROOT/commands/succeed.md" "overwrites the previous handover's Live state")|$(spells "$ORCH_REFS/lifecycle.md" "overwrites the previous handover's Live state")"
check "the lifecycle's step 3 reads the brief and its Live state, not whole files" "no|yes" \
  "$(spells "$ORCH_REFS/lifecycle.md" 'read the brief and its pointed state')|$(spells "$ORCH_REFS/lifecycle.md" 'read the rulebook and the brief, whose Live state is the hand-over copy of the state file')"
check "the design says what a successor reads at takeover, and why" "yes|yes" \
  "$(spells "$ROOT/docs/design.md" 'the successor reads the rulebook and its brief'"'"'s live state, the rest by section on demand')|$(spells "$ROOT/docs/design.md" 'input and cache tokens of each assistant turn')"
# The lint: a succession brief past 10,000 characters is a finding naming the count and the limit.
SUCCFILL="$WORK/succession-filled.md"
sed -E -e 's#\{\{PROJECT\}\}#scratch#g' -e 's#\{\{PREDECESSOR_NAME_PATTERN\}\}#Orch : scratch#g' \
  -e "s#\{\{GAUGE\}\}#$ROOT/skills/context-gauge/scripts/context-gauge.sh#g" \
  -e 's#\{\{LIVE_[A-Z_]+\}\}#none open#g' -e "s#\{\{[A-Z_]+\}\}#$WORK#g" "$SUCC" > "$SUCCFILL"
check "a succession brief, every placeholder filled, lints clean and stays under 10,000 characters" "0|yes" \
  "$(bash "$LINT" "$SUCCFILL" >/dev/null 2>&1; echo $?)|$([ "$(LC_ALL=C tr -d '\200-\277' < "$SUCCFILL" | wc -c | tr -d ' ')" -le 10000 ] && echo yes || echo no)"
SUCCBIG="$WORK/succession-big.md"
{ cat "$SUCCFILL"; printf '\n'; head -c 10000 /dev/zero | tr '\0' 'x'; printf '\n'; } > "$SUCCBIG"
SUCCBIG_N=$(LC_ALL=C tr -d '\200-\277' < "$SUCCBIG" | wc -c | tr -d ' ')
check "a succession brief over 10,000 characters is a finding naming the count and the limit" "1|1|1" \
  "$(bash "$LINT" "$SUCCBIG" 2>&1 | grep -c "succession brief is $SUCCBIG_N characters, over the limit of 10000")|$(bash "$LINT" "$SUCCBIG" >/dev/null 2>&1; echo $?)|$(bash "$LINT" "$SUCCBIG" 2>&1 | grep -c ': 1 finding(s)')"
SUCCOTHER="$WORK/not-a-succession.md"
{ cat "$B/good.md"; head -c 10000 /dev/zero | tr '\0' 'x'; printf '\n'; } > "$SUCCOTHER"
check "the size limit binds a succession brief only" "0" "$(bash "$LINT" "$SUCCOTHER" >/dev/null 2>&1; echo $?)"
check "the README's hooks table names the Stop hook" "yes" "$(spells "$ROOT/README.md" 'hook `Stop`')"
check "the eval selection says its two stop-gate cases grade the staged spawn line and do not run the hook" "2" \
  "$(grep -E '^\| 5[12] \|' "$ROOT/evals/SELECTION.md" | grep -c 'under staging; it does not run the hook')"
check "the hook is registered on the Stop event" "1" \
  "$("$py" -c 'import json,sys; h=json.load(open(sys.argv[1]))["hooks"]["Stop"]; print(sum("hooks/stop-gate.sh" in x["command"] for e in h for x in e["hooks"]))' "$ROOT/hooks/hooks.json" 2>/dev/null)"

echo "-- the sweep, run last and never part of the decision"
sweepargs() { cat "$SG/sweep-args" 2>/dev/null; }
sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
printf 'deleted /ws/p/one\nkept /ws/p/two: the tree is dirty\ndeleted /ws/p/three\n' > "$SG/sweep-out"
check "a passing stop of an orchestrator runs the sweep and still passes silently" "" "$(sg 'I launched the phase.')"
check "with what is left of the budget, minus a margin, as its deadline" "1" "$(sweepargs | grep -cE '^sweep --deadline 1[4-7]$')"
check "each deletion is logged, a kept item is not" "2|0" \
  "$(sglog | grep -c '| Orch : f \[a1b2c3\] | sweep | deleted | /ws/p/')|$(sglog | grep -c 'two')"
sg 'And again.' >/dev/null
check "a second stop within ten minutes does not sweep again" "1" "$(sweepargs | grep -c .)"
touch -t 200001010000 "$SGS/sweep.stamp"
sg 'And later.' >/dev/null
check "one past the ten minutes does" "2" "$(sweepargs | grep -c .)"

sg_reset; sg_listing
# The host reads the decision at the hook's exit: a refusal never waits on a sweep.
check "a refused stop is refused as before, and runs no sweep" "block|Nothing will wake you|0" \
  "$(sg 'I am launching the phase 3 agent now.' | reason | cut -c1-27)|$(sweepargs | grep -c .)"

sg_reset; sg_ps '--name Agent : one [b2c3d4]'
sg 'done' >/dev/null
check "a session that is not an orchestrator never sweeps" "0" "$(sweepargs | grep -c .)"

sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
echo boom > "$SG/sweep-err"; echo 3 > "$SG/sweep-code"
check "a sweep that fails never refuses the stop" "" "$(sg 'I launched the phase.')"
check "and the failure is logged" "1" "$(sglog | grep -c '| sweep | error | exit 3: boom$')"

sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
# The stub sleeps a duration carrying this run's pid, so only its own leftover is counted: a
# bare `sleep 20` belongs to whichever other run of the suite is at this check.
own_sleeps() { ps -axo command | grep -c "^sleep 20\\.$$\$"; }
echo "20.$$" > "$SG/sweep-sleep"
t0=$SECONDS
out=$(SG_DEADLINE=6 sg 'I launched the phase.')
elapsed=$((SECONDS - t0))
check "a sweep that overruns is stopped inside the budget, the stop passes" "|1|0" \
  "$out|$([ "$elapsed" -lt 12 ] && echo 1 || echo 0)|$(own_sleeps)"
check "and the overrun is logged" "1" "$(sglog | grep -c '| sweep | error | did not finish within')"
# Another run of the suite sleeping 20 seconds at the same moment is not this run's leftover.
sleep 20 & stray=$!
check "a stray sleep 20 of another process is not counted" "0" "$(own_sleeps)"
kill "$stray"; wait "$stray" 2>/dev/null

sg_reset; sg_listing "$BUSY"; sg_chain /dev/ttys901 S-ME
SG_DEADLINE=3 sg 'I launched the phase.' >/dev/null
check "no budget left after the checks: no sweep, and no stamp spent" "0|0" \
  "$(sweepargs | grep -c .)|$([ -e "$SGS/sweep.stamp" ] && echo 1 || echo 0)"
sg_reset

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
# Scoped to this suite's own stub path, not the bare name: a bare `pgrep -f osascript-deaf`
# reads machine-wide and flakes when another suite's own deaf stub is alive at the same time.
check "the deaf probe leaves no osascript behind" "0" \
  "$(ORCHESTRATOR_OSASCRIPT="$IBIN/osascript-deaf" ORCHESTRATOR_PROBE_TIMEOUT=2 \
     ipy "
import subprocess
ia.osascript_run('x')
print(subprocess.run(['pgrep','-f','$IBIN/osascript-deaf'],capture_output=True,text=True).stdout.count('\n'))")"

# Proof the scoped guard still falls on a real leak: a copy of the stub started directly
# under this suite's own work directory and left running on purpose, so "0" above means a
# clean kill, not a pattern too narrow to ever match anything.
LEAKED="$IBIN/osascript-deaf-leak"
cp "$IBIN/osascript-deaf" "$LEAKED"
"$LEAKED" </dev/null >/dev/null 2>&1 &
LEAK_PID=$!
check "the scoped guard still catches a leak planted in a scratch copy" "1" \
  "$(pgrep -f -- "$LEAKED" | wc -l | tr -d ' ')"
kill "$LEAK_PID" 2>/dev/null
wait "$LEAK_PID" 2>/dev/null
rm -f "$LEAKED"
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

echo "== iterm-agents: the AppleScript rung leaves the operator where they work =="
# The API rung creates a tab without selecting it; `create tab` in AppleScript selects it,
# so an orchestrator that fell to this rung pulled the operator onto every agent it
# launched. The stub records the script the spawn sends and answers with the new tty.
AS_SENT="$WORK/as-spawn-sent.applescript"
printf '#!/bin/bash\ncat > "%s"\necho /dev/ttys900\n' "$AS_SENT" > "$IBIN/osascript-record"
chmod +x "$IBIN/osascript-record"
check "the AppleScript spawn still returns the new session's tty" "/dev/ttys900" \
  "$(ORCHESTRATOR_OSASCRIPT="$IBIN/osascript-record" ipy "print(ia.as_spawn('true'))")"
check "the AppleScript spawn re-selects the operator's tab after creating the agent's" "reselects" \
  "$("$py" -c "
import sys
s = open(sys.argv[1]).read()
create = s.find('create tab')
remember = s.find('set prev to current tab')
print('reselects' if -1 < remember < create < s.find('select prev', create) else 'no')" "$AS_SENT")"
check "the re-selection is guarded, so a tab closed meanwhile cannot fail the spawn" "guarded" \
  "$("$py" -c "
import sys
s = open(sys.argv[1]).read()
select = s.find('select prev', s.find('create tab'))
opened = s.rfind('try', 0, select)
closed = s.find('end try', select)
ret = s.find('return newTty', select)
print('guarded' if -1 < opened < select < closed < ret else 'no')" "$AS_SENT")"

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

echo "== iterm-agents: a close takes the stood-down session's checkout with it =="
# The session's purpose is over once its close is proved on the process table, so the
# checkout it worked in is deleted — through `workspace.sh delete`, never `--discard`, so a
# checkout holding work stays and says why. The cwd is read BEFORE the close, `--keep-checkout`
# opts out, and a rotation deletes nothing: its replacement works in the same checkout. The
# suite stands in for the process table's cwd with ORCHESTRATOR_CWD_TABLE and runs on the
# temporary repositories and the temporary host area of the workspace section above.
export GIT_CONFIG_GLOBAL="$WORK/no-global-gitconfig"
export ORCHESTRATOR_WORKSPACES="$WORK/wcroot"
export ORCHESTRATOR_HOST_TMP="$WC/hosttmp"
CT_TABLE="$WORK/cwd-table"
export ORCHESTRATOR_CWD_TABLE="$CT_TABLE"
cat > "$WORK/close_probe.py" <<'PYEOF'
import contextlib, io, os, sys
sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
mode = sys.argv[2]
tty = '/dev/ttys901'
table = os.environ['ORCHESTRATOR_CWD_TABLE']
ia.host_cli_on = lambda t: '4242'
ia.wait_gone = lambda t, timeout=None: '4242' if mode == 'survivor' else None
ia.served_by = (lambda *a, **k: open(table, 'w').close()) if mode == 'vanish' else (lambda *a, **k: None)
ia.cmd_spawn = lambda argv: None
out, err = io.StringIO(), io.StringIO()
code = 0
try:
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        if mode == 'rotate':
            ia.cmd_rotate(['--old-tty', tty, '--dir', '/x', '--title', 'T'])
        else:
            ia.cmd_close(['--tty', tty] + sys.argv[3:])
except SystemExit as e:
    code = e.code
print('exit=%s' % code)
print('OUT:' + out.getvalue().strip())
print('ERR:' + err.getvalue().strip())
PYEOF
cprobe() { "$py" "$WORK/close_probe.py" "$ROOT/skills/iterm-agents/scripts" "$@"; }
field() { printf '%s\n' "$1" | sed -n "s/^$2://p"; }

CL=$(mkclone "$WCSRC" cl-a feat/cl-a); HCL=$(scratch "$CL"); printf '/dev/ttys901 %s\n' "$CL" > "$CT_TABLE"
res=$(cprobe close)
check "a proved close deletes the session's checkout and its host directory; stdout keeps its one contract line" \
  "exit=0|closed 1 session on /dev/ttys901|0|0" \
  "$(printf '%s\n' "$res" | head -1)|$(field "$res" OUT)|$(exists "$CL")|$(exists "$HCL")"
check "and stderr says it" "1" "$(field "$res" ERR | grep -c "^close: deleted checkout $CL\$")"

CL=$(mkclone "$WCSRC" cl-b feat/cl-b dirty); printf '/dev/ttys901 %s\n' "$CL" > "$CT_TABLE"
res=$(cprobe close)
check "a dirty checkout stays: the close succeeds, says why on stderr, and keeps its contract line" \
  "exit=0|closed 1 session on /dev/ttys901|1|1" \
  "$(printf '%s\n' "$res" | head -1)|$(field "$res" OUT)|$(exists "$CL")|$(field "$res" ERR | grep -c "^close: kept checkout $CL: the tree is dirty\$")"
bash "$WS" delete "$CL" --discard >/dev/null 2>&1

CL=$(mkclone "$WCSRC" cl-c feat/cl-c unpushed); printf '/dev/ttys901 %s\n' "$CL" > "$CT_TABLE"
res=$(cprobe close)
check "unpushed commits stay too, never discarded" "1|1" \
  "$(exists "$CL")|$(field "$res" ERR | grep -c "^close: kept checkout $CL: commits on no remote branch\$")"
bash "$WS" delete "$CL" --discard >/dev/null 2>&1

CL=$(mkclone "$WCSRC" cl-d feat/cl-d); printf '/dev/ttys901 %s\n' "$CL" > "$CT_TABLE"
res=$(cprobe close --keep-checkout)
check "--keep-checkout opts out: nothing deleted, nothing said about a checkout" "1|0" \
  "$(exists "$CL")|$(field "$res" ERR | grep -c 'checkout')"

res=$(cprobe rotate)
check "a rotation deletes nothing: its replacement works in the same checkout" "1|0" \
  "$(exists "$CL")|$(field "$res" ERR | grep -c 'deleted')"

printf '/dev/ttys901 %s\n' "$WCSRC" > "$CT_TABLE"
res=$(cprobe close)
check "a session outside the workspaces root (the orchestrator's own checkout) is never touched" "1|0" \
  "$(exists "$WCSRC/README.md")|$(field "$res" ERR | grep -c 'checkout')"

CLG=$(mkclone "$WCSRC" cl-g feat/cl-g)
printf '/dev/ttys901 %s\n' "$(rp "$WORK/wcroot")Zproj/cl-g" > "$CT_TABLE"
res=$(cprobe close)
check "a sibling directory sharing the root's name is not under the root" "1" "$(exists "$CLG")"
bash "$WS" delete "$CLG" >/dev/null 2>&1
printf '/dev/ttys901 %s\n' "$CL/.git/info" > "$CT_TABLE"
res=$(cprobe close)
check "a session in a subdirectory of its checkout takes the whole checkout" "0" "$(exists "$CL")"

CL=$(mkclone "$WCSRC" cl-e feat/cl-e); printf '/dev/ttys901 %s\n' "$CL" > "$CT_TABLE"
res=$(cprobe vanish close)
check "the cwd is read before the close, not after it" "0" "$(exists "$CL")"

CL=$(mkclone "$WCSRC" cl-f feat/cl-f); printf '/dev/ttys901 %s\n' "$CL" > "$CT_TABLE"
res=$(cprobe survivor)
check "a close that is not proved deletes nothing" "exit=1|1" "$(printf '%s\n' "$res" | head -1)|$(exists "$CL")"
bash "$WS" delete "$CL" >/dev/null 2>&1

hold "$WORK"
check "the host CLI's cwd is read from the process table when no stand-in is set" "$(rp "$WORK")" \
  "$(env -u ORCHESTRATOR_CWD_TABLE "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as ia
ia.host_cli_on = lambda t: '${LIVE##* }'
print(ia.host_cli_cwd('/dev/ttys901'))")"
release
unset GIT_CONFIG_GLOBAL ORCHESTRATOR_WORKSPACES ORCHESTRATOR_HOST_TMP ORCHESTRATOR_CWD_TABLE
rm -rf "$WC/hosttmp"/* 2>/dev/null

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

# The coordinator's record and its readings of the facts are what nothing downstream
# re-checks: a record read alive after its session died would refuse the next coordinator,
# and a collision missed is one the operator never hears of. Every liveness answer here
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
check "a holder whose operation is unknown is not guessed" \
  "coordinator: refused: the coordinator's lock is held: $CLOCK held by pid $deadpid (dead): remove $CLOCK|exit 1" \
  "$(coord register --name "Coord : three [ccc333]" --tty /dev/ttys103 2>&1)|$(coord_status register --name "Coord : three [ccc333]" --tty /dev/ttys103)"
rm -f "$CLOCK/holder"
check "a lock with no holder recorded is refused all the same" \
  "coordinator: refused: the coordinator's lock is held: $CLOCK names no holder: remove $CLOCK" \
  "$(coord register --name "Coord : three [ccc333]" --tty /dev/ttys103 2>&1)"
rmdir "$CLOCK"

# A state directory that cannot be written is refused at once, not after five seconds.
CRO="$WORK/coord-ro"
mkdir -p "$CRO" && chmod 555 "$CRO"
t0=$(date +%s)
out=$(ORCHESTRATOR_STATE_DIR="$CRO" COORDINATOR_VERIFY="$WORK/coord-verify" COORD_LIVE="$CLIVE" \
  bash "$COORD" register --name "Coord : ro [r0r0r0]" --tty /dev/ttys201 2>&1); code=$?
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

# Liveness: an error of the check is no « dead ». Its own « not running », exit 1 and
# silent, is the only answer read as dead.
live /dev/ttys106
coord register --name "Coord : six [fff666]" --tty /dev/ttys106 >/dev/null 2>&1
cvar() { ORCHESTRATOR_STATE_DIR="$CS" COORD_LIVE="$CLIVE" COORDINATOR_VERIFY="$1" bash "$COORD" "${@:2}"; }
cvar_status() { cvar "$@" >/dev/null 2>&1; echo "exit $?"; }
check "a missing liveness command is said, exit 1 from lookup" \
  "coordinator: the liveness command $WORK/no-verify is missing or not executable|exit 1" \
  "$(cvar "$WORK/no-verify" lookup 2>&1)|$(cvar_status "$WORK/no-verify" lookup)"
check "and from register, the record kept" "exit 1|Coord : six [fff666]" \
  "$(cvar_status "$WORK/no-verify" register --name "Coord : x [xxx000]" --tty /dev/ttys107)|$(jq -r .name "$CREC")"
printf '#!/bin/bash\necho "cannot read the process table" >&2\nexit 1\n' > "$WORK/coord-verify-err"
chmod +x "$WORK/coord-verify-err"
check "a liveness check that fails is not read as dead" \
  "coordinator: the liveness check failed on /dev/ttys106: cannot read the process table|exit 1" \
  "$(cvar "$WORK/coord-verify-err" lookup 2>&1)|$(cvar_status "$WORK/coord-verify-err" lookup)"
# The lock's holder writes its pid and its operation into it: read here from inside the
# lock, by a liveness check that register runs while it holds it.
printf '#!/bin/bash\ncat "$ORCHESTRATOR_STATE_DIR/coordinator.lock/holder" > "$COORD_PEEK"\nexit 1\n' > "$WORK/coord-verify-peek"
chmod +x "$WORK/coord-verify-peek"
COORD_PEEK="$WORK/coord-peek" cvar "$WORK/coord-verify-peek" register --name "Coord : seven [ggg777]" --tty /dev/ttys108 >/dev/null 2>&1
check "the lock's holder records its pid and its operation" "1" "$(grep -cE '^[0-9]+ registration$' "$WORK/coord-peek" 2>/dev/null)"
coord clear
check "the ledger's commands are gone" "exit 1|exit 1|exit 1" \
  "$(coord_status declare --orchestrator x --tty /dev/ttys1 --repo /r)|$(coord_status release c1)|$(coord_status conflicts c1)"

# facts and owners: read from a stand-in process table, a stand-in table of working
# directories, real repositories and checkouts, and a stand-in forge. Nobody declares
# anything: every line is crossed from what runs and what is checked out now.
CF="$WORK/coord-facts"
mkdir -p "$CF/src" "$CF/briefs" "$CWS/app" "$CWS/other"
mkrepo() {  # <path> <branch> <origin url>
  git init -q -b "$2" "$1" && git -C "$1" remote add origin "$3" \
    && git -C "$1" -c user.email=t@local -c user.name=t commit -q --allow-empty -m "Set up"
}
mkrepo "$CF/src/app" main git@forge.example:o/app.git
mkrepo "$CWS/app/a1" feat/x https://forge.example/o/app.git
mkrepo "$CWS/app/b1" feat/x git@forge.example:o/app.git
mkrepo "$CWS/app/c1" feat/y ssh://git@forge.example/o/app
mkrepo "$CWS/app/idle" feat/w git@forge.example:o/app.git
mkrepo "$CWS/other/o1" feat/x git@forge.example:o/other.git
mkrepo "$CWS/other/o2" feat/o git@forge.example:o/other.git
mkrepo "$CWS/none/n1" feat/x git@forge.example:o/none.git
mkrepo "$CWS/none/n2" feat/x git@forge.example:o/none.git
real() { (cd "$1" && pwd -P); }
RSRC=$(real "$CF/src/app"); RA1=$(real "$CWS/app/a1"); RB1=$(real "$CWS/app/b1"); RC1=$(real "$CWS/app/c1")
RIDLE=$(real "$CWS/app/idle"); RO1=$(real "$CWS/other/o1"); RO2=$(real "$CWS/other/o2")
printf 'The phase.\n\n- Your orchestrator is the session **`Orch : alpha [aaa111]`** — that exact name.\n' > "$CF/briefs/a1.md"
printf 'A brief that names no orchestrator.\n' > "$CF/briefs/c1.md"
cat > "$CF/ps" <<PS
100 1 ttys100 /usr/bin/hostcli --model m Read and execute $CF/briefs/orch.md --name Orch : alpha --remote-control Orch : alpha
101 1 ttys101 /usr/bin/hostcli --model m Read and execute $CF/briefs/a1.md. Your orchestrator is Orch : wrong [zzz999]. --name Agent : a1
102 1 ttys102 hostcli Read and execute $CF/briefs/gone.md. Your orchestrator is Orch : beta [bbb222]; handshake first. --name Agent : b1
103 1 ttys103 /usr/bin/hostcli Read and execute $CF/briefs/c1.md --name Agent : c1
104 1 ?? /usr/bin/hostcli --print a job with no tty
105 1 ttys105 /usr/bin/vim notes.md
106 1 ttys106 /usr/bin/hostcli Read and execute $CF/briefs/gone.md. Your orchestrator is Orch : gamma [ccc333]. --name Agent : o1
200 1 ttys100 bash ./tests/run-tests.sh
201 200 ttys100 bash ./tests/run-tests.sh
300 1 ttys101 timeout 595 /usr/bin/hostcli plugin eval . --case x
301 300 ttys101 /usr/bin/hostcli plugin eval . --case x
400 1 ttys102 /bin/zsh -c while pgrep -f run-tests.sh >/dev/null; do sleep 5; done
401 400 ttys102 pgrep -f run-tests.sh
PS
cat > "$CF/cwds" <<CW
100 $RSRC
101 $RA1
102 $RB1
103 $RC1
106 $RO1
200 $RSRC
300 $RA1
CW
cat > "$CF/forge" <<'FG'
#!/bin/bash
case "$(git -C "$1" remote get-url origin)" in
  *o/app*) printf '7 feat/x same\n8 feat/y same\n9 feat/z same\n10 feat/w same\n' ;;
  *o/lone*|*o/other*) ;;
  *) echo "the forge does not know $1" >&2; exit 1 ;;
esac
FG
chmod +x "$CF/forge"
cfacts() {
  ORCHESTRATOR_STATE_DIR="$CS" ORCHESTRATOR_WORKSPACES="$CWS" ORCHESTRATOR_HOST_CLI=hostcli \
    COORDINATOR_PS_TABLE="${COORDINATOR_PS_TABLE:-$CF/ps}" COORDINATOR_CWDS="${COORDINATOR_CWDS:-$CF/cwds}" \
    COORDINATOR_FORGE="${COORDINATOR_FORGE:-$CF/forge}" bash "$COORD" "$@"
}
cfacts_status() { cfacts "$@" >/dev/null 2>&1; echo "exit $?"; }
FACTS=$(cfacts facts 2>/dev/null)
OWNERS=$(cfacts owners 2>/dev/null)

check "facts lists each host session on a tty with its title, its orchestrator, its repository and branch" \
  "session 100 | ttys100 | Orch : alpha | Orch : alpha | forge.example/o/app | main | $RSRC|session 101 | ttys101 | Agent : a1 | Orch : alpha [aaa111] | forge.example/o/app | feat/x | $RA1|session 102 | ttys102 | Agent : b1 | Orch : beta [bbb222] | forge.example/o/app | feat/x | $RB1|session 103 | ttys103 | Agent : c1 | unknown | forge.example/o/app | feat/y | $RC1|session 106 | ttys106 | Agent : o1 | Orch : gamma [ccc333] | forge.example/o/other | feat/x | $RO1" \
  "$(printf '%s\n' "$FACTS" | grep '^session ' | tr '\n' '|' | sed 's/|$//')"
check "a job with no tty, a process that is not the host and an evaluation's host are no sessions" "0|0|0" \
  "$(printf '%s\n' "$FACTS" | grep -c '^session 104 ')|$(printf '%s\n' "$FACTS" | grep -c '^session 105 ')|$(printf '%s\n' "$FACTS" | grep -c '^session 301 ')"
check "the checkouts read are those of a repository a session works in" \
  "checkout $RA1 | forge.example/o/app | feat/x|checkout $RB1 | forge.example/o/app | feat/x|checkout $RC1 | forge.example/o/app | feat/y|checkout $RIDLE | forge.example/o/app | feat/w|checkout $RO1 | forge.example/o/other | feat/x|checkout $RO2 | forge.example/o/other | feat/o" \
  "$(printf '%s\n' "$FACTS" | grep '^checkout ' | tr '\n' '|' | sed 's/|$//')"
check "a heavy run is listed once, at its top process, with where it runs" \
  "heavy 200 | $RSRC | bash ./tests/run-tests.sh|heavy 300 | $RA1 | timeout 595 /usr/bin/hostcli plugin eval . --case x" \
  "$(printf '%s\n' "$FACTS" | grep '^heavy ' | tr '\n' '|' | sed 's/|$//')"
check "a shell that only names a suite, and a pgrep looking for one, are no heavy run" "0|0" \
  "$(printf '%s\n' "$FACTS" | grep -c '^heavy 400 ')|$(printf '%s\n' "$FACTS" | grep -c '^heavy 401 ')"
check "two checkouts on one branch of one repository are a collision" \
  "collision checkouts | forge.example/o/app | feat/x | $RA1, $RB1" \
  "$(printf '%s\n' "$FACTS" | grep '^collision checkouts ')"
check "two sessions on one branch of one repository are a collision" \
  "collision sessions | forge.example/o/app | feat/x | 101 Agent : a1, 102 Agent : b1" \
  "$(printf '%s\n' "$FACTS" | grep '^collision sessions ')"
check "two heavy runs at once are a collision" "collision heavy | 200, 300" \
  "$(printf '%s\n' "$FACTS" | grep '^collision heavy ')"
check "a pull request whose branch two orchestrations are on is a collision" \
  "collision pr | forge.example/o/app#7 | feat/x | Orch : alpha [aaa111], Orch : beta [bbb222]" \
  "$(printf '%s\n' "$FACTS" | grep '^collision pr ')"
check "the same branch in a repository nobody works in is no collision" "0" \
  "$(printf '%s\n' "$FACTS" | grep -c 'o/none')"
# A session sits on feat/x in o/other as in o/app: keyed on the branch alone, it would join
# the collisions above.
check "the same branch in two repositories does not collide" "0" \
  "$(printf '%s\n' "$FACTS" | grep '^collision ' | grep -c "o/other\|106 Agent\|$RO1")"
check "facts exits 1 on a collision" "exit 1" "$(cfacts_status facts)"

check "owners traces each open pull request to the orchestrator named in its agent's brief" \
  "pr forge.example/o/app#7 | feat/x | Orch : alpha [aaa111] | session 101 in $RA1|pr forge.example/o/app#7 | feat/x | Orch : beta [bbb222] | session 102 in $RB1|pr forge.example/o/app#8 | feat/y | unknown | session 103 in $RC1 names no orchestrator|pr forge.example/o/app#9 | feat/z | unknown | no checkout on feat/z|pr forge.example/o/app#10 | feat/w | unknown | no session in $RIDLE" \
  "$(printf '%s\n' "$OWNERS" | tr '\n' '|' | sed 's/|$//')"
check "owners exits 0 when every source was read" "exit 0" "$(cfacts_status owners)"

# Nothing shared: one session in a repository of its own, one run.
mkrepo "$CWS/lone/l1" feat/l git@forge.example:o/lone.git
printf '101 1 ttys101 /usr/bin/hostcli --name Agent : l1\n200 1 ttys100 bash ./tests/run-tests.sh\n' > "$CF/ps-quiet"
printf '101 %s\n200 %s\n' "$(real "$CWS/lone/l1")" "$RSRC" > "$CF/cwds-quiet"
check "no collision, exit 0 and no collision line" "exit 0|0" \
  "$(COORDINATOR_PS_TABLE="$CF/ps-quiet" COORDINATOR_CWDS="$CF/cwds-quiet" cfacts_status facts)|$(COORDINATOR_PS_TABLE="$CF/ps-quiet" COORDINATOR_CWDS="$CF/cwds-quiet" cfacts facts 2>/dev/null | grep -c '^collision ')"

# A detached checkout is on no branch, so it collides with nothing.
git -C "$CWS/app/b1" checkout -q --detach
check "a detached checkout collides with nothing" "0" \
  "$(cfacts facts 2>/dev/null | grep -c '^collision checkouts ')"
git -C "$CWS/app/b1" checkout -q feat/x

# A source that cannot be read makes the answer unknown, never « no collision »: said,
# and exit 2, with what was read still printed.
printf '#!/bin/bash\necho "cannot reach the forge" >&2\nexit 1\n' > "$CF/forge-down"
chmod +x "$CF/forge-down"
check "a forge that cannot be read is said, and exit 2" \
  "unread forge forge.example/o/app: cannot reach the forge|exit 2|exit 2" \
  "$(COORDINATOR_FORGE="$CF/forge-down" cfacts facts 2>/dev/null | grep '^unread forge forge.example/o/app')|$(COORDINATOR_FORGE="$CF/forge-down" cfacts_status facts)|$(COORDINATOR_FORGE="$CF/forge-down" cfacts_status owners)"
check "and the rest is still printed" "1" \
  "$(COORDINATOR_FORGE="$CF/forge-down" cfacts facts 2>/dev/null | grep -c '^collision checkouts ')"
check "a process table that cannot be read is said, and exit 2" "unread processes: $CF/no-ps cannot be read|exit 2" \
  "$(COORDINATOR_PS_TABLE="$CF/no-ps" cfacts facts 2>/dev/null | grep '^unread ')|$(COORDINATOR_PS_TABLE="$CF/no-ps" cfacts_status facts)"
# A session or a heavy run whose directory was not read is on no branch, so it would drop
# out of every collision unsaid: each one is an unread line, and so is lsof failing.
grep -v '^103 \|^300 ' "$CF/cwds" > "$CF/cwds-gap"
check "a session or a heavy run with no directory read is said, and exit 2" \
  "unread directory of session 103: no working directory read|unread directory of heavy run 300: no working directory read|exit 2" \
  "$(COORDINATOR_CWDS="$CF/cwds-gap" cfacts facts 2>/dev/null | grep '^unread directory ' | tr '\n' '|')$(COORDINATOR_CWDS="$CF/cwds-gap" cfacts_status facts)"
mkdir -p "$CF/bin-lsof"
printf '#!/bin/bash\necho "lsof: cannot read the kernel" >&2\nexit 1\n' > "$CF/bin-lsof/lsof"
chmod +x "$CF/bin-lsof/lsof"
clsof() {
  PATH="$CF/bin-lsof:$PATH" ORCHESTRATOR_STATE_DIR="$CS" ORCHESTRATOR_WORKSPACES="$CWS" ORCHESTRATOR_HOST_CLI=hostcli \
    COORDINATOR_PS_TABLE="$CF/ps" COORDINATOR_FORGE="$CF/forge" bash "$COORD" "$@"
}
check "an lsof that fails is said, and exit 2" "1|exit 2" \
  "$(clsof facts 2>/dev/null | grep -c '^unread directories: lsof failed: lsof: cannot read the kernel$')|$(clsof facts >/dev/null 2>&1; echo "exit $?")"

# git failing on a tree it should read drops that tree from every collision unsaid; a
# directory that is in no git tree at all is no failure, and its session line says so.
mkdir -p "$CF/bin-git"
printf '#!/bin/bash\nfor a in "$@"; do case "$a" in */app/a1*) echo "fatal: the index is corrupt" >&2; exit 128 ;; esac; done\nexec %s "$@"\n' \
  "$(command -v git)" > "$CF/bin-git/git"
chmod +x "$CF/bin-git/git"
CGIT=$(PATH="$CF/bin-git:$PATH" cfacts facts 2>/dev/null)
check "git failing on a session's directory and on a listed checkout is said" \
  "unread checkout $RA1: git failed on $RA1: fatal: the index is corrupt|unread directory of session 101: git failed on $RA1: fatal: the index is corrupt" \
  "$(printf '%s\n' "$CGIT" | grep '^unread ' | sort | tr '\n' '|' | sed 's/|$//')"
check "and facts exits 2" "exit 2" "$(PATH="$CF/bin-git:$PATH" cfacts_status facts)"
mkdir -p "$CF/nogit"
printf '120 1 ttys120 /usr/bin/hostcli --name Agent : n\n' > "$CF/ps-nogit"
printf '120 %s\n' "$(real "$CF/nogit")" > "$CF/cwds-nogit"
check "a session in no git tree says so on its line, and nothing is unread" \
  "session 120 | ttys120 | Agent : n | unknown | not a git tree | - | $(real "$CF/nogit")|0" \
  "$(COORDINATOR_PS_TABLE="$CF/ps-nogit" COORDINATOR_CWDS="$CF/cwds-nogit" cfacts facts 2>/dev/null | grep '^session ')|$(COORDINATOR_PS_TABLE="$CF/ps-nogit" COORDINATOR_CWDS="$CF/cwds-nogit" cfacts facts 2>/dev/null | grep -c '^unread ')"

# A brief is read where its session reads it: a relative path from the session's directory,
# not the coordinator's. A brief that exists and cannot be read is unread, never « names no
# orchestrator », which stays for a brief read that gives no address.
mkdir -p "$CWS/app/a1/notes"
printf 'Your orchestrator is the session **`Orch : gamma [ccc333]`** here.\n' > "$CWS/app/a1/notes/rel.md"
printf 'Your orchestrator is the session **`Orch : delta [ddd444]`** here.\n' > "$CF/briefs/locked.md"
chmod 000 "$CF/briefs/locked.md"
cat > "$CF/ps-brief" <<PS
110 1 ttys110 /usr/bin/hostcli Read and execute $CF/briefs/locked.md --name Agent : k
111 1 ttys111 /usr/bin/hostcli Read and execute notes/rel.md --name Agent : r
PS
printf '110 %s\n111 %s\n' "$RC1" "$RA1" > "$CF/cwds-brief"
cbrief() { COORDINATOR_PS_TABLE="$CF/ps-brief" COORDINATOR_CWDS="$CF/cwds-brief" cfacts "$@"; }
CBRIEF=$(cbrief facts 2>/dev/null)
check "a relative brief is read from its session's directory" \
  "session 111 | ttys111 | Agent : r | Orch : gamma [ccc333] | forge.example/o/app | feat/x | $RA1" \
  "$(printf '%s\n' "$CBRIEF" | grep '^session 111 ')"
check "a brief that cannot be read is said, its session unknown, and exit 2" \
  "unread brief $CF/briefs/locked.md: cannot be read|session 110 | ttys110 | Agent : k | unknown | forge.example/o/app | feat/y | $RC1|exit 2" \
  "$(printf '%s\n' "$CBRIEF" | grep '^unread brief ')|$(printf '%s\n' "$CBRIEF" | grep '^session 110 ')|$(cbrief facts >/dev/null 2>&1; echo "exit $?")"
check "and owners gives the unread brief as the reason, never « names no orchestrator »" \
  "pr forge.example/o/app#8 | feat/y | unknown | session 110 in $RC1: brief $CF/briefs/locked.md cannot be read" \
  "$(cbrief owners 2>/dev/null | grep '#8 ')"
chmod 600 "$CF/briefs/locked.md"

# owners says « unknown » where the chain allows two answers: a checkout on the branch with
# no session beside one with a session, two sessions of one checkout naming two
# orchestrators, and a pull request whose head is in a fork, whatever its branch is called.
mkrepo "$CWS/amb/v1" feat/v git@forge.example:o/amb.git
mkrepo "$CWS/amb/v2" feat/v git@forge.example:o/amb.git
mkrepo "$CWS/amb/d1" feat/d git@forge.example:o/amb.git
mkrepo "$CWS/amb/f1" feat/f git@forge.example:o/amb.git
RV1=$(real "$CWS/amb/v1"); RV2=$(real "$CWS/amb/v2"); RD1=$(real "$CWS/amb/d1"); RF1=$(real "$CWS/amb/f1")
cat > "$CF/ps-amb" <<'PS'
130 1 ttys130 /usr/bin/hostcli Your orchestrator is Orch : alpha [aaa111]. --name Agent : v1
131 1 ttys131 /usr/bin/hostcli Your orchestrator is Orch : alpha [aaa111]. --name Agent : d1
132 1 ttys132 /usr/bin/hostcli Your orchestrator is Orch : beta [bbb222]. --name Agent : d2
133 1 ttys133 /usr/bin/hostcli Your orchestrator is Orch : alpha [aaa111]. --name Agent : f1
PS
printf '130 %s\n131 %s\n132 %s\n133 %s\n' "$RV1" "$RD1" "$RD1" "$RF1" > "$CF/cwds-amb"
printf '#!/bin/bash\nprintf "11 feat/v same\\n12 feat/d same\\n13 feat/f fork:someone\\n"\n' > "$CF/forge-amb"
chmod +x "$CF/forge-amb"
camb() { COORDINATOR_PS_TABLE="$CF/ps-amb" COORDINATOR_CWDS="$CF/cwds-amb" COORDINATOR_FORGE="$CF/forge-amb" cfacts "$@"; }
check "owners says unknown for an idle checkout beside a busy one, two orchestrators in one checkout, and a fork" \
  "pr forge.example/o/amb#11 | feat/v | unknown | no session in $RV2, beside a session in $RV1|pr forge.example/o/amb#12 | feat/d | unknown | sessions 131, 132 in $RD1 name different orchestrators: Orch : alpha [aaa111], Orch : beta [bbb222]|pr forge.example/o/amb#13 | feat/f | unknown | head branch in a fork, owned by someone" \
  "$(camb owners 2>/dev/null | tr '\n' '|' | sed 's/|$//')"
check "two orchestrators in one checkout are still a pull request collision; a fork's is none" \
  "collision pr | forge.example/o/amb#12 | feat/d | Orch : alpha [aaa111], Orch : beta [bbb222]" \
  "$(camb facts 2>/dev/null | grep '^collision pr ')"
CT="$WORK/coord-tree/skills"
mkdir -p "$CT/coordinator/scripts" "$CT/orchestrator/scripts" "$CT/iterm-agents/scripts"
cp "$COORD" "$CT/coordinator/scripts/"
printf '#!/bin/bash\necho "workspace: cannot read the root" >&2\nexit 1\n' > "$CT/orchestrator/scripts/workspace.sh"
check "a workspace list that fails is said, and exit 2" "unread checkouts: workspace: cannot read the root|exit 2" \
  "$(ORCHESTRATOR_WORKSPACES="$CWS" ORCHESTRATOR_HOST_CLI=hostcli COORDINATOR_PS_TABLE="$CF/ps" COORDINATOR_CWDS="$CF/cwds" COORDINATOR_FORGE="$CF/forge" bash "$CT/coordinator/scripts/coordinator.sh" facts 2>/dev/null | grep '^unread ')|$(ORCHESTRATOR_WORKSPACES="$CWS" ORCHESTRATOR_HOST_CLI=hostcli COORDINATOR_PS_TABLE="$CF/ps" COORDINATOR_CWDS="$CF/cwds" COORDINATOR_FORGE="$CF/forge" bash "$CT/coordinator/scripts/coordinator.sh" facts >/dev/null 2>&1; echo "exit $?")"
cp "$ROOT/skills/orchestrator/scripts/workspace.sh" "$CT/orchestrator/scripts/workspace.sh"
# With no host name, no process is a session: an empty list read as « no collision ».
check "a host name that cannot be known is said, and exit 2" "unread sessions: the host's name is unknown: set ORCHESTRATOR_HOST_CLI|exit 2" \
  "$(env -u ORCHESTRATOR_HOST_CLI ORCHESTRATOR_WORKSPACES="$CWS" COORDINATOR_PS_TABLE="$CF/ps" COORDINATOR_CWDS="$CF/cwds" COORDINATOR_FORGE="$CF/forge" bash "$CT/coordinator/scripts/coordinator.sh" facts 2>/dev/null | grep '^unread ')|$(env -u ORCHESTRATOR_HOST_CLI ORCHESTRATOR_WORKSPACES="$CWS" COORDINATOR_PS_TABLE="$CF/ps" COORDINATOR_CWDS="$CF/cwds" COORDINATOR_FORGE="$CF/forge" bash "$CT/coordinator/scripts/coordinator.sh" facts >/dev/null 2>&1; echo "exit $?")"
# The host's name is the launcher's, read from it, never spelled in this script.
printf 'HOST_CLI = os.environ.get("ORCHESTRATOR_HOST_CLI", "hostcli")\n' > "$CT/iterm-agents/scripts/iterm_agent.py"
check "without ORCHESTRATOR_HOST_CLI the host's name is the launcher's default" "5" \
  "$(env -u ORCHESTRATOR_HOST_CLI ORCHESTRATOR_WORKSPACES="$CWS" COORDINATOR_PS_TABLE="$CF/ps" COORDINATOR_CWDS="$CF/cwds" COORDINATOR_FORGE="$CF/forge" bash "$CT/coordinator/scripts/coordinator.sh" facts 2>/dev/null | grep -c '^session ')"
check "the script never spells the host's name" "0" "$(grep -v 'CLAUDE_CONFIG_DIR' "$COORD" | grep -ci 'claude')"
check "an unknown subcommand is refused" "exit 1" "$(coord_status bogus)"

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
