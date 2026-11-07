# A fixture build — design

## Why

The operator wants every build measured against what its spec set out to reach, and a
done that a command can check.

The rest of this section explains it.

## Goals

1. The unit of choice is a **pair** `<alias>/<effort>`: a family alias and an
   effort level.
2. Every dispatch's cost is **measured** and attached to its record row.
3. **Offline calibration**: a bench replays merged pull requests on a grid of pairs.
4. **Generalisation**: per-project tables fold into one global table per language | project kind.
5. **Online refinement**: the record corrects the table build after build.

## Non-goals

1. Not a goal.
