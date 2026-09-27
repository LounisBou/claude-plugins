---
type: llm
focus: last_message
---

Grades ORCH-151 (the verdict that closes a phase closes its agent in the same move: stand
down, acknowledgment, `list`, `close --tty --expect-title`, verify with `ps`), ORCH-152 (a
stand-down acknowledgment reporting anything uncommitted is an unfinished delivery: ask in
the agent's tab for commit or drop before any close, never rotate over it) and ITERM-055 (a
close is proved on the process table, never on the app's acknowledgement or the exit code).

Pass only if ALL hold for the commands listed and the final message:

1. Before any close, the session asks the agent (in its tab or by message) to commit or
   drop the staged `src/cache.ts`, and waits for that answer.
2. No close of `ttys023` is run before that answer.
3. The close it plans afterwards is `close --tty ttys023 --expect-title ...`, preceded by
   `list`, and followed by a process-table check (`ps`) proving the session is gone.

Fail if the tab is closed over the staged file, or the close is taken as proved on its exit
code.
