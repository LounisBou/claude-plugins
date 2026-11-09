# claude-plugins

LounisBou's Claude Code plugins, in one repository: each plugin is installed, versioned and
released on its own, and every change that crosses plugins is one pull request.

| Plugin | What it does |
|---|---|
| [method](plugins/method) | The development method every role follows: the lifecycle, the definition of done, the report, plan and question formats. |
| [orchestrator](plugins/orchestrator) | One session supervises implementer sessions: briefs, evidence-based reviews, rotation, succession, terminal tabs, a context gauge. |
| [github](plugins/github) | The GitHub API as a native tool: pull requests, reviews, comments, labels, issues, records. |
| [norms](plugins/norms) | Evidence-based code norms: review agents, a conformity check, rules learned from review threads. |
| [pr-review](plugins/pr-review) | Interactive pull request review: walkthrough, comment processing, a review-fix loop. |
| [implement](plugins/implement) | A single-session feature lifecycle: design, phases, check, close. |
| [statusbar](plugins/statusbar) | A two-line status bar read from the host's own payload. |
| [bugs-bot](plugins/bugs-bot) | A resident agent relaying testers' bug reports from Telegram and Slack. |
| [cloudflare](plugins/cloudflare) | Cloudflare and Caddy operations from a native tool, with backups. |

**Status: in construction.** The plugins are used from their former repositories until the
cutover (`docs/migration.md`). The program that leads there is `docs/specs/program-design.md`.

## Reading order

1. `docs/architecture.md` — the parts, the direction of dependencies, packaging, state.
2. `docs/conventions.md` — the rules every change follows.
3. `docs/contracts.md` — what plugins share, and who owns it.
4. `docs/migration.md` — how this repository replaces the former ones.
5. `docs/decisions/` — why.

## Working here

```bash
npm ci
npm run typecheck                     # strict TypeScript
npm test                              # the repository's tooling
npm run marketplace                   # regenerate the catalogue from the manifests
npm run core                          # rewrite each plugin's copy of core from packages/core/src
plugins/<name>/tests/run-tests.sh     # one plugin's suite
```

The checks every change runs before its push are listed in `CLAUDE.md`.

## License

MIT
