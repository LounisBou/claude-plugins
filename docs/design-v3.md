# Status line v3 — approved design

> **Archive document.** The original design spec, kept for the reasoning it
> records. The paths it cites (`~/.claude/statusline-command.sh`) have changed
> since the extraction into a plugin — see the README.

Date: 2026-07-28 · Status: approved, implementation followed immediately.

## Goal

Extend `~/.claude/statusline-command.sh` (2 lines, stateless, bash 3.2, ~45 ms)
with: context percentage + compaction warning, enriched git state, session
name, reset countdowns, changed lines.

## Target

```
geonative-api │ ⎇ main* ↑1↓2 {3} │ PR #1424 ⋯ │ a-model │ Fix the status l…
ctx: 26% │ 5h: 47% ▓▓▓▓▓░░░░░ → 2h13 │ 7d: 50% ▓▓▓▓▓░░░░░ → 3d │ +649/-167
```

## Line 1

- Enriched git state attached to the branch: yellow `*` when the worktree is
  dirty (untracked included), `↑n ↓n` against upstream (hidden with no
  upstream), gray `{n}` for stashes (hidden at 0). A single call:
  `git status --porcelain=v2 --branch --show-stash` (replacing the current two
  calls, rev-parse + branch).
- Session name (`session_name`) in gray, truncated at 24 characters + `…`,
  hidden when absent.

## Line 2

- `ctx: N%` first (`context_window.used_percentage`) — existing gradient; at
  ≥ 80% (the auto-compaction threshold): red `⚠ ctx: N%`. Hidden when absent.
- Countdown instead of clock times: `→ 2h13` / `→ 47m` (5h), `→ 3d` rounded to
  the nearest day, or `→ 5h12` when under 24 h (7d). `RESET_COUNTDOWN=0`
  restores the previous time/date format.
- `+A/-R` (green/red) at the end of the line
  (`cost.total_lines_added/removed`), hidden at 0/0.
- The `Usage: ~` fallback is unchanged: only when no quota window exists.

## Settings (new toggles, default 1)

`SHOW_CONTEXT`, `SHOW_CONTEXT_TOKENS` (tokens beside the percentage, against the
gate in an orchestration session), `SHOW_GIT_STATUS` (the `*↑↓{}` extras only — `SHOW_BRANCH`
still governs the whole segment), `SHOW_SESSION_NAME`, `SHOW_LINES_CHANGED`,
`RESET_COUNTDOWN`.

## Constraints held

- A single jq call — 4 fields added to the array, `cur_path` stays in last
  position (protected by the 0x1F separator).
- Stateless, no network, bash 3.2 (no nameref, no `local -n`).
- Missing field → hidden segment, never a field shift.

## Tests

Non-regression: the 6 existing payloads. New cases: ctx 79/80/100, resets at
47 min / 3 h / 26 h / 6 d, repository with no upstream, 0/n stashes,
clean/dirty worktree, unnamed session, long accented names (multibyte
truncation), all under `/bin/bash` 3.2.
