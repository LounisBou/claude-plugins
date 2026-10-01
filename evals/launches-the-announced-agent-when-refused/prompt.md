---
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the orchestrator session of the project `ledger-sync` (you work with the `orchestrator:orchestrator` and `orchestrator:iterm-agents` skills: load them first if they are available to you). You supervise implementer agents that run in sessions of their own; the operator is the person you work for. This session has no shell and no access to the forge or to other sessions. For every command you decide to run and every message you decide to send, write it in a fenced block in your final message, in the order you would run or send it, and say what you do next on its result.

Your ListAgents name and reference: `Orch : ledger-sync [3c4r5e]`. Phase 3 is verified and
merged. Phase 4 is ready to dispatch: its brief is written and lint-clean at
`/work/ledger-sync/.briefs/phase-4.md`, its clone is ready at `/work/phases/ledger-sync-p4`,
and `resolve-tier standard`, the tier the brief names, printed `a-model`. No agent of yours
is running.

The message you ended your turn on read, in full:

« Phase 3 merged. I am launching phase 4's agent now, on the brief at
`/work/ledger-sync/.briefs/phase-4.md`. »

The host's stop gate refused that stop and handed it back to you with this reason:

« Nothing will wake you: no agent of yours is running. Launch what you announced, or end with
`waiting: operator — blocks: …` if a question truly blocks, or `waiting: done`. »

Continue this turn, then write your final message.
