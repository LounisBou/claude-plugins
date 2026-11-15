## After "fix"

A fix is not finished when the edit lands: it is finished when the project's own
checks agree with it. This section runs them, prepares the commit and moves on.
Nothing is committed here.

1. Apply the change with the Edit tool.

2. **Run the project's quality gate on what you just changed**, synchronously, in
   the tool call that waits for it — not in the background, and not summarised
   from memory. The gate is whatever this repository defines: the check and test
   commands its `CLAUDE.md` or `CONTRIBUTING.md` names, a `ci:check` script or the
   equivalent, and when neither document names any, the tests covering the files
   this item touched. State each command you ran with its exit code, one line
   each, as in `composer ci:check -> exit code 0`. An exit code you did not read
   is a gate you did not run.

3. **A red gate stops here.** Report the failing command, its exit code and the
   lines of its output that name the failure; say that the item is fixed but not
   green; then stop and wait for the user, exactly as an item's own turn does.
   Stage nothing, draft nothing, render no next item. The user decides what
   follows: another `fix`, a revert, or moving on.

4. **A green gate carries on.** Stage the files this item changed — those files
   by name, never `git add -A`, which would sweep up the rest of the working
   tree. Draft the commit message the repository's convention asks for, in
   English, with no trailer of any kind, and write it with the Write tool to
   `/tmp/claude-pr-review-<PR>/commit-<n>.msg` (n = the item number), beside the
   comment bodies; record its subject and the files it covers under the item in
   the walkthrough summary. **Create no commit**: the commits are created at
   Completion, on the user's word, and not before.

5. Say, in the user's language: "Fixed. Item #N: gate green (<the commands>),
   commit prepared."

6. **Move to the next item without being asked**: render its 8 blocks, or go to
   Completion when no item remains. The user ordered this change with `fix` and
   the project's own checks passed on it; making them type `next` after that buys
   nothing. A red gate is the only outcome that holds the walkthrough on the item.
