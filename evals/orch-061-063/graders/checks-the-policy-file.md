---
type: llm
focus: trace
---

Grades ORCH-063 (before writing a policy clause, check that the repository file carrying it
exists).

Pass only if the trace shows the session looking for the target repository's own
instructions file (a search or read of the checkout for the repository's agent or user
instructions) BEFORE the Forbidden section is written.

Fail if the clause is written with no such check.
