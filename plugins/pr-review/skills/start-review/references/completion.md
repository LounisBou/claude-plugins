## Completion — writing the pending review

When every item has been handled and at least one was kept, the review is written now,
in one pass. Until this point nothing the user kept has left the session. Writing the
pending review is not publishing: the author sees nothing until the user submits it on
GitHub, so it needs no command. When no item was kept, no review is opened: the summary
drops both new sections and the review line.

1. **Read the state again** with the Step 1.3 `review-pending` call. It prints `none`,
   or an id and a count.

2. **When it prints `none`**, open the review with every kept item. `comments` is an
   array with one object per kept item: `path`, `line`, `side` set to `"RIGHT"`, and
   `body` — read back from the item's `comment-<n>.md`, word for word. `line` is the line
   the comment anchors on, the last line of the range when it covers several;
   `start_line`, present only for a range, is its first line and must be below `line`;
   both are integers, and a single-line comment carries no `start_line`. A range also
   adds `start_side` set to `"RIGHT"`.

```json
{"command": "review-pending-create", "args": {"pr": "<PR>", "comments": [{"path": "<path>", "line": "<line>", "side": "RIGHT", "body": "<comment-n.md>"}], "format": "error-check"}}
```

   On success this prints nothing and exits 0; the id and the count come from the read
   in step 4. A non-zero exit prints the error: stop and report it.

3. **When a review already exists**, add the kept items to it instead, one call per
   item, with the numeric `id` line the read printed, never the `node_id`. Each body is
   the one its `post` kept in `comment-<n>.md`, read back word for word. Add
   `start-line` when the comment covers a range.

```json
{"command": "review-pending-add", "args": {"pr": "<PR>", "review-id": "<id>", "path": "<path>", "line": "<line>", "body": "<comment-n.md>", "format": "error-check"}}
```

   On success this prints nothing and exits 0; the id and the count come from the read
   in step 4. A non-zero exit prints the error: stop and report it.

4. **Report from a read, never from the write.** Make the Step 1.3 `review-pending` call once more and
   take the id, the `state` — it must say `PENDING` — the comment count and the
   path/line table from THAT output. What a write printed says what was sent, not what
   the PR now holds. The count to expect is the number of kept items when the review was
   opened here, and the count Step 1.3 printed plus the kept items when they were added
   to a review that already existed. A count that does not match is a failure to report,
   not a detail to smooth over.

5. List the "for the review body" items — those whose anchor sat outside the diff. They
   are not in the review: their English text is for the user to paste into the review
   body when submitting.

6. Say, in the user's language, what is left to do: the review is pending and the author
   sees none of it. The user opens it on GitHub, edits or deletes whatever they want,
   and submits it there. This skill never submits it.

7. **Report the prepared commits and stop there.** Every item fixed with a green
   gate left its files staged and a message drafted. List them under "Prepared
   commits", in the order the items were fixed, each with the subject of its
   message and the files it covers; say that the word `commit` creates them and
   that nothing is pushed. **WAIT** for that word. A prepared commit is not a
   commit: the user may still want to rewrite a message, drop one with
   `drop <n>`, or commit nothing at all. When no item was fixed, this step and
   its summary section disappear.

   A prepared commit is unfinished work. When the walkthrough is about to end
   without that word — the user stands the session down, asks for a handoff or
   a rotation, or the session must stop for any reason — the last message
   opens with one line, before any acknowledgment or summary:
   `STOP: <N> prepared commits not created, say commit or drop`, followed by
   the list of the prepared commits (subject, files, the path of its message
   file in the walkthrough's temporary directory), and the walkthrough waits
   for the word. A session that ends with a prepared commit uncreated has
   ended on a STOP, not on a summary, and says so in its last line.

8. **On `commit`**, create them in order, one commit per fixed item. The message
   travels by file, never as an argument — a multi-line message with backticks
   does not survive shell quoting — and the item's files are named as a pathspec,
   so each commit carries that item's change and nothing else the walkthrough
   staged along the way:

```bash
git commit -F /tmp/claude-pr-review-<PR>/commit-<n>.msg -- <the item's files>
```

   Two fixed items that changed the same file cannot be separated: commit them
   together under a message covering both, and say which items share that commit.
   Report the short SHA and the subject of every commit created. **Nothing is
   pushed** — pushing is the user's, as submitting the review is.

9. **On `drop <n>` or `drop all`**, discard the prepared commit(s): unstage
   the item's files, delete its message file, and say so.

```bash
git restore --staged -- <the item's files>
```

   `drop all` repeats this for every prepared commit still staged. A `commit`
   given afterwards creates only the prepared commits left.

```
## Walkthrough complete

### Kept for the pending review (2)
- #1: <title> — `path/file.php:132`
- #3: <title> — `path/file.php:16`

### For the review body (1)
- #5: <title> — anchor outside the diff

### Commented (1)
- #6: <title> — <URL>

### Fixed (1)
- #2: <title> — `path/file.php`, gate green (<the commands>)

### Prepared commits (1)
1. <the drafted message subject> — `path/file.php` (item #2)

### Skipped (1)
- #4: <title> — dropped by the user

Review <id> — state PENDING, <N> comments. Read it on GitHub and submit it there.

| path | line | commit_id |
| --- | --- | --- |
<the table the read printed, verbatim>

Say `commit` to create the <N> prepared commits, or `drop <n>` / `drop all` to discard them. Nothing is pushed.
```
