# drift

Proves that a change meant to change nothing changed nothing: the same build output byte for byte
(`drift build`), the same pages pixel for pixel (`drift shots`), the same rendering of every
changed SVG file (`drift svg`). An agent or a reviewer runs it on
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
- the server's URL is on this machine (`localhost`, `127.0.0.1` or `[::1]`) and its configured
  port; its environment is `PATH`, `HOME`, `NODE_ENV` and the config's `env`, nothing else of the
  caller's;
- the pages, made stable: API requests answered from the config's fixtures, never from a real API;
  a request to any host neither the server's nor allowed by the config aborted and listed
  (`blocked:`), a WebSocket to one closed and listed, a redirect chain leaving them stopped at its
  first request and its target listed; an API request with no fixture answered 404 and listed
  (`unmocked:`), never waited on; the clock frozen (`now`), animations and transitions stopped,
  the caret hidden, fonts loaded, the config's ignore regions masked; one locale, time zone and
  pixel ratio. A host listed without a port means its scheme's default port alone;
- a route answering an error status (outside 2xx and 3xx) on either side is a tool error, never
  a capture;
- `drift: identical` (exit 0), or `drift: <n> differ` (exit 1) with one line per pair,
  `<n> px differ in <x,y,w,h>` and a diff image; exit 2 when the tool cannot answer. At
  `--threshold 0`, the default, identical means the same size and the same bytes for every pixel.
  Above 0, `--threshold` is the comparator's per-pixel colour tolerance, and the comparator also
  ignores pixels it takes for anti-aliasing: the report says so.

The routing is the browser's: the server's own outgoing calls (server-side rendering, a dev
server's proxy) are not routed, and reach whatever the server reaches. Point them at an invented
host through `env`, or keep them out of the captured routes.

The capture and comparison specs are generated in the run directory, never written into the
target repository, and run with the plugin's own Playwright, never the project's.

### Playwright

`/drift:install` (`install.sh`, `drift.sh install`) installs one pinned `@playwright/test` and its
Chromium headless shell once per machine, under `~/.claude/playwright/<version>/` (the host's
configuration directory), outside the plugin's cache so an update of the plugin keeps it; a second
call finds it and does nothing. The packages are installed by `npm ci` from a lockfile core writes
with the integrity the registry published for each, their install scripts not run; the install
runs in its own process group, stopped on an interruption and past core's `INSTALL_TIMEOUT_MS`. The install and its pin belong to the repository's shared core,
so another plugin driving a browser uses the same one. `drift shots` and `drift svg` without it
exit 2 and name the command.

## drift svg

```
skills/drift/scripts/drift.sh svg [--repo <path>] [--base <ref>] [--head <ref>] [--out <dir>] [--scales <s,…>]
```

Compares the standalone `.svg` files changed between the two refs as rendered images. A command of
its own rather than an option of `shots`: it needs no config, no checkout, no install and no
server, so it runs on any repository as it is.

- the files: `git diff --raw --no-renames` between the two commits, every path ending in `.svg`
  (any case); each side's bytes read from the object store, never checked out, written under the
  run directory. Added and removed files are listed, not rendered; a side that is a symbolic link
  or a submodule is listed as skipped;
- the rendering: each changed file of each side shown in the shared Chromium as an image from a
  `data:` URL, where an SVG runs no script and loads nothing; every request a page makes is
  aborted and listed (`blocked:`). The size is the file's viewBox (else its `width` and `height`
  in px, else 300×150, a browser's default) times each of `--scales` (default `1,4`), on a
  transparent then a white background;
- the comparison: each pair byte for byte, as `shots` at `--threshold 0`; a change of size differs
  even when no pixel does. A file whose bytes changed but whose renderings all match reads
  `identical (text differs)`;
- the resources a file names outside itself (`href`, `src`, `url()`, `@import`), on either side,
  are listed (`external:`) and never fetched: the file is rendered without them;
- a changed file that does not parse as XML, whose root is not `<svg>` in the SVG namespace, or
  that the browser does not render is a tool error naming the file and its side (exit 2), never
  a verdict;
- `drift: identical` (exit 0), or `drift: <n> differ` (exit 1), `<n>` counting the files added,
  removed or rendering differently, with one line per differing rendering and its diff image.

SVGs inlined in components or style sheets are not read: `shots` sees them on its pages. An
animated SVG (SMIL or CSS) is captured at whatever frame the image shows, and may read as a
difference.

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

The browser tests (`skills/drift/scripts/shots.e2e.ts`) need the shared install (`install.sh`),
which downloads about 100 MB the first time the suite runs on a machine. A fixture app
(`tests/shots-fixture`, static pages served by a tiny server, its API answered from
`tests/shots-api`) reads identical on three runs in a row; a one-pixel colour change is found with
its box, and so is a grey column the comparator would take for anti-aliasing; a change of size,
a threshold, a masked box are read; a blocked host, a missing fixture, a WebSocket, redirects and
another port of an allowed host are listed and never reached; an error page and a page that never
gets ready end in a tool error with the server stopped.

The SVG tests (`skills/drift/scripts/svg.e2e.ts`) commit a few icons at several refs: a path moved
by one unit is found with its box at each scale and on each background; a file only reformatted,
its attributes reordered, reads `identical (text differs)`; an added and a removed file are
listed; a reference to a local server is listed and the server never reached; a malformed file
ends in a tool error; the same refs give the same report.
