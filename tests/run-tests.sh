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

# A live plugin load writes .claude-plugin/types/ and a root tsconfig.json into the
# checkout — generated files the sweeps below must not read and git must not track.


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
  ( cd "$ROOT" && grep -rniI 'claude' . --exclude-dir=.git --exclude-dir=__pycache__ --exclude-dir=.claude --exclude-dir=.superpowers --exclude-dir=plans --exclude-dir=types \
      --exclude=plan.md --exclude=CLAUDE.md --exclude=run-tests.sh --exclude=tsconfig.json \
    | grep -viE '~/\.claude/|\$HOME/\.claude|CLAUDE_CONFIG_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_CODE_SESSION_ID|ORCHESTRATOR_HOST_CLI|claude-orchestrator|\.claude-plugin|/\.claude/|\.claude\.json|claude-code/|LounisBou/claude-statusbar|LounisBou/claude-plugins-marketplace|/tmp/claude-|CLAUDE_CODE_TOTAL_TOKENS_REMINDER|CLAUDE_CODE_SILENT_TURN_REMINDER|CLAUDE_CODE_AUTO_COMPACT_WINDOW|syncClaudeAiSkills' || true )
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
hits=$(grep -rniIE '\b(opus|sonnet|haiku)\b' "$ROOT" --exclude-dir=.git --exclude-dir=__pycache__ --exclude-dir=.claude --exclude-dir=.superpowers --exclude-dir=plans --exclude-dir=types \
  --exclude=plan.md --exclude=CLAUDE.md --exclude=run-tests.sh --exclude=tsconfig.json || true)
check "no model family name in the plugin" "" "$hits"

# Nothing tied to one machine or one project enters the generic plugin: no absolute home
# path, no real session reference (the documented example is the six-hex placeholder
# a1b2c3), no path into a downstream project's tree.
hits=$(grep -rnIE '/Users/|/home/[a-z]|\[[0-9a-f]{6}\]|docs/reference/|BUGS\.md|IMPLEMENTATION\.md' "$ROOT" --exclude-dir=.git --exclude-dir=__pycache__ --exclude=.git --exclude-dir=.claude --exclude-dir=.superpowers --exclude=plan.md --exclude=run-tests.sh --exclude-dir=types --exclude=tsconfig.json \
  | grep -vE '\[a1b2c3\]' || true)
check "nothing project- or machine-specific in the plugin" "" "$hits"

# The namespace is the plugin's name, `orchestrator`: commands and skills are reached as
# /orchestrator:* and orchestrator:*. The former prefix must not come back in prose.
hits=$(grep -rnI 'claude-orchestrator:' "$ROOT" --exclude-dir=.git --exclude-dir=__pycache__ --exclude-dir=.superpowers --exclude=run-tests.sh || true)
check "the old command namespace is gone" "" "$hits"

# The operator manages the usage budget (ruling of 2026-10-10): no orchestrator or agent
# stops, throttles or drops a tier because of what it has consumed, nor proposes to. The
# words themselves are not banned: a bench trial records the gauge as a control
# (`quota_before`, `quota_after`), a manifest gives each trial a spending cap (`budget_usd`,
# `--budget-usd`, the host's `--max-budget-usd`), and the routing skill says the gauge stays
# out of the choice. What the guard catches is a line naming the usage budget or its 5-hour
# and 7-day windows together with stopping, throttling, dropping a tier or proposing one.
BUDGET_TERMS='five_hour|seven_day|budget|rate_limits|quota|5-hour|7-day|five-hour|seven-day|usage limit'
BUDGET_ACTIONS='stop|throttl|drop|downgrad|lower|pause|slow|propos|fall back|cheaper tier|lighter tier|switch|reduc|cheapest|ration|defer|cut back'
budget_hits() { # <root>
  ( cd "$1" && grep -rnIiE --exclude-dir=__pycache__ "$BUDGET_TERMS" skills commands templates hooks README.md docs/design.md 2>/dev/null \
    | sed -E 's/--max-budget-usd|--budget-usd|budget_usd|quota_before|quota_after|ORCHESTRATOR_QUOTA_FILE//g' \
    | grep -iE "$BUDGET_TERMS" | grep -iE "$BUDGET_ACTIONS" || true )
}
check "no stop, throttle or tier drop on the usage budget in the plugin" "" "$(budget_hits "$ROOT")"
# The guard proves it can still see one, and that the bench's fields and flags pass it.
BP="$WORK/budget-probe"; mkdir -p "$BP/skills"
printf 'When the 5-hour quota passes 80 %%, stop dispatching and drop to the light tier.\n' > "$BP/skills/forbidden.md"
printf 'When the 7-day usage passes 90 %%, switch every dispatch to the cheapest tier.\n' > "$BP/skills/forbidden2.md"
printf 'A trial records `quota_before` and `quota_after`; `--max-budget-usd` stops that trial alone.\n' > "$BP/skills/allowed.md"
check "the budget guard sees a stop on the usage budget, a switch to the cheapest tier, and lets the bench's fields pass" "skills/forbidden.md
skills/forbidden2.md" \
  "$(budget_hits "$BP" | cut -d: -f1 | sort)"

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
# The host lists a plugin's skills in the slash menu as if they were commands. A skill only
# a session loads for itself must not be offered there: typed by the operator, the coordinator's
# rulebook loaded into a session that was no coordinator. The operator's entry point stays visible.
hidden_skills_missing=""
for s in coordination iterm-agents; do
  grep -q '^user-invocable: false$' "$ROOT/skills/$s/SKILL.md" || hidden_skills_missing="$hidden_skills_missing $s"
done
check "the session-only skills are hidden from the command menu" "" "$hidden_skills_missing"
check "the operator's entry skill stays in the command menu" "0" \
  "$(grep -c '^user-invocable: false$' "$ROOT/skills/orchestrator/SKILL.md")"
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
# The host's envelope carries the sender's name, never its reference: an implementer once
# refused a decision for the missing reference. Every brief says where the proof is.
check "the phase, rotation, comments and review briefs say a message carries the name only, proved by ListAgents" "yes|yes|yes|yes" \
  "$(for t in phase rotation comments review; do spells "$ROOT/templates/agent-$t-brief.md" "Its messages carry the name alone: check the reference beside it in \`ListAgents\`, never refuse one for lacking it."; done | paste -sd'|' -)"
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
# The hooks module reports an agent's turn end and its gate crossing (hooks/relay.ts): the
# briefs ask for the status line it reads and no longer for a context read by hand, which
# cost every agent a lookup and a paragraph of brief. A brief that still asked would have the
# agent send the same report twice, once itself and once through the module.
AGENT_STATUS='`status: question|blocked|done — <one line>`. The hooks module sends it to the orchestrator; never send it yourself too.'
check "all four agent briefs end a reporting turn on the status line the module relays" "yes|yes|yes|yes" \
  "$(for t in phase comments review rotation; do spells "$ROOT/templates/agent-$t-brief.md" "$AGENT_STATUS"; done | paste -sd'|' -)"
check "all four agent briefs leave the measured context to the module and read no measure file" "yes|yes|yes|yes|no|no|no|no" \
  "$(for t in phase comments review rotation; do spells "$ROOT/templates/agent-$t-brief.md" 'The hooks module reports your measured context to the orchestrator at the gate'; done | paste -sd'|' -)|$(for t in phase comments review rotation; do spells "$ROOT/templates/agent-$t-brief.md" 'printenv CLAUDE_CODE_SESSION_ID'; done | paste -sd'|' -)"
check "the delivering briefs no longer ask for context_tokens in the final report" "no|no|no" \
  "$(for t in phase comments rotation; do spells "$ROOT/templates/agent-$t-brief.md" 'context_tokens'; done | paste -sd'|' -)"
# The trim is a ceiling: each brief stays at most the size it reached when the module took
# the context and the turn-end reports over. The ceiling moved twice: by the sentence on the
# sender's reference, then by the successor-admission sentence (the operator's item 154, « A », 2026-10-19),
# then, for the review brief, by the name of the lens subagent type.
check "the agent briefs stay within their trimmed sizes" "yes|yes|yes|yes" \
  "$(for pair in phase:8801 comments:6436 review:8143 rotation:2833; do [ "$(wc -c < "$ROOT/templates/agent-${pair%%:*}-brief.md" | tr -d ' ')" -le "${pair##*:}" ] && echo yes || echo no; done | paste -sd'|' -)"
# A chained push (`&&`, `;`, `cd … &&`) falls outside the permission rules and is refused.
check "the phase and comments briefs say a push runs as one bare command" "yes|yes" \
  "$(for t in phase comments; do spells "$ROOT/templates/agent-$t-brief.md" 'A push runs as one bare command, `git push -u origin {{BRANCH}}`, never chained to another command (`&&`, `;`, `cd … &&`): a chained push falls outside the permission rules and is refused.'; done | paste -sd'|' -)"
check "the orchestrator succession brief still says how to find its session id and directory" "yes" \
  "$(spells "$ROOT/templates/orchestrator-succession-brief.md" '`printenv CLAUDE_CODE_SESSION_ID` prints the id, `printenv CLAUDE_CONFIG_DIR` the directory')"
# review.md asks for each finding's proposed fix; the one-line finding keeps it as its last field.
check "the review brief's finding line ends with the proposed fix" "yes" \
  "$(spells "$ROOT/templates/agent-review-brief.md" '`[severity] file:line — the claim — the evidence in a few words — proposed fix`')"
check "the comments brief's end report carries the threads and their outcomes" "yes" \
  "$(spells "$ROOT/templates/agent-comments-brief.md" 'threads and their outcomes')"
# The successor always closes its predecessor, one started by hand included (the operator's
# standing order): nothing is asked of him, and where the host refuses the close of a tab the
# plugin did not open, the predecessor is asked to end its own session through the module.
# That end is proved on the tty, never on `list`, which keeps the row of a tab left holding a
# shell.
SUCC="$ROOT/templates/orchestrator-succession-brief.md"
SUCC4=$(awk '/^4\. /{f=1} /^5\. /{f=0} f' "$SUCC" | tr '\n' ' ' | tr -s ' ')
SUCC3=$(awk '/^3\. /{f=1} /^4\. /{f=0} f' "$SUCC" | tr '\n' ' ' | tr -s ' ')
succ3_has() { printf '%s' "$SUCC3" | grep -oF -- "$1" | wc -l | tr -d ' '; }
succ4_has() { printf '%s' "$SUCC4" | grep -oF -- "$1" | wc -l | tr -d ' '; }
check "the succession brief closes every predecessor and asks nothing" "1|1|1|0" \
  "$(succ4_has 'the successor ALWAYS closes its predecessor')|$(succ4_has 'a predecessor the launcher did not open (started by hand) included')|$(succ4_has 'call mcp__orchestrator__end_session')|$(succ4_has '« close it »')"
check "the end_session fallback is proved on the tty, not on list" "1|1|0" \
  "$(succ4_has '`verify --tty <its tty>` fails (no host on it)')|$(succ4_has '`ps -t <that tty without /dev/>` shows no host CLI')|$(succ4_has 'and `list` shows it gone; then tell')"
# The successor waits for « handed over » on a subscription the stop gate counts: without it,
# live, the gate refused that wait « Nothing will wake you ».
check "the successor subscribes to its predecessor's idle notice with « takeover confirmed »" "1" \
  "$(succ4_has 'message the predecessor "takeover confirmed" with `notify_when_idle: true`')"
check "the lifecycle closes a predecessor started by hand like any other" "1|0" \
  "$(grep -c 'is closed like any other, nothing asked' "$ORCH_REFS/lifecycle.md")|$(grep -c 'close it himself' "$ORCH_REFS/lifecycle.md")"
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
# 21,000 until the operator's order routed every question for him through a running coordinator:
# that rule binds wherever no reference is loaded, so it lives here, and the bound moved with it.
# 21,600 until the hooks module took the relay over: the bound follows the rule down.
# 21,450 until the module reported an agent's turn end and gate crossing too.
# 21,446 until the hand-over sentence naming the successor to the agents (item 154, « A », 2026-10-19).
check "the orchestrator rulebook stays at 21,518 bytes or fewer" "yes" \
  "$([ "$(wc -c < "$ROOT/skills/orchestrator/SKILL.md" | tr -d ' ')" -le 21518 ] && echo yes || echo no)"
# Real load on a shared machine is stopped, and « under load » means emulated throttling: the
# rulebook, the briefs reference and the phase brief template each carry the rule.
check "the rulebook stops real machine load an agent reports or plans" "yes" \
  "$(spells "$ROOT/skills/orchestrator/SKILL.md" 'is stopped at once, its processes killed, and the work redone under emulated throttling')"
check "the standing rules read « under load » as emulated throttling" "yes" \
  "$(spells "$ORCH_REFS/briefs.md" '**« Under load » means emulated throttling, never real load on the machine.**')"
check "the phase brief template reads « under load » as emulated throttling" "yes" \
  "$(spells "$ROOT/templates/agent-phase-brief.md" '« Under load » means emulated throttling, never real load on the machine')"
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
# A resident agent's own succession: the entry naming the caller's tab sits in its
# ORCHESTRATOR's chain, not in the caller's, so the hand-over above never reaches it. It must
# follow the successor, owner and mark kept, or the orchestrator reads a closed tab as its
# resident agent.
repoint() { ORCHESTRATOR_STATE_DIR="$WORK/istate" "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
print(m.chain_repoint_tab('41', '42', '/dev/ttys942'))" 2>&1; }
dropt() { ORCHESTRATOR_STATE_DIR="$WORK/istate" "$py" -c "
import sys; sys.path.insert(0, '$ROOT/skills/iterm-agents/scripts')
import iterm_agent as m
m.chain_drop_tab('41')" 2>&1; }
printf '{"tab_id": "40", "tty": "/dev/ttys940", "owner": "S-ORCH"}\n{"tab_id": "41", "tty": "/dev/ttys941", "owner": "S-ORCH", "resident": true}\n' > "$CHAINS/ttys899.jsonl"
printf '{"tab_id": "43", "tty": "/dev/ttys943", "owner": "S-OTHER"}\n' > "$CHAINS/ttys898.jsonl"
plain_before=$(sed -n 1p "$CHAINS/ttys899.jsonl")
other_before=$(cat "$CHAINS/ttys898.jsonl")
check "a successor's tab replaces the caller's in the chain that names it: one entry re-pointed" "1" "$(repoint)"
check "the entry names the new tab and tty, owner and mark kept" \
  '{"tab_id": "42", "tty": "/dev/ttys942", "owner": "S-ORCH", "resident": true}' \
  "$(sed -n 2p "$CHAINS/ttys899.jsonl")"
check "the other entry of that chain is byte-identical" "$plain_before" "$(sed -n 1p "$CHAINS/ttys899.jsonl")"
check "a chain with no entry for the tab is left alone, and returns 0" "0|$other_before" \
  "$(repoint | head -1)|$(cat "$CHAINS/ttys898.jsonl")"
printf '%s\n' "$other_before" > "$CHAINS/ttys898.jsonl"
check "the predecessor's close afterwards removes nothing" "2" "$(dropt; wc -l < "$CHAINS/ttys899.jsonl" | tr -d ' ')"
rm -f "$CHAINS/ttys899.jsonl" "$CHAINS/ttys898.jsonl"

check "an existing test's assertion is never edited to pass: brief rule, template, review item" "1|1|1" \
  "$(grep -c "An existing test's assertion is never edited to make it pass" "$ROOT/skills/orchestrator/references/briefs.md")|$(grep -c "Never edit an existing test's assertion to make it pass" "$ROOT/templates/agent-phase-brief.md")|$(grep -c "A diff that changes an existing test's assertions is read first" "$ROOT/skills/orchestrator/references/review.md")"

check "a TODO item of a pull request description is a task-list checkbox" "1" \
  "$(grep -c 'a TODO item is a task-list checkbox, `- \[ \] <step>`, never a bare `- ` bullet' "$ROOT/skills/orchestrator/references/briefs.md")"

check "a TODO item stands alone and is one action: brief rule, its own briefs, phase template" "yes|yes|yes|yes" \
  "$(spells "$ORCH_REFS/briefs.md" '**A TODO item stands alone and is one action**: written in full — the file, the value before and after, the host or environment — never by reference to another item')|$(spells "$ORCH_REFS/briefs.md" 'an edit and the step that applies it (reload, restart, deploy, migrate) are two checkboxes, never joined by « then » or « and run »')|$(spells "$ORCH_REFS/briefs.md" 'a brief names each TODO step the same way, in full, never by reference to another pull request or item')|$(spells "$ROOT/templates/agent-phase-brief.md" 'Each TODO item stands alone and is one action: written in full, never « the same edit », and an edit and its reload or restart are two checkboxes.')"

echo "== dispatch record =="

# The routing rule says a tier drop that costs a second corrective round is reverted for
# its class. Nothing measured that, so the rule could only ever be applied from memory —
# and an economy nobody measures is one that always looks free. One row per dispatch,
# and a summary that names the classes where the drop did not pay.
REC="$ROOT/skills/orchestrator/scripts/dispatch-record.sh"
R="$WORK/dispatch.jsonl"
# A build with no spec still writes its goals file, empty: `open` refuses without one.
bash "$REC" goals "$R" init --spec none >/dev/null

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

# A takeover only needs the open rows: `--open` prints them in the same line format and
# nothing else, while the statistics stay one plain `summary` away.
check "summary --open prints the open rows and nothing else" "open=1 label=plan after the round" \
  "$(bash "$REC" summary "$RO" --open)"
check "summary --open prints no class, signal, cascade or escape line" "0" \
  "$(bash "$REC" summary "$RO" --open | grep -c '^class=\|^signal=\|^cascade=\|^escapes=')"
check "plain summary still prints the class lines and the open rows" "2|1" \
  "$(bash "$REC" summary "$RO" | grep -c '^class=')|$(bash "$REC" summary "$RO" | grep -c '^open=')"
check_status "summary --open of an absent record is not an error" 0 bash "$REC" summary "$WORK/absent.jsonl" --open
check "summary --open of an absent record says so, as summary does" "dispatch-record: no record at $WORK/absent.jsonl" \
  "$(bash "$REC" summary "$WORK/absent.jsonl" --open)"
check "the succession brief's step 2 runs summary --open" "1" \
  "$(grep -c 'dispatch-record.sh summary {{DISPATCH_RECORD}} --open' "$ROOT/templates/orchestrator-succession-brief.md")"
check "the succession brief reads the goals by command and points at them" "yes|yes|yes" \
  "$(spells "$ROOT/templates/orchestrator-succession-brief.md" 'dispatch-record.sh goals {{DISPATCH_RECORD}} status')|$(spells "$ROOT/templates/orchestrator-succession-brief.md" '{{GOALS}}')|$(spells "$ROOT/templates/orchestrator-succession-brief.md" 'goals met=m/n')"
# Done is the spec's goals, said where each session reads it: the rulebook's machine line, the
# prerequisites, the decision round's announcement, and the routing skill's map rule.
check "the rulebook, the prerequisites, decide and the routing skill carry the goals and the map rule" "yes|yes|yes|yes|yes" \
  "$(spells "$ROOT/skills/orchestrator/SKILL.md" 'or waiting: done: every goal in `goals.md` met or ruled out by him)')|$(spells "$ORCH_REFS/briefs.md" 'and a `goals.md` beside the dispatch record, every goal of the spec in a phase or ruled out by the operator')|$(spells "$ROOT/commands/decide.md" '« N questions, back to back. Goals: m/n met, open: G3, G4. »')|$(spells "$ROOT/skills/model-routing/SKILL.md" "A pair \`pick\` returns for one class or one project goes in the brief, the record and \`calibrate\`'s project table, never in \`models.json\`")|$(spells "$ORCH_REFS/briefs.md" 'A plan section that moves goal work after the build is a goal without a phase: put it to him.')"

# Every subcommand registers its record under the session, by absolute path, once. The
# state directory is the hook's: the hook reads the same file for the same session id.
# The E2E line every passing `ready` below gives: a test the reviewer can replay.
E2EOK='E2E: tests/e2e/breadcrumb.spec.ts — npx playwright test tests/e2e/breadcrumb.spec.ts — passed'
RS="$WORK/rec-state"; RD="$WORK/rec-dir"; mkdir -p "$RD"
bash "$REC" goals "$RD/dispatch.jsonl" init --spec none >/dev/null
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
rec_with s-ready ready dispatch.jsonl 1 --head abcdef1234 --e2e "$E2EOK" >/dev/null
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

# The spec's goals, beside the record. A build was declared done against its plan while the
# plan had moved three of its spec's five goals « after the build », and no row was opened for
# them: done was never measured against the spec. `goals.md` holds the spec's goals once, each
# open, met with evidence a local read verifies, or ruled out in the operator's words.
GSPEC="$ROOT/tests/fixtures/goals/spec.md"
GAIM="every build measured against what its spec set out to reach"
GD="$WORK/goals-build"; GR="$GD/dispatch.jsonl"; GF="$GD/goals.md"
GREPO="$WORK/goals-repo"; mkdir -p "$GREPO"
git -C "$GREPO" init -q && git -C "$GREPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m one
GSHA=$(git -C "$GREPO" rev-parse HEAD); touch "$GREPO/table.json"
check "goals init writes the spec's five goals verbatim and the aim" "0|5|aim: $GAIM|yes|yes" \
  "$(bash "$REC" goals "$GR" init --spec "$GSPEC" --aim "$GAIM" --repo "$GREPO" >/dev/null 2>&1; echo $?)|$(grep -c '^| G[0-9] | open |' "$GF")|$(grep '^aim:' "$GF")|$(spells "$GF" '| G1 | open | The unit of choice is a **pair** `<alias>/<effort>`: a family alias and an effort level. |')|$(spells "$GF" 'one global table per language \| project kind.')"
check_status "an aim with one word altered dies" 1 bash "$REC" goals "$WORK/goals-aim/d.jsonl" init --spec "$GSPEC" --aim "every build measured against what its plan set out to reach"
printf '# No goals here\n\n## Why\n\nA reason.\n' > "$WORK/nogoals-spec.md"
check_status "a spec with no Goals list and no --goal dies" 1 bash "$REC" goals "$WORK/goals-nolist/d.jsonl" init --spec "$WORK/nogoals-spec.md"
check "the death names what to add" "1" "$(bash "$REC" goals "$WORK/goals-nolist/d.jsonl" init --spec "$WORK/nogoals-spec.md" 2>&1 | grep -c 'has no numbered list under « ## Goals »')"
GN="$WORK/goals-none/d.jsonl"
check "--spec none writes zero rows, and check exits 0" "0|0|0" \
  "$(bash "$REC" goals "$GN" init --spec none >/dev/null 2>&1; echo $?)|$(grep -c '^| G' "$WORK/goals-none/goals.md")|$(bash "$REC" goals "$GN" check >/dev/null 2>&1; echo $?)"
check_status "init over a file of another spec dies without --replace" 1 bash "$REC" goals "$GN" init --spec "$GSPEC" --aim "$GAIM"
check "init --replace archives the old file under its spec's stem" "0|yes|5" \
  "$(bash "$REC" goals "$GN" init --spec "$GSPEC" --aim "$GAIM" --replace >/dev/null 2>&1; echo $?)|$([ -f "$WORK/goals-none/goals-none.md" ] && echo yes || echo no)|$(grep -c '^| G[0-9] | open |' "$WORK/goals-none/goals.md")"
check_status "met with a path that does not exist dies" 1 bash "$REC" goals "$GR" met G1 --evidence nowhere/table.json
check_status "met with a commit git cannot resolve dies" 1 bash "$REC" goals "$GR" met G1 --evidence commit:0123456789abcdef
check_status "met with a pull request alone dies" 1 bash "$REC" goals "$GR" met G1 --evidence 'pr:#12'
check "met with a path that exists, or a commit that resolves, writes the row" "0|0|met|met" \
  "$(bash "$REC" goals "$GR" met G1 --evidence table.json --evidence 'pr:#12' >/dev/null 2>&1; echo $?)|$(bash "$REC" goals "$GR" met G2 --evidence "commit:${GSHA:0:10}" >/dev/null 2>&1; echo $?)|$(grep '^| G1 ' "$GF" | cut -d'|' -f3 | tr -d ' ')|$(grep '^| G2 ' "$GF" | cut -d'|' -f3 | tr -d ' ')"
check_status "rule-out without --ruling dies" 1 bash "$REC" goals "$GR" rule-out G4
check_status "rule-out with an empty quote dies" 1 bash "$REC" goals "$GR" rule-out G4 --ruling '« »'
check "check names the open goals and exits 1" "1|open: G3, G4, G5" \
  "$(bash "$REC" goals "$GR" check >/dev/null 2>&1; echo $?)|$(bash "$REC" goals "$GR" check 2>/dev/null | grep '^open:')"
bash "$REC" goals "$GR" plan G3 --phase "Phase 3" >/dev/null
bash "$REC" goals "$GR" met G3 --evidence table.json >/dev/null
bash "$REC" goals "$GR" met G5 --evidence table.json >/dev/null
bash "$REC" goals "$GR" rule-out G4 --ruling 'not this build, one project is enough for now' >/dev/null
check "every goal met or ruled out exits 0, and the ruling keeps his words" "0|yes" \
  "$(bash "$REC" goals "$GR" check >/dev/null 2>&1; echo $?)|$(spells "$GF" 'operator: « not this build, one project is enough for now »')"
check "a pipe in a goal round-trips through the file" "yes|0" \
  "$(spells "$GF" 'per language \| project kind.')|$(bash "$REC" goals "$GR" check >/dev/null 2>&1; echo $?)"
cp "$GF" "$WORK/goals-saved.md"
grep -v '^| G5 ' "$WORK/goals-saved.md" > "$GF"
check "four rows against the spec's five is a fault" "1|1" \
  "$(bash "$REC" goals "$GR" check >/dev/null 2>&1; echo $?)|$(bash "$REC" goals "$GR" check 2>/dev/null | grep -c "4 rows, the spec's Goals list 5")"
sed 's/a family alias and an effort level/a family alias/' "$WORK/goals-saved.md" > "$GF"
check "an edited goal text is a fault" "1|1" \
  "$(bash "$REC" goals "$GR" check >/dev/null 2>&1; echo $?)|$(bash "$REC" goals "$GR" check 2>/dev/null | grep -c "G1 is not the spec's text")"
sed 's/^| G4 | ruled-out | \(.*\) | operator: « .* » |$/| G4 | ruled-out | \1 | dropped |/' "$WORK/goals-saved.md" > "$GF"
check "a goal ruled out without his words is a fault" "1" \
  "$(bash "$REC" goals "$GR" check 2>/dev/null | grep -c "G4 ruled out without the operator's words")"
rm -f "$GREPO/table.json"; cp "$WORK/goals-saved.md" "$GF"
check "a met goal whose evidence left the disk is a fault" "1|1" \
  "$(bash "$REC" goals "$GR" check >/dev/null 2>&1; echo $?)|$(bash "$REC" goals "$GR" check 2>/dev/null | grep -c 'G1 met without evidence on disk: table.json does not exist')"
touch "$GREPO/table.json"
check "check --json is the stop gate's reading" "true|5" \
  "$(bash "$REC" goals "$GR" check --json 2>/dev/null | jq -r '.ok')|$(bash "$REC" goals "$GR" check --json 2>/dev/null | jq -r '.rows')"
check "a goals file that cannot be read exits 2" "2" "$(bash "$REC" goals "$WORK/goals-absent/d.jsonl" check --json >/dev/null 2>&1; echo $?)"

# `open` refuses without the goals, and names the line that writes them; warns on a goal no
# phase carries — the « after the build » deferral, said at every dispatch.
GO="$WORK/goals-open/d.jsonl"; mkdir -p "$WORK/goals-open"
check "open refuses with no goals.md and names the init line" "1|1" \
  "$(bash "$REC" open "$GO" --class x --tier light >/dev/null 2>&1; echo $?)|$(bash "$REC" open "$GO" --class x --tier light 2>&1 | grep -c "dispatch-record.sh goals $GO init --spec <path>|none")"
bash "$REC" goals "$GO" init --spec none >/dev/null
check "after init --spec none, open passes" "1" "$(bash "$REC" open "$GO" --class x --tier light 2>/dev/null)"
bash "$REC" goals "$GO" init --spec "$GSPEC" --aim "$GAIM" --replace >/dev/null
bash "$REC" goals "$GO" plan G1 --phase "Phase 1" >/dev/null
for g in G2 G3 G5; do bash "$REC" goals "$GO" plan "$g" --phase "Phase 2" >/dev/null; done
check "open warns on a goal in no phase, and prints the goals line with unplanned=" "1|0|1" \
  "$(bash "$REC" open "$GO" --class x --tier light 2>&1 >/dev/null | grep -c 'WARNING: G4 is in no phase and not ruled out: plan it or put it to the operator')|$(bash "$REC" open "$GO" --class x --tier light 2>&1 >/dev/null | grep -c 'G1 is in no phase')|$(bash "$REC" open "$GO" --class x --tier light 2>&1 >/dev/null | grep -c 'unplanned=G4$')"
check "status prints the aim, the table and the goals line" "aim: $GAIM|goals met=0/5 ruled_out=0 open=G1,G2,G3,G4,G5 unplanned=G4" \
  "$(bash "$REC" goals "$GO" status | head -1)|$(bash "$REC" goals "$GO" status | tail -1)"

# Every goals subcommand registers the record under the session, even before its first row.
GRS="$WORK/goals-rec-state"; GRD="$WORK/goals-rec"; GRDREAL=""
for sub in "init --spec none" "status" "check"; do
  sid="g-${sub%% *}"
  CLAUDE_CODE_SESSION_ID="$sid" ORCHESTRATOR_STATE_DIR="$GRS" bash "$REC" goals "$GRD/dispatch.jsonl" $sub >/dev/null 2>&1
  GRDREAL="$(cd "$GRD" && pwd -P)"
  check "goals ${sub%% *} registers the record" "$GRDREAL/dispatch.jsonl" "$(cat "$GRS/records/$sid" 2>/dev/null)"
done
bash "$REC" goals "$GRD/dispatch.jsonl" init --spec "$GSPEC" --aim "$GAIM" --replace >/dev/null
for sub in "plan G1 --phase P1" "met G1 --evidence $GSPEC" "rule-out G2 --ruling no" "reopen G2"; do
  sid="g-${sub%% *}"
  CLAUDE_CODE_SESSION_ID="$sid" ORCHESTRATOR_STATE_DIR="$GRS" bash "$REC" goals "$GRD/dispatch.jsonl" $sub >/dev/null 2>&1
  check "goals ${sub%% *} registers the record" "$GRDREAL/dispatch.jsonl" "$(cat "$GRS/records/$sid" 2>/dev/null)"
done
check "reopen puts the goal back open, its ruling cleared" "yes" "$(grep -q '^| G2 | open | .* |  |  |$' "$GRD/goals.md" && echo yes || echo no)"

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
check_status "ready refuses a row that does not say whether it changes a frontend surface" 1 bash "$REC" ready "$G" "$g1" --head aaa1111 --e2e "$E2EOK"
check "and names the subcommand that records it" "1" \
  "$(bash "$REC" ready "$G" "$g1" --head aaa1111 --e2e "$E2EOK" 2>&1 | grep -c 'ready: row 1 does not say whether its pull request changes a frontend surface: record it with `surface`')"
bash "$REC" surface "$G" "$g1" --none >/dev/null
check_status "ready warns, it does not refuse, a row no review has touched" 0 bash "$REC" ready "$G" "$g1" --head aaa1111 --e2e "$E2EOK"
check "and names what is missing" "1" \
  "$(bash "$REC" ready "$G" "$g1" --head aaa1111 --e2e "$E2EOK" 2>&1 | grep -c 'no review recorded on row')"
check "ready still prints its reading of the row" "1" \
  "$(bash "$REC" ready "$G" "$g1" --head aaa1111 --e2e "$E2EOK" 2>/dev/null | grep -c 'ready: row 1 has no review recorded yet; head aaa1111 is unverified')"

bash "$REC" review "$G" "$g1" --head aaa1111 --norms tool >/dev/null
check "a review records the head it read and its norms check" "aaa1111|tool" \
  "$(jq -r --argjson i "$g1" 'select(.id==$i)|[.review.head,.review.norms]|join("|")' "$G")"
check "a review counts as a round" "1" "$(jq -r --argjson i "$g1" 'select(.id==$i)|.rounds' "$G")"
check_status "ready passes at the head that review read" 0 bash "$REC" ready "$G" "$g1" --head aaa1111 --e2e "$E2EOK"

# The head moves on every corrective round, and the review that read the previous one says
# nothing about this one. This is the case the orchestrator talked itself past.
check_status "ready refuses a head no review has read" 1 bash "$REC" ready "$G" "$g1" --head bbb2222 --e2e "$E2EOK"
check "and names both heads" "1" \
  "$(bash "$REC" ready "$G" "$g1" --head bbb2222 --e2e "$E2EOK" 2>&1 | grep -c 'last review read aaa1111, head is bbb2222')"

bash "$REC" review "$G" "$g1" --head bbb2222 --norms none >/dev/null
check "the row keeps the LAST review, and the round is counted" "bbb2222|none|2" \
  "$(jq -r --argjson i "$g1" 'select(.id==$i)|[.review.head,.review.norms,.rounds]|join("|")' "$G")"
check "a review adds no row" "1" "$(wc -l < "$G" | tr -d ' ')"
check_status "a project shipping no norms tool still passes the gate" 0 bash "$REC" ready "$G" "$g1" --head bbb2222 --e2e "$E2EOK"

# `workspace.sh` prints short SHAs where a host API gives all forty: the same commit must not
# be refused for how it was spelled. Either side may abbreviate the other, from seven
# characters up; anything shorter identifies nothing, and no git call is made to check.
full=0123456789abcdef0123456789abcdef01234567
g2=$(bash "$REC" open "$G" --class behaviour-phase --tier standard --label "abbreviated")
bash "$REC" surface "$G" "$g2" --none >/dev/null
bash "$REC" review "$G" "$g2" --head 0123456 --norms tool >/dev/null
check_status "a short recorded head accepts the full head of the same commit" 0 bash "$REC" ready "$G" "$g2" --head "$full" --e2e "$E2EOK"
bash "$REC" review "$G" "$g2" --head "$full" --norms tool >/dev/null
check_status "a full recorded head accepts the short head of the same commit" 0 bash "$REC" ready "$G" "$g2" --head 0123456 --e2e "$E2EOK"
check_status "two heads sharing no prefix are refused" 1 bash "$REC" ready "$G" "$g2" --head fedcba9876543210fedcba9876543210fedcba98 --e2e "$E2EOK"
check "and are named" "1" \
  "$(bash "$REC" ready "$G" "$g2" --head fedcba9 --e2e "$E2EOK" 2>&1 | grep -c "last review read $full, head is fedcba9")"
check_status "a six-character head identifies nothing" 1 bash "$REC" ready "$G" "$g2" --head 012345 --e2e "$E2EOK"
check "and says so" "1" "$(bash "$REC" ready "$G" "$g2" --head 012345 --e2e "$E2EOK" 2>&1 | grep -c 'ready: head 012345 is too short')"

# The operator's process: ONE review round, the orchestrator's triage, ONE correction round
# the orchestrator verifies on the artifact, done. The correction moves the head, and the
# review that read the previous one must still let the pull request through at the head the
# orchestrator verified. `fixed` no longer refuses a row with no review, or a second
# correction round: it warns and records anyway, the way a project's own method may still
# forbid either.
g3=$(bash "$REC" open "$G" --class behaviour-phase --tier standard --label "one fix")
bash "$REC" surface "$G" "$g3" --none >/dev/null
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
check_status "ready passes at the fixed head" 0 bash "$REC" ready "$G" "$g3" --head ddd4444 --e2e "$E2EOK"
check "and says which reading it rests on" "1" \
  "$(bash "$REC" ready "$G" "$g3" --head ddd4444 --e2e "$E2EOK" 2>&1 | grep -c 'ready: row 3 reviewed at ccc3333, corrected and verified at ddd4444')"
check_status "the fixed head accepts its full spelling" 0 bash "$REC" ready "$G" "$g3" --head ddd4444abcdef --e2e "$E2EOK"
check_status "ready still passes at the reviewed head" 0 bash "$REC" ready "$G" "$g3" --head ccc3333 --e2e "$E2EOK"
check_status "ready refuses a head neither reviewed nor fixed" 1 bash "$REC" ready "$G" "$g3" --head eee5555 --e2e "$E2EOK"
check "and names all three heads" "1" \
  "$(bash "$REC" ready "$G" "$g3" --head eee5555 --e2e "$E2EOK" 2>&1 | grep -c 'last review read ccc3333, its correction ddd4444, head is eee5555')"
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
check_status "ready on an unknown row is an error" 1 bash "$REC" ready "$G" 99 --head aaa1111 --e2e "$E2EOK"
check "and names the row it did not find" "1" "$(bash "$REC" ready "$G" 99 --head aaa1111 --e2e "$E2EOK" 2>&1 | grep -c 'ready: no row with id 99')"
check_status "review on an unknown option is an error" 1 bash "$REC" review "$G" "$g1" --head ccc333 --norms tool --force
check_status "an unknown subcommand is an error" 1 bash "$REC" bogus "$G"
check "and names the subcommands it expects" "1" \
  "$(bash "$REC" bogus "$G" 2>&1 | grep -c 'unknown subcommand: bogus (expected open, round, review, fixed, surface, audit, ready, exempt, close, escaped, cost, summary or goals)')"

# The screenshots. Five front-office pull requests were declared ready without one image,
# under a rule written three times in prose. A `--ui` row reads its pull request's
# description and refuses ready while no image is there; `--minor` passes with its reason
# printed for the operator; a review round does not erase the surface.
S="$WORK/surface.jsonl"; SB="$WORK/surface-bin"; mkdir -p "$SB"
cat > "$SB/gh" <<'GH'
#!/bin/bash
# gh pr view <n> -R <repo> --json body -q .body: the body file named after the number.
[ "$1 $2" = "pr view" ] || exit 9
f="$SURFACE_BODIES/$3"; [ -f "$f" ] || { echo "no pull request $3" >&2; exit 1; }
cat "$f"
GH
chmod +x "$SB/gh"
export SURFACE_BODIES="$WORK/surface-bodies"; mkdir -p "$SURFACE_BODIES"
printf 'Adds the alert pop-up avatar.\n\n**Related PRs:** none\n' > "$SURFACE_BODIES/11"
printf 'Adds the avatar.\n\n![pop-up](https://github.com/user-attachments/assets/abc)\n' > "$SURFACE_BODIES/12"
printf 'Adds the avatar.\n\n<img width="600" alt="pop-up" src="https://github.com/user-attachments/assets/def" />\n' > "$SURFACE_BODIES/13"
srec() { env PATH="$SB:$PATH" bash "$REC" "$@"; }
s1=$(srec open "$S" --class behaviour-phase --tier standard --label "ui")
srec review "$S" "$s1" --head aaa1111 --norms tool >/dev/null
srec surface "$S" "$s1" --ui acme/front#11 >/dev/null
check "surface records the kind and the pull request" "ui|acme/front#11" \
  "$(jq -r --argjson i "$s1" 'select(.id==$i)|[.surface.kind,.surface.pr]|join("|")' "$S")"
check_status "ready refuses a frontend pull request with no image in its description" 1 srec ready "$S" "$s1" --head aaa1111 --e2e "$E2EOK"
check "and says why" "1" \
  "$(srec ready "$S" "$s1" --head aaa1111 --e2e "$E2EOK" 2>&1 | grep -c 'ready: acme/front#11 changes a frontend surface and its description carries no screenshot: not ready')"
srec surface "$S" "$s1" --ui acme/front#12 >/dev/null
srec audit "$S" "$s1" --head aaa1111 --images 1 >/dev/null
check_status "a markdown image passes" 0 srec ready "$S" "$s1" --head aaa1111 --e2e "$E2EOK"
check "and is counted on the ready line" "1" \
  "$(srec ready "$S" "$s1" --head aaa1111 --e2e "$E2EOK" 2>/dev/null | grep -c 'norms check tool; 1 screenshot(s) on acme/front#12')"
srec surface "$S" "$s1" --ui acme/front#13 >/dev/null
check_status "an uploaded HTML image passes" 0 srec ready "$S" "$s1" --head aaa1111 --e2e "$E2EOK"
srec review "$S" "$s1" --head bbb2222 --norms tool >/dev/null
check "a new review round keeps the surface" "ui|acme/front#13" \
  "$(jq -r --argjson i "$s1" 'select(.id==$i)|[.surface.kind,.surface.pr]|join("|")' "$S")"
srec surface "$S" "$s1" --ui acme/front#99 >/dev/null
check_status "a description that cannot be read is not ready" 1 srec ready "$S" "$s1" --head bbb2222 --e2e "$E2EOK"
check "and says the screenshots are unverified" "1" \
  "$(srec ready "$S" "$s1" --head bbb2222 --e2e "$E2EOK" 2>&1 | grep -c 'could not read the description of acme/front#99: its screenshots are unverified')"
srec surface "$S" "$s1" --minor "a label wording, nothing moves on screen" >/dev/null
check "a minor ruling passes and prints its reason for the operator" "1" \
  "$(srec ready "$S" "$s1" --head bbb2222 --e2e "$E2EOK" 2>/dev/null | grep -c 'frontend change ruled minor: a label wording, nothing moves on screen - tell the operator this reason with the ready')"
s2=$(srec open "$S" --class behaviour-phase --tier standard --label "no review yet")
srec surface "$S" "$s2" --ui acme/front#11 >/dev/null
check_status "the no-review warning does not let a frontend pull request with no image by" 1 srec ready "$S" "$s2" --head aaa1111 --e2e "$E2EOK"
check_status "surface without a kind is an error" 1 bash "$REC" surface "$S" "$s1"
check_status "surface with two kinds is an error" 1 bash "$REC" surface "$S" "$s1" --none --minor x
check_status "--ui needs <owner/repo>#<number>" 1 bash "$REC" surface "$S" "$s1" --ui 1520
check_status "--minor needs a reason" 1 bash "$REC" surface "$S" "$s1" --minor ""
check_status "surface on an unknown row is an error" 1 bash "$REC" surface "$S" 99 --none
check_status "surface on an unknown option is an error" 1 bash "$REC" surface "$S" "$s1" --skip
# The audit. Three captures that showed a defect were each read by an orchestrator and passed,
# because every check only counted the images. A `--ui` row is ready only with the
# orchestrator's own audit at a head `ready` accepts, covering every image, with no defect.
# A new audit replaces the last one; a review round keeps it; `--minor` and `--none` rows are
# not held to it.
printf 'Before and after.\n\n![before](https://github.com/user-attachments/assets/b1)\n![after](https://github.com/user-attachments/assets/a1)\n' > "$SURFACE_BODIES/14"
A="$WORK/audit.jsonl"
a1=$(srec open "$A" --class behaviour-phase --tier standard --label "audit")
srec surface "$A" "$a1" --ui acme/front#14 >/dev/null
srec review "$A" "$a1" --head aaa1111 --norms tool >/dev/null
check_status "ready refuses a --ui row with no audit recorded" 1 srec ready "$A" "$a1" --head aaa1111 --e2e "$E2EOK"
check "and names the subcommand that records it" "1" \
  "$(srec ready "$A" "$a1" --head aaa1111 --e2e "$E2EOK" 2>&1 | grep -c 'ready: no audit of the images on acme/front#14 is recorded: open each one, audit it, and record it with `audit <record> 1 --head <sha> --images <n>`')"
srec audit "$A" "$a1" --head aaa1111 --images 1 >/dev/null
check "audit records the head, the images and no defect" "aaa1111|1|0" \
  "$(jq -r --argjson i "$a1" 'select(.id==$i)|[.audit.head,.audit.images,(.audit.defects|length)]|join("|")' "$A")"
check "an audit is not a round" "1" "$(jq -r --argjson i "$a1" 'select(.id==$i)|.rounds' "$A")"
check_status "ready refuses an audit that opened fewer images than the description carries" 1 srec ready "$A" "$a1" --head aaa1111 --e2e "$E2EOK"
check "and names both counts" "1" \
  "$(srec ready "$A" "$a1" --head aaa1111 --e2e "$E2EOK" 2>&1 | grep -c 'ready: the audit opened 1 image(s), the description of acme/front#14 carries 2: audit every image')"
srec audit "$A" "$a1" --head aaa1111 --images 2 --defect "map button: icon off-centre, style unlike its neighbours" --defect "after: stray text in the search field" >/dev/null
check "a defect is recorded per --defect" "2" "$(jq -r --argjson i "$a1" 'select(.id==$i)|.audit.defects|length' "$A")"
check_status "ready refuses an audit that recorded a defect" 1 srec ready "$A" "$a1" --head aaa1111 --e2e "$E2EOK"
check "and names every defect" "1" \
  "$(srec ready "$A" "$a1" --head aaa1111 --e2e "$E2EOK" 2>&1 | grep -c 'ready: the audit of acme/front#14 recorded 2 defect(s): map button: icon off-centre, style unlike its neighbours; after: stray text in the search field. Fix each one, retake the capture, and audit again: not ready')"
srec audit "$A" "$a1" --head aaa1111 --images 2 >/dev/null
check "a new audit replaces the last, defects included" "aaa1111|2|0" \
  "$(jq -r --argjson i "$a1" 'select(.id==$i)|[.audit.head,.audit.images,(.audit.defects|length)]|join("|")' "$A")"
check_status "ready passes a clean audit of every image at the reviewed head" 0 srec ready "$A" "$a1" --head aaa1111 --e2e "$E2EOK"
check "and says the images were audited clean" "1" \
  "$(srec ready "$A" "$a1" --head aaa1111 --e2e "$E2EOK" 2>/dev/null | grep -c 'norms check tool; 2 screenshot(s) on acme/front#14, audited clean at aaa1111')"
srec audit "$A" "$a1" --head aaa1111 --images 3 >/dev/null
check_status "an audit that opened more images than the description carries passes" 0 srec ready "$A" "$a1" --head aaa1111 --e2e "$E2EOK"
srec fixed "$A" "$a1" --head bbb2222 >/dev/null
check_status "an audit at the reviewed head still passes at the fixed head" 0 srec ready "$A" "$a1" --head bbb2222 --e2e "$E2EOK"
srec audit "$A" "$a1" --head bbb2222 --images 2 >/dev/null
check_status "an audit at the fixed head passes there" 0 srec ready "$A" "$a1" --head bbb2222 --e2e "$E2EOK"
check_status "an audit at the fixed head passes at the reviewed head too" 0 srec ready "$A" "$a1" --head aaa1111 --e2e "$E2EOK"
srec audit "$A" "$a1" --head bbb2222abcdef --images 2 >/dev/null
check_status "an audit head spelled in full accepts the short head" 0 srec ready "$A" "$a1" --head bbb2222 --e2e "$E2EOK"
srec review "$A" "$a1" --head ccc3333 --norms tool >/dev/null
check "a new review round keeps the audit" "bbb2222abcdef|2" \
  "$(jq -r --argjson i "$a1" 'select(.id==$i)|[.audit.head,.audit.images]|join("|")' "$A")"
check_status "ready refuses an audit at a head it does not accept" 1 srec ready "$A" "$a1" --head ccc3333 --e2e "$E2EOK"
check "and names both heads" "1" \
  "$(srec ready "$A" "$a1" --head ccc3333 --e2e "$E2EOK" 2>&1 | grep -c 'ready: the images on acme/front#14 were audited at bbb2222abcdef, head is ccc3333: audit them again at the head in front of you')"
srec audit "$A" "$a1" --head ccc3333 --images 2 >/dev/null
check_status "an audit at the new head passes" 0 srec ready "$A" "$a1" --head ccc3333 --e2e "$E2EOK"
a2=$(srec open "$A" --class behaviour-phase --tier standard --label "audit, no review")
srec surface "$A" "$a2" --ui acme/front#14 >/dev/null
check_status "the no-review warning does not let a --ui row with no audit by" 1 srec ready "$A" "$a2" --head ddd4444 --e2e "$E2EOK"
srec audit "$A" "$a2" --head eee5555 --images 2 >/dev/null
check_status "with no review, an audit at another head is refused" 1 srec ready "$A" "$a2" --head ddd4444 --e2e "$E2EOK"
srec audit "$A" "$a2" --head ddd4444 --images 2 --defect "reset button on its own row" >/dev/null
check_status "with no review, a defect is still refused" 1 srec ready "$A" "$a2" --head ddd4444 --e2e "$E2EOK"
srec audit "$A" "$a2" --head ddd4444 --images 2 >/dev/null
check_status "with no review, a clean audit at the head in front lets the warning speak" 0 srec ready "$A" "$a2" --head ddd4444 --e2e "$E2EOK"
a3=$(srec open "$A" --class behaviour-phase --tier standard --label "minor")
srec review "$A" "$a3" --head aaa1111 --norms tool >/dev/null
srec surface "$A" "$a3" --minor "a label wording" >/dev/null
check_status "a --minor row needs no audit" 0 srec ready "$A" "$a3" --head aaa1111 --e2e "$E2EOK"
srec surface "$A" "$a3" --none >/dev/null
check_status "a --none row needs no audit" 0 srec ready "$A" "$a3" --head aaa1111 --e2e "$E2EOK"
srec audit "$A" "$a3" --head aaa1111 --images 1 --defect "an unrelated defect" >/dev/null
check_status "a --none row is not held to an audit's defect" 0 srec ready "$A" "$a3" --head aaa1111 --e2e "$E2EOK"
check_status "audit without --head is an error" 1 bash "$REC" audit "$A" "$a1" --images 2
check_status "audit with a head too short to identify a commit is an error" 1 bash "$REC" audit "$A" "$a1" --head abc123 --images 2
check_status "audit without --images is an error" 1 bash "$REC" audit "$A" "$a1" --head aaa1111
check_status "audit with --images 0 is an error" 1 bash "$REC" audit "$A" "$a1" --head aaa1111 --images 0
check_status "audit with --images not a number is an error" 1 bash "$REC" audit "$A" "$a1" --head aaa1111 --images two
check_status "audit with an empty --defect is an error" 1 bash "$REC" audit "$A" "$a1" --head aaa1111 --images 2 --defect ""
check_status "audit on an unknown row is an error" 1 bash "$REC" audit "$A" 99 --head aaa1111 --images 2
check_status "audit on an unknown option is an error" 1 bash "$REC" audit "$A" "$a1" --head aaa1111 --images 2 --clean
check "a refused audit leaves the last one in place" "ccc3333|2|0" \
  "$(jq -r --argjson i "$a1" 'select(.id==$i)|[.audit.head,.audit.images,(.audit.defects|length)]|join("|")' "$A")"
# The E2E line. A frontend pull request was merged and deployed and did not work there: its
# only proof was a browser pass the implementer reported, nothing a reviewer could replay, and
# nobody said « no E2E test ». `ready` takes the report's E2E line, never the pull request's
# description; silence is refused; `E2E: none — <reason>` passes only with the operator's
# dated validation of that pull request, or his dated exemption of the whole session.
E="$WORK/e2e/dispatch.jsonl"; mkdir -p "$WORK/e2e"
bash "$REC" goals "$E" init --spec none >/dev/null
e1=$(bash "$REC" open "$E" --class behaviour-phase --tier standard --label "e2e")
bash "$REC" surface "$E" "$e1" --none >/dev/null
bash "$REC" review "$E" "$e1" --head aaa1111 --norms tool >/dev/null
E2ENONE='E2E: none — a one-line config default, no environment worth bringing up'
check_status "ready refuses a row with no E2E line" 1 bash "$REC" ready "$E" "$e1" --head aaa1111
check "and says silence is not ready" "1" \
  "$(bash "$REC" ready "$E" "$e1" --head aaa1111 2>&1 | grep -c 'ready: row 1 gives no E2E line: pass the implementer.s report line, `--e2e "E2E: <test path(s)> — <command> — passed"` or `--e2e "E2E: none — <reason>"`; silence is not ready')"
check_status "an empty E2E line is refused" 1 bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e ""
check_status "a line not starting E2E: is refused" 1 bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e "tests passed"
check "and says what it must start with" "1" \
  "$(bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e "tests passed" 2>&1 | grep -c 'ready: the E2E line must start with `E2E:` and say something, got: tests passed')"
check_status "a bare E2E: is refused" 1 bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e "E2E:  "
check_status "a test line passes" 0 bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e "$E2EOK"
check "and the ready line states it for the operator" "1" \
  "$(bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e "$E2EOK" 2>/dev/null | grep -cF "norms check tool; no frontend surface; $E2EOK")"
check "the E2E line is recorded on the row" "$E2EOK|test|aaa1111" \
  "$(jq -r --argjson i "$e1" 'select(.id==$i)|[.e2e.line,.e2e.kind,.e2e.head]|join("|")' "$E")"
check_status "a waiver beside a test line is refused" 1 bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e "$E2EOK" --e2e-waiver "ok 2026-10-13"
check_status "E2E: none without the operator's validation is refused" 1 bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e "$E2ENONE"
check "and says to tell him and record his validation" "1" \
  "$(bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e "$E2ENONE" 2>&1 | grep -cF "ready: row 1 has no E2E test and the operator has not validated it ready without one: tell him « $E2ENONE », then record his validation with --e2e-waiver")"
e2=$(bash "$REC" open "$E" --class n-bis --tier light --label "no review"); bash "$REC" surface "$E" "$e2" --none >/dev/null
check_status "with no review, a test line lets the warning speak" 0 bash "$REC" ready "$E" "$e2" --head aaa1111 --e2e "$E2EOK"
check_status "the no-review warning does not let silence by" 1 bash "$REC" ready "$E" "$e2" --head aaa1111
check_status "the no-review warning does not let an unvalidated E2E: none by" 1 bash "$REC" ready "$E" "$e2" --head aaa1111 --e2e "$E2ENONE"
check_status "E2E: none without its reason is refused" 1 bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e "E2E: none" --e2e-waiver "ok 2026-10-13"
check_status "an undated waiver is refused" 1 bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e "$E2ENONE" --e2e-waiver "fine by me"
check_status "E2E: none with his dated validation passes" 0 bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e "$E2ENONE" --e2e-waiver "ready without E2E, ok - 2026-10-13"
check "and the ready line carries his words" "1" \
  "$(bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e "$E2ENONE" --e2e-waiver "ready without E2E, ok - 2026-10-13" 2>/dev/null | grep -cF "$E2ENONE (the operator validated it ready without E2E: ready without E2E, ok - 2026-10-13)")"
check "the waiver is recorded on the row" "none|ready without E2E, ok - 2026-10-13" \
  "$(jq -r --argjson i "$e1" 'select(.id==$i)|[.e2e.kind,.e2e.waiver]|join("|")' "$E")"
check_status "exempt without his words is an error" 1 bash "$REC" exempt "$E"
check_status "an undated exemption is refused" 1 bash "$REC" exempt "$E" --e2e "no E2E this session"
check "and nothing is recorded" "no" "$([ -e "$E.e2e-exempt" ] && echo yes || echo no)"
bash "$REC" exempt "$E" --e2e "no E2E tests for this session's PRs - 2026-10-13" >/dev/null
check "the exemption is recorded once beside the record" "no E2E tests for this session's PRs - 2026-10-13" "$(jq -r .words "$E.e2e-exempt")"
check_status "with the session exempted, E2E: none passes with no waiver" 0 bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e "$E2ENONE"
check "and the ready line names the exemption" "1" \
  "$(bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e "$E2ENONE" 2>/dev/null | grep -cF "(this session's pull requests exempted from E2E by the operator: no E2E tests for this session's PRs - 2026-10-13)")"
check_status "an exemption does not excuse silence" 1 bash "$REC" ready "$E" "$e1" --head aaa1111
check "the exemption is not a row" "2" "$(wc -l < "$E" | tr -d ' ')"
check_status "ready with an unknown option is an error" 1 bash "$REC" ready "$E" "$e1" --head aaa1111 --e2e "$E2EOK" --force
# The E2E rule in prose, where every brief, phase brief, review and review brief reads it: a
# backend test against a container, a frontend Playwright test committed, the `E2E: none —
# <reason>` line, silence not ready, nothing in the pull request's description, and the
# operator's validation or session exemption before `none` is ready.
BR="$ORCH_REFS/briefs.md"; PB="$ROOT/templates/agent-phase-brief.md"; RB="$ROOT/templates/agent-review-brief.md"; RV="$ORCH_REFS/review.md"
check "briefs.md carries the E2E rule for every phase" "yes|yes|yes|yes|yes|yes|yes" \
  "$(spells "$BR" "**Every pull request carries an E2E test the reviewer can replay, as far as one can be written — in every phase, not only the last.**")|$(spells "$BR" "Backend: the test runs against the service brought up in a container (docker, or the project's compose).")|$(spells "$BR" "Frontend: a Playwright test committed in the project's test tree")|$(spells "$BR" '`E2E: none — <reason>`, said plainly')|$(spells "$BR" "Silence is not allowed: a report with neither a test nor that line is not ready.")|$(spells "$BR" "Nothing about E2E goes in the description")|$(spells "$BR" "The exception is his exemption of every pull request of your session: then you decide alone, without telling him.")"
check "briefs.md holds a pull request without E2E to the operator's validation" "yes|yes" \
  "$(spells "$BR" "A pull request with no E2E test is not ready on your word: tell the operator « no E2E test — <reason> »")|$(spells "$BR" "it is ready once he has validated it ready without one.")"
check "the phase brief orders the E2E test and its report line" "yes|yes|yes|yes|yes" \
  "$(spells "$PB" "a backend change is tested against the service brought up in a container (docker, or the project's compose)")|$(spells "$PB" "a frontend change by a Playwright test committed in the project's test tree")|$(spells "$PB" '`E2E: none — <reason>`. Silence is not allowed: a report with neither is not ready.')|$(spells "$PB" "your E2E line (\`E2E: …\`, §4)")|$(spells "$PB" "its codified sections and nothing more: nothing about E2E.")"
check "the review brief replays the test or judges the reason, and flags silence" "yes|yes|yes|yes" \
  "$(spells "$RB" "its E2E line, from the implementer's report, never from the pull request's description")|$(spells "$RB" 'you replay that command (a targeted run, §5)')|$(spells "$RB" 'With `E2E: none — <reason>`, you judge the reason')|$(spells "$RB" "A report with no E2E line is a finding.")"
check "review.md item 14 holds the E2E gate and the operator's validation" "yes|yes|yes|yes|yes" \
  "$(spells "$RV" "14. **Every pull request carries an E2E test the reviewer replays, or says plainly it has none.**")|$(spells "$RV" "a backend test against the service brought up in a container, a frontend one a Playwright test committed in the project's test tree")|$(spells "$RV" "a report with no E2E line is a finding, and the pull request is not ready: silence is not allowed.")|$(spells "$RV" "A pull request with \`E2E: none\` is not ready on your word")|$(spells "$RV" 'you tell the operator « ready », with its E2E line')"
check "design.md mirrors the E2E gate under the ready gate" "yes" \
  "$(spells "$ROOT/docs/design.md" '`E2E: none` passes only with the operator'"'"'s validation of that pull request ready without one (`--e2e-waiver`')"
unset SURFACE_BODIES
check "the review reference records the surface before ready" "1" \
  "$(grep -c 'dispatch-record.sh surface <record> <id> --ui <owner/repo>#<n>' "$ROOT/skills/orchestrator/references/review.md")"
check "a screen with no data on the reference account is seeded, never skipped" "1|1|1" \
  "$(grep -c 'A screen the reference account has no data for is not minor and not skipped' "$ROOT/skills/orchestrator/references/review.md")|$(grep -c 'A screen the reference account has no data for is never minor' "$ROOT/skills/orchestrator/references/briefs.md")|$(grep -c 'seed the data on the local environment, and if you cannot, STOP' "$ROOT/templates/agent-phase-brief.md")"
check "the review brief reports the surface in one line" "1" \
  "$(grep -c 'frontend surface: yes|minor|no' "$ROOT/templates/agent-review-brief.md")"
VAUDIT='edges aligned with their neighbours; icons and text centred in their controls; no stray text left in an input; nothing truncated and nothing overflowing; no unexpected extra row or space; each control consistent with the controls beside it; both viewports'
check "the phase brief orders the visual audit of every capture before delivery" "yes|yes|yes" \
  "$(spells "$ROOT/templates/agent-phase-brief.md" "Before you deliver, audit every capture yourself, image by image, against this checklist: $VAUDIT.")|$(spells "$ROOT/templates/agent-phase-brief.md" 'Your report carries one line per image, `<image>: clean` or `<image>: <the defect>`.')|$(spells "$ROOT/templates/agent-phase-brief.md" 'A capture that shows a defect is not delivered: fix the defect, retake the capture, and audit it again.')"
check "the standing rule carries the audit, its checklist and the retake" "yes|yes|yes" \
  "$(spells "$ROOT/skills/orchestrator/references/briefs.md" "Every capture is audited by the implementer before delivery, image by image, against one checklist — $VAUDIT — and the report carries one line per image, clean or the defect it shows.")|$(spells "$ROOT/skills/orchestrator/references/briefs.md" 'A capture that shows a defect is not delivered: the defect is fixed and the capture retaken.')|$(spells "$ROOT/skills/orchestrator/references/briefs.md" 'The orchestrator audits each image again itself before its verdict')"
check "the review brief audits every image and makes each defect a finding" "yes|yes" \
  "$(spells "$ROOT/templates/agent-review-brief.md" "With \`yes\`, you also open and audit every image, one by one, against this checklist: $VAUDIT.")|$(spells "$ROOT/templates/agent-review-brief.md" 'and every defect is also a finding: a capture that shows a defect is never a pass')"
check "item 12: the orchestrator audits each image itself, and a defect is a finding" "yes|yes|yes" \
  "$(spells "$ROOT/skills/orchestrator/references/review.md" "Then open each image yourself and audit it, before the verdict, against the checklist the briefs carry: $VAUDIT.")|$(spells "$ROOT/skills/orchestrator/references/review.md" 'A defect you see on a capture is a finding, and the pull request is not ready')|$(spells "$ROOT/skills/orchestrator/references/review.md" 'dispatch-record.sh audit <record> <id> --head <sha> --images <n> [--defect "<text>"]...')"
check "the script's header and the design name the audit" "yes|yes" \
  "$(spells "$REC" '#   dispatch-record.sh audit   <record> <id> --head <sha> --images <n> [--defect "<text>"]...')|$(spells "$ROOT/docs/design.md" 'dispatch-record.sh audit <record> <id> --head <sha> --images <n> [--defect "<text>"]...')"
check "the record's subcommands list surface" "1" \
  "$(grep -c '^dispatch-record.sh surface <record> <id>' "$ROOT/skills/model-routing/SKILL.md")"

# A pair row names the alias and the effort it ran on, and carries what its sessions cost:
# rounds alone cannot say whether a lighter pair paid. The tier rows above print unchanged.
CSTATE="$WORK/cstate"; mkdir -p "$CSTATE/routing"
cp "$ROOT/tests/fixtures/routing/prices.json" "$CSTATE/routing/prices.json"
crec() { ORCHESTRATOR_STATE_DIR="$CSTATE" ORCHESTRATOR_PROJECTS_DIR="$ROOT/tests/fixtures/routing/projects" bash "$REC" "$@"; }
PR="$WORK/pairs.jsonl"
p1=$(crec open "$PR" --class behaviour-phase --model a-model --effort medium --label "p1")
check "a pair row carries model and effort" "a-model|medium|false|0" \
  "$(jq -r 'select(.id==1)|[.model,.effort,.explore,.cost_usd]|map(tostring)|join("|")' "$PR")"
crec cost "$PR" "$p1" --session s-1 >/dev/null
check "cost adds the session's measured cost to the row" "0.1701|s-1" \
  "$(jq -r 'select(.id==1)|[(.cost_usd*10000|round/10000|tostring), (.sessions|join(","))]|join("|")' "$PR")"
check "the same session twice is not counted twice" "0.1701" \
  "$(crec cost "$PR" "$p1" --session s-1 2>/dev/null; jq -r 'select(.id==1)|.cost_usd*10000|round/10000' "$PR")"
check "cost records the identifier the row's alias resolved to" "a-model-1" "$(jq -r '.["a-model"]' "$CSTATE/routing/aliases.json")"
crec close "$PR" "$p1" --verdict approved >/dev/null
check "summary prints the pair and its average cost" "1" \
  "$(crec summary "$PR" | grep -c '^class=behaviour-phase pair=a-model/medium dispatches=1 closed=1 rounds_avg=0 cost_avg=0.1701$')"
# A pair row with no effort ran on the host's default: it says so rather than print a pair cut short.
crec open "$WORK/pair-noeffort.jsonl" --class n-bis --model b-model >/dev/null
check "a pair row without an effort groups as the host's default" "1" \
  "$(crec summary "$WORK/pair-noeffort.jsonl" | grep -c '^class=n-bis pair=b-model/default dispatches=1 closed=0 rounds_avg=0$')"
check_status "open refuses an unknown effort" 1 crec open "$PR" --class x --model a-model --effort huge
check_status "open wants a tier or a model" 1 crec open "$PR" --class x
check_status "an effort without a model is refused" 1 crec open "$PR" --class x --tier light --effort low
check_status "an exploration without a model is refused" 1 crec open "$PR" --class x --tier light --explore
check_status "cost wants a session" 1 crec cost "$PR" "$p1"
check_status "cost of a session with no transcript is an error" 1 crec cost "$PR" "$p1" --session s-404
# A transcript with no assistant usage is a refusal, and the row is left as it was.
sessions_before=$(jq -c --argjson i "$p1" 'select(.id==$i)|.sessions' "$PR")
check_status "cost of a session with no usage is an error" 1 crec cost "$PR" "$p1" --session s-4
check "and the row's sessions are unchanged" "$sessions_before" \
  "$(jq -c --argjson i "$p1" 'select(.id==$i)|.sessions' "$PR")"
# An unpriced model leaves the row's cost incomplete, and the summary averages only rows
# whose cost is whole: a partial figure would rank a pair cheaper than it is.
# The incomplete row carries a positive partial cost (s-2 priced, s-3 not): the average
# must drop it on cost_incomplete, not because its cost happens to be zero.
p2=$(crec open "$PR" --class behaviour-phase --model a-model --effort medium)
crec cost "$PR" "$p2" --session s-2 >/dev/null
crec cost "$PR" "$p2" --session s-3 >/dev/null 2>&1
check "an unpriced session marks the row cost_incomplete, its priced one still counted" "true|s-2,s-3|0.028" \
  "$(jq -r --argjson i "$p2" 'select(.id==$i)|[(.cost_incomplete|tostring), (.sessions|join(",")), (.cost_usd*10000|round/10000|tostring)]|join("|")' "$PR")"
check "the unpriced session is listed as such" "s-3" "$(jq -r --argjson i "$p2" 'select(.id==$i)|.unpriced|join(",")' "$PR")"
# A price written later lets the unpriced session be counted: it is recounted, not refused,
# and the row is whole again. A copy of the row is used so the average below is unchanged.
RC="$WORK/recount.jsonl"; jq -c --argjson i "$p2" 'select(.id==$i)|.id=1' "$PR" > "$RC"
RCS="$WORK/rcstate"; mkdir -p "$RCS/routing"
jq '. + {"d-model-1": {"input": 1.0, "output": 5.0, "cache_write_5m": 1.25, "cache_write_1h": 2.0, "cache_read": 0.1}}' \
  "$ROOT/tests/fixtures/routing/prices.json" > "$RCS/routing/prices.json"
rcrec() { ORCHESTRATOR_STATE_DIR="$RCS" ORCHESTRATOR_PROJECTS_DIR="$ROOT/tests/fixtures/routing/projects" bash "$REC" "$@"; }
rcrec cost "$RC" 1 --session s-3 >/dev/null 2>&1
check "a session counted unpriced is recounted once priced, and the row is whole" "false|s-2,s-3||1" \
  "$(jq -r '[(.cost_incomplete|tostring), (.sessions|join(",")), (.unpriced|join(",")), (if .cost_usd > 0.028 then 1 else 0 end)]|map(tostring)|join("|")' "$RC")"
rc_before=$(jq -r '.cost_usd' "$RC")
check "a session counted with a figure is never counted twice" "$rc_before|1" \
  "$(rcrec cost "$RC" 1 --session s-3 2>/dev/null; jq -r '.cost_usd' "$RC")|$(rcrec cost "$RC" 1 --session s-3 2>&1 | grep -c 'already counted')"
# A row written before the list existed: incomplete with nothing counted reads as all unpriced.
printf '{"id":1,"class":"x","model":"a-model","effort":"low","rounds":0,"state":"open","cost_usd":0,"sessions":["s-3"],"cost_incomplete":true}\n' > "$WORK/legacy.jsonl"
rcrec cost "$WORK/legacy.jsonl" 1 --session s-3 >/dev/null 2>&1
check "a legacy incomplete row with nothing counted is recounted" "false|1" \
  "$(jq -r '[(.cost_incomplete|tostring), (if .cost_usd > 0 then 1 else 0 end)]|map(tostring)|join("|")' "$WORK/legacy.jsonl")"
# A row written before the list, incomplete with a figure counted (s-2 priced, s-3 not):
# which session was unpriced cannot be read, so it is refused without --recount and
# recounted with it, naming the session.
printf '{"id":1,"class":"x","model":"a-model","effort":"low","rounds":0,"state":"open","cost_usd":0.028,"sessions":["s-2","s-3"],"cost_incomplete":true}\n' > "$WORK/mixed.jsonl"
check "a mixed legacy row without --recount is not recounted, and says how" "0.028|1" \
  "$(rcrec cost "$WORK/mixed.jsonl" 1 --session s-3 2>&1 | grep -c 'takes --recount' >/dev/null; jq -r '.cost_usd' "$WORK/mixed.jsonl")|$(rcrec cost "$WORK/mixed.jsonl" 1 --session s-3 2>&1 | grep -c 'takes --recount')"
rcrec cost "$WORK/mixed.jsonl" 1 --session s-3 --recount >/dev/null 2>&1
check "--recount on a mixed legacy row counts the named session and makes the row whole" "false||1|s-2,s-3" \
  "$(jq -r '[(.cost_incomplete|tostring), (.unpriced|join(",")), (if .cost_usd > 0.028 then 1 else 0 end), (.sessions|join(","))]|map(tostring)|join("|")' "$WORK/mixed.jsonl")"
check_status "--recount on a row that keeps the list is refused" 1 rcrec cost "$WORK/mixed.jsonl" 1 --session s-3 --recount
check_status "--recount on a session the row does not count is refused" 1 rcrec cost "$WORK/legacy.jsonl" 1 --session s-9 --recount
crec close "$PR" "$p2" --verdict approved >/dev/null
check "an incomplete cost stays out of the average" "1" \
  "$(crec summary "$PR" | grep -c '^class=behaviour-phase pair=a-model/medium dispatches=2 closed=2 rounds_avg=0 cost_avg=0.1701$')"
# Exploration: a failed one freezes the class; three that close in one round promote the pair.
e1=$(crec open "$PR" --class conversion-phase --model a-model --effort low --explore)
crec round "$PR" "$e1" >/dev/null; crec round "$PR" "$e1" >/dev/null; crec close "$PR" "$e1" --verdict approved >/dev/null
check "an exploration that cost a corrective round freezes its class" "1" "$(crec summary "$PR" | grep -c '^frozen=conversion-phase$')"
for i in 1 2 3; do e=$(crec open "$PR" --class n-bis --model a-model --effort low --explore); crec round "$PR" "$e" >/dev/null; crec close "$PR" "$e" --verdict approved >/dev/null; done
check "three explorations closed in one round promote the pair" "1" "$(crec summary "$PR" | grep -c '^promote=n-bis a-model/low$')"
for i in 1 2 3; do e=$(crec open "$WORK/pair-noeffort.jsonl" --class n-bis --model b-model --explore); crec round "$WORK/pair-noeffort.jsonl" "$e" >/dev/null; crec close "$WORK/pair-noeffort.jsonl" "$e" --verdict approved >/dev/null; done
check "three explorations of a pair with no effort promote it as the host's default" "1" \
  "$(crec summary "$WORK/pair-noeffort.jsonl" | grep -c '^promote=n-bis b-model/default$')"
check "an escaped defect on an exploration freezes its class too" "1|0" \
  "$(crec escaped "$PR" "$e" >/dev/null; crec summary "$PR" | grep -c '^frozen=n-bis$')|$(crec summary "$PR" | grep -c '^promote=n-bis')"

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
# A review session in a pin lacked the project's instruction file, kept out by the global
# excludes: the pin carries the files `create` copies from them (§37), and still nothing the
# source's own exclude file or its settings directory holds — the orchestrator's material.
out=$(GIT_CONFIG_GLOBAL="$WORK/global-gitconfig" bash "$WS" pin "$SRC" round-ge main 2>"$WORK/wspinge.err")
PGE="$WORK/wsroot/proj/round-ge"
check "a pin carries the files the global excludes keep out, and reads clean" "$PGE|notes||1" \
  "$out|$(cat "$PGE/NOTES.local.md" 2>/dev/null)|$(GIT_CONFIG_GLOBAL="$WORK/global-gitconfig" git -C "$PGE" status --porcelain 2>/dev/null)|$(grep -c 'copied 1 files kept out by the global excludes' "$WORK/wspinge.err")"
check "and nothing the source's own exclude file or settings directory holds" "0|0|0" \
  "$([ -e "$PGE/LOCAL.md" ] && echo 1 || echo 0)|$([ -e "$PGE/.claude" ] && echo 1 || echo 0)|$([ -e "$PGE/plain.txt" ] && echo 1 || echo 0)"
check "such a pin deletes clean and the source forgets it" "deleted|0" \
  "$(GIT_CONFIG_GLOBAL="$WORK/global-gitconfig" bash "$WS" delete "$PGE" 2>/dev/null | cut -d' ' -f1)|$(git -C "$SRC" worktree list | grep -c round-ge)"

# Steps 1, 2 and 2b copy their lists in one pass each, never one process per file: a create
# listing 3,421 excluded files ran over four minutes at heavy system CPU on a shared server.
# mkmany <dir> <n>: a source whose settings directory, exclude file and global excludes each
# list about n files, nested, one name with a space, one path both excludes files name.
mkmany() {
  local d="$1" n="$2" i
  mkdir -p "$d" && ( cd "$d" && git init -q -b main && echo tracked > README.md && git add -A \
    && git -c user.email=t@local -c user.name=t commit -q -m "Set up" \
    && mkdir -p .claude/agents .claude/skills/deep/x .claude/cache data/a data/b/c logs \
    && echo '{}' > .claude/settings.local.json && echo c > .claude/cache/c && echo sp > ".claude/a b.md" \
    && echo sp > "data/b/c/with space.txt" && echo dup > data/a/dup.log \
    && printf '/.claude/\n/.claude/cache/\ndata/\n' > .git/info/exclude ) || return 1
  for i in $(seq 1 "$n"); do
    echo "$i" > "$d/.claude/agents/n$i.md"; echo "$i" > "$d/.claude/skills/deep/x/s$i.md"
    echo "$i" > "$d/data/a/f$i.txt"; echo "$i" > "$d/data/b/c/f$i.txt"; echo "$i" > "$d/logs/l$i.log"
  done
}
mkmany "$WORK/wsrc/many" 100
mkmany "$WORK/wsrc/few" 1
printf '*.log\n' > "$WORK/many-global-excludes"
printf '[core]\n\texcludesFile = %s\n' "$WORK/many-global-excludes" > "$WORK/many-gitconfig"
mkdir -p "$WORK/cpshim"
printf '#!/bin/bash\necho "$*" >> "%s"\nexec /bin/cp "$@"\n' "$WORK/cp-calls" > "$WORK/cpshim/cp"
chmod +x "$WORK/cpshim/cp"
: > "$WORK/cp-calls"
PATH="$WORK/cpshim:$PATH" GIT_CONFIG_GLOBAL="$WORK/many-gitconfig" bash "$WS" create "$WORK/wsrc/few" one-pass --base main >/dev/null 2>&1
few_cp=$(grep -c . "$WORK/cp-calls")
: > "$WORK/cp-calls"
PATH="$WORK/cpshim:$PATH" GIT_CONFIG_GLOBAL="$WORK/many-gitconfig" bash "$WS" create "$WORK/wsrc/many" one-pass --base main >/dev/null 2>"$WORK/wsmany.err"
MC="$WORK/wsroot/many/one-pass"
check "a create over many excluded files copies the same tree" \
  "Only in $WORK/wsrc/many/.claude: cache|Only in $WORK/wsrc/many/.claude: settings.local.json" \
  "$(diff -r -x .git "$WORK/wsrc/many" "$MC" 2>&1 | sort | paste -sd '|' -)"
check "and says the same counts" "1|1|1" \
  "$(grep -c 'settings directory (201 files, 1 skipped by the exclude file, 1 withheld' "$WORK/wsmany.err")|$(grep -c 'copied 202 excluded files' "$WORK/wsmany.err")|$(grep -c 'copied 100 files kept out by the global excludes' "$WORK/wsmany.err")"
check "the cp processes a create spawns do not grow with the file count" "$few_cp" "$(grep -c . "$WORK/cp-calls")"
# A file the copy cannot read fails the whole pass: the checkout is removed, the step named.
echo locked > "$WORK/wsrc/few/data/a/locked.txt" && chmod 000 "$WORK/wsrc/few/data/a/locked.txt"
check "a failed copy removes the checkout and names the step" "1|0|1" \
  "$(GIT_CONFIG_GLOBAL="$WORK/many-gitconfig" bash "$WS" create "$WORK/wsrc/few" locked --base main >/dev/null 2>"$WORK/wslocked.err"; echo $?)|$([ -e "$WORK/wsroot/few/locked" ] && echo 1 || echo 0)|$(grep -c 'create: copying the excluded files failed' "$WORK/wslocked.err")"
chmod 600 "$WORK/wsrc/few/data/a/locked.txt"

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

# A working directory the process table prints without a leading slash once sent the
# name walk into an endless loop: the delete never returned. A watchdog bounds the run.
mkdir -p "$WC/bin-relcwd"
printf '#!/bin/bash\nprintf "p1\\nfcwd\\nnrelative/dir\\np2\\nfcwd\\nn/\\n"\n' > "$WC/bin-relcwd/lsof"
chmod +x "$WC/bin-relcwd/lsof"
CR=$(mkclone "$WCSRC" del-r feat/del-r); HR=$(scratch "$CR")
env PATH="$WC/bin-relcwd:$PATH" perl -e 'alarm shift; exec @ARGV' 20 bash "$WS" delete "$CR" >/dev/null 2>&1; code=$?
check "a relative working directory in the process table does not hang the delete" "0|0" "$code|$(exists "$CR")"
rm -rf "$HR"

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
- Every report ends with your measured context, from the hooks module's measure file.
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

# A slash command is not a path: `/<plugin>:<command>`, with or without arguments.
ok_brief "$B/slash.md"; printf 'Run `/orchestrator:status`, then `/implement:phase 3`.\n' >> "$B/slash.md"
check_status "a slash command is not a path" 0 bash "$LINT" "$B/slash.md"
check "a slash command raises no path finding" "0" "$(bash "$LINT" "$B/slash.md" 2>&1 | grep -c 'path does not exist')"
ok_brief "$B/slashpath.md"; printf 'Run `/orchestrator:status`, read `/nowhere/at/all:x/spec.md`.\n' >> "$B/slashpath.md"
check "a path with a colon is still a path" "1" "$(bash "$LINT" "$B/slashpath.md" 2>&1 | grep -c 'path does not exist: /nowhere/at/all:x/spec.md')"
# The plugin's own commands are reached by their short names too, `/orchestrator-<name>` and
# `/coordinator[-<name>]`: no path either. A path under such a word is still a path.
ok_brief "$B/short.md"; printf 'Run `/orchestrator-status`, then `/coordinator`, `/coordinator-end` and `/orchestrator-sleeping drop Orch : x`.\n' >> "$B/short.md"
check_status "the plugin's short command names are not paths" 0 bash "$LINT" "$B/short.md"
check "they raise no path finding" "0" "$(bash "$LINT" "$B/short.md" 2>&1 | grep -c 'path does not exist')"
ok_brief "$B/shortpath.md"; printf 'Read `/orchestrator-x/y`.\n' >> "$B/shortpath.md"
check "a path that starts like a short name is still a path" "1" "$(bash "$LINT" "$B/shortpath.md" 2>&1 | grep -c 'path does not exist: /orchestrator-x/y')"

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
review_brief() { printf '# round 2\n\nYou are the REVIEW agent for this round.\n\nYour orchestrator is `p-1 [a1b2c3]`.\n' > "$1"; }

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

# The gauge-path check (lint check 8) retired with the context gauge's shell script: the
# module measures every session itself, in-process, and no brief cites a script any more.
# Its eleven cases — the missing path, the variable in its place, the review, comments and
# rotation briefs held to it, the prose-mention and non-goal clause readings — went with it.

# The class is the role declared at the start of a line, not the phrase anywhere: a review
# brief or a memo that quotes an implementer brief is not one.
review_brief "$B/review-quotes.md"
printf 'End the report with `norms-check: tool <head>`.\nThe phase brief opens with "You are the implementer for this phase." and the agent obeyed it.\n' >> "$B/review-quotes.md"
check_status "a review brief quoting the implementer line gets no implementer finding" 0 bash "$LINT" "$B/review-quotes.md"
printf '# memo\nThe brief said "You are the implementer for this phase." inline, and You are the REVIEW agent too.\n' > "$B/memo.md"
check_status "a memo quoting role lines inline is no agent brief" 0 bash "$LINT" "$B/memo.md"

# A pull request title the brief imposes is held to the operator's writing rule, 60
# characters: a longer one makes the implementer choose between the brief and the rule.
title_of() { printf 'x%.0s' $(seq 1 "$1"); }
ok_brief "$B/title-61.md"; printf -- '- Draft PR, title `%s`, base `main`.\n' "$(title_of 61)" >> "$B/title-61.md"
check_status "a 61-character imposed title is a finding" 1 bash "$LINT" "$B/title-61.md"
check "it is one finding, naming the length and the limit" "1" "$(bash "$LINT" "$B/title-61.md" 2>&1 | grep -c 'title is 61 characters, over the limit of 60')"
ok_brief "$B/title-60.md"; printf -- '- Draft PR, title `%s`, base `main`.\n' "$(title_of 60)" >> "$B/title-60.md"
check_status "a 60-character imposed title is not a finding" 0 bash "$LINT" "$B/title-60.md"
ok_brief "$B/title-none.md"; printf -- '- Draft PR, base `main`.\n' >> "$B/title-none.md"
check "a brief with no imposed title raises no title finding" "0" "$(bash "$LINT" "$B/title-none.md" 2>&1 | grep -c 'pull request title')"
ok_brief "$B/title-placeholder.md"; printf -- '- Draft PR, title `{{PR_TITLE}}`, base `main`.\n' >> "$B/title-placeholder.md"
check "an unfilled title placeholder is check 1's, not a title finding" "0" "$(bash "$LINT" "$B/title-placeholder.md" 2>&1 | grep -c 'pull request title')"

check "the phase brief template says the imposed title is at most 60 characters" "1" "$(grep -c 'title `{{PR_TITLE}}` (at most 60 characters)' "$ROOT/templates/agent-phase-brief.md")"

# The templates name no gauge script any more — the module's measure file replaced it,
# named in prose as a path under the configuration directory. What the lint must still say
# of them is that every path they DO name exists.
check "the shipped templates raise no missing-path finding" "0" \
  "$(for t in "$ROOT"/templates/*.md; do bash "$LINT" "$t" 2>&1; done | grep -c 'path does not exist')"

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
rm -rf "$TSET/coordination-trigger-01"
cp -R "$TSET/orchestrator-trigger-01" "$TSET/no-such-skill-trigger-01"
sed 's/max: 0/max: 1/' "$ROOT/trigger-evals/model-routing-no-trigger-01/graders/skill-not-loaded.md" \
  > "$TSET/model-routing-no-trigger-01/graders/skill-not-loaded.md"
sed 's/)?iterm-agents/)?model-routing/' "$ROOT/trigger-evals/iterm-agents-trigger-01/graders/skill-loaded.md" \
  > "$TSET/iterm-agents-trigger-01/graders/skill-loaded.md"
check "a case naming no skill, a grader of the wrong skill or bound, and a short side are each named" \
  "few:coordination:trigger:5|few:iterm-agents:trigger:5|few:model-routing:no-trigger:5|grader:iterm-agents-trigger-01|grader:model-routing-no-trigger-01|shape:model-routing-no-trigger-01|unknown:no-such-skill-trigger-01" \
  "$(trigger_set_drift "$TSET" "$ROOT/skills" | sort | tr '\n' '|' | sed 's/|$//')"

# One planted defect per requirement a case must meet to be able to fail. The context-gauge
# cases that carried three of them went with the skill; coordination carries them now.
FSET="$WORK/trigger-evals-shape"
cp -R "$ROOT/trigger-evals" "$FSET"
rm "$FSET/orchestrator-trigger-02/prompt.md"
sed -i.bak 's/^type: tool_used$/type: regex/' "$FSET/iterm-agents-trigger-02/graders/skill-loaded.md"
sed -i.bak 's/^tool: Skill$/tool: Read/' "$FSET/coordination-trigger-03/graders/skill-loaded.md"
sed -i.bak 's/^min: 1$/min: 1\
max: 3/' "$FSET/model-routing-trigger-04/graders/skill-loaded.md"
sed -i.bak '/^min: 0$/d' "$FSET/orchestrator-no-trigger-02/graders/skill-not-loaded.md"
rm "$FSET/coordination-no-trigger-02/graders/answered.md"
sed -i.bak '/^arm: both$/d' "$FSET/iterm-agents-no-trigger-03/graders/answered.md"
sed -i.bak '/^arm: both$/d' "$FSET/model-routing-no-trigger-04/graders/skill-not-loaded.md"
printf 'Use the model-routing skill for this.\n' >> "$FSET/orchestrator-no-trigger-05/prompt.md"
printf 'Then run /orchestrator:status.\n' >> "$FSET/iterm-agents-trigger-06/prompt.md"
printf 'Run rhythm.sh first.\n' >> "$FSET/coordination-trigger-04/prompt.md"
find "$FSET" -name '*.bak' -delete
check "a missing prompt, a grader of the wrong type, tool or bounds, a missing floor or arm, and a prompt naming the plugin are each named" \
  "arm:iterm-agents-no-trigger-03|arm:model-routing-no-trigger-04|floor:coordination-no-trigger-02|names:coordination-trigger-04|names:iterm-agents-trigger-06|names:orchestrator-no-trigger-05|prompt:orchestrator-trigger-02|shape:coordination-trigger-03|shape:iterm-agents-trigger-02|shape:model-routing-trigger-04|shape:orchestrator-no-trigger-02" \
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
check "the launch stays short whatever the prompt" "short" "$([ "${#cmd}" -lt 1000 ] && echo short || echo "${#cmd} chars typed")"
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
  "$(mcpd --account-connectors | sed -n 's/^launch=//p' | grep -Fc -- "--settings '{\"remoteControlAtStartup\":false,\"enableAllProjectMcpServers\":true,\"syncClaudeAiSkills\":false,\"awaySummaryEnabled\":false,\"env\":{\"CLAUDE_CODE_TOTAL_TOKENS_REMINDER\":\"off\",\"CLAUDE_CODE_SILENT_TURN_REMINDER\":\"0\",\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\":\"300000\"}}'")"
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
  "$(shaped --title 'Agent : x' | sed -n 's/^launch=//p' | grep -Fc -- "--settings '{\"remoteControlAtStartup\":false,\"syncClaudeAiSkills\":false,\"awaySummaryEnabled\":false,\"env\":{\"CLAUDE_CODE_TOTAL_TOKENS_REMINDER\":\"off\",\"CLAUDE_CODE_SILENT_TURN_REMINDER\":\"0\",\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\":\"300000\"}}'")|$(shaped --title 'Agent : x' | sed -n 's/^launch=//p' | grep -c -- '--remote-control')"
check "a successor carries the flag, and not the setting" "1|0" \
  "$(succ "$PSTAB" --successor | sed -n 's/^launch=//p' | grep -c -- "--remote-control 'Orch : f'")|$(succ "$PSTAB" --successor | sed -n 's/^launch=//p' | grep -c -- 'remoteControlAtStartup')"
check "--successor --no-remote-control carries the setting" "1" \
  "$(succ "$PSTAB" --successor --no-remote-control | sed -n 's/^launch=//p' | grep -Fc -- "--settings '{\"remoteControlAtStartup\":false,\"syncClaudeAiSkills\":false,\"env\":{\"CLAUDE_CODE_TOTAL_TOKENS_REMINDER\":\"off\",\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\":\"400000\"}}'")"
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
# The host keeps a session's current name in its registry, and a rename changes the
# registry, never argv: read from argv alone, a renamed orchestrator listed as « (host
# default) » and its successor was refused for having no name.
NCFG="$WORK/namecfg"; mkdir -p "$NCFG/sessions"
printf '/dev/ttys900 5151 claude --resume x\n' > "$WORK/ps-reg.txt"
printf '/dev/ttys900 5252 claude --name Agent : old\n' > "$WORK/ps-reg-argv.txt"
printf '{"pid":5151,"name":"\xe2\x80\x9cOrch : g\xe2\x80\x9d"}\n' > "$NCFG/sessions/5151.json"
printf '{"pid":5252,"name":""}\n' > "$NCFG/sessions/5252.json"
check "a registry file names the session, its quotes stripped" "Orch : g" \
  "$(CLAUDE_CONFIG_DIR="$NCFG" name_on "$WORK/ps-reg.txt" /dev/ttys900)"
check "an empty registry name falls back to the launch name" "Agent : old" \
  "$(CLAUDE_CONFIG_DIR="$NCFG" name_on "$WORK/ps-reg-argv.txt" /dev/ttys900)"
printf '{"pid":5252,"name":"Agent : renamed"}\n' > "$NCFG/sessions/5252.json"
check "and a registry name wins over the launch name" "Agent : renamed" \
  "$(CLAUDE_CONFIG_DIR="$NCFG" name_on "$WORK/ps-reg-argv.txt" /dev/ttys900)"
check "a successor of a session named only in the registry takes that name" "1" \
  "$(CLAUDE_CONFIG_DIR="$NCFG" succ "$WORK/ps-reg.txt" --successor | sed -n 's/^launch=//p' | grep -c -- "--name 'Orch : g'")"

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
AUDSTATE="$WORK/audstate"; AUDCFG="$WORK/audcfg"
# The auditor inherits the caller's model from the measure file, and that file is the
# module's own artifact: it is read under the config dir (CLAUDE_CONFIG_DIR, else the
# home's .claude), never under the state override, while the chains and prompts the same
# spawn touches still sit under the override.
mkdir -p "$AUDSTATE/chains" "$AUDCFG/claude-orchestrator/measure"
printf '{"context_tokens":21000,"context_window":200000,"context_percent":10,"model":"aud-model","updated_at":"2026-10-10T00:00:00Z"}\n' > "$AUDCFG/claude-orchestrator/measure/s-aud.json"
printf '{"tab_id":"7","tty":"/dev/ttys901","owner":"S-ME"}\n' > "$AUDSTATE/chains/ttys900.jsonl"
aud() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" CLAUDE_CONFIG_DIR="$AUDCFG" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-aud bash "$AGENT" spawn --dir "$WORK" --prompt p "$@" 2>&1; }
audl() { aud "$@" | sed -n 's/^launch=//p'; }
AUDOUT=$(aud --auditor --title 'Audit : tm')
AUDLAUNCH=$(printf '%s' "$AUDOUT" | sed -n 's/^launch=//p')
check "an auditor is named by its title and comes up under remote control under it" "1|1" \
  "$(printf '%s' "$AUDLAUNCH" | grep -c -- "--name 'Audit : tm'")|$(printf '%s' "$AUDLAUNCH" | grep -c -- "--remote-control 'Audit : tm'")"
check "and without the setting that turns remote control off" "0" "$(printf '%s' "$AUDLAUNCH" | grep -c -- 'remoteControlAtStartup')"
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
check "an auditor with no model on record is refused, naming the module's measure file" "1" \
  "$(CLAUDE_CODE_SESSION_ID=s-aud-none ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" bash "$AGENT" spawn --dir "$WORK" --auditor --title 'Audit : x' --prompt p 2>&1 | grep -c 'the hooks module writes the measure file')"
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
audsucc() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" CLAUDE_CONFIG_DIR="$AUDCFG" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-aud ORCHESTRATOR_PS_TABLE="${AUDPS:-$PSAUDTAB}" \
  bash "$AGENT" spawn --dir "$WORK" --prompt p "$@" 2>&1; }
AUDSUCCOUT=$(audsucc --successor --inherit-model --permission-mode auto)
AUDSUCCLAUNCH=$(printf '%s' "$AUDSUCCOUT" | sed -n 's/^launch=//p')
check "an auditor's successor takes the caller's name and comes up under remote control under it" "1|1|0" \
  "$(printf '%s' "$AUDSUCCLAUNCH" | grep -c -- "--name 'Audit : tm'")|$(printf '%s' "$AUDSUCCLAUNCH" | grep -c -- "--remote-control 'Audit : tm'")|$(printf '%s' "$AUDSUCCLAUNCH" | grep -c -- 'remoteControlAtStartup')"
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
  ORCHESTRATOR_STATE_DIR="$AUDSTATE" CLAUDE_CONFIG_DIR="$AUDCFG" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_SELF_ID=S-ME \
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
CRDSTATE="$WORK/crdstate"; CRDCFG="$WORK/crdcfg"
mkdir -p "$CRDSTATE/chains" "$CRDCFG/claude-orchestrator/measure"
printf '{"context_tokens":21000,"context_window":200000,"context_percent":10,"model":"crd-model","updated_at":"2026-10-10T00:00:00Z"}\n' > "$CRDCFG/claude-orchestrator/measure/s-crd.json"
printf '{"tab_id":"7","tty":"/dev/ttys901","owner":"S-ME"}\n' > "$CRDSTATE/chains/ttys900.jsonl"
crd() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" CLAUDE_CONFIG_DIR="$CRDCFG" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-crd bash "$AGENT" spawn --dir "$WORK" --prompt p "$@" 2>&1; }
crdl() { crd "$@" | sed -n 's/^launch=//p'; }
CRDOUT=$(crd --coordinator-successor --title 'Coord : ops')
CRDLAUNCH=$(printf '%s' "$CRDOUT" | sed -n 's/^launch=//p')
check "the coordinator's successor is named by its title and comes up under remote control under it" "1|1" \
  "$(printf '%s' "$CRDLAUNCH" | grep -c -- "--name 'Coord : ops'")|$(printf '%s' "$CRDLAUNCH" | grep -c -- "--remote-control 'Coord : ops'")"
check "and without the setting that turns remote control off" "0" "$(printf '%s' "$CRDLAUNCH" | grep -c -- 'remoteControlAtStartup')"
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
check "a coordinator-successor with no model on record is refused, naming the module's measure file" "1" \
  "$(CLAUDE_CODE_SESSION_ID=s-crd-none ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" bash "$AGENT" spawn --dir "$WORK" --coordinator-successor --title 'Coord : x' --prompt p 2>&1 | grep -c 'the hooks module writes the measure file')"
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
# A paused orchestrator is relaunched with --wake: its recorded name, model and effort, right
# of the caller, in no chain, under remote control. Nothing is guessed: no model, no wake.
WKOUT=$(crd --wake --title 'Orch : alpha' --model a-model --effort high)
WKLAUNCH=$(printf '%s' "$WKOUT" | sed -n 's/^launch=//p')
check "a wake runs under its recorded name, model and effort, under remote control" "1|1|1|1" \
  "$(printf '%s' "$WKLAUNCH" | grep -c -- "--name 'Orch : alpha'")|$(printf '%s' "$WKLAUNCH" | grep -c -- '--model a-model --effort high')|$(printf '%s' "$WKLAUNCH" | grep -c -- "--remote-control 'Orch : alpha'")|$(printf '%s' "$WKOUT" | grep -c '^wake=yes$')"
check "a wake lands right of its caller and joins no chain" "1|1|1" \
  "$(printf '%s' "$WKOUT" | grep -c '^side=right$')|$(printf '%s' "$WKOUT" | grep -c '^anchor=self$')|$(printf '%s' "$WKOUT" | grep -c '^chain=none$')"
check "a wake without the recorded model, or under another title, is refused" "1|1|1" \
  "$(crd --wake --title 'Orch : alpha' | grep -c 'a wake never guesses the model')|$(crd --wake --title 'Agent : alpha' --model m | grep -c -- '--wake needs the recorded name')|$(crd --wake --title 'Orch : alpha [abc123]' --model m >/dev/null 2>&1; echo $?)"
for WKFLAG in --successor --auditor '--right-of self' --title-free '--tier deep' --inherit-model --resident --no-remote-control; do
  # shellcheck disable=SC2086 # the flag and its value are two words on purpose
  check "a wake refuses $WKFLAG" "1|1" "$(crd --wake --title 'Orch : x' --model m $WKFLAG >/dev/null 2>&1; echo $?)|$(crd --wake --title 'Orch : x' --model m $WKFLAG | grep -c "is not a wake's")"
done
check "a wake beside --coordinator-successor is refused" "1" "$(crd --wake --coordinator-successor --title 'Orch : x' --model m >/dev/null 2>&1; echo $?)"
check "rotate refuses --wake" "1" "$(crdrot --old-tty /dev/ttys901 --wake | grep -c -- '--wake is not a rotation')"
# A new orchestrator opened on the operator's order: by a coordinator or an orchestrator only,
# read by the caller's name, right of it, in no chain, under remote control, on the deep tier
# unless told. An agent, an auditor or a session with no name never opens one.
OPSTATE="$WORK/opstate"; mkdir -p "$OPSTATE/chains"; OPPS="$WORK/ps-open.txt"
opn() { local caller="$1"; shift
  if [ "$caller" = - ]; then printf '/dev/ttys900 /opt/x/claude\n' > "$OPPS"
  else printf '/dev/ttys900 /opt/x/claude --name %s\n' "$caller" > "$OPPS"; fi
  ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="${OPST:-$OPSTATE}" CLAUDE_CONFIG_DIR="$CRDCFG" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-crd ORCHESTRATOR_PS_TABLE="$OPPS" ORCHESTRATOR_TIER_DEEP=deep-model \
  bash "$AGENT" spawn --dir "$WORK" --prompt p "$@" 2>&1; }
OPOUT=$(opn 'Coord : ops' --open --title 'Orch : sync logs')
OPLAUNCH=$(printf '%s' "$OPOUT" | sed -n 's/^launch=//p')
check "an opening by the coordinator runs under its title, on the deep tier, under remote control" "1|1|1|1" \
  "$(printf '%s' "$OPLAUNCH" | grep -c -- "--name 'Orch : sync logs'")|$(printf '%s' "$OPLAUNCH" | grep -c -- '--model deep-model')|$(printf '%s' "$OPLAUNCH" | grep -c -- "--remote-control 'Orch : sync logs'")|$(printf '%s' "$OPOUT" | grep -c '^open=yes$')"
check "an opened orchestrator lands right of its caller and joins no chain" "1|1|1" \
  "$(printf '%s' "$OPOUT" | grep -c '^side=right$')|$(printf '%s' "$OPOUT" | grep -c '^anchor=self$')|$(printf '%s' "$OPOUT" | grep -c '^chain=none$')"
check "an orchestrator opens one too, and a model it names wins over the tier" "1|1" \
  "$(opn 'Orch : gateway' --open --title 'Orch : x' | grep -c '^open=yes$')|$(opn 'Orch : gateway' --open --title 'Orch : x' --model a-model | sed -n 's/^launch=//p' | grep -c -- '--model a-model')"
check "an agent, an auditor or a session with no name never opens one" "1|1|1|1" \
  "$(opn 'Agent : x' --open --title 'Orch : x' >/dev/null 2>&1; echo $?)|$(opn 'Agent : x' --open --title 'Orch : x' | grep -c 'an agent never opens an orchestrator')|$(opn 'Audit : x' --open --title 'Orch : x' | grep -c 'an agent never opens an orchestrator')|$(opn - --open --title 'Orch : x' | grep -c "this session reads 'no name'")"
OPREC="$WORK/opstate-rec"; mkdir -p "$OPREC/chains"
printf '{"name":"Coord : hand","tty":"/dev/ttys900"}\n' > "$OPREC/coordinator.json"
check "a coordinator opened by hand, named only by its own record, opens one" "1" \
  "$(OPST="$OPREC" opn - --open --title 'Orch : x' | grep -c '^open=yes$')"
check "an opening needs an orchestrator's title, with no reference" "1|1" \
  "$(opn 'Coord : ops' --open --title 'Agent : x' | grep -c -- "--open needs the new orchestrator's name")|$(opn 'Coord : ops' --open --title 'Orch : x [abc123]' >/dev/null 2>&1; echo $?)"
for OPFLAG in --successor --auditor --wake '--right-of self' '--left-of /dev/ttys555' --title-free --resident --no-remote-control; do
  # shellcheck disable=SC2086 # the flag and its value are two words on purpose
  check "an opening refuses $OPFLAG" "1|0" "$(opn 'Coord : ops' --open --title 'Orch : x' $OPFLAG >/dev/null 2>&1; echo $?)|$(opn 'Coord : ops' --open --title 'Orch : x' $OPFLAG | grep -c '^launch=')"
done
check "rotate refuses --open" "1" "$(crdrot --old-tty /dev/ttys901 --open | grep -c -- '--open is not a rotation')"
check "a tier the opening names wins over the deep default" "1" \
  "$(ORCHESTRATOR_TIER_STANDARD=std-model opn 'Coord : ops' --open --title 'Orch : x' --tier standard | sed -n 's/^launch=//p' | grep -c -- '--model std-model')"
# Outside a dry run the caller is read from the real process table: the suite's two
# stand-ins would let any session name itself the coordinator. The directory does not
# exist, so a launcher that let the stand-ins through still stops short of a tab.
check "outside a dry run, an opening refuses the suite's stand-ins for the caller" "1|1" \
  "$(env -u ORCHESTRATOR_DRY_RUN ORCHESTRATOR_STATE_DIR="$OPSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_PS_TABLE="$OPPS" bash "$AGENT" spawn --open --title 'Orch : x' --dir "$WORK/no-such-dir" --prompt p 2>&1 | grep -c 'are for tests and dry runs')|$(env -u ORCHESTRATOR_DRY_RUN ORCHESTRATOR_STATE_DIR="$OPSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 bash "$AGENT" spawn --open --title 'Orch : x' --dir "$WORK/no-such-dir" --prompt p 2>&1 | grep -c 'are for tests and dry runs')"
check "the coordination skill opens on his order, by the bare command, and relays it to another machine" "yes|yes|yes|yes|yes" \
  "$(spells "$ROOT/skills/coordination/SKILL.md" 'operator told you to open, pause or wake')|$(spells "$ROOT/skills/coordination/SKILL.md" 'spawn --open --title "Orch : <subject>"')|$(spells "$ROOT/skills/coordination/SKILL.md" 'answer that he should do it himself')|$(spells "$ROOT/skills/coordination/SKILL.md" 'Run it alone, never chained to another command')|$(spells "$ROOT/skills/coordination/SKILL.md" 'Never ask a session to change')"
check "an orchestrator runs a relayed opening and never edits its own permissions" "yes|yes|yes" \
  "$(spells "$ORCH_REFS/lifecycle.md" "**An opening, on the operator's word.**")|$(spells "$ORCH_REFS/lifecycle.md" 'iterm-agent.sh spawn --open --title "Orch : <subject>"')|$(spells "$ORCH_REFS/lifecycle.md" 'You never edit your own permissions')"
check "an agent's tab still rotates without --force" "1" "$(crdrot --old-tty /dev/ttys901 | tail -1 | grep -c '^close=/dev/ttys901')"
# The first coordinator is opened by hand and names itself through a rename, which never
# reaches argv: named only in the host registry, or only in the coordinator's own record,
# its tab is still not an agent to rotate or to move.
CRDREGCFG="$WORK/crdregcfg"; mkdir -p "$CRDREGCFG/sessions"
printf '{"pid":6161,"name":"Coord : hand"}\n' > "$CRDREGCFG/sessions/6161.json"
printf '/dev/ttys951 6161 claude --resume x\n/dev/ttys952 6262 claude --resume y\n' > "$WORK/ps-coord-reg.txt"
crdregrot() { CLAUDE_CONFIG_DIR="$CRDREGCFG" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$1" ORCHESTRATOR_PS_TABLE="$WORK/ps-coord-reg.txt" \
  bash "$AGENT" rotate --dir "$WORK" --title "Agent : rotated" --prompt p --old-tty "$2" 2>&1; }
CRDREGROT=$(crdregrot "$CRDSTATE" /dev/ttys951)
check "rotate refuses a coordinator named only in the host registry" "0|1" \
  "$(printf '%s' "$CRDREGROT" | grep -c '^launch=')|$(printf '%s' "$CRDREGROT" | grep -c "rotate: refused: /dev/ttys951 is the coordinator's tab ('Coord : hand')")"
CRDRECSTATE="$WORK/crdrecstate"; mkdir -p "$CRDRECSTATE"
printf '{"name":"Coord : rec [abc123]","tty":"/dev/ttys952"}\n' > "$CRDRECSTATE/coordinator.json"
CRDRECROT=$(crdregrot "$CRDRECSTATE" /dev/ttys952)
check "rotate refuses the tty the coordinator's record registers" "0|1" \
  "$(printf '%s' "$CRDRECROT" | grep -c '^launch=')|$(printf '%s' "$CRDRECROT" | grep -c "rotate: refused: /dev/ttys952 is the coordinator's tab ('Coord : rec \[abc123\]')")"
check "and move names it, forced or not" "1|1" \
  "$(CLAUDE_CONFIG_DIR="$CRDREGCFG" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDRECSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_SELF_ID=S-ME ORCHESTRATOR_PS_TABLE="$WORK/ps-coord-reg.txt" bash "$AGENT" move --tty /dev/ttys952 --right-of self 2>&1 | grep -c "move: refused: /dev/ttys952 is the coordinator's tab")|$(CLAUDE_CONFIG_DIR="$CRDREGCFG" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDRECSTATE" ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_SELF_ID=S-ME ORCHESTRATOR_PS_TABLE="$WORK/ps-coord-reg.txt" bash "$AGENT" move --tty /dev/ttys952 --right-of self --force 2>&1 | grep -c "^move: forced: /dev/ttys952 is the coordinator's tab")"
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
# One exception, the operator's order: the rulebook and the decision round route a question for
# him through a running coordinator. They name it in that one paragraph and nowhere else.
coordinator_named_in() { # <root>
  ( cd "$1" && grep -rln -i --exclude-dir=__pycache__ 'coordinat' skills/orchestrator skills/iterm-agents/SKILL.md skills/iterm-agents/references templates/agent-*.md templates/orchestrator-succession-brief.md commands/succeed.md commands/audit.md | grep -v '^skills/orchestrator/SKILL.md$' )
}
check "no orchestrator, launcher or brief-template text names the coordinator" "" \
  "$(coordinator_named_in "$ROOT")"
# A byte-compiled script left under __pycache__ by an earlier run is not text of the plugin:
# the verdict is the same whether or not one lies in the tree.
PYC="$WORK/pycache-trap"
mkdir -p "$PYC/skills" "$PYC/templates" "$PYC/commands"
cp -R "$ROOT/skills/orchestrator" "$ROOT/skills/iterm-agents" "$PYC/skills/"
cp "$ROOT"/templates/agent-*.md "$ROOT/templates/orchestrator-succession-brief.md" "$PYC/templates/"
cp "$ROOT/commands/succeed.md" "$ROOT/commands/audit.md" "$PYC/commands/"
mkdir -p "$PYC/skills/orchestrator/scripts/__pycache__"
printf 'x\0coordinat\0' > "$PYC/skills/orchestrator/scripts/__pycache__/draft_guard.cpython-311.pyc"
check "a stray __pycache__ does not change the coordinator check" "" "$(coordinator_named_in "$PYC")"
rm -rf "$PYC"
coord_outside_routing() {
  awk 'BEGIN { RS = "" } { p = $0; gsub(/(^|\n)allowed-tools:[^\n]*/, "", p) }
    tolower(p) ~ /coordinat/ && p !~ /^\*\*While a coordinator runs/ { print FILENAME }' "$@"
}
check "the rulebook and the decision round name the coordinator only to route a question" "" \
  "$(cd "$ROOT" && coord_outside_routing skills/orchestrator/SKILL.md commands/decide.md)"
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
# The short names (the operator's ruling of 2026-10-24): every command answers to `/<name>`
# by the `name:` of its frontmatter, the coordinator's `coordinator-…`, the others
# `orchestrator-…`. The host hands a hook `orchestrator:<name>` whichever form was typed, so a
# name lost silences the hook that matches it; and a command file the table does not know is
# one whose short name nobody chose. The pane answers to both roles' names, one body twice.
COMMAND_NAMES='agents:orchestrator-agents audit:orchestrator-audit calibrate:orchestrator-calibrate coordinator:coordinator coordinator-decide:coordinator-decide coordinator-end:coordinator-end coordinator-supervision:coordinator-supervision decide:orchestrator-decide install:orchestrator-install progress:orchestrator-progress sleeping:orchestrator-sleeping status:orchestrator-status succeed:orchestrator-succeed supervision:orchestrator-supervision uninstall:orchestrator-uninstall'
short_names_missing() {  # <commands dir>: one line per command without its short name, or unknown
  local pair f stem
  for pair in $COMMAND_NAMES; do
    f="$1/${pair%%:*}.md"
    [ "$(awk 'NR == 1 { next } /^---$/ { exit } { print }' "$f" 2>/dev/null | sed -n 's/^name: //p')" = "${pair#*:}" ] || echo "missing:${pair%%:*}"
  done
  for f in "$1"/*.md; do
    stem=$(basename "$f" .md)
    case " $COMMAND_NAMES " in *" $stem:"*) ;; *) echo "unknown:$stem" ;; esac
  done
}
check "every command carries its short name" "" "$(short_names_missing "$ROOT/commands")"
SNCMDS="$WORK/short-name-commands"; mkdir -p "$SNCMDS"; cp "$ROOT"/commands/*.md "$SNCMDS"/
sed -i.bak '/^name: /d' "$SNCMDS/status.md"; rm -f "$SNCMDS"/*.bak; cp "$ROOT/commands/status.md" "$SNCMDS/stray.md"
check "a command without its name, and one the table does not know, fail the check" "missing:status|unknown:stray" \
  "$(short_names_missing "$SNCMDS" | paste -sd'|' -)"
check "both supervision commands carry one body" "" \
  "$(diff <(sed '/^name: /d' "$ROOT/commands/supervision.md") <(sed '/^name: /d' "$ROOT/commands/coordinator-supervision.md"))"
check "both coordinator commands and the successor's brief load the coordination skill" "yes|yes|yes" \
  "$(spells "$COORDCMD" 'described in `orchestrator:coordination`')|$(spells "$COORDEND" 'described in `orchestrator:coordination`')|$(spells "$COORDTPL" '`orchestrator:coordination` FIRST')"
check "each coordinator command carries its description and its allowed tools" "1|1|1|1" \
  "$(sed -n '1,5p' "$COORDCMD" | grep -c '^description: ')|$(sed -n '1,5p' "$COORDCMD" | grep -c '^allowed-tools: .*coordinator\.sh')|$(sed -n '1,5p' "$COORDEND" | grep -c '^description: ')|$(sed -n '1,5p' "$COORDEND" | grep -c '^allowed-tools: .*coordinator\.sh')"
check "a merge is the operator's, relayed and never decided by the coordinator" "yes" \
  "$(spells "$COORDSKILL" 'You never decide it and never offer to')"
check "the coordinator never closes its own tab" "yes" "$(spells "$COORDSKILL" 'never close your own tab')"
# The operator's order: one interface for his questions, the coordinator's. While one runs, an
# orchestrator sends it every question meant for him; the coordinator relays each verbatim and
# answers none itself. Facts questions stay optional, and with no coordinator he is asked directly.
check "the coordinator relays every operator question and answers none itself" "yes|yes|yes" \
  "$(spells "$COORDSKILL" '## Relaying questions to the operator')|$(spells "$COORDSKILL" "**You are the operator's single question")|$(spells "$COORDSKILL" '**You never answer an operator question yourself**')"
check "the coordinator's announcement routes operator questions through it, facts optional" "yes|yes|no" \
  "$(spells "$COORDCMD" "I am the operator's single question interface")|$(spells "$COORDCMD" 'Asking me the facts is optional')|$(spells "$COORDCMD" 'you still speak to the operator directly')"
check "the coordinator takes a [module] report into its round, a report and never an order" "yes|yes|yes" \
  "$(spells "$COORDSKILL" 'A message headed `[module]` is the hooks module'"'"'s report of an orchestrator'"'"'s turn end, sent')|$(spells "$COORDSKILL" '« reports its work done » is a closing proposal, his to rule. Either is a report, never an')|$(spells "$COORDSKILL" 'order. His answer goes, verbatim and dated, to the address its « reply with SendMessage to: »')"
# A live bench: the coordinator read a [module] question and said it had no way to answer. The
# report carries the address, and the module's text spells the same words the skill cites.
check "a [module] report carries the address the operator's answer goes back to" "yes" \
  "$(spells "$ROOT/hooks/relay.ts" 'reply with SendMessage to: ${name}')"
check "the successor's announcement keeps operator questions coming to it" "yes" \
  "$(spells "$COORDTPL" 'question meant for the operator still comes to me')"
# The operator's second order: by default, without his asking, the coordinator runs every
# relayed question through the whole decision round — a round file as its ledger, the end line
# counting it. Every question reaches him: written to the ledger before anything else, never
# dropped or merged. The questions come grouped by the orchestrator that sent them, each group
# opened by that orchestrator's own account of its work, every message naming the sender and
# the coordinator, since he runs several coordinators.
check "the coordinator runs every relayed question as a decision round by default, with its file and end line" "yes|yes|yes|yes" \
  "$(spells "$COORDSKILL" 'goes through a decision round, by default**: the whole method of `/orchestrator-decide`, run')|$(spells "$COORDSKILL" 'without his asking and without his typing that command, even for a single question')|$(spells "$COORDSKILL" '`decision-round.md` in your scratch directory: number, the sender'"'"'s exact `ListAgents`')|$(spells "$COORDSKILL" '« The round is complete: N/N. »')"
check "every relayed question reaches the operator: in the ledger first, none dropped or merged" "yes|yes|yes" \
  "$(spells "$COORDSKILL" 'A question received is written, before anything else is done, to')|$(spells "$COORDSKILL" 'The round file is the ledger: nothing received is dropped, merged or')|$(spells "$COORDSKILL" 'one found settled is not dropped by you: ask its sender, and only its')"
check "the round groups its questions by the orchestrator that sent them" "yes|yes|yes" \
  "$(spells "$COORDSKILL" 'all the questions of one orchestrator together, consecutive, in the sender'"'"'s own order')|$(spells "$COORDSKILL" 'question arriving mid-round from an orchestrator whose group is not done joins that')|$(spells "$COORDSKILL" '« `<sender'"'"'s exact name>` — 3 questions »')"
check "the round names the coordinator and each sender, and opens each group with the sender's own context" "yes|yes|yes|yes|yes" \
  "$(spells "$COORDSKILL" 'line naming you and the senders it covers, and the count')|$(spells "$COORDSKILL" 'line naming who asks: « Question i of N — from `<sender'"'"'s exact name>` », then the sender'"'"'s')|$(spells "$COORDSKILL" 'context block of three to five plain sentences: what that orchestrator works on')|$(spells "$COORDSKILL" 'you ask the sender for it before presenting the group, and you never invent it')|$(spells "$COORDCMD" 'With your questions, send three to five sentences')"
check "the round is mirrored in the successor's brief, the design and the decision round" "yes|yes|yes|yes" \
  "$(spells "$COORDTPL" 'Then the round file `{{ROUND_FILE}}`')|$(spells "$ROOT/docs/design.md" 'runs every relayed question through the whole decision round of `commands/decide.md`')|$(spells "$ROOT/docs/design.md" 'the questions come grouped by the orchestrator that sent them')|$(spells "$ROOT/commands/decide.md" 'round of its own where your questions come together')"
# The module carries the question since the turn-end relay: the orchestrator asks in its tab and
# ends on the machine line; the lookup and the send it once ran itself are gone from its rulebook.
check "the orchestrator asks in its tab and the module carries the question to a running coordinator" "yes|yes|yes" \
  "$(spells "$ROOT/skills/orchestrator/SKILL.md" '**While a coordinator runs, every question for the operator goes to it** — his order —')|$(spells "$ROOT/skills/orchestrator/SKILL.md" 'and the hooks module carries it: ask here, in the shape of `/orchestrator-decide` step 2, and')|$(spells "$ROOT/skills/orchestrator/SKILL.md" 'end the turn on `waiting: operator — blocks: <what it blocks>`; never send it yourself')"
# A report that asks nothing, ended on the operator's wait, was drawn in the pane as a question.
check "the orchestrator ends on the operator's wait only for a question in the decide shape, and the coordinator still records one that asks nothing" "yes|yes" \
  "$(spells "$ROOT/skills/orchestrator/SKILL.md" 'Only such a question ends on that line; a report asking nothing, on its other machine line.')|$(spells "$COORDSKILL" 'row alone showing the wait: record it all the same, and present it once due.')"
check "the orchestrator rulebook no longer runs the lookup and the send itself" "no|no" \
  "$(spells "$ROOT/skills/orchestrator/SKILL.md" 'coordinator.sh lookup')|$(spells "$ROOT/skills/orchestrator/SKILL.md" 'no coordinator runs, and you ask him directly')"
check "a decision round goes through a running coordinator, carried by the module" "yes|yes" \
  "$(spells "$ROOT/commands/decide.md" '**While a coordinator runs, the wave goes through it**, carried by the hooks module: each')|$(spells "$ROOT/commands/decide.md" 'blocks>`, and the module forwards it; never send it yourself.')"
# The module carries each question; the round sending them itself as well delivered one question twice.
check "the decision round no longer looks the coordinator up or sends it the questions itself, and stays at 8,650 bytes or fewer" "no|no|0|yes" \
  "$(spells "$ROOT/commands/decide.md" 'coordinator.sh lookup')|$(spells "$ROOT/commands/decide.md" 'goes to that coordinator with `SendMessage`')|$(sed -n '1,5p' "$ROOT/commands/decide.md" | grep -c '^allowed-tools: .*coordinator\.sh')|$([ "$(wc -c < "$ROOT/commands/decide.md" | tr -d ' ')" -le 8650 ] && echo yes || echo no)"
# The operator's order of 2026-10-24: a question the pane shows is asked in the coordinator's tab
# only once due — urgent, or no pane open — and never twice; whether the pane is open decides.
# A hold on his word keeps the other questions open, and the urgent ones still signalled.
check "the rulebooks say a question the pane shows is not asked twice, when it falls due, and how a wait is marked urgent" \
  "yes|yes|yes|yes|yes|yes|yes|yes|yes|yes|yes|yes|yes" \
  "$(spells "$COORDSKILL" '**A question the pane shows is not asked twice.**')|$(spells "$COORDSKILL" 'ended on `waiting: operator (urgent) — blocks: …`, or your pane is closed. Whether he keeps the')|$(spells "$COORDSKILL" 'he lifts that hold: they stay open, in the pane and in the round; an urgent one you signal in')|$(spells "$ROOT/commands/decide.md" 'compaction, in asking order: the urgent first (a production fault, a detected')|$(spells "$COORDSKILL" '(« [module] … now due in this tab »)')|$(spells "$COORDSKILL" 'showed it, is closed once, by one `round-close`, and never presented again.')|$(spells "$ROOT/commands/decide.md" 'again only when urgent or no pane is open (his order of 2026-10-24: no question asked')|$(spells "$ROOT/commands/decide.md" 'end on `waiting: operator (urgent) — blocks: …` only for')|$(spells "$ROOT/commands/decide.md" '« already done: <evidence> », dropped from the count (N in the header drops with it),')|$(spells "$ROOT/commands/decide.md" 'a settled item is never asked.')|$(spells "$ROOT/skills/orchestrator/SKILL.md" '`waiting: operator (urgent) — blocks: <…>` only for a production fault, a detected')|$(spells "$ROOT/docs/design.md" 'A question the pane shows is not asked twice, on the operator')|$(spells "$ROOT/docs/design.md" 'submits to its own session one « [module] … now due in this tab »')"
# The coordinator's own decision round takes every orchestrator's open questions in the order
# `round --by-urgency` prints, points at decide.md for the round's shape, and relays each ruling.
CDECIDE="$ROOT/commands/coordinator-decide.md"
check "coordinator-decide reads round --by-urgency, follows decide.md's shape, relays each ruling verbatim, and is listed" \
  "yes|yes|yes|yes|1|yes" \
  "$(spells "$CDECIDE" '--by-urgency`: its open `operator` entries are the round')|$(spells "$CDECIDE" "The round's shape is \`/orchestrator-decide\`'s, read from \`commands/decide.md\`")|$(spells "$CDECIDE" 'verbatim and dated (`date -u +%FT%TZ`, pasted) to the sender')|$(spells "$CDECIDE" 'the urgent first, then by `since`, the')|$(sed -n '1,5p' "$CDECIDE" | grep -c '^allowed-tools: .*coordinator\.sh.*SendMessage')|$(spells "$ROOT/README.md" '| `/coordinator-decide` |')"
COORDSPAWN=$(grep -m1 -o 'iterm-agent.sh spawn --coordinator-successor.*' "$COORDSKILL" 2>/dev/null | sed -e 's/^iterm-agent.sh spawn //' \
  -e 's#<subject>#ops#' -e "s#<your working directory>#$WORK#" -e 's#<brief path>#/tmp/coord-brief.md#')
coordspawn() { eval "set -- $COORDSPAWN"; ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$CRDSTATE" CLAUDE_CONFIG_DIR="$CRDCFG" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
  ORCHESTRATOR_SELF_ID=S-ME CLAUDE_CODE_SESSION_ID=s-crd bash "$AGENT" spawn "$@" 2>&1; }
COORDSPAWNOUT=$(if [ -n "$COORDSPAWN" ]; then coordspawn; else echo "no spawn line"; fi)
check "the skill's succession spawn line is one the launcher runs as the coordinator's successor" "1|1|1|1" \
  "$(printf '%s' "$COORDSPAWNOUT" | grep -c '^coordinator_successor=yes$')|$(printf '%s' "$COORDSPAWNOUT" | grep -c '^anchor=leftmost$')|$(printf '%s' "$COORDSPAWNOUT" | grep -c '^chain=none$')|$(printf '%s' "$COORDSPAWNOUT" | sed -n 's/^launch=//p' | grep -c -- "--name 'Coord : ops'")"

# The start renames itself through the plugin's tool before it registers, and places its tab.
COORDLINE() { grep -n -m1 -F -- "$2" "$1" | cut -d: -f1; }
check "the start renames itself before it registers" "1" \
  "$([ "$(COORDLINE "$COORDCMD" 'Call `mcp__orchestrator__rename_session` with `Coord : <subject>`')" -lt "$(COORDLINE "$COORDCMD" 'coordinator.sh register --name')" ] 2>/dev/null && echo 1 || echo 0)"
# The orchestrator's rename lands when its turn ends: a spawn in the same turn would carry
# the directory-stem name into every brief, so the rulebook ends the turn on the call, and
# the module refuses the spawn or the message made before it, then resumes the session.
# A session the launcher cannot read a name for still succeeds: the title is passed by hand.
check "succeed passes the current name as the title when the launcher reads none" "yes" \
  "$(spells "$ROOT/commands/succeed.md" 'older convention — it says to type one: pass `--title "<this session'"'"'s current name>"`,')"
check "the orchestrator ends the turn on its rename and the module resumes it under the name" "yes|no" \
  "$(spells "$ROOT/skills/orchestrator/SKILL.md" 'once, and END THE TURN: the name is taken when it ends, and the module resumes you under it; a spawn or a message before then is refused')|$(spells "$ROOT/skills/orchestrator/SKILL.md" 'so you dispatch from the next turn')"
check "the coordinator ends the turn on its rename and the module resumes it" "yes|no" \
  "$(spells "$COORDCMD" 'END THE TURN: the session takes the name when it ends, and the module resumes you under it')|$(spells "$COORDCMD" 'nothing below waits for it')"
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
# A coordinator started by hand is closed too, nothing asked: its title is the host's, the
# host may refuse the close, and the end it then asks for is proved on the tty, not on list.
check "the coordinator's successor closes a hand-started predecessor, with the end_session fallback" "yes|yes|yes|yes" \
  "$(spells "$COORDTPL" "The operator's standing order: you ALWAYS close your")|$(spells "$COORDTPL" '`list` printed for it as `--expect-title` instead')|$(spells "$COORDTPL" 'mcp__orchestrator__end_session »: the module ends its session')|$(spells "$COORDTPL" 'verify --tty {{PREDECESSOR_TTY}}` fails')"
check "the coordinator calls end_session when its successor asks" "yes" \
  "$(spells "$COORDSKILL" 'mcp__orchestrator__end_session » (the host refused it the close), you call it and end the')"
COORDFILLED="$WORK/coordinator-brief-filled.md"
mkdir -p "$WORK/coord-fill/coordinator" "$WORK/coord-fill/scratch"; : > "$WORK/coord-fill/coordinator/notes.md"; : > "$WORK/coord-fill/scratch/decision-round.md"
if [ -f "$COORDTPL" ]; then
  sed -E -e 's#\{\{PREDECESSOR\}\}#Coord : ops [a1b2c3]#g' -e 's#\{\{PREDECESSOR_TTY\}\}#/dev/ttys950#g' -e 's#\{\{SUBJECT\}\}#ops#g' \
    -e "s#\{\{STATE_DIR\}\}#$WORK/coord-fill#g" -e "s#\{\{NOTES_FILE\}\}#$WORK/coord-fill/coordinator/notes.md#g" -e "s#\{\{ROUND_FILE\}\}#$WORK/coord-fill/scratch/decision-round.md#g" \
    -e "s#\{\{COORDINATOR_SH\}\}#$ROOT/skills/coordinator/scripts/coordinator.sh#g" -e "s#\{\{ITERM_AGENT_SH\}\}#$AGENT#g" \
    -e 's#\{\{[A-Z_]+\}\}#$WORK#g' "$COORDTPL" > "$COORDFILLED"
fi
check "the coordinator's succession brief, filled with a real predecessor's values, lints clean" "yes|0" \
  "$([ -s "$COORDFILLED" ] && echo yes || echo no)|$(bash "$ROOT/skills/orchestrator/scripts/brief-lint.sh" "$COORDFILLED" >/dev/null 2>&1; echo $?)"

# `/orchestrator-audit` (§52): the brief instantiated and linted, the auditor spawned with
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
audspawn() { eval "set -- $AUDSPAWN"; ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$AUDSTATE" CLAUDE_CONFIG_DIR="$AUDCFG" ORCHESTRATOR_SELF_TTY=/dev/ttys900 \
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
# The predecessor tells the operator BEFORE it hands over, as /orchestrator-succeed orders it:
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
# inherit it. Without the option an agent's launch exports 240,000; any other role exports
# nothing and the 300,000 default holds.
gspawn() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : gate" "$@" 2>&1; }
out=$(gspawn --prompt p --gate-tokens 200000)
check "--gate-tokens exports the gate in the launch" "1" "$(printf '%s\n' "$out" | grep -c '^launch=.*export ORCHESTRATOR_CONTEXT_GATE_TOKENS=200000 && ')"
check "without --gate-tokens an agent's launch exports the 240000 gate" "1" "$(gspawn --prompt p | grep -c '^launch=.*export ORCHESTRATOR_CONTEXT_GATE_TOKENS=240000 && ')"
check "--gate-tokens on an agent wins over the 240000 default" "1|0" \
  "$(gspawn --prompt p --gate-tokens 150000 | grep -c '^launch=.*export ORCHESTRATOR_CONTEXT_GATE_TOKENS=150000 && ')|$(gspawn --prompt p --gate-tokens 150000 | grep -c 'GATE_TOKENS=240000')"
check "an orchestrator's, an auditor's and a coordinator's launch export no gate" "0|0|0" \
  "$(gspawn --title 'Orch : gate' --prompt p | grep -c 'ORCHESTRATOR_CONTEXT_GATE_TOKENS')|$(gspawn --title 'Audit : gate' --auditor --prompt p | grep -c 'ORCHESTRATOR_CONTEXT_GATE_TOKENS')|$(gspawn --title 'Coord : gate' --prompt p | grep -c 'ORCHESTRATOR_CONTEXT_GATE_TOKENS')"
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

# A tier may bind an effort with its model: effort moves token spend as much as the family.
PMAP="$WORK/pair-map.json"
printf '{"deep":{"model":"a-model","effort":"high"},"standard":"b-model","light":{"model":"c-model"}}' > "$PMAP"
check "a pair binding resolves to model/effort" "a-model/high" \
  "$(env ORCHESTRATOR_MODELS_MAP="$PMAP" bash "$AGENT" resolve-tier deep)"
check "a string binding still resolves to the model alone" "b-model" \
  "$(env ORCHESTRATOR_MODELS_MAP="$PMAP" bash "$AGENT" resolve-tier standard)"
check "an object without effort resolves to the model alone" "c-model" \
  "$(env ORCHESTRATOR_MODELS_MAP="$PMAP" bash "$AGENT" resolve-tier light)"
check "the environment may bind a pair too" "c-model/low" \
  "$(env ORCHESTRATOR_MODELS_MAP="$PMAP" ORCHESTRATOR_TIER_DEEP=c-model/low bash "$AGENT" resolve-tier deep)"
printf '{"deep":{"model":"a-model","effort":"huge"}}' > "$WORK/bad-effort.json"
check "an unknown effort in the map is a refusal" \
  "ERROR: resolve-tier: tier deep has an unknown effort: huge (expected low, medium, high, xhigh or max)" \
  "$(env ORCHESTRATOR_MODELS_MAP="$WORK/bad-effort.json" bash "$AGENT" resolve-tier deep 2>&1)"
printf '{"deep":{"effort":"high"}}' > "$WORK/no-model.json"
check_status "an object without a model is a refusal" 1 \
  env ORCHESTRATOR_MODELS_MAP="$WORK/no-model.json" bash "$AGENT" resolve-tier deep
pcmd() { env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$PMAP" bash "$AGENT" spawn --dir "$WORK" --title 'Agent : x' --prompt p "$@" 2>/dev/null; }
check "a pair tier types the model then the effort" "1" "$(pcmd --tier deep | grep -c -- '--model a-model --effort high')"
check "an explicit effort wins over the map's" "1" "$(pcmd --tier deep --effort low | grep -c -- '--effort low')"
check "an explicit effort with an explicit model" "1" "$(pcmd --model z-model --effort medium | grep -c -- '--model z-model --effort medium')"
check "no effort anywhere: no effort argument" "0" "$(pcmd --tier standard | grep -c -- '--effort')"
check "an unknown effort on spawn is a refusal" \
  "ERROR: spawn: unknown effort: huge (expected low, medium, high, xhigh or max)" \
  "$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title 'Agent : x' --prompt p --effort huge 2>&1 | tail -1)"
check "an auditor refuses an effort: it runs as its caller runs" "1" \
  "$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --auditor --title 'Audit : x' --prompt p --effort low 2>&1 | grep -c -- 'refused: --effort is not an auditor')"
check "rotate forwards the effort to the spawn" "1" \
  "$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$PMAP" \
      bash "$AGENT" rotate --old-tty /dev/ttys999 --dir "$WORK" --title "Agent : rotated" --tier deep --effort max --prompt p 2>&1 | grep -c -- '--model a-model --effort max')"

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
# The measure file the succession reads is the module's own artifact: it lives under the
# config dir, never under the state override (gauge.ts resolves CLAUDE_CONFIG_DIR alone).
# A decoy planted under the override root proves the reading; so does a session whose file
# exists ONLY there, which must refuse naming the config-dir path.
ICFG="$WORK/icfg"; mkdir -p "$ICFG/claude-orchestrator/measure" "$ISTATE/measure"
printf '{"context_tokens":21000,"context_window":200000,"context_percent":10,"model":"a-model","updated_at":"2026-10-10T00:00:00Z"}\n' > "$ICFG/claude-orchestrator/measure/s-inh.json"
printf '{"context_tokens":21000,"context_window":200000,"context_percent":10,"model":"override-root-model","updated_at":"2026-10-10T00:00:00Z"}\n' > "$ISTATE/measure/s-inh.json"
inh() { local sid=$1; shift; CLAUDE_CODE_SESSION_ID="$sid" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" CLAUDE_CONFIG_DIR="$ICFG" \
  bash "$AGENT" spawn --dir "$WORK" "$@" 2>&1; }
check "inherit-model types the calling session's model" "1" \
  "$(inh s-inh --title "Orch : heir" --inherit-model --prompt p | sed -n 's/^launch=//p' | grep -c -- '--model a-model')"
printf '{"context_tokens":21000,"context_window":200000,"context_percent":10,"model":"override-root-model","updated_at":"2026-10-10T00:00:00Z"}\n' > "$ISTATE/measure/s-ovr.json"
check "the measure file is read under the config dir, not the state override" "1" \
  "$(inh s-ovr --inherit-model --prompt p | grep -cF "$ICFG/claude-orchestrator/measure/s-ovr.json")"
check "inherit-model with no measure file refuses and names the module" "1" \
  "$(inh s-none --inherit-model --prompt p | grep -c 'hooks module')"
# The module records `unavailable` when the host gave it no model: a sentinel, never a
# model to type, and a succession must not start on a guess (§27).
printf '{"context_tokens":21000,"context_window":200000,"context_percent":10,"model":"unavailable","updated_at":"2026-10-10T00:00:00Z"}\n' > "$ICFG/claude-orchestrator/measure/s-unav.json"
check "inherit-model refuses the unavailable sentinel, as if no model were recorded" "0|1" \
  "$(inh s-unav --title "Orch : heir" --inherit-model --prompt p | grep -c -- '--model unavailable')|$(inh s-unav --title "Orch : heir" --inherit-model --prompt p | grep -c 'no model recorded for this session')"
check "inherit-model is exclusive with a tier" "1" \
  "$(inh s-inh --inherit-model --tier deep --prompt p | grep -c 'exclusive')"
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
# A rotation closes the old agent only once its replacement is verified running; without
# the verification, a replacement that never started leaves no agent at all.
check "rotate refuses --no-verify, before it spawns anything" "1|0" \
  "$(rot_refuse --no-verify --prompt p | grep -c -- '--no-verify is not a rotation')|$(rot_refuse --no-verify --prompt p | grep -c '^launch=')"
# ...and forwarding is not enough: the refusal has to STOP the rotation. A tier that does
# not resolve once opened a real tab with no model at all, because the failure was swallowed
# crossing a shell substitution. The guard reads what comes LAST: an exit code alone would
# pass on that bug too, since the close that followed failed on its own.
rot=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
  bash "$AGENT" rotate --dir "$WORK" --old-tty /dev/ttys999 --tier bogus --prompt p 2>&1 || true)
check "an unresolvable tier stops the rotation, and nothing runs after it" \
  "ERROR: resolve-tier: unknown tier: bogus (expected deep, standard or light)" "$(printf '%s' "$rot" | tail -1)"

# The context gate's hook cases — the role lines verbatim, the unmeasured-once rule, the
# model drift and its marker, the name reading both gates share, the wiring over a faked $ —
# moved module-side with the gate itself: hooks/tests/context-gate.test.ts,
# session-name.test.ts, gauge-core.test.ts and gauge-band.test.ts, run by the host's plugin
# test. The threshold sweep below stays: the numbers are the rulebook's, not the gate's
# implementation, and they bind the module's gate the same as they bound the script's.

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

# The gate is 300,000 tokens (30 %) on a window of 1,000,000 tokens or more, the common
# case, and 80 % of a smaller window. A line that states 80 % without the token half is a
# gate a large-window session would read as its own: every such line carries the rule
# whole, in the same words.
GATE_RULE='300,000 tokens (30 %) on a window of 1,000,000 tokens or more, the common case, and 80 % of a smaller window'
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

# The push guard's hook cases — every forced form the awk tokeniser answered, the pinned
# lease, the spawn marker, the degraded read, the wiring over a faked $ — moved module-side
# with the guard: hooks/tests/tokenizer.test.ts (the fixtures, moved not shrunk) and
# hooks/tests/push-guard.test.ts, run by the host's plugin test.

echo "== draft guard =="
# A failing check of a draft pull request is a draft guard when the job that produced it tests
# the draft flag in its own definition. `draft_guard.py` reads the run behind the check's link,
# the workflow file at the run's head and, for a local reusable workflow, the called file. A fake
# `gh` answers from files: `api` from DGA (the run, the contents), `pr view` and `pr checks` from
# the files of DG. The fixtures are shared with the cases of ci-watch and of the stop gate below.
DG="$WORK/draft-guard"; DGA="$DG/api"; DGB="$DG/bin"; DGS="$DG/state"
mkdir -p "$DGA" "$DGB" "$DGS"
DGSCRIPT="$ROOT/skills/orchestrator/scripts/draft_guard.py"
dg_key() { printf '%s' "$1" | tr '/?=@' '____'; }
dg_run() {  # <run id> <workflow path> <head sha>
  printf '{"path": "%s", "head_sha": "%s"}\n' "$2" "$3" > "$DGA/$(dg_key "repos/acme/thing/actions/runs/$1")"
}
dg_file() {  # <workflow path> <head sha> <content>
  printf '{"content": "%s", "encoding": "base64"}\n' "$(printf '%s\n' "$3" | base64 | tr -d '\n')" \
    > "$DGA/$(dg_key "repos/acme/thing/contents/$1?ref=$2")"
}
dg_link() { printf 'https://github.com/acme/thing/actions/runs/%s/job/%s' "$1" "$2"; }
IFS= read -r -d '' WF_CI <<'EOF'
name: CI
on: pull_request
jobs:
  wip-check:
    uses: ./.github/workflows/wip-check.yml
  tests:
    runs-on: ubuntu-latest
    steps:
      - run: make test
EOF
IFS= read -r -d '' WF_WIP <<'EOF'
name: wip-check
on:
  workflow_call:
jobs:
  wip-check:
    runs-on: ubuntu-latest
    steps:
      - name: Refuse a draft pull request
        run: |
          if [[ "${{ github.event_name }}" == "pull_request" && "${{ github.event.pull_request.draft }}" == "true" ]]; then exit 1; fi
EOF
IFS= read -r -d '' WF_INLINE <<'EOF'
name: CI
on: pull_request
jobs:
  draft-gate:
    name: draft-gate
    runs-on: ubuntu-latest
    steps:
      - run: test "${{ github.event.pull_request.draft }}" != "true"
  tests:
    runs-on: ubuntu-latest
    steps:
      - run: make test
EOF
DGSHA_R=aaaa000000000000000000000000000000000001   # run 555: the reusable guard
DGSHA_I=bbbb000000000000000000000000000000000002   # run 556: the inline guard
DGSHA_U=cccc000000000000000000000000000000000003   # run 558: a workflow file that cannot be read
dg_run 555 .github/workflows/ci.yml "$DGSHA_R"
dg_file .github/workflows/ci.yml "$DGSHA_R" "$WF_CI"
dg_file .github/workflows/wip-check.yml "$DGSHA_R" "$WF_WIP"
dg_run 556 .github/workflows/ci.yml "$DGSHA_I"
dg_file .github/workflows/ci.yml "$DGSHA_I" "$WF_INLINE"
dg_run 558 .github/workflows/ci.yml "$DGSHA_U"
C_WIP='{"name": "wip-check / wip-check", "bucket": "fail", "link": "'"$(dg_link 555 9001)"'"}'
C_TESTS='{"name": "tests", "bucket": "fail", "link": "'"$(dg_link 555 9002)"'"}'
C_GATE='{"name": "draft-gate", "bucket": "fail", "link": "'"$(dg_link 556 9003)"'"}'
C_TESTS_I='{"name": "tests", "bucket": "fail", "link": "'"$(dg_link 556 9006)"'"}'
C_NOREAD='{"name": "wip-check / wip-check", "bucket": "fail", "link": "'"$(dg_link 558 9004)"'"}'
C_PASS='{"name": "lint", "bucket": "pass", "link": "'"$(dg_link 555 9005)"'"}'
cat > "$DGB/gh" <<EOF
#!/bin/bash
echo "\$*" >> "$DG/gh-calls"
case "\$1 \$2" in
  "pr view") [ -f "$DG/view" ] || { echo "gh: HTTP 502" >&2; exit 1; }; cat "$DG/view" ;;
  "pr checks") [ -f "$DG/checks" ] || { echo "gh: HTTP 502" >&2; exit 1; }; cat "$DG/checks" ;;
  "api "*) f="$DGA/\$(printf '%s' "\$2" | tr '/?=@' '____')"; [ -f "\$f" ] && cat "\$f" || { echo "gh: HTTP 404" >&2; exit 1; } ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$DGB/gh"
check "draft_guard.py exists" "yes" "$([ -f "$DGSCRIPT" ] && echo yes || echo no)"
# dg_raw: the command's stdout, its exit code; dg <draft: true|false> <checks, a JSON array>: the
# names it printed joined by `, `, then the exit code.
dg_raw() { env PATH="$DGB:$PATH" ORCHESTRATOR_STATE_DIR="$DGS" "$py" "$DGSCRIPT" acme/thing 7 2>"$DG/stderr"; }
dg() {
  local out rc
  printf '{"isDraft": %s}\n' "$1" > "$DG/view"; printf '%s\n' "$2" > "$DG/checks"
  out=$(dg_raw); rc=$?
  printf '%s|%s' "$(printf '%s' "$out" | paste -sd, - | sed 's/,/, /g')" "$rc"
}
dg_apis() { { cat "$DG/gh-calls" 2>/dev/null; true; } | grep -c '^api'; }
dg_reset() { rm -rf "$DGS/draft-guard" "$DG/gh-calls" "$DG/view" "$DG/checks"; }

dg_reset
check "a draft's failing check from a local reusable workflow that tests the draft flag: a guard, nothing printed" "|0" \
  "$(dg true "[$C_WIP, $C_PASS]")"
dg_reset
check "a guard and a failing check that is not one: only the second is printed" "tests|0" \
  "$(dg true "[$C_WIP, $C_TESTS]")"
dg_reset
check "a job with the draft test inline, no \`uses:\`, is a guard" "|0" "$(dg true "[$C_GATE]")"
dg_reset
check "the job of the same file that does not read the flag is not" "tests|0" "$(dg true "[$C_GATE, $C_TESTS_I]")"
dg_reset
check "a guard on a pull request that is not a draft is reported, and no run is read" "wip-check / wip-check|0|0" \
  "$(dg false "[$C_WIP]")|$(dg_apis)"
dg_reset
check "an unreadable workflow file is no guard: the check is reported" "wip-check / wip-check|0" "$(dg true "[$C_NOREAD]")"
dg_reset
check "a check with no run behind its link is no guard" "ext|0" \
  "$(dg true '[{"name": "ext", "bucket": "fail", "link": "https://ci.example.com/build/4"}]')"
dg_reset
C_CANCEL=$(sed 's/"fail"/"cancel"/' <<< "$C_WIP")
check "a cancelled check is never a guard: it is printed" "wip-check / wip-check|0" "$(dg true "[$C_CANCEL]")"
dg_reset
check "a draft with no failing check prints nothing and reads no run" "|0|0" "$(dg true "[$C_PASS]")|$(dg_apis)"

# The cache is keyed by repository, workflow path and head: a head already classified costs no call.
dg_reset
dg true "[$C_WIP]" >/dev/null
rm -f "$DG/gh-calls"
check "the same head classified again costs no api call, and the answer is the same" "|0|0" \
  "$(dg true "[$C_WIP]")|$(dg_apis)"
dg_reset
dg true "[$C_NOREAD]" >/dev/null
rm -f "$DG/gh-calls"
dg true "[$C_NOREAD]" >/dev/null
check "an unreadable file is not cached: it is read again" "yes" "$([ "$(dg_apis)" -gt 0 ] && echo yes || echo no)"
dg_reset
dg true "[$C_WIP]" >/dev/null
mkdir -p "$DGS/draft-guard"; : > "$DGS/draft-guard/old-entry"; : > "$DGS/draft-guard/fresh-entry"
touch -t 202001010000 "$DGS/draft-guard/old-entry"
dg true "[$C_GATE]" >/dev/null
check "an entry older than seven days is removed when one is written, a fresh one is kept" "no|yes" \
  "$([ -e "$DGS/draft-guard/old-entry" ] && echo yes || echo no)|$([ -e "$DGS/draft-guard/fresh-entry" ] && echo yes || echo no)"

dg_reset
printf '[%s]\n' "$C_WIP" > "$DG/checks"
dg_out=$(dg_raw); dg_rc=$?
check "gh failing (the draft flag unread): exit 5, nothing on stdout, one line on stderr" "|5|1" \
  "$dg_out|$dg_rc|$(grep -c . "$DG/stderr")"
dg_reset
check "guards() runs on an injected gh and answers the names of the guards" "wip-check / wip-check" \
  "$(DGA="$DGA" DGCHECKS="[$C_WIP, $C_TESTS]" PYTHONPATH="$ROOT/skills/orchestrator/scripts" "$py" - "$DGS/stub" <<'PYEOF'
import json, os, sys
import draft_guard

def gh(argv):
    if argv[0] != "api":
        raise RuntimeError("only api is stubbed")
    path = os.path.join(os.environ["DGA"], argv[1].translate(str.maketrans("/?=@", "____")))
    with open(path) as fh:
        return fh.read()

print(", ".join(sorted(draft_guard.guards("acme/thing", json.loads(os.environ["DGCHECKS"]), sys.argv[1], gh))))
PYEOF
)"

# A trailing comment is no part of the definition; a draft test written only in one is no guard.
IFS= read -r -d '' WF_TRAIL <<'EOF'
name: CI
on: pull_request
jobs:
  trailing:
    runs-on: u # pull_request.draft
    steps:
      - run: make test
EOF
DGSHA_T=dddd000000000000000000000000000000000004
dg_run 560 .github/workflows/ci.yml "$DGSHA_T"
dg_file .github/workflows/ci.yml "$DGSHA_T" "$WF_TRAIL"
C_TRAIL='{"name": "trailing", "bucket": "fail", "link": "'"$(dg_link 560 9007)"'"}'
dg_reset
check "a draft test only in a trailing comment is no guard: the check is reported" "trailing|0" \
  "$(dg true "[$C_TRAIL]")"

# One run, many failing names: its workflow file is read once, not once per name.
IFS= read -r -d '' WF_MATRIX <<'EOF'
name: CI
on: pull_request
jobs:
  a:
    runs-on: u
  b:
    runs-on: u
  c:
    runs-on: u
EOF
DGSHA_M=eeee000000000000000000000000000000000005
dg_run 561 .github/workflows/ci.yml "$DGSHA_M"
dg_file .github/workflows/ci.yml "$DGSHA_M" "$WF_MATRIX"
dg_check() { printf '{"name": "%s", "bucket": "fail", "link": "%s"}' "$1" "$(dg_link "$2" "$3")"; }
dg_reset
dg true "[$(dg_check a 561 1), $(dg_check b 561 2), $(dg_check c 561 3)]" >/dev/null
check "three failing names of one run cost one read of the workflow file" "1" \
  "$(grep -c '^api repos/acme/thing/contents/' "$DG/gh-calls")"

# The verdict entry is keyed by the head sha too: one check name, one workflow path, two heads whose
# files disagree, two verdicts.
IFS= read -r -d '' WF_GATE_ON <<'EOF'
name: CI
on: pull_request
jobs:
  gate:
    runs-on: u
    steps:
      - run: test "${{ github.event.pull_request.draft }}" != "true"
EOF
IFS= read -r -d '' WF_GATE_OFF <<'EOF'
name: CI
on: pull_request
jobs:
  gate:
    runs-on: u
    steps:
      - run: make test
EOF
DGSHA_G1=ffff000000000000000000000000000000000006
DGSHA_G2=0000ffff00000000000000000000000000000007
dg_run 562 .github/workflows/ci.yml "$DGSHA_G1"
dg_file .github/workflows/ci.yml "$DGSHA_G1" "$WF_GATE_ON"
dg_run 563 .github/workflows/ci.yml "$DGSHA_G2"
dg_file .github/workflows/ci.yml "$DGSHA_G2" "$WF_GATE_OFF"
dg_reset
dg true "[$(dg_check gate 562 4)]" >/dev/null
check "the same check name and workflow path at another head is classified on its own file" "gate|0" \
  "$(dg true "[$(dg_check gate 563 5)]")"

# The checks behind a guard: a passed check whose job lists the guard in its `needs` (the three
# forms), as opposed to one whose job does not and to one that is no job of the workflow at all.
IFS= read -r -d '' WF_NEEDS <<'EOF'
name: CI
on: pull_request
jobs:
  wip-check:
    uses: ./.github/workflows/wip-check.yml
  other:
    runs-on: u
  build:
    needs: wip-check
    runs-on: u
  lint:
    needs: [other, wip-check]
    runs-on: u
  deploy:
    runs-on: u
    needs:
      - other
      - wip-check   # the guard
    steps:
      - run: make deploy
  docs:
    needs: other
    runs-on: u
EOF
DGSHA_N=1111000000000000000000000000000000000008   # run 570: jobs behind the guard
dg_run 570 .github/workflows/ci.yml "$DGSHA_N"
dg_file .github/workflows/ci.yml "$DGSHA_N" "$WF_NEEDS"
dg_file .github/workflows/wip-check.yml "$DGSHA_N" "$WF_WIP"
dg_pass() { printf '{"name": "%s", "bucket": "pass", "link": "%s"}' "$1" "$(dg_link "$2" "$3")"; }
C_WIP_N=$(dg_check "wip-check / wip-check" 570 9100)
C_BUILD_N=$(dg_pass build 570 9101); C_LINT_N=$(dg_pass lint 570 9102); C_DEPLOY_N=$(dg_pass deploy 570 9103)
C_DOCS_N=$(dg_pass docs 570 9104)
C_EXT_P='{"name": "secrets", "bucket": "pass", "link": "https://ci.example.com/scan/4"}'
C_NOREAD_P=$(dg_pass build 558 9105)
dg_dep_raw() { env PATH="$DGB:$PATH" ORCHESTRATOR_STATE_DIR="$DGS" "$py" "$DGSCRIPT" acme/thing 7 --dependents 2>"$DG/stderr"; }
dg_dep() {  # <draft: true|false> <checks, a JSON array>: the names printed joined by `, `, then the exit code
  local out rc
  printf '{"isDraft": %s}\n' "$1" > "$DG/view"; printf '%s\n' "$2" > "$DG/checks"
  out=$(dg_dep_raw); rc=$?
  printf '%s|%s' "$(printf '%s' "$out" | paste -sd, - | sed 's/,/, /g')" "$rc"
}
dg_reset
check "--dependents: the passed jobs that need the guard, in the three forms of \`needs\`" "build, lint, deploy|0" \
  "$(dg_dep true "[$C_WIP_N, $C_BUILD_N, $C_LINT_N, $C_DEPLOY_N]")"
dg_reset
check "--dependents: a passed job that does not need the guard is not one" "|0" \
  "$(dg_dep true "[$C_WIP_N, $C_DOCS_N]")"
dg_reset
check "--dependents: a passed check with no run behind its link is not one" "|0" \
  "$(dg_dep true "[$C_WIP_N, $C_EXT_P]")"
dg_reset
check "--dependents: beside a job that needs the guard, the others are left out" "build|0" \
  "$(dg_dep true "[$C_WIP_N, $C_DOCS_N, $C_EXT_P, $C_BUILD_N]")"
dg_reset
check "--dependents: a passed check whose workflow file cannot be read is not one" "|0" \
  "$(dg_dep true "[$C_NOREAD, $C_NOREAD_P]")"
dg_reset
check "--dependents on a pull request that is no draft: nothing printed, no run read" "|0|0" \
  "$(dg_dep false "[$C_WIP_N, $C_BUILD_N]")|$(dg_apis)"
dg_reset
printf '[%s]\n' "$C_BUILD_N" > "$DG/checks"
dg_out=$(dg_dep_raw); dg_rc=$?
check "--dependents with gh failing: exit 5, nothing on stdout, one line on stderr" "|5|1" \
  "$dg_out|$dg_rc|$(grep -c . "$DG/stderr")"
dg_reset
check "dependents() runs on an injected gh and answers the names behind the guards" "build, deploy, lint" \
  "$(DGA="$DGA" DGCHECKS="[$C_WIP_N, $C_BUILD_N, $C_LINT_N, $C_DEPLOY_N, $C_DOCS_N, $C_EXT_P]" PYTHONPATH="$ROOT/skills/orchestrator/scripts" "$py" - "$DGS/stub" <<'PYEOF'
import json, os, sys
import draft_guard

def gh(argv):
    if argv[0] != "api":
        raise RuntimeError("only api is stubbed")
    path = os.path.join(os.environ["DGA"], argv[1].translate(str.maketrans("/?=@", "____")))
    with open(path) as fh:
        return fh.read()

checks = json.loads(os.environ["DGCHECKS"])
print(", ".join(sorted(draft_guard.dependents("acme/thing", checks, ["wip-check / wip-check"], sys.argv[1], gh))))
PYEOF
)"

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
# per call, the last one repeated. `buckets` (`<name>:<bucket>` lines, one `build:pass` by
# default) answers the bucket read after a watch that exits 0, the script's own --jq run on it;
# without the file that read fails. `watch-code` holds one line per checks watch, the last one
# repeated. `head-runs` answers the read of the head's workflow runs, one answer per read:
# `<id>:<status>` pairs joined by `;`, `-` for none, or `fail`; without the file, no run.
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
      *"--json isDraft"*) if tail -n 1 "$CW/view" | grep -q draft; then echo '{"isDraft": true}'; else echo '{"isDraft": false}'; fi ;;
      *mergeCommit*) [ -f "$CW/merge" ] || { echo "gh: HTTP 404" >&2; exit 1; }
                     cat "$CW/merge" ;;
      *) [ -f "$CW/view" ] || { echo "gh: HTTP 502" >&2; exit 1; }
         nth "$CW/view" view-n ;;
    esac ;;
  "run list")
    case "\$*" in
      *--commit*--json\ databaseId,status*)
                    [ -f "$CW/head-runs" ] || exit 0
                    r=\$(nth "$CW/head-runs" head-runs-n)
                    [ "\$r" = fail ] && { echo "gh: HTTP 502" >&2; exit 1; }
                    f=.; while [ \$# -gt 0 ]; do [ "\$1" = --jq ] && f="\$2"; shift; done
                    [ "\$r" = - ] && r=""
                    printf '%s\n' "\$r" | tr ';' '\n' \
                      | jq -Rn '[inputs | select(length > 0) | split(":") | {databaseId: (.[0] | tonumber), status: .[1]}]' \
                      | jq -r "\$f" ;;
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
      *"name,bucket,link"*) [ -f "$CW/checks-link" ] || { echo "gh: HTTP 502" >&2; exit 1; }; cat "$CW/checks-link" ;;
      *--watch*) echo "WATCH-OUTPUT-MARKER"; c=\$(nth "$CW/watch-code" watch-n); exit "\${c:-0}" ;;
      *"--json name,bucket"*)
         case "\$*" in *select*) [ -f "$CW/failing" ] && { cat "$CW/failing"; exit 1; } ;; esac
         [ -f "$CW/buckets" ] || { echo "gh: HTTP 502" >&2; exit 1; }
         f=.; while [ \$# -gt 0 ]; do [ "\$1" = --jq ] && f="\$2"; shift; done
         jq -Rn '[inputs | select(length > 0) | split(":") | {name: .[0], bucket: .[1]}]' "$CW/buckets" | jq -r "\$f" ;;
      *"--json name"*) r=\$(nth "$CW/reg" reg-n)
         case "\$r" in
           none) echo "no checks reported on the 'feat' branch" >&2; exit 1 ;;
           fail) echo "error connecting to api.github.com" >&2; exit 1 ;;
           *) echo "\$r" ;;
         esac ;;
    esac ;;
  "repo view") echo "acme/thing" ;;
  "api "*) f="$DGA/\$(printf '%s' "\$2" | tr '/?=@' '____')"; [ -f "\$f" ] && cat "\$f" || { echo "gh: HTTP 404" >&2; exit 1; } ;;
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
  local -a sid=()
  shift 4
  # CW_SESSION sets the arming session's id; without it the variable is unset for the watch.
  [ -z "${CW_SESSION:-}" ] || sid=(CLAUDE_CODE_SESSION_ID="$CW_SESSION")
  rm -f "$CW"/gh-calls "$CW"/view "$CW"/reg "$CW"/failing "$CW"/watch-code "$CW"/view-n "$CW"/reg-n \
    "$CW"/merge "$CW"/runs "$CW"/runs-n "$CW"/run-codes "$CW"/jobs "$CW"/newest "$CW"/newest-n "$CW"/buckets \
    "$CW"/watch-n "$CW"/head-runs "$CW"/head-runs-n
  [ "${CW_BUCKETS-build:pass}" = fail ] || printf '%b\n' "${CW_BUCKETS-build:pass}" > "$CW/buckets"
  [ -z "${CW_MERGE:-}" ] || printf '%b\n' "$CW_MERGE" > "$CW/merge"
  [ -z "${CW_RUNS:-}" ] || printf '%b\n' "$CW_RUNS" > "$CW/runs"
  [ -z "${CW_RUN_CODES:-}" ] || printf '%b\n' "$CW_RUN_CODES" > "$CW/run-codes"
  [ -z "${CW_JOBS:-}" ] || printf '%b\n' "$CW_JOBS" > "$CW/jobs"
  [ -z "${CW_NEWEST:-}" ] || printf '%b\n' "$CW_NEWEST" > "$CW/newest"
  [ -z "${CW_HEAD_RUNS:-}" ] || printf '%b\n' "$CW_HEAD_RUNS" > "$CW/head-runs"
  [ -z "$view" ] || printf '%b\n' "$view" > "$CW/view"
  [ -z "$reg" ] || printf '%b\n' "$reg" > "$CW/reg"
  [ -z "$failing" ] || printf '%b\n' "$failing" > "$CW/failing"
  printf '%b\n' "$code" > "$CW/watch-code"
  out=$(env -u CLAUDE_CODE_SESSION_ID ${sid[@]+"${sid[@]}"} PATH="$CWB:$PATH" ORCHESTRATOR_STATE_DIR="$CWS" CI_WATCH_REGISTER_WAIT="${CW_WAIT:-2}" \
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
# The watch exits 0 over a cancelled check, as it does over a passing one: the buckets read
# after it turns a cancelled check into a red, never a green.
check "a watch that exits 0 over cancelled checks is a red naming them, exit 1" "ci-watch: red 7 $HA build, test, lint, e2e|1" \
  "$(CW_BUCKETS="build:cancel\ntest:cancel\ndocs:skipping\nlint:cancel\npages:skipping\nunit:pass\na:skipping\nb:skipping\nc:skipping\nd:skipping\nsmoke:pass\ne2e:cancel\ne:skipping\nf:skipping" cw "OPEN $HA" "2" 0 "" 7 --interval 1)"
check "a watch that exits 0 over passing and skipped checks only is green, exit 0" "ci-watch: green 7 $HA|0" \
  "$(CW_BUCKETS="unit:pass\ndocs:skipping\nsmoke:pass" cw "OPEN $HA" "2" 0 "" 7 --interval 1)"
# A green carries evidence: a head whose every check was skipped had nothing run, and says so
# as no checks with the count skipped, never green.
check "a watch that exits 0 over skipped checks only is no green: no-checks with the count, exit 2" "ci-watch: no-checks 7 $HA skipped=3|2" \
  "$(CW_BUCKETS="unit:skipping\ndocs:skipping\nsmoke:skipping" cw "OPEN $HA" "2" 0 "" 7 --interval 1)"
# A slower workflow's checks are not registered yet when a faster one's are done: the watch
# exits 0 over the checks it knows, so the head's workflow runs are read before any green, and
# a run still going is watched to its end, then the checks are watched again.
check "a run of the head unfinished at a passing watch, then a failing check: red, exit 1" "ci-watch: red 7 $HA e2e|1" \
  "$(CW_HEAD_RUNS="201:completed;202:in_progress\n201:completed;202:completed" cw "OPEN $HA" "2" "0\n1" "e2e" 7 --interval 1)"
check "the unfinished run is watched, then the checks once more" "1|0|2" \
  "$(grep -c '^run watch 202' "$CW/gh-calls")|$(grep -c '^run watch 201' "$CW/gh-calls")|$(grep -c -e '--watch' "$CW/gh-calls")"
check "the head's runs are read at the head" "2" "$(grep -c "^run list --commit $HA --json databaseId,status" "$CW/gh-calls")"
check "every run of the head completed and every check passed: green, no extra watch" "ci-watch: green 7 $HA|0|1|0" \
  "$(CW_HEAD_RUNS="201:completed;202:completed" cw "OPEN $HA" "2" 0 "" 7 --interval 1)|$(grep -c -e '--watch' "$CW/gh-calls")|$(grep -c '^run watch' "$CW/gh-calls")"
check "a run of the head unfinished at a passing watch that ends green: green, exit 0" "ci-watch: green 7 $HA|0|2" \
  "$(CW_HEAD_RUNS="201:queued\n201:completed" cw "OPEN $HA" "2" 0 "" 7 --interval 1)|$(grep -c -e '--watch' "$CW/gh-calls")"
check "the head moves while its runs are waited for: exit 3" "ci-watch: moved 7 $HA $HB|3" \
  "$(CW_HEAD_RUNS="201:in_progress\n201:completed" cw "OPEN $HA\nOPEN $HA\nOPEN $HB" "2" 0 "" 7 --interval 1)"
check "a head moved during a run watch is seen at once, before any second checks watch" "ci-watch: moved 7 $HA $HB|3|1" \
  "$(CW_HEAD_RUNS="201:in_progress\n201:completed" cw "OPEN $HA\nOPEN $HA\nOPEN $HB" "2" 0 "" 7 --interval 1)|$(grep -c -e '--watch' "$CW/gh-calls")"
check "closed while its runs are waited for: exit 4" "ci-watch: closed 7 CLOSED|4" \
  "$(CW_HEAD_RUNS="201:in_progress\n201:completed" cw "OPEN $HA\nOPEN $HA\nCLOSED $HA" "2" 0 "" 7 --interval 1)"
check "unread: the head's runs cannot be read, exit 5" "ci-watch: unread 7 gh run list failed: gh: HTTP 502|5" \
  "$(CW_HEAD_RUNS="fail" cw "OPEN $HA" "2" 0 "" 7 --interval 1)"
check "a run of the head still unfinished past the bound is no green: unread, exit 5" "5" \
  "$(CW_WAIT=1 CW_HEAD_RUNS="201:in_progress" cw "OPEN $HA" "2" 0 "" 7 --interval 1 | sed 's/.*|//')"
check "the repository is passed on to every gh call of the run wait" "0" \
  "$(CW_HEAD_RUNS="201:in_progress\n201:completed" cw "OPEN $HA" "2" 0 "" 7 --repo o/r --interval 1 >/dev/null; grep -vc -e '-R o/r' "$CW/gh-calls")"
check "the head's run watch never reaches stdout, it lands in the pull request's log" "0|1" \
  "$(CW_HEAD_RUNS="201:in_progress\n201:completed" cw "OPEN $HA" "2" 0 "" 7 --interval 1 | grep -c RUN-WATCH-MARKER)|$(grep -c RUN-WATCH-MARKER "$CWS/ci-watch/here-pr7.log")"
# The base branch's checks below count the logs holding a run watch's output: start them clean.
rm -rf "$CWS/ci-watch"
check "unread: the buckets cannot be read after the watch, exit 5" "ci-watch: unread 7 gh pr checks failed: gh: HTTP 502|5" \
  "$(CW_BUCKETS=fail cw "OPEN $HA" "2" 0 "" 7 --interval 1)"
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
check "every check skipped with auto-merge, not merged within the bound: no-checks, exit 2" "ci-watch: no-checks 7 $HA skipped=1|2" \
  "$(CW_MERGE_WAIT=1 CW_BUCKETS="docs:skipping" cw "OPEN $HA\nOPEN $HA auto" "2" 0 "" 7 --interval 1)"
check "every check skipped with auto-merge, then merged: the base branch followed" "ci-watch: base-green 7 $HM|0" \
  "$(CW_MERGE="$HM main" CW_RUNS="101:CI" CW_BUCKETS="docs:skipping" cw "OPEN $HA\nOPEN $HA auto\nMERGED $HA" "2" 0 "" 7 --interval 1)"
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

# A draft pull request: a red whose every failing check is a draft guard is no red. The watch
# runs without --fail-fast (it would stop on the guard before the real checks finish), then the
# failing names are classified by draft_guard.py; a pull request that is no draft keeps its path.
# The view file's `draft` token is what `gh pr view --json isDraft` answers from.
CWD="OPEN $HA draft"
# On a draft, green needs a passed check whose job needs the guard (`draft_guard.py --dependents`),
# so the passed checks of these cases (build, lint) are jobs behind the guard of run 570.
printf '[%s, %s, %s]\n' "$C_WIP_N" "$C_BUILD_N" "$C_LINT_N" > "$CW/checks-link"
check "a draft whose only failure is a draft guard is no red: green, exit 0" "ci-watch: green 7 $HA|0" \
  "$(rm -rf "$CWS/draft-guard"; cw "$CWD" "2" 1 "wip-check / wip-check" 7 --interval 1)"
# Measured on another project: four guard checks failed and every real job, depending on the
# guard, was skipped. The guard settled, nothing had run, and the watch said green.
check "a draft whose guard fails and whose every other check is skipped: no-checks, exit 2" "ci-watch: no-checks 7 $HA skipped=5|2" \
  "$(rm -rf "$CWS/draft-guard"; CW_BUCKETS="code-style:skipping\nsecurity-check:skipping\ntests:skipping\nMigrations:skipping\nbuild:skipping\nwip-check / wip-check:fail\nwip-check / wip-check:fail\nwip-check / wip-check:fail\nwip-check / wip-check:fail" cw "$CWD" "2" 1 "wip-check / wip-check" 7 --interval 1)"
check "a draft whose guard fails, one real check passing beside skipped ones: green, exit 0" "ci-watch: green 7 $HA|0" \
  "$(rm -rf "$CWS/draft-guard"; CW_BUCKETS="lint:pass\ntests:skipping\nwip-check / wip-check:fail" cw "$CWD" "2" 1 "wip-check / wip-check" 7 --interval 1)"
# Measured again on that project: an outside check (a secret scanner) depends on no guard and
# passed, so the guard settled, one check had passed, and the watch said green with no job run.
printf '[%s, %s, %s]\n' "$C_WIP_N" "$C_DOCS_N" "$C_EXT_P" > "$CW/checks-link"
check "a draft whose guard fails, whose jobs are skipped and whose outside check passes: no-checks, exit 2" "ci-watch: no-checks 7 $HA skipped=1|2" \
  "$(rm -rf "$CWS/draft-guard"; CW_BUCKETS="secrets:pass\ndocs:skipping\nwip-check / wip-check:fail" cw "$CWD" "2" 1 "wip-check / wip-check" 7 --interval 1)"
printf '[%s, %s, %s]\n' "$C_WIP_N" "$C_BUILD_N" "$C_EXT_P" > "$CW/checks-link"
check "the same with a job behind the guard passed beside the outside check: green, exit 0" "ci-watch: green 7 $HA|0" \
  "$(rm -rf "$CWS/draft-guard"; CW_BUCKETS="secrets:pass\nbuild:pass\nwip-check / wip-check:fail" cw "$CWD" "2" 1 "wip-check / wip-check" 7 --interval 1)"
check "a draft with no guard among its checks and one passed: green as before, no run read" "ci-watch: green 7 $HA|0|0" \
  "$(rm -rf "$CWS/draft-guard"; cw "$CWD" "2" 0 "" 7 --interval 1)|$(grep -c '^api' "$CW/gh-calls")"
printf '[%s, %s, %s]\n' "$C_WIP_N" "$C_BUILD_N" "$C_LINT_N" > "$CW/checks-link"
printf '[%s, %s]\n' "$C_WIP" "$C_TESTS" > "$CW/checks-link"
check "and with a real failure too: red, naming only the real one" "ci-watch: red 7 $HA tests|1" \
  "$(rm -rf "$CWS/draft-guard"; cw "$CWD" "2" 1 "wip-check / wip-check\ntests" 7 --repo acme/thing --interval 1)"
check "a draft's watch runs without --fail-fast, once" "0|1" \
  "$(rm -rf "$CWS/draft-guard"; cw "$CWD" "2" 1 "wip-check / wip-check\ntests" 7 --interval 1 >/dev/null
     grep -c -e '--fail-fast' "$CW/gh-calls")|$(grep -c -e '--watch' "$CW/gh-calls")"
check "the same failures on a pull request that is no draft: red naming both, --fail-fast kept, no run read" \
  "ci-watch: red 7 $HA wip-check / wip-check, tests|1|1|0" \
  "$(rm -rf "$CWS/draft-guard"; cw "OPEN $HA" "2" 1 "wip-check / wip-check\ntests" 7 --interval 1)|$(grep -c -e '--fail-fast' "$CW/gh-calls")|$(grep -c '^api' "$CW/gh-calls")"
check "a pull request made ready during the watch reads its guard as a red" "ci-watch: red 7 $HA wip-check / wip-check, tests|1" \
  "$(rm -rf "$CWS/draft-guard"; cw "$CWD\nOPEN $HA" "2" 1 "wip-check / wip-check\ntests" 7 --interval 1)"
# A watch that exits non-zero names no failing check when `gh` itself failed (an API error): that is
# no draft guard, so it must not settle to a pass.
printf '[%s]\n' "$C_PASS" > "$CW/checks-link"
check "a draft whose watch exits non-zero with no failing check is not green: unread, exit 5" "5" \
  "$(rm -rf "$CWS/draft-guard"; cw "$CWD" "2" 1 "" 7 --interval 1 | sed 's/.*|//')"
check "and its report never says green" "0" \
  "$(rm -rf "$CWS/draft-guard"; cw "$CWD" "2" 1 "" 7 --interval 1 | grep -c 'ci-watch: green')"
rm -f "$CW/checks-link"
check "a draft whose failing checks cannot be classified: unread, exit 5" "ci-watch: unread 7 draft_guard|5" \
  "$(rm -rf "$CWS/draft-guard"; cw "$CWD" "2" 1 "wip-check / wip-check" 7 --interval 1 | sed 's/\(draft_guard\).*|/\1|/')"

# The owner file: the session that armed a watch, beside its log, is the key the stop gate tells a
# session its own watches by. A watch armed by no session leaves no owner file behind.
OWN="$CWS/ci-watch/here-pr7.log.session"
rm -rf "$CWS/ci-watch"
check "a watch armed by a session writes its owner file: the session's id, on one line" "sess-42|1" \
  "$(CW_SESSION=sess-42 cw "OPEN $HA" "2" 0 "" 7 --interval 1 >/dev/null; echo "$(cat "$OWN")|$(wc -l < "$OWN" | tr -d ' ')")"
check "a watch armed by no session removes the owner file an earlier watch left" "present|absent" \
  "$(CW_SESSION=sess-42 cw "OPEN $HA" "2" 0 "" 7 --interval 1 >/dev/null; echo "$([ -e "$OWN" ] && echo present || echo absent)|$(cw "OPEN $HA" "2" 0 "" 7 --interval 1 >/dev/null; [ -e "$OWN" ] && echo present || echo absent)")"
mkdir -p "$OWN"
check "an owner file that cannot be written is unread, exit 5" "ci-watch: unread 7 cannot write $OWN|5" \
  "$(CW_SESSION=sess-42 cw "OPEN $HA" "2" 0 "" 7 --interval 1)"
rm -rf "$OWN"

echo "== stop gate: the prose and the pins that survive the module =="
# The hook's own cases — the wake decision, the once-per-tell CI record, the deadline race,
# the sweep it runs after a passing stop — moved module-side with the gate
# (hooks/tests/stop-gate.test.ts, run by the host's plugin test). What stays here is what
# the module cannot check itself: the prose the briefs and references must carry, the
# succession figures, and the registration pins.
check "the phase brief template ends the delivery at the push, no CI watch" "yes|no|no" \
  "$(spells "$ROOT/templates/agent-phase-brief.md" 'The delivery ends at the push')|$(spells "$ROOT/templates/agent-phase-brief.md" 'gh pr checks')|$(spells "$ROOT/templates/agent-phase-brief.md" 'in the foreground')"
check "the standing rules say an agent never waits on CI" "yes|no" \
  "$(spells "$ROOT/skills/orchestrator/references/briefs.md" '**An agent never waits on CI.**')|$(spells "$ROOT/skills/orchestrator/references/briefs.md" 'timeout 590 gh pr checks <n> --watch')"
check "the orchestrator skill arms one background watch per pull request" "yes|yes|yes" \
  "$(spells "$ORCH_REFS/review.md" 'start `ci-watch.sh <n>`')|$(spells "$ORCH_REFS/review.md" 'with `run_in_background` and a timeout of 7 200 000 ms: one per pull request, never two')|$(spells "$ORCH_REFS/review.md" 'Moved: re-arm on the new head')"
check "and reads each ending: red, no checks, closed, unread" "yes|yes|yes|yes" \
  "$(spells "$ORCH_REFS/review.md" 'dispatch the correction at once, to a fresh session')|$(spells "$ORCH_REFS/review.md" 'No checks, none registered or none passed (each one skipped, `skipped=<n>`, never a green): ready on the suite')|$(spells "$ORCH_REFS/review.md" 'Closed: stop the work on it')|$(spells "$ORCH_REFS/review.md" 'Unread, or the timeout: re-arm once, then report')"
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
# status, progress and agents are answered by the hooks module without a model turn; their
# bodies run only when that answer fails, and each says so, with what the answer leaves out.
check "the three hooked commands say the module answers them and their body is the fallback" "yes|yes|yes" \
  "$(for c in status agents progress; do spells "$ROOT/commands/$c.md" 'The hooks module answers this command on the spot, with no model turn'; done | paste -sd'|' -)"
# The question of a decision round ends on the machine line: the stop gate refuses a turn
# whose last line is a bare question.
check "a decision round's question ends on the operator's machine line" "yes" \
  "$(spells "$ROOT/commands/decide.md" 'text, as the message'"'"'s last line: `waiting: operator — blocks: <the question>`')"
check "a relayed ruling is dated by a command, pasted, never from memory" "yes|no" \
  "$(spells "$ROOT/commands/decide.md" 'the ruling verbatim, dated (`date -u +%FT%TZ`, pasted),')|$(spells "$ROOT/commands/decide.md" 'the ruling verbatim, dated,')"
# The operator's time: a round is a wave of questions back to back, nothing relayed or launched
# inside it; the relays and the work come at its end, and a second wave is chained at once.
check "a decision round asks its questions back to back and acts only when the wave ends" "yes|yes|yes" \
  "$(spells "$ROOT/commands/decide.md" 'in this same message, right under the')|$(spells "$ROOT/commands/decide.md" 'nothing relayed, launched or reported inside a wave')|$(spells "$ROOT/commands/decide.md" 'announce « Wave 2: M questions, back to back. »')"
check "a decision round no longer relays a ruling before the next question" "no" \
  "$(spells "$ROOT/commands/decide.md" 'Present the next question IN FULL (step 2). Not before.')"
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
check "step 5 announces the successor's own measured context from its measure file" "1|1" \
  "$(printf '%s' "$SUCC5" | grep -oF 'context_tokens' | wc -l | tr -d ' ')|$(printf '%s' "$SUCC5" | grep -oF 'measure file' | wc -l | tr -d ' ')"
# Every successor measures its takeover at the same point, the turn that sends « takeover
# confirmed », so one orchestration's takeover figures compare from one succession to the next:
# step 4 keeps the figure recorded when that turn ends, and step 5 reports that reading only.
# The module writes the measure file only when a turn ends: a reading inside the turn that
# sends « takeover confirmed » is the turn before's, or no file at all on a first turn. The
# figure is the one recorded when that turn ends, read at the next turn's first tool call.
check "step 4 takes the takeover figure the module records when the « takeover confirmed » turn ends" "1|1|0" \
  "$(succ4_has 'Your « at takeover confirmed » figure is the `context_tokens` the module records when the turn that sends « takeover confirmed » ends')|$(succ4_has 'read your measure file at the first tool call of your next turn and keep that figure')|$(succ4_has 'immediately before the message')"
check "step 5 reports the context kept at « takeover confirmed », never a later reading" "1|1" \
  "$(printf '%s' "$SUCC5" | grep -oF 'your own measured context at « takeover confirmed »' | wc -l | tr -d ' ')|$(printf '%s' "$SUCC5" | grep -oF 'the one step 4 kept, never a later reading' | wc -l | tr -d ' ')"
# The successor also keeps its first turn's reading: the gap between it and the « takeover
# confirmed » reading is what the takeover's verification costs.
# Live, a successor asked to read its measure file at its first tool call found none: the
# module writes it only when a turn ends. The « first turn » figure is the one recorded at
# the end of the first turn, read at the second turn's first tool call.
check "step 1 says the measure file is written only when a turn ends, and asks no reading before" "1|0|0" \
  "$(printf '%s' "$SUCC1" | grep -oF 'the module writes it only when a turn of yours ends, so it is not there during your first turn' | wc -l | tr -d ' ')|$(printf '%s' "$SUCC1" | grep -oF 'Your FIRST tool call, ahead of any skill load, reads your own measure file' | wc -l | tr -d ' ')|$(printf '%s' "$SUCC1" | grep -oF 'at this call' | wc -l | tr -d ' ')"
check "step 1's « first turn » figure is the one recorded at the end of the first turn, read at the next turn's first tool call" "1" \
  "$(printf '%s' "$SUCC1" | grep -oF 'Your « first turn » figure is the `context_tokens` it records when your first turn ends: read the file at the first tool call of your next turn and keep that figure' | wc -l | tr -d ' ')"
# A file still missing when it is read — a first turn the host could not measure — gets the
# four agent briefs' guard: no figure rather than an estimate.
check "step 1 guards the measure file missing when it is read" "1" \
  "$(printf '%s' "$SUCC1" | grep -oF 'If it is not there, say so and give no figure: an estimate presented as a measurement is worse than an admitted gap' | wc -l | tr -d ' ')"
check "step 5 reports both figures, « first turn » and « at takeover confirmed », on one line" "1|1" \
  "$(printf '%s' "$SUCC5" | grep -oF 'both on one line: « first turn » and « at takeover confirmed »' | wc -l | tr -d ' ')|$(printf '%s' "$SUCC5" | grep -oF 'the figure kept in step 1' | wc -l | tr -d ' ')"
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
# {{GAUGE}} is gone from the template with the gauge script it named — the module's measure
# file replaced both — and what this fill proves is the size limit over a full brief.
sed -E -e 's#\{\{PROJECT\}\}#scratch#g' -e 's#\{\{PREDECESSOR_NAME_PATTERN\}\}#Orch : scratch#g' \
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
# A succession brief written by hand dropped the template's step 4, and the predecessor stayed
# open a day after the takeover: a brief whose reader confirms the takeover to its predecessor
# carries the launcher's close, and a brief whose reader is the one handed over from is not held.
SUCCHAND="$WORK/succession-by-hand.md"
cat > "$SUCCHAND" <<'BRIEF'
# Handover: you are Orch : scratch

You succeed the session Orch: scratch.

## Your first moves

1. Send the coordinator one line with your new name.
2. Reply to your predecessor with exactly « takeover confirmed ».
3. Then end your turn on `waiting: done`.
BRIEF
check "a succession brief without the predecessor's close is a finding naming the step and the template" "1|1|1" \
  "$(bash "$LINT" "$SUCCHAND" >/dev/null 2>&1; echo $?)|$(bash "$LINT" "$SUCCHAND" 2>&1 | grep -c "succession brief without the predecessor's close")|$(bash "$LINT" "$SUCCHAND" 2>&1 | grep -c 'instantiate the template')"
SUCCHANDCLOSE="$WORK/succession-by-hand-close.md"
{ cat "$SUCCHAND"; printf '4. On its handed over, close its tab: `iterm-agent.sh list`, then close --tty <its tty> --expect-title "Orch: scratch".\n'; } > "$SUCCHANDCLOSE"
check "the same brief with the close lints clean" "0" "$(bash "$LINT" "$SUCCHANDCLOSE" >/dev/null 2>&1; echo $?)"
SUCCHANDNOTITLE="$WORK/succession-by-hand-no-title.md"
{ cat "$SUCCHAND"; printf '4. On its handed over, close its tab: close --tty <its tty>.\n'; } > "$SUCCHANDNOTITLE"
check "a close with no expected title is still the finding" "1" "$(bash "$LINT" "$SUCCHANDNOTITLE" >/dev/null 2>&1; echo $?)"
SUCCFROM="$WORK/handed-over-from.md"
printf '# scratch: audit\n\nWait for « takeover confirmed », answer it with « handed over » as your last message.\n' > "$SUCCFROM"
check "a brief whose reader is handed over from is not held to the close" "0" "$(bash "$LINT" "$SUCCFROM" >/dev/null 2>&1; echo $?)"
check "succeed.md has the brief from the template, never by hand, and « handed over » sent with SendMessage" "yes|yes|yes" \
  "$(spells "$ROOT/commands/succeed.md" 'never a brief written by hand')|$(spells "$ROOT/commands/succeed.md" 'with `SendMessage` to the name it confirmed from')|$(spells "$ROOT/commands/succeed.md" 'a line written in your own tab reaches no one')"
check "the skill sends « handed over » with SendMessage, not as a line in the predecessor's own tab" "yes|yes" \
  "$(spells "$ROOT/skills/orchestrator/SKILL.md" 'is your last message, sent with `SendMessage` to it')|$(spells "$ROOT/skills/orchestrator/SKILL.md" 'a line in your tab reaches no one')"
check "the README's hooks table names the Stop hook" "yes" "$(spells "$ROOT/README.md" 'hook `Stop`')"
check "the eval selection says its two stop-gate cases grade the staged spawn line and do not run the hook" "2" \
  "$(grep -E '^\| 5[12] \|' "$ROOT/evals/SELECTION.md" | grep -c 'under staging; it does not run the hook')"
check "hooks.json declares the module and nothing else" "1|0|0" \
  "$("$py" -c 'import json,sys; d=json.load(open(sys.argv[1])); print(str(sum(m=="./register.ts" for m in d.get("modules",[])))+"|"+str(len(d.get("hooks",{})))+"|"+str(sum(k!="description" and k!="modules" for k in d)))' "$ROOT/hooks/hooks.json" 2>/dev/null)"
# The module's log is appended, never read and rewritten: every session shares it, and a
# read-then-write lost the lines written in between and wiped the history past the host's
# 4 MiB read limit. Forty writers at once keep all forty lines; past the cap the log moves
# to its one `.1` generation and the next line starts a fresh file.
LOGD="$WORK/module-log"
for i in $(seq 1 40); do sh "$ROOT/hooks/log-append.sh" "$LOGD/hooks-module.log" "line $i" 1000000 & done; wait
check "the module's log keeps every line forty sessions append at once" "40|40" \
  "$(wc -l < "$LOGD/hooks-module.log" | tr -d ' ')|$(sort -u "$LOGD/hooks-module.log" | grep -c '^line [0-9]*$')"
sh "$ROOT/hooks/log-append.sh" "$LOGD/hooks-module.log" "past the cap" 100
check "a log past its cap is rotated to one .1 generation, the new line alone in the fresh file" "40|past the cap|no" \
  "$(grep -c '^line' "$LOGD/hooks-module.log.1")|$(cat "$LOGD/hooks-module.log")|$([ -e "$LOGD/hooks-module.log.lock" ] && echo yes || echo no)"

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
# Which row IS the host. Matched on the full HOST_CLI path, a host typed as a bare command
# was « not running » whenever HOST_CLI was absolute, and a wrapper that `exec`s the binary
# made every spawn die « never started » after its tab existed. A row is the host when the
# host registered its pid, or when its program's basename is HOST_CLI's or that of what
# HOST_CLI resolves to.
printf '/dev/ttys901 claude --resume x\n' > "$WORK/ps-bare.txt"
printf '/dev/ttys901 /opt/homebrew/bin/claude --name Agent : x\n' > "$WORK/ps-binary.txt"
printf '/dev/ttys901 4242 node /opt/lib/cli.js --resume x\n' > "$WORK/ps-node.txt"
printf '/dev/ttys901 -zsh\n' > "$WORK/ps-shell.txt"
mkdir -p "$WORK/wrapbin" "$WORK/hostcfg/sessions"
printf '#!/bin/bash\nexec /opt/homebrew/bin/claude "$@"\n' > "$WORK/wrapbin/claude"
printf '#!/bin/bash\nexec /opt/homebrew/bin/claude "$@"\n' > "$WORK/wrapbin/run-host.sh"
chmod +x "$WORK/wrapbin/claude" "$WORK/wrapbin/run-host.sh"
ln -sf "$WORK/wrapbin/claude" "$WORK/wrapbin/host-link"
hostp() { ORCHESTRATOR_HOST_CLI="$1" ORCHESTRATOR_PS_TABLE="$2" CLAUDE_CONFIG_DIR="$WORK/hostcfg" \
  ipy "print('host' if ia.host_cli_on('/dev/ttys901') else 'none')"; }
check "an absolute HOST_CLI matches a bare host row" "host" "$(hostp /opt/homebrew/bin/claude "$WORK/ps-bare.txt")"
check "a wrapper path matches the binary's row" "host" "$(hostp "$WORK/wrapbin/claude" "$WORK/ps-binary.txt")"
check "a link to the wrapper matches through what it resolves to" "host" "$(hostp "$WORK/wrapbin/host-link" "$WORK/ps-binary.txt")"
check "a wrapper named otherwise does not match on argv alone" "none" "$(hostp "$WORK/wrapbin/run-host.sh" "$WORK/ps-node.txt")"
printf '{"pid":4242,"sessionId":"s-reg","name":"Agent : x"}\n' > "$WORK/hostcfg/sessions/4242.json"
check "a pid the host registered is the host, whatever its argv" "host" "$(hostp "$WORK/wrapbin/run-host.sh" "$WORK/ps-node.txt")"
check "a shell on the tty is not the host" "none" "$(hostp /opt/homebrew/bin/claude "$WORK/ps-shell.txt")"
check "verify reads a bare host row under an absolute HOST_CLI" "0" \
  "$(ORCHESTRATOR_HOST_CLI=/opt/homebrew/bin/claude ORCHESTRATOR_PS_TABLE="$WORK/ps-bare.txt" bash "$AGENT" verify --tty /dev/ttys901 >/dev/null 2>&1; echo $?)"
# --pid narrows verify to one process, and counts EVERY host CLI on the tty: a session that
# runs a nested host CLI shows two, and the recorded one is not always the first.
printf '/dev/ttys901 5100 a-host --name outer\n/dev/ttys901 5101 a-host --nested\n' > "$WORK/ps-two.txt"
vpid() { ORCHESTRATOR_HOST_CLI=a-host ORCHESTRATOR_PS_TABLE="$WORK/ps-two.txt" CLAUDE_CONFIG_DIR="$WORK/hostcfg" \
  bash "$AGENT" verify --tty /dev/ttys901 "$@"; }
vpid_status() { vpid "$@" >/dev/null 2>&1; echo "exit $?"; }
check "verify --pid answers for the first host CLI on the tty" "a-host running on /dev/ttys901 (pid 5100)|exit 0" \
  "$(vpid --pid 5100 2>&1)|$(vpid_status --pid 5100)"
check "verify --pid answers for a host CLI that is not the first" "a-host running on /dev/ttys901 (pid 5101)|exit 0" \
  "$(vpid --pid 5101 2>&1)|$(vpid_status --pid 5101)"
check "verify --pid of a pid the tty does not run is not running, and silent" "|exit 1" \
  "$(vpid --pid 9999 2>&1)|$(vpid_status --pid 9999)"
check "verify without --pid names the first host CLI" "a-host running on /dev/ttys901 (pid 5100)" "$(vpid 2>&1)"
check "a --pid that is no number is a usage error, not « not running »" "exit 2|1" \
  "$(vpid_status --pid abc)|$(vpid --pid abc 2>&1 >/dev/null | grep -c 'invalid int value')"
check "the close note claims no more than the table showed" "1|0" \
  "$(ipy "print(ia.close_note('/dev/ttys901', None))" | grep -c 'no process matching claude was found on /dev/ttys901')|$(ipy "print(ia.close_note('/dev/ttys901', None))" | grep -c 'was running')"

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

# The tap and the gauge script are gone with the cutover, and their cases with them: the
# tap's writes, the freshness window, the transcript tier and the pruning are the module's
# now, pinned in hooks/tests/gauge-core.test.ts and gauge-band.test.ts (run by the host's
# plugin test), and the one file that survives — the measure file — is pinned there too.

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
# Whether the tab was closed is not the refusal's to assert: `refuse_made` says it after the
# text, from what the close returned.
check "the unread refusal names the checkout, the timeout, and the remedy, and claims no close" "1|1|0|1" \
  "$(unread_msg /work/dir 20 | grep -c '^spawn: refused: no transcript for /work/dir')|$(unread_msg /work/dir 20 | grep -c 'parked on a dialog or hung at start')|$(unread_msg /work/dir 20 | grep -c 'closed')|$(unread_msg /work/dir 20 | grep -c 'ORCHESTRATOR_MODE_TIMEOUT')"

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

# The whole spawn after its tab exists, over a fake app: a refusal closes the tab it made,
# prints its tty on stdout, says whether the close happened, and leaves the chain as it found
# it — the chain is written only once the session is verified. The « never started » refusal
# closed nothing and kept the tty to stderr, after a successor had already taken the
# predecessor's chain.
cat > "$WORK/spawn_probe.py" <<'PYEOF'
import asyncio, contextlib, io, json, os, sys
sys.path.insert(0, sys.argv[1])
import iterm_agent as ia
scenario, workdir = sys.argv[2], sys.argv[3]
argv = sys.argv[4:]
class S:
    def __init__(s, sid, tty): s.session_id = sid; s.tty = tty
    async def async_get_variable(s, k): return {"tty": s.tty}.get(k)
    async def async_close(s, force=False):
        if scenario.endswith("stuck"):
            raise RuntimeError("the app refused the close")
        for w in app.windows:
            w.tabs = [t for t in w.tabs if s not in t.sessions]
class T:
    def __init__(s, tid, sess): s.tab_id = tid; s.sessions = [sess]; s.all_sessions = [sess]
    @property
    def current_session(s): return s.sessions[0]
class W:
    def __init__(s, tabs): s.window_id = "w"; s.tabs = tabs
    async def async_create_tab(s, command=None, index=None, select=True):
        t = T("NEW", S("S-NEW", "/dev/ttys902"))
        s.tabs.insert(len(s.tabs) if index is None else index, t)
        return t
class App:
    def __init__(s, wins): s.windows = wins; s.current_window = wins[0]
app = App([W([T("1", S("S-OWN", "/dev/ttys801")), T("2", S("S-AG", "/dev/ttys802"))])])
class Api:
    async def async_get_app(self, connection): return app
ia.run = lambda fn: asyncio.run(fn(Api(), None))
ia.SPAWN_TIMEOUT = 1
ia.time.sleep = lambda s: None
ia.find_transcript = lambda d, since: "/x/t.jsonl" if scenario.startswith("transcript") else None
ia.verify_mode = lambda *a, **k: "spawn: mode auto read on the transcript"
closed_by_tty = []
ia.as_spawn = lambda command: (app.windows[0].tabs.append(T("AS", S("S-AS", "/dev/ttys902")))
                               or "/dev/ttys902")
ia.as_close = lambda tty, expect: closed_by_tty.append(tty) or "the made one"
if scenario.startswith("raise"):
    async def boom(tab, connection=None, tries=10): raise RuntimeError("the tab vanished")
    ia.tty_of = boom
out, err = io.StringIO(), io.StringIO()
code = 0
try:
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        ia.cmd_spawn(["--dir", workdir, "--prompt", "p"] + argv)
except SystemExit as e:
    code = e.code
def chain(name):
    try:
        return [(e["tab_id"], e["owner"]) for e in map(json.loads, open(os.path.join(ia.CHAINS_DIR, name)))]
    except OSError:
        return "absent"
print("exit=%s" % code)
print("stdout=%s" % out.getvalue().strip().splitlines()[-1:])
print("tabs=%s" % [t.tab_id for t in app.windows[0].tabs])
print("own=%s" % chain("ttys801.jsonl"))
print("new=%s" % chain("ttys902.jsonl"))
print("outside=%s" % chain("ttys999.jsonl"))
print("bytty=%s" % closed_by_tty)
print("ERR:" + " ".join(err.getvalue().split()))
PYEOF
PSPAWN="$WORK/ps-spawn"; mkdir -p "$PSPAWN"
: > "$PSPAWN/none"
printf '/dev/ttys902 claude --name Agent : x\n' > "$PSPAWN/running"
sprobe() { local scenario="$1" state="$WORK/spawnstate-$1" ps="$2" tty="$3"; shift 3
  rm -rf "$state"; mkdir -p "$state/chains"
  printf '{"tab_id":"2","tty":"/dev/ttys802","owner":"S-OWN"}\n' > "$state/chains/ttys801.jsonl"
  printf '{"tab_id":"7","tty":"/dev/ttys807","owner":"S-STRANGER"}\n' > "$state/chains/ttys999.jsonl"
  ORCHESTRATOR_BACKEND="${BACKEND:-api}" ORCHESTRATOR_STATE_DIR="$state" ORCHESTRATOR_SELF_TTY="$tty" \
    ORCHESTRATOR_PS_TABLE="$PSPAWN/$ps" "$py" "$WORK/spawn_probe.py" "$ROOT/skills/iterm-agents/scripts" \
    "$scenario" "$WORK" "$@" 2>&1; }
sfield() { printf '%s\n' "$1" | sed -n "s/^$2[=:]//p"; }
res=$(sprobe never none /dev/ttys801 --title "Agent : x")
check "a spawn that never started closes its tab, prints its tty, and leaves the chain untouched" \
  "1|['/dev/ttys902']|['1', '2']|[('2', 'S-OWN')]|1" \
  "$(sfield "$res" exit)|$(sfield "$res" stdout)|$(sfield "$res" tabs)|$(sfield "$res" own)|$(sfield "$res" ERR | grep -c 'never started on /dev/ttys902 after 1s; the tab was closed')"
res=$(sprobe succnever none /dev/ttys801 --successor --title "Orch : heir")
check "a successor that never started takes no chain and re-points no entry" \
  "1|['1', '2']|[('2', 'S-OWN')]|absent" \
  "$(sfield "$res" exit)|$(sfield "$res" tabs)|$(sfield "$res" own)|$(sfield "$res" new)"
res=$(sprobe neverstuck none /dev/ttys801 --title "Agent : x")
check "a close that fails is said, with the command that closes the tab" "1|1" \
  "$(sfield "$res" exit)|$(sfield "$res" ERR | grep -c 'the tab on /dev/ttys902 was NOT closed: close it with close --tty /dev/ttys902')"
res=$(sprobe agent running /dev/ttys801 --title "Agent : x")
check "a verified agent is appended to its caller's chain, and its tty printed last" \
  "0|['/dev/ttys902']|[('2', 'S-OWN'), ('NEW', 'S-OWN')]" \
  "$(sfield "$res" exit)|$(sfield "$res" stdout)|$(sfield "$res" own)"
res=$(sprobe succ running /dev/ttys801 --successor --title "Orch : heir")
check "a verified successor takes the chain" "0|[]|[('2', 'S-NEW')]" \
  "$(sfield "$res" exit)|$(sfield "$res" own)|$(sfield "$res" new)"
res=$(sprobe transcript none /dev/ttys801 --title "Agent : x")
check "a session that wrote its transcript has started, whatever the process table says" \
  "0|[('2', 'S-OWN'), ('NEW', 'S-OWN')]|1" \
  "$(sfield "$res" exit)|$(sfield "$res" own)|$(sfield "$res" ERR | grep -c 'but the session wrote /x/t.jsonl since the launch: it started')"
res=$(sprobe outside running /dev/ttys999 --successor --title "Orch : heir")
check "a caller the app does not know writes no chain entry, hands none over, and says so" \
  "0|[('7', 'S-STRANGER')]|absent|1" \
  "$(sfield "$res" exit)|$(sfield "$res" outside)|$(sfield "$res" new)|$(sfield "$res" ERR | grep -c 'the chain was not updated (the transfer was skipped)')"
res=$(sprobe raise none /dev/ttys801 --title "Agent : x")
check "a failure after the tab exists closes it and says what failed" "1|['1', '2']|1" \
  "$(sfield "$res" exit)|$(sfield "$res" tabs)|$(sfield "$res" ERR | grep -c 'then the terminal failed: the tab vanished; the tab was closed')"
res=$(BACKEND=applescript sprobe ascript none /dev/ttys801 --title "Agent : x")
check "the AppleScript rung says it keeps no chain, and a refusal there closes by tty" \
  "1|['/dev/ttys902']|[('2', 'S-OWN')]|1|1" \
  "$(sfield "$res" exit)|$(sfield "$res" bytty)|$(sfield "$res" own)|$(sfield "$res" ERR | grep -c 'this rung keeps no chain, so the chain was not updated (the append was skipped)')|$(sfield "$res" ERR | grep -c 'the tab was closed')"

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

# The installer asks the host for its version before it touches anything, so every run
# below goes through a stand-in host CLI: the suite must not depend on the host that
# happens to be on the machine, and two of the runs exist to show a refusal.
HBIN="$WORK/hostcli"; mkdir -p "$HBIN"
printf '#!/usr/bin/env bash\necho "2.1.292 (stand-in)"\n' > "$HBIN/claude"; chmod +x "$HBIN/claude"
OBIN="$WORK/oldcli"; mkdir -p "$OBIN"
printf '#!/usr/bin/env bash\necho "2.1.100 (stand-in)"\n' > "$OBIN/claude"; chmod +x "$OBIN/claude"
NBIN="$WORK/nocli"; mkdir -p "$NBIN"
printf '#!/usr/bin/env bash\necho "a version I will not say"\n' > "$NBIN/claude"; chmod +x "$NBIN/claude"
# Both scripts resolve CLAUDE_CONFIG_DIR before HOME: an operator's exported one would aim
# every case below at his real configuration, and the uninstall at its removal. Each run
# drops it, and the state override with it, so HOME alone decides where they act.
inst() { env -u CLAUDE_CONFIG_DIR -u ORCHESTRATOR_STATE_DIR HOME="$1" ORCHESTRATOR_HOST_CLI="$HBIN/claude" bash "$ROOT/install.sh" "${@:2}"; }
uninst() { env -u CLAUDE_CONFIG_DIR -u ORCHESTRATOR_STATE_DIR HOME="$1" bash "$ROOT/uninstall.sh" "${@:2}"; }
instwith() { env -u CLAUDE_CONFIG_DIR -u ORCHESTRATOR_STATE_DIR HOME="$1" ORCHESTRATOR_HOST_CLI="$2" bash "$ROOT/install.sh"; }
# The tab tooling's environment is planted, not built: a real build is network work the
# suite must not wait on. The stand-in python answers the probe the installer makes.
stub_venv() {
  mkdir -p "$1/.claude/claude-orchestrator/venv/bin"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$1/.claude/claude-orchestrator/venv/bin/python"
  chmod +x "$1/.claude/claude-orchestrator/venv/bin/python"
}

H0="$WORK/home0"; mkdir -p "$H0/.claude"
check_status "a host below 2.1.287 is refused" 1 \
  instwith "$H0" "$OBIN/claude"
check "the refusal names the floor and what needs it" "1" \
  "$(instwith "$H0" "$OBIN/claude" 2>&1 \
    | grep -c 'this plugin needs 2.1.287 or later (the hooks module)')"
check_status "a version that cannot be read is refused, not guessed at" 1 \
  instwith "$H0" "$NBIN/claude"
check "the unreadable refusal names where it looked" "1" \
  "$(instwith "$H0" "$NBIN/claude" 2>&1 | grep -c 'could not be read from')"
check "a refused install creates nothing" "none" \
  "$([ -e "$H0/.claude/claude-orchestrator" ] && echo made || echo none)"

# The unwrap, on a settings.json wired the way the tap's own installer wired it:
# tests/fixtures/tap-settings.json carries @TAP@ where that installer wrote its copy.
H="$WORK/home"; mkdir -p "$H/.claude"; stub_venv "$H"
sed "s#@TAP@#$H/.claude/claude-orchestrator/statusline-tap.sh#" \
  "$ROOT/tests/fixtures/tap-settings.json" > "$H/.claude/settings.json"
printf '{"type":"command","command":"/x/bar.sh","padding":0}\n' \
  > "$H/.claude/claude-orchestrator/statusline.previous.json"
inst "$H" >/dev/null 2>&1
check "a saved status line is restored whole by the unwrap" \
  '{"type":"command","command":"/x/bar.sh","padding":0}' "$(jq -c '.statusLine' "$H/.claude/settings.json")"
check "the rest of settings is untouched by the unwrap" "1" "$(jq '.other' "$H/.claude/settings.json")"
check "measure directory created" "yes" \
  "$([ -d "$H/.claude/claude-orchestrator/measure" ] && echo yes || echo no)"
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
inst "$H" >/dev/null 2>&1
check "an existing tier map is never overwritten" "a-model" \
  "$(jq -r .deep "$H/.claude/claude-orchestrator/models.json")"
check "an existing catalogue is left byte for byte" "$catbefore" \
  "$(cat "$H/.claude/claude-orchestrator/mcp.json")"
check "the installer says which of the two it found" "1|1" \
  "$(inst "$H" 2>&1 | grep -c "server catalogue already present: $H/.claude/claude-orchestrator/mcp.json$")|$(inst "$H" 2>&1 | grep -c 'tier map already present')"
before=$(cat "$H/.claude/settings.json")
inst "$H" >/dev/null 2>&1
check "second run leaves settings untouched" "$before" "$(cat "$H/.claude/settings.json")"
# The module's log rotates to one `.1` file beside a lock; the uninstall takes all three.
for f in hooks-module.log hooks-module.log.1 hooks-module.log.lock; do
  printf 'line\n' > "$H/.claude/claude-orchestrator/$f"
done
uninst "$H" >/dev/null 2>&1
# A plain install writes the one rule that lets the launcher's opening through the host's
# review, once, on the operator's standing ruling; --allow-open stays accepted for the
# earlier instructions that still name it.
OPSUFFIX='/skills/iterm-agents/scripts/iterm-agent.sh spawn --open *)'
OPRULE="Bash($(cd "$ROOT" && pwd)$OPSUFFIX"
HO="$WORK/homeopen"; mkdir -p "$HO/.claude"; stub_venv "$HO"
printf '{"permissions":{"allow":["Bash(ls)"]}}\n' > "$HO/.claude/settings.json"
check "a dry run says the rule it would write and writes nothing" "1|0" \
  "$(inst "$HO" --dry-run 2>&1 | grep -c 'dry-run. the opening of an orchestrator allowed')|$(jq --arg r "$OPRULE" '[.permissions.allow[] | select(. == $r)] | length' "$HO/.claude/settings.json")"
check "a plain install writes the rule, and no run asks the operator for a flag" "1|0" \
  "$(inst "$HO" >/dev/null 2>&1; jq --arg r "$OPRULE" '[.permissions.allow[] | select(. == $r)] | length' "$HO/.claude/settings.json")|$(inst "$HO" 2>&1 | grep -c 'the operator allows it with ./install.sh --allow-open')"
check "a plain install writes the rule once, beside the rules already there" "[\"Bash(ls)\",\"$OPRULE\"]" \
  "$(inst "$HO" >/dev/null 2>&1; inst "$HO" >/dev/null 2>&1; jq -c '.permissions.allow' "$HO/.claude/settings.json")"
check "a run after it says it is allowed, and no run asks for the flag" "1|0" \
  "$(inst "$HO" 2>&1 | grep -c 'is already allowed')|$(inst "$HO" 2>&1 | grep -c 'allows it with')"
HO2="$WORK/homeopen2"; mkdir -p "$HO2/.claude"; stub_venv "$HO2"
check "with no settings.json yet, a plain install creates it with the rule alone" "[\"$OPRULE\"]" \
  "$(inst "$HO2" >/dev/null 2>&1; jq -c '.permissions.allow' "$HO2/.claude/settings.json" 2>/dev/null)"
HO5="$WORK/homeopen5"; mkdir -p "$HO5/.claude"; stub_venv "$HO5"
printf '{"permissions":{"allow":["Bash(ls)"]}}\n' > "$HO5/.claude/settings.json"
check "--allow-open is still accepted and leaves the same permissions.allow as a plain install" "0|$(jq -c '.permissions.allow' "$HO/.claude/settings.json")" \
  "$(inst "$HO5" --allow-open >/dev/null 2>&1; echo $?)|$(jq -c '.permissions.allow' "$HO5/.claude/settings.json")"
check "an unknown option is refused before anything is done" "2" "$(inst "$HO" --bogus >/dev/null 2>&1; echo $?)"
# A rule granted an earlier version, beside this one in the same cache directory, follows
# the plugin to this path at a plain install; a rule for a launcher elsewhere is left alone.
HO3="$WORK/homeopen3"; mkdir -p "$HO3/.claude"; stub_venv "$HO3"
OPOLD="Bash($(dirname "$(cd "$ROOT" && pwd)")/0.0.1-old$OPSUFFIX"; OPELSE="Bash(/elsewhere/x$OPSUFFIX"
jq -n --arg a "$OPOLD" --arg b "$OPELSE" '{permissions: {allow: ["Bash(ls)", $a, $b]}}' > "$HO3/.claude/settings.json"
check "a rule granted an earlier version names this one after a plain install, one of it, the rest untouched" \
  "$(jq -nc --arg b "$OPELSE" --arg r "$OPRULE" '["Bash(ls)", $b, $r]')" \
  "$(inst "$HO3" >/dev/null 2>&1; jq -c '.permissions.allow' "$HO3/.claude/settings.json")"
HO4="$WORK/homeopen4"; mkdir -p "$HO4/.claude"; stub_venv "$HO4"
printf '{"permissions":{"allow":"Bash(ls)"}}\n' > "$HO4/.claude/settings.json"
check "permissions.allow that is not a list is said, left as it is, and the install still ends well" "1|\"Bash(ls)\"|0" \
  "$(inst "$HO4" 2>&1 | grep -c 'permissions.allow in settings.json is not a list')|$(jq -c '.permissions.allow' "$HO4/.claude/settings.json")|$(inst "$HO4" >/dev/null 2>&1; echo $?)"

check "uninstall removes the state directory, the module's rotated log and lock with it" "gone|absent|absent" \
  "$([ -d "$H/.claude/claude-orchestrator" ] && echo kept || echo gone)|$([ -e "$H/.claude/claude-orchestrator/hooks-module.log.1" ] && echo present || echo absent)|$([ -e "$H/.claude/claude-orchestrator/hooks-module.log.lock" ] && echo present || echo absent)"

H2="$WORK/home2"; mkdir -p "$H2/.claude"; stub_venv "$H2"
sed "s#@TAP@#$H2/.claude/claude-orchestrator/statusline-tap.sh#" \
  "$ROOT/tests/fixtures/tap-settings.json" > "$H2/.claude/settings.json"
inst "$H2" >/dev/null 2>&1
check "no saved object: the tap's prefix is stripped" "/x/bar.sh" \
  "$(jq -r '.statusLine.command' "$H2/.claude/settings.json")"

# The follower is the authority whenever there is one: the saved object dates from the
# day the tap was wired, and an operator may have changed his line since — or made it
# portable. Restoring the saved command would undo both and write a machine-absolute
# path into a settings file other machines share. The saved object only fills the keys
# the line lacks; the command stays the follower, spelled as it was written.
H2B="$WORK/home2b"; mkdir -p "$H2B/.claude/claude-orchestrator"; stub_venv "$H2B"
jq --arg cmd '$HOME/.claude/claude-orchestrator/statusline-tap.sh $HOME/.claude/statusbar/statusline.sh' \
  '.statusLine.command = $cmd | del(.statusLine.padding)' "$ROOT/tests/fixtures/tap-settings.json" > "$H2B/.claude/settings.json"
printf '{"type":"command","command":"/Users/elsewhere/.claude/statusbar/statusline.sh","padding":2}\n' \
  > "$H2B/.claude/claude-orchestrator/statusline.previous.json"
inst "$H2B" >/dev/null 2>&1
check "a saved object never overrides the follower: its spelling is kept, the missing keys filled" \
  '{"type":"command","command":"$HOME/.claude/statusbar/statusline.sh","padding":2}' \
  "$(jq -c '.statusLine' "$H2B/.claude/settings.json")"

# The uninstall unwraps the same way, through the same code: the follower kept as
# written beside a saved object, and kept as well when no saved object exists — the
# status bar behind the tap is the operator's, not the plugin's to drop.
H2C="$WORK/home2c"; mkdir -p "$H2C/.claude/claude-orchestrator"
jq --arg cmd '$HOME/.claude/claude-orchestrator/statusline-tap.sh $HOME/.claude/statusbar/statusline.sh' \
  '.statusLine.command = $cmd' "$ROOT/tests/fixtures/tap-settings.json" > "$H2C/.claude/settings.json"
printf '{"type":"command","command":"/Users/elsewhere/.claude/statusbar/statusline.sh","padding":0}\n' \
  > "$H2C/.claude/claude-orchestrator/statusline.previous.json"
uninst "$H2C" >/dev/null 2>&1
check "uninstall keeps the follower's spelling beside a saved object" \
  '$HOME/.claude/statusbar/statusline.sh' "$(jq -r '.statusLine.command' "$H2C/.claude/settings.json")"
H2D="$WORK/home2d"; mkdir -p "$H2D/.claude/claude-orchestrator"
sed "s#@TAP@#$H2D/.claude/claude-orchestrator/statusline-tap.sh#" \
  "$ROOT/tests/fixtures/tap-settings.json" > "$H2D/.claude/settings.json"
uninst "$H2D" >/dev/null 2>&1
check "uninstall with no saved object keeps the follower, not an empty settings" "/x/bar.sh|0" \
  "$(jq -r '.statusLine.command' "$H2D/.claude/settings.json")|$(jq -r '.statusLine.padding' "$H2D/.claude/settings.json")"
H2E="$WORK/home2e"; mkdir -p "$H2E/.claude/claude-orchestrator"
jq --arg cmd "$H2E/.claude/claude-orchestrator/statusline-tap.sh" '.statusLine.command = $cmd' \
  "$ROOT/tests/fixtures/tap-settings.json" > "$H2E/.claude/settings.json"
printf '{"type":"command","command":"/x/saved.sh"}\n' > "$H2E/.claude/claude-orchestrator/statusline.previous.json"
uninst "$H2E" >/dev/null 2>&1
check "uninstall restores the saved object whole when the tap was all the line held" \
  '{"type":"command","command":"/x/saved.sh"}' "$(jq -c '.statusLine' "$H2E/.claude/settings.json")"

H3="$WORK/home3"; mkdir -p "$H3/.claude"; stub_venv "$H3"
jq --arg cmd "$H3/.claude/claude-orchestrator/statusline-tap.sh" '.statusLine.command = $cmd' \
  "$ROOT/tests/fixtures/tap-settings.json" > "$H3/.claude/settings.json"
inst "$H3" >/dev/null 2>&1
check "a statusLine that held only the tap is removed" "null" "$(jq '.statusLine' "$H3/.claude/settings.json")"

H4="$WORK/home4"; mkdir -p "$H4/.claude"; stub_venv "$H4"
jq --arg cmd "/x/other.sh" '.statusLine.command = $cmd' \
  "$ROOT/tests/fixtures/tap-settings.json" > "$H4/.claude/settings.json"
inst "$H4" >/dev/null 2>&1
check "a statusLine carrying no tap is left untouched" "/x/other.sh" \
  "$(jq -r '.statusLine.command' "$H4/.claude/settings.json")"

# An unparseable settings.json is named on stderr and skipped, never silently read as
# empty: the operator must know the unwrap never ran, for the tap's wiring may still be
# in the broken file, and the rest of the install is no hostage to it.
H4B="$WORK/home4b"; mkdir -p "$H4B/.claude"; stub_venv "$H4B"
printf '{"statusLine": {"command": "not json' > "$H4B/.claude/settings.json"
before=$(cat "$H4B/.claude/settings.json")
check "an unparseable settings.json still installs, says what was skipped, touches nothing" "0|1|1" \
  "$(inst "$H4B" >/dev/null 2>&1; echo $?)|$(inst "$H4B" 2>&1 >/dev/null | grep -c 'does not parse as JSON')|$([ "$(cat "$H4B/.claude/settings.json")" = "$before" ] && echo 1 || echo 0)"
# The broken file may still point at the tap's copy: the copy stays while it might be
# in use, by the install and the uninstall alike, so the status line does not break on
# top of the settings file.
mkdir -p "$H4B/.claude/claude-orchestrator"
printf '#!/bin/sh\n' > "$H4B/.claude/claude-orchestrator/statusline-tap.sh"
inst "$H4B" >/dev/null 2>&1
check "an install that could not unwire keeps the tap's copy" "kept" \
  "$([ -f "$H4B/.claude/claude-orchestrator/statusline-tap.sh" ] && echo kept || echo gone)"
for f in hooks-module.log.1 hooks-module.log.lock; do printf 'line\n' > "$H4B/.claude/claude-orchestrator/$f"; done
uninst "$H4B" >/dev/null 2>&1
check "an uninstall that could not unwire keeps the tap's copy, removes the rest, the log's rotation and lock among it" "kept|gone|gone|gone" \
  "$([ -f "$H4B/.claude/claude-orchestrator/statusline-tap.sh" ] && echo kept || echo gone)|$([ -e "$H4B/.claude/claude-orchestrator/models.json" ] && echo kept || echo gone)|$([ -e "$H4B/.claude/claude-orchestrator/hooks-module.log.1" ] && echo kept || echo gone)|$([ -e "$H4B/.claude/claude-orchestrator/hooks-module.log.lock" ] && echo kept || echo gone)"

# What the old pipeline left behind: the tap's ctx/ directory, its copy and saved object,
# the shell gates' logs and heads, and measure files from sessions long ended. A session
# writes its measure file only when a turn ends, so age alone proves nothing: an idle one
# waits for days. A file is pruned only past a week AND when no live session owns it —
# the host's registry names each session's pid; a dead or absent pid frees the file.
H5="$WORK/home5"; mkdir -p "$H5/.claude"; stub_venv "$H5"
S5="$H5/.claude/claude-orchestrator"
mkdir -p "$S5/ctx" "$S5/measure" "$S5/stop-gate" "$H5/.claude/sessions"
printf 'noise\n' > "$S5/ctx/old.json"
for f in statusline-tap.sh context-gate.log stop-gate.log stop-gate/s-a.heads stop-gate/s-a.mheads; do
  printf 'old\n' > "$S5/$f"
done
printf '{"type":"command","command":"/x/bar.sh"}\n' > "$S5/statusline.previous.json"
for sid in s-gone s-dead s-live s-idle s-kept; do
  printf '{"context_tokens":1,"context_window":200000,"context_percent":0,"model":"a-model","updated_at":"2026-10-10T00:00:00Z"}\n' \
    > "$S5/measure/$sid.json"
done
sleep 0 & deadpid=$!; wait "$deadpid"
printf '{"pid":%s,"sessionId":"s-live"}\n' "$$" > "$H5/.claude/sessions/$$.json"
printf '{"pid":%s,"sessionId":"s-dead"}\n' "$deadpid" > "$H5/.claude/sessions/$deadpid.json"
touch -t 202001010000 "$S5/measure/s-gone.json" "$S5/measure/s-dead.json" "$S5/measure/s-live.json"
touch -t "$(date -v-3d +%Y%m%d%H%M 2>/dev/null || date -d '3 days ago' +%Y%m%d%H%M)" "$S5/measure/s-idle.json"
inst "$H5" >/dev/null 2>&1
check "the tap's ctx/ is purged" "gone" \
  "$([ -d "$S5/ctx" ] && echo kept || echo gone)"
present() { [ -e "$1" ] && echo present || echo absent; }
check "a measure file is pruned only past a week with no live session: gone, dead pid, live pid, idle, fresh" \
  "absent|absent|present|present|present" \
  "$(present "$S5/measure/s-gone.json")|$(present "$S5/measure/s-dead.json")|$(present "$S5/measure/s-live.json")|$(present "$S5/measure/s-idle.json")|$(present "$S5/measure/s-kept.json")"
check "with no tap wired, the old pipeline's files are removed and the module's heads kept" \
  "absent|absent|absent|absent|absent|present" \
  "$(present "$S5/statusline-tap.sh")|$(present "$S5/statusline.previous.json")|$(present "$S5/context-gate.log")|$(present "$S5/stop-gate.log")|$(present "$S5/stop-gate/s-a.heads")|$(present "$S5/stop-gate/s-a.mheads")"
# After an unwrap the same files go: nothing reads them once the line no longer runs the tap.
H5B="$WORK/home5b"; mkdir -p "$H5B/.claude/claude-orchestrator"; stub_venv "$H5B"
sed "s#@TAP@#$H5B/.claude/claude-orchestrator/statusline-tap.sh#" \
  "$ROOT/tests/fixtures/tap-settings.json" > "$H5B/.claude/settings.json"
printf '#!/bin/sh\n' > "$H5B/.claude/claude-orchestrator/statusline-tap.sh"
printf '{"type":"command","command":"/x/bar.sh","padding":0}\n' > "$H5B/.claude/claude-orchestrator/statusline.previous.json"
inst "$H5B" >/dev/null 2>&1
check "an unwrap that succeeded removes the tap's copy and saved object" "/x/bar.sh|absent|absent" \
  "$(jq -r '.statusLine.command' "$H5B/.claude/settings.json")|$(present "$H5B/.claude/claude-orchestrator/statusline-tap.sh")|$(present "$H5B/.claude/claude-orchestrator/statusline.previous.json")"

H6="$WORK/home6"; mkdir -p "$H6/.claude"
sed "s#@TAP@#$H6/.claude/claude-orchestrator/statusline-tap.sh#" \
  "$ROOT/tests/fixtures/tap-settings.json" > "$H6/.claude/settings.json"
inst "$H6" --dry-run >/dev/null 2>&1
check "dry-run changes nothing" "$H6/.claude/claude-orchestrator/statusline-tap.sh /x/bar.sh" \
  "$(jq -r '.statusLine.command' "$H6/.claude/settings.json")"
check "dry-run creates no state directory" "none" \
  "$([ -d "$H6/.claude/claude-orchestrator" ] && echo created || echo none)"
check "dry-run writes no tier map" "none" \
  "$([ -f "$H6/.claude/claude-orchestrator/models.json" ] && echo written || echo none)"
check "dry-run writes no catalogue, and says it would create one" "none|1" \
  "$([ -f "$H6/.claude/claude-orchestrator/mcp.json" ] && echo written || echo none)|$(inst "$H6" --dry-run 2>&1 | grep -c "\[dry-run\] server catalogue created: $H6/.claude/claude-orchestrator/mcp.json$")"
check "dry-run says what it would strip" "1" \
  "$(inst "$H6" --dry-run 2>&1 | grep -c '\[dry-run\] statusLine.command → /x/bar.sh')"

# A portable settings file spells the home as `$HOME`, `${HOME}` or `~`, and the host
# expands it when the line runs; the unwrap matches the stored spelling verbatim, so
# the command that followed the tap keeps the spelling it was written with (§33).
for spelling in '$HOME' '${HOME}' '~'; do
  H7="$WORK/home7"; rm -rf "$H7"; mkdir -p "$H7/.claude"; stub_venv "$H7"
  jq --arg cmd "$spelling/.claude/claude-orchestrator/statusline-tap.sh $spelling/.claude/statusbar/statusline.sh" \
    '.statusLine.command = $cmd' "$ROOT/tests/fixtures/tap-settings.json" > "$H7/.claude/settings.json"
  inst "$H7" >/dev/null 2>&1
  check "a tap spelled $spelling is unwired, the follower keeps its spelling" \
    "$spelling/.claude/statusbar/statusline.sh" "$(jq -r '.statusLine.command' "$H7/.claude/settings.json")"
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

# A tty is a claim about a moment: once the recorded session is gone, another host CLI can
# take the tty. The record names the process, and only that process keeps it alive. This
# stub reads a file of `<tty> <pid>` lines: with --tty alone it prints the pid there, with
# --pid it answers only for that pid.
CPIDS="$WORK/coord-pids"
cat > "$WORK/coord-verify-pid" <<'EOF'
#!/bin/bash
tty=$2; pid=""
[ "$3" = --pid ] && pid=$4
line=$(awk -v t="$tty" '$1 == t { print $2; exit }' "$COORD_PIDS")
[ -n "$line" ] || exit 1
[ -z "$pid" ] || [ "$pid" = "$line" ] || exit 1
echo "running on $tty (pid $line)"
EOF
chmod +x "$WORK/coord-verify-pid"
cpid() { ORCHESTRATOR_STATE_DIR="$CS" COORD_PIDS="$CPIDS" COORDINATOR_VERIFY="$WORK/coord-verify-pid" bash "$COORD" "$@"; }
cpid_status() { cpid "$@" >/dev/null 2>&1; echo "exit $?"; }
printf '/dev/ttys120 4001\n' > "$CPIDS"
cpid register --name "Coord : pid [p00001]" --tty /dev/ttys120 >/dev/null 2>&1
check "register records the pid of the host CLI on the tty" "4001" "$(jq -r .pid "$CREC")"
check "the same pid still running keeps the record alive" "Coord : pid [p00001]|exit 1" \
  "$(cpid lookup 2>/dev/null)|$(cpid_status register --name "Coord : two [p00002]" --tty /dev/ttys121)"
printf '/dev/ttys120 4002\n' > "$CPIDS"
check "another pid on the recorded tty reads as a stale record" \
  "|coordinator: stale record: Coord : pid [p00001] on /dev/ttys120" \
  "$(cpid lookup 2>/dev/null)|$(cpid lookup 2>&1 >/dev/null)"
out=$(cpid register --name "Coord : next [p00003]" --tty /dev/ttys121 2>"$WORK/coord.err")
check "register replaces a record whose tty was reused" \
  "registered Coord : next [p00003]|coordinator: replaced a stale record: Coord : pid [p00001]" \
  "$out|$(cat "$WORK/coord.err")"
# A record written before the pid was kept is read by its tty alone.
jq -n '{name:"Coord : old [p00004]", tty:"/dev/ttys122", started:"2026-01-01T00:00:00Z"}' > "$CREC"
printf '/dev/ttys122 4003\n' > "$CPIDS"
check "a record with no pid keeps the tty-only reading" "Coord : old [p00004]" "$(cpid lookup 2>/dev/null)"
printf '' > "$CPIDS"
check "and is stale once nothing runs on its tty" "|coordinator: stale record: Coord : old [p00004] on /dev/ttys122" \
  "$(cpid lookup 2>/dev/null)|$(cpid lookup 2>&1 >/dev/null)"
coord clear
# A tty that runs a host CLI but gives no pid is recorded without one, and the register says so.
live /dev/ttys123
out=$(coord register --name "Coord : nopid [p00005]" --tty /dev/ttys123 2>"$WORK/coord.err")
check "a register that finds no pid on the tty records none and says so in one line" \
  "registered Coord : nopid [p00005]|null|coordinator: no process id found on /dev/ttys123: the record is written without one" \
  "$out|$(jq -r '.pid' "$CREC")|$(cat "$WORK/coord.err")"
coord clear
# Against the real launcher: the « (pid N) » that register parses is the text verify prints.
creal() { ORCHESTRATOR_STATE_DIR="$CS" ORCHESTRATOR_HOST_CLI=a-host ORCHESTRATOR_PS_TABLE="$WORK/ps-two.txt" \
  CLAUDE_CONFIG_DIR="$WORK/hostcfg" bash "$COORD" "$@"; }
creal register --name "Coord : real [p00006]" --tty /dev/ttys901 >/dev/null 2>&1
check "register records the pid the real launcher's verify prints" "5100" "$(jq -r .pid "$CREC")"
check "and the record is alive for that pid" "Coord : real [p00006]" "$(creal lookup 2>/dev/null)"
jq '.pid = 5101' "$CREC" > "$WORK/coord-rec2" && cp "$WORK/coord-rec2" "$CREC"
check "a recorded pid that is the tty's second host CLI is alive" "Coord : real [p00006]" "$(creal lookup 2>/dev/null)"
jq '.pid = 9999' "$CREC" > "$WORK/coord-rec2" && cp "$WORK/coord-rec2" "$CREC"
check "a recorded pid the real launcher does not find on the tty is stale" \
  "|coordinator: stale record: Coord : real [p00006] on /dev/ttys901" "$(creal lookup 2>/dev/null)|$(creal lookup 2>&1 >/dev/null)"
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
# The hooks module's wait files, as facts reads them for the orchestrators waiting at a turn's
# end: a live one waiting on the operator, one whose pid is gone, a cleared wait, a broken file.
CCFG="$WORK/coord-config"; CSTORE="$CCFG/claude-orchestrator/store/waits"; mkdir -p "$CSTORE"
printf '%s\n' '{"name":"Orch : alpha","pid":"100","waiting":"operator","blocks":"phase 3","waiting_since":"2026-10-14T09:45:16.000Z","relayed":null}' > "$CSTORE/s-alpha"
printf '%s\n' '{"name":"Orch : gone","pid":"999","waiting":"operator","blocks":"x","waiting_since":"y"}' > "$CSTORE/s-gone"
printf '%s\n' '{"name":"Orch : beta","pid":"101","waiting":null,"blocks":null,"waiting_since":null}' > "$CSTORE/s-beta"
printf 'not json\n' > "$CSTORE/s-broken"
cfacts() {
  CLAUDE_CONFIG_DIR="$CCFG" ORCHESTRATOR_STATE_DIR="$CS" ORCHESTRATOR_WORKSPACES="$CWS" ORCHESTRATOR_HOST_CLI=hostcli \
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
# The defect: an orchestrator that asked the operator in its own tab looked stopped, and the
# coordinator spent two turns asking it why. Its wait is in the module's row, and facts shows it.
check "facts shows a live orchestrator waiting on the operator, and no dead one, cleared wait or broken file" \
  "waiting Orch : alpha | operator since 2026-10-14T09:45:16.000Z | blocks: phase 3" \
  "$(printf '%s\n' "$FACTS" | grep '^waiting ')"

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

# The sleeping orchestrators: paused on the operator's word, their tab closed by the
# coordinator, their record kept apart from the coordinator's own so it outlives a
# succession. sleep refuses what a wake could not start on; wake-done and drop remove one
# record under the registration's lock; drop moves the brief, never deletes it, and touches
# no pull request, branch or checkout.
SLS="$WORK/sleep-state"; SLP="$WORK/sleep-proj"; mkdir -p "$SLS" "$SLP/briefs"
echo brief > "$SLP/briefs/succession-brief.md"
slc() { ORCHESTRATOR_STATE_DIR="$SLS" bash "$COORD" "$@"; }
slc_status() { slc "$@" >/dev/null 2>&1; echo "exit $?"; }
SLREC="$SLS/sleeping.json"
check "sleep records a paused orchestrator and says so" "sleeping Orch : alpha" \
  "$(slc sleep --name 'Orch : alpha' --brief "$SLP/briefs/succession-brief.md" --dir "$SLP" --model a-model --effort high --pr 'forge.example/o/app#9 feat/z' --checkout "$SLP" 2>&1)"
check "the record holds every field a wake needs, the time stamped in UTC" \
  "Orch : alpha|$SLP/briefs/succession-brief.md|$SLP|a-model|high|forge.example/o/app#9 feat/z|$SLP|1" \
  "$(jq -r '.[0] | [.name,.brief,.dir,.model,.effort,(.prs|join(",")),(.checkouts|join(",")),(.slept|test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")|if . then 1 else 0 end)] | map(tostring) | join("|")' "$SLREC" 2>/dev/null)"
check "sleep leaves no lock behind" "0" "$([ -e "$SLS/coordinator.lock" ] && echo 1 || echo 0)"
check "an orchestrator already sleeping is refused" "exit 1|coordinator: sleep: refused: Orch : alpha is already sleeping" \
  "$(slc_status sleep --name 'Orch : alpha' --brief "$SLP/briefs/succession-brief.md" --dir "$SLP" --model m)|$(slc sleep --name 'Orch : alpha' --brief "$SLP/briefs/succession-brief.md" --dir "$SLP" --model m 2>&1)"
check "sleep refuses a name with its reference, an agent's name, a missing brief, a relative directory, no model, an unknown effort" \
  "exit 1|exit 1|exit 1|exit 1|exit 1|exit 1" \
  "$(slc_status sleep --name 'Orch : b [abc123]' --brief "$SLP/briefs/succession-brief.md" --dir "$SLP" --model m)|$(slc_status sleep --name 'Agent : b' --brief "$SLP/briefs/succession-brief.md" --dir "$SLP" --model m)|$(slc_status sleep --name 'Orch : b' --brief "$SLP/briefs/gone.md" --dir "$SLP" --model m)|$(slc_status sleep --name 'Orch : b' --brief "$SLP/briefs/succession-brief.md" --dir sleep-proj --model m)|$(slc_status sleep --name 'Orch : b' --brief "$SLP/briefs/succession-brief.md" --dir "$SLP")|$(slc_status sleep --name 'Orch : b' --brief "$SLP/briefs/succession-brief.md" --dir "$SLP" --model m --effort huge)"
check "a refused sleep records nothing" "1" "$(jq length "$SLREC")"
slc sleep --name 'Orch : beta' --brief "$SLP/briefs/succession-brief.md" --dir "$SLP" --model a-model >/dev/null 2>&1
check "sleeping lists each one with its directory, pull requests, checkouts, brief, model and effort" \
  "sleeping Orch : alpha | since * | $SLP | prs forge.example/o/app#9 feat/z | checkouts $SLP | brief $SLP/briefs/succession-brief.md | model a-model | effort high|sleeping Orch : beta | since * | $SLP | prs none | checkouts none | brief $SLP/briefs/succession-brief.md | model a-model | effort default" \
  "$(slc sleeping | sed -E 's/since [^ ]+/since */' | tr '\n' '|' | sed 's/|$//')"
check "wake-done removes the woken one's record alone" "woken Orch : beta|Orch : alpha" \
  "$(slc wake-done --name 'Orch : beta' 2>&1)|$(jq -r 'map(.name)|join(",")' "$SLREC")"
check "wake-done and drop refuse a name that does not sleep" "exit 1|exit 1|coordinator: drop: refused: Orch : beta is not sleeping (coordinator.sh sleeping lists who is)" \
  "$(slc_status wake-done --name 'Orch : beta')|$(slc_status drop --name 'Orch : beta')|$(slc drop --name 'Orch : beta' 2>&1)"
mkdir "$SLS/coordinator.lock" && echo "$$ registration" > "$SLS/coordinator.lock/holder"
check "a drop that cannot take the lock is refused and drops nothing" "exit 1|1|1" \
  "$(slc_status drop --name 'Orch : alpha')|$(jq length "$SLREC")|$([ -f "$SLP/briefs/succession-brief.md" ] && echo 1 || echo 0)"
rm -rf "$SLS/coordinator.lock"
SLDROP=$(slc drop --name 'Orch : alpha' 2>&1)
check "drop removes the record, moves the brief under abandoned/ beside it, and names what it left untouched" \
  "dropped Orch : alpha|brief moved to $SLP/briefs/abandoned/*-succession-brief.md|left untouched: forge.example/o/app#9 feat/z, $SLP|0|0|1" \
  "$(printf '%s' "$SLDROP" | sed -E 's#abandoned/[0-9TZ]+-#abandoned/*-#' | tr '\n' '|')|$(jq length "$SLREC")|$([ -f "$SLP/briefs/succession-brief.md" ] && echo 1 || echo 0)|$(ls "$SLP/briefs/abandoned" | grep -c 'succession-brief.md$')"
check "sleeping prints nothing when none sleeps" "|exit 0" "$(slc sleeping)|$(slc_status sleeping)"
echo 'not json' > "$SLREC"
check "an unreadable sleeping record is said, never read as none" "exit 1|exit 1" "$(slc_status sleeping)|$(slc_status sleep --name 'Orch : c' --brief "$SLP/briefs/abandoned/$(ls "$SLP/briefs/abandoned" | head -1)" --dir "$SLP" --model m)"
# owners: a pull request whose chain breaks on a sleeping orchestrator's absence is its own.
echo x > "$SLP/briefs/b2.md"
printf '[{"name":"Orch : gamma","brief":"%s","dir":"%s","model":"m","effort":"","slept":"2026-10-13T10:00:00Z","prs":["forge.example/o/app#9 feat/z","forge.example/o/app#7 feat/x"],"checkouts":[]}]\n' "$SLP/briefs/b2.md" "$SLP" > "$SLREC"
SLOWN=$(ORCHESTRATOR_STATE_DIR="$SLS" ORCHESTRATOR_WORKSPACES="$CWS" ORCHESTRATOR_HOST_CLI=hostcli COORDINATOR_PS_TABLE="$CF/ps" COORDINATOR_CWDS="$CF/cwds" COORDINATOR_FORGE="$CF/forge" bash "$COORD" owners 2>/dev/null)
check "owners gives a sleeping orchestrator's unknown pull request to it, and leaves a live session's alone" \
  "pr forge.example/o/app#9 | feat/z | Orch : gamma | sleeping since 2026-10-13T10:00:00Z|2|pr forge.example/o/app#10 | feat/w | unknown | no session in $RIDLE" \
  "$(printf '%s\n' "$SLOWN" | grep '#9 ')|$(printf '%s\n' "$SLOWN" | grep -c '#7 .*session 10[12] ')|$(printf '%s\n' "$SLOWN" | grep '#10 ')"
# The pause's rules, in the prose that carries them: the operator's word only, the
# coordinator closes, the orchestrator spawns no successor at a pause, a woken one skips the
# handshake with a predecessor already gone, and a drop keeps the brief and touches nothing
# of the operator's. Read flattened, so a rewrap does not hide a sentence.
flat_has() { tr '\n' ' ' < "$1" | sed -E 's/ > / /g; s/[[:space:]]+/ /g' | grep -qF -- "$2" && echo yes || echo no; }
# The pane on the operator's plain words: both supervising rulebooks name the tool that opens
# and closes it, by the words he says.
check "both rulebooks open and close the pane through the tool on the operator's words" "yes|yes" \
  "$(spells "$ROOT/skills/orchestrator/SKILL.md" "when the operator says to start, launch or open the supervision, call \`mcp__orchestrator__supervision\` with \`open\`; to end, stop or close it, with \`close\`.")|$(flat_has "$COORDSKILL" "When the operator says to start, launch or open the supervision, call \`mcp__orchestrator__supervision\` with \`open\`; to end, stop or close it, with \`close\`.")"
SLCMD="$ROOT/commands/sleeping.md"
check "pause, wake and drop are the operator's word only, never the coordinator's or a peer's" "yes|yes" \
  "$(flat_has "$COORDSKILL" "**Pause, wake and drop are the operator's word only**")|$(flat_has "$COORDSKILL" "Never your own initiative, never a peer's request, never to make room.")"
check "the coordinator closes a paused orchestrator, which spawns no successor and closes nothing" "yes|yes|yes" \
  "$(flat_has "$COORDSKILL" "**You close it**, as a successor closes its predecessor")|$(flat_has "$COORDSKILL" "Spawn no successor and do not close yourself: I close your tab.")|$(flat_has "$ORCH_REFS/lifecycle.md" "You spawn NO successor and you do not close yourself")"
check "a pause refused or failing is told to the operator, and that orchestrator is not closed" "yes" \
  "$(flat_has "$COORDSKILL" "an orchestrator not proved paused-ready is never closed")"
check "a sleeping orchestrator is not missing, and its record outlives the coordinator" "yes|yes|yes" \
  "$(flat_has "$COORDSKILL" "its absence from \`ListAgents\` is its sleep, never a death")|$(flat_has "$COORDTPL" "outlives every succession, and nothing in it is woken or dropped but on his word")|$(flat_has "$COORDEND" "the sleeping record is kept")"
check "a woken orchestrator skips the handshake with a predecessor already gone" "yes|yes" \
  "$(flat_has "$SUCC" "**Woken from a pause**")|$(flat_has "$SUCC" "step 4 is void — no « takeover confirmed », nothing to close")"
check "the rulebook points a pause at the lifecycle, inside its one coordinator paragraph" "yes" \
  "$(flat_has "$ROOT/skills/orchestrator/SKILL.md" "A pause it relays: its bullet in \`references/lifecycle.md\`.")"
check "the sleeping command lists, asks one confirmation before a drop, and leaves the operator's things alone" "yes|yes|yes|yes" \
  "$(flat_has "$SLCMD" "The hooks module answers it on the spot, with no model turn")|$(flat_has "$SLCMD" "**Ask one confirmation**, naming what is left behind")|$(flat_has "$SLCMD" "It does NOT touch the pull requests, their branches or the checkouts: closing those is the operator's.")|$(flat_has "$SLCMD" "moved, never deleted, so a slip loses nothing")"
check "the drop runs only on his yes, after the turn ends" "1" \
  "$([ "$(grep -n 'END THE TURN' "$SLCMD" | head -1 | cut -d: -f1)" -lt "$(grep -n 'coordinator.sh drop --name' "$SLCMD" | head -1 | cut -d: -f1)" ] 2>/dev/null && echo 1 || echo 0)"
check "the README lists the sleeping command" "yes" "$(spells "$ROOT/README.md" '| `/orchestrator-sleeping` |')"

# Moving an orchestrator between machines, on the operator's word: the coordination section, its
# trust anchor, the lifecycle bullet, the succession note and the design paragraph.
check "the coordination skill moves an orchestrator on his order, after opening and before its limits" "yes|yes" \
  "$(flat_has "$COORDSKILL" "## Moving an orchestrator")|$([ "$(grep -n '^## Opening an orchestrator$' "$COORDSKILL" | cut -d: -f1)" -lt "$(grep -n '^## Moving an orchestrator$' "$COORDSKILL" | cut -d: -f1)" ] 2>/dev/null && [ "$(grep -n '^## Moving an orchestrator$' "$COORDSKILL" | cut -d: -f1)" -lt "$(grep -n '^## Your limits$' "$COORDSKILL" | cut -d: -f1)" ] 2>/dev/null && echo yes || echo no)"
check "a receiver opens an arrival only on the order the coordinator relayed for that name" "yes|yes" \
  "$(flat_has "$COORDSKILL" "The coordinator relays the operator's order to the receiver BEFORE the send, and a receiver opens an arrival only when the coordinator relayed that order for that name; files that arrived without it are left unopened and reported.")|$(flat_has "$COORDSKILL" "calling \`move_send\` again with the same arguments")"
check "the lifecycle moves an orchestrator on his word, sending and receiving" "yes|yes" \
  "$(flat_has "$ORCH_REFS/lifecycle.md" "**A move, on the operator's word.**")|$(flat_has "$ORCH_REFS/lifecycle.md" "only on the relayed order for that name")"
check "an orchestrator that arrived by a move re-verifies every checkout from git first" "yes|yes" \
  "$(flat_has "$SUCC" "**Arrived by a move** — you are told so:")|$(flat_has "$SUCC" "first re-verify each checkout from git")"
check "the design describes the move's messages and its two notices" "yes|yes|yes" \
  "$(flat_has "$ROOT/docs/design.md" "A move is carried by marked messages")|$(flat_has "$ROOT/docs/design.md" "the address pinned at the first answer")|$(flat_has "$ROOT/docs/design.md" "the only text a model reads")"
check "an orchestrator that moved itself replies on the outcome, to the session that relayed the order" "yes|yes" \
  "$(flat_has "$ORCH_REFS/lifecycle.md" "acknowledged, you first reply \`moved <receiver> brief=<the brief path the notice gives>\` to the session that relayed the order, then you end")|$(flat_has "$ORCH_REFS/lifecycle.md" "failed, you reply \`move-failed <reason>\` to it and end nothing")"
check "the coordinator closes a moved orchestrator's tab on its moved reply and tells a move-failed reason to the operator" "yes|yes" \
  "$(flat_has "$COORDSKILL" "you close its tab on its \`moved\` reply")|$(flat_has "$COORDSKILL" "a \`move-failed\` reply is told to the operator through your round, with its reason")"
check "the receiver tells the arrived session it arrived by a move, once it is verified running" "yes|yes" \
  "$(flat_has "$COORDSKILL" "send it ONE message saying that it arrived by a move from the origin the notice names, so that it first re-verifies each checkout from git")|$(flat_has "$ORCH_REFS/lifecycle.md" "send it ONE message saying that it arrived by a move from the origin the notice names, so that it first re-verifies each checkout from git")"
check "the design paragraph on a move cites the coordination skill for the trust anchor and carries its order's date" "yes|yes|no" \
  "$(flat_has "$ROOT/docs/design.md" "the order the coordinator relayed for that name (the coordination skill's « Moving an orchestrator » in \`skills/coordination/SKILL.md\`)")|$(flat_has "$ROOT/docs/design.md" "an orchestrator is moved from one machine to another: his order of 2026-10-16")|$(flat_has "$ROOT/docs/design.md" "(section 9.5 above), which a manifest cannot supply")"
check "the coordination section names the move tools in full at their first mention" "yes|yes" \
  "$(flat_has "$COORDSKILL" "messages (\`mcp__orchestrator__move_send\`, which only")|$(flat_has "$COORDSKILL" "(the title guard, \`mcp__orchestrator__end_session\` where the host refuses)")"

# Remote rows: the rows the hooks module received from orchestrators on other machines, read
# beside the same local sessions. A fresh row is listed in each wait form; a stale one, one a
# local session names and a temporary file are passed over; a malformed file is unread (exit 2).
# Its pull requests join owners where the chain gives « unknown », and count as one more
# orchestrator on a collision; a repository this machine did not read is said so.
CRCFG="$WORK/coord-remote-config"; RREM="$CRCFG/claude-orchestrator/store/remote"
mkdir -p "$RREM" "$CRCFG/claude-orchestrator/store/waits"
RNOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z); ROLD=2020-01-01T00:00:00.000Z
cat > "$RREM/Orch___far" <<EOF
{"name":"Orch : far","role":"orchestrator","context_tokens":120000,"context_percent":12,"window":1000000,"waiting":"operator","blocks":"phase 3","waiting_since":"$RNOW","updated_at":"$RNOW","machine":"bench-mac","repo":"o/app","prs":["o/app#7","o/app#9","o/app#99"]}
EOF
cat > "$RREM/Orch___near" <<EOF
{"name":"Orch : near","role":"orchestrator","context_tokens":300000,"context_percent":30,"window":1000000,"waiting":"done","blocks":null,"waiting_since":"$RNOW","updated_at":"$RNOW","machine":"lab-mini","repo":null,"prs":[]}
EOF
cat > "$RREM/Orch___quiet" <<EOF
{"name":"Orch : quiet","role":"orchestrator","context_tokens":0,"context_percent":0,"window":1000000,"waiting":null,"blocks":null,"waiting_since":null,"updated_at":"$RNOW","machine":"lab-mini","repo":"o/app","prs":["o/app#10","o/gone#5"]}
EOF
cat > "$RREM/Orch___twin" <<EOF
{"name":"Orch : twin","role":"orchestrator","context_tokens":0,"context_percent":0,"window":1000000,"waiting":null,"blocks":null,"waiting_since":null,"updated_at":"$RNOW","machine":"lab-mini","repo":null,"prs":["o/gone#5"]}
EOF
cat > "$RREM/Orch___zeta" <<EOF
{"name":"Orch : zeta","role":"orchestrator","context_tokens":0,"context_percent":0,"window":1000000,"waiting":null,"blocks":null,"waiting_since":null,"updated_at":"$RNOW","machine":"lab-mini","repo":"o/app","prs":["o/app#99"]}
EOF
cat > "$RREM/Orch___old" <<EOF
{"name":"Orch : old","role":"orchestrator","context_tokens":0,"context_percent":0,"window":1000000,"waiting":"operator","blocks":"x","waiting_since":"$ROLD","updated_at":"$ROLD","machine":"lab-mini","repo":"o/app","prs":["o/app#8"]}
EOF
cat > "$RREM/Orch___alpha" <<EOF
{"name":"Orch : alpha","role":"orchestrator","context_tokens":0,"context_percent":0,"window":1000000,"waiting":null,"blocks":null,"waiting_since":null,"updated_at":"$RNOW","machine":"lab-mini","repo":"o/app","prs":["o/app#8"]}
EOF
printf 'not json\n' > "$RREM/Orch___bad"
printf 'half a row' > "$RREM/Orch___far.tmp-1"
crem() {
  CLAUDE_CONFIG_DIR="$CRCFG" ORCHESTRATOR_STATE_DIR="$CS" ORCHESTRATOR_WORKSPACES="$CWS" ORCHESTRATOR_HOST_CLI=hostcli \
    COORDINATOR_PS_TABLE="$CF/ps" COORDINATOR_CWDS="$CF/cwds" COORDINATOR_FORGE="$CF/forge" bash "$COORD" "$@"
}
crem_status() { crem "$@" >/dev/null 2>&1; echo "exit $?"; }
RFACTS=$(crem facts 2>/dev/null)
ROWNERS=$(crem owners 2>/dev/null)
check "facts lists each fresh remote row in its wait form: operator, done, working" \
  "remote Orch : far | on bench-mac | updated $RNOW | context 120000 (12%) | repository o/app | prs o/app#7, o/app#9, o/app#99 | operator since $RNOW | blocks: phase 3|remote Orch : near | on lab-mini | updated $RNOW | context 300000 (30%) | repository none | prs none | done since $RNOW|remote Orch : quiet | on lab-mini | updated $RNOW | context 0 (0%) | repository o/app | prs o/app#10, o/gone#5 | working|remote Orch : twin | on lab-mini | updated $RNOW | context 0 (0%) | repository none | prs o/gone#5 | working|remote Orch : zeta | on lab-mini | updated $RNOW | context 0 (0%) | repository o/app | prs o/app#99 | working" \
  "$(printf '%s\n' "$RFACTS" | grep '^remote ' | tr '\n' '|' | sed 's/|$//')"
check "a stale remote row, a local session's name, and a temporary file are not listed" "0|0|1" \
  "$(printf '%s\n' "$RFACTS" | grep -c '^remote Orch : old ')|$(printf '%s\n' "$RFACTS" | grep -c '^remote Orch : alpha ')|$(printf '%s\n' "$RFACTS" | grep -c '^remote Orch : far ')"
check "a malformed remote row is unread, and facts and owners exit 2" "unread remote $RREM/Orch___bad: not a JSON row|exit 2|exit 2" \
  "$(printf '%s\n' "$RFACTS" | grep '^unread ')|$(crem_status facts)|$(crem_status owners)"
check "a remote row listing a pull request a local session is on is a collision, and so is two remote rows on one pull request of an unread repository" \
  "collision pr | forge.example/o/app#7 | feat/x | Orch : alpha [aaa111], Orch : beta [bbb222], Orch : far|collision pr | o/gone#5 | - | Orch : quiet, Orch : twin" \
  "$(printf '%s\n' "$RFACTS" | grep '^collision pr ' | tr '\n' '|' | sed 's/|$//')"
check "owners names the orchestrator of an unknown pull request a remote row lists, and says a pull request in an unread repository is not read" \
  "pr forge.example/o/app#9 | feat/z | Orch : far | remote on bench-mac, updated $RNOW|pr forge.example/o/app#10 | feat/w | Orch : quiet | remote on lab-mini, updated $RNOW|pr o/gone#5 | - | Orch : quiet | remote on lab-mini, updated $RNOW, not read on the forge here|pr o/gone#5 | - | Orch : twin | remote on lab-mini, updated $RNOW, not read on the forge here" \
  "$(printf '%s\n' "$ROWNERS" | grep 'remote on' | tr '\n' '|' | sed 's/|$//')"
check "a remote pull request absent from its repository's open list is not printed by owners, nor counted in a collision" "0|0" \
  "$(printf '%s\n' "$ROWNERS" | grep -c '#99')|$(printf '%s\n' "$RFACTS" | grep '^collision ' | grep -c '#99')"

# The round: the hooks module writes one entry per wait of an orchestrator on this machine
# under <state>/round/ (hooks/round.ts), and the coordinator reads it with `round` and closes
# an entry with `round-close`. The entries' shapes are the module's own; a file that does not
# parse is skipped, never repaired.
CROUND="$CS/round"
mkdir -p "$CROUND"
# The sender's sessions file is read under the config dir, as the waits are: the entries below
# have live senders, one file each, so a line carries no « sender gone ». The config dir is this
# section's own, put back as it was after it.
RCFG_HAD="${CLAUDE_CONFIG_DIR+set}"; RCFG_WAS="${CLAUDE_CONFIG_DIR-}"
export CLAUDE_CONFIG_DIR="$WORK/coord-config"
mkdir -p "$CLAUDE_CONFIG_DIR/claude-orchestrator/store/sessions"
# The round's clock pinned minutes after these entries, given to each `round` call alone so that
# it reaches no later test, and the coordinator's pane open (its record naming this shell's pid,
# which lives), so that no entry below is due in the tab.
ROUND_NOW=2026-10-18T10:06:00Z
printf '{"session":"s-coord","pid":"%s","at":"2026-10-18T10:00:00.000Z"}\n' "$$" > "$CS/pane.json"
round_entry() {  # <id> <from> <since> <status> <kind> <question>
  jq -n --arg id "$1" --arg from "$2" --arg since "$3" --arg status "$4" --arg kind "$5" --arg q "$6" \
    '{id:$id, from:$from, session:("s-" + $id), kind:$kind, since:$since, blocks:(if $kind == "operator" then "phase 3" else null end),
      question:$q, choices:[], recommendation:null, status:$status, at:$since, answer:null}' > "$CROUND/$1.json"
  : > "$CLAUDE_CONFIG_DIR/claude-orchestrator/store/sessions/s-$1"
}
round_entry b-late "Orch : b" 2026-10-18T10:05:00.000Z open operator 'Merge #12 now?
- **A** : merge it
- **B** : wait'
round_entry a-one "Orch : a" 2026-10-18T10:03:00.000Z open operator 'Rename the pane?'
round_entry b-early "Orch : b" 2026-10-18T10:01:00.000Z open operator 'Ship it?'
round_entry a-gone "Orch : a" 2026-10-18T09:00:00.000Z withdrawn operator 'Close the tab?'
round_entry c-done "Orch : c" 2026-10-18T10:04:00.000Z open done 'Everything merged.'
round_entry d-shut "Orch : d" 2026-10-18T08:00:00.000Z closed operator 'Old question?'
printf '{"id": "half' > "$CROUND/broken.json"
cp "$CROUND/a-one.json" "$CROUND/a-one.json.tmp-123-abcdef"
check "round prints the open entries grouped by sender, the groups by their first wait, then the withdrawn ones" \
  "round b-early | operator | from Orch : b | since 2026-10-18T10:01:00.000Z | blocks: phase 3 | open
    Ship it?
round b-late | operator | from Orch : b | since 2026-10-18T10:05:00.000Z | blocks: phase 3 | open
    Merge #12 now?
    - **A** : merge it
    - **B** : wait
round a-one | operator | from Orch : a | since 2026-10-18T10:03:00.000Z | blocks: phase 3 | open
    Rename the pane?
round c-done | done | from Orch : c | since 2026-10-18T10:04:00.000Z | blocks: - | open
    Everything merged.
round a-gone | operator | from Orch : a | since 2026-10-18T09:00:00.000Z | blocks: phase 3 | withdrawn
    Close the tab?" \
  "$(COORDINATOR_NOW=$ROUND_NOW coord round 2>&1)"
check "round exits 0, and an empty or missing round directory prints nothing" "exit 0||" \
  "$(COORDINATOR_NOW=$ROUND_NOW coord_status round)|$(ORCHESTRATOR_STATE_DIR="$WORK/coord-no-round" bash "$COORD" round 2>&1)|$(mkdir -p "$WORK/coord-empty-round/round" && ORCHESTRATOR_STATE_DIR="$WORK/coord-empty-round" bash "$COORD" round 2>&1)"
out=$(coord round-close b-early --answer 'A, ship it — on 2026-10-18' 2>&1); code=$?
check "round-close says what it closed" "closed b-early|exit 0" "$out|exit $code"
check "round-close writes the status and the operator's answer, by the coordinator, stamped in UTC" \
  "closed|A, ship it — on 2026-10-18|coordinator|1|Ship it?|Orch : b" \
  "$(jq -r '[.status, .answer.text, .answer.by, (.answer.at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$") | if . then 1 else 0 end), .question, .from] | join("|")' "$CROUND/b-early.json")"
check "round-close leaves no temporary file, and round no longer lists the closed entry but still the others" "0|0|1" \
  "$(find "$CROUND" -name 'b-early.json.tmp-*' | wc -l | tr -d ' ')|$(COORDINATOR_NOW=$ROUND_NOW coord round | grep -c '^round b-early ')|$(COORDINATOR_NOW=$ROUND_NOW coord round | grep -c '^round b-late ')"
check "a withdrawn entry is closed the same way" "closed a-gone|closed" \
  "$(coord round-close a-gone --answer 'withdrawn: answered in its own tab' 2>&1)|$(jq -r .status "$CROUND/a-gone.json")"
check "round-close refuses an unknown id, a path, an unreadable entry and a missing answer, writing nothing" \
  "exit 1|exit 1|exit 1|exit 1|exit 1|{\"id\": \"half" \
  "$(coord_status round-close nobody --answer x)|$(coord_status round-close ../coordinator --answer x)|$(coord_status round-close broken --answer x)|$(coord_status round-close a-one)|$(coord_status round-close)|$(cat "$CROUND/broken.json")"
check "the refusal of an unknown id names it" "coordinator: round-close: no entry nobody in $CROUND" \
  "$(coord round-close nobody --answer x 2>&1 >/dev/null)"

# round-archive moves the closed entries into round/archive/ and nothing else; the archive is
# read by no one, so an entry planted there with the status open is neither printed nor counted.
AROUND="$WORK/coord-archive"
mkdir -p "$AROUND/round"
arch_entry() {  # <id> <status>
  jq -n --arg id "$1" --arg status "$2" \
    '{id:$id, from:"Orch : z", session:("s-" + $id), kind:"operator", since:"2026-10-18T10:00:00.000Z", blocks:"x",
      question:("Question " + $id), choices:[], recommendation:null, status:$status, at:"2026-10-18T10:00:00.000Z", answer:null}' > "$AROUND/round/$1.json"
}
arch_entry z-closed-1 closed; arch_entry z-closed-2 closed; arch_entry z-open open
arch_entry z-answered answered; arch_entry z-withdrawn withdrawn
printf '{"id": "half' > "$AROUND/round/z-broken.json"
acoord() { ORCHESTRATOR_STATE_DIR="$AROUND" CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" bash "$COORD" "$@"; }
check "round-archive prints the count of the entries it moved" "archived 2|exit 0" \
  "$(acoord round-archive 2>&1)|exit $?"
check "round-archive moves the closed entries only, and leaves the others and the broken file" \
  "z-closed-1.json z-closed-2.json|z-answered.json z-broken.json z-open.json z-withdrawn.json" \
  "$(ls "$AROUND/round/archive" | tr '\n' ' ' | sed 's/ $//')|$(find "$AROUND/round" -maxdepth 1 -type f -name '*.json' -exec basename {} \; | sort | tr '\n' ' ' | sed 's/ $//')"
check "a second round-archive finds nothing to move" "archived 0" "$(acoord round-archive 2>&1)"
check "round-archive on a missing round directory moves nothing" "archived 0|exit 0" \
  "$(ORCHESTRATOR_STATE_DIR="$WORK/coord-no-round" bash "$COORD" round-archive 2>&1)|exit $?"
check "round-archive refuses an argument and moves nothing" "exit 1|0" \
  "$(ORCHESTRATOR_STATE_DIR="$AROUND" bash "$COORD" round-archive now >/dev/null 2>&1; echo "exit $?")|$(find "$AROUND/round/archive" -type f | wc -l | tr -d ' ' | awk '{ print $1 - 2 }')"
arch_entry z-hidden open; mv "$AROUND/round/z-hidden.json" "$AROUND/round/archive/z-hidden.json"
check "round prints nothing from the archive, even an entry there with the status open" "0|1" \
  "$(acoord round | grep -c 'z-hidden\|z-closed')|$(acoord round | grep -c '^round z-open ')"
check "round-close does not find an archived entry" "exit 1" "$(ORCHESTRATOR_STATE_DIR="$AROUND" bash "$COORD" round-close z-hidden --answer x >/dev/null 2>&1; echo "exit $?")"

# A sender that has ended leaves its question in the round: it is still printed, and its header
# says the sender is gone, so the coordinator does not relay a question nobody can answer.
GSTATE="$WORK/coord-gone"; GCFG="$WORK/coord-gone-config"
mkdir -p "$GSTATE/round" "$GCFG/claude-orchestrator/store/sessions"
for gone in "live:s-live" "ended:s-ended" "odd:s odd/1"; do
  jq -n --arg id "${gone%%:*}" --arg session "${gone#*:}" \
    '{id:$id, from:("Orch : " + $id), session:$session, kind:"operator", since:"2026-10-18T10:0\(if $id == "live" then 1 elif $id == "ended" then 2 else 3 end):00.000Z",
      blocks:"phase 3", question:"Ship it?", choices:[], recommendation:null, status:"open", at:"T", answer:null}' > "$GSTATE/round/${gone%%:*}.json"
done
: > "$GCFG/claude-orchestrator/store/sessions/s-live"
cp "$CS/pane.json" "$GSTATE/pane.json"
: > "$GCFG/claude-orchestrator/store/sessions/s_odd_1"
check "round says the sender is gone on the header of an entry whose sessions file is absent, and still prints the entry" \
  "round live | operator | from Orch : live | since 2026-10-18T10:01:00.000Z | blocks: phase 3 | open
    Ship it?
round ended | operator | from Orch : ended | since 2026-10-18T10:02:00.000Z | blocks: phase 3 | open | sender gone
    Ship it?
round odd | operator | from Orch : odd | since 2026-10-18T10:03:00.000Z | blocks: phase 3 | open
    Ship it?" \
  "$(ORCHESTRATOR_STATE_DIR="$GSTATE" CLAUDE_CONFIG_DIR="$GCFG" COORDINATOR_NOW=$ROUND_NOW bash "$COORD" round 2>&1)"
# An entry the operator answered from the coordinator's pane is printed after the open ones and
# before the withdrawn ones, each set in the round's order, with the answer the pane recorded.
ASTATE="$WORK/coord-answered"; ACFG="$WORK/coord-answered-config"
mkdir -p "$ASTATE/round" "$ACFG/claude-orchestrator/store/sessions"
for spec in "w1:withdrawn:1" "x1:answered:2" "o1:open:3" "x2:answered:4" "o2:open:5"; do
  IFS=: read -r aid astatus amin <<< "$spec"
  jq -n --arg id "$aid" --arg status "$astatus" --arg since "2026-10-20T10:0${amin}:00.000Z" \
    '{id:$id, from:"Orch : a", session:"s-a", kind:"operator", since:$since, blocks:"phase 3", question:("Ask " + $id + "?"),
      choices:[], recommendation:null, status:$status, at:$since,
      answer:(if $status == "answered" then {text:"A : ship it", by:"pane", at:"2026-10-20T10:09:00.000Z"}
              elif $status == "withdrawn" then {text:"", by:"sender", at:"2026-10-20T10:09:00.000Z"} else null end)}' > "$ASTATE/round/$aid.json"
done
: > "$ACFG/claude-orchestrator/store/sessions/s-a"
cp "$CS/pane.json" "$ASTATE/pane.json"
check "round prints the open entries, then the answered ones with their answer, then the withdrawn ones, a sender's own withdrawal said" \
  "round o1 | operator | from Orch : a | since 2026-10-20T10:03:00.000Z | blocks: phase 3 | open
    Ask o1?
round o2 | operator | from Orch : a | since 2026-10-20T10:05:00.000Z | blocks: phase 3 | open
    Ask o2?
round x1 | operator | from Orch : a | since 2026-10-20T10:02:00.000Z | blocks: phase 3 | answered
    Ask x1?
    answered from the pane at 2026-10-20T10:09:00.000Z: A : ship it
round x2 | operator | from Orch : a | since 2026-10-20T10:04:00.000Z | blocks: phase 3 | answered
    Ask x2?
    answered from the pane at 2026-10-20T10:09:00.000Z: A : ship it
round w1 | operator | from Orch : a | since 2026-10-20T10:01:00.000Z | blocks: phase 3 | withdrawn
    Ask w1?
    withdrawn by the sender at 2026-10-20T10:09:00.000Z: a later turn the operator typed in waits on something else" \
  "$(ORCHESTRATOR_STATE_DIR="$ASTATE" CLAUDE_CONFIG_DIR="$ACFG" COORDINATOR_NOW=2026-10-20T10:06:00Z bash "$COORD" round 2>&1)"
# An open question the pane can show is the pane's: `round` marks it due, for the coordinator to
# present in its tab, only when its sender marked it urgent, however long the others have
# waited, or when no pane of the coordinator is open: its record, <state>/pane.json, names a
# pid the process table (COORDINATOR_PS_TABLE here) holds. Answered and withdrawn entries, and
# a closing proposal, which the pane cannot rule, are never due.
DSTATE="$WORK/coord-due"; DCFG="$WORK/coord-due-config"
mkdir -p "$DSTATE/round" "$DCFG/claude-orchestrator/store/sessions"
for spec in "u1:open:2026-10-24T11:59:00.000Z:true" "p15:open:2026-10-24T11:45:00.000Z:false" \
    "p14:open:2026-10-24T11:45:01.000Z:false" "pold:open:2026-10-24T09:00:00.000Z:false" \
    "xu:answered:2026-10-24T11:58:00.000Z:true" "wold:withdrawn:2026-10-24T09:00:00.000Z:false" \
    "zdone:open:2026-10-24T09:30:00.000Z:false"; do
  IFS=: read -r did dstatus dh dm drest durgent <<< "$spec"
  jq -n --arg id "$did" --arg status "$dstatus" --arg since "$dh:$dm:$drest" --argjson urgent "$durgent" \
    '{id:$id, from:"Orch : d", session:"s-d", kind:(if $id == "zdone" then "done" else "operator" end), since:$since,
      blocks:(if $id == "zdone" then null else "phase 3" end), question:("Ask " + $id + "?"),
      choices:[], recommendation:null, status:$status, at:$since,
      answer:(if $status == "answered" then {text:"A : ship it", by:"pane", at:"2026-10-24T11:59:00.000Z"}
              elif $status == "withdrawn" then {text:"", by:"sender", at:"2026-10-24T11:59:00.000Z"} else null end)}
     + (if $urgent then {urgent:true} else {} end)' > "$DSTATE/round/$did.json"
done
: > "$DCFG/claude-orchestrator/store/sessions/s-d"
printf '4242 1 ttys004 hostcli\n' > "$WORK/coord-due-ps"
printf '{"session":"s-coord","pid":"4242","at":"2026-10-24T09:00:00.000Z"}\n' > "$DSTATE/pane.json"
dround() { ORCHESTRATOR_STATE_DIR="$DSTATE" CLAUDE_CONFIG_DIR="$DCFG" COORDINATOR_NOW=2026-10-24T12:00:00Z COORDINATOR_PS_TABLE="$WORK/coord-due-ps" bash "$COORD" round 2>&1; }
check "with the pane open round marks due an urgent entry alone, however old the others" \
  "round pold | operator | from Orch : d | since 2026-10-24T09:00:00.000Z | blocks: phase 3 | open
round zdone | done | from Orch : d | since 2026-10-24T09:30:00.000Z | blocks: - | open
round p15 | operator | from Orch : d | since 2026-10-24T11:45:00.000Z | blocks: phase 3 | open
round p14 | operator | from Orch : d | since 2026-10-24T11:45:01.000Z | blocks: phase 3 | open
round u1 | operator | from Orch : d | since 2026-10-24T11:59:00.000Z | blocks: phase 3 | open | due
round xu | operator | from Orch : d | since 2026-10-24T11:58:00.000Z | blocks: phase 3 | answered
round wold | operator | from Orch : d | since 2026-10-24T09:00:00.000Z | blocks: phase 3 | withdrawn" \
  "$(dround | grep '^round ')"
check "with no pane open every open question is due, a closing proposal still not: no record, a dead pid, a record with no pid" \
  "4|0|4|4" \
  "$(mv "$DSTATE/pane.json" "$WORK/coord-due-pane"; dround | grep -c ' | open | due$')|$(dround | grep -c '^round zdone .* | due')|$(printf '{"session":"s-coord","pid":"4243"}\n' > "$DSTATE/pane.json"; dround | grep -c ' | open | due$')|$(printf '{"session":"s-coord"}\n' > "$DSTATE/pane.json"; dround | grep -c ' | open | due$')"
# An entry answered in the pane is never due, pane open or not, and once the coordinator closes
# it with round-close it is never listed again: the tab never presents it.
check "an entry answered in the pane is never due, and once closed with round-close is never listed again" \
  "0|closed xu|0|0" \
  "$(dround | grep -c '^round xu .* | due')|$(ORCHESTRATOR_STATE_DIR="$DSTATE" bash "$COORD" round-close xu --answer 'answered from the pane: A : ship it' 2>&1)|$(dround | grep -c '^round xu ')|$(dround | grep -c 'Ask xu?')"
check "round refuses a pinned clock that is no UTC time" "exit 1|coordinator: round: COORDINATOR_NOW is no UTC time: soon" \
  "$(ORCHESTRATOR_STATE_DIR="$DSTATE" COORDINATOR_NOW=soon bash "$COORD" round >/dev/null 2>&1; echo "exit $?")|$(ORCHESTRATOR_STATE_DIR="$DSTATE" COORDINATOR_NOW=soon bash "$COORD" round 2>&1)"
# round --by-urgency lists the same lines, due marked the same, each set ordered urgent first,
# then by start, across senders: the order a decision round over every orchestrator asks in.
USTATE="$WORK/coord-urgency"; UCFG="$WORK/coord-urgency-config"
mkdir -p "$USTATE/round" "$UCFG/claude-orchestrator/store/sessions"
for spec in "a0:a:open:10:00:false" "b1:b:open:10:01:true" "b2:b:open:10:02:false" "a3:a:open:10:03:true" \
    "a4:a:answered:10:04:true" "b5:b:answered:10:05:false" "b6:b:open:10:06:false" "a7:a:open:10:06:false" \
    "a8:a:withdrawn:10:08:true"; do
  IFS=: read -r uid ufrom ustatus uh um uurgent <<< "$spec"
  jq -n --arg id "$uid" --arg from "Orch : $ufrom" --arg status "$ustatus" --arg since "2026-10-24T$uh:$um:00.000Z" --argjson urgent "$uurgent" \
    '{id:$id, from:$from, session:("s-" + ($from | ascii_downcase | gsub("[^a-z]"; ""))), kind:"operator", since:$since,
      blocks:"phase 3", question:("Ask " + $id + "?"), choices:[], recommendation:null, status:$status, at:$since,
      answer:(if $status == "answered" then {text:"A : ship it", by:"pane", at:"2026-10-24T11:00:00.000Z"} else null end)}
     + (if $urgent then {urgent:true} else {} end)' > "$USTATE/round/$uid.json"
done
: > "$UCFG/claude-orchestrator/store/sessions/s-orcha"; : > "$UCFG/claude-orchestrator/store/sessions/s-orchb"
printf '{"session":"s-coord","pid":"4242","at":"2026-10-24T09:00:00.000Z"}\n' > "$USTATE/pane.json"
uround() { ORCHESTRATOR_STATE_DIR="$USTATE" CLAUDE_CONFIG_DIR="$UCFG" COORDINATOR_PS_TABLE="$WORK/coord-due-ps" bash "$COORD" round "$@" 2>&1; }
check "round --by-urgency orders each set urgent first, then by start, across senders, due marked as without it" \
  "round b1 | operator | from Orch : b | since 2026-10-24T10:01:00.000Z | blocks: phase 3 | open | due
round a3 | operator | from Orch : a | since 2026-10-24T10:03:00.000Z | blocks: phase 3 | open | due
round a0 | operator | from Orch : a | since 2026-10-24T10:00:00.000Z | blocks: phase 3 | open
round b2 | operator | from Orch : b | since 2026-10-24T10:02:00.000Z | blocks: phase 3 | open
round a7 | operator | from Orch : a | since 2026-10-24T10:06:00.000Z | blocks: phase 3 | open
round b6 | operator | from Orch : b | since 2026-10-24T10:06:00.000Z | blocks: phase 3 | open
round a4 | operator | from Orch : a | since 2026-10-24T10:04:00.000Z | blocks: phase 3 | answered
round b5 | operator | from Orch : b | since 2026-10-24T10:05:00.000Z | blocks: phase 3 | answered
round a8 | operator | from Orch : a | since 2026-10-24T10:08:00.000Z | blocks: phase 3 | withdrawn" \
  "$(uround --by-urgency | grep '^round ')"
# Two entries started at the same instant (a7, b6) are ordered by id, whoever wrote first; a
# withdrawn entry is listed last and never due.
check "round --by-urgency with no pane open reads the same order, every open entry due" \
  "round b1 | operator | from Orch : b | since 2026-10-24T10:01:00.000Z | blocks: phase 3 | open | due
round a3 | operator | from Orch : a | since 2026-10-24T10:03:00.000Z | blocks: phase 3 | open | due
round a0 | operator | from Orch : a | since 2026-10-24T10:00:00.000Z | blocks: phase 3 | open | due
round b2 | operator | from Orch : b | since 2026-10-24T10:02:00.000Z | blocks: phase 3 | open | due
round a7 | operator | from Orch : a | since 2026-10-24T10:06:00.000Z | blocks: phase 3 | open | due
round b6 | operator | from Orch : b | since 2026-10-24T10:06:00.000Z | blocks: phase 3 | open | due
round a4 | operator | from Orch : a | since 2026-10-24T10:04:00.000Z | blocks: phase 3 | answered
round b5 | operator | from Orch : b | since 2026-10-24T10:05:00.000Z | blocks: phase 3 | answered
round a8 | operator | from Orch : a | since 2026-10-24T10:08:00.000Z | blocks: phase 3 | withdrawn" \
  "$(mv "$USTATE/pane.json" "$WORK/coord-urgency-pane"; uround --by-urgency | grep '^round '; mv "$WORK/coord-urgency-pane" "$USTATE/pane.json")"
check "round without the flag keeps the round's order, its lines those of --by-urgency, and refuses another argument" \
  "a0 a3 a7 b1 b2 b6 a4 b5 a8|same lines|exit 1|coordinator: round: unexpected argument --soon" \
  "$(uround | grep '^round ' | cut -d' ' -f2 | tr '\n' ' ' | sed 's/ $//')|$([ "$(uround | sort)" = "$(uround --by-urgency | sort)" ] && echo 'same lines')|$(uround --soon >/dev/null 2>&1; echo "exit $?")|$(uround --soon)"
if [ -n "$RCFG_HAD" ]; then export CLAUDE_CONFIG_DIR="$RCFG_WAS"; else unset CLAUDE_CONFIG_DIR; fi

echo "== routing: cost =="

ROUTING="$ROOT/skills/model-routing/scripts/routing.py"
RFIX="$ROOT/tests/fixtures/routing"
RSTATE="$WORK/rstate"; mkdir -p "$RSTATE/routing"
cp "$RFIX/prices.json" "$RSTATE/routing/prices.json"
rcost() { ORCHESTRATOR_STATE_DIR="$RSTATE" ORCHESTRATOR_PROJECTS_DIR="$RFIX/projects" python3 "$ROUTING" cost "$@"; }

check "cost of a session: one usage per message id, subagents included, tiered price applied" \
  "cost_usd=0.170100 models=a-model-1,c-model-1 tokens_in=202000 tokens_out=4000 cache_read=10000 cache_write=3000" \
  "$(rcost --session s-1)"
check "cost of one transcript file, by path" "0.1695" \
  "$(rcost "$RFIX/projects/-repo/s-1.jsonl" --json | jq -r '.cost_usd|.*10000|round/10000')"
check "a placeholder message with an all-zero usage is neither priced nor named" "0" \
  "$(rcost --session s-1 2>&1 | grep -c 'synthetic')"
# The upper rates apply when fresh input plus cache reads pass the threshold: 50000 + 60000
# is 110000 > 100000 though input alone is below it. 50000 * 0.5 + 60000 * 0.05 = 28000
# micro-dollars; at the lower rates it would be 5600.
check "the tiered price is judged on the whole prompt, not on fresh input alone" \
  "cost_usd=0.028000 models=c-model-1 tokens_in=50000 tokens_out=0 cache_read=60000 cache_write=0" \
  "$(rcost --session s-2)"
check_status "a transcript with no assistant usage is a refusal, never a cost of zero" 1 rcost --session s-4
check "and the refusal names the session" "1" "$(rcost --session s-4 2>&1 | grep -c 's-4')"
rm "$RSTATE/routing/prices.json"
check "no price file: the cost is unknown, never guessed" "cost_usd=unknown" \
  "$(rcost --session s-1 2>/dev/null | cut -d' ' -f1)"
check "no price file: stderr names the model" "1" \
  "$(rcost --session s-1 2>&1 >/dev/null | grep -c 'no price for a-model-1')"
cp "$RFIX/prices.json" "$RSTATE/routing/prices.json"
check_status "an unknown session is a refusal" 1 rcost --session s-404
check "a transcript path that does not exist is a refusal, never a cost of zero" "ERROR: cost: no transcript at $WORK/none.jsonl" \
  "$(rcost "$WORK/none.jsonl" 2>&1)"
rcost --session s-1 --alias a-model >/dev/null
check "the alias records the identifier it resolved to" "a-model-1" \
  "$(jq -r '.["a-model"]' "$RSTATE/routing/aliases.json")"
# A session of other models says nothing about an alias none of its identifiers carries: the
# costliest one is not that alias's identifier, and folding pairs on it would merge two models.
check "an alias no model of the session carries is recorded as nothing, the others kept" "0|false|a-model-1" \
  "$(rcost --session s-1 --alias b-model >/dev/null 2>&1; echo $?)|$(jq -r 'has("b-model")' "$RSTATE/routing/aliases.json")|$(jq -r '.["a-model"]' "$RSTATE/routing/aliases.json")"

echo "== routing: pick =="

T="$ROOT/tests/fixtures/routing/trees"
check "profile: a composer project with artisan" "php/laravel-app" "$(python3 "$ROUTING" profile "$T/laravel")"
check "profile: a plugin by its manifest, language by dominant extension" "shell/plugin" "$(python3 "$ROUTING" profile "$T/plugin")"
check "profile: a python project with a bin entry point" "python/cli" "$(python3 "$ROUTING" profile "$T/pycli")"
check "profile: a node package with no entry point" "javascript/library" "$(python3 "$ROUTING" profile "$T/jslib")"
check_status "profile: no path is a refusal" 1 python3 "$ROUTING" profile

PS="$WORK/pstate"; mkdir -p "$PS/routing/tables" "$PS/routing/projects/laravel"
printf '{"deep":"a-model","standard":{"model":"b-model","effort":"medium"},"light":"c-model"}' > "$PS/models.json"
printf '{"slug":"laravel","repo":"%s","profile":"php/laravel-app","tasks":[]}' "$T/laravel" > "$PS/routing/projects/laravel/manifest.json"
DEF="$WORK/defaults"; mkdir -p "$DEF"
rpick() { ORCHESTRATOR_STATE_DIR="$PS" ORCHESTRATOR_ROUTING_DEFAULTS="$DEF" python3 "$ROUTING" pick --repo "$T/laravel" "$@"; }
check "nothing measured: the tier table through the map" $'pair=b-model/medium source=tier-table\nnbis=b-model/high' "$(rpick --class behaviour-phase)"
check "nothing measured, a tier bound to a model alone" "pair=c-model source=tier-table" "$(rpick --class search)"
mv "$PS/models.json" "$PS/models.json.off"
check "nothing measured and nothing bound: the host's default" "pair=host-default source=tier-table" "$(rpick --class search)"
mv "$PS/models.json.off" "$PS/models.json"
printf '{"scope":"global","entries":{"behaviour-phase":{"pair":"light/high"}}}' > "$DEF/global.json"
check "a shipped default resolves its tier through the map" $'pair=c-model/high source=shipped:global\nnbis=c-model/xhigh' "$(rpick --class behaviour-phase)"
printf '{"scope":"profile:php/laravel-app","entries":{"behaviour-phase":{"pair":"deep/low"}}}' > "$DEF/profile-php-laravel-app.json"
check "a shipped profile default beats the shipped global one" $'pair=a-model/low source=shipped:profile:php/laravel-app\nnbis=a-model/medium' "$(rpick --class behaviour-phase)"
printf '{"scope":"profile:php/laravel-app","entries":{"behaviour-phase":{"pair":"nonsense/low"}}}' > "$DEF/profile-php-laravel-app.json"
check "a shipped default on a tier the map does not bind falls through" $'pair=c-model/high source=shipped:global\nnbis=c-model/xhigh' "$(rpick --class behaviour-phase)"
printf '{"scope":"global","entries":{"behaviour-phase":{"pair":"c-model/medium","models":["c-model-1"]}}}' > "$PS/routing/tables/global.json"
check "the local global table beats the shipped defaults" $'pair=c-model/medium source=global\nnbis=c-model/high' "$(rpick --class behaviour-phase)"
printf '{"scope":"profile:php/laravel-app","entries":{"behaviour-phase":{"pair":"b-model/low","models":["b-model-1"]}}}' > "$PS/routing/tables/profile-php-laravel-app.json"
check "the profile table beats the global one" $'pair=b-model/low source=profile:php/laravel-app\nnbis=b-model/medium' "$(rpick --class behaviour-phase)"
printf '{"scope":"project:laravel","entries":{"behaviour-phase":{"pair":"a-model/low","models":["a-model-1"],"floor":0.9,"ladder":[{"pair":"a-model/low","n":6,"pass_rate":1.0,"eligible":true}]},"conversion-phase":{"pair":"a-model/medium","models":["a-model-1"],"floor":0.9,"ladder":[{"pair":"a-model/low","n":8,"pass_rate":0.5,"eligible":false},{"pair":"a-model/medium","n":8,"pass_rate":1.0,"eligible":true}]},"comments":{"pair":"a-model/high","models":["a-model-1"],"floor":0.9,"ladder":[{"pair":"a-model/low","n":6,"pass_rate":1.0,"eligible":true},{"pair":"a-model/medium","n":8,"pass_rate":0.5,"eligible":false},{"pair":"a-model/high","n":6,"pass_rate":1.0,"eligible":true}]},"review-collector":{"pair":"a-model/high","models":["a-model-1"],"floor":0.9,"ladder":[{"pair":"a-model/low","n":6,"pass_rate":1.0,"eligible":true},{"pair":"a-model/medium","n":6,"pass_rate":1.0,"eligible":true},{"pair":"a-model/high","n":6,"pass_rate":1.0,"eligible":true}]},"review-lens":{"pair":"a-model/high","models":["a-model-1"],"floor":0.9,"ladder":[{"pair":"a-model/low","n":6,"pass_rate":1.0,"eligible":true},{"pair":"a-model/medium","n":2,"pass_rate":1.0,"eligible":false},{"pair":"a-model/high","n":6,"pass_rate":1.0,"eligible":true}]},"contract-phase":{"pair":"a-model/high","models":["a-model-1"]}}}' > "$PS/routing/tables/project-laravel.json"
check "the project table beats them all" $'pair=a-model/low source=project:laravel\nnbis=a-model/medium' "$(rpick --class behaviour-phase)"
printf '{"a-model":"a-model-2"}' > "$PS/routing/aliases.json"
check "an entry measured on another identifier is flagged stale" $'pair=a-model/low source=project:laravel stale\nnbis=a-model/medium' "$(rpick --class behaviour-phase)"
check_status "an unknown class is a refusal" 1 rpick --class nonsense
# Exploration: three one-round closes at the class's pair, none escaped, and a class that may be explored.
ER="$WORK/explore.jsonl"; : > "$ER"
for i in 1 2 3; do printf '{"id":%d,"class":"behaviour-phase","model":"a-model","effort":"low","rounds":1,"state":"closed"}\n' "$i" >> "$ER"; done
check "three clean closes offer one notch down: the lowest rung, no lower effort, so the next lighter family" \
  "explore=b-model/low" "$(rpick --class behaviour-phase --record "$ER" | sed -n 2p)"
check "two clean closes are not enough" "2" \
  "$(sed -n 1,2p "$ER" > "$WORK/two.jsonl"; rpick --class behaviour-phase --record "$WORK/two.jsonl" | wc -l | tr -d ' ')"
check "a line of the record that does not read is skipped, not fatal" "explore=b-model/low" \
  "$({ cat "$ER"; echo '{"id":'; } > "$WORK/torn.jsonl"; rpick --class behaviour-phase --record "$WORK/torn.jsonl" 2>/dev/null | sed -n 2p)"
check "an escaped defect at the class's pair closes the exploration" "2" \
  "$({ cat "$ER"; printf '{"id":4,"class":"behaviour-phase","model":"a-model","effort":"low","rounds":1,"state":"closed","escaped":true}\n'; } > "$WORK/esc.jsonl"; rpick --class behaviour-phase --record "$WORK/esc.jsonl" | wc -l | tr -d ' ')"
check "a failed exploration freezes the class for the build" "2" \
  "$({ cat "$ER"; printf '{"id":5,"class":"behaviour-phase","model":"b-model","effort":"low","rounds":2,"state":"closed","explore":true}\n'; } > "$WORK/frozen.jsonl"; rpick --class behaviour-phase --record "$WORK/frozen.jsonl" | wc -l | tr -d ' ')"
check "a notch the ladder measured below the floor is never offered" "2" \
  "$(for i in 1 2 3; do printf '{"id":%d,"class":"conversion-phase","model":"a-model","effort":"medium","rounds":1,"state":"closed"}\n' "$i"; done > "$WORK/conv.jsonl"; rpick --class conversion-phase --record "$WORK/conv.jsonl" | wc -l | tr -d ' ')"
hi3() { for i in 1 2 3; do printf '{"id":%d,"class":"%s","model":"a-model","effort":"high","rounds":1,"state":"closed"}\n' "$i" "$1"; done; }
# The notch is the IMMEDIATE cheaper rung. Comments: medium was measured at 0.5 over 8, below
# the 0.9 floor, so no notch - the eligible low rung beneath it is two notches, not one.
hi3 comments > "$WORK/n-a.jsonl"
check "an immediate rung measured below the floor is no notch, the eligible one beneath it is not offered" "2" \
  "$(rpick --class comments --record "$WORK/n-a.jsonl" | wc -l | tr -d ' ')"
hi3 review-collector > "$WORK/n-b.jsonl"
check "an eligible immediate rung is the notch" "explore=a-model/medium" \
  "$(rpick --class review-collector --record "$WORK/n-b.jsonl" | sed -n 2p)"
# Review-lens: medium has only 2 trials at 1.0 - not yet eligible, which is why it is worth testing.
hi3 review-lens > "$WORK/n-c.jsonl"
check "an immediate rung with too few trials is offered, not skipped for the eligible one below" "explore=a-model/medium" \
  "$(rpick --class review-lens --record "$WORK/n-c.jsonl" | sed -n 2p)"
check "a contract phase is never explored, measured or not" "2" \
  "$(printf '{"id":9,"class":"contract-phase","model":"a-model","effort":"high","rounds":1,"state":"closed"}\n%.0s' 1 2 3 > "$WORK/c.jsonl"; rpick --class contract-phase --record "$WORK/c.jsonl" | wc -l | tr -d ' ')"
# A table written before the selection by equivalence: a floor, rungs with no new field.
check "show --detail reads a table written before the tables by task, a missing figure as -" "1|1" \
  "$(ORCHESTRATOR_STATE_DIR="$PS" python3 "$ROUTING" show --detail laravel 2>&1 | grep -c '^class=conversion-phase project=a-model/medium ')|$(ORCHESTRATOR_STATE_DIR="$PS" python3 "$ROUTING" show --detail laravel 2>&1 | grep -c '^  rung pair=a-model/low tasks=- pass_rate=0.5 p_best=- median_usd=- ci=-..- expected_usd=- off_model=-$')"

# The size of a phase: one rule, the bucket a task is stamped with and the one `pick` is given.
rcall() { # a python expression over the module as `m`, printed; a crash is read as its last traceback line
  "$py" -c 'import importlib.util,sys; s=importlib.util.spec_from_file_location("r",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(eval(sys.argv[2]))' "$ROUTING" "$1" 2>&1 | tail -1; }
check "a phase of 3 files and 50 lines is small; one more file or one more line is large" "small|small|large|large" \
  "$(rcall 'm.size_bucket(3, 50)')|$(rcall 'm.size_bucket(0, 0)')|$(rcall 'm.size_bucket(4, 0)')|$(rcall 'm.size_bucket(0, 51)')"

# The N-bis pair: the corrective round runs one effort notch above its phase (the round is the
# retry: cheap first, escalate on failure). The top effort has no notch above, so it stays.
check "the notch up is the next effort of the same family, and the top stays" "a-model/medium|a-model/high|a-model/xhigh|a-model/max|a-model/max" \
  "$(rcall 'm.nbis_pair("a-model/low")')|$(rcall 'm.nbis_pair("a-model/medium")')|$(rcall 'm.nbis_pair("a-model/high")')|$(rcall 'm.nbis_pair("a-model/xhigh")')|$(rcall 'm.nbis_pair("a-model/max")')"
check "a pair with no effort, or one the efforts do not list, has no notch up" "None|None|None" \
  "$(rcall 'm.nbis_pair("a-model")')|$(rcall 'm.nbis_pair("host-default")')|$(rcall 'm.nbis_pair("a-model/ultra")')"
check "the notch up comes last, after the explore line" $'explore=b-model/low\nnbis=a-model/medium' \
  "$(rpick --class behaviour-phase --record "$ER" | sed -n 2,3p)"
check "and nothing follows it" "3" "$(rpick --class behaviour-phase --record "$ER" | wc -l | tr -d ' ')"

# Pick by the phase's size. An entry stamped on smaller work than the phase does not serve it,
# and pick goes on down its order; a table written before the stamp reads as unknown size.
ZS="$WORK/zstate"; ZD="$WORK/zdefaults"; mkdir -p "$ZS/routing/tables" "$ZS/routing/projects/laravel" "$ZD"
printf '{"deep":"a-model","standard":{"model":"b-model","effort":"medium"},"light":"c-model"}' > "$ZS/models.json"
cp "$PS/routing/projects/laravel/manifest.json" "$ZS/routing/projects/laravel/manifest.json"
printf '{"a-model":"a-model-2","b-model":"b-model-2"}' > "$ZS/routing/aliases.json"
printf '{"scope":"project:laravel","entries":{"behaviour-phase":{"pair":"a-model/low","size":"small"},"conversion-phase":{"pair":"a-model/medium"},"comments":{"pair":"a-model/high","size":"large","models":["a-model-1"]},"review-lens":{"pair":"a-model/low","size":"small"}}}' > "$ZS/routing/tables/project-laravel.json"
printf '{"scope":"profile:php/laravel-app","entries":{"behaviour-phase":{"pair":"b-model/low","size":"large"},"conversion-phase":{"pair":"b-model/medium","size":"large","models":["b-model-1"]},"review-lens":{"pair":"b-model/low","size":"small"}}}' > "$ZS/routing/tables/profile-php-laravel-app.json"
printf '{"scope":"global","entries":{"behaviour-phase":{"pair":"c-model/medium","size":"small"},"review-lens":{"pair":"c-model/low","size":"small"}}}' > "$ZS/routing/tables/global.json"
printf '{"scope":"profile:php/laravel-app","entries":{"search":{"pair":"nonsense/low","size":"small"},"n-bis":{"pair":"standard/low","size":"small"}}}' > "$ZD/profile-php-laravel-app.json"
printf '{"scope":"global","entries":{"search":{"pair":"deep/high","size":"large"},"n-bis":{"pair":"standard/high","size":"small"}}}' > "$ZD/global.json"
zpick() { ORCHESTRATOR_STATE_DIR="$ZS" ORCHESTRATOR_ROUTING_DEFAULTS="$ZD" python3 "$ROUTING" pick --repo "$T/laravel" "$@"; }
check "a small phase takes the project's entry measured on small work" $'pair=a-model/low source=project:laravel size=small\nnbis=a-model/medium' \
  "$(zpick --class behaviour-phase --files 2 --lines 40)"
check "3 files and 50 lines, and nothing at all, are still a small phase" "size=small|size=small" \
  "$(zpick --class behaviour-phase --files 3 --lines 50 | grep -o 'size=[a-z]*')|$(zpick --class behaviour-phase --files 0 --lines 0 | grep -o 'size=[a-z]*')"
check "a large phase by its files skips an entry measured on small work and says which scope" $'pair=b-model/low source=profile:php/laravel-app size=large beyond=project:laravel\nnbis=b-model/medium' \
  "$(zpick --class behaviour-phase --files 4 --lines 10)"
check "a large phase by its lines falls through the same way" $'pair=b-model/low source=profile:php/laravel-app size=large beyond=project:laravel\nnbis=b-model/medium' \
  "$(zpick --class behaviour-phase --files 1 --lines 51)"
check "without the options pick reads no size: the project's entry, no size= and no beyond=" $'pair=a-model/low source=project:laravel\nnbis=a-model/medium' \
  "$(zpick --class behaviour-phase)"
check "a table written before the stamp reads as unknown size: skipped by a large phase" $'pair=b-model/medium source=profile:php/laravel-app stale size=large beyond=project:laravel\nnbis=b-model/high' \
  "$(zpick --class conversion-phase --files 9 --lines 9)"
check "and it serves a small phase" $'pair=a-model/medium source=project:laravel size=small\nnbis=a-model/high' \
  "$(zpick --class conversion-phase --files 1 --lines 1)"
check "a large phase with no entry measured on large work lands on the tier table, naming the first scope skipped" $'pair=b-model/medium source=tier-table size=large beyond=project:laravel\nnbis=b-model/high' \
  "$(zpick --class review-lens --files 9 --lines 9)"
check "a project entry measured on large work serves a large phase, nothing skipped" $'pair=a-model/high source=project:laravel stale size=large\nnbis=a-model/xhigh' \
  "$(zpick --class comments --files 9 --lines 9)"
check "a shipped entry measured on large work serves a large phase through the map, a shipped tier the map does not bind never being a beyond" \
  $'pair=a-model/high source=shipped:global size=large\nnbis=a-model/xhigh' "$(zpick --class search --files 9 --lines 9)"
check "a shipped entry measured on small work is skipped by a large phase, the first one named" $'pair=b-model/medium source=tier-table size=large beyond=shipped:profile:php/laravel-app\nnbis=b-model/high' \
  "$(zpick --class n-bis --files 9 --lines 9)"
check "and serves a small phase" $'pair=b-model/low source=shipped:profile:php/laravel-app size=small\nnbis=b-model/medium' \
  "$(zpick --class n-bis --files 1 --lines 1)"
check "the explore line keeps its place when the phase is sized" $'pair=a-model/low source=project:laravel size=small\nexplore=b-model/low\nnbis=a-model/medium' \
  "$(zpick --class behaviour-phase --files 2 --lines 40 --record "$ER")"
check "--files without --lines is a refusal that says they go together" "exit 1|ERROR: pick: --files and --lines go together" \
  "$(zpick --class behaviour-phase --files 3 >/dev/null 2>&1; echo "exit $?")|$(zpick --class behaviour-phase --files 3 2>&1)"
check "--lines without --files is the same refusal" "ERROR: pick: --files and --lines go together" \
  "$(zpick --class behaviour-phase --lines 3 2>&1)"
check "a negative count, or one that is not a whole number, is a refusal that says what a count is" \
  "exit 1|ERROR: pick: --files and --lines are counts, 0 or more|ERROR: pick: --files and --lines are counts, 0 or more|ERROR: pick: --files and --lines are counts, 0 or more|ERROR: pick: --files and --lines are counts, 0 or more" \
  "$(zpick --class behaviour-phase --files -1 --lines 3 >/dev/null 2>&1; echo "exit $?")|$(zpick --class behaviour-phase --files -1 --lines 3 2>&1)|$(zpick --class behaviour-phase --files 3 --lines -1 2>&1)|$(zpick --class behaviour-phase --files abc --lines 3 2>&1)|$(zpick --class behaviour-phase --files 2.5 --lines 3 2>&1)"
check "a refusal prints no pair" "0" "$(zpick --class behaviour-phase --files -1 --lines 3 2>/dev/null | wc -l | tr -d ' ')"

echo "== routing: calibrate =="

CS="$WORK/calstate"; mkdir -p "$CS/routing/projects/demo"
TR="$CS/routing/projects/demo/trials.jsonl"; : > "$TR"
trial() { # class pair status cost [task]: a pair's trials cycle over three tasks; an empty task names none
  local task="${5-t$(( $(grep -c "\"class\":\"$1\",\"pair\":\"$2\"" "$TR") % 3 + 1 ))}" tf=""
  [ -n "$task" ] && tf="\"task\":\"$task\","
  printf '{%s"class":"%s","pair":"%s","rep":1,"models":{"%s-1":%s},"cost_usd":%s,"status":"%s"}\n' \
    "$tf" "$1" "$2" "${2%%/*}" "$4" "$4" "$3" >> "$TR"; }
for i in 1 2 3 4; do trial behaviour-phase c-model/medium pass 0.10; done
for i in 1 2; do trial behaviour-phase c-model/medium fail 0.10; done
for i in 1 2 3 4 5 6; do trial behaviour-phase b-model/medium pass 0.30; trial behaviour-phase a-model/low pass 0.50; done
trial behaviour-phase b-model/medium error 0.05
for i in 1 2 3 4 5; do trial contract-phase b-model/high pass 0.40; done
trial contract-phase b-model/high fail 0.40
for i in 1 2 3 4 5 6; do trial contract-phase a-model/high pass 0.90; done
# Escalation term. search: c-model/low costs 0.10 and passes 7 of 7, 7 of 7 and 5 of 6 on its three
# tasks (pass rate 0.9444, equivalent to the best); b-model/medium costs 0.105 and passes 6 of 6.
# expected_usd(c) = 0.10 + (1 - 0.9444) * 0.105 = 0.105838 against 0.105 for b, so the dearer pair
# wins; with the term at 0 the cheaper one would (0.10 < 0.105).
for t in t1 t2; do for i in $(seq 7); do trial search c-model/low pass 0.10 "$t"; done; done
for i in $(seq 5); do trial search c-model/low pass 0.10 t3; done; trial search c-model/low fail 0.10 t3
for i in 1 2 3 4 5 6; do trial search b-model/medium pass 0.105; done
# A pair with one failure in 20: 19 of 20 at 0.20 is equivalent to the best, and its expected_usd
# would beat a-model/high's 0.9 were a strict class not held to a pair that never failed.
for i in $(seq 19); do trial contract-phase c-model/high pass 0.20; done; trial contract-phase c-model/high fail 0.20
printf '{"task":"t","class":"behaviour-phase","pair":"b-model/medium","rep":1,"cost_' >> "$TR"; echo >> "$TR"
printf '{"task":"t","class":"behaviour-phase","pair":"b-model/default","rep":1,"cost_usd":9,"status":"pass"}\n' >> "$TR"
# A trial with no cost is not free: it is unreadable, and left out of n and of the mean cost.
printf '{"task":"t","class":"behaviour-phase","pair":"b-model/medium","rep":1,"models":{},"status":"pass"}\n' >> "$TR"
printf '{"task":"t","class":"behaviour-phase","pair":"b-model/medium","rep":1,"models":{},"cost_usd":null,"status":"pass"}\n' >> "$TR"
printf '{"slug":"demo","repo":"/nonexistent","profile":"x/y","tasks":[]}' > "$CS/routing/projects/demo/manifest.json"
rcal() { ORCHESTRATOR_STATE_DIR="$CS" python3 "$ROUTING" calibrate "$@"; }
out=$(rcal demo 2>"$WORK/cal.err")
check "a pair not equivalent to the best is never chosen, however cheap" "class=behaviour-phase pair=b-model/medium pass_rate=1.0 n=6 expected_usd=0.2643 p_best=0.4815 size=unknown" \
  "$(printf '%s\n' "$out" | grep '^class=behaviour-phase')"
check "work nothing re-checks takes only a pair that never failed" "class=contract-phase pair=a-model/high pass_rate=1.0 n=6 expected_usd=0.9 p_best=0.4143 size=unknown" \
  "$(printf '%s\n' "$out" | grep '^class=contract-phase')"
check "a cheaper pair that fails now and then loses to a dearer sure one on the escalation it costs" "class=search pair=b-model/medium pass_rate=1.0 n=6 expected_usd=0.105 p_best=0.4497 size=unknown" \
  "$(printf '%s\n' "$out" | grep '^class=search')"
check "and its expected cost is the cheaper pair's cost plus the escalation" "0.105838" \
  "$(jq -r '.entries.search.ladder[]|select(.pair=="c-model/low")|.expected_usd' "$CS/routing/tables/project-demo.json")"
check "an error trial costs but does not count" "6|0.2643" \
  "$(jq -r '.entries["behaviour-phase"].ladder[]|select(.pair=="b-model/medium")|"\(.n)|\(.cost_usd*10000|round/10000)"' "$CS/routing/tables/project-demo.json")"
check "the ladder is ordered by cost, cheapest first" "c-model/medium,b-model/medium,a-model/low" \
  "$(jq -r '[.entries["behaviour-phase"].ladder[].pair]|join(",")' "$CS/routing/tables/project-demo.json")"
check "the entry keeps the identifiers it was measured on" "b-model-1" \
  "$(jq -r '.entries["behaviour-phase"].models|join(",")' "$CS/routing/tables/project-demo.json")"
check "the entry keeps its selection, its scope and the ladder's eligibility" "1|8|true|project:demo|false,true,true" \
  "$(jq -r '"\(.entries["behaviour-phase"].delta*10|round)|\(.entries["behaviour-phase"].bar*10|round)|\(.entries["contract-phase"].strict)|\(.scope)|\([.entries["behaviour-phase"].ladder[].eligible]|map(tostring)|join(","))"' "$CS/routing/tables/project-demo.json")"
check "a torn trial line, a line with no pair and a trial with no cost are skipped with a warning each, never fatal" "4" \
  "$(grep -c 'does not read as a trial, skipped' "$WORK/cal.err")"
# A trial whose cost could not be read holds the ceiling it was launched with: it stays out of the pair's mean.
printf '{"task":"t1","class":"behaviour-phase","pair":"b-model/medium","rep":1,"models":{},"cost_usd":2.0,"cost_incomplete":true,"status":"error"}\n' >> "$TR"
printf '{"task":"t1","class":"behaviour-phase","pair":"b-model/medium","rep":1,"models":{},"cost_usd":2.0,"cost_incomplete":true,"status":"pass"}\n' >> "$TR"
rcal demo >/dev/null 2>&1
check "an unread cost leaves the pair's cost unchanged" "0.2643" \
  "$(jq -r '.entries["behaviour-phase"].ladder[]|select(.pair=="b-model/medium")|.cost_usd*10000|round/10000' "$CS/routing/tables/project-demo.json")"
printf '{"selection":{"delta":0.4}}' > "$CS/routing/config.json"
check "the operator's config sets the selection" "class=behaviour-phase pair=c-model/medium" \
  "$(rcal demo 2>/dev/null | grep '^class=behaviour-phase' | cut -d' ' -f1-2)"
rm "$CS/routing/config.json"
# A class with no bench task: fewer than six trials covers no pair.
: > "$TR"; for i in 1 2 3; do trial n-bis c-model/low pass 0.01 ""; done
check "fewer than six trials is never eligible" "class=n-bis no eligible pair (no covered pair)" "$(rcal demo)"
check "and the class gets no entry" "0" "$(jq '.entries|length' "$CS/routing/tables/project-demo.json")"
# Record rows count as trials: closed in one round and not escaped is a pass.
RR="$WORK/calrec.jsonl"; : > "$RR"
for i in 1 2 3 4 5 6; do printf '{"id":%d,"class":"n-bis","model":"c-model","effort":"low","rounds":1,"state":"closed","cost_usd":0.02,"sessions":["s"],"cost_incomplete":false}\n' "$i" >> "$RR"; done
# Left out: an open row, a row with no measured cost, an incomplete cost, a tier row, a row with no effort.
printf '{"id":7,"class":"n-bis","model":"c-model","effort":"low","rounds":0,"state":"open","cost_usd":0,"sessions":[],"cost_incomplete":false}\n' >> "$RR"
printf '{"id":8,"class":"n-bis","model":"c-model","effort":"low","rounds":1,"state":"closed","cost_usd":0,"sessions":[],"cost_incomplete":false}\n' >> "$RR"
printf '{"id":9,"class":"n-bis","model":"c-model","effort":"low","rounds":1,"state":"closed","cost_usd":5,"sessions":["s"],"cost_incomplete":true}\n' >> "$RR"
printf '{"id":10,"class":"n-bis","tier":"light","rounds":1,"state":"closed"}\n' >> "$RR"
printf '{"id":11,"class":"n-bis","model":"c-model","effort":"","rounds":1,"state":"closed","cost_usd":5,"sessions":["s"],"cost_incomplete":false}\n' >> "$RR"
check "record rows complete the measurement" "class=n-bis pair=c-model/low pass_rate=1.0 n=9 expected_usd=0.0167 p_best=1.0 size=unknown" \
  "$(rcal demo --from-record "$RR")"
printf '{"id":12,"class":"n-bis","model":"c-model","effort":"low","rounds":2,"state":"closed","cost_usd":0.02,"sessions":["s"],"cost_incomplete":false}\n' >> "$RR"
printf '{"id":13,"class":"n-bis","model":"c-model","effort":"low","rounds":1,"state":"closed","cost_usd":0.02,"sessions":["s"],"cost_incomplete":false,"escaped":true}\n' >> "$RR"
# Nine passes in eleven: a posterior median of 0.78, below the bar: both rows read as failures.
check "a corrective round or an escaped defect grades a row as a failure" "class=n-bis no eligible pair (best c-model/low weak)" \
  "$(rcal demo --from-record "$RR")"
: > "$TR"
check_status "no trial and no record row is a refusal" 1 rcal demo
check "and with nothing left out, it says there was no trial and no record row" "ERROR: calibrate: no trial and no record row for demo" "$(rcal demo 2>&1)"
check_status "a record that does not exist is a refusal" 1 rcal demo --from-record "$WORK/no-such-record.jsonl"

# Tables by task: a pair is weighed per task, compared with the best measured pair, and its
# entry stamped with the size of the work it was measured on.
TS="$WORK/taskstate"; mkdir -p "$TS/routing/projects/tasks"
TT="$TS/routing/projects/tasks/trials.jsonl"; : > "$TT"
TTAB="$TS/routing/tables/project-tasks.json"
tt() { # task class pair status cost [main model]
  printf '{"task":"%s","class":"%s","pair":"%s","rep":1,"models":{"%s":%s},"cost_usd":%s,"status":"%s"}\n' \
    "$1" "$2" "$3" "${6:-${3%%/*}-1}" "$5" "$5" "$4" >> "$TT"; }
# A fixture repository: t-small adds two files of 20 lines each and a test of 300 lines; t-large
# then touches four files of one line each.
SR="$WORK/sizerepo"; mkdir -p "$SR/tests"; git -C "$SR" init -q
echo base > "$SR/README"; gc -C "$SR" add -A; gc -C "$SR" commit -qm base
S0=$(git -C "$SR" rev-parse HEAD)
seq 20 > "$SR/a.txt"; seq 20 > "$SR/b.txt"; seq 300 > "$SR/tests/a_test.sh"
gc -C "$SR" add -A; gc -C "$SR" commit -qm small
S1=$(git -C "$SR" rev-parse HEAD)
for f in c d e f; do echo x > "$SR/$f.txt"; done
gc -C "$SR" add -A; gc -C "$SR" commit -qm large
S2=$(git -C "$SR" rev-parse HEAD)
"$py" -c "
import json,sys
repo,s0,s1,s2,out=sys.argv[1:6]
tasks=[{'id':'t-large','class':'behaviour-phase','base':s1,'merged':s2,'status':'ready'}]
tasks+=[{'id':t,'class':'behaviour-phase','base':s0,'merged':s1,'status':'ready'} for t in ('t-a','t-b','t-c','t-d')]
json.dump({'slug':'tasks','repo':repo,'profile':'x/y','test_globs':['tests/*'],'tasks':tasks},open(out,'w'))
" "$SR" "$S0" "$S1" "$S2" "$TS/routing/projects/tasks/manifest.json"
# review-collector, five tasks at two reps: the best a-model/high at 10/10; b-model/medium at 9/10
# and cheaper; c-model/low at 8/10 and cheapest.
for t in t-a t-b t-c t-d t-e; do
  for r in 1 2; do tt "$t" review-collector a-model/high pass 1.0; done
  tt "$t" review-collector c-model/low pass 0.1
  case "$t" in t-a|t-b) tt "$t" review-collector c-model/low fail 0.1 ;; *) tt "$t" review-collector c-model/low pass 0.1 ;; esac
  tt "$t" review-collector b-model/medium pass 0.4
  case "$t" in t-a) tt "$t" review-collector b-model/medium fail 0.4 ;; *) tt "$t" review-collector b-model/medium pass 0.4 ;; esac
done
# behaviour-phase on the manifest's five tasks: a-model/high 2/2 on each; c-model/low 2/2 on t-a and
# 0/1 on t-b; c-model/medium perfect and cheapest but never graded on t-d.
for t in t-large t-a t-b t-c t-d; do tt "$t" behaviour-phase a-model/high pass 0.5; tt "$t" behaviour-phase a-model/high pass 0.5; done
tt t-a behaviour-phase c-model/low pass 0.05; tt t-a behaviour-phase c-model/low pass 0.05; tt t-b behaviour-phase c-model/low fail 0.05
for t in t-large t-a t-b t-c; do for r in 1 2 3; do tt "$t" behaviour-phase c-model/medium pass 0.01; done; done
# An off-model trial: the pair is b-model's, the money went to a-model-1.
tt t-a behaviour-phase b-model/medium pass 0.2; tt t-a behaviour-phase b-model/medium fail 0.9 a-model-1
# A full identifier and an alias, each run on its own model: the full identifier is reported exactly
# as the pair names it; the alias is reported as the identifier it resolved to. One trial of the
# full identifier's pair reports a key that merely starts with it: another model, off-model.
for t in t-large t-a t-b t-c t-d; do tt "$t" behaviour-phase b-model-1/low pass 0.3 b-model-1; tt "$t" behaviour-phase b-model/high pass 0.35; done
tt t-a behaviour-phase b-model-1/low pass 0.9 b-model-1-1
# comments: the best is 4/5, its posterior median below 0.8.
for t in t-a t-b t-c t-d; do tt "$t" comments a-model/high pass 0.5; done; tt t-e comments a-model/high fail 0.5
# contract-phase, strict: b-model/high at 9/10 is equivalent and cheaper, the 10/10 pair is chosen.
for t in t-a t-b t-c t-d t-e; do
  for r in 1 2; do tt "$t" contract-phase a-model/high pass 1.0; done
  tt "$t" contract-phase b-model/high pass 0.4
  [ "$t" = t-e ] && tt "$t" contract-phase b-model/high fail 0.4 || tt "$t" contract-phase b-model/high pass 0.4
done
# search: two tasks only.
for t in t-a t-b; do for r in 1 2 3 4; do tt "$t" search c-model/low pass 0.01; done; done
rtc() { ORCHESTRATOR_STATE_DIR="$TS" python3 "$ROUTING" calibrate tasks "$@"; }
out=$(rtc 2>"$WORK/tasks.err")
rung() { jq -r --arg c "$1" --arg p "$2" ".entries[\$c].ladder[]|select(.pair==\$p)|$3" "$TTAB"; }
check "a pair's pass rate is the mean of its per-task rates, n its graded trials" "0.5|3|2" \
  "$(rung behaviour-phase c-model/low '"\(.pass_rate)|\(.n)|\(.tasks)"')"
check "a trial whose main model is another family is out of n and costs, counted off-model" "1|1.0|0.2|1" \
  "$(rung behaviour-phase b-model/medium '"\(.n)|\(.pass_rate)|\(.cost_usd)|\(.off_model)"')"
check "a full-identifier pair is compared exactly, an alias pair by its dash segment: only the key that starts with the identifier is off-model" "1|5|0|5" \
  "$(rung behaviour-phase b-model-1/low '"\(.off_model)|\(.n)"')|$(rung behaviour-phase b-model/high '"\(.off_model)|\(.n)"')"
check "on_model: an identifier is compared exactly, a bracketed suffix ignored; an alias keeps the dash-segment rule" "True|True|False|False|False|True|True|True" \
  "$("$py" -c 'import importlib.util,sys; s=importlib.util.spec_from_file_location("r",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); f=m.on_model; print("|".join(str(x) for x in (f("b-model-1/low", {"b-model-1": 1}), f("b-model-1/low", {"b-model-1[1m]": 1}), f("b-model-1/low", {"b-model-1-1": 1}), f("b-model-1/low", {"x-b-model-1": 1}), f("b-model-1/low", {"b-model-12": 1}), f("b-model/high", {"b-model-1": 1}), f("b-model/high", {"b-model-1[1m]": 1}), f("b-model-1/low", {}))))' "$ROUTING")"
check "the cheapest pair equivalent to the best is the entry; one too far below is not equivalent" \
  "b-model/medium|a-model/high|false|true" \
  "$(jq -r '.entries["review-collector"]|"\(.pair)|\(.best)|\(.ladder[]|select(.pair=="c-model/low")|.equivalent)|\(.ladder[]|select(.pair=="b-model/medium")|.equivalent)"' "$TTAB")"
check "the calibrate line names the pair, its rates, its p_best and its size" "1" \
  "$(printf '%s\n' "$out" | grep -cE '^class=review-collector pair=b-model/medium pass_rate=0.9 n=10 expected_usd=0.5 p_best=[0-9.]+ size=small$')"
check "a best pair whose posterior median is below the bar leaves the class without an entry" \
  "class=comments no eligible pair (best a-model/high weak)" "$(printf '%s\n' "$out" | grep '^class=comments')"
check "a strict class takes only a pair that never failed" "a-model/high|true" \
  "$(jq -r '.entries["contract-phase"]|"\(.pair)|\(.strict)"' "$TTAB")"
check "a strict class still marks the 9/10 pair equivalent, and not eligible" "true|false" \
  "$(rung contract-phase b-model/high '"\(.equivalent)|\(.eligible)"')"
check "a pair missing one task of the class is not covered and never the entry" "false|b-model-1/low" \
  "$(rung behaviour-phase c-model/medium '.covered')|$(jq -r '.entries["behaviour-phase"].pair' "$TTAB")"
check "a class measured on two tasks only has no covered pair" "class=search no eligible pair (no covered pair)" \
  "$(printf '%s\n' "$out" | grep '^class=search')"
check "a task's size leaves its test files out: two files, 40 lines is small" "small" \
  "$(ORCHESTRATOR_STATE_DIR="$TS" python3 -c 'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("r",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.task_sizes(json.load(open(sys.argv[2])))["t-a"])' "$ROUTING" "$TS/routing/projects/tasks/manifest.json")"
check "four files is large, and the entry takes the largest bucket and counts each" "large|1|4|0" \
  "$(jq -r '.entries["behaviour-phase"]|"\(.size)|\(.sizes.large)|\(.sizes.small)|\(.sizes.unknown)"' "$TTAB")"
sized() { # repo base merged: the size task_sizes gives a manifest of one task, a crash read as its traceback
  "$py" -c 'import importlib.util,sys; s=importlib.util.spec_from_file_location("r",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.task_sizes({"repo":sys.argv[2],"tasks":[{"id":"t","base":sys.argv[3],"merged":sys.argv[4]}]})["t"])' "$ROUTING" "$@" 2>&1 | tail -1; }
# A path that is not UTF-8 is a valid path for git. The file cannot be made on every file
# system, so its commit is built in the index.
NB="$WORK/nonutf8repo"; mkdir -p "$NB"; git -C "$NB" init -q
echo base > "$NB/README"; gc -C "$NB" add -A; gc -C "$NB" commit -qm base
NB0=$(git -C "$NB" rev-parse HEAD)
git -C "$NB" update-index --add --cacheinfo "100644,$(printf 'one\ntwo\n' | git -C "$NB" hash-object -w --stdin),$(printf 'bad\377name.txt')"
gc -C "$NB" commit -qm bad
check "a path that is not UTF-8 is sized, not a crash" "small" "$(sized "$NB" "$NB0" "$(git -C "$NB" rev-parse HEAD)")"
# A rename is one file whatever the user's configuration: three pure renames are three files and
# no line, where a configuration turning rename detection off reads them as six files and sixty lines.
NR="$WORK/renamerepo"; mkdir -p "$NR"; git -C "$NR" init -q; git -C "$NR" config diff.renames false
for f in a b c; do seq 10 > "$NR/$f.txt"; done
gc -C "$NR" add -A; gc -C "$NR" commit -qm base
NR0=$(git -C "$NR" rev-parse HEAD)
for f in a b c; do git -C "$NR" mv "$f.txt" "$f.moved"; done
gc -C "$NR" commit -qm moved
check "a rename counts as one file, whatever the configuration says about rename detection" "small" \
  "$(sized "$NR" "$NR0" "$(git -C "$NR" rev-parse HEAD)")"
# One rule, two callers: a task's bucket is the one size_bucket gives, not a comparison of its own.
check "a task is bucketed by size_bucket" "bucket-of-3-files" \
  "$("$py" -c 'import importlib.util,sys; s=importlib.util.spec_from_file_location("r",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.size_bucket=lambda files, lines: "bucket-of-%d-files" % files; print(m.task_sizes({"repo":sys.argv[2],"tasks":[{"id":"t","base":sys.argv[3],"merged":sys.argv[4]}]})["t"])' "$ROUTING" "$NR" "$NR0" "$(git -C "$NR" rev-parse HEAD)" 2>&1 | tail -1)"
check "the entry carries the selection it was made with, and no floor" "0.1|0.8|false|false" \
  "$(jq -r '.entries["behaviour-phase"]|"\(.delta)|\(.bar)|\(.strict)|\(has("floor"))"' "$TTAB")"
check "every rung carries the per-task figures, the median and its interval" "true" \
  "$(jq -r '[.entries[].ladder[]|has("per_task") and has("median_usd") and has("median_ci") and has("p_best") and has("covered")]|all' "$TTAB")"
check "the median interval holds the median" "true" \
  "$(rung behaviour-phase a-model/high '(.median_ci[0] <= .median_usd and .median_usd <= .median_ci[1])')"
check "p_best is shared among the covered pairs only" "1|null" \
  "$(jq -r '[.entries["review-collector"].ladder[].p_best]|add*1000|round/1000' "$TTAB")|$(rung behaviour-phase c-model/medium '.p_best')"
check "a notch measured and found not equivalent is no notch; a notch not covered is offered" "None|b-model/medium" \
  "$(ORCHESTRATOR_STATE_DIR="$TS" python3 -c 'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("r",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); e=json.load(open(sys.argv[2]))["entries"]; print("%s|%s" % (m.ladder_down("b-model/medium", e["review-collector"]), m.ladder_down("b-model-1/low", e["behaviour-phase"])))' "$ROUTING" "$TTAB")"
# The case the two above leave out: on a table written by this code, the rung under the pair is
# covered and equivalent to the best, so it is the notch an exploration may test.
check "a notch measured and found equivalent to the best is offered" "b-model/medium" \
  "$(ORCHESTRATOR_STATE_DIR="$TS" python3 -c 'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("r",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); e=json.load(open(sys.argv[2]))["entries"]["review-collector"]; print(m.ladder_down("a-model/high", e))' "$ROUTING" "$TTAB")"
cp "$TTAB" "$WORK/tasks.first.json"
rtc >/dev/null 2>&1
check "the same trials give the same table, byte for byte" "same" "$(cmp -s "$TTAB" "$WORK/tasks.first.json" && echo same || echo changed)"
# A pair's draws and its cost bootstrap come from a generator of its own, seeded by the class
# and the pair: a pair added to the class without being covered, or a trial of another class,
# moves no figure of the covered pairs. The extra pair sorts between a-model/high and
# b-model/medium, where a shared generator would have shifted every pair after it.
IS="$WORK/indepstate"
covered_figures() { jq -c '[.entries["review-collector"].ladder[]|select(.covered)|[.pair,.p_best,.equivalent,.median_ci]]' "$1"; }
with_extra_trial() { # the review-collector figures after one more trial line in the project's file
  rm -rf "$IS"; cp -R "$TS" "$IS"; printf '%s\n' "$1" >> "$IS/routing/projects/tasks/trials.jsonl"
  ORCHESTRATOR_STATE_DIR="$IS" python3 "$ROUTING" calibrate tasks >/dev/null 2>&1
  covered_figures "$IS/routing/tables/project-tasks.json"; }
check "a pair added without being covered moves no p_best, equivalence or interval of the covered pairs" \
  "$(covered_figures "$TTAB")" \
  "$(with_extra_trial '{"task":"t-a","class":"review-collector","pair":"a-model/low","rep":1,"models":{"a-model-1":0.05},"cost_usd":0.05,"status":"pass"}')"
check "a trial of another class moves no p_best, equivalence or interval either" \
  "$(covered_figures "$TTAB")" \
  "$(with_extra_trial '{"task":"t-a","class":"behaviour-phase","pair":"a-model/high","rep":1,"models":{"a-model-1":0.5},"cost_usd":0.5,"status":"fail"}')"
printf '{"selection":{"delta":0.2}}' > "$TS/routing/config.json"
check "the operator's config sets the selection: with delta 0.2, 8/10 is equivalent" "c-model/low|true|0.2" \
  "$(rtc 2>/dev/null >/dev/null; jq -r '.entries["review-collector"]|"\(.pair)|\(.ladder[]|select(.pair=="c-model/low")|.equivalent)|\(.delta)"' "$TTAB")"
# The selection is checked where it is read: a delta or a bar that is no number (a boolean is
# not one), not finite or outside [0, 1] is refused naming the key and the value, and the
# table on disk is left as it was.
cp "$TTAB" "$WORK/tasks.before-selection.json"
selection_refusal() { # config text: calibrate's exit status and its refusal
  printf '%s' "$1" > "$TS/routing/config.json"
  rtc >/dev/null 2>"$WORK/selection.err"; local code=$?
  echo "$code|$(grep -m1 '^ERROR' "$WORK/selection.err")"; }
check "a delta given as a string is refused" '1|ERROR: selection: delta must be a number from 0 to 1, got "0.1"' \
  "$(selection_refusal '{"selection":{"delta":"0.1"}}')"
check "a bar given as a boolean is refused" "1|ERROR: selection: bar must be a number from 0 to 1, got true" \
  "$(selection_refusal '{"selection":{"bar":true}}')"
check "a delta given as null is refused" "1|ERROR: selection: delta must be a number from 0 to 1, got null" \
  "$(selection_refusal '{"selection":{"delta":null}}')"
check "a delta that is not a number is refused" "1|ERROR: selection: delta must be a number from 0 to 1, got NaN" \
  "$(selection_refusal '{"selection":{"delta":NaN}}')"
check "a bar that is not finite is refused" "1|ERROR: selection: bar must be a number from 0 to 1, got Infinity" \
  "$(selection_refusal '{"selection":{"bar":Infinity}}')"
check "a delta below 0 is refused" "1|ERROR: selection: delta must be a number from 0 to 1, got -0.1" \
  "$(selection_refusal '{"selection":{"delta":-0.1}}')"
check "a bar above 1 is refused" "1|ERROR: selection: bar must be a number from 0 to 1, got 1.5" \
  "$(selection_refusal '{"selection":{"bar":1.5}}')"
check "the refusal leaves the table as it was" "same" "$(cmp -s "$TTAB" "$WORK/tasks.before-selection.json" && echo same || echo changed)"
check "the bounds 0 and 1 are numbers in range" "0|" "$(selection_refusal '{"selection":{"delta":0,"bar":1}}')"
rm "$TS/routing/config.json"
# A manifest whose repository is missing: every size unknown, one warning per task, the table written.
jq '.repo="/nonexistent/repo"' "$TS/routing/projects/tasks/manifest.json" > "$WORK/m.tmp" && mv "$WORK/m.tmp" "$TS/routing/projects/tasks/manifest.json"
rm -f "$TTAB"
rtc >/dev/null 2>"$WORK/tasks.err"
check "a repository that cannot be read sizes every task unknown, warns once per task, writes the table" "5|unknown|5" \
  "$(grep -c 'size of task .* cannot be read' "$WORK/tasks.err")|$(jq -r '.entries["behaviour-phase"].size' "$TTAB")|$(jq -r '.entries["behaviour-phase"].sizes.unknown' "$TTAB")"
check "show --detail prints one rung line per pair of the project's table, chosen on the entry" "3|1" \
  "$(ORCHESTRATOR_STATE_DIR="$TS" python3 "$ROUTING" show --detail tasks | sed -n '/^class=review-collector/,/^class=/p' | grep -c '^  rung ')|$(ORCHESTRATOR_STATE_DIR="$TS" python3 "$ROUTING" show --detail tasks | grep -cE '^  rung pair=b-model/medium tasks=5 pass_rate=0.9 p_best=[0-9.]+ median_usd=0.4 ci=0.4..0.4 expected_usd=0.5 off_model=0 equivalent chosen$')"
check "show without --detail prints no rung" "0" "$(ORCHESTRATOR_STATE_DIR="$TS" python3 "$ROUTING" show tasks | grep -c 'rung')"

# p_equiv: the share of paired draws the `equivalent` figure thresholds at 0.5, on a covered rung.
check "every covered rung carries p_equiv, equivalent exactly when it reaches 0.5; a rung not covered carries null" "0|true" \
  "$(jq -r '[.entries[].ladder[]|select((if .covered then ((.p_equiv|type)=="number" and ((.p_equiv>=0.5)==.equivalent)) else (has("p_equiv") and .p_equiv==null) end)|not)]|length' "$TTAB")|$(jq -r '[.entries[].ladder[]|select(.covered)]|length>0' "$TTAB")"
check "the best pair is equivalent to itself in every draw" "true" "$(rung behaviour-phase a-model/high '.p_equiv==1')"
PQ='{"x-model/low": {"n": 10, "passes": 0, "costs": [0.1], "models": set(), "per_task": {"t1": [0, 4], "t2": [0, 3], "t3": [0, 3]}, "off_model": 0}, "y-model/high": {"n": 10, "passes": 10, "costs": [0.5], "models": set(), "per_task": {"t1": [4, 4], "t2": [3, 3], "t3": [3, 3]}, "off_model": 0}}'
check "a pair at 0 of 10 against a best at 10 of 10 is equivalent in next to no draw, p_equiv rounded to 4 places" "True|True|1.0" \
  "$(rcall '(lambda r: "|".join(str(x) for x in (r[0]["p_equiv"] < 0.01, round(r[0]["p_equiv"], 4) == r[0]["p_equiv"], r[1]["p_equiv"])))(sorted(m.compare("c", '"$PQ"', 0.1)[0], key=lambda r: r["pair"]))')"
cp -R "$TS" "$WORK/nopeq"
jq 'del(.entries[].ladder[].p_equiv)' "$TTAB" > "$WORK/nopeq/routing/tables/project-tasks.json"
check "a table written without p_equiv still reads in show, output unchanged" "$(ORCHESTRATOR_STATE_DIR="$TS" python3 "$ROUTING" show --detail tasks 2>&1)" \
  "$(ORCHESTRATOR_STATE_DIR="$WORK/nopeq" python3 "$ROUTING" show --detail tasks 2>&1)"

# One model, one pair. A pair that names the identifier an alias resolved to counts under the
# alias: canonical_pair folds the name, stats_of reads each trial through it, and an older
# release of the family is another model and stays apart.
check "canonical_pair: the identifier's pair becomes the alias's, the alias's pair stays, an alias that maps to itself yields to the other alias" "b/low|b/low|b/low" \
  "$(rcall 'm.canonical_pair("b-model-1/low", {"b": "b-model-1"})')|$(rcall 'm.canonical_pair("b/low", {"b": "b-model-1"})')|$(rcall 'm.canonical_pair("b-model-1/low", {"b-model-1": "b-model-1", "b": "b-model-1"})')"
check "canonical_pair: an older release is another model, a pair no alias names is unchanged" "b-model-0/low|c-model-1/high" \
  "$(rcall 'm.canonical_pair("b-model-0/low", {"b": "b-model-1"})')|$(rcall 'm.canonical_pair("c-model-1/high", {"b": "b-model-1"})')"
check "canonical_pair: two aliases on one identifier, the first in name order, whatever order the file lists them in" "a/low|b/low" \
  "$(rcall 'm.canonical_pair("b-model-1/low", {"z": "b-model-1", "a": "b-model-1", "m": "b-model-1"})')|$(rcall 'm.canonical_pair("b-model-1/low", {"m": "b-model-1", "b": "b-model-1"})')"
check "canonical_pair: the effort is kept whatever it is, and no aliases leaves the pair as it is" "b/max|b-model-1/low" \
  "$(rcall 'm.canonical_pair("b-model-1/max", {"b": "b-model-1"})')|$(rcall 'm.canonical_pair("b-model-1/low", {})')"
AS="$WORK/aliasstate"; mkdir -p "$AS/routing/projects/alias"
AT="$AS/routing/projects/alias/trials.jsonl"; : > "$AT"
ATAB="$AS/routing/tables/project-alias.json"
printf '{"slug":"alias","repo":"/nonexistent","profile":"x/y","tasks":[]}' > "$AS/routing/projects/alias/manifest.json"
printf '{"b":"b-model-1"}' > "$AS/routing/aliases.json"
at() { # task pair status cost main-model
  printf '{"task":"%s","class":"behaviour-phase","pair":"%s","rep":1,"models":{"%s":%s},"cost_usd":%s,"status":"%s"}\n' \
    "$1" "$2" "$5" "$4" "$4" "$3" >> "$AT"; }
for t in t1 t2 t3; do
  at "$t" b/medium pass 0.10 b-model-1; at "$t" b-model-1/medium pass 0.10 b-model-1
  at "$t" b-model-0/medium pass 0.20 b-model-0
done
# One trial of the identifier's pair spent its money on another family: off-model, whatever name its pair has.
at t1 b-model-1/medium pass 0.90 c-model-1
ORCHESTRATOR_STATE_DIR="$AS" python3 "$ROUTING" calibrate alias >/dev/null 2>&1
check "trials under the alias and under the identifier it resolves to are one rung, n the sum; the older release keeps its own" "b/medium,b-model-0/medium" \
  "$(jq -r '[.entries["behaviour-phase"].ladder[].pair]|join(",")' "$ATAB")"
check "the folded rung weighs both names' trials: n, tasks and the per-task cells add up" "6|3|[2,2]" \
  "$(jq -r '.entries["behaviour-phase"].ladder[]|select(.pair=="b/medium")|"\(.n)|\(.tasks)|\(.per_task.t1|tostring)"' "$ATAB")"
check "an off-model trial under the identifier's pair is still counted in off_model, under the folded rung, and not in n" "1|6|0.1" \
  "$(jq -r '.entries["behaviour-phase"].ladder[]|select(.pair=="b/medium")|"\(.off_model)|\(.n)|\(.cost_usd)"' "$ATAB")"
check "the older release is a rung of three trials of its own" "3|0" \
  "$(jq -r '.entries["behaviour-phase"].ladder[]|select(.pair=="b-model-0/medium")|"\(.n)|\(.off_model)"' "$ATAB")"
check "generalize folds the same way: the pooled rung is the alias's and holds all six trials" "b/medium,b-model-0/medium|6" \
  "$(ORCHESTRATOR_STATE_DIR="$AS" python3 "$ROUTING" generalize >/dev/null 2>&1; jq -r '[.entries["behaviour-phase"].ladder[].pair]|join(",")' "$AS/routing/tables/global.json")|$(jq -r '.entries["behaviour-phase"].ladder[]|select(.pair=="b/medium")|.n' "$AS/routing/tables/global.json")"
check "without an aliases file nothing folds: the identifier's pair is a rung of its own" "b-model-0/medium,b-model-1/medium,b/medium" \
  "$(rm "$AS/routing/aliases.json"; ORCHESTRATOR_STATE_DIR="$AS" python3 "$ROUTING" calibrate alias >/dev/null 2>&1; jq -r '[.entries["behaviour-phase"].ladder[].pair]|sort|join(",")' "$ATAB")"
# note_alias records an alias only for an identifier that carries it.
NS="$WORK/notestate"; mkdir -p "$NS/routing"
rnote() { # alias, models as JSON: what aliases.json holds after the call, "none" when there is no file, "failed:<status>" when the call itself dies
  local status
  ORCHESTRATOR_STATE_DIR="$NS" "$py" -c 'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("r",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.note_alias(sys.argv[2], json.loads(sys.argv[3]))' "$ROUTING" "$1" "$2" 2>/dev/null
  status=$?
  if [ "$status" -ne 0 ]; then echo "failed:$status"; return; fi
  if [ -f "$NS/routing/aliases.json" ]; then jq -c . "$NS/routing/aliases.json"; else echo none; fi; }
check "note_alias: no identifier carries the alias, nothing is written" "none" "$(rnote b '{"c-model-1": 2.0}')"
printf '{"b":"b-model-1"}' > "$NS/routing/aliases.json"
check "and a recorded alias is left as it was" '{"b":"b-model-1"}' "$(rnote b '{"c-model-1": 2.0}')"
rm "$NS/routing/aliases.json"
check "note_alias: the identifier that carries the alias is written, though another model cost more" '{"b":"b-model-1"}' \
  "$(rnote b '{"b-model-1": 1.0, "c-model-1": 2.0}')"

echo "== routing: bench =="

# A project whose merged change makes hello.sh greet, with a test the merge added.
make_bench_repo() {
  local d="$1"; mkdir -p "$d/tests"
  git -C "$d" init -q
  printf '#!/bin/bash\necho hi\n' > "$d/hello.sh"
  printf '#!/bin/bash\n[ "$(bash hello.sh)" = "hi" ]\n' > "$d/tests/old.sh"
  # Two tracked files an ignore rule matches: one by the repository's own rule, one by a
  # global excludes file the trial test names. Both were added with --force.
  printf '*.keepme\n' > "$d/.gitignore"
  echo repo > "$d/by-repo.keepme"; echo glob > "$d/by-global.globalignored"
  git -C "$d" add -A; git -C "$d" add -f by-repo.keepme by-global.globalignored
  git -C "$d" -c user.name=t -c user.email=t@t commit -qm base
  printf '#!/bin/bash\necho hello world\n' > "$d/hello.sh"
  printf '#!/bin/bash\n[ "$(bash hello.sh)" = "hello world" ] || { echo "FAIL greet: expected hello world"; exit 1; }\n' > "$d/tests/greet.sh"
  rm "$d/tests/old.sh"
  git -C "$d" add -A; git -C "$d" -c user.name=t -c user.email=t@t commit -qm merged
}
BR="$WORK/benchrepo"; make_bench_repo "$BR"
BASE=$(git -C "$BR" rev-parse HEAD~1); MERGED=$(git -C "$BR" rev-parse HEAD)
BS="$WORK/bstate"; mkdir -p "$BS"
rbench() { ORCHESTRATOR_STATE_DIR="$BS" ORCHESTRATOR_GH="$ROOT/tests/fixtures/routing/gh-stub.sh" STUB_MERGE="$MERGED" python3 "$ROUTING" "$@"; }
check "harvest drafts a task from a merged pull request" "harvested pr-7 (draft)" \
  "$(rbench harvest "$BR" --class behaviour-phase --pr 7 --test-command 'for t in tests/*.sh; do bash "$t" || exit 1; done' --test-glob 'tests/*')"
BM="$BS/routing/projects/benchrepo/manifest.json"
check "the task carries base and merge" "$BASE|$MERGED|draft|behaviour-phase" \
  "$(jq -r '.tasks[0]|[.base,.merged,.status,.class]|join("|")' "$BM")"
check "the brief keeps the description and drops fenced code" "0|1" \
  "$(grep -c secret "$BS/routing/projects/benchrepo/briefs/pr-7.md")|$(grep -c 'Make hello print a greeting.' "$BS/routing/projects/benchrepo/briefs/pr-7.md")"
check "harvesting the same pull request twice keeps one task" "1" \
  "$(rbench harvest "$BR" --class behaviour-phase --pr 7 >/dev/null; jq '.tasks|length' "$BM")"
rbench ready benchrepo pr-7 >/dev/null
check "ready marks the task" "ready" "$(jq -r '.tasks[0].status' "$BM")"
check_status "ready refuses an unknown task" 1 rbench ready benchrepo pr-99
check "a forge that does not answer stops harvest, naming the pull request" "1" \
  "$(ORCHESTRATOR_STATE_DIR="$BS" ORCHESTRATOR_GH=false python3 "$ROUTING" harvest "$BR" --class behaviour-phase --pr 12 2>&1 | grep -c 'pull request 12')"
# One pull request whose merge commit the clone lacks costs no task harvested around it.
HS="$WORK/hstate"
hout=$(ORCHESTRATOR_STATE_DIR="$HS" ORCHESTRATOR_GH="$ROOT/tests/fixtures/routing/gh-stub.sh" STUB_MERGE="$MERGED" STUB_MISSING_PR=22 \
  python3 "$ROUTING" harvest "$BR" --class behaviour-phase --pr 21 --pr 22 --pr 23 2>&1; echo "exit=$?")
check "a pull request with no merge commit is skipped and named, the others written, the run fails" "pr-21,pr-23|1|1|exit=1" \
  "$(jq -r '[.tasks[].id]|join(",")' "$HS/routing/projects/benchrepo/manifest.json")|$(printf '%s\n' "$hout" | grep -c 'pull request 22 is not in .*skipped')|$(printf '%s\n' "$hout" | grep -c '^ERROR: harvest: 1 pull request(s) skipped: 22$')|$(printf '%s\n' "$hout" | tail -1)"

chmod +x "$ROOT/tests/fixtures/routing/host-stub.sh"
printf '{"deep":"a-model","standard":"b-model","light":"c-model"}' > "$BS/models.json"
rtrial() { ORCHESTRATOR_STATE_DIR="$BS" ORCHESTRATOR_HOST_CLI="$ROOT/tests/fixtures/routing/host-stub.sh" STUB_MERGED="$MERGED" TMPDIR="$WORK" python3 "$ROUTING" trial benchrepo pr-7 "$@"; }
BT="$BS/routing/projects/benchrepo/trials.jsonl"
jq '.budget_usd=1.25' "$BM" > "$WORK/bm.tmp" && mv "$WORK/bm.tmp" "$BM"
rtrial b-model/medium --keep >/dev/null
last() { tail -1 "$BT" | jq -r "$1"; }
check "a right change passes the hidden tests and the judge" "pass|pass|pass|0.1|0.02" \
  "$(last '[.mech,.judge,.status,.cost_usd,.judge_cost_usd]|map(tostring)|join("|")')"
KEPT=$(last '.dir')
check "a passing trial has no tests_tail and no judge_raw" "false|false" "$(last '[has("tests_tail"),has("judge_raw")]|map(tostring)|join("|")')"
check "the judge's scores and reasons are on the trial line" "5|0" "$(last '"\(.judge_scores.scope)|\(.judge_reasons|length)"')"
check "the trial tree starts at the base" "echo hi" "$(sed -n 2p "$KEPT/.start-hello")"
check "the per-trial ceiling reaches the host" "1.25" "$(cat "$KEPT/.budget-ceiling")"
check "the agent saw one commit and no history" "1|no" "$(cat "$KEPT/.reachable-commits")|$(cat "$KEPT/.merged-reachable")"
check "the hidden test is in place, the deleted one is gone" "yes|no" \
  "$([ -f "$KEPT/tests/greet.sh" ] && echo yes || echo no)|$([ -f "$KEPT/tests/old.sh" ] && echo yes || echo no)"
check "an alias with no mode configured runs in auto" "auto" "$(cat "$KEPT/.permission-mode")"
ARGSLOG="$WORK/host-args.log"; rm -f "$ARGSLOG"
STUB_ARGS_LOG="$ARGSLOG" rtrial b-model/medium >/dev/null
check "a trial's agent run and its judge run load the project's settings only" "agent sources=project|judge sources=project" \
  "$(paste -sd'|' "$ARGSLOG")"
rtrial b-model/low >/dev/null
check "a wrong change fails mechanically and is never judged" "fail|null|fail|0" \
  "$(last '[.mech,.judge,.status,.judge_cost_usd]|map(tostring)|join("|")')"
check "a failed mechanical check records the tail of the test output" "FAIL greet: expected hello world" "$(last '.tests_tail' | tr -d '\n')"
TC=$(jq -r '.test_command' "$BM")
set_tests() { jq --arg c "$1" '.test_command=$c' "$BM" > "$WORK/bm.tmp" && mv "$WORK/bm.tmp" "$BM"; }
set_tests "($TC); for i in \$(seq 1 120); do echo \"ok padding line \$i of passing output\"; done; exit 1"
rtrial b-model/low >/dev/null
check "the failing line survives output long enough to push it out of the tail" "FAIL greet: expected hello world|false" \
  "$(last '"\(.tests_failed|join("|"))|\(.tests_tail|contains("FAIL"))"')"
set_tests "for i in \$(seq 1 50); do echo \"FAIL case \$i\"; done; echo 'a FAILURE of nothing'; echo 'ERROR late'; exit 1"
rtrial b-model/low >/dev/null
check "tests_failed keeps at most 40 lines, in order" "40|FAIL case 1|FAIL case 40" "$(last '"\(.tests_failed|length)|\(.tests_failed[0])|\(.tests_failed[-1])"')"
set_tests "echo 'no failure here'; echo 'a FAILURE of nothing'; printf 'FAILED %0400d\\n' 0; echo 'ERROR late' >&2; exit 1"
rtrial b-model/low >/dev/null
check "tests_failed matches whole words only, cuts at 300 characters, reads stderr after stdout" "2|300|ERROR late" \
  "$(last '"\(.tests_failed|length)|\(.tests_failed[0]|length)|\(.tests_failed[1])"')"
set_tests "echo all good; exit 1"
rtrial b-model/low >/dev/null
check "a failure with no matching line records an empty list" "[]" "$(last '.tests_failed|tostring')"
set_tests "$TC"
check "a passing trial has no tests_failed" "false" "$(jq -s '[.[]|select(.mech=="pass")][0]|has("tests_failed")' "$BT")"
STUB_JUDGE=fail rtrial b-model/high >/dev/null
check "a judge's fail is the trial's fail" "pass|fail|fail" "$(last '[.mech,.judge,.status]|join("|")')"
STUB_JUDGE=garbage rtrial b-model/high >/dev/null
check "a judge that does not answer JSON makes an error, cost kept" "error|0.1" "$(last '[.status,.cost_usd]|map(tostring)|join("|")')"
check "and records no scores and no reasons" "null|null" "$(last '[.judge_scores,.judge_reasons]|map(tostring)|join("|")')"
check "an unreadable answer is kept in judge_raw, with the host's success" "not json at all|true" "$(last '"\(.judge_raw)|\(.judge_ok)"')"
STUB_JUDGE=prose rtrial b-model/high >/dev/null
check "a judge answering prose with no object is an error holding that prose" "error|null|The change looks fine to me, no object here." \
  "$(last '[.status,.judge,.judge_raw]|map(tostring)|join("|")')"
STUB_JUDGE=fenced rtrial b-model/high >/dev/null
check "a judge answering inside a code fence yields its verdict and scores" "pass|4|null" "$(last '"\(.judge)|\(.judge_scores.scope)|\(.judge_raw)"')"
STUB_JUDGE=lead rtrial b-model/high >/dev/null
check "a judge with a line of prose before its object yields its verdict and scores" "pass|3|pass" "$(last '"\(.judge)|\(.judge_scores.scope)|\(.status)"')"
rtrial b-model/max >/dev/null
check "an agent stopped by its cap is an error with its cost" "error|0.4" "$(last '[.status,.cost_usd]|map(tostring)|join("|")')"
check "the trial records the identifiers used and the alias they resolve" "b-model-1|b-model-1" \
  "$(last '.models|keys|join(",")')|$(jq -r '.["b-model"]' "$BS/routing/aliases.json")"
# The alias can lag behind the family's latest release: each trial names the identifier it
# ran on, and a release older than one the host reported or the map names is flagged.
check "a trial records the identifier its alias ran on" "b-model-1" "$(last '.model')"
STUB_RELEASE=2 rtrial b-model/medium >/dev/null 2>"$WORK/release.err"
check "a trial on the newest release the host reported warns nothing" "b-model-2|0" \
  "$(last '.model')|$(grep -c 'older release' "$WORK/release.err")"
rtrial b-model/medium >/dev/null 2>"$WORK/release.err"
check "a trial on an older release than the host reported says so" "1" \
  "$(grep -c '^WARNING: trial: b-model resolved to b-model-1, an older release than b-model-2 (reported by the host)' "$WORK/release.err")"
printf '{"deep":"a-model","standard":"b-model-3","light":"c-model"}' > "$BS/models.json"
STUB_RELEASE=2 rtrial b-model/medium >/dev/null 2>"$WORK/release.err"
check "a trial on an older release than the map names says so" "1" \
  "$(grep -c '^WARNING: trial: b-model resolved to b-model-2, an older release than b-model-3 (named by the map)' "$WORK/release.err")"
printf '{"deep":"a-model","standard":"b-model","light":"c-model"}' > "$BS/models.json"
: > "$BT"; rtrial b-model/medium >/dev/null
check "trial directories are removed unless kept" "1" "$(ls -d "$WORK"/trial-* 2>/dev/null | wc -l | tr -d ' ')"
rm -rf "$KEPT"
ORCHESTRATOR_HOST_CLI="$WORK/no-such-host" ORCHESTRATOR_STATE_DIR="$BS" TMPDIR="$WORK" python3 "$ROUTING" trial benchrepo pr-7 b-model/medium >/dev/null 2>&1
check "a host that cannot start is an error, never a crash, never free, and leaves no directory" "error|1.25|true|0" \
  "$(last '[.status,.cost_usd,.cost_incomplete]|map(tostring)|join("|")')|$(ls -d "$WORK"/trial-* 2>/dev/null | wc -l | tr -d ' ')"
printf '{"modes":{"b-model":"acceptEdits"}}' > "$BS/routing/config.json"
rtrial b-model/medium --keep >/dev/null
check "config.json gives an alias its permission mode" "acceptEdits" "$(cat "$(last '.dir')/.permission-mode")"
rm -rf "$(last '.dir')" "$BS/routing/config.json"
# The base commit holds every archived file, whatever ignore rules apply.
printf '*.globalignored\n' > "$WORK/global-excludes"
printf '[core]\n\texcludesFile = %s\n' "$WORK/global-excludes" > "$WORK/global-gitconfig"
GIT_CONFIG_GLOBAL="$WORK/global-gitconfig" rtrial b-model/medium --keep >/dev/null
check "a file an ignore rule matches is still in the trial's base commit" "by-global.globalignored|by-repo.keepme" \
  "$(git -C "$(last '.dir')" ls-files | grep -E 'by-(repo|global)' | sort | paste -sd'|' -)"
rm -rf "$(last '.dir')"
printf '{"standard":"b-model","light":"c-model"}' > "$BS/models.json"
check "no judge without a deep tier, refused before any trial runs" "ERROR: trial: the deep tier is unbound: the judge has no model|0" \
  "$(rtrial b-model/medium 2>&1)|$(ls -d "$WORK"/trial-* 2>/dev/null | wc -l | tr -d ' ')"
printf '{"deep":"a-model","standard":"b-model","light":"c-model"}' > "$BS/models.json"
# A torn last line never swallows the next trial.
: > "$BT"
printf '{"task":"a","class":"behaviour-phase","pair":"b-model/medium","cost_usd":0.1,"status":"pass"}\n{"task":"b","class":"behaviour-phase","pair":"b-model/medium","cost_usd":0.1,"status":"pass"}\n{"task":"c","class":"beha' > "$BT"
rtrial b-model/medium >/dev/null
check "a torn last line is closed before the next trial: the two before it and the new one read" "3" \
  "$(ORCHESTRATOR_STATE_DIR="$BS" python3 -c 'import importlib.util,sys; s=importlib.util.spec_from_file_location("r",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(len(m.read_trials(sys.argv[2])))' "$ROUTING" "$BT" 2>/dev/null)"
# An agent that commits its work still leaves the judge a diff to read.
STUB_COMMIT=1 rtrial b-model/medium >/dev/null
check "the agent's diff is taken against its base, so a committing agent is not judged on nothing" "pass|0" \
  "$(last '"\(.judge)|\(.judge_reasons|length)"')"
# The overlay never writes through a link the agent planted.
OUT="$WORK/outside"; mkdir -p "$OUT"; echo keep > "$OUT/old.sh"; echo keep > "$OUT/other.txt"
before=$(cd "$OUT" && ls -R && cat old.sh other.txt)
STUB_SYMLINK_OUT="$OUT" rtrial b-model/medium >/dev/null 2>"$WORK/link.err"
check "the overlay writes and deletes nothing outside the trial" "$before" "$(cd "$OUT" && ls -R && cat old.sh other.txt)"
check "and says it skipped" "1" "$(grep -c 'overlay skipped tests/' "$WORK/link.err" | tr -d ' ' | sed 's/^[2-9]/1/')"
# A timeout kills the group, not only the child.
ORCHESTRATOR_TRIAL_TIMEOUT=1 STUB_GRANDCHILD=1 rtrial b-model/medium >/dev/null 2>&1
# The kill is a signal: give the group a moment to be reaped before counting survivors.
for _ in 1 2 3 4 5 6 7 8 9 10; do ps -axo command | grep -q '[s]leep 31337' || break; sleep 0.3; done
check "a timeout is an error, leaves no process of the agent and no directory" "error|0|0" \
  "$(last .status)|$(ps -axo command | grep -c '[s]leep 31337')|$(ls -d "$WORK"/trial-* 2>/dev/null | wc -l | tr -d ' ')"
pkill -f 'sleep 31337' 2>/dev/null || true
rbench harvest "$BR" --class behaviour-phase --pr 8 >/dev/null
check "a draft task is refused" "ERROR: trial: task pr-8 is still a draft" \
  "$(env ORCHESTRATOR_STATE_DIR="$BS" python3 "$ROUTING" trial benchrepo pr-8 b-model/medium 2>&1)"
check_status "an unknown task is refused" 1 env ORCHESTRATOR_STATE_DIR="$BS" python3 "$ROUTING" trial benchrepo pr-404 b-model/medium
check "the rubric opens on the marker the judge's prompt is known by" "JUDGE-RUBRIC" \
  "$(head -1 "$ROOT/skills/model-routing/references/judge-rubric.md")"

rbench harvest "$BR" --class behaviour-phase --pr 9 >/dev/null; rbench ready benchrepo pr-7 pr-8 pr-9 >/dev/null
: > "$BT"
rb() { ORCHESTRATOR_STATE_DIR="$BS" ORCHESTRATOR_HOST_CLI="$ROOT/tests/fixtures/routing/host-stub.sh" TMPDIR="$WORK" python3 "$ROUTING" bench benchrepo "$@"; }
check_status "bench wants a cap" 2 rb --grid b-model/medium

# The two stages of the paired bench. stage_split cuts a class's tasks, in manifest order, after
# the first half rounded up; prune reads stage A: a pair with no pass, or that another pair
# matches on cost and on every task it passed and beats on one of the two, stops.
check "stage A is the first half of the tasks rounded up, stage B the rest: 4, 5, 1 and 0 tasks" "2+2|3+2|1+0|0+0" \
  "$(rcall '"|".join("+".join(str(len(x)) for x in m.stage_split(list(w))) for w in ("abcd", "abcde", "a", ""))')"
check "and the tasks keep their order, stage A ahead of stage B" "['t1', 't2', 't3']|['t4', 't5']" \
  "$(rcall '"|".join(str(x) for x in m.stage_split(["t1", "t2", "t3", "t4", "t5"]))')"
rprune() { # pairs, then rows (task, pair, status, cost[, 1 for a cost not read]) of stage A (t1, t2): "survivors/pruned"
  rcall "(lambda r: '%s/%s' % (','.join(r[0]), ','.join(r[1])))(m.prune($1, {(t, p): dict(status=s, cost_usd=c, cost_incomplete=bool(i)) for t, p, s, c, *i in $2}, ['t1', 't2']))"; }
check "prune: a pair another pair undercuts on the same passed tasks is pruned" "y/x" \
  "$(rprune "['x', 'y']" "[('t1','x','pass',.2),('t2','x','pass',.2),('t1','y','pass',.1),('t2','y','pass',.1)]")"
check "prune: a cheaper pair that missed a task the other passed leaves both standing" "x,y/" \
  "$(rprune "['x', 'y']" "[('t1','x','pass',.2),('t2','x','pass',.2),('t1','y','pass',.1),('t2','y','fail',.1)]")"
check "prune: equal cost and equal passes, neither is better, both survive" "x,y/" \
  "$(rprune "['x', 'y']" "[('t1','x','pass',.1),('t2','x','pass',.1),('t1','y','pass',.1),('t2','y','pass',.1)]")"
check "prune: at equal cost, one more task passed is better" "y/x" \
  "$(rprune "['x', 'y']" "[('t1','x','pass',.1),('t2','x','fail',.1),('t1','y','pass',.1),('t2','y','pass',.1)]")"
check "prune: a pair with no pass on stage A is pruned, an errored pair too" "z/x,y" \
  "$(rprune "['x', 'y', 'z']" "[('t1','x','fail',.01),('t2','x','fail',.01),('t1','y','error',.01),('t2','y','error',.01),('t1','z','pass',.5),('t2','z','pass',.5)]")"
check "prune: an error is paid for, it counts in the mean cost" "y/x" \
  "$(rprune "['x', 'y']" "[('t1','x','pass',.1),('t2','x','error',.4),('t1','y','pass',.2),('t2','y','pass',.2)]")"
check "prune: a dropped pair, left out of the pairs, is in neither list and dominates nobody" "x/" \
  "$(rprune "['x']" "[('t1','x','pass',.2),('t2','x','pass',.2),('t1','y','pass',.01),('t2','y','pass',.01)]")"
check "prune: the pruned come cheapest first, then by name" "d/c,a,b" \
  "$(rprune "['a', 'b', 'c', 'd']" "[('t1','a','pass',.2),('t2','a','pass',.2),('t1','b','pass',.2),('t2','b','pass',.2),('t1','c','pass',.1),('t2','c','pass',.1),('t1','d','pass',.05),('t2','d','pass',.05)]")"
check "prune: a pair whose cost is unreadable is neither beaten nor beating on cost" "x,y/" \
  "$(rprune "['x', 'y']" "[('t1','x','pass',1.25,1),('t2','x','pass',1.25,1),('t1','y','pass',.1),('t2','y','pass',.1)]")"
out=$(rb --grid b-model/low,b-model/medium,c-model/medium --max-usd 100 --reps 2 --concurrency 1)
check "stage A runs every pair of the grid once on the first half of the tasks, rounded up: two of three" "6" "$(jq -s '[.[]|select(.rep==1)]|map(.task+.pair)|unique|map(select(startswith("pr-7") or startswith("pr-8")))|length' "$BT")"
check "a pair with no pass on stage A is pruned: it never runs stage B, and the last line counts it" "0|1" \
  "$(jq -s '[.[]|select(.pair=="b-model/low" and .task=="pr-9")]|length' "$BT")|$(printf '%s\n' "$out" | tail -1 | grep -c ' pruned=1$')"
check "every surviving pair runs stage B: graded on all three tasks" "3|3" \
  "$(jq -s '[.[]|select(.pair=="b-model/medium")]|map(.task)|unique|length' "$BT")|$(jq -s '[.[]|select(.pair=="c-model/medium")]|map(.task)|unique|length' "$BT")"
check "the best pair runs every task at every rep" "6|3" \
  "$(jq -s '[.[]|select(.pair=="b-model/medium")]|length' "$BT")|$(jq -s '[.[]|select(.pair=="b-model/medium")]|map(.task)|unique|length' "$BT")"
check "the last line counts what the three stages and the second repetition spent, and the pair pruned" "bench: spent=1.64 trials=14 unmeasured=0 pruned=1" "$(printf '%s\n' "$out" | tail -1)"
check "a run leaves no trial directory behind" "0" "$(ls -d "$WORK"/trial-* 2>/dev/null | wc -l | tr -d ' ')"
before=$(wc -l < "$BT" | tr -d ' ')
rb --grid b-model/low,b-model/medium,c-model/medium --max-usd 100 --reps 2 --concurrency 1 >/dev/null
check "a restart re-pays nothing already measured" "$before" "$(wc -l < "$BT" | tr -d ' ')"
# The cheapest family does stage A and then fades: it is the only survivor, it misses on stage B and
# the class is weak. The pruned pairs re-enter cheapest first and the first entry stops them: the
# dearest is never run past stage A. Against a best that weak, the pair that failed everything is
# half-way equivalent, so its own second repetition runs (6 trials, not 3).
: > "$BT"; FADE="$WORK/fade"; rm -rf "$FADE"; mkdir -p "$FADE"
out=$(STUB_COSTS="c-model=0.05,a-model=0.30" STUB_FADE="c-model:2:$FADE" \
  rb --grid c-model/medium,b-model/medium,a-model/medium,b-model/low --max-usd 100 --reps 2 --concurrency 1 2>/dev/null)
check "a survivor that misses on stage B hands the class to the pruned pairs, cheapest first, and the first entry stops it" \
  "a-model/medium=2|b-model/low=6|b-model/medium=6|c-model/medium=6" \
  "$(jq -rs 'group_by(.pair)|map("\(.[0].pair)=\(length)")|join("|")' "$BT")"
check "the pair re-admitted last meets the bar on every task" "6/6" \
  "$(jq -rs '[.[]|select(.pair=="b-model/medium")]|"\(map(select(.status=="pass"))|length)/\(length)"' "$BT")"
check "and the last line counts only the pair never re-admitted" "bench: spent=2.30 trials=20 unmeasured=0 pruned=1" "$(printf '%s\n' "$out" | tail -1)"
# Four tasks, so that stage A (the first two) and stage B (the last two) are told apart.
mkdir -p "$BS/routing/projects/bench4"; cp -R "$BS/routing/projects/benchrepo/briefs" "$BS/routing/projects/bench4/"
jq '.slug="bench4" | .tasks += [.tasks[2] | .id="pr-10" | .pr=10]' "$BM" > "$BS/routing/projects/bench4/manifest.json"
B4T="$BS/routing/projects/bench4/trials.jsonl"
rb4() { ORCHESTRATOR_STATE_DIR="$BS" ORCHESTRATOR_HOST_CLI="$ROOT/tests/fixtures/routing/host-stub.sh" TMPDIR="$WORK" python3 "$ROUTING" bench bench4 "$@"; }
tasks_of() { jq -rs --arg p "$1" '[.[]|select(.pair==$p)]|map(.task)|unique|length' "$B4T"; }
reps_of() { jq -rs --arg r "$1" '[.[]|select(.rep==($r|tonumber))]|group_by(.pair)|map("\(.[0].pair)=\(length)")|join("|")' "$B4T"; }
last_line() { printf '%s\n' "$1" | tail -1; }
# A pair another pair undercuts while passing the same stage-A tasks stops after stage A.
: > "$B4T"
out=$(STUB_COSTS="c-model=0.05" rb4 --grid c-model/medium,b-model/medium --max-usd 100 --reps 1 --concurrency 1 2>/dev/null)
check "a pair dominated on stage A runs two tasks only, the dominating pair all four, and the last line counts the pruned" "4|2|bench: spent=0.52 trials=6 unmeasured=0 pruned=1" \
  "$(tasks_of c-model/medium)|$(tasks_of b-model/medium)|$(last_line "$out")"
# The second repetition goes to the best pair and to the pairs between a third and seven tenths
# likely to be equivalent to it, on every task. The family fades after its fifth run: c-model/medium
# ends at 3 of 4 (about 0.39), c-model/high at 2 of 4 (about 0.16), b-model/medium at 4 of 4.
: > "$B4T"; rm -rf "$FADE"; mkdir -p "$FADE"
out=$(STUB_FADE="c-model:5:$FADE" rb4 --grid c-model/medium,c-model/high,b-model/medium --max-usd 100 --reps 2 --concurrency 1 2>/dev/null)
check "every survivor is graded on all four tasks" "4|4|4" "$(tasks_of c-model/medium)|$(tasks_of c-model/high)|$(tasks_of b-model/medium)"
check "only the best pair and the pair between 0.3 and 0.7 have a second repetition, on every task" "b-model/medium=4|c-model/medium=4" "$(reps_of 2)"
check "and the last line counts every trial of the run" "bench: spent=2.26 trials=20 unmeasured=0 pruned=0" "$(last_line "$out")"
: > "$B4T"; rm -rf "$FADE"; mkdir -p "$FADE"
out=$(STUB_FADE="c-model:5:$FADE" rb4 --grid c-model/medium,c-model/high,b-model/medium --max-usd 100 --reps 1 --concurrency 1 2>/dev/null)
check "--reps 1 runs no second repetition" "|bench: spent=1.38 trials=12 unmeasured=0 pruned=0" "$(reps_of 2)|$(last_line "$out")"
# The band has an upper edge: a pair above seven tenths is as good as the best already. Two pairs
# that pass every task at one price are such a pair, the one named first being the best.
: > "$B4T"
rb4 --grid b-model/medium,c-model/medium --max-usd 100 --reps 1 --concurrency 1 >/dev/null 2>&1
ORCHESTRATOR_STATE_DIR="$BS" python3 "$ROUTING" calibrate bench4 >/dev/null 2>&1
check "the pair behind the best is equivalent to it in more than seven tenths of the draws" "b-model/medium|true" \
  "$(jq -r '.entries[].ladder|map(select(.p_equiv==1).pair)[0] + "|" + (map(select(.pair=="c-model/medium").p_equiv>0.7)[0]|tostring)' "$BS/routing/tables/project-bench4.json")"
rb4 --grid b-model/medium,c-model/medium --max-usd 100 --reps 2 --concurrency 1 >/dev/null 2>&1
check "so it gets no second repetition, and the best does, on every task" "b-model/medium=4" "$(reps_of 2)"
# Re-admission: the survivor is weak after stage B; the pruned pairs come back cheapest first and
# the first entry stops them.
: > "$B4T"; rm -rf "$FADE"; mkdir -p "$FADE"
out=$(STUB_COSTS="c-model=0.05,a-model=0.30" STUB_FADE="c-model:2:$FADE" rb4 --grid c-model/medium,b-model/medium,a-model/medium --max-usd 100 --reps 1 --concurrency 1 2>/dev/null)
check "the cheapest pruned pair runs stage B and gives the entry; the dearer one is left at stage A" "a-model/medium=2|b-model/medium=4|c-model/medium=4" \
  "$(jq -rs 'group_by(.pair)|map("\(.[0].pair)=\(length)")|join("|")' "$B4T")"
check "and the last line counts the pair never re-admitted" "bench: spent=1.36 trials=10 unmeasured=0 pruned=1" "$(last_line "$out")"
before=$(wc -l < "$B4T" | tr -d ' ')
out=$(STUB_COSTS="c-model=0.05,a-model=0.30" rb4 --grid c-model/medium,b-model/medium,a-model/medium --max-usd 100 --reps 1 --concurrency 1 2>/dev/null)
check "a restart re-runs no trial, takes the same decisions and counts the same pruned pair" "$before|bench: spent=0.00 trials=0 unmeasured=0 pruned=1" \
  "$(wc -l < "$B4T" | tr -d ' ')|$(last_line "$out")"
# A single pruned pair that re-enters and gives the entry leaves nothing pruned.
: > "$B4T"; rm -rf "$FADE"; mkdir -p "$FADE"
out=$(STUB_COSTS="c-model=0.05" STUB_FADE="c-model:2:$FADE" rb4 --grid c-model/medium,b-model/medium --max-usd 100 --reps 1 --concurrency 1 2>/dev/null)
check "the one pruned pair runs stage B and gives the entry: graded on all four tasks, and the last line counts nothing pruned" "4|4|bench: spent=0.72 trials=8 unmeasured=0 pruned=0" \
  "$(tasks_of b-model/medium)|$(tasks_of c-model/medium)|$(last_line "$out")"
# One model, one pair. The grid is read through aliases.json: a trial recorded under the
# identifier an alias resolves to is the alias's, whatever name the grid gives the model.
[ -f "$BS/routing/aliases.json" ] && cp "$BS/routing/aliases.json" "$WORK/aliases.bench.bak"
printf '{"b-model":"b-model-1"}' > "$BS/routing/aliases.json"
: > "$B4T"
rb4 --grid b-model/medium --max-usd 100 --reps 1 --concurrency 1 >/dev/null 2>&1
jq -c '.pair="b-model-1/medium"' "$B4T" > "$WORK/b4t.tmp" && mv "$WORK/b4t.tmp" "$B4T"
before=$(wc -l < "$B4T" | tr -d ' ')
out=$(rb4 --grid b-model/medium --max-usd 100 --reps 1 --concurrency 1 2>/dev/null)
check "a grid naming the alias reuses the trials recorded under the identifier: none re-run, the last line counts none" \
  "$before|bench: spent=0.00 trials=0 unmeasured=0 pruned=0" "$(wc -l < "$B4T" | tr -d ' ')|$(last_line "$out")"
: > "$B4T"
out=$(rb4 --grid b-model-1/medium --max-usd 100 --reps 1 --concurrency 1 2>/dev/null)
check "a grid naming the identifier runs the alias and records every new trial under the alias" "4|b-model/medium" \
  "$(wc -l < "$B4T" | tr -d ' ')|$(jq -rs 'map(.pair)|unique|join(",")' "$B4T")"
: > "$B4T"
out=$(rb4 --grid b-model-1/medium,b-model/medium --max-usd 100 --reps 1 --concurrency 1 2>/dev/null)
check "a grid naming one model twice, by identifier and by alias, runs it once" "4|bench: spent=0.48 trials=4 unmeasured=0 pruned=0" \
  "$(wc -l < "$B4T" | tr -d ' ')|$(last_line "$out")"
if [ -f "$WORK/aliases.bench.bak" ]; then cp "$WORK/aliases.bench.bak" "$BS/routing/aliases.json"; else rm -f "$BS/routing/aliases.json"; fi
: > "$BT"
out=$(rb --grid b-model/medium,c-model/medium --max-usd 0.15 --concurrency 1)
check "the cap stops new trials and says what is left" "1" "$(printf '%s\n' "$out" | tail -1 | grep -c '^bench: spent=0.24 trials=2 unmeasured=2 pruned=0$')"
: > "$BT"
out=$(rb --grid b-model/medium,c-model/medium --max-usd 100 --reps 1 --concurrency 2)
check "two trials at once measure the same grid" "6|0" \
  "$(wc -l < "$BT" | tr -d ' ')|$(ls -d "$WORK"/trial-* 2>/dev/null | wc -l | tr -d ' ')"
# A worker that raises is recorded, never lost: a base that is no commit is an error trial.
mkdir -p "$BS/routing/projects/badbase"; cp -R "$BS/routing/projects/benchrepo/briefs" "$BS/routing/projects/badbase/"
jq '.slug="badbase" | .tasks=[{id:"bad-1",pr:1,class:"behaviour-phase",base:"0000000000000000000000000000000000000000",merged:.tasks[0].merged,brief:"briefs/pr-7.md",status:"ready"}]' "$BM" \
  > "$BS/routing/projects/badbase/manifest.json"
out=$(ORCHESTRATOR_STATE_DIR="$BS" ORCHESTRATOR_HOST_CLI="$ROOT/tests/fixtures/routing/host-stub.sh" TMPDIR="$WORK" python3 "$ROUTING" bench badbase --grid b-model/medium --max-usd 100 2>/dev/null)
check "a trial that raises is recorded as an error and the bench goes on to its last line" "error|bench: spent=0.00 trials=1 unmeasured=0 pruned=1" \
  "$(jq -r .status "$BS/routing/projects/badbase/trials.jsonl")|$(printf '%s\n' "$out" | tail -1)"
check "and leaves no trial directory" "0" "$(ls -d "$WORK"/trial-* 2>/dev/null | wc -l | tr -d ' ')"
# Costs that cannot be read are never free; a draft is named; errors count within one run.
cp "$BM" "$WORK/bm.bak"
jq '.tasks += [{id:"draft-1",pr:1,class:"behaviour-phase",base:.tasks[0].base,merged:.tasks[0].merged,brief:.tasks[0].brief,status:"draft"},
               {id:"s-1",pr:2,class:"search",base:.tasks[0].base,merged:.tasks[0].merged,brief:.tasks[0].brief,status:"ready"}]' "$WORK/bm.bak" > "$BM"
: > "$BT"
out=$(STUB_SILENT=1 rb --grid b-model/medium --max-usd 100 --class behaviour-phase --reps 1 --concurrency 1 2>"$WORK/silent.err")
check "a host that answers nothing costs the ceiling it was launched with, flagged" "1.25|true|error" "$(last '[.cost_usd,.cost_incomplete,.status]|map(tostring)|join("|")')"
check "the cap counts the ceiling" "bench: spent=2.50 trials=2 unmeasured=0 pruned=1" "$(printf '%s\n' "$out" | tail -1)"
check "a draft task is named when the bench skips it" "1" "$(grep -c 'bench: task draft-1 is still a draft, skipped' "$WORK/silent.err")"
: > "$BT"
rb --grid b-model/max --max-usd 100 --concurrency 1 2>"$WORK/bench.err" >/dev/null
check "three errors in one run drop a pair, and the bench says so" "1" "$(grep -c 'dropping b-model/max after 3 errors' "$WORK/bench.err")"
# Three errors recorded by an earlier run drop nothing in a new one.
: > "$BT"
for i in 1 2 3; do printf '{"task":"old-%d","class":"behaviour-phase","pair":"b-model/max","rep":1,"cost_usd":0.4,"status":"error"}\n' "$i" >> "$BT"; done
rb --grid b-model/max --max-usd 100 --class behaviour-phase --concurrency 1 2>"$WORK/bench.err" >/dev/null
check "errors of an earlier run do not drop the pair" "0|5" "$(grep -c 'dropping' "$WORK/bench.err")|$(wc -l < "$BT" | tr -d ' ')"
# Three judge failures in one run drop nothing: the host's outage is not the pair's fault.
: > "$BT"
STUB_JUDGE=garbage rb --grid b-model/medium --max-usd 100 --concurrency 1 2>"$WORK/bench.err" >/dev/null
check "a judge that answers nothing drops no pair" "0|3" "$(grep -c 'dropping' "$WORK/bench.err")|$(wc -l < "$BT" | tr -d ' ')"
cp "$WORK/bm.bak" "$BM"
# Six tasks, so that stage A holds the three errors that drop a pair. A pair dropped there is out of
# the pruning: it runs no stage B and the last line does not count it among the pruned.
mkdir -p "$BS/routing/projects/bench6"; cp -R "$BS/routing/projects/benchrepo/briefs" "$BS/routing/projects/bench6/"
jq '.slug="bench6" | .tasks += [(10, 11, 12) as $n | .tasks[2] | .id="pr-\($n)" | .pr=$n]' "$BM" > "$BS/routing/projects/bench6/manifest.json"
B6T="$BS/routing/projects/bench6/trials.jsonl"; : > "$B6T"
out=$(ORCHESTRATOR_STATE_DIR="$BS" ORCHESTRATOR_HOST_CLI="$ROOT/tests/fixtures/routing/host-stub.sh" TMPDIR="$WORK" \
  python3 "$ROUTING" bench bench6 --grid b-model/medium,b-model/max --max-usd 100 --reps 1 --concurrency 1 2>"$WORK/bench.err")
check "a pair dropped after three errors in stage A runs no stage B and is not counted among the pruned" "1|3|6|bench: spent=1.92 trials=9 unmeasured=0 pruned=0" \
  "$(grep -c 'dropping b-model/max after 3 errors' "$WORK/bench.err")|$(jq -s '[.[]|select(.pair=="b-model/max")]|length' "$B6T")|$(jq -s '[.[]|select(.pair=="b-model/medium")]|length' "$B6T")|$(last_line "$out")"
# The selection thresholds are read before anything is spent.
: > "$BT"; printf '{"selection":{"delta":2}}' > "$BS/routing/config.json"
check "a mistyped selection threshold stops the bench before any trial" "ERROR: selection: delta must be a number from 0 to 1, got 2|0" \
  "$(rb --grid b-model/medium --max-usd 100 2>&1 | tail -1)|$(wc -l < "$BT" | tr -d ' ')"
rm -f "$BS/routing/config.json"
check "no grid and no family bound is a refusal" "ERROR: bench: no family bound in the tier map; name them with --families" \
  "$(mv "$BS/models.json" "$WORK/models.off"; rb --max-usd 1 2>&1; mv "$WORK/models.off" "$BS/models.json")"
printf '{"slug":"bare","repo":"%s","profile":"x/y","tasks":[]}' "$BR" > "$WORK/bare.json"; mkdir -p "$BS/routing/projects/bare"; cp "$WORK/bare.json" "$BS/routing/projects/bare/manifest.json"
check "a manifest with no test command is refused" "ERROR: bench: project bare has no test_command or test_globs in its manifest" \
  "$(ORCHESTRATOR_STATE_DIR="$BS" python3 "$ROUTING" bench bare --grid b-model/medium --max-usd 1 2>&1)"

echo "== routing: task control =="

# A task is proved passable before it is benched: `ready` runs the merged commit's own tests on the
# merged tree. Here ok-1's base fails its test and its merge fixes it, bad-1's base passes and its
# merge breaks it, slow-1's merge adds a test that never ends, and lost-1's merged commit is no
# commit: a control run on the base, or on anything but the merged tree, reads each one wrong.
KR="$WORK/controlrepo"; mkdir -p "$KR/tests"; git -C "$KR" init -q
kcommit() { printf '%s\n' "$1" > "$KR/tests/t.sh"; gc -C "$KR" add -A; gc -C "$KR" commit -qm "$2"; git -C "$KR" rev-parse HEAD; }
K0=$(kcommit 'echo "FAIL the base is broken"; exit 1' broken)
K1=$(kcommit 'exit 0' fixed)
K2=$(kcommit 'for i in 1 2 3 4 5 6 7; do echo "FAIL case $i"; done; exit 1' regressed)
K3=$(kcommit 'sleep 31339' hangs)
KT="$WORK/ctl-tmp"; mkdir -p "$KT"
KS="$WORK/ctlstate"; KP="$KS/routing/projects/ctl"; mkdir -p "$KP"; KM="$KP/manifest.json"
printf '{"deep":"a-model","standard":"b-model","light":"c-model"}' > "$KS/models.json"
jq -n --arg repo "$KR" --arg k0 "$K0" --arg k1 "$K1" --arg k2 "$K2" --arg k3 "$K3" '
  def task($id; $base; $merged): {id: $id, class: "behaviour-phase", base: $base, merged: $merged,
                                  brief: "briefs/x.md", status: "draft"};
  {slug: "ctl", repo: $repo, profile: "x/y", test_globs: ["tests/*"],
   test_command: "for t in tests/*.sh; do bash \"$t\" || exit 1; done",
   tasks: [task("ok-1"; $k0; $k1), task("bad-1"; $k1; $k2), task("slow-1"; $k1; $k3),
           task("draft-1"; $k0; $k1), task("draft-2"; $k0; $k1),
           task("lost-1"; $k0; "0000000000000000000000000000000000000000")]}' > "$KM"
rk() { ORCHESTRATOR_STATE_DIR="$KS" TMPDIR="$KT" python3 "$ROUTING" "$@"; }
ktask() { jq -r --arg id "$1" ".tasks[]|select(.id==\$id)|$2" "$KM"; }

out=$(rk ready ctl ok-1 2>"$WORK/ctl.err"); code=$?
check "ready proves a task whose merged tree passes, and keeps the control it ran" "0|ready|0|true|number" \
  "$code|$(ktask ok-1 .status)|$(ktask ok-1 .control.exit)|$(ktask ok-1 '.control.at|test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")')|$(ktask ok-1 '.control.duration_s|type')"
check "and says so, with the time the tests took" "1" "$(printf '%s\n' "$out" | grep -c '^ready: ok-1 (control passed in [0-9.]*s)$')"
check "a passing control keeps no failure lines" "0|false|false" "$(ktask ok-1 .control.exit)|$(ktask ok-1 '.control|has("tests_failed")')|$(ktask ok-1 '.control|has("tests_tail")')"

# ok-1 was proved by the call above: put it back to a draft, so that only this call can leave it ready.
jq '(.tasks[]|select(.id=="ok-1")) |= (.status="draft" | del(.control, .void))' "$KM" > "$WORK/ctl.tmp" && mv "$WORK/ctl.tmp" "$KM"
out=$(rk ready ctl bad-1 ok-1 2>"$WORK/ctl.err"); code=$?
check "ready voids a task whose merged tree fails its own tests, proves the next one, and exits 1" "1|void|ready" \
  "$code|$(ktask bad-1 .status)|$(ktask ok-1 .status)"
check "the void carries its reason and the failure the control saw, as a failed trial does" "control: the merged commit's own tests fail (exit 1)|1|7|FAIL case 1|true" \
  "$(ktask bad-1 .void)|$(ktask bad-1 .control.exit)|$(ktask bad-1 '.control.tests_failed|length')|$(ktask bad-1 '.control.tests_failed[0]')|$(ktask bad-1 '.control.tests_tail|contains("FAIL case 7")')"
check "each task has its line, the void one with its reason" "1|1" \
  "$(printf '%s\n' "$out" | grep -c "^void: bad-1 control: the merged commit's own tests fail (exit 1)\$")|$(printf '%s\n' "$out" | grep -c '^ready: ok-1 (control passed in ')"
check "stderr shows the first five failing lines of a voided task, then names the voided tasks last" "5|ERROR: ready: voided bad-1" \
  "$(grep -c '^FAIL case' "$WORK/ctl.err")|$(tail -1 "$WORK/ctl.err")"
check "a control leaves no tree behind" "0" "$(ls "$KT" | wc -l | tr -d ' ')"

out=$(ORCHESTRATOR_TRIAL_TIMEOUT=1 rk ready ctl slow-1 2>"$WORK/ctl.err"); code=$?
# The kill is a signal: give the group a moment to be reaped before counting survivors.
for _ in 1 2 3 4 5 6 7 8 9 10; do ps -axo command | grep -q '[s]leep 31339' || break; sleep 0.3; done
check "a control that never ends is voided as a timeout, with no exit code" "1|void|control: the merged commit's own tests time out|null" \
  "$code|$(ktask slow-1 .status)|$(ktask slow-1 .void)|$(ktask slow-1 '.control.exit|tostring')"
check "and leaves no process and no tree behind" "0|0" "$(ps -axo command | grep -c '[s]leep 31339')|$(ls "$KT" | wc -l | tr -d ' ')"
pkill -f 'sleep 31339' 2>/dev/null || true

# A merged commit that cannot be read is not the task's fault: nothing is voided.
out=$(rk ready ctl lost-1 2>&1); code=$?
check "a merged commit that cannot be read stops ready, and the task is left as it was" "1|1|draft|false" \
  "$code|$(printf '%s\n' "$out" | grep -c '^ERROR: ready: the merged commit of task lost-1 cannot be read')|$(ktask lost-1 .status)|$(ktask lost-1 'has("control")')"

# Refusals come before any run.
cp "$KM" "$WORK/ctl.before"
out=$(rk ready ctl draft-1 nope-9 2>&1); code=$?
check "ready refuses an unknown task before running any, and writes nothing" "1|ERROR: ready: no task nope-9 in ctl|false|same" \
  "$code|$out|$(ktask draft-1 'has("control")')|$(cmp -s "$KM" "$WORK/ctl.before" && echo same || echo changed)"
mkdir -p "$KS/routing/projects/notests" "$KS/routing/projects/noglobs"
jq 'del(.test_command) | .slug="notests"' "$KM" > "$KS/routing/projects/notests/manifest.json"
jq 'del(.test_globs) | .slug="noglobs"' "$KM" > "$KS/routing/projects/noglobs/manifest.json"
for slug in notests noglobs; do
  out=$(rk ready "$slug" draft-1 2>&1); code=$?
  check "ready dies before any run on a manifest with no test command or no test globs: $slug" "1|ERROR: bench: project $slug has no test_command or test_globs in its manifest|draft|false" \
    "$code|$out|$(jq -r '.tasks[]|select(.id=="draft-1")|.status' "$KS/routing/projects/$slug/manifest.json")|$(jq -r '.tasks[]|select(.id=="draft-1")|has("control")' "$KS/routing/projects/$slug/manifest.json")"
done

# The manifest is written after each task: a run killed midway keeps the tasks proved before it.
jq '(.tasks[]|select(.id=="bad-1" or .id=="slow-1")) |= (.status="draft" | del(.control, .void))' "$KM" > "$WORK/ctl.tmp" && mv "$WORK/ctl.tmp" "$KM"
ORCHESTRATOR_STATE_DIR="$KS" ORCHESTRATOR_TRIAL_TIMEOUT=60 TMPDIR="$KT" python3 "$ROUTING" ready ctl bad-1 slow-1 >/dev/null 2>&1 &
kpid=$!
for _ in $(seq 1 50); do [ "$(ktask bad-1 .status)" = void ] && break; sleep 0.2; done
kill -9 "$kpid" 2>/dev/null; { wait "$kpid"; } 2>/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10; do pkill -f 'sleep 31339' 2>/dev/null; ps -axo command | grep -q '[s]leep 31339' || break; sleep 0.3; done
check "a run killed midway keeps the task proved before it, and the one it was proving is untouched" "void|draft|false" \
  "$(ktask bad-1 .status)|$(ktask slow-1 .status)|$(ktask slow-1 'has("control")')"
rm -rf "${KT:?}"/*

# void: a task whose merged commit passes but whose tests assert what the brief never states.
check_status "void wants a reason" 2 rk void ctl ok-1
check "and a reason that says something" "ERROR: void: --reason must not be empty" "$(rk void ctl ok-1 --reason '  ' 2>&1)"
check "void of an unknown task is refused, naming it" "ERROR: void: no task nope-9 in ctl" "$(rk void ctl nope-9 --reason why 2>&1)"
at=$(ktask ok-1 .control.at)
out=$(rk void ctl ok-1 draft-1 --reason "the tests assert what the brief never states" 2>&1); code=$?
check "void marks each task with its reason, prints it for each, and runs no control" "0|void|void|the tests assert what the brief never states|$at|false" \
  "$code|$(ktask ok-1 .status)|$(ktask draft-1 .status)|$(ktask ok-1 .void)|$(ktask ok-1 .control.at)|$(ktask draft-1 'has("control")')"
check "one line each" "void: ok-1 the tests assert what the brief never states|void: draft-1 the tests assert what the brief never states" \
  "$(printf '%s\n' "$out" | paste -sd'|' -)"
rk ready ctl ok-1 >/dev/null 2>&1
check "a voided task whose merged tree passes returns through ready, its void field gone" "ready|false" \
  "$(ktask ok-1 .status)|$(ktask ok-1 'has("void")')"
rk ready ctl bad-1 >/dev/null 2>&1
check "and one whose merged tree fails stays void" "void" "$(ktask bad-1 .status)"

# The bench names why it skips a task: a draft keeps its wording, a void task is named void.
out=$(ORCHESTRATOR_HOST_CLI="$ROOT/tests/fixtures/routing/host-stub.sh" rk bench ctl --grid b-model/medium --max-usd 0 2>&1 >/dev/null)
check "the bench skips a void task and says it is void, and a draft keeps its wording" "1|1|0" \
  "$(printf '%s\n' "$out" | grep -c 'bench: task bad-1 is void, skipped')|$(printf '%s\n' "$out" | grep -c 'bench: task draft-2 is still a draft, skipped')|$(printf '%s\n' "$out" | grep -c 'bench: task ok-1 is')"

# What a table counts: the trials of ready tasks, those naming no task (record rows), and those
# naming a task the manifest does not know.
check "counted keeps a trial of a ready task, one naming no task and one naming an unknown task; the others come back by task" "['a', None, 'x']|[('d', 1), ('v', 2)]" \
  "$(rcall '(lambda r: "%s|%s" % ([t.get("task") for t in r[0]], sorted(r[1].items())))(m.counted({"tasks": [{"id": "a", "status": "ready"}, {"id": "v", "status": "void"}, {"id": "d", "status": "draft"}]}, [{"task": "a"}, {"task": "v"}, {"task": "d"}, {}, {"task": "x"}, {"task": "v"}]))')"
check "counted of a manifest with no task keeps every trial" "3|{}" \
  "$(rcall '(lambda r: "%d|%s" % (len(r[0]), r[1]))(m.counted({}, [{"task": "a"}, {"task": "b"}, {}]))')"

QS="$WORK/countstate"; QP="$QS/routing/projects/cnt"; mkdir -p "$QP"
printf '{"slug":"cnt","repo":"/nonexistent","profile":"x/y","tasks":[{"id":"t1","status":"ready"},{"id":"t2","status":"ready"},{"id":"t3","status":"ready"},{"id":"t4","status":"void"},{"id":"t5","status":"draft"}]}' > "$QP/manifest.json"
qtrial() { # task status [times]: a trial of b-model/medium; an empty task names none
  local i tf=""; [ -n "$1" ] && tf="\"task\":\"$1\","
  for i in $(seq "${3:-1}"); do
    printf '{%s"class":"behaviour-phase","pair":"b-model/medium","rep":1,"models":{"b-model-1":0.3},"cost_usd":0.3,"status":"%s"}\n' "$tf" "$2" >> "$QP/trials.jsonl"
  done; }
: > "$QP/trials.jsonl"
for t in t1 t2 t3; do qtrial "$t" pass 2; done
qtrial t4 fail 2; qtrial t5 fail; qtrial "" pass; qtrial t9 pass
rcnt() { ORCHESTRATOR_STATE_DIR="$QS" python3 "$ROUTING" calibrate cnt "$@"; }
rcnt >/dev/null 2>"$WORK/cnt.err"
qrung() { jq -r '.entries["behaviour-phase"].ladder[0]|"\(.n)|\(.tasks)|\(.per_task|keys|join(","))"' "$QS/routing/tables/project-cnt.json"; }
check "calibrate leaves the trials of a voided and of a draft task out of the figures, and keeps the rest" "8|4|record,t1,t2,t3,t9" "$(qrung)"
check "and says what it left out, once, with the ids sorted" "1|1" \
  "$(grep -c 'cnt: excluded 3 trial(s) of task(s) not ready: t4 t5$' "$WORK/cnt.err")|$(grep -c 'excluded' "$WORK/cnt.err")"
# Made ready again, t4 and t5 bring their trials back (their failures are now passes, so the class
# keeps its entry and the ladder can be read).
jq '(.tasks[]|select(.id=="t4" or .id=="t5")).status="ready"' "$QP/manifest.json" > "$WORK/cnt.tmp" && mv "$WORK/cnt.tmp" "$QP/manifest.json"
sed 's/"status":"fail"/"status":"pass"/' "$QP/trials.jsonl" > "$WORK/cnt.tmp" && mv "$WORK/cnt.tmp" "$QP/trials.jsonl"
rcnt >/dev/null 2>"$WORK/cnt.err"
check "a task made ready again brings its trials back, and nothing is said when nothing is left out" "11|6|0" \
  "$(qrung | cut -d'|' -f1,2)|$(grep -c 'excluded' "$WORK/cnt.err")"
# Every trial on a voided task: only the record rows are left to calibrate on.
printf '{"slug":"cnt2","repo":"/nonexistent","profile":"x/y","tasks":[{"id":"t1","status":"void"}]}' > "$WORK/cnt2.json"
mkdir -p "$QS/routing/projects/cnt2"; cp "$WORK/cnt2.json" "$QS/routing/projects/cnt2/manifest.json"
for i in 1 2 3; do printf '{"task":"t1","class":"n-bis","pair":"c-model/low","rep":1,"models":{"c-model-1":0.1},"cost_usd":0.1,"status":"pass"}\n' >> "$QS/routing/projects/cnt2/trials.jsonl"; done
RR2="$WORK/cnt-rec.jsonl"; : > "$RR2"
for i in 1 2 3 4 5 6; do printf '{"id":%d,"class":"n-bis","model":"c-model","effort":"low","rounds":1,"state":"closed","cost_usd":0.02,"sessions":["s"],"cost_incomplete":false}\n' "$i" >> "$RR2"; done
check "trials all left out, the record rows still calibrate" "class=n-bis pair=c-model/low pass_rate=1.0 n=6 expected_usd=0.02 p_best=1.0 size=unknown" \
  "$(ORCHESTRATOR_STATE_DIR="$QS" python3 "$ROUTING" calibrate cnt2 --from-record "$RR2" 2>/dev/null)"
check_status "and with no record row either, calibrate has nothing to read" 1 env ORCHESTRATOR_STATE_DIR="$QS" python3 "$ROUTING" calibrate cnt2
# Every trial left out and no record row either: the table those trials built goes with them, or
# pick would go on serving the entry the exclusion exists to remove.
rcnt2() { ORCHESTRATOR_STATE_DIR="$QS" python3 "$ROUTING" calibrate cnt2 "$@"; }
Q2TAB="$QS/routing/tables/project-cnt2.json"
rcnt2 --from-record "$RR2" >/dev/null 2>&1
q2had=$([ -f "$Q2TAB" ] && echo table || echo none)
rcnt2 >/dev/null 2>"$WORK/cnt2.err"; code=$?
check "calibrate with every trial left out and no record row removes the project's table, naming how many trials it left out" \
  "table|1|ERROR: calibrate: no counted trial for cnt2 (3 excluded); its table removed|none" \
  "$q2had|$code|$(tail -1 "$WORK/cnt2.err")|$([ -f "$Q2TAB" ] && echo table || echo none)"
rm -f "$Q2TAB"
rcnt2 >/dev/null 2>"$WORK/cnt2.err"; code=$?
check "and with no table to remove it says only that no trial was counted" \
  "1|ERROR: calibrate: no counted trial for cnt2 (3 excluded)" "$code|$(tail -1 "$WORK/cnt2.err")"

GQ="$WORK/gcountstate"
gcmk() { mkdir -p "$GQ/routing/projects/$1"; printf '{"slug":"%s","repo":"/x/%s","profile":"php/laravel-app","tasks":%s}' "$1" "$1" "$2" > "$GQ/routing/projects/$1/manifest.json"; : > "$GQ/routing/projects/$1/trials.jsonl"; }
gctrial() { # slug task status [times]
  local i; for i in $(seq "${4:-1}"); do
    printf '{"task":"%s","class":"behaviour-phase","pair":"b-model/medium","rep":1,"models":{"b-model-1":0.3},"cost_usd":0.3,"status":"%s"}\n' "$2" "$3" >> "$GQ/routing/projects/$1/trials.jsonl"
  done; }
gcmk g1 '[{"id":"t1","status":"ready"},{"id":"t2","status":"ready"},{"id":"t3","status":"ready"},{"id":"t4","status":"void"}]'
gcmk g2 '[{"id":"t1","status":"ready"},{"id":"t2","status":"ready"},{"id":"t3","status":"ready"}]'
gcmk g3 '[{"id":"t1","status":"void"}]'
for s in g1 g2; do for t in t1 t2 t3; do gctrial $s $t pass 2; done; done
gctrial g1 t4 fail 2; gctrial g3 t1 pass 2
out=$(ORCHESTRATOR_STATE_DIR="$GQ" python3 "$ROUTING" generalize 2>"$WORK/gcount.err")
check "generalize leaves the trials of a voided task out of the pooled figures" "12|6" \
  "$(jq -r '.entries["behaviour-phase"].ladder[]|select(.pair=="b-model/medium")|"\(.n)|\(.tasks)"' "$GQ/routing/tables/global.json")"
check "and says which project left what out, one line per project that did" "g1: excluded 2 trial(s) of task(s) not ready: t4|g3: excluded 2 trial(s) of task(s) not ready: t1" \
  "$(grep 'excluded' "$WORK/gcount.err" | sed 's/^WARNING: //' | paste -sd'|' -)"
check "a project with no trial left is no project of the fold" "global projects=2 classes=1" "$(printf '%s\n' "$out" | grep '^global')"

echo "== routing: generalize =="

GS="$WORK/gstate"
mkproj() { # slug profile
  mkdir -p "$GS/routing/projects/$1"
  printf '{"slug":"%s","repo":"/x/%s","profile":"%s","tasks":[]}' "$1" "$1" "$2" > "$GS/routing/projects/$1/manifest.json"; }
gtrial() { # slug class pair status cost: a pair's trials in a project cycle over three tasks
  local f="$GS/routing/projects/$1/trials.jsonl" n
  n=$(grep -c "\"class\":\"$2\",\"pair\":\"$3\"" "$f" 2>/dev/null)
  printf '{"task":"t%s","class":"%s","pair":"%s","models":{"%s-1":%s},"cost_usd":%s,"status":"%s"}\n' \
    "$(( ${n:-0} % 3 + 1 ))" "$2" "$3" "${3%%/*}" "$5" "$5" "$4" >> "$f"; }
mkproj p1 php/laravel-app; mkproj p2 php/laravel-app; mkproj p3 shell/plugin
# c-model/medium: perfect on p1 (6/6), poor on p2 (3/6): not equivalent to p2's best, held back.
# b-model/medium: 6/6 on p1 and p2 -> chosen for the profile.
for i in 1 2 3 4 5 6; do gtrial p1 behaviour-phase c-model/medium pass 0.1; gtrial p1 behaviour-phase b-model/medium pass 0.3; gtrial p2 behaviour-phase b-model/medium pass 0.3; done
for i in 1 2 3; do gtrial p2 behaviour-phase c-model/medium pass 0.1; gtrial p2 behaviour-phase c-model/medium fail 0.1; done
# On the global fold, add p3 where c-model/medium is perfect too: still held back by p2.
for i in 1 2 3 4 5 6; do gtrial p3 behaviour-phase c-model/medium pass 0.1; done
printf '{"deep":"a-model","standard":"b-model","light":"c-model"}' > "$GS/models.json"
rg() { ORCHESTRATOR_STATE_DIR="$GS" python3 "$ROUTING" "$@"; }
out=$(rg generalize)
check "a profile needs two projects" "profile=php/laravel-app projects=2 classes=1" "$(printf '%s\n' "$out" | grep '^profile=')"
check "no table for a profile of one project" "no" "$([ -f "$GS/routing/tables/profile-shell-plugin.json" ] && echo yes || echo no)"
check "the profile's pair must hold in each project" "b-model/medium" \
  "$(jq -r '.entries["behaviour-phase"].pair' "$GS/routing/tables/profile-php-laravel-app.json")"
check "the global fold covers every project" "global projects=3 classes=1" "$(printf '%s\n' "$out" | grep '^global')"
# The per-project condition, isolated: c-model/medium at 12/12 on p1 and p3 and 4/6 on p2 is
# pooled 28/30, equivalent to the pooled best, yet not equivalent to p2's best on p2 alone.
: > "$GS/routing/projects/p2/trials.jsonl"
for i in 1 2 3 4; do gtrial p2 behaviour-phase c-model/medium pass 0.1; done
for i in 1 2; do gtrial p2 behaviour-phase c-model/medium fail 0.1; done
for i in 1 2 3 4 5 6; do gtrial p1 behaviour-phase c-model/medium pass 0.1; gtrial p3 behaviour-phase c-model/medium pass 0.1; done
for i in 1 2 3 4 5 6; do gtrial p2 behaviour-phase b-model/medium pass 0.3; done
rg generalize >/dev/null
check "one weak project keeps a cheaper pair out of the global table" "b-model/medium" \
  "$(jq -r '.entries["behaviour-phase"].pair' "$GS/routing/tables/global.json")"
check "a pair held back by one project keeps its pooled measure on the ladder" "30|0.8889|true|false" \
  "$(jq -r '.entries["behaviour-phase"].ladder[]|select(.pair=="c-model/medium")|"\(.n)|\(.pass_rate)|\(.equivalent)|\(.eligible)"' "$GS/routing/tables/global.json")"
ED="$WORK/exported"; mkdir -p "$ED"
out=$(rg export --to "$ED")
check "export says what it wrote" "exported $ED/global.json (1 classes)" "$(printf '%s\n' "$out" | grep global.json)"
check "export writes the tier, never the family" "standard/medium" "$(jq -r '.entries["behaviour-phase"].pair' "$ED/global.json")"
check "export drops identifiers and costs" "null|null" "$(jq -r '.entries["behaviour-phase"]|"\(.models)|\(.cost_usd)"' "$ED/global.json")"
check "export keeps the ladder in tier form, without costs" "light/medium,standard/medium|null" \
  "$(jq -r '.entries["behaviour-phase"]|"\([.ladder[].pair]|join(","))|\(.ladder[0].cost_usd)"' "$ED/global.json")"
check "no family name in an export" "" "$(grep -rl -e a-model -e b-model -e c-model "$ED" || true)"
check "an export keeps the selection and the size, never a floor, a cost or an identifier" "1|8|false|unknown|false|false" \
  "$(jq -r '.entries["behaviour-phase"]|"\(.delta*10|round)|\(.bar*10|round)|\(.strict)|\(.size)|\(has("floor"))|\([.ladder[]|has("cost_usd") or has("median_usd") or has("per_task")]|any)"' "$ED/global.json")"
check "an exported rung carries its coverage and its equivalence" "covered,eligible,equivalent,p_best,pair,pass_rate,tasks" \
  "$(jq -r '.entries["behaviour-phase"].ladder[0]|keys|join(",")' "$ED/global.json")"
printf '{"deep":"a-model","light":"c-model"}' > "$GS/models.json"
check "a family bound to no tier is skipped, with a warning per table" "2" \
  "$(rg export --to "$ED" 2>&1 >/dev/null | grep -c 'export: b-model is bound to no tier, behaviour-phase skipped')"
cp "$ED/global.json" "$WORK/global.before"
printf '{}' > "$GS/models.json"
rg export --to "$ED" >/dev/null 2>"$WORK/export.err"
check "an export with nothing in tier form leaves the shipped table untouched, and says so" "same|1" \
  "$(cmp -s "$ED/global.json" "$WORK/global.before" && echo same || echo changed)|$(grep -c 'export: global.json has no class in tier form, not written' "$WORK/export.err")"
printf '{"deep":"a-model","light":"c-model"}' > "$GS/models.json"
check "show lists each class with its tables" "1" "$(rg show p1 | grep -c '^class=behaviour-phase project=- profile=b-model/medium global=b-model/medium')"
printf '{"b-model":"b-model-2"}' > "$GS/routing/aliases.json"
check "show flags an entry measured on another identifier" "1" "$(rg show p1 | grep -c '^class=behaviour-phase .* stale$')"
rm "$GS/routing/aliases.json"
check_status "show of an unknown project is a refusal" 1 rg show nope
# A fold pools a pair only where it is covered: c-model/low is perfect and cheapest, but f2
# graded it on one task of three.
FS="$WORK/fstate"
ftrial() { mkdir -p "$FS/routing/projects/$1"
  printf '{"slug":"%s","repo":"/x/%s","profile":"go/cli","tasks":[]}' "$1" "$1" > "$FS/routing/projects/$1/manifest.json"
  printf '{"task":"%s","class":"behaviour-phase","pair":"%s","models":{"%s-1":%s},"cost_usd":%s,"status":"pass"}\n' \
    "$2" "$3" "${3%%/*}" "$4" "$4" >> "$FS/routing/projects/$1/trials.jsonl"; }
for t in t1 t2 t3; do for r in 1 2; do
  ftrial f1 "$t" b-model/medium 0.3; ftrial f2 "$t" b-model/medium 0.3; ftrial f1 "$t" c-model/low 0.05; done; done
for r in 1 2 3; do ftrial f2 t1 c-model/low 0.05; done
ORCHESTRATOR_STATE_DIR="$FS" python3 "$ROUTING" generalize >/dev/null
check "a pair covered in one project of two is not covered in the profile, never its entry" "b-model/medium|false|false" \
  "$(jq -r '.entries["behaviour-phase"]|"\(.pair)|\(.ladder[]|select(.pair=="c-model/low")|"\(.covered)|\(.eligible)")"' "$FS/routing/tables/profile-go-cli.json")"
check "a fold names each task by its project, so two projects' tasks never merge" "6" \
  "$(jq -r '.entries["behaviour-phase"].ladder[]|select(.pair=="b-model/medium")|.tasks' "$FS/routing/tables/profile-go-cli.json")"
check "generalize with no trial anywhere is a refusal" "ERROR: generalize: no project has trials" \
  "$(ORCHESTRATOR_STATE_DIR="$WORK/empty-state" python3 "$ROUTING" generalize 2>&1)"

# A project of unknown language shares nothing with another one: pooling them would serve
# unrelated repositories one table. They count toward the global table only.
printf '{"deep":"a-model","standard":"b-model","light":"c-model"}' > "$GS/models.json"
mkproj u1 unknown/library; mkproj u2 unknown/library
for i in 1 2 3 4 5 6; do gtrial u1 search c-model/low pass 0.01; gtrial u2 search c-model/low pass 0.01; done
out=$(rg generalize)
check "projects of unknown language get no profile table, and still count globally" "no|global projects=5 classes=2" \
  "$([ -f "$GS/routing/tables/profile-unknown-library.json" ] && echo yes || echo no)|$(printf '%s\n' "$out" | grep '^global')"
UT="$WORK/unknown-tree"; mkdir -p "$UT"
check "a third project of unknown language is served by the global table" $'pair=c-model/low source=global\nnbis=c-model/medium' \
  "$(ORCHESTRATOR_STATE_DIR="$GS" ORCHESTRATOR_ROUTING_DEFAULTS="$WORK/no-defaults" python3 "$ROUTING" pick --repo "$UT" --class search)"

# One weak trial does not hold a pair back: r3 has a single failed trial of c-model/medium.
RS="$WORK/rstate"; mkdir -p "$RS"
rmk() { mkdir -p "$RS/routing/projects/$1"; printf '{"slug":"%s","repo":"/x/%s","profile":"ruby/gem","tasks":[]}' "$1" "$1" > "$RS/routing/projects/$1/manifest.json"; }
rtr() { local f="$RS/routing/projects/$1/trials.jsonl" n; n=$(cat "$f" 2>/dev/null | wc -l)
  printf '{"task":"t%s","class":"behaviour-phase","pair":"c-model/medium","models":{"c-model-1":0.1},"cost_usd":0.1,"status":"%s"}\n' "$(( n % 3 + 1 ))" "$2" >> "$f"; }
rmk r1; rmk r2; rmk r3
for i in 1 2 3 4 5 6; do rtr r1 pass; rtr r2 pass; done; rtr r3 fail
printf '{"deep":"a-model","standard":"b-model","light":"c-model"}' > "$RS/models.json"
ORCHESTRATOR_STATE_DIR="$RS" python3 "$ROUTING" generalize >/dev/null
check "a project with one failed trial does not hold a pair back from the profile table" "c-model/medium|true" \
  "$(jq -r '.entries["behaviour-phase"]|"\(.pair)|\(.ladder[0].eligible)"' "$RS/routing/tables/profile-ruby-gem.json")"

# A shipped ladder is in tier form; the dispatched pair is an alias. The rungs are read
# through the map, or a shipped ladder's measured floor is never honoured.
XS="$WORK/xstate"; XD="$WORK/xdefaults"; mkdir -p "$XS" "$XD"
printf '{"deep":"a-model","standard":"b-model","light":"c-model"}' > "$XS/models.json"
printf '{"scope":"global","entries":{"behaviour-phase":{"pair":"standard/high","floor":0.9,"n":6,"pass_rate":1.0,"ladder":[{"pair":"light/high","n":6,"pass_rate":0.5,"eligible":false},{"pair":"standard/high","n":6,"pass_rate":1.0,"eligible":true}]}}}' > "$XD/global.json"
for i in 1 2 3; do printf '{"id":%d,"class":"behaviour-phase","model":"b-model","effort":"high","rounds":1,"state":"closed"}\n' "$i"; done > "$WORK/x.jsonl"
xpick() { ORCHESTRATOR_STATE_DIR="$XS" ORCHESTRATOR_ROUTING_DEFAULTS="$XD" python3 "$ROUTING" pick --repo "$UT" --class behaviour-phase --record "$WORK/x.jsonl"; }
check "a shipped rung measured below the floor, read through the map, is no notch" $'pair=b-model/high source=shipped:global\nnbis=b-model/xhigh' "$(xpick)"
printf '{"deep":"a-model","standard":"b-model"}' > "$XS/models.json"
check "a shipped rung on an unbound tier is skipped: the effort notch stands" "explore=b-model/medium" "$(xpick | sed -n 2p)"

# An old table stays old. A rung written before the selection by equivalence has no `equivalent`,
# and an export used to write one as null: either way the floor rule that selected the table reads
# it, never the new rule on a key that was not measured. An export writes the keys a table carries
# and no null in their place.
check "a rung with no equivalence, or a null one, is read by the floor rule" "True|True|False|False|False" \
  "$("$py" -c 'import importlib.util,sys; s=importlib.util.spec_from_file_location("r",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); e={"floor":0.9}; f=lambda r: m.failed_rung(r, e); print("|".join(str(x) for x in (f({"n":8,"pass_rate":0.5}), f({"n":8,"pass_rate":0.5,"covered":None,"equivalent":None}), f({"n":8,"pass_rate":1.0}), f({"n":8,"pass_rate":1.0,"covered":None,"equivalent":None}), f({"n":2,"pass_rate":0.5,"equivalent":None}))))' "$ROUTING")"
OS="$WORK/oldstate"; OD="$WORK/oldexport"; mkdir -p "$OS/routing/tables" "$OD"
printf '{"deep":"a-model","standard":"b-model","light":"c-model"}' > "$OS/models.json"
printf '{"scope":"global","generated":"2026-01-01","entries":{"conversion-phase":{"pair":"b-model/medium","pass_rate":1.0,"n":8,"floor":0.9,"models":["b-model-1"],"ladder":[{"pair":"c-model/medium","n":8,"pass_rate":0.5,"eligible":false},{"pair":"b-model/medium","n":8,"pass_rate":1.0,"eligible":true}]},"review-collector":{"pair":"b-model/medium","pass_rate":1.0,"n":8,"floor":0.9,"models":["b-model-1"],"ladder":[{"pair":"c-model/medium","n":8,"pass_rate":1.0,"eligible":true},{"pair":"b-model/medium","n":8,"pass_rate":1.0,"eligible":true}]}}}' > "$OS/routing/tables/global.json"
ORCHESTRATOR_STATE_DIR="$OS" python3 "$ROUTING" export --to "$OD" >/dev/null 2>&1
check "an old table exported carries no null, and no key it never had" "0|ladder,n,pair,pass_rate|eligible,pair,pass_rate" \
  "$(jq -r '[..|nulls]|length' "$OD/global.json")|$(jq -r '.entries["conversion-phase"]|keys|join(",")' "$OD/global.json")|$(jq -r '.entries["conversion-phase"].ladder[0]|keys|join(",")' "$OD/global.json")"
# A table written by this code has rungs that were never covered, whose p_best is null: its export
# carries no null either, and the rung is written without the figure it does not have.
with_extra_trial '{"task":"t-a","class":"review-collector","pair":"a-model/low","rep":1,"models":{"a-model-1":0.05},"cost_usd":0.05,"status":"pass"}' >/dev/null
NX="$WORK/newexport"; ND="$WORK/newexported"; mkdir -p "$NX/routing/tables" "$ND"
printf '{"deep":"a-model","standard":"b-model","light":"c-model"}' > "$NX/models.json"
cp "$IS/routing/tables/project-tasks.json" "$NX/routing/tables/global.json"
ORCHESTRATOR_STATE_DIR="$NX" python3 "$ROUTING" export --to "$ND" >/dev/null 2>&1
check "the table to export has a rung with a null p_best, and its export carries no null" "1|0|1" \
  "$(jq -r '[.entries["review-collector"].ladder[]|select(.p_best==null)]|length' "$NX/routing/tables/global.json")|$(jq -r '[..|nulls]|length' "$ND/global.json")|$(jq -r '[.entries["review-collector"].ladder[]|select(has("p_best")|not)]|length' "$ND/global.json")"

echo "== routing: the skill =="

MR="$ROOT/skills/model-routing/SKILL.md"
check "the skill picks a pair through routing.py pick" "yes" "$(spells "$MR" 'routing.py pick --repo')"
check "the skill records each session's cost" "yes" "$(spells "$MR" 'dispatch-record.sh cost')"
check "the skill bounds exploration to one notch" "yes" "$(spells "$MR" 'one notch')"
check "the skill names what is never explored" "yes" "$(carries "$MR" 'never explored')"
check "the skill points at the calibration reference" "yes" "$(spells "$MR" 'references/calibration.md')"
check "the skill keeps the budget out of the choice" "yes" "$(carries "$MR" 'never read the subscription gauge to choose')"
check "the skill folds a promotion into the table from the record" "yes" "$(spells "$MR" 'routing.py calibrate <slug> --from-record <record>')"
CLASSES="$(python3 -c 'import importlib.util,sys; s=importlib.util.spec_from_file_location("r",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(" ".join(sorted(m.CLASS_TIERS)))' "$ROUTING")"
check "pick knows classes to name" "yes" "$([ -n "$CLASSES" ] && echo yes || echo no)"
check "the skill's table names every class pick knows, in backticks" "" \
  "$(for c in $CLASSES; do grep -qF "\`$c\`" "$MR" || echo "$c"; done)"
MRC="$ROOT/skills/model-routing/references/calibration.md"
check "the calibration reference walks the bench in the operator's order" "yes|yes|yes" \
  "$(spells "$MRC" 'max-usd')|$(spells "$MRC" 'generalize')|$(spells "$MRC" 'export')"
check "the calibration reference states that a trial's session can reach the real repository" "yes" \
  "$(spells "$MRC" 'with its own permissions on the machine and could reach the real repository')"
check "the calibration reference states that a run can pass its cap by the trials in flight" "yes" \
  "$(spells "$MRC" "a run can pass \`--max-usd\` by at most N per-trial ceilings")"
check "the calibration reference states the selection by equivalence, its keys and the size stamp" "yes|yes|yes|yes" \
  "$(spells "$MRC" '{"selection": {"delta": <d>, "bar": <b>}}')|$(spells "$MRC" 'The entry**: the eligible pair with the lowest expected cost')|$(spells "$MRC" 'the files matching `test_globs` left out')|$(spells "$MRC" 'show [--detail] [<slug>...]')"
check "the calibration reference no longer states a floor for the tables" "no" "$(spells "$MRC" 'The reliability floors')"
check "the routing skill skips a notch found not equivalent, not one below a floor" "yes|no" \
  "$(spells "$MR" 'measured and found not equivalent to the best')|$(spells "$MR" 'measured below the floor')"
check "the skill passes the phase's size to pick: both options, and the two thresholds of the readings" "yes|yes|yes|yes" \
  "$(spells "$MR" '--files')|$(spells "$MR" '--lines')|$(spells "$MR" 'files > 3')|$(spells "$MR" 'lines > 50')"
check "the skill says what beyond= means for the brief, and that a correction round runs at nbis=" "yes|yes|yes" \
  "$(spells "$MR" 'size=large beyond=<scope>')|$(spells "$MR" 'nbis=')|$(spells "$MR" '--class n-bis')"
check "the skill says an n-bis call's own pair is the round's, not its nbis= line" "yes" "$(spells "$MR" "its \`nbis=\` line is not read")"
check "the skill puts a search exploration, summary in the brief, before a phase beyond every measured size" "yes|yes" \
  "$(spells "$MR" 'beyond every measured size')|$(carries "$MR" 'read-only search exploration')"
check "the calibration reference states pick's options and its lines" "yes|yes|yes" \
  "$(spells "$MRC" '--files <n> --lines <n>')|$(spells "$MRC" 'size=large beyond=<scope>')|$(spells "$MRC" 'nbis=<pair>')"
check "the calibration reference says ready runs the merged commit's tests, what void is for, and that a table counts only ready tasks" "yes|yes|yes|yes|yes" \
  "$(spells "$MRC" '`ready` proves each task passable before it is benched')|$(spells "$MRC" '`void <slug> <task-id>... --reason <text>`')|$(spells "$MRC" 'whose tests assert behaviour the brief never')|$(spells "$MRC" '**Ready tasks only.**')|$(spells "$MRC" 'excluded <n> trial(s) of task(s) not ready: <ids>')"
check "the dispatch log holds the correction round's notch and the size rule" "yes|yes" \
  "$(spells "$ROOT/docs/agent-dispatches.md" 'A correction round runs one effort notch above its phase')|$(spells "$ROOT/docs/agent-dispatches.md" 'A table measured on small work does not serve a large phase')"
check "the calibration reference walks the paired bench: the two stages, the prune rule, the band of the second repetition, re-admission" "yes|yes|yes|yes|yes" \
  "$(spells "$MRC" '**Stage A**')|$(spells "$MRC" '**Stage B**')|$(spells "$MRC" 'stage-A task it passed, and beats it on one of the two')|$(spells "$MRC" 'between 0.3 and 0.7')|$(spells "$MRC" '**Re-admission**')"
check "and its last line carries pruned=, and no screening, cost band or bench floor is left" "yes|no|no|no" \
  "$(spells "$MRC" 'unmeasured=<n> pruned=<n>')|$(carries "$MRC" 'screening')|$(spells "$MRC" '1.5 times the cheapest')|$(spells "$MRC" 'reads its floors from')"
check "the calibration reference lists p_equiv among the rung's fields" "yes" "$(spells "$MRC" '`p_best` (covered pairs only), `p_equiv` (covered pairs only)')"
check "the calibration reference says one model is one pair, an older release a pair of its own, and an alias is recorded only for a model that carries it" "yes|yes|yes" \
  "$(spells "$MRC" 'trial whose pair names the identifier an alias resolves to in `aliases.json` counts under the')|$(spells "$MRC" 'older release of the family has no alias and stays a pair of its own')|$(spells "$MRC" 'when one of the models it reports carries the alias, updates')"
check "the dispatch log holds the paired bench" "yes" "$(spells "$ROOT/docs/agent-dispatches.md" 'The bench runs every pair on the same tasks')"
check "the skill states pick's order, the map as last fallback, and what a new project or a fresh install gets" "yes|yes|yes|yes" \
  "$(spells "$MR" '**The order `pick` reads, class by class:** the project'"'"'s table, its profile'"'"'s table, the global table')|$(spells "$MR" '`models.json` is the last fallback, not the default')|$(spells "$MR" 'A new project with no table of its own gets, for each class, the first of its profile'"'"'s and the global table that measures it')|$(spells "$MR" 'so on a fresh install the same project falls to the tier map')"
check "the skill walks a new project's calibration in order, its cap and where each step lands" "yes|yes|yes|yes|yes|yes|yes" \
  "$(spells "$MR" '## Calibrating a new project')|$(spells "$MR" '1. `harvest <repo> --class <class> --pr <n>')|$(spells "$MR" '2. `ready <slug> <task-id>...`: the control run')|$(spells "$MR" '3. `bench <slug> --max-usd <n>`: the spend cap')|$(spells "$MR" '4. `calibrate <slug>`: writes the project'"'"'s table, `tables/project-<slug>.json`')|$(spells "$MR" '5. `generalize`: no argument')|$(spells "$MR" '6. `export [--to <dir>]`, on the operator'"'"'s word only')"
check "the README calls the map the last fallback, states pick's order and points at the calibration section" "yes|yes|yes" \
  "$(spells "$ROOT/README.md" 'The map is the last fallback, not the default')|$(tr '\n' ' ' < "$ROOT/README.md" | tr -s ' ' | grep -qF 'the project'"'"'s measured table, its profile'"'"'s, the global one, the shipped defaults, and only then the tier table' && echo yes || echo no)|$(tr '\n' ' ' < "$ROOT/README.md" | tr -s ' ' | grep -qF '« Calibrating a new project » in `skills/model-routing/SKILL.md`' && echo yes || echo no)"
check "the routing skill and the brief say a pair, not a tier" "yes|yes" \
  "$(spells "$MR" 'must choose the model/effort pair')|$(spells "$ROOT/skills/orchestrator/references/briefs.md" 'then choose the model/effort pair the work needs')"


echo "== command: calibrate =="
# The operator's ruling: one command chains harvest, ready, bench and calibrate on a spend cap
# he gives, and stops before generalize and export.
CALCMD="$ROOT/commands/calibrate.md"
check "the calibrate command exists with its description, its hint and a narrow tool list" "yes|1|1|1|0" \
  "$([ -f "$CALCMD" ] && echo yes || echo no)|$(sed -n '1,5p' "$CALCMD" 2>/dev/null | grep -c '^description: ')|$(sed -n '1,5p' "$CALCMD" 2>/dev/null | grep -c '^argument-hint: .*--max-usd <cap>')|$(sed -n '1,5p' "$CALCMD" 2>/dev/null | grep -c '^allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/model-routing/scripts/routing\.py:\*)')|$(sed -n '1,5p' "$CALCMD" 2>/dev/null | grep '^allowed-tools: ' | grep -cE 'Write|Edit|Bash\((gh|git|python3)')"
cal_order() {  # the line of each step's invocation, in the order the command runs them
  local s n
  for s in 'harvest <checkout>' 'ready <slug>' 'bench <slug> --max-usd <cap>' 'calibrate <slug>'; do
    n=$(grep -nF -- "routing.py $s" "$1" | head -1 | cut -d: -f1)
    printf '%s ' "${n:-0}"
  done
}
check "the calibrate command runs harvest, ready, bench on the cap and calibrate, in that order" "yes" \
  "$(read -r a b c d <<< "$(cal_order "$CALCMD")"; [ "$a" -gt 0 ] && [ "$a" -lt "$b" ] && [ "$b" -lt "$c" ] && [ "$c" -lt "$d" ] && echo yes || echo no)"
check "the calibrate command refuses without a cap and never picks one" "yes" \
  "$(spells "$CALCMD" '**No cap given, the command refuses and asks the operator for one: it never picks a cap itself**')"
check "the calibrate command stops at the first failure and checks the judge's tier and the manifest's tests" "yes|yes|yes" \
  "$(spells "$CALCMD" 'A non-zero exit is a failure')|$(spells "$CALCMD" '`bench` refuses a run with the `deep` tier unbound')|$(spells "$CALCMD" 'because `ready` and `bench` both refuse such a manifest')"
check "the calibrate command runs neither generalize nor export, and leaves them to the operator" "0|yes" \
  "$(grep -cE 'routing\.py (generalize|export)' "$CALCMD")|$(spells "$CALCMD" '**`generalize` and `export` are not run by this command.**')"
check "the README, the routing skill and the calibration reference name the calibrate command" "yes|yes|yes" \
  "$(spells "$ROOT/README.md" '| `/orchestrator-calibrate` |')|$(spells "$MR" '`/orchestrator-calibrate <checkout> --max-usd <cap> --class <class> --pr <n>...` does it')|$(spells "$MRC" '`/orchestrator-calibrate` runs sections 1 to 5')"
check "the routing skill no longer says no command does the calibration" "no" \
  "$(spells "$MR" 'No command or wrapper does it')"
check "the rulebook no longer orders a routine idle-notice subscription after each message" "0|yes" \
  "$(grep -c 'notify_when_idle' "$ROOT/skills/orchestrator/SKILL.md")|$(spells "$ROOT/skills/orchestrator/SKILL.md" 'once re-instantiated, your first message re-announces your new address to every running agent')"

# §65: a launched session is given a lean tool set, by role, and the spawn can change it.
# `--disallowedTools` takes several values like `--mcp-config`, so it sits before another
# option; the roles read their title.
LEANSTATE="$WORK/leanstate"; mkdir -p "$LEANSTATE/chains"
lean() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$LEANSTATE" bash "$AGENT" spawn --dir "$WORK" --prompt p "$@" 2>&1; }
leanl() { lean "$@" | sed -n 's/^launch=//p'; }
# The words between --disallowedTools and the next option, one line.
leanset() { perl -ne 'print "$1\n" if / --disallowedTools (.*?) --(?:strict-mcp-config|mcp-config|permission-mode) /'; }
leansettings() { sed -n "s/.* --settings '\([^']*\)'.*/\1/p"; }
LEANBASE="Artifact SendFeedback Workflow ScheduleWakeup ReportFindings"
LEANMOVE="mcp__orchestrator__move_send mcp__orchestrator__move_probe mcp__orchestrator__end_session"
check "an agent loses the five unused tools and the three that move an orchestrator" "$LEANBASE $LEANMOVE" \
  "$(leanl --title 'Agent : x' | leanset)"
check "an orchestrator loses the five and keeps the three" "$LEANBASE" \
  "$(leanl --title 'Orch : x' | leanset)"
check "a title of no role is read as an agent's: it loses all eight" "$LEANBASE $LEANMOVE" \
  "$(leanl --title-free --title probe | leanset)"
check "an auditor loses all eight" "$LEANBASE $LEANMOVE" \
  "$(audl --auditor --title 'Audit : tm' | leanset)"
check "the coordinator's successor keeps the three" "$LEANBASE" \
  "$(crdl --coordinator-successor --title 'Coord : ops' | leanset)"
check "a successor keeps the three, as an orchestrator does" "$LEANBASE" \
  "$(succ "$PSTAB" --successor | sed -n 's/^launch=//p' | leanset)"
check "a woken orchestrator and an opened one keep the three" "$LEANBASE|$LEANBASE" \
  "$(crdl --wake --title 'Orch : alpha' --model a-model | leanset)|$(opn 'Coord : ops' --open --title 'Orch : sync logs' | sed -n 's/^launch=//p' | leanset)"
check "the removed set is the dry run's too, and Artifact is never switched off by the host's own setting" "1|0" \
  "$(lean --title 'Orch : x' | grep -c '^tools_removed=Artifact,SendFeedback,Workflow,ScheduleWakeup,ReportFindings$')|$(leanl --title 'Agent : x' | grep -c enableArtifact)"
check "the removed set is followed by another option and comes before --permission-mode: never last, never next to the prompt" "1|1|0" \
  "$(leanl --title 'Agent : x' | grep -c -- '--disallowedTools [^-].* --permission-mode ')|$(leanl --title 'Agent : x' | leanset | grep -c .)|$(leanl --title 'Agent : x' | grep -c -- '--disallowedTools [^-]* "\$(cat ')"
check "with a server file the removed set comes first and the pair is still closed by the mode" "1" \
  "$(mcpd | sed -n 's/^launch=//p' | grep -c -- '--disallowedTools Artifact .* --strict-mcp-config --mcp-config [^ ]* --permission-mode ')"
check "with the account's connectors the removed set is followed by the mode" "1" \
  "$(mcpd --account-connectors --mcp none | sed -n 's/^launch=//p' | grep -c -- '--disallowedTools Artifact .* ReportFindings .* --permission-mode ')"

# The two options.
check "--keep-tool Artifact takes it out of the removed set" "SendFeedback Workflow ScheduleWakeup ReportFindings $LEANMOVE" \
  "$(leanl --title 'Agent : x' --keep-tool Artifact | leanset)"
check "--drop-tool adds any name, once, after the defaults" "$LEANBASE $LEANMOVE 'Bash(git push:*)'" \
  "$(leanl --title 'Agent : x' --drop-tool 'Bash(git push:*)' --drop-tool Artifact | leanset)"
check "--drop-tool given the same name twice removes it once, on the launch line and in the dry run" "$LEANBASE $LEANMOVE WebSearch|1" \
  "$(leanl --title 'Agent : x' --drop-tool WebSearch --drop-tool WebSearch | leanset)|$(lean --title 'Agent : x' --drop-tool WebSearch --drop-tool WebSearch | sed -n 's/^tools_removed=//p' | tr ',' '\n' | grep -c '^WebSearch$')"
check "--keep-tool of a name the default keeps is harmless, and the options repeat" "SendFeedback Workflow ScheduleWakeup ReportFindings $LEANMOVE WebSearch" \
  "$(leanl --title 'Agent : x' --keep-tool Artifact --keep-tool Bash --drop-tool WebSearch | leanset)"
check "--drop-tool on a name the role keeps removes it" "$LEANBASE mcp__orchestrator__end_session" \
  "$(leanl --title 'Orch : x' --drop-tool mcp__orchestrator__end_session | leanset)"
check "a spawn that keeps every default removes no tool, and the option is then left out" "0|none" \
  "$(leanl --title 'Orch : x' --keep-tool Artifact --keep-tool SendFeedback --keep-tool Workflow --keep-tool ScheduleWakeup --keep-tool ReportFindings | grep -c -- '--disallowedTools')|$(lean --title 'Orch : x' --keep-tool Artifact --keep-tool SendFeedback --keep-tool Workflow --keep-tool ScheduleWakeup --keep-tool ReportFindings | sed -n 's/^tools_removed=//p')"
check "an empty name is refused for either option, before any tab exists" "1|1|1|1" \
  "$(lean --title 'Agent : x' --keep-tool '' >/dev/null 2>&1; echo $?)|$(lean --title 'Agent : x' --drop-tool '  ' >/dev/null 2>&1; echo $?)|$(lean --title 'Agent : x' --keep-tool '' | grep -c -- '--keep-tool needs a tool name')|$(lean --title 'Agent : x' --drop-tool '' | grep -c -- '--drop-tool needs a tool name')"
check "the same name on both options is refused, and the refusal names it" "1|1" \
  "$(lean --title 'Agent : x' --keep-tool Artifact --drop-tool Artifact >/dev/null 2>&1; echo $?)|$(lean --title 'Agent : x' --keep-tool Artifact --drop-tool Artifact | grep -c "'Artifact' is given to both --keep-tool and --drop-tool")"
check "a name with surrounding whitespace is read without it, for either option, and a padded repeat is one name" "SendFeedback Workflow ScheduleWakeup ReportFindings $LEANMOVE|$LEANBASE $LEANMOVE WebSearch|$LEANBASE $LEANMOVE WebSearch" \
  "$(leanl --title 'Agent : x' --keep-tool 'Artifact ' | leanset)|$(leanl --title 'Agent : x' --drop-tool $'\tWebSearch ' | leanset)|$(leanl --title 'Agent : x' --drop-tool 'WebSearch ' --drop-tool ' WebSearch' | leanset)"
check "the same name on both options is refused whatever its padding" "1|1" \
  "$(lean --title 'Agent : x' --keep-tool 'Artifact ' --drop-tool Artifact >/dev/null 2>&1; echo $?)|$(lean --title 'Agent : x' --keep-tool Artifact --drop-tool ' Artifact' | grep -c "'Artifact' is given to both --keep-tool and --drop-tool")"
check "every launch path honours them: successor, wake, open, auditor, coordinator-successor" "1|1|1|1|1" \
  "$(succ "$PSTAB" --successor --keep-tool Artifact | sed -n 's/^launch=//p' | leanset | grep -c '^SendFeedback Workflow ScheduleWakeup ReportFindings$')|$(crdl --wake --title 'Orch : alpha' --model a-model --keep-tool Artifact | leanset | grep -c '^SendFeedback ')|$(opn 'Coord : ops' --open --title 'Orch : sync logs' --keep-tool Artifact | sed -n 's/^launch=//p' | leanset | grep -c '^SendFeedback ')|$(audl --auditor --title 'Audit : tm' --keep-tool Artifact | leanset | grep -c '^SendFeedback ')|$(crdl --coordinator-successor --title 'Coord : ops' --keep-tool Artifact --drop-tool WebSearch | leanset | grep -c '^SendFeedback Workflow ScheduleWakeup ReportFindings WebSearch$')"
LEANPS="$WORK/ps-lean.txt"
printf '/dev/ttys901 /opt/x/claude --name Agent : x\n' > "$LEANPS"
leanrot() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$LEANSTATE" ORCHESTRATOR_PS_TABLE="$LEANPS" \
  bash "$AGENT" rotate --dir "$WORK" --title "Agent : rotated" --prompt p "$@" 2>&1; }
check "rotate passes both options to the replacement it launches" "1|1" \
  "$(leanrot --old-tty /dev/ttys901 --keep-tool Artifact --drop-tool WebSearch | sed -n 's/^launch=//p' | leanset | grep -c '^SendFeedback Workflow ScheduleWakeup ReportFindings .* WebSearch$')|$(leanrot --old-tty /dev/ttys901 --keep-tool Artifact | sed -n 's/^launch=//p' | grep -c -- '--name .Agent : rotated.')"
check "rotate refuses an empty name and the same name on both, before it spawns anything" "1|1" \
  "$(leanrot --old-tty /dev/ttys901 --keep-tool '' >/dev/null 2>&1; echo $?)|$(leanrot --old-tty /dev/ttys901 --keep-tool X --drop-tool X >/dev/null 2>&1; echo $?)"
check "rotate reads a padded name without its padding" "SendFeedback Workflow ScheduleWakeup ReportFindings $LEANMOVE" \
  "$(leanrot --old-tty /dev/ttys901 --keep-tool 'Artifact ' | sed -n 's/^launch=//p' | leanset)"

# The host cuts, in the one --settings the launch carries. A cut a probe did not prove is not
# listed here (§65).
check "an agent's settings cut the synced skills, the recap, the countdown and the silent-turn reminder" '{"remoteControlAtStartup":false,"syncClaudeAiSkills":false,"awaySummaryEnabled":false,"env":{"CLAUDE_CODE_TOTAL_TOKENS_REMINDER":"off","CLAUDE_CODE_SILENT_TURN_REMINDER":"0","CLAUDE_CODE_AUTO_COMPACT_WINDOW":"300000"}}' \
  "$(leanl --title 'Agent : x' | leansettings)"
check "an agent's settings carry the 300000 compaction window, and no switch for the 1M window" "1|0" \
  "$(leanl --title 'Agent : x' | leansettings | grep -Fc '"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"300000"')|$(leanl --title 'Agent : x' | grep -c 'DISABLE_1M_CONTEXT')"
check "an orchestrator, a successor and a coordinator's successor carry the 400000 compaction window, an auditor none" "1|1|0|1" \
  "$(leanl --title 'Orch : x' | grep -Fc '"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"400000"')|$(succ "$PSTAB" --successor | grep -Fc '"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"400000"')|$(audl --auditor --title 'Audit : tm' | grep -c 'AUTO_COMPACT_WINDOW')|$(crdl --coordinator-successor --title 'Coord : ops' | grep -Fc '"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"400000"')"
check "an orchestrator exports a 75 percent gate, an agent and an auditor none" "1|0|0" \
  "$(gspawn --title 'Orch : gate' --prompt p | grep -c '^launch=.*export ORCHESTRATOR_CONTEXT_GATE=75 && ')|$(gspawn --prompt p | grep -c 'ORCHESTRATOR_CONTEXT_GATE=')|$(gspawn --title 'Audit : gate' --auditor --prompt p | grep -c 'ORCHESTRATOR_CONTEXT_GATE=')"
check "a successor and a coordinator's successor export the 75 percent gate" "1|1" \
  "$(succ "$PSTAB" --successor | grep -c '^launch=.*export ORCHESTRATOR_CONTEXT_GATE=75 && ')|$(crdl --coordinator-successor --title 'Coord : ops' | grep -c 'export ORCHESTRATOR_CONTEXT_GATE=75 && ')"
check "an orchestrator's settings cut the synced skills and the countdown, and compact at 400000" '{"remoteControlAtStartup":false,"syncClaudeAiSkills":false,"env":{"CLAUDE_CODE_TOTAL_TOKENS_REMINDER":"off","CLAUDE_CODE_AUTO_COMPACT_WINDOW":"400000"}}' \
  "$(leanl --title 'Orch : x' | leansettings)"
check "a successor, an auditor and the coordinator's successor carry the cuts and no setting for remote control" '{"syncClaudeAiSkills":false,"env":{"CLAUDE_CODE_TOTAL_TOKENS_REMINDER":"off","CLAUDE_CODE_AUTO_COMPACT_WINDOW":"400000"}}|{"syncClaudeAiSkills":false,"env":{"CLAUDE_CODE_TOTAL_TOKENS_REMINDER":"off"}}|{"syncClaudeAiSkills":false,"env":{"CLAUDE_CODE_TOTAL_TOKENS_REMINDER":"off","CLAUDE_CODE_AUTO_COMPACT_WINDOW":"400000"}}' \
  "$(succ "$PSTAB" --successor | sed -n 's/^launch=//p' | leansettings)|$(audl --auditor --title 'Audit : tm' | leansettings)|$(crdl --coordinator-successor --title 'Coord : ops' | leansettings)"
check "the settings key for the host's own artifact switch is never passed, whatever the role" "0|0|0" \
  "$(leanl --title 'Agent : x' --keep-tool Artifact | grep -c enableArtifact)|$(leanl --title 'Orch : x' | grep -c enableArtifact)|$(audl --auditor --title 'Audit : tm' | grep -c enableArtifact)"
check "--account-connectors still merges into the same JSON, before the cuts" '{"remoteControlAtStartup":false,"enableAllProjectMcpServers":true,"syncClaudeAiSkills":false,"awaySummaryEnabled":false,"env":{"CLAUDE_CODE_TOTAL_TOKENS_REMINDER":"off","CLAUDE_CODE_SILENT_TURN_REMINDER":"0","CLAUDE_CODE_AUTO_COMPACT_WINDOW":"300000"}}' \
  "$(mcpd --account-connectors | sed -n 's/^launch=//p' | leansettings)"

check "--keep-synced-skills leaves the synced skills in, for any role, and the dry run says which" '{"remoteControlAtStartup":false,"awaySummaryEnabled":false,"env":{"CLAUDE_CODE_TOTAL_TOKENS_REMINDER":"off","CLAUDE_CODE_SILENT_TURN_REMINDER":"0","CLAUDE_CODE_AUTO_COMPACT_WINDOW":"300000"}}|{"env":{"CLAUDE_CODE_TOTAL_TOKENS_REMINDER":"off"}}|kept|removed' \
  "$(leanl --title 'Agent : x' --keep-synced-skills | leansettings)|$(audl --auditor --title 'Audit : tm' --keep-synced-skills | leansettings)|$(lean --title 'Agent : x' --keep-synced-skills | sed -n 's/^synced_skills=//p')|$(lean --title 'Agent : x' | sed -n 's/^synced_skills=//p')"
# The launch line first: a rotation that refused the option prints none, and a count of
# zero on an empty output would pass.
check "rotate forwards --keep-synced-skills to the replacement" "1|0" \
  "$(leanrot --old-tty /dev/ttys901 --keep-synced-skills | grep -c '^launch=')|$(leanrot --old-tty /dev/ttys901 --keep-synced-skills | sed -n 's/^launch=//p' | grep -c syncClaudeAiSkills)"

# The synced-skills key hides them for ONE invocation when it travels in that session's own
# --settings; in the operator's user settings the same key makes the host move the synced
# directory to the trash. So the launcher writes it nowhere but the launch line.
LEANCFG="$WORK/leancfg"; mkdir -p "$LEANCFG"
printf '{"model":"a-model"}\n' > "$LEANCFG/settings.json"; printf '{"x":1}\n' > "$LEANCFG/settings.local.json"
LEANSUM=$(cat "$LEANCFG"/settings*.json | cksum)
LEANRUN=$(CLAUDE_CONFIG_DIR="$LEANCFG" HOME="$LEANCFG" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$LEANSTATE" bash "$AGENT" spawn --dir "$WORK" --title 'Agent : x' --prompt p 2>&1)
check "the key appears once in a spawn's output, inside the --settings of the launch" "1|1" \
  "$(printf '%s\n' "$LEANRUN" | grep -c syncClaudeAiSkills)|$(printf '%s\n' "$LEANRUN" | sed -n 's/^launch=//p' | grep -c -- "--settings '[^']*syncClaudeAiSkills\":false")"
check "and no settings file is written by it, the config directory and the state directory included" "$LEANSUM|0" \
  "$(cat "$LEANCFG"/settings*.json | cksum)|$(grep -rl syncClaudeAiSkills "$LEANCFG" "$LEANSTATE" 2>/dev/null | wc -l | tr -d ' ')"
check "no script, hook, command or template of the plugin writes the key but the launcher's launch line" "skills/iterm-agents/scripts/iterm_agent.py" \
  "$(cd "$ROOT" && grep -rl --exclude-dir=__pycache__ syncClaudeAiSkills skills hooks commands templates install.sh .claude-plugin 2>/dev/null | grep -v '\.md$' | sort | tr '\n' ' ' | sed 's/ $//')"

# `tools`: what a session on this machine is given, from a transcript.
TOOLSPROJ="$WORK/toolsproj"; mkdir -p "$TOOLSPROJ/-w-x"
TOOLSTR="$TOOLSPROJ/-w-x/s-tools.jsonl"
"$py" - "$TOOLSTR" <<'PYEOF'
import json, sys
def att(**a):
    return json.dumps({"type": "attachment", "attachment": a}, ensure_ascii=False)
tools = [{"name": "Bash", "description": "run", "schema": {}},
         {"name": "Artifact", "description": "x" * 200, "schema": {}},
         {"name": "mcp__orchestrator__move_send", "description": "move", "schema": {}}]
lines = [
    att(type="prompt_snapshot", systemPrompt=["s"]),
    att(type="prompt_snapshot", systemPrompt=["s"], tools=tools),
    att(type="deferred_tools_delta", addedNames=["CronCreate", "Workflow"], removedNames=[]),
    att(type="skill_listing", content="- alpha: first skill\n- plug:beta: second: skill\nwith two lines\n- anthropic-skills:pdf: pdf work\n", names=["alpha", "plug:beta", "anthropic-skills:pdf"]),
    att(type="agent_listing_delta", addedTypes=["Explore"], addedLines=["- Explore: read-only search agent"]),
    att(type="mcp_instructions_delta", addedNames=["a"], addedBlocks=["## a\nServer a instructions."]),
]
open(sys.argv[1], "w").write("\n".join(lines) + "\n")
PYEOF
toolsx() { ORCHESTRATOR_STATE_DIR="$WORK/toolsstate" ORCHESTRATOR_MCP_CATALOGUE="$CAT" ORCHESTRATOR_PROJECTS_DIR="$TOOLSPROJ" bash "$AGENT" tools "$@" 2>&1; }
TOOLSOUT=$(toolsx --transcript "$TOOLSTR")
BASHCHARS=$("$py" -c "import json; print(len(json.dumps({'name': 'Bash', 'description': 'run', 'schema': {}})))")
ARTCHARS=$("$py" -c "import json; print(len(json.dumps({'name': 'Artifact', 'description': 'x' * 200, 'schema': {}})))")
check "a loaded tool is one row: kind, name, characters, tokens at 0.2215 each, and the roles that lose it" "loaded | Bash | $BASHCHARS | $("$py" -c "print(int(round($BASHCHARS * 0.2215)))") | -" \
  "$(printf '%s\n' "$TOOLSOUT" | grep '^loaded | Bash ')"
check "the heaviest loaded tool comes first, with every role that loses it" "loaded | Artifact | $ARTCHARS | $("$py" -c "print(int(round($ARTCHARS * 0.2215)))") | Orch,Coord,Audit,Agent" \
  "$(printf '%s\n' "$TOOLSOUT" | grep '^loaded' | head -1)"
check "a move tool names the two roles whose default removes it" "1" \
  "$(printf '%s\n' "$TOOLSOUT" | grep -c '^loaded | mcp__orchestrator__move_send | [0-9]* | [0-9]* | Audit,Agent$')"
check "a removed name the transcript lacks is listed with ? for what it cannot say" "loaded | SendFeedback | ? | ? | Orch,Coord,Audit,Agent|loaded | mcp__orchestrator__end_session | ? | ? | Audit,Agent" \
  "$(printf '%s\n' "$TOOLSOUT" | grep '^loaded | SendFeedback ')|$(printf '%s\n' "$TOOLSOUT" | grep '^loaded | mcp__orchestrator__end_session ')"
check "a removed name that is deferred stays a deferred row, with its roles, and is not listed twice" "deferred | Workflow | 8 | 2 | Orch,Coord,Audit,Agent|0" \
  "$(printf '%s\n' "$TOOLSOUT" | grep '^deferred | Workflow ')|$(printf '%s\n' "$TOOLSOUT" | grep -c '^loaded | Workflow ')"
check "a deferred name that is not removed shows no role" "deferred | CronCreate | 10 | 2 | -" \
  "$(printf '%s\n' "$TOOLSOUT" | grep '^deferred | CronCreate ')"
check "a skill is one row whatever its prefix, with the lines of its description" "1|1" \
  "$(printf '%s\n' "$TOOLSOUT" | grep -c '^skills | plug:beta | 42 | 9 | -$')|$(printf '%s\n' "$TOOLSOUT" | grep -c '^skills | alpha | 21 | 5 | -$')"
check "a synced skill names every role: the launch removes them all" "1" \
  "$(printf '%s\n' "$TOOLSOUT" | grep -c '^skills | anthropic-skills:pdf | [0-9]* | [0-9]* | Orch,Coord,Audit,Agent$')"
check "an agent type is one row" "1" "$(printf '%s\n' "$TOOLSOUT" | grep -c '^agent-types | Explore | 33 | 7 | -$')"
check "the catalogue's servers are listed, the default first; the size is the transcript's or ?" "mcp | a | 27 | 6 | -|mcp | b | ? | ? | -" \
  "$(printf '%s\n' "$TOOLSOUT" | grep '^mcp | a ')|$(printf '%s\n' "$TOOLSOUT" | grep '^mcp | b ')"
check "every row has five fields" "0" "$(printf '%s\n' "$TOOLSOUT" | awk -F' [|] ' 'NF != 5' | wc -l | tr -d ' ')"
check "no catalogue lists no server and says nothing" "0" \
  "$(ORCHESTRATOR_STATE_DIR="$WORK/toolsstate" ORCHESTRATOR_MCP_CATALOGUE="$NOCAT" bash "$AGENT" tools --transcript "$TOOLSTR" 2>&1 | grep -c '^mcp')"
check "the caller's own transcript is found by the session id the host sets" "$TOOLSOUT" \
  "$(CLAUDE_CODE_SESSION_ID=s-tools toolsx)"
check "no session id and no --transcript is refused, naming both ways out" "1|1" \
  "$(env -u CLAUDE_CODE_SESSION_ID ORCHESTRATOR_STATE_DIR="$WORK/toolsstate" bash "$AGENT" tools >/dev/null 2>&1; echo $?)|$(env -u CLAUDE_CODE_SESSION_ID ORCHESTRATOR_STATE_DIR="$WORK/toolsstate" bash "$AGENT" tools 2>&1 | grep -c 'CLAUDE_CODE_SESSION_ID is unset; pass --transcript <path>')"
check "a session with no transcript and a missing file are each refused" "1|1" \
  "$(CLAUDE_CODE_SESSION_ID=s-none toolsx | grep -c 'tools: no transcript for session s-none')|$(toolsx --transcript "$WORK/absent.jsonl" | grep -c 'tools: transcript not found')"

# The agent's orchestrator may hand over: the agent admits the successor its orchestrator names,
# and the predecessor names it to each agent before « handed over ».
ADMIT='When it hands over, it first sends you its successor'"'"'s exact name and reference; from then on that session is your orchestrator, with no other confirmation. A session claiming to succeed it before that message waits for its word.'
for t in phase review comments rotation; do
  check "the $t brief admits the successor its orchestrator names" "yes" "$(flat_has "$ROOT/templates/agent-$t-brief.md" "$ADMIT")"
  check "the $t brief no longer refuses whatever a session says, nor every session but one" "0" "$(grep -c -e 'whatever it says' -e 'no other session' -e '— and no other' "$ROOT/templates/agent-$t-brief.md")"
done
spells_before() { case "$1" in *"$2"*) ;; *) echo no; return ;; esac; local head="${1%%"$2"*}"; case "$head" in *"$3"*) echo yes ;; *) echo no ;; esac; }
SUCCEEDMD="$ROOT/commands/succeed.md"
SUCCEEDFLAT=$(tr '\n' ' ' < "$SUCCEEDMD" | tr -s ' ')
check "succeed.md has the predecessor name its successor to each agent, before the wait for « takeover confirmed »" "yes|yes" \
  "$(printf '%s' "$SUCCEEDFLAT" | grep -qF "send each running agent of your own ONE message giving the successor's exact name and reference" && echo yes || echo no)|$(spells_before "$SUCCEEDFLAT" 'Wait for the successor' 'ONE message giving the successor')"
check "lifecycle.md and SKILL.md say the predecessor names its successor to its agents" "yes|yes" \
  "$(flat_has "$ROOT/skills/orchestrator/references/lifecycle.md" "gives its successor's exact name and reference to each of its agents")|$(flat_has "$ROOT/skills/orchestrator/SKILL.md" "ONE message giving its exact name and reference")"
check "the successor names its predecessor in its message to the agents" "1" \
  "$(succ3_has "and your predecessor's,")"
check "the design says the agents learn their new orchestrator from their current one" "yes" \
  "$(flat_has "$ROOT/docs/design.md" "the agents learn their new orchestrator from their current one")"

# The review lenses run as a dedicated read-only subagent type: a lens needs to read and to run
# git, and a type that lists only those tools starts about 35,000 tokens lighter than the
# general-purpose one that carries every tool of the session. It names no model, so the tier the
# review brief gives is the one it runs at.
LENS="$ROOT/agents/lens.md"
check "the lens agent lists exactly four read tools and names no model" "yes|1|0" \
  "$([ -f "$LENS" ] && echo yes || echo no)|$(grep -cx 'tools: Read, Grep, Glob, Bash' "$LENS" 2>/dev/null)|$(grep -c '^model:' "$LENS" 2>/dev/null)"
check "the lens agent is named lens" "1" "$(grep -cx 'name: lens' "$LENS" 2>/dev/null)"
check "the review brief dispatches each lens as the subagent type orchestrator:lens" "yes" \
  "$(spells "$ROOT/templates/agent-review-brief.md" 'one read-only sub-agent of the type `orchestrator:lens` per lens')"
check "the routing table, the review reference and the design name the lens type" "yes|yes|yes" \
  "$(flat_has "$ROOT/skills/model-routing/SKILL.md" '`orchestrator:lens`')|$(flat_has "$ROOT/skills/orchestrator/references/review.md" '`orchestrator:lens`')|$(flat_has "$ROOT/docs/design.md" '`orchestrator:lens`')"

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
