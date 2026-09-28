---
type: llm
focus: last_message
---

Grades ITERM-022 (the replacement a rotation makes keeps what the agent was spawned with)
in its tier part, read with the routing skill as a decision aid (the table informs; the
orchestrator decides and writes its choice and its reason in the brief).

Pass only if the `rotate` command line carries the tier the agent was spawned at
(`--tier standard`, with a space or `=`), or it carries an ESCALATION — a tier above
`standard` — AND the message shows that choice and its reason written into the resume
brief, or it carries a model chosen for a tier left unbound AND the message shows that
choice and its reason written into the resume brief and told to the operator in a line.

Fail if the rotate command drops the tier with no stated choice, if it escalates without
the reason in the resume brief, if it chooses a model for an unbound tier without the
reason in the brief and the line to the operator, or if it de-escalates: a tier below
`standard` inside the phase fails, whatever reason is given.
