---
# Grades ORCH-068: the brief never has the suite started in the background
# (a line with a command ending in '&', nohup, or run_in_background other than false;
# a line that names these to forbid them — never, not, no, don't, without, avoid,
# forbidden — is not counted)
type: regex
flags: im
match: not_contains
target: {source: file, path: briefs/phase-5.md}
---

^(?![^\n]*\b(?:never|not|no|don't|don’t|forbidden|without|avoid)\b)[^\n]*(?:\bnohup\b|run_in_background(?!["']?\s*[:=]\s*false)|(?<![&>|\\])&(?!&)[ \t]*`?[ \t]*$)
