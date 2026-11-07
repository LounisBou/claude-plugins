---
name: doctor
description: Re-check that the superpowers dependency is enabled
---

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.sh" --deps-only
```

Report its verdict to the user verbatim: exit 0 means everything is still ready, a
non-zero exit prints an `error:`/`fix:` pair naming the first problem found.

It does not look for a git repository: each skill checks that it runs inside one when it
starts.
