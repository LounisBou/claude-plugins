# gh.py reference

## Calling

The mod's `mcp__github__gh` tool runs this CLI: each `command` is a subcommand
below, and the `args` object holds the subcommand's arguments.

- Positional arguments go by their documented name: `pr-checks` → `{"pr": 12}`,
  `file-at-ref` → `{"path": "a.txt", "ref": "HEAD"}`. Variadic positionals
  (`label...`, `user...`, `term...`, `file...`) take an array.
- Every other key must be one of the subcommand's own `--flag`s, spelled out
  whole: `{"branch": "x"}` → `--branch x`, `{"format": "pr-number"}` →
  `--format pr-number`, `{"draft": true}` → `--draft`. An unknown or abbreviated
  key is refused.
- Text bodies go in `"body"` as a plain string — gh.py writes it to a private
  temporary file, passes `--body-file` and removes it afterwards; the bytes
  travel unchanged. Inline-comment arrays go in `"comments"`
  (`--comments-file`), and `comments-resolved-batch` takes `"nodes"` (an array
  of node ids). `body-file`, `comments-file` and `json_file` are refused.

The tool sends `{"command", "args", "repo"}` to `gh.py --stdin-json`, which
builds the argument vector from its own parser.

Example:

```json
{ "command": "pr-comment", "args": { "pr": 12, "body": "Multi-line `markdown`" } }
```

`repo` (`owner/name`) overrides the `origin` remote.

Before writing a text, read its rules in `writing/` beside this file.

## Subcommands

### Pull requests

| Subcommand | Arguments | Description |
|---|---|---|
| `pr-get` | `[--branch B \| --pr N]` | The PR for a branch, defaulting to the current one, or PR `N` (`{"pr": N}` through the tool). Both answer a list of one PR. An unknown number exits 4 |
| `pr-list` | | Open PRs |
| `pr-status` | `<pr>` | State, draft flag, head and base |
| `pr-checks` | `<pr>` | Combined commit status and check runs |
| `pr-gate` | `<pr>` | `{"repo", "pr", "state", "draft", "head", "labels", "ci": {"result", "failed", "running", "skipped", "total"}}`, the reads the ready guard decides on (below) |
| `pr-diff` | `<pr>` | Unified diff as plain text |
| `pr-files` | `<pr>` | Changed paths with their patches, paginated |
| `pr-commits` | `<pr>` | Commits on the PR, paginated |
| `file-at-ref` | `<path> <ref>` | A file's contents at a ref |
| `pr-create` | `--title T [--body-file P] [--base B] [--head H] [--draft]` | Open a PR from the current branch, `--draft` for a draft (the house default). A draft gets the `Not Ready` label, any other PR the `Ready` one. A label failure is printed as an `error:` line on stderr and does not fail the command |
| `pr-merge` | `<pr> [--method merge\|squash\|rebase] [--sha SHA]` | Merge a PR, optionally pinned to the head that was verified |

`pr-gate` makes three REST reads: the pull request, the combined status and the check
runs at its head (`per_page=100`). `state` is `open`, `closed` or `merged`, `head` the
full sha, `labels` the names it carries. `ci.total` counts the check runs plus the
commit statuses at that head. `ci.result` is `FAILURE` when one failed (`ci.failed`
names them), `PENDING` when one still runs (`ci.running` counts them) or when one
proved nothing: `skipped`, or `neutral` on a draft (`ci.skipped` names them), and
`SUCCESS` otherwise, no check at all included. A check that was skipped never turns green
by itself: it reads `PENDING` for as long as it stays skipped, in `checks-status` as in
`pr-gate`.

`file-at-ref` returns `content`, plus `binary`. When the file is not valid UTF-8,
`binary` is true and `content` holds base64 — the bytes are never decoded lossily.

`pr-merge --sha <full sha>` sends the head that was verified, and GitHub refuses the merge
if the head has moved since.
`--match-head-commit` takes the full sha read by `git rev-parse` or `headRefOid`, never
copied from a short form or completed by hand.

A PR that GitHub counts as part of a stack refuses the synchronous merge with a 403, so
`pr-merge` then uses the asynchronous merge endpoint with the same method (and the same sha
when `--sha` is given) and reads the PR until it is merged, for at most `GH_MERGE_WAIT`
seconds (default 60). It prints the merge commit sha, or exits 3 naming the request's uuid
if the merge fails or is not seen in time. Any other error is reported as it is.

### Review threads and comments

| Subcommand | Arguments | Description |
|---|---|---|
| `pr-threads` | `<pr>` | All review threads (GraphQL) |
| `pr-comments` | `<pr>` | Inline review comments, paginated |
| `pr-issue-comments` | `<pr>` | General PR comments, paginated |
| `pr-reviews` | `<pr>` | Review bodies, paginated |
| `thread-reply` | `<thread_id> --body-file P` | Reply inside a review thread |
| `pr-comment` | `<pr> --body-file P` | Post a general PR comment |
| `comment-edit` | `<comment_id> --body-file P` | Edit a comment |
| `comment-delete` | `<comment_id>` | Delete a comment |
| `thread-resolve` | `<thread_id>` | Resolve a review thread |
| `comment-resolve` | `<node_id>` | Minimise any minimizable node (issue comment, review body, commit comment) |
| `comment-unresolve` | `<node_id>` | Restore a minimised node |
| `comment-resolved` | `<node_id>` | Whether a node is minimised |
| `comments-resolved-batch` | `<json_file>` | The same check for a JSON array of node ids |

### Reviews

| Subcommand | Arguments | Description |
|---|---|---|
| `review-submit` | `<pr> --event COMMENT\|APPROVE\|REQUEST_CHANGES [--body-file P] [--comments-file P]` | Submit a review |

`--comments-file` holds a JSON array of `{path, line, side, body}` objects.
`APPROVE` may carry no body; the other two events need a body or inline comments.

### Pending reviews

A review left PENDING is invisible to the PR author until its owner submits it on
GitHub. The tool opens one, adds to it and reads it back. It never submits one:
submitting is the operator's act, on GitHub.

| Subcommand | Arguments | Description |
|---|---|---|
| `review-pending-create` | `<pr> --comments-file P` | Open a review left PENDING with inline comments; refuses if the token's user already has one on the PR |
| `review-pending-add` | `<pr> --review-id ID --path P --line N [--start-line N] --body-file P` | Add an inline thread to the token user's PENDING review (GraphQL `addPullRequestReviewThread`) |
| `review-pending` | `<pr> [--author LOGIN]` | The PENDING review of a user (default: the token's) with its comments |
| `repo-review-comments` | `[--author LOGIN] [--limit N]` | The newest review comments of the repository (one page), filtered on a login, default limit 30 |

`--comments-file` holds a non-empty JSON array of `{path, line, body}` objects; `side`
defaults to `RIGHT`, a range adds `start_line` (below `line`) and `start_side` (defaults
to `RIGHT`). `commit_id` is the PR head, read by the tool. The request carries no
`event`, which is what keeps the review pending.

### Metadata

| Subcommand | Arguments | Description |
|---|---|---|
| `pr-update` | `<pr> [--title T] [--body-file P] [--base B] [--state open\|closed]` | Change a PR's fields |
| `pr-ready` | `<pr> [--for-ci]` | Mark a draft ready for review, and put the `Ready` label on it. `--for-ci` takes it out of draft only for its CI to run, and puts `Not Ready` on it |
| `pr-draft` | `<pr>` | Convert a pull request back to a draft, and put the `Not Ready` label on it |
| `pr-readiness` | `<pr> <ready\|not-ready>` | Put `Ready` or `Not Ready` on a PR and take the other off, creating the labels when missing. Prints the state now carried, `(unchanged)` after it when nothing changed |
| `labels-ensure` | | Create `Ready` (`27e760`) and `Not Ready` (`8c1455`) when missing, no description. A label already there under that name, in any case, is left as it is. One line per label: `created <name>` or `present <name>`, with ` #<colour>` when it differs from the house colour |
| `label-add` | `<pr> <label>...` | Add labels |
| `label-remove` | `<pr> <label>` | Remove one label — GitHub deletes one per call |
| `reviewer-add` / `reviewer-remove` | `<pr> <user>...` | Request or drop reviewers |
| `assignee-add` / `assignee-remove` | `<pr> <user>...` | Assign or unassign |

### Issues and search

| Subcommand | Arguments | Description |
|---|---|---|
| `issue-view` | `<number>` | One issue |
| `issue-list` | `[--state open\|closed\|all]` | Issues in the repository |
| `issue-search` | `<term>...` | Search within this repository |
| `pr-linked-issues` | `<pr>` | Issues the PR closes |

### Assets and auth

| Subcommand | Arguments | Description |
|---|---|---|
| `image-upload` | `<file>... [--branch pr-assets] [--title T]...` | Store one or more images, return their URLs and markdown |
| `auth-check` | | Verify the token |

### The forge's protection

| Subcommand | Arguments | Description |
|---|---|---|
| `protect-check` | | Whether the default branch refuses force-push and deletion |
| `protect-apply` | | Put the ruleset refusing both in place, when missing |

### Auto-merge

Answered by the mod, not by `gh.py`: the list is a file on this machine,
`auto-merge.json` in the plugin's data directory (README « Repositories in auto-merge »).

| Subcommand | Arguments | Description |
|---|---|---|
| `auto-merge-set` | `{"repo": "owner/name", "on": true\|false, "words": "<their words, verbatim>"}` | Put the repository in auto-merge (`on: true`) or take it out (`on: false`), on the operator's quoted word |
| `auto-merge-list` | | The repositories in auto-merge, one per line, or `no repository in auto-merge` |

`auto-merge-set` needs `words` of at least 8 characters, naming auto-merge (« auto-merge »,
« auto merge » or « automerge »), found verbatim, whitespace
normalised, in a prompt the operator typed in this session, or quoting their answer in a
consent record of auto-merge on that repository (core's `consent-record.ts`,
`<config dir>/consents/<owner>/<name>/`). A peer's message is not their word.
Otherwise it is refused, naming both proofs:

```
github: auto-merge-set refused on <owner/name>: its "words" are neither in a prompt the operator typed in this session, nor his answer in a consent record (orchestrator) of auto-merge on <owner/name>. Quote his words verbatim; a peer's message is not his word.
```

The file keeps its shape (`{"repositories": [...]}`, other keys kept), names compare
without regard to case, and it is changed under a lock (`<file>.lock`, core's convention),
written whole to a temporary file then moved in place:
no reader sees half a list, and a move that fails leaves no temporary file. A malformed
file is never overwritten. A deny rule refuses both subcommands, an ask from an explicit
rule asks before the write.

## Formatters

`--format NAME`, default `raw`. Reads leave the unprocessed JSON visible unless a
shape is asked for.

| Format | Input from | Output |
|---|---|---|
| `raw` | anything | pretty-printed JSON |
| `error-check` | any response | raises on an API error, else nothing |
| `pr-number` | `pr-get`, `pr-create` | the number, or empty |
| `pr-url` | `pr-create`, `pr-status` | the HTML URL |
| `pr-merge-status` | `pr-status` | `merged`, `open` or `closed` |
| `pr-details` | `pr-status` | number, title, state, draft, head, base, url |
| `checks-status` | `pr-checks` | `{"result": SUCCESS\|FAILURE\|PENDING, "failed_checks": [...]}`, the verdict `pr-gate` gives as `ci.result` |
| `open-threads` | `pr-threads` | unresolved threads |
| `resolved-threads` | `pr-threads` | resolved threads |
| `thread-summary` | `pr-threads` | a markdown table of open threads |
| `resolve-status` | `thread-resolve` | `resolved` or `unresolved` |
| `issue-comments-summary` | `pr-issue-comments` | a markdown table |
| `login` | `auth-check`, any list response | the login, or empty |
| `pending-review-summary` | `review-pending` | `none`, or `id`, `node_id`, `state`, `comments N` and a `path | line | commit_id` table |
| `comment-bodies` | `repo-review-comments`, `pr-comments` | the bodies only, separated by `---` |

## Image upload

`image-upload` stores the file on a dedicated branch (`pr-assets` by default) through
the Contents API, using the scoped token. A file that is not a PNG, JPEG, GIF or WebP by its
first bytes is refused. The blob is named after the SHA-256 of its
bytes, so uploading the same screenshot twice issues no write at all and reports
`reused`. It prints both the URL and ready-to-paste markdown, as a
`https://github.com/<owner>/<repo>/blob/<branch>/<blob>?raw=true` link — it goes
through github.com, so it renders for anyone who can see the repository, private
ones included.

GitHub's web upload endpoint would produce a `user-attachments` URL, but it
authenticates with browser session cookies rather than a scoped token. That route is
deliberately not used: it would mean whole-account credentials on disk.

`--title T` puts the screenshot's descriptive title above its image, as a bold line
followed by the image with the title as alt text (`writing/pull-requests.md` « Pull request
descriptions »): one line, trimmed, 100 characters or fewer, with no colon at its end. Asterisks and
closing brackets are taken out of it, as they would break the bold line or the alt text. A title
the description rules would refuse is refused too, so the block always passes them: a semicolon,
a `#N` or `repo#N` reference or a pull request URL, and the phrasings that say what a pull
request does not do (`unchanged`, `does not`, `without conflict`…, the list of « Pull request
descriptions »):

```
python3 "$GH" image-upload screenshot.png --title "Login screen"
# **Login screen**
# ![Login screen](https://github.com/acme/thing/blob/pr-assets/<sha>.png?raw=true)
```

`image-upload` also takes several files in one call, each with its own `--title`,
repeated once per file in the same order. The `markdown` field joins each titled block
with a horizontal rule, and the JSON carries an `images` list (one `{url, path, reused,
title}` entry per file) instead of a single `url`/`path`/`reused`:

```
python3 "$GH" image-upload before.png after.png --title "Before" --title "After"
# **Before**
# ![Before](https://github.com/acme/thing/blob/pr-assets/<sha1>.png?raw=true)
#
# ---
#
# **After**
# ![After](https://github.com/acme/thing/blob/pr-assets/<sha2>.png?raw=true)
```

`--title` given for a multi-file call must be repeated exactly once per file, or the
call is refused as a usage error. A multi-file call with no `--title` at all is refused
too: each block between two rules needs its title.

Requires push access to the repository.

## Records

### Where

`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pr-records/<owner>/<name>/<head>/<kind>.<at>.<producer>.json`

- `<owner>/<name>` lowercased. `<head>` is the full 40-hex sha, refused shorter, so the guard only lists one directory.
- `<at>` is UTC `YYYYMMDDTHHMMSSZ`, and `<producer>` is the producer's slug (`[a-z0-9-]`).
- Neutral root, not the github plugin's data directory: the producers are other plugins and a shell script, and none of them can read the github plugin's `CLAUDE_PLUGIN_DATA`. `~/.claude/.gitignore` ignores everything (`*`, line 3), so the root needs no git change.

### The one writer: `engine/record.py`

`python3 <github root>/engine/record.py --repo <owner/name> --pr <n> --head <40 hex> --kind review|norms|e2e --result pass|fail|waived --producer <slug> [--detail <text>] [--session <id>]`

- The contract is core's `pr-record.ts`, loaded here as the generated `core/pr-record.json`.
- It validates: the sha shape, the kind, `waived` for `e2e` only and only with a `--detail` that carries a date `YYYY-MM-DD`, a detail of at most 500 characters.
- It writes the file under a temporary name in the same directory, then renames it. It prints the path, and exits 2 on a usage error. Standard library only, like the engine.
- The producers find `<github root>` the way pr-review's `scripts/resolve_github.py` already does: the `installPath` of `github@lounisbou` (or `github@claude-github`) in `~/.claude/plugins/installed_plugins.json`, never a hand-built cache path.

### Fields (one JSON object per file)

```json
{"v": 1, "repo": "owner/name", "pr": 12, "head": "<40 hex>", "kind": "review",
 "result": "pass", "producer": "pr-review", "detail": "clean at pass 3",
 "session": "<CLAUDE_CODE_SESSION_ID or empty>", "at": "2026-11-01T10:00:00Z"}
```

### How the guard reads it, and how a head voids it

- The guard reads the PR's head from GitHub (`pr-gate`) and lists `<root>/<owner>/<name>/<head>/`. Only that directory counts. A record written at any other sha, older or not yet pushed, is not read.
- Per kind, the record with the latest `at` decides, so a later `fail` overrides an earlier `pass`. A file that does not parse, or whose `repo`, `head` or `pr` disagree with its path or with the PR, is skipped, and the refusal names it when a kind is missing or not accepted.
- Accepted: `review` `pass`, `norms` `pass`, `e2e` `pass` or `waived`. Anything else, or no record, is missing.
- A moved head voids every record by construction, with nothing deleted. A record written before a push matches once that same sha is pushed: a review of an unpushed commit counts once it is on the PR.
- Pruning: at `session.start`, at most once a day (a stamp file in the root), the github module removes the `<head>` directories whose newest file is older than 90 days.

### The producers

Core's `pr-record.ts` declares the producer of each kind; github writes a kind only for the plugin
declared its producer, and names no consumer.

| Producer | Kind | When, and with what |
|---|---|---|
| pr-review `auto-fix-loop` (`hooks/loop.ts`, `verdict`) | review | At the loop's end, computed from the review agents' findings blocks: a clean exit writes `pass`; a loop stopped at its pass limit, or a reviewer's one pass (`review_only`), writes `pass` when nothing Critical or Important was reported, `fail` otherwise or when the severity is unknown. No record when tracked files are dirty or the branch has no PR; the tool's answer then gains `record: none — <why>` |
| norms `/norms:check` (`hooks/record.ts`, `mcp__norms__check_done`) | norms | `{open, fixed, passed}`: `pass` when `open` is 0, `fail` otherwise, at the head at the call. Refused unless `/norms:check` computed its scope in this session; a commit after the check may only touch the files the check read. No record on a dirty tree or with no PR |
| any session that runs the E2E (`mcp__github__record`, module-only) | e2e | `{pr, repo?, result: pass\|fail\|waived, detail}`. The module checks that the checkout's `HEAD` equals the PR head read by `pr-gate`, and that the tree is clean, then calls `record.py` with producer `session-e2e`. `waived` needs a detail found verbatim in a prompt the operator typed in this session, or quoting their answer in a consent record of an E2E waiver of that pull request (« Guards » below), and carrying a date |

A review record is refused when the session writing it pushed the head it reviews: the review is
another session's.

Not producers: `start-review` (a walkthrough the operator submits themselves) and `process-comments` (answers to comments). A human `APPROVED` review on GitHub is no record.

### What the contract does not stop

A session that writes a file by hand under the root, or runs `record.py` itself, forges a record. The records guard (« Guards » below) refuses a Write, an Edit, a MultiEdit or a NotebookEdit under the root, and a Bash command naming the root, a `pr-records/` path or `engine/record.py`, read word by word with the shell's quotes removed. It does not see a script that does it internally. The guards stop a forgotten review, norms check or E2E. They do not stop a session set on forging one.

## Pushing from the sandbox

Outgoing SSH is blocked in the sandbox, even through `!`. Push over HTTPS with gh's
token and an empty `credential.helper=` first, to avoid the keychain dialogs:
`git -c credential.helper= -c credential.helper='!f(){ echo username=x-access-token; echo "password=$(gh auth token)"; }; f' push https://github.com/<owner>/<repo>.git HEAD:<branch>`.
A push by URL does not update `refs/remotes/origin/*`: `--force-with-lease` takes an
explicit sha (`--force-with-lease=<branch>:<full sha>`). Same pattern for `fetch`.
Never « external terminal ».

## Guards

**Writing rules read.** A commit (`git commit`), a pull request or an issue opened, edited
with a title or a body, or commented (`gh pr create`, `gh issue create`, `gh pr
comment`, `gh issue comment`, `gh pr review` with a body, `gh pr edit` and `gh issue
edit` with a title or a body), and every call of this tool that carries a text, waits
until the files of `writing/` its kind of text needs, which the refusal names, were read
whole in the context that writes it: the Read tool from a file's first line to its last, or
a Bash `cat` or `sed -n '1,$p'` of it.
Each subagent reads for itself, and a compaction asks for one more read. The command
is read word by word, so a message or a body that only mentions one of these commands
passes. Until then the call is refused with:

```
github: read <root>/engine/writing/<file> and <root>/engine/writing/references.md with the Read tool, whole, before <command>: their rules apply to this text. Then run the same command again.
```

**Ready.** `pr-ready`, `pr-merge`, `pr-readiness ready`, `label-add` with `Ready` and
`pr-create` out of draft, and in the shell `gh pr ready` (not `--undo`), `gh pr merge`
(not `--disable-auto`, `--auto` included), `gh pr edit` and `gh issue edit` with
`--add-label Ready`, `gh pr create` without `--draft`, `gh api` with `PUT` or `POST` on
`repos/<o>/<r>/pulls/<n>/merge` or on `repos/<o>/<r>/issues/<n>/labels` with `Ready`, and
`gh api graphql` naming `mergePullRequest`, `markPullRequestReadyForReview` or
`enablePullRequestAutoMerge`, and the same subcommands of the engine run from Bash
(`python3 <root>/engine/gh.py pr-merge 12 --repo owner/name`, its script given by its path or
by a shell variable followed by its subcommand), need the pull request ready at its head: a clean review, a
passed norms check and passed or waived E2E recorded at the head `pr-gate` reads (« Records »
above), and green CI. A `--match-head-commit` or a `pr-merge --sha` other than that head
is not ready either. Under the enforce phase the act is refused before any question, and a
pull request still carrying `Ready` goes back to `Not Ready`:

```
github: <act> refused on <owner/name>#<n> at <head7>: not ready. Missing: <item>, <item>. A pull request is ready when a clean review, a passed norms check, passed E2E and green CI are all at its current head (engine/writing/pull-requests.md « Ready pull requests »).
```

Under the warn phase, the one this release ships (`CLAUDE_GITHUB_READY_ENFORCE=1` brings
enforce forward), it goes ahead with one transcript line, `github: <act> on
<owner/name>#<n> is not ready, let through while the guard only warns. Missing: <item>`,
and one JSON line `{at, session, repo, pr, head, act, route, missing}` in `guard-warn.log`,
in the plugin's data directory. In the shell, a pull request opened out of draft outside a
repository in auto-merge is refused in both phases, naming the tool call that asks the
operator (« Auto-merge split » below). Under enforce, a pull request opened out of draft is
refused with `github: <act> refused: open it as a draft, then leave draft once ready.`,
and a readiness `pr-gate` could not read with `github: readiness of <owner/name>#<n>
unverified: <error>`. A shell merge or undraft that names no repository (`-R`, `--repo`
or a URL) is refused in both phases, a `Ready` label without one under enforce, with
`github: <command> refused: name the repository with -R owner/name.`; a GraphQL merge or
undraft names no pull request and is always refused, with the tool call to run.

A pull request that carries `Not Ready` and whose CI is not green may leave draft for its
CI to run, in every repository and with no question: the tool runs `pr-ready --for-ci`,
which keeps `Not Ready`, the shell's `gh pr ready` passes, and both print `github:
<owner/name>#<n> out of draft to run CI, still Not Ready`. Going back to draft
(`pr-draft`, `gh pr ready --undo`) always passes and puts `Not Ready`, and so does `gh pr
create --draft`. After a `git push`, a pull request of the pushed branch that carries
`Ready` goes back to `Not Ready`, with `github: <owner/name>#<n> back to Not Ready after
the push to <branch>`; a branch or a repository the push does not name with certainty is
left as it is, with one line.

**Auto-merge split.** In the shell, a merge or leaving draft (CI undraft aside) runs only
in a repository listed in `auto-merge.json`, the ready guard applying on top, through `gh`
and through the engine alike. The engine's undraft is a CI undraft only with `--for-ci`, and
the engine names its repository with `--repo`. Elsewhere it is refused in both phases:

```
github: <gh pr merge | gh pr ready> refused on <owner/name>: this repository is not in auto-merge, so a merge or leaving draft needs the operator's explicit word. When he gave it, run mcp__github__gh <pr-merge | pr-ready> {"pr": <n>} on <owner/name>: it checks that the pull request is ready, then asks him in the conversation.
```

The engine run from Bash keeps the writing rules too: `pr-create`, `pr-comment`, a
`pr-update` with a title or a body, and `review-submit`, `thread-reply`, `comment-edit`,
`review-pending-create` and `review-pending-add` with a body file or a comments file wait for
the writing rules to be read, as `gh pr create`, `gh pr comment` and `gh pr edit` do, and the `--title` of `pr-create` and `pr-update`, and the
file a `--body-file` names, are linted as the tool's call would be. An engine act whose
pull request number cannot be read from the command (`pr-merge {}` fed by an `xargs`,
`pr-merge "$PR"`) is refused in both phases, never read against the current branch's pull
request: write the number, or call the tool.

What the guards do not read on that route:

- A request the engine reads from stdin (`gh.py --stdin-json`) is not on the command line:
  the guards do not see it. Nor do they see an engine script given by a shell variable that is
  not followed by one of its subcommands, `$PY engine/gh.py …`, `eval`, `uv run`, or an
  unquoted `${CLAUDE_PLUGIN_ROOT}/engine/gh.py`: run it as `python3 "<root>/engine/gh.py" …`.
- A `--comments-file` is not read, so its inline comments are not linted.
- A body file written by the same command line (`printf … > body.md && python3 gh.py
  pr-create --body-file body.md`) is read before it exists, so it is not linted.

**Records.** A Write, an Edit, a MultiEdit or a NotebookEdit under the records root, and a
shell command naming that root, a `pr-records/` path or `engine/record.py` (in its text or in
any word with the shell's quotes removed), are refused, whatever the command does with it (a
Read of a record passes):

```
github: records are written by their producers' tools, and E2E by mcp__github__record, never by hand.
```

`mcp__github__record {pr, repo?, result, detail, kind?}` writes one record through
`record.py`, at the head when the checkout's `HEAD` equals the one `pr-gate` reads and the
tracked files are clean. A session writes `e2e` only (producer `session-e2e`); each other
kind is written by the plugin the record contract (core's `pr-record.ts`, `producers`) names
its producer, any other kind refused with `github: <kind> records are written by their
producer (<plugin>, <tool>)`. `waived` needs a detail found verbatim in a prompt the operator
typed in this session, or quoting their answer in a consent record of an E2E waiver of that
pull request (core's `consent-record.ts`, `<config dir>/consents/<owner>/<name>/`), carrying
a date. The answer quoted is at least 8 characters.

**Auto-merge list.** A Write, an Edit, a MultiEdit or a NotebookEdit of `auto-merge.json` in a plugin's
data directory, and a shell command naming it there (the data directory, `plugins/data/`,
`CLAUDE_PLUGIN_DATA` or `github-lounisbou` on the same line), are refused:

```
github: the auto-merge list changes only through mcp__github__gh auto-merge-set, on the operator's words quoted verbatim ({"repo": "owner/name", "on": true|false, "words": "..."}); auto-merge-list prints it.
```

A prompt the operator typed (at the terminal or through the bridge, never a peer's
message) that speaks of auto-merge (« auto-merge », « auto merge », « automerge », in any
case) enters with one line of context: if they put a repository in or out of auto-merge,
call `auto-merge-set` with their words verbatim in the same turn, and the repositories in
auto-merge today.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | usage error — bad arguments, unreadable file, wrong shape |
| `2` | authentication failure |
| `3` | API error |
| `4` | not found |
| `5` | rate limited after retries |

Every failure prints one `error:` line to stderr. A Python traceback is a bug, not
an expected output.
