# The cases, and the criteria that chose them

`cases.json` holds the cases in the order runs take them: the pilot replays the first, the
measure the first six; the last three are reserves, each taking the place of a case whose
calibration fails on the machine of the run.

## Criteria

A merged pull request of this repository is a case when:

1. **It changes one plugin**, so the task has one suite and one owner, and the catalogue's
   version line is its only change outside the plugin.
2. **Its suite decides it**: the merged change adds or changes tests of its plugin, and those
   tests fail on the base. The calibration checks both on every run.
3. **Its task can be stated without its solution**: the program's list of verified defects
   (`docs/specs/program-design.md`, « Verified defects by plugin »), or the goal it served,
   names the problem before the change. The task is that statement, never the pull
   request's description of what it did.
4. **It is the size of one orchestrated phase**: from about ten to a few hundred changed
   lines, where a single session can finish within its cap and an orchestration has room
   to split.
5. **Together the cases vary**: six plugins, three languages (TypeScript, bash, Python), and
   three kinds of work: a guard that must fail closed, a race under a lock, a feature that
   changes a contract.

Left out, and why:

- **The imports** (`chore(import)`, the orchestrator's urgent builds): copies of work done
  elsewhere, with no task of their own.
- **Repository tooling and CI** (`ci:`, `feat(core)`, the context simulator, the rules
  report): they change several plugins or none, and their suite is the repository's.
- **The orchestrator's own pull requests**: its suite does not block on Linux yet and runs
  for a long time; a replay of the plugin being measured would also measure the plugin on
  itself.
- **Pull requests over several plugins** (#30, implement with github and norms): no single
  suite decides them.

## The cases

| Order | Case | Pull request | Plugin | Kind | Changed lines |
|---:|---|---:|---|---|---:|
| 1 | `norms-check-records-only-what-it-read` | #11 | norms | a record bound to what was read | 44 |
| 2 | `github-auto-merge-list-under-a-lock` | #36 | github | a race, under a lock | 115 |
| 3 | `bugs-bot-guards-fail-closed` | #16 | bugs-bot | a guard that fails closed | 80 |
| 4 | `statusbar-verified-defects` | #22 | statusbar | five defects in bash, portability | 115 |
| 5 | `pr-review-verdict-computed-from-findings` | #18 | pr-review | a feature: a verdict computed, not reported | 230 |
| 6 | `cloudflare-restore-only-where-taken` | #27 | cloudflare | a Python engine's scope, a test fixture's hang | 39 |
| 7 | `github-guards-fail-closed` | #15 | github | a guard that fails closed (reserve) | 49 |
| 8 | `norms-push-consent-is-asked` | #13 | norms | consent as a structured act (reserve) | 73 |
| 9 | `pr-review-no-clean-exit-before-a-pass` | #12 | pr-review | an ordering rule (reserve) | 14 |

The first case is the pilot's: the smallest of the six, so a broken arm costs the least to
find.
