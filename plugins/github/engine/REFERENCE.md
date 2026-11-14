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

`repo` (`owner/name`) overrides the `origin` remote.

Before writing a text, read its rules in `writing/` beside this file.

## Subcommands

### Pull requests

| Subcommand | Arguments | Description |
|---|---|---|
| `pr-get` | `[--branch B \| --pr N]` | The PR for a branch, defaulting to the current one, or PR `N` (`{"pr": N}` through the tool). Both answer a list of one PR (`pr-lines`; `--json`: the full list). An unknown number exits 4 |
| `pr-list` | | Open PRs, a line each (`pr-lines`); `--json`: the full list |
| `pr-status` | `<pr>` | Five lines: state, mergeable, head, labels, checks. `--json` or a `--format`: the full pull request |
| `pr-checks` | `<pr>` | Verdict, counts, failed and skipped names (`checks-summary`); `--json`: commit status and check runs |
| `pr-gate` | `<pr>` | `{"repo", "pr", "state", "draft", "head", "labels", "commits", "ci": {"result", "failed", "running", "skipped", "total"}}`, the reads the ready guard decides on (below) |
| `pr-fingerprint` | `<pr> <head> [--count K]` | `{"head", "commits", "fingerprint"}` of the PR's K (default: all) commits ending at that head, by first parents, no merge |
| `pr-diff` | `<pr>` | Unified diff as plain text |
| `pr-files` | `<pr>` | Totals, a line per changed path (`files-summary`); `--json`: with the patches, paginated |
| `pr-commits` | `<pr>` | A line per commit (`commits-summary`); `--json`: the commits, paginated |
| `file-at-ref` | `<path> <ref>` | A file's contents at a ref |
| `pr-create` | `--title T [--body-file P] [--base B] [--head H] [--draft]` | Open a PR from the current branch, `--draft` for a draft (the house default). It gets the `Not Ready` label, draft or not: `Ready` is the gate's (« Ready »). A label failure is printed as an `error:` line on stderr and does not fail the command |
| `pr-merge` | `<pr> [--method merge\|squash\|rebase] [--sha SHA]` | Merge a PR, optionally pinned to the head that was verified |

`pr-gate` reads the pull request, then at its head the status, check runs and Actions runs
(`per_page=100`); `state` is `open`, `closed` or `merged`, `head` the full sha. `ci.total`:
statuses and each check's latest run, less a skipped or neutral one of a run older than its
workflow's latest (greatest run id) if that has a check. `ci.result`: `FAILURE` if one failed
(`ci.failed`), `PENDING` if one runs (`ci.running`) or proved nothing (`ci.skipped`:
`skipped`, or `neutral` on a draft), else `SUCCESS`, also with no check. A skipped check
never turns green, in `checks-status` too. Actions call failed: `error:` on stderr, every
run counted. `gh run rerun` of a draft-time run skips its jobs again: push a new commit
instead.

`file-at-ref` returns `content` and `binary`: a file not valid UTF-8 has `binary` true and
`content` in base64, never decoded lossily.

`pr-merge --sha <full sha>` sends the head that was verified, and GitHub refuses the merge
if the head has moved since.
`--match-head-commit` takes the full sha read by `git rev-parse` or `headRefOid`, never
copied from a short form or completed by hand.

A PR GitHub counts in a stack refuses the synchronous merge (403): `pr-merge` then uses the
asynchronous merge endpoint, same method (and `--sha`), and reads the PR until
merged, at most `GH_MERGE_WAIT` seconds (default 60). It prints the merge commit sha, or
exits 3 naming the request's uuid if the merge fails or times out. Other errors pass as is.

### Review threads and comments

| Subcommand | Arguments | Description |
|---|---|---|
| `pr-threads` | `<pr>` | Open review threads as a table (`thread-summary`); `--json`: all of them (GraphQL) |
| `pr-comments` | `<pr>` | A line per inline review comment (`review-comments`); `--json`: the comments, paginated |
| `pr-issue-comments` | `<pr>` | General PR comments as a table (`issue-comments-summary`); `--json`: the comments, paginated |
| `pr-reviews` | `<pr>` | A line per review (`reviews-summary`); `--json`: the review bodies, paginated |
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
| `repo-review-comments` | `[--author LOGIN] [--limit N]` | The newest review comments of the repository (one page), filtered on a login, default limit 30, a line each (`review-comments`); `--json`: the comments |

`--comments-file` holds a non-empty JSON array of `{path, line, body}` objects; `side`
defaults to `RIGHT`, a range adds `start_line` (below `line`) and `start_side` (defaults
to `RIGHT`). `commit_id` is the PR head, read by the tool. The request carries no
`event`, which is what keeps the review pending.

### Metadata

| Subcommand | Arguments | Description |
|---|---|---|
| `pr-update` | `<pr> [--title T] [--body-file P] [--base B] [--state open\|closed]` | Change a PR's fields |
| `pr-ready` | `<pr> [--for-ci]` | Mark a draft ready for review, its labels left as they are; refused outside auto-merge (« Guards »). `--for-ci` takes it out of draft only for its CI to run, and puts `Not Ready` on it |
| `pr-draft` | `<pr>` | Convert a pull request back to a draft, and put the `Not Ready` label on it |
| `pr-readiness` | `<pr> <ready\|not-ready>` | Put `Ready` or `Not Ready` on a PR and take the other off, creating the labels when missing. Prints the state now carried, `(unchanged)` after it when nothing changed. `ready` only when the four hold (« Guards ») |
| `labels-ensure` | | Create `Ready` (`27e760`) and `Not Ready` (`8c1455`) when missing, no description. A label already there under that name, in any case, is left as it is. One line per label: `created <name>` or `present <name>`, with ` #<colour>` when it differs from the house colour |
| `label-add` | `<pr> <label>...` | Add labels |
| `label-remove` | `<pr> <label>` | Remove one label — GitHub deletes one per call |
| `reviewer-add` / `reviewer-remove` | `<pr> <user>...` | Request or drop reviewers |
| `assignee-add` / `assignee-remove` | `<pr> <user>...` | Assign or unassign |

### Issues and search

| Subcommand | Arguments | Description |
|---|---|---|
| `issue-view` | `<number>` | One issue: header, body, link (`issue-detail`); `--json`: the issue |
| `issue-list` | `[--state open\|closed\|all]` | Issues in the repository, a line each (`issue-lines`); `--json`: the issues |
| `issue-search` | `<term>...` | Search within this repository, a line each (`issue-lines`); `--json`: the search object |
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
normalised, in a prompt the operator typed (or a quote of it), or quoting their answer in a
consent record of auto-merge on that repository (core's `consent-record.ts`,
`<config dir>/consents/<owner>/<name>/`). Otherwise it is refused, naming both proofs.

The file keeps its shape (`{"repositories": [...]}`, other keys kept), names compare
without regard to case, and it is changed under a lock (`<file>.lock`, core's convention),
written whole to a temporary file then moved in place, which a failed move removes. A malformed
file is never overwritten. A deny rule refuses both subcommands, an ask from an explicit
rule asks before the write.

## Formatters

`--format NAME`, default: the few lines named in the command rows above (`pr-lines`, `checks-summary`,
`review-comments`, `thread-summary`, `issue-comments-summary`, `pr-summary`, `reviews-summary`, `files-summary`, `commits-summary`, `issue-lines`, `issue-detail`),
else `raw`. `--json` (or `--format raw`) is the full object a program parses; a format beside it wins.

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
| `resolve-status` | `thread-resolve` | `resolved` or `unresolved` |
| `login` | `auth-check`, any list response | the login, or empty |
| `pending-review-summary` | `review-pending` | `none`, or `id`, `node_id`, `state`, `comments N` and a `path | line | commit_id` table |
| `comment-bodies` | `repo-review-comments`, `pr-comments` | the bodies only, separated by `---` |

## Image upload

`image-upload` stores the file on a dedicated branch (`pr-assets` by default) through
the Contents API, using the scoped token. A file that is not a PNG, JPEG, GIF or WebP by its
first bytes is refused. The blob is named after the SHA-256 of its
bytes, so uploading the same screenshot twice issues no write at all and reports
`reused`. It prints both the URL and ready-to-paste markdown, as a
`https://github.com/<owner>/<repo>/blob/<branch>/<blob>?raw=true` link, which renders for anyone who can see the repository.

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

`image-upload` takes several files in one call, one `--title` per file, in order.
`markdown` joins the titled blocks with a horizontal rule; the JSON has an `images` list
(one `{url, path, reused, title}` per file) in place of `url`/`path`/`reused`.
A multi-file call without one `--title` per file is a usage error.

## Records

### Where

`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pr-records/<owner>/<name>/<head>/<kind>.<at>.<producer>.json`

- `<owner>/<name>` lowercased. `<head>` is the full 40-hex sha, refused shorter, so the guard only lists one directory.
- `<at>` is UTC `YYYYMMDDTHHMMSSZ`, and `<producer>` is the producer's slug (`[a-z0-9-]`).
- Neutral root, not the github plugin's data directory, which its producers, other plugins, cannot read.

### The one writer: `engine/record.py`

`python3 <github root>/engine/record.py --repo <owner/name> --pr <n> --head <40 hex> --kind review|norms|e2e --result pass|fail|waived|not-applicable|accepted --producer <slug> [--detail <text>] [--session <id>]`

- The contract is core's `pr-record.ts`, loaded here as the generated `core/pr-record.json`.
- It validates the sha shape, the kind, `waived` for `e2e` or `norms`, `not-applicable` for `e2e` (a not applicable's `--detail` giving its reason), `accepted` for `review` only, a detail of 500 characters at most.
- It writes under a temporary name in the same directory, then renames; prints the path; exits 2 on a usage error. Standard library only.

### Fields (one JSON object per file)

```json
{"v": 1, "repo": "owner/name", "pr": 12, "head": "<40 hex>", "kind": "review",
 "result": "pass", "producer": "pr-review", "detail": "clean at pass 3",
 "session": "<CLAUDE_CODE_SESSION_ID or empty>", "at": "2026-11-01T10:00:00Z"}
```

### How the guard reads it, and how a head voids it

- The guard reads the PR's head from GitHub (`pr-gate`) and lists `<root>/<owner>/<name>/<head>/`; a record at another sha counts only when carried (below).
- Per kind, the latest `at` decides: a later `fail` overrides an earlier `pass`. A file that does not parse, or whose `repo`, `head` or `pr` disagree with its path or the PR, is skipped, named in the refusal when a kind is missing or not accepted.
- Accepted: `review` `pass`, or `accepted` (the orchestrator's review, its points set aside); `norms` `pass` or `waived`; `e2e` `pass`, `waived` or `not-applicable`. Anything else, or no record, is missing; `norms` only if failed or planned.
- The check plan and the E2E exemption (below) stand for the kinds they excuse, a `waived` at an earlier head for later ones while newest, and the operator's waiver (newest consent record `<kind>-waiver`) at every head with none of its kind; named in the `Ready` line; a `fail` holds.
- A kind missing at the head takes its latest record across the PR's earlier heads of the same commit count and `pr-fingerprint`, if accepted (`<kind> carried from <head7>`).
- Otherwise a moved head voids every record, nothing deleted; a record of an unpushed commit counts once that sha is on the PR.
- Pruning: at `session.start`, once a day at most (a stamp in the root), the `<head>` directories and fingerprints untouched for 90 days are removed.

### The producers

Core's `pr-record.ts` declares each kind's producer, the only plugin github writes it for; github
names no consumer.

| Producer | Kind | When, and with what |
|---|---|---|
| pr-review `auto-fix-loop` (`hooks/loop.ts`, `verdict`) | review | At the loop's end, from the review agents' findings blocks: `pass` on a clean exit; at the pass limit or after a reviewer's one pass (`review_only`), `pass` when nothing Critical or Important was reported, else `fail` (unknown severity too). None on dirty tracked files or with no PR: the answer gains `record: none — <why>` |
| norms `/norms:check` (`hooks/record.ts`, `mcp__norms__check_done`) | norms | `{open, fixed, passed}`: `pass` when `open` is 0, `fail` otherwise, at the head at the call. Refused unless `/norms:check` computed its scope in this session; a commit after the check may only touch the files the check read. No record on a dirty tree or with no PR |
| orchestrator `mcp__orchestrator__review` | review | `verdict: pass\|fail\|accepted` from an orchestrator session, at the head of a clean checkout: `accepted` names each point set aside with its reason; a `pass` over a failed review at the head is refused |
| any session that runs the E2E (`mcp__github__record`, module-only) | e2e | `{pr, repo?, result: pass\|fail\|waived\|not-applicable, detail, dir?}`, producer `session-e2e`, checked as « Guards » below says; `not-applicable` needs its reason and files with no runtime (below) |

A review record is refused from the session that pushed the head it reviews.

Not producers: `start-review` (the operator submits it), `process-comments` (answers to comments), a human `APPROVED` review on GitHub.

### E2E a pull request does not need

Both routes are `hooks/e2e-scope.ts`'s.

- **No runtime.** `not-applicable` is written only when no file of the PR (`pr-files` at the
  head) holds runtime (`runtimeFiles`); the refusal names the files.
- **Check plan.** `mcp__orchestrator__review`'s `{pr, plan}`: e2e `required|none|screenshots`, norms `required|none`, review
  `full|one-pass` (unread by the gate), each `<need>[: <reason>]`, a reason unless the first; rules
  in `writing/pull-requests.md`. One file per PR in `<data dir>/check-plans/`, posted on the PR.
- **Standing exemption.** `{repo, exempt: true, detail, paths?, labels?}` exempts a repository's
  pull requests, all or those carrying one of `labels` or whose files all match `paths` (globs);
  `exempt: false` revokes it. `detail` quotes the operator's words typed in the session, or a consent record
  of subject `e2e-exemption`. One file per repository, `<data dir>/e2e-exempt/<owner>/<name>.json`;
  one that does not parse exempts nothing.

### What the contract does not stop

The records guard (« Guards » below) does not see a script writing under the root or running `record.py`: the guards stop a forgotten review, norms check or E2E, not a forger.

## Pushing from the sandbox

SSH is blocked in the sandbox, even through `!`: push over HTTPS with gh's token, an
empty `credential.helper=` first (no keychain dialog):
`git -c credential.helper= -c credential.helper='!f(){ echo username=x-access-token; echo "password=$(gh auth token)"; }; f' push https://github.com/<owner>/<repo>.git HEAD:<branch>`.
A push by URL does not update `refs/remotes/origin/*`: `--force-with-lease` takes an
explicit sha (`--force-with-lease=<branch>:<full sha>`). Same pattern for `fetch`.
Never « external terminal ».

## Guards

**Ready.** `pr-ready`, `pr-merge` and
`pr-create` out of draft, and in the shell `gh pr ready` (not `--undo`; `--undo=false` is
none), `gh pr merge` (not `--disable-auto`), `gh pr create` without `--draft`, `gh api` (a path or a full URL) with `PUT` or `POST`
on `repos/<o>/<r>/pulls/<n>/merge`, `gh api graphql` naming `mergePullRequest`, `markPullRequestReadyForReview`
or `enablePullRequestAutoMerge`, and the same subcommands of the engine run from Bash (its
script by its path, or a shell variable followed by its subcommand), need the pull request
ready at its head: a clean review and passed or waived E2E recorded at
the head `pr-gate` reads (« Records » above), and green CI. A `--match-head-commit` or a
`pr-merge --sha` other than that head is not ready either. A `Ready` label put by hand is no
act: the gate alone decides readiness. Under enforce every act is refused, before any question, with `github: <act>
refused on <owner/name>#<n> at <head7>: not ready. Missing: <item>, …`, and a pull request
still carrying `Ready` goes back to `Not Ready`.

Under warn, the phase this release ships (`CLAUDE_GITHUB_READY_ENFORCE=1` brings enforce
forward), the other acts go ahead with `github: <act> on <owner/name>#<n> is not ready, let
through while the guard only warns. Missing: <item>`, and one JSON line `{at, session, repo,
pr, head, act, route, missing}` in `guard-warn.log`, in the plugin's data directory. Under
enforce, opening out of draft is refused, and a readiness `pr-gate` could not read with
`github: readiness of <owner/name>#<n> unverified: <error>`, a `Ready` label in both phases. A
shell merge, undraft or `Ready` label naming no repository (`-R`, `--repo` or a URL) is refused
in both phases; a GraphQL merge or undraft names no pull request and is always refused, with
the tool call to run. A GraphQL query the command does not show (`-F query=@file`, `--input`, a
shell variable or substitution) is refused outside auto-merge, an unverified readiness inside
it. `gh.py --stdin-json` run from Bash is refused: its request cannot be read.

**The gate puts `Ready`.** After a record is written (any producer) and a `pr-gate` or
`pr-checks` read through the tool, the module reads the three at the open pull request's head
and puts `Ready` when they hold, or `Not Ready` back on one carrying `Ready`: the gate's
act. It reads the head again just before writing, and writes nothing on a moved head or on
records it cannot list. Outside auto-merge one the plugin undrafted for CI
goes back to draft first. Its line follows a record's output; after a read it is a line of
its own, and `pr-gate` stays JSON, with the labels and draft the gate left.

A pull request that carries `Not Ready` and no passed check at its head may leave draft for
its CI to run, in every repository and with no question: the tool runs `pr-ready --for-ci`,
which keeps `Not Ready`, the shell's `gh pr ready` passes, and both print `github:
<owner/name>#<n> out of draft to run CI, still Not Ready`. Going back to draft
(`pr-draft`, `gh pr ready --undo`) always passes and puts `Not Ready`, and so does `gh pr
create --draft`. After a `git push`, a pull request of the pushed branch that carries
`Ready` goes back to `Not Ready`, with one line; a branch or a repository the push does not
name with certainty is left as it is.

**Auto-merge split.** A merge or leaving draft (CI undraft aside) runs only in a repository
listed in `auto-merge.json`, the ready guard on top. Elsewhere leaving draft or opening out of
draft is refused on every route, never asked (`github: <act> refused on <owner/name>: outside
auto-merge, leaving draft is the operator's, …`); a merge is asked through the tool and refused
in the shell. The engine's undraft is a CI undraft only with `--for-ci`; it names its
repository with `--repo`.

The engine's texts run from Bash (`pr-create`, `pr-comment`, `pr-update`, `review-submit`,
`thread-reply`, `comment-edit`, `review-pending-*`) wait for the writing rules to be read
and are linted, `--title` and the `--body-file` file, as the tool's call would be. An engine
act whose pull request number cannot be read (`pr-merge {}` from an `xargs`, `pr-merge "$PR"`)
is refused in both phases, never read against the current branch's: write the number.

What the guards do not read on that route:

- An engine script given by a shell variable not followed by one of its subcommands, `$PY
  engine/gh.py …`, `eval`, `uv run`, or an unquoted `${CLAUDE_PLUGIN_ROOT}/engine/gh.py`:
  run it as `python3 "<root>/engine/gh.py" …`. Nor a `gh alias`, a script or a subprocess
  that runs `gh` or the engine, or `curl` on the API: documented, not guarded.
- A `--comments-file` is not read, so its inline comments are not linted.
- A body file written by the same command line (`printf … > body.md && python3 gh.py
  pr-create --body-file body.md`) is read before it exists, so it is not linted.

**Records.** A Write, Edit, MultiEdit or NotebookEdit under the records root, and a shell
command naming that root, a `pr-records/` path or `engine/record.py` (in its text or in any word
unquoted), are refused whatever it does (a Read passes):

```
github: records are written by their producers' tools, and E2E by mcp__github__record, never by hand.
```

The E2E exemption and check plan files are refused alike (`github: an E2E exemption changes only through …`).

`mcp__github__record {pr, repo?, result, detail, kind?, dir?}` writes one record through
`record.py` when the `HEAD` of `dir`, the checkout the tests ran in (default: the session's
directory), is the head `pr-gate` reads and its tracked files are clean; else it
refuses, naming both shas. A session writes `e2e` only, each other kind its producer. `waived`
needs the operator's waiver (above), his recorded answer its detail.

**Auto-merge and deploy lists.** A Write, Edit, MultiEdit or NotebookEdit of `auto-merge.json` or
`auto-deploy.json` in a plugin's data directory, and a shell command naming one there (the data
directory, `plugins/data/`, `CLAUDE_PLUGIN_DATA` or `github-lounisbou` on the same line), are refused
with a line naming `auto-merge-set` or `auto-deploy-set`.

A prompt the operator typed (at the terminal or through the bridge, never a peer's message)
that speaks of auto-merge (« auto-merge », « auto merge », « automerge ») enters with one line of
context: call `auto-merge-set` with their words verbatim in the same turn, and the repositories
in auto-merge today.

### Auto-deploy

Answered by the mod (README « Repositories in auto-deploy »).

| Subcommand | Arguments | Description |
|---|---|---|
| `auto-deploy-set` | `{"repo": "owner/name", "env": "dev"\|"staging"\|"prod", "on": true\|false, "words": "<their words, verbatim>", "commands": [...]?}` | Grant or withdraw the environment on the operator's quoted word; `commands`: its deploys |
| `auto-deploy-list` | | The environments granted |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | usage error — bad arguments, unreadable file, wrong shape |
| `2` | authentication failure |
| `3` | API error |
| `4` | not found |
| `5` | rate limited after retries |

Every failure prints one `error:` line to stderr.
