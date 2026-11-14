# norms

Evidence-based code norms tooling for [Claude Code](https://claude.com/claude-code), packaged as the `norms` plugin.

## What it does

Eight review agents check a diff against a project's own established conventions —
never against generic style opinions. Every finding must cite evidence: either an
explicit rule in the project's `CONTRIBUTING.md`, or a pattern demonstrably repeated
in the existing codebase. No evidence, no finding.

- `norms-pattern-conformity` — structural patterns, function shapes, DI style, error handling
- `norms-variable-naming` — naming conventions
- `norms-test-structure` — test file structure conventions
- `norms-diff-scope` — flags unrelated changes, reformatting, out-of-scope hunks
- `norms-import-organization` — unused/duplicate imports, grouping/ordering
- `norms-magic-values` — hardcoded values that should be extracted
- `norms-documentation` — missing documentation where the project's own conventions require it
- `norms-test-coverage` — coverage gaps relative to the project's existing baseline

## Commands and skills

- `/norms:check` — runs the eight agents above in parallel against the current diff
- `/norms:learn` — after a PR is merged or reviewed, reads its resolved review
  threads and turns the generalizable ones into rules in the project's own
  `CONTRIBUTING.md`
- `find-pattern` skill — pre-implementation pattern discovery for a given file type
- `validate` skill — validates `CONTRIBUTING.md` structure before `/norms:check` relies on it

## Automatic mode

`/norms:check` runs without asking anything, so that an unattended session
(nobody typing in its tab) still ends with its record.
It is automatic when:

- the arguments say `mode=auto` (beside `base=<branch>`), or
- the environment variable `ORCHESTRATOR_SPAWNED` is set and not empty (the
  orchestrator's launcher sets it; core's `env.ts` names it, read through `isSpawned`).

The analysis is the same. No question is asked and no code is edited; the
findings come in one table (severity, agent, `file:line`, issue, proposed fix).
The record counts the ERROR findings as open and passes the WARNING and INFO
ones as non-blocking: its detail reads like
`0 fixed, 3 passed (non-blocking, automatic), 0 open`, so a reader can tell an
automatic pass from an operator's. The result is `pass` when nothing is open,
`fail` otherwise. A finding set aside as not critical, with its reason (`setAside`
and `reason` of the tool), is not open: the detail keeps the reason. Typing the command in your own session stays interactive.

## Hooks module

Where the host loads plugin modules, `hooks/register.ts` takes over the
mechanical work the markdown would otherwise hand the model:

- `/norms:check`: the base commit (the pull request's base read through the
  `github` plugin's `pr-get`, then `scripts/resolve_base.sh`), the changed files and their classes, the project type, the CONTRIBUTING.md status,
  the applicable agents and the validated reference paths arrive as a
  `<norms-scope>` block after the arguments.
- Each `norms-*` agent receives, when it starts, the diff of its own files and
  the CONTRIBUTING.md sections it applies, as a `<norms-context>` block.
- `/norms:learn`: with no PR number the usage answers at once; otherwise each
  PR's resolved threads come from the `github` plugin's tool, with the rules
  CONTRIBUTING.md already holds, as a `<norms-learn>` block.
- The walkthrough rules hold: no code edit on the report turn or after a
  "pass" or "discuss" answer, no CONTRIBUTING.md edit before "add" or after
  "skip", and under `/norms:check` no commit message naming the check or its
  tooling. A `git push` during a walkthrough asks the user through the host's
  dialog: only their Allow lets it through, and nobody there to answer refuses it;
  words in a prompt grant nothing. A subagent's shell line during a walkthrough
  must only read (no command that writes, no redirection but to `/dev/null`).
- The walkthrough is armed by the typed command or by the main loop's Skill tool
  call that runs it; a Skill-armed check ends at its `check_done` once its record
  is written. A spawned session (`ORCHESTRATOR_SPAWNED`) has nobody to walk
  through, so its Skill call arms nothing. Any other words the user types, an
  interrupted turn, `/clear` and any other command release the guards.
- `/norms:check` leaves a norms record at its end, through the `check_done` tool
  and the `github` plugin's record tool (0.12.0 or later), for the `github`
  plugin's ready guard: `pass` when no finding is left open, `fail` otherwise,
  at the head commit the check ended on. The findings are the ones the check's
  agents reported, each ending its answer with a JSON block the module reads:
  the call is refused when no agent reported, when one gave no readable block,
  or when its figures do not account for every finding once. Commits made after the check may only
  touch the files it read. It leaves none, and says why on a `record:` line of
  the report, when `/norms:check` did not compute its scope in the session, the
  branch has no pull request, tracked files have changes, a later commit touches
  a file the check did not read, or the `github` plugin is absent, older, or
  refuses the record. Whether a pull request owes the check is its plan's to say (the
  `github` plugin's `hooks/check-plan.ts`), not this plugin's.
- `validate`: the lexical checks (empty entries, vague words, no code block,
  mixed list markers, no top-level header) arrive with exact line numbers.

Every hook that fails passes the event on unchanged, and the markdown keeps
its own instructions for each step, so a host without modules runs as before.
The push guard is the exception: when nobody can be asked, the push is refused.

## CONTRIBUTING.md stays with the project

`CONTRIBUTING.md` lives at the root of whatever project you run these commands
in, not inside this plugin — the plugin never bundles or ships one. A copy
committed here would ship one project's conventions to every other project
that installs it.

Rules are grouped under `## [section]` headings. Four sections have a fixed
reader: `[type-strictness]`, `[test-conventions]`, `[naming]` and
`[code-hygiene]`. Any other section is read by the pattern-conformity agent,
and its first prose line is its scope: a sentence naming a path (for example
"Rules specific to migrations under `migrations/`") restricts the section to
files under that path, and a section with no such sentence applies to every
source file.

## GitHub dependency

The plugin's manifest (`.claude-plugin/plugin.json`) declares the `github`
plugin of the `lounisbou` catalogue, with a version range. `/norms:learn` uses
it to fetch a PR's resolved review threads; `/norms:check` uses it to read the
pull request's base and to write its record. `find-pattern` and `validate` work
offline and never touch it.

## Installation

```
/plugin marketplace add LounisBou/claude-plugins
/plugin install norms@lounisbou
```

## Tests

```
CLAUDE_GITHUB_ROOT=<path to a github plugin checkout> bash tests/run-tests.sh
```

The suite also runs the hooks module's tests in `hooks/tests/` in the host's
kit (`claude plugin test`).

The suite runs offline and needs no GitHub account or installed plugin; it
reads the `github` plugin from `CLAUDE_GITHUB_ROOT` (the sibling directory
`../github` of the repository when unset) purely to check that `/norms:learn`
calls only subcommands and formats that tool actually exposes. If the `github`
plugin is not there, the suite fails loudly rather than skipping the check.
The `github` plugin owns locating itself: this plugin carries no locator.

## Licence

MIT.
