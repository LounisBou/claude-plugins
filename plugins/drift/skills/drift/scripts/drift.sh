#!/bin/bash
# drift.sh — whether two refs of a repository build to the same output, or render the same pixels.
#
#   drift.sh build [--repo <path>] [--base <ref>] [--head <ref>] [--config <path>] [--out <dir>]
#   drift.sh shots [--repo <path>] [--base <ref>] [--head <ref>] [--config <path>] [--out <dir>] [--threshold <0..1>]
#   drift.sh install
#
# Defaults: --repo ., --base origin/main, --head HEAD, --config ~/.claude/drift/<owner>-<repo>.json
# (named after the repository's origin, under $CLAUDE_CONFIG_DIR when it is set), --out a new directory under the calling session's
# scratchpad when one is found, else under the system temp directory; --threshold 0. A given --out
# must be new, empty or a previous run's (it holds a report.json): anything else is refused.
#
# The config, a JSON object kept outside the repository:
#   "install"      optional, the command run in each checkout first, as a list: ["npm", "ci"]
#   "build"        the build command, as a list: ["npm", "run", "build"]; no shell runs either
#   "outDir"       the build's output directory, relative to the repository root: "dist"
#   "hashPattern"  optional, the regular expression removed from each output file name; the
#                  default reads Vite's and Rollup's `name-[hash].ext`
#   "env"          optional, variables added to the environment of install, build and server on
#                  both sides, to pin what a build embeds from it: {"RELEASE": "drift"}; the
#                  server inherits PATH, HOME and NODE_ENV alone besides them
#   "shots"        what `shots` reads, an object:
#     "server"       the server command, as a list, run in each checkout once installed
#     "port"         the port it listens on; refused when something already listens there
#     "url"          optional, the server's root: http://localhost:<port>; its host is localhost,
#                    127.0.0.1 or [::1], its port "port"
#     "routes"       paths to capture, from that root: ["/", "/login"], or {"path", "waitFor"}
#                    where waitFor is a selector the page shows once ready
#     "viewports"    optional, widths, or {"width", "height"}: [1440, 390]; a width alone is 900 high
#     "fixtures"     optional, the directory API responses come from, relative to the config file:
#                    a request to <host>/<path> is answered with <host>/<path>.<METHOD>.json, else
#                    <host>/<path>.json (status 200, JSON; the query is not read)
#     "api"          optional, hosts answered from the fixtures alone: a request with no fixture
#                    gets a 404 and is listed as unmocked
#     "allow"        optional, hosts let through to the network; a request to any other host but
#                    the server's is aborted and listed as blocked, a WebSocket closed and listed,
#                    and a redirect leaving them blocks the request that led to it. A host in
#                    "api" or "allow" without a port means its scheme's default port alone
#     "ignore"       optional, regions masked on both sides: {"selector"} or {"box": [x, y, w, h]},
#                    each with an optional "route"
#     "now"          optional, the time the pages read, frozen: 2026-01-01T09:00:00Z
#     "timeout"      optional, seconds a page has to load and get ready: 30
#     "startTimeout" optional, seconds the server has to answer: 120
#     "fullPage"     optional, whether the whole page is captured, not only the viewport: true
#
# stdout of build: the verdict first, then one line per differing file and per changed source
# module, then the refs, then `out: <run directory>`, which holds report.txt, report.json,
# base.log and head.log.
#   drift: identical                                             0  every file pairs byte for byte
#   drift: identical (hash references normalised in <n> files)  0  the same, once the hashed names
#                                                                  the files reference are read
#                                                                  without their hash
#   drift: <n> differ                                            1  followed by
#     changed|added|removed <path> raw <±bytes> gzip <±bytes>
#       source <module>   (a changed file both sides map: a module whose generated text changed)
#   ambiguous: <n> files paired by their hashed name, then one indented line per file, 20 at most
#     and `… <n> more in report.json` past them: files of one side whose names strip to the same
#     one keep their full name, so a changed one reads removed and added
#
# stdout of shots: the verdict, one line per route and viewport, the requests left out, the refs,
# then `out: <run directory>`, which holds the captures (base/, head/), the diff images (diff/),
# the generated specs (spec/), the logs, report.txt and report.json.
#   drift: identical                                             0  every pair of captures matches
#   drift: <n> differ                                            1  <n> pairs differ
#   <route> @<width>: identical
#   <route> @<width>: <n> px differ in <x,y,w,h>[ (size <w>x<h> → <w>x<h>)], diff diff/<name>.png
#                               at --threshold 0, a pair differs as soon as one byte of one pixel
#                               does; above 0, Playwright's comparator decides, and the line
#   threshold <t>: colour differences within it and pixels taken for anti-aliasing are not counted
#                               says what it may forgive
#   blocked: <url>              a request to a host neither the server's, nor in "api" or "allow"
#   unmocked: <METHOD> <url>    a request to an "api" host with no fixture
#
# install: `drift: Playwright <version> installed in <dir> (<n> MB)`, or `already installed`.
#
# stderr: `drift: <reason>`, exit 2, when the tool cannot answer (a bad call, a missing config, a
# ref that is no commit, a failed install, build, server or capture, a route answering an error
# status, Playwright not installed, no node able to run the command).
#
# The command itself is drift.ts, beside this launcher: TypeScript, which node runs without a flag
# from 22.18 and 23.6 on.

launcher_error() {
  echo "drift: $1" >&2
  exit 2
}

version=$(node -p 'process.versions.node' 2>/dev/null) || launcher_error "node not found: drift needs node 22.18 or later"
IFS=. read -r major minor _ <<<"$version"
case "$major.$minor" in
  *[!0-9.]* | . | *.) launcher_error "node $version unreadable: drift needs node 22.18 or later" ;;
esac
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 18 ]; } || { [ "$major" -eq 23 ] && [ "$minor" -lt 6 ]; }; then
  launcher_error "node $version is too old: drift needs node 22.18 or later"
fi

shopt -s execfail
exec node --no-warnings "$(dirname "$0")/drift.ts" "$@"
launcher_error "node could not be started"
