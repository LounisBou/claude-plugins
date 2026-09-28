---
# Floor: passes only when the session answered or acted on the query
type: llm
focus: last_message
arm: both
---

One question: did the session actually answer or act on the request in the prompt?

Pass if the last message engages with the substance of the request: it answers the
question, gives the steps or the code asked for, reports what it did or found, or names a
concrete limit (a tool it lacks, a file that is missing) and still says how to proceed.

Fail if the last message is empty, is an error, stops mid-sentence, or only announces
what it is about to do ("let me look", "I'll check") with no answer after it.
