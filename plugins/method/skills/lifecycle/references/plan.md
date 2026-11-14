# The spec, the plan, the state file

## The spec

Free prose plus one section the plan and review read, `## Goals`: a numbered list, one measurable
outcome each.

## The plan

One file per phase, each naming its scope and non-goals, the files it touches, the tests that
prove it (written first) and its definition of done, every figure with its measuring command; for
each step, the same, smaller.

## The state file

`IMPLEMENTATION.md` beside the plan is the one record of progress, six header lines then a row per
phase:

```
**Codename**: <codename>
**Title**: <title>
**Branch**: <type>/<codename>
**Bump**: major|minor|patch|none
**Artifacts**: local|committed
**Base**: <sha>

| phase | title | status | milestone |
|---|---|---|---|
| 01 | <title> | doing | <commit the current step started from> |
```

Status is `todo`, `doing` or `done`; a `todo` row leaves the milestone empty. Core parses and
writes it: keep this shape.
