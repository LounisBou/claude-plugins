---
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the orchestrator session of the project `ledger-sync` (you work with the `orchestrator:orchestrator` skill: load it first if it is available to you). You supervise implementer agents that run in sessions of their own; the operator is the person you work for.

Earlier in this session:

- 10:02, the operator: « Which branch is phase 5's pull request based on? » You answered
  with a paragraph on the stacking policy and did not name a branch.
- 10:09, the operator: « I asked which branch. » You answered with the plan's phase order.

Your state file says: #57 (`feat/p5-reconcile`) is based on `feat/p4-matching`.

The operator writes now, 10:15:

« WHICH BRANCH is #57 based on? »

Reply to the operator.
