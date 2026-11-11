# drift

Proves that a change meant to change nothing changed nothing: the same build output byte for byte
(`drift build`), the same pages pixel for pixel (`drift shots`). An agent or a reviewer runs it on
a refactor, a rename or a move, and quotes its verdict as evidence; it is an optional proof, never a
required gate.

## drift build

```
skills/drift/scripts/drift.sh build [--repo <path>] [--base <ref>] [--head <ref>] [--config <path>] [--out <dir>]
```

Builds the two refs (default `origin/main` and `HEAD`) with the project's own commands, each in a
temporary `git worktree` outside the target checkout, and compares the outputs:

- content hashes stripped from file names (Vite's and Rollup's `name-[hash].ext` by default),
  files paired by the stripped name, so a file renamed only in what the pattern strips
  (`data-20240101.json` to `data-20240202.json`) is read as the same file; files of one side
  sharing a stripped name (chunks of same-named modules) are paired by their hashed name instead,
  and listed as ambiguous;
- contents compared byte for byte, hashed names inside them read without their hash, and the
  verdict says how many files only matched that way;
- for a changed file with a source map on both sides, the source modules whose generated code
  changed, from the map's segments grouped by source;
- `drift: identical` (exit 0), or `drift: <n> differ` (exit 1) and one line per changed, added or
  removed file with its raw and gzip size delta; exit 2 when the tool cannot answer.

Text and `report.json` (sorted, no timestamps) are written to the run directory, printed last. The
launcher's header (`skills/drift/scripts/drift.sh`) documents every option and line.

## drift shots

```
skills/drift/scripts/drift.sh shots [--repo <path>] [--base <ref>] [--head <ref>] [--config <path>] [--out <dir>] [--threshold <0..1>]
```

Checks out and installs each ref like `drift build`, starts the project's server there, captures
every configured route at every viewport (1440 and 390 px wide by default) in Chromium, then
compares each pair of captures with Playwright's own comparator:

- the server: refused when its port is already in use, waited for until its URL answers, then
  stopped with its whole process group, on failure too, before the next ref;
- the pages, made stable: API requests answered from the config's fixtures, never from a real API;
  a request to any host neither the server's nor allowed by the config aborted and listed
  (`blocked:`); an API request with no fixture answered 404 and listed (`unmocked:`), never waited
  on; the clock frozen (`now`), animations and transitions stopped, the caret hidden, fonts
  loaded, the config's ignore regions masked; one locale, time zone and pixel ratio;
- `drift: identical` (exit 0), or `drift: <n> differ` (exit 1) with one line per pair,
  `<n> px differ in <x,y,w,h>` and a diff image; exit 2 when the tool cannot answer.
  `--threshold` is the comparator's per-pixel colour tolerance: 0, exact, by default.

The capture and comparison specs are generated in the run directory, never written into the
target repository, and run with the plugin's own Playwright, never the project's.

### Playwright

`/drift:install` (`install.sh`, `drift.sh install`) installs one pinned `@playwright/test` and its
Chromium headless shell once per machine, under `~/.claude/playwright/<version>/` (the host's
configuration directory), outside the plugin's cache so an update of the plugin keeps it; a second
call finds it and does nothing. The install and its pin belong to the repository's shared core,
so another plugin driving a browser uses the same one. `drift shots` without it exits 2 and names
the command.

## The config

One JSON file per project, outside its repository, at `~/.claude/drift/<owner>-<repo>.json`
(named after the origin) or wherever `--config` says:

```json
{
  "install": ["npm", "ci"],
  "build": ["npm", "run", "build"],
  "outDir": "dist"
}
```

Commands are argument lists, run without a shell. `hashPattern`, a regular expression, replaces
the default hash stripping. `env`, an object of strings, is added to the environment of the
install, the build and the server on both sides: a build that embeds a release name or a commit
read from its environment reads the same on both once it is pinned there
(`"env": { "RELEASE": "drift" }`), and a page reads its API from an invented host the fixtures
answer (`"env": { "API_URL": "https://api.drift.test" }`).

`drift shots` reads `install`, `env` and a `shots` section:

```json
{
  "install": ["npm", "ci"],
  "env": { "API_URL": "https://api.drift.test" },
  "shots": {
    "server": ["npx", "vite", "--port", "5179", "--strictPort"],
    "port": 5179,
    "routes": ["/login", { "path": "/sites", "waitFor": "table" }],
    "viewports": [1440, 390],
    "fixtures": "fixtures",
    "api": ["api.drift.test"],
    "allow": [],
    "ignore": [{ "selector": ".clock" }, { "route": "/sites", "box": [0, 0, 200, 40] }],
    "now": "2026-01-01T09:00:00Z"
  }
}
```

A request to `<host>/<path>` is answered with `<fixtures>/<host>/<path>.<METHOD>.json`, else
`<fixtures>/<host>/<path>.json` (status 200, JSON; the query is not read). The fixtures are the
project's own neutral data, written by hand: never a copy of a real response. Every field, its
default and its validation: the launcher's header.

## Commands

`/drift:install`: the pinned Playwright, once per machine.

## Skill

`skills/drift/SKILL.md` (`drift:drift`): when the tool fits, how to run it, how to read and
quote its verdict.

## Tests

```
bash tests/run-tests.sh
```

A fixture project (`tests/fixture`) whose build writes a hashed bundle and its source map is
committed at several refs in a temporary repository: one module changed, a hash-only rename,
files added and removed, a failing build, an interrupted one.

The browser tests (`skills/drift/scripts/shots.e2e.ts`) need the shared install
(`install.sh`): a fixture app (`tests/shots-fixture`, a static page served by a tiny server, its API
answered from `tests/shots-api`) reads identical on three runs in a row, its one-pixel colour
change is found with its box, a blocked host and a missing fixture are listed, and a page that
never gets ready ends in a tool error with its server stopped.
