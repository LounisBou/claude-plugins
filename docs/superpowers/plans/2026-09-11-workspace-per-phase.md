# Workspace Per Phase Implementation Plan

> **For the orchestrator:** this plan is executed by implementer SESSIONS the orchestrator spawns (`orchestrator:iterm-agents`), one brief per task — never by subagents of the orchestrator's own session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One release, 0.23.0: a phase runs in a clone made for it, with the project's local material copied in, so the one-writer rule is structural and a sandbox can allow one root for every implementer.

**Architecture:** a new bash script `skills/orchestrator/scripts/workspace.sh` with `create`, `delete` and `list`; a suite section that exercises it on a temporary repository it makes; a live-round change that launches the probe in a checkout the script made; three touches to the rulebook and one sentence in each of two templates.

**Tech Stack:** bash 3.2, git. No `jq`, no Python.

**Spec:** `docs/design.md`, section 30. Sections 20 (trust) and 8 (release) bind it.

## Global Constraints

Copied from `CLAUDE.md`; the task's requirements include them.

- **English only, everywhere.** **No vendor or product name in prose**; the runtime is "the host". Load-bearing identifiers exempt. **The suite's brand guard exempts only the path forms `~/.claude/` and `/.claude/` (with the slashes)** — write the local settings directory as `"$src/.claude/"`, `/.claude/*`, `./.claude/`, never bare; in prose say « the project's local settings directory ».
- **Commits**: Conventional Commits; no trailer, no attribution, no tool name, no session link.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (197 on the base head; this task adds 13, expected `210 passed, 0 failed`); the brand grep returns only exempt occurrences; no accented character outside `docs/`.
- **Release** (spec §8): version in `plugin.json` and both fields of `marketplace.json`: `0.23.0`.
- **Never run anything against the live app from the suite.** The live round (`tests/e2e.sh`) is the orchestrator's to run; it gains changes here that the implementer writes but does not run.
- **Every command runs synchronously**, in the tool call that waits for it; the suite is piped to `tail` in the same call.
- **Branches**: created with `git switch -c <name> <base> --no-track`, never `git checkout -b X origin/Y`.
- **The design's layout block (§2) already lists the new script**; the suite's layout check reads it, so nothing to add there.

---

### Task 1: A checkout per phase, with the project's local material (0.23.0)

**Files:**
- Create: `skills/orchestrator/scripts/workspace.sh` (mode 755, like `brief-lint.sh`).
- Modify: `tests/run-tests.sh` — a new section `== workspace ==` inserted immediately before the line `echo "== brief lint =="`.
- Modify: `tests/e2e.sh` — the workspace root exported after `SANDBOX` is made; the probe spawned in a checkout the script makes; one check that the session runs in it; one check that the checkout is deleted after its close.
- Modify: `skills/orchestrator/SKILL.md` — the one-writer bullet, the « Launch » step, the « Terminate » step, the « Environment preparation » bullet.
- Modify: `templates/agent-phase-brief.md` — one bullet after « Working directory ».
- Modify: `templates/orchestrator-succession-brief.md` — one sentence at the end of step 3.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.23.0`.
- Commit (already in the worktree, written by the orchestrator): `docs/design.md` (section 30 and the §2 layout line), and this plan file.

**Interfaces:**
- Consumes: `git clone --branch`, `git remote get-url|set-url|remove`, `git ls-files --others --ignored --exclude-from`, `git log --branches --not --remotes`, `git status --porcelain`; `ORCHESTRATOR_WORKSPACES` (root, default `$HOME/dev/workspaces`).
- Produces: `workspace.sh create <source> <name> [--base <ref>]` → stdout: the checkout path `<root>/<basename of source>/<name>`, exactly one line; stderr: one `workspace: …` line per copied category; exit 1 and one `workspace: <reason>` line on refusal, nothing created. `workspace.sh delete <path> [--discard]` → stdout `deleted <real path>`; exit 1 on a path outside the root, or on a dirty tree or unpushed commit without `--discard`. `workspace.sh list` → one line per checkout: `<path> | <branch> | <short head> | clean|dirty | pushed|unpushed`. The manifest is `<repository>/.claude/workspace-manifest`, one relative path per line, `#` comments.

- [ ] **Step 1: Write the failing checks**

In `tests/run-tests.sh`, immediately before the line `echo "== brief lint =="`, insert:

```bash
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
  && mkdir -p ./.claude/ node_modules/dep && echo '{}' > ./.claude/settings.local.json \
  && printf '.env\nabsent.txt\n# a comment\n' > ./.claude/workspace-manifest \
  && echo local > LOCAL.md && printf 'LOCAL.md\n/.claude/\n' > .git/info/exclude \
  && echo secret > .env && echo '.env' > .gitignore && echo dep > node_modules/dep/index.js \
  && git add .gitignore && git commit -q -m "Ignore the environment file" )
export ORCHESTRATOR_WORKSPACES="$WORK/wsroot"
out=$(bash "$WS" create "$SRC" phase-1 --base main 2>"$WORK/ws.err")
check "create prints the checkout path under the root" "$WORK/wsroot/proj/phase-1" "$out"
C="$WORK/wsroot/proj/phase-1"
check "the checkout is on the base branch at the source's head" "main|$(git -C "$SRC" rev-parse HEAD)" \
  "$(git -C "$C" rev-parse --abbrev-ref HEAD 2>/dev/null)|$(git -C "$C" rev-parse HEAD 2>/dev/null)"
check "origin is the source's origin, not the source" "git@example.invalid:owner/proj.git" \
  "$(git -C "$C" remote get-url origin 2>/dev/null)"
check "the local settings directory is copied" "{}" "$(cat "$C/.claude/settings.local.json" 2>/dev/null)"
check "the exclude file's file is copied" "local" "$(cat "$C/LOCAL.md" 2>/dev/null)"
check "the manifest's present file is copied and the absent one is said" "secret|1" \
  "$(cat "$C/.env" 2>/dev/null)|$(grep -c 'missing: absent.txt' "$WORK/ws.err")"
check "the build tree does not travel" "ok" "$([ -d "$C/.git" ] && [ ! -e "$C/node_modules" ] && echo ok || echo bad)"
check_status "create on an existing target refuses" 1 bash "$WS" create "$SRC" phase-1
check "and leaves it intact" "local" "$(cat "$C/LOCAL.md" 2>/dev/null)"
( cd "$C" && git config user.email t@local && git config user.name t && echo more >> README.md && git commit -q -am "Local work" )
check "list shows the checkout, clean and unpushed" "1" "$(bash "$WS" list 2>/dev/null | grep -c "/proj/phase-1 | main | [0-9a-f]* | clean | unpushed$")"
check_status "delete refuses an unpushed commit" 1 bash "$WS" delete "$C"
check_status "delete refuses a path outside the root" 1 bash "$WS" delete "$SRC"
check "delete with --discard removes the checkout" "deleted|0" \
  "$(bash "$WS" delete "$C" --discard 2>/dev/null | cut -d' ' -f1)|$([ -e "$C" ] && echo 1 || echo 0)"
unset ORCHESTRATOR_WORKSPACES
```

- [ ] **Step 2: Run the suite and watch the new checks fail for the right reason**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `197 passed, 13 failed` — every new check fails because the script does not exist (`bash: …/workspace.sh: No such file or directory`, exit 127, empty outputs). Report the first failing check's actual value verbatim before writing the script. If the count is not 13, the checks were not inserted as given: stop and compare against Step 1.

- [ ] **Step 3: Write the script**

Create `skills/orchestrator/scripts/workspace.sh` with exactly this content, then `chmod 755` it:

```bash
#!/bin/bash
# workspace.sh — a checkout per phase, with the project's local material.
#
#   workspace.sh create <source-repo> <name> [--base <ref>]   prints the checkout's path
#   workspace.sh delete <path> [--discard]                     refuses unpushed work unless told
#   workspace.sh list                                          one line per checkout under the root
#
# Root: ORCHESTRATOR_WORKSPACES, else ~/dev/workspaces. A checkout lives at
# <root>/<basename of the source>/<name>.
#
# Why it exists: a git worktree writes into its source repository, so no single sandbox
# path contains it; a clone does, and a clone per phase makes the one-writer rule a fact
# instead of a queue. But a clone carries what git tracks and nothing else — not the
# project's local settings directory, not what its exclude file keeps out of history, not
# an environment file — so a session in it behaved like a stranger's. The copy is part of
# making the checkout, not a step after it (design §30).
#
# The script never writes the host's trust record (that is `spawn --trust`), never
# launches anything, and never touches the source.

set -uo pipefail

die() { echo "workspace: $*" >&2; exit 1; }
say() { echo "workspace: $*" >&2; }

ROOT_DIR="${ORCHESTRATOR_WORKSPACES:-$HOME/dev/workspaces}"

cmd="${1:-}"
[ -n "$cmd" ] || die "usage: workspace.sh {create|delete|list} ... (see header)"
shift

# copy_tree <source-root> <checkout-root> <relative-path>: 1 when absent, 2 when the copy fails.
copy_tree() {
    local from="$1/$3" to="$2/$3"
    [ -e "$from" ] || return 1
    mkdir -p "$(dirname "$to")" || return 2
    cp -R "$from" "$to" || return 2
}

trim() { printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }

cmd_create() {
    local src="" name="" base=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --base) base="${2:-}"; shift 2 ;;
            --*) die "create: unknown option $1" ;;
            *) if [ -z "$src" ]; then src="$1"; elif [ -z "$name" ]; then name="$1"; else die "create: unexpected argument $1"; fi; shift ;;
        esac
    done
    [ -n "$src" ] && [ -n "$name" ] || die "create: usage: create <source-repo> <name> [--base <ref>]"
    git -C "$src" rev-parse --show-toplevel >/dev/null 2>&1 || die "create: not a git repository: $src"
    src=$(git -C "$src" rev-parse --show-toplevel)
    printf '%s' "$name" | grep -qE '^[A-Za-z0-9._-]+$' || die "create: name must match [A-Za-z0-9._-]+: $name"
    [ -n "$base" ] || base=$(git -C "$src" rev-parse --abbrev-ref HEAD)
    git -C "$src" rev-parse --verify --quiet "refs/heads/$base" >/dev/null || die "create: the source has no branch $base"
    local target="$ROOT_DIR/$(basename "$src")/$name"
    [ ! -e "$target" ] || die "create: already exists, delete it first: $target"
    mkdir -p "$(dirname "$target")" || die "create: cannot create $(dirname "$target")"
    git clone --quiet --branch "$base" "$src" "$target" 2>/dev/null || { rm -rf "$target"; die "create: clone failed from $src"; }

    # origin is the real remote, so the implementer's push reaches it; a source without
    # one yields a checkout without one, and says so.
    local url
    url=$(git -C "$src" remote get-url origin 2>/dev/null || true)
    if [ -n "$url" ]; then
        git -C "$target" remote set-url origin "$url" || { rm -rf "$target"; die "create: cannot point origin at $url"; }
    else
        git -C "$target" remote remove origin >/dev/null 2>&1
        say "the source has no origin; the checkout has none either"
    fi

    # 1. The project's local settings directory, whole.
    if [ -d "$src/.claude/" ]; then
        copy_tree "$src" "$target" "/.claude/" || { rm -rf "$target"; die "create: copying the local settings directory failed"; }
        say "copied the local settings directory ($(find "$target/.claude/" -type f | wc -l | tr -d ' ') files)"
    fi

    # 2. What the exclude file keeps out of history, listed by git itself so the patterns
    #    are read the way git reads them and only present files are copied.
    local n=0 f
    if [ -f "$src/.git/info/exclude" ]; then
        while IFS= read -r f; do
            [ -n "$f" ] || continue
            case "/$f" in /.claude/*) continue ;; esac
            copy_tree "$src" "$target" "$f" || { rm -rf "$target"; die "create: copying $f failed"; }
            n=$((n + 1))
        done <<EOF
$(git -C "$src" ls-files --others --ignored --exclude-from="$src/.git/info/exclude")
EOF
    fi
    say "copied $n excluded files"

    # What was copied is kept out of the checkout's own history the way the source keeps
    # it out of its own: otherwise every checkout reads dirty from birth, and `delete`
    # refuses it for work that is not work.
    {
        echo "# workspace.sh: the source's local material, copied in, never committed"
        [ -f "$src/.git/info/exclude" ] && cat "$src/.git/info/exclude"
        [ -d "$src/.claude/" ] && echo "/.claude/"
    } >> "$target/.git/info/exclude"

    # 3. The optional manifest: one relative path per line, a file or a directory. Absent
    #    is said and skipped (a manifest serves more than one machine); leaving the
    #    repository is refused; build trees never travel.
    local manifest="$src/.claude/workspace-manifest" copied=0 missing=""
    if [ -f "$manifest" ]; then
        while IFS= read -r f || [ -n "$f" ]; do
            f=$(trim "${f%%#*}")
            [ -n "$f" ] || continue
            case "$f" in /*|..|../*|*/..|*/../*) rm -rf "$target"; die "create: manifest path leaves the repository: $f" ;; esac
            case "$f" in .git|.git/*|node_modules|node_modules/*|vendor|vendor/*) say "manifest: never copied: $f"; continue ;; esac
            if copy_tree "$src" "$target" "$f"; then copied=$((copied + 1)); echo "/$f" >> "$target/.git/info/exclude"; else missing="$missing $f"; fi
        done < "$manifest"
        if [ -n "$missing" ]; then say "manifest: $copied copied, missing:$missing"; else say "manifest: $copied copied, 0 missing"; fi
    fi

    echo "$target"
}

cmd_delete() {
    local path="" discard=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --discard) discard=1; shift ;;
            --*) die "delete: unknown option $1" ;;
            *) [ -z "$path" ] || die "delete: unexpected argument $1"; path="$1"; shift ;;
        esac
    done
    [ -n "$path" ] || die "delete: usage: delete <path> [--discard]"
    [ -d "$path" ] || die "delete: no such checkout: $path"
    local real root
    real=$(cd "$path" && pwd -P)
    mkdir -p "$ROOT_DIR" || die "delete: cannot read the root $ROOT_DIR"
    root=$(cd "$ROOT_DIR" && pwd -P)
    case "$real/" in "$root"/*/*/) ;; *) die "delete: refusing a path outside $root: $path" ;; esac
    if [ "$discard" = 0 ]; then
        [ -z "$(git -C "$real" status --porcelain 2>/dev/null)" ] || die "delete: the tree is dirty; commit and push, or pass --discard: $path"
        [ -z "$(git -C "$real" log --branches --not --remotes --oneline 2>/dev/null)" ] || die "delete: commits on no remote branch; push, or pass --discard: $path"
    fi
    rm -rf "$real" || die "delete: rm failed: $real"
    echo "deleted $real"
}

cmd_list() {
    [ -d "$ROOT_DIR" ] || return 0
    local d br head state pushed
    for d in "$ROOT_DIR"/*/*/; do
        [ -d "$d/.git" ] || continue
        d="${d%/}"
        br=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)
        head=$(git -C "$d" rev-parse --short HEAD 2>/dev/null)
        if [ -z "$(git -C "$d" status --porcelain 2>/dev/null)" ]; then state=clean; else state=dirty; fi
        if [ -z "$(git -C "$d" log --branches --not --remotes --oneline 2>/dev/null)" ]; then pushed=pushed; else pushed=unpushed; fi
        echo "$d | $br | $head | $state | $pushed"
    done
}

case "$cmd" in
    create) cmd_create "$@" ;;
    delete) cmd_delete "$@" ;;
    list) cmd_list "$@" ;;
    *) die "unknown command: $cmd" ;;
esac
```

- [ ] **Step 4: Run the suite**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `210 passed, 0 failed`. If a check fails, read its actual value. Do not weaken a check to pass; report the actual value and stop if the script and the check disagree on the contract.

- [ ] **Step 5: The live round (written, not run)**

In `tests/e2e.sh`:

(a) Immediately after the line `trap cleanup EXIT`, add:

```bash
# Every checkout the round makes lands under the sandbox, so cleanup's rm -rf takes them.
export ORCHESTRATOR_WORKSPACES="$SANDBOX/ws"
WS="$ROOT/skills/orchestrator/scripts/workspace.sh"
```

(b) In the `== spawn ==` block, replace the line

```bash
spawn_out=$(bash "$AGENT" spawn --dir "$SANDBOX/repo" --tier "$tier" --title e2e-probe --trust \
```

with

```bash
# The probe runs in a checkout the script made from the round's repository, not in the
# repository itself: that is the flow the method uses from 0.23.0, and the proof that
# trust and the sandbox let a fresh root through (§30).
WSDIR=$(bash "$WS" create "$SANDBOX/repo" e2e-probe --base main 2>/dev/null)
check "a checkout was made for the probe" "$SANDBOX/ws/repo/e2e-probe" "$WSDIR"
[ -n "$WSDIR" ] || exit 1
spawn_out=$(bash "$AGENT" spawn --dir "$WSDIR" --tier "$tier" --title e2e-probe --trust \
```

(c) Immediately after the check `the live process carries the tier's model`, add:

```bash
# The session's working directory is the checkout, read from the process, not assumed.
check "the session runs in its checkout" "1" \
  "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -c "^n$(cd "$WSDIR" && pwd -P)\$")"
```

(d) In the `== a hidden pane ==` block, immediately after the line `TTY=""`, add:

```bash
check "the probe's checkout is deleted after its close" "0" \
  "$(bash "$WS" delete "$WSDIR" --discard >/dev/null 2>&1; [ -e "$WSDIR" ] && echo 1 || echo 0)"
```

Do not run `tests/e2e.sh`; the orchestrator runs it on the pinned head.

- [ ] **Step 6: The rulebook and the templates**

In `skills/orchestrator/SKILL.md`:

(a) The bullet that begins `- **One writer per repository at a time.** Never have two implementer agents holding the same working directory, even for disjoint files.` — replace that opening (up to and including « disjoint files. ») with:

```
- **One writer per checkout, and a checkout per phase.** Never have two implementer agents holding the same working directory, even for disjoint files; a phase runs in a clone `workspace.sh create` makes for it (§30 of the design), so the rule is structural and the orchestrator's own checkout is never lent out.
```

The rest of the bullet (« Observed cost: … queue the next dispatch. ») is unchanged.

(b) In « The agents' lifecycle is yours », step 1 « Launch », replace `iterm-agent.sh spawn --dir <the checkout the wave writes in> --right-of self` with `workspace.sh create <source> <phase> --base <branch>` (it prints the path; the project's local material is copied in) then `iterm-agent.sh spawn --dir <that path> --trust --right-of self` — keep everything from `--right-of self --title "Implementer : <phase>" --prompt` onward byte for byte: the suite pins that literal (`the rulebook spawns beside the orchestrator`).

(c) In step 4 « Terminate », after `verify with `ps`.` add: `Then `workspace.sh delete <path>` — it refuses unpushed work unless told `--discard`, which a shelved phase needs — and `workspace.sh list` as the proof that nothing of the phase is left.`

(d) The bullet `- **Environment preparation is orchestrator housekeeping**, not implementation: worktree setup, copying untracked local material (version pins, local decrypt keys), granting test databases.` — replace `worktree setup, copying untracked local material (version pins, local decrypt keys)` with `the phase's checkout (`skills/orchestrator/scripts/workspace.sh create <source> <phase> --base <branch>`, which copies the project's local material: its settings directory, what the exclude file keeps out of history, the paths its manifest names)`.

Before each edit, `grep -n` the literal you replace in `tests/run-tests.sh`; the orchestrator read no pin on (a), (c) or (d), and one on the launch line of (b), which the instruction above preserves. Say in your report what you found.

In `templates/agent-phase-brief.md`, immediately after the line `- Working directory: `{{WORKTREE}}` — never leave it.`, add:

```
- This checkout is a clone the orchestrator made for this phase: `origin` is the real remote, the base branch is checked out, the project's local material is copied in. Nothing outside it is yours to write.
```

In `templates/orchestrator-succession-brief.md`, at the end of step 3 (the one that begins `3. Run `ListAgents`.`), append the sentence: `Then `workspace.sh list` under the state directory's root: every checkout it shows belongs to a phase that is open or was not cleaned up; none is yours to delete before you know which.`

Then `./tests/run-tests.sh 2>&1 | tail -1` again: still `210 passed, 0 failed`; and `bash skills/orchestrator/scripts/brief-lint.sh` on a brief instantiated from the phase template is not needed — the live round lints one.

- [ ] **Step 7: Version**

`.claude-plugin/plugin.json` `version` and both `version` fields of `.claude-plugin/marketplace.json`: `0.23.0`. Then `./tests/run-tests.sh 2>&1 | tail -1`: `210 passed, 0 failed`.

- [ ] **Step 8: Commit and deliver**

Two commits, in this order, with these exact subjects:

1. `docs(design): a checkout per phase, with the project's local material` — `docs/design.md` and `docs/superpowers/plans/2026-09-11-workspace-per-phase.md`, as found in the worktree.
2. `feat(orchestrator): make a checkout per phase with the project's local material` — the script, `tests/run-tests.sh`, `tests/e2e.sh`, `skills/orchestrator/SKILL.md`, the two templates, the two version files. Body: why (a worktree cannot be contained under one sandbox root and a clone can; a clone carries none of the project's local material, so the copy is part of making it; the one-writer rule becomes structural).

Push the branch, open the draft PR as the brief says.
