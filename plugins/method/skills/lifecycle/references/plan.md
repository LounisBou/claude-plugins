# The spec, the plan, the state file

## The spec

Free prose, plus the section the plan and the review read:

```
## Goals

1. <one outcome, measurable: what is true once it is done>
2. ...
```

A goal is met when a reading of the code, a command or a commit shows it, never on a claim.

## The plan

One file per phase, each naming:

- its scope and its non-goals;
- the files it creates or changes;
- the tests that prove it, written first;
- its definition of done, every figure with the command that measures it;
- for each step (sub-phase), the same, smaller.

A question the plan leaves open is asked before the phase starts, not decided during it.

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
| 01 | <title> | done | <last commit of the phase> |
| 02 | <title> | doing | <commit the current step started from> |
| 03 | <title> | todo |  |
```
