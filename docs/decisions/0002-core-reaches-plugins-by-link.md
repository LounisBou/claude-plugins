# 0002 — `core` reaches each plugin through a link

**Context.** The host copies a plugin's directory into its cache; a plugin cannot import a
path outside it. Shared code must still exist once.

**Decision.** `packages/core` is the only copy in the repository. Each plugin that uses it holds
a link to it inside its directory, which the host follows when it copies. Before any plugin
depends on it, the program verifies on the operator's host that an installed plugin resolves
the link (program goal 3). If the host does not follow it, a release script copies `core` into
each plugin at release, and CI refuses a copy that differs from the source.

**Cost.** A plugin's installed size grows by what it uses of `core`.
