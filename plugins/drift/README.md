# drift

Proves that a change meant to change nothing changed nothing. An agent or a reviewer runs it on a
refactor, a rename or a move, and quotes its verdict as evidence; it is an optional proof, never a
required gate.

## drift build

```
skills/drift/scripts/drift.sh build [--repo <path>] [--base <ref>] [--head <ref>] [--config <path>] [--out <dir>]
```

Builds the two refs (default `origin/main` and `HEAD`) with the project's own commands, each in a
temporary `git worktree` outside the target checkout, and compares the outputs:

- content hashes stripped from file names (Vite's and Rollup's `name-[hash].ext` by default),
  files paired by the stripped name; files of one side sharing a stripped name (chunks of
  same-named modules) are paired by their full name instead, and listed as ambiguous;
- contents compared byte for byte, hashed names inside them read without their hash, and the
  verdict says how many files only matched that way;
- for a changed file with a source map on both sides, the source modules whose generated code
  changed, from the map's segments grouped by source;
- `drift: identical` (exit 0), or `drift: <n> differ` (exit 1) and one line per changed, added or
  removed file with its raw and gzip size delta; exit 2 when the tool cannot answer.

Text and `report.json` (sorted, no timestamps) are written to the run directory, printed last. The
launcher's header (`skills/drift/scripts/drift.sh`) documents every option and line.

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
the default hash stripping.

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
