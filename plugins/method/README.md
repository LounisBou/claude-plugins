# method

The development method the other plugins are roles in (decision 0008): the lifecycle, the
definition of done, consent, and the formats of the report, the plan, the state file and the
question. It owns them; no other plugin restates them.

- `skills/lifecycle/SKILL.md` is the kernel, the skill `method:lifecycle`: loaded once per
  session by a role that plans, implements or reviews. implement's hooks ask its skills to load
  it first; the orchestrator loads it before planning work that ends in a pull request.
  Its prompt budget is measured by CI (`ci/prompts.json`, a report) and only falls.
- `skills/lifecycle/references/` holds one file per format (`plan.md`, `report.md`,
  `questions.md`), read only when that artifact is written.
- The formats that code reads are parsed in `packages/core/src/method.ts` (`parseState`,
  `markRow`, `nextRow`, `reportStatus`), so a role never re-implements them.
- "Done" is computed by the github plugin's ready gate; the kernel states it, the gate decides.

## Tests

```
bash tests/run-tests.sh
```

The suite validates the plugin and checks that every reference the kernel names exists.
