# claude-plugins

A monorepo of independent Claude Code plugins under `plugins/<name>/`.

- Read `docs/conventions.md` before changing anything; `docs/architecture.md` before adding a
  file outside a plugin, a dependency or a shared format; `docs/contracts.md` before touching
  anything another plugin reads.
- Every change: `npm run typecheck`, `npm test`, `npm run deps`, `npm run permissions`,
  `npm run marketplace -- --check`, `npm run core -- --check`, `npm run -s prompts`,
  `npm run context`, `npm run rules`, and the suite of each plugin touched
  (`plugins/<name>/tests/run-tests.sh`).
- Shared code is edited in `packages/core/src` only, then `npm run core` rewrites each plugin's
  `core/` copy; never edit a copy. A plugin whose copy changed ships a change.
- Prompt budgets (`ci/prompts.json`) are lowered by the release (`npm run release`), never in a pull
  request; CI still refuses a budget exceeded.
- A pull request raises no version. One release pull request raises the version of every plugin
  changed since the last release, in `plugins/<name>/.claude-plugin/plugin.json`, then runs
  `npm run marketplace` (`npm run version-bump -- <last-release-ref>` checks it). Never edit the
  catalogue's `plugins` list by hand.
- Conventional commits, scoped by plugin (`fix(github): …`) or repository part (`ci`, `core`, `docs`).
- This repository is in auto-merge: the session that opens a pull request merges it, with a
  merge commit, once the repository rules and the blocking suites (`ci/plugins.json`) pass.
  A pull request runs the Linux suites of the plugins it touches, none for a documentation-only
  one, which passes; macOS runs on `main` after the merge.
- The program in progress is `docs/specs/program-design.md`; its goals are the definition of done.
