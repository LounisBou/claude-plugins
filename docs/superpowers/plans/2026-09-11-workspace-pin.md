# Workspace Pin Implementation Plan

> **For the orchestrator:** this plan is executed by implementer SESSIONS the orchestrator spawns (`orchestrator:iterm-agents`), one brief per task — never by subagents of the orchestrator's own session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One release, 0.24.0: `workspace.sh pin <source> <name> <ref>` makes a detached worktree of the source under the root, at the commit the ref resolves to, carrying no local material; `list` shows it as `pinned`; `delete` removes it through git with the guards a pin needs; the suite's machine-specific guard ignores a worktree's gitfile; the rulebook names the script where it named the git line.

**Architecture:** one new function `cmd_pin` in `workspace.sh` and one dispatcher entry; one branch in `cmd_delete`; two lines in `cmd_list`; one grep option in the suite; two sentence edits in the rulebook and one in the design's layout block. Seven checks in the suite.

**Tech Stack:** bash 3.2 (the script and the suite), git.

**Spec:** `docs/design.md`, section 37. Sections 30 and 36 bind it.

## Global Constraints

Copied from `CLAUDE.md`; the task's requirements include them.

- **English only, everywhere.** **No vendor or product name in prose**; the runtime is "the host". Load-bearing identifiers exempt.
- **Commits**: Conventional Commits; no trailer, no attribution, no tool name, no session link.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (251 on the base head; this task adds 7, expected `258 passed, 0 failed`); the brand grep returns only exempt occurrences; no accented character outside `docs/`.
- **Release** (spec §8): version in `plugin.json` and both fields of `marketplace.json`: `0.24.0`.
- **Never run `workspace.sh pin` against a real repository from this checkout** — not against the orchestrator's checkout, not against this one: a worktree writes into the source's `.git`. The suite's fixture under its own working directory is the only source you run it on.
- **Every command runs synchronously**, in the tool call that waits for it; the suite is piped to `tail` in the same call.
- **The checkout you work in is already on the phase branch** (the orchestrator committed this plan and the spec on it): do not create another branch.

---

### Task 1: Pin (0.24.0)

**Files:**
- Modify: `skills/orchestrator/scripts/workspace.sh` — `cmd_pin` (new, placed immediately after `cmd_create`), `cmd_delete` (one branch), `cmd_list` (two lines), the dispatcher, the header comment.
- Modify: `tests/run-tests.sh` — one grep option on the machine-specific guard; six checks inserted immediately before the line `unset ORCHESTRATOR_WORKSPACES` that closes the workspace section; one guard inserted immediately after the check `the review brief template pins a worktree`.
- Modify: `skills/orchestrator/SKILL.md` — two sentence edits.
- Modify: `docs/design.md` — the `workspace.sh` line of the §2 layout block only.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.24.0`.
- Already committed on this branch by the orchestrator: `docs/design.md` §37 and this plan.

**Interfaces:**
- Consumes: `die`, `say`, `ROOT_DIR`, the source's git.
- Produces: `pin <source-repo> <name> <ref>` → stdout the path `<root>/<basename of source>/<name>`, stderr `workspace: pinned <short id> from <ref>`; refusals (exit 1, one stderr line): not a repository, a bad name, `pin: the source does not know <ref>`, `pin: already exists, delete it first: <path>`. `list` line for a pin: `<path> | HEAD | <short head> | clean|dirty | pinned`. `delete <pin>`: refuses a dirty tree and a head on no branch of the source unless `--discard`; removes with `git worktree remove` (`--force` under `--discard`); prints `deleted <path>`.

- [ ] **Step 1: Write the failing checks**

In `tests/run-tests.sh`, immediately BEFORE the line `unset ORCHESTRATOR_WORKSPACES` that closes the workspace section (after the second fixture's `bash "$WS" delete "$C2" >/dev/null 2>&1`), insert:

```bash

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
```

Immediately after the check `the review brief template pins a worktree`, insert:

```bash
check "the rulebook pins a reader's copy through the script" "1" "$(grep -c 'workspace.sh pin <source> <round> <head>' "$ROOT/skills/orchestrator/SKILL.md")"
```

- [ ] **Step 2: Run the suite and watch the new checks fail for the right reason**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `252 passed, 6 failed`. The one that passes already: « pin refuses an unknown ref and an existing target » — today's dispatcher refuses `pin` altogether (`unknown command`, exit 1) on both calls, for the wrong reason. Report the count and the first failing check's actual value verbatim before editing the script.

- [ ] **Step 3: `cmd_pin`**

In `skills/orchestrator/scripts/workspace.sh`, immediately after `cmd_create`'s closing `}` (before `cmd_delete()`), insert:

```bash

cmd_pin() {
    local src="" name="" ref=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --*) die "pin: unknown option $1" ;;
            *) if [ -z "$src" ]; then src="$1"; elif [ -z "$name" ]; then name="$1"; elif [ -z "$ref" ]; then ref="$1"; else die "pin: unexpected argument $1"; fi; shift ;;
        esac
    done
    [ -n "$src" ] && [ -n "$name" ] && [ -n "$ref" ] || die "pin: usage: pin <source-repo> <name> <ref>"
    git -C "$src" rev-parse --show-toplevel >/dev/null 2>&1 || die "pin: not a git repository: $src"
    src=$(git -C "$src" rev-parse --show-toplevel)
    printf '%s' "$name" | grep -qE '^[A-Za-z0-9._-]+$' || die "pin: name must match [A-Za-z0-9._-]+: $name"
    local sha
    sha=$(git -C "$src" rev-parse --verify --quiet "$ref^{commit}") || die "pin: the source does not know $ref"
    local target="$ROOT_DIR/$(basename "$src")/$name"
    [ ! -e "$target" ] || die "pin: already exists, delete it first: $target"
    mkdir -p "$(dirname "$target")" || die "pin: cannot create $(dirname "$target")"
    # A detached worktree, and nothing else: a reader's copy carries the code at the head
    # and none of the local material — least of all the orchestrator's briefs and state
    # file — and writes nothing but its metadata into the source, which is the
    # orchestrator's own checkout (§37). A worktree shares the source's remotes.
    git -C "$src" worktree add --quiet --detach "$target" "$sha" 2>/dev/null || { rm -rf "$target"; die "pin: worktree add failed at $sha"; }
    say "pinned $(git -C "$src" rev-parse --short "$sha") from $ref"
    echo "$target"
}
```

- [ ] **Step 4: `cmd_delete` and `cmd_list`**

In `cmd_delete`, immediately after the line `case "$real/" in "$root"/*/*/) ;; *) die "delete: refusing a path outside $root: $path" ;; esac`, insert:

```bash
    if [ -f "$real/.git" ]; then
        # A pinned copy (§37): removed through git so the source forgets it. The second
        # guard is not « commits on no remote branch » — the shared refs would read the
        # source's — but « a head on no branch of the source »: a reader that committed in
        # its copy is the one way to lose work here, the pinned commit itself living in the source.
        if [ "$discard" = 0 ]; then
            [ -z "$(git -C "$real" status --porcelain 2>/dev/null)" ] || die "delete: the tree is dirty; pass --discard: $path"
            [ -n "$(git -C "$real" branch -a --contains HEAD 2>/dev/null)" ] || die "delete: the pin's head is on no branch of the source; pass --discard: $path"
            git -C "$real" worktree remove "$real" || die "delete: worktree remove failed: $real"
        else
            git -C "$real" worktree remove --force "$real" || die "delete: worktree remove failed: $real"
        fi
        echo "deleted $real"
        return 0
    fi
```

In `cmd_list`, replace `[ -d "$d/.git" ] || continue` with `[ -e "$d/.git" ] || continue`, and replace

```bash
        if [ -z "$(git -C "$d" log --branches --not --remotes --oneline 2>/dev/null)" ]; then pushed=pushed; else pushed=unpushed; fi
```

with

```bash
        if [ -f "$d/.git" ]; then pushed=pinned
        elif [ -z "$(git -C "$d" log --branches --not --remotes --oneline 2>/dev/null)" ]; then pushed=pushed; else pushed=unpushed; fi
```

In the dispatcher, add `pin) cmd_pin "$@" ;;` after the `create)` line; in the usage message of the `[ -n "$cmd" ] || die …` line, `{create|delete|list}` becomes `{create|pin|delete|list}`. In the header comment, add after the `create` line: `#   workspace.sh pin <source-repo> <name> <ref>                a detached worktree at that commit, nothing local; prints its path`, and after the `list` line's text add ` (a pin reads HEAD … pinned)`; extend the paragraph « The script never writes the trust record … » with the sentence « A pin writes nothing into the source but its worktree metadata. »

- [ ] **Step 5: Run the suite**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `257 passed, 1 failed` — the rulebook guard. Do not weaken a check to pass; report the actual value and stop if the script and a check disagree on the contract.

- [ ] **Step 6: The suite's guard, the rulebook, the layout block**

In `tests/run-tests.sh`, in the grep that feeds the check `nothing project- or machine-specific in the plugin`, add `--exclude=.git` immediately after `--exclude-dir=.git` (a worktree's gitfile is git's pointer, not the plugin's text). Then, in `skills/orchestrator/SKILL.md`:

(a) In the review paragraph, replace ``a detached worktree of your own checkout (`git worktree add --detach <path> <head>`), never a clone:`` with ``a detached worktree of your own checkout (`workspace.sh pin <source> <round> <head>` — `git worktree add --detach` under the root), never a clone:`` and, in the same sentence, replace ``and `git worktree remove` takes it when the round is judged;`` with ``and `workspace.sh delete` takes it when the round is judged;``.

(b) In the housekeeping boundary, replace ``a reader's pinned copy is a detached worktree of your own checkout, not a clone.`` with ``a reader's pinned copy is a detached worktree of your own checkout, not a clone (`workspace.sh pin`).``

Before each edit, `grep -cF` the literal you replace (expect 1) and `grep -n` it in `tests/run-tests.sh` for a guard; the two guards of 0.23.6 read literals these edits keep intact — confirm and say so in your report.

In `docs/design.md`, in the §2 layout block, replace the line
```
skills/orchestrator/scripts/workspace.sh    a clone per phase, with the project's local material
```
with
```
skills/orchestrator/scripts/workspace.sh    a clone per phase with the project's local material; a pinned worktree per review round
```

Then `./tests/run-tests.sh 2>&1 | tail -1`: `258 passed, 0 failed`.

- [ ] **Step 7: Version**

`.claude-plugin/plugin.json` `version` and both `version` fields of `.claude-plugin/marketplace.json`: `0.24.0`. Then `./tests/run-tests.sh 2>&1 | tail -1`: `258 passed, 0 failed`.

- [ ] **Step 8: Commit and deliver**

One commit, with this exact subject: `feat(workspace): pin a reader's copy as a detached worktree under the root` — the script, the suite, the rulebook, the design's layout line, the two version files. Body: why (a reader's copy made by hand was invisible to `list`, mishandled by `delete`, and read by the suite's guard as a machine path; the script makes and removes it and the rulebook names it). It stacks on the orchestrator's docs commit already on this branch. Push with `git push -u origin workspace-pin`, open the draft PR as the brief says.
