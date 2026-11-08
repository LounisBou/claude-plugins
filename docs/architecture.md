# Architecture

How the repository is built, and the rules that keep it from drifting. The conventions every
change follows are in `conventions.md`; the formats plugins share are in `contracts.md`; each
decision that shaped this file, with its reason, is under `decisions/`.

## The parts

```
.claude-plugin/marketplace.json   the catalogue: authored header, generated plugin list
packages/core/                    the shared library: paths, store, deadlines, names, plugin locator
plugins/<name>/                   one installable plugin per directory, named as its manifest
scripts/                          the repository's own tooling, strict TypeScript, tested
ci/plugins.json                   where each plugin's suite blocks the build
docs/                             architecture, conventions, contracts, decisions, specs
```

A plugin is the unit of installation, versioning and release. The repository is the unit of
change: a change that crosses plugins is one pull request.

## Layers and the direction of dependencies

```
            host (Claude Code: events, tools, sessions)
                              ▲
   packages/core   ◀──────────┤   knows no plugin
        ▲                     │
        │      plugins/method ◀── every plugin that takes part in the lifecycle
        │      plugins/github ◀── norms, pr-review, orchestrator, implement
        │      plugins/orchestrator ◀── bugs-bot, statusbar (through a contract)
        └───── every plugin    cloudflare stands alone
```

- `core` depends on the host's API and on nothing in `plugins/`.
- A plugin depends on `core`, and on another plugin only through that plugin's published
  contract (`contracts.md`) and a dependency declared, with a version range, in its manifest.
- The graph is acyclic. A plugin never imports another plugin's source and never reads another
  plugin's private state.

These rules are checked by the dependency lint (program goal 7), not by review.

## One method, many roles

The lifecycle, the definition of done and the artifact formats belong to the `method` plugin
(decision 0006). The others are roles in it and point at it: implement runs it alone, the
orchestrator runs it with implementer sessions in its `build` mode and leaves it out in its
`investigate` mode, norms and pr-review supply reviews to github's ready gate, bugs-bot turns
reports into its inputs, statusbar shows its state. cloudflare stands outside it.

## Packaging

The host installs a plugin by copying its directory into its cache: nothing outside
`plugins/<name>/` exists at run time. `core` therefore reaches each plugin as a link inside
the plugin's directory, which the host follows when it copies; whether the installed host
follows it is the first thing the program verifies (decision 0002), and the fallback is a copy
made at release by a script.

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
because the host caches by version. A release is the merge; the tag `<name>--v<version>` marks it.

## What CI holds

| Check | Source of truth |
|---|---|
| strict types | `tsconfig.base.json`, coverage ratcheted in `tsconfig.json` |
| tooling tests | `scripts/*.test.ts` |
| catalogue matches the manifests | `plugins/*/.claude-plugin/plugin.json` |
| shipped change raises the version | the same manifests, against the base branch |
| the coverage floor | `npm test` thresholds |
| prompt budgets and duplicates only fall | `ci/prompts.json` |
| every plugin's suite, macOS and Linux | `plugins/<name>/tests/run-tests.sh`, blocking per `ci/plugins.json` |
