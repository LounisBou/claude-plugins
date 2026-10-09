---
description: "Use after a PR is merged or reviewed to capture reviewer feedback as reusable project code norms in CONTRIBUTING.md"
argument-hint: "<PR-number> [PR-number...]"
allowed-tools: ["Bash", "Glob", "Grep", "Read", "Edit", "Write", "AskUserQuestion", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]
---

# Norms Learn — Extract Rules from PR Reviews

Learn project-specific code norms from resolved PR review threads and add them to `CONTRIBUTING.md`.

**PR numbers:** $ARGUMENTS

## Iron Rules

| Rule | Meaning |
|------|---------|
| **User approves every rule** | Never add a rule to CONTRIBUTING.md without explicit "add" from the user. |
| **One rule at a time** | Present each proposed rule individually. Don't batch. |
| **Only resolved threads** | Skip unresolved threads — they represent ongoing debate. |
| **No duplicate rules** | Check existing CONTRIBUTING.md before proposing. Skip if a similar rule exists. |
| **Generalizable rules only** | Skip one-off questions, architecture debates, subjective opinions. Only propose rules that are repeatable patterns. |

### Red Flags — STOP If You Think This

| Thought | Reality |
|---------|---------|
| "This rule is obvious, just add it" | Present it. Wait for "add". |
| "I'll batch these related rules" | One rule at a time. Always. |
| "This question is a generalizable rule" | Questions aren't rules. Skip. |
| "I'll create CONTRIBUTING.md with all rules at once" | Interactive approval. One by one. |
| "I'm not sure which category this is" | Default to `code-hygiene` or ask the user. |

## Workflow

### Step 1: Prerequisites

Locate the `github` plugin. The resolver reads the platform's install record; it
never builds a cache path by hand:

```bash
GH_ROOT=$(python3 "${CLAUDE_PLUGIN_ROOT}/scripts/resolve_github.py") || exit 1
GH="$GH_ROOT/engine/gh.py"
```

If it exits non-zero it prints an `error:` line and a `fix:` line. Stop and show
both to the user.

### Step 2: Parse PR numbers

Extract PR numbers from `$ARGUMENTS`. If no PR number provided, show usage:

```
Usage: /norms:learn <PR-number> [PR-number...]
Example: /norms:learn 1383
Example: /norms:learn 1383 1375 1380
```

### Step 3: Fetch resolved threads

For each PR number, call the tool. Formatting is a flag now, not a second script
in a pipe. Each Bash call is a fresh shell, so resolve `GH` again here rather
than relying on the variables set in Step 1:

```bash
GH_ROOT=$(python3 "${CLAUDE_PLUGIN_ROOT}/scripts/resolve_github.py") || exit 1
GH="$GH_ROOT/engine/gh.py"
mkdir -p /tmp/claude
python3 "$GH" pr-threads <PR_NUMBER> --format resolved-threads > /tmp/claude/resolved-<PR_NUMBER>.json
```

Count and report: "Found X resolved threads across Y PRs."

If zero resolved threads, stop: "No resolved review threads found. Nothing to learn from."

### Step 4: Read existing CONTRIBUTING.md

Check if `CONTRIBUTING.md` exists at the project root:
- If yes: read it, parse existing rules (each `### Rule Name` under a `## [section]`)
- If no: note that it will be created from scratch

### Step 5: Analyze and categorize threads

For each resolved thread, read the comment body and the file path. Categorize into:

| Category | Section in CONTRIBUTING.md | Signals |
|----------|---------------------|---------|
| test-conventions | `[test-conventions]` | Comment on test files, mentions test helpers, test naming, assertion patterns |
| type-strictness | `[type-strictness]` | Mentions types, unions, visibility, readonly, class constants |
| naming | `[naming]` | Mentions variable/method/parameter naming, semantics |
| code-hygiene | `[code-hygiene]` | Mentions comments, blank lines, coverage annotations, formatting |
| existing section | the heading of a domain section already present in the project's CONTRIBUTING.md | The comment fits that section's scope sentence better than the four above (a rule about migrations when a migration section exists). Never create a new domain section from a review thread |
| **skip** | — | One-off questions, architecture discussions, subjective opinions |

**A thread is generalizable (keep) when:**
- It suggests a concrete, repeatable pattern (not a one-off question like "Why?" or "Explain this")
- The pattern could apply to other files/PRs in the same project
- The fix was accepted (thread resolved after making the change)

**Skip:** architecture suggestions ("Move to another repository?"), debatable opinions, business-logic-specific comments.

**If unsure about category:** default to `code-hygiene` or ask the user.

### Step 6: Create TODO list

Create one `TaskCreate` entry per proposed rule (skipping "skip" category).

Each task:
- **subject**: `[category] Proposed rule: <short description>`
- **description**: Original comment body, file path, proposed rule text
- **activeForm**: `Proposing rule from PR review`

Announce: "I found X generalizable rules from Y resolved threads. I'll present each one — say **add** to include in CONTRIBUTING.md, **skip** to ignore, or **edit** to modify before adding."

### Step 7: Present each proposed rule

For each task, mark as `in_progress` and display:

```markdown
## Rule N/total — [category]

**From PR #X:** `path/to/file.ext:line`
**Reviewer comment:** "<original comment>"
**Thread outcome:** The fix was applied (thread resolved)

### Proposed CONTRIBUTING.md rule

Under `## [category]`:

### <Rule Name>
- <Rule description line 1>
- <Rule description line 2>
- Severity: <ERROR|WARNING|INFO>

**add** · **skip** · **edit**
```

Wait for user response.

### Step 8: Handle user decision

- **"add"** → Append the rule to CONTRIBUTING.md under the correct section. If the section doesn't exist, create it. Mark task completed.
- **"skip"** → Mark task completed. Move to next.
- **"edit"** → Ask user what to change. Apply their edits, then add to CONTRIBUTING.md. Mark task completed.
- **Anything else** → Discussion. Adjust proposed rule, re-present.

### Step 9: Write CONTRIBUTING.md

After all rules are processed:

1. If CONTRIBUTING.md was modified, show the final file content
2. Commit:
```bash
git add CONTRIBUTING.md
git commit -m "Update project code norms from PR review feedback"
```
3. Present summary:

```markdown
# Norms Learn — Complete

| # | Category | Rule | Decision |
|---|----------|------|----------|
| 1 | test-conventions | PestPHP naming | add |
| 2 | naming | Method names match return type | add |
| 3 | type-strictness | Minimize unions | skip |
| ... | ... | ... | ... |

**Summary:** X rules added, Y skipped
**File:** CONTRIBUTING.md updated (or created)
```
