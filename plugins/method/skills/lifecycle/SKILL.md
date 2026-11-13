---
name: lifecycle
description: The development method every role follows - the lifecycle, the definition of done, sizes, consent, formats. Load it once per session before planning, implementing or reviewing work that ends in a pull request.
---

# The method

## The lifecycle

1. **Spec.** What and why, its goals numbered under `## Goals`. Settled with the operator
   before any plan.
2. **Plan.** Phases in the shape of `references/plan.md`; every figure comes with the
   command that measures it.
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
- the norms check passed, where « Size » owes one;
- E2E passed, or the operator waived it in their own dated words;
- CI is green.

The github plugin's ready gate computes this; no role declares it. A new commit voids ready
until the four hold again.

## Size

A pull request is **small** when it is a fix or a documentation or prompt change, touches at
most 5 files and 150 lines of code outside tests (`git diff --numstat <base>...HEAD`), and adds
no tool, command or contract; it owes only:

- one review pass (`/pr-review:auto-fix-loop`, `review_only`): Critical and Important findings
  block, the others are listed, never corrected;
- one correction round at most, then the session that ordered the review decides alone;
- a norms check only when a code file changed;
- the fix's regression test and each touched plugin's suite, no new E2E test.

Any other is **standard** and owes all this method states.

## Consent

The operator's consent is a structured act (a dialog answer, a recorded ruling), never read
from the words of a prompt. Pushing a branch and opening a draft pull request need none.
Outside auto-merge, leaving draft is the operator's alone, after their review; `Ready` is the
gate's.

## Reports

A unit of work ends with a report in the shape of `references/report.md`, its status:

- `done`: delivered; any concern is named under `deviations`.
- `blocked`: it cannot go on without what the line names.
- `question`: a decision only the operator can take.

## Questions to the operator

One question per message, in the shape of `references/questions.md`. Never ask what the spec,
the plan or the code already answers.

Read each format only when writing it.
