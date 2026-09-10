# Operator Decides Implementation Plan

> **For the orchestrator:** this plan is executed by implementer SESSIONS the orchestrator spawns (`orchestrator:iterm-agents`), one brief per task — never by subagents of the orchestrator's own session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The rulebook states, in one section the suite reads, that a command the orchestrator could run is the orchestrator's to run, and that a session's own limit is repaired by a successor rather than delegated to the operator.

**Architecture:** One new section in `skills/orchestrator/SKILL.md`, placed after « The agents' lifecycle is yours » and before « Context rotation »; three rows added to its « Rationalizations » table; two red flags; two guards in `tests/run-tests.sh` reading that the section and its sentence exist; design §23 committed; version `0.20.0`. No code changes.

**Tech Stack:** Markdown, bash 3.2 for the suite.

**Spec:** `docs/design.md`, section 23 — « The operator decides; the orchestrator runs ».

## Global Constraints

Copied from `CLAUDE.md`; every task's requirements include them.

- **English only, everywhere.** **No vendor or product name in prose**; the runtime is "the host". Load-bearing identifiers exempt (`~/.claude/`, `.claude-plugin/`, `CLAUDE_*` variables, `claude-orchestrator`, `ListAgents`, `SendMessage`).
- **Commits**: Conventional Commits; no trailer, no attribution, no tool name, no session link. Subject imperative, body says why.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (178 on the base head; this plan adds 2); the brand grep returns only exempt occurrences; no accented character outside `docs/` — the section quotes the operator in English, not in French.
- **Release** (spec §8): version in `plugin.json` and both fields of `marketplace.json`: `0.20.0`.
- Never run anything against the live app. No e2e.

---

### Task 1: The rulebook section, its guards, the release (0.20.0)

**Files:**
- Modify: `skills/orchestrator/SKILL.md` — new `## The operator decides; the orchestrator runs` section inserted immediately before `## Context rotation`; three rows appended to the `## Rationalizations` table; two bullets appended to `## Red flags: STOP`.
- Modify: `tests/run-tests.sh` — two checks appended right after `check "the rulebook spawns beside the orchestrator" …`.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.20.0`.
- Commit (already in the worktree, written by the orchestrator): `docs/design.md` section 23.

**Interfaces:**
- Consumes: nothing.
- Produces: the heading text `## The operator decides; the orchestrator runs` and the sentence `A command the orchestrator could run is the orchestrator's to run.` — both read verbatim by the suite.

- [ ] **Step 1: Write the failing guards**

In `tests/run-tests.sh`, immediately after the line
`check "the rulebook spawns beside the orchestrator" "1" "$(grep -c -- '--right-of self --prompt' "$ROOT/skills/orchestrator/SKILL.md")"`
insert:

```bash
# The operator's ruling after an afternoon of pasted command lines: everything the
# orchestrator asks him to run, it can run itself; he decides, nothing else. Pinned so the
# rule cannot drift back into « hand the operator the exact line ».
check "the rulebook keeps running to the orchestrator" "1" "$(grep -c '^## The operator decides; the orchestrator runs' "$ROOT/skills/orchestrator/SKILL.md")"
check "a runnable command is the orchestrator's" "1" "$(grep -c "A command the orchestrator could run is the orchestrator's to run" "$ROOT/skills/orchestrator/SKILL.md")"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `./tests/run-tests.sh 2>&1 | grep -E "orchestrator's|running to the orchestrator|passed"`
Expected: both FAIL (0 where 1 is expected); `178 passed, 2 failed`.

- [ ] **Step 3: The section**

Insert into `skills/orchestrator/SKILL.md`, immediately before the line `## Context rotation`, the full text of the section given in the design's companion file — the orchestrator supplies it verbatim in the brief (§3 Deliverables). It begins `## The operator decides; the orchestrator runs` and ends with its three-row table. Leave one blank line before and after.

- [ ] **Step 4: The table rows and the red flags**

Append to the `## Rationalizations` table, as its last three rows:

```markdown
| "The operator can run it in two seconds" | The operator can decide in two seconds. Running is yours; spawn what your session lacks. |
| "My session has no PATH for it, so it is his" | A session limit is repaired by a successor with the right environment, not delegated upward. |
| "I will hand him the exact line to be safe" | A line he did not write is one he cannot check. Run it, read the result, report the reading. |
```

Append to `## Red flags: STOP`, as its last two bullets:

```markdown
- A command line handed to the operator to paste; a report whose next step is « you run … »; a session limit reported as the operator's chore instead of repaired by a successor.
- A configuration request sent to the operator with no measurement behind it, or sent to him at all when a session owns that configuration.
```

- [ ] **Step 5: Run the suite**

Run: `./tests/run-tests.sh 2>&1 | tail -1`
Expected: `180 passed, 0 failed`.

- [ ] **Step 6: Version and commits**

Set `0.20.0` in `.claude-plugin/plugin.json` and both fields of `.claude-plugin/marketplace.json`. Re-run the suite → `180 passed, 0 failed`.

```bash
git add docs/design.md
git commit -m "docs(design): the operator decides, the orchestrator runs" -m "Three command lines were handed to the operator in one afternoon, each for a limit of the orchestrator's session rather than of its role. Section 23 says why a session limit is repaired by a successor and never delegated upward."

git add skills/orchestrator/SKILL.md tests/run-tests.sh .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "feat(orchestrator): a command the orchestrator could run is its to run" -m "The operator decides and nothing else: opening, merging and tagging pull requests, the live round, plugin updates and session restarts are the orchestrator's, and a session that lacks what the role needs is replaced by a successor with it. Two guards read that the section exists."
```

- [ ] **Step 7: Open the draft PR**

Branch `operator-decides`, created with `git switch -c operator-decides <head of login-shell-launch>` (no tracking; `git push -u` sets it), base `login-shell-launch`, title `The operator decides; the orchestrator runs`. `Related PR:` with the 0.19.0 PR's bare link if it exists. Report to the orchestrator.
