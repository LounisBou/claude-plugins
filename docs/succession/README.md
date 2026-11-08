# Succession: the program's working session, 2026-11-08

The handover of the session that built this repository from phase 0 to phase 8 of
`docs/specs/program-design.md`. A successor reads this file, then `CLAUDE.md`,
`docs/conventions.md` and the program, and takes up « Next steps » in order. Delete this
directory once its content has been absorbed (the program and the contracts carry the rest).

## The operator's standing rules

Every one of them was given explicitly; none is reopened.

- **Answer in French**; the repository (code, docs, commits, PR bodies) is in English.
- **Auto-merge**: the session that opens a pull request merges it itself, with a **merge
  commit**, once « repository rules » and the blocking suites of `ci/plugins.json` pass. No
  question asked before a push, a draft, a merge.
- **No attribution anywhere**: no `Co-Authored-By`, no `Claude-Session`, no « Generated with /
  by Claude Code » in commits, PR titles, PR bodies or comments. The PR creation tool appends a
  footer: **rewrite the body right after creating the PR** (`update_pull_request`).
- **Never add a permission prompt, an approval step or a chore** for the operator (program
  non-goal 2). Consent is a structured act (the host's `$.ui.ask` dialog), never words.
- **Generic only**: no project, account, person or machine in a plugin. The operator's own
  configuration (`LounisBou/claude-code`) stays outside this repository.
- **Coverage**: high and pragmatic, near the current level, not 100 %.
- **Keep**: the orchestrator's iTerm sessions and home session, `deck.json`'s format, the spawn
  without approval, the launcher's trust write (made safe, not removed), the context gauge.
- **The orchestrator is the operator's**: its urgent fixes run in the old
  `LounisBou/claude-orchestrator` repository by the operator's own orchestrator, each imported
  here the same day; its refoundation (`docs/specs/orchestrator-refoundation-design.md`) runs
  here alongside. Last import: `b55da76` (0.98.2).
- A PR or an issue is always named with its repository: `claude-plugins#24`, never `#24`.

## State by phase (main at `349e5bb`)

| Phase | State |
|---|---|
| 0 Urgent risks | done (cloudflare sudoers and merge pre-approvals, bugs-bot `shell=True`) |
| 1 Install from the monorepo | **not verified**: needs the operator's machine, a separate profile |
| 2 Core | done; core reaches github, implement, norms (and pr-review with claude-plugins#29) as a generated copy |
| 3 Contracts | done except the orchestrator's rows (`docs/contracts.md`) |
| 4 Readiness and consent | done: guards fail closed (#15, #16), grants read the command an answer starts with (#17), verdict computed from the review agents' JSON blocks (#18) |
| 4b Method | done: `plugins/method` (kernel `method:lifecycle` + 3 references, 1,406 tokens), core `method.ts`, implement on it (#19); review by another session: `/implement:review` (iTerm through the orchestrator's launcher on macOS, headless `claude -p` elsewhere), github refuses a review record written by the session that pushed the head (#20). The orchestrator joins the method after its urgent build |
| 5 Security | done: `npm run permissions` (no committed grant, installer rules listed), `/github:protect [apply]` (ruleset on the default branch) (#21) |
| 6 Platforms | in progress: see `ci/plugins.json`; #24 adds Linux for github, pr-review, cloudflare |
| 7 Defects | done for statusbar (#22, #26), bugs-bot (#25), norms (#28), implement (#30); open: pr-review #29, github #31, cloudflare #27 |
| 8 Prompts and evals | simulator #32 and rules report #33 open; evals not started (need the operator's spend cap) |
| 9 Configuration and cutover | not started (operator) |

## Open pull requests at handover

Each is the session's own: watch it (`subscribe_pr_activity`), merge it when its blocking
checks are green on its current head. After each merge, bring main into the others (see
« Merging »).

| PR | Content | What is left |
|---|---|---|
| claude-plugins#24 | github and pr-review suites green on Linux (gzip in the test PATH, `joinlines` instead of GNU `tr` with `⏎`, no `&` in a bash 5.2 pattern replacement); Linux blocking for github, pr-review, cloudflare | merge when green |
| claude-plugins#27 (draft) | cloudflare: `restore` replays a backup only where it was taken; the fake Caddy prints its stderr when it does not start | **cloudflare's suite does not start on macOS**: `world.py` writes no `caddy/ports` and its stderr is empty. Reproduce on macOS (`tests/fixtures/caddy/world.py`: TLS context, `load_cert_chain` with LibreSSL-made certificates is the first suspect), then undraft and merge; then macOS blocking for cloudflare |
| claude-plugins#29 | pr-review: its `install.sh` runs github's installer instead of its own copy; `runsGitPush` through core's reader (`sh -c`, `eval`) | merge when green |
| claude-plugins#31 | github: `image-upload` only uploads real images; only rate limits are retried, GraphQL too; the records guard reads dequoted words, NotebookEdit held | merge when green; its 4 Linux failures vanish once #24 is in |
| claude-plugins#32 | `npm run context`, `ci/scenarios.json`: tokens per scenario, each PR's difference in the CI summary | merge when green |
| claude-plugins#33 | `npm run rules`: rules stated in prompts that no code holds and no eval names | merge when green |

## Next steps, in order

1. Merge the open PRs above as they turn green.
2. **Platforms (phase 6)**: read the real result of each non-blocking suite in the last run on
   main — a non-blocking job is green even when its suite fails; the truth is in the log
   (`gh api repos/LounisBou/claude-plugins/actions/jobs/<id>/logs`, look for `FAIL` and
   `passed, N failed`). Add a platform to `ci/plugins.json` the day its suite is fully green
   there. Expected: bugs-bot (after #25 only root-only tests failed locally; CI is not root),
   cloudflare macOS (after #27). implement fails in CI only because `superpowers` is not
   installed there: install it in the CI job or make those three checks skip with a reason.
3. **Defects left (phase 7)**, outside the orchestrator: github `auto-merge.json` written
   without a lock (the module only has `$.fs`); pr-review's fallback request file at a fixed
   `/tmp` path. Waiting for the orchestrator: github reads the orchestrator's private `round/`
   files for waivers and auto-merge consent (replace by a declared consent contract), and
   github's `ready.ts` names its consumers.
4. **Phase 8**: the evals need **the operator's spend cap per run, asked before any run**
   (program). Calibrate the simulator on the gauge's first-turn measures (the measure file on the
   operator's machine). WRITING.md read whole by github (~3.3k tokens): cut or load on demand,
   with `npm run context` showing the gain.
5. **Orchestrator** (after the operator's go): import its urgent build from the old repository
   (`git -C <old> diff A B --binary | git apply --index --directory=plugins/orchestrator`), then
   the refoundation spec. `method-inventory.md` beside this file lists every place the
   orchestrator restates the lifecycle, done, the formats and the question format, and its
   contradictions with github's ready gate (ready read before the rebase, the « fixed » head
   accepted, a review missing only warned about, 2–5 choices against 2–4).
6. **Phase 9** with the operator: the configuration repository on its `next` branch, the
   install in a separate profile, the cutover criteria of `docs/migration.md`.

## Questions open to the operator

- The spend cap per eval run (phase 8).
- Whether the orchestrator's urgent build is over (to start its import and refoundation).
- The install test on the operator's machine (phases 1 and 9).
- The `rewritten/*` branches left on GitHub by the early history rewrite: the proxy refuses a
  branch deletion from a session; the operator deletes them.

## How this repository is worked

**Checks before every push** (`CLAUDE.md`): `npm run typecheck`, `npm test`, `npm run deps`,
`npm run permissions`, `npm run marketplace -- --check`, `npm run core -- --check`,
`npm run -s prompts`, and each touched plugin's `tests/run-tests.sh` plus
`claude plugin test plugins/<name>` and `claude plugin validate plugins/<name>`.

**Versions**: a shipped change raises its plugin's version, then `npm run marketplace`. A change
of `packages/core/src` rewrites every core copy (`npm run core`): each plugin whose copy
changed is a shipped change too, so its version rises.

**Prompt budgets** (`ci/prompts.json`) only fall: a prompt that grows must pay for itself
elsewhere; after a cut, `npm run prompts -- --lower`. A pytest run leaves `.pytest_cache/`
(skipped since #25); check with `npm run -s prompts`, whose exit code a pipe would hide.

**Merging**: the merge tool needs the full 40-character head sha. After a merge, bring main into
every open branch **one conflict at a time**: generated files (`marketplace.json`, `core/`,
`ci/prompts.json`) are taken from main then regenerated (`npm run marketplace`, `npm run core`,
`npm run prompts -- --lower`); a version conflict keeps the higher version, or the next one when
the branch ships a change main does not have. **Never commit before `git grep '^<<<<<<< '`
finds nothing.**

**CI**: macOS runners queue for 15 to 30 minutes; work on the next PR meanwhile. A check event
names a head: compare it with the PR's current head before acting.

**This container**: it runs as root, so tests of unreadable files fail here and pass in CI;
run a suite as another user with `runuser -u nobody` when it matters. The installed host is
`claude` 2.1.x; its test kit is `claude plugin test`; a hooks module imports no `node:` module
and no JSON, reads a variable only by a literal name, and sees `$.ui.ask` as an
`AskUserQuestion` tool call in tests.

**Portability traps met**: GNU `stat -f` reads the filesystem (use `stat -c` first); GNU `tar`
needs an external `gzip`; GNU `tr` is not multibyte; bash 5.2 reads `&` in a pattern
replacement as the match; bash 3.2 does not reseed `$RANDOM` in a subshell; mawk is Ubuntu's
`awk`; the monorepo's root `package.json` is `"type": "module"`, so a plugin's CommonJS file
needs its own `package.json`.
