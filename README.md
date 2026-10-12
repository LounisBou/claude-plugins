# claude-norms

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

## Hooks module

Where the host loads plugin modules, `hooks/register.ts` takes over the
mechanical work the markdown would otherwise hand the model:

- `/norms:check`: the base commit (through `scripts/resolve_base.sh`), the
  changed files and their classes, the project type, the CONTRIBUTING.md status,
  the applicable agents and the validated reference paths arrive as a
  `<norms-scope>` block after the arguments.
- Each `norms-*` agent receives, when it starts, the diff of its own files and
  the CONTRIBUTING.md sections it applies, as a `<norms-context>` block.
- `/norms:learn`: with no PR number the usage answers at once; otherwise each
  PR's resolved threads come from the `github` plugin's tool, with the rules
  CONTRIBUTING.md already holds, as a `<norms-learn>` block.
- The walkthrough rules hold: no code edit on the report turn or after a
  "pass" or "discuss" answer, no CONTRIBUTING.md edit before "add" or after
  "skip", no `git push` unless the user's last words ask for one, and under
  `/norms:check` no commit message naming the check or its tooling. Any other
  words the user types, an interrupted turn and any other command release them.
- `validate`: the lexical checks (empty entries, vague words, no code block,
  mixed list markers, no top-level header) arrive with exact line numbers.

Every hook that fails passes the event on unchanged, and the markdown keeps
its own instructions for each step, so a host without modules runs as before.

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

The plugin's manifest (`.claude-plugin/plugin.json`) declares `"dependencies":
["github@lounisbou"]`. Only `/norms:learn` uses it, to fetch a PR's resolved
review threads; `/norms:check`, `find-pattern`, and `validate` work offline
and never touch it.

## Installation

```
/plugin marketplace add LounisBou/claude-norms
/plugin install norms@claude-norms
```

Once the aggregate `lounisbou` marketplace lists this plugin, `norms@lounisbou`
becomes the canonical install key instead.

## Tests

```
CLAUDE_GITHUB_ROOT=<path to a github plugin checkout> bash tests/run-tests.sh
claude plugin test .
claude plugin validate .
```

`claude plugin test .` runs the hooks module's tests in `hooks/tests/`.

The suite runs offline and needs no GitHub account or installed plugin; it
resolves the `github` plugin from `CLAUDE_GITHUB_ROOT` (or the platform's own
install record) purely to check that `/norms:learn` calls only subcommands and
formats that tool actually exposes. If the `github` plugin can't be resolved,
the suite fails loudly with an `error:`/`fix:` pair rather than skipping the
check. Sample run:

```
45 passed, 0 failed
```

## Licence

MIT.
