# claude-orchestrator — design

Status: validated · Scope: a host plugin that packages the orchestration method, the terminal tab tooling and a context gauge that any session can read.

## 1. Goal

One session supervises implementer sessions instead of writing code itself: it writes their briefs, reviews every delivery on the artifact, rotates saturated agents and hands over to a successor before its own judgment degrades. This plugin ships that method as skills, the tab tooling the method needs on macOS, the briefs as templates, and a context gauge that does not depend on any particular status bar.

Everything here was extracted from a working setup: the skills existed as loose files in the user's config directory, the gauge was a patch inside an installed status-bar script, and the briefs were rewritten by hand for every phase. The plugin makes them installable, versioned and independent of that machine.

## 2. Layout

```
.claude-plugin/plugin.json           name claude-orchestrator, semver, MIT
.claude-plugin/marketplace.json      single-plugin marketplace, source "./"
skills/orchestrator/SKILL.md         the rulebook
skills/iterm-agents/SKILL.md         tab management on macOS
skills/iterm-agents/scripts/iterm-agent.sh   entry point: resolves an interpreter
skills/iterm-agents/scripts/iterm_agent.py   the implementation, over the app API
skills/orchestrator/scripts/brief-lint.sh   refuses a brief before it is dispatched
skills/orchestrator/scripts/dispatch-record.sh  one row per dispatch, and the routing signal
skills/orchestrator/scripts/workspace.sh    a clone per phase, with the project's local material
skills/model-routing/SKILL.md        which capability tier a dispatch gets
skills/context-gauge/SKILL.md        how a session reads its own context fill
skills/context-gauge/scripts/context-gauge.sh
skills/context-gauge/scripts/statusline-tap.sh
templates/agent-phase-brief.md       one implementer, one phase, one PR
templates/agent-rotation-brief.md    resume brief for a fresh implementer
templates/agent-review-brief.md      one review round, read-only, one lens per reader
templates/agent-comments-brief.md    one pass over a pull request's open threads
templates/orchestrator-succession-brief.md
commands/install.md                  wires the tap, creates the state directory
commands/uninstall.md                restores the previous status line
commands/status.md                   live sessions, their gauges, the routing pressure
commands/succeed.md                  runs the orchestrator succession
commands/agents.md                   each running implementer's progress
commands/progress.md                 where the build stands
commands/decide.md                   the decision round, one arbitration at a time
hooks/hooks.json                     declares the context gate on UserPromptSubmit
hooks/context-gate.sh                the gate the harness enforces, not the model
install.sh, uninstall.sh
tests/run-tests.sh
tests/e2e.sh                         one real round: a tab, a session, a close
tests/fixtures/transcript.jsonl      a transcript tail for the gauge's computed tier
docs/design.md                       this document
README.md, LICENSE
```

The suite checks this block against the tracked files: it had already lost the hooks,
three commands, two briefs and the fixture while still reading as current.

Skills reach their scripts through `${CLAUDE_PLUGIN_ROOT}`; a relative path does not resolve from a skill. Skills are invoked as `orchestrator:<skill>`.

## 3. Context gauge

### 3.1 Why two tiers

The host exposes the exact context fill in one place only: the JSON it writes to the status line command's stdin (`context_window.used_percentage`, `context_window.context_window_size`, a `current_usage` token breakdown, the 5-hour and 7-day quotas, `session_id` and `transcript_path` — field names read from a captured payload, not from documentation). Hooks do not carry it, and a plugin cannot declare a status line. A session can also compute its fill from its own transcript: the last `usage` block's input plus cache tokens is the context sent on the last turn, within half a point of the host's figure. The transcript needs the window size, which the payload carries as `context_window_size`.

So the gauge has a harness-exact tier fed by a status-line tap, and a computed tier from the transcript that needs no wiring at all. An idle session stops rendering its status line, so its tap file ages; the gauge then falls back to the transcript and says so.

### 3.2 The tap

`statusline-tap.sh [wrapped command...]` reads the payload from stdin, writes one file per session, then feeds the untouched payload to the wrapped command and exits with its status. With no wrapped command it prints a one-line `ctx: N% │ 5h: N% │ 7d: N%` so a user without a status bar still sees something.

The file is `${CLAUDE_CONFIG_DIR:-~/.claude}/claude-orchestrator/ctx/<session-id>.json`:

```json
{"session_id": "...", "context_percent": 36.4, "context_used": 91000, "context_total": 250000,
 "five_hour_percent": 3, "five_hour_resets_at": 1788560000,
 "seven_day_percent": 1, "seven_day_resets_at": 1788900000,
 "transcript_path": "/path/to/session.jsonl", "updated_epoch": 1788553115}
```

The sweep takes both kinds of file the plugin leaves in `ctx/`: the context files, and the
gate's one-shot markers. Taking only the first meant it pruned half of what it makes, and
on the machine where this was found the markers outnumbered the files they sat beside —
twenty-six against nineteen, the oldest four days old.

`context_used` is the sum of `current_usage`'s input, cache-creation and cache-read tokens; `context_total` is `context_window_size`; `transcript_path` lets the gauge open the transcript without guessing its location. One `jq` call parses the payload; missing fields become `null`. The file is written to a temporary name then renamed, so a reader never sees a partial file. Invalid or empty stdin writes nothing and still runs the wrapped command. On the first render of a session (no file yet) the tap deletes files older than one day, so ended sessions do not accumulate.

### 3.3 The gauge

`context-gauge.sh [session-id] [--window N] [--max-age S]` prints `key=value` lines:

```
context_percent=36.4
context_tokens=91000
context_window=250000
five_hour_percent=3
seven_day_percent=1
source=tap            # or transcript
```

The two quota figures are printed in BOTH tiers, and read `unavailable` when the payload
never carried them or when the answer comes from the transcript, which has no trace of
them. They are never omitted: the callers that read this output are told to keep those
lines, and a missing line is one a reader takes for zero — "no budget pressure" exactly
when the pressure cannot be measured.

The session id defaults to `CLAUDE_CODE_SESSION_ID`, which the host sets in every session's environment. The tap file is used when younger than `--max-age` (default 120 s). Otherwise the transcript — the path recorded in the tap file when there is one, else `<config>/projects/*/<session-id>.jsonl` — is scanned backwards for the last `usage` block. The window for that computation comes, in order, from the stale tap file's `context_total`, `--window`, or the default 200000, and `context_window_source=` names which. No tap file and no transcript is an error with exit 1.

### 3.4 Install and uninstall

`install.sh` copies the tap to `<config>/claude-orchestrator/statusline-tap.sh` (a stable path: the plugin cache path changes with every version), creates `ctx/`, then rewrites `statusLine.command` in `<config>/settings.json` as `<tap path> <previous command>`. The previous `statusLine` object is saved to `<config>/claude-orchestrator/statusline.previous.json` and `settings.json` is backed up under `<config>/backups/claude-orchestrator-<stamp>/`. Idempotent: a command already starting with the tap path is left alone. With no `statusLine` at all, the command becomes the tap alone. `--dry-run` prints and changes nothing.

`uninstall.sh` restores the saved `statusLine` (or deletes the key if there was none) and removes the state directory. The tap copy goes with it.

Requirements: `jq` for the tap and the installer, `python3` for the transcript scan, bash 3.2.

## 4. Skills

**orchestrator** is the rulebook as it stands, with three edits: script invocations go through the plugin root, briefs are instantiated from `templates/`, and the gauge is described by pointing at the `context-gauge` skill. Every project-specific fact is removed; the skill states the rule and leaves the project's policy (where briefs live, whether tests are committed, what the durable-artifact policy forbids) to the brief the orchestrator writes.

**iterm-agents** keeps `list`, `spawn`, `close`, `move`, `rotate`, gains `verify` and
`resolve-tier`, and since 0.11.0 drives the app through its own API rather than by typing
into a shell — §14 says what that removed and what it cost. The layout convention is
stated: the orchestrator's tab sits immediately left of its implementer's tab. The spawn
prompt is a one-line "Read and execute <path>" naming the orchestrator's address.

**context-gauge** documents how a session reads its own fill, what each `source=` means, and the duty the orchestrator puts in every brief: report the measured figure, never an estimate.

## 5. Templates

Three Markdown briefs with `{{PLACEHOLDER}}` markers, each carrying the sections the orchestrator skill makes mandatory:

- **agent-phase-brief**: required reading, environment with state-verification commands, scope with contracts verbatim and a non-goals list ending in the STOP-and-ask clause, method, forbidden list, communication protocol with the gauge invocation, delivery, resource envelope.
- **agent-rotation-brief**: phase state, branch state, remaining scope, decisions marked non-reopenable, same protocol.
- **orchestrator-succession-brief**: pointer-based (project state file, spec, plan, runbook, briefs directory), the successor's ordered first task (read, verify on artifacts, re-identify to live agents, confirm takeover, close the predecessor's tab), and the standing user rules that bind the successor.

A brief is written to a path the fresh session can open on its machine, never only into a session's context.

## 6. Commands

- `install` and `uninstall` run the scripts of §3.4 and report.
- `status` lists tap files younger than ten minutes with session id, context percent and age, next to the live-session list the host provides, so an orchestrator sees at a glance who is near the rotation gate.
- `succeed` executes the succession the orchestrator skill describes: refresh the standing brief from the template, spawn the successor with `--left-of` the implementer's tty, wait for the takeover confirmation, answer nothing new meanwhile.

## 7. Tests

`tests/run-tests.sh`, bash, no network, no terminal automation, isolated `HOME` per case:

- gauge: fresh tap file → `source=tap`; stale tap file plus fixture transcript → `source=transcript` with the window taken from the file; transcript only with `--window`; nothing → exit 1; session id from the environment variable.
- tap: file written with every field; payload passed byte-for-byte to the wrapped command and its exit status returned; no wrapped command → the one-line render; invalid stdin → no file, wrapped command still run; stale files pruned on first render.
- install: wraps an existing command, is idempotent on a second run, handles a settings file without `statusLine`, `--dry-run` changes nothing; uninstall restores the previous object exactly.
- iterm script: argument validation paths (`--tty` required, differing ttys) fail before any automation call.
- repository policy: the prose contains no vendor or product name outside the load-bearing identifiers, no model family name anywhere, nothing machine- or project-specific — and the guard proves it can still SEE a violation, through a probe planted and removed by the same function, because it once masked every hit behind the repository's own path.
- model tiers: a bound tier resolves, an unbound one resolves to nothing without erring, an unknown one is refused, the environment overrides the map, a map that does not parse stops the caller instead of passing for an unbound tier, and a rotation whose tier cannot resolve stops before anything else runs.
- version: the plugin and marketplace manifests agree, and the number never falls behind a published tag — the comparison itself is proved on ahead, equal, behind, a double-digit component and no tags at all, so the rule holds when the repository state changes.

## 8. Release

Version in `plugin.json` AND in both fields of `marketplace.json` — the same fact in
three places, so the suite checks they agree and that the number never falls
BEHIND a published tag (equal is a tagged release, ahead is unreleased work; only behind
is the defect). Tag `orchestrator--v<version>` pushed with the code — the prefix
since 0.4.1; the first three releases used `claude-orchestrator--v`, before the plugin
was renamed, and the suite reads both when it checks the version against what is
published. Install:

```
/plugin marketplace add LounisBou/claude-orchestrator
/plugin install claude-orchestrator@claude-orchestrator
/orchestrator:install
```

## 9. Out of scope

Windows and Linux terminal automation (the iterm-agents skill is macOS only; the other two skills and the gauge work anywhere the host runs). A hook-based gauge: no hook event carries context usage. Editing the user's status line script: the tap wraps it, never patches it.

## 10. Model routing

**0.7.0.** Every session the orchestrator dispatched ran at whatever the launcher
hardcoded, which put a model identifier in a plugin whose rules forbid one and paid the
top tier for work a test suite already judges.

The rule is « pay for judgment that nothing downstream re-checks »: a conversion phase is
judged by the suite, a findings list by the orchestrator, so both run cheap; the
contracts a phase imposes on the next, the final verification and the orchestrator's own
sequencing are re-read by nobody, so they do not. Three tiers name capability — `deep`,
`standard`, `light` — and the binding to real identifiers lives in the operator's
`<state dir>/models.json`, overridable per run by `ORCHESTRATOR_TIER_DEEP` and its two
siblings. `iterm-agent.sh resolve-tier <tier>` prints a binding; `spawn --tier` and
`rotate --tier` apply one, and with nothing bound the launcher types no model argument at
all so the host applies its own default. That is the behaviour change behind the minor
version: an existing installation routes to the host default until the map is filled.

`skills/model-routing/SKILL.md` carries the table by class of work, the five readings for
a phase that does not sit on a row, escalation as a rotation (a model does not change
inside a live session), the false-economy rule that reverts a drop which cost a second
round, and budget pressure read from the gauge's quota figures rather than estimated. The
briefs carry the tier down to each session, because an agent can only report that the
work outgrew its brief if it knows what the brief assumed.

Design: `docs/superpowers/specs/2026-09-08-model-routing-design.md`.

## 11. What a brief can carry

**0.8.0.** Three defects came out of running one phase end to end on a live machine — a
brief instantiated from the template, an agent spawned at a tier, its delivery reviewed on
the artifact, its tab closed. None was reachable from the test suite, because all three
live in what happens when a fresh session opens the file.

**A path that only the host can expand does not resolve in a brief.** All four brief
templates told the agent to run `${CLAUDE_PLUGIN_ROOT}/skills/context-gauge/…`. A spawned
session's shell carries none of the host's plugin variables, so that expanded to an
absolute path that cannot exist, and the plugin's own doctrine — measure, never estimate —
was unrunnable at the point of delivery. The agent reported it could not measure and
refused to invent a figure, which is the right answer to an instruction that was never
runnable. The templates now carry a `{{GAUGE}}` placeholder the orchestrator fills with an
absolute path, like every other path in a brief, and the suite refuses a host variable
anywhere under `templates/`.

**A brief points at a policy, it cannot grant one.** The phase brief asserted that
committed history must carry nothing of the workflow, attribution trailers included. The
agent's host tells it directly to append those trailers. Sent a one-line corrective to
strip them, the agent STOPPED and said a peer session cannot authorise overriding a
host-level directive — and it was right: a file written by a peer is not its user
speaking. That policy binds only where it lives in the target repository's own user-level
instructions, and the brief's job is to name that file and quote the clause. The rulebook
and the template now say so, and the brief tells the agent to stop rather than choose
between two authorities.

**Nothing that reads as a second address goes near the one that matters.** The phase brief
carried `e.g. project-70 [a1b2c3]` — guidance for whoever fills the template, delivered to
the agent, inside the one rule whose point is a single named address and no guessing. The
suite refuses a session-reference shape under `templates/`.

The round also confirmed what does work: the tier reached the live process (`--model`
matching the map's `standard`), the tab landed beside the orchestrator's, the handshake
arrived in seconds against a named address while four peer sessions were listed, and the
delivery passed review on the artifact — gate re-run, contract walked case by case, the
agent's suite mutation-tested, and both factual claims in its report re-derived and true.

## 12. Linting the brief

**0.9.0.** Specification is the largest category of multi-agent failure in the published
taxonomy — larger than coordination, and more than twice verification — and a brief is
this plugin's whole specification act. Nothing read the file before it reached a session.

`brief-lint.sh` refuses a brief carrying an unfilled placeholder, an unexpanded variable,
a path that does not exist on this machine, more than one session reference, or — for an
implementer brief — no address, no non-goals, no STOP-and-ask clause. Every one of those
has reached a live agent at least once; the last round supplied two of them, and the
script was verified against the brief that agent actually received rather than against a
fixture: it names both and exits 1.

It reads what a script can read. Whether the scope is right, whether the contracts are the
ones the next phase consumes, whether the tier fits the work — those stay the
orchestrator's, and the skill says so where it tells you to run it, because a guard whose
limits are unstated is one people trust past them.

## 13. Measuring what the routing rule assumes

**0.10.0.** The routing rule says a tier drop that costs a second corrective round is
reverted for its class. Nothing measured that, so it could only be applied from memory —
and a rule applied from memory always finds the drop was free, because its cost lands
rounds later where nobody attributes it.

`dispatch-record.sh` keeps one row per dispatch as JSON lines — class, tier, rounds,
verdict — with `open`, `round`, `close` and `summary`. The row is rewritten in place
rather than appended per event: a record of events would make every read a reduction over
history, and the history is not the fact. `summary` prints a line per class and tier, then
the one the rule exists for: `signal=<class> at <tier> averages N rounds: the drop did not
pay, revert it for this class`.

The record lives with the PROJECT being built. The default table ships here; a project's
corrections belong to that project's state, where status lives once.

## 14. The terminal tooling speaks the app's own API

**0.11.0.** Every expensive launch bug this plugin carried came from one decision: the
command was TYPED into a fresh shell. Typed, it could be truncated past a few hundred
characters while the script reported success; typed, a startup question ate its first
keystroke twice in one night; typed, it had to be quoted for AppleScript, which died on a
non-ASCII byte under a C locale. And placement drove a menu through System Events, which
needed an Accessibility grant, the app in front, and a focus flicker per move.

The app has an API. `async_create_tab` takes the command and the index directly, so none
of that exists here: the launch is handed over, the tab is born where it belongs, and
`async_set_tabs` reorders without touching a menu. Two macOS approvals become one.

The surface is unchanged — same subcommands, options, messages and exit codes — because
skills, commands and briefs call it by those. `iterm-agent.sh` is now a launcher that
resolves an interpreter and hands over to `iterm_agent.py`; the module the app needs is
imported only by the subcommands that talk to it, so reading the tier map or a tty works
on a machine with no environment and no window server.

Three things the live probe found that no documentation says:

- **The tab gets no login shell.** The app runs the launch as the session's program, with
  a bare default PATH that does not contain the package manager's bin directory. The first
  spawn died instantly and reported a tty belonging to nothing. The launch now names the
  CLI by absolute path, resolved from the orchestrator's own environment.
- **The app splits the command into words itself**, so a compound command handed over raw
  is run by no shell at all. The launch goes to a file and the app is asked to run
  `/bin/sh <file>`: a path has no quoting, and quoting for someone else's tokenizer is the
  losing game the typed version already played.
- **A window's tab list is a cached copy.** A reorder read back through the object already
  held reports the position the tab used to have. Re-fetch the app after any mutation.

The environment is the installer's: `python3 -m venv` under the state directory plus the
app's module, 19 MB. Recent macOS refuses to install into a package-managed interpreter,
and a plugin has no business writing into one it did not create. Without it the tooling
refuses to run and says how to build it.

Cost paid: seventeen guards that read the old implementation's source are gone, replaced
by checks that read what the launch SAYS. That is a gain — a guard reading an
implementation is green on the day the implementation changes shape and wrong the day
after.

## 15. The round the suite cannot play

**0.12.0.** `run-tests.sh` proves the plumbing and cannot touch the choreography: it
forbids terminal automation, so the acts the tooling exists for — placing a tab, verifying
a session, killing it — were held by argument checks and by reading the implementation's
own source. Every defect the last two rounds found lived in exactly that gap.

`tests/e2e.sh` plays one real round: a brief instantiated from the template and linted, a
dispatch recorded, a session spawned at a tier, the tab placed against its anchor, the
title guard exercised, the tab closed, the process confirmed gone, the record closed. It
asserts the one thing no dry run can — that the tier named at dispatch is the model the
LIVE PROCESS carries — and it exercises the brief lint, the dispatch record and the tab
tooling together, which nothing else does.

It is deliberately NOT part of the default suite. It drives the terminal, it starts a
session that costs tokens, and it needs the app running with its API enabled: a suite that
cannot run in a checkout with no window server is a suite people stop running. It skips
itself off macOS and stops with a clear reason when the tooling cannot reach the app.

It does not talk to the agent. Handshakes, verdicts and reviews need judgment and stay the
orchestrator's; this holds the mechanism underneath them.

## 16. Cascading where a retry is cheap

**0.13.0.** Routing by rule, before the work, is what the table does. The cheaper strategy
in the published work is a cascade — try the cheap model, escalate when the result does not
hold — and it reports very large savings on one assumption: that a failed attempt is cheap
to detect and cheap to discard.

For an implementation phase that assumption is false and expensively so, because a failed
attempt is a review round plus a rework round. For a review lens, a read-only search
subagent, and an N-bis narrow enough for the project's gate to judge, it holds: a machine
says whether the attempt stood, and throwing it away costs one short session.

So the skill cascades exactly there, one tier below the table's row, and the record marks
the row `--cascade`. `summary` reports `cascade=<class> at <tier>: N of M paid` and says
`stop cascading` below half over at least two attempts. The marking is the point: unmarked,
a cascade that failed is indistinguishable from a row that needed two rounds, and nobody
can tell an economy from a cost — which is the same failure the record was built to end.

## 17. A second reader, armed by evidence

**0.14.0.** The published measurements of model judges are lopsided in a way that decides
the design: a strong judge rarely invents a defect and regularly misses one. What a review
costs is what it did not see, and a missed defect leaves no trace in the round that missed
it. The recommended mitigation is a panel of differing readers with a consensus rule.

A standing panel is not shipped here, and the reason is stated in the skill rather than
left as an omission: the compensating control is already stronger than a vote, since the
orchestrator verifies every finding on the artifact and mutates the tests a verdict rests
on. Paying for a panel on every round would buy less than that costs.

So the panel is armed by evidence instead. `dispatch-record.sh escaped <record> <id>`
records an approval a later round contradicted; `summary` then prints
`signal=double-read <class> at <tier>`, and from that point the class gets a second reader
with a DIFFERENT lens, a finding surviving only when both see it. A different lens is the
condition that matters: two readers asked the same question agree by construction, and
agreement bought that way is a gate green over nothing.

## 18. The directives that outlived their decision

**0.15.0.** The plugin's own rule says a directive that outlives the decision it served is
read as current by the next session, and that what loses its subject is removed rather than
kept. Six versions in ten hours had left four of them, and one was worse than stale:

- §4 still described the tab tooling as it worked before 0.11.0, while §14 described what
  replaced it — a document contradicting itself, which is worse than one merely out of date.
- A rationalization gave a reason that no longer exists (« a typed command can be truncated »)
  for a conclusion that still holds. The conclusion was kept and the reason rewritten: a
  launch can still be refused, exit at once on a name it cannot find, or die on its first line.
- The handshake step told the reader to inspect a tab through a scripting bridge the tooling
  no longer uses.
- The install command described an installer that has since grown two more jobs.

And three commands had never been wired to what the last versions built: `progress` now reads
the dispatch record's summary and says what each `signal=` obliges rather than printing a
number to interpret; `agents` reports the tier each agent was dispatched at, from the brief or
the record and never from the agent, which cannot see its own; `uninstall` says which two files
leave with the state directory that no backup holds — the operator's tier bindings and the
record of what every session was launched with.

## 19. What a live rotation found

**0.16.0.** The end-to-end round gained the one operation that kills something, and with it
the property that order exists for: a rotation whose replacement cannot start must leave the
old session alive. Checking only that a good rotation works would pass equally on a script
that closed first and spawned second — the one outcome that loses work.

Running it found two defects that no dry run could reach.

**A tab can come back from creation before its session is attached to it.** `current_session`
reads None and the attribute error that follows names nothing useful. It is a race, so it is
intermittent: the first probes never saw it, and the fourth spawn of one run did. The tty is
waited for now, re-fetching the app rather than trusting the copy in hand.

**The title guard was unreliable in the operation it protects.** The first character of a
session's title is an activity glyph the session flips itself — one shape while it works,
another once it idles. A rotation stands the old agent down and then spends ten seconds
bringing up its replacement, so a title captured before and compared after is guaranteed to
differ, and every rotation was refused by the guard written to make its close unambiguous.
Both sides are compared with the glyph stripped, so a caller that captured it still matches
and a genuinely different title still does not — but the glyph was only half of it. A
session rewrites its whole title to say what it is doing, so across a rotation's ten seconds
the string can change entirely. `--expect-title` is therefore right for a standalone close,
where the title is read seconds before and nothing runs in between, and wrong for a
rotation, where the guard is the stand-down the old agent acknowledged and the tty that
identifies it. The skill says so in both places.

One spawn out of roughly six returned no tty during these runs, and its mechanism is not
named: the check swallowed stderr, so it reported an empty string where a diagnosis was
available. It keeps stderr now and prints what the spawn said. That is not a fix and is not
recorded as one — it is the next occurrence made able to explain itself, which is what is
owed to a fall whose cause nobody has established.

## 20. A running process is not a launched agent

**0.17.0.** The operator supplied the evidence: a screenshot of an agent tab stopped on the
host's workspace-trust question, and a note that every spawn stole the focus of whatever
tab they were working in.

**The trust question.** A directory the host has never opened stops the session on a safety
check whose highlighted answer is « exit ». Nobody sits at that keyboard, so the session
waits for ever having never read its brief, or takes a stray keystroke and quits. From
outside both look like a launched agent, because the process genuinely runs — which is why
the end-to-end round had been passing while its sessions sat on that question, and is the
most likely mechanism behind the intermittent spawn that returned no tty. The launcher now
refuses such a spawn before making a tab, and `--trust` records the answer for ONE
directory. It is a flag rather than a default because it writes to the host's own record
and bypasses a safety check: right for a checkout the orchestrator prepared itself, wrong
for anything else.

**The focus.** Tabs are created unselected. A launch that pulls the window across
interrupts whoever is working in another tab, every time an agent starts.

**Reading a stuck tab.** Migrating to the app's API dropped the scripting bridge, and with
it the ability to see what a session is showing — the very thing the skill tells you to do
with an agent that has not shaken hands. `screen --tty` restores it, and the round now
asserts that a session got past its startup questions rather than merely that a process
exists.

**The intermittent spawn is explained.** One launch in roughly six returned no tty, with no
mechanism named — and this is it: the trust question's highlighted answer is « exit », so a
session that takes a stray keystroke quits before its tty can be read. After the fix, five
consecutive end-to-end rounds, twenty-three checks each, zero failures, the tab count
identical before and after every one. It was never flaky; it had a cause.

Temporary files across the plugin are anchored to `TMPDIR`: the platform default can be a
directory a restricted shell may not write to, and a script that fails there fails on a
path it never chose.

**decide** (0.4.2) is the decision round: the orchestrator collects every arbitration that is the user's — agents' STOPs, proposed owners, review findings without one — and puts them ONE AT A TIME, each with its context in plain words, two to four choices carrying their cost, one recommendation, then waits; the ruling is written back in one line, recorded where it lives, relayed to the agent it answers, and only then the next question comes. A question interrupted by anything else is re-presented in full, never referenced. Written after a day on which twelve arbitrations were put that way and every one was ruled in a minute, where batching them had stalled for hours.

## 21. The tab is born in the anchor's window, after the last agent

**0.17.1 / 0.18.0.** The operator supplied the evidence again: two windows open, an
orchestrator in the second, and its agent's tab appearing at the end of the first. The
round that reproduced it on the current head is short: `spawn --right-of /dev/ttys002`,
with that tty in window 2, made the tab at w1/t5 and printed success.

**The window was chosen by focus.** `cmd_spawn` took `app.current_window` — whichever
window was in front — and searched the anchor only among that window's tabs. An anchor in
another window was simply not found, `index` stayed `None`, and the tab was appended at the
end of a window that had nothing to do with it. The convention (§ Tab layout in the skill)
says the orchestrator's tab sits immediately left of its agent's; the code could not honour
it whenever the operator was looking at another window, which is exactly when a launch
happens unattended.

Two rules replace it, one per release, because one is a repair and the other a behaviour.

**The window is the anchor's** (0.17.1). An anchor is resolved with `find_tab`, across every
window, before anything else has a side effect — before the trust record is written, before
a prompt file is made. The tab is created in the window that holds the anchor, at the
anchor's index plus one for `--right-of` and at its index for `--left-of`. An anchor that is
given and not found is a refusal — `spawn: no session found on <tty>` — never an append: a
tab that lands somewhere is worse than no tab, because the script has said where it is and
the orchestrator believes it. A spawn with no anchor keeps today's behaviour, the end of the
current window, and the skill keeps saying not to use it.

**Each new agent goes after the orchestrator's last one** (0.18.0). `--right-of self` used
to mean « immediately right of my tab », so a second agent slid in between the orchestrator
and the first, and a window read right to left told the launch order backwards. The
operator's rule is the natural one: orchestrator, agent 1, agent 2, … in the order they
were launched. The launcher keeps a **chain file** per orchestrator tty under the state
directory — `chains/<tty>.jsonl`, one line per spawn: the new tab's `tab_id` (the app's own
identifier, never recycled the way a tty is) and its tty. Resolving `self` reads the chain
from its tail and takes the first entry whose tab still exists in the orchestrator's window;
entries whose tab is gone are dropped on that read; an empty or exhausted chain anchors on
the orchestrator itself. `close` drops the entry for the tty it closed. A tty is recycled
minutes after a close, so the chain is checked on `tab_id`, not on tty: an entry whose tty
now belongs to a stranger's tab does not match and is pruned.

`ORCHESTRATOR_SELF_TTY` overrides the process-tree walk that finds the caller's own tab, so
the chain's resolution can be tested where there is no terminal: a dry run seeded with a
chain file prints the anchor it would use.

What the suite reads: a dry run with `--right-of self` and no chain prints `anchor=self`;
with a chain of two, `anchor=<the second's tty>`; a dry run never writes a chain, because
there is no tab to record. What only the live round can read: an anchor that is not there
is refused before a tab exists, a second probe lands immediately right of the first rather
than of the orchestrator, and after both are closed the chain no longer names them.

## 22. The tab runs its launch through a login shell

**0.19.0.** The operator's rule: every binary the package manager installs must be on an
agent's PATH, because an agent must be able to run the commands the operator runs. The
finding behind it: no spawned session could open a pull request. `gh` typed bare was
`command not found`; typed by absolute path it ran sandboxed and could not read the keychain,
so it reported a valid token as invalid. Read on the process with `ps -E`, a spawned session
carried `PATH=/usr/bin:/bin:/usr/sbin:/sbin:` and the app's own utilities — the bare default
§14 describes, inherited by every command the session runs.

§14 solved the launch's own problem — finding the CLI — by naming it absolutely, and that
stays: a launch must not depend on the operator's dotfiles to find the program it runs. What
the login shell is for is the SESSION: the app is now asked to run `<login shell> -l
<launch file>` rather than `/bin/sh <launch file>`, so the environment the CLI inherits, and
hands to every command it runs, is the one the operator's own terminal has. The login shell
is `ORCHESTRATOR_LOGIN_SHELL`, else `SHELL`, else `/bin/zsh`; measured on this machine, it
puts the package manager's directory first, costs 0.03 s and writes nothing to stdout. A
non-interactive `-l` reads the profile files and not the interactive ones, which is the
environment without the prompt.

The alternative — a fixed `PATH` in the host's settings — was refused by the operator's
peer session with the right reason: it would replace every session's rich environment
(version managers, language toolchains) with a frozen list. The launcher is the one place
that knows a session is being born, so the launcher is where the shell is chosen.

What the suite reads: the dry run prints `program=<shell> -l <launch-file>`; the launch text
itself is unchanged and still `exec`s the CLI by absolute path. What only the live round can
read: the `PATH` of the spawned process, through `ps -E`, contains the first entry of a
login shell's own `PATH`.

## 23. The operator decides; the orchestrator runs

**0.20.0.** The operator's ruling, after an afternoon in which the orchestrator handed him
three command lines — open this pull request, run this live round, refresh this credential:
« everything you ask me to do, you can do yourself; I am here to decide, nothing else ». He
was right on every count. Each line had a reason that was true of the orchestrator's SESSION
— a reduced PATH, a keychain the sandbox would not open, a nested script no exclusion covered
— and none was true of the orchestrator's ROLE. A session limit is repaired by the
orchestrator: a successor spawned with the environment the task needs, a configuration
request with its measurement, a launcher change. It is never delegated upward, because the
operator adds nothing to a command he did not write and cannot check, and every such line
costs him the attention the arbitrations need.

So the rulebook now says it in one place, and the suite reads that it does: **a command the
orchestrator could run is the orchestrator's to run.** Opening, merging and tagging pull
requests, running the live round, updating the installed plugin, restarting the sessions a
change requires, pinning a head for review — all of it. What reaches the operator is an
arbitration: two readings, what each costs, one recommendation — and the rule already says
those come one at a time with their context. A request for a configuration change is not an
exception: it goes to whichever session owns that configuration, as a request with the
reading that justifies it, and the operator hears of it as a decision if that session asks him.

The corollary the day also taught: **when the orchestrator's own session lacks what the role
needs, the fix is a successor, not a favour.** A session launched before the launcher learned
the login shell has no way to gain the PATH; the rulebook's succession exists for exactly
that — spawn the successor through the current launcher, hand over, close the old tab. The
successor is the proof that the launcher change worked, read on its process.

## 24. A session is named at launch

**0.21.0.** The operator's ask, after the phase-4 implementer came up in the listing as
`project-70 [a1b2c3]` beside an orchestrator whose name was `project-70` too, the two differing only in their six-character reference:
give agents and orchestrators clear names. The host names a session from its directory
stem plus a suffix, so two sessions in one checkout share a name and differ by a reference
nobody reads at a glance — the rulebook's coin toss, observed on the orchestrator's own
dispatch.

The host takes a name at launch: `--name <name>`, « shown in the prompt box, the resume
picker and the terminal title », with a variant applied when a live session already holds
it. The launcher now passes the spawn's `--title` as that name, so a title is no longer a
transient tab label the shell overwrites but the session's own name, and the convention
becomes the rule, in the operator's format: `Orchestrator : <feature>` for an orchestrator and
its successor, `Implementer : <phase>`, `Reviewer : <round>` — never the bare `agent`.

What the suite reads: the launch text carries `--name` with the title, byte for byte,
including a title with non-ASCII bytes. What only the live round can read, and the
orchestrator reads on the first spawn: whether the listing other sessions see shows that
name. The host's text does not promise it; if the listing keeps its own stem, the title
still names the tab and the resume picker, and the brief keeps citing name and reference
together — the reference is what disambiguates in every case.

## 25. A hidden pane is still a session

**0.21.1.** The operator reported a critical case: a successor could not close its
predecessor, sitting in the first tab of the window, because the tooling did not list it.
`list` printed the tab with ANOTHER session in it — a code review the terminal's host
extension had opened — and `close --tty` answered `no session found`, while `ListAgents`
showed the predecessor alive and answering. When the review closed, the predecessor was
listed again and the close passed.

**The mechanism, reproduced on a probe.** The extension's « Chat / Diff / Code Review »
bar opens each view as a sibling pane in the SAME tab and maximizes the one shown. A
maximized pane hides its siblings, and the app's own session list reports a tab's hidden
panes apart from its visible ones: split a probe tab in two and both sessions are
enumerated; maximize one and only it remains in the tab's session tree, the other moving
to the tab's `minimized_sessions`; restore and both are back. The library mirrors that
split: `Tab.sessions` is the visible tree, `Tab.all_sessions` adds the minimized ones. Every
reader in the tool used `sessions`, so a session behind a maximized sibling was invisible
to `list`, `find_tab`, `screen` and `close`, and nothing in the tool skips a tab index —
that was checked on three versions before the pane was found.

**Two rules.** Every reader enumerates `all_sessions`, and the listing says when a row is
hidden — a fourth column, `hidden`, on that row alone, so a reader that greps a tty still
finds it and an operator sees why the tab shows something else. And `close` closes the
SESSION, never the tab: `tab.async_close` would have taken the review pane down with the
agent, and with the extension in use that is a tab the operator is reading. A session
closed alone leaves its siblings and, when it was the last one, the app removes the tab
itself. `screen` reads a hidden session like any other; `verify` never looked at the
app.

**The convention, in the skill.** One agent = one tab, never a pane; and a session alive
in `ListAgents` but absent from `list` was the symptom of this defect, not a rule to keep.

What the suite reads, on a stub of the app: a session that only `all_sessions` returns is
found by its tty; the listing marks it `hidden`; closing a session calls the session's
close, and a tab's close is never called. What only the live round can read: a probe tab
split in two with one pane maximized lists both, `close --tty` on the hidden one succeeds,
its sibling is still listed, and the sibling closes with the tab.

## 26. A chain belongs to a session, not to a tty

**0.21.2.** Found by the verification round after 0.21.0: a `spawn --right-of self` from
the successor orchestrator landed the probe LEFT of its own tab. The chain file for its tty
held an entry written earlier that day by a previous occupant of the same tty — the
orchestrator before its predecessor — naming the predecessor's tab, still open at that
moment. The entry passed the tab-id check (§21), which only asks whether the tab exists,
and the anchor resolved to a tab that was never this session's agent. The mirror image
existed too: the predecessor's chain named the successor as its agent.

**A tty is recycled; a session id is not.** §21 keyed the chain on the orchestrator's tty
because that is what `self` resolves to, and guarded each entry on the agent's tab id —
which protects against the AGENT's tty being reissued, not the ORCHESTRATOR's. Every entry
now also carries `owner`: the app's session id of the orchestrator that wrote it. Reading
a chain live, the tool reads the session id of whoever sits on the tty now and keeps only
the entries that name it; the rest are dropped and the file rewritten, exactly as
entries whose tab is gone already are. An entry without an owner — one written before this
release — is dropped the same way once an owner is known. The file keeps its name, because
`self` still resolves to a tty and a file per tty is what `close` sweeps.

A dry run has no app and so no session id; `ORCHESTRATOR_SELF_ID` stands in for it, and
with neither the chain is read unfiltered, which is what the existing dry-run checks seed.

What the suite reads: with an owner given, a foreign entry is skipped and an own entry
anchors; an entry with no owner is skipped when an owner is known; the anchor line of a dry
run says which. What only the live round can read: the chain written by a live spawn
names its owner.

## 27. The successor inherits the orchestrator's model

**0.22.0.** The operator's ruling, verbatim in substance: « no default model — the
successor inherits the orchestrator's model; if I change the orchestrator's model, the
successor inherits that one ». The succession command spawned the successor at the `deep`
tier, so a succession re-routed through the operator's map and silently undid a model the
operator had set by hand: the verification-round successor was running on a model the map
did not name, kept only because its predecessor had typed `--model` explicitly.

**The model to hand over is the CURRENT one, not the launch one.** A session's process
arguments say what it was launched with, and the operator may have switched models since.
The host's status payload carries the model in use on every render, and the context tap
already records that payload for the session: it now keeps the model id beside the
context figures. The launcher gains `--inherit-model`: it reads the tap file of the calling
session (`CLAUDE_CODE_SESSION_ID`) and types that id as `--model`. It is exclusive with
`--tier` and `--model`. Without a tap file, or with one that carries no model, the spawn
refuses and names the installer — a succession must not guess a model, and the ruling
forbids a default. The succession command uses it in place of the tier.

The tier map keeps binding what it binds — implementers, reviewers, probes. An
orchestrator's FIRST instantiation is the operator's launch, and the model it carries from
then on is the operator's choice, carried across every succession.

What the suite reads: the tap writes `model_id` from a payload that carries it and `null`
from one that does not; a dry-run spawn with `--inherit-model` and a seeded tap file types
that model; with no tap file it refuses and names the installer; combined with `--tier` it
is refused; the succession command spawns with `--inherit-model` and no tier.

## 28. The orchestrator never implements through a subagent of its own

**0.22.1.** The operator's finding, on running orchestrators: at their succession they
ordered their successors to execute the plan in subagents of their own session. The
rulebook's first sentence — you orchestrate, you never implement — was read as « never
write code yourself », and a subagent was taken for someone else. It is not: a subagent's
diff is the orchestrator's own diff, and its reviewer would be its writer. The whole method
rests on the writer and the reviewer being different sessions.

**The mechanism is a directive that outlived its decision (§18), in a foreign template.**
Every plan written with a plan-writing skill opens with that skill's execution header —
« For agentic workers: REQUIRED SUB-SKILL: use the subagent-driven skill or the
plan-executing skill » — the succession brief says « read the plan », and the meta-rule
loaded at every start says a matching skill MUST be invoked. A fresh successor obeys all
three. The rulebook forbade IMPLEMENTERS from delegating and let the REVIEW session fan out
readers, but never named the orchestrator's own subagent as the violation.

**The rule, stated where the successor reads it.** The rulebook names it as a standing
rule, a red flag and a rationalization: the orchestrator never implements through a
subagent of its own — not the host's agent tool, not a plan-execution skill; implementers
are sessions it spawns, one brief per phase; a plan-writing skill's header is that
template's boilerplate, replaced when the plan is written and ignored when one is read;
read-only search subagents stay allowed, as for implementers. The succession brief template
carries the same sentence in its first paragraph. Every plan in this repository opens with
the orchestrator's header instead — executed by implementer sessions the orchestrator
spawns — so a reader finds no order to the contrary.

What the suite reads: no plan under `docs/superpowers/plans/` opens with the foreign
header; the rulebook carries the rule; the succession brief template carries it.

## 29. The tracebacks a spawn leaves on stderr are the library's, and they stay

**Not released.** Since 0.18.0 every spawn prints library tracebacks on stderr — « Task
exception was never retrieved », each ending on a websocket our side had closed — and then
a tty that is right. A corrective release was opened to remove them and shelved after one
review round, because the removal costs more than the noise.

**The mechanism, read on the artifact.** Getting the app object subscribes it to layout and
focus notifications; creating a tab is a layout change; the library dispatches each
notification as a task of its own. The launcher opens a connection per step — the chain,
the anchor probe, the creation — and each `run()` builds its own event loop. When a step's
coroutine returns, the library cancels its dispatcher and helper tasks without awaiting
them, and the block that owns the socket closes it. The helper tasks that were mid-flight
end on the closed socket with an exception, and that exception is reported when the
finished task is collected — when the next `run()` closes the previous loop, or at exit —
never while the loop that owns it is still running.

**What was tried, and why it did not hold.** A settle step that awaits pending helper tasks
before the coroutine returns: instrumented on a live spawn, it finds none on any pass — the
only live tasks are the socket's own and the dispatcher's — because the failing tasks are
either not yet dispatched or already finished. The suite's stub made it green by creating
helper tasks by hand on the same loop right before the settle, a timing that never occurs
against the app: a gate green over what it does not read. A per-loop exception handler
installed inside the coroutine: the reports still print. Both readings were taken on a
pinned clone with the live round, which is the only instrument that reads this at all.

**The decision.** The noise is cosmetic: the spawn succeeds, the tty is right, the chain
entry lands. A fix that holds would either reduce the launcher to one connection and one
loop per spawn, with the teardown drained under our control, or filter the known lines in
the shell wrapper — which hides the diagnoses the stream exists to carry. Neither is worth
the surgery for a stream the orchestrator reads only on failure; when it does, the known
lines are few and identical, and what follows them is the diagnosis.

What the suite reads: nothing — this section records a limitation, not a mechanism. The
live round's spawn check keeps stderr and prints its last lines on failure, which is where
a real diagnosis surfaces above the known noise.

## 30. A checkout per phase, with the project's local material

**0.23.0.** Two rules of the method were held by discipline alone. « One writer per
repository » meant the orchestrator queued every dispatch behind the checkout it shares with
its implementer, and lent that checkout away for the length of a phase. And a sandbox that
should let an implementer write under one root could not: a git worktree writes into its
source repository's `.git`, so no single allowed path contains it. A clone contains
everything it touches, and a clone per phase turns the one-writer rule from a queue into a
fact.

**The gap a clone opens, and the reason nothing did this by hand.** A clone carries what
git tracks and nothing else. A project's `<repository>/.claude/` directory is ignored, so a session in
the clone reads a bare project — no local settings, no agents, no briefs — and behaves like
a stranger's. What a repository keeps out of history on purpose (`.git/info/exclude`: the
instruction file that must never be committed, a local plan) is absent too, and so are the
files a project needs and never tracks (an environment file, a decrypt key). The rulebook
already named the copy as the orchestrator's housekeeping; done by hand it was done
sometimes, and a clone makes the omission systematic rather than occasional. So the copy is
part of making the checkout, not a step after it.

**The script.** `skills/orchestrator/scripts/workspace.sh`, bash 3.2 like its neighbours.
The root is `ORCHESTRATOR_WORKSPACES`, else `~/dev/workspaces`; a checkout lives at
`<root>/<repository name>/<name>`, the repository name being the source directory's
basename.

- `create <source> <name> [--base <ref>]` prints the checkout's path on stdout and nothing
  else there. It refuses a source that is not a git repository, a name outside
  `[A-Za-z0-9._-]`, a target that already exists (a stale checkout is deleted on purpose,
  never overwritten), and a base ref the source does not know. It clones from the local
  repository — fast, offline — on the base branch (default: the source's current branch),
  then points the clone's `origin` at the URL of the source's `origin`, so the
  implementer's `git push -u` reaches the real remote; a source without `origin` yields a
  clone without one, said on stderr. Then the copy below. The implementer creates its phase
  branch itself from the base, as today. Nothing is left half-made: a copy that fails
  removes the clone and names the error.
- `delete <path> [--discard]` refuses a path outside the root, always. It refuses a dirty
  tree or a commit on no remote branch unless `--discard` is given — the guard that keeps a
  shelved phase's work from vanishing before anyone said so, since its branch is deleted on
  the remote before the checkout is. It removes the directory and prints `deleted <path>`.
- `list` prints one line per checkout under the root: path, branch, short head, `clean` or
  `dirty`, `pushed` or `unpushed`. It is what a successor reads to know what is lying
  around.
- Every refusal is one line `workspace: <reason>` on stderr and exit 1, the launcher's
  contract. The script never writes the trust record (that is `spawn --trust`), never
  launches anything, never touches the source.

**The copy**, from the source to the clone at the same relative path, in this order:

1. The project's `<repository>/.claude/` directory, whole, when it exists.
2. The files `.git/info/exclude` designates — listed by git itself, `git ls-files --others
   --ignored --exclude-from=.git/info/exclude`, so the patterns are read the way git reads
   them and only present files are copied.
3. The optional manifest `<repository>/.claude/workspace-manifest`: one path per line relative to the
   repository root, `#` for a comment, a file or a directory (copied recursively). A path
   that is absent is said on stderr and skipped, not an error — a manifest serves more than
   one machine. A path that leaves the repository (`..`, absolute) is refused.

Never copied, even when listed: `.git`, `node_modules`, `vendor`, and anything `.gitignore`
covers that the manifest does not name. Build trees and caches rebuild; copying them makes
a huge checkout and copies secrets by accident. `create` says what it copied, one stderr
line per category with a count, so the orchestrator reads once what the checkout carries.
When the source is this repository, the copy carries the orchestrator's briefs and state
file too: intended, the implementer reads its brief at the same path, and none of it is
committed since `<repository>/.claude/` is excluded. What was copied is kept out of the
checkout's own history the way the source keeps it out of its own — the source's exclude
file is appended to the checkout's, and the settings directory and each manifest path are
excluded by name — otherwise every checkout reads dirty from birth and `delete` refuses it
for work that is not work.

**The method, three touches.** The dispatch is `workspace.sh create <source> <phase>
--base main` then `spawn --dir <path> --trust --right-of self …`, and the brief cites the
path as its working directory. Closing a phase — merged or shelved — is stand-down, tab
closed, `workspace.sh delete <path>`, `list` as the proof. The orchestrator's own checkout
is never lent to an implementer again; it writes its specs and plans there and nothing else
happens in it. In the rulebook, « One writer per repository at a time » becomes « One
writer per checkout, and a checkout per phase »: the rule stays, the clone makes it
structural. Two implementers on two phases of one repository become possible when their
files are disjoint and their pull requests stack; this release does not promise it and the
text does not either. « Environment preparation is orchestrator housekeeping » names the
script in place of « worktree setup » and the copy by hand; « Launch » cites create then
spawn; « Terminate » adds delete. The phase brief template's environment section gains
the sentence that the checkout is a clone made for this phase, that `origin` is the real
remote, and that the base branch is checked out. The succession brief's first task reads
`workspace.sh list`.

**A prerequisite, not a deliverable.** The root must be writable under the sandbox for
implementer sessions and readable for the orchestrator's clone. That is a request to the
session in charge of the host's configuration, carrying the path and the commands, per the
operator's rule; the live round needs it, the suite does not.

**Out of scope, on purpose**: several implementers on one repository, a `--workspace` flag
on `spawn`, migrating the sibling builds' sessions, any cleanup by age.

What the suite reads, on a temporary repository it makes with a fake `origin`, a
`<repository>/.claude/` directory, an exclude file naming one file, a manifest naming one present and one absent
file, and a `node_modules` tree: `create` prints the expected path under the root; the
clone is on the base branch at the source's head; its `origin` is the source's `origin`
URL; `<repository>/.claude/` is copied; the excluded file is copied; the manifest's present file is
copied and its absent one is said on stderr; `node_modules` is not copied; `create` on an
existing target refuses and leaves it intact; `delete` refuses an unpushed commit, accepts
with `--discard`, and the path is gone; `delete` refuses a path outside the root; `list`
shows the checkout as `clean | unpushed` after a local commit. The live round launches its
probe in a checkout the script made from the round's repository, with `spawn --trust`,
reads that the session runs in it, and deletes it after the close: the proof that trust and
the sandbox let a fresh root through.

## 31. The trust record is the host's file too

**0.23.1.** Three readings of the trust gate (§20), taken by the operator on a machine
with twenty-seven entries, once a checkout per phase (§30) made the gate run at every
dispatch.

**A record that already says yes was rewritten anyway.** `spawn --trust` wrote the record
without looking at what the gate had just read, so every dispatch into a trusted checkout
rewrote a file the host rewrites itself — a window, for nothing, in which one of the two
loses an entry. The rule now: when the reading is « trusted », nothing is written, whatever
the flag says; the flag records an answer, it does not repeat one.

**A record the launcher cannot read launched past the question in silence.** The gate
returns « unknown » when the file is unreadable, and the launcher treated unknown as yes:
the pre-0.4.2 failure — a session parked on the trust question, looking launched from
outside — back through a side door. The gate cannot measure there, so it lets the launch
through and says so on stderr, naming the flag and the alternative; `--trust` on an
unreadable record still refuses to write blind, as before. The dry run prints the reading
(`trust=already|recorded|unread`) so the suite reads all three without a live app.

**Entries outlive their directories.** Nothing removed a trust entry when its checkout
went, and a checkout per phase adds one per dispatch. `trust prune` lists the entries whose
directory no longer exists; `--apply` removes them, with the writer's own temporary file,
replace and owner-only mode, and keeps every other entry byte for byte — an entry for a
directory that is gone holds nothing the host can use, and the rest is the host's. Listing
is the default because the file is shared: a write is a decision, and the orchestrator
takes it by typing the flag. The script that makes checkouts (§30) still never touches
this file; pruning is the launcher's, beside the writer.

What the suite reads, on the fixture record it already makes: `--trust` on a recorded
directory leaves the file byte for byte and the dry run says `already`; on an unrecorded
one it says `recorded`; an unreadable record lets the dry run through with exit 0 and a
stderr line that says it cannot be read; `trust prune` prints exactly the entry whose
directory is gone and writes nothing; `--apply` removes it, keeps the other entry with its
own fields, and leaves the file owner-only; `trust prune` is accepted and any other action
refused.
