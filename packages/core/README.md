# core

What more than one plugin needs, defined once (docs/architecture.md, decision 0002). It knows
no plugin. A plugin reaches it through a link inside its own directory, which the host follows
when it installs the plugin.

| Module | What it owns |
|---|---|
| `paths.ts` | The host's configuration directory and each plugin's state directory. |
| `store.ts` | Writes in one rename, read-modify-write under a lock. |
| `deadline.ts` | Work given a deadline, cancelled when it passes. |
| `names.ts` | The shapes of session names and the role each one gives. |
| `locate.ts` | Where the host installed another plugin. |
