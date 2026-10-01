# claude-statusbar

A two-line status bar for your terminal coding agent. No network, no state, no
credentials.

```
geonative-api │ ⎇ main* ↑1↓2 {3} │ a-model │ Fix the status bar…
ctx: 26% │ 5h: 47% ▓▓▓▓▓░░░░░ → 2h13 │ 7d: 50% ▓▓▓▓▓░░░░░ → 3d │ +649/-167
```

**Line 1** — current directory · enriched git branch · open PR · model · session name
**Line 2** — context consumed · 5-hour quota · 7-day quota · lines added/removed

## Install

### From the plugin marketplace

```
/plugin marketplace add LounisBou/claude-statusbar
/plugin install claude-statusbar@lounisbou
/claude-statusbar:install
```

The `lounisbou` marketplace also lists [claude-orchestrator](https://github.com/LounisBou/claude-orchestrator), installable the same way once the marketplace is added.

That last step is required: `statusLine` is a key in `settings.json` and a
plugin manifest cannot declare it. The command writes it for you.

### Without the plugin system

```bash
git clone https://github.com/LounisBou/claude-statusbar.git
cd claude-statusbar && ./install.sh
```

`./install.sh --dry-run` shows what would happen without changing anything.

Restart your session to see the bar.

## Requirements

- `jq` — the stdin payload is parsed in a **single** `jq` call (each fork costs
  ~5 ms and the bar is rendered continuously)
- `bash` — compatible with bash 3.2, the version macOS ships
- `git` optional — without it the branch segment is simply absent

## Settings

`~/.claude/statusline-config.txt`, one key per line, `1` or `0`:

| Key | Default | Effect |
|---|---|---|
| `SHOW_DIRECTORY` | 1 | current directory name |
| `SHOW_BRANCH` | 1 | git branch |
| `SHOW_GIT_STATUS` | 1 | `*` when dirty, `↑n↓n` ahead/behind, `{n}` stashes |
| `SHOW_PR` | 1 | number and state of the open PR |
| `SHOW_MODEL` | 1 | model name |
| `SHOW_SESSION_NAME` | 1 | session name set with `/rename` |
| `SHOW_CONTEXT` | 1 | context consumed, turns red at ≥ 80% |
| `SHOW_CONTEXT_TOKENS` | 1 | tokens next to the context percentage (`296k`, or `296k/300k` against the gate in an orchestration session) |
| `SHOW_USAGE` | 1 | 5-hour quota |
| `SHOW_SEVEN_DAY` | 1 | 7-day quota |
| `SHOW_PROGRESS_BAR` | 1 | ten-block bar |
| `SHOW_RESET_TIME` | 1 | reset deadline |
| `RESET_COUNTDOWN` | 1 | `1` = `2h13`, `0` = absolute time/date |
| `SHOW_LINES_CHANGED` | 1 | `+added/-removed` |

Or in session: `/claude-statusbar:config hide the session name`

## Migrating from a session-cookie install

**If your status bar keeps asking for a web session cookie on every start,
`install.sh` fixes that.**

An earlier generation of this script fetched the 5-hour quota by calling the
vendor's web API with a session cookie, and a `SessionStart` hook reopened an
input dialog as soon as that cookie looked dead. Two facts make the whole
arrangement obsolete:

1. **The data is native.** The host puts `rate_limits.five_hour` and
   `rate_limits.seven_day` straight into the JSON it sends to the status line
   on stdin, with `resets_at` as a Unix epoch. No secret is needed.

2. **The validity check could never have worked.** That web API sits behind a
   bot challenge: it answers `HTTP 403` carrying `cf-mitigated: challenge` to
   any non-browser client — **with a valid cookie exactly as with a bogus
   one**. The code treated `403` as `401`, i.e. "session expired". The verdict
   was structurally always the same, the cookie was never actually evaluated,
   and the dialog came back indefinitely. The giveaway symptom: clicking
   "Cancel" breaks nothing, because the quotas had already stopped depending
   on that cookie.

`install.sh` strips the offending `SessionStart` hook from `settings.json`
(preserving every other hook) and **moves** — never deletes — the fetcher
script, the credentials file and the associated cache files into
`~/.claude/backups/statusbar-<timestamp>/`.

That folder holds your old session cookie. Delete it whenever you like, and
revoke the cookie by signing out on the web if it matters to you.

## How it works

Every value comes from the JSON payload the host sends on stdin. The only
external command is a single
`git status --porcelain=v2 --branch --show-stash`, which yields branch,
cleanliness, ahead/behind and stash count in one shot.

Two implementation details are worth knowing before editing the script:

- **The jq field separator is `0x1F`, not a tab.** Tabs belong to IFS
  *whitespace*: bash collapses consecutive tabs, so two empty fields in a row
  would silently shift every field after them.
- **`current_dir` is read last.** `read` assigns the remainder of the line to
  its final variable, so a missing field elsewhere cannot corrupt it.

The quota shows `Usage: ~` while `rate_limits` is absent: that field only
appears after the session's first API response, and only for subscription
accounts.

## Tests

```bash
./tests/run-tests.sh
```

15 cases, no network: nominal render, missing or partial quotas, context
warning threshold, the consecutive-empty-fields regression, disabled settings,
clean/dirty/absent git repository, empty or invalid stdin, plus a check that no
session cookie and no network call survive anywhere — including under a
pristine `HOME`.

If another tool has wrapped `statusLine.command` around this status bar's
script, install and uninstall leave that wrapper in place — install skips
the write when the command already carries our path, and uninstall strips
only our path, never the whole key.

## Uninstall

```bash
./uninstall.sh          # or /claude-statusbar:uninstall
```

## License

MIT
