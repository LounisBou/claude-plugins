# implement

The feature lifecycle in a repository — brainstorm, branch, plan, phases, close —
with nothing in it that belongs to one project.

## Requires one plugin

`superpowers@claude-plugins-official`. Installed is not the same as enabled: a
plugin can sit on disk and be inert, so the preflight reads the `enabledPlugins`
map rather than looking for files. If it is missing or disabled, every skill
stops before doing anything and prints the command that fixes it.

## Install

```
/plugin marketplace add LounisBou/claude-implement
/plugin install implement@claude-implement
/implement:install
```

`/implement:install` writes nothing and checks only the dependency, so it runs
from any directory. Run `/implement:doctor` any time to repeat the check. The
git repository is checked by each of the five commands below when it starts:
outside one, it stops with an `error:`/`fix:` pair.

One thing the target repository has to provide: in the default mode,
`docs/features` and `ROADMAP.md` must be ignored there, see `.implement.json`
below.

## The five commands

- **`/implement:feature`** — start a feature: brainstorm, confirm the codename,
  title, branch type and bump type once, create the branch, write the plan.
- **`/implement:phase`** — run the plan's phases, gated and checked, one sub-phase
  at a time, without pausing unless a phase number is given.
- **`/implement:check`** — verify a delivery against the plan and the design, on
  any commit range.
- **`/implement:close`** — the full project gate, the version bump, the final
  summary; push, pull request and review are yours.
- **`/implement:prepare`** — plan a future feature onto `ROADMAP.md` without
  touching a branch, so it coexists with a feature in progress on another one.

## The hooks module

`hooks/` holds a module the host loads beside the skills. Where it loads, it
does five things; where it does not, every skill and command runs from its
markdown exactly as before, and each of its hooks falls back to that path when
it fails.

- **The commands answer at once.** `/implement:install` and `/implement:doctor`
  are answered by the module, without a model turn, from the merged settings of
  every scope.
- **The preflight runs before the skill.** The module checks the dependency and
  the repository as the skill's text is loaded: a failure replaces the text with
  the `error:`/`fix:` lines, a pass leads it with a `Preflight: passed` line and
  the state derived from the branch, and the skill skips its own preflight call.
- **One state tool.** `mcp__implement__state` answers `get` (branch, codename,
  artifacts path and mode, ignore-guard verdict, head, clean tree, the parsed
  `IMPLEMENTATION.md` and its next phase) and `mark` (one row, its sha resolved
  from `HEAD`). The skills use it in place of their derivation blocks when it is
  listed.
- **The Iron Rules are held at the call.** While `implement:phase` or
  `implement:close` is armed, a `git push`, a `git merge`, `gh pr create`,
  `gh pr merge` and the github tool's `pr-create` and `pr-merge` are refused;
  while `implement:phase` is armed, so is a subagent other than `Explore`; while
  `implement:check` runs, an edit, a `git add` and a `git commit` are refused
  until its verdict line is written. No commit trailer is asked for while
  `feature`, `phase` or `close` is armed.
- **A band above the prompt** shows the phase run: phase N of M, its status, the
  sha it started from, and the head.

A guard stays armed across turns, so a phase stopped on a question resumes
under the same rules. It is released by another implement skill starting, the
user naming the action in a prompt (`push`, `merge`, `pull request`, `PR`,
`agent`), an interrupted turn, the conversation ending or being cleared, and
`/implement:release-guard`. A shell line is read word by word: a guarded command
named inside quotes, a comment or a here-document is not a call.

## The artifact layout

```
docs/features/<codename>/
  DESIGN.md              the design implement:feature writes from the brainstorm's content (superpowers:brainstorming, architectural path)
  plan/INDEX.md          the phase list (superpowers:writing-plans)
  plan/phase-NN-<slug>.md  one file per phase: sub-phases, files, tests, definition of done
  IMPLEMENTATION.md      the state, and the only source of truth for progress
ROADMAP.md               at the repository root: one line per prepared feature
.implement.json          at the repository root, optional: {"artifacts": "local" | "committed"}
```

`/implement:feature` writes all of it; `/implement:phase`, `/implement:check` and
`/implement:close` read it. `IMPLEMENTATION.md` carries six header lines — codename,
title, branch, bump type, artifacts mode, and the commit the branch was cut from —
then one row per phase:

```
| phase | title | status | milestone |
|---|---|---|---|
| 01 | the first phase | done | 82525e4 |
| 02 | the second one | doing | 9f31a0c |
```

Status is `todo`, `doing` or `done`. While a row is `doing` the milestone column
holds the sha the current sub-phase started from, rewritten before each one; once
the row is `done` it holds the phase's last commit; a `todo` row leaves it empty.
`/implement:phase` resumes at the first row that is not done and refuses to run
without this file; `/implement:close` refuses while a row is not done.
`/implement:prepare` appends `- <codename> — <title> (<bump>)` to `ROADMAP.md` and
writes no state file, which is what makes a prepared feature recognisable.

Each of the three reading commands takes `--docs <path>` naming the feature
directory, for the case where the default — `docs/features/<codename>`, the
codename read from the branch name — is not what should be read: a worktree does
not see an ignored directory of the main checkout.

## .implement.json

Optional, at the repository root, one key:

```json
{"artifacts": "local"}
```

**Local, the default** — also what an absent file means. Both `docs/features` and
`ROADMAP.md` must be ignored, which `/implement:feature`, `/implement:prepare`,
`/implement:phase` and `/implement:close` verify with `git check-ignore -q` on each
path separately, refusing to run without and naming the fix. Neither is ever
staged; the artifacts are working notes, and a closed feature's own directory is
deleted by `/implement:close`, along with its line in `ROADMAP.md`.

**Committed** — `{"artifacts": "committed"}`. The test inverts on both paths, and is
never simply skipped: neither `docs/features` nor `ROADMAP.md` may be ignored. The
design, the plan, the state and the roadmap travel with the code — in the commit
that opens the feature, in one commit per finished phase, and in the closing
commit — and nothing is deleted at close.

`/implement:phase` and `/implement:close` take `--docs <path>`, and an explicit path
skips this test altogether: whoever names a directory outside the repository's
excludes has taken the responsibility for it.

## CLAUDE.md

This repository keeps a local `CLAUDE.md` with the conventions for working on
the plugin itself. It is gitignored and will not be tracked.

## Licence

MIT.
