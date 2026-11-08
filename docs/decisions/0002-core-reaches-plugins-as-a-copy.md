# 0002 — core reaches each plugin as a generated copy

**Context.** The host copies a plugin's directory into its cache; a plugin cannot import a path
outside it. Shared code must still exist once.

**Decision.** `packages/core/src` is the only source. Each plugin that uses it holds a `core/`
directory that `npm run core` fills with the source's modules, tests left out, every file
marked as generated. Nobody edits a copy: CI (`npm run core -- --check`) refuses one that
differs from the source, so a change to core is made once and reaches every consumer in the
same pull request, which then raises their versions.

**Why not a link.** On the host at 2.1.319 an installed plugin's link is followed (the cache
gets a real directory), but `claude plugin validate` refuses a link ("not a regular file") and
the host's test kit cannot import through one. A copy passes all three.

**Cost.** The repository holds one copy of core per consumer; the check keeps them identical.
