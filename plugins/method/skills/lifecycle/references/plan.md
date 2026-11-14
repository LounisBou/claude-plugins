# The spec, the plan, the state file

## The spec

Free prose, plus the one section the plan and the review read:

```
## Goals

1. <one outcome, measurable>
2. ...
```

## The plan

One file per phase, each naming:

- its scope and its non-goals;
- the files it creates or changes;
- the tests that prove it, written first;
- its definition of done, every figure with the command that measures it;
- for each step (sub-phase), the same, smaller.

## The state file

`IMPLEMENTATION.md` beside the plan is the one record of progress. Six header lines, then one
row per phase:

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

Status is `todo`, `doing` or `done`; a `todo` row leaves the milestone empty. Core parses and writes
it; edit it through core or in this shape.
