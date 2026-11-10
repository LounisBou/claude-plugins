---
name: drift
description: Use when a change must not change the built output (a refactor, a rename, a move) and you want proof of it in a gate or a review - builds two refs and compares their outputs byte by byte. Not for a change meant to change behaviour.
---

# drift

An optional proof, never a required gate. It fits a change whose built output should not move
(a refactor, a rename, a move), not one meant to change behaviour or output.

## Run it

```bash
<this skill's directory>/scripts/drift.sh build --base <ref> --head <ref> --out <scratchpad>/drift
```

It needs the project's config, outside the repository, at `~/.claude/drift/<owner>-<repo>.json`
(or `--config <path>`): `install` and `build` as argument lists, `outDir`, optionally
`hashPattern`, and `env`, variables pinning what the build embeds (a release name). The
launcher's header documents every option and line.

## Read it

- `drift: identical`: every output file matches byte for byte.
- `drift: identical (hash references normalised in <n> files)`: the same once hashed file names
  inside the files are read without their hash. Equivalent output, but not byte for byte: say so.
- `drift: <n> differ`: each changed, added or removed file with its size deltas; `source` lines
  name the modules whose generated code changed.
- `ambiguous:` lists same-named chunks (two `Alerts.vue`), paired by their hashed name: such a
  file that changed reads removed and added.
- A file renamed only in what the hash pattern strips (`data-20240101.json`) reads as the same file.
- Exit 2: the tool could not answer (config, ref, install or build); no verdict.

## Quote it

In a report: `drift build: identical (base <sha7>, head <sha7>)`, from the verdict line and the
`base … head …` line, with the normalised count when there is one.
