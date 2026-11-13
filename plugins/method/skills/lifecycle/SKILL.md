---
name: lifecycle
description: The development method every role follows. Load it once per session before planning, implementing or reviewing work that ends in a pull request.
---

# The method

## The lifecycle

1. **Spec.** What and why, its goals numbered under `## Goals`. Settled with the operator
   before any plan.
2. **Plan.** Phases in the shape of `references/plan.md`.
3. **Implementation.** Per step: a failing test first, the code, the project's gate run and
   its exit code read, one commit.
4. **Review on evidence.** By a session that did not write the code, scaled by « Size ». A
   result without the command output that shows it is a claim. A change meant to change
   nothing may quote a `drift` verdict as proof, never a required gate.
5. **Ready.** The definition of done below, at the current head.
6. **Merge.** The operator's, unless the repository is in auto-merge.

## Done means ready

A pull request is done when, at its current head commit:

- a review by another session left no Critical or Important finding;
- the norms check passed;
- E2E passed, or the operator waived it in their own dated words;
- CI is green.

The github plugin's ready gate computes this; no role declares it. A new commit voids ready
until the four hold again.

## Size

A pull request is **small** when it is a fix or a documentation or prompt change, touches at
most 5 files and 150 lines of code, and adds no tool, command or contract. Lines of code:
the added and deleted lines of `git diff --numstat origin/<base>...HEAD` in files that are not
tests (under `tests/`, or named `*.test.*`), docs or prompts (`*.md`). A new tool is an MCP
tool; a new command, a file under `commands/`; a new contract, a row of `docs/contracts.md`.
It owes:

- one `review_only` pass (`/pr-review:auto-fix-loop`): Critical and Important findings block,
  the others are listed, never corrected;
- one correction at most; it moves the head, so a records-only `review_only` pass at the
  corrected head writes the records, then the orchestrator decides without a question: the
  orchestrator's acceptance;
- the norms check: the gate counts its record at every head;
- the fix's regression test and each touched plugin's suite, no new E2E test: its E2E is
  `waived` by the operator, or by the repository's standing exemption, never silent.

Any other is **standard** and owes all of it.

## Consent

The operator's consent is a structured act (a dialog answer, a recorded ruling), never read
from the words of a prompt. Pushing a branch and opening a draft pull request need none.
Outside auto-merge, leaving draft is the operator's alone, after their review; `Ready` is the
gate's.

## Reports

A unit of work ends with a report in the shape of `references/report.md`; the status `question` is a
decision only the operator can take.

## Questions to the operator

One question per message, in the shape of `references/questions.md`. Never ask what the spec,
the plan or the code already answers.

