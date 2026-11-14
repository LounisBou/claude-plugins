# github

A Claude Code mod that talks to the GitHub API through one native tool and a PR
pane, over a Python 3.9+ standard-library engine. No third-party packages and no
npm dependencies in the mod: `gh` only supplies the GitHub token, unless
`GH_TOKEN` is set.

The tool, the commands and the pane need Claude Code v2.1.287 or later with
mods enabled (tested against 2.1.292). Where mods do not load (`claude -p`, an
older Claude Code), the `github-curl` skill runs the same engine from Bash.
`skills/github-curl/gh.py` stays as an entry point for plugins built on earlier
releases and runs `engine/gh.py` unchanged.

## Install

Add the marketplace, then install the plugin:

```
/plugin marketplace add LounisBou/claude-plugins
/plugin install github@lounisbou
```

Then run `/github:install`. When no GitHub token is found, it installs `gh` if it
is missing (Homebrew on macOS; on Linux the system package manager when it runs
without a password, otherwise the official release archive, checked against its published
sha256 checksum, into `~/.local/bin`) and starts `gh auth login --web`: the GitHub device page opens in the browser
and the command prints the one-time code to enter there. The token stays in the
system credential store where `gh` keeps it; the plugin never prints or writes
it. `/github:doctor` then confirms everything is ready.

## What you get

- **The `mcp__github__gh` tool** — pull requests, review threads, comments,
  reviews, labels, reviewers, issues, search and image attachments. Arguments
  travel as JSON, so multi-line markdown bodies (backticks, quotes, `$VAR`,
  CRLF) arrive byte-identical: the mod hands the request to `gh.py
  --stdin-json`, which maps it onto its own parser, refuses any argument that
  parser does not declare, and passes each body as a private temporary file it
  removes afterwards. Failures come back as `isError` with the
  engine's `error:` line; exit codes 1–5 are documented in
  `engine/REFERENCE.md`. Calls follow the session's permission rules: a
  `deny` rule refuses, reads run unless a rule asks, and every write asks
  first unless a rule or the permission mode allows it, leaving draft and a
  merge excepted (below). The dialog offers
  « Allow for this session », which covers that one command on that one
  repository until the session ends; it is never offered for `pr-merge` or
  `comment-delete`, nor where an explicit rule asks.
- **Writing rules enforced** — before a title, a description or a comment
  leaves the machine, the mod checks the mechanical rules of
  `engine/writing/`: no semicolon in prose (code spans, fenced blocks and
  URLs are not prose), no trailer of any kind (`Co-Authored-By`,
  `Signed-off-by`, `Claude-Session`, any `<word>-by`, `Change-Id`), a
  title on one line and within 72 characters, no heading in a PR description,
  every CVE id in a PR description a link to its advisory, and a security
  update's tables, one per advisory. A PR description ends with the four
  sections `TODO Staging`, `TODO Prod`, `PRs Dependency` and `Related PRs`, in
  that order, `none` where empty, with nothing after them, and carries no horizontal rule but the `---`
  between two screenshots, no other bold label (a screenshot's bold title, with
  no colon at its end, is none), and in its summary no pull request reference and no negative phrasing
  from a fixed list. The same rules hold for `gh pr create`, `gh pr edit`,
  `gh pr comment` and `gh pr review` run through Bash, their `--body-file` read,
  and for the engine's own subcommands run there (`python3 engine/gh.py
  pr-update 12 --body-file body.md`). A request the engine would read from
  stdin (`--stdin-json`) is refused from Bash, as nothing on the line shows it.
  A `--body` read from stdin or made by a command substitution other than a
  `$(cat <<'EOF' … EOF)` heredoc is left unchecked, as the hook cannot see it.
  A text that breaks one is refused with the rule, so it can be rewritten. A
  text the user typed in the prompt passes, and the same text sent again is
  put to the user. `pr-create` opens a draft unless the call says otherwise.
  Outside a repository in auto-merge (below), leaving draft (`draft: false`,
  `pr-ready`) is refused, never asked: it is the operator's, on GitHub after
  their review, a CI undraft aside (« Ready pull requests »); a merge
  (`pr-merge`) is always asked, whatever the rules allow. An existing
  description is replaced without asking, under the writing rules.
- **Ready and Not Ready labels** — `pr-readiness <pr> ready|not-ready` puts
  the `Ready` (`27e760`) or `Not Ready` (`8c1455`) label on a pull request and
  takes the other off, and `labels-ensure` creates both on a repository that
  lacks them. `pr-create` labels the new pull request (`Not Ready` for a draft,
  `Ready` otherwise) and `pr-ready` puts `Ready` on it. A label failure never fails the command it follows.
  `Ready` is the gate's: put by the module once the three hold (« Ready pull
  requests »), and refused by hand on a pull request that is not ready.
- **Auto-merge list** — `auto-merge-set` puts a repository in auto-merge or
  takes it out, on the operator's recorded answer, and `auto-merge-list`
  prints the list (below).
- **Deploy list** — `auto-deploy-set` grants a repository's deploy to one environment or
  withdraws it, on the operator's recorded answer, and `auto-deploy-list` prints
  the list (« Repositories in auto-deploy »).
- **`/checks [pr]`** — combined CI status of a PR, with the failed checks
  named, defaulting to the current branch's. It is the ready guard's verdict
  (« Ready pull requests »): a skipped check, or a neutral one on a draft, is
  `PENDING`, and the pane shows the same.
- **`/threads [pr]`** — the open review threads of a PR, as a markdown table.
- **`/prs`** — opens a pane listing every open PR: number, title and draft
  flag, plus CI state and comment count for the five newest, with a Refresh
  button. While it is open it reads the PRs again every minute and after each
  write through the tool, and a toast says when a PR's CI ends in success or
  failure.
- **`/github:protect [apply]`** — whether the default branch refuses a force-push and a
  deletion on GitHub itself (a ruleset, or the classic branch protection); `apply` puts
  the ruleset « protect the default branch » in place, administrators included.
- **`/github:install`, `/github:doctor`** — set up `gh` and its sign-in
  (install only), run the dependency diagnostic and name its exit code with no
  model turn; where mods do not load, the markdown commands run the same
  script.

The engine (`engine/gh.py` + `ghlib/`) is plain Python standard library; the
mod (`hooks/register.ts`) is TypeScript loaded directly by Claude Code — no
build step. Writing rules for commits, PR titles, descriptions and review
comments live in `engine/writing/`, one file per kind of text; the tool's description
points Claude at them.

Images are attached by committing them to a dedicated `pr-assets` branch
through the Contents API, named after the SHA-256 of their bytes so the same
screenshot uploads once. Only an image (PNG, JPEG, GIF or WebP, by its first bytes) is
uploaded. GitHub's own web upload endpoint would need
whole-account browser cookies; that route is deliberately not used.

## Repositories in auto-merge

No write is asked on a repository listed in `auto-merge.json`, in the
plugin's data directory: `$CLAUDE_PLUGIN_DATA` when the host sets it, else
`~/.claude/plugins/data/github-lounisbou/`.

```json
{ "repositories": ["owner/name"] }
```

Names compare without regard to case. The repository is the call's `repo`,
else `GH_REPO`, else the checkout's `origin`, the order the engine itself
follows. There, opening a pull request out of draft, `pr-ready`, a merge
and every other write run without a question, which ends agents held on a
dialog nobody answers in a repository that merges on its own. A deny rule
still refuses, an ask from an explicit rule still asks, and the writing
rules still apply. Elsewhere leaving draft is refused and every other write
is asked as before. An absent file
lists no repository; an unreadable or malformed one lists none either and
says so in one transcript line.

The list changes only through the tool, on the operator's word:
`auto-merge-set {"repo": "owner/name", "on": true|false, "words": "<their words>"}`
adds or removes a repository, under a lock on the file, when `words` names auto-merge (« auto-merge », « auto
merge » or « automerge ») and quotes their answer in a consent record of auto-merge on that
repository (core's `consent-record.ts`; the orchestrator writes them under
`<config dir>/consents/`), and `auto-merge-list` prints it. A Write, an Edit or a shell command
on the file is refused.

## Repositories in auto-deploy

A deploy is refused unless the repository is listed for its environment in `auto-deploy.json`,
beside `auto-merge.json` in the plugin's data directory. The file holds the grants and, per
repository, the commands that are its deploys:

```json
{
  "repositories": [{ "repo": "owner/name", "env": "dev|staging|prod" }],
  "commands": [
    { "repo": "owner/name", "kind": "command", "argv": ["composer", "deploy:api:prod"], "env": "prod" },
    { "repo": "owner/name", "kind": "script", "path": "scripts/deploy.sh" },
    { "repo": "owner/name", "kind": "workflow", "workflow": "deploy.yml", "input": "environment" },
    { "repo": "owner/name", "kind": "skill", "name": "deploy-staging", "env": "staging" }
  ]
}
```

A Bash line runs a deploy when one of its simple commands (those of a `bash -c` line included)
is a declared command: the first words of a `command`, a `script` by the end of its path, alone
or under an interpreter, its environment the later word that names one, a `gh workflow run` of
a `workflow`, its environment the value of its `input` field. A Skill call is a deploy when it
names a declared `skill`. The environment reads `dev`, `staging` or `prod` (`production` too).
A deploy the list does not grant, or whose call names no environment, is refused with one line
naming how the operator adds it. A path no repository declares is not read here: the host's own
protections stand behind it. The list only refuses; it never allows, so what is granted
still meets the host's permission decision. An absent file grants nothing, and an unreadable or
malformed one declares nothing and says so in one transcript line.

The file changes only through the tool, on the operator's word:
`auto-deploy-set {"repo": "owner/name", "env": "dev|staging|prod", "on": true|false, "words": "<their words>", "commands": [...]}`
grants or withdraws one environment under a lock on the file, when `words` names auto-deploy
(« auto-deploy », « auto deploy », « autodeploy », « auto-déploiement ») and quotes their answer
in a consent record of auto-deploy on that repository and environment (core's `consent-record.ts`). `commands` adds declarations for the repository
(`repo` implied) and needs the same words; the tool never removes one. `auto-deploy-list` prints
each granted environment. A Write, an Edit or a shell command on the file is refused.

## Ready pull requests

A pull request is ready when three things hold at its current head commit: a
clean review, passed end-to-end tests (or the operator's waiver) and green
CI, but for what the pull request's check plan does not
require. A norms check is on demand: it blocks only when it ran at the head and
failed. The `Ready` label, leaving
draft and a merge need the three; a draft opens with `Not Ready`, and a push to
the branch puts `Not Ready` back. A rebase that leaves the pull request's own
commits unchanged carries its review and norms check to the new head; an E2E waiver stands for every later head. CI is read from GitHub: no check at all is
green, a check that failed, still runs, was skipped, or is neutral on a draft
is not. The others are records, one small JSON file per run under
`${CLAUDE_CONFIG_DIR:-~/.claude}/pr-records/<owner>/<name>/<head>/`, written by
their producers, which the record contract (core's `pr-record.ts`) declares:
pr-review's auto-fix-loop for the review, `/norms:check` for the norms, and
`mcp__github__record` for the end-to-end run. A review record written by the
session that pushed the head is refused. A record counts only at the head it names, so a new commit voids them
all without anything deleted. `engine/REFERENCE.md` « Records » holds the
contract; `engine/writing/pull-requests.md` « Ready pull requests » the rule.

The module puts `Ready` itself: after a record is written, and after a
`pr-gate` or `pr-checks` read through the tool, it reads the three at the head
and puts `Ready` when they hold, or `Not Ready` back on a pull request that
carries `Ready` and no longer holds them, with one line of its own. That label
is the gate's act, not the session's, though a read brought it about. The head
is read again just before the label is written: a head that moved gets none.
`pr-gate`'s answer stays JSON, with the labels the gate left. A CI that turns
green after the last record is followed by the next read of the gate; the
orchestrator makes one when its CI watch says green, the call printed on its
green line.

When the CI does not run on a draft, the pull request leaves draft for it,
still `Not Ready`, as long as no check of its head has passed. Outside
auto-merge, once the three hold the gate puts back to draft only a pull request
the plugin itself took out of draft for its CI (a mark kept in the data directory),
then puts `Ready`; one the operator took out of draft keeps its place. That undraft
runs in every repository, with one transcript line:

```
github: <owner/name>#<n> out of draft to run CI, still Not Ready
```

This release ships the ready guard in its warn phase: an act that is not ready,
the `Ready` label aside, goes ahead with one transcript line and one JSON line in `guard-warn.log`, in
the plugin's data directory. `CLAUDE_GITHUB_READY_ENFORCE=1` in the
environment brings the enforce phase forward, where it is refused.

## Guards

**Ready.** Taking a pull request out of draft and merging it
(`gh pr merge --auto` included) need the three conditions above, through the tool
(`pr-ready`, `pr-merge`) and through the
shell (`gh pr ready`, `gh pr merge`, `gh api` on a pull request's merge, and the
engine's own subcommands, `python3 engine/gh.py pr-merge 12 --repo owner/name`).
Under enforce
the act is refused before anyone is asked, and a pull request still carrying
`Ready` goes back to `Not Ready`:

```
github: <act> refused on <owner/name>#<n> at <head7>: not ready. Missing: <item>, <item>. A pull request is ready when a clean review, passed E2E and green CI are all at its current head (engine/writing/pull-requests.md « Ready pull requests »).
```

Under warn the act goes ahead with `github: <act> on <owner/name>#<n> is not
ready, let through while the guard only warns. Missing: <item>`. A pull request
opened out of draft in the shell outside auto-merge is refused in both phases, as
`gh pr ready` is, and anywhere under enforce with `github: <act> refused: open it
as a draft, then leave draft once ready.`, and a readiness GitHub did not answer
with `github: readiness of <owner/name>#<n> unverified: <error>`. Going back to
draft always passes, and `gh pr create --draft` and `gh pr ready --undo` put
`Not Ready` on, as the tool does. A merge, an undraft or a `Ready` label in the
shell names its repository, else under both phases (the label under enforce
only) it is refused with `github: <command> refused: name the repository with -R
owner/name.`; a GraphQL merge or undraft names none and is always refused, with
the tool call to run instead.

**Auto-merge split.** In the shell, a merge or leaving draft runs only in a
repository listed in `auto-merge.json`, and the ready guard applies on top.
Elsewhere it is refused in both phases, so the operator is asked in the
conversation through the tool:

```
github: <gh pr merge | gh pr ready> refused on <owner/name>: this repository is not in auto-merge, so a merge or leaving draft needs the operator's explicit word. When they gave it, run mcp__github__gh <pr-merge | pr-ready> {"pr": <n>} on <owner/name>: it checks that the pull request is ready, then asks them in the conversation.
```

A CI undraft, as above, is the exception, through the shell and the tool alike.

**Records.** The records are written by their producers alone. A Write, an Edit,
a MultiEdit or a NotebookEdit under the records root, and a shell command that names it,
a `pr-records/` path or `engine/record.py`, are refused with:

```
github: records are written by their producers' tools, and E2E by mcp__github__record, never by hand.
```

The command is read as text and word by word with the shell's quotes removed (so
`rec""ord.py` is `record.py`), and a plain `ls` of the root is refused too; reading
a record with the Read tool passes. `mcp__github__record` writes at the head the
checkout and the pull request share, on a clean tree, one kind per caller: E2E
for a session, each other kind for the plugin the record contract names its
producer. The waiver's rule is in `engine/REFERENCE.md`, « Records ». Once a
day at most, the start of a session prunes the head directories whose newest
record is older than 90 days.

## Tests

Two suites, both offline — no network, no account:

```
bash tests/run-tests.sh        # the Python engine, served from fixtures
claude plugin test             # the mod, with stubbed process/fs/ui calls
```

## Licence

MIT.
