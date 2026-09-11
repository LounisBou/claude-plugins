# Short Names, No Project Server Unless Asked, Rename On Declare Implementation Plan

> **For the orchestrator:** this plan is executed by implementer SESSIONS the orchestrator spawns (`orchestrator:iterm-agents`), one brief per task — never by subagents of the orchestrator's own session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one release, 0.26.0: every session name reads `Orch : <subject>` or `Agent : <subject>` with the subject at most twenty-five characters, a spawn loads no project server unless `--mcp` says so, and the rulebook tells a hand-launched orchestrator how it gets its name.

**Architecture:** `skills/iterm-agents/scripts/iterm_agent.py` (the shape, the derived name, the launch's server flags, `--mcp` on spawn and rotate), every document that spells a role (`skills/orchestrator/SKILL.md`, `skills/iterm-agents/SKILL.md`, `commands/succeed.md`, the five templates, `README.md` where it names one), `tests/e2e.sh` titles, the suite.

**Tech Stack:** Python 3 (standard library), bash 3.2.

**Spec:** `docs/design.md` section 42; sections 24, 38, 39 bind the readings.

## Global Constraints

Copied from `CLAUDE.md`; the task's requirements include them.

- **English only, everywhere.** **No vendor or product name in prose**; the runtime is "the host". Load-bearing identifiers exempt.
- **Commits**: Conventional Commits with a scope; no trailer, no attribution, no tool name, no session link. Subject in the imperative, body says why.
- **`CLAUDE.md` and `.claude/` are never committed.**
- **Before pushing**: `./tests/run-tests.sh` passes (315 on the base head `0c50934`); the brand grep returns only exempt occurrences; no accented character outside `docs/`.
- **Release** (spec §8): version in `plugin.json` and both fields of `marketplace.json`: `0.26.0`.
- **Every command runs synchronously**, in the tool call that waits for it; the suite is piped to `tail` in the same call. The first suite run in a fresh copy takes minutes.
- **The checkout you work in is already on the task's branch**: do not create another branch.
- **`tests/e2e.sh` is edited, never run**: the orchestrator runs the live round.

---

### Task 1: Short names, no project server unless asked, rename on declare (0.26.0)

**Files:**
- Modify: `skills/iterm-agents/scripts/iterm_agent.py` — `TITLE_SHAPE`, the refusal sentences, the derived-name guard, `build_command`, `cmd_spawn` (`--mcp`), `cmd_rotate` (forwards `--mcp`).
- Modify: `skills/iterm-agents/SKILL.md`, `commands/succeed.md`, `skills/orchestrator/SKILL.md`, `templates/agent-phase-brief.md`, `templates/agent-review-brief.md`, `templates/agent-comments-brief.md`, `templates/agent-rotation-brief.md`, `templates/orchestrator-succession-brief.md`, `README.md` — every spelling of the older roles.
- Modify: `tests/e2e.sh` — titles; `tests/run-tests.sh` — the checks below and every existing literal that spelled a role.
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — `0.26.0`.
- Already committed on this branch by the orchestrator: `docs/design.md` §42 and this plan.

**Interfaces (verbatim, the contract the checks read):**

- `TITLE_SHAPE = ^(Orch|Agent) : .{1,25}$`. Refusal, exit 1: `spawn: refused: a title reads "Orch : <subject>" or "Agent : <subject>", the subject at most 25 characters, got '<title>' (pass --title-free for a tab named otherwise)`.
- Derived successor name: held to `TITLE_SHAPE`; `DERIVED_NAME_MAX` and its sentence are removed. Refusal: `spawn: refused: the caller's session name '<the first 40 characters>' does not read "Orch : <subject>"; pass --title "Orch : <subject>"`.
- The `Orchestrator :` prefix test of §39 (an orchestrator's title on a plain anchor) reads `Orch :`.
- Launch without `--mcp`: `--strict-mcp-config` present, no `--settings` with `enableAllProjectMcpServers`. With `--mcp`: the settings `{"enableAllProjectMcpServers":true}` present, no `--strict-mcp-config`. `rotate` forwards `--mcp` (it is not in its refused list). Dry run prints `mcp=yes|no`.
- Roles in every document: `Orch : <subject>` where `Orchestrator : <feature>` stood, `Agent : <subject>` where `Implementer : <phase>` or `Reviewer : <round>` stood; the sentence that lists the roles says the subject is at most 25 characters. The rulebook's Overview (or its first section) carries the literal `/rename "Orch : <subject>"` in a sentence that says the host gives the model no rename and the operator types it once, or relaunches with `--name`.
- `tests/e2e.sh` titles: `Agent : e2e probe`, `Agent : e2e self`, `Agent : e2e chain 1`, `Agent : e2e chain 2`, `Agent : e2e ghost`, `Agent : e2e 2`, `Agent : e2e rotated`; the successor case unchanged (no title).

- [ ] **Step 1: The failing checks** — shape: `Agent : x` and `Orch : x` accepted and named; `Implementer : x` refused with the shape in the sentence; a subject of 25 characters accepted, of 26 refused; the derived name from a table naming the caller `Orch : f` launches under `--name 'Orch : f'` and `--remote-control 'Orch : f'`, from `Orchestrator : f` refused with the new sentence; `Orch : x --right-of self` refused; the launch without `--mcp` carries `--strict-mcp-config` and no enabling setting, with `--mcp` the reverse; `rotate --mcp` yields `mcp=yes`; one literal guard per document for the roles (`Orch : <subject>` and `Agent : <subject>` present, `Orchestrator : <feature>` / `Implementer : <phase>` / `Reviewer : <round>` absent, outside `docs/`); the rename literal in the rulebook. Every existing check that spelled a role (`--title "Implementer : <phase>"`, `Implementer : x`, `Probe : …`, `Orchestrator : heir`, the derived-name checks, the 100-character check) moves to the new spelling, never deleted — a check retired with the length guard is replaced by the shape check on the derived name.
- [ ] **Step 2: Run, watch them fail, report** the count and the first failing value.
- [ ] **Step 3: The code**, in the module's style. Then the documents, then `tests/e2e.sh`.
- [ ] **Step 4: Mutations on the committed tree**: the shape widened to anything → the shape checks fall; the derived-name shape check dropped → the `Orchestrator : f` check falls; `--strict-mcp-config` dropped from the default launch → its check falls.
- [ ] **Step 5: The gate**, then `0.26.0`, then the suite again.
- [ ] **Step 6: Commits** — `feat(iterm-agents): short names, and no project server unless asked`; `docs(orchestrator): spell the short roles everywhere and name a hand-launched orchestrator`; `chore(release): 0.26.0`.
