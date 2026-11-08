# claude-plugins

A monorepo of independent Claude Code plugins under `plugins/<name>/`.

- Read `docs/conventions.md` before changing anything; `docs/architecture.md` before adding a
  file outside a plugin, a dependency or a shared format; `docs/contracts.md` before touching
  anything another plugin reads.
- Every change: `npm run typecheck`, `npm test`, `npm run marketplace -- --check`, and the
  suite of each plugin touched (`plugins/<name>/tests/run-tests.sh`).
- A shipped change raises its plugin's version in `plugins/<name>/.claude-plugin/plugin.json`,
  then `npm run marketplace`. Never edit the catalogue's `plugins` list by hand.
- Conventional commits, scoped by plugin (`fix(github): …`) or repository part (`ci`, `core`, `docs`).
- The program in progress is `docs/specs/program-design.md`; its goals are the definition of done.
