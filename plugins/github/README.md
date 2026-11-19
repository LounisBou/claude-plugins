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
  first unless a rule or the permission mode allows it, a merge excepted (below). The dialog offers
  « Allow for this session », which covers that one command on that one
  repository until the session ends; it is never offered for `pr-merge` or
  `comment-delete`, nor where an explicit rule asks.
- **Writing rules refused** — `pr-create` and `pr-update`, through the tool or
  `engine/gh.py` run from Bash, refuse a title or a description that breaks a
  mechanical rule of `engine/writing/` and send nothing, the refusal naming each
  rule: no semicolon in prose (code spans, fenced blocks and URLs are not prose),
  no trailer of any kind (`Co-Authored-By`, `Signed-off-by`, `Claude-Session`,
  any `<word>-by`, `Change-Id`), a title on one line and within 72 characters,
  no heading in a description, every CVE id a link to its advisory, and a
  security update's tables, one per advisory. No description carries a
  horizontal rule but the `---` between two screenshots, nor a negative phrasing
  of `engine/negative-phrases.json` in its summary. In a GeoNative repository
  (owner `geonativefr`) a description also ends with the four sections
  `TODO Staging`, `TODO Prod`, `PRs Dependency` and `Related PRs`, in that
  order, `none` where empty, with nothing after them, carries no other bold
  label (a screenshot's bold title, with no colon at its end, is none), and has
  no pull request reference in its summary. A request the engine would read from
  stdin (`--stdin-json`) is refused from Bash, as nothing on the line shows it.
  `pr-create` opens a
  draft unless the call says otherwise. Opening out of draft (`draft: false`)
  goes through; outside a repository in auto-merge (below), leaving draft
  (`pr-ready`) is the operator's act on GitHub after their review, and it is asked
  as any write no rule allows, the readiness gate refusing a pull request whose CI is
  not green or whose record failed (« Ready pull requests »); a merge
  (`pr-merge`) is asked outside auto-merge, whatever the rules allow, and runs inside it once
  the gate lets it. An existing
  description is replaced without asking, under the writing rules.
- **Ready and Not Ready labels** — `pr-readiness <pr> ready|not-ready` puts
  the `Ready` (`27e760`) or `Not Ready` (`8c1455`) label on a pull request and
  takes the other off, and `labels-ensure` creates both on a repository that
  lacks them. `pr-create` labels the new pull request (`Not Ready` for a draft,
  `Ready` otherwise) and `pr-ready` puts `Ready` on it. A label failure never fails the command it follows.
  `Ready` is the gate's: put by the module once the pull request is ready (« Ready pull
  requests »). `pr-readiness <pr> ready` puts it only on a pull request the gate reads
  ready, through the check `pr-ready` and `pr-merge` run, and otherwise answers, with no error,
  the label the pull request carries and what is missing.
- **Auto-merge list** — `auto-merge-set` puts a repository in auto-merge or
  takes it out, on the operator's quoted, dated words, and `auto-merge-list`
  prints the list (below).
- **Deploy list** — `auto-deploy-set` grants a repository's deploy to one environment or
  withdraws it, on the operator's quoted, dated words, and `auto-deploy-list` prints
  the list (« Repositories in auto-deploy »).
- **`/checks [pr]`** — combined CI status of a PR, with the failed checks
  named, defaulting to the current branch's. It is the ready guard's verdict
  (« Ready pull requests »), `pr-gate`'s `ci.result`. The pane reads the head's rollup instead, so it can
  differ from that verdict.
- **`/threads [pr]`** — the open review threads of a PR, as a markdown table.
- **`/prs`** — opens a pane listing the open PRs (the newest 100): number, title and draft
  flag, CI state and comment count, with a Refresh button, all read in one GraphQL query
  (`pr-panel`). While it is shown it reads the PRs again every five minutes and after each
  write through the tool, and a toast says when a PR's CI ends in success or failure. A pane
  that is not shown (behind another tab, or waiting undrawn) reads nothing; it reads once
  when it shows again if its rows are older than five minutes or a write made them stale.
- **`/github:protect [apply] [ci]`** — whether the default branch refuses a force-push and a
  deletion on GitHub itself (a ruleset, or the classic branch protection); `apply` puts
  the ruleset « protect the default branch » in place, administrators included. `ci` also
  reads, or with `apply` requires, the status check core's readiness contract names
  (`conditions.ci.check`), so GitHub refuses a merge until it is green; a check the ruleset
  already requires stays when it is rewritten. Apply `ci` only once the workflow's job of that
  name runs on the default branch: a required check no job reports blocks every pull request.
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
rules still apply. Elsewhere leaving draft is asked, and every other write
is asked as before. An absent file
lists no repository; an unreadable or malformed one lists none either and
says so in one transcript line.

The list changes only through the tool, on the operator's word:
`auto-merge-set {"repo": "owner/name", "on": true|false, "words": "« <his words> », <their date>"}`
adds or removes a repository, under a lock on the file, when `words` quote the operator with their
date, as a waiver's `detail` does, and `auto-merge-list` prints it. A Write, an Edit or a shell command
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
`auto-deploy-set {"repo": "owner/name", "env": "dev|staging|prod", "on": true|false, "words": "« <his words> », <their date>", "commands": [...]}`
grants or withdraws one environment under a lock on the file, when `words` quote the operator with
their date. `commands` adds declarations for the repository (`repo` implied); the tool never removes
one. `auto-deploy-list` prints
each granted environment. A Write, an Edit or a shell command on the file is refused.

## Ready pull requests

What Ready needs at a head, who holds each condition and what a new head voids are core's
readiness contract (`core/readiness.ts`); the gate computes it there (`missingEvidence`). The
records are small JSON files under
`${CLAUDE_CONFIG_DIR:-~/.claude}/pr-records/<owner>/<name>/<head>/`, written by the producers
core's `pr-record.ts` declares; a review record written by the session that pushed the head is
refused (the pushed heads are kept on disk, `pushed-heads/`); an E2E pass or fail is computed from a
run the record tool performs (`run`) or observed in the session's Bash calls (`ran`); with neither, or a `ran` not seen,
it is written marked `stated, not computed`, and observed. `engine/REFERENCE.md` « Records » holds the record contract.

The module puts `Ready` itself: after a record is written, and after a
`pr-gate` or `pr-checks` read through the tool, it reads readiness at the head, CI included,
and puts `Ready` when nothing is missing, or `Not Ready` back on a pull request that
carries `Ready` and no longer is ready, with one line of its own. That label
is the gate's act, not the session's, though a read brought it about. The head
is read again just before the label is written: a head that moved gets none.
`pr-gate`'s answer stays JSON, with the labels the gate left. A CI that turns
green after the last record is followed by the next read of the gate; the
orchestrator makes one when its CI watch says green, the call printed on its
green line.

When the CI does not run on a draft, the pull request leaves draft for it,
still `Not Ready`, as long as no check of its head has passed. The gate never puts
a pull request back to draft: once out of draft, for its CI or by the operator, it stays out, and
`Ready` lands on it as it stands. That undraft runs in every repository, with one transcript line:

```
github: <owner/name>#<n> out of draft to run CI, still Not Ready
```

### Stacked pull requests: the light CI

A stacked pull request, whose base is the head branch of another open pull request (neither
the default branch nor a protected one, so a release pull request's head is no stacked base),
often runs no CI at all: most workflows filter their pull requests on `main`, `develop` or
`staging`. Such a pull request is ready on its review; in a repository where the operator
configured light CI, also on a `tests` record passed at its head or its checks green there, which
stand over a failed run. A failed check blocks it. The bottom pull
request keeps the full CI. A `tests` record of an earlier head of the same diff carries, as the
other kinds do.

The record is written by the **`mcp__github__light_ci`** tool alone, never by
`mcp__github__record` nor by a waiver:

- `{"action": "run", "pr": <n>, "dir"?}` checks that the checkout is the pull request's head and
  clean, runs the repository's `prepare` then `command` (argument lists, no shell, under a
  timeout, `{base}` replaced by the merge base for a tests-impact command such as
  `npx jest --changedSince={base}`), and records `pass` or `fail` with the command, its time and
  its test count. The tool stops at 570 seconds, the host's limit, and records nothing then: a
  command that needs longer is no light CI.
- `{"action": "status", "repo"?}` answers in one line what the repository's file holds.

Each repository's command lives outside the repository, in
`${CLAUDE_CONFIG_DIR:-~/.claude}/light-ci/<owner>-<name>.json`:

```json
{ "command": ["vendor/bin/pest", "--parallel", "--compact"],
  "prepare": ["docker", "compose", "up", "-d", "--wait", "mysql", "redis"],
  "timeoutSeconds": 600,
  "decided": { "at": "2026-11-14T18:30:00Z", "words": "<the operator's answer>" } }
```

or, for a repository where the operator refused it, `{ "off": "<his words>", "at": "…" }`. With
no file, or that refusal, its stacked pull requests are ready on their review alone, and the
`Ready` line says so. The gate reads that key alone, never the command.

## Guards

**Ready.** Taking a pull request out of draft and merging it
(`gh pr merge --auto` included) meet the gate, which puts the `Ready` label itself
just before the act when the whole contract holds at the head, CI green included (a check the base
branch requires that has not reported at the head yet is not green), through the tool (`pr-ready`, `pr-merge`) and through the
shell (`gh pr ready`, `gh pr merge`, `gh api` on a pull request's merge, and the
engine's own subcommands, `python3 engine/gh.py pr-merge 12 --repo owner/name`).
An act that misses only records absent at the head (`<kind>: no record at <head7>`) goes through
without `Ready`. On anything else missing (CI not green, a
record that failed at the head) the act is refused before anyone is asked, and a pull request still carrying
`Ready` goes back to `Not Ready`:

```
github: <act> refused on <owner/name>#<n> at <head7>: not ready. Missing: <item>, <item>. What Ready needs is core's readiness contract (core/readiness.ts).
```

A pull request opened out of draft is not gated, and a
readiness GitHub did not answer is refused with `github: readiness of <owner/name>#<n> unverified: <error>`. Going back to
draft (`pr-draft`, `gh pr ready --undo`) always passes and moves no label, and the gate never does it: Ready follows the records at the
head, never the draft state; `gh pr create --draft` puts `Not Ready` on the new pull request. A merge or an undraft in the
shell names its repository, else it is refused with `github: <command> refused: name
the repository with -R owner/name.`; a GraphQL merge or undraft names none and is
always refused, with the tool call to run instead.

**Auto-merge split.** In the shell, a merge runs only in a
repository listed in `auto-merge.json`, and the ready guard applies on top.
Elsewhere it is refused, so the operator is asked in the
conversation through the tool (leaving draft there meets the ready guard):

```
github: gh pr merge refused on <owner/name>: this repository is not in auto-merge, so a merge needs the operator's explicit word. When they gave it, run mcp__github__gh pr-merge {"pr": <n>} on <owner/name>: it checks that the pull request is ready, then asks them in the conversation.
```

A CI undraft, as above, is the exception, through the shell and the tool alike.

**Records.** The records are written by their producers alone. A Write, an Edit,
a MultiEdit or a NotebookEdit under the records root, and a shell command that names it,
a `pr-records/` path or `engine/record.py`, go through; a shell command that deletes in them (`rm`, `unlink`, `find -delete`, a `mv` out
of them, an interpreter's `os.remove`) stays refused, a deletion being irreversible:

```
github: records are written by their producers' tools, and E2E by mcp__github__record, never by hand.
```

The command is read as text and word by word with the shell's quotes removed (so
`rec""ord.py` is `record.py`).
`mcp__github__record` writes at the head the
checkout and the pull request share, on a clean tree, one kind per caller: E2E
for a session, each other kind for the plugin the record contract names its
producer. The waiver's rule is in `engine/REFERENCE.md`, « Records ». Once a
day at most, the start of a session prunes the head directories whose newest
record is older than 90 days.

## Observed guards

The guards of this module refuse only what cannot be taken back: a merge, the auto-merge and deploy
lists, a deploy, a deletion of the records, of the E2E exemptions or of the check plans, a pull request
whose CI is not green or whose record failed (the gate every merge and undraft meets), a readiness that cannot be read. Every other guard observes: the call goes through and one refusal
event is written into the module's journal (`<config dir>/github/journal/`, core's learning
contract, under the guard's stable code), with no command or text in it. A journal that cannot be
written is one line in the transcript, and the call still goes through.

| Code | A call that |
|---|---|
| `github.exemption.write` | writes an E2E exemption or a check plan by hand |
| `github.record.e2e-stated` | records an E2E pass or fail with no run the tool performed or observed |

A refusal that protects something writes one refusal event too, under its own code (`REFUSED` in
`hooks/observe.ts`): `github.ready.held` (the Ready gate), `github.auto-merge.*` and `github.auto-deploy.*`
(the lists and their tools), `github.deploy.unlisted`, `github.records.delete`, `github.exemption.delete`,
`github.net.blocked`, and `github.record.*` for each refusal of `mcp__github__record`. A refusal that only
asks for a missing or malformed argument writes none.

## Tests

Two suites, both offline — no network, no account:

```
bash tests/run-tests.sh        # the Python engine, served from fixtures, then the mod's tests
claude plugin test             # the mod alone, with stubbed process/fs/ui calls
```

## Licence

MIT.
