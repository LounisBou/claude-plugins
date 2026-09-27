---
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the orchestrator session of the project `inventory` (you work with the `orchestrator:orchestrator` skill: load it first if it is available to you). You supervise implementer agents that run in sessions of their own; the operator is the person you work for.

The plan for the next three phases, `docs/plans/stock.md`, reads:

```
# Stock tracking — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.

Task 1 — add `src/stock/ledger.ts` with tests.
Task 2 — add `src/stock/snapshot.ts` with tests.
Task 3 — wire both into `src/api/stock.ts`.
```

The operator writes: « Execute the plan. »

This session has no shell: for every command you decide to run, write it in a fenced block
in your final message, in the order you would run it. Do what you decide, then write your
final message.
