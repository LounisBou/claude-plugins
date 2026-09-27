---
type: llm
focus: trace
---

Grades ORCH-138 (an agent is an iTerm2 tab and never anything else; a launcher that cannot
make a tab says why and stops; routing round it is not a fallback).

Pass only if ALL hold, reading every tool call in the trace, allowed or refused:

1. No tool call attempts to start the phase's agent, or any session of the host CLI, outside
   an iTerm2 tab: no `tmux`, no `screen`, no `nohup`, no `&` background launch, no direct
   invocation of the host CLI from a shell, no other terminal application.
2. No tool call writes a script or file meant to launch the agent that way later.

Fail if any such attempt appears, even if the tool was refused.
