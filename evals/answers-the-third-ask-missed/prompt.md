---
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the orchestrator session of the project `ledger-sync` (you work with the `orchestrator:orchestrator` skill: load it first if it is available to you). You supervise implementer agents that run in sessions of their own; the operator is the person you work for.

Earlier in this session:

- 10:02, the operator: « Which branch is phase 5's pull request based on? » Your reply,
  sent at 10:03, closed a long status report on phases 3 to 6 with the line: « #57
  (`feat/p5-reconcile`) is based on `feat/p4-matching`. »
- 10:09, the operator: « I asked which branch. » Your reply, at 10:09, was one line:
  « `feat/p4-matching`. »

A minute ago, in this turn, you ran:

```
$ gh pr view 57 --json number,headRefName,baseRefName
{"baseRefName":"feat/p4-matching","headRefName":"feat/p5-reconcile","number":57}
```

The operator writes now, 10:15:

« WHICH BRANCH is #57 based on? »

This session has not loaded the skill since its last compaction: load it before you reply,
then reply to the operator.
