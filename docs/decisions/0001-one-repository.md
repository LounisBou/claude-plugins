# 0001 — One repository, separate plugins

**Context.** Eight plugins lived in eight repositories, maintained by one person, depending on
one another. A change crossing plugins took several coordinated pull requests and an upgrade
order to follow by hand; shared code was copied (the shell tokenizer, the github locator, the
gate's arithmetic) and the copies drifted; the catalogue was a hand-kept copy of the versions,
already wrong for github; no repository had CI.

**Decision.** One repository. Each plugin stays a directory of its own, installed, versioned
and released on its own; the separation is enforced by the dependency lint instead of by
repository walls. The history of every plugin is imported. The catalogue keeps the name
`lounisbou`, so installed names do not change; a separate host profile, not a separate
catalogue name, isolates this repository until the cutover (docs/migration.md).

**Cost.** One CI for every plugin, so a slow suite slows every pull request: suites run in
parallel, one job per plugin and platform.
