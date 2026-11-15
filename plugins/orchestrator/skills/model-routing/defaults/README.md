# Shipped routing defaults

This directory holds the shipped profile and global routing tables a plugin version may carry:
`profile-<language>-<kind>.json` serves the projects of one profile, `global.json` every
project. None ships today, so `pick` falls to the tier table of the skill. The operator's own
tables, `<state dir>/routing/tables/project-<slug>.json`, `profile-<language>-<kind>.json` and
`global.json`, take the same format and are written by hand.

A table is `{"scope": "project:<slug>" | "profile:<language>/<kind>" | "global", "entries": {...}}`,
one entry per class (the slugs of the skill's table). An entry reads:

- `pair`: the pair to dispatch, `<alias>/<effort>`. Shipped here it is `<tier>/<effort>`, read
  through the operator's tier map, so the file names no model and a tier the map does not
  bind falls through to the next table.
- `size`: `small` or `large`. An entry stamped `small` does not serve a large phase.
- `ladder`: the pairs of the class, cheapest first, each `{"pair", "n", "pass_rate",
  "eligible"}`; `pick` offers the rung just below the pair as the exploration notch.
- `floor`: the pass rate under which a rung with at least six trials is no notch, read on a
  rung that has no `equivalent`. A rung with `covered: true` and `equivalent: false` is no
  notch either.
- `models`: the identifiers the entry was tried on, informative.

Any field left out reads as absent. `pick` reads these tables after the operator's own
project, profile and global tables, and before the tier table.

The operator decides which tables are committed here.
