#!/bin/bash
# Test suite. No network, no plugin installation.
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

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

check_status() {
  local name="$1" expected="$2"
  shift 2
  "$@" >/dev/null 2>&1
  local code=$?
  check "$name" "exit $expected" "exit $code"
}

echo "== manifests =="

check "plugin name" "norms" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$ROOT/.claude-plugin/plugin.json")"

check "declares the github dependency" "github@lounisbou" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["dependencies"][0])' "$ROOT/.claude-plugin/plugin.json")"

check "marketplace lists the plugin" "norms" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["plugins"][0]["name"])' "$ROOT/.claude-plugin/marketplace.json")"

check "plugin version" "0.1.2" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/.claude-plugin/plugin.json")"

check "marketplace plugin version" "0.1.2" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["plugins"][0]["version"])' "$ROOT/.claude-plugin/marketplace.json")"

echo "== components =="

check "eight agents" "8" "$(ls "$ROOT"/agents/norms-*.md | wc -l | tr -d ' ')"

for s in find-pattern validate; do
  check "skill $s exists" "yes" \
    "$([ -f "$ROOT/skills/$s/SKILL.md" ] && echo yes || echo no)"
  check "skill $s names its directory" "$s" \
    "$(sed -n 's/^name: *//p' "$ROOT/skills/$s/SKILL.md" | head -1)"
done

echo "== the project norms file is never bundled =="

# CONTRIBUTING.md is per-repository and local. A copy inside the plugin would
# ship one project's conventions to every other project.
check "no CONTRIBUTING.md at the plugin root" "absent" \
  "$([ -e "$ROOT/CONTRIBUTING.md" ] && echo present || echo absent)"

echo "== no project-specific paths leaked from the divergent variant =="

# The PHP/Symfony variant of this tooling references src/Protocol/*,
# migrations/Version*.php and PHPUnit's codeCoverageIgnore. None of that is
# portable; its presence here would mean project-specific content leaked into
# what must be a generic plugin.
leak=0
for needle in 'src/Protocol/' 'migrations/Version' 'codeCoverageIgnore'; do
  hits=$(grep -rl -- "$needle" "$ROOT/agents" "$ROOT/commands" "$ROOT/skills" 2>/dev/null | wc -l | tr -d ' ')
  check "no match for '$needle'" "0" "$hits"
done

echo "== commands =="

for c in check learn; do
  check "command $c exists" "yes" \
    "$([ -f "$ROOT/commands/$c.md" ] && echo yes || echo no)"
done

# The retired tool must not be referenced anywhere.
check "no reference to the retired shell tool" "" \
  "$(grep -rl 'gh-api\.sh\|gh-parse\.py' "$ROOT/commands" "$ROOT/skills" "$ROOT/agents" 2>/dev/null)"

# No command may reach into a project-local skill directory.
check "no project-local skill path" "" \
  "$(grep -rl '\.claude/skills/github-curl' "$ROOT/commands" 2>/dev/null)"

echo "== github resolver =="

RESOLVE="$ROOT/scripts/resolve_github.py"

mkdir -p "$WORK/override"
check "CLAUDE_GITHUB_ROOT wins" "$WORK/override" \
  "$(CLAUDE_GITHUB_ROOT="$WORK/override" python3 "$RESOLVE" 2>&1)"

# A non-empty override that names nothing on disk is a misconfiguration, not a
# resolution. Returned as-is it satisfies the caller's `|| exit 1`, and the run
# fails later, somewhere further from the cause.
bad_override=$(CLAUDE_GITHUB_ROOT=/nonexistent/garbage python3 "$RESOLVE" 2>&1)
bad_code=$?
check "a nonexistent override exits 1 naming the path" "1 named" \
  "$bad_code $(printf '%s' "$bad_override" | grep -q '^error:.*/nonexistent/garbage' && echo named || echo unnamed)"

printf '{"version":2,"plugins":{}}' > "$WORK/none.json"
# -u CLAUDE_GITHUB_ROOT: the suite is run with that override set, and the
# override outranks the state file. Left in place it would mask the very
# absence this asserts, and the check would pass without testing anything.
check_status "missing dependency exits 1" 1 \
  env -u CLAUDE_GITHUB_ROOT CLAUDE_PLUGIN_STATE="$WORK/none.json" python3 "$RESOLVE"

echo "== learn calls only what exists =="

GHDIR="$(CLAUDE_GITHUB_ROOT="${CLAUDE_GITHUB_ROOT:-}" python3 "$RESOLVE" 2>/dev/null)/engine"
if [ ! -f "$GHDIR/gh.py" ]; then
  printf '  FAIL contract test cannot run: github plugin not resolved\n'
  printf '       fix: /plugin install github@lounisbou, or set CLAUDE_GITHUB_ROOT\n'
  fail=$((fail + 1))
else
  phantom=$(python3 - "$GHDIR" "$ROOT" <<'PYREV'
import os, re, sys
sys.path.insert(0, sys.argv[1])
import gh
from ghlib import fmt
subs = set([a for a in gh.build_parser()._actions if a.dest == "command"][0].choices)
fmts = set(fmt._FORMATTERS)
bad = []
for name in ("check", "learn"):
    path = os.path.join(sys.argv[2], "commands", name + ".md")
    for i, line in enumerate(open(path, encoding="utf-8"), 1):
        # All four spellings of the same call. The quoted form was the only
        # one matched, so `python3 $GH pr-frobnicate` slipped past the one
        # check that catches a phantom subcommand.
        m = re.search(r'python3\s+(?:"\$GH"|\$GH|"\$\{GH\}"|\$\{GH\})\s+([a-z][a-z0-9-]+)', line)
        if m and m.group(1) not in subs:
            bad.append("%s:%d subcommand %s" % (name, i, m.group(1)))
        for f in re.finditer(r'--format\s+([a-z][a-z0-9-]+)', line):
            if f.group(1) not in fmts:
                bad.append("%s:%d format %s" % (name, i, f.group(1)))
print(" ".join(bad))
PYREV
)
  check "every command invocation names something real" "" "$phantom"
fi

echo "== every section learn writes is read by an agent =="

# learn files rules under the sections its category table names, in backticks.
# A section nobody reads is a rule nobody applies.
for section in $(grep -oE '`\[[a-z-]+\]`' "$ROOT/commands/learn.md" | tr -d '`' | sort -u); do
  hits=$(grep -l -F -- "## $section" "$ROOT"/agents/norms-*.md | wc -l | tr -d ' ')
  check "section $section is read by at least one agent" "yes" \
    "$([ "$hits" -gt 0 ] && echo yes || echo no)"
done

echo "== the conformity agent reads every applicable section =="

PC="$ROOT/agents/norms-pattern-conformity.md"
check "conformity agent reads sections beyond type-strictness" "1" \
  "$(grep -c -F 'Find every other `## [...]` section' "$PC")"
for owned in test-conventions naming code-hygiene; do
  check "conformity agent leaves [$owned] to its owner" "1" \
    "$(grep -c -F "\`[$owned]\`" "$PC")"
done
check "conformity agent reads a rule's cited reference before flagging" "1" \
  "$(grep -c -F 'Reference:' "$PC")"
check "learn can file a rule under an existing project section" "1" \
  "$(grep -c -F 'already present in the project' "$ROOT/commands/learn.md")"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
