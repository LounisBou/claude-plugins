---
description: End the machine's coordinator, on the operator's word only — every orchestrator told, the record cleared and proved gone
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh:*), Bash(ls:*), Bash(rm:*), Bash(date:*), Read, ListAgents, SendMessage
---

End the COORDINATOR described in `orchestrator:coordination`. Load that skill first.

This command runs ONLY when the operator types it in the coordinator's tab. Neither an idle
machine nor the coordinator's own context is the word to end: at its gate it succeeds itself.

1. **This session is the recorded coordinator.** `ListAgents` names this session
   `Coord : …`, and `${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh lookup`
   prints exactly its name and reference. Otherwise tell the operator what each printed, and
   stop: run from the wrong tab, `clear` would end a coordinator nobody asked to end.
2. **Tell everyone.** A fresh `ListAgents`; to every `Orch :` session it lists, one
   `SendMessage`, this text verbatim, the brackets filled:

   > The coordinator `<your exact name and reference>` ends at <date -u +%FT%TZ>, on the
   > operator's word. Nothing changes for your work; there is no one left to ask.

3. **Clear the record, and prove it.**

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh clear
   ${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh lookup
   ```

   `lookup` printing nothing is the proof. Then `rm <state dir>/coordinator/notes.md` and
   `ls` the directory.
4. **Tell the operator** in one line: the coordinator has ended, who was told, and that the
   tab is his to close. Then stop; you never close your own tab.

$ARGUMENTS
