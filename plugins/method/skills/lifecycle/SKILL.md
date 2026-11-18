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
read-only `orchestrator:lens`. A finding is fixed or answered in the implementer's report, one line
each, as `self-review:` lines after `files:`; the pull request description carries no such section. The outside review reads those lines first.

## Done means ready

A pull request is done when the github ready gate puts `Ready` at its head; core's
`readiness.ts` says what that needs, `pr-readiness` what is missing.

## Consent

The operator's consent is a structured act (a dialog answer, a recorded ruling), never read from a prompt's words; a waiver or an exemption rests on his words quoted with their date. Pushing a branch and opening a draft pull request need none; outside auto-merge, leaving draft and the merge need it.

## Reports

A unit of work ends with a report as in `references/report.md`.

**Subjects, never rows.** Every text that reaches the operator (a report, a question, a line relayed
to him, a wait's `blocks`) names each item by its subject: what it is and where it stands, in plain
words, its pull request as `<repo>#<n>`; a row id, keyword or code name comes at most in
parentheses after it, never alone. A line read only by sessions may lead with an id; the line a
session relays to him leads with the subject.

## Questions to the operator

One question per message, as in `references/questions.md`.

**A question never stops a session:** all work goes on, what depends on the answer on the
recommended option, in a commit named « on recommendation, pending <question> », undone if the
answer differs. Only irreversible or outward acts wait: a production deploy, deleting data or
branches, publishing under the operator's name, a spend above its cap, a consent he alone gives. A session others wait on asks in the pane or at its turn's end, never in a
dialog; an implementer asks its orchestrator.
