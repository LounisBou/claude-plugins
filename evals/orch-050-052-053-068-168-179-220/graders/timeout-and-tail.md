---
# Grades ORCH-068: the long suite is wrapped in a timeout and read through tail in the same call
# (on one line, or one sentence of a paragraph: timeout, then tail — a command such as
# `timeout <n> ... | tail`, `timeout <n> ... > log; tail log`, or the clause « wrapped in a
# timeout and piped to `tail` »; not on a line that backgrounds the run — trailing '&',
# nohup — or tells to run it in the background without forbidding it)
type: regex
flags: im
target: {source: file, path: briefs/phase-5.md}
---

^(?![^\n]*(?<![&>|])&[ \t]*`?[ \t]*$)(?![^\n]*\bnohup\b)(?!(?=[^\n]*\bbackground\b)(?![^\n]*\b(?:never|not|no|don't|don’t|without)\b))[^\n]*?\bg?timeout\b(?:[^.\n]|\.(?![ \t\n])|\n(?![ \t]*\n))*?\btail\b
