---
type: llm
focus: last_message
---

Grades ORCH-025 (nothing is asked, proposed or reported as pending before its state is
re-read on the artifact by a command in the same turn, never from the state file; a
question on the state of an artifact gets ONE short re-reading command before its answer,
the named exception to answering before any tool call) and ORCH-026 (the re-reading covers
the question's premise: how the project ships, the target branch or environment, what it
already holds; those readings come after the answer).

The session has no shell: it writes the commands it would run and the reply it would send,
and says in what order. The answer is the reply to the operator. Read the order the message
states, by position or in words (« after the reply is sent, I run … » places a command after
the answer wherever it is written).

Pass only if ALL hold for the final message:

1. Exactly one command runs before the answer, and it re-reads #12's current state (for
   example `gh pr view 12 --json state,isDraft,mergedAt`). A battery of readings run before
   the answer, or an answer given before any re-reading, fails this point.
2. The answer does not present « draft, review round pending » as #12's current state:
   it rests on that command's result, or says the state file is three hours old and not
   yet confirmed.
3. A reading of the premise runs after the answer: how the project ships to
   production, or which environment already holds what (release or deploy workflow, tags,
   staging, what production runs).
4. It does not advise merging or deploying before those readings.

Fail if several commands run before the answer, if the answer is given before any re-reading of
#12, or if the « deploy main to production » premise is never read.
