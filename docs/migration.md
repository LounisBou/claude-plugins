# Migration and cutover

The operator keeps working with the current repositories until this one is proved stable.
This file says how the two lines are kept from diverging, how this repository is used before
the cutover, what « stable » means, and what the cutover changes.

## Until the cutover: one line of development

- The eight current repositories are **frozen**. They receive only urgent fixes: a security
  risk, or a defect that blocks the operator's work.
- An urgent fix is made small in the current repository, then imported here the same day:

  ```bash
  git subtree pull --prefix=plugins/<name> https://github.com/LounisBou/<repository> main
  ```

  (`<repository>` is the plugin's former repository: `claude-<name>`, `claude-review` for
  `pr-review`.)
- Every other change is made here only.

## Using this repository before the cutover

A second host profile, so the two installs never share hooks or state:

```bash
CLAUDE_CONFIG_DIR=~/.claude-next claude
```

In that profile only, add this repository's catalogue and the official one, then install the
plugins from this one: implement depends on `superpowers` and pr-review requires
`pr-review-toolkit`, both from the official catalogue, which the host does not add by itself.
Sign in once in the profile: it shares no credentials with the main one. The
catalogue keeps the name `lounisbou` (decision 0001): the profile isolates it, and installed
names (`orchestrator@lounisbou`) never change. The profile's configuration is the `next`
branch of the operator's configuration repository, adapted as this program changes commands,
rules and practices.

## Stable: the cutover criteria

All of them, each with its evidence:

1. CI green on `main`, every plugin blocking on macOS and Linux (`ci/plugins.json`).
2. Every goal of `specs/program-design.md` met or ruled out by the operator.
3. Outcome evals measured, the orchestration at least as good as the current version on the
   same replayed pull requests.
4. One to two weeks of daily work in the `next` profile without a blocking incident.
5. A rehearsal on a copy of the operator's profile: a fresh install, and the migration of the
   existing state directories, both without loss.
6. No stale reference left in the configuration's `next` branch (below).

## What the operator's configuration must follow

The configuration repository stays outside this one; it is adapted on its `next` branch. The
inventory to keep current, by kind:

- **Enabled plugins**: each `@lounisbou` plugin, and the official ones that overlap them —
  an official PR review toolkit beside `pr-review`, `superpowers` beside `implement` and the
  orchestrator. Each overlap is kept or disabled by the operator's decision.
- **Permission rules**: the orchestrator's spawn rule is pinned to a versioned cache path and
  goes stale at each update; other rules name plugin scripts or tools (`dispatch-record.sh`,
  the tab close, `mcp__github__gh`, `bugs-bot:*`, the norms skills). Each follows the
  installer rules of `contracts.md`, and wide ones are narrowed.
- **Status line**: the command the statusbar installer writes.
- **Environment**: the orchestrator's variables (`ORCHESTRATOR_*`).
- **Personal hooks**: those overlapping a plugin's guard (commit attribution, background runs,
  sensitive files) are kept in one place, not both.
- **Instructions**: every command or tool the configuration's instructions name, and every
  rule they state that a plugin's method now states.

## The cutover

1. Merge the configuration's `next` branch.
2. In the main profile: remove the former catalogue, add this repository's, update every
   plugin, restart every session.
3. Archive the eight former repositories, each with a README pointing here.
