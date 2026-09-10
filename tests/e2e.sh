#!/bin/bash
# e2e.sh - the round the suite cannot play: a real tab, a real session, a real close.
#
#   tests/e2e.sh            run it
#   tests/e2e.sh --keep     leave the sandbox behind for inspection
#
# NOT part of `run-tests.sh`, and deliberately so: it drives the terminal, it starts a
# session that costs tokens, and it needs the app running with its API enabled. A suite
# that cannot run in a checkout with no window server is a suite people stop running.
#
# What it proves that the unit tests cannot: that a brief written from a template reaches
# a session, that the tier named at dispatch is the model that session actually runs, that
# the tab lands where the layout says, and that a stood-down agent's tab and process are
# both gone. Every one of those was a defect at least once, and none was reachable from a
# dry run.
#
# It does NOT talk to the agent. Handshakes, verdicts and reviews are the orchestrator's
# job and need judgment; this checks the mechanism underneath them.

set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
AGENT="$ROOT/skills/iterm-agents/scripts/iterm-agent.sh"
LINT="$ROOT/skills/orchestrator/scripts/brief-lint.sh"
RECORD="$ROOT/skills/orchestrator/scripts/dispatch-record.sh"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

pass=0; fail=0; TTY=""
check() {
  if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1))
  else printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}

SANDBOX=$(mktemp -d)
cleanup() {
  # The tab first: a session left running is the one failure this script must not cause,
  # and it outlives the shell that started it.
  if [ -n "$TTY" ]; then bash "$AGENT" close --tty "$TTY" >/dev/null 2>&1 || true; fi
  [ "$KEEP" = 1 ] || rm -rf "$SANDBOX"
  [ "$KEEP" = 1 ] && echo "sandbox kept: $SANDBOX"
  return 0
}
trap cleanup EXIT

echo "== preflight =="
[ "$(uname -s)" = "Darwin" ] || { echo "  not macOS: nothing to drive, skipping"; exit 0; }
bash "$AGENT" list >/dev/null 2>&1
check "the tooling can read the app" "0" "$?"
bash "$AGENT" list >/dev/null 2>&1 || { echo "  cannot reach the app (API enabled? /orchestrator:install run?)"; exit 1; }
tier=${ORCHESTRATOR_E2E_TIER:-light}
bound=$(bash "$AGENT" resolve-tier "$tier")
check "the probe tier is bound in the operator's map" "bound" "$([ -n "$bound" ] && echo bound || echo "unbound: fill models.json or set ORCHESTRATOR_E2E_TIER")"
[ -n "$bound" ] || exit 1

echo "== a brief, from the template, linted =="
mkdir -p "$SANDBOX/repo"
( cd "$SANDBOX/repo" && git init -q -b main && git config user.email e2e@local && git config user.name e2e \
  && echo "scratch" > README.md && git add -A && git commit -q -m "Set up the scratch repository" )
# The documented placeholder reference: the brief must name exactly one address, and the
# probe session is never messaged, so a real one would be a lie the lint could not see.
me="e2e-orchestrator [a1b2c3]"
sed -e "s|{{PROJECT}}|scratch|g" -e "s|{{PHASE_NUMBER}}|1|g" -e "s|{{PHASE_TITLE}}|probe|g" \
    -e "s|{{SPEC}}|$SANDBOX/repo/README.md|g" -e "s|{{PLAN}}|$SANDBOX/repo/README.md|g" \
    -e "s|{{NORMS}}|$SANDBOX/repo/README.md|g" -e "s|{{REFERENCE_FILES}}|none|g" \
    -e "s|{{WORKTREE}}|$SANDBOX/repo|g" -e "s|{{ENV_CHECKS}}|none|g" \
    -e "s|{{BRANCH}}|probe|g" -e "s|{{BASE_BRANCH}}|main|g" -e "s|{{STATE_COMMANDS}}|git status --short|g" \
    -e "s|{{DELIVERABLES}}|- nothing: this brief exists to be read, not executed|g" \
    -e "s|{{CONTRACTS}}|none|g" -e "s|{{NON_GOALS}}|- everything|g" \
    -e "s|{{QUALITY_GATE}}|true|g" -e "s|{{ARTIFACTS_POLICY_SOURCE}}|$SANDBOX/repo/README.md|g" \
    -e "s|{{ARTIFACTS_POLICY}}|local only|g" -e "s|{{TESTS_POLICY}}|committed|g" \
    -e "s|{{EXTRA_FORBIDDEN}}|- none|g" -e "s|{{ORCHESTRATOR_NAME}}|$me|g" \
    -e "s|{{GAUGE}}|$ROOT/skills/context-gauge/scripts/context-gauge.sh|g" \
    -e "s|{{PR_TITLE}}|none|g" -e "s|{{PR_DESCRIPTION_SHAPE}}|none|g" -e "s|{{RESOURCE_ENVELOPE}}|none|g" \
    -e "s|{{TIER}}|$tier|g" -e "s|{{TIER_REASON}}|it is a probe, not a phase|g" \
    "$ROOT/templates/agent-phase-brief.md" > "$SANDBOX/brief.md"
check "every placeholder is filled" "0" "$(grep -c '{{' "$SANDBOX/brief.md")"
lint=$(bash "$LINT" "$SANDBOX/brief.md" 2>&1); code=$?
check "the brief passes its own lint" "0" "$code"

echo "== the dispatch, recorded =="
REC="$SANDBOX/dispatch.jsonl"
id=$(bash "$RECORD" open "$REC" --class probe --tier "$tier" --label "e2e")
check "the dispatch is recorded before it happens" "1" "$id"

echo "== spawn =="
self=$(bash "$AGENT" list | head -1 | awk -F' \\| ' '{print $2}')
TTY=$(bash "$AGENT" spawn --dir "$SANDBOX/repo" --tier "$tier" --title e2e-probe \
      --prompt "Read $SANDBOX/brief.md and wait. Do not write anything." --right-of "$self" 2>/dev/null | tail -1)
check "spawn returns a tty" "yes" "$(printf '%s' "$TTY" | grep -qE '^/dev/tty' && echo yes || echo "$TTY")"
[ -n "$TTY" ] || exit 1

waited=0
while [ $waited -lt 30 ]; do
  bash "$AGENT" verify --tty "$TTY" >/dev/null 2>&1 && break
  sleep 1; waited=$((waited+1))
done
# Asked again, on its own: `$?` after that loop is the arithmetic, not the answer.
bash "$AGENT" verify --tty "$TTY" >/dev/null 2>&1
check "the session is running on that tty" "0" "$?"

# THE assertion this whole script exists for: the tier named at dispatch is the model the
# live process carries. Everything else can be read from a dry run; this cannot.
got=$(ps -t "${TTY#/dev/}" -o command= 2>/dev/null | grep -oE -- '--model [^ ]+' | awk '{print $2}')
check "the live process carries the tier's model" "$bound" "$got"

pos_self=$(bash "$AGENT" list | grep -n "$self" | cut -d: -f1)
pos_new=$(bash "$AGENT" list | grep -n "$TTY" | cut -d: -f1)
check "the tab landed immediately right of its anchor" "$((pos_self + 1))" "$pos_new"

echo "== stand down =="
title=$(bash "$AGENT" list | grep "$TTY" | sed 's/.*| //' | cut -c1-6)
bash "$AGENT" close --tty "$TTY" --expect-title "nope" >/dev/null 2>&1
check "the title guard refuses a mismatch" "1" "$?"
bash "$AGENT" close --tty "$TTY" --expect-title "$title" >/dev/null 2>&1
check "the tab closes with the right title" "0" "$?"
dead=0
for _ in 1 2 3 4 5 6; do
  ps -t "${TTY#/dev/}" -o command= 2>/dev/null | grep -q . || { dead=1; break; }
  sleep 2
done
check "the process is gone, not merely detached" "1" "$dead"
check "the tab is gone from the listing" "0" "$(bash "$AGENT" list | grep -c "$TTY")"
TTY=""

bash "$RECORD" close "$REC" "$id" --verdict approved >/dev/null
check "the dispatch closes in one round" "1" "$(bash "$RECORD" summary "$REC" | grep -c 'class=probe .* rounds_avg=0')"
check "one round raises no signal" "0" "$(bash "$RECORD" summary "$REC" | grep -c '^signal=')"

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
