# claude-plugins

A monorepo of independent Claude Code plugins under `plugins/<name>/`.

- Read `docs/conventions.md` before changing anything; `docs/architecture.md` before adding a
  file outside a plugin, a dependency or a shared format; `docs/contracts.md` before touching
  anything another plugin reads.
- Every change, run locally: `npm run typecheck`, `npm test`, and the suite of each plugin touched
  (`plugins/<name>/tests/run-tests.sh`) except the orchestrator's. CI runs the rest: `npm run deps`,
  `npm run permissions`, `npm run marketplace -- --check`, `npm run core -- --check`, and the
  orchestrator's suite. `npm run -s prompts`, `npm run context` and `npm run rules` report, they do
  not block: CI prints their figures and a warning; the weekly report has a line for the budgets, the
  duplicates and the rules.
- Shared code is edited in `packages/core/src` only, then `npm run core` rewrites each plugin's
  `core/` copy; never edit a copy. A plugin whose copy changed ships a change.
- Prompt budgets (`ci/prompts.json`) are lowered by the release (`npm run release`), never in a pull
  request; a budget exceeded is a warning in CI and a line of the weekly report, and the release
  refuses it. No pull request grows a plugin's prompts: CI fails one that raises any plugin's prompt
  tokens against its base (`npm run prompts -- --growth origin/main`), and a rise is paid by a removal
  in the same plugin, in the same pull request.
- A pull request raises no version. One release pull request raises the version of every plugin
  changed since the last release, in `plugins/<name>/.claude-plugin/plugin.json`, then runs
  `npm run marketplace` (`npm run version-bump -- <last-release-ref>` checks it). Never edit the
  catalogue's `plugins` list by hand.
- Conventional commits, scoped by plugin (`fix(github): …`) or repository part (`ci`, `core`, `docs`).
- This repository is in auto-merge, with a merge commit, once the repository rules and the blocking
  suites (`ci/plugins.json`) pass. A pull request dispatched by an orchestrator is merged by that
  orchestrator, never by its agent; a session working alone merges its own. The method is in
  `docs/conventions.md`, « What the method is »; what CI runs, and when, is in
  `docs/architecture.md`, « What CI holds ».
- The repository's objectives are `docs/objectives.md`. The method does not bind its own
  development: any session, whatever its role, writes and merges a correction here. A guard of the
  method that blocks a correction of the method is the defect, and is removed first.
- Each change is one pull request, with one review, green CI and auto-merge.
- A friction met only while working on claude-plugins becomes no new rule, guard, gate or check of
  the method unless the same problem is seen on one of the operator's other projects; it is fixed by
  removing or simplifying.
- Base a judgment of a plugin on data from its version in service (events after its last deploy), or
  on a point re-verified on main.
