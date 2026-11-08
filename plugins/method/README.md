# method

The development method the other plugins are roles in (decision 0006): the lifecycle, the
definition of done, consent, and the formats of the report, the plan, the state file and the
question. It owns them; no other plugin restates them.

- `skills/lifecycle/SKILL.md` is the kernel: loaded once per session by a role that plans,
  implements or reviews. Its prompt budget is the strictest of the repository.
- `skills/lifecycle/references/` holds one file per format, read only when that artifact is
  written.
- The formats that code reads are parsed in `packages/core/src/method.ts` (`parseState`,
  `markRow`, `nextRow`, `reportStatus`), so a role never re-implements them.
- "Done" is computed by the github plugin's ready gate; the kernel states it, the gate decides.

## Tests

```
bash tests/run-tests.sh
```
