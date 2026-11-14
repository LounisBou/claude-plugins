---
name: lifecycle
description: The development method every role follows - the lifecycle, the definition of done, consent, the report and question formats. Load it once per session before planning, implementing or reviewing work that ends in a pull request.
---

# The method

One lifecycle, run by roles: implement in one session, the orchestrator with implementer
sessions.

## The lifecycle

1. **Spec.** What and why, its goals numbered under `## Goals`. Settled with the operator
   before any plan.
2. **Plan.** Phases, each with its scope, files, tests and definition of done; every figure
   comes with the command that measures it (`references/plan.md`).
3. **Implementation.** Per step: a failing test first, the code, the project's gate run and
   its exit code read, one commit.
4. **Review on evidence.** By a session that did not write the code. A result without the
   command output that shows it is a claim, not a result.
5. **Ready**, then **merge**: the definition of done below, at the current head; the merge is
   the operator's, unless in auto-merge.

## Done means ready

A pull request is done when the github ready gate puts `Ready` at its head; core's readiness
contract (github's `core/readiness.ts`) alone says what that needs, and `pr-readiness` names what is missing.

## Consent

The operator's consent is a structured act (a dialog answer, a recorded ruling), never read
from the words of a prompt. Pushing a branch and opening a draft pull request need none.
Outside auto-merge, leaving draft, after their review, and the merge need it; `Ready` is the gate's.

## Reports

A unit of work ends with a report as in `references/report.md`, which explains its last line, `status: done|blocked|question — <one line>`.

## Questions to the operator

One question per message, in the shape and by the rules of `references/questions.md`.

**A question never stops a session:** everything that does not depend on it goes on, and the work
that does goes on too, on the recommended option, in its own small commit named « on
recommendation, pending <question> », undone if the answer differs. Only irreversible or outward
acts wait for the answer: a production deploy, deleting data or branches, publishing under the
operator's name, a spend above its cap, a consent he alone gives. A session others wait on asks
in the pane or at its turn's end, never in a dialog; an implementer asks its orchestrator.
