#!/bin/bash
# Test suite. No network, no plugin installation, isolated HOME per case.
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

echo "== manifests =="
MAN="$ROOT/.claude-plugin/plugin.json"; MKT="$ROOT/.claude-plugin/marketplace.json"
check "plugin is named implement" "implement" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$MAN")"
check "manifest version" "0.3.2" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$MAN")"
check "marketplace and manifest agree on the version" "0.3.2 0.3.2" \
  "$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m["metadata"]["version"], m["plugins"][0]["version"])' "$MKT")"
check "descriptions are identical" "True" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["description"]==json.load(open(sys.argv[2]))["plugins"][0]["description"])' "$MAN" "$MKT")"
check "the only dependency is superpowers" "['superpowers@claude-plugins-official']" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["dependencies"])' "$MAN")"
check "both commands run the preflight" "2" "$(grep -l 'scripts/preflight.sh' "$ROOT"/commands/*.md | wc -l | tr -d ' ')"
check "both commands check the dependency only" "2" "$(grep -l 'scripts/preflight.sh" --deps-only$' "$ROOT"/commands/*.md | wc -l | tr -d ' ')"
check "no command description asks for a git repository" "0" "$(grep -il '^description:.*git repository' "$ROOT"/commands/*.md | wc -l | tr -d ' ')"

echo "== preflight =="
PF="$ROOT/scripts/preflight.sh"
settings() { mkdir -p "$WORK/cfg"; printf '%s' "$1" > "$WORK/cfg/settings.json"; }
pf() { env HOME="$WORK" PREFLIGHT_SETTINGS="$WORK/cfg/settings.json" PREFLIGHT_SKIP_GIT=1 bash "$PF" "$@"; }
settings '{"enabledPlugins":{"superpowers@claude-plugins-official":true}}'
check_status "superpowers enabled passes" 0 pf
settings '{"enabledPlugins":{"superpowers@claude-plugins-official":false}}'
check_status "superpowers disabled exits 10" 10 pf
check "the failure names superpowers with a fix line" "2" "$(pf 2>&1 >/dev/null | grep -cE '^(error|fix):.*superpowers')"
settings '{"enabledPlugins":{}}'
check_status "superpowers absent exits 10" 10 pf
settings '{ not json'
check_status "malformed settings exits 10" 10 pf
check "malformed settings is one error line and no traceback" "1 0" \
  "$(out=$(pf 2>&1 >/dev/null); printf '%s %s' "$(printf '%s\n' "$out" | grep -c '^error:')" "$(printf '%s\n' "$out" | grep -c Traceback)")"
settings '{"enabledPlugins":{"superpowers@claude-plugins-official":true}}'
check_status "outside a git repository exits 13" 13 env HOME="$WORK" PREFLIGHT_SETTINGS="$WORK/cfg/settings.json" bash -c "cd '$WORK' && bash '$PF'"
check "outside a git repository, a skill's preflight prints its error and fix" \
  "error: not a git repository with a current branch⏎fix:   run this from inside a git repository, on a branch" \
  "$(env HOME="$WORK" PREFLIGHT_SETTINGS="$WORK/cfg/settings.json" bash -c "cd '$WORK' && bash '$PF'" 2>&1 >/dev/null | tr '\n' '⏎' | sed 's/⏎$//')"
check_status "outside a git repository, --deps-only (install, doctor) passes" 0 env HOME="$WORK" PREFLIGHT_SETTINGS="$WORK/cfg/settings.json" bash -c "cd '$WORK' && bash '$PF' --deps-only"
settings '{"enabledPlugins":{}}'
check_status "outside a git repository, --deps-only still exits 10 on a missing dependency" 10 env HOME="$WORK" PREFLIGHT_SETTINGS="$WORK/cfg/settings.json" bash -c "cd '$WORK' && bash '$PF' --deps-only"
settings '{"enabledPlugins":{"superpowers@claude-plugins-official":true}}'

# Scopes: user (CLAUDE_CONFIG_DIR), project, local. Later wins.
SP='{"enabledPlugins":{"superpowers@claude-plugins-official":true}}'
SPOFF='{"enabledPlugins":{"superpowers@claude-plugins-official":false}}'
scoped() { # scoped <user-json|-> <project-json|-> <local-json|->
  rm -rf "$WORK/scopes"; mkdir -p "$WORK/scopes/user" "$WORK/scopes/proj/.claude"
  [ "$1" = - ] || printf '%s' "$1" > "$WORK/scopes/user/settings.json"
  [ "$2" = - ] || printf '%s' "$2" > "$WORK/scopes/proj/.claude/settings.json"
  [ "$3" = - ] || printf '%s' "$3" > "$WORK/scopes/proj/.claude/settings.local.json"
}
pfs() { env -u PREFLIGHT_SETTINGS HOME="$WORK/nohome" CLAUDE_CONFIG_DIR="$WORK/scopes/user" PREFLIGHT_SKIP_GIT=1 bash -c "cd '$WORK/scopes/proj' && bash '$PF'"; }
scoped - "$SP" -
check_status "dependency enabled only at project scope passes" 0 pfs
scoped - - "$SP"
check_status "dependency enabled only at local scope passes" 0 pfs
scoped "$SP" - -
check_status "dependency enabled only in CLAUDE_CONFIG_DIR passes" 0 pfs
scoped "$SP" - "$SPOFF"
check_status "disabled in local while enabled at user exits 10" 10 pfs
scoped "$SPOFF" "$SP" -
check_status "enabled at project over disabled at user passes" 0 pfs
scoped - - -
check_status "no scope file at all exits 10" 10 pfs

echo "== skills =="
for skill in feature phase check close prepare; do
  doc="$ROOT/skills/$skill/SKILL.md"
  # Every guard below reads this file. A missing document answers all eight of them
  # with an empty string, which is what six of them expect from a correct one.
  check "$skill document exists" "1" "$([ -f "$doc" ] && echo 1 || echo 0)"
  check "$skill frontmatter names itself" "$skill" "$(awk '/^name:/{print $2; exit}' "$doc" 2>/dev/null)"
  check "$skill runs the preflight first" "1" "$(grep -c 'scripts/preflight.sh' "$doc" 2>/dev/null || echo 0)"
  check "$skill hard-codes no language" "" "$(grep -o 'French' "$doc" 2>/dev/null || true)"
  check "$skill has no accented character" "" "$(grep -o '[àâäéèêëïîôöùûüçÀÂÄÉÈÊËÏÎÔÖÙÛÜÇœŒ]' "$doc" 2>/dev/null | sort -u | tr '\n' ',' || true)"
  check "$skill has no common French words" "" "$(grep -Eiow 'vous|nous|avec|chemin|fichier|sont|une|titre' "$doc" 2>/dev/null | sort -u | tr '\n' ',' || true)"
  check "$skill reaches no other plugin's cache" "" "$(grep -o 'plugins/cache' "$doc" 2>/dev/null || true)"
  # Commands, not substrings. The bracket classes make the match begin and end on a
  # word boundary, so "through" in a comment stops being a call to GitHub while
  # "git push origin main" in a block still is one.
  check "$skill never pushes, merges or calls GitHub" "" \
    "$(awk '/^```bash/{f=1;next} /^```/{f=0} f && /(^|[^A-Za-z0-9_])(git push|git merge|curl|gh)([^A-Za-z0-9_]|$)/{print NR}' "$doc" 2>/dev/null)"

  # A preflight named after the first block is reached too late: the block it was
  # meant to guard has already run by then.
  check "$skill runs the preflight before its first bash block" "1" \
    "$(awk '/scripts\/preflight\.sh/ && !p { p = NR }
            /^```bash/ && !b { b = NR }
            END { print (p > 0 && b > 0 && p < b) ? 1 : 0 }' "$doc" 2>/dev/null)"

  # One plugin variable and no absolute path standing in for one: a second variable,
  # or a path under a home directory, reaches outside what this plugin owns.
  check "$skill uses no plugin variable but CLAUDE_PLUGIN_ROOT" "" \
    "$(grep -oE '\$\{?CLAUDE_[A-Z_]+|/Users/' "$doc" 2>/dev/null \
       | grep -vE '^\$\{?CLAUDE_PLUGIN_ROOT$' | sort -u | tr '\n' ',')"
done
# Each bash block is its own shell.
for skill in feature phase check close prepare; do
  unresolved=$(python3 - "$ROOT/skills/$skill/SKILL.md" <<'PYFENCE'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read().split("\n")
names = ("CODENAME", "DOCS", "BRANCH", "MAIN")
bad, block, start = [], None, 0
for i, line in enumerate(text, 1):
    if block is None:
        if line.startswith("```bash"):
            block, start = [], i
    elif line.startswith("```"):
        body = "\n".join(block)
        for name in names:
            if re.search(r"\$\{?%s\b" % name, body) and not re.search(r"^\s*%s=" % name, body, re.M):
                bad.append("%d:%s" % (start, name))
        block = None
    else:
        block.append(line)
print(" ".join(bad))
PYFENCE
)
  check "every $skill bash block derives what it uses" "" "$unresolved"
done
# Both artifact paths are guarded, and the four skills that write to either of them
# say so. A guard naming only docs/features leaves ROADMAP.md at the repository
# root, which is the file that turns a clean tree dirty.
for skill in feature prepare phase close; do
  check "$skill guards ROADMAP.md with check-ignore" "1" \
    "$(grep -c 'check-ignore.*ROADMAP\.md' "$ROOT/skills/$skill/SKILL.md" 2>/dev/null \
       | awk '{print ($1 >= 1) ? 1 : 0}')"
done
# The pattern docs/features/ reads "not ignored" on the bare directory before it
# exists; only an inner path is matched by every form the pattern takes.
for skill in feature prepare phase close; do
  check "$skill reads the ignore rule through docs/features/probe" "1" \
    "$(grep -c 'check-ignore -q docs/features/probe' "$ROOT/skills/$skill/SKILL.md" 2>/dev/null \
       | awk '{print ($1 >= 1) ? 1 : 0}')"
done
check "no skill reads the ignore rule through the bare directory" "" \
  "$(grep -HoE 'check-ignore -q docs/features( |&&|\|\|)' \
     "$ROOT"/skills/{feature,prepare,phase,close}/SKILL.md 2>/dev/null || true)"
# Contract: every superpowers:<name> exists in the installed plugin, every implement:<name> is one of ours.
# Each key of "plugins" in installed_plugins.json maps to a LIST of per-scope
# install records (a plugin can be installed at more than one scope), so every
# record of every matching key is flattened before the first installPath is read.
SP_ROOT="${SUPERPOWERS_ROOT:-$(python3 -c 'import json,os; d=json.load(open(os.path.expanduser("~/.claude/plugins/installed_plugins.json"))); recs=[r for k,v in d.get("plugins",{}).items() if k.startswith("superpowers@") for r in v]; print(recs[0]["installPath"] if recs and isinstance(recs[0],dict) and "installPath" in recs[0] else "")' 2>/dev/null)}"
check "the superpowers plugin resolves" "1" "$([ -d "$SP_ROOT/skills" ] && echo 1 || echo 0)"
phantoms=$(for skill in feature phase check close prepare; do
  grep -oE '(superpowers|implement):[a-z-]+' "$ROOT/skills/$skill/SKILL.md" 2>/dev/null | sort -u | while read -r ref; do
    case "$ref" in
      (superpowers:*) [ -d "$SP_ROOT/skills/${ref#superpowers:}" ] || printf '%s:%s ' "$skill" "$ref" ;;
      (implement:*)   [ -d "$ROOT/skills/${ref#implement:}" ] || [ -f "$ROOT/commands/${ref#implement:}.md" ] || printf '%s:%s ' "$skill" "$ref" ;;
    esac
  done
done)
check "every skill reference names something real" "" "$phantoms"

echo "== check =="
CHECK_DOC="$ROOT/skills/check/SKILL.md"

# A heading inside a fence is content the reader is shown, not a section of the
# document: this one shows the verdict table. Left uncounted, it moves every line
# after it into a section that does not exist. A fence opens on three or more
# backticks and closes on at least as many.
FENCE_TRACK='function bt(  c) { c = 0; while (substr($0, c + 1, 1) == "`") c++; return c }
/^```/ { n = bt(); if (!f) { f = 1; fence = n } else if (n >= fence) { f = 0 } next }'

# The report is the whole output of this skill. A reader who gets prose instead
# of the table cannot tell which of the seven checks produced which evidence.
check "check reports under one heading" "1" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## Report$/ { hits++ }
     END { print (hits > 0) ? 1 : 0 }' "$CHECK_DOC")"
check "check gives the table its header" "1" \
  "$(grep -c '^| check | evidence | result |' "$CHECK_DOC" | awk '{print ($1 >= 1) ? 1 : 0}')"

# Seven verifications, each with its evidence, and the order is the one the spec
# fixes: a delivery is read before it is compared, compared before it is re-run.
# The concatenation falls on a deletion and on a reordering; the count names
# which of the two happened.
check "check carries seven numbered verifications" "7" \
  "$(awk "$FENCE_TRACK"'!f && /^### [1-7]\. / { seen++ } END { print seen + 0 }' "$CHECK_DOC")"
check "the seven verifications are in order" "1234567" \
  "$(awk "$FENCE_TRACK"'!f && /^### [1-7]\. / { printf "%s", substr($0, 5, 1) }' "$CHECK_DOC")"

# This skill verifies and stops there. An overview that leaves it open reads as
# licence to repair what it just found, which is the other skill's work.
check "check says in its overview that it edits nothing" "1" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## Overview$/ { in_ov = 1; next }
     !f && /^## / { in_ov = 0 }
     in_ov && /(edits nothing|never edits)/ { hits++ }
     END { print (hits > 0) ? 1 : 0 }' "$CHECK_DOC")"

# The range travels by the environment, like the artifacts path. A positional
# argument reaches the first block of a document and no other, and the block that
# reads the range is the second one.
check "check takes its range from RANGE inside a fence" "1" \
  "$(awk '/^```bash/ { b = 1; next } /^```/ { b = 0 }
          b && /RANGE=/ { seen++ }
          END { print (seen > 0) ? 1 : 0 }' "$CHECK_DOC")"
check "check's fence for verification 2 holds RANGE=\${RANGE:-} once" "1" \
  "$(awk '/^### 2\. /{s=1;next} /^### [0-9]/{s=0} s && /^```bash/{b=1;next} s && /^```/{b=0} s && b && $0=="RANGE=${RANGE:-}"{c++} END{print c+0}' "$CHECK_DOC")"
check "check never assigns RANGE from a positional argument" "" \
  "$(grep -oE 'RANGE="?\$[0-9]"?' "$CHECK_DOC" 2>/dev/null || true)"

# Verifications 3 and 7 read what the delivery puts forward, not the whole phase
# file: a sub-phase still to come is not a deliverable this range owes.
check "check's plan compliance judges what the delivery claims" "1" \
  "$(awk "$FENCE_TRACK"'
     !f && /^### 3\. / { in_v3 = 1; next }
     !f && /^### / { in_v3 = 0 }
     in_v3 && /sub-phases the delivery claims/ { hits++ }
     END { print (hits > 0) ? 1 : 0 }' "$CHECK_DOC")"

echo "== phase =="
PHASE_DOC="$ROOT/skills/phase/SKILL.md"

# The three NEVER lines are the whole of what this skill refuses. Two of them
# would still read as a complete rule, which is why the count is the check and
# not the presence of the fence. The rule itself lives in a fence, so the heading
# tracking runs through $FENCE_TRACK: a "## " line shown inside that fence is
# content the reader is given, not the start of the section after it.
check "phase's iron rule holds three NEVER lines" "3" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## The Iron Rule$/ { in_rule = 1; next }
     !f && /^## / { in_rule = 0 }
     in_rule && /^NEVER / { nevers++ }
     END { print nevers + 0 }' "$PHASE_DOC")"

# The two skills the loop hands its work to. The contract check above proves the
# directories exist; here they are proved to be invoked at all.
for ref in implement:check superpowers:test-driven-development; do
  check "phase invokes $ref" "1" \
    "$(grep -c "$ref" "$PHASE_DOC" 2>/dev/null | awk '{print ($1 >= 1) ? 1 : 0}')"
done

# A gate whose result is not read is not a gate. The loop states each command with
# its exit code, so a transcript tells a green run from a red one without trusting
# the summary written over it.
check "the loop states the gate exit code" "1" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## The loop$/ { in_loop = 1; next }
     !f && /^## / { in_loop = 0 }
     in_loop && /exit code/ { seen++ }
     END { print (seen > 0) ? 1 : 0 }' "$PHASE_DOC")"

# The nested call carries the artifacts path it was given, at both places the
# document spells that call out. Without it the inner run derives a path from the
# branch name, which is what --docs was passed to the outer run to avoid.
check "phase's nested check call carries the artifacts path" "1" \
  "$(grep -c 'implement:check .*--docs' "$PHASE_DOC" 2>/dev/null \
     | awk '{print ($1 >= 2) ? 1 : 0}')"

# The work is written inline, by whoever read the plan, or it is written by nobody
# who read it. A dispatch hidden in a copyable block is the one that gets run.
check "no phase bash block dispatches a subagent" "" \
  "$(awk '/^```bash/ { b = 1; next } /^```/ { b = 0 } b && /(Task\(|subagent)/ { print NR }' "$PHASE_DOC")"

# The milestone column carries a sha from the moment a phase is under way: the base
# of the sub-phase being written while the row is doing, the phase's last commit
# once it is done. An example showing it empty teaches the older shape.
check "phase's example table shows a doing row carrying its base" "1" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## Inputs$/ { in_in = 1; next }
     !f && /^## / { in_in = 0 }
     in_in && f && /^\| *[0-9]+ *\|[^|]*\| *doing *\| *[0-9a-f]+ *\|/ { hits++ }
     END { print (hits > 0) ? 1 : 0 }' "$PHASE_DOC")"

echo "== feature =="
FEATURE_DOC="$ROOT/skills/feature/SKILL.md"

# The spec fixes the two superpowers skills this one stands on. Paraphrasing
# either of them is the failure mode the whole plugin exists to avoid.
for ref in superpowers:brainstorming superpowers:writing-plans; do
  check "feature invokes $ref" "1" \
    "$(grep -c "$ref" "$FEATURE_DOC" 2>/dev/null | awk '{print ($1 >= 1) ? 1 : 0}')"
done

# One question, asked once, carrying four proposed values. Three of them asked and
# the fourth assumed is the quiet failure: the user confirms what they were shown
# and the unshown value lands in the state file unread.
check "feature's one question carries the four values" "4" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## .*The one question/ { in_q = 1; next }
     !f && /^## / { in_q = 0 }
     in_q && /codename/ { seen["codename"] = 1 }
     in_q && /title/ { seen["title"] = 1 }
     in_q && /branch/ { seen["branch"] = 1 }
     in_q && /bump/ { seen["bump"] = 1 }
     END { total = 0; for (k in seen) total++; print total }' "$FEATURE_DOC")"

# The state table is the contract phase and close parse. It is shown in a fence so
# the writer copies it rather than inventing a spelling of its own.
check "feature gives the state table its header inside a fence" "1" \
  "$(awk "$FENCE_TRACK"'
     f && /^\| phase \| title \| status \| milestone \|/ { hits++ }
     END { print (hits > 0) ? 1 : 0 }' "$FEATURE_DOC")"

# The brainstorm and the plan skill each save a file of their own under
# docs/superpowers. This document names that path to say it is NOT written: the
# design and the plan land under the feature's own directory instead.
check "feature names the superpowers paths it does not write" "1" \
  "$(grep -c 'docs/superpowers' "$FEATURE_DOC" 2>/dev/null | awk '{print ($1 >= 1) ? 1 : 0}')"

# The plan skill's mandatory header hands execution to a subagent, which the loop
# of implement:phase refuses. A plan step that does not name that header inherits it.
check "feature's plan step names the header it omits" "1" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## Step 5/ { in_plan = 1; next }
     !f && /^## / { in_plan = 0 }
     in_plan && /header/ { hits++ }
     END { print (hits > 0) ? 1 : 0 }' "$FEATURE_DOC")"

# The listing must be reached whether docs/features is absent or empty, which a
# find of the directory does and a glob guarded on it does not.
check "feature lists prepared features with find, not a glob" "1" \
  "$(awk '/^```bash/ { b = 1; next } /^```/ { b = 0 }
          b && index($0, "find docs/features -mindepth 1 -maxdepth 1 -type d") { seen++ }
          END { print (seen > 0) ? 1 : 0 }' "$FEATURE_DOC")"

echo "== prepare =="
PREPARE_DOC="$ROOT/skills/prepare/SKILL.md"

# Preparing a feature is the first half of starting one, and the half that touches
# no branch: it has to stand on the same two superpowers skills.
for ref in superpowers:brainstorming superpowers:writing-plans; do
  check "prepare invokes $ref" "1" \
    "$(grep -c "$ref" "$PREPARE_DOC" 2>/dev/null | awk '{print ($1 >= 1) ? 1 : 0}')"
done

# The one line that keeps a prepared feature from disturbing whatever is in flight
# on another branch. Without it this skill is implement:feature with a missing step.
check "prepare refuses to create a branch" "1" \
  "$(grep -c '^NEVER create a branch' "$PREPARE_DOC" 2>/dev/null | awk '{print ($1 >= 1) ? 1 : 0}')"
check "prepare's iron rule holds two NEVER lines" "2" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## The Iron Rule$/ { in_rule = 1; next }
     !f && /^## / { in_rule = 0 }
     in_rule && /^NEVER / { nevers++ }
     END { print nevers + 0 }' "$PREPARE_DOC")"

echo "== close =="
CLOSE_DOC="$ROOT/skills/close/SKILL.md"

# The detection order is the contract: the first file found is the one bumped, so a
# repository holding both a VERSION and a package.json gets a different version
# written if two names trade places. Compared in order of first appearance.
check "close names the five version files in order" \
  "VERSION pyproject.toml package.json composer.json .claude-plugin/plugin.json" \
  "$(grep -oE 'VERSION|pyproject\.toml|package\.json|composer\.json|\.claude-plugin/plugin\.json' "$CLOSE_DOC" \
     | awk '!already[$0]++' | tr '\n' ' ' | sed 's/ *$//')"

check "close's iron rule holds three NEVER lines" "3" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## The Iron Rule$/ { in_rule = 1; next }
     !f && /^## / { in_rule = 0 }
     in_rule && /^NEVER / { nevers++ }
     END { print nevers + 0 }' "$CLOSE_DOC")"

# What happens after the branch belongs to the user. Said once: twice reads as a
# warning, absent it reads as an offer to do it.
check "close hands the rest back in one sentence" "1" \
  "$(grep -o 'a push, a pull request or a merge that your instructions call for is carried out without asking' "$CLOSE_DOC" 2>/dev/null | wc -l | tr -d ' ')"

# A version written into one file and mirrored in another leaves the repository
# green on the first gate and red on the second. The stop names the file it wrote.
check "close stops on a gate that turned red after the version write" "1" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## Stops$/ { in_st = 1; next }
     !f && /^## / { in_st = 0 }
     in_st && /^\|/ && /gate red/ { hits++ }
     END { print (hits > 0) ? 1 : 0 }' "$CLOSE_DOC")"

# The release subject is the repository's, not this skill's. The log line that
# reads it is quoted so the writer runs it rather than recalling a shape.
# index() rather than a regex: the command carries the quote awk would end on.
check "close reads the repository's last release subject" "1" \
  "$(awk '/^```bash/ { b = 1; next } /^```/ { b = 0 }
          b && index($0, "--grep=\047^([a-z]+(\\([^)]*\\))?: )?[Rr]elease\047") { seen++ }
          END { print (seen > 0) ? 1 : 0 }' "$CLOSE_DOC")"

# The feature directory goes, and the two parents it was the only tenant of go
# with it. Left behind, they are what the next run of the ignore guard reads.
check "close takes away the empty parents it leaves" "1" \
  "$(awk '/^```bash/ { b = 1; next } /^```/ { b = 0 }
          b && index($0, "rmdir docs/features docs") { seen++ }
          END { print (seen > 0) ? 1 : 0 }' "$CLOSE_DOC")"

echo "== module =="
# The hooks module answers what the markdown does when it is not loaded. Its own
# tests run in the host's test kit; what is pinned here is the seam between the
# two halves: the contract strings, the state file's two parsers, the manifest.
check "hooks.json names the module" "./register.ts" \
  "$(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["modules"]))' "$ROOT/hooks/hooks.json")"
check "the manifest names the state contract, and it exists" "1" \
  "$(python3 -c 'import json,os,sys; t=json.load(open(sys.argv[1])).get("types",""); print(1 if t and os.path.isfile(os.path.join(sys.argv[2], t)) else 0)' "$MAN" "$ROOT")"
check "the module leads a skill with the line the skills skip on" "1" \
  "$(grep -c "^export const PREFLIGHT_PASSED = 'Preflight: passed'$" "$ROOT/hooks/core.ts")"
for skill in feature phase check close prepare; do
  check "$skill skips its preflight on the module's line" "1" \
    "$(grep -c 'when this text opens on a `Preflight: passed` line' "$ROOT/skills/$skill/SKILL.md")"
done
for skill in phase check close; do
  check "$skill names the state tool" "1" \
    "$(grep -c 'mcp__implement__state' "$ROOT/skills/$skill/SKILL.md" | awk '{print ($1 >= 1) ? 1 : 0}')"
done

# One fixture, two parsers: the module's (hooks/core.test.ts holds the same text)
# and the close skill's own grep and sed lines, read out of the skill and run.
FIX="$ROOT/tests/fixtures/state-table.md"
check "the module's test reads the same fixture" "True" \
  "$(python3 -c 'import sys; s=open(sys.argv[1]).read(); a=s.index("const FIXTURE = `")+17; print(s[a:s.index("`", a)]==open(sys.argv[2]).read())' "$ROOT/hooks/core.test.ts" "$FIX")"
close_line() { grep -E "^$1" "$CLOSE_DOC" | head -1; }
mkdir -p "$WORK/fx/feat"; cp "$FIX" "$WORK/fx/feat/IMPLEMENTATION.md"
check "close's parser reads the fixture's bump" "minor" \
  "$(DOCS="$WORK/fx/feat" bash -c "$(close_line 'BUMP=')"'; echo "$BUMP"')"
check "close's parser reads the fixture's base" "abc1234" \
  "$(DOCS="$WORK/fx/feat" bash -c "$(close_line 'BASE=')"'; echo "$BASE"')"
check "close's parser sees the fixture's open phase" "a phase is not done" \
  "$(DOCS="$WORK/fx/feat" bash -c "$(close_line 'grep -qE')")"
sed -e 's/| doing | 9f31a0c |/| done | 9f31a0c |/' -e 's/| todo |  |/| done | 1234abc |/' "$FIX" > "$WORK/fx/feat/IMPLEMENTATION.md"
check "close's parser passes the fixture once every row is done" "" \
  "$(DOCS="$WORK/fx/feat" bash -c "$(close_line 'grep -qE')")"

# The host validates the module the way it loads it, and runs its tests.
check "the host validates the plugin" "0" \
  "$(claude plugin validate "$ROOT" >/dev/null 2>&1; echo $?)"
check "the module's tests pass in the host's kit" "0" \
  "$(claude plugin test "$ROOT" >/dev/null 2>&1; echo $?)"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
