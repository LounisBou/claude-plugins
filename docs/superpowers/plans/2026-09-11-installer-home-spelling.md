# Installer Home Spelling Implementation Plan

> **For the orchestrator:** this plan is executed by implementer SESSIONS the orchestrator spawns (`orchestrator:iterm-agents`), one brief per task — never by subagents of the orchestrator's own session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One release, 0.23.3: the installer and the uninstaller recognise a stored `statusLine.command` whose home is spelled `$HOME`, `${HOME}` or `~` as the tap they wrote, so a second install says « already wired » and leaves the file untouched, and uninstall restores the saved object — instead of wrapping the tap twice and leaving it in place.

**Architecture:** one small function, `normalise_home`, defined identically in `install.sh` and `uninstall.sh` (the two scripts share no file on purpose: each runs alone from the plugin root), applied to `current` before the existing `case`; the `case` itself, the messages and the writes do not change. Six checks in the suite's install section, on a fourth fixture home wired by the installer and then rewritten with the portable spelling.

**Tech Stack:** bash 3.2 (the scripts and the suite), `jq`.

**Spec:** `docs/design.md`, section 33. Section 3.2 (the tap and how it is wired) binds it.

## Global Constraints

Copied from `CLAUDE.md`; the task's requirements include them.

- **English only, everywhere.** **No vendor or product name in prose**; the runtime is "the host". Load-bearing identifiers exempt (`~/.claude/` is one).
- **Commits**: Conventional Commits; no trailer, no attribution, no tool name, no session link.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (223 on the base head; this task adds 6, expected `229 passed, 0 failed`); the brand grep returns only exempt occurrences; no accented character outside `docs/`.
- **Release** (spec §8): version in `plugin.json` and both fields of `marketplace.json`: `0.23.3`.
- **Never run the installer against the real home.** The suite's fixtures run it under `env HOME=<fixture>`; `./install.sh` and `./uninstall.sh` are never run bare from this checkout — the operator's live settings file carries the very spelling this phase is about, and a bare run before the fix lands would wrap his tap twice.
- **Every command runs synchronously**, in the tool call that waits for it; the suite is piped to `tail` in the same call.
- **The checkout you work in is already on the phase branch** (the orchestrator committed this plan and the spec on it): do not create another branch.

---

### Task 1: Installer home spelling (0.23.3)

**Files:**
- Modify: `install.sh` — a function `normalise_home` defined right after `run()`, and one line before the `case "$current" in` of the settings section.
- Modify: `uninstall.sh` — the same function defined right after `say()`, and the same line before its `case`.
- Modify: `tests/run-tests.sh` — six checks appended at the end of the install section, immediately after the check `dry-run writes no tier map` and before the line `echo "== iterm script (argument validation, no automation) =="`.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.23.3`.
- Already committed on this branch by the orchestrator: `docs/design.md` §33 and this plan.

**Interfaces:**
- Consumes: `current` (the stored `statusLine.command`, read by `jq -r '.statusLine.command // ""'`), `TAP_DEST` (expanded), `HOME`.
- Produces: `normalise_home <string>` prints the string with a leading `$HOME/`, `${HOME}/` or `~/` replaced by `$HOME/` expanded, and any other string unchanged; a variable `stored` holding what was read, so `current` carries the normalised form for the `case` while the messages and the wrapping keep the stored spelling.

- [ ] **Step 1: Write the failing checks**

In `tests/run-tests.sh`, immediately after the check `dry-run writes no tier map` (its three lines), insert:

```bash
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
```

- [ ] **Step 2: Run the suite and watch the new checks fail for the right reason**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `223 passed, 6 failed`. The « already wired » checks read `0` (the installer prints `statusLine.command → …` instead); the byte-for-byte checks read a file whose command now starts with the expanded tap path a second time; the restore checks read the doubled object, not `/x/bar.sh`. Report the count and the first failing check's actual value verbatim before editing the scripts.

- [ ] **Step 3: `install.sh`**

Immediately after the line `run()  { if [ "$DRY" = "1" ]; then printf '  [dry-run] %s\n' "$*"; else eval "$@"; fi; }`, insert:

```bash

# A stored command may spell the home as `$HOME`, `${HOME}` or `~` — a settings file kept
# in a repository and meant for more than one machine does — while TAP_DEST is expanded.
# The comparison is made on the expanded spelling; what is stored is never rewritten (§33).
normalise_home() {
  case "$1" in
    '$HOME/'*)   printf '%s' "$HOME/${1#\$HOME/}" ;;
    '${HOME}/'*) printf '%s' "$HOME/${1#\$\{HOME\}/}" ;;
    '~/'*)       printf '%s' "$HOME/${1#\~/}" ;;
    *)           printf '%s' "$1" ;;
  esac
}
```

In the settings section, replace

```bash
case "$current" in
  "$TAP_DEST"|"$TAP_DEST "*)
    say "already wired: $current"
    ;;
  *)
    if [ -n "$current" ]; then new="$TAP_DEST $current"; else new="$TAP_DEST"; fi
```

with

```bash
stored="$current"
current=$(normalise_home "$stored")
case "$current" in
  "$TAP_DEST"|"$TAP_DEST "*)
    say "already wired: $stored"
    ;;
  *)
    if [ -n "$stored" ]; then new="$TAP_DEST $stored"; else new="$TAP_DEST"; fi
```

Nothing else in the file changes: the dry-run branch, the backup, the `jq` write and the verification probe stay as they are.

- [ ] **Step 4: `uninstall.sh`**

Immediately after the line `say() { printf '  %s\n' "$*"; }`, insert the same `normalise_home` function, verbatim, with the same comment. Then replace

```bash
  current=$(jq -r '.statusLine.command // ""' "$SETTINGS" 2>/dev/null || echo "")
  case "$current" in
```

with

```bash
  current=$(jq -r '.statusLine.command // ""' "$SETTINGS" 2>/dev/null || echo "")
  current=$(normalise_home "$current")
  case "$current" in
```

The uninstaller prints no stored spelling, so it needs no `stored` variable.

- [ ] **Step 5: Run the suite**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `229 passed, 0 failed`. Do not weaken a check to pass; report the actual value and stop if a script and a check disagree on the contract.

- [ ] **Step 6: Version**

`.claude-plugin/plugin.json` `version` and both `version` fields of `.claude-plugin/marketplace.json`: `0.23.3`. Then `./tests/run-tests.sh 2>&1 | tail -1`: `229 passed, 0 failed`.

- [ ] **Step 7: Commit and deliver**

One commit, with this exact subject: `fix(install): read the stored status-line command through its home spelling` — the two scripts, `tests/run-tests.sh`, the two version files. Body: why (a portable settings file spells the home as `$HOME` or `~`; the comparison was textual against the expanded path, so a wired file read as unwired, the tap was wrapped twice on the next run and left in place on uninstall; the comparison now runs on the expanded spelling and the stored line is never rewritten). It stacks on the orchestrator's docs commit already on this branch. Push with `git push -u origin installer-home-spelling`, open the draft PR as the brief says.
