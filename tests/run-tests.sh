#!/bin/bash
# Test suite. No network, no terminal automation, isolated HOME per case.
#
# Each case runs a script against a temporary state directory or a temporary
# HOME and compares its output or its side effects with an expected value.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

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
  ( cd "$ROOT" && grep -rniI 'claude' . --exclude-dir=.git --exclude-dir=plans \
      --exclude=plan.md --exclude=CLAUDE.md --exclude=run-tests.sh \
    | grep -viE '~/\.claude/|\$HOME/\.claude|CLAUDE_CONFIG_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_CODE_SESSION_ID|ORCHESTRATOR_HOST_CLI|claude-orchestrator|\.claude-plugin|/\.claude/' || true )
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
hits=$(grep -rniIE '\b(opus|sonnet|haiku)\b' "$ROOT" --exclude-dir=.git --exclude-dir=plans \
  --exclude=plan.md --exclude=CLAUDE.md --exclude=run-tests.sh || true)
check "no model family name in the plugin" "" "$hits"

# Nothing tied to one machine or one project enters the generic plugin: no
# absolute home path, no real session reference (the documented example is
# the six-hex placeholder a1b2c3), no path into a downstream project's tree.
hits=$(grep -rnIE '/Users/|/home/[a-z]|\[[0-9a-f]{6}\]|docs/reference/|BUGS\.md|IMPLEMENTATION\.md' "$ROOT" --exclude-dir=.git --exclude=plan.md --exclude=run-tests.sh \
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
check "spawn types a permission mode" "1" "$(grep -c -- '--permission-mode \$(printf' "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh")"
check "spawn and rotate default to the operator's mode" "2" "$(grep -c 'mode=\"auto\"' "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh")"
check "spawn pre-approves the project MCP servers" "1" "$(grep -c 'enableAllProjectMcpServers' "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh" | tr -d ' ')"
check "the succession brief closes the predecessor's tab" "1" "$(grep -c 'CLOSE ITS TAB' "$ROOT/templates/orchestrator-succession-brief.md")"
check "the decide command asks one question per message" "1" "$(grep -c 'one question per message' "$ROOT/commands/decide.md")"
check "the decide command re-presents an interrupted question in full" "1" "$(grep -c 'IN FULL when you return' "$ROOT/commands/decide.md")"
check "the decide command records before it moves on" "1" "$(grep -c 'Present the next question IN FULL (step 2). Not before.' "$ROOT/commands/decide.md")"

# Review rounds run in sessions spawned for the round and closed when it is judged:
# the rulebook names the mode, both briefs exist, and neither lets its session push.
check "the rulebook runs review rounds in disposable sessions" "1" "$(grep -c '^## Review rounds run in disposable sessions' "$ROOT/skills/orchestrator/SKILL.md")"
check "the review brief forbids writing" "1" "$(grep -c 'You write nothing and post nothing' "$ROOT/templates/agent-review-brief.md")"
check "the comments brief forbids pushing" "1" "$(grep -c 'Never push' "$ROOT/templates/agent-comments-brief.md")"

# A plain spawn appends at the END of the window, not beside the caller — an agent
# once landed two tabs from its orchestrator with a stranger's session between them.
# So placement anchors on a tty or on `self`, the caller's own tab, and the docs say
# to name one rather than trusting the default position.
check "move accepts a right anchor" "1" "$(grep -c -- '--right-of) anchor_tty=' "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh")"
check "an anchor is required" "1" "$(grep -c 'move: --left-of or --right-of is required' "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh")"
check "self resolves the caller's own tty" "1" "$(grep -c '^resolve_self_tty()' "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh")"
# Named in full: the bare phrase now appears twice (the anchors, and --tier against
# --model), and a guard that counts an unrelated message is green over nothing.
check "spawn refuses two anchors" "1" "$(grep -c -- '--left-of and --right-of are mutually exclusive' "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh")"
# Crossing the anchor shifts it by one, so the move count differs per side. The first
# --right-of implementation computed zero moves and the AppleScript verification caught
# it live: the counts are pinned here so the asymmetry cannot be "simplified" away.
check "the move count is asymmetric per side" "1" "$(grep -c 'gt_adjust=-1; lt_adjust=0' "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh")"
check "the left side keeps its own counts" "1" "$(grep -c 'gt_adjust=0 lt_adjust=-1' "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh")"

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
check "the rulebook spawns beside the orchestrator" "1" "$(grep -c -- '--right-of self --prompt' "$ROOT/skills/orchestrator/SKILL.md")"
out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$WORK/istate2" bash "$ROOT/skills/iterm-agents/scripts/iterm-agent.sh" spawn --dir "$WORK" --prompt p --left-of /dev/ttys001 --right-of self 2>&1 || true)
case "$out" in *"mutually exclusive"*) anchors="refused" ;; *) anchors="$out" ;; esac
check "two anchors are refused at spawn" "refused" "$anchors"

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
out=$(LC_ALL=C ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --title "B-1 — é" --prompt "$prompt" 2>&1)
code=$?
check "dry-run spawn under LC_ALL=C exits 0" "0" "$code"
cmd=${out#*shellcmd=}; cmd=${cmd%%$'\n'*}
file=${out#*prompt_file=}; file=${file%%$'\n'*}
check "a long prompt is not typed into the shell" "short" "$([ "${#cmd}" -lt 500 ] && echo short || echo "${#cmd} chars typed")"
check "the typed command reads the prompt from its file" "1" "$(printf '%s' "$cmd" | grep -c '"\$(cat ')"
check "the prompt file holds the prompt byte for byte" "$prompt" "$(cat "$file")"
check "the prompt file lives under the state directory" "yes" "$([ "${file#"$ISTATE"/prompts/}" != "$file" ] && echo yes || echo "$file")"
check "the typed command carries the decision mode" "1" "$(printf '%s' "$cmd" | grep -c -- '--permission-mode auto')"
check "no tier and no map types no model argument" "0" "$(printf '%s' "$cmd" | grep -c -- '--model')"
check "the typed command changes into the working directory" "1" "$(printf '%s' "$cmd" | grep -c "^cd $WORK && ")"
aq=${out#*applescript=}; aq=${aq%%$'\n'*}
check "the double quotes are escaped for AppleScript" "1" "$(printf '%s' "$aq" | grep -c '\\"\$(cat ')"
out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --prompt-file "$file" 2>&1)
check "--prompt-file reuses the given file" "1" "$(printf '%s' "$out" | grep -c "prompt_file=$file")"
out=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" 2>&1)
cmd=${out#*shellcmd=}; cmd=${cmd%%$'\n'*}
check "no prompt: nothing appended after the settings" "1" "$(printf '%s' "$cmd" | grep -c -- 'enableAllProjectMcpServers.*}$')"
check_status "--prompt and --prompt-file together are refused" 1 env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --prompt x --prompt-file "$file"
check_status "verify on a tty nobody has exits 1" 1 bash "$AGENT" verify --tty /dev/ttys999
check "spawn verifies by default and rotate inherits it" "1" "$(grep -c 'if \[ "\$verify" = 1 \]' "$AGENT")"
check "quoting uses no sed" "0" "$(sed -n '/^applescript_quote()/,/^}/p' "$AGENT" | grep -c sed)"

# The shell of a fresh tab is read before anything is typed into it: a startup question
# waiting for a keystroke ate the first character of a command twice in one night.
check "a yes/no startup question is recognised" "question" "$(printf '[oh-my-zsh] Would you like to update? [Y/n]  \n' | bash "$AGENT" prompt-state)"
check "a prompt-first theme reads as ready" "ready" "$(printf 'Last login: today\n➜  ~ \n' | bash "$AGENT" prompt-state)"
check "a prompt-last shell reads as ready" "ready" "$(printf 'host:~ user$ \n' | bash "$AGENT" prompt-state)"
check "output still scrolling reads as busy" "busy" "$(printf 'building the bundle…\n' | bash "$AGENT" prompt-state)"
# Twice: once before the first typing, once before the single retry.
check "the command is typed only after the shell is ready" "2" "$(grep -c 'await_shell_ready "\$new_tty"$' "$AGENT")"
check "a mangled first attempt is re-typed once" "1" "$(grep -c 'typing the command once more' "$AGENT")"

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
    bash "$AGENT" spawn --dir "$WORK" "$@" 2>&1)
  out=${out#*shellcmd=}; printf '%s' "${out%%$'\n'*}"
}
check "a bound tier is typed as the model argument" "1" "$(tcmd --tier deep | grep -c -- '--model a-model')"
check "an unbound tier types no model argument" "0" "$(tcmd --tier light | grep -c -- '--model')"
check "an explicit model is typed as given" "1" "$(tcmd --model b-model | grep -c -- '--model b-model')"
check_status "--tier and --model together are refused" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
  bash "$AGENT" spawn --dir "$WORK" --tier deep --model b-model
check_status "an unknown tier is refused at spawn" 1 \
  env ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
  bash "$AGENT" spawn --dir "$WORK" --tier deepest
# rotate performs a real close, so its forwarding is checked on the source, as the
# suite already checks that rotate inherits the spawn's verification.
check "rotate forwards the tier to the spawn" "1" \
  "$(grep -c '\${tier:+--tier "\$tier"}' "$AGENT")"
# ...and forwarding is not enough: the refusal has to STOP the rotation. `rotate` runs the
# spawn inside a command substitution, so an `exit` from `resolve_tier` two substitutions
# deep ends only its own subshell — `set -e` never sees it. The spawn ran on with an empty
# model and opened a real tab for a tier that does not exist. Observed on a live machine.
# The guard is what comes LAST: an exit code alone would pass on the bug too, because the
# close that follows fails on its own.
rot=$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" ORCHESTRATOR_MODELS_MAP="$MAP" \
  bash "$AGENT" rotate --dir "$WORK" --old-tty /dev/ttys999 --tier bogus 2>&1 || true)
check "an unresolvable tier stops the rotation, and nothing runs after it" \
  "ERROR: spawn: cannot resolve tier: bogus" "$(printf '%s' "$rot" | tail -1)"

echo "== context gate hook =="
# A fake config dir with a tap file: at 70 % the hook orders the succession, at 30 % it
# prints nothing, and with no tap file it says « unmeasured » exactly once.
GH="$(mktemp -d)"; mkdir -p "$GH/claude-orchestrator/ctx"
now=$(date +%s)
printf '{"session_id":"g-hi","context_percent":70,"updated_epoch":%s}\n' "$now" > "$GH/claude-orchestrator/ctx/g-hi.json"
printf '{"session_id":"g-lo","context_percent":30,"updated_epoch":%s}\n' "$now" > "$GH/claude-orchestrator/ctx/g-lo.json"
gate() { printf '{"session_id":"%s"}' "$1" | CLAUDE_CONFIG_DIR="$GH" bash "$ROOT/hooks/context-gate.sh"; }
check "past the gate the hook orders the succession" "1" "$(gate g-hi | grep -c 'SUCCEEDS at the next quiet boundary')"
check "under the gate the hook is silent" "" "$(gate g-lo)"
check "unmeasured says so once" "1" "$(gate g-none | grep -c 'unmeasured'; )"
check "unmeasured stays silent the second time" "" "$(gate g-none)"
rm -rf "$GH"

echo "== tap =="

TAP="$ROOT/skills/context-gauge/scripts/statusline-tap.sh"
# The payload shape is the one the host actually sends: context_window carries
# used_percentage, context_window_size and a current_usage breakdown.
PAYLOAD='{"session_id":"s-1","transcript_path":"/t/s-1.jsonl","context_window":{"used_percentage":36.4,"context_window_size":250000,"current_usage":{"input_tokens":1000,"cache_creation_input_tokens":2000,"cache_read_input_tokens":88000}},"rate_limits":{"five_hour":{"used_percentage":3,"resets_at":1788560000},"seven_day":{"used_percentage":1,"resets_at":1788900000}}}'
STATE="$WORK/state"

out=$(printf '%s' "$PAYLOAD" | ORCHESTRATOR_STATE_DIR="$STATE" bash "$TAP")
check "no wrapped command: one-line render" "ctx: 36% │ 5h: 3% │ 7d: 1%" "$out"
check "file written with every field" \
  '{"session_id":"s-1","context_percent":36.4,"context_used":91000,"context_total":250000,"five_hour_percent":3,"five_hour_resets_at":1788560000,"seven_day_percent":1,"seven_day_resets_at":1788900000,"transcript_path":"/t/s-1.jsonl"}' \
  "$(jq -c 'del(.updated_epoch)' "$STATE/ctx/s-1.json")"
out=$(printf '{"session_id":"s-early","context_window":{"used_percentage":0}}' | ORCHESTRATOR_STATE_DIR="$STATE" bash "$TAP")
check "early payload without usage or transcript: nulls, no crash" \
  '{"session_id":"s-early","context_percent":0,"context_used":null,"context_total":null,"five_hour_percent":null,"five_hour_resets_at":null,"seven_day_percent":null,"seven_day_resets_at":null,"transcript_path":null}' \
  "$(jq -c 'del(.updated_epoch)' "$STATE/ctx/s-early.json")"
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
printf '%s' "$PAYLOAD" | sed 's/s-1/s-2/' | ORCHESTRATOR_STATE_DIR="$STATE" bash "$TAP" >/dev/null
check "stale files pruned on a session's first render" "gone" "$([ -f "$STATE/ctx/old.json" ] && echo kept || echo gone)"

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
source=tap" "$(gauge g-3)"
rm -f "$GSTATE/ctx/g-3.json"

check "fresh tap file wins" "context_percent=36.4
context_tokens=91000
context_window=250000
five_hour_percent=3
seven_day_percent=1
source=tap" "$(gauge g-1)"

check "stale tap file: transcript with the file's window" "context_percent=36.0
context_tokens=90000
context_window=250000
context_window_source=tap-file
five_hour_percent=unavailable
seven_day_percent=unavailable
source=transcript" "$(gauge g-1 --max-age 0)"

rm "$GSTATE/ctx/g-1.json"
check "no tap file: --window" "context_percent=45.0
context_tokens=90000
context_window=200000
context_window_source=flag
five_hour_percent=unavailable
seven_day_percent=unavailable
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
