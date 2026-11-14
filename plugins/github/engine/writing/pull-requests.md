# Pull requests and issues

## Pull request titles

The same convention as the commits: `<type>[(<scope>)]: <description>`.
One line, stating what the change does, with no semicolon. No workflow vocabulary —
the same words forbidden in commit messages.

Short and concise: about sixty characters at most, the subject of the change in a
few words after the conventional prefix, with no clause explaining how or why — that
belongs in the description.

Too long: `test(device-server): stop the listen tests on their awaited event instead of a fixed timer`
Right: `test(device-server): fix flaky listen tests`

## Pull request descriptions

Follow this exact template:

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

The four sections are mandatory in every description, so an empty one reads as checked,
never as forgotten. A section with nothing in it is written `none`, lowercase
in one word, on its label's line.
With nothing to do at deployment and no linked PR, a description ends with:

```
**TODO Staging:** none
**TODO Prod:** none
**PRs Dependency:** none
**Related PRs:** none
```

No heading of any kind: the description starts directly with the summary text, never
with `## Summary` or any other title. State what the PR does, never what it does not
do — no list of omissions, no rejected alternatives, no things left untouched. Phrase
a prerequisite positively ("X must have Y set", not "it will fail without Y"). The
plugin refuses, through its tool and through the shell alike, in the summary, the phrasings that say what the PR does not do,
and names them in its refusal. The summary names no pull request: no
`#N`, no `repo#N`, no `owner/repo#N`, no pull request URL above the sections, as links
go in `PRs Dependency` or `Related PRs`, a closing keyword such as `Fixes #12` excepted. No horizontal rule (`---`, `***`, `___`)
other than the `---` between two screenshots, and no bold label line (`**Label:**`)
other than the four sections, anywhere in the description.
The four sections come after the summary text, in that order, each in that exact shape
whatever the number of items: the bold label alone on its line, then one item per line,
nothing else on the line. A TODO Staging or TODO Prod item is a task-list checkbox,
`- [ ] <step>`, never a bare `- ` bullet: the operator ticks it as the step is done. A TODO
item stands alone:
it never points to another item ("do the same edit", "same as above", "likewise") and writes
the action in full, the file, the value before and after, and the host or environment. One
checkbox, one action: an edit and the restart, reload, deploy or migration that applies it are
two checkboxes, never joined by "then" or "and run". A PRs Dependency or Related PRs
item is a `- ` bullet — the line break and the dash are what keep
GitHub's preview rendering every link as a pull request card. Never a heading, never a
link inline after the label: `none` is the one thing ever written beside a label, and
never beside items. A label with nothing after it and no item below is an empty section
left unsaid: write `none`. Staging and prod TODOs are always kept apart, even when
they are the same items: then both sections list them. `**PRs Dependency:**` lists the PRs
that ship before this one or at the same time: that is the delivery prerequisite, their
deploy steps included. No TODO repeats it (« Deploy/Merge <PR> before this PR », their
migrations, restarts or config): with no deploy action of its own, a PR has both TODOs at
`none`, even with dependencies. A TODO states only a constraint the list cannot express: the
dependency ships strictly before, or a step waits for an asynchronous operation of the
dependency. `**Related PRs:**` lists the PRs truly linked to this work: part of the same
batch, the origin of the bug, or a link of that strength. A follow-up PR, one that must come
after this one, is never listed
in Related PRs. Two PRs never depend on each other. English always, with no
semicolon. No workflow vocabulary. Every PR is opened as a draft (`pr-create
--draft`, the house default), and leaves draft only once it is ready (see « Ready
pull requests »). Outside
auto-merge, leaving draft (a CI undraft aside) is the operator's, on GitHub after their
review, and a merge needs their explicit word, given through this tool. In a
repository in auto-merge, the merge, leaving draft and the deployment its method
foresees need no approval of the operator once the pull request is ready. A repository
enters or leaves auto-merge only through `auto-merge-set`, on the operator's words quoted
verbatim.
Reviewers are requested only when the operator asks, and never on a draft.
The description of the operator's own draft PR is published and edited without asking.
A colleague's PR and any review comment are proposed first.

A paragraph stating the ship order is always added to a description, without asking:
add, re-read, report in one line. It names no pull request, it points to the sections
(« Ships with or after the PRs in PRs Dependency », « Ships in any order with the Related
PRs »), and every pull request goes in `PRs Dependency` or `Related PRs` as its full
URL. Every URL written in those sections comes from that pull request's own files and
body, never by eye. A TODO goes only on the PR that enables its
step: it runs when that PR ships.

A pull request that changes an interface carries screenshots of what it changes,
desktop AND mobile on a project with a mobile version. They sit above the four
sections. Each screenshot is its descriptive title in bold, alone on its line: the
screen, the state shown, the screen size, and before or after when there is a pair
(`**Devices list, desktop 1440 px, after**`), with no colon at its end, which would
read as a section label. Its image, `![…](…)` or an `<img>` tag, is on the next line.
Two screenshots in a row are separated by a `---` line with a blank line before it, so
the line above never turns into a heading: the block `image-upload --title` writes.
Every image is audited before the PR is Ready, and a PR without both is not ready. When
a visual is fixed after the merge, retake the screenshots and replace them on GitHub
and Notion.

A pull request carries no change its purpose does not need: no reformatting, no
renaming, no unrelated file. A refactor needed for the change to be clean and
architecturally sound is part of it: it is done in a commit of its own and named in
the description. A refactor unrelated to the purpose goes in its own pull request.

## Ready pull requests

A pull request is ready when a review came out clean at its head, CI is green, and the E2E
passed or was waived unless its check plan needs none. Norms block when failed, or missing
where planned. A plan requires only what it marks `required` (norms `none` with no
CONTRIBUTING.md), and a required E2E or norms never goes laxer but by the operator's waiver:
« Accorder » to « Dispense d'E2E|de normes pour <owner/name>#<n> : <why> » / « Refuser ».
A new commit voids readiness, a rebase keeping its commits keeps its records.

The `Ready` and `Not Ready` labels carry that fact, and a draft opens `Not Ready`. The plugin
puts `Ready` once they hold, `Not Ready` back on a push. When CI does not run on a draft,
the plugin takes it out of draft, still `Not Ready`, and back once CI is green. Only the gate
puts `Ready`, and it refuses an unready exit from draft or merge.
