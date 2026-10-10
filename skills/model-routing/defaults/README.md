# Shipped routing defaults

The files in this directory are profile and global routing tables, exported by
`routing.py export` from an operator's measured tables. `profile-<language>-<kind>.json`
serves the projects of one profile, `global.json` every project. They use the table format
of `routing.py pick`, with each entry's pair written as `<tier>/<effort>`.

They name no model. A pair's tier resolves through the operator's own tier map when `pick`
reads it, so the same file serves any map; a tier the map does not bind falls through to the
next table. `pick` reads them after the operator's own project, profile and global tables,
and before the tier table the skill ships.

They are regenerated from measurements, never edited by hand: a figure typed here would be a
judgment dressed as a measurement. The operator decides when an export is committed.
