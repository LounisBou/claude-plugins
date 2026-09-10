# Session Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A spawned session carries the spawn's `--title` as its host-level name (`--name`), so agents and orchestrators are told apart by a name that says their role and phase.

**Architecture:** `build_command` appends `--name <title>` to the CLI arguments. The dry run already prints the launch text, so the suite reads the argument there. The rulebook's spawn line and the iterm-agents skill say what a title is for. No other change.

**Tech Stack:** Python 3, bash 3.2 for the suite.

**Spec:** `docs/design.md`, section 24 — « A session is named at launch ». Sections 8 and 14 bind it.

## Global Constraints

Copied from `CLAUDE.md`; every task's requirements include them.

- **English only, everywhere.** **No vendor or product name in prose**; the runtime is "the host". Load-bearing identifiers exempt.
- **Commits**: Conventional Commits; no trailer, no attribution, no tool name, no session link.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (180 on the base head; this plan adds 2); the brand grep returns only exempt occurrences; no accented character outside `docs/`.
- **Release** (spec §8): version in `plugin.json` and both fields of `marketplace.json`: `0.21.0`.
- Never run anything against the live app. Dry runs only.

---

### Task 1: The title becomes the session's name (0.21.0)

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` — `build_command` (the `cli` list, after the `--settings` argument).
- Modify: `tests/run-tests.sh` — two checks after « the launch text itself is unchanged by the shell »; the guard « the rulebook spawns beside the orchestrator » re-pinned on the new launch line.
- Modify: `skills/iterm-agents/SKILL.md` — the « Dynamic titles override manual ones » caveat and the quick-reference `spawn` line; `skills/orchestrator/SKILL.md` — the launch line in « The agents' lifecycle is yours » step 1.
- Modify: `commands/succeed.md` — the successor's spawn title.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.21.0`.
- Commit (already in the worktree, written by the orchestrator): `docs/design.md` section 24, and this plan file.

**Interfaces:**
- Consumes: `build_command(dir_, title, model, mode, prompt_file)`, existing.
- Produces: the launch text contains `--name <shell-quoted title>` immediately after the `--settings` argument and before the prompt.

- [ ] **Step 1: Write the failing checks**

In `tests/run-tests.sh`, immediately after the check « the launch text itself is unchanged by the shell », insert:

```bash
# The title is the session's NAME, not a tab label the shell overwrites: two sessions in one
# checkout otherwise share the host's stem and differ by a reference nobody reads at a
# glance (observed: an implementer listed under its orchestrator's own name). Non-ASCII
# bytes travel like the prompt does — quoted by the shell's own rules.
check "the launch names the session after its title" "1" "$(printf '%s' "$cmd" | grep -c -- "--name 'B-1 — é'")"
check "no title: the session is still named" "1" "$(ORCHESTRATOR_DRY_RUN=1 ORCHESTRATOR_STATE_DIR="$ISTATE" bash "$AGENT" spawn --dir "$WORK" 2>&1 | sed -n 's/^launch=//p' | grep -c -- '--name agent')"
```

Note: `$cmd` at that point is the launch text of the section's first dry run, whose title is `B-1 — é`.

- [ ] **Step 2: Run them to verify they fail**

Run: `./tests/run-tests.sh 2>&1 | grep -E 'names the session|still named|passed'`
Expected: both FAIL; `180 passed, 2 failed`.

- [ ] **Step 3: The argument**

In `build_command`, replace

```python
    cli += ["--permission-mode", shq(mode), "--settings", shq(settings)]
```

with

```python
    # The title is the session's name: the host shows it in its prompt, its resume picker
    # and the terminal title, and applies a variant when a live session already holds it.
    # Without it two sessions in one checkout share the host's stem and differ only by a
    # reference (§24).
    cli += ["--permission-mode", shq(mode), "--settings", shq(settings), "--name", shq(title)]
```

- [ ] **Step 4: Run the suite**

Run: `./tests/run-tests.sh 2>&1 | tail -1`
Expected: `182 passed, 0 failed`.

- [ ] **Step 5: Documentation**

In `skills/iterm-agents/SKILL.md`, replace the caveat that begins `- **Dynamic titles override manual ones**` with:

```markdown
- **The title is the session's name.** `--title` is passed to the host as the session's name (shown in its prompt, its resume picker, the terminal title, and applied with a variant when a live session already holds it), so name it the operator's way — `Orchestrator : <feature>` for an orchestrator or its successor, `Implementer : <phase>`, `Reviewer : <round>` — never the bare default. The tab title still reflects the session's current task for `--expect-title`: read it from `list` seconds before closing.
```

In the quick reference, change `--title <t>` on the `spawn` line to `--title "<Role> : <what>"`.

In `skills/orchestrator/SKILL.md`, in « The agents' lifecycle is yours » step 1, insert after `--right-of self` in the launch line: `--title "Implementer : <phase>"` (so the line reads `… --dir <the checkout the wave writes in> --right-of self --title "Implementer : <phase>" --prompt "…"`), and append to that step's last sentence: `The title is the session's name and the tab's, in the operator's format: \`Implementer : <phase>\` for an implementer, \`Reviewer : <round>\` for a review session, \`Orchestrator : <feature>\` for a successor — never the bare default.`

- [ ] **Step 6: Version and commits**

Set `0.21.0` in `.claude-plugin/plugin.json` and both fields of `.claude-plugin/marketplace.json`. Re-run the suite → `182 passed, 0 failed`.

```bash
git add docs/design.md docs/superpowers/plans/2026-09-10-session-name.md
git commit -m "docs(design): a session is named at launch" -m "An implementer came up in the listing under its orchestrator's own name, differing by a reference nobody reads at a glance. Section 24 makes the spawn title the session's name and says what a title is for."

git add skills/iterm-agents/scripts/iterm_agent.py tests/run-tests.sh skills/iterm-agents/SKILL.md skills/orchestrator/SKILL.md .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "feat(iterm-agents): pass the spawn title as the session name" -m "Two sessions in one checkout share the host's name stem and differ only by a reference. The title now goes to the host as the session's name, so a listing says the role and the phase; the rulebook names them that way."
```

- [ ] **Step 7: Open the draft PR**

Branch `session-name`, created with `git switch -c session-name origin/operator-decides --no-track`, base `operator-decides`, title `Pass the spawn title as the session's name`. Report to the orchestrator with the link or the compare link.
