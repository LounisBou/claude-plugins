# Pull requests and issues

`pr-create` and `pr-update` refuse a title or a description that breaks a mechanical rule of
this file (its sections, headings, horizontal rules, bold labels and semicolons, the references
and phrasings of its summary, its TODO items), naming the rule: what follows is what they cannot check.

## Pull request titles

The same convention as the commits: `<type>[(<scope>)]: <description>`, stating what the
change does, with no workflow vocabulary — the same words forbidden in commit messages.
Short: the subject of the change in a few words after the conventional prefix, no clause on
how or why — that belongs in the description.

## Pull request descriptions

In a repository of the `geonativefr` GitHub organisation follow this exact template. In any
other repository the description is the summary text alone, then what a pull request may carry
(screenshots): the four sections below are GeoNative's own.

```
<summary: what it is about, what it does, in 3-5 lines>

<what it does — only if needed>

<explanation of the complex part — only if needed>

<explanation of a non-obvious decision — only if needed>

**TODO Staging:**
- [ ] <deploy step for staging>
- [ ] <next step>

**TODO Prod:**
- [ ] <deploy step for prod>
- [ ] <next step>

**PRs Dependency:**
- <url of a PR that must ship with or before this one>
- <url of the next one>

**Related PRs:**
- <url of a PR truly linked to this work>
- <url of the next one>
```

A section with nothing in it is `none` on its label's line. State what the PR does, never what
it does not do — no list of omissions, no rejected alternatives, no things left untouched. Phrase
a prerequisite positively ("X must have Y set", not "it will fail without Y"). A TODO item writes
the action in full, the file, the value before and after, and the host or environment, one action
per checkbox. A TODO is only an action a person does by hand: a step the deploy runs on its own
(database migrations, cache clear, build) is never a TODO. A PRs Dependency or Related PRs item is
a `- ` bullet with the pull request's full URL, which GitHub's preview renders as a card. Staging
and prod TODOs are always kept apart, both listing the items they share. `**PRs Dependency:**`
lists the PRs that ship before this one or at the same time: that is the delivery prerequisite,
their deploy steps included. No TODO repeats it (« Deploy/Merge <PR> before this PR », their
migrations, restarts or config): with no deploy action of its own, a PR has both TODOs at
`none`, even with dependencies. A TODO never names a PRs Dependency item nor its deploy: that
section carries the order. `**Related PRs:**` lists the PRs truly linked to this work: part of the same
batch, the origin of the bug, or a link of that strength. A follow-up PR, one that must come
after this one, is never listed
in Related PRs. Two PRs never depend on each other. English always. No workflow vocabulary.
Every PR is opened as a draft and leaves
draft only for its CI to run or to be merged. Outside auto-merge, a merge needs the operator's explicit word, given through this tool.
A deployment needs its repository listed for its environment (`auto-deploy-set`).
Reviewers are requested only when the operator asks, and never on a draft.
The description of the operator's own draft PR is published and edited without asking.
A colleague's PR and any review comment are proposed first.

A paragraph stating the ship order is added to a description without asking, and only for
the sections that list a pull request: « Ships with or after the PRs in PRs Dependency »
when PRs Dependency lists one, « Ships in any order with the Related PRs » when Related PRs
lists one, both sentences when both do, and no paragraph when both are `none`. Add,
re-read, report in one line. The paragraph names no pull request: the pull requests the
sections list go in `PRs Dependency` or `Related PRs` as their full URL, taken from that
pull request's own files and body, never by eye. A TODO goes only on the PR that
enables its step: it runs when that PR ships.

A pull request that changes an interface carries screenshots of what it changes,
desktop AND mobile on a project with a mobile version, above the four sections, as the
block `image-upload --title` writes. Each title names the screen, the state shown, the
screen size, and before or after when there is a pair (`Devices list, desktop 1440 px, after`).
When
a visual is fixed after the merge, retake the screenshots and replace them on GitHub
and Notion.

A pull request carries no change its purpose does not need: no reformatting, no
renaming, no unrelated file. A refactor needed for the change to be clean and
architecturally sound is part of it: it is done in a commit of its own and named in
the description. A refactor unrelated to the purpose goes in its own pull request.

## Ready pull requests

What Ready needs and what voids it are core's readiness contract (`core/readiness.ts`).
A required E2E or norms check goes laxer only by the operator's waiver, his words quoted with their
date in `mcp__github__record`'s `detail` (`waived`). Words waiving it for an orchestration or a
repository hold for each of its pull requests. An E2E waiver that names a repository or « all PRs »
with an end is recorded once, `mcp__github__record {repo, exempt: true, until, detail}`, never per pull
request. With none, ask once:
« Dispense d'E2E|de normes pour <owner/name>#<n> : <why> », « Accorder » / « Refuser ».
The gate alone puts `Ready` and `Not Ready` (REFERENCE.md « Guards »).
