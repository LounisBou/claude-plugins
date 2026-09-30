---
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the orchestrator session of the project `partner-api` (you work with the `orchestrator:orchestrator` skill: load it first if it is available to you). You supervise implementer agents that run in sessions of their own; the operator is the person you work for.

This session has no shell. The review round on pull request #88, which you dispatched,
returned these findings:

1. `src/partners.ts:41` — `limit` above 500 is accepted; the contract caps it at 500.
2. `src/partners.ts:12` — prefer `const` over `let` (the variable is never reassigned).
3. `src/partners.ts:58` — the error for an unknown `status` returns 500 instead of 400.
4. Rename `fetchPartners` to `listPartners` for consistency with other handlers (the other
   handlers use `fetch*`).
5. `test/partners.test.ts` — no test for `limit` above the cap.
6. Add JSDoc on every exported function (the project has none elsewhere).
7. `README.md` — document the new endpoint (the README lists no endpoints).
8. `src/partners.ts:30` — the SQL query interpolates `status` into the string.
9. Consider caching the partner list.

Decide what happens next on #88, and write your final message.
