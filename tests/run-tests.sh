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

check "plugin name" "pr-review" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$ROOT/.claude-plugin/plugin.json")"

check "plugin license" "MIT" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["license"])' "$ROOT/.claude-plugin/plugin.json")"

check "marketplace lists the plugin" "pr-review" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["plugins"][0]["name"])' "$ROOT/.claude-plugin/marketplace.json")"

# The product name belongs only in load-bearing identifiers: host paths, host
# environment variables, the plugin name and the manifest directory.

echo "== the tool is no longer vendored here =="

check "github-curl is gone" "absent" \
  "$([ -e "$ROOT/skills/github-curl" ] && echo present || echo absent)"

check "manifest declares the dependency" "github@lounisbou" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["dependencies"][0])' "$ROOT/.claude-plugin/plugin.json")"

check "manifest version" "0.3.6" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/.claude-plugin/plugin.json")"

# The marketplace entry is a second copy of the same facts, read by the host that
# installs the plugin rather than the one that loads it. A copy that drifts
# advertises one version and ships another, and nothing else here would say so.
MANIFEST_VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/.claude-plugin/plugin.json")
check "marketplace and manifest agree on the version" \
  "$MANIFEST_VERSION $MANIFEST_VERSION $MANIFEST_VERSION" \
  "$(python3 -c 'import json,sys
plugin = json.load(open(sys.argv[1]))
market = json.load(open(sys.argv[2]))
print(plugin["version"], market["plugins"][0]["version"], market["metadata"]["version"])' \
    "$ROOT/.claude-plugin/plugin.json" "$ROOT/.claude-plugin/marketplace.json")"

check "marketplace and manifest share one description" "" \
  "$(python3 -c 'import json,sys
plugin = json.load(open(sys.argv[1]))["description"]
market = json.load(open(sys.argv[2]))["plugins"][0]["description"]
print("" if plugin == market else "plugin: %s / marketplace: %s" % (plugin, market))' \
    "$ROOT/.claude-plugin/plugin.json" "$ROOT/.claude-plugin/marketplace.json")"

# No skill may hardcode a sibling plugin's cache path.
check "no skill builds a cache path" "" \
  "$(grep -rl 'plugins/cache' "$ROOT/skills" 2>/dev/null)"

echo "== preflight: system tools =="

# A PATH containing none of the required tools.
mkdir -p "$WORK/emptybin"
check_status "missing python3 exits 11" 11 \
  env PATH="$WORK/emptybin" HOME="$WORK" /bin/bash "$ROOT/scripts/preflight.sh"

# Not a git repository at all.
mkdir -p "$WORK/norepo"
check_status "not a git repo exits 13" 13 \
  env HOME="$WORK" PR_REVIEW_SKIP_PLUGINS=1 sh -c "cd '$WORK/norepo' && /bin/bash '$ROOT/scripts/preflight.sh'"

# A git repository whose origin is not GitHub.
mkdir -p "$WORK/gitlab" && git -C "$WORK/gitlab" init -q -b main
git -C "$WORK/gitlab" remote add origin https://gitlab.com/acme/thing.git
check_status "non-github origin exits 13" 13 \
  env HOME="$WORK" PR_REVIEW_SKIP_PLUGINS=1 sh -c "cd '$WORK/gitlab' && /bin/bash '$ROOT/scripts/preflight.sh'"

# The failure message names the remedy.
msg=$(env PATH="$WORK/emptybin" HOME="$WORK" /bin/bash "$ROOT/scripts/preflight.sh" 2>&1 >/dev/null | grep -c '^fix:')
check "failure prints a fix line" "1" "$msg"

echo "== preflight: plugin dependencies =="

mkdir -p "$WORK/repo" && git -C "$WORK/repo" init -q -b main
git -C "$WORK/repo" remote add origin https://github.com/acme/thing.git

settings() { mkdir -p "$WORK/cfg"; printf '%s' "$1" > "$WORK/cfg/settings.json"; }
pf() {
  env HOME="$WORK" PR_REVIEW_SETTINGS="$WORK/cfg/settings.json" PR_REVIEW_SKIP_AUTH=1 \
    sh -c "cd '$WORK/repo' && bash '$ROOT/scripts/preflight.sh'"
}

settings '{"enabledPlugins":{"pr-review-toolkit@claude-plugins-official":true,"github@lounisbou":true}}'
check_status "all dependencies enabled passes" 0 pf

# The github plugin resolves under either marketplace key -- its own and the
# aggregate one -- exactly as the resolver's KEYS does. Either enabled key
# satisfies the dependency; only neither is a failure. Requiring the
# aggregate-key installs to re-install under a key that does not exist yet
# would stop every skill on every machine that has the plugin already.
settings '{"enabledPlugins":{"pr-review-toolkit@claude-plugins-official":true,"github@claude-github":true}}'
check_status "github under the aggregate key passes" 0 pf

settings '{"enabledPlugins":{"pr-review-toolkit@claude-plugins-official":true}}'
check_status "neither github key exits 10" 10 pf

# Reported once, under the canonical key -- not twice, once per variant.
check "the missing github dependency is named once" "1" \
  "$(pf 2>&1 >/dev/null | grep -c '^error:.*github@lounisbou')"
check "the aggregate key is never reported as missing" "0" \
  "$(pf 2>&1 >/dev/null | grep -c 'github@claude-github')"

settings '{"enabledPlugins":{"pr-review-toolkit@claude-plugins-official":false,"github@lounisbou":true}}'
check_status "a disabled dependency exits 10" 10 pf

settings '{"enabledPlugins":{"pr-review-toolkit@claude-plugins-official":true}}'
check_status "an absent dependency exits 10" 10 pf

settings '{ this is not json'
check_status "malformed settings exits 10" 10 pf

settings '{"enabledPlugins":{"pr-review-toolkit@claude-plugins-official":false,"github@lounisbou":true}}'
named=$(pf 2>&1 >/dev/null | grep -c 'pr-review-toolkit')
check "the failure names the offending plugin" "2" "$named"

settings '{"enabledPlugins":"not-a-dict"}'
check_status "enabledPlugins as string exits 10" 10 pf

settings '[]'
check_status "top-level array exits 10" 10 pf

settings '{"enabledPlugins":"not-a-dict"}'
output=$(pf 2>&1)
error_lines=$(printf '%s' "$output" | grep -c '^error:')
fix_lines=$(printf '%s' "$output" | grep -c '^fix:')
traceback_lines=$(printf '%s' "$output" | grep -cE 'Traceback|^[A-Za-z]*Error:')
check "enabledPlugins string produces error lines" "2" "$error_lines"
check "enabledPlugins string produces fix lines" "2" "$fix_lines"
check "enabledPlugins string has no traceback" "0" "$traceback_lines"

settings '[]'
output=$(pf 2>&1)
error_lines=$(printf '%s' "$output" | grep -c '^error:')
fix_lines=$(printf '%s' "$output" | grep -c '^fix:')
traceback_lines=$(printf '%s' "$output" | grep -cE 'Traceback|^[A-Za-z]*Error:')
check "top-level array produces error lines" "2" "$error_lines"
check "top-level array produces fix lines" "2" "$fix_lines"
check "top-level array has no traceback" "0" "$traceback_lines"

# A python3 that dies before printing anything is exactly the "missing"
# variable being empty, which reads the same as "nothing is missing" unless
# the interpreter's own exit code is checked. A fake python3 stands in: it
# behaves like the real one for the earlier version check (invoked as
# "python3 -", one argument) and dies silently for the dependency check
# (invoked as "python3 - $SETTINGS", two arguments).
mkdir -p "$WORK/pybin"
cat > "$WORK/pybin/python3" <<'FAKEPY'
#!/bin/sh
cat >/dev/null
if [ $# -le 1 ]; then
  exit 0
fi
exit 1
FAKEPY
chmod +x "$WORK/pybin/python3"

settings '{"enabledPlugins":{"pr-review-toolkit@claude-plugins-official":true}}'
check_status "a crashing python3 exits 10, not 0" 10 \
  env HOME="$WORK" PR_REVIEW_SETTINGS="$WORK/cfg/settings.json" PR_REVIEW_SKIP_AUTH=1 PATH="$WORK/pybin:$PATH" \
    sh -c "cd '$WORK/repo' && bash '$ROOT/scripts/preflight.sh'"

output=$(env HOME="$WORK" PR_REVIEW_SETTINGS="$WORK/cfg/settings.json" PR_REVIEW_SKIP_AUTH=1 PATH="$WORK/pybin:$PATH" \
  sh -c "cd '$WORK/repo' && bash '$ROOT/scripts/preflight.sh'" 2>&1)
check "a crashing python3 prints an error line" "1" "$(printf '%s' "$output" | grep -c '^error:')"
check "a crashing python3 prints a fix line" "1" "$(printf '%s' "$output" | grep -c '^fix:')"

# The operator's own machine: code-review@claude-plugins-official installed and
# disabled, the two actual dependencies enabled. Not a dependency, so disabling
# it must not block.
settings '{"enabledPlugins":{"pr-review-toolkit@claude-plugins-official":true,"github@lounisbou":true,"code-review@claude-plugins-official":false}}'
check_status "code-review disabled is not a dependency, passes" 0 pf

echo "== preflight: GitHub token =="

# Missing token, missing gh
mkdir -p "$WORK/fakebin"
printf '#!/bin/sh\nexit 1\n' > "$WORK/fakebin/gh"
chmod +x "$WORK/fakebin/gh"
check_status "missing token exits 12" 12 \
  env -u GH_TOKEN HOME="$WORK" PR_REVIEW_SETTINGS="$WORK/cfg/settings.json" PR_REVIEW_SKIP_PLUGINS=1 PATH="$WORK/fakebin:$PATH" \
    sh -c "cd '$WORK/repo' && bash '$ROOT/scripts/preflight.sh'"

# Token via environment variable
check_status "GH_TOKEN set exits 0" 0 \
  env HOME="$WORK" PR_REVIEW_SETTINGS="$WORK/cfg/settings.json" PR_REVIEW_SKIP_PLUGINS=1 GH_TOKEN="dummy-token-12345" \
    sh -c "cd '$WORK/repo' && bash '$ROOT/scripts/preflight.sh'"

echo "== skill documents =="

# No relative .claude/skills path may survive the move into a plugin.
stale=$(grep -rn '\.claude/skills/' "$ROOT/skills" 2>/dev/null || true)
check "no relative skill paths" "" "$stale"


echo "== extracted skills =="

for skill in start-review auto-fix-loop process-comments; do
  doc="$ROOT/skills/$skill/SKILL.md"

  check "$skill frontmatter names itself" "$skill" \
    "$(awk '/^name:/ {print $2; exit}' "$doc" 2>/dev/null)"

  check "$skill runs the preflight first" "1" \
    "$(grep -c 'scripts/preflight.sh' "$doc" 2>/dev/null || echo 0)"

  # The old fake namespace is gone, except for the upstream command this plugin
  # legitimately depends on.
  check "$skill drops the old namespace" "" \
    "$(grep -o 'pr-review-toolkit:[a-z-]*' "$doc" 2>/dev/null | grep -v 'pr-review-toolkit:review-pr' || true)"

  # Prose in a shipped plugin must not name one human language as the reader's.
  check "$skill hard-codes no language" "" \
    "$(grep -o 'French' "$doc" 2>/dev/null || true)"

  # The word "French" not appearing proves nothing if the doc is simply
  # written in French without ever naming the language (a "🇫🇷 Français"
  # heading, or an untranslated template) -- this caught nothing on the
  # original document despite nine French markers sitting in it. Check for
  # actual French prose instead: any accented Latin character at all (plain
  # English technical writing has none), plus a handful of common French
  # words that do not occur in English technical writing.
  check "$skill has no French accented characters" "" \
    "$(grep -o '[àâäéèêëïîôöùûüçÀÂÄÉÈÊËÏÎÔÖÙÛÜÇœŒ]' "$doc" 2>/dev/null | sort -u | tr '\n' ',' || true)"

  check "$skill has no common French words" "" \
    "$(grep -Eiow 'vous|nous|avec|chemin|fichier|sont|une|titre' "$doc" 2>/dev/null | sort -u | tr '\n' ',' || true)"

  # Paths must be plugin-relative, never relative to a project's .claude directory.
  check "$skill uses plugin-root paths" "" \
    "$(grep -o '\.claude/skills/[a-z-]*' "$doc" 2>/dev/null || true)"
done

check "process-comments ships its helper scripts" "4" \
  "$(ls "$ROOT/skills/process-comments/scripts/" 2>/dev/null | grep -c '\.py$')"

echo "== process-comments helper scripts: null-safety =="

# These four scripts are executed directly by the skill, but exercised by no
# other test in this suite. Each is fed a fixture GitHub would plausibly
# send -- a null author, a null user, a null body, an empty PR list -- that
# an unguarded ".get(key, default)" chain (which only substitutes its
# default for an ABSENT key, not a present null) turns into an uncaught
# AttributeError/IndexError instead of a handled "nothing here". A bare
# exit-code check cannot tell a mapped "no data" apart from a crash, so each
# case also asserts there is no traceback and that the printed value is the
# sane one, not an artifact of the crash.
PCSCRIPTS="$ROOT/skills/process-comments/scripts"

# count_open.py: a review thread whose last comment has a null author (a
# deleted GitHub account) must count as pending, not crash.
PCTMP="$WORK/pc-null-author"; mkdir -p "$PCTMP"
printf '%s' '[{"comments":{"nodes":[{"author":null}]}}]' > "$PCTMP/open-threads.json"
printf '%s' '[]' > "$PCTMP/open-issue-comments.json"
printf '%s' '[]' > "$PCTMP/open-reviews.json"
out=$(env PR_REVIEW_TMP="$PCTMP" python3 "$PCSCRIPTS/count_open.py" someone 2>&1)
check "count_open.py survives a null thread author" "0" \
  "$(env PR_REVIEW_TMP="$PCTMP" python3 "$PCSCRIPTS/count_open.py" someone >/dev/null 2>&1; echo $?)"
check "count_open.py null author has no traceback" "0" \
  "$(printf '%s' "$out" | grep -cE 'Traceback|AttributeError')"
check "count_open.py still counts the thread as pending" "1" \
  "$(printf '%s' "$out" | grep -c '^PENDING=1$')"

# filter_reviews.py: a null body and a null user (both legal GitHub payloads)
# must be filtered out / compared safely, not crash the whole batch.
PCTMP="$WORK/pc-null-review"; mkdir -p "$PCTMP"
printf '%s' '[{"body":null,"user":null},{"body":"hello","user":{"login":"alice"}}]' \
  > "$PCTMP/reviews.json"
out=$(env PR_REVIEW_TMP="$PCTMP" python3 "$PCSCRIPTS/filter_reviews.py" bob 2>&1)
check "filter_reviews.py survives a null body and null user" "0" \
  "$(env PR_REVIEW_TMP="$PCTMP" python3 "$PCSCRIPTS/filter_reviews.py" bob >/dev/null 2>&1; echo $?)"
check "filter_reviews.py null review has no traceback" "0" \
  "$(printf '%s' "$out" | grep -cE 'Traceback|AttributeError')"
check "filter_reviews.py keeps only the real review" "Open review body comments: 1" "$out"

# filter_reviews.py: a review already minimized on GitHub (per the
# comments-resolved-batch fixture SKILL.md Phase 3 writes before calling
# this script) must be dropped; a visible review with the same shape must
# survive. This is the regression test for the review-body read side --
# reverting the isMinimized check makes both reviews come back.
PCTMP="$WORK/pc-minimized-review"; mkdir -p "$PCTMP"
printf '%s' '[{"node_id":"PRR_hidden","body":"hide me","user":{"login":"alice"}},{"node_id":"PRR_visible","body":"keep me","user":{"login":"alice"}}]' \
  > "$PCTMP/reviews.json"
printf '%s' '{"PRR_hidden":{"node":{"isMinimized":true}},"PRR_visible":{"node":{"isMinimized":false}}}' \
  > "$PCTMP/reviews-resolved-batch.json"
out=$(env PR_REVIEW_TMP="$PCTMP" python3 "$PCSCRIPTS/filter_reviews.py" bob 2>&1)
check "filter_reviews.py drops a minimized review and keeps the visible one" \
  "Open review body comments: 1" "$out"
check "filter_reviews.py's survivor is the visible node_id, not the hidden one" \
  "PRR_visible" \
  "$(python3 -c "import json; print(json.load(open('$PCTMP/open-reviews.json'))[0]['node_id'])")"

# filter_reviews.py: a resolved-batch entry whose "node" is null -- the id the
# batch could not resolve, the same payload comments-resolved-batch can send
# for an issue comment -- must be treated as "not minimized", not crash.
# ".get('node', {})" would substitute its default only for an ABSENT key, not
# this present null.
PCTMP="$WORK/pc-review-null-node"; mkdir -p "$PCTMP"
printf '%s' '[{"node_id":"PRR_x","body":"hi","user":{"login":"alice"}}]' > "$PCTMP/reviews.json"
printf '%s' '{"PRR_x":{"node":null}}' > "$PCTMP/reviews-resolved-batch.json"
out=$(env PR_REVIEW_TMP="$PCTMP" python3 "$PCSCRIPTS/filter_reviews.py" bob 2>&1)
check "filter_reviews.py survives a null node in the resolved batch" "0" \
  "$(env PR_REVIEW_TMP="$PCTMP" python3 "$PCSCRIPTS/filter_reviews.py" bob >/dev/null 2>&1; echo $?)"
check "filter_reviews.py null node has no traceback" "0" \
  "$(printf '%s' "$out" | grep -cE 'Traceback|AttributeError')"
check "filter_reviews.py null node still counts the review as visible" \
  "Open review body comments: 1" "$out"

# filter_reviews.py: no resolved-batch file at all (a caller that never runs
# the batch step) must behave exactly as before this change -- the minimized
# check is additive, never mandatory.
PCTMP="$WORK/pc-review-no-batch-file"; mkdir -p "$PCTMP"
printf '%s' '[{"node_id":"PRR_y","body":"hi","user":{"login":"alice"}}]' > "$PCTMP/reviews.json"
out=$(env PR_REVIEW_TMP="$PCTMP" python3 "$PCSCRIPTS/filter_reviews.py" bob 2>&1)
check "filter_reviews.py with no resolved-batch file keeps the review" \
  "Open review body comments: 1" "$out"

# extract_user_login.py: an empty PR list (no PR on this branch) is the
# ordinary "not found" response from pr-get, fetched before the skill's own
# "is PR_NUM empty" check runs -- pr_data[0] must not raise IndexError here.
PCTMP="$WORK/pc-empty-pr"; mkdir -p "$PCTMP"
printf '%s' '[]' > "$PCTMP/pr.json"
out=$(env PR_REVIEW_TMP="$PCTMP" python3 "$PCSCRIPTS/extract_user_login.py" 2>&1)
check "extract_user_login.py survives an empty PR list" "0" \
  "$(env PR_REVIEW_TMP="$PCTMP" python3 "$PCSCRIPTS/extract_user_login.py" >/dev/null 2>&1; echo $?)"
check "extract_user_login.py empty PR list has no traceback" "0" \
  "$(printf '%s' "$out" | grep -cE 'Traceback|IndexError')"
check "extract_user_login.py prints an empty login" "" "$out"

# extract_paths.py: the open-threads.json file is simply absent (e.g. Fast
# tier, which skips producing it) -- the unguarded json.load(open(...)) must
# not crash the read.
PCTMP="$WORK/pc-missing-threads"; mkdir -p "$PCTMP"
out=$(env PR_REVIEW_TMP="$PCTMP" python3 "$PCSCRIPTS/extract_paths.py" 2>&1)
check "extract_paths.py survives a missing open-threads.json" "0" \
  "$(env PR_REVIEW_TMP="$PCTMP" python3 "$PCSCRIPTS/extract_paths.py" >/dev/null 2>&1; echo $?)"
check "extract_paths.py missing file has no traceback" "0" \
  "$(printf '%s' "$out" | grep -cE 'Traceback|Error')"
check "extract_paths.py prints nothing for a missing file" "" "$out"

echo "== process-comments: review body resolution =="

PC_DOC="$ROOT/skills/process-comments/SKILL.md"

# The two paragraphs asserting a review body cannot be resolved via the API
# are gone. A pull request review implements the same Minimizable interface
# as an issue comment, so the claim was simply false.
check "process-comments no longer claims a review body cannot be individually resolved" "" \
  "$(grep -n 'cannot be individually resolved' "$PC_DOC" 2>/dev/null || true)"
check "process-comments no longer claims a review body cannot be resolved via API" "" \
  "$(grep -n 'cannot be resolved via API' "$PC_DOC" 2>/dev/null || true)"

# Step 4 resolves a review body the same way it resolves an issue comment --
# comment-resolve on the node id -- so the exact call appears twice: once
# under "For issue comments", once under "For review body comments". Reverting
# the review-body block drops this back to one.
check "comment-resolve is called for both issue comments and review bodies" "2" \
  "$(grep -c 'python3 "\$GH" comment-resolve "\$NODE_ID" --format error-check' "$PC_DOC")"


echo "== install =="

# commands/install.md and commands/doctor.md both tell the user to run
# "${CLAUDE_PLUGIN_ROOT}/install.sh" directly, and their allowed-tools scope
# Bash to that exact executable path. Invoking it through "/bin/bash" (as the
# rest of this suite does, below) works regardless of the file's own mode and
# would never catch a missing execute bit, so this checks the mode itself.
check "install.sh is executable" "executable" \
  "$([ -x "$ROOT/install.sh" ] && echo executable || echo not-executable)"

mkdir -p "$WORK/cfg"
printf '%s' '{"enabledPlugins":{"pr-review-toolkit@claude-plugins-official":true,"github@lounisbou":true}}' \
  > "$WORK/cfg/settings.json"

inst() {
  env HOME="$WORK" PR_REVIEW_SETTINGS="$WORK/cfg/settings.json" PR_REVIEW_SKIP_AUTH=1 \
    sh -c "cd '$WORK/repo' && /bin/bash '$ROOT/install.sh'"
}

check_status "install.sh succeeds when dependencies are met" 0 inst

# It must write nothing: compare the whole listing before and after.
before=$(find "$WORK/cfg" -type f | sort)
inst >/dev/null 2>&1
check "install.sh writes nothing" "$before" "$(find "$WORK/cfg" -type f | sort)"

printf '%s' '{"enabledPlugins":{"pr-review-toolkit@claude-plugins-official":false,"github@lounisbou":true}}' \
  > "$WORK/cfg/settings.json"
check_status "install.sh fails when a dependency is disabled" 10 inst

check "both commands declare a description" "2" \
  "$(grep -l '^description:' "$ROOT"/commands/*.md 2>/dev/null | wc -l | tr -d ' ')"

check "no uninstall script exists" "" \
  "$(ls "$ROOT/uninstall.sh" 2>/dev/null || true)"

echo "== repository policy =="

check "no attribution trailers in history" "0" \
  "$(cd "$ROOT" && git log --format='%B' | grep -ciE 'claude-session|co-authored-by|generated with')"


echo "== skills call only what exists =="

# The reverse of the documentation check. That one asks "is everything that exists
# written down"; this one asks "does everything written down exist". Its absence is
# what let process-comments ship calling ten subcommands that were never there.
# The tool lives in the github plugin now, so the parser this reads is the real
# installed one. An unresolvable dependency is a FAIL, never a skip: a skip here
# would silently retire the only check that catches a phantom subcommand.
GHDIR=$(CLAUDE_GITHUB_ROOT="${CLAUDE_GITHUB_ROOT:-}" python3 "$ROOT/scripts/resolve_github.py" 2>/dev/null)/engine
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
for name in ("start-review", "process-comments", "auto-fix-loop"):
    path = os.path.join(sys.argv[2], "skills", name, "SKILL.md")
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
  check "every skill invocation names something real" "" "$phantom"
fi

echo "== start-review pending review =="

START_DOC="$ROOT/skills/start-review/SKILL.md"

# The pending review is the default destination of a kept comment; the immediate
# path stays for an explicit request. So review-submit lives in exactly one fence,
# and --event never appears outside it.
#
# Every fence, not only the bash ones: the document shows the user a plain fence
# holding the completion summary and a four-backtick fence holding the item
# format, and a call written in either would have been read by nobody. A fence
# opens on three or more backticks and closes on at least as many, which is what
# keeps the ```php example nested inside the item format from closing it.
FENCES='function bt(  c) { c = 0; while (substr($0, c + 1, 1) == "`") c++; return c }
/^```/ { n = bt(); if (!f) { f = 1; fence = n; blk = ""; next }
         if (n >= fence) { CLOSE; f = 0; next } }
f { if (blk == "") s = NR; blk = blk "\n" $0 }'

check "start-review submits from exactly one bash block" "1" \
  "$(awk "${FENCES/CLOSE/if (blk ~ /review-submit/) cnt++} END { print cnt + 0 }" "$START_DOC")"
check "start-review passes --event only beside review-submit" "" \
  "$(awk "${FENCES/CLOSE/if (blk ~ /--event/ && blk !~ /review-submit/) print s}" "$START_DOC")"

# Both section checks below track which "## " heading a line sits under, and a
# heading inside a fence is content the reader is shown, not a section of the
# document: the completion template holds one. Left uncounted, it moves every
# line after it into a section that does not exist.
FENCE_TRACK='function bt(  c) { c = 0; while (substr($0, c + 1, 1) == "`") c++; return c }
/^```/ { n = bt(); if (!f) { f = 1; fence = n } else if (n >= fence) { f = 0 } next }'

# "post" sends nothing. A tool call anywhere in that section is the defect the
# whole design exists to prevent, and it would read as legitimate. The document
# can spell that call four ways, and matching only the quoted one is what let
# `python3 $GH pr-frobnicate` past the contract loop once already.
#
# The alternation is written out here rather than shared through a variable: a
# command-line assignment has its escape sequences processed, so the `\$` of the
# pattern reaches the match as a bare `$`, which is an anchor. The check then
# matches nothing and passes on everything.
check "start-review calls no tool under post" "" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## After "post"$/ { in_post = 1; next }
     !f && /^## / { in_post = 0 }
     in_post && /python3[[:space:]]+("\$GH"|\$GH|"\$\{GH\}"|\$\{GH\})/ { print NR }' "$START_DOC")"

# The pending review is written once, at completion. A write reached from an
# item's own turn would publish part of the walkthrough while it is still running.
check "start-review writes the review only at completion" "" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## / { section = $0 }
     /review-pending-(create|add)/ && section !~ /^## Completion/ { print NR }' "$START_DOC")"

# A decision on the item shown — post, post now, fix on a green gate, next — is the
# order to move on: the walkthrough renders the next item without a second command.
# Only a question, rework and a red gate hold it. A "do not auto-advance" left under
# the post sections would make the user type next after every decision, which is
# the stall this rule removes.
check "start-review advances after post and post now" "" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## After "post( now)?"$/ { in_post = 1; next }
     !f && /^## / { in_post = 0 }
     in_post && /do not auto-advance/ { print NR }' "$START_DOC")"
check "start-review renders the next item after post and post now" "2" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## After "post( now)?"$/ { in_post = 1; next }
     !f && /^## / { in_post = 0 }
     in_post && /Move to the next item without being asked/ { cnt++ }
     END { print cnt + 0 }' "$START_DOC")"

# The three pending subcommands are the new path; the contract loop proves they exist.
for sub in review-pending review-pending-create review-pending-add; do
  check "start-review invokes $sub" "1" \
    "$(grep -cE 'python3[[:space:]]+("\$GH"|\$GH|"\$\{GH\}"|\$\{GH\})[[:space:]]+'"$sub"'( |$)' "$START_DOC" 2>/dev/null | awk '{print ($1>=1)?1:0}')"
done

echo "== start-review comment voice =="

# The comment asks how something works instead of asserting it is broken. These
# four strings are the ones the owner ruled DECIDED after rejecting a comment
# that asserted "X is never reached"; each is proven load-bearing below by
# removing it, rerunning, and restoring.
check "start-review says the comment never asserts a failure" "1" \
  "$(grep -ci "never tells the author" "$START_DOC")"
check "start-review bans colons in the comment" "1" \
  "$(grep -ci "no colon" "$START_DOC")"
check "start-review bans semicolons in the comment" "1" \
  "$(grep -ci "no semicolon" "$START_DOC")"
check "start-review quotes the reference example" "1" \
  "$(grep -c "I have a doubt on the way back" "$START_DOC")"

# Each of the four assertions above passes on the unmodified document; that alone
# does not prove the check discriminates. Remove the sentence it names, rerun the
# single check, confirm it fails, then restore — the loop this file's own CLAUDE.md
# demands for a regression test.
voice_regression() {
  local label="$1" needle="$2" grepflag="$3"
  local after
  cp "$START_DOC" "$WORK/voice-backup.md"
  if [ "$grepflag" = "-i" ]; then
    grep -vi "$needle" "$START_DOC" > "$WORK/voice-stripped.md"
  else
    grep -v "$needle" "$START_DOC" > "$WORK/voice-stripped.md"
  fi
  mv "$WORK/voice-stripped.md" "$START_DOC"
  if [ "$grepflag" = "-i" ]; then
    after=$(grep -ci "$needle" "$START_DOC")
  else
    after=$(grep -c "$needle" "$START_DOC")
  fi
  mv "$WORK/voice-backup.md" "$START_DOC"
  check "start-review voice check for '$label' fails when the sentence is removed" "0" "$after"
}
voice_regression "never tells the author" "never tells the author" "-i"
voice_regression "no colon" "no colon" "-i"
voice_regression "no semicolon" "no semicolon" "-i"
voice_regression "reference example" "I have a doubt on the way back" ""

# Each bash block is its own shell: a variable used in a block that does not
# assign it expands to nothing, silently.
unresolved=$(python3 - "$START_DOC" <<'PYFENCE'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read().split("\n")
names = ("GH", "GH_ROOT", "PR_NUM", "PR_REVIEW_TMP", "HEAD_SHA")
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
check "every start-review bash block derives what it uses" "" "$unresolved"

# Revision 3 -- "fix" runs the gate, prepares the commit and advances. The
# section that used to stop the walkthrough after applying a change now runs the
# project's gate and renders the next item, so the marker that stops a turn must
# be gone from it: the uppercase WAIT this document uses everywhere else to
# forbid auto-advance. A red gate still stops, said in prose, which is why this
# check is case-sensitive -- it forbids the marker, not the waiting.
check "start-review carries no WAIT marker after fix" "" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## After "fix"$/ { in_fix = 1; next }
     !f && /^## / { in_fix = 0 }
     in_fix && /WAIT/ { print NR }' "$START_DOC")"

# A gate whose result is not read is not a gate. Each command is stated with its
# exit code, so a reader of the transcript can tell a green run from a red one
# without trusting the agent's summary of it.
check "start-review states the gate exit code" "1" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## After "fix"$/ { in_fix = 1; next }
     !f && /^## / { in_fix = 0 }
     in_fix && /exit code/ { hits++ }
     END { if (hits > 0) print 1; else print 0 }' "$START_DOC")"

# The prepared commits are created on one word, at completion, and nowhere else:
# the section that ends the walkthrough has to name that word as a command.
check "start-review waits for commit at completion" "1" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## Completion/ { in_done = 1; next }
     !f && /^## / { in_done = 0 }
     in_done && /`commit`/ { hits++ }
     END { if (hits > 0) print 1; else print 0 }' "$START_DOC")"

# A prepared commit is unfinished work if the walkthrough ends before the word
# arrives; a buried mention mid-paragraph must not pass, only the STOP opening.
check "start-review stops on a prepared commit left uncreated" "1" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## Completion/ { in_done = 1; next }
     !f && /^## / { in_done = 0 }
     in_done && index($0, "STOP: <N> prepared commits not created") { hits++ }
     END { if (hits > 0) print 1; else print 0 }' "$START_DOC")"

# The walkthrough is item by item, and three of the user's own commands cover more
# than one item. The rule that forbids advancing has to name them, or an agent that
# reads it literally refuses a command the table grants.
check "start-review names its batch commands in the advance rule" "1" \
  "$(awk '/^NEVER move to the next item/ {
       if ($0 ~ /"post all"/ && $0 ~ /"fix all"/ && $0 ~ /"skip all"/) hits++ }
     END { if (hits == 1) print 1; else print 0 }' "$START_DOC")"

# The skill never batches on its own initiative, and the user's own command may.
# The core principle has to carry that distinction: a blanket "No batching" reads
# as a refusal of "post all", "fix all" and "skip all", which the table grants.
# The line must exist and must say the walkthrough is item by item -- a check that
# only forbade a phrase would pass on a deleted principle.
check "start-review's core principle admits the user's batch commands" "1" \
  "$(awk '/^\*\*Core principle:\*\*/ {
       n++; if ($0 !~ /No batching/ && $0 ~ /one item at a time/) ok++ }
     END { if (n == 1 && ok == 1) print 1; else print 0 }' "$START_DOC")"

# The row grants `drop <n>`; the Completion section is where `drop all` must
# also appear, since both are STOP-shaped words that exist there and nowhere else.
check "start-review discards a prepared commit on drop" "1" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## User Commands/ { section = "cmds"; next }
     !f && /^## Completion/ { section = "done"; next }
     !f && /^## / { section = "" }
     section == "cmds" && /^\| `drop <n>`/ { drop_row = 1 }
     section == "done" && index($0, "drop all") { drop_all = 1 }
     END { if (drop_row && drop_all) print 1; else print 0 }' "$START_DOC")"

# The row promises an unstage command; the Completion section's own bash fence
# must actually carry it, not just describe it in prose.
check "start-review's drop command runs git restore --staged" "1" \
  "$(awk "$FENCE_TRACK"'
     !f && /^## Completion/ { in_done = 1; next }
     !f && /^## / { in_done = 0 }
     in_done && f && index($0, "git restore --staged") { hits++ }
     END { if (hits > 0) print 1; else print 0 }' "$START_DOC")"

echo "== github resolver =="

RESOLVE="$ROOT/scripts/resolve_github.py"

# The suite itself may run with CLAUDE_GITHUB_ROOT set -- that is how the
# contract test above reaches the tool offline. Every case below but the first
# exercises the state-file path, and the override answers before the state file
# is ever opened, so it has to be cleared per case. Left in place it would turn
# each of these into a test of the override it already has, proving nothing.
resolve_state() { env -u CLAUDE_GITHUB_ROOT CLAUDE_PLUGIN_STATE="$1" python3 "$RESOLVE"; }

# 1. The explicit override wins over everything.
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

# 2. A real state file resolves to its installPath.
mkdir -p "$WORK/installed"
python3 - "$WORK/state.json" "$WORK/installed" <<'PY'
import json, sys
json.dump({"version": 2, "plugins": {
    "github@lounisbou": [{"scope": "user", "installPath": sys.argv[2], "version": "0.1.0"}]
}}, open(sys.argv[1], "w"))
PY
check "installPath is read from the state file" "$WORK/installed" \
  "$(resolve_state "$WORK/state.json" 2>&1)"

# 3. Absent dependency fails loudly, and says how to fix it.
printf '{"version":2,"plugins":{}}' > "$WORK/none.json"
check_status "missing dependency exits 1" 1 resolve_state "$WORK/none.json"
check "missing dependency names the fix" "1" \
  "$(resolve_state "$WORK/none.json" 2>&1 | grep -c '^fix:')"

# 4. An installPath recorded but deleted from disk is not a resolution.
python3 - "$WORK/gone.json" <<'PY'
import json, sys
json.dump({"version": 2, "plugins": {
    "github@lounisbou": [{"installPath": "/nonexistent/path/xyz"}]
}}, open(sys.argv[1], "w"))
PY
check_status "recorded but absent path exits 1" 1 resolve_state "$WORK/gone.json"

# 5. A state file of the wrong shape is a failure, never a silent pass.
# Exit code alone cannot tell "the shape guard fired" apart from "some other
# guard fired for an unrelated reason and happened to also exit 1" — assert on
# the distinct NotFound message the shape guard raises.
printf '{"plugins": "not-a-dict"}' > "$WORK/wrong.json"
check_status "wrong-shaped state exits 1" 1 resolve_state "$WORK/wrong.json"
check "wrong-shaped state names the actual problem" "1" \
  "$(resolve_state "$WORK/wrong.json" 2>&1 | grep -c 'has no plugins map')"

printf 'not json at all' > "$WORK/bad.json"
check_status "unparseable state exits 1" 1 resolve_state "$WORK/bad.json"
check "unparseable state names the actual problem" "1" \
  "$(resolve_state "$WORK/bad.json" 2>&1 | grep -c 'is not valid JSON')"

# 6. The aggregate marketplace key resolves as well as the plugin's own key.
# That pair is what the preflight's either-key rule mirrors, so if the resolver
# ever stops accepting one of them the two must be changed together.
mkdir -p "$WORK/installed-agg"
printf '{"version":2,"plugins":{"github@claude-github":[{"scope":"user","installPath":"%s"}]}}' \
  "$WORK/installed-agg" > "$WORK/agg.json"
check "the aggregate key resolves too" "$WORK/installed-agg" \
  "$(resolve_state "$WORK/agg.json" 2>&1)"


echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
