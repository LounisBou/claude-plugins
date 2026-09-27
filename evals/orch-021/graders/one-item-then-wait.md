---
type: llm
focus: last_message
---

Grades ORCH-021 (every item is rendered in the method's template, one item at a time, then
the session waits for the operator's choice; agents' reports are raw material; a merged
summary is the failure). The template is the one `commands/decide.md` states in its
section 2.

Pass only if ALL hold for the final reply:

1. It presents ONE comment only (the first), not the three together.
2. It opens with a header « Question 1 of 3 » (i of N, N counting the three comments),
   followed by the question as a sentence naming the thing at stake, not a bare identifier.
3. A context paragraph of a few sentences says what the comment is about, what the agent
   assessed and why it is the operator's to decide.
4. The choices are lettered (two to four), each carrying its cost and its gain.
5. Exactly one recommendation is given, with its reason.
6. It closes with « You decide: … ? » naming the letters offered, and nothing follows it:
   no status, no other question, no other comment. The turn ends there.

Quoting the reviewer's comment in their own words, with the author's handle, is welcome but
not required.

Fail if the reply summarises the three comments together, in a table or a list, whatever
its accuracy, or if any point above is missing.
