# Migration and cutover

The operator installs from this repository's catalogue, `lounisbou`, in their own profile; the
second host profile first planned (`~/.claude-next`) was left (`specs/program-design.md`, goal 2).
This file says how the former repositories are kept from diverging, what « stable » means, and
what the cutover changes.

## Until the cutover: one line of development

- The eight current repositories are **frozen**. They receive only urgent fixes: a security
  risk, or a defect that blocks the operator's work.
- An urgent fix is made small in the current repository, then imported here the same day, in
  a pull request whose commit names the former repository's commits. Where the plugin's code
  here still matches, the fix is applied as a patch:

  ```bash
  git -C <former checkout> diff <last imported> <merged> --binary \
    | git apply --index --directory=plugins/<name>
  ```

  Where this repository has moved on, the fix's intent is re-implemented on the current
  design, with its tests. (`<former checkout>` is the plugin's former repository:
  `claude-<name>`, `claude-review` for `pr-review`.)
- Every other change is made here only.

## Stable: the cutover criteria

All of them, each with its evidence:

1. CI green on `main`, every plugin blocking on macOS and Linux (`ci/plugins.json`). Not met:
   drift blocks on Linux only.
2. Every goal of `specs/program-design.md` met.
3. Outcome evals measured, the orchestration at least as good as the current version on the
   same replayed pull requests.
4. A rehearsal on a copy of the operator's profile: a fresh install, and the migration of the
   existing state directories, both without loss.
5. No stale reference left in the operator's configuration (below).

Where each stands is row 17 of « State on main » in `specs/program-design.md`.

## What the operator's configuration must follow

The configuration repository stays outside this one; it was adapted on its own branch, since
merged (claude-code#43). The
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

1. Merge the configuration's branch. Done (claude-code#43).
2. On each machine: remove the former catalogue, add this repository's, update every
   plugin, restart every session. Done on the MacBook; not recorded for IznoServer.
3. Archive the eight former repositories, each with a README pointing here.
