#!/bin/bash
# drift.sh — whether two refs of a repository build to the same output.
#
#   drift.sh build [--repo <path>] [--base <ref>] [--head <ref>] [--config <path>] [--out <dir>]
#
# Defaults: --repo ., --base origin/main, --head HEAD, --config ~/.claude/drift/<owner>-<repo>.json
# (named after the repository's origin), --out a new directory under the calling session's
# scratchpad when one is found, else under the system temp directory.
#
# The config, a JSON object kept outside the repository:
#   "install"      optional, the command run in each checkout first, as a list: ["npm", "ci"]
#   "build"        the build command, as a list: ["npm", "run", "build"]; no shell runs either
#   "outDir"       the build's output directory, relative to the repository root: "dist"
#   "hashPattern"  optional, the regular expression removed from each output file name; the
#                  default reads Vite's and Rollup's `name-[hash].ext`
#   "env"          optional, variables added to the environment of install and build on both
#                  sides, to pin what a build embeds from it: {"RELEASE": "drift"}
#
# stdout: the verdict first, then one line per differing file and per changed source module, then
# the refs, then `out: <run directory>`, which holds report.txt, report.json, base.log and head.log.
#   drift: identical                                             0  every file pairs byte for byte
#   drift: identical (hash references normalised in <n> files)  0  the same, once the hashed names
#                                                                  the files reference are read
#                                                                  without their hash
#   drift: <n> differ                                            1  followed by
#     changed|added|removed <path> raw <±bytes> gzip <±bytes>
#       source <module>   (a changed file both sides map: a module whose generated text changed)
#   ambiguous: <n> files paired by their hashed name, then one indented line per file: files of
#     one side whose names strip to the same one keep their full name, so a changed one reads
#     removed and added
# stderr: `drift: <reason>`, exit 2, when the tool cannot answer (a bad call, a missing config, a
# ref that is no commit, a failed install or build).
#
# The command itself is drift.ts, beside this launcher.

exec node --no-warnings "$(dirname "$0")/drift.ts" "$@"
