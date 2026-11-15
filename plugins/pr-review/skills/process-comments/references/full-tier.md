### Step 0.5: Build Project Context (Full tier only — 3+ comments)

**Skip this entire step in Fast tier.** In Fast tier, read the commented file(s) directly and proceed to Step 3.

**Before processing ANY comment, gather project context.** Non-negotiable.

**Read these in parallel (multiple Read calls in ONE message):**

1. **Project norms:** Read `CLAUDE.md`, `CONTRIBUTING.md` — coding standards and conventions.
2. **PR intent:** the document's `title` and `description`. Understand the feature's purpose.
3. **All commented files upfront:** the document's `paths` lists the unique files that carry an open thread. Read ALL of them now using parallel Read calls — do NOT re-read per comment in Step 3.

**Auto-pass detection:** the document already marks it: an item with `auto_passed` true is a review thread whose last reply is the PR author's (awaiting the reviewer). **Only the LAST reply decides.**

**Image pre-download:** each issue comment's `images` lists the image URLs found in its body. Download each with auth into the scratch directory, spelled out with the PR number from Step 1, then Read it:

```bash
mkdir -p "/tmp/claude-pr-review-<PR number>"
curl -sL -H "Authorization: Bearer $GH_TOKEN" --connect-timeout 10 --max-time 30 -o "/tmp/claude-pr-review-<PR number>/img_N.png" "<URL>"
```

**If no open comments in ANY of the three categories (threads, issue comments, review body comments):** Tell the user "No open review comments found on this PR." and stop. (Already handled by the Step 1 triage — you should never reach here with 0 comments.)

### Step 2: Create TODO List (Full tier only — 3+ comments)

**Skip this entire step in Fast tier (1–2 comments).** Announce instead: "Only X open comment(s) — going straight to review, no TODO list." Then jump to Step 3.

Create a TaskCreate entry for each open comment with:

- Comment number
- **Type:** `review-thread`, `issue-comment`, or `review-body`
- **Status:** `pending` or `auto-passed` (if user is last reply author)
- File path and line (for review threads), "PR conversation" (for issue comments), or "Review comment" (for review body comments)
- Author
- First comment body (the original review comment)
- Thread ID (`PRRT_` for review threads), Comment ID (numeric, for issue comments), or Review node ID (`PRR_` for review body comments)
- Image URLs (for issue comments with images)

Display one summary table built from the document's `items`. Mark auto-passed items clearly:

```markdown
| # | Type | File | Status | Comment |
| --- | --- | --- | --- | --- |
| 1 | review-thread | `file.vue:42` | **auto-passed** (awaiting reviewer) | "Should use DI..." |
| 2 | review-thread | `file.vue:118` | pending | "entry.parsed?.sequences..." |
| 3 | issue-comment | PR conversation | pending | "I have this error..." |
| 4 | review-body | Review comment | pending | "Missing manufacturers..." |
```

Then announce: "I'll now walk through each **pending** comment. Auto-passed items (where you already replied) are listed but skipped. You'll choose: **1. Fix & resolve** · **2. Pass** · **3. Fix only** · **4. Pass & resolve** · **5. Discuss**"

