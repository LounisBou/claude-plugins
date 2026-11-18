# gh.py reference

## Calling

The mod's `mcp__github__gh` tool runs this CLI: each `command` is a subcommand
below, and the `args` object holds the subcommand's arguments.

- Positional arguments go by their documented name: `pr-checks` → `{"pr": 12}`,
  `file-at-ref` → `{"path": "a.txt", "ref": "HEAD"}`. Variadic positionals
  (`label...`, `user...`, `term...`, `file...`) take an array.
- Every other key must be one of the subcommand's own `--flag`s, spelled out
  whole: `{"branch": "x"}` → `--branch x`, `{"draft": true}` → `--draft`.
- Text bodies go in `"body"` as a plain string, passed unchanged through a private
  temporary file. Inline-comment arrays go in `"comments"`, and
  `comments-resolved-batch` takes `"nodes"` (an array of node ids). `body-file`,
  `comments-file` and `json_file` are refused.

`repo` (`owner/name`) overrides the `origin` remote.

## Subcommands

### Pull requests

| Subcommand | Arguments | Description |
|---|---|---|
| `pr-get` | `[--branch B \| --pr N]` | The PR of a branch (default: the current one) or number `N`, as a list of one (`pr-lines`; `--json`: the list). An unknown number exits 4 |
| `pr-list` | | Open PRs, a line each (`pr-lines`); `--json`: the full list |
| `pr-panel` | | The open PRs, newest first (at most 100), for the `/prs` pane, in one GraphQL query: `[{"number", "title", "url", "draft", "comments", "ci", "failed"}]`, `ci` (`SUCCESS`, `FAILURE`, `PENDING`, `?`) from the head's status check rollup, not the gate's reading |
| `pr-status` | `<pr>` | Five lines: state, mergeable, head, labels, checks. `--json` or a `--format`: the full pull request |
| `pr-checks` | `<pr>` | Verdict, counts, failed and skipped names (`checks-summary`); `--json`: commit status and check runs |
| `pr-gate` | `<pr> [--head-only]` | `{"repo", "pr", "state", "draft", "head", "labels", "commits", "ci": {"result", "failed", "running", "skipped", "total", "checks"}}`, the reads the ready guard decides on (below). `--head-only`: the first six fields from the pull request alone, one read |
| `pr-fingerprint` | `<pr> <head> [--count K]` | `{"head", "commits", "fingerprint"}` of the PR's K (default: all) commits ending at that head, by first parents, no merge |
| `pr-diff` | `<pr>` | Unified diff as plain text |
| `pr-files` | `<pr>` | Totals, a line per changed path (`files-summary`); `--json`: with the patches, paginated |
| `pr-commits` | `<pr>` | A line per commit (`commits-summary`); `--json`: the commits, paginated |
| `file-at-ref` | `<path> <ref>` | A file's contents at a ref |
| `pr-create` | `--title T [--body-file P] [--base B] [--head H] [--draft]` | Open a PR from the current branch, a draft by default. One line (`pr-created`): `owner/name#N`, URL, head, labels, then `related` and the PRs updated; `--json` the PR. It gets `Not Ready`; a label failure only prints `error:`. Each open PR its `Related PRs` section names gets the new PR added to its own `Related PRs`; one that cannot be updated only prints `error:` |
| `pr-merge` | `<pr> [--method merge\|squash\|rebase] [--sha SHA]` | Merge a PR, optionally pinned to the head that was verified |

`pr-gate` is the one reading of CI, the ready guard's and the orchestrator's: it reads the PR, then at
its head the statuses, check runs and Actions runs, and the base's required checks. `state` is `open`,
`closed` or `merged`, `head` the full sha. `ci.result`: `FAILURE` (`ci.failed`), `PENDING` (nothing reported
yet, `ci.running`, or `ci.skipped`: a check that proved nothing, or `ci.unverified`: the required checks unread), `SUCCESS`, or `NONE` when the repository has no CI (no active workflow, required check or check on
the default branch). `ci.checks`: each check counted, its `bucket` (`pass`, `fail`, `pending`, `skipping`)
and `link`. Which run counts is the gate's code (`ghlib/fmt.py` `gate_ci`) and its tests. `gh run rerun` of a
draft-time run skips its jobs again: push a new commit.

`file-at-ref` returns `content` and `binary`: a file not valid UTF-8 has `binary` true and
`content` in base64.

`pr-merge --sha <full sha>` pins the verified head: GitHub refuses the merge if it moved. Take
the sha (as for `--match-head-commit`) from `git rev-parse` or `headRefOid`, never a short form.
Without one, the tool pins the head the gate checked; a shell merge must pin it.
A PR in a stack refuses the synchronous merge (403): `pr-merge` then uses the
asynchronous merge endpoint, same method and `--sha`, and waits for the merge at most `GH_MERGE_WAIT` seconds
(default 60), printing the merge commit sha, or exiting 3 with the request's uuid.

### Review threads and comments

| Subcommand | Arguments | Description |
|---|---|---|
| `pr-threads` | `<pr>` | Open review threads (`thread-summary`: thread, file, line, first author, `authorAssociation`); `--json`: all of them (GraphQL) |
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

A PENDING review is invisible to the PR author until its owner submits it. The tool opens one,
adds to it and reads it back, and never submits one: that is the operator's act, on GitHub.

| Subcommand | Arguments | Description |
|---|---|---|
| `review-pending-create` | `<pr> --comments-file P` | Open a PENDING review with inline comments; refused if the token's user already has one on the PR |
| `review-pending-add` | `<pr> --review-id ID --path P --line N [--start-line N] --body-file P` | Add an inline thread to the token user's PENDING review |
| `review-pending` | `<pr> [--author LOGIN]` | The PENDING review of a user (default: the token's) with its comments |
| `repo-review-comments` | `[--author LOGIN] [--limit N]` | The newest review comments of the repository (one page, default 30), filtered on a login, a line each (`review-comments`); `--json`: the comments |

`--comments-file` holds a non-empty JSON array of `{path, line, body}` objects; `side` and
`start_side` default to `RIGHT`, a range adds `start_line` (below `line`). `commit_id` is the
head; the request carries no `event`, which keeps the review pending.

### Metadata

| Subcommand | Arguments | Description |
|---|---|---|
| `pr-update` | `<pr> [--title T] [--body-file P] [--base B] [--state open\|closed]` | Change a PR's fields |
| `pr-ready` | `<pr> [--for-ci]` | Mark a draft ready, its labels untouched (« Guards »). `--for-ci`: out of draft only for its CI, with `Not Ready` put on it |
| `pr-draft` | `<pr>` | Back to draft, its labels untouched: `Ready` follows the records at the head, not the draft state |
| `pr-readiness` | `<pr> <ready\|not-ready>` | Put `Ready` or `Not Ready` and take the other off, creating the labels when missing (a PR already carrying the label reads nothing); prints the state, `(unchanged)` when nothing changed. `ready` only when the gate reads it ready, else the label carried and `Missing: …` |
| `labels-ensure` | | Create `Ready` (`27e760`) and `Not Ready` (`8c1455`) when missing, any case. One line per label, `created <name>` or `present <name>`, with ` #<colour>` when not the house colour |
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
| `protect-check` | `[--require-ci]` | Whether the default branch refuses force-push and deletion; with the flag, whether it requires the CI check core's readiness contract names |
| `protect-apply` | `[--require-ci]` | Put the ruleset refusing both in place, when missing; with the flag, it requires that check too (once the workflow's job reports it), and a check it already requires stays |

### Auto-merge

Answered by the mod, not by `gh.py`: the list is `auto-merge.json` in the plugin's data
directory (README « Repositories in auto-merge »).

| Subcommand | Arguments | Description |
|---|---|---|
| `auto-merge-set` | `{"repo": "owner/name", "on": true\|false, "words": "« <his words> », <their date>"}` | Put the repository in auto-merge or take it out, on the operator's quoted word |
| `auto-merge-list` | | The repositories in auto-merge, one per line, or `no repository in auto-merge` |

`words` quote the operator with their date, as a waiver's `detail` does.
The file keeps its other keys, names compare without regard to case, and it is written whole
under a lock; a malformed file is never overwritten.

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
| `checks-status` | `pr-checks` | `{"result": SUCCESS\|FAILURE\|PENDING\|NONE, "failed_checks": [...]}`, the verdict `pr-gate` gives as `ci.result` |
| `open-threads` | `pr-threads` | unresolved threads |
| `resolved-threads` | `pr-threads` | resolved threads |
| `resolve-status` | `thread-resolve` | `resolved` or `unresolved` |
| `login` | `auth-check`, any list response | the login, or empty |
| `pending-review-summary` | `review-pending` | `none`, or `id`, `node_id`, `state`, `comments N` and a `path | line | commit_id` table |
| `comment-bodies` | `repo-review-comments`, `pr-comments` | the bodies only, separated by `---` |

## Image upload

`image-upload` stores each file on a branch (`pr-assets` by default) through the Contents API:
a PNG, JPEG, GIF or WebP by its first bytes, named by its SHA-256, so a second upload writes
nothing and reports `reused`. It prints the URL,
`https://github.com/<owner>/<repo>/blob/<branch>/<blob>?raw=true`, and ready-to-paste markdown.

`--title T`, one per file in order, puts the screenshot's title in bold above its image and as
its alt text (`writing/pull-requests.md` « Pull request descriptions »): one line,
100 characters or fewer, no colon at its end, asterisks and closing brackets taken out. A title the description
rules refuse is refused too. With several files, `markdown` joins the blocks with a horizontal
rule and the JSON has `images`, one `{url, path, reused, title}` per file.

## Records

### Where

`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pr-records/<owner>/<name>/<head>/<kind>.<at>.<producer>.json`

- `<owner>/<name>` lowercased. `<head>` is the full 40-hex sha, refused shorter.
- `<at>` is UTC `YYYYMMDDTHHMMSSZ`, and `<producer>` is the producer's slug (`[a-z0-9-]`).

### The one writer: `engine/record.py`

`python3 <github root>/engine/record.py --repo <owner/name> --pr <n> --head <40 hex> --kind review|norms|e2e|tests --result pass|fail|waived|not-applicable|accepted --producer <slug> [--detail <text>] [--session <id>]`

- The contract is core's `pr-record.ts`, loaded here as the generated `core/pr-record.json`.
- It validates the sha shape, the kind, `waived` for `e2e` or `norms`, `not-applicable` for `e2e` (its `--detail` giving its reason), `accepted` for `review` only, `tests` `pass|fail` by `light-ci` only, a detail of 500 characters at most.
- It writes under a temporary name, then renames; prints the path; exits 2 on a usage error.

### Fields (one JSON object per file)

```json
{"v": 1, "repo": "owner/name", "pr": 12, "head": "<40 hex>", "kind": "review",
 "result": "pass", "producer": "pr-review", "detail": "clean at pass 3",
 "session": "<CLAUDE_CODE_SESSION_ID or empty>", "at": "2026-11-01T10:00:00Z"}
```

### How the guard reads it, and how a head voids it

- The guard reads the PR's head from GitHub (`pr-gate`) and lists `<root>/<owner>/<name>/<head>/`; a record at another sha counts only when carried (below).
- Per kind, the latest `at` decides: a later `fail` overrides an earlier `pass`. A file that does not parse, or whose `repo`, `head` or `pr` disagree with its path or the PR, is skipped, named in the refusal when a kind is missing or not accepted.
- What a record lets pass and what is owed: core's `pr-record.ts` (`accepts`) and `readiness.ts` (`missingEvidence`).
- The check plan and the E2E exemption (below) stand for the kinds they excuse, a `waived` at an earlier head for later ones while newest; named in `Ready`; a `fail` holds.
- A kind missing at the head takes its latest accepted record across earlier heads of the same commit count and `pr-fingerprint` (`<kind> carried from <head7>`).
- Otherwise a moved head voids every record; one of an unpushed commit counts once that sha is on the PR.
- Pruning: once a day at `session.start`, `<head>` directories and fingerprints untouched for 90 days go.

### The producers

Core's `pr-record.ts` declares each kind's producer, the only plugin github writes it for.

| Producer | Kind | When, and with what |
|---|---|---|
| pr-review `auto-fix-loop` (`hooks/loop.ts`, `verdict`) | review | At the loop's end, from the findings blocks: `pass` on a clean exit, or at the pass limit or after a `review_only` pass when nothing Critical or Important was reported, else `fail`. None on dirty tracked files or with no PR (`record: none — <why>`) |
| norms `/norms:check` (`hooks/record.ts`, `mcp__norms__check_done`) | norms | `{open, fixed, passed}`: `pass` when `open` is 0, else `fail`, at the head. Refused unless `/norms:check` computed its scope in this session; a later commit may only touch the files it read. None on a dirty tree or with no PR |
| orchestrator `mcp__orchestrator__review` | review | `verdict: pass\|fail\|accepted` from an orchestrator session, at the head of a clean checkout: `accepted` names each point set aside with its reason; a `pass` over a failed review at the head is refused |
| github `mcp__github__light_ci` | tests | « Light CI » below |
| any session that runs the E2E (`mcp__github__record`, module-only) | e2e | `{pr, repo?, run\|ran, detail?, dir?}` or `{pr, repo?, result: waived\|not-applicable, detail, dir?}`, producer `session-e2e` (below, and « Guards ») |

A review record is refused from a session that pushed the head it reviews
(`${CLAUDE_CONFIG_DIR:-~/.claude}/pushed-heads/<sha>`, one line per pushing session, read by every
session of the machine, pruned with the records).

**E2E computed from its run.** `run` (an argv, no shell) is run by the tool in the checkout at the
head, after the head and clean checks, only when Bash would run it without asking, within 570 s,
the head unmoved after. `ran` names a command line this session ran to its end in Bash, not in the
background, in that checkout (its directory or a leading `cd <absolute path> &&`) since its `HEAD`
last moved. Exit 0 is `pass`, else `fail`; the detail names the command, the head and the exit. A
`result: pass|fail` with neither (a run on another machine) is written, its detail opening `stated,
not computed: `, and observed (`github.record.e2e-stated`). `waived` and `not-applicable` take no run.

Not producers: `start-review`, `process-comments`, a human `APPROVED` review on GitHub.

### E2E a pull request does not need

Both routes are `hooks/e2e-scope.ts`'s.

- **No runtime.** `not-applicable` is written only when no file of the PR (`pr-files` at the
  head) holds runtime (`runtimeFiles`).
- **Check plan.** `mcp__orchestrator__review`'s `{pr, plan}`: e2e `required|none|screenshots`, norms `required|none`, review
  `required[: max <n>]|one-pass` (core's `readiness.ts`), each `<need>[: <reason>]`, a reason unless the first; rules
  in `writing/pull-requests.md`. One file per PR in `<data dir>/check-plans/`, posted on the PR;
  `pr-plan {pr}`, answered by the mod, prints it as the gate reads it (JSON).
- **Standing exemption.** `{repo, exempt: true, detail, paths?, labels?, until?}` exempts a repository's
  pull requests, all or those carrying one of `labels` or whose files all match `paths` (globs);
  `exempt: false` revokes it. `detail` quotes the operator's words with their date (« Guards »,
  « Records »). One file per repository, `<data dir>/e2e-exempt/<owner>/<name>.json`; one that does
  not parse exempts nothing. `until` (ISO UTC to the second) ends it at that instant: past it, it
  excuses nothing and the gate adds `E2E exemption of <repo> expired at <until>`.

### Light CI

A stacked PR (`pr-gate`'s `stacked`: its base heads another open PR, unprotected, not default) is ready on
its review and, where the operator configured light CI, a `tests` pass at its head or its checks green, which
stand over a failed run; a failed check blocks. File `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/light-ci/<owner>-<name>.json`:
`{"command": [...], "prepare": [...]?, "timeoutSeconds": 600, "decided": {"at", "words"}}`, or `{"off": "<words>", "at"}`;
no file or `off`: review alone, named in `Ready`.

- `mcp__github__light_ci {action: "run", pr, dir?}`: clean checkout of the head; `prepare`, then `command` (no
  shell; `{base}`: the merge base); `tests` `pass|fail` by `light-ci`. Past 570 s nothing is written.
- `{action: "status", repo?}`: what the file holds.

### What the contract does not stop

The guards do not see a script writing under the root or running `record.py`: they observe a
forgotten review, norms check or E2E, and stop no forger.

## Pushing from the sandbox

SSH is blocked in the sandbox, even through `!`: push over HTTPS with gh's token, `credential.helper=`
emptied first (no keychain dialog):
`git -c credential.helper= -c credential.helper='!f(){ echo username=x-access-token; echo "password=$(gh auth token)"; }; f' push https://github.com/<owner>/<repo>.git HEAD:<branch>`.
A push by URL leaves `refs/remotes/origin/*`: `--force-with-lease=<branch>:<full sha>`. Same for `fetch`.
Never « external terminal ».

## Guards

**Ready.** These acts meet the gate at the PR's head (core's readiness contract), CI included:
`pr-ready`, `pr-merge`; in the shell `gh pr ready` (not `--undo`), `gh pr merge` (not
`--disable-auto`), `gh api` `PUT`/`POST` on `repos/<o>/<r>/pulls/<n>/merge`, `gh api graphql`
naming `mergePullRequest`, `markPullRequestReadyForReview` or `enablePullRequestAutoMerge`; the
engine's same subcommands from Bash. The gate puts `Ready` just before the act, which runs on it,
or without it, observed (`github.ready.no-record`), when only records are absent at the head. CI
not green, a failed record, or a `--match-head-commit` or `--sha` off the head refuse it before any
question, naming what is missing. Refused too: a shell merge or undraft naming no repository
(`-R`, `--repo`, a URL), a GraphQL merge or undraft, a GraphQL query the line does not show
(`-F query=@file`, `--input`, a shell expansion), `gh.py --stdin-json` from Bash. A `Ready` put by
`label-add` or the shell is no act.

**The gate puts `Ready`.** After a record is written, or a `pr-gate` or `pr-checks` read through
the tool, the module reads readiness at the open PR's head, rereading it just before writing, and
puts `Ready` when nothing is missing, `Not Ready` back otherwise. It never touches the draft state:
a PR out of draft, for its CI or by the operator, stays out.

A PR carrying `Not Ready` with no passed check at its head may leave draft for its CI, unasked:
`pr-ready --for-ci` or `gh pr ready`, still `Not Ready`. Back to draft (`pr-draft`, `gh pr ready
--undo`) always passes and leaves `Ready` or `Not Ready` as the records at the head make them;
`gh pr create --draft` puts `Not Ready` on the new pull request. A `git push` puts a `Ready`
PR of the pushed branch back to `Not Ready`.

**Auto-merge split.** A merge runs only in a repository of `auto-merge.json`, the ready guard on
top; elsewhere it is asked through the tool, refused in the shell. Outside auto-merge, leaving
draft (CI undraft aside) meets the ready guard, is observed, then asked; opening out of draft is
observed. The engine's undraft is a CI one only with `--for-ci`, and names `--repo`.

The engine's texts from Bash (`pr-create`, `pr-comment`, `pr-update`, `review-submit`,
`thread-reply`, `comment-edit`, `review-pending-*`) are linted as the tool's are. An engine act
whose PR number cannot be read (`pr-merge "$PR"`) is refused: write the number.

Not read on that route: an engine script run through a variable, `eval`, `uv run` or an unquoted
`${CLAUDE_PLUGIN_ROOT}/engine/gh.py` (run `python3 "<root>/engine/gh.py" …`), a `gh alias`, a
script or subprocess running `gh` or the engine, `curl` on the API, a `--comments-file`'s
comments, a body file the same command line writes.

**Records.** Writing under the records root, the E2E exemptions or the check plans (Write, Edit,
MultiEdit, NotebookEdit, or a shell command naming the root, `pr-records/` or `engine/record.py`)
is observed (`github.records.write`, `github.exemption.write`); deleting in them (`rm`, `unlink`,
`find -delete`, a `mv` out) is refused. Also observed: moving a label an exemption names
(`github.exempt-label.move`), opening out of draft (`github.draft.open-out`), leaving draft
outside auto-merge (`github.draft.leave`), a text breaking a writing rule (`github.writing.rule`):
README « Observed guards ».

`mcp__github__record {pr, repo?, result?, run?, ran?, detail, kind?, dir?}` writes one record
through `record.py` when the `HEAD` of `dir` (default: the session's directory) is the head
`pr-gate` reads and its tracked files are clean. A session writes `e2e` only. `waived` (E2E or
norms) and `exempt` rest on his words quoted in `detail` with their date (`YYYY-MM-DD`, a time
optional), from any channel: « « <his words> », 2026-11-15T08:50Z », and so do `auto-merge-set` and `auto-deploy-set` in `words`.

**Auto-merge and deploy lists.** Writing `auto-merge.json` or `auto-deploy.json` in a plugin's
data directory, by a tool or a shell command naming one there, is refused: use `auto-merge-set`
or `auto-deploy-set`.

### Auto-deploy

Answered by the mod (README « Repositories in auto-deploy »).

| Subcommand | Arguments | Description |
|---|---|---|
| `auto-deploy-set` | `{"repo": "owner/name", "env": "dev"\|"staging"\|"prod", "on": true\|false, "words": "« <his words> », <their date>", "commands": [...]?}` | Grant or withdraw the environment on the operator's quoted, dated words; `commands`: its deploys |
| `auto-deploy-list` | | The environments granted |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | usage error — bad arguments, unreadable file, wrong shape |
| `2` | authentication failure |
| `3` | API error |
| `4` | not found |
| `5` | rate limited: a spent quota at once, with its reset time in Paris and UTC; a secondary limit after its retries |

Every failure prints one `error:` line to stderr.
