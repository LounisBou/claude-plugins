# Workspace Copy And Base Implementation Plan

> **For the orchestrator:** this plan is executed by implementer SESSIONS the orchestrator spawns (`orchestrator:iterm-agents`), one brief per task — never by subagents of the orchestrator's own session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One release, 0.23.5: `workspace.sh create` copies the local settings directory file by file through the source's exclude file — what a pattern names inside the directory does not travel, a pattern naming the directory whole is set aside — and says both counts; and `--base` accepts an `origin/<branch>` remote-tracking ref of the source, fetched into the checkout from the real origin and checked out as `<branch>` tracking it.

**Architecture:** two touches to `cmd_create` in `workspace.sh`: the base resolution (before the clone) and the clone-and-fetch, then the settings-directory copy (step 1 of the copy). Eight checks in the suite's workspace section: three on the existing fixture, extended; five on a second source whose origin is a bare repository advanced from elsewhere.

**Tech Stack:** bash 3.2 (the script and the suite), git.

**Spec:** `docs/design.md`, section 35. Section 30 (the checkout and its copy) binds it.

## Global Constraints

Copied from `CLAUDE.md`; the task's requirements include them.

- **English only, everywhere.** **No vendor or product name in prose**; the runtime is "the host". Load-bearing identifiers exempt.
- **Commits**: Conventional Commits; no trailer, no attribution, no tool name, no session link.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (239 on the base head; this task adds 8, expected `247 passed, 0 failed`); the brand grep returns only exempt occurrences; no accented character outside `docs/`.
- **Release** (spec §8): version in `plugin.json` and both fields of `marketplace.json`: `0.23.5`.
- **The suite touches no network**: the second fixture's origin is a bare repository under the suite's working directory. `tests/e2e.sh` is not touched and not run.
- **Every command runs synchronously**, in the tool call that waits for it; the suite is piped to `tail` in the same call.
- **The checkout you work in is already on the phase branch** (the orchestrator committed this plan and the spec on it): do not create another branch.

---

### Task 1: Workspace copy and base (0.23.5)

**Files:**
- Modify: `skills/orchestrator/scripts/workspace.sh` — `cmd_create`: the base resolution, the clone, the settings-directory copy; the header comment's `create` line.
- Modify: `tests/run-tests.sh` — the existing workspace fixture extended (two lines), three checks inserted after `the local settings directory is copied`, one fixture block plus five checks inserted immediately before the line `unset ORCHESTRATOR_WORKSPACES` that ends the workspace section.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.23.5`.
- Already committed on this branch by the orchestrator: `docs/design.md` §35 and this plan.

**Interfaces:**
- Consumes: `copy_tree`, `die`, `say`, `ROOT_DIR`, the variables of `cmd_create` (`src`, `name`, `base`, `target`, `url`).
- Produces: `--base <local branch>` as before; `--base origin/<branch>` → clone `--no-checkout`, `origin` re-pointed, `git fetch origin <branch>`, `git checkout -B <branch> origin/<branch>`; any other `<remote>/…` or unknown base → `create: the source has no branch or origin/ remote-tracking ref <base>`, exit 1, nothing made. The settings-directory copy → files listed by `git ls-files --others --exclude-from=<reduced exclude file> -- .claude/`, copied one by one; stderr `copied the local settings directory (N files, M skipped by the exclude file)`.

- [ ] **Step 1: Extend the fixture and write the failing checks — the copy**

In `tests/run-tests.sh`, in the workspace fixture, replace the line

```bash
  && mkdir -p ./.claude/ node_modules/dep && echo '{}' > ./.claude/settings.local.json \
```

with

```bash
  && mkdir -p ./.claude/agents ./.claude/worktrees/w1 node_modules/dep && echo '{}' > ./.claude/settings.local.json \
  && echo a > ./.claude/agents/a.md && echo w > ./.claude/worktrees/w1/f \
```

and the line

```bash
  && echo local > LOCAL.md && printf 'LOCAL.md\n/.claude/\n' > .git/info/exclude \
```

with

```bash
  && echo local > LOCAL.md && printf 'LOCAL.md\n/.claude/\n**/.claude/worktrees/\n' > .git/info/exclude \
```

Then, immediately after the check `the local settings directory is copied`, insert:

```bash
# Inside the settings directory, what the exclude file names does not travel — the host
# writes its runtime block there (worktrees, checkpoints) and a whole-directory copy once
# carried 4 GB of worktrees into a checkout (§35). A pattern naming the directory whole is
# set aside: it says the directory stays out of history, which every copied file already does.
check "the settings directory's own files travel" "a" "$(cat "$C/.claude/agents/a.md" 2>/dev/null)"
check "what the exclude file names inside it does not" "0" "$([ -e "$C/.claude/worktrees" ] && echo 1 || echo 0)"
check "and the copy says what it skipped" "1" "$(grep -c 'settings directory (3 files, 1 skipped by the exclude file)' "$WORK/ws.err")"
```

- [ ] **Step 2: Write the failing checks — the base**

In `tests/run-tests.sh`, immediately BEFORE the line `unset ORCHESTRATOR_WORKSPACES` that closes the workspace section (the one right after the `delete with --discard removes the checkout` check), insert:

```bash

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
```

- [ ] **Step 3: Run the suite and watch the new checks fail for the right reason**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `242 passed, 5 failed`. Three pass already, for reasons that hold after the change too: « the settings directory's own files travel » (today's whole copy carries the file), « a base the source does not know is refused » and « and makes no checkout » (today's refusal covers `nope` and `upstream/main` alike: exit 1, nothing made). The five that must fail: « what the exclude file names inside it does not » (the tree is copied today), « and the copy says what it skipped » (today's message carries one count), « a remote-tracking base checks out that branch at the remote's head » and « and tracks it on the real origin » (refused today, no checkout), « list shows it clean and pushed » (no checkout, so no line). Report the count and the first failing check's actual value verbatim before editing the script.

- [ ] **Step 4: The base**

In `skills/orchestrator/scripts/workspace.sh`, `cmd_create`, replace

```bash
    [ -n "$base" ] || base=$(git -C "$src" rev-parse --abbrev-ref HEAD)
    git -C "$src" rev-parse --verify --quiet "refs/heads/$base" >/dev/null || die "create: the source has no branch $base"
```

with

```bash
    [ -n "$base" ] || base=$(git -C "$src" rev-parse --abbrev-ref HEAD)
    # A base is a local branch of the source, or an origin/ remote-tracking ref of it: a
    # source whose local branch lags its remote would otherwise hand the phase a stale base
    # with no way to name the fresh one (§35). Only origin/, because the checkout's origin
    # is pointed at the source's origin and nothing else; the remote's head is fetched into
    # the checkout below, since a clone carries only what the source's local branches reach.
    local remote_branch=""
    if git -C "$src" rev-parse --verify --quiet "refs/heads/$base" >/dev/null; then
        :
    elif [ "${base#origin/}" != "$base" ] && git -C "$src" rev-parse --verify --quiet "refs/remotes/$base" >/dev/null; then
        remote_branch="${base#origin/}"
    else
        die "create: the source has no branch or origin/ remote-tracking ref $base"
    fi
```

Replace the clone line

```bash
    git clone --quiet --branch "$base" "$src" "$target" 2>/dev/null || { rm -rf "$target"; die "create: clone failed from $src"; }
```

with

```bash
    if [ -n "$remote_branch" ]; then
        git clone --quiet --no-checkout "$src" "$target" 2>/dev/null || { rm -rf "$target"; die "create: clone failed from $src"; }
    else
        git clone --quiet --branch "$base" "$src" "$target" 2>/dev/null || { rm -rf "$target"; die "create: clone failed from $src"; }
    fi
```

Then, immediately after the `origin` block (the `if [ -n "$url" ]; then … else … fi` that re-points or removes `origin`), insert:

```bash
    if [ -n "$remote_branch" ]; then
        [ -n "$url" ] || { rm -rf "$target"; die "create: --base $base needs the source to have an origin"; }
        git -C "$target" fetch --quiet origin "$remote_branch" 2>/dev/null || { rm -rf "$target"; die "create: cannot fetch $remote_branch from $url"; }
        # -B, not -b: a --no-checkout clone already made the local branch the source's HEAD
        # names, and -b would refuse it.
        git -C "$target" checkout --quiet -B "$remote_branch" "origin/$remote_branch" 2>/dev/null || { rm -rf "$target"; die "create: cannot check out $remote_branch from origin/$remote_branch"; }
    fi
```

- [ ] **Step 5: The copy**

In `cmd_create`, replace the block

```bash
    # 1. The project's local settings directory, whole.
    if [ -d "$src/.claude/" ]; then
        copy_tree "$src" "$target" "/.claude/" || { rm -rf "$target"; die "create: copying the local settings directory failed"; }
        say "copied the local settings directory ($(find "$target/.claude/" -type f | wc -l | tr -d ' ') files)"
    fi
```

with

```bash
    # 1. The project's local settings directory — minus what the source's exclude file
    #    names INSIDE it. The host writes a runtime block into every repository's exclude
    #    file (worktrees, checkpoints, a mailbox), and a copy of the directory whole once
    #    carried two full worktrees, 4 GB, each with a `.git` pointing at the source (§35).
    #    A pattern naming the directory whole is set aside: it says the directory stays out
    #    of history, which every copied file already does. Git reads the reduced file, so
    #    the patterns mean what they mean to git; the files are copied one by one, so what
    #    is skipped is never read.
    if [ -d "$src/.claude/" ]; then
        local rules="$target/.git/workspace-rules" copied=0 skipped=0
        if [ -f "$src/.git/info/exclude" ]; then
            grep -vE '^(/|\*\*/)?\.claude/?$' "$src/.git/info/exclude" > "$rules"
        else
            : > "$rules"
        fi
        while IFS= read -r f; do
            [ -n "$f" ] || continue
            copy_tree "$src" "$target" "$f" || { rm -rf "$target"; die "create: copying the local settings directory failed at $f"; }
            copied=$((copied + 1))
        done <<EOF
$(git -C "$src" ls-files --others --exclude-from="$rules" -- .claude/)
EOF
        skipped=$(git -C "$src" ls-files --others --ignored --directory --exclude-from="$rules" -- .claude/ | grep -c .)
        rm -f "$rules"
        say "copied the local settings directory ($copied files, $skipped skipped by the exclude file)"
    fi
```

Note `local f` is already declared for the loop below (`local n=0 f`): move that declaration's `f` up — make the first line of this block `local rules="$target/.git/workspace-rules" copied=0 skipped=0 f` and change the later `local n=0 f` to `local n=0`.

In the header comment, the `create` line becomes `#   workspace.sh create <source-repo> <name> [--base <branch|origin/branch>]   prints the checkout's path`.

- [ ] **Step 6: Run the suite**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `247 passed, 0 failed`. Do not weaken a check to pass; report the actual value and stop if the script and a check disagree on the contract. If « the copy says what it skipped » reads a different count, print `$WORK/ws.err`'s line and stop: the count is the contract.

- [ ] **Step 7: Version**

`.claude-plugin/plugin.json` `version` and both `version` fields of `.claude-plugin/marketplace.json`: `0.23.5`. Then `./tests/run-tests.sh 2>&1 | tail -1`: `247 passed, 0 failed`.

- [ ] **Step 8: Commit and deliver**

One commit, with this exact subject: `fix(workspace): copy the settings directory through the exclude file, accept a remote base` — the script, `tests/run-tests.sh`, the two version files. Body: why (the host writes a runtime block into the exclude file naming worktrees and checkpoints under the settings directory, and a whole copy carried them; a source whose local branch lags its remote had no way to name the fresh base). It stacks on the orchestrator's docs commit already on this branch. Push with `git push -u origin workspace-copy-and-base`, open the draft PR as the brief says.
