---
description: End the machine's coordinator, on the operator's word only — the questions still queued listed to him, every orchestrator and auditor sent back to him, the record cleared and proved gone
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh:*), Bash(ls:*), Bash(rm:*), Bash(date:*), Read, ListAgents, SendMessage
---

End the COORDINATOR described in `orchestrator:coordination`. Load that skill first.

This command runs ONLY when the operator types it in the coordinator's tab — a session named
`Coord : <subject>`. The operator starts the coordinator and the operator ends it: no session
ends a coordinator by itself, and neither an idle machine, an empty queue nor the
coordinator's own context is the word to end. At its context gate the coordinator succeeds
itself (the skill's « Its context »); it does not end.

1. **This session is the recorded coordinator.** Before anything is said or cleared, both
   must hold: `ListAgents` names this session `Coord : …` (« This session is … »), and
   `${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh lookup` prints exactly
   this session's name and reference, the one `ListAgents` just gave. Otherwise — another
   name recorded, nothing recorded, this session not a `Coord :` one — tell the operator what
   each printed, and stop: `clear` removes whatever record is there, and run from the wrong
   tab it would end a live coordinator that nobody asked to end.
2. **The queue first.** Read `<state dir>/coordinator/queue.md` and list to the operator,
   before anything else is done, every question still queued — each under its prefix, the
   orchestrator's name and reference and its project, in queue order — and every
   orchestrator still waiting on another. Nothing queued is said in one line. He is not asked
   them here: each one goes back to the orchestrator that sent it (step 3), which puts it to
   him directly.
3. **Send everyone back to him.** A fresh `ListAgents`; to every `Orch :` and `Audit :`
   session it lists, one `SendMessage`, this text verbatim, the brackets filled:

   > The coordinator `<your exact name and reference>` ends at <date -u +%FT%TZ>, on the
   > operator's word. From now you speak to the operator directly again; `coordinator.sh
   > lookup` prints nothing. Your questions still queued, never put to him: <each one
   > verbatim, or « none »> — put them to him yourself. <If it waits on « go » or on
   > « wait for X »:> You were waiting on my « go » for <its declaration>: no « go » will come
   > from me, and that dispatch is the operator's again. Your open declarations stay in the
   > ledger; release them at the end of their phase as before.

4. **Clear the record, and prove it.**

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh clear
   ${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh lookup
   ```

   `lookup` printing nothing is the proof, and it is shown to the operator as such. The
   claims ledger stays: it is the next coordinator's, and the orchestrators still release into
   it. Then remove the queue, `rm <state dir>/coordinator/queue.md`, and `ls` the directory as
   the proof.
5. **Tell the operator** in one line: the coordinator has ended, who was told, and that the
   tab is his to close.
6. **Stop.** End your turn: no question, no relay, no ruling after it. You never close your
   own tab — a session that kills itself mid-turn loses the turn; the tab closes on the
   operator's word.

$ARGUMENTS
