# Agent Under Review And Reader's Copy Implementation Plan

> **For the orchestrator:** this plan is executed by implementer SESSIONS the orchestrator spawns (`orchestrator:iterm-agents`), one brief per task — never by subagents of the orchestrator's own session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One release, 0.23.6, text only: the rulebook says that an implementer stays through the review round of its own delivery and its N-bis and is stood down at the verdict, that « reuse » means an agent with a next phase to start now, and that a reader's pinned copy is a detached worktree while a clone is for a writer; the tab skill and the review brief template say the same.

**Architecture:** six sentence-level edits in three files, four guards in the suite. No code.

**Tech Stack:** Markdown, bash 3.2 (the suite).

**Spec:** `docs/design.md`, section 36. Section 30 (the clone per phase) binds the second reading.

## Global Constraints

Copied from `CLAUDE.md`; the task's requirements include them.

- **English only, everywhere.** **No vendor or product name in prose**; the runtime is "the host". Load-bearing identifiers exempt.
- **Commits**: Conventional Commits; no trailer, no attribution, no tool name, no session link.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (247 on the base head; this task adds 4, expected `251 passed, 0 failed`); the brand grep returns only exempt occurrences; no accented character outside `docs/`.
- **Release** (spec §8): version in `plugin.json` and both fields of `marketplace.json`: `0.23.6`.
- **Every command runs synchronously**, in the tool call that waits for it; the suite is piped to `tail` in the same call.
- **The checkout you work in is already on the phase branch** (the orchestrator committed this plan and the spec on it): do not create another branch.

---

### Task 1: The two sentences (0.23.6)

**Files:**
- Modify: `skills/orchestrator/SKILL.md` — four sentence-level edits (lifecycle step 4, the rotation paragraph, the review paragraph, the housekeeping boundary).
- Modify: `skills/iterm-agents/SKILL.md` — the tab-hygiene paragraph.
- Modify: `templates/agent-review-brief.md` — the working-directory line.
- Modify: `tests/run-tests.sh` — four guards, inserted immediately after the check `a runnable command is the orchestrator's`.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.23.6`.
- Already committed on this branch by the orchestrator: `docs/design.md` §36 and this plan.

**Interfaces:** none — text. The guards read the literals below; the literals are the contract.

- [ ] **Step 1: Write the failing guards**

In `tests/run-tests.sh`, immediately after the check `a runnable command is the orchestrator's` (one line), insert:

```bash
# Two readings the rulebook left open (§36): an implementer stays through the review round
# of ITS delivery and is stood down at the verdict; a reader's pinned copy is a worktree.
check "the rulebook keeps the implementer through its own review round" "1|1" \
  "$(grep -c 'stays through the review round of ITS delivery' "$ROOT/skills/orchestrator/SKILL.md")|$(grep -c 'a tab kept in case is not reuse' "$ROOT/skills/orchestrator/SKILL.md")"
check "the tab skill says the same" "1" "$(grep -c 'stood down at the verdict' "$ROOT/skills/iterm-agents/SKILL.md")"
check "the rulebook pins a reader's copy as a worktree" "1|1" \
  "$(grep -c 'never a clone: a clone is for a WRITER' "$ROOT/skills/orchestrator/SKILL.md")|$(grep -c "a reader's pinned copy is a detached worktree" "$ROOT/skills/orchestrator/SKILL.md")"
check "the review brief template pins a worktree" "1" "$(grep -c 'a detached worktree pinned at the head under review' "$ROOT/templates/agent-review-brief.md")"
```

- [ ] **Step 2: Run the suite and watch the guards fail for the right reason**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `247 passed, 4 failed` — each guard reads `0` where it expects `1`. Report the count and the first failing check's actual value verbatim before editing the texts.

- [ ] **Step 3: The rulebook**

In `skills/orchestrator/SKILL.md`:

(a) In the lifecycle's step 4 (the line beginning `4. **Terminate — in the same move as the approval.**`), replace the two sentences

```
There is no « standing by for merge-time fixups » tab (observed: an approved agent left open a whole day, then a second agent spawned beside it — the owner's ruling is that no finished tab is ever left around). A later fixup goes to a fresh session with a resume brief.
```

with

```
An implementer stays through the review round of ITS delivery and the N-bis that round produces — a one-line fix is minutes for the session that wrote the code and a cold start for any other — and is stood down at the verdict, approved or shelved. There is no « standing by for merge-time fixups » tab (observed: an approved agent left open a whole day, then a second agent spawned beside it — the owner's ruling is that no finished tab is ever left around; and an agent kept « for a possible N-bis » through a merge nobody had scheduled, idle under memory pressure until the operator asked why). A fixup after the verdict goes to a fresh session with a resume brief.
```

(b) In the rotation paragraph, replace the sentence

```
Below the threshold, prefer REUSING the same agent session across phases, because it keeps the interfaces it built in mind and a continuation prompt costs a fraction of a cold start.
```

with

```
Below the threshold, prefer REUSING the same agent session across phases, because it keeps the interfaces it built in mind and a continuation prompt costs a fraction of a cold start — « reuse » names an agent with a NEXT phase to start now; a tab kept in case is not reuse, it is the standing-by tab the lifecycle forbids.
```

(c) In the review paragraph, replace

```
Independent readers (read-only reviewer sessions the ORCHESTRATOR dispatches — never the implementer), one lens each, on a copy pinned at the head under review;
```

with

```
Independent readers (read-only reviewer sessions the ORCHESTRATOR dispatches — never the implementer), one lens each, on a copy pinned at the head under review — a detached worktree of your own checkout (`git worktree add --detach <path> <head>`), never a clone: a clone is for a WRITER (sandbox containment, one writer per checkout, §30 of the design); a reader's copy writes nothing, is confined to no root, needs none of the project's local material, and `git worktree remove` takes it when the round is judged;
```

(d) In the boundaries, replace

```
the paths its manifest names), granting test databases. Do these yourself rather than blocking an agent.
```

with

```
the paths its manifest names), granting test databases; a reader's pinned copy is a detached worktree of your own checkout, not a clone. Do these yourself rather than blocking an agent.
```

- [ ] **Step 4: The tab skill and the template**

In `skills/iterm-agents/SKILL.md`, in the paragraph beginning `**A finished agent's tab is closed, not left open.**`, replace

```
There is no « standing by » tab: a later fixup goes to a fresh session with a resume brief, which costs one cold start and keeps the window readable.
```

with

```
An implementer stays through the review round of its own delivery and the N-bis that round produces, and is stood down at the verdict; there is no « standing by » tab after it: a later fixup goes to a fresh session with a resume brief, which costs one cold start and keeps the window readable.
```

In `templates/agent-review-brief.md`, replace

```
- Working directory: `{{WORKTREE}}` — a copy pinned at the head under review; never leave it, never switch its branch.
```

with

```
- Working directory: `{{WORKTREE}}` — a detached worktree pinned at the head under review; never leave it, never check anything out in it.
```

Before each edit, `grep -n` the literal you replace in `tests/run-tests.sh` and `skills/orchestrator/scripts/brief-lint.sh` and re-pin any guard that pinned it; say in your report what you found (the orchestrator read none).

- [ ] **Step 5: Run the suite**

```bash
./tests/run-tests.sh 2>&1 | tail -3
```

Expected: `251 passed, 0 failed`. Do not weaken a guard to pass; report the actual value and stop if a text and a guard disagree.

- [ ] **Step 6: Version**

`.claude-plugin/plugin.json` `version` and both `version` fields of `.claude-plugin/marketplace.json`: `0.23.6`. Then `./tests/run-tests.sh 2>&1 | tail -1`: `251 passed, 0 failed`.

- [ ] **Step 7: Commit and deliver**

One commit, with this exact subject: `docs(orchestrator): keep the implementer through its review round, pin a reader's copy as a worktree` — the two skills, the template, the suite, the two version files. Body: why (the rulebook read two ways on both points, both observed; the operator's rulings). It stacks on the orchestrator's docs commit already on this branch. Push with `git push -u origin agent-under-review`, open the draft PR as the brief says.
