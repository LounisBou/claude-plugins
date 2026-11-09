# Architecture

How the repository is built, and the rules that keep it from drifting. The conventions every
change follows are in `conventions.md`; the formats plugins share are in `contracts.md`; each
decision that shaped this file, with its reason, is under `decisions/`.

## The parts

```
.claude-plugin/marketplace.json   the catalogue: authored header, generated plugin list
packages/core/                    the shared library: paths, store, deadlines, session names, the shell
                                  reader, shared environment names, the plugin locator, and the typed
                                  contracts (the method's formats, PR records, consent records)
plugins/<name>/                   one installable plugin per directory, named as its manifest
scripts/                          the repository's own tooling, strict TypeScript, tested
evals/outcome/                    the outcome evals' cases and spend caps, read by scripts/outcome.ts
ci/plugins.json                   where each plugin's suite blocks the build
ci/prompts.json                   the prompt budgets and the duplicate ceiling
ci/scenarios.json                 what each kind of session loads, summed by `npm run context`
.github/workflows/ci.yml          the one workflow: the repository rules, then the plugin suites
docs/                             architecture, conventions, contracts, migration, decisions, specs
```

A plugin is the unit of installation, versioning and release. The repository is the unit of
change: a change that crosses plugins is one pull request.

## Layers and the direction of dependencies

```
            host (Claude Code: events, tools, sessions)
                              ▲
   packages/core   ◀──────────┤   knows no plugin
        ▲                     │
        │      plugins/method ◀── implement, orchestrator
        │      plugins/github ◀── norms, pr-review
        │      plugins/orchestrator ◀── bugs-bot
        └───── github, implement, norms, orchestrator, pr-review (a copy in core/)
```

- `core` depends on the host's API and on nothing in `plugins/`.
- A plugin depends on `core`, and on another plugin only through that plugin's published
  contract (`contracts.md`) and a dependency declared, with a version range, in its manifest.
- The edges above are the dependencies the manifests declare. Two readings are not declared
  yet and are listed in `contracts.md`: the orchestrator calls github's tool, and implement
  and bugs-bot run the orchestrator's launcher. statusbar and cloudflare depend on no plugin.
- The graph is acyclic. A plugin never imports another plugin's source and never reads another
  plugin's private state.

These rules are checked by `npm run deps`, not by review: a dependency on a plugin of this
repository is declared `{ "name", "marketplace": "lounisbou", "version": ">=a.b.c" }`, its range
holds for that plugin's current version, the graph has no cycle, and no TypeScript file
imports a path outside its plugin. A dependency from another catalogue may omit its range.

## One method, many roles

The lifecycle, the definition of done and the artifact formats belong to the `method` plugin
(decision 0006). The others are roles in it and point at it: implement runs it alone, the
orchestrator runs it with implementer sessions in its `build` mode and leaves it out in its
`investigate` mode, norms and pr-review supply reviews to github's ready gate, bugs-bot turns
reports into its inputs, statusbar shows a session's context against the orchestrator's gate.
cloudflare stands outside it.

## Packaging

The host installs a plugin by copying its directory into its cache: nothing outside
`plugins/<name>/` exists at run time. `core` therefore reaches each plugin as a generated copy
in its `core/` directory, written by `npm run core` and checked identical to the source by CI
(decision 0002). A plugin imports `../core/<module>.ts`; nobody edits the copy.

## State

Each plugin owns one state directory under the host's configuration directory and writes it
only through `core`'s store, which locks and writes atomically. A file another plugin or an
outside program reads (`deck.json`, the measure file) is a contract: typed in `core`,
versioned, written in one rename by its owner alone.

## Languages

TypeScript, strict, for every hook, module and tool. Python is kept where an engine already
lives in it (the github and cloudflare engines, bugs-bot) and for the orchestrator's iTerm2
adapter, the one API that exists only in Python. Bash is limited to entry points
(`install.sh`, `tests/run-tests.sh`) with no logic of their own. A rule is written in ONE
language; when another language needs it, it reads it as data, never as a re-implementation
(decision 0003).

## Release

A plugin's version lives in its `plugin.json` and nowhere else; the catalogue is generated
from it. A pull request that changes what a plugin ships raises its version, or CI refuses it,
because the host caches by version. A release is the merge: the
host installs the version the catalogue names, and no tag is made.

## What CI holds

| Check | Source of truth |
|---|---|
| strict types | `tsconfig.base.json`, coverage ratcheted in `tsconfig.json` |
| tests of the tooling, of core and of the plugins' strict scripts, with the coverage floor | `npm test` (`scripts/**/*.test.ts`, `packages/*/src/**/*.test.ts`, `plugins/*/skills/*/scripts/**/*.spec.ts`) |
| dependencies declared, acyclic, no import across plugins, shared variables named in core | `npm run deps` |
| no committed permission grant, every installer rule listed | `npm run permissions`, `contracts.md` |
| every copy of core matches the source | `npm run core -- --check`, `packages/core/src` |
| catalogue matches the manifests | `npm run marketplace -- --check`, `plugins/*/.claude-plugin/plugin.json` |
| shipped change raises the version (pull requests) | `npm run version-bump`, the same manifests against the base branch |
| prompt budgets and duplicates only fall | `npm run prompts`, `ci/prompts.json` |
| tokens by scenario, and the pull request's difference (a report in the run's summary) | `npm run context`, `ci/scenarios.json` |
| rules a prompt states that nothing holds (a report in the run's summary) | `npm run rules` |
| every plugin's suite | `plugins/<name>/tests/run-tests.sh`, blocking per `ci/plugins.json` (`npm run plugin-matrix`) |

A pull request runs the Linux suites of the plugins it changes: a change outside `plugins/`
runs every plugin, a change of documentation alone (`docs/`, a Markdown file at the root) none.
A push to `main` runs every plugin on Linux and macOS.
