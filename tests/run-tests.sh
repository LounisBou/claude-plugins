#!/bin/bash
# Test suite. No network, no terminal automation, isolated HOME per case.
#
# Each case runs a script against a temporary state directory or a temporary
# HOME and compares its output or its side effects with an expected value.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
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

echo "== repository policy =="

# The product name appears only in load-bearing identifiers: host paths, host
# environment variables, the plugin name and the manifest directory.
#
# The grep runs from INSIDE the repository, on a relative path. With an absolute one,
# every result line carried `/…/claude-orchestrator/…` in its own path and the exemption
# for the plugin's name deleted the whole line whatever it said: this check reported a
# clean repository for its entire life without ever reading a single file. Two files are
# excluded because they QUOTE the pattern they are searched for.
policy_hits() {
  ( cd "$ROOT" && grep -rniI 'claude' . --exclude-dir=.git --exclude-dir=.claude --exclude-dir=plans \
      --exclude=plan.md --exclude=CLAUDE.md --exclude=run-tests.sh \
    | grep -viE '~/\.claude/|\$HOME/\.claude|CLAUDE_CONFIG_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_CODE_SESSION_ID|ORCHESTRATOR_HOST_CLI|claude-orchestrator|\.claude-plugin|/\.claude/|\.claude\.json' || true )
}
check "no product name in prose" "" "$(policy_hits)"

# And the guard proves it can still SEE one. A file planted with a violation must show up
# in the very same function: "no hits" means nothing until "hits would have shown" is
# established. This is the check that would have caught the hole above on the day it
# appeared, instead of years later by hand.
PROBE="$ROOT/.policy-probe-$$.md"
trap 'rm -rf "$WORK"; rm -f "$PROBE"' EXIT
printf 'PRODUCT NAME IN PROSE\n' | sed 's/PRODUCT NAME/Claude/' > "$PROBE"
seen=$(policy_hits | grep -c 'policy-probe' || true)
rm -f "$PROBE"
check "the policy guard can see a violation" "1" "$seen"

# The tiers exist so no model family name has to appear here. The grep above looks for
# the host's name only, and would never have caught the identifier the launcher carried.
# `run-tests.sh` and the plan document are excluded because they QUOTE this deny-list;
# everything else in the repository is held to it.
hits=$(grep -rniIE '\b(opus|sonnet|haiku)\b' "$ROOT" --exclude-dir=.git --exclude-dir=.claude --exclude-dir=plans \
  --exclude=plan.md --exclude=CLAUDE.md --exclude=run-tests.sh || true)
check "no model family name in the plugin" "" "$hits"

# Nothing tied to one machine or one project enters the generic plugin: no
# absolute home path, no real session reference (the documented example is
# the six-hex placeholder a1b2c3), no path into a downstream project's tree.
hits=$(grep -rnIE '/Users/|/home/[a-z]|\[[0-9a-f]{6}\]|docs/reference/|BUGS\.md|IMPLEMENTATION\.md' "$ROOT" --exclude-dir=.git --exclude=.git --exclude-dir=.claude --exclude=plan.md --exclude=run-tests.sh \
  | grep -vE '\[a1b2c3\]' || true)
check "nothing project- or machine-specific in the plugin" "" "$hits"

# The namespace is the plugin's name, `orchestrator`: commands and skills are
# reached as /orchestrator:* and orchestrator:*. The former prefix must not
# come back in prose, or half the references resolve and half do not.
hits=$(grep -rnI 'claude-orchestrator:' "$ROOT" --exclude-dir=.git --exclude=run-tests.sh || true)
check "the old command namespace is gone" "" "$hits"
check "the plugin is named orchestrator" "orchestrator" "$(jq -r .name "$ROOT/.claude-plugin/plugin.json")"

# A spawned session inherits a decision mode: the command line the script types
# carries --permission-mode, defaulting to auto, on spawn and on rotate.
check "the succession brief closes the predecessor's tab" "1" "$(grep -c 'CLOSE ITS TAB' "$ROOT/templates/orchestrator-succession-brief.md")"
check "the decide command asks one question per message" "1" "$(grep -c 'one question per message' "$ROOT/commands/decide.md")"
check "the decide command re-presents an interrupted question in full" "1" "$(grep -c 'IN FULL when you return' "$ROOT/commands/decide.md")"
check "the decide command records before it moves on" "1" "$(grep -c 'Present the next question IN FULL (step 2). Not before.' "$ROOT/commands/decide.md")"
check "the succession inherits the orchestrator's model" "1" "$(grep -c -- '--inherit-model' "$ROOT/commands/succeed.md")"
check "the succession names no tier" "0" "$(grep -c -- '--tier deep' "$ROOT/commands/succeed.md")"
# The successor is spawned with --successor, everywhere the succession is described (§34);
# the two sentences that promised a placement the launcher did not make are gone.
check "the succession spawns with --successor" "yes|0" \
  "$(grep -q -- '--successor' "$ROOT/commands/succeed.md" && echo yes || echo no)|$(grep -c -- '--left-of <implementer tty>' "$ROOT/commands/succeed.md")"
# The succession stops asking for a typed title where the derivation exists: a successor
# carries the predecessor's own name, and a typed one is how the house format went missing
# from a listing (§39). The tab skill's rotate line names --trust, which it never did while
# a live rotation into a fresh checkout was being refused on the trust question.
check "the succession types no title" "0" "$(grep -c -- '--title' "$ROOT/commands/succeed.md")"
check "the succession says where the successor's name comes from" "1" \
  "$(grep -c "takes THIS session's own name" "$ROOT/commands/succeed.md")"
check "the tab skill's rotation line forwards the trust flag" "1" \
  "$(grep -c -- 'rotate --dir <workdir> --old-tty <tty> \[--trust\] \[--tier <tier>\]' "$ROOT/skills/iterm-agents/SKILL.md")"
check "the tab skill spawns the successor the same way" "1|0" \
  "$(grep -c 'spawning your successor: `--successor`' "$ROOT/skills/iterm-agents/SKILL.md")|$(grep -c 'sits between you and your agent' "$ROOT/skills/iterm-agents/SKILL.md")"
check "and so does the rulebook" "1|0" \
  "$(grep -c 'passing `--successor`' "$ROOT/skills/orchestrator/SKILL.md")|$(grep -c 'lands between you and your agent' "$ROOT/skills/orchestrator/SKILL.md")"
# A plan-writing skill's header ordered the orchestrator to execute in subagents of its own
# session, and successors obeyed it (§28). No plan opens with it; the rulebook and the
# succession template carry the rule instead.
check "no plan opens with the foreign execution header" "0" "$(grep -l '^> \*\*For agentic workers' "$ROOT"/docs/superpowers/plans/*.md | wc -l | tr -d ' ')"
check "the rulebook forbids implementing through a subagent of its own" "1" "$(grep -c 'never implements through a subagent of its own' "$ROOT/skills/orchestrator/SKILL.md")"
check "the succession template forbids it too" "1" "$(grep -c 'not through a subagent of your own session either' "$ROOT/templates/orchestrator-succession-brief.md")"

# Review rounds run in sessions spawned for the round and closed when it is judged:
# the rulebook names the mode, both briefs exist, and neither lets its session push.
check "the rulebook runs review rounds in disposable sessions" "1" "$(grep -c '^## Review rounds run in disposable sessions' "$ROOT/skills/orchestrator/SKILL.md")"
check "the review brief forbids writing" "1" "$(grep -c 'You write nothing and post nothing' "$ROOT/templates/agent-review-brief.md")"
check "the comments brief forbids pushing" "1" "$(grep -c 'Never push' "$ROOT/templates/agent-comments-brief.md")"

# A plain spawn appends at the END of the window, not beside the caller — an agent
# once landed two tabs from its orchestrator with a stranger's session between them.
# So placement anchors on a tty or on `self`, the caller's own tab, and the docs say
# to name one rather than trusting the default position.
# Named in full: the bare phrase now appears twice (the anchors, and --tier against
# --model), and a guard that counts an unrelated message is green over nothing.
# Crossing the anchor shifts it by one, so the move count differs per side. The first
# --right-of implementation computed zero moves and the AppleScript verification caught
# it live: the counts are pinned here so the asymmetry cannot be "simplified" away.

# A round's wall clock is the cold start, the gate and the round trips — never bought
# back by shortening the verification. The three levers and their counterweight are
# pinned so a later edit cannot quietly drop the gate rule while keeping the speed one.
check "the rulebook prices a round" "1" "$(grep -c '^### The cost of a round' "$ROOT/skills/orchestrator/SKILL.md")"
check "the gate overlaps the writing" "1" "$(grep -c 'starts the moment that commit lands' "$ROOT/skills/orchestrator/SKILL.md")"
check "decided items skip the assessment" "1" "$(grep -c 'DECIDED findings list' "$ROOT/skills/orchestrator/SKILL.md")"
check "speed is not bought from the gate" "1" "$(grep -c 'never gated by a scoped run' "$ROOT/skills/orchestrator/SKILL.md")"
check "the comments brief carries a decided list" "1" "$(grep -c 'DECIDED_ITEMS' "$ROOT/templates/agent-comments-brief.md")"

# Text published under the operator's name is theirs to authorise, and a thread closed
# by a change is answered by the change. Two replies once went up on an orchestrator's
# approval alone, on threads a fix had already answered.
check "outward-facing text needs the operator" "1" "$(grep -c "may draft it, never authorise it" "$ROOT/skills/orchestrator/SKILL.md")"
check "a fix answers its own thread" "1" "$(grep -c 'answered by the change' "$ROOT/skills/orchestrator/SKILL.md")"
check "the comments brief drafts nothing on a fixed thread" "1" "$(grep -c 'draft nothing and post nothing there' "$ROOT/templates/agent-comments-brief.md")"
check "the rulebook spawns beside the orchestrator" "1" "$(grep -c -- '--right-of self --title "Agent : <subject>" --prompt' "$ROOT/skills/orchestrator/SKILL.md")"

# The operator's ruling after an afternoon of pasted command lines: everything the
# orchestrator asks him to run, it can run itself; he decides, nothing else. Pinned so the
# rule cannot drift back into « hand the operator the exact line ».
check "the rulebook keeps running to the orchestrator" "1" "$(grep -c '^## The operator decides; the orchestrator runs' "$ROOT/skills/orchestrator/SKILL.md")"
check "a runnable command is the orchestrator's" "1" "$(grep -c "A command the orchestrator could run is the orchestrator's to run" "$ROOT/skills/orchestrator/SKILL.md")"

# Two readings the rulebook left open (§36): an implementer stays through the review round
# of ITS delivery and is stood down at the verdict; a reader's pinned copy is a worktree.
check "the rulebook keeps the implementer through its own review round" "1|1" \
  "$(grep -c 'stays through the review round of ITS delivery' "$ROOT/skills/orchestrator/SKILL.md")|$(grep -c 'a tab kept in case is not reuse' "$ROOT/skills/orchestrator/SKILL.md")"
check "the tab skill says the same" "1" "$(grep -c 'stood down at the verdict' "$ROOT/skills/iterm-agents/SKILL.md")"
check "the rulebook pins a reader's copy as a worktree" "1|1" \
  "$(grep -c 'never a clone: a clone is for a WRITER' "$ROOT/skills/orchestrator/SKILL.md")|$(grep -c "a reader's pinned copy is a detached worktree" "$ROOT/skills/orchestrator/SKILL.md")"
check "the review brief template pins a worktree" "1" "$(grep -c 'a detached worktree pinned at the head under review' "$ROOT/templates/agent-review-brief.md")"

# Four more readings the live rounds produced (§41): one literal guard per file.
check "the rulebook refuses a stand-down over uncommitted work" "1" \
  "$(grep -c 'a stand-down acknowledgment that reports anything uncommitted is an unfinished delivery' "$ROOT/skills/orchestrator/SKILL.md")"
check "the review brief forbids git configuration writes" "1" "$(grep -c 'no git configuration write of any kind' "$ROOT/templates/agent-review-brief.md")"
check "the review brief carries every sandbox path per call" "1" "$(grep -c 'carry every sandbox path inside each tool call' "$ROOT/templates/agent-review-brief.md")"
check "the phase brief's gauge names the installed copy" "1" "$(grep -c "the plugin's installed copy" "$ROOT/templates/agent-phase-brief.md")"
check "the review brief's gauge names the installed copy" "1" "$(grep -c "the plugin's installed copy" "$ROOT/templates/agent-review-brief.md")"
check "the comments brief's gauge names the installed copy" "1" "$(grep -c "the plugin's installed copy" "$ROOT/templates/agent-comments-brief.md")"
check "the rotation brief's gauge names the installed copy" "1" "$(grep -c "the plugin's installed copy" "$ROOT/templates/agent-rotation-brief.md")"
check "the rulebook's first instantiation carries remote control" "1" "$(grep -c -- '--remote-control "Orch : <subject>"' "$ROOT/skills/orchestrator/SKILL.md")"
check "the tab skill already reads the Chat caveat" "1" "$(grep -c 'before the session names itself' "$ROOT/skills/iterm-agents/SKILL.md")"

# The name is short and it has two roles (§42): the operator read his window and could not
# tell one agent from another, nor an agent from an orchestrator, at a glance. Every
# document the plugin ships spells the short roles and the cap on the subject; the older
# spellings survive only in the design's own record of the decision.
# Read as presence, not as a count: a document may spell a role on one line or on five,
# and a guard that pins the number breaks on a sentence that was merely rewritten.
spells() { grep -qF -- "$2" "$1" && echo yes || echo no; }
check "the rulebook spells the short roles and the cap" "yes|yes|yes" \
  "$(spells "$ROOT/skills/orchestrator/SKILL.md" 'Agent : <subject>')|$(spells "$ROOT/skills/orchestrator/SKILL.md" 'Orch : <subject>')|$(spells "$ROOT/skills/orchestrator/SKILL.md" 'at most 25 characters')"
check "the tab skill spells them and the cap too" "yes|yes|yes" \
  "$(spells "$ROOT/skills/iterm-agents/SKILL.md" 'Agent : <subject>')|$(spells "$ROOT/skills/iterm-agents/SKILL.md" 'Orch : <subject>')|$(spells "$ROOT/skills/iterm-agents/SKILL.md" 'at most 25 characters')"
check "the succession command spells the short role" "yes" \
  "$(spells "$ROOT/commands/succeed.md" 'Orch : <subject>')"
# The pattern is assembled from its two halves so this guard does not count itself. The
# directories that do not ship are dropped from the RESULT rather than from the walk: the
# platform's grep honours only one --exclude-dir, and the one that must hold is the
# repository's history. `docs/` keeps the record of the decision; `.claude/` is the
# operator's own material, briefs and command logs included, and a guard that read it
# would answer differently on every machine; a bytecode cache is a copy of a source file
# as it stood when some interpreter last read it, and one of them held this literal for
# hours after the source stopped spelling it.
older_role() { grep -rl --exclude-dir=.git -- "$1 : <$2>" "$ROOT" 2>/dev/null | grep -Evc "^$ROOT/(docs|\.claude)/|/__pycache__/"; }
check "no older role survives outside the design" "0|0|0" \
  "$(older_role Implementer phase)|$(older_role Reviewer round)|$(older_role Orchestrator feature)"
# The host names a session from its directory stem and gives the MODEL no rename, so a
# session the operator starts by hand reads as an orchestrator to no listing. The rulebook
# hands him the one line to type, once, before anything is dispatched (§42).
check "the rulebook hands the operator the rename line" "yes" \
  "$(spells "$ROOT/skills/orchestrator/SKILL.md" '/rename "Orch : <subject>"')"
# A directive that outlived its decision is worse than none: both documents told the reader
# the launch pre-approved the project's servers on the command line, which is the reverse of
# what it does now, and the observation that made that rule — an agent sat on the host's
# question about them until the owner clicked — is kept as the reason no such question may
# be left standing either way. Halves again, so the guard does not read itself.
stale_wording() { grep -rl --exclude-dir=.git -- "$1 $2" "$ROOT" 2>/dev/null | grep -Evc "^$ROOT/(docs|\.claude)/|/__pycache__/"; }
check "both documents say the launch loads no project server, and the older directive is gone" "yes|yes|0" \
  "$(spells "$ROOT/skills/orchestrator/SKILL.md" 'loads none and asks nothing about them')|$(spells "$ROOT/skills/iterm-agents/SKILL.md" 'loads none and asks nothing about them')|$(stale_wording pre-approves "the project's")"

# A brief that does not say which servers its session was given lets an agent reach for a
# browser tool it never had: the phase brief says it where it names the tier (§42).
check "the phase brief names the server flag beside the tier" "yes" \
  "$(spells "$ROOT/templates/agent-phase-brief.md" '--mcp')"

check "the rulebook pins a reader's copy through the script" "1" "$(grep -c 'workspace.sh pin <source> <round> <head>' "$ROOT/skills/orchestrator/SKILL.md")"

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
check "the local settings directory is copied" "{}" "$(cat "$C/.claude/settings.local.json" 2>/dev/null)"

# Inside the settings directory, what the exclude file names does not travel — the host
# writes its runtime block there (worktrees, checkpoints) and a whole-directory copy once
# carried 4 GB of worktrees into a checkout meant to hold a phase (§35). A pattern naming
# the directory whole is set aside: it says the directory stays out of history, which every
# copied file already does.
check "the settings directory's own files travel" "a" "$(cat "$C/.claude/agents/a.md" 2>/dev/null)"
check "what the exclude file names inside it does not" "0" "$([ -e "$C/.claude/worktrees" ] && echo 1 || echo 0)"
check "and the copy says what it skipped" "1" "$(grep -c 'settings directory (3 files, 1 skipped by the exclude file)' "$WORK/ws.err")"

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
# and holding it to one would make the check noise nobody reads.
printf '# round 2\n\nYou are the REVIEW agent for this round.\n\nYour orchestrator is `p-1 [a1b2c3]`.\n' > "$B/review.md"
check_status "a review brief is not held to the implementer sections" 0 bash "$LINT" "$B/review.md"

check_status "a brief that does not exist is an error" 1 bash "$LINT" "$B/absent.md"
check_status "no argument is an error" 1 bash "$LINT"

echo "== briefs are readable where they are read =="

# A template becomes a file a FRESH session opens and acts on. That session's shell does
# not carry the host's plugin variables: `${CLAUDE_PLUGIN_ROOT}` expands to nothing there,
# so the gauge invocation every brief carries pointed at an absolute path that cannot
# exist. Observed end to end — an agent reported it could not measure its context and
# flagged it rather than inventing a figure, which is the right behaviour against an
# instruction that was never runnable. Paths in a brief are absolute, filled by the
# orchestrator writing it.
hits=$(grep -rn 'CLAUDE_PLUGIN_ROOT' "$ROOT/templates" 2>/dev/null || true)
check "no host variable in a brief the agent must run" "" "$hits"

# And nothing that reads as a SECOND session address may sit beside the real one. The
# phase brief carried `e.g. project-70 [a1b2c3]` — guidance meant for whoever fills the
# template, delivered to the agent, inside the one rule whose point is that there is a
# single named address and no guessing.
hits=$(grep -rnE '\[[0-9a-f]{6}\]' "$ROOT/templates" 2>/dev/null || true)
check "no example session reference in a brief" "" "$hits"

echo "== design layout =="

# The design document opens with a tree of the repository. Nothing kept it honest, so it
# lost the hooks, three commands, two briefs and the test fixture while still reading as
# current to whoever opens it next — the exact shape of a directive that outlives what it
# described. Every tracked file must appear in that block; the plan and spec directories
# are excluded because they are workflow artifacts, not shipped layout.
layout=$(awk '/^## 2\. Layout/{f=1} f&&/^```$/{c++; if(c==2) exit} f&&c==1' "$ROOT/docs/design.md")
undocumented=""
for f in $(cd "$ROOT" && git ls-files | grep -vE '^docs/superpowers/|^LICENSE$|^\.gitignore$'); do
  printf '%s' "$layout" | grep -qF "$f" || undocumented="$undocumented $f"
done
check "every shipped file is in the design's layout" "" "$undocumented"

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
check "the prompt file holds the prompt byte for byte" "$prompt" "$(cat "$file")"
check "the prompt file lives under the state directory" "yes" "$([ "${file#"$ISTATE"/prompts/}" != "$file" ] && echo yes || echo "$file")"
check "the launch carries the decision mode" "1" "$(printf '%s' "$cmd" | grep -c -- '--permission-mode auto')"
check "no tier and no map: no model argument" "0" "$(printf '%s' "$cmd" | grep -c -- '--model')"
check "the launch changes into the working directory" "1" "$(printf '%s' "$cmd" | grep -c "^cd $WORK && ")"
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
shaped() { ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" "$@" 2>&1; }
check "a shaped title names the session" "1" \
  "$(shaped --title 'Agent : x' | sed -n 's/^launch=//p' | grep -c -- "--name 'Agent : x'")"
check "and so does an orchestrator's" "1" \
  "$(shaped --title 'Orch : x' | sed -n 's/^launch=//p' | grep -c -- "--name 'Orch : x'")"
check "and so does a probe's" "1" \
  "$(shaped --title 'Agent : anchor' | sed -n 's/^launch=//p' | grep -c -- "--name 'Agent : anchor'")"
check "the dry run says which name it passes" "1" "$(shaped --title 'Agent : anchor' | grep -c '^name=Agent : anchor$')"
check "a title without the shape is refused, and the reason names the shape and the cap" "1|1" \
  "$(shaped --title foo >/dev/null 2>&1; echo $?)|$(shaped --title foo | grep -c 'a title reads "Orch : <subject>" or "Agent : <subject>", the subject at most 25 characters, got .foo.')"
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

# Every launch used to carry the setting that enables all of the project's servers, so a
# fresh session never parked on the host's question about them. Measured on the operator's
# machine, that loaded a browser driver and a devtools bridge into every agent — about
# seventy megabytes each, used by none (§42). The launch carries --strict-mcp-config
# instead, so the host loads no project server and asks nothing; --mcp puts the setting
# back for the agent that drives a browser, and for nothing else.
check "a launch loads no project server, and the dry run says so" "1|0|1" \
  "$(shaped --title 'Agent : x' | sed -n 's/^launch=//p' | grep -c -- '--strict-mcp-config')|$(shaped --title 'Agent : x' | sed -n 's/^launch=//p' | grep -c -- 'enableAllProjectMcpServers')|$(shaped --title 'Agent : x' | grep -c '^mcp=no$')"
check "--mcp puts the project's servers back and drops the strict flag" "1|0|1" \
  "$(shaped --title 'Agent : x' --mcp | sed -n 's/^launch=//p' | grep -c -- '--settings .{"enableAllProjectMcpServers":true}.')|$(shaped --title 'Agent : x' --mcp | sed -n 's/^launch=//p' | grep -c -- '--strict-mcp-config')|$(shaped --title 'Agent : x' --mcp | grep -c '^mcp=yes$')"

# A successor carries the PREDECESSOR's name, read from the process table, and comes up
# under remote control: the operator drives his orchestrators from the host's remote
# client as well as from the tab, and an agent is driven by its orchestrator alone (§39).
# The table is a file here; a live run reads `ps`.
PSTAB="$WORK/ps-table.txt"
printf '/dev/ttys900 /opt/x/host --name Orch : f --permission-mode auto\n' > "$PSTAB"
PSNONAME="$WORK/ps-noname.txt"
printf '/dev/ttys900 /opt/x/host --permission-mode auto\n' > "$PSNONAME"
succ() { local t="$1"; shift; ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  ORCHESTRATOR_SELF_TTY=/dev/ttys900 ORCHESTRATOR_PS_TABLE="$t" bash "$AGENT" spawn --dir "$WORK" "$@" 2>&1; }
check "a successor with no title takes the caller's session name" "1" \
  "$(succ "$PSTAB" --successor | sed -n 's/^launch=//p' | grep -c -- "--name 'Orch : f'")"
check "and comes up under remote control, under that name" "1" \
  "$(succ "$PSTAB" --successor | sed -n 's/^launch=//p' | grep -c -- "--remote-control 'Orch : f'")"
check "--no-remote-control drops the flag and keeps the name" "0|1" \
  "$(succ "$PSTAB" --successor --no-remote-control | sed -n 's/^launch=//p' | grep -c -- '--remote-control')|$(succ "$PSTAB" --successor --no-remote-control | sed -n 's/^launch=//p' | grep -c -- "--name 'Orch : f'")"
check "a plain spawn never carries remote control" "0" \
  "$(shaped --title 'Agent : x' | sed -n 's/^launch=//p' | grep -c -- '--remote-control')"
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
check "a derived name that is a launch line is refused, and the refusal quotes 40 characters" "1|1" \
  "$(succ "$PSLONG" --successor >/dev/null 2>&1; echo $?)|$(succ "$PSLONG" --successor | grep -c "the caller's session name 'Orchestrator : $(printf 'x%.0s' $(seq 1 25))' does not read")"
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

out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : prompt" --prompt-file "$file" 2>&1)
check "--prompt-file reuses the given file" "1" "$(printf '%s' "$out" | grep -c "prompt_file=$file")"
out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Agent : prompt" 2>&1)
cmd=${out#*launch=}; cmd=${cmd%%$'\n'*}
check "no prompt: nothing appended after the server flag" "1" "$(printf '%s' "$cmd" | grep -c -- '--strict-mcp-config')"
check_status "--prompt and --prompt-file together are refused" 1 env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --prompt x --prompt-file "$file"
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
  bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent : trust" --tier deep
check "the refusal says how to proceed" "1" \
  "$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
     bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent : trust" --tier deep 2>&1 | grep -c -- '--trust')"
check_status "--trust records it and proceeds" 0 \
  env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent : trust" --tier deep --trust
check "the record now holds the directory" "true" \
  "$("$py" -c "import json,os,sys; d=json.load(open(sys.argv[1])); print(str(d['projects'].get(os.path.realpath(sys.argv[2]),{}).get('hasTrustDialogAccepted')).lower())" "$TRUSTF" "$UNTRUSTED")"
check_status "a directory already recorded needs no flag" 0 \
  env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
  bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent : trust" --tier deep
check "the record keeps owner-only permissions" "600" \
  "$(stat -f '%OLp' "$TRUSTF" 2>/dev/null || stat -c '%a' "$TRUSTF")"

# A record that already says yes is not rewritten: the host writes this file too, and a
# rewrite for nothing is a window in which one of the two loses. The fixture is written
# compact on purpose — the launcher's own writer indents, so any rewrite changes the bytes.
compact="{\"projects\":{\"$(cd "$UNTRUSTED" && pwd -P)\":{\"hasTrustDialogAccepted\":true}}}"
printf '%s' "$compact" > "$TRUSTF"
out=$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
      bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent : trust" --tier deep --trust 2>&1)
check "--trust on a recorded directory does not rewrite the record" "$compact" "$(cat "$TRUSTF")"
check "and the dry run says the record already held it" "1" "$(printf '%s' "$out" | grep -c '^trust=already$')"
check "--trust on an unrecorded directory says it recorded it" "1" \
  "$(printf '{"projects":{}}' > "$TRUSTF"; env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
     bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent : trust" --tier deep --trust 2>&1 | grep -c '^trust=recorded$')"
# A record the launcher cannot read is a gate that cannot measure: it lets the launch
# through AND says so, instead of launching past a question nobody will see.
printf '{not json' > "$WORK/trust-garbage.json"
out=$(env ORCHESTRATOR_TRUST_FILE="$WORK/trust-garbage.json" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" \
      bash "$AGENT" spawn --dir "$UNTRUSTED" --title "Agent : trust" --tier deep 2>&1); code=$?
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
# opened a tab for a tier that did not exist.
check_status "a broken map stops the spawn" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$WORK/broken.json" \
  bash "$AGENT" spawn --dir "$WORK" --tier deep

check "a missing map is an all-empty map" "" \
  "$(env ORCHESTRATOR_MODELS_MAP="$WORK/absent.json" bash "$AGENT" resolve-tier standard)"
check_status "a missing map is not an error" 0 \
  env ORCHESTRATOR_MODELS_MAP="$WORK/absent.json" bash "$AGENT" resolve-tier standard
check "resolve-tier wants exactly one tier" "ERROR: resolve-tier: exactly one tier is required (deep, standard or light)" \
  "$(bash "$AGENT" resolve-tier 2>&1)"

tcmd() {
  local out
  out=$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
    bash "$AGENT" spawn --dir "$WORK" --title "Agent : tier" "$@" 2>&1)
  out=${out#*launch=}; printf '%s' "${out%%$'\n'*}"
}
check "a bound tier is typed as the model argument" "1" "$(tcmd --tier deep | grep -c -- '--model a-model')"
check "an unbound tier types no model argument" "0" "$(tcmd --tier light | grep -c -- '--model')"
check "an explicit model is typed as given" "1" "$(tcmd --model b-model | grep -c -- '--model b-model')"
check_status "--tier and --model together are refused" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
  bash "$AGENT" spawn --dir "$WORK" --tier deep --model b-model
mkdir -p "$ISTATE/ctx"
printf '{"session_id":"s-inh","model_id":"a-model","updated_epoch":%s}\n' "$(date +%s)" > "$ISTATE/ctx/s-inh.json"
check "inherit-model types the calling session's model" "1" \
  "$(CLAUDE_CODE_SESSION_ID=s-inh ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "Orch : heir" --inherit-model 2>&1 | sed -n 's/^launch=//p' | grep -c -- '--model a-model')"
check "inherit-model with no tap file refuses and names the installer" "1" \
  "$(CLAUDE_CODE_SESSION_ID=s-none ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --inherit-model 2>&1 | grep -c 'orchestrator:install')"
check "inherit-model is exclusive with a tier" "1" \
  "$(CLAUDE_CODE_SESSION_ID=s-inh ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --inherit-model --tier deep 2>&1 | grep -c 'exclusive')"
check_status "an unknown tier is refused at spawn" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
  bash "$AGENT" spawn --dir "$WORK" --tier deepest
# rotate performs a real close, so its forwarding is checked on the source, as the
# suite already checks that rotate inherits the spawn's verification.
check "rotate forwards the tier to the spawn" "1" \
  "$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
      bash "$AGENT" rotate --old-tty /dev/ttys999 --dir "$WORK" --title "Agent : rotated" --tier deep 2>&1 | grep -c -- '--model a-model')"
check "rotate closes the old tab only after the spawn" "1" \
  "$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
      bash "$AGENT" rotate --old-tty /dev/ttys999 --dir "$WORK" --title "Agent : rotated" --tier deep 2>&1 | tail -1 | grep -c '^close=/dev/ttys999')"
# The rotation's spawn receives every argument the rotation does not consume, --trust
# included — but the tab skill's line never said so, and a live rotation into a fresh
# checkout was refused on the trust question and redone by hand (§39). Read on the record
# the spawn writes, which is the only artifact that says the flag arrived.
ROTDIR="$WORK/rot-untrusted"; mkdir -p "$ROTDIR"
printf '{"projects":{}}' > "$TRUSTF"
check "rotate forwards --trust to the spawn, which records it" "true" \
  "$(env ORCHESTRATOR_TRUST_FILE="$TRUSTF" ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
      bash "$AGENT" rotate --old-tty /dev/ttys999 --dir "$ROTDIR" --title "Agent : rotated" --tier deep --trust >/dev/null 2>&1; \
     "$py" -c "import json,os,sys; d=json.load(open(sys.argv[1])); print(str(d['projects'].get(os.path.realpath(sys.argv[2]),{}).get('hasTrustDialogAccepted')).lower())" "$TRUSTF" "$ROTDIR")"
# The rotation forwards --mcp too: an agent that drives a browser is replaced by one that
# still can. It is not in the refused list below, and the dry run is where the forwarding
# is read (§42).
check "rotate forwards --mcp to the spawn" "1" \
  "$(env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
      bash "$AGENT" rotate --old-tty /dev/ttys999 --dir "$WORK" --title "Agent : rotated" --mcp 2>&1 | grep -c '^mcp=yes$')"
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
  bash "$AGENT" rotate --dir "$WORK" --old-tty /dev/ttys999 --tier bogus 2>&1 || true)
check "an unresolvable tier stops the rotation, and nothing runs after it" \
  "ERROR: resolve-tier: unknown tier: bogus (expected deep, standard or light)" "$(printf '%s' "$rot" | tail -1)"

echo "== context gate hook =="
# A fake config dir with a tap file: at 70 % the hook orders the succession, at 30 % it
# prints nothing, and with no tap file it says « unmeasured » exactly once.
GH="$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-XXXXXX")"; mkdir -p "$GH/claude-orchestrator/ctx"
now=$(date +%s)
printf '{"session_id":"g-hi","context_percent":70,"updated_epoch":%s}\n' "$now" > "$GH/claude-orchestrator/ctx/g-hi.json"
printf '{"session_id":"g-lo","context_percent":30,"updated_epoch":%s}\n' "$now" > "$GH/claude-orchestrator/ctx/g-lo.json"
gate() { printf '{"session_id":"%s"}' "$1" | CLAUDE_CONFIG_DIR="$GH" bash "$ROOT/hooks/context-gate.sh"; }
check "past the gate the hook orders the succession" "1" "$(gate g-hi | grep -c 'SUCCEEDS at the next quiet boundary')"
check "under the gate the hook is silent" "" "$(gate g-lo)"
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

echo "== tap =="

TAP="$ROOT/skills/context-gauge/scripts/statusline-tap.sh"
# The payload shape is the one the host actually sends: context_window carries
# used_percentage, context_window_size and a current_usage breakdown.
PAYLOAD='{"session_id":"s-1","transcript_path":"/t/s-1.jsonl","context_window":{"used_percentage":36.4,"context_window_size":250000,"current_usage":{"input_tokens":1000,"cache_creation_input_tokens":2000,"cache_read_input_tokens":88000}},"rate_limits":{"five_hour":{"used_percentage":3,"resets_at":1788560000},"seven_day":{"used_percentage":1,"resets_at":1788900000}}}'
STATE="$WORK/state"

out=$(printf '%s' "$PAYLOAD" | ORCHESTRATOR_STATE_DIR="$STATE" bash "$TAP")
check "no wrapped command: one-line render" "ctx: 36% │ 5h: 3% │ 7d: 1%" "$out"
check "file written with every field" \
  '{"session_id":"s-1","context_percent":36.4,"context_used":91000,"context_total":250000,"five_hour_percent":3,"five_hour_resets_at":1788560000,"seven_day_percent":1,"seven_day_resets_at":1788900000,"transcript_path":"/t/s-1.jsonl","model_id":null}' \
  "$(jq -c 'del(.updated_epoch)' "$STATE/ctx/s-1.json")"
out=$(printf '{"session_id":"s-early","context_window":{"used_percentage":0}}' | ORCHESTRATOR_STATE_DIR="$STATE" bash "$TAP")
check "early payload without usage or transcript: nulls, no crash" \
  '{"session_id":"s-early","context_percent":0,"context_used":null,"context_total":null,"five_hour_percent":null,"five_hour_resets_at":null,"seven_day_percent":null,"seven_day_resets_at":null,"transcript_path":null,"model_id":null}' \
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
check "empty stdin renders a placeholder" "ctx: ~ │ 5h: ~ │ 7d: ~" "$out"

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
printf '{"session_id":"g-1","context_percent":36.4,"context_used":91000,"context_total":250000,"five_hour_percent":3,"five_hour_resets_at":null,"seven_day_percent":1,"seven_day_resets_at":null,"transcript_path":null,"updated_epoch":%s}\n' \
  "$(date +%s)" > "$GSTATE/ctx/g-1.json"
gauge() { ORCHESTRATOR_STATE_DIR="$GSTATE" ORCHESTRATOR_TRANSCRIPTS_DIR="$WORK/projects" bash "$GAUGE" "$@"; }

# g-2 has no transcript under the projects directory: only the path recorded in
# its stale tap file can lead to it.
printf '{"session_id":"g-2","context_percent":36.4,"context_used":91000,"context_total":250000,"five_hour_percent":null,"five_hour_resets_at":null,"seven_day_percent":null,"seven_day_resets_at":null,"transcript_path":"%s","updated_epoch":0}\n' \
  "$WORK/projects/p1/g-1.jsonl" > "$GSTATE/ctx/g-2.json"
check "stale tap file: transcript found through its recorded path" "context_percent=36.0
context_tokens=90000
context_window=250000
context_window_source=tap-file
five_hour_percent=unavailable
seven_day_percent=unavailable
model=a-model
model_source=transcript
source=transcript" "$(gauge g-2)"

# A fresh tap whose payload carried no quota figures says so in the same word as the
# transcript tier. `commands/status.md` and the routing skill both tell a reader to keep
# the `five_hour_percent=` line; a line that is absent, or that reads `null`, is one a
# careless reader takes for zero — and zero means "no budget pressure, dispatch at full
# tier" exactly when the opposite is true.
printf '{"session_id":"g-3","context_percent":36.4,"context_used":91000,"context_total":250000,"five_hour_percent":null,"seven_day_percent":null,"transcript_path":null,"updated_epoch":%s}\n' \
  "$(date +%s)" > "$GSTATE/ctx/g-3.json"
check "a fresh tap without quota figures says unavailable" "context_percent=36.4
context_tokens=91000
context_window=250000
five_hour_percent=unavailable
seven_day_percent=unavailable
model=unavailable
model_source=unavailable
source=tap" "$(gauge g-3)"
rm -f "$GSTATE/ctx/g-3.json"

# No transcript reachable: the tap's declared model is the reading, said as the tap's.
printf '{"session_id":"g-4","context_percent":36.4,"context_used":91000,"context_total":250000,"five_hour_percent":3,"five_hour_resets_at":null,"seven_day_percent":1,"seven_day_resets_at":null,"transcript_path":null,"model_id":"t-model","updated_epoch":%s}\n' \
  "$(date +%s)" > "$GSTATE/ctx/g-4.json"
check "no transcript: the model comes from the tap, and says so" "model=t-model
model_source=tap" "$(gauge g-4 | grep '^model')"
rm -f "$GSTATE/ctx/g-4.json"

check "fresh tap file wins" "context_percent=36.4
context_tokens=91000
context_window=250000
five_hour_percent=3
seven_day_percent=1
model=a-model
model_source=transcript
source=tap" "$(gauge g-1)"

check "stale tap file: transcript with the file's window" "context_percent=36.0
context_tokens=90000
context_window=250000
context_window_source=tap-file
five_hour_percent=unavailable
seven_day_percent=unavailable
model=a-model
model_source=transcript
source=transcript" "$(gauge g-1 --max-age 0)"

rm "$GSTATE/ctx/g-1.json"
check "no tap file: --window" "context_percent=45.0
context_tokens=90000
context_window=200000
context_window_source=flag
five_hour_percent=unavailable
seven_day_percent=unavailable
model=a-model
model_source=transcript
source=transcript" "$(gauge g-1 --window 200000)"

check "session id from the environment, default window" "context_window_source=default" \
  "$(CLAUDE_CODE_SESSION_ID=g-1 gauge | grep context_window_source)"
check "assumed window carries a warning line" "1" "$(CLAUDE_CODE_SESSION_ID=g-1 gauge | grep -c '^warning=window assumed')"
check "known window carries no warning" "0" "$(gauge g-1 --window 200000 | grep -c '^warning=')"

check_status "nothing readable exits 1" 1 gauge nope
check_status "no session id exits 1" 1 env -u CLAUDE_CODE_SESSION_ID ORCHESTRATOR_STATE_DIR="$GSTATE" bash "$GAUGE"

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
printf '{"deep":"a-model","standard":"","light":""}\n' > "$H/.claude/claude-orchestrator/models.json"
env HOME="$H" bash "$ROOT/install.sh" >/dev/null 2>&1
check "an existing tier map is never overwritten" "a-model" \
  "$(jq -r .deep "$H/.claude/claude-orchestrator/models.json")"
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

echo "== iterm script (argument validation, no automation) =="

ITERM="$ROOT/skills/iterm-agents/scripts/iterm-agent.sh"
check_status "close without --tty fails" 1 bash "$ITERM" close --expect-title x
check_status "move with identical ttys fails" 1 bash "$ITERM" move --tty /dev/ttys000 --left-of /dev/ttys000
check_status "spawn without --dir fails" 1 bash "$ITERM" spawn --title x
check_status "unknown subcommand fails" 1 bash "$ITERM" bogus
check "close error names the option" "ERROR: close: --tty is required" "$(bash "$ITERM" close 2>&1)"

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
