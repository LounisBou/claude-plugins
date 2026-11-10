---
name: drift
description: Use when a change must not change the built output (a refactor, a rename, a move) and you want proof of it in a gate or a review - builds two refs and compares their outputs byte by byte. Not for a change meant to change behaviour.
---

# drift

An optional proof, never a required gate: run it when a change claims to have no effect and the
claim is worth checking.

## When it fits

- Fits: a refactor, a rename, a move, a dependency-free cleanup, anything whose built output
  should not move.
- Does not fit: a change meant to change behaviour or output; its `differ` says nothing new.

## Run it

```bash
<this skill's directory>/scripts/drift.sh build --base <ref> --head <ref> --out <scratchpad>/drift
```

It needs the project's config, outside the repository, at `~/.claude/drift/<owner>-<repo>.json`
(or `--config <path>`): `install` and `build` as argument lists, `outDir`, optionally
`hashPattern`. The launcher's header documents every option and line.

## Read it

- `drift: identical`: every output file matches byte for byte.
- `drift: identical (hash references normalised in <n> files)`: the same once hashed file names
  inside the files are read without their hash. Equivalent output, but not byte for byte: say so.
- `drift: <n> differ`: each changed, added or removed file with its size deltas; `source` lines
  name the modules whose generated code changed. Read them before calling the change neutral.
- Exit 2: the tool could not answer (config, ref, install or build); no verdict.

## Quote it

In a report: `drift build: identical (base <sha7>, head <sha7>)`, from the verdict line and the
`base … head …` line, with the normalised count when there is one.
