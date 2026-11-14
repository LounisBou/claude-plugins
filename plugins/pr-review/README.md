# pr-review

An interactive pull-request review workflow, packaged as a plugin: walk through
review feedback one item at a time, process a PR's comments with a human deciding
each one, and run an autonomous review-fix loop.

The plugin is named `pr-review`, so its skills are `/pr-review:start-review`,
`/pr-review:process-comments` and `/pr-review:auto-fix-loop`.

## Requires two plugins

This is a thin layer, not a fork. It builds on two plugins and refuses to run
without them:

- `pr-review-toolkit@claude-plugins-official` — the review agents and `/review-pr`
- `github@lounisbou` — the GitHub API tool, see below

**Installed is not the same as enabled.** A plugin can sit on disk and be inert, so
the preflight reads the `enabledPlugins` map rather than looking for files. If any
dependency is missing or disabled, every skill stops before doing anything and prints
the command that fixes it.

The GitHub plugin is accepted under either of the two keys it can be installed
from — `github@lounisbou` from this repository's catalogue, or `github@claude-github`
from its former one. Either one satisfies the dependency; only neither is a failure.

## Install

Add the marketplace, install the plugin, then check it:

```
/plugin marketplace add LounisBou/claude-plugins
/plugin install pr-review@lounisbou
/pr-review:install
```

`/pr-review:install` first gives the machine a GitHub login. When `GH_TOKEN` is not
set it runs the github plugin's own installer, which installs `gh` when it is missing
and signs in with the browser; the token stays in `gh`'s credential store, and nothing
here prints or writes it. Each step is skipped when already satisfied, so running it
again is harmless.

It then verifies the two plugin dependencies — `pr-review-toolkit@claude-plugins-official`
and `github@lounisbou` — plus python3 3.9+, curl and the GitHub token, from any directory: installing needs
no git repository. Each skill checks for a GitHub `origin` remote when it starts.
`/pr-review:doctor` repeats that verification any time and changes nothing. A skill that starts with no token says the one command that fixes it:
`/pr-review:install`.

## The skills

**`/pr-review:start-review`** — an interactive walkthrough of review findings. It
builds a numbered list, then presents one item at a time and waits. The comments kept
along the way go into a single review left pending on the PR, which the author cannot
see until the user reads it, edits it and submits it on GitHub. Applying a fix
happens only on the explicit `fix` command, and publishing a comment on the spot only
on `post now`. A fix runs the repository's own check and test commands before the
walkthrough moves on, and leaves its commit prepared: the commits are created at the
end, on `commit`, and nothing is pushed.

**`/pr-review:process-comments`** — works through a PR's existing comments with the
user deciding each one. It announces the workload first and only builds full project
context when there is enough to justify it. A reviewer asking for a change is not on
its own a reason to make it.

**`/pr-review:auto-fix-loop`** — the autonomous counterpart: review, fix, re-review,
until no Critical or Important finding is left, or until a pass limit. Use it when you want the cycle run for you rather
than presented to you. Its reviewer mode (`review_only`), run by a session that did not
write the code (implement's `/implement:review` launches one), makes one pass and fixes
nothing: its findings are the verdict.

## The GitHub tool

The skills talk to GitHub through the `github@lounisbou` plugin — pull requests,
review threads, comments, reviews, labels, reviewers, issues, search and image
attachments, Python standard library only, no `gh` CLI. That tool is no longer
carried here: the plugin is declared under `dependencies` in
`.claude-plugin/plugin.json` and installed along with this one.

Each call in a skill is written as the JSON request that plugin's
`mcp__github__gh` tool takes, `{"command": ..., "args": {...}}`, and made as a call
of that tool. A write made that way passes the session's permission check, which a
shell call of the engine does not.

Where the tool is not listed (a session where plugin modules do not load, such as
`claude -p`), the skill sends the same request to the same engine from Bash:
`gh.py --stdin-json`, the request in a file. The engine's root comes from
`scripts/resolve_github.py`, which reads the platform's own install record — never a
path assembled into the plugin cache, whose directory names are sometimes git SHAs
— and stops on an `error:`/`fix:` pair when the dependency is absent.

Its documentation — the full subcommand and formatter surface, the exit codes —
lives in the github plugin (`plugins/github/engine/REFERENCE.md`).

## The hooks module

`hooks/` holds a module the host loads beside the skills. It adds no step the
skills cannot do without it: under `claude -p` or an older host it does not load,
and every skill keeps its own route.

- **The Iron Rules, held.** While `start-review` or `process-comments` runs, a code
  change waits for the user's own `fix` (process-comments: `1` or `3`, or an
  alias carrying `fix`), a publication on the PR for `post now`, a resolve in
  process-comments for `1` or `4`, and `git push` for `push`. A refused call tells
  the model which word lifts it. The walkthrough's own files under
  `/tmp/claude-pr-review-*` are never refused. A review is never submitted with
  an event other than `COMMENT`.
- **Never a trap.** `end review` typed by the user, an interrupted turn (Esc), a
  `/clear` and the skill's own closing line each end those rules at once.
  `auto-fix-loop` is autonomous and runs under none of them.
- **`mcp__pr-review__open_comments`.** process-comments' triage in one call: the
  PR, its comments, reviews and open threads read through `mcp__github__gh`, then
  `skills/process-comments/scripts/triage.py` — the same script the Bash route
  runs — answering the open items, the counts, the tier and the line to announce.
- **`mcp__pr-review__loop` and a Stop gate.** auto-fix-loop's pass counter, seen
  findings and fix log, held outside the model's memory. While a loop runs and
  neither exit condition (a review with no Critical or Important finding, the pass limit) is met, a stop is refused once,
  naming the pass. Any prompt the user types, or an interrupted turn, ends that hold.
- **The review record.** When the loop ends, it leaves a review record at the pull
  request's head, written through the github plugin's `mcp__github__record`, for that
  plugin's ready guard. The verdict is computed, not reported: during a pass, each
  agent the session launches is asked to end with a JSON block of its findings, and
  the module reads them. An agent the host runs in the background is read from its own
  hand-back (its `SubagentHandback` call, else its last answer); until every one has
  answered, `findings` asks to wait and a stop is let through. A clean exit needs every
  agent of the pass to report no Critical or Important finding, and a reviewer's verdict needs at least one agent;
  a background agent whose hand-back has no block is asked for it once (`findings` names
  its agentId for a SendMessage, and keeps its place); an agent still without a readable
  block (or one that fails) leaves the severity unknown, and the record's detail and
  `findings`' answer name that agent by its `subagent_type`. A background agent whose
  turn ends in error or aborted is silent at once, and a stop is held while an agent
  without its block waits to be asked again. Every agent launched during a pass is a
  reader of it, whatever its type, but a norms agent (`norms:…`), left as it is.
  A clean review writes `pass`. A loop stopped by the pass limit writes `fail`. A reviewer's loop (`review_only`) ends
  after its one pass and records its findings' verdict. A `fail` is judged by the
  orchestrator, through its review tool, which can accept it at the same head; the loop
  lifts nothing itself. github refuses a review record written by the session that pushed
  the head. It leaves none when the loop was
  released by the user, when the branch has no pull request, when tracked files have
  uncommitted changes, or when the github plugin is absent or older than 0.12.0. The
  loop's answer then says `record: none — <why>`. A github call that fails with a 5xx, a
  timeout or a dropped connection is asked again up to three times after a short pause;
  if GitHub still fails, the verdict is kept and the answer says the record is still owed:
  the next `findings` or `status` writes it.
- **The band.** A line above the prompt while a skill holds the session: which one,
  the comments kept, the prepared commits waiting for `commit` or `drop`, the pass.
- **`/pr-review:doctor` and `/pr-review:install`** answer with `install.sh`'s output
  (`--check` for doctor) and the remedy for its exit code, with no model turn; the preflight runs once per
  session and each skill reads that it passed.

The matcher reads the command an answer starts with, after an optional `ok,` or
`yes,`. It refuses consent given in other words (`go ahead`, `yes`, `please apply
it`), as the skills themselves do, and a command inside a negation, an aside or a
question (`don't fix this one`, `why not post now`, `fix?`). `hooks/tests/policy.test.ts`
pins each of those cases.

## Tests

```
bash tests/run-tests.sh
```

No network and no GitHub account. The tool's own behaviour is tested by the github
plugin's suite; what runs here is the manifests, the
preflight, the resolver, the triage script, the skill documents, and a contract
test that maps every request a skill makes through the real installed engine and
fails if it names a subcommand, an argument or a formatter that does not exist. Point
`CLAUDE_GITHUB_ROOT` at the github plugin's directory to run that contract test without
the plugin installed:

```
CLAUDE_GITHUB_ROOT=<this repository>/plugins/github bash tests/run-tests.sh
```

The hooks module has its own tests, run by the host against its engine:

```
claude plugin test .
claude plugin validate .
```

## Licence

MIT.
