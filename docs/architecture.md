# Architecture

How the repository is built, and the rules that keep it from drifting. The conventions every
change follows are in `conventions.md`; the formats plugins share are in `contracts.md`; each
decision that shaped this file, with its reason, is under `decisions/`.

## The parts

```
.claude-plugin/marketplace.json   the catalogue: authored header, generated plugin list
packages/core/                    the shared library: paths, store, deadlines, session names, the shell
                                  reader, shared environment names, the plugin locator, the pinned
                                  Playwright's install, and the typed contracts (the method's
                                  formats, PR records, consent records, readiness, the orchestration's
                                  measure file, gate, launcher line and ListAgents reading)
plugins/<name>/                   one installable plugin per directory, named as its manifest
scripts/                          the repository's own tooling, strict TypeScript, tested
evals/outcome/                    the outcome evals' cases and spend caps, read by scripts/outcome.ts
ci/plugins.json                   where each plugin's suite blocks the build
ci/prompts.json                   the prompt budgets and the duplicate ceiling
ci/scenarios.json                 what each kind of session loads, summed by `npm run context`
.github/workflows/ci.yml          the one workflow: the repository rules, the plugin suites, then `ci`,
                                  the one check GitHub requires (core's readiness contract)
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
        │      plugins/github ◀── norms, pr-review, orchestrator
        │      plugins/orchestrator ◀── bugs-bot
        └───── bugs-bot, drift, github, implement, learning, norms, orchestrator, pr-review,
               statusbar, telemetry (a copy in core/)
```

- `core` depends on the host's API and on nothing in `plugins/`.
- A plugin depends on `core`, and on another plugin only through that plugin's published
  contract (`contracts.md`) and a dependency declared, with a version range, in its manifest.
- The edges above are the dependencies the manifests declare. One reading is not declared
  yet and is listed in `contracts.md`: implement and bugs-bot run the orchestrator's
  launcher. statusbar, cloudflare, telemetry and learning depend on no plugin (learning reads the journals the others write through the contract in `contracts.md`).
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
cloudflare stands outside it; telemetry observes every role and changes none; learning reads what the roles journal and changes none.

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

## Tools installed once per machine

A heavy tool several plugins may drive (a browser and its test runner) is never a dependency of
the repository's `package.json` nor of a plugin: the host copies a plugin into its cache, where
an install would be repeated per plugin and per version, and lost on each update. `core` pins its
version in one constant and installs it once per machine under the host's configuration
directory, in a directory named by the pin, outside every plugin's cache; a plugin locates it
through `core` and names its own install command when it is missing.

- Playwright: `packages/core/src/playwright.ts`, `PLAYWRIGHT_VERSION`; `@playwright/test` and its
  Chromium headless shell in `<config dir>/playwright/<version>/` (the browser under `browsers/`,
  through `PLAYWRIGHT_BROWSERS_PATH`); a marker written last tells a complete install from a
  half-done one, which is removed and redone. Installed by `/drift:install`.

The pin is raised in that constant, with the integrity the registry publishes for each package it
installs (`PLAYWRIGHT_PACKAGES`, read with `npm view <name>@<version> dist.integrity`): the install
writes them into a lockfile and runs `npm ci`, which refuses a tarball of another hash. Then
`npm run core`: every plugin carrying core ships the change, and the next release pull request
raises its version. Once released, the next install lands beside the old one, and the CI cache
keyed on the module installs the new one. An old version's directory is removed by hand.

## Languages

TypeScript, strict, for every hook, module and tool. Python is kept where an engine already
lives in it (the github and cloudflare engines, bugs-bot) and for the orchestrator's iTerm2
adapter, the one API that exists only in Python. Bash is limited to entry points
(`install.sh`, `tests/run-tests.sh`) with no logic of their own. A rule is written in ONE
language; when another language needs it, it reads it as data, never as a re-implementation
(decision 0003).

## Release

A plugin's version lives in its `plugin.json`; the catalogue is generated from it. A pull request
raises no version. The release pull request (`npm run release`) raises the version of every plugin
changed since its last release, because the host caches by version; a plugin already raised by that
pull request keeps its version on a re-run, and one that carries its own `marketplace.json` (the
orchestrator) has it raised with its manifest.
A release runs at the end of each merge wave, and at least daily.
A release is its merge: the host installs the version the catalogue names, and no tag is made.
Once the release is installed on a machine, every session on it is restarted: a running session
keeps the plugin version it loaded and runs it until it ends.
The release pull request also asks the operator whether to re-run the outcome measure (cap
`measure` of `evals/outcome/caps.json`) when its monthly run falls due or a learned method change
awaits its proof, not at each minor version (`docs/specs/learning-design.md`, question 4); nothing
runs without their yes.

## What CI holds

| Check | Source of truth |
|---|---|
| strict types | `tsconfig.base.json`, coverage ratcheted in `tsconfig.json` |
| tests of the tooling, of core and of the plugins' strict scripts, with the coverage floor | `npm test` (`scripts/**/*.test.ts`, `packages/*/src/**/*.test.ts`, `plugins/*/skills/*/scripts/**/*.spec.ts`) |
| dependencies declared, acyclic, no import across plugins, shared variables named in core | `npm run deps` |
| no committed permission grant, every installer rule listed | `npm run permissions`, `contracts.md` |
| every copy of core matches the source | `npm run core -- --check`, `packages/core/src` |
| catalogue matches the manifests | `npm run marketplace -- --check`, `plugins/*/.claude-plugin/plugin.json` |
| every changed plugin's version raised (the release pull request, not run by CI) | `npm run version-bump -- <last-release-ref>`, the same manifests against the last release |
| prompt budgets and duplicates within their ceilings (a pull request may lower a ceiling after a cut; no ceiling rises outside the release, a rise CI does not refuse) | `npm run prompts`, `ci/prompts.json` |
| tokens by scenario, and the pull request's difference (a report in the run's summary) | `npm run context`, `ci/scenarios.json` |
| rules a prompt states that nothing holds (a report in the run's summary) | `npm run rules` |
| the release raises every changed plugin and lowers the prompt budgets in one commit | `npm run release`, `scripts/release.ts` |
| every plugin's suite | `plugins/<name>/tests/run-tests.sh`, blocking per `ci/plugins.json` (`npm run plugin-matrix`) |
| the repository rules and every blocking cell passed, as one check the default branch requires (`/github:protect apply ci`, once that job runs on `main`) | the `ci` job, named by `packages/core/src/readiness.ts` |

What runs when (a pull request, the release, a push to `main`, the night) is the table at the head of
`scripts/plugin-matrix.ts`.

A push to `main` skips what its tree already passed. The merge of a pull request is usually the very
tree its `pull_request` run tested; `scripts/tested-tree.ts` finds that run (green, on the pull
request's head), reads the merge commit its checkout fetched, and when that commit's tree equals the
pushed tree, `main` leaves out the repository rules and the Linux cells that run passed. It runs
everything else: a tree that differs (`main` moved and the merge is another tree), a run that failed
or is gone, a cell the pull request did not run, and any lookup that fails. The `ci` check still
reports on `main`: a skipped step is a passed job, and a matrix with no cell left runs the cell
without a suite. It makes the push to `main` a net for what no pull request tested, not a second run
of what one did.
