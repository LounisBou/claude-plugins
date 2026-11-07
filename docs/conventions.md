# Conventions

Every change follows these. Each one exists because its absence produced a repeated defect
across the plugins; the defects are listed in `specs/program-design.md`. A convention is
changed by a pull request that edits this file and the code it governs together.

## One rule, one place

- A fact (a path, a name shape, a threshold, a price, a version) is defined once and read
  everywhere else. A second copy, with a test keeping the two equal, is not a solution: it is
  the defect, waiting.
- Shared code lives in `packages/core`. A helper needed by two plugins moves there; it is never
  copied.
- Between languages, a rule travels as data (a JSON file both sides read), never as two
  implementations.
- A document points at the rule; it does not restate it.

## Types and boundaries

- `strict` with the options of `tsconfig.base.json`. No `any`; `unknown` at every boundary.
- Every value read from outside (a file, an event payload, a command's output, an environment
  variable) goes through a validator that returns a typed value or an error. A cast is allowed
  only inside a validator.
- Every format shared between plugins is a type exported by `core`, with a `version` field.

## State and concurrency

- Writes go through `core`'s store: a lock, a unique temporary name, one rename. No
  read-modify-write without the lock.
- Work given a deadline is cancelled at the deadline (an `AbortSignal`), never abandoned to
  finish and write later.
- Time is injected (`now`), never read from the wall clock inside logic, so no test depends on
  the date it runs.

## Guards and consent

- A guard that protects (an irreversible action, a security boundary) fails closed: when it
  cannot decide, it refuses and says why. A hook that only observes fails open and logs.
- The operator's consent is a structured act: a tool call, a choice in a prompt, a recorded
  answer. It is never inferred from words in a prompt: « don't push » contains « push ».
- A gate decides on structured facts (a tool call such as `declare_wait`, a record), never on
  the wording of a model's last line.
- Separation holds by construction: a review or norms record is written by a session other
  than the one that wrote the code, bound to the head it read, computed from the tool's output
  rather than from figures the model reports.

## Permissions and security

- No committed settings file grants a permission.
- An installer writes a permission rule only when the rule names the plugin's own script and
  that script validates every argument it receives (an allowlist for modes, paths under a
  known root). Each such rule is listed in `contracts.md`. Fluidity is kept by narrow rules,
  never by wide ones.
- A file of the operator's (`~/.claude.json`, `settings.json`) is changed under a lock, with
  a backup, in one rename, and only for the keys the plugin owns.
- Secrets never reach a command line, a log or a model.
- No `shell=True`, no `eval`, no command built from configuration text.

## Tests

- A test checks behaviour: what a function returns, what a command does, what a hook decides.
  A test never asserts the wording of a skill or a document.
- A fix lands with the test that fails when the fix is reverted.
- Every suite runs on macOS and Linux, as a normal user and as root, under any locale.
- One entry point per plugin: `tests/run-tests.sh`, selectable by case where the runner allows.

## Prompts (skills, commands, agents, briefs)

- A rule is stated once, in imperative form, with no history: no dates, no quotation of a past
  ruling, no account of the incident behind it. The reason, when needed, goes in a decision
  record or the commit, where it costs nothing at run time.
- Each plugin has a budget of tokens loaded per session, measured by CI; text is added only
  by removing as much.
- A rule enters a prompt only when an eval shows it changes an outcome, and it replaces one.

## Changes and releases

- Conventional commits, the scope being the plugin (`fix(github): …`) or the repository part
  (`ci`, `core`, `docs`).
- One plugin per pull request, except a contract change, which moves its owner and every
  consumer in the same one.
- A shipped change raises the plugin's version (SemVer: a contract change that breaks a
  consumer is MAJOR).

## Ratchets

Some coverage grows one step at a time: the TypeScript under the strict check
(`tsconfig.json`), the platforms where a suite blocks (`ci/plugins.json`), the prompt budgets.
A ratchet only tightens. A pull request that loosens one is refused unless it says why in its
description and the operator accepts it.
