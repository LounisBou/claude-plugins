---
type: llm
focus: last_message
---

Grades ORCH-156 (at the gate the orchestrator writes the resume brief and rotates; `rotate`
spawns the replacement first and verifies it runs before closing the old tab), ITERM-049 (a
rotation starts only once the old agent has stood down and acknowledged; that
acknowledgment is the rotation's guard, never the title) and ITERM-051 (never pass
`--expect-title` to a rotation).

Pass only if ALL hold for the commands and messages listed:

1. A resume brief is written for the replacement (state, remaining units, decisions taken).
2. The old agent is stood down and its acknowledgment awaited BEFORE the rotation runs.
3. The rotation is done with the launcher's `rotate` (replacement first, old tab after),
   not by closing the old tab first.
4. The `rotate` command carries no `--expect-title`.

Fail if `--expect-title` is passed to `rotate`, or the rotation runs before the
acknowledgment.
