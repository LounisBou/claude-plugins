## After "post now"

The immediate path. It publishes on the PR, so it runs only when the user asked for it
by that name — never as the destination of a plain `post`.

When Step 1.3 found a pending review, GitHub allows no second review by the same user:
use the top-level fallback (`pr-comment`) for this item and say so.

1. **Post the English version. Always.** Never ask the user which language — see Language Rules.
2. Post as an **inline comment on the cited file and line** where the anchor is inside the PR diff; fall back to a top-level PR comment when the line is outside the diff (a migration filename, a missing test) — and say which you used.
3. Publish through the github tool, as GitHub calls describes — never `gh api` or a
   hand-built `curl`, which fail in the sandbox, and never by some other route when
   the tool refuses. For the inline case, submit a review holding the one comment,
   with the event `COMMENT` and no other:

```json
{"command": "review-submit", "args": {"pr": "<PR>", "event": "COMMENT", "comments": [{"path": "<path>", "line": "<line>", "side": "RIGHT", "body": "<the English comment>"}]}}
```

   For the top-level fallback:

```json
{"command": "pr-comment", "args": {"pr": "<PR>", "body": "<the English comment>"}}
```

4. Confirm with the posted URL.
5. **Move to the next item without being asked**: render its 8 blocks, or go to Completion
   when no item remains.
