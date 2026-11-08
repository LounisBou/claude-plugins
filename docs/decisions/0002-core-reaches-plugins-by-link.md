# 0002 — `core` reaches each plugin through a link

**Context.** The host copies a plugin's directory into its cache; a plugin cannot import a
path outside it. Shared code must still exist once.

**Decision.** `packages/core` is the only copy in the repository. Each plugin that uses it holds
a link to it inside its directory, which the host follows when it copies.

**Verified** on the host at 2.1.319: a plugin installed from a git catalogue holding
`core -> ../../packages/core/src` gets a real `core/` directory with the files in its cache
copy, and a catalogue added from a local directory loads the plugin in place, where the link
resolves as it is. To verify again on the operator's host in phase 1. Should a host stop
following links, a release script copies `core` into each plugin, and CI refuses a copy that
differs from the source.

**Cost.** A plugin's installed size grows by what it uses of `core`.
