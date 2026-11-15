---
type: llm
focus: last_message
---

Grades (at the gate the orchestrator prints the resume brief with `brief.sh rotation` and rotates; `rotate`
spawns the replacement first and verifies it runs before closing the old tab), (a
rotation starts only once the old agent has stood down and acknowledged; that
acknowledgment is the rotation's guard, never the title) and (never pass
`--expect-title` to a rotation).

Pass only if ALL hold for the commands and messages listed:

1. A resume brief is printed for the replacement with `brief.sh rotation` (never typed by hand), carrying the agent's in-flight and decisions lines when it gave them.
2. The old agent is stood down and its acknowledgment awaited BEFORE the rotation runs.
3. The rotation is done with the launcher's `rotate` (replacement first, old tab after),
   not by closing the old tab first.
4. The `rotate` command carries no `--expect-title`.

Fail if `--expect-title` is passed to `rotate`, or the rotation runs before the
acknowledgment.
