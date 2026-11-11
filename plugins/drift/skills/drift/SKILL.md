---
name: drift
description: Use when a change must not change the built output or the rendered pages (a refactor, a rename, a move) and you want proof of it in a gate or a review - builds two refs and compares their outputs byte by byte, or captures their pages and compares them pixel by pixel. Not for a change meant to change behaviour.
---

# drift

An optional proof, never a required gate, for a change whose output should not move.

```bash
<this skill's directory>/scripts/drift.sh build|shots|svg --base <ref> --head <ref> --out <scratchpad>/drift
```

Needs the project's config at `~/.claude/drift/<owner>-<repo>.json` (or `--config <path>`);
`shots` also takes `--threshold <0..1>`. Config: see the README.
`svg` renders the changed `.svg` files, no config; it and `shots` need `/drift:install`.

## Read it

- `drift: identical`: same output (`shots`: same pixels).
- `drift: identical (hash references normalised in <n> files)`: equivalent, not byte for byte: say so.
- `drift: <n> differ`: one line per difference, with its diff.
- `blocked:` requests aborted, `unmocked:` requests with no fixture (answered 404): listed, not hidden.
- Exit 2: the tool could not answer; no verdict.

## Quote it

`drift build: identical (base <sha7>, head <sha7>)`, `shots`, `svg` alike, from the verdict line
and the `base … head …` line, with the normalised count when there is one.
