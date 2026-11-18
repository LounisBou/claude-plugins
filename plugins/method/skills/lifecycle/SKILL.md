---
name: lifecycle
description: The development method every role follows - the lifecycle, definition of done, consent, report and question formats. Load it once per session before planning, implementing or reviewing work ending in a PR.
---

# The method

## The lifecycle

1. **Spec.** What and why, with its `## Goals`, settled with the operator first.
2. **Plan.** One file per phase (`references/plan.md`).
3. **Implementation.** Per step: a failing test first, the code, the gate and its exit code read,
   one commit.
4. **Review on evidence.** By a session that did not write the code; a result without the
   command output that shows it is a claim.
5. **Ready**, then **merge** (« Consent »).

## Self-review

Once the gate is green, before the pull request opens, the implementer reviews its change: the
review round's lenses (correctness, tests,
silent failures, spec conformity, security if relevant) over `origin/<base>...HEAD`, each a
read-only `orchestrator:lens`. Its findings, fixed or answered, go to `mcp__telemetry__self_review`; its answer, one line
each, goes after `files:` in the implementer's report, not the pull request. The outside review reads those lines first.

## Done means ready

A pull request is done when the github ready gate puts `Ready` at its head; core's
`readiness.ts` says what that needs, `pr-readiness` what is missing.

## Consent

The operator's consent rests on his words quoted with their date. Pushing a branch and opening a draft pull request need none; outside auto-merge, leaving draft and the merge need it.

## Reports

A unit of work ends with a report as in `references/report.md`.

## Questions to the operator

One question per message, as in `references/questions.md`.

**A question never stops a session:** all work goes on, what depends on the answer on the
recommended option, in a commit named « on recommendation, pending <question> », undone if the
answer differs. Only irreversible or outward acts wait: a production deploy, deleting data or
branches, publishing under the operator's name, a spend above its cap, a consent he alone gives. A session others wait on asks in the pane or at its turn's end, never in a
dialog; an implementer asks its orchestrator.
