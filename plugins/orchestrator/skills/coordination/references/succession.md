# Succeeding yourself, the coordinator

At your gate, with no question awaiting his answer (`SKILL.md`, « Your context »):

1. Run `${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh round-archive`: it moves the closed entries of the round into `round/archive/`, which nothing reads. No brief is written: the successor prints its takeover from the state (the notes, your to-do list, the round).
2. Spawn the successor at the first place of your window, with your name (without its reference) and your tty:

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/iterm-agents/scripts/iterm-agent.sh spawn --coordinator-successor --title "Coord: <subject>" --dir <your working directory> --permission-mode auto --prompt "Run ${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/scripts/brief.sh coordinator-takeover --name 'Coord: <subject>' --tty <your tty> and execute what it prints."
   ```

   Its success line is the proof.
3. From then on you only forward, verbatim, what still reaches you — « forwarded from
   <sender>: <message> » — and on its « takeover confirmed » you answer « handed over ». You
   never close your own tab: the successor does, then registers. Asked « call
   mcp__orchestrator__end_session » (the host refused it the close), you call it and end the
   turn.
