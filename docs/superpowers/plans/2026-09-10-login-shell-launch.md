# Login Shell Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A spawned session inherits the operator's full environment — the package manager's binaries included — because the tab runs its launch file through a login shell instead of `/bin/sh`.

**Architecture:** One change in the launcher: the program handed to the app becomes `<login shell> -l <launch file>`, the shell being `ORCHESTRATOR_LOGIN_SHELL`, else `SHELL`, else `/bin/zsh`. The launch file's content does not change and still `exec`s the CLI by absolute path. The dry run prints the program line so the suite can read it; the live round reads the spawned process's `PATH` with `ps -E`.

**Tech Stack:** Python 3 over the app's API module, bash 3.2 for the suites. No new dependency.

**Spec:** `docs/design.md`, section 22 — « The tab runs its launch through a login shell ». Sections 8 and 14 bind it.

## Global Constraints

Copied from `CLAUDE.md`; every task's requirements include them.

- **English only, everywhere**: code, comments, identifiers, output strings, documentation, commit messages, branch names, PR text.
- **No vendor or product name in prose.** The runtime is "the host"; its sessions are "sessions" or "agents". Model names in examples are placeholders (`a-model`).
- **Load-bearing identifiers are exempt**: `~/.claude/`, `.claude-plugin/`, `CLAUDE_CONFIG_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_CODE_SESSION_ID`, `claude-orchestrator`, `ListAgents`, `SendMessage`. Anything new gets a neutral name (`ORCHESTRATOR_*`).
- **Commits**: Conventional Commits; no co-author trailer, no generated-with attribution, no tool name, no session link — nothing after the body. Subject in the imperative, body explaining *why*.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (175 checks on the base head; this plan adds 3); `grep -rniI 'claude' . --exclude-dir=.git` returns only exempt occurrences; no accented character or French word outside `docs/`.
- **Release** (spec §8): the version lives in `.claude-plugin/plugin.json` and in BOTH fields of `.claude-plugin/marketplace.json`. This branch bumps to `0.19.0`.
- The unit suite runs with no terminal automation and no network. Anything that needs the app goes to `tests/e2e.sh`, run by the operator at the host's `!` prompt — **never by an implementer session**.
- Never run `spawn`, `close`, `move` or `rotate` against the live app from an implementer session. Dry runs only (`ORCHESTRATOR_DRY_RUN=1`).

---

### Task 1: The program handed to the app is a login shell (release 0.19.0)

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` — a new global after `SELF_TTY` (line 35); the comment in `build_command` (lines 221-226); the docstring of `write_launch_script` (lines 243-249); in `cmd_spawn`, the dry-run print block (after `print("anchor=…")`) and the line `command = "/bin/sh " + script`.
- Modify: `tests/run-tests.sh` — three checks appended to the `== iterm-agents spawn (dry run) ==` section, right after the check « the launch execs the CLI by absolute path », and the comment above that check (lines 392-393).
- Modify: `tests/e2e.sh` — one check after « the session is running on that tty ».
- Modify: `skills/iterm-agents/SKILL.md` — one « Caveats » entry; `README.md` — the `iterm-agents` row.
- Modify: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` — version `0.19.0`.
- Commit (already written, uncommitted in the worktree): `docs/design.md` section 22.

**Interfaces:**
- Consumes: `write_launch_script(command, title) -> path` and the dry-run print block, both existing.
- Produces: `LOGIN_SHELL = os.environ.get("ORCHESTRATOR_LOGIN_SHELL") or os.environ.get("SHELL") or "/bin/zsh"`; the dry run prints `program=<LOGIN_SHELL> -l <launch-file>` (the literal text `<launch-file>`, since a dry run writes no file); the live spawn hands the app `"%s -l %s" % (LOGIN_SHELL, script)`.

- [ ] **Step 1: Write the failing dry-run checks**

In `tests/run-tests.sh`, immediately after the line
`check "the launch execs the CLI by absolute path" "1" "$(printf '%s' "$cmd" | grep -cE 'exec /[^ ]+/')"`
insert:

```bash
# The tab runs the launch through a LOGIN shell, so the session inherits the operator's
# PATH — the package manager's binaries included — rather than the app's bare default.
# Observed: no spawned session could run `gh`, so none could open a pull request. The CLI
# is still named absolutely inside the launch: finding the program must not depend on the
# operator's dotfiles, only the session's environment does.
check "the tab runs the launch through a login shell" "1" "$(printf '%s' "$out" | grep -c '^program=.* -l <launch-file>$')"
check "the login shell is the operator's" "1" "$(env ORCHESTRATOR_LOGIN_SHELL=/bin/bash ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --prompt p 2>&1 | grep -c '^program=/bin/bash -l ')"
check "the launch text itself is unchanged by the shell" "1" "$(env ORCHESTRATOR_LOGIN_SHELL=/bin/bash ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" --prompt p 2>&1 | sed -n 's/^launch=//p' | grep -cE '^cd .* && .* && exec /[^ ]+/')"
```

Also replace the two comment lines just above the « execs the CLI by absolute path » check:

```bash
# The app runs this as the session's program, with none of a login shell's PATH: an
# unresolved name exits at once and the session dies before its tty can be read.
```

with:

```bash
# Named absolutely even though the tab now runs a login shell: a dotfile that breaks PATH
# must not be able to kill the launch, and the session dies before its tty can be read
# when the name does not resolve.
```

- [ ] **Step 2: Run them to verify they fail**

Run: `./tests/run-tests.sh 2>&1 | grep -E 'login shell|unchanged by the shell|passed'`
Expected: the first two FAIL (no `program=` line exists); the third passes already (the launch text is what it is). `176 passed, 2 failed` at the end.

- [ ] **Step 3: The global and the program**

In `skills/iterm-agents/scripts/iterm_agent.py`, after the `SELF_TTY = …` line:

```python
# The shell the tab runs the launch through. A LOGIN shell, so the session inherits the
# operator's environment — the package manager's binaries included — instead of the bare
# default the app hands a program run directly (§22). Non-interactive `-l` reads the
# profile files and not the interactive ones: the environment without the prompt.
LOGIN_SHELL = os.environ.get("ORCHESTRATOR_LOGIN_SHELL") or os.environ.get("SHELL") or "/bin/zsh"
```

In `cmd_spawn`, replace `command = "/bin/sh " + script` with:

```python
    command = "%s -l %s" % (LOGIN_SHELL, script)
```

In the dry-run print block, after `print("anchor=%s" % …)` add:

```python
        print("program=%s -l <launch-file>" % LOGIN_SHELL)
```

- [ ] **Step 4: The two comments that named the old decision**

In `build_command`, replace the comment block that begins `# The ABSOLUTE path, resolved from the environment the orchestrator has.` and ends `# session dies with it, and the spawn fails as a tty that belongs to nothing.` with:

```python
    # The ABSOLUTE path, resolved from the environment the orchestrator has. The tab runs
    # the launch through a login shell now (§22), so a bare name would usually resolve —
    # but finding the program must not depend on the operator's dotfiles: a profile that
    # breaks PATH would kill the launch, and the session would die before its tty could be
    # read, which is how the first spawn under the bare default died.
```

In `write_launch_script`, replace the docstring's first line
`"""The launch goes to a FILE and the app is asked to run `/bin/sh <file>`.`
with
`"""The launch goes to a FILE and the app is asked to run `<login shell> -l <file>`.`
and leave the rest of the docstring as it is.

- [ ] **Step 5: Run the unit suite**

Run: `./tests/run-tests.sh 2>&1 | tail -1`
Expected: `178 passed, 0 failed`.

- [ ] **Step 6: The live proof**

In `tests/e2e.sh`, immediately after the line `check "the session is running on that tty" "0" "$?"`, insert:

```bash
# The agent inherits the operator's PATH: read from the process, never assumed. The first
# entry of a login shell's own PATH is the machine-neutral witness (the package manager's
# directory on this one); a session born of the app's bare default does not carry it.
pid=$(bash "$AGENT" verify --tty "$TTY" 2>/dev/null | grep -oE 'pid [0-9]+' | grep -oE '[0-9]+')
want=$("${SHELL:-/bin/zsh}" -l -c 'printf %s "$PATH"' 2>/dev/null | cut -d: -f1)
check "the session inherits a login shell's PATH" "1" \
  "$(ps -E -p "$pid" -o command= 2>/dev/null | tr ' ' '\n' | grep '^PATH=' | grep -c -- "$want")"
```

Do not run it. Report that it is written.

- [ ] **Step 7: Documentation**

In `skills/iterm-agents/SKILL.md`, add to the « Caveats (all observed) » list, after the entry that begins `**The tab is born in the anchor's window**`:

```markdown
- **The tab runs the launch through a login shell** (`ORCHESTRATOR_LOGIN_SHELL`, else `SHELL`, else `/bin/zsh`), so the agent inherits the operator's PATH, the package manager's binaries included. Before that, no spawned session could run `gh`: the app hands a program run directly a bare default PATH. The CLI is still named absolutely inside the launch, so a profile that breaks PATH cannot kill it.
```

In `README.md`, in the `iterm-agents` row, replace `The prompt goes to a file and the typed command stays short;` with `The prompt goes to a file and the typed command stays short; the tab runs the launch through the operator's login shell, so the agent inherits the full PATH;`.

- [ ] **Step 8: Bump the version and commit**

Set `0.19.0` in `.claude-plugin/plugin.json` and both fields of `.claude-plugin/marketplace.json`. Run `./tests/run-tests.sh 2>&1 | tail -1` → `178 passed, 0 failed`.

Two commits, in this order:

```bash
git add docs/design.md
git commit -m "docs(design): the tab runs its launch through a login shell" -m "No spawned session could open a pull request: the app hands a program run directly a bare default PATH, and every command the session runs inherits it. Section 22 says why the launch keeps naming the CLI absolutely while the session gets the operator's environment."

git add skills/iterm-agents/scripts/iterm_agent.py tests/run-tests.sh tests/e2e.sh skills/iterm-agents/SKILL.md README.md .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "feat(iterm-agents): run the launch through a login shell" -m "A session born of the app's bare default PATH cannot run the package manager's binaries, so no agent could open a pull request. The tab now runs the launch file through the operator's login shell and the session inherits their environment; the CLI stays named absolutely so a profile that breaks PATH cannot kill the launch."
```

- [ ] **Step 9: Open the draft PR**

Branch `login-shell-launch`, created from the head of `agent-chain`, base `agent-chain`, title `Run the launch through a login shell so the agent inherits the operator's PATH`. `Related PR:` section with the bare link of the 0.18.0 PR if it exists when you open yours; otherwise no section. Report to the orchestrator with the link, or with the compare link if the PR cannot be opened.
