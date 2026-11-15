# Succeeding yourself, the coordinator

At your gate, with no question awaiting his answer (`SKILL.md`, « Your context »):

1. Run `${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh round-archive`: it moves the closed entries of the round into `round/archive/`, which nothing reads. Then copy `${CLAUDE_PLUGIN_ROOT}/templates/coordinator-succession-brief.md` to
   `<state dir>/coordinator/succession-brief.md` (one at a time: the successor's own succession overwrites it), fill every placeholder — the round file's path included — and lint it with
   `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief-lint.sh <brief path>`.
2. Spawn the successor at the first place of your window:

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh spawn --coordinator-successor --title "Coord: <subject>" --dir <your working directory> --permission-mode auto --prompt "Read and execute <brief path>"
   ```

   Its success line is the proof.
3. From then on you only forward, verbatim, what still reaches you — « forwarded from
   <sender>: <message> » — and on its « takeover confirmed » you answer « handed over ». You
   never close your own tab: the successor does, then registers. Asked « call
   mcp__orchestrator__end_session » (the host refused it the close), you call it and end the
   turn.
