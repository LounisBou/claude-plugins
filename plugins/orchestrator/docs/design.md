# orchestrator — design

This document describes the plugin as it is now: its parts, how they fit, and the design
decisions that still hold, each with its reason. It does not restate the rules. Where a
skill, a reference or a template states one, this document points at it, because a fact
kept in two places goes stale in one of them. How a decision was reached, and every
decision since reversed, is in the repository's history.

Sections 1 to 9 describe the architecture. From section 10 on, each section is a decision
that holds, under the number it has carried since it was taken: the scripts, the commands
and the test suite cite those numbers, and the suite checks that every number cited names a
section here. A number that is absent names a decision a skill now states in full.

## 1. Goal

One session supervises implementer sessions instead of writing code itself: it writes their
briefs, launches them, reviews every delivery on the artifact, rotates saturated agents and
hands over to a successor before its own judgment degrades. For work ending in a pull request it loads the lifecycle, done and the artifact formats from the `method` plugin (`method:lifecycle`) rather than stating them; an investigation is a row delivering a report (decision 0008). This plugin ships that method as skills, the tab tooling the method needs on macOS, the briefs as
templates, and a context gauge that does not depend on any particular status bar.

Everything here was extracted from a working setup: the skills were loose files in the
operator's configuration directory, the gauge was a patch inside an installed status-bar
script, and the briefs were rewritten by hand for every phase. The plugin makes them
installable, versioned and independent of that machine.

Four ideas carry the rest, each stated where it binds:

- **The operator's word comes first**, and it is answered: `skills/orchestrator/SKILL.md`,
  « The principles » (section 47 here).
- **The orchestrator orchestrates and never implements**, and it launches, verifies,
  terminates and replaces its agents itself: `skills/orchestrator/SKILL.md`, « The principles »,
  and `skills/orchestrator/references/agents.md`.
- **Measured, never estimated**: a context figure comes from the gauge
  (`hooks/gauge.ts`'s measure file, written on every gauge pass), a verdict from the
  artifact (`skills/orchestrator/references/review-verdict.md`).
- **A rule lives once, and a decision that changes changes its directives in the same
  move**: `skills/orchestrator/references/directives.md`, « When a decision changes, the directives
  change in the same move » (section 18).

Out of scope: Windows and Linux terminal automation (the iterm-agents skill is macOS only;
the other skills and the gauge work anywhere the host runs); and editing the user's status
line script — the module needs nothing there, and install only unwraps a tap a previous
release left in front of it.

## 2. Layout

The plugin's `core/` is the generated copy of the repository's `packages/core` (`npm run core`), laid out there and never edited here.

```
.claude-plugin/plugin.json           name orchestrator, semver, MIT
.claude-plugin/marketplace.json      name claude-orchestrator, single-plugin marketplace, source "./"
types/index.d.ts                     the hooks module's state contract with the host
skills/orchestrator/SKILL.md         the rulebook
skills/orchestrator/references/phases.md                      the prerequisites and the phase rules
skills/orchestrator/references/brief.md                       the agent prompt recipe, the lint, the tier
skills/orchestrator/references/standing-rules.md              the standing rules every prompt carries and every review enforces
skills/orchestrator/references/directives.md                  what changes when a decision changes
skills/orchestrator/references/agents.md                      launch, verify, control, terminate, replace an agent
skills/orchestrator/references/rotation.md                    context rotation
skills/orchestrator/references/succession-predecessor.md      handing over
skills/orchestrator/references/pause-opening-move.md          a pause, an opening
skills/orchestrator/references/review-thresholds.md           the thresholds a verdict never crosses, depth versus scope
skills/orchestrator/references/review-round.md                disposable review sessions, the cost of a round
skills/orchestrator/references/review-comments.md             the comments round, publishing under the operator's name
skills/orchestrator/references/review-verdict.md              the checks, the record, the verdict message
skills/orchestrator/references/ci-watch.md                    the checks of an open pull request, in one background watch
skills/orchestrator/references/rebase.md                      the rebase
skills/orchestrator/references/screenshot-checklist.md  the one checklist every frontend capture is audited against
skills/iterm-agents/SKILL.md         tab management on macOS
skills/iterm-agents/references/commands.md   the script's commands, how it builds a tab, when iTerm2 does not answer
skills/iterm-agents/scripts/iterm-agent.sh   entry point: resolves the adapter's interpreter, runs launcher.ts
skills/iterm-agents/scripts/launcher.ts, skills/iterm-agents/scripts/launcher.spec.ts  the command line read into a typed request, handed to the adapter
skills/iterm-agents/scripts/agent-row.ts, skills/iterm-agents/scripts/agent-row.spec.ts  the row of the dispatch record a spawn or a rotation writes
skills/iterm-agents/scripts/spawn-prep.ts, skills/iterm-agents/scripts/spawn-prep.spec.ts  what a spawn's line decides alone: refusals, title, tools, gate, prompt
skills/iterm-agents/scripts/tier.ts, skills/iterm-agents/scripts/tier.spec.ts  a tier's binding in the operator's map
skills/iterm-agents/scripts/chains.ts, skills/iterm-agents/scripts/chains.spec.ts  the adapter's chain changes, through core's store
skills/iterm-agents/scripts/data-root.spec.ts  the launcher on a data root placed apart: what it reads protected, what it writes as data
skills/iterm-agents/scripts/iterm_agent.py   the adapter: the request performed, over the app API
skills/iterm-agents/scripts/iterm_restart.py   `restart`: the app stopped and started again, every session kept
skills/iterm-agents/scripts/conversation_tail.py   the end of a session's conversation, read from its transcript for a succession
skills/iterm-agents/scripts/tab_order.py   each window's tabs in the operator's order, the closed ones kept where they were
skills/iterm-agents/tmux/home.conf          a home server's tmux configuration, read through -f
skills/orchestrator/scripts/brief-lint.sh   lints a brief before it is dispatched, warning on its findings
skills/orchestrator/scripts/review-brief.sh, skills/orchestrator/scripts/review-brief.ts, skills/orchestrator/scripts/review-brief.spec.ts  a review round's brief filled from its fields, the template's text never retyped
skills/orchestrator/scripts/lens-model.sh, skills/orchestrator/scripts/lens-model.ts, skills/orchestrator/scripts/lens-model.spec.ts  the model of a review's readers, by the diff's class
skills/orchestrator/scripts/brief.sh, skills/orchestrator/scripts/brief.ts, skills/orchestrator/scripts/brief.spec.ts  the phase, audit and takeover briefs, printed from the state
skills/orchestrator/scripts/ci-watch.sh      the one wait on a pull request's checks, in the background
skills/orchestrator/scripts/draft-guard.sh, skills/orchestrator/scripts/draft-guard.ts, skills/orchestrator/scripts/draft-guard.spec.ts  which failing checks of a draft pull request are draft guards
skills/orchestrator/scripts/dispatch-record.sh  one row per dispatch, and the routing signal
skills/orchestrator/scripts/goals.sh, skills/orchestrator/scripts/goals.ts, skills/orchestrator/scripts/goals.spec.ts  the spec's goals of one build
skills/orchestrator/scripts/lib/goals-file.ts  the goals file's format, for goals.ts and succession.ts
skills/orchestrator/scripts/workspace.sh    launches workspace.ts: a clone per phase, a pinned worktree per review round
skills/orchestrator/scripts/rhythm.sh       an audit's net balance, from git alone
skills/orchestrator/scripts/ci-watch.ts, skills/orchestrator/scripts/dispatch-record.ts, skills/orchestrator/scripts/rhythm.ts, skills/orchestrator/scripts/workspace.ts, skills/orchestrator/scripts/install.ts, skills/orchestrator/scripts/brief-lint.ts  what the shell launchers above run, each command documented in its launcher's header
skills/orchestrator/scripts/shell-profile.ts  the shell file's copy and the one line of the profile that sources it, written by install.ts
shell/profile.sh      the plugin's shell configuration, sourced from the user's profile: an interactive login shell on a terminal drops a session's nesting marks
skills/orchestrator/scripts/node-ts.sh         sourced by every launcher of a .ts command: runs the first node able to run TypeScript, else says so
skills/orchestrator/scripts/lib/process.ts  what the scripts reach outside themselves, passed in so a test stands in for it
skills/orchestrator/scripts/lib/record-paths.ts  where a dispatch record, its owner and its goals live
skills/orchestrator/scripts/lib/audit.ts  the audit trail the scripts write into the orchestrator's journal
skills/orchestrator/scripts/lib/round-archive.ts  the round's old entries moved into its archive
skills/orchestrator/scripts/lib/workspace-ledger.ts  the ledger of the checkouts, written by workspace.ts alone
skills/orchestrator/scripts/lib/resume-window.json  the resume window and the plans' directories, read by the launcher and by workspace-ledger.ts
skills/orchestrator/scripts/ci-watch.spec.ts, skills/orchestrator/scripts/dispatch-record.spec.ts, skills/orchestrator/scripts/rhythm.spec.ts, skills/orchestrator/scripts/workspace.spec.ts, skills/orchestrator/scripts/install.spec.ts, skills/orchestrator/scripts/brief-lint.spec.ts, skills/orchestrator/scripts/short-commands.spec.ts, skills/orchestrator/scripts/shell-file.spec.ts, skills/orchestrator/scripts/lib/process.spec.ts, skills/orchestrator/scripts/lib/record-paths.spec.ts, skills/orchestrator/scripts/lib/audit.spec.ts  their node tests
skills/orchestrator/scripts/succession.sh, skills/orchestrator/scripts/succession.ts, skills/orchestrator/scripts/succession.spec.ts  the takeover printed from the state
skills/coordination/SKILL.md         the coordinator: answers from the facts, flags collisions, relays what is the operator's, its succession
skills/coordination/references/orchestrators.md  pausing, waking and opening an orchestrator, read on his word
skills/coordination/references/succession.md  the coordinator's own succession, read at its gate
skills/coordinator/scripts/coordinator.sh  the coordinator's record and facts, the sleeping orchestrators, the round
skills/coordinator/scripts/coordinator.ts  the coordinator's commands, run by coordinator.sh
skills/coordinator/scripts/context.ts, skills/coordinator/scripts/facts.ts, skills/coordinator/scripts/liveness.ts, skills/coordinator/scripts/lock.ts, skills/coordinator/scripts/module-lost.ts, skills/coordinator/scripts/record.ts, skills/coordinator/scripts/round.ts, skills/coordinator/scripts/sleeping.ts  what those commands read from their process, one file per concern
skills/coordinator/scripts/fixture.ts, skills/coordinator/scripts/decide.spec.ts, skills/coordinator/scripts/facts.spec.ts, skills/coordinator/scripts/lock.spec.ts, skills/coordinator/scripts/module-lost.spec.ts, skills/coordinator/scripts/record.spec.ts, skills/coordinator/scripts/round.spec.ts, skills/coordinator/scripts/sleeping.spec.ts  their node tests, on a context of their own
skills/model-routing/SKILL.md        which model/effort pair a dispatch gets
skills/model-routing/scripts/routing.py  the entry point of every routing subcommand: cost, profile, pick
skills/model-routing/defaults/README.md  what the shipped tier/effort tables are and how they are made
templates/agent-phase-brief.md       one implementer, one phase, one PR
templates/agent-rotation-brief.md    resume brief for a fresh implementer
templates/agent-review-brief.md      one review round, read-only, readers sized by the orchestrator
templates/orchestrator-succession-brief.md
templates/agent-audit-brief.md       one audit of the method
templates/coordinator-succession-brief.md  the coordinator's successor
templates/auditor-succession-brief.md  the auditor's successor
agents/lens.md                       read-only reader for one review lens: findings only
agents/screenshots.md                read-only auditor of a pull request's screenshots
commands/install.md                  unwires the tap, creates the state directory
commands/uninstall.md                restores the previous status line, removes the state directory
commands/status.md                   live sessions and their measured context fill
commands/supervision.md              opens or closes the supervision pane on the person's command
commands/succeed.md                  runs the orchestrator succession
commands/agents.md                   each running implementer's progress
commands/progress.md                 where the build stands
commands/decide.md                   the decision round, one arbitration at a time
commands/audit.md                    launches an audit of the method on the operator's word
commands/coordinator.md              starts the machine's coordinator on the operator's word
commands/coordinator-end.md          ends the coordinator on the operator's word
commands/coordinator-decide.md       the operator's machine-wide decide over every orchestrator's open questions
commands/sleeping.md                 lists the orchestrators paused on the operator's word; drop abandons one
short-names.tsv                      each command's short name beside its file: what the installer and brief-lint read
short-commands.sh                    launches skills/orchestrator/scripts/short-commands.ts, which writes the short names as user commands (a file without its marker is never touched)
hooks/hooks.json                     declares the hooks module, and nothing else
hooks/host.ts                        the part of the host's API the strict hooks call
hooks/register.ts                    the hooks module's entry point: mounts the domains, the gauge before the store that reads its figure
hooks/gauge-core.ts                  the measurement rules, pure: the double gate, the measure file, when a newer installed commit is acted on (a coordinator told, the home servers reloaded)
hooks/gate-recheck.ts                re-runs github's Ready gate on a pull request an open question names
hooks/gauge.ts                       measures the context into one file per session, and announces model drift
hooks/session-name.ts                the session's naming, pure: role prefixes, title normalization, the name walk
hooks/guards.ts                      the guards (context gate, kill guard, turn end) and the module's one tick
hooks/supervision.ts                 the shared store (one row per live session) and the supervision pane, opened on the operator's words and by nothing else
hooks/relay.ts                       an orchestrator's turn end, pure: its declared wait read into the row and reported to a coordinator
hooks/permission-wait.ts             an agent's permission dialog, told to its orchestrator as it appears, and reminded once past the busy bound
hooks/round.ts                       the coordinator's round on this machine, pure: the entry a wait becomes, the round's order
hooks/remote-row.ts                  an orchestrator's row for a coordinator on another machine, pure: the fields that travel, the news rule, the receiver's checks
hooks/remote-round.ts                a remote orchestrator's question for the coordinator's round, pure: the only question line between machines
hooks/remote-asked.ts                a question asked with `ask` whose coordinator runs on another machine: its replica, its answer, its resends
hooks/deck.ts                        the machine's deck, pure: the versioned `deck.json` D3vDeck reads
hooks/usage.ts                       a session's token use and cost at API list prices, pure: core's `usage-cost.ts` over transcript lines
hooks/commands.ts                    the commands the markdown files declare, answered without a model turn
hooks/short-names.ts                 the short names' forms, pure, and the marker of a user command that is this plugin's copy
hooks/short-commands.ts              at each session start, the writer's sync run from an installed plugin
hooks/naming.ts                      the session's own rename: the `rename_session` and `end_session` tools
hooks/background.ts                  no background session: the Bash guard and the start guard
hooks/pattern-kills.ts               the kill guard's reading, pure: every kill by name or pattern a command line holds
hooks/models-guard.ts                the tier map's guard, pure: a Bash line that writes the operator's models.json, and the prompt that lifts it
hooks/stop-gate.ts                   the turn end's pure parts: the listing, the refusals of a declared wait, the busy wake
hooks/wait.ts                        the declared wait: the `declare_wait` tool, its validator and its hand-on to the turn's end
hooks/tab-state.ts                   the state a window shows in its home session's tab bar, pure
hooks/pr-file.ts                     the machine's one pull request file (`<state>/prs.json`), refreshed in one GraphQL call under its lock
hooks/pr-file-format.ts              the pull request file's format, pure, read by pr-file.ts, the sweep, the coordinator's facts and the takeover
hooks/close-agent.ts                 the module's close of an agent done with its Ready or merged pull request, an act of the tick
hooks/ready-agent.ts                 what says an agent is done with a Ready pull request, read from the label at its head, pure
hooks/unattended.ts                  the pull requests of the orchestration's own lines that nobody attends, and the holds that follow
hooks/ledger.ts                      the ledger line of a pull request written where it is created, and the tick's wake on the orchestration's pull requests (`prWake`)
hooks/row-owner.ts                   who owns an open row, pure, read by succession.ts and ledger.ts
hooks/settle.ts                      the `settle` tool's pure half: the call's fields checked and what a closure writes
hooks/todo-format.ts                 the to-do list's format, owned here and in no core
hooks/todo.ts                        the `todo` tool: a request of the operator that outlasts the turn, recorded in the holder's own list
hooks/asked-key.ts                   what makes two questions one, pure: the key a question asked with `ask` is stored under
hooks/question.ts                    the `ask` and `settle` tools, and the one closure of a round entry
hooks/review.ts                      the orchestrator's tool for its review verdict, written through github's record tool
hooks/review-rounds.ts               the round a review verdict counts, raised on the dispatch-record row; never a refusal
hooks/review-close.ts                the review sessions a recorded verdict owes a close, kept for the tick
hooks/review-reading.ts              what a review brief says of its round, and whether a verdict is for it
hooks/lens-ids.ts                    a review reader's answer with each finding line's stable id (`<lens>:<hash>`)
hooks/lens-method.ts                 a review reader's method: the toolkit agent of its lens's angle, or the generic reader
hooks/audit-events.ts                the audit trail's facts, pure: never a command line, a prompt or a finding's words
hooks/audit.ts                       writes those facts into the orchestrator's journal, mounted first; a failed write is logged and the hook's outcome stands
hooks/observe.ts                     the journal writer the audit trail and the one observation left share
hooks/module-log.ts                  the module's log line, pure
hooks/module-io.ts                   the module's own I/O over a handler's $, once for every domain
hooks/log-append.sh                  appends one line to the module's log, shared by every session, and rotates it past the cap
hooks/tests/scaffold.test.ts, hooks/tests/gauge-core.test.ts, hooks/tests/gate-recheck.test.ts, hooks/tests/no-band.test.ts, hooks/tests/session-name.test.ts, hooks/tests/context-gate.test.ts, hooks/tests/models-guard.test.ts, hooks/tests/background.test.ts, hooks/tests/kill-guard.test.ts, hooks/tests/stop-gate.test.ts, hooks/tests/retrospective.test.ts, hooks/tests/ledger.test.ts, hooks/tests/row-owner.test.ts, hooks/tests/pr-file.test.ts, hooks/tests/review.test.ts, hooks/tests/review-rounds.test.ts, hooks/tests/lens-ids.test.ts, hooks/tests/lens-method.test.ts, hooks/tests/audit.test.ts, hooks/tests/todo-format.test.ts, hooks/tests/todo.test.ts, hooks/tests/settle.test.ts, hooks/tests/question.test.ts, hooks/tests/unattended.test.ts, hooks/tests/supervision.test.ts, hooks/tests/short-commands.test.ts, hooks/tests/pane.test.ts, hooks/tests/relay.test.ts, hooks/tests/round.test.ts, hooks/tests/remote-row.test.ts, hooks/tests/remote-round.test.ts, hooks/tests/tab-state.test.ts, hooks/tests/deck.test.ts, hooks/tests/usage.test.ts, hooks/tests/gate-self.test.ts, hooks/tests/agent-relay.test.ts, hooks/tests/permission-wait.test.ts, hooks/tests/naming.test.ts, hooks/tests/commands.test.ts, hooks/tests/module-log.test.ts, hooks/tests/module-io.test.ts, hooks/tests/data-root.test.ts  the node tests of the hooks module, over a faked $, one file per domain
hooks/tests/fakes.ts                 what every faked $ answers the same way
hooks/tests/golden-deck.ts           deck.json byte for byte, the format the Stream Deck reads
hooks/tests/fixtures.ts              texts the pane met on the operator's machine, kept verbatim
hooks/tests/screen.ts                a tree laid out as the rows a terminal shows
install.sh, uninstall.sh
tests/run-tests.sh
tests/e2e.sh                         one real round: a tab, a session, a close
tests/conversation-tail-probe.py     the fixture transcripts of the conversation tail's cases
tests/restart-probe.py               the machine stood in for by the cases of `restart`
tests/order-probe.py                 the app stood in for by the cases of the tabs' order
tests/e2e-data-root.sh              the two roots end to end under scratch directories: dispatch, brief, dry-run spawn, launch script, round entry and log, with files planted in the data root
tests/e2e-host.sh                    the live host the pane's test starts
tests/deck-e2e.ts                    the deck built once from this machine's real state, read-only
tests/usage-rule.ts                  the deck's usage rule run under node, for the suite to hold to routing.py cost
tests/row-rule.ts                    the module's row writer run under node, for the suite to hold the launcher's row_write to it
tests/pane-e2e.sh                    the coordinator's pane answered from the keyboard in a live host, under tmux
tests/tmux-e2e.sh                    agents as windows of a home session, driven by the launcher on live hosts, under tmux
tests/question-relay-proof.sh        a home succession watched on a live machine, with a dry run over fixtures
tests/fixtures/tap-settings.json     a settings.json wired the way the tap installer wired it, for the unwrap
tests/fixtures/transcript-renamed.jsonl  a transcript whose last custom-title entry is a rename
tests/fixtures/rhythm-repo.sh        builds the dated repository rhythm.sh is tested on
tests/fixtures/spawn-dry-run.sh      prints the dry run of every spawn form, for the suite to hold to the recorded one
tests/fixtures/spawn-dry-run.golden  the dry runs above as recorded
tests/fixtures/usage/transcript.jsonl, tests/fixtures/usage/prices.json  a transcript and its price file, for the deck's usage against routing.py cost
tests/fixtures/goals/spec.md         a spec with a Why and five numbered Goals, for goals.ts
tests/fixtures/routing/prices.json, tests/fixtures/routing/projects/-repo/s-1.jsonl, tests/fixtures/routing/projects/-repo/s-1/subagents/agent-x.jsonl, tests/fixtures/routing/projects/-repo/s-2.jsonl, tests/fixtures/routing/projects/-repo/s-3.jsonl, tests/fixtures/routing/projects/-repo/s-4.jsonl  a price file and transcripts, for routing.py cost
tests/fixtures/routing/trees/laravel/composer.json, tests/fixtures/routing/trees/laravel/artisan, tests/fixtures/routing/trees/plugin/.claude-plugin/plugin.json, tests/fixtures/routing/trees/plugin/run.sh, tests/fixtures/routing/trees/plugin/a.sh, tests/fixtures/routing/trees/plugin/b.py, tests/fixtures/routing/trees/pycli/pyproject.toml, tests/fixtures/routing/trees/pycli/bin/tool, tests/fixtures/routing/trees/jslib/package.json, tests/fixtures/routing/trees/jslib/index.js  four marker trees a profile is inferred from, for routing.py profile and pick
docs/design.md                       this document
docs/state.md                        the machine-wide state files, their writers and how each is written
docs/specs/2026-10-01-stop-gate-design.md  the stop gate's approved spec
docs/specs/2026-10-07-hooks-module-design.md  the hooks module's approved spec
docs/plans/2026-10-07-hooks-module-plan.md     the hooks module's implementation plan
docs/agent-dispatches.md             the standing dispatch choices, each with its reason and evidence
evals/README.md                      how the behaviour suite is staged, run and read
evals/SELECTION.md                   the cases chosen, and the criteria that chose them
evals/baseline-0.34.0.json           the first baseline run, with and without the plugin
evals/baseline-0.36.0.json           the current baseline the suite is compared against
evals/coord-answers-from-facts/prompt.md
evals/coord-answers-from-facts/graders/answers-from-facts.md
evals/coord-answers-from-facts/graders/no-ruling.md
evals/coord-flags-collision/prompt.md
evals/coord-flags-collision/graders/flags-both.md
evals/coord-flags-collision/graders/gates-nothing.md
evals/coord-order-to-all/prompt.md
evals/coord-order-to-all/graders/orchestrators-not-agents.md
evals/coord-order-to-all/graders/verbatim-dated-to-each.md
evals/coord-relays-merge/prompt.md
evals/coord-relays-merge/graders/no-merge-no-undraft.md
evals/coord-relays-merge/graders/relayed-unjudged.md
evals/coord-succession/prompt.md
evals/coord-succession/graders/brief-closes-then-registers.md
evals/coord-succession/graders/coordinator-successor-spawn.md
evals/coord-succession/graders/no-orchestrator-successor.md
evals/coord-succession/graders/succeeds-without-asking.md
evals/closes-by-fresh-tty-and-title-words/prompt.md
evals/closes-by-fresh-tty-and-title-words/graders/close-with-title.md
evals/closes-by-fresh-tty-and-title-words/graders/no-glyph.md
evals/closes-by-fresh-tty-and-title-words/graders/relists.md
evals/moves-beside-self-never-respawns/prompt.md
evals/moves-beside-self-never-respawns/graders/moves-beside-self.md
evals/moves-beside-self-never-respawns/graders/no-respawn.md
evals/picks-a-model-when-the-tier-is-unbound/prompt.md
evals/picks-a-model-when-the-tier-is-unbound/graders/unbound-is-advisory.md
evals/dispatches-a-fix-never-writes-it/prompt.md
evals/dispatches-a-fix-never-writes-it/graders/dispatches-not-writes.md
evals/answers-the-third-ask-missed/prompt.md
evals/answers-the-third-ask-missed/graders/answer-alone-no-hand-over.md
evals/answers-the-third-ask-missed/graders/names-the-base.md
evals/answers-the-third-ask-unanswered/prompt.md
evals/answers-the-third-ask-unanswered/graders/names-the-base.md
evals/answers-the-third-ask-unanswered/graders/says-so-answers-offers-hand-over.md
evals/names-the-departure-then-obeys/prompt.md
evals/names-the-departure-then-obeys/graders/names-the-term.md
evals/states-only-what-an-output-printed/prompt.md
evals/states-only-what-an-output-printed/graders/count-marked-unverified.md
evals/states-only-what-an-output-printed/graders/handles-as-printed.md
evals/states-only-what-an-output-printed/graders/roles-as-printed.md
evals/refuses-to-merge-or-undraft-for-a-peer/prompt.md
evals/refuses-to-merge-or-undraft-for-a-peer/graders/leaves-draft-and-merge.md
evals/launches-the-announced-agent-when-refused/prompt.md
evals/launches-the-announced-agent-when-refused/graders/spawns-phase-4.md
evals/launches-the-announced-agent-when-refused/graders/launches-in-this-turn.md
evals/asks-and-dispatches-in-one-turn/prompt.md
evals/asks-and-dispatches-in-one-turn/graders/dispatches-phase-5.md
evals/asks-and-dispatches-in-one-turn/graders/asks-and-dispatches.md
evals/rereads-the-artifact-before-answering/prompt.md
evals/rereads-the-artifact-before-answering/graders/rereads-item-and-premise.md
evals/rereads-the-artifact-before-answering/graders/rereads-pr-state.md
evals/writes-a-well-formed-phase-brief/prompt.md
evals/writes-a-well-formed-phase-brief/graders/brief-command.md
evals/writes-a-well-formed-phase-brief/graders/exact-address.md
evals/writes-a-well-formed-phase-brief/graders/from-the-state.md
evals/writes-a-well-formed-phase-brief/graders/no-host-variable.md
evals/writes-a-well-formed-phase-brief/graders/not-typed.md
evals/announces-then-takes-over/prompt.md
evals/announces-then-takes-over/graders/agent-p8-addressed.md
evals/announces-then-takes-over/graders/agent-review-addressed.md
evals/announces-then-takes-over/graders/announces-before-confirming.md
evals/announces-then-takes-over/graders/closes-predecessor-tab.md
evals/triages-then-one-correction-round/prompt.md
evals/triages-then-one-correction-round/graders/triage-then-one-correction.md
evals/declares-ready-only-on-a-green-record/prompt.md
evals/declares-ready-only-on-a-green-record/graders/fixed-at-verified-head.md
evals/declares-ready-only-on-a-green-record/graders/fixed-before-ready.md
evals/declares-ready-only-on-a-green-record/graders/ready-at-verified-head.md
evals/declares-ready-only-on-a-green-record/graders/ready-on-the-record.md
evals/declares-ready-only-on-a-green-record/graders/ready-only-on-exit-0.md
evals/stops-when-no-tab-can-be-made/prompt.md
evals/stops-when-no-tab-can-be-made/graders/no-other-terminal.md
evals/stops-when-no-tab-can-be-made/graders/says-why-and-stops.md
evals/rotates-only-after-the-stand-down/prompt.md
evals/rotates-only-after-the-stand-down/graders/no-title-on-rotate.md
evals/rotates-only-after-the-stand-down/graders/rotate-used.md
evals/rotates-only-after-the-stand-down/graders/rotation-order.md
evals/hands-over-and-goes-silent/prompt.md
evals/hands-over-and-goes-silent/graders/handed-over.md
evals/hands-over-and-goes-silent/graders/leaves-60-to-successor.md
evals/hands-over-and-goes-silent/graders/no-close-own-tab.md
evals/hands-over-and-goes-silent/graders/nothing-after-handed-over.md
evals/dispatches-past-the-gate-to-a-fresh-session/prompt.md
evals/dispatches-past-the-gate-to-a-fresh-session/graders/gate-and-readings.md
evals/dispatches-past-the-gate-to-a-fresh-session/graders/reads-tier-map.md
trigger-evals/README.md              what the triggering set measures, how it is run and read
trigger-evals/coordination-no-trigger-01/prompt.md
trigger-evals/coordination-no-trigger-01/graders/answered.md
trigger-evals/coordination-no-trigger-01/graders/skill-not-loaded.md
trigger-evals/coordination-no-trigger-02/prompt.md
trigger-evals/coordination-no-trigger-02/graders/answered.md
trigger-evals/coordination-no-trigger-02/graders/skill-not-loaded.md
trigger-evals/coordination-no-trigger-03/prompt.md
trigger-evals/coordination-no-trigger-03/graders/answered.md
trigger-evals/coordination-no-trigger-03/graders/skill-not-loaded.md
trigger-evals/coordination-no-trigger-04/prompt.md
trigger-evals/coordination-no-trigger-04/graders/answered.md
trigger-evals/coordination-no-trigger-04/graders/skill-not-loaded.md
trigger-evals/coordination-no-trigger-05/prompt.md
trigger-evals/coordination-no-trigger-05/graders/answered.md
trigger-evals/coordination-no-trigger-05/graders/skill-not-loaded.md
trigger-evals/coordination-no-trigger-06/prompt.md
trigger-evals/coordination-no-trigger-06/graders/answered.md
trigger-evals/coordination-no-trigger-06/graders/skill-not-loaded.md
trigger-evals/coordination-no-trigger-07/prompt.md
trigger-evals/coordination-no-trigger-07/graders/answered.md
trigger-evals/coordination-no-trigger-07/graders/skill-not-loaded.md
trigger-evals/coordination-no-trigger-08/prompt.md
trigger-evals/coordination-no-trigger-08/graders/answered.md
trigger-evals/coordination-no-trigger-08/graders/skill-not-loaded.md
trigger-evals/coordination-trigger-01/prompt.md
trigger-evals/coordination-trigger-01/graders/skill-loaded.md
trigger-evals/coordination-trigger-02/prompt.md
trigger-evals/coordination-trigger-02/graders/skill-loaded.md
trigger-evals/coordination-trigger-03/prompt.md
trigger-evals/coordination-trigger-03/graders/skill-loaded.md
trigger-evals/coordination-trigger-04/prompt.md
trigger-evals/coordination-trigger-04/graders/skill-loaded.md
trigger-evals/coordination-trigger-05/prompt.md
trigger-evals/coordination-trigger-05/graders/skill-loaded.md
trigger-evals/coordination-trigger-06/prompt.md
trigger-evals/coordination-trigger-06/graders/skill-loaded.md
trigger-evals/iterm-agents-no-trigger-01/prompt.md
trigger-evals/iterm-agents-no-trigger-01/graders/answered.md
trigger-evals/iterm-agents-no-trigger-01/graders/skill-not-loaded.md
trigger-evals/iterm-agents-no-trigger-02/prompt.md
trigger-evals/iterm-agents-no-trigger-02/graders/answered.md
trigger-evals/iterm-agents-no-trigger-02/graders/skill-not-loaded.md
trigger-evals/iterm-agents-no-trigger-03/prompt.md
trigger-evals/iterm-agents-no-trigger-03/graders/answered.md
trigger-evals/iterm-agents-no-trigger-03/graders/skill-not-loaded.md
trigger-evals/iterm-agents-no-trigger-04/prompt.md
trigger-evals/iterm-agents-no-trigger-04/graders/answered.md
trigger-evals/iterm-agents-no-trigger-04/graders/skill-not-loaded.md
trigger-evals/iterm-agents-no-trigger-05/prompt.md
trigger-evals/iterm-agents-no-trigger-05/graders/answered.md
trigger-evals/iterm-agents-no-trigger-05/graders/skill-not-loaded.md
trigger-evals/iterm-agents-no-trigger-06/prompt.md
trigger-evals/iterm-agents-no-trigger-06/graders/answered.md
trigger-evals/iterm-agents-no-trigger-06/graders/skill-not-loaded.md
trigger-evals/iterm-agents-trigger-01/prompt.md
trigger-evals/iterm-agents-trigger-01/graders/skill-loaded.md
trigger-evals/iterm-agents-trigger-02/prompt.md
trigger-evals/iterm-agents-trigger-02/graders/skill-loaded.md
trigger-evals/iterm-agents-trigger-03/prompt.md
trigger-evals/iterm-agents-trigger-03/graders/skill-loaded.md
trigger-evals/iterm-agents-trigger-04/prompt.md
trigger-evals/iterm-agents-trigger-04/graders/skill-loaded.md
trigger-evals/iterm-agents-trigger-05/prompt.md
trigger-evals/iterm-agents-trigger-05/graders/skill-loaded.md
trigger-evals/iterm-agents-trigger-06/prompt.md
trigger-evals/iterm-agents-trigger-06/graders/skill-loaded.md
trigger-evals/model-routing-no-trigger-01/prompt.md
trigger-evals/model-routing-no-trigger-01/graders/answered.md
trigger-evals/model-routing-no-trigger-01/graders/skill-not-loaded.md
trigger-evals/model-routing-no-trigger-02/prompt.md
trigger-evals/model-routing-no-trigger-02/graders/answered.md
trigger-evals/model-routing-no-trigger-02/graders/skill-not-loaded.md
trigger-evals/model-routing-no-trigger-03/prompt.md
trigger-evals/model-routing-no-trigger-03/graders/answered.md
trigger-evals/model-routing-no-trigger-03/graders/skill-not-loaded.md
trigger-evals/model-routing-no-trigger-04/prompt.md
trigger-evals/model-routing-no-trigger-04/graders/answered.md
trigger-evals/model-routing-no-trigger-04/graders/skill-not-loaded.md
trigger-evals/model-routing-no-trigger-05/prompt.md
trigger-evals/model-routing-no-trigger-05/graders/answered.md
trigger-evals/model-routing-no-trigger-05/graders/skill-not-loaded.md
trigger-evals/model-routing-no-trigger-06/prompt.md
trigger-evals/model-routing-no-trigger-06/graders/answered.md
trigger-evals/model-routing-no-trigger-06/graders/skill-not-loaded.md
trigger-evals/model-routing-trigger-01/prompt.md
trigger-evals/model-routing-trigger-01/graders/skill-loaded.md
trigger-evals/model-routing-trigger-02/prompt.md
trigger-evals/model-routing-trigger-02/graders/skill-loaded.md
trigger-evals/model-routing-trigger-03/prompt.md
trigger-evals/model-routing-trigger-03/graders/skill-loaded.md
trigger-evals/model-routing-trigger-04/prompt.md
trigger-evals/model-routing-trigger-04/graders/skill-loaded.md
trigger-evals/model-routing-trigger-05/prompt.md
trigger-evals/model-routing-trigger-05/graders/skill-loaded.md
trigger-evals/model-routing-trigger-06/prompt.md
trigger-evals/model-routing-trigger-06/graders/skill-loaded.md
trigger-evals/orchestrator-no-trigger-01/prompt.md
trigger-evals/orchestrator-no-trigger-01/graders/answered.md
trigger-evals/orchestrator-no-trigger-01/graders/skill-not-loaded.md
trigger-evals/orchestrator-no-trigger-02/prompt.md
trigger-evals/orchestrator-no-trigger-02/graders/answered.md
trigger-evals/orchestrator-no-trigger-02/graders/skill-not-loaded.md
trigger-evals/orchestrator-no-trigger-03/prompt.md
trigger-evals/orchestrator-no-trigger-03/graders/answered.md
trigger-evals/orchestrator-no-trigger-03/graders/skill-not-loaded.md
trigger-evals/orchestrator-no-trigger-04/prompt.md
trigger-evals/orchestrator-no-trigger-04/graders/answered.md
trigger-evals/orchestrator-no-trigger-04/graders/skill-not-loaded.md
trigger-evals/orchestrator-no-trigger-05/prompt.md
trigger-evals/orchestrator-no-trigger-05/graders/answered.md
trigger-evals/orchestrator-no-trigger-05/graders/skill-not-loaded.md
trigger-evals/orchestrator-no-trigger-06/prompt.md
trigger-evals/orchestrator-no-trigger-06/graders/answered.md
trigger-evals/orchestrator-no-trigger-06/graders/skill-not-loaded.md
trigger-evals/orchestrator-trigger-01/prompt.md
trigger-evals/orchestrator-trigger-01/graders/skill-loaded.md
trigger-evals/orchestrator-trigger-02/prompt.md
trigger-evals/orchestrator-trigger-02/graders/skill-loaded.md
trigger-evals/orchestrator-trigger-03/prompt.md
trigger-evals/orchestrator-trigger-03/graders/skill-loaded.md
trigger-evals/orchestrator-trigger-04/prompt.md
trigger-evals/orchestrator-trigger-04/graders/skill-loaded.md
trigger-evals/orchestrator-trigger-05/prompt.md
trigger-evals/orchestrator-trigger-05/graders/skill-loaded.md
trigger-evals/orchestrator-trigger-06/prompt.md
trigger-evals/orchestrator-trigger-06/graders/skill-loaded.md
README.md, LICENSE
```

The suite checks this block against the tracked files both ways: it had already lost the hooks, three commands, two briefs and the fixture while still reading as current, and kept a deleted grader listed just as long.

Skills reach their scripts through `${CLAUDE_PLUGIN_ROOT}`; a relative path does not resolve from a skill. Skills are invoked as `orchestrator:<skill>`.

## 3. Context gauge

The hooks module measures every session itself, in-process: `hooks/gauge.ts` answers the host's own measure events and `hooks/gauge-core.ts` holds the rules, pure. The shell pipeline it replaced (a tap wrapped around the operator's status line, a `ctx/` file per render, a gauge script that fell back to scanning the transcript) is gone; the one file that survives is the measure file, because external processes cannot read the module's memory.

### 3.1 The host is asked, not inferred from

The host fires a measure event after each turn and on each change of a plan-limit percentage, and the reading it carries is the figure itself, not an inference from a payload meant for a status line or from the transcript's last usage block. Both earlier tiers paid for their indirection daily: the tap forced a cohabitation protocol with whatever status bar the operator ran, and the transcript scan paid a process spawn to approximate a number the host already knew. The module writes no marker files and keeps its once-per-session and once-per-drift state in memory; a reload of the module resets it, which is the correct reset, because a reloaded module has measured nothing yet. A /clear and a compaction of the main conversation drop the figures measured before them too, since they are no longer the conversation's; the next answer measures again.

### 3.2 The measure file

The measure file is the only channel any external process is documented to read; its format is in the repository's `../../../docs/contracts.md`. It is kept when the session ends, so the series of closed sessions stays readable, and replaced whole in one rename, never emptied; a reader treats an unparseable or empty line as unmeasured, without touching the file. The shared store it feeds (`hooks/supervision.ts`) is a file tree an outside process could open as well, but none is given it: the store feeds the module's own surfaces alone. A row carries its host pid, so a session idle for hours keeps its row and one that ended without the end event loses it the moment its pid is gone. Pruning is `install.ts`'s, and spares a file a live session owns, so an idle session keeps the file it will read again.

### 3.3 Install and uninstall

`install.sh` and `uninstall.sh` (both launch `skills/orchestrator/scripts/install.ts`) unwrap any tap a previous install left in front of the operator's status line, keeping the command that followed it as written; the steps, the backup and the idempotence are the two commands' own (`commands/install.md`, `commands/uninstall.md`). The module needs nothing in the status line, so the unwrap is all that remains of the tap. Why the comparison reads the home's spelling is section 33.

Requirements: `jq` for the workflow scripts, `node` 22.18 or later for the scripts' TypeScript (their launchers run it directly, with no build step), `python3` for the tab tooling's environment and the routing and goals scripts, bash 3.2 for every shell script.

### 3.4 The context gate

The module's context gate (`hooks/guards.ts`, on every prompt submitted) speaks only to orchestration sessions: those whose name starts with `Orch:`, `Agent:`, `Audit:` or `Coord:`. The name is read by the module's own name walk (`hooks/session-name.ts`, shared with the turn end and the store), in-process, so no interpreter is started per prompt. A walk that fails or does not finish in its bound is an unknown name, never a session found unnamed: a name already known is kept. A session launched underneath another, such as a headless run started from its shell, speaks for no one: never another session's name. A session with no role name gets no gate line and no « unmeasured » line; the model-drift line alone reaches every session (section 32). A name the launcher knows exists and cannot read is one line in the module's log (section 4.4), so a session that went dark leaves a trace.

At or past the gate, the smaller of 300,000 tokens (30 %) and 80 % of the reported window: 300,000 on 1,000,000; 160,000 on 200,000, it puts one line in front of the session, fitted to its role (the lines are in `hooks/guards.ts`, the rules they enforce in `skills/orchestrator/SKILL.md`, « The principles »). The launcher sets the token gate for one session (section 60). Below it, it prints nothing; unable to measure, it says so once per session instead of staying silent as if the fill were low, except on the first prompt, before any measure exists. It exists because the rule « succession is yours to trigger » lived in the skill and was not applied: a sentence the model must remember can be rationalised away, a line the harness puts in front of every prompt cannot.

## 4. The parts

### 4.1 Skills and their references

Four skills (`orchestrator`, `iterm-agents`, `model-routing`, `coordination`), each with its own `SKILL.md`; the layout names their references and the skills say what they hold. A skill never carries a project-specific fact: it states the rule and leaves the project's policy (where briefs live, whether tests are committed, what the policy on workflow artifacts forbids) to the brief the orchestrator writes.

A rule lives once, where the session that needs it will read it when it needs it. `SKILL.md` holds what the orchestrator must carry at all times; a reference holds the rules of one action, and the step of the core loop that performs that action tells the session to read it at that moment. The risk of that shape is a rule sitting in a reference that is not read when it applies, so the load instruction is tied to the action rather than the topic, and every critical case of the eval suite is staged at the moment of the action. Each reference over a hundred lines opens with its table of contents, and each `SKILL.md` stays under five hundred lines.

### 4.2 Scripts

Each script's commands are documented in its launcher's header; the decisions behind them are in the sections named here.

| Script | Decisions |
|---|---|
| `skills/iterm-agents/scripts/iterm-agent.sh`, `iterm_agent.py` | sections 14, 19 to 22, 24 to 27, 29, 31, 34, 38, 39, 42 to 46, 48, 49, 51, 52, 57, 66; its commands: `skills/iterm-agents/references/commands.md` |
| `skills/orchestrator/scripts/brief-lint.sh` | sections 11, 12 |
| `skills/orchestrator/scripts/review-brief.sh`, `brief.sh` | section 37 |
| `skills/orchestrator/scripts/ci-watch.sh`, `draft-guard.sh` | section 62 |
| `skills/orchestrator/scripts/dispatch-record.sh` | sections 13, 55, 58 |
| `skills/orchestrator/scripts/goals.sh` | section 64 |
| `skills/orchestrator/scripts/workspace.sh` | sections 30, 35, 36, 37, 40, 61 |
| `skills/orchestrator/scripts/rhythm.sh` | section 52 |
| `skills/orchestrator/scripts/succession.sh` | section 9.3 |
| `skills/coordinator/scripts/coordinator.sh` | section 9.5 |
| `install.sh`, `uninstall.sh` | sections 3.3, 33 |

Temporary files across the plugin are anchored to `TMPDIR`: the platform default can be a directory a restricted shell may not write to, and a script that fails there fails on a path it never chose.

### 4.3 Hooks

`hooks/hooks.json` declares one hooks module and nothing else; every gate below is enforced in-process by the host rather than remembered by the model. The context gate is section 3.4; like the turn end it reads the session's name before anything else, and leaves every session outside the orchestration alone.

A forced push is the forge's to refuse: github's `/github:protect` checks and applies the default branch's protection, and no guard here reads a command's text for one.

The kill guard (`hooks/guards.ts`, `hooks/pattern-kills.ts`) runs only in a session the launcher spawned (a session the operator starts by hand is never touched) and refuses a kill by name or pattern while passing a kill by a recorded pid: a session kills only what it started, since a kill by pattern reaches the dev servers and the wait loops of other sessions. Its own failure is decided on the launcher's mark as last read: closed in a spawned session, open in one the operator started.

At an orchestrator's turn end (`hooks/guards.ts` on the Stop event, its pure parts in `hooks/stop-gate.ts`) the module decides nothing of the stop, which always passes, and reads no prose of the turn: it arms the module's tick on the session's busy agents and on the pull requests of its records, shows each idle agent's pull request on its window (section 66), and runs `workspace.sh sweep` at most once per ten minutes (section 61). A read that fails is one line in the module's log, and the stop passes all the same. Its checks (what will wake the orchestrator, the rows, goals and to-dos of its ending, the CI state of its watches, its warnings) were removed on the operator's ruling of 2026-11-18: none had refused a stop since 2026-11-15, and 33 commits fixed them in the three days after; the rows and goals of a declared done or deferred wait are refused by `declare_wait` itself (`hooks/wait.ts`). The observing guards (on a file tool's write of the tier map, on the dialogs of a session others wait on, on an agent's long message naming no report, on a call addressing an agent while a rename waits) were removed on the same ruling: they let every call through, and nothing read their escapes. Only the kill guard, the background guard and the tier map's Bash overwrite still refuse.

The background guard (`hooks/background.ts`, on the Bash tool in every session) refuses a line that runs the host's CLI to start or resume a background session or to run its daemon, and ends a session the host started as one: a background session has no tab, so nothing the method relies on could see it. The stop gate's original spec is `docs/specs/2026-10-01-stop-gate-design.md`, superseded by this section.

### 4.4 The state directory

`${CLAUDE_CONFIG_DIR:-~/.claude}/claude-orchestrator/` holds what the plugin keeps between sessions: `models.json`, the operator's tier map (section 10); `mcp.json`, his server catalogue (section 42); `chains/` (sections 21, 26, 34); `prompts/`, the files each launch was made from (section 45); `measure/` (section 3.2); `hooks-module.log`; the `ignored-checks` list and the sweep stamp; the store (`hooks/supervision.ts`); `round/` (section 9.6); `records/`, per host session, the dispatch records it touched, which the declared wait reads for open rows; `ci-gate/`, the last `pr-gate` answer each ci-watch read; and the tab tooling's Python environment (section 14). `hooks-module.log` is the module's one log, shared by every session; `ci-gate/` is what the facts line of a delivery reads. `docs/state.md` and the repository's `../../../docs/contracts.md` hold the machine-wide files other plugins read; the rest is in the code of the module that writes it. What the code cannot say is where each thing lives and why.

That directory is the protected root: it keeps what runs or is trusted, the Python environment, `prompts/`, `mcp.json`, `models.json`, `routing/`, `config.json`, `sleeping.json`, `coordinator.json`, and `data-root.json`. That file may place the data root elsewhere, in a directory any session writes without a prompt; every other item, from the chains and the round to the measure files, the store and the log, is data and lives there, on the protected root itself while no valid file names one (core's `orchestration.ts` and `roots.ts`). Nothing read from the data root decides what runs; `docs/state.md` gives each item its root.

`ORCHESTRATOR_STATE_DIR` overrides the protected root, and the sharing follows it: the chain files, the records registry, ci-watch's logs and gate readings, the heads record, the `ignored-checks` list, the sweep stamp and the round are what the surviving shell scripts still share, under the data root that root's file places, and the scripts and the launcher build the same roots from the same override. The module's own artifacts (the measure file, the store, `hooks-module.log`) stay under the data root of the config dir's `claude-orchestrator` whatever the override says, `ORCHESTRATOR_MODULE_DIR` alone moving them: no surviving script shares them, and an override aimed at the shared root does not move them. `install.sh` and `uninstall.sh` build the state directory from the host configuration directory directly and do not read that override; install names the data root it reads, and uninstall leaves one placed elsewhere.

The module's log has every session on the machine writing to it at once, so each line is appended by `hooks/log-append.sh`, one append-mode write that never interleaves with another's and never rewrites the file; past 2 MiB it is moved aside, one previous generation kept, under a directory lock, rather than wiped.

Three things live elsewhere on purpose: the trust record is the host's own file (section 31), the dispatch record lives with the project being built (section 13), and the checkouts live under the workspace root (section 30).

## 5. Templates

No date or hour is written from memory (`skills/orchestrator/SKILL.md`, « The principles »): a brief is a file named by its subject, and a time a record must carry is a command's output. Each template carries the sections the orchestrator skill makes mandatory; how a brief is built from them is `skills/orchestrator/references/brief.md`, « The brief is printed, never typed ».

A template is read by an agent that does not load the orchestrator skill, so it keeps in full the rules that agent needs (the orchestrator's address, the STOP-and-ask clause, synchronous commands, the measured context as it nears the gate) and the skill points at the template rather than restating them. No template points at a plugin path, and none carries a host variable or a session reference (section 11): `brief-lint.sh` flags a brief that does.

## 6. Commands

Each command carries its own procedure and points at the skill for the rules. `status`, `agents` and `progress` are answered without a model turn by the module's command handlers, their markdown files kept as the degraded path. A command names in its `allowed-tools` the tools it needs, and nothing more.

A skill never takes a command's name: a plugin's commands and skills share one namespace, and a skill named like a command would shadow one or the other. The audit is a command and its brief, not a skill.

## 7. Tests

`tests/run-tests.sh`, bash, no network, no terminal automation, an isolated `HOME` per case. It also holds the repository's policy: the prose contains no vendor or product name outside the load-bearing identifiers, no model family name anywhere and nothing machine- or project-specific, and the guard proves it can still SEE a violation, through a probe planted and removed by the same function, because it once masked every hit behind the repository's own path. The suite also holds this document: the layout block against the tracked files (section 2), every section number the code cites against the headings here, and every relative link in `README.md`, `docs/`, `skills/`, `commands/` and `templates/` against the file and the heading it names.

`tests/e2e.sh` plays one real round against a live terminal and stays out of the default suite on purpose (section 15). `evals/` is the behaviour suite, graded on the decision and compared case by case with a committed baseline (`evals/README.md`, `evals/SELECTION.md`). `ORCHESTRATOR_*` variables are the suite's door into every script and the operator's alike (section 45).

## 8. Release

The version lives in `plugin.json`; the repository's catalogue is generated from it by `npm run marketplace`, and CI refuses a shipped change that does not raise it. The plugin's own `.claude-plugin/marketplace.json`, a single-plugin manifest kept from the plugin's former repository, carries the same version twice, and the suite checks the three agree. A release is the merge; the tag `orchestrator--v<version>` marks it (the first three releases used `claude-orchestrator--v`, and the suite reads both). Install: `/plugin install orchestrator@lounisbou`, then `/orchestrator-install`, beside the `method` plugin it depends on.

## 9. How the parts fit

### 9.1 A session's life, from launch to close

The orchestrator's core loop (plan, brief, launch, verify, review, terminate, replace) is `skills/orchestrator/SKILL.md`, « Where the rest lives, read at the moment of the action », each moment naming the file or files it reads. A file is one moment's and binds whole: a rule shared by two moments lives in its own file, named on each line of the table that needs it. A successor read lifecycle.md whole at its birth when the step named only the file, so the reference was split by moment, and the hand-over row sends a takeover to its brief (`templates/orchestrator-succession-brief.md`), which holds the announcement and the close proof.

- **Plan.** `skills/orchestrator/references/phases.md`.
- **Brief.** Written from a template, carrying its tier and the reading that chose it (`orchestrator:model-routing`, section 10): `references/brief.md`.
- **Launch.** `workspace.sh create` makes the phase's checkout (section 30); `iterm-agent.sh spawn --brief` lints the brief and opens the agent's place, a window of the orchestrator's home session or a tab beside it, in a checkout the host trusts (sections 12, 21, 31, 42): `references/agents.md`, « The agents' lifecycle is yours », and `skills/iterm-agents/SKILL.md`, « Safety order for a launch ».
- **Verify.** The launcher reads the mode the session came up in (section 43); the orchestrator then relies on the module's reports, not on its own polling.
- **Control.** An agent reports its measured context as it nears the gate, and the number is read against it: `SKILL.md`, « The principles ».
- **Terminate.** The module closes each implementer of a pull request's line (the last put on it and every one before, each judged alone on its own facts) once the pull request is Ready or merged, it is done, idle and clean, and it holds no other pull request or row (`hooks/close-agent.ts`); a record registered under two spellings of its path is read once, so an agent's own row never holds it: the tab proved gone on the process table (section 46), its checkout kept until the merge, work that comes back resuming it within the hour (`references/agents.md`, step 4), on the model, effort and plan its transcript names: the host's cache belongs to the account's organization and the model, and 5 of 7 resumes that rewrote their context ran on the caller's other plan, 2 on a tier's model (the plan is found by the `organizationUuid` of its last `credential_org` and the two `.claude.json`; an organization of neither plan, or a plan with no room, is refused).

### 9.2 The review round

One review session per round, spawned from `agent-review-brief.md` in a copy pinned at the head under review (section 37), its readers sized by the orchestrator, and reporting once. The module closes it, pin and all, once the round's verdict is recorded (`hooks/review-close.ts`): the session is the one whose launch brief names the verdict's project, pull request and head, the verdict's answer says it, and the tick closes it when its host is idle and its pin clean (never mid-turn), its cost on the row the verdict counted; a round's next reader is a fresh session, so none is needed again. A lens whose angle has a pr-review-toolkit agent reads with that agent's prompt: the brief names the agent's file and the session writes it into the reader's prompt (`hooks/lens-method.ts`). No hook changes a launch, since the host's auto mode refuses a call a hook rewrote; the module only logs a toolkit reader whose prompt names no file (`hooks/lens-ids.ts`). The orchestrator verifies every finding on the artifact, keeps only what must necessarily be fixed and names every dropped item with its reason, dispatches one correction round, and verifies it itself. The round lands on the dispatch record, and `ready` refuses a head no round read (sections 55, 58). The rules are `skills/orchestrator/references/review-round.md`, `review-verdict.md` and `review-thresholds.md`; review comments on a pull request go to a comments session, `references/review-comments.md`.

A pull request stays in draft. Ready, from the orchestrator's side, is implemented, reviewed, corrected, verified, `ready` green and rebased; then it tells the operator « ready ». Merging a pull request and taking it out of draft are the operator's, on his clear and explicit request, and in no list of what the orchestrator decides and moves on (sections 23, 58). The `Ready` or `Not Ready` label is the github gate's: the implementer's pull request opens `Not Ready`, the gate puts `Ready` itself once the pull request is ready and `Not Ready` back when the head moves, and the orchestrator tells its ready once `Ready` is on.

### 9.3 Rotation and succession

An agent at the context gate is replaced: `rotate` spawns the fresh session from a resume brief and verifies it before it closes the old tab, which stood down first (section 19): `references/rotation.md`. The orchestrator at its own gate hands over (`commands/succeed.md`): the state must live in its owners (every planned item and ruling an open row with its blocker, a judgment a row's note, each to-do item naming its rows), and the successor, spawned with `--successor`, takes the predecessor's place (sections 34, 39), on the model and effort in use now (section 27). Its prompt is fixed: load `orchestrator:orchestrator`, then run `succession.sh takeover` from the base directory that skill load printed (its own copy of the plugin, never the predecessor's older one) and execute what it prints. The takeover is printed from the state, never written from memory nor to a file (decision 0007 of the repository; « One owner per fact », below). The successor verifies the state on the artifacts, confirms the takeover, and closes the predecessor's tab on its « handed over » (section 45): `templates/orchestrator-succession-brief.md`. The operator's duties travel in the takeover's fixed text (section 47).

Why the successor reads little: measured on transcripts, a successor confirmed its takeover at about 75k to 97k tokens against a gate of 300k, of which 45k to 65k is the host's own before any tool; the part this plugin decides was the reading list, which ordered the spec, plan, runbook, state file and briefs directory read whole. It now reads the rulebook and what the takeover prints, the rest by section on demand. The successor reports the reading the module records when the turn that sends « takeover confirmed » ends, read at its next turn's first tool call, rather than any later one, so that its figures compare from one succession to the next: taken after the predecessor's close and whatever the successor read meanwhile, one orchestration's takeovers measured 81k, 88k and 104k at different turns. Two figures, its first turn and that turn, because the gap between them is what the takeover's verification costs.

### 9.4 The audit

An auditor weighs the method's cost against its yield and proposes to the operator, who launched it; it writes one report and stops: section 52. Kept on by the operator past its report, at its gate it tells him and goes on, and succeeds only on his word.

### 9.5 The coordinator

The operator runs several orchestrations on one machine at times, and they can step on each other: two checkouts on one branch, two agents pushing to it, two suites at once, one orchestration moving onto another's pull request. A coordinator, started and ended on his word only, watches for that from the outside. It reads the facts now (`skills/coordinator/scripts/coordinator.sh`, its header is the contract) rather than any declaration: a pull request is traced to its orchestrator along its branch, the checkout on it, the session working there and the address that session's brief names. It is the operator's single question interface: each question an orchestrator has for him goes to the coordinator, carried by the hooks module rather than by the orchestrator, which relays it verbatim with its sender's name, sends his answer back verbatim and dated, and never answers one itself. It answers questions from the facts, flags a collision to both sides, relays to the operator what is his (a merge, a scope, a method, ending a process), carries his orders to all, and gates nothing: `skills/coordination/SKILL.md` (named `coordination`, not `coordinator`, so the skill never shares its start command's name, section 6). Its succession at its gate is that skill's « Your context » and `references/succession.md`: the successor closes its predecessor, the first coordinator started by hand included, which ends its own session through the module's `end_session` where the host refuses the close. The launcher refuses to move or rotate the coordinator's tab without `--force`.

The relay is the hooks module's, at the end of an orchestrator's turn (`hooks/relay.ts`, on `turn.complete`, which fires once the turn is over): the wait the turn declared is written to the session's wait file beside its store row, its one writer the relay, so the measure's merge of the row can never put an older wait back. A wait on the operator waits on the questions the session asked with `ask` (section 9.6): it enters nothing and sends nothing. A closing proposal (`waiting: done`) is entered once per wait in the round of a coordinator on this machine, which is sent nothing: each message used to cost its model a turn just to note a wait. The same wait is never entered or sent twice (its fingerprint), and a closing proposal ends the moment its session works again. A session that ends or hands over with no successor learnt (section 9.6) withdraws all its open entries and questions; a session that dies without an end has its row judged dead by the store's read every reader makes, and that read does what its own end would have. When an entry the coordinator was shown is withdrawn, the module writes it `closed` itself and sends the coordinator one line saying to drop it and never relay it again; an entry it never saw is only withdrawn. A write that fails, or a send refused or late, is one log line, never a held turn, and the same wait is tried again at the next turn end.

The coordinator is found on this machine first, else from the last peer message whose envelope names a `Coord:` sender, so an orchestrator on another machine reports too (`hooks/remote-row.ts`, `hooks/remote-round.ts`, `hooks/remote-asked.ts`; only the question lines between machines are in the repository's `../../../docs/contracts.md`; the row's fields, its 5 % band and its refresh bound are `hooks/remote-row.ts`, `ROW_MARKER` and `ROW_BAND_PERCENT`). Its store row follows the same way, silently, at a turn's end and only on news, never at a measure. The host reaches only the sessions of its own account, so an orchestrator moved to another one is out of its coordinator's reach until that one is there too: a row or an open question's push that reached nobody is retried by a timer (`UNREACHED_RETRY_MS`), armed again at a module's start, since a session waiting on the operator ends no turn. The coordinator's `session.receive` hook consumes a peer line before any model reads it and checks it against a strict schema; a remote row carries no pid and an orchestrator waiting on the operator takes no turn to refresh it, hence the 24-hour bound on a remote row; a live local row of the same name wins.

On the operator's word only, the coordinator pauses orchestrations and wakes them. An orchestrator asked to pause reaches a quiet boundary (its agents stood down, its CI watches stopped, its state in its owners), writes no brief, spawns no successor and closes nothing of its own (`skills/orchestrator/references/pause-opening-move.md`); the coordinator closes its tab as a successor closes a predecessor and records it sleeping, apart from its own record so that it survives the coordinator's succession and its end. A sleeping orchestrator is not missing: `owners` attributes its pull requests to it, and no announcement chases it. A wake spawns it with the launcher's `--wake`, on the model and effort its resumed transcript holds, never asked of the operator; the takeover handshake is voided, its predecessor being gone. `drop` abandons one after one confirmation, its pull requests, branches and checkouts left to the operator.

On his word to open a new orchestration, the coordinator opens it, and never answers that he should do it himself. A remote orchestrator asked to launch one tried a free title and a remote-control command in the new tab, and the host's own review refused even the dry run as an autonomous agent launched at another session's request; the coordinator here had opened two by bending `--wake`, which is for a sleeping orchestrator. The launcher's `--open` is that opening, and it is refused when the caller's session reads neither `Coord:` nor `Orch:`, so an agent never opens an orchestrator. The host's own review judges the opening, a refusal being reported in one line to the session that relayed the order and never worked round. No session is asked to edit its own permissions: the host refuses that too, and rightly.

It lives outside the orchestrator on purpose. The orchestrator's skill carries one rule for it, ask the operator's question in the tab and end the turn on the machine line, and nothing else, so an orchestration run without a coordinator asks him directly, and one run with a coordinator loses nothing if it never asks it the facts. An earlier design put the orchestrators on a single channel through it, declaring before every dispatch and waiting for its « go »; that made every orchestrator carry the coordinator's weight to let it read what the process table, the checkouts and the forge already show.

### 9.6 The coordinator's round

The round of a coordinator on this machine is a directory of JSON files, one per entry, written whole and renamed into place under a lock, so no reader sees half of one; a file that does not parse is skipped by every reader and never repaired (`../../../docs/contracts.md`, « Round files », holds the subset other plugins read; the entries' own fields, senders, sequence, delivery, origin and closing proposal's statuses are `core/round-question.ts` and `hooks/question.ts`). It holds two kinds: a question to the operator, the object of `ask` (`hooks/question.ts`), and a closing proposal, the relay's entry (`hooks/round.ts`). Every close of either goes through one function, `closeRound` (`hooks/question.ts`), the entry read again and written under its lock as a pure plan decides (`hooks/settle.ts`), so the answer, its journal, the relay's fingerprint, the coordinator's notice and the push to a coordinator on another machine are one gesture. An operator entry of an older release is drawn by no pane: one received is answered on the line it came by, one left in the round is withdrawn by the round's wake and its sender told to ask it again with `ask`.

An orchestrator's open questions outlive it when a successor takes its work over: closing the predecessor's tab withdraws none of them, and the successor asks them. The successor's « takeover confirmed » is recorded by the predecessor's module, and at the hand-over and at the session's end each open question is rewritten for the successor, marked with the predecessor's session id, while an open closing proposal is withdrawn instead, never moved: the successor works, so the orchestration is not done. With no successor recorded, the session's end or hand-over withdraws them, the text saying why. The withdrawal message of a remote sender closes only the entry it names and only from the peer address the entry came from; a lost or doubled one changes nothing, and the words it quotes are never kept as the operator's answer.

Nothing wakes the coordinator's model for a question while the pane can answer it. The supervision pane opens on the operator's word and as its role left it (the role's own file, `pane-open-<name>`, never written by the close the host makes at a session's end); nothing else opens it: no start, turn end, wake or reload. What he closed stays closed. The older reason for never reopening it at a succession (a pane reopened there is unseen from the operator's remote client, and with it open no question reaches the tab) is accepted: the operator ruled that a succession leaves the pane as it was. The record of the pane's presence is judged on the host, never believed: a host whose tab was closed stays listed for days, exiting, on no tty, and is no pane. Its layout and keys are `hooks/supervision.ts` and its tests; the decisions that shaped it are these:

- A « Questions for you » section comes first, above the rows, since in a 14-row pane the choices fall below the fold; one open question is drawn at a time, in the order asked (urgent first), the others staying stored and untouched.
- The choices are drawn whole above a picker whose options carry only their letter: a text drawn twice was one of the operator's reports, and so was a collapsed « Answer: B … » that read as an answer already sent.
- The picker is the host's `Select`, not Buttons: a focused pane taller than its body scrolls on the arrows instead of moving its focus ring, so Buttons could not be walked in a pane listing several orchestrators above its question. A click gives the ring and answers nothing; a letter only moves the highlight, so a stray key answers nothing; the highlight starts on the recommended choice.
- The free-text field exists only once « Other answer » is picked (or when a question has no choices): a field drawn sooner is a stop of the pane's ring, which Tab reached from a choice, and the text typed there landed in it. On a surface with no picker (mobile) each choice is a Button.
- Every `<repository>#<n>` the pane draws is a link, so a pull request named in a question is one tap away.
- The pane's own scroll bar exists because the host draws none; the module counts the tree's height itself, since a plugin's own scroll call is not raised to its hooks.
- A pick or a submitted text answers through `closeRound` and sends its asker's session by id while it has a live row here, else by its name: two sessions may share a name, and a send to that name is refused. A send not delivered leaves the question answered and is written in its `delivery`, which the pane says.

The operator answers from the pane, in the coordinator's tab, which relays, or in the asking orchestrator's own tab, where a prompt that names one of an open question's choices claims that question and answers it with his words; words that name no choice claim nothing, and only the asker closes it. When an entry falls due the coordinator runs `coordinator.sh round`, and on his answer calls the module's `settle` (outcome `answered-here`) alone, which sends its asker the answer in the same call, to its session here or as a reply to its owner's machine; the close of a closing proposal sends nothing back. The close is the one gesture, no SendMessage beside it (`skills/coordination/SKILL.md`, « Relaying questions to the operator »). With no coordinator live, an orchestrator running the machine-wide decide settles another session's open question `answered-here` alone, the answer recorded as the coordinator's; a withdrawal or an answer by message on another's question, a replica of another machine, a closing proposal, and any settle by an agent, a subagent or an auditor stay refused. At its succession the coordinator runs `coordinator.sh round-archive`, which moves the closed entries into an archive that nothing reads: the store otherwise grows without bound, and every reader of it walks entries that are never printed again. The cost the whole relay removes: every wait had cost the coordinator a full model turn to read and file a message, up to 29 % of its tokens over the week the method's audit of 2026-10-17 read.

A question the pane shows is not asked twice: the coordinator asks one in its chat only when it is urgent or left unanswered in the pane. An open question is due when its sender asked it `urgent` (the orchestrator skill keeps that for a production fault, a detected regression or a decision under a real deadline), or when no pane of the coordinator is open: whether the pane is open is the one fact that decides where a question goes; open, it holds every other question however long it waits; closed, every open one is due at once, and on reopening it draws the first pending one. The module's `isDue` and the script's `due` are the one rule. Waiting for the operator's next word is not enough, an urgent question or a pane closed meanwhile being the order's very case: the coordinator's module reads its round every 30 seconds, and a session that a start or a turn end could not yet tell is the recorded coordinator (a name walk not answered in time on a loaded machine, a row naming no one) is asked again at each reading, since a successor not told at its first turn end was never woken while it waited (the operator's report of 2026-11-21); it submits to its own session one line for the entries just due, never twice for one entry (the ids are kept, so neither a reload of the module nor a successor coordinator wakes for one again), never for one answered meanwhile or whose sender has ended.

Two rules sit on top of the due marking. A hold on the operator's word: when he tells the coordinator to focus on one subject and present nothing else, it presents none of the other due questions until he lifts it, and an urgent one is signalled in one line without leaving the subject; the module detects no focus, the coordination skill carries the rule. And `/orchestrator:coordinator-decide`, the operator's machine-wide decide, runs one decision round over every orchestrator's open questions, in the coordinator's tab while a coordinator is live and in any orchestrator's tab while none is, in the round's own order: the urgent level first, then the questions grouped by orchestrator, the groups ordered by their oldest wait. `/orchestrator:decide` orders its own wave the same way, urgent first, then oldest first.

## Decisions that hold

## 10. Tiers name capability, and the binding is the operator's

The plugin carries no model. Three tiers name capability — `deep`, `standard`, `light` — and what each runs on is bound in the operator's `<state dir>/models.json`, overridable per run by `ORCHESTRATOR_TIER_DEEP` and its two siblings; with a tier unbound, the launcher types no model argument and the host applies its own default. Every session the orchestrator dispatched ran at whatever the launcher hardcoded before the tiers existed, which put a model identifier in a plugin whose rules forbid one and paid the top tier for work a test suite already judges. How the orchestrator chooses a tier is `skills/model-routing/SKILL.md`, a decision aid to its own judgment; how a tier is bound is section 57. The briefs carry the tier down to each session, so an agent can say when the work outgrew what its brief assumed.

## 11. What a brief can carry

Three defects came out of running one phase end to end on a live machine, none reachable from the test suite, because all three live in what happens when a fresh session opens the file. Each became a rule of the briefs (`skills/orchestrator/references/brief.md`, `skills/orchestrator/references/standing-rules.md`): a path only the host can expand does not resolve in a spawned session's shell, so a brief carries absolute paths; a brief points at a policy and cannot grant one, since a file written by a peer is not the agent's user speaking; and nothing that reads as a second address goes near the one that matters, so the suite refuses a session-reference shape under `templates/`, as it refuses a host variable there.

## 12. Linting the brief

Specification is the largest category of multi-agent failure in the published taxonomy, and a brief is this plugin's whole specification act; nothing read the file before it reached a session. `brief-lint.sh` reads what a script can read of a brief's structure — a hole, a path, an address, a field, never the wording of an instruction — and `iterm-agent.sh spawn --brief` runs it before any tab exists; a finding no longer refuses the spawn, it prints on stderr as a warning and the launch goes on, the startup prompt built either way, so a brief spawned with `--brief` cannot skip the lint (`skills/orchestrator/references/brief.md`, « The brief is printed, never typed »). `--prompt` and `--prompt-file` reach no lint of their own; the script is run by hand first when a brief is worth writing anyway (`skills/orchestrator/references/brief.md`, « The brief is printed, never typed »). Its limits are stated where it is run: scope, contracts and tier stay the orchestrator's, because a guard whose limits are unstated is one people trust past them. `--expect-created <path>` exempts exactly the paths a brief dictates for the agent to create — chosen over accepting any path whose parent directory exists, which would have exempted every misspelt file in an existing directory.

## 13. Measuring what the routing rule assumes

The routing skill reverts a tier drop that cost a second corrective round. Nothing measured that, so it could only be applied from memory — and a rule applied from memory always finds the drop was free, because its cost lands rounds later where nobody attributes it. `dispatch-record.sh` keeps one row per dispatch as JSON lines — class, tier, rounds, verdict — and `summary` prints the signals the routing skill acts on (`skills/model-routing/SKILL.md`, « The record »): a drop that did not pay, a cascade that stopped paying, an escaped defect that arms a second reader. The row is rewritten in place rather than appended per event: a record of events would make every read a reduction over history, and the history is not the fact. The same row carries the readiness gate (sections 55, 58). `summary <record> --open` prints only the open rows, which is all a successor needs at takeover; the statistics stay on the plain `summary`, read when a dispatch is routed. At a takeover even the open rows are too much read whole (99 of them were 25,371 characters at one birth): `--open --ids` prints one count per state and the ids, and `--open --label <ids>` the full line of the rows named, nothing else.

## 14. The terminal tooling speaks the app's own API

Every expensive launch bug this plugin carried came from one decision: the command was TYPED into a fresh shell. Typed, it could be truncated past a few hundred characters while the script reported success, lose its first keystroke to a startup question, and die on a non-ASCII byte; and placement drove a menu that needed an Accessibility grant and a focus flicker per move. The launch is now handed to the app's API with the tab's index (`skills/iterm-agents/references/commands.md`, « How the launcher builds a tab »). The surface is unchanged — same subcommands, options, messages and exit codes — across implementations, because skills, commands and briefs call it by those. `iterm-agent.sh` resolves an interpreter and hands over to `iterm_agent.py`, and the app's module is imported only by the subcommands that talk to it, so reading the tier map or a tty works on a machine with no environment and no window server. The environment is a virtual environment the installer builds under the state directory, because recent macOS refuses to install into a package-managed interpreter and a plugin has no business writing into one it did not create.

The suite holds the launcher by checks that read what the launch SAYS. A guard that reads an implementation is green on the day the implementation changes shape and wrong the day after.

## 15. The round the suite cannot play

`run-tests.sh` proves the plumbing and cannot touch the choreography: it forbids terminal automation, so the acts the tooling exists for — placing a tab, verifying a session, killing it — are out of its reach, and that gap is where the defects of the tab tooling were found. `tests/e2e.sh` plays one real round: a brief instantiated from the template and linted, a dispatch recorded, a session spawned at a tier, the tab placed against its anchor, the title guard exercised, the tab closed, the process confirmed gone, the record closed. It asserts the one thing no dry run can, that the tier named at dispatch is the model the live process carries. It is deliberately NOT part of the default suite. It drives the terminal, starts a session that costs tokens, and needs the app running with its API enabled: a suite that cannot run in a checkout with no window server is a suite people stop running. It skips itself off macOS and stops with a reason when the tooling cannot reach the app. It does not talk to the agent: verdicts and reviews need judgment and stay the orchestrator's.

## 18. A directive that outlives its decision is removed

The rule is the rulebook's (`skills/orchestrator/references/directives.md`, « When a decision changes, the directives change in the same move ») and this document follows it: a decision since reversed leaves this file, and whatever a skill states is pointed at rather than restated. Six versions in ten hours had left four of them when the rule was written — one a section of this document contradicting another — and three commands had never been wired to what the last versions built.

## 19. A rotation leaves the old session alive until the new one runs

`rotate` spawns the replacement first and verifies it is running before the old tab is closed: a rotation whose replacement cannot start must leave the old session alive, since closing first is the one order that loses work (`skills/iterm-agents/SKILL.md`, « Safety order for a live rotation »). Running it found two defects that no dry run could reach. A tab can come back from creation before its session is attached to it: the tty is waited for now, re-fetching the app rather than trusting the copy in hand. And a title compared across a rotation always differs, because a working session rewrites it, so a rotation's guard is the stood-down acknowledgment and the tty, never the title. A failure whose mechanism is not yet named keeps its diagnostics: the check prints what the spawn said on stderr, so the next occurrence can explain itself. `rotate` refuses `--no-verify`: the verification is the rotation's whole guarantee.

## 20. A running process is not a launched agent

The operator supplied the evidence: a screenshot of an agent tab stopped on the host's workspace-trust question, and a note that every spawn stole the focus of whatever tab he was working in. A directory the host has never opened stops the session on a question whose highlighted answer is « exit », and from outside the session looks launched, because its process genuinely runs; so the launcher refuses such a spawn before making a tab, `--trust` records the answer for one directory, tabs are created unselected, and `screen --tty` shows what a stuck session displays (`skills/iterm-agents/references/commands.md`). **The intermittent spawn is explained.** One launch in roughly six returned no tty: a session on that question took a stray keystroke and quit before its tty could be read. After the fix, five consecutive end-to-end rounds ran with zero failures; it was never flaky, it had a cause.

## 21. The tab is born in the anchor's window, after the last agent

An anchor is resolved across every window before anything else has a side effect, and the tab is created in the window that holds it; an anchor given and not found is refused, never an append, because a tab that lands somewhere is worse than no tab once the script has said where it is. Each new agent goes after the orchestrator's last one, so a window reads left to right in launch order, through a chain file per orchestrator tty checked on the app's tab id, which is never recycled the way a tty is. The rules are `skills/iterm-agents/SKILL.md`, « Layout convention ». In a home session the same order is the window index (section 66). `ORCHESTRATOR_SELF_TTY` overrides the process-tree walk that finds the caller's own tab, so the chain's resolution can be tested where there is no terminal.

## 22. The tab runs its launch through a login shell

Every binary the package manager installs is on an agent's PATH, because an agent must be able to run the commands the operator runs: the app is asked to run the launch through the operator's login shell, while the launch still names the host CLI by absolute path so a profile that breaks PATH cannot kill it (`skills/iterm-agents/references/commands.md`). The alternative — a fixed `PATH` in the host's settings — would replace every session's rich environment (version managers, language toolchains) with a frozen list. The launcher is the one place that knows a session is being born, so the launcher is where the shell is chosen.

## 23. The operator decides; the orchestrator runs

A command the orchestrator could run is the orchestrator's to run: opening and tagging pull requests, running the live round, updating the installed plugin, restarting the sessions a change requires, pinning a head for review. What reaches the operator is an arbitration — what the thing is, two readings, what each costs, one recommendation — and a configuration change goes to the session that owns the configuration. Merging a pull request and taking it out of draft are the two exceptions: they are the operator's, on his clear and explicit request, never taken on green evidence or by « decide and move »; the orchestrator tells him « ready » and waits. When the orchestrator's own session lacks what the role needs, the repair is a successor spawned with the environment the task needs, not a favour asked of him. The rules are `skills/orchestrator/SKILL.md`, « The principles ». The first of them came after an afternoon in which the orchestrator handed the operator three command lines — open this pull request, run this live round, refresh this credential: each justified by a limit of its session, none by its role.

## 24. A session is named at launch

The launcher passes the spawn's `--title` to the host as the session's name, so the title is the name every listing, the resume picker and the terminal show, not a transient tab label. The operator's ask, after the phase-4 implementer came up in the listing as the directory stem plus a reference, beside an orchestrator of the same stem: give agents and orchestrators names that tell them apart at a glance. The shape of a name is section 42; a brief still cites a session by name and reference together, because the reference is what disambiguates in every case (`skills/orchestrator/references/brief.md`).

## 25. A hidden pane is still a session

A session behind a maximized sibling pane — the host extension opens its review views that way — is enumerated by every reader of the tool and listed as `hidden` (`skills/iterm-agents/references/commands.md`). And `close` closes the SESSION, never the tab: `tab.async_close` would have taken the review pane down with the agent, and with the extension in use that is a tab the operator is reading. A session closed alone leaves its siblings, and when it was the last one the app removes the tab itself.

## 26. A chain belongs to a session, not to a tty

A tty is recycled; a session id is not. Once, the successor orchestrator landed the probe LEFT of its own tab: the chain file for its tty held an entry a previous occupant of the same tty had written. So every chain entry now also carries `owner`: the app's session id of the orchestrator that wrote it, and a chain read live keeps only the entries whose owner sits on the tty now; entries naming another owner, or none, are dropped and the file rewritten. The file keeps its name, because `self` still resolves to a tty and a file per tty is what `close` sweeps. A dry run has no app and no session id; `ORCHESTRATOR_SELF_ID` stands in for it.

## 27. The successor inherits the orchestrator's model and effort

The succession command spawned the successor at the `deep` tier, so a succession re-routed through the operator's map and silently undid a model he had set by hand. The operator's ruling: no default model — the successor inherits the orchestrator's model, and the one in use now, not the one the session was launched with. His rule of 2026-11-04 extends it to the effort and to every role (decision 3 of `docs/agent-dispatches.md`): a succession always inherits its predecessor's effort, whatever the role, and the host's effort setting, his default for new sessions, applies only to a session he launches by hand.

The pair is read on the caller's transcript (`caller_pair` in the launcher): the host writes each request it sends there with its pair, and the last one of the main thread names the model and the effort the session runs on now. That reading follows a `/model` or an `/effort` typed since the launch within the very turn that asks, which the measure file does not (section 3.2), and it exists for a session launched by hand or without the plugin. It is the host's own format, not a documented one, so nothing falls back: a missing transcript, request, model or effort refuses the launch, naming what was missing; a fixture of the suite pins the format and `tests/e2e.sh` checks it on the real host. The succession roles (`--successor`, `--auditor`, an auditor's successor, `--coordinator-successor`) read it whether or not `--inherit-model` is typed, and refuse `--tier`, `--model` and `--effort`. The tier map keeps binding what it binds — implementers, reviewers, probes; an orchestrator's first instantiation is the operator's launch, and its pair is his choice from then on.

## 28. The orchestrator never implements through a subagent of its own

A subagent's diff is the orchestrator's own diff, and its reviewer would be its writer; the method rests on the writer and the reviewer being different sessions. The rule, and why a plan-writing skill's execution header is boilerplate to replace rather than an order to obey, is `skills/orchestrator/references/standing-rules.md`, « Standing rules (the brief templates carry them, never retyped; enforce in every review) ». A successor meets it before it acts: its brief's first step reads the rulebook, whose Overview opens on « You orchestrate; you never implement. » The suite refuses a document under `docs/` that opens with that foreign header.

## 29. The library's tracebacks are filtered at their source, and nothing else is

Getting the app object subscribes it to layout and focus notifications, and the API library dispatches each as a task of its own. When a step's coroutine returns, the library cancels its helper tasks without awaiting them and the socket is closed; a helper task mid-flight ends on the closed socket, and its exception is reported by the event loop's default handler under the `asyncio` logger. Two earlier attempts read the loop and did not hold, because the failing tasks are either not yet dispatched or already finished; the suite's stub made them green by creating helper tasks by hand, a timing that never occurs against the app. So the module filters at the source: a record of that logger whose message starts with « Task exception was never retrieved » and whose exception class is `ConnectionClosed…` is dropped, and every other record passes, because a diagnosis the stream exists to carry is not of that shape. Measured on a live spawn against a control: the known lines gone, every other line kept.

The launcher's other readings follow the rule this section's history taught: a gate that cannot measure holds nothing, and says so. A reading that never comes (a transcript not yet written, a record that cannot be read) lets the launch through with a line on stderr, never a silent pass and never a refusal. One reading is a named exception: a permission mode that never gets read is refused, the tab closed the way a mismatch closes it, because a session nobody can read may be parked on a dialog or hung at start, which the plugin already calls not launched (§43). A launch with no first prompt could only ever fail that timeout, since the host writes no transcript before one, so it is refused up front, before any tab is made.

## 30. A checkout per phase, with the project's local material

Two rules of the method were held by discipline alone. « One writer per repository » queued every dispatch behind the orchestrator's own checkout, and a sandbox that should let an implementer write under one root could not, because a git worktree writes into its source's `.git`. A clone contains everything it touches, and a clone per phase turns the one-writer rule into a fact (`skills/orchestrator/references/phases.md`, « Prerequisites and phase rules »). A clone carries only what git tracks, so the project's local material — its settings directory (never the operator's own `settings.local.json`, which stays his), what its exclude file keeps out of history, what its manifest names — is copied as part of making the checkout, not as a step after it, which by hand was done only sometimes. What is left out on purpose: several implementers on one repository, a `--workspace` flag, and cleanup by age.

The commands, refusals and exit codes of `skills/orchestrator/scripts/workspace.sh` are its header's; the decisions are these. The root is `ORCHESTRATOR_WORKSPACES`, else `~/dev/workspaces`. A stale checkout is deleted on purpose, never overwritten. The clone's `origin` points at the source's `origin`, so the implementer's push reaches the real remote. A copy that fails leaves nothing half-made. `delete` refuses a path outside the root, always, and a dirty tree or a commit on no remote branch unless `--discard`, the guard that keeps a shelved phase's work from vanishing before anyone said so. The script never writes the trust record (that is `spawn --trust`), never launches anything and never touches the source.

Every listing of the source's local material is read NUL-separated (`ls-files -z`), because git quotes and octal-escapes a name that is not plain ASCII by default and the copy would read a path that does not exist; the sweep reads the repository's default branch from `origin/HEAD` alone, with no network call and no guess, since it runs inside an orchestrator's turn end on a deadline.

Never copied, even when listed: `.git`, `node_modules`, `vendor`, and anything `.gitignore` covers that the manifest does not name; build trees and caches rebuild, and copying them makes a huge checkout and copies secrets by accident. The copied material is kept out of the checkout's own history the way the source keeps it out of its own, so a checkout does not read dirty from birth. The root must be writable under the sandbox for implementer sessions and readable for the orchestrator's clone, a request to the session in charge of the host's configuration.

## 31. The trust record is the host's file too

Three readings of the trust gate (§20), taken once a checkout per phase made the gate run at every dispatch: a record that already said yes was rewritten anyway, a record the launcher could not read launched past the question in silence, and entries outlived their directories. So a recorded directory is never rewritten, an unreadable record lets the launch through and says so, and `trust prune` lists the entries whose directory is gone before `--apply` removes them, because the file is shared and a write is a decision (`skills/iterm-agents/references/commands.md`). The script that makes checkouts never touches this file; pruning is the launcher's, beside the writer.

## 32. The model that answers is read, not assumed

Once, the host switched a running orchestrator from the operator's chosen model to a fallback after its own classifier refused one message, and told nobody: the launch line, the process line and the status line still said the chosen model, and the only trace was the transcript, where every assistant entry carries the model that produced it. So the module reports the model that answered last: the measure event's model is the figure the host itself carries, the last assistant entry's `model` is the trace that once caught it, and `unavailable` is said rather than a line left out. The module keeps the last model in its own memory: the first reading is kept in silence; a reading that differs makes one line, shown as a toast and put in the context of the session's next prompt, in every session whatever its role — the channel every gate line reaches the model by, since a toast alone fades unread — saying which model answers now, which one answered until now, that the operator must hear of it in the next message, and that a succession does not repair it — so a switch back is said too and a drift that holds is said once, and a module reload, which has measured nothing yet, says nothing on its first reading. What is left out on purpose: comparing against the launch line's `--model`, since the kept reading is enough and what matters is a change, not a distance from an intention; and naming the refusal's category, which would read as a verdict on the message when the drift is the fact. Any automatic action on a drift: the operator decides what a session on the wrong model does next, and the plugin takes none.

## 33. The installer reads the stored command through its home spelling

The installer unwraps a tap a previous install left by comparing the stored status line command with the tap's own spellings, and the tap's path is expanded. An operator who keeps the configuration directory in a repository writes the home as `$HOME` or `~`, which the host expands when it runs the line; compared as text, the installer reads a wired file as unwired and leaves the tap in place. Before the comparison, the installer normalises the command it reads — a leading `$HOME/`, `${HOME}/` or `~/` becomes the expanded home, and nothing else in the line changes — and the stored line is never rewritten: which spelling a settings file uses is the operator's choice, in a repository the plugin does not own. What is left out on purpose: detecting a doubled tap already written by an earlier run — that file is the operator's to fix by hand.

## 34. A successor takes the predecessor's place, chain included

The layout convention once promised that a successor spawned `--right-of self` « sits between you and your agent »; with agents open it landed past every agent, joined the predecessor's chain as if it were one, and its own next spawn landed left of the agents it had inherited. A successor is not an agent: `spawn --successor` places it immediately right of the caller, the chain ignored, and hands the predecessor's own chain entries over to it (`skills/iterm-agents/SKILL.md`, « Layout convention »). In a home session the successor is a window of the same session and takes window 0 (section 66). The chain is handed over only once the successor is verified running: a spawn refused after its tab exists closes the tab it made, prints its tty, says whether the close happened, and leaves every chain as it found it. If the new session cannot be read in the seconds after creation, the launch stands and one stderr line says the chain stayed behind and how to place the next agent by hand. A step that must never be forgotten belongs to the launcher rather than to a template: the hand-over is the launcher's, so a successor that forgets a step cannot lose it. The same holds for the entry that names the caller's own tab in an orchestrator's chain (written when that orchestrator spawned it, `--resident` mark included): the launcher re-points it, in every chain that holds one, to the successor's tab and tty with owner and mark kept, so the orchestrator's turn end and `--right-of self` never read a closed tab, or a recycled tty's stranger, as its resident agent.

## 35. The settings directory travels through the exclude file, and a base may be the remote's

Two findings from the sibling build that runs the same script on a larger repository: copying the settings directory whole would have carried the host's own worktrees, 4.2 GB, into a checkout meant to hold a phase, and a source whose local base lagged its remote handed the phase a stale base with no way to name the fresh one. Inside the settings directory, the exclude file's patterns say what does not travel: a pattern that reaches inside the directory names something the host generates, while a pattern naming the directory as a whole says only that the directory stays out of history, which every copied file already does, so it is set aside. The files are listed by git and copied in one pass, never the directory whole.

A base is a branch name or one of the source's `origin/` refs, and the origin comes first: `--base <branch>` starts from the origin's branch when the origin holds it, even when the source's own branch lags it or the source never fetched it, and from the source's local branch only when the origin has none. The origin is asked with a probe that never prompts for a credential and gives up after 30 s; when it cannot be read, the local branch stands and the reason is said, and a branch only the origin holds is refused with that reason. Any other remote is refused, because the checkout's `origin` is the source's; the source is never touched. An explicit base says on stderr which ref and sha it started from. A bare commit id or a tag is refused: a phase branch stacks on a branch. What is left out on purpose: reading `.gitignore` for the settings directory, since a project that ignores it there says nothing about what inside it is local material. The operator's own `settings.local.json` never travels either way, whatever the exclude file says about it: the permission rules it holds (a squash-merge, an undraft, a pinned-lease push) are his session's, never an agent's.

## 36. A reader's pinned copy is a detached worktree; a clone is for a writer

The clone per phase exists for two reasons that concern a WRITER only: sandbox containment and one writer per checkout. A review reader, or an instrument the orchestrator runs itself, writes nothing, is confined to no root, and needs none of the project's local material but the norms its global excludes keep out (section 37) — least of all the orchestrator's own briefs and state file, which a clone of this repository would carry into a reviewer's copy. So a reader's copy is a detached worktree of the orchestrator's own checkout, at exactly the head under review (`skills/orchestrator/references/review-round.md`, « The deepest method, from the first round »), made and removed by the script (section 37). A delivered implementer is not kept for the fixes a review may order, whatever the tab is called (section 45).

## 37. A pinned copy for a reader, made and removed by the script

The first review run under that rule showed the two things a by-hand step always shows. The copy was one `list` did not know and `delete` would have removed leaving the source's worktree metadata behind, and the suite read the worktree's `.git` file as a machine path. `workspace.sh pin <source> <name> <ref>` makes the copy under the same root with the same naming as `create`; the ref is anything the source resolves to a commit, refused when the source does not know it, since a pin names a head and a head is a fact. It copies the files the operator's global excludes keep out of the source, the ones `create` copies (section 40), the project's instruction file among them — two review sessions once read the code without the project's norms — and no other local material: nothing of the settings directory and nothing the source's own exclude file keeps out, where the orchestrator's briefs and state live. `delete` refuses a dirty pin, or one whose head is on no branch of the source, without `--discard`, then removes the worktree so the source forgets it. Out of scope on purpose: pinning a directory outside the root, and a pin that carries any other local material, since a reader that needs a project's environment file is running an instrument, which is the orchestrator's to prepare.

## 38. A session knows its own tab, and moves only what is its own

`list` marks the caller's own row `self` and shows each session's name beside the tab title, and `move` refuses a target that is neither the caller's own tab nor in its chain unless `--force`, which says what it moved (`skills/iterm-agents/references/commands.md`). A session the caller did not launch is not its to place: an orchestrator that had never measured its own tty took the last tab for its own and moved a stranger's session between itself and its agents.

## 39. A successor carries the orchestrator's name, and a title has a shape

Two reports, one machine each: one predecessor spawned its successor with `--title steward-successor`: the launcher took it, and the successor came up under that name in every listing; another spawned its successor with a plain anchor, and it landed at the far right of the window with no chain. A title has a shape the launcher holds it to (section 42). A successor spawned without a title takes the caller's session name — the host's record of the session first, which holds a name given by a rename, then the launch line's `--name` — so every brief that cites the orchestrator still cites it; a caller whose name cannot be derived is refused and the title typed in the house format. An orchestrator's title with a plain anchor is refused, because the plain anchor lands after the chain and a successor spawned there is the far-right tab the operator saw. A successor comes up under remote control with its name, because the operator drives his orchestrators from the host's remote client too; an agent never does (section 44). `rotate` forwards every argument it does not consume, `--trust` included. The rules are `skills/iterm-agents/references/commands.md`.

## 40. The operator's global excludes are local material too

One file travelled by hand on every live run of this family: the project's instruction file at its root, kept out of history not by the repository's exclude file but by the operator's global one. `create` reads the global excludes file the source's git configuration names (`core.excludesFile`, else the host's default location), copies what it keeps out of the source, and adds its patterns to the checkout's own exclude file, so the copy stays out of the checkout's history; the stderr line counts those files apart from the repository's own.

## 41. What the live rounds paid for, in text

Four readings of the live rounds each became a sentence where it binds: a stand-down acknowledgment that reports anything uncommitted is an unfinished delivery (now a fact the module reads before it closes an agent, `hooks/close-agent.ts`); a reader writes no git configuration and carries every path inside each tool call (`templates/agent-review-brief.md`); a brief's context line names the agent's own measure file, never a checkout of this repository (`templates/agent-review-brief.md`, and the comments brief since removed; it named the plugin's installed gauge script until the hooks module replaced both the script and the rule); and a fresh tab reads « Chat » for a few seconds before the session names itself (`skills/iterm-agents/SKILL.md`, « Reading the tabs »).

## 42. Short names, chosen servers, and a hand-launched orchestrator named on the spot

Three rulings by the operator on the evening 0.25.2 shipped, after reading his window: names too long to read, every agent loading servers it never used at about 70 MB each, and an orchestrator he had started by hand that no listing could recognise. A name has three roles (`Orch:`, `Agent:`, and, under `--auditor` only, `Audit:`), the subject at most twenty-five characters, and the launcher refuses anything else; `--title-free` is the probe's escape from the shape. An agent's servers are chosen per agent from the operator's catalogue under a strict launch by default: the catalogue copies server definitions rather than switching scopes off, because measured, no setting removes a user-scope server and the strict flag alone removes every server of every scope. A session the operator starts by hand is named when it declares itself: the host gives the model no rename of its own, so the plugin's `rename_session` tool records the name the model chose and the module runs the host's `/rename` with it when the turn ends — the host refuses a command run from a hook the turn is waiting on — so the session calls it once and ends the turn, and dispatches from the next, under its new name. The rules are `skills/orchestrator/references/agents.md`, `skills/orchestrator/SKILL.md`, « The principles », and `skills/iterm-agents/references/commands.md`.

A later ruling (2026-09-30) answered a fourth: a spawned agent could not reach the account's own Slack connector, because the strict launch excludes every scope but the catalogue's file, and the account's connectors live outside it. `--account-connectors` drops the strict flag for that one chosen spawn, so the session also loads every connector of the account, not one of them. Dropping strict reopens the project's own "enable these MCP servers?" dialog, so the launch pre-answers it for that spawn only. Off unless asked: without it the launch is unchanged, byte for byte. A launch also names the tools the session is not given and carries the host's cuts in its one `--settings`: §65.

## 43. The mode a session came up in is read, not believed, and the screen is read from the bottom

The host applied the permission mode asked to every session on two tiers' models and to none on the third's, which came up in default mode with the flag accepted and ignored; two agents stood on a permission prompt in tabs nobody watched. So the spawn reads the mode on the session's own transcript and refuses a launch whose mode differs, closing the tab it made and naming the repairs, and a session nobody watches runs in the operator's decision mode (`skills/model-routing/SKILL.md`, « Pairs, tiers and the map »). A transcript that has not appeared by the timeout refuses the launch too and closes the tab the same way — the named exception section 29 states. A launch with no startup prompt at all is refused before that timeout is even started, for the same reason (§29): no transcript, ever, without a first prompt. `screen --lines N` returns the last lines, because a blocked prompt sits at the bottom of a tall terminal.

## 44. An agent comes up with remote control off

The host starts remote control for every new interactive session when nothing is set. The operator read his remote client and found an agent in it, a session an orchestrator had spawned with no `--remote-control` on its launch line. Measured with a debug log, a launch setting turns it off and the flag wins over the setting. So the launch carries the setting whenever it carries no `--remote-control`: every spawn that is neither a successor nor an auditor, and a successor spawned with `--no-remote-control`. A plain successor and every auditor carry `--remote-control '<its name>'` (sections 39, 52), as `iterm_agent.py`'s own comment says.

## 45. The closing round: what the deferred list held

One round closed everything the live rounds had deferred, each item fixed or closed with its reason.

- **An implementer lives until its pull request is Ready** and receives only the kept review findings (`skills/orchestrator/references/agents.md`, step 4). The brief lint's check 9, which refused a brief keeping it after its delivery, is retired with it.
- **A subject neither starts nor ends on a space**, so a listing never shows a name that reads as empty or one the operator cannot tell from its trimmed twin.
- **The library's stderr noise is filtered at its source** (section 29).
- **The predecessor's last message is the successor's signal to close its place.** On the takeover confirmation the predecessor sends « handed over » as its last message and ends its turn; the successor closes the predecessor's tab on it, or on a reading of the tab's screen after five minutes, never on the host's idle notice (`templates/orchestrator-succession-brief.md`). Measured on one succession: the successor waited for an idle notice that reaches a working session only when its own turn ends, and it arrived a quarter of an hour after the predecessor had finished.
- **A hand-started predecessor is closed like any other, nothing asked.** The successor always closes its predecessor, one the launcher did not open included; where the host refuses that close, the successor asks the predecessor to call the module's `end_session` tool, and proves the end on the tty, never on `list`, which keeps the row of a tab left holding a shell (`templates/orchestrator-succession-brief.md`, step 4). Measured on one succession: the host's own safety check refused the close as interfering with a workload the session had not started, because the plugin did not launch that tab. The operator's first ruling (2026-10-01) was to ask him up front; a predecessor then stayed open for hours beside its successor, under the same name, while the successor waited for a « close it » nobody was asked to give again, and his standing order replaced the question with the module's end.
- **One marketplace, the family's** (section 8).

Closed without a change, with the reason:

- The 25-character cap counts code points, not graphemes: the subject is typed by an orchestrator in the house format, no listing has shown a combining sequence in one, and the standard library carries no grapheme segmentation to count with.
- Two transcripts born in the same instant tie on their path: the launcher launches one session at a time and waits seconds for the host on its tty, so two births inside the filesystem's timestamp resolution are not a case it makes.
- An empty `permissionMode` string is read as absent: the host writes a mode name, and a value that says nothing is judged as unread, which refuses the launch the same way (section 29).
- The dry run's stdout does not tell « no catalogue » from « empty default »: the stderr line is that reading, and the suite reads both streams.
- `ORCHESTRATOR_PS_TABLE` is honoured on a live run: every `ORCHESTRATOR_*` override is read the same way and is the suite's door and the operator's alike, and a guard on one of them would be a false comfort about the rest.
- `list` spends up to ten seconds on a tty whose process table does not answer: the bound is on `ps`, a tty that does not exist answers at once with nothing, and the wait has not been observed.

## 46. An app that stops answering is named, not waited on

One right-click left a context menu open in iTerm2, and for four hours every launcher call hung while the terminals kept scrolling. A menu runs a nested event loop during which the app dispatches no AppleEvent, and the API library's authentication is a blocking read no timeout inside the call could reach. So the bound is taken outside the library, before it is entered; the launcher tries two rungs, `api` then `applescript`, and says which served; when neither reaches the app it samples the main thread and names the cause with its remedy; and a close is proved on the process table, not on the app's acknowledgment (`skills/iterm-agents/references/commands.md`, « When iTerm2 does not answer »). The `applescript` rung selects the operator's tab again after its `create tab`, which selects the tab it makes, so a launch leaves the operator where they work on either rung. `ORCHESTRATOR_BACKEND` pins one rung, and an unknown value is refused rather than read as the default. The suite pins `ORCHESTRATOR_HOST_CLI`, which is read from the environment at import, and the operator's own shell carries it as an absolute path: the same tests were matching two different names depending on whose machine ran them.

## 47. The operator's word comes first, and it is answered

The operator's primacy and the seven duties owed him while he rules are `skills/orchestrator/SKILL.md`, « The principles », which sits above every other section because it outranks them. Three of its rules stand out because their earlier forms read otherwise. Every question gets an answer, in order, before any tool call, the one exception a question on the state of an artifact, which gets one short re-reading command first. On the third ask of the same question the session re-reads its own earlier messages first: if it had answered clearly, the operator missed it, and the answer is given again in full, at the top of the message, alone, with no hand-over offered; if it had not answered, or answered beside the question, it says so in one sentence, answers, and offers the hand-over to a fresh session. And only an explicit instruction of his on the very point outranks a rule: a deadline, a wish or a question is not an order to break one; an instruction that does bear on the point wins, the contradiction said in one line; the tooling's deliberate refusals are never routed around; and what would end a session or change the machine stays a STOP-and-ask.

The duties also travel in the takeover's fixed text. A successor reads what the takeover prints first and can act on it before it loads the rulebook, so a duty living only in the skill is lost at the first succession; the suite checks both files carry them.

## 48. An agent has a place the operator can see, and a name that cannot be read is not invented

A session that is neither a window of its orchestrator's home session nor a tab in the window the operator reads is not an agent he can see, place, close or account for, and a launcher that quietly hands him one has hidden a fault that has a one-keystroke remedy: the launcher has two iTerm2 rungs and no third, and a launcher failure is reported, never routed around (`skills/iterm-agents/SKILL.md`, « An agent is a window of its orchestrator's home session, or a tab »). This section first read « an agent is an iTerm2 tab, and never anything else »; goal G12 reversed that wording, not its reason (section 66). The refusal that survives is the old one: **a window is a placement chosen by where the caller runs, not a rung a failed iTerm2 call falls to**, so `tmux` stays refused as a backend and a wedged app still stops the launcher for any tab it must make. A name is read first from the host's own record of the session (`<config dir>/sessions/<pid>.json`), which holds a name given by a rename too, its surrounding quotes stripped; without one, it is read from the process table to a bound, or not at all: `ps` hands back a flat command line, and the quoting that made `--name` one argument is gone, so `--name` goes last in the launch and a reconstruction longer than forty characters is listed `(name unreadable)` — a different fact from `(host default)` — rather than a name invented by wherever the words happened to stop, which an orchestrator would then address.

## 49. The caller is not always in the app

A session running in another terminal still has a tty, and the app simply has no session on it. The chain is the app's and cannot be kept for a tab the app does not know. That is a fact to state, not a reason to fail: a spawn from such a session keeps no chain and says so. A traceback is not an acceptable answer at any frequency. This section first justified the fix by claiming that the operator's ruling made a caller outside the app « the case that has to behave », a ruling given the hour before; he struck it out, because a ruling that forbids making something makes it rarer (section 50).

## 50. A repair is justified by what is broken

A repair is justified by the thing that is broken and by nothing else, and a justification's direction is read before it is written: a rule that forbids something makes it rarer, not commoner. Section 49 is the case that taught it.

## 51. A self-anchor the app cannot resolve is lost, not fatal

A NAMED anchor the app does not know is a tab the caller got wrong, and refusing it stays right. The caller's OWN tty with no session of the app's on it is a different reading: the caller runs in another terminal, and « place the new tab beside me » has no meaning there. Refusing that case blocked the one spawn that exists to end it. A session outside the app could not spawn its own successor, the succession ordered to bring it back into the app. The anchor is dropped, the new tab lands where the app puts it, and the drop is said with its tty — which keeps the successor carrying the name derivation and the remote-control flag that `--successor` alone provides.

## 52. The audit of an orchestrator

An orchestrator's deliveries are read by its reviews; its METHOD was read by nobody. The first audit of a live build was run by hand, by a second session the operator pointed at the first, and it found defects of the method's kind. The operator asked for the instrument: `commands/audit.md` launches it, `templates/agent-audit-brief.md` holds the auditor's terms.

**Why it was redone.** Its first form ordered changes to the orchestrator, which applied them, and kept a method file of its own. On another project it issued 101 orders in 18 days, almost all of them new rules: it reacted to the incidents everyone saw and never to the time lost a little at every step, never ran the loop « change, measure, keep or undo », and ended up auditing its own rules. The role was right; ordering without a cost and without an end was not. It now proposes and the operator decides.

**What it does.** It starts from the stock (what is in place, what it costs, what it has yielded), shows the net balance (lines added and removed under the product against the instruments, time in gates against time producing), re-reads the figure of each proposal the previous audit made, and proposes at most five changes, each « remove X » or « restore Y » with its expected gain, its cost and the figure that will check it. Removing is proposed as freely as adding; adding asks for a product defect as its evidence. It writes one report under the briefs directory's `audits/`, tells the operator, and stops. The report keeps a dated name, because successive reports of one subject must not collide, but its date is the output of `date +%F` run at launch, never typed.

**What it does not do.** It writes no other file, applies nothing, orders nothing and messages no session. The orchestrator's skill says nothing about it: a proposal the operator relays is his word, like any other. The audit ends by itself, and the session that launched it closes its tab once the report is delivered and its verdict relayed; an auditor is kept on only on the operator's word, and then meets its gate with work in hand: it succeeds (`templates/auditor-succession-brief.md`) instead of stopping. With no work after the report, the rule is unchanged: the one report, then stop.

**An auditor is a third kind of session** for the launcher: it is placed immediately left of the orchestrator it audits, on the caller's model and under remote control, but written into no chain, because an auditor written into the chain would become the anchor the orchestrator's next agent lands after (`skills/iterm-agents/references/commands.md`). Its place is read after the spawn and repaired if wrong, and a listing it cannot read is said as such rather than as a misplacement.

**Its instrument.** `rhythm.sh` reads the net balance from git alone. Two readings of its first version were wrong on a real repository, each repaired with a fixture case seen red first: a pathspec that stopped `*` at a slash, and a bare date that git completes with the current time of day. A default branch that is guessed is named on stderr, so a figure built on a guess is never silent.

## 53. A method he names is a format, and a fact not read is not stated

Duties 4 and 5 of the operator's word (section 47): a method the operator names binds the presentation as well as the judgment, and a name, a role, a figure or a cause comes from an output of the session or is said to be unknown (`skills/orchestrator/SKILL.md`) — a named method nobody opened once produced a summary with no assessment, and a name no command printed was once stated as fact. The comments section of the review reference points at duty 4, and both duties travel in the succession brief.

## 55. A pull request is ready only when the record says a round read its head

The review round of a delivery (`skills/orchestrator/references/review-round.md`) was skipped three times in one day, and two pull requests were one command from leaving draft on that evidence. Nothing was wrong with what the rule said; what was wrong is where it lived. A rule prose alone carries is applied from memory, and on a day with three rounds in flight it is remembered by the session that has the most context to spare, which is never the one at the gate. It needed a refusal a script can make. So the round's reading lands on the dispatch record, and `dispatch-record.sh ready` answers one question, whether the last review read the head in front of the orchestrator (`skills/model-routing/SKILL.md`, « The record »). The gate is blind past its facts on purpose: whether the findings were verified and whether the operator approved stay the orchestrator's and his, and a green `ready` is not an approved pull request.

The screenshots a frontend pull request owes went the same way: written in the rulebook, the phase brief and the review brief, and still five front-office pull requests were declared ready without one image, two « skipped » for lack of data on the reference account and three never shot. So the row also says whether its pull request changes what a user sees (`surface`), and `ready` refuses a row that says nothing and reads the description of a `--ui` one, refusing it with no image. Counting images is all a script can see; whether they show the surface the diff changes stays the review's and the orchestrator's.

Counting them was then shown not to be enough. On one day three captures that showed a defect (a map button whose icon sat off-centre, a reset button pushed onto a row of its own, an « after » image with stray text left in a search field) were each read by an orchestrator and passed, because the briefs asked only whether the images were there, showed the surface and used the right account. Nobody was asked to look at an image for a defect. So every capture is audited against one checklist (`skills/orchestrator/references/screenshot-checklist.md`) by the implementer before delivery, by the screenshots agent, and by the orchestrator before its verdict, each image getting one line, clean or its defect; a capture that shows a defect is not delivered, it is fixed and retaken. The orchestrator's audit lands on the row (`dispatch-record.sh audit`), and on a `--ui` row `ready` refuses with no audit at the head, with an audit that opened fewer images than the description carries, and with an audit that recorded a defect; `--minor` and `--none` rows are not held to it. Whether the audit was an honest look stays the orchestrator's; the record only makes it a step that cannot be forgotten.

The audit then left the orchestrator's context. An orchestrator that opened twenty captures of one pull request in a row grew by about 42,000 tokens at once, from about 277,000 to 319,000, and crossed its 300,000 gate; an image read by the orchestrator stays in its context until its succession. So the audit is made by a dedicated read-only agent, `orchestrator:screenshots` (`agents/screenshots.md`), which opens every image one by one against the same checklist and returns one line per image, which costs the orchestrator only those lines. The agent audits, it never counts; the record's refusals are unchanged. The orchestrator opens one capture itself only on doubt about that one.

The proof end to end went the same way. A frontend pull request was merged and deployed and did not work there: its only proof was a browser pass the implementer reported, nothing a reviewer could replay, and neither the report nor the « ready » said there was no E2E test. So, on the operator's order, every pull request carries an E2E test as far as one can be written, or says plainly `E2E: none — <reason>`, and silence is not ready (`skills/orchestrator/scripts/brief.ts`, its build rules, and `templates/agent-phase-brief.md`). The line lives in the implementer's report, never in the pull request's description; the review replays the test or judges the reason. `ready` once also held `E2E: none` for the operator's validation of each pull request: every orchestrated pull request without a test waited on him, and that branch was removed with the method-drift retirements (the method-drift design, §11.3). The E2E record is the github gate's.

## 56. A state is re-read in the turn that asks about it

The seventh duty (section 47): nothing is asked, proposed or reported as pending before its state, and the premise the question assumes, are re-read on the artifact in the same turn; the rows are corrected from the artifacts at every quiet boundary (`skills/orchestrator/SKILL.md`). No script and no polling: the re-reading is the command the question already needs, run in the turn that asks it, and a watcher that refreshed the rows on a schedule would only move the stale reading from the record to the watcher's last pass. `decide` verifies each item when it collects the round and again when it presents it, and `progress` corrects the rows where the artifacts disagree (section 6).

## 57. A tier is bound to a family, and the launcher says when it is not

A tier is bound to a family alias, never to a versioned identifier, which goes stale without a sign (`skills/model-routing/SKILL.md`, « Pairs, tiers and the map »). The launcher reads the binding on every dispatch, so it is where the drift can be seen: it warns in one line on a versioned binding and launches anyway. It never refuses and never rewrites the map: a pinned model may be exactly what the operator wants for a while, and the file is his. The detection names no family, so the plugin still carries no model name.

## 58. A review round, a correction round, and ready is the operator's turn

The orchestrator's process on a pull request it dispatched is a review round, its own triage, a correction round the gate and a reader at its head verify, and done, as many times as the check plan's `review` max says; rounds of review repeated until nothing is left are the operator's own process, when he runs reviews by hand (`skills/orchestrator/references/review-thresholds.md`, « Thresholds a verdict never crosses »). Rounds that repeat until nothing is left converge on nothing: each one reads the previous fix, finds something in it, and orders a fix of its own, and a finding nobody had to fix ships as churn. Where the review record is written, and what a rebase does to it, is that same rule, stated there once; `fixed` and `ready` follow it. Outside auto-merge, his review, taking the pull request out of draft and approving the squash-merge are his by default.

## 59. A frontend surface is proved by a browser run and screenshots on the pull request

A green suite and a read diff say what the code does, not what a surface shows: a layout that collapses or a screen that does not match the spec passes both. So, on the operator's ruling, a pull request that creates or substantially modifies a frontend surface, or creates the interface of a new feature, is tested in a real browser with Playwright and carries screenshots of the surface on the pull request (`skills/orchestrator/scripts/brief.ts`, its build rules, for the implementer; the review check is `skills/orchestrator/references/review-verdict.md`, item 12, and the review brief carries it for the round). What is left out on purpose: no script, no hook and no tooling for screenshots, and no named upload mechanism. What the suite reads: in the phase brief and the review brief, the trigger phrase verbatim, the minor exemption, where the screenshots go, the stop without a browser, the review check, the excuse and the red flag, each check falling when its sentence is removed or reversed. The audit every capture owes, its checklist and the record that gates it are section 55's.

## 60. The launch can set one session's gate

The operator's ruling (2026-10-02): 300,000 tokens by default, and a parameter changes the value. `spawn --gate-tokens <N>`, which `rotate` forwards, takes a positive integer and refuses anything else before a tab exists, and the launch exports it as the variable the module's context gate already reads, so the launcher adds no new reader: the gate of a session inherits what its launch exports, as the kill guard's marker already showed. The gate stays the smaller of 300,000 tokens (30 %) and 80 % of the reported window: 300,000 on 1,000,000; 160,000 on 200,000, the option standing in for the 300,000. With `--brief`, the startup prompt states the real value, so a brief's « past 300,000 » is read against it; the brief is not rewritten. A successor does not inherit its predecessor's gate: it carries one only when the option is given. Apart from the agent's 240,000 (section 65), there is no per-role default and no configuration file.

## 61. A temporary directory is cleaned once its purpose is over

The operator's order (2026-10-02): a temporary directory that is no longer useful — review done, pull request merged, or other — is cleaned automatically. Until then every cleanup was a manual step of the orchestrator's after a stand-down, and what was missed stayed: the workspaces root held checkouts of merged pull requests, the host's per-user temporary area held one directory per checkout ever used, and a reviewer's removal of its own scratch was refused twice by the host's guard on the working directory, the agent being inside it.

Who deletes what is `workspace.sh`'s header and `skills/iterm-agents/references/commands.md`; the decisions are these.

- **A checkout or a pin goes with its session, by `close`**, once the process table proves the session gone, never with `--discard`, and a refused delete never fails the close; an agent's clone (the close names `Agent:`) stays, unmarked as a rotation leaves it, since 16 of 34 returns of work within the hour found their checkout gone (audit of 2026-11-22), and the sweep ends it as it ends any, after its hour once its pull request is over; a review's pin goes. `--keep-checkout` marks the checkout kept: once its orchestrator and agent are gone, the sweep never ends it, whoever made it (a sweep once ended the clone of a dead predecessor minutes after a close that said to keep it). A rotation deletes nothing, the replacement working in the same checkout. A close of a home tab whose server runs an agent beside window 0 keeps the server for them unless `--end-agents`; a process table or pane list that cannot be read refuses and kills nothing.
- **The host's temporary directory goes with its checkout.** The host keeps one directory per working directory a session ran in, named after that path with every character that is not a letter or a digit turned into `-`. The rule was first read as « every `/` », which held on the two entries checked; the directory for a path with a dot in it showed the whole rule, so one function, `encode`, spells it for `delete`, the sweep's orphans and the live-process guard. A session's working directory is never its host directory, which is named after the directory the session STARTED in, so a host directory is in use when its name is the encoding of a live process's working directory or of any ancestor of it, or when a live process works inside it.
- **The leftovers go by `sweep`**, which decides each item on facts, the pull requests read in the machine's pull request file (`hooks/pr-file.ts`: no forge call of its own, a repository the file holds no current reading of keeping its items): a clone whose branch's pull request is merged or closed is deleted, provided the pull request is about the clone's own commit and the branch is not a long-lived one, which a pull request from a fork can share by name; a pin whose recorded pull request is over, or whose head moved off the pinned commit, is deleted; a clone with no pull request, a pin with no record, anything dirty, unpushed or in use is kept, with its reason. A host directory matching no checkout and no live process is removed; the encoded root followed by `-` alone is not enough to claim one, since it is also the name of a sibling of the root.
- **The sweep runs by itself**, at an orchestrator's passing turn end, at most once per ten minutes. A sweep that fails or overruns is logged, killed inside the deadline, and never holds a stop. No daemon, no background process, no launch agent.

The safety rule over all of it: never a dirty tree, unpushed commits, a pin whose head is on no branch of its source, or a directory a live process has as its working directory. Unpushed means a commit no remote branch holds, on a branch or on a detached head, or a stash: the branches alone see neither. A process table or a checkout git cannot read refuses every deletion instead of reading as empty or as clean and pushed. A removal first moves its directory, in one rename, into a trash beside it, then removes it there: a removal killed half way leaves its remains in the trash, never a partial checkout at its path that would read as dirty for ever. `--discard` stays the operator's word over every guard on the checkout itself, and never over the live-process guard on a host directory.

The first real dry run showed why the branch's name alone is not enough: a clone on `main` read as « the pull request of branch main is merged », a fork's own `main` having been merged once. The pin guard « head on no branch » never fired, because `git branch --contains` lists the detached head itself; it asks the refs now. And `gh pr list` lists thirty pull requests by default, so a merged one older than that read as « no pull request » and would never have been swept. The review of the delivery then measured the sweep starving inside the stop gate: the full dry run took twenty-nine seconds, most of it a list of a thousand pull requests per repository, with fifteen to spend. So the order is the trashes, then the orphans (local and cheap), then the checkouts, and a merged pull request the file no longer holds reads as « no pull request », which keeps the checkout: the safe side.

### One ledger of the checkouts, and none outlives its use

The operator's words (2026-11-18): every checkout made is written down, with its orchestrator and/or its agent, and one whose orchestrator and agent are no longer active has a reason to still be there; better still, its code is pushed so the next session starts again from git. The sweep above did not keep the root clean, and a dry run over the machine's 130 checkouts said why: it deleted only on a pull request read merged or closed about the checkout's own head. A checkout whose pull request had left the machine's file, whose branch never had one, a pin made without `--pr`, a clone with no GitHub origin were kept for ever, « no pull request » being the safe side; and `close`, the one moment that ends a checkout with its agent, refuses any commit not on a remote, so a session closed before its last push left its checkout behind too.

So the checkouts have a ledger, as the pull requests do: `<root>/.workspaces.jsonl` (`lib/workspace-ledger.ts`), a dot file in the root beside what it names, so that a suite's root carries its own ledger and never writes the operator's, one line per checkout. `create` and `pin` open the line, naming their caller (the host exports the session's id to its commands, and its registry gives that session's name); `delete` closes it into an archive with how it ended; the sweep adopts a checkout no line names and closes a line whose checkout was removed by hand.

Who lives is read, never assumed: the registry's sessions whose process answers, a registry that cannot be read ending nothing, as an unreadable process table deletes nothing. A checkout's agent is a live session started in it or below it, or one carrying the agent's name on its line; its orchestrator lives while a live session carries its name, which a successor carries too. The sweep then reads each checkout in this order: an agent working in it keeps it; in its first hour, or while its orchestrator lives, it goes as before, once its pull request is over; otherwise its use is over, and it ends the default way: `delete --push` puts every local branch holding a commit no remote branch holds on its origin under its own name, as a creation (an empty lease: a branch the origin took since the last fetch refuses it), with no hook of the checkout run, then removes it. What cannot be is kept with its reason written on its line: uncommitted changes (never committed or deleted for the agent: a file it left out of history may hold a secret), a stash, commits on a detached head, no origin to push to, a push refused, commits past a branch the origin already holds (it may carry an open pull request, whose head only its agent moves), or commits on `main`, `master`, `develop`, `trunk` or the default branch, which no sweep ever publishes. The reason is said once when first written, and the turn end logs it with each `pushed` line, so the module's log keeps the account the orchestrator, gone by then, can no longer be told.

The moments are the ones that already exist: the sweep runs at every passing stop of every orchestrator, over the whole root, so an orchestrator ended or handed over is noticed by the next stop of any other, and a pull request merged or closed wakes its orchestrator, whose stop sweeps; `close` keeps deleting what it can when it closes an agent. The figures to read later are the count of deletable directories on the first real dry run, and the workspaces root's count after a week of use.

## 62. Nobody waits on CI in the foreground: one background watch per pull request

The cause, read from an audit of another orchestration (127 session transcripts, 2026-10-02 to 2026-10-03; the audit's figures, not re-measured here): 26 % of all session-minutes (1 507 of 5 811) went to CI polling loops run until MERGED — 714 minutes by the orchestrator, 563 by its agents (37 % of their time); the five longest single waits were 67, 62, 58, 49 and 29 minutes; four agents crossed the context gate while waiting and were rotated.

What the plugin said that produced it: the agent's delivery clause watched the checks in the foreground after every push, under the rule that every command runs synchronously; the orchestrator re-read the checks at each idle notice; and the stop gate's refusal told it to « wait for the end in one call ». Each was reasonable alone; together they made waiting the default activity, and a session that waits in the foreground holds its context and its turn for nothing.

The mechanism instead: a command started with the host's `run_in_background` keeps running after the turn ends and re-invokes the session when it exits, and costs no token while it waits.

- **`ci-watch.sh <pr>` is the one way to wait** (its header documents its options, its log and owner files, and its exit codes; the rules for the orchestrator are `skills/orchestrator/references/ci-watch.md`). It never loops on `gh pr view`. A push is seen before its checks, so it waits, bounded, for checks to be registered on the head before reading « no checks » as a red. Its verdict is the github gate's (`pr-gate`, the one reading of CI, read again after each wait), never its own: the definition of « CI is still to come » is the gate's alone, the watch adds none.
- **A draft guard is not a red.** A check whose job tests the draft flag in its own definition is recognised from the job's definition (`draft-guard.ts`) and ignored while the pull request is a draft; `ignored-checks` remains the manual fallback. On another project a draft's every real job depended on its guard, so all of them were skipped and the watch said `green` with nothing run: a green now needs one passing check, and on a draft settled on its guards only a passed check whose job lists a guard in its `needs` counts, else the line is `no-checks … skipped=<n>`, which the orchestrator reads as it reads no checks.
- **Green waits for the CI run to exist.** On 2026-11-14 the watch said green for two pull requests of this repository while their `ci` run had not started: only a secret scanner had registered a check, passed, and the checks watch ended on it. The watch now goes on while the gate reads PENDING with a check running, or a required check it could not read, or a verdict about another head than the one watched, bounded; past the bound it says `no-checks`, and a gate that cannot be read is `unread`. A required context that no check ever reports keeps the gate PENDING, and the gate would not put `Ready` either.
- **A merge is not the end of the watch.** On another project the base branch's push run went red after a merge (a flaky test, green on the pull request's merge ref) and stayed red fourteen hours unseen, because the watch exited on MERGED and nothing read the run of the merged commit. So a pull request found merged is followed onto its base branch: the watch waits, bounded, for the push runs at the merge commit and watches each to its end, and with auto-merge enabled it stays on a green until the merge happens. A run cancelled there is no red, the branch's concurrency cancels it for a newer push, so the newest push run of the same workflow is followed instead; a cancelled run with no newer one is a red. A base red is read as a red: a flake or an infrastructure fault re-run once, any other red or a second one fixed at once in its own pull request — a red base branch is never left standing. `--no-base` and `--base-workflow` narrow what is followed, for a project whose slower suite should not hold the watch.
- **The orchestrator arms it** once per pull request, when one it owns is opened or its head moves; never a foreground watch, never a loop, never a wait for MERGED outside the watch.
- **An agent's delivery ends at the push**: the suite green locally on the final head, the pull request opened, the final report; it receives the kept findings until its pull request is Ready. The watch clause is gone from the agent's duties.
- **Rotation**: an agent whose remaining work is waiting on CI is never rotated, and no session is spawned to watch CI.

The script does not depend on `gh pr checks --watch`'s own code beyond zero (measured on 2.100.0 only for a pull request whose checks all passed): it reads the failing names itself when the watch is not green. The figure to read at the next audit: the CI-wait share of session time, 26 % to under 5 %.

## 63. An agent's report to the orchestrator is capped

The operator's ruling, after a trial: successions cost too much, and an orchestrator's context grows after its takeover mostly by the reports it reads. Uncapped reports measured 1,700 to 9,500 characters each, review reports the longest. A trial on three running orchestrations capped them; per one orchestration's report, 4 capped reports of 260 to 960 characters against 1,700 to 2,300 before, no follow-up question needed, nothing the artifact showed missing from them, and the « wrong or doubtful » line surfaced two points the orchestrator would not have seen. The ruling first capped every report at 12 lines / 1,000 characters; the briefs no longer carry that cap but name what the final report holds (suite counts, E2E line, image lines, deviations, doubts) and send it to a file, details in the pull request body or a file of the repository's, cited by path, and one channel for what an agent says: the end of its turn, which the module relays and holds to the verdict limit (`core/verdict.ts`), no start or per-push message. The review brief leaves its findings uncapped in number, since they are the report's substance and the orchestrator verifies each, but writes each on one line of at most 200 characters, its proposed fix in the detail file the line names.

## 64. Done is measured against the spec's goals

A build was declared done against its plan while its spec's goals 3 to 5 were not reached: the plan's « after the build » section had moved them out of the work, no dispatch-record row was opened for them, and the stop gate saw nothing open. The same plan told the orchestrator to bind the tiers in `models.json`, against the routing skill's rule that the map is the operator's, and the directive won over the rule. Prose lost both times, so both became facts a module reads.

The spec's goals live once, in `goals.md` beside the build's dispatch record, kept by `dispatch-record.sh goals` over one script, `skills/orchestrator/scripts/goals.ts` (the file's format in `lib/goals-file.ts`, the grammar's only implementation; the subcommands are its header's). A goal is `open`, `met` with evidence a local read verifies (a path that exists, a commit git resolves; a pull request or a run only beside one of those, since a stop reads no network), `ruled-out` with the operator's words, or `deferred` with his words (work he put off: it stays unmet). The declared wait (`hooks/wait.ts` `holdsRecord`) refuses a declared done while a goal is open, a `met` row's evidence is not on disk, a ruling lacks his words, or the rows are not the spec's list one for one; with every goal holding, the done passes. A record with no `goals.md` (opened before it existed), a check that fails or runs out of time, and a moved spec pass. The successor reads the goals by command at takeover, and a decision round asks every goal no phase carries.

A ruling that defers work (« later, when I say so ») has no ending of its own, and the gate's only line for open work was a question to the operator: on 2026-10-29 `waiting: operator — blocks: G5, G6 (on his word)` was relayed to the coordinator as a question and raised an alert for one that did not exist. The ruling is now a fact of the record: a row or a goal is marked deferred with his dated words, and a deferred row carries its revisit date as its blocker, so that when it comes the takeover reads the row `DEFERRED DUE` and puts it to the operator, relaunched or dropped. The ending is `waiting: deferred — <n> items`; the gate takes it when every row and goal still open is deferred and refuses it otherwise; the relay reads it as no wait, so nothing reaches the round, the coordinator, the pane or an alert.

A dispatch record belongs to one orchestration. On 2026-11-03 a deploy orchestration wrote its rows into another's record, the stop gate made it answer for that record's open rows and goals, and it ended on an operator wait that asked nothing. The first write now names the owner in `<record>.owner` (the orchestration's name without its reference, which the orchestration's id will replace without a change of format), any write from another orchestration is refused, a read registers the record only for its owner, and the declared wait skips a record that another orchestration owns. A successor that never read or wrote its record has registered none: the done gate reads the orchestration's records, its own register and every register on the machine whose record its orchestration owns (`hooks/unattended.ts` `projectRecords`), so a successor answers for the rows, goals and pull requests its predecessors opened (on 2026-11-18 one declared done with 5 rows open). A record with no owner file, every record written before this, is read as before and claimed by its first write.

The tier map's guard (`hooks/models-guard.ts`) denies a session of the orchestration a Bash line that writes `<state dir>/models.json`; a project's own `models.json` passes unless the line names the state directory. The guard stands aside while the last prompt the operator typed in that session (at the terminal or through the bridge, never a peer's delivery) names `models.json` or a tier, so a binding he asks for is never a third lock. It denies rather than asks: under auto mode an ask goes to the mode's decider, not to him.

## 65. A launched session is given a lean tool set, chosen per spawn

The host sends the schema of every loaded tool on every call. A probe of the launcher on a read-only task measured 52,243 tokens on the first call, and 32,814 once eight tools and two settings were removed, for the same answer: 19,429 tokens per call, at 0.2215 token per character of schema. Five of the tools (`Artifact`, `SendFeedback`, `Workflow`, `ScheduleWakeup`, `ReportFindings`) have hardly been called by a session of this method, `Artifact` by 23 sessions in 556 and `ScheduleWakeup` once.

The operator's rulings (2026-10-18): remove from every session the launcher opens the tools no session calls; let the coordinator choose the tools with which it opens an orchestrator or an agent, and an orchestrator those of an agent, so that no session carries every tool; and let the caller know which tools exist on the machine. So the launch passes `--disallowedTools` with the default set of the title's role, and `--keep-tool` / `--drop-tool` adjust it for one spawn (the options, the paths that honour them and the `tools` command are `skills/iterm-agents/references/commands.md`). `Artifact` is removed by name and never by the host's `enableArtifact` setting: that setting also drops the « Scratchpad directory » line from the session's environment, which every agent brief relies on.

The same launch cuts what the host adds on its own, in the `--settings` it already passes: the `<total_tokens>` reminder (its figure counts down from a budget unrelated to the gate the module measures), the account's synced skills (hidden for that invocation, moving nothing on disk, where the same key in the user's settings would trash the synced directory), and, for an `Agent:` session alone, the away recap and the silent-turn reminder: an agent is read by its orchestrator alone, while an orchestrator, an auditor and the coordinator are read by the operator, who keeps both. Two of these keys are internal to the host and undocumented, so each cut was proved by a probe on the version that ships with it, a cut that failed its probe was left out, and a launcher test keeps the keys passed; the probe is redone when the host's version changes. The host compacts where the operator's settings say; the plugin sets only the gates: agent 240,000, others 300,000, a token count that no window moves by itself. The launcher exports no percentage gate any more; the module still takes the smaller of 300,000 tokens (30 %) and 80 % of the reported window: 300,000 on 1,000,000; 160,000 on 200,000 (sections 3.4 and 60), so a model whose real window is small is gated before its token count.

The probes, their transcripts and figures are in the pull request that introduced this section.

## 66. Agents are windows of their orchestrator's home session

**The goal (G12, 2026-10-30).** Agents run as tmux windows inside their orchestrator's iTerm2 tab, the orchestrator in window 0, a tab bar with each agent's state and a key to switch; real terminals, nothing lost in reliability or interaction; the operator tests it on an unmerged branch before any merge or deployment, and a failed test stops the work (no `tmux -CC` fallback). It reversed the rule of section 48, held until then by `skills/orchestrator/references/agents.md`, the iterm-agents skill, a guard in the suite and an eval.

**The operator's need (2026-10-31).** An orchestrator tab that is always a real terminal, with its agents in sub-tabs; one way only, automatic and as fluid as before: he opens an iTerm2 tab, types the orchestrator command, and it moves into tmux by itself if needed. Never two ways of managing agents. The decisions that follow from it:

- **No home command for the operator.** At the end of the turn that names the session, the orchestrator command converts its own tab into the home session (`iterm-agent.sh home`, run by the hooks module): a tmux server of its own whose window 0 resumes the same conversation once the session has ended where it ran; the old tab is closed once the resumed host is proved running on window 0's tty. Any failure leaves the session where it is. A woken or opened orchestrator is made the same way; a successor spawned into a plain tab is converted at the end of the turn that ran its takeover, and the agents it inherited in tabs stay there.
- **One server per orchestrator tab**, with its own configuration (`skills/iterm-agents/tmux/home.conf`, which only that server reads and which leaves the operator's own tmux setup untouched): a server's death ends one orchestration and its agents, never every orchestration of the machine.
- **Agents are always windows of that session.** The switch is the caller's own session: `$TMUX` set and the home mark present means a window made without taking the operator's view; anything else (a plain tab, a tmux session made by hand) keeps the tab. A tmux that cannot answer inside a pane is a refusal naming the cause, never a silent fall to the tab. Chain entries name the window and are owned by the pane, because a pane's tty is recycled like a tab's, and every window of a server inherits the server's `ITERM_SESSION_ID`, which no longer names one session.
- **An orchestrator outside its home spawns no agent** (2026-11-10). An orchestrator that spawned in the turn that named it, before that turn's end moved it home, left three agents as tabs the move did not take. So a spawn of an agent whose caller is an orchestrator outside a home session is refused before the app is asked, saying how to get home; an operator's plain shell, the coordinator, an auditor and an agent keep their tabs. Making the agent a window of a server the move would then take was set aside: the move starts its server with window 0 and refuses one already there, and an agent's window in a server no tab shows is one the operator cannot see if the move never comes.
- **A successor is a window of the same session** and takes index 0, its agents keeping their windows. After a deploy (the operator's ruling, 2026-11-17: the new version everywhere, to test it), every live server sources the installed commit's conf as soon as an orchestrator or coordinator session sees the commit (`home-reload`; only a coordinator is also told to hand over, 2026-11-21: an orchestrator keeps its version to its context gate): the conf is all a server takes from a commit, so no server is replaced and no agent is ever moved out of its orchestrator's tab. A pause and a coordinator's close end a home session by its tab, which takes the whole server with it.
- **Closing the iTerm2 tab ends the server, the orchestrator and every agent.** The launcher's close escalates and proves it on the process table; a close by hand ends the server by the client's detach only, with no escalation and no log.
- **The auditor and the coordinator stay tabs**: they are read beside the build, and the auditor's place directly left of the orchestrator it audits has no meaning in a window bar.
- **The tab bar** (validated by the operator after his live test, 2026-11-03) shows each window's state as an icon after its name (the legend is the README's « Where agents run »). `asks` is the operator's question alone; a wait on the orchestrator shows `held`. The state is written on the window by the hooks module when it changes (`hooks/tab-state.ts`) and mapped to an icon by the status line, which polls nothing; the orchestrator's turn end adds `over` for an agent whose pull request is merged or closed (its close is owed) and the move of a delivery between `review` and `done`, the latter once every open pull request of the agent carries the `Ready` label. Each icon keeps one colour on every tab; the selected one draws it in a small dark block, since a yellow background held 7:1 only with darkened colours that read alike. Every colour pair holds 7:1, except `over` (a red glyph on the grey tab), which holds 4.5:1.

**What the study measured.** Probes in a detached server with real hosts on the subscription: rendering, input, transcript, registry, `ListAgents` and cross-session messages pass on a pane; the host draws 256-colour SGR only inside tmux; Shift-Enter submits under tmux's defaults and inserts a newline with `extended-keys always` and `csi-u`; `new-window -d` steals no focus; a pane's tty is recycled within a minute, a window id is not.

**The seam.** The launcher's tab operations sit behind one `Terminal` interface with the iTerm2 implementation and the tmux one (`ORCHESTRATOR_TMUX` names the binary, so the suite stands a recorder in for it); `tests/tmux-e2e.sh` runs the live round outside the suite, as `tests/pane-e2e.sh` does.

The stack that built it is claude-orchestrator#257 to claude-orchestrator#261; the operator's checklist for the tab bar is in the pull request that carries this section, not in the repository.

## 67. The operator's answers are read in the round, never restated

An orchestration once kept a rulings file beside its dispatch record, where each session wrote in its own words what it drew from the operator's answers, and a successor read it at takeover as his orders: it produced rules he never gave. The file and the code that kept it are gone.

What he said is written by code, not by a model: each question whole with his answer and its date in the round (`<state directory>/round/`, its `archive/` once settled over a day), his requests in his own words in the to-do list, a goal ruled out or deferred with his words in the dispatch record. A successor reads them by the item at hand, never whole (`templates/orchestrator-succession-brief.md`, « Standing context »). The takeover text itself holds to 6,000 characters of template and 9,000 filled, the steps' how in the lifecycle's « Your own context (the orchestrator is not exempt) ».

## One owner per fact: the takeover reads the state, no brief

The operator asked that no two lists of the truth be kept, since two lists drift apart and contradict each other, and that the succession need nothing but the file that already knows where everything stands. So each fact has one owner and the rest point to it: the to-do list holds his words and the dispatch rows each item turned into, never their state; a dispatch row holds the work's state, its blocker, its note of judgment, the session working it (written by the launcher at the spawn or rotation of its brief) and the verdict line of its review; the round holds his answers. Every planned item and ruling is a row from the moment it is decided. The project state file the orchestrator once kept beside its briefs, and the per-project succession brief whose « Live state » was generated from the state, were each a second list: both are gone. `succession.sh takeover` prints the plugin's fixed instructions (`templates/orchestrator-succession-brief.md`) filled from the state, never written to a file, so what is printed from the state cannot miss an item of it; its output (the open rows with their owners, the ledger's pull requests, the agents, the round's open questions, the to-do items pointing to a closed or missing row, the project sheet from `goals.md`) is `skills/orchestrator/scripts/succession.ts`'s. A row never reads its agent from its label nor from a note: the launcher writes it from the `Row:` line of the brief it launches. Session facts (ttys, checkouts, CI watches) are read live. The successor's prompt is fixed text in `commands/succeed.md`, the takeover command in it, so the launcher reads no brief and checks none.
