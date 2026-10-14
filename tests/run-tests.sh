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

check "manifest version" "0.5.1" \
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

# Scopes: the host merges user, project and local settings; the later wins.
pfs() {
  env HOME="$WORK" PR_REVIEW_SETTINGS="$WORK/cfg/settings.json" PR_REVIEW_SKIP_AUTH=1 \
    sh -c "cd '$WORK/repo' && bash '$ROOT/scripts/preflight.sh'"
}
mkdir -p "$WORK/repo/.claude"
settings '{"enabledPlugins":{"pr-review-toolkit@claude-plugins-official":true}}'
printf '%s' '{"enabledPlugins":{"github@lounisbou":true}}' > "$WORK/repo/.claude/settings.json"
check_status "a dependency enabled only at project scope passes" 0 pfs
rm -f "$WORK/repo/.claude/settings.json"

settings '{"enabledPlugins":{"pr-review-toolkit@claude-plugins-official":true,"github@lounisbou":true}}'
printf '%s' '{"enabledPlugins":{"github@lounisbou":false}}' > "$WORK/repo/.claude/settings.local.json"
check_status "disabled at local scope while enabled at user fails" 10 pfs
rm -f "$WORK/repo/.claude/settings.local.json"

mkdir -p "$WORK/cfgdir"
printf '%s' '{"enabledPlugins":{"pr-review-toolkit@claude-plugins-official":true,"github@lounisbou":true}}' > "$WORK/cfgdir/settings.json"
check_status "CLAUDE_CONFIG_DIR is read as the user scope" 0 \
  env HOME="$WORK" CLAUDE_CONFIG_DIR="$WORK/cfgdir" PR_REVIEW_SKIP_AUTH=1 \
    sh -c "cd '$WORK/repo' && bash '$ROOT/scripts/preflight.sh'"

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

echo "== install: the GitHub login through gh =="

# Every external command install.sh may run is a fake on a PATH built from
# scratch: the host's own gh and brew must stay out of reach, so nothing is
# installed for real and no browser opens. The fakes log their arguments.
# FAKE_SECRET stands for the token gh would hold; it must never reach output.
FAKE_SECRET="fake-token-not-real-7f3a9c"
PY_REAL=$(python3 -c 'import sys; print(sys.executable)')
TPL="$WORK/auth-tpl"
mkdir -p "$TPL/gh_2.99.0_linux_amd64/bin"

cat > "$TPL/gh" <<'FAKE'
#!/bin/sh
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "auth token")
    [ -f "$FAKE_STATE/token" ] && { cat "$FAKE_STATE/token"; exit 0; }
    exit 1 ;;
  "auth login")
    case " $* " in *" --help "*) echo "  -c, --clipboard   Copy one-time OAuth device code to clipboard"; exit 0 ;; esac
    echo "! First copy your one-time code: ABCD-1234" >&2
    [ -n "${FAKE_LOGIN_FAILS:-}" ] || printf '%s' "$FAKE_SECRET" > "$FAKE_STATE/token"
    exit 0 ;;
esac
exit 0
FAKE
cat > "$TPL/brew" <<'FAKE'
#!/bin/sh
echo "brew $*" >> "$FAKE_LOG"
[ "$1 $2" = "install gh" ] && cp "$FAKE_TPL/gh" "$FAKE_BIN/gh"
exit 0
FAKE
cat > "$TPL/uname" <<'FAKE'
#!/bin/sh
case "$1" in -m) echo "$FAKE_ARCH" ;; *) echo "$FAKE_OS" ;; esac
FAKE
cat > "$TPL/curl" <<'FAKE'
#!/bin/sh
echo "curl $*" >> "$FAKE_LOG"
case "$*" in *url_effective*) echo "https://github.com/cli/cli/releases/tag/v2.99.0"; exit 0 ;; esac
out=""; prev=""; url=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; url="$a"; done
case "$url" in
  *_checksums.txt) cp "${FAKE_SUMS:-$FAKE_TPL/checksums.txt}" "$out" ;;
  *) cp "$FAKE_TPL/gh.tar.gz" "$out" ;;
esac
FAKE
chmod +x "$TPL/gh" "$TPL/brew" "$TPL/uname" "$TPL/curl"
cp "$TPL/gh" "$TPL/gh_2.99.0_linux_amd64/bin/gh"
tar -czf "$TPL/gh.tar.gz" -C "$TPL" gh_2.99.0_linux_amd64
# The release's checksum list, in its own format: one that matches the archive,
# and one whose line for it is wrong.
SUM=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$TPL/gh.tar.gz")
printf '%s  gh_2.99.0_linux_arm64.tar.gz\n%s  gh_2.99.0_linux_amd64.tar.gz\n' "$(printf '%064d' 1)" "$SUM" > "$TPL/checksums.txt"
printf '%s  gh_2.99.0_linux_amd64.tar.gz\n' "$(printf '%064d' 0)" > "$TPL/checksums-bad.txt"

# auth_case <name> <os> <fakes...>: a fresh bin, home and state for one case.
# The real tools the scripts need are linked in one by one; the fakes are
# copies, never written through a link.
auth_case() {
  A="$WORK/auth/$1"; AOS="$2"; shift 2
  rm -rf "$A" && mkdir -p "$A/bin" "$A/home" "$A/state"
  : > "$A/log"
  for tool in bash sh git tar mktemp cp mkdir chmod rm grep cat dirname head; do
    ln -s "$(command -v "$tool")" "$A/bin/$tool"
  done
  # The checksum tool the machine has: sha256sum, or shasum where it is missing.
  for tool in sha256sum shasum; do
    command -v "$tool" >/dev/null 2>&1 && ln -s "$(command -v "$tool")" "$A/bin/$tool"
  done
  # The interpreter itself: a version manager's shim needs tools this PATH lacks.
  ln -s "$PY_REAL" "$A/bin/python3"
  # curl is always the fake: the preflight only asks that one exists.
  for fake in uname curl "$@"; do rm -f "$A/bin/$fake" && cp "$TPL/$fake" "$A/bin/$fake"; done
}
# auth_run <script args...>: run in the GitHub clone with nothing inherited.
auth_run() {
  env -i HOME="$A/home" PATH="$A/bin" FAKE_LOG="$A/log" FAKE_STATE="$A/state" FAKE_TPL="$TPL" \
    FAKE_BIN="$A/bin" FAKE_OS="$AOS" FAKE_ARCH=x86_64 FAKE_SECRET="$FAKE_SECRET" \
    PR_REVIEW_SKIP_PLUGINS=1 ${AUTH_EXTRA:-} \
    /bin/sh -c "cd '$WORK/repo' && bash \"\$@\"" sh "$@" > "$A/out" 2>&1
  echo $? > "$A/code"
}
LOGIN_LINE="gh auth login --hostname github.com --git-protocol https --web --clipboard"
leaked=0
leak_check() { grep -q "$FAKE_SECRET" "$A/out" && leaked=$((leaked + 1)); }

# 1. macOS, gh missing, no token: Homebrew installs gh, then the browser login.
auth_case mac-no-gh Darwin brew
auth_run "$ROOT/install.sh"; leak_check
check "missing gh on macOS: install.sh exits 0" "0" "$(cat "$A/code")"
check "missing gh on macOS: brew install gh is run" "1" "$(grep -cx 'brew install gh' "$A/log")"
check "missing gh on macOS: then gh auth login --web" "1" "$(grep -cx "$LOGIN_LINE" "$A/log")"

# 2. gh present, no token: no install, the login.
auth_case mac-no-token Darwin brew gh
auth_run "$ROOT/install.sh"; leak_check
check "no token: install.sh exits 0" "0" "$(cat "$A/code")"
check "no token: nothing installed" "0" "$(grep -c '^brew' "$A/log")"
check "no token: gh auth login --web is run" "1" "$(grep -cx "$LOGIN_LINE" "$A/log")"

# 3. gh holds a token: nothing runs but the question.
auth_case mac-token Darwin brew gh
printf '%s' "$FAKE_SECRET" > "$A/state/token"
auth_run "$ROOT/install.sh"; leak_check
check "token present: install.sh exits 0" "0" "$(cat "$A/code")"
check "token present: no install and no login" "0" "$(grep -cE '^brew|auth login' "$A/log")"

# 4. GH_TOKEN in the environment: gh is not even asked.
auth_case env-token Darwin brew
AUTH_EXTRA="GH_TOKEN=$FAKE_SECRET" auth_run "$ROOT/install.sh"; leak_check
check "GH_TOKEN set: install.sh exits 0 and runs nothing" "0 0" "$(cat "$A/code") $(wc -l < "$A/log" | tr -d ' ')"

# 5. macOS with neither gh nor Homebrew: a mapped refusal naming the remedy.
auth_case mac-no-brew Darwin
auth_run "$ROOT/install.sh"; leak_check
check "no Homebrew: exits 11" "11" "$(cat "$A/code")"
check "no Homebrew: error and fix lines, the fix names brew.sh" "1 1" \
  "$(grep -c '^error: gh is not installed' "$A/out") $(grep -c '^fix: .*brew\.sh' "$A/out")"

# 6. Linux, gh missing: the official release binary into ~/.local/bin, no root.
auth_case linux-no-gh Linux
auth_run "$ROOT/install.sh"; leak_check
check "missing gh on Linux: install.sh exits 0" "0" "$(cat "$A/code")"
check "missing gh on Linux: the release archive for this machine is fetched" "1" \
  "$(grep -c 'releases/download/v2.99.0/gh_2.99.0_linux_amd64.tar.gz' "$A/log")"
check "missing gh on Linux: gh lands in ~/.local/bin" "executable" \
  "$([ -x "$A/home/.local/bin/gh" ] && echo executable || echo missing)"
check "missing gh on Linux: then gh auth login --web" "1" "$(grep -cx "$LOGIN_LINE" "$A/log")"
check "missing gh on Linux: the release checksum list is fetched from the same tag" "1" \
  "$(grep -c 'releases/download/v2.99.0/gh_2.99.0_checksums.txt' "$A/log")"

# 6b. An archive that does not match its checksum line is refused, and nothing
# lands in ~/.local/bin.
auth_case linux-bad-sum Linux
AUTH_EXTRA="FAKE_SUMS=$TPL/checksums-bad.txt" auth_run "$ROOT/install.sh"; leak_check
check "a checksum mismatch exits 11 with an error line" "11 1" \
  "$(cat "$A/code") $(grep -c '^error: .*does not match its release checksum' "$A/out")"
check "a checksum mismatch installs nothing" "absent 0" \
  "$([ -e "$A/home/.local/bin/gh" ] && echo present || echo absent) $(grep -c 'auth login --hostname' "$A/log")"

# 6c. A checksum list with no line for the archive is a refusal too.
printf '%s  gh_2.99.0_linux_arm64.tar.gz\n' "$(printf '%064d' 1)" > "$WORK/sums-missing.txt"
auth_case linux-no-sum Linux
AUTH_EXTRA="FAKE_SUMS=$WORK/sums-missing.txt" auth_run "$ROOT/install.sh"; leak_check
check "a missing checksum line exits 11 and installs nothing" "11 absent" \
  "$(cat "$A/code") $([ -e "$A/home/.local/bin/gh" ] && echo present || echo absent)"

# 7. The login does not complete: exit 12 and the one command that retries it.
auth_case login-fails Darwin gh
AUTH_EXTRA="FAKE_LOGIN_FAILS=1" auth_run "$ROOT/install.sh"; leak_check
check "an unfinished login exits 12 with the retry command" "12 1" \
  "$(cat "$A/code") $(grep -cx 'fix:   /pr-review:install' "$A/out")"

# 8. doctor's --check changes nothing: no install, no login, just the verdict.
auth_case check-only Darwin brew gh
auth_run "$ROOT/install.sh" --check; leak_check
check "install.sh --check exits 12 without a login" "12 0" \
  "$(cat "$A/code") $(grep -cE '^brew|auth login' "$A/log")"

# 9. A skill's preflight with no token says the one command that fixes it.
auth_case preflight-no-token Darwin gh
auth_run "$ROOT/scripts/preflight.sh"; leak_check
check "preflight without a token exits 12 naming /pr-review:install" "12 1 1" \
  "$(cat "$A/code") $(grep -c '^error: no GitHub token available' "$A/out") $(grep -cx 'fix:   /pr-review:install' "$A/out")"

# 10. The preflight finds the gh that install.sh unpacked into ~/.local/bin.
auth_case preflight-local-gh Linux
mkdir -p "$A/home/.local/bin" && cp "$TPL/gh" "$A/home/.local/bin/gh"
printf '%s' "$FAKE_SECRET" > "$A/state/token"
auth_run "$ROOT/scripts/preflight.sh"; leak_check
check "preflight reads the token through ~/.local/bin/gh" "0" "$(cat "$A/code")"

check "the token never appears in any output" "0" "$leaked"
check "no case printed a traceback" "" \
  "$(grep -lE 'Traceback|line [0-9]+:' "$WORK"/auth/*/out 2>/dev/null)"

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

check "process-comments ships its triage script, and nothing else" "triage.py" \
  "$(ls "$ROOT/skills/process-comments/scripts/" 2>/dev/null | grep '\.py$' | tr '\n' ' ' | sed 's/ $//')"

echo "== process-comments triage: null-safety and filtering =="

# triage.py is run by the module (--stdin, after fetching through the github
# tool) and by the Bash route (--gh, fetching itself). Each case feeds it a
# payload GitHub plausibly sends -- a null author, a null user, a null body, a
# null node, an empty PR list -- that an unguarded ".get(key, default)" chain
# (which substitutes its default only for an ABSENT key, never a present null)
# turns into a traceback instead of a handled "nothing here". An exit code
# alone cannot tell a mapped failure from a crash, so each case also reads the
# value printed and asserts no traceback.
TRIAGE="$ROOT/skills/process-comments/scripts/triage.py"
PR_OK='{"number":7,"user":{"login":"author"},"title":"T","html_url":"https://x/7","body":"intent"}'

# triage <stdin json> <python expression on the document `d`>
triage() {
  printf '%s' "$1" | python3 "$TRIAGE" --stdin 2>"$WORK/triage.err" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$2" 2>&1
}
no_traceback() { grep -cE 'Traceback|Error:' "$WORK/triage.err"; }

check "triage counts a thread whose last author is null as pending" "1 FAST" \
  "$(triage '{"pr":['"$PR_OK"'],"threads":[{"id":"T1","comments":{"nodes":[{"author":null}]}}]}' '"%d %s" % (d["pending"], d["tier"])')"
check "triage null author has no traceback" "0" "$(no_traceback)"

check "triage auto-passes a thread the PR author answered last" "0 1 EXIT" \
  "$(triage '{"pr":['"$PR_OK"'],"threads":[{"id":"T1","comments":{"nodes":[{"author":{"login":"rev"},"body":"q"},{"author":{"login":"author"},"body":"a"}]}}]}' '"%d %d %s" % (d["pending"], d["counts"]["auto_passed"], d["tier"])')"

check "triage keeps only the real review of a null body and a null user" "1 alice" \
  "$(triage '{"pr":['"$PR_OK"'],"reviews":[{"body":null,"user":null},{"node_id":"PRR_a","body":"hello","user":{"login":"alice"}}]}' '"%d %s" % (d["counts"]["review_bodies"], d["items"][0]["author"])')"
check "triage null review has no traceback" "0" "$(no_traceback)"

check "triage drops the PR author's own review" "0" \
  "$(triage '{"pr":['"$PR_OK"'],"reviews":[{"node_id":"PRR_a","body":"self","user":{"login":"author"}}]}' 'd["pending"]')"

# A review or an issue comment minimized on GitHub is resolved: dropped. The
# visible one with the same shape survives. Reverting the isMinimized check
# makes both come back.
check "triage drops a minimized review and keeps the visible one" "PRR_visible" \
  "$(triage '{"pr":['"$PR_OK"'],"reviews":[{"node_id":"PRR_hidden","body":"x","user":{"login":"alice"}},{"node_id":"PRR_visible","body":"y","user":{"login":"alice"}}],"reviews_resolved":{"PRR_hidden":{"node":{"isMinimized":true}},"PRR_visible":{"node":{"isMinimized":false}}}}' '",".join(i["id"] for i in d["items"])')"
check "triage drops a minimized issue comment and keeps the visible one" "IC_visible" \
  "$(triage '{"pr":['"$PR_OK"'],"issue_comments":[{"id":1,"node_id":"IC_hidden","body":"x","user":{"login":"bob"}},{"id":2,"node_id":"IC_visible","body":"y","user":{"login":"bob"}}],"issue_resolved":{"IC_hidden":{"node":{"isMinimized":true}}}}' '",".join(i["node_id"] for i in d["items"])')"

check "triage treats a null node in the resolved batch as visible" "1" \
  "$(triage '{"pr":['"$PR_OK"'],"reviews":[{"node_id":"PRR_x","body":"hi","user":{"login":"alice"}}],"reviews_resolved":{"PRR_x":{"node":null}}}' 'd["pending"]')"
check "triage null node has no traceback" "0" "$(no_traceback)"

check "triage with no resolved batch at all keeps the review" "1" \
  "$(triage '{"pr":['"$PR_OK"'],"reviews":[{"node_id":"PRR_y","body":"hi","user":{"login":"alice"}}]}' 'd["pending"]')"

# An empty PR list is pr-get's ordinary "no PR on this branch": a document that
# says so, not an IndexError.
check "triage answers an empty PR list with no PR" "None no open pull request for this branch" \
  "$(triage '{"pr":[]}' '"%s %s" % (d["pr"], d["error"])')"
check "triage empty PR list has no traceback" "0" "$(no_traceback)"

check "triage lists the paths of open threads once each, sorted" "a.ts,b.ts" \
  "$(triage '{"pr":['"$PR_OK"'],"threads":[{"path":"b.ts","comments":{"nodes":[]}},{"path":"a.ts","comments":{"nodes":[]}},{"path":"a.ts","comments":{"nodes":[]}},{"path":"c.ts","isResolved":true}]}' '",".join(d["paths"])')"

check "triage finds the image URLs of an issue comment" "https://user-images.githubusercontent.com/1/a.png" \
  "$(triage '{"pr":['"$PR_OK"'],"issue_comments":[{"node_id":"IC_1","body":"see https://user-images.githubusercontent.com/1/a.png).","user":{"login":"bob"}}]}' '",".join(d["items"][0]["images"])')"

check "triage announces the workload in one line" "PR #7 — 3 open comment(s): 1 review thread(s), 1 issue comment(s), 1 review body comment(s)." \
  "$(triage '{"pr":['"$PR_OK"'],"threads":[{"id":"T","comments":{"nodes":[{"author":{"login":"rev"}}]}}],"issue_comments":[{"node_id":"IC","body":"x","user":{"login":"r"}}],"reviews":[{"node_id":"R","body":"y","user":{"login":"r"}}]}' 'd["announce"]')"
check "triage picks the full tier from 3 comments" "FULL" \
  "$(triage '{"pr":['"$PR_OK"'],"issue_comments":[{"node_id":"a","body":"1"},{"node_id":"b","body":"2"},{"node_id":"c","body":"3"}]}' 'd["tier"]')"

out=$(printf 'not json' | python3 "$TRIAGE" --stdin 2>&1)
code=$?
check "triage refuses bad stdin with an error line, no traceback" "1 1 0" \
  "$code $(printf '%s' "$out" | grep -c '^error:') $(printf '%s' "$out" | grep -c 'Traceback')"
out=$(python3 "$TRIAGE" --gh "$WORK/no-such-gh.py" 2>&1)
code=$?
check "triage refuses a missing engine with an error line, no traceback" "1 1 0" \
  "$code $(printf '%s' "$out" | grep -c '^error:') $(printf '%s' "$out" | grep -c 'Traceback')"

# The Bash route, end to end, against a stand-in engine that answers each
# subcommand from fixtures and records what it was asked.
mkdir -p "$WORK/fakegh"
cat > "$WORK/fakegh/gh.py" <<'FAKEGH'
import json, os, sys
log = os.path.join(os.path.dirname(__file__), "calls.log")
with open(log, "a") as fh:
    fh.write(" ".join(sys.argv[1:2] + [a for a in sys.argv[2:] if not a.startswith("/")]) + "\n")
cmd = sys.argv[1]
answers = {
    "pr-get": [{"number": 7, "user": {"login": "author"}}],
    "pr-issue-comments": [{"id": 1, "node_id": "IC_1", "body": "q", "user": {"login": "rev"}}],
    "pr-reviews": [{"node_id": "PRR_1", "body": "r", "user": {"login": "rev"}}],
    "pr-threads": [{"id": "PRRT_1", "path": "a.ts", "comments": {"nodes": [{"author": {"login": "rev"}}]}}],
}
if cmd == "comments-resolved-batch":
    ids = json.load(open(sys.argv[2]))
    print(json.dumps({i: {"node": {"isMinimized": i == "IC_1"}} for i in ids}))
else:
    print(json.dumps(answers[cmd]))
FAKEGH
out=$(python3 "$TRIAGE" --gh "$WORK/fakegh/gh.py" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["pending"], ",".join(i["type"] for i in d["items"]))')
check "triage's Bash route fetches, resolves and counts" "2 review-thread,review-body" "$out"
check "triage's Bash route asks for the open threads by formatter" "1" \
  "$(grep -c '^pr-threads 7 --format open-threads$' "$WORK/fakegh/calls.log")"
check "triage's Bash route checks both node id sets" "2" \
  "$(grep -c '^comments-resolved-batch' "$WORK/fakegh/calls.log")"

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
# comment-resolve on the node id -- so the exact request appears twice: once
# under "For issue comments", once under "For review body comments". Reverting
# the review-body block drops this back to one.
check "comment-resolve is called for both issue comments and review bodies" "2" \
  "$(grep -c '^{"command": "comment-resolve", "args": {"node_id": "<node_id>", "format": "error-check"}}$' "$PC_DOC")"


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

# Installing needs no git repository: install and doctor run from any directory.
# The repository check belongs to the skills, whose preflight runs at their start.
printf '%s' '{"enabledPlugins":{"pr-review-toolkit@claude-plugins-official":true,"github@lounisbou":true}}' \
  > "$WORK/cfg/settings.json"
outside() {
  env HOME="$WORK" PR_REVIEW_SETTINGS="$WORK/cfg/settings.json" PR_REVIEW_SKIP_AUTH=1 \
    sh -c "cd '$WORK/norepo' && /bin/bash \"\$@\"" sh "$@"
}
check_status "install.sh outside a git repository exits 0" 0 outside "$ROOT/install.sh"
check_status "install.sh --check outside a git repository exits 0" 0 outside "$ROOT/install.sh" --check
check "install.sh outside a git repository never mentions the origin remote" "0" \
  "$(outside "$ROOT/install.sh" 2>&1 | grep -c 'origin')"
output=$(outside "$ROOT/scripts/preflight.sh" 2>&1)
check "a skill's preflight outside a git repository still refuses with exit 13" "13" \
  "$(outside "$ROOT/scripts/preflight.sh" >/dev/null 2>&1; echo $?)"
check "a skill's preflight outside a git repository prints its error and fix pair" "1 1" \
  "$(printf '%s\n' "$output" | grep -c '^error: no git remote named origin') $(printf '%s\n' "$output" | grep -c '^fix:   run this from a GitHub repository clone')"

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

  # The same contract for the requests the skills make of the mcp__github__gh
  # tool: each one-line JSON object in a json fence that names a "command" is
  # mapped by the engine's own stdin-json mapper (the one the tool runs) and
  # parsed by the real parser, placeholders filled with a value of their type.
  # An unknown command, an argument the subcommand does not take, a missing
  # positional or a formatter that does not exist all land here.
  requests=$(python3 - "$GHDIR" "$ROOT" <<'PYREQ'
import json, os, re, sys, tempfile
sys.path.insert(0, sys.argv[1])
import gh
from ghlib import fmt, stdinjson, errors
NUMBERS = {"pr", "line", "start-line", "review-id"}
def fill(key, value):
    if isinstance(value, dict):
        return {k: fill(k, v) for k, v in value.items()}
    if isinstance(value, list):
        return [fill(key, v) for v in value]
    if isinstance(value, str) and re.fullmatch(r"<[^>]*>", value):
        return 1 if key in NUMBERS else "x"
    return value
bad, seen = [], 0
for name in ("start-review", "process-comments", "auto-fix-loop"):
    path = os.path.join(sys.argv[2], "skills", name, "SKILL.md")
    fence = None
    for i, line in enumerate(open(path, encoding="utf-8"), 1):
        stripped = line.strip()
        if stripped.startswith(chr(96) * 3):
            fence = None if fence is not None else stripped[3:]
            continue
        if fence != "json" or not stripped.startswith("{"):
            continue
        try:
            request = json.loads(stripped)
        except ValueError:
            bad.append("%s:%d not JSON" % (name, i))
            continue
        if "command" not in request:
            continue
        seen += 1
        request = fill("", request)
        fmt_name = (request.get("args") or {}).get("format")
        if fmt_name and fmt_name not in fmt._FORMATTERS:
            bad.append("%s:%d format %s" % (name, i, fmt_name))
        with tempfile.TemporaryDirectory() as tmp:
            try:
                argv = stdinjson.build_argv(gh.build_parser(), request, tmp)
                gh.build_parser().parse_args(argv)
            except errors.GhError as exc:
                bad.append("%s:%d %s" % (name, i, exc.message))
            except SystemExit:
                bad.append("%s:%d rejected by the parser" % (name, i))
print("%d %s" % (seen, " ".join(bad)))
PYREQ
)
  check "every tool request in a skill maps onto the real parser" "" "${requests#* }"
  check "the skills make tool requests at all" "1" "$([ "${requests%% *}" -ge 8 ] 2>/dev/null && echo 1 || echo 0)"
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
check "start-review passes an event only beside review-submit" "" \
  "$(awk "${FENCES/CLOSE/if (blk ~ /--event|\"event\"/ && blk !~ /review-submit/) print s}" "$START_DOC")"
# And the one event it passes is COMMENT: a review opened with any other is
# submitted with a verdict the user never gave.
check "start-review submits with the COMMENT event alone" "" \
  "$(grep -oE '"event": "[A-Z_]+"' "$START_DOC" | grep -v '"COMMENT"' || true)"

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
     in_post && /python3[[:space:]]+("\$GH"|\$GH|"\$\{GH\}"|\$\{GH\})|"command":/ { print NR }' "$START_DOC")"

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
    "$(grep -cE '^\{"command": "'"$sub"'"' "$START_DOC" 2>/dev/null | awk '{print ($1>=1)?1:0}')"
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

echo "== the hooks module and the routes without it =="

check "hooks.json names the module" "./register.ts" \
  "$(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["modules"]))' "$ROOT/hooks/hooks.json")"

# The tools the skills call are the ones the module registers, by name. The
# module lists them as mcp__pr-review__<name>.
check "process-comments calls the triage tool the module registers" "1 1" \
  "$(grep -c 'mcp__pr-review__open_comments' "$PC_DOC" | awk '{print ($1>=1)?1:0}') $(grep -c "OPEN_COMMENTS = 'open_comments'" "$ROOT/hooks/triage.ts")"
check "auto-fix-loop calls the loop tool the module registers" "1 1" \
  "$(grep -c 'mcp__pr-review__loop' "$ROOT/skills/auto-fix-loop/SKILL.md" | awk '{print ($1>=1)?1:0}') $(grep -c "LOOP_TOOL = 'loop'" "$ROOT/hooks/loop.ts")"

# A session where modules do not load (claude -p, an older host) has neither
# the github tool nor this plugin's: every skill keeps a route that works there.
for doc in "$START_DOC" "$PC_DOC"; do
  check "$(basename "$(dirname "$doc")") keeps the engine route for a session without the tool" "1" \
    "$(awk "$FENCE_TRACK"'
       f && /resolve_github\.py/ { r = 1 }
       f && /engine\/gh\.py" --stdin-json </ { g = 1 }
       END { print (r && g) ? 1 : 0 }' "$doc")"
done
check "process-comments keeps the triage route for a session without its tool" "1" \
  "$(grep -c 'scripts/triage.py" --gh "\$GH_ROOT/engine/gh.py"' "$PC_DOC")"
check "auto-fix-loop keeps its state by hand where the loop tool is not listed" "1" \
  "$(grep -c 'When the tool is not listed, keep the same state yourself' "$ROOT/skills/auto-fix-loop/SKILL.md")"

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
