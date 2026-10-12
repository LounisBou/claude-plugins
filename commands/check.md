---
description: "Analyze code against established project patterns and conventions using parallel agents"
argument-hint: "[agents-to-run] [base=<branch>] [use also <path> as pattern reference]"
allowed-tools: ["Bash", "Glob", "Grep", "Read", "Task", "Edit", "Write", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "AskUserQuestion"]
---

# Norms Check — Parallel Agent Orchestrator

Run a comprehensive code norms check using multiple specialized agents, each focusing on a different aspect of code quality.

**Requested agents (optional):** "$ARGUMENTS"

## Iron Rules

| Rule | Meaning |
|------|---------|
| **No code changes without approval** | Propose fixes, wait for user to say "fix". Never edit code proactively. |
| **No auto-commit** | Only commit after user explicitly approves a fix. |
| **One commit per fix** | Each "fix" gets its own commit. Never batch multiple fixes. |
| **Clean commit messages** | Describe the code change only. No mention of: norms check, TODO list, Claude, agent name. |
| **Every finding addressed** | No finding may be left without an explicit "fix", "pass", or "discuss→fix/pass" from the user. |
| **Never push commits** | NEVER run `git push`. User pushes themselves. |
| **Run tests after each fix** | Run project test suite after applying a fix. Never commit broken code. |

### Red Flags — STOP If You Think This

| Thought | Reality |
|---------|---------|
| "This fix is trivial, I'll just do it" | Propose it. Wait for "fix". |
| "I'll batch these two related fixes" | One commit per fix. Always. |
| "Tests are probably fine" | Run them. Verify. Every time. |
| "This INFO is not important, skip it" | Show it. User decides fix or pass. |
| "I should push these commits" | NEVER push. Remind user to do it. |

## Workflow

### Step 1: Detect Project Type

Check for project type indicators:

| Indicator File | Project Type |
|----------------|--------------|
| `package.json` | JavaScript/TypeScript |
| `composer.json` | PHP |
| `requirements.txt` / `pyproject.toml` | Python |
| `Cargo.toml` | Rust |
| `go.mod` | Go |
| `Gemfile` | Ruby |
| `pom.xml` / `build.gradle` | Java/Kotlin |
| `*.csproj` / `*.sln` | C#/.NET |

### Step 1.5: Detect Project Norms

Check if `CONTRIBUTING.md` exists at the project root:

```bash
ls CONTRIBUTING.md 2>/dev/null
```

- If found: note "Project norms: CONTRIBUTING.md found (agents will apply project-specific rules)"
- If not found: note "Project norms: no CONTRIBUTING.md (agents will discover conventions from codebase)"

Include this status in the summary report.

### Step 2: Get Changed Files

```bash
BASE=$("${CLAUDE_PLUGIN_ROOT}/scripts/resolve_base.sh" [<base>]) || exit 1
git diff --name-only "$BASE"...HEAD
```

`<base>` is the optional `base=<branch>` token of the arguments (for example `/norms:check base=develop`). Without it the script uses the base of the open pull request, then the remote default branch, then `main`. Pass `$BASE` to every agent that needs the diff.

Classify each file into categories:
- **source**: Application code files
- **test**: Test files (`*.test.*`, `*.spec.*`, `*_test.*`, `*/tests/*`, `*/test/*`)
- **config**: Configuration files (`*.json`, `*.yml`, `*.yaml`, `*.toml`, `*.xml`, `*.env*`)

### Step 3: Determine Applicable Agents

| Agent | Condition | Skip reason |
|-------|-----------|-------------|
| `norms-pattern-conformity` | Any source file changed | No source files |
| `norms-variable-naming` | Any source file changed | No source files |
| `norms-test-structure` | Any test file changed | No test files |
| `norms-diff-scope` | Always | Never skipped |
| `norms-import-organization` | Source files changed (not config-only) | Config-only changes |
| `norms-magic-values` | Source files changed (not config-only) | Config-only changes |
| `norms-documentation` | Source files changed (not test-only or config-only) | Test-only or config-only |
| `norms-test-coverage` | Tests directory exists in project | No test infrastructure |

If user specified agents via arguments, only run those (e.g., `/norms:check naming tests`).

Available agent shortcuts:
- `pattern` or `conformity` → norms-pattern-conformity
- `naming` or `variables` → norms-variable-naming
- `tests` or `test-structure` → norms-test-structure
- `scope` or `diff` → norms-diff-scope
- `imports` → norms-import-organization
- `magic` → norms-magic-values
- `docs` or `documentation` → norms-documentation
- `coverage` → norms-test-coverage
- `all` → run all applicable (default)

### External Reference Paths

The user can specify external codebases as pattern references in natural language. Parse `$ARGUMENTS` for path references.

**Examples:**
- `/norms:check use also ../project1/src as pattern reference`
- `/norms:check check patterns against ~/dev/api-gateway/src`
- `/norms:check pattern ref ../project1/src ../project2/src`
- `/norms:check use ../backend and ../shared-lib as references`

**How to parse:**
1. Look for filesystem paths in the arguments (anything starting with `/`, `../`, `./`, `~/`, or looking like a relative path)
2. Verify each path exists using `ls`
3. If paths are found, pass them to the `norms-pattern-conformity` agent as `external_references`
4. External references are **additional** — the agent still searches the current project first, then also looks in external paths for reference files of the same type

### Step 4: Launch Agents in Parallel

**CRITICAL: You MUST launch ALL applicable agents in a SINGLE message by making multiple Task tool calls at once.** Do NOT launch one agent, wait for it, then launch the next. Put all Task tool calls in ONE response so they execute simultaneously. They will run concurrently and return results directly.

**Do NOT use `run_in_background: true`.** Just make multiple Task calls in one message — Claude Code runs them in parallel automatically.

**Example of CORRECT parallel dispatch (one message, multiple tool calls):**
```
[Task call 1: norms-pattern-conformity agent]
[Task call 2: norms-variable-naming agent]
[Task call 3: norms-diff-scope agent]
[Task call 4: norms-import-organization agent]
...all in the SAME message, no run_in_background flag
```

**WRONG (sequential — do NOT do this):**
```
Message 1: [Task call: norms-pattern-conformity agent]
...wait for result...
Message 2: [Task call: norms-variable-naming agent]
...wait for result...
```

Each agent prompt MUST include:
1. Project type and framework
2. List of changed files relevant to that agent
3. The full diff for those files (from `git diff "$BASE"...HEAD -- <files>`)
4. Branch name and the base commit `$BASE` (for diff-scope agent)
5. **External reference paths** (for pattern-conformity agent only): If the user specified external codebases, include the validated paths so the agent can search them for reference files

### Step 5: Present Summary Report

All agent results are returned directly from the Task calls. Aggregate all findings and present a read-only summary:

```markdown
# Norms Check Report

## Summary
- **Branch**: <branch-name>
- **Project**: <type> (<framework>)
- **Files analyzed**: <count>
- **Project norms**: CONTRIBUTING.md found / not found
- **Agents run**: X/8 (skipped by file type: <agent>: <reason>, ...)
- **Agents with no convention detected**: <list of agents that returned SKIPPED and what they searched>

| Severity | Count |
|----------|-------|
| ERROR    | X     |
| WARNING  | X     |
| INFO     | X     |

## Findings Preview

| # | Agent | Severity | File | Issue |
|---|-------|----------|------|-------|
| 1 | variable-naming | ERROR | `auth.ts:47` | `usr` should be `user` |
| 2 | diff-scope | WARNING | `utils.ts:12` | Unrelated formatting change |
| ... | ... | ... | ... | ... |
```

**If zero findings:** Display "No issues found. All norms checks passed." and stop.

### Step 6: Create TODO List

Create one `TaskCreate` entry per finding, ordered by severity (ERRORs first, then WARNINGs, then INFOs).

Each task should include:
- **subject**: `[SEVERITY] [agent-name] Issue title`
- **description**: Full details — file path, line, rule, what was found, what's expected, reference file if applicable
- **activeForm**: `Processing [agent-name] finding`

Announce: "I'll now walk through each finding one by one. For each, I'll explain the issue, show the code, and propose a fix. You'll choose: **1. Fix** · **2. Pass** · **3. Discuss**"

### Step 7: Process Each Finding

For **each** finding in the TODO list, follow this exact sequence:

#### 7.1 Show the Finding

Mark the task as `in_progress` with `TaskUpdate`, then display:

```markdown
## Finding N/total — [agent-name] SEVERITY

**File:** `path/to/file.ext:line`
**Rule:** <rule description>

### What was found
<Show the actual code snippet (3-5 lines of context around the issue). Use a fenced code block with syntax highlighting.>

### Why this is a problem
<2-3 sentences explaining WHY this violates the norm, what concrete negative effect it has (readability, maintainability, bug risk, inconsistency with codebase), and what principle it breaks. Be specific — don't just restate the rule.>

### What's expected
<Describe the expected pattern, ideally with a reference to an existing file in the project that does it correctly.>
**Reference:** <reference file path, if applicable>
```

#### 7.2 Propose a Concrete Fix

Read the file, understand the context, and propose a specific code change:

```markdown
### Proposed Fix

**File:** `path/to/file.ext:line`

**Before:**
\`\`\`<lang>
<current code with enough context — typically 3-7 lines>
\`\`\`

**After:**
\`\`\`<lang>
<proposed code with the same context lines>
\`\`\`

**What this fix does:** <1-2 sentences explaining the change and why this specific approach was chosen over alternatives. If there's a tradeoff, mention it.>

---
> **1. Fix** — Apply this change, run tests, and commit
> **2. Pass** — Skip this finding, no changes made
> **3. Discuss** — Ask questions or suggest a different approach
>
> Reply with **1**, **2**, or **3** (or **fix**, **pass**, **discuss**)
```

Wait for user response. Do NOT proceed without explicit user input.

#### 7.3 User Decides

Accepted inputs (case-insensitive):

| Input | Aliases | Action |
|-------|---------|--------|
| **1** or **fix** | "f", "yes", "apply", "do it" | → Go to 7.4 (apply fix) |
| **2** or **pass** | "p", "skip", "no", "next" | → Go to 7.5 (skip finding) |
| **3** or **discuss** | "d", "why", "explain", "?" | → Go to 7.6 (open discussion) |

Any other input → Treat as discussion (7.6).

#### 7.6 On "discuss"

1. Answer the user's question or concern thoroughly
2. If they suggest an alternative approach, evaluate it:
   - If valid: adopt THEIR version as the new proposed fix
   - If problematic: explain why and suggest a compromise
3. After the discussion, **always re-present the updated fix proposal** with the same selector format:

```markdown
### Updated Fix Proposal

**File:** `path/to/file.ext:line`

**Before:**
\`\`\`<lang>
<current code>
\`\`\`

**After:**
\`\`\`<lang>
<revised proposed code incorporating discussion feedback>
\`\`\`

**What changed from original proposal:** <1 sentence explaining what was adjusted based on discussion>

---
> **1. Fix** — Apply this change, run tests, and commit
> **2. Pass** — Skip this finding, no changes made
> **3. Discuss** — Continue the discussion
>
> Reply with **1**, **2**, or **3** (or **fix**, **pass**, **discuss**)
```

Wait for user response again. This loop continues until the user picks Fix or Pass.

#### 7.4 On "fix"

1. **Apply the code edit** using the Edit tool
2. **Run the project test suite:**
   - Detect test runner from project type (npm test, pytest, phpunit, cargo test, go test, etc.)
   - Run tests
   - If tests fail: fix the regression, re-run tests. Do NOT commit until tests pass.
   - If no test suite exists: inform the user and ask whether to proceed with the commit.
3. **Commit** with a clean, short message:
   ```bash
   git add <specific-files>
   git commit -m "$(cat <<'EOF'
   <type>(<scope>): <short description of the code change>
   EOF
   )"
   ```
   Commit message rules:
   - Conventional Commits: `<type>[(<scope>)]: <description>`, type one of `feat|fix|chore|refactor|style|docs|test|perf|build|ci`
   - Describe the code change only (e.g., "refactor(auth): rename usr variable to user")
   - NEVER mention: norms check, TODO list, Claude, agent name, review
   - Keep under 72 characters
4. **Record the commit hash** for the completion summary
5. **Mark task as `completed`** with `TaskUpdate`, move to next finding

#### 7.5 On "pass"

Mark task as `completed` with `TaskUpdate`. Move to next finding. No edit, no commit.

### Step 8: Completion Summary

After all findings are processed, present the final summary:

```markdown
# Norms Check — Complete

## Results Overview

| Metric | Count |
|--------|-------|
| Fixed | X |
| Passed | Y |
| Total findings | N |
| Of which discussed before decision | D |

## Detailed Results

### Fixed

| # | File | What was changed | Why | Commit |
|---|------|------------------|-----|--------|
| 1 | `auth.ts:47` | Renamed `usr` → `user` | Variable name was abbreviated, violating naming convention. Full names improve readability and grep-ability. | `a1b2c3d` |
| 3 | `api.ts:12` | Extracted timeout `5000` → `API_TIMEOUT_MS` | Magic number obscured intent. Named constant documents the value's purpose. | `e4f5g6h` |

### Passed (no changes)

| # | File | Finding | Reason for passing |
|---|------|---------|--------------------|
| 2 | `utils.ts:12` | Unrelated formatting change | User confirmed this was intentional cleanup |

<If any findings were discussed before fix/pass, include a "Discussion Notes" subsection>

### Discussion Notes

| # | File | Original proposal | User feedback | Final outcome |
|---|------|-------------------|---------------|---------------|
| 3 | `api.ts:12` | Extract to `TIMEOUT_MS` | User preferred `API_TIMEOUT_MS` for clarity | Fixed with user's naming |
```

If any fixes were committed, remind: "Remember to push your commits when ready."

## Agent Reference

| Agent | Focus | Model |
|-------|-------|-------|
| norms-pattern-conformity | Match existing codebase patterns | sonnet |
| norms-variable-naming | Naming rules enforcement | haiku |
| norms-test-structure | Given/When/Then enforcement | haiku |
| norms-diff-scope | Minimal diff + scope | sonnet |
| norms-import-organization | Import ordering/grouping | haiku |
| norms-magic-values | Hardcoded values detection | haiku |
| norms-documentation | Comments for complex code | sonnet |
| norms-test-coverage | Coverage + missing tests | sonnet |
