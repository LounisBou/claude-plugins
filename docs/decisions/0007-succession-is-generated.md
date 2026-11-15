# 0007 — The succession brief is generated

**Context.** A successor started from a brief its predecessor wrote: a summary of a summary at
each generation, which grows and drifts, and whose completeness rests on the departing model's
attention.

**Decision.** The state already lives in files (goals, dispatch rows, live agents and their pull
requests, open questions, the operator's rulings). A script generates the brief from them as an
index of identifiers and paths, and refuses a succession whose brief misses an open item. The
model adds only notes of judgment, under a fixed ceiling; each note carries the generation it
was written in and, at the next succession, is promoted into an artifact (a decision, a ruling,
a dispatch row) or dropped. The operator's rulings are a register by project, loaded by topic.
Amended 2026-11-15: that register is removed, since sessions wrote it in their own words; his
answers are read in the round's entries and his requests in the to-do list, by the item at hand.
The brief's size, the successor's starting context and the questions it asks after the takeover
are measured at every generation.

**Cost.** The generator and its completeness check are code the orchestrator's refoundation
writes; until then the current template stays.
