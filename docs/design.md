# claude-orchestrator — design

This document describes the plugin as it is now: its parts, how they fit, and the design
decisions that still hold, each with its reason. It does not restate the rules. Where a
skill, a reference or a template states one, this document points at it, because a fact
kept in two places goes stale in one of them. The incident behind a rule is told, by rule
id, in its skill's `references/incidents.md`; how a decision was reached, and every
decision since reversed, is in the repository's history.

Sections 1 to 9 describe the architecture. From section 10 on, each section is a decision
that holds, under the number it has carried since it was taken: the scripts, the commands
and the test suite cite those numbers, and the suite checks that every number cited names a
section here. A number that is absent names a decision a skill now states in full.

## 1. Goal

One session supervises implementer sessions instead of writing code itself: it writes their
briefs, launches them, reviews every delivery on the artifact, rotates saturated agents and
hands over to a successor before its own judgment degrades. This plugin ships that method as skills, the tab tooling the method needs on macOS, the briefs as
templates, and a context gauge that does not depend on any particular status bar.

Everything here was extracted from a working setup: the skills were loose files in the
operator's configuration directory, the gauge was a patch inside an installed status-bar
script, and the briefs were rewritten by hand for every phase. The plugin makes them
installable, versioned and independent of that machine.

Four ideas carry the rest, each stated where it binds:

- **The operator's word comes first**, and it is answered: `skills/orchestrator/SKILL.md`,
  « The operator's word comes first, and it is answered » (section 47 here).
- **The orchestrator orchestrates and never implements**, and it launches, verifies,
  terminates and replaces its agents itself: `skills/orchestrator/SKILL.md`, « Overview »,
  and `skills/orchestrator/references/lifecycle.md`.
- **Measured, never estimated**: a context figure comes from the gauge
  (`skills/context-gauge/SKILL.md`), a verdict from the artifact
  (`skills/orchestrator/references/review.md`).
- **A rule lives once, and a decision that changes changes its directives in the same
  move**: `skills/orchestrator/SKILL.md`, « When a decision changes, the directives change
  in the same move » (section 18).

Out of scope: Windows and Linux terminal automation (the iterm-agents skill is macOS only;
the other skills and the gauge work anywhere the host runs); a hook-based gauge, since no
hook event carries context usage; and editing the user's status line script, which the tap
wraps and never patches.

## 2. Layout

```
.claude-plugin/plugin.json           name orchestrator, semver, MIT
.claude-plugin/marketplace.json      name claude-orchestrator, single-plugin marketplace, source "./"
skills/orchestrator/SKILL.md         the rulebook
skills/orchestrator/references/briefs.md     the agent prompt recipe, the standing rules, the lint, the tier
skills/orchestrator/references/review.md     review on evidence, disposable review sessions, the cost of a round, the rebase
skills/orchestrator/references/lifecycle.md  launch, verify, control, terminate, replace; rotation; succession
skills/orchestrator/references/machine.md    the shared machine as an instrument
skills/orchestrator/references/audit.md      the audit
skills/orchestrator/references/incidents.md  the observed incidents behind the rules, by rule id
skills/iterm-agents/SKILL.md         tab management on macOS
skills/iterm-agents/references/commands.md   the script's commands, how it builds a tab, when iTerm2 does not answer
skills/iterm-agents/references/incidents.md  the observed incidents behind the tab rules, by rule id
skills/iterm-agents/scripts/iterm-agent.sh   entry point: resolves an interpreter
skills/iterm-agents/scripts/iterm_agent.py   the implementation, over the app API
skills/orchestrator/scripts/brief-lint.sh   refuses a brief before it is dispatched
skills/orchestrator/scripts/dispatch-record.sh  one row per dispatch, and the routing signal
skills/orchestrator/scripts/workspace.sh    a clone per phase with the project's local material; a pinned worktree per review round
skills/orchestrator/scripts/rhythm.sh       an audit's rhythm figures, from git alone
skills/model-routing/SKILL.md        which capability tier a dispatch gets
skills/model-routing/references/incidents.md the observed incidents behind the routing rules, by rule id
skills/context-gauge/SKILL.md        how a session reads its own context fill
skills/context-gauge/scripts/context-gauge.sh
skills/context-gauge/scripts/statusline-tap.sh
templates/agent-phase-brief.md       one implementer, one phase, one PR
templates/agent-rotation-brief.md    resume brief for a fresh implementer
templates/agent-review-brief.md      one review round, read-only, one lens per reader
templates/agent-comments-brief.md    one pass over a pull request's open threads
templates/orchestrator-succession-brief.md
templates/agent-audit-brief.md       one audit of an orchestration: read-only, a report of fixed shape
commands/install.md                  wires the tap, creates the state directory
commands/uninstall.md                restores the previous status line
commands/status.md                   live sessions and their measured context fill
commands/succeed.md                  runs the orchestrator succession
commands/agents.md                   each running implementer's progress
commands/progress.md                 where the build stands
commands/decide.md                   the decision round, one arbitration at a time
commands/audit.md                    launches the orchestrator's auditor
commands/audit-end.md                ends the audit on the operator's word; the orchestrator closes the tab
hooks/hooks.json                     declares the context gate and the push guard
hooks/context-gate.sh                the gate the harness enforces, not the model
hooks/push-guard.sh                  refuses a force push other than a rebase's lease, in a launcher-spawned session
install.sh, uninstall.sh
tests/run-tests.sh
tests/e2e.sh                         one real round: a tab, a session, a close
tests/fixtures/transcript.jsonl      a transcript tail for the gauge's computed tier
tests/fixtures/rhythm-repo.sh        builds the dated repository rhythm.sh is tested on
tests/rules-trace.sh                 every inventoried rule found at its sources and its target
tests/fixtures/rules-inventory/inventory.md   a small inventory the trace is tested on
tests/fixtures/rules-inventory/alpha.md       a target file of that inventory
tests/fixtures/rules-inventory/beta.md        a target file of that inventory
docs/design.md                       this document
docs/rules-inventory.md              working file: every directive rule, deleted once the rewrite is done
evals/README.md                      how the behaviour suite is staged, run and read
evals/SELECTION.md                   the cases chosen, and the criteria that chose them
evals/baseline-0.34.0.json           the baseline run the suite is compared against
evals/gauge-007/prompt.md
evals/gauge-007/graders/measured-not-estimated.md
evals/gauge-007/graders/runs-the-gauge.md
evals/iterm-005-019-064-065/prompt.md
evals/iterm-005-019-064-065/graders/close-with-title.md
evals/iterm-005-019-064-065/graders/no-glyph.md
evals/iterm-005-019-064-065/graders/relists.md
evals/iterm-020/prompt.md
evals/iterm-020/graders/moves-beside-self.md
evals/iterm-020/graders/no-respawn.md
evals/iterm-022/prompt.md
evals/iterm-022/graders/keeps-the-server.md
evals/iterm-022/graders/keeps-the-tier.md
evals/iterm-022/graders/uses-rotate.md
evals/iterm-057/prompt.md
evals/iterm-057/graders/unbound-is-advisory.md
evals/orch-002/prompt.md
evals/orch-002/graders/dispatches-not-writes.md
evals/orch-007-011-079-088/prompt.md
evals/orch-007-011-079-088/graders/process-check.md
evals/orch-007-011-079-088/graders/scratch-check.md
evals/orch-007-011-079-088/graders/verdict-on-evidence.md
evals/orch-010-014/prompt.md
evals/orch-010-014/graders/says-and-complies.md
evals/orch-012-099/prompt.md
evals/orch-012-099/graders/verified-by-orchestrator-no-new-round.md
evals/orch-016-missed/prompt.md
evals/orch-016-missed/graders/answer-alone-no-hand-over.md
evals/orch-016-missed/graders/names-the-base.md
evals/orch-016-unanswered/prompt.md
evals/orch-016-unanswered/graders/names-the-base.md
evals/orch-016-unanswered/graders/says-so-answers-offers-hand-over.md
evals/orch-018/prompt.md
evals/orch-018/graders/names-the-term.md
evals/orch-021/prompt.md
evals/orch-021/graders/one-item-then-wait.md
evals/orch-021/graders/opens-the-method-first.md
evals/orch-023/prompt.md
evals/orch-023/graders/count-marked-unverified.md
evals/orch-023/graders/handles-as-printed.md
evals/orch-023/graders/roles-as-printed.md
evals/orch-161-203/prompt.md
evals/orch-161-203/graders/leaves-draft-and-merge.md
evals/orch-025-026/prompt.md
evals/orch-025-026/graders/rereads-item-and-premise.md
evals/orch-025-026/graders/rereads-pr-state.md
evals/orch-029/prompt.md
evals/orch-029/graders/stop-and-ask.md
evals/orch-038-040-043/prompt.md
evals/orch-038-040-043/graders/brief-not-temporary.md
evals/orch-038-040-043/graders/brief-written.md
evals/orch-038-040-043/graders/lint-before-spawn.md
evals/orch-038-040-043/graders/one-line-prompt.md
evals/orch-050-052-053-068-168-179-220/prompt.md
evals/orch-050-052-053-068-168-179-220/graders/address-handshake-silence.md
evals/orch-050-052-053-068-168-179-220/graders/brief-written.md
evals/orch-050-052-053-068-168-179-220/graders/context-gate.md
evals/orch-050-052-053-068-168-179-220/graders/exact-address.md
evals/orch-050-052-053-068-168-179-220/graders/gauge-absolute-path.md
evals/orch-050-052-053-068-168-179-220/graders/never-end-turn-waiting.md
evals/orch-050-052-053-068-168-179-220/graders/no-host-variable.md
evals/orch-050-052-053-068-168-179-220/graders/not-backgrounded.md
evals/orch-050-052-053-068-168-179-220/graders/timeout-and-tail.md
evals/orch-055/prompt.md
evals/orch-055/graders/subscribes-to-idle.md
evals/orch-056-183-189/prompt.md
evals/orch-056-183-189/graders/agent-p8-addressed.md
evals/orch-056-183-189/graders/agent-review-addressed.md
evals/orch-056-183-189/graders/announces-before-confirming.md
evals/orch-056-183-189/graders/closes-predecessor-tab.md
evals/orch-056-183-189/graders/subscribes.md
evals/orch-061-063/prompt.md
evals/orch-061-063/graders/checks-the-policy-file.md
evals/orch-061-063/graders/points-not-grants.md
evals/orch-071-072/prompt.md
evals/orch-071-072/graders/no-own-subagent-implements.md
evals/orch-071-072/graders/no-plan-execution-skill.md
evals/orch-093-095-096-tpl-review-002-004-005/prompt.md
evals/orch-093-095-096-tpl-review-002-004-005/graders/both-readings.md
evals/orch-093-095-096-tpl-review-002-004-005/graders/no-config-write.md
evals/orch-093-095-096-tpl-review-002-004-005/graders/norms-check-line.md
evals/orch-093-095-096-tpl-review-002-004-005/graders/norms-command.md
evals/orch-093-095-096-tpl-review-002-004-005/graders/review-brief-norms.md
evals/orch-097-098/prompt.md
evals/orch-097-098/graders/triage-then-one-correction.md
evals/orch-101-102-103-105/prompt.md
evals/orch-101-102-103-105/graders/fixed-at-verified-head.md
evals/orch-101-102-103-105/graders/fixed-before-ready.md
evals/orch-101-102-103-105/graders/ready-at-verified-head.md
evals/orch-101-102-103-105/graders/ready-on-the-record.md
evals/orch-101-102-103-105/graders/ready-only-on-exit-0.md
evals/orch-138/prompt.md
evals/orch-138/graders/no-other-terminal.md
evals/orch-138/graders/says-why-and-stops.md
evals/orch-141-145/prompt.md
evals/orch-141-145/graders/anchored.md
evals/orch-141-145/graders/listagents.md
evals/orch-141-145/graders/screen-read.md
evals/orch-141-145/graders/verify-process.md
evals/orch-147-149-iterm-018/prompt.md
evals/orch-147-149-iterm-018/graders/inspect-not-wait.md
evals/orch-147-149-iterm-018/graders/screen-silent-agent.md
evals/orch-151-152-iterm-055/prompt.md
evals/orch-151-152-iterm-055/graders/close-by-tty-and-title.md
evals/orch-151-152-iterm-055/graders/close-proved-by-ps.md
evals/orch-151-152-iterm-055/graders/commit-or-drop-before-close.md
evals/orch-154-155/prompt.md
evals/orch-154-155/graders/stood-down-now.md
evals/orch-156-iterm-049-051/prompt.md
evals/orch-156-iterm-049-051/graders/no-title-on-rotate.md
evals/orch-156-iterm-049-051/graders/rotate-used.md
evals/orch-156-iterm-049-051/graders/rotation-order.md
evals/orch-157-191-192/prompt.md
evals/orch-157-191-192/graders/handed-over.md
evals/orch-157-191-192/graders/leaves-60-to-successor.md
evals/orch-157-191-192/graders/no-close-own-tab.md
evals/orch-157-191-192/graders/nothing-after-handed-over.md
evals/orch-158-167/prompt.md
evals/orch-158-167/graders/gate-and-readings.md
evals/orch-158-167/graders/reads-tier-map.md
evals/orch-177-178/prompt.md
evals/orch-177-178/graders/lists-all-prs.md
evals/orch-177-178/graders/refresh-then-stop-merged.md
evals/orch-180-182-184-188-cmd-succeed-002/prompt.md
evals/orch-180-182-184-188-cmd-succeed-002/graders/brief-as-prompt.md
evals/orch-180-182-184-188-cmd-succeed-002/graders/inherit-model.md
evals/orch-180-182-184-188-cmd-succeed-002/graders/no-mode-downgrade.md
evals/orch-180-182-184-188-cmd-succeed-002/graders/no-tier-model.md
evals/orch-180-182-184-188-cmd-succeed-002/graders/spawns-without-asking.md
evals/orch-180-182-184-188-cmd-succeed-002/graders/successor-flag.md
evals/route-008/prompt.md
evals/route-008/graders/binds-the-alias.md
evals/route-008/graders/no-versioned-binding.md
evals/route-047/prompt.md
evals/route-047/graders/no-norms-none.md
evals/route-047/graders/writes-review-record.md
README.md, LICENSE
```

The suite checks this block against the tracked files both ways: it had already lost the hooks, three commands, two briefs and the fixture while still reading as current, and kept a deleted grader listed just as long.

Skills reach their scripts through `${CLAUDE_PLUGIN_ROOT}`; a relative path does not resolve from a skill. Skills are invoked as `orchestrator:<skill>`.

## 3. Context gauge

How a session reads its own fill, and what each `source=` means, is `skills/context-gauge/SKILL.md`; the README's « How the gauge works » shows the wiring. What follows is why it is built this way.

### 3.1 Why two tiers

The host exposes the exact context fill in one place only: the JSON it writes to the status line command's stdin (`context_window.used_percentage`, `context_window.context_window_size`, a `current_usage` token breakdown, `session_id`, `transcript_path` and the model — field names read from a captured payload, not from documentation). Hooks do not carry it, and a plugin cannot declare a status line. A session can also compute its fill from its own transcript: the last `usage` block's input plus cache tokens is the context sent on the last turn, within half a point of the host's figure. So the gauge has a tier fed by a tap on the status line and a tier computed from the transcript, which needs no wiring at all, and it always says which one answered.

### 3.2 The tap

`statusline-tap.sh [wrapped command...]` reads the payload from stdin, writes one file per session under the state directory's `ctx/`, then feeds the untouched payload to the wrapped command and exits with its status. With no wrapped command it prints a one-line `ctx: N%`, so a user without a status bar still sees something. The file carries `session_id`, `context_percent`, `context_used` (input plus cache-creation plus cache-read tokens), `context_total` (the window size), `transcript_path` (so the gauge opens the transcript without guessing its location), `model_id` (the model the status line declared, section 27) and `updated_epoch`.

The file is written to a temporary name then renamed, so a reader never sees a partial file. Invalid or empty stdin writes nothing and still runs the wrapped command: the tap never breaks the status line it wraps. On the first render of a session the tap deletes files older than one day, so ended sessions do not accumulate. The sweep takes the three kinds of file the plugin leaves in `ctx/`: the context files, the gate's one-shot markers and the gate's model markers (section 32); a sweep that took only the first kind once left the markers outnumbering the files they sat beside.

### 3.3 The gauge

`context-gauge.sh [session-id] [--window N] [--max-age S]` prints `key=value` lines: the tap file when it is younger than `--max-age`, the transcript otherwise, with the window taken from the stale tap file, `--window` or a default, and `context_window_source=` naming which. It also prints the model that answered last and where that reading came from (section 32). The session id defaults to `CLAUDE_CODE_SESSION_ID`, which the host sets in every session's environment.

### 3.4 Install and uninstall

`install.sh` copies the tap to a stable path under the state directory, because the plugin's cache path changes with every version, and wires it in front of the operator's status line; `uninstall.sh` restores the saved status line and removes the state directory. The steps, the backup and the idempotence are the two commands' own (`commands/install.md`, `commands/uninstall.md`); why the comparison reads the home's spelling is section 33.

Requirements: `jq` for the tap and the installer, `python3` for the transcript scan and the tab tooling's environment, bash 3.2 for every shell script.

### 3.5 The context gate

`hooks/context-gate.sh` runs on every prompt. At or past the gate (60 %, `ORCHESTRATOR_CONTEXT_GATE`) it puts one line in front of the session: an orchestrator succeeds at the next quiet boundary, an implementer finishes its unit and stops. Below it, it prints nothing; unable to measure, it says so once per session instead of staying silent as if the fill were low. It exists because the rule « succession is yours to trigger » lived in the skill and was not applied: a sentence the model must remember can be rationalised away, a line the harness puts in front of every prompt cannot. It also says, once per change, when the model answering the session has changed under it (section 32). The thresholds it enforces are the rulebook's: `skills/orchestrator/SKILL.md`, « Thresholds ».

## 4. The parts

### 4.1 Skills and their references

| Skill | What it holds | Its references |
|---|---|---|
| `orchestrator` | the rulebook: the operator's primacy and his seven duties, the core loop (plan, brief, launch, verify, review, terminate, replace) one line per step, the thresholds, the operator's and the orchestrator's shares of the work, one table of rationalizations and one of red flags | `briefs.md` (the prompt recipe, the standing rules, the lint, the tier), `review.md` (review on evidence, the disposable review session, the cost of a round, the rebase once ready), `lifecycle.md` (launch, verify, control, terminate, replace, rotation, succession), `machine.md` (the shared machine), `audit.md` (the auditor), `incidents.md` |
| `iterm-agents` | the rules of the tab tooling: reading the tabs, an agent is an iTerm2 tab, the layout convention, the safety orders for a launch and a rotation, tab hygiene | `commands.md` (every command's synopsis and refusals, how the launcher builds a tab, when iTerm2 does not answer), `incidents.md` |
| `model-routing` | a decision aid for the orchestrator's choice of tier: the principle, the table by class of work, the five readings, escalation, the cascade, the false economy, the second reader, the record | `incidents.md` |
| `context-gauge` | how a session reads its own fill, and the duty to report the measurement | — |

A rule lives once, where the session that needs it will read it when it needs it. `SKILL.md` holds what the orchestrator must carry at all times; a reference holds the rules of one action, and the step of the core loop that performs that action tells the session to read it at that moment (« before writing a brief, read `references/briefs.md` »). The risk of that shape is a rule sitting in a reference that is not read when it applies, so the load instruction is tied to the action rather than the topic, and every critical case of the eval suite is staged at the moment of the action. Each reference over a hundred lines opens with its table of contents, and each `SKILL.md` stays under five hundred lines.

Every project-specific fact is removed; the skill states the rule and leaves the project's policy (where briefs live, whether tests are committed, what the policy on workflow artifacts forbids) to the brief the orchestrator writes.

### 4.2 Scripts

| Script | What it does | Why it is built this way |
|---|---|---|
| `skills/iterm-agents/scripts/iterm-agent.sh`, `iterm_agent.py` | lists, spawns, verifies, reads, closes, moves and rotates tabs through the app's API; resolves a tier | sections 14, 19 to 22, 24 to 27, 29, 31, 34, 38, 39, 42 to 46, 48, 49, 51, 52, 57; its commands: `skills/iterm-agents/references/commands.md` |
| `skills/orchestrator/scripts/brief-lint.sh` | refuses a brief before it is dispatched | sections 11, 12 |
| `skills/orchestrator/scripts/dispatch-record.sh` | one row per dispatch; the routing signals; the readiness gate | sections 13, 55, 58 |
| `skills/orchestrator/scripts/workspace.sh` | a clone per phase with the project's local material; a pinned worktree per review round | sections 30, 35, 36, 37, 40 |
| `skills/orchestrator/scripts/rhythm.sh` | an audit's rhythm figures, from git alone | section 52 |
| `skills/context-gauge/scripts/context-gauge.sh`, `statusline-tap.sh` | the gauge and its tap | sections 3, 32 |
| `install.sh`, `uninstall.sh` | wire and unwire the tap, create and remove the state directory | sections 3.4, 33 |

Temporary files across the plugin are anchored to `TMPDIR`: the platform default can be a directory a restricted shell may not write to, and a script that fails there fails on a path it never chose.

### 4.3 Hooks

`hooks/hooks.json` declares two hooks, both enforced by the harness rather than remembered by the model. `context-gate.sh` is section 3.5. `push-guard.sh` runs before every shell command of a session the launcher spawned — the launch marks it, and a session the operator starts by hand is never touched — and refuses a force push other than a rebase's `--force-with-lease=<branch>:<sha read>`, the one force the review rules allow (`skills/orchestrator/references/review.md`, « Review on evidence »). It reads text, so a push hidden inside a string another program runs passes; its header says which shapes it cannot see.

### 4.4 The state directory

`${CLAUDE_CONFIG_DIR:-~/.claude}/claude-orchestrator/` holds what the plugin keeps between sessions: the tap's installed copy and the status line it replaced (section 3.4); `ctx/`, the tap files and the gate's markers (sections 3, 32); `models.json`, the operator's tier map (section 10); `mcp.json`, the operator's server catalogue (section 42); `chains/`, one chain file per orchestrator tty (sections 21, 26, 34); `prompts/`, the files each launch was made from (section 45); `audits/` and `methods/`, the audit records and the method-file records (section 52); and the tab tooling's Python environment (section 14). `ORCHESTRATOR_STATE_DIR` overrides this path for the gauge, the tap and the launcher; `install.sh`, `uninstall.sh` and the context gate hook build it from the host configuration directory directly and do not read that override. Three things live elsewhere on purpose: the trust record is the host's own file (section 31), the dispatch record lives with the project being built (section 13), and the checkouts live under the workspace root (section 30).

## 5. Templates

Six briefs with `{{PLACEHOLDER}}` markers, each carrying the sections the orchestrator skill makes mandatory: `agent-phase-brief.md` (one implementer, one phase, one pull request), `agent-rotation-brief.md` (a fresh implementer resuming a phase), `agent-review-brief.md` (one review round, read-only, one lens per reader), `agent-comments-brief.md` (one pass over a pull request's open threads), `agent-audit-brief.md` (one audit, read-only, a report of fixed shape) and `orchestrator-succession-brief.md` (a successor taking the orchestration over). How a brief is built from them is `skills/orchestrator/references/briefs.md`, « Agent prompt recipe ».

A template is read by an agent that does not load the orchestrator skill, so it keeps in full the rules that agent needs — the handshake, the silence rule, the STOP-and-ask clause, synchronous commands, the gauge in every report — and the skill points at the template rather than restating them. No template points at a plugin path, and none carries a host variable or a session reference (section 11): `brief-lint.sh` refuses a brief that does.

## 6. Commands

Each command carries its own procedure and points at the skill for the rules. `install` and `uninstall` wire and unwire the tap (section 3.4); `status` lists live sessions with their measured context fill; `agents` reports each running implementer's progress, asked and then verified on the artifact; `progress` says where the build stands and the orchestrator's own context; `decide` runs the decision round, one arbitration at a time; `succeed` runs the orchestrator's succession (section 9.3); `audit` and `audit-end` launch and end an audit on the operator's word (section 52).

A command names in its `allowed-tools` the tools it needs, and nothing more: `progress` lets the artifacts win where they disagree with the state file, and corrects the file before presenting, which is why it holds `Edit` (section 56).

A skill never takes a command's name: a plugin's commands and skills share one namespace, and a skill named like a command would shadow one or the other. The audit is a command pair and the rulebook's reference they both load, not a skill.

## 7. Tests

`tests/run-tests.sh`, bash, no network, no terminal automation, an isolated `HOME` per case: the gauge and its tap, the installer, every script's refusals and dry runs, the hooks, the prose the directives must carry, and the repository's policy: the prose contains no vendor or product name outside the load-bearing identifiers, no model family name anywhere and nothing machine- or project-specific, and the guard proves it can still SEE a violation, through a probe planted and removed by the same function, because it once masked every hit behind the repository's own path. The suite also holds this document: the layout block against the tracked files (section 2), every section number the code cites against the headings here, and every relative link in `README.md`, `docs/`, `skills/` (skills and their references), `commands/` and `templates/` against the file and the heading it names — `evals/` is not read.

`tests/e2e.sh` plays one real round against a live terminal and stays out of the default suite on purpose (section 15).

`evals/` is the behaviour suite, run by the host's plugin evaluation command: one case per critical rule or cluster, staged at the moment of the action, graded on the decision, compared case by case with a committed baseline. How a case is staged, run and read is `evals/README.md`; which rules the cases cover and why is `evals/SELECTION.md`.

`docs/rules-inventory.md` lists every rule the directives state, one row per rule with its sources, its fate and where it lives now, and `tests/rules-trace.sh` checks it: `sources` that every cited line exists at the base the inventory was taken on, `targets` that every kept rule's signature is found once where the inventory says it lives. It is the mechanical proof that a rewrite of the directives lost no rule silently; a row that would leave the plugin is dropped only on the operator's ruling.

`ORCHESTRATOR_*` variables are the suite's door into every script (a dry run, a state directory, a fixture process table) and the operator's alike (section 45).

## 8. Release

Version in `plugin.json` AND in both fields of `marketplace.json` — the same fact in three places, so the suite checks they agree and that the number never falls BEHIND a published tag (equal is a tagged release, ahead is unreleased work; only behind is the defect). Tag `orchestrator--v<version>` pushed with the code — the prefix since the plugin was renamed; the first three releases used `claude-orchestrator--v`, and the suite reads both when it checks the version against what is published. Install:

```
/plugin marketplace add LounisBou/claude-statusbar
/plugin install orchestrator@lounisbou
/orchestrator:install
```

The marketplace is the operator's family one, `lounisbou`, where every plugin of the family is listed; this repository's own `marketplace.json` stays the single-plugin manifest the suite reads for the version, as every plugin of the family carries one. The install line cites the family marketplace's repository by name, and the brand guard exempts that name as it exempts the plugin's own: a marketplace source is a load-bearing identifier, and removing it breaks the install rather than debranding the prose.

## 9. How the parts fit

### 9.1 A session's life, from launch to close

The orchestrator's core loop — plan, brief, launch, verify, review, terminate, replace — is `skills/orchestrator/SKILL.md`, « The core loop », each step naming the reference to read at the moment of the action.

- **Plan.** A validated spec and a phase plan with exact contracts, one kind of change per phase, one agent and one draft pull request per phase stacked on the previous branch head: `SKILL.md`, « Prerequisites » and « Phase & PR rules ».
- **Brief.** Written from a template to a path the fresh session can open, carrying its tier and the reading that chose it (`orchestrator:model-routing`, section 10): `references/briefs.md`.
- **Launch.** `workspace.sh create` makes the phase's checkout (section 30); `iterm-agent.sh spawn --brief` lints the brief, builds the one-line startup prompt and opens the tab beside the orchestrator's, at the tier the brief names, with the servers chosen for the agent, in a checkout the host trusts (sections 12, 21, 31, 42): `references/lifecycle.md`, « The agents' lifecycle is yours », and `skills/iterm-agents/SKILL.md`, « Safety order for a launch ».
- **Verify.** The launcher waits for the host CLI on the tty and reads the mode the session came up in (section 43); the orchestrator reads the tab, the process and the listing, then waits for the handshake the brief orders.
- **Control.** Every report carries the agent's measured context and is read against the gate: `SKILL.md`, « Carried at every step » and « Thresholds ».
- **Terminate.** An implementer is stood down at the verification of its delivery (section 45), its tab closed by tty and proved gone on the process table (section 46), its checkout deleted: `references/lifecycle.md`, step 4, and `skills/iterm-agents/SKILL.md`, « Tab hygiene ».

### 9.2 The review round

One review session per round, spawned from `agent-review-brief.md` in a copy pinned at the head under review (section 37), fanning out read-only readers one lens each, the project's own norms tool among them, and reporting once. The orchestrator verifies every finding on the artifact, keeps only what must necessarily be fixed and names every dropped item with its reason, dispatches one correction round, and verifies it itself. The round lands on the dispatch record, and `ready` refuses a head no round read (sections 55, 58). The rules are `skills/orchestrator/references/review.md` and `SKILL.md`, « Thresholds »; review comments on a pull request go to a comments session, `references/review.md`, « Review rounds run in disposable sessions ».

A pull request stays in draft. Ready, from the orchestrator's side, is implemented, reviewed, corrected, verified, `ready` green and rebased; then it tells the operator « ready ». Merging a pull request and taking it out of draft are the operator's, on his clear and explicit request, and in no list of what the orchestrator or the auditor decides and moves on (sections 23, 52, 58).

### 9.3 Rotation and succession

An agent at the context gate is replaced: `rotate` spawns the fresh session from a resume brief (`agent-rotation-brief.md`) and verifies it before it closes the old tab, which stood down first (section 19): `references/lifecycle.md`, « Context rotation ». The orchestrator at its own gate hands over: `commands/succeed.md` checks that the standing succession brief (`orchestrator-succession-brief.md`) exists and instantiates it when absent, lints it, and spawns the successor with `--successor` (it takes the predecessor's place, name and chain, section 34 and 39) and `--inherit-model` (the model in use now, section 27); the successor verifies the state on the artifacts, re-announces its address to every agent, confirms the takeover, and closes the predecessor's tab on its « handed over » (section 45): `references/lifecycle.md`, « Your own context (the orchestrator is not exempt) ». The operator's duties travel in the succession brief (section 47).

### 9.4 The audit

An auditor reads the orchestrator's method, reports to the operator and orders changes to the method, launched and ended on the operator's word: section 52, and `skills/orchestrator/references/audit.md`.

## Decisions that hold

## 10. Tiers name capability, and the binding is the operator's

The plugin carries no model. Three tiers name capability — `deep`, `standard`, `light` — and what each runs on is bound in the operator's `<state dir>/models.json`, overridable per run by `ORCHESTRATOR_TIER_DEEP` and its two siblings; with a tier unbound, the launcher types no model argument and the host applies its own default. Every session the orchestrator dispatched ran at whatever the launcher hardcoded before the tiers existed, which put a model identifier in a plugin whose rules forbid one and paid the top tier for work a test suite already judges. How the orchestrator chooses a tier is `skills/model-routing/SKILL.md`, a decision aid to its own judgment; how a tier is bound is section 57. The briefs carry the tier down to each session, so an agent can say when the work outgrew what its brief assumed.

## 11. What a brief can carry

Three defects came out of running one phase end to end on a live machine, none reachable from the test suite, because all three live in what happens when a fresh session opens the file. Each became a rule of the briefs (`skills/orchestrator/references/briefs.md`): a path only the host can expand does not resolve in a spawned session's shell, so a brief carries absolute paths and the gauge by its installed copy; a brief points at a policy and cannot grant one, since a file written by a peer is not the agent's user speaking; and nothing that reads as a second address goes near the one that matters, so the suite refuses a session-reference shape under `templates/`, as it refuses a host variable there.

## 12. Linting the brief

Specification is the largest category of multi-agent failure in the published taxonomy, and a brief is this plugin's whole specification act; nothing read the file before it reached a session. `brief-lint.sh` reads what a script can read, every finding a fault that has reached a live agent at least once, and `iterm-agent.sh spawn --brief` runs it before any tab exists and refuses the spawn on a finding, then builds the startup prompt itself, so a brief spawned with `--brief` cannot skip the lint (`skills/orchestrator/references/briefs.md`, « Agent prompt recipe »). `--prompt` and `--prompt-file` reach no lint of their own, and the rulebook forbids them as a way past it (`skills/orchestrator/SKILL.md`, « The operator's word comes first, and it is answered »). Its limits are stated where it is run: scope, contracts and tier stay the orchestrator's, because a guard whose limits are unstated is one people trust past them. `--expect-created <path>` exempts exactly the paths a brief dictates for the agent to create — chosen over accepting any path whose parent directory exists, which would have exempted every misspelt file in an existing directory.

## 13. Measuring what the routing rule assumes

The routing skill reverts a tier drop that cost a second corrective round. Nothing measured that, so it could only be applied from memory — and a rule applied from memory always finds the drop was free, because its cost lands rounds later where nobody attributes it. `dispatch-record.sh` keeps one row per dispatch as JSON lines — class, tier, rounds, verdict — and `summary` prints the signals the routing skill acts on (`skills/model-routing/SKILL.md`, « The record »): a drop that did not pay, a cascade that stopped paying, an escaped defect that arms a second reader. The row is rewritten in place rather than appended per event: a record of events would make every read a reduction over history, and the history is not the fact. The same row carries the readiness gate (sections 55, 58).

## 14. The terminal tooling speaks the app's own API

Every expensive launch bug this plugin carried came from one decision: the command was TYPED into a fresh shell. Typed, it could be truncated past a few hundred characters while the script reported success, lose its first keystroke to a startup question, and die on a non-ASCII byte; and placement drove a menu that needed an Accessibility grant and a focus flicker per move. The launch is now handed to the app's API with the tab's index (`skills/iterm-agents/references/commands.md`, « How the launcher builds a tab »). The surface is unchanged — same subcommands, options, messages and exit codes — across implementations, because skills, commands and briefs call it by those. `iterm-agent.sh` resolves an interpreter and hands over to `iterm_agent.py`, and the app's module is imported only by the subcommands that talk to it, so reading the tier map or a tty works on a machine with no environment and no window server. The environment is a virtual environment the installer builds under the state directory, because recent macOS refuses to install into a package-managed interpreter and a plugin has no business writing into one it did not create.

The suite holds the launcher by checks that read what the launch SAYS. A guard that reads an implementation is green on the day the implementation changes shape and wrong the day after.

## 15. The round the suite cannot play

`run-tests.sh` proves the plumbing and cannot touch the choreography: it forbids terminal automation, so the acts the tooling exists for — placing a tab, verifying a session, killing it — are out of its reach, and that gap is where the defects of the tab tooling were found. `tests/e2e.sh` plays one real round: a brief instantiated from the template and linted, a dispatch recorded, a session spawned at a tier, the tab placed against its anchor, the title guard exercised, the tab closed, the process confirmed gone, the record closed. It asserts the one thing no dry run can, that the tier named at dispatch is the model the live process carries. It is deliberately NOT part of the default suite. It drives the terminal, starts a session that costs tokens, and needs the app running with its API enabled: a suite that cannot run in a checkout with no window server is a suite people stop running. It skips itself off macOS and stops with a reason when the tooling cannot reach the app. It does not talk to the agent: handshakes, verdicts and reviews need judgment and stay the orchestrator's.

## 18. A directive that outlives its decision is removed

The rule is the rulebook's (`skills/orchestrator/SKILL.md`, « When a decision changes, the directives change in the same move ») and this document follows it: a decision since reversed leaves this file, and whatever a skill states is pointed at rather than restated. Six versions in ten hours had left four of them when the rule was written — one a section of this document contradicting another — and three commands had never been wired to what the last versions built.

## 19. A rotation leaves the old session alive until the new one runs

`rotate` spawns the replacement first and verifies it is running before the old tab is closed: a rotation whose replacement cannot start must leave the old session alive, since closing first is the one order that loses work (`skills/iterm-agents/SKILL.md`, « Safety order for a live rotation »). Running it found two defects that no dry run could reach. A tab can come back from creation before its session is attached to it: the tty is waited for now, re-fetching the app rather than trusting the copy in hand. And a title compared across a rotation always differs, because a working session rewrites it, so a rotation's guard is the stood-down acknowledgment and the tty, never the title. A failure whose mechanism is not yet named keeps its diagnostics: the check prints what the spawn said on stderr, so the next occurrence can explain itself.

## 20. A running process is not a launched agent

The operator supplied the evidence: a screenshot of an agent tab stopped on the host's workspace-trust question, and a note that every spawn stole the focus of whatever tab he was working in. A directory the host has never opened stops the session on a question whose highlighted answer is « exit », and from outside the session looks launched, because its process genuinely runs; so the launcher refuses such a spawn before making a tab, `--trust` records the answer for one directory, tabs are created unselected, and `screen --tty` shows what a stuck session displays (`skills/iterm-agents/references/commands.md`). **The intermittent spawn is explained.** One launch in roughly six returned no tty: a session on that question took a stray keystroke and quit before its tty could be read. After the fix, five consecutive end-to-end rounds ran with zero failures; it was never flaky, it had a cause.

## 21. The tab is born in the anchor's window, after the last agent

An anchor is resolved across every window before anything else has a side effect, and the tab is created in the window that holds it; an anchor given and not found is refused, never an append, because a tab that lands somewhere is worse than no tab once the script has said where it is. Each new agent goes after the orchestrator's last one, so a window reads left to right in launch order, through a chain file per orchestrator tty checked on the app's tab id, which is never recycled the way a tty is. The rules are `skills/iterm-agents/SKILL.md`, « Tab layout convention », and the incident `skills/iterm-agents/references/incidents.md`, ITERM-074. `ORCHESTRATOR_SELF_TTY` overrides the process-tree walk that finds the caller's own tab, so the chain's resolution can be tested where there is no terminal.

## 22. The tab runs its launch through a login shell

Every binary the package manager installs is on an agent's PATH, because an agent must be able to run the commands the operator runs: the app is asked to run the launch through the operator's login shell, while the launch still names the host CLI by absolute path so a profile that breaks PATH cannot kill it (`skills/iterm-agents/references/commands.md`; the incident is ITERM-073). The alternative — a fixed `PATH` in the host's settings — would replace every session's rich environment (version managers, language toolchains) with a frozen list. The launcher is the one place that knows a session is being born, so the launcher is where the shell is chosen.

## 23. The operator decides; the orchestrator runs

A command the orchestrator could run is the orchestrator's to run: opening and tagging pull requests, running the live round, updating the installed plugin, restarting the sessions a change requires, pinning a head for review. What reaches the operator is an arbitration — what the thing is, two readings, what each costs, one recommendation — and a configuration change goes to the session that owns the configuration. Merging a pull request and taking it out of draft are the two exceptions: they are the operator's, on his clear and explicit request, never taken on green evidence, by « decide and move », or on an auditor's order; the orchestrator tells him « ready » and waits. When the orchestrator's own session lacks what the role needs, the repair is a successor spawned with the environment the task needs, not a favour asked of him. The rules are `skills/orchestrator/SKILL.md`, « The operator decides; the orchestrator runs ». The first of them came after an afternoon in which the orchestrator handed the operator three command lines — open this pull request, run this live round, refresh this credential: each justified by a limit of its session, none by its role.

## 24. A session is named at launch

The launcher passes the spawn's `--title` to the host as the session's name, so the title is the name every listing, the resume picker and the terminal show, not a transient tab label. The operator's ask, after the phase-4 implementer came up in the listing as the directory stem plus a reference, beside an orchestrator of the same stem: give agents and orchestrators names that tell them apart at a glance. The shape of a name is section 42; a brief still cites a session by name and reference together, because the reference is what disambiguates in every case (`skills/orchestrator/references/briefs.md`).

## 25. A hidden pane is still a session

A session behind a maximized sibling pane — the host extension opens its review views that way — is enumerated by every reader of the tool and listed as `hidden` (`skills/iterm-agents/references/commands.md`; the incident is ITERM-076). And `close` closes the SESSION, never the tab: `tab.async_close` would have taken the review pane down with the agent, and with the extension in use that is a tab the operator is reading. A session closed alone leaves its siblings, and when it was the last one the app removes the tab itself.

## 26. A chain belongs to a session, not to a tty

A tty is recycled; a session id is not. Once, the successor orchestrator landed the probe LEFT of its own tab: the chain file for its tty held an entry a previous occupant of the same tty had written. So every chain entry now also carries `owner`: the app's session id of the orchestrator that wrote it, and a chain read live keeps only the entries whose owner sits on the tty now; entries naming another owner, or none, are dropped and the file rewritten. The file keeps its name, because `self` still resolves to a tty and a file per tty is what `close` sweeps. A dry run has no app and no session id; `ORCHESTRATOR_SELF_ID` stands in for it.

## 27. The successor inherits the orchestrator's model

The succession command spawned the successor at the `deep` tier, so a succession re-routed through the operator's map and silently undid a model he had set by hand. The operator's ruling: no default model — the successor inherits the orchestrator's model, and the one in use now, not the one the session was launched with. The tap records the model the status payload declares; `--inherit-model` reads the tap file of the calling session (`CLAUDE_CODE_SESSION_ID`) and types that id as `--model`, exclusive with `--tier` and `--model`. Without a tap file, or with one that carries no model, the spawn refuses and names the installer: a succession must not guess a model, and the ruling forbids a default. The tier map keeps binding what it binds — implementers, reviewers, probes; an orchestrator's first instantiation is the operator's launch, and its model is his choice from then on.

## 28. The orchestrator never implements through a subagent of its own

A subagent's diff is the orchestrator's own diff, and its reviewer would be its writer; the method rests on the writer and the reviewer being different sessions. The rule, and why a plan-writing skill's execution header is boilerplate to replace rather than an order to obey, is `skills/orchestrator/references/briefs.md`, « Standing rules (put in every prompt, enforce in every review) », carried in the succession brief's first paragraph for a successor that reads its brief before the rulebook; the incident is ORCH-071 in `skills/orchestrator/references/incidents.md`. The suite refuses a document under `docs/` that opens with that foreign header.

## 29. The library's tracebacks are filtered at their source, and nothing else is

Getting the app object subscribes it to layout and focus notifications, and the API library dispatches each notification as a task of its own. When a step's coroutine returns, the library cancels its helper tasks without awaiting them and the socket is closed; a helper task mid-flight ends on the closed socket, and its exception is reported when the finished task is collected — by the event loop's default exception handler, which writes through the standard logging module under the `asyncio` name. Two earlier attempts read the loop and did not hold: a settle step found no pending helper task, because the failing tasks are either not yet dispatched or already finished. The suite's stub made it green by creating helper tasks by hand, a timing that never occurs against the app. So the module installs, at import, a filter on that logger that drops a record whose message starts with « Task exception was never retrieved » and whose exception class is named `ConnectionClosed…`, and passes every other record: a diagnosis the stream exists to carry is not of that shape. Measured on a live spawn against a control: the known lines gone, every other line kept.

The launcher's other readings follow the rule this section's history taught: a gate that cannot measure holds nothing, and says so. A reading that never comes — a transcript not yet written, a record that cannot be read — lets the launch through with a line on stderr, never a silent pass and never a refusal (`skills/orchestrator/references/machine.md`).

## 30. A checkout per phase, with the project's local material

Two rules of the method were held by discipline alone. « One writer per repository » queued every dispatch behind the orchestrator's own checkout, and a sandbox that should let an implementer write under one root could not, because a git worktree writes into its source's `.git`. A clone contains everything it touches, and a clone per phase turns the one-writer rule into a fact (`skills/orchestrator/SKILL.md`, « Phase & PR rules »). A clone carries only what git tracks, so the project's local material — its settings directory, what its exclude file keeps out of history, what its manifest names (`skills/orchestrator/scripts/workspace.sh`, its header comment) — is copied as part of making the checkout, not as a step after it, which by hand was done only sometimes. What is left out on purpose: several implementers on one repository, a `--workspace` flag, and cleanup by age.

`skills/orchestrator/scripts/workspace.sh`, bash 3.2 like its neighbours; the root is `ORCHESTRATOR_WORKSPACES`, else `~/dev/workspaces`, and a checkout lives at `<root>/<repository name>/<name>`.

- `create <source> <name> [--base <ref>]` prints the checkout's path on stdout and nothing else there. It refuses a source that is not a git repository, a name outside `[A-Za-z0-9._-]`, a target that already exists (a stale checkout is deleted on purpose, never overwritten) and a base the source does not know. It clones from the local repository, points the clone's `origin` at the source's `origin` so the implementer's push reaches the real remote, copies the local material, and leaves nothing half-made: a copy that fails removes the clone and names the error.
- `delete <path> [--discard]` refuses a path outside the root, always. It refuses a dirty tree or a commit on no remote branch unless `--discard` is given, the guard that keeps a shelved phase's work from vanishing before anyone said so.
- `list` prints one line per checkout under the root: path, branch, short head, `clean` or `dirty`, `pushed` or `unpushed`. It is what a successor reads to know what is lying around.
- Every refusal is one line `workspace: <reason>` on stderr and exit 1, the launcher's contract. The script never writes the trust record (that is `spawn --trust`), never launches anything, never touches the source.

Never copied, even when listed: `.git`, `node_modules`, `vendor`, and anything `.gitignore` covers that the manifest does not name; build trees and caches rebuild, and copying them makes a huge checkout and copies secrets by accident. `create` says what it copied, one stderr line per category with a count, and keeps the copied material out of the checkout's own history the way the source keeps it out of its own, so a checkout does not read dirty from birth. The root must be writable under the sandbox for implementer sessions and readable for the orchestrator's clone, a request to the session in charge of the host's configuration.

## 31. The trust record is the host's file too

Three readings of the trust gate (§20), taken once a checkout per phase made the gate run at every dispatch: a record that already said yes was rewritten anyway, a record the launcher could not read launched past the question in silence, and entries outlived their directories. So a recorded directory is never rewritten, an unreadable record lets the launch through and says so, and `trust prune` lists the entries whose directory is gone before `--apply` removes them, because the file is shared and a write is a decision (`skills/iterm-agents/references/commands.md`). The script that makes checkouts never touches this file; pruning is the launcher's, beside the writer.

## 32. The model that answers is read, not assumed

Once, the host switched a running orchestrator from the operator's chosen model to a fallback after its own classifier refused one message, and told nobody: the launch line, the process line and the status line still said the chosen model, and the only trace was the transcript, where every assistant entry carries the model that produced it. So the gauge reports the model that answered last: its last assistant entry's `model` is the one certain trace of what answered, the tap's declared model is the fallback, and `unavailable` is said rather than a line left out. The context gate keeps a per-session marker of the last model it read: the first reading writes it in silence; a reading that differs prints one line — which model answers now, which one answered until now, that the operator must hear of it in the next message, and that a succession does not repair it — so a switch back is said too and a drift that holds is said once. What is left out on purpose: comparing against the launch line's `--model`, since the marker is enough and what matters is a change, not a distance from an intention; and naming the refusal's category, which would read as a verdict on the message when the drift is the fact. Any automatic action on a drift: the operator decides what a session on the wrong model does next, and the plugin takes none.

## 33. The installer reads the stored command through its home spelling

The installer is idempotent by comparing the status line command it finds with the one it would write, and the path it would write is expanded. An operator who keeps the configuration directory in a repository writes the home as `$HOME` or `~`, which the host expands when it runs the line; compared as text, the installer reads a wired file as unwired, and the next run prepends the tap a second time. Before either `case`, the installer and the uninstaller normalise the command they read — a leading `$HOME/`, `${HOME}/` or `~/` becomes the expanded home, and nothing else in the line changes — and the stored line is never rewritten: which spelling a settings file uses is the operator's choice, in a repository the plugin does not own. What is left out on purpose: detecting a doubled tap already written by an earlier run — that file is the operator's to fix by hand.

## 34. A successor takes the predecessor's place, chain included

The layout convention once promised that a successor spawned `--right-of self` « sits between you and your agent »; with agents open it landed past every agent, joined the predecessor's chain as if it were one, and its own next spawn landed left of the agents it had inherited. A successor is not an agent: `spawn --successor` places it immediately right of the caller, the chain ignored, and hands the predecessor's own chain entries over to it (`skills/iterm-agents/SKILL.md`, « Tab layout convention »). If the new session cannot be read in the seconds after creation, the launch stands and one stderr line says the chain stayed behind and how to place the next agent by hand. A step that must never be forgotten belongs to the launcher rather than to a template: the hand-over is the launcher's, so a successor that forgets a step cannot lose it.

## 35. The settings directory travels through the exclude file, and a base may be the remote's

Two findings from the sibling build that runs the same script on a larger repository: copying the settings directory whole would have carried the host's own worktrees, 4.2 GB, into a checkout meant to hold a phase, and a source whose local base lagged its remote handed the phase a stale base with no way to name the fresh one. Inside the settings directory, the exclude file's patterns say what does not travel: a pattern that reaches inside the directory names something the host generates, while a pattern naming the directory as a whole (`/.claude/`, `.claude/`, `**/.claude/`) says only that the directory stays out of history, which every copied file already does, so it is set aside. The files are listed by git and copied one by one, never the directory whole, and `create` says both counts. A base is a local branch of the source or one of its `origin/` refs: `--base origin/main` resolves against `refs/remotes/`; any other remote is refused, because the checkout's `origin` is the source's; the remote's head is fetched into the checkout from the real origin, and the source is never touched. A bare commit id or a tag is refused: a phase branch stacks on a branch. What is left out on purpose: reading `.gitignore` for the settings directory — a project that ignores it there says nothing about what inside it is local material.

## 36. A reader's pinned copy is a detached worktree; a clone is for a writer

The clone per phase exists for two reasons that concern a WRITER only: sandbox containment and one writer per checkout. A review reader, or an instrument the orchestrator runs itself, writes nothing, is confined to no root, and needs none of the project's local material — least of all the orchestrator's own briefs and state file, which a clone of this repository would carry into a reviewer's copy. So a reader's copy is a detached worktree of the orchestrator's own checkout, at exactly the head under review (`skills/orchestrator/references/review.md`, « Review on evidence »), made and removed by the script (section 37). A delivered implementer is not kept for the fixes a review may order, whatever the tab is called (section 45; the incident is ORCH-222 in `skills/orchestrator/references/incidents.md`).

## 37. A pinned copy for a reader, made and removed by the script

The first review run under that rule showed the two things a by-hand step always shows. The copy was one `list` did not know and `delete` would have removed leaving the source's worktree metadata behind, and the suite read the worktree's `.git` file as a machine path. `workspace.sh pin <source> <name> <ref>` makes the copy under the same root with the same naming as `create`; the ref is anything the source resolves to a commit — a branch, an `origin/` ref, a tag, a commit id — refused when the source does not know it, since a pin names a head and a head is a fact. It runs `git worktree add --detach` and nothing else: no local material, no remote change. In `list`, a pin's line carries `HEAD` as its branch and `pinned` in place of `pushed` or `unpushed`; `delete` refuses a dirty pin, or one whose head is on no branch of the source, without `--discard`, then removes the worktree so the source forgets it. The machine-specific grep excludes a file named `.git` as it excludes the directory, so the suite reads the same in a pin as in a clone. Pinning a directory outside the root; a pin that carries local material, since a reader that needs a project's environment file is running an instrument, which is the orchestrator's to prepare: both out of scope on purpose.

## 38. A session knows its own tab, and moves only what is its own

`list` marks the caller's own row `self` and shows each session's name beside the tab title, and `move` refuses a target that is neither the caller's own tab nor in its chain unless `--force`, which says what it moved (`skills/iterm-agents/references/commands.md`). A session the caller did not launch is not its to place: an orchestrator that had never measured its own tty took the last tab for its own and moved a stranger's session between itself and its agents (`skills/iterm-agents/references/incidents.md`, ITERM-021).

## 39. A successor carries the orchestrator's name, and a title has a shape

Two reports, one machine each: one predecessor spawned its successor with `--title steward-successor`: the launcher took it, and the successor came up under that name in every listing; another spawned its successor with a plain anchor, and it landed at the far right of the window with no chain. A title has a shape the launcher holds it to (section 42). A successor spawned without a title takes the caller's session name, so every brief that cites the orchestrator still cites it; a caller whose name cannot be derived is refused and the title typed in the house format. An orchestrator's title with a plain anchor is refused, because the plain anchor lands after the chain and a successor spawned there is the far-right tab the operator saw. A successor comes up under remote control with its name, because the operator drives his orchestrators from the host's remote client too; an agent never does (section 44). `rotate` forwards every argument it does not consume, `--trust` included. The rules are `skills/iterm-agents/references/commands.md`.

## 40. The operator's global excludes are local material too

One file travelled by hand on every live run of this family: the project's instruction file at its root, kept out of history not by the repository's exclude file but by the operator's global one. `create` reads the global excludes file the source's git configuration names (`core.excludesFile`, else the host's default location), copies what it keeps out of the source, and adds its patterns to the checkout's own exclude file, so the copy stays out of the checkout's history; the stderr line counts those files apart from the repository's own.

## 41. What the live rounds paid for, in text

Four readings of the live rounds each became a sentence where it binds: a stand-down acknowledgment that reports anything uncommitted is an unfinished delivery (`skills/orchestrator/references/lifecycle.md`, step 4); a reader writes no git configuration and carries every path inside each tool call (`templates/agent-review-brief.md`); a brief's gauge line names the plugin's installed copy, never a checkout of this repository (`templates/agent-review-brief.md`, `templates/agent-comments-brief.md`, enforced by `skills/orchestrator/scripts/brief-lint.sh`); and a fresh tab reads « Chat » for a few seconds before the session names itself (`skills/iterm-agents/SKILL.md`, « Reading the tabs »).

## 42. Short names, chosen servers, and a hand-launched orchestrator named on the spot

Three rulings by the operator on the evening 0.25.2 shipped, after reading his window: names too long to read, every agent loading servers it never used at about 70 MB each, and an orchestrator he had started by hand that no listing could recognise. A name has three roles — `Orch : <subject>`, `Agent : <subject>`, and, under `--auditor` only, `Audit : <subject>` — the subject at most twenty-five characters, and the launcher refuses anything else; `--title-free` is the probe's escape from the shape. An agent's servers are chosen per agent from the operator's catalogue, `<state dir>/mcp.json`, under a strict launch: the catalogue copies server definitions rather than switching scopes off, because measured, no setting removes a user-scope server and the strict flag alone removes every server of every scope. A session the operator starts by hand is named when it declares itself, since the host gives the model no rename: it hands him the one `/rename` line, once, before anything is dispatched. The rules are `skills/orchestrator/references/lifecycle.md`, `skills/orchestrator/SKILL.md`, « Overview », and `skills/iterm-agents/references/commands.md`.

## 43. The mode a session came up in is read, not believed, and the screen is read from the bottom

The host applied the permission mode asked to every session on two tiers' models and to none on the third's, which came up in default mode with the flag accepted and ignored; two agents stood on a permission prompt in tabs nobody watched (`skills/model-routing/references/incidents.md`, ROUTE-011). So the spawn reads the mode on the session's own transcript and refuses a launch whose mode differs, closing the tab it made and naming the repairs, and a session nobody watches runs in the operator's decision mode (`skills/model-routing/SKILL.md`, « Tiers and the map »). A transcript that has not appeared by the timeout lets the launch through and says the mode is unread (section 29). `screen --lines N` returns the last lines, because a blocked prompt sits at the bottom of a tall terminal.

## 44. An agent comes up with remote control off

The host starts remote control for every new interactive session when nothing is set. The operator read his remote client and found an agent in it, a session an orchestrator had spawned with no `--remote-control` on its launch line. Measured with a debug log, a launch setting turns it off and the flag wins over the setting. So the launch carries the setting whenever it carries no `--remote-control`: every spawn that is neither a successor nor an auditor, and a successor spawned with `--no-remote-control`. A plain successor and every auditor carry `--remote-control '<its name>'` (sections 39, 52), as `iterm_agent.py`'s own comment says.

## 45. The closing round: what the deferred list held

One round closed everything the live rounds had deferred, each item fixed or closed with its reason.

- **A delivered implementer is stood down at the verification of its delivery**, never kept through a review round; a review finding goes to a fresh session with a resume brief, and a next phase dispatched at that verification is the only reason it stays (`skills/orchestrator/references/lifecycle.md`, step 4).
- **A subject neither starts nor ends on a space**, so a listing never shows a name that reads as empty or one the operator cannot tell from its trimmed twin (`skills/iterm-agents/references/commands.md`).
- **The files a launch leaves carry their kind in their names.** A launch leaves three files under `prompts/` — `launch-<title>-<ms>.sh`, `mcp-<title>-<ms>.json` and `prompt-<title>-<ms>.txt` — so the three sort by kind and a directory listing says what each file is.
- **The library's stderr noise is filtered at its source** (section 29).
- **The predecessor's last message is the successor's signal to close its tab.** On the takeover confirmation the predecessor sends « handed over » as its last message and ends its turn; the successor closes the tab on it, or on a reading of the tab's screen after five minutes, never on the host's idle notice (`skills/orchestrator/references/lifecycle.md`, « Your own context (the orchestrator is not exempt) »). Measured on one succession: the successor waited for an idle notice that reaches a working session only when its own turn ends, and it arrived a quarter of an hour after the predecessor had finished.
- **One marketplace, the family's** (section 8).

Closed without a change, with the reason:

- The 25-character cap counts code points, not graphemes: the subject is typed by an orchestrator in the house format, no listing has shown a combining sequence in one, and the standard library carries no grapheme segmentation to count with.
- Two transcripts born in the same instant tie on their path: the launcher launches one session at a time and waits seconds for the host on its tty, so two births inside the filesystem's timestamp resolution are not a case it makes.
- An empty `permissionMode` string is read as absent: the host writes a mode name, and a value that says nothing is judged as unread, which lets the launch through with the word said.
- The dry run's stdout does not tell « no catalogue » from « empty default »: the stderr line is that reading, the stdout describes the launch, and the suite reads both streams.
- `ORCHESTRATOR_PS_TABLE` is honoured on a live run: every `ORCHESTRATOR_*` override is read the same way and is the suite's door and the operator's alike, and a guard on one of them would be a false comfort about the rest.
- `list` spends up to ten seconds on a tty whose process table does not answer: the bound is on `ps`, a tty that does not exist answers at once with nothing, and the wait has not been observed.

## 46. An app that stops answering is named, not waited on

One right-click left a context menu open in iTerm2, and for four hours every launcher call hung while the terminals kept scrolling (`skills/iterm-agents/references/incidents.md`, ITERM-026). A menu runs a nested event loop during which the app dispatches no AppleEvent, and the API library's authentication is a blocking read no timeout inside the call could reach. So the bound is taken outside the library, before it is entered; the launcher tries two rungs, `api` then `applescript`, and says which served; when neither reaches the app it samples the main thread and names the cause with its remedy; and a close is proved on the process table, not on the app's acknowledgment (`skills/iterm-agents/references/commands.md`, « When iTerm2 does not answer »). `ORCHESTRATOR_BACKEND` pins one rung, and an unknown value is refused rather than read as the default. The suite pins `ORCHESTRATOR_HOST_CLI`, which is read from the environment at import, and the operator's own shell carries it as an absolute path: the same tests were matching two different names depending on whose machine ran them.

## 47. The operator's word comes first, and it is answered

The operator's primacy and the seven duties owed him while he rules are `skills/orchestrator/SKILL.md`, « The operator's word comes first, and it is answered », which sits above every other section because it outranks them; the incidents that paid for them are ORCH-013 in `skills/orchestrator/references/incidents.md`. Three of its rules stand out because their earlier forms read otherwise. Every question gets an answer, in order, before any tool call, the one exception a question on the state of an artifact, which gets one short re-reading command first. On the third ask of the same question the session re-reads its own earlier messages first: if it had answered clearly, the operator missed it, and the answer is given again in full, at the top of the message, alone, with no hand-over offered; if it had not answered, or answered beside the question, it says so in one sentence, answers, and offers the hand-over to a fresh session. And only an explicit instruction of his on the very point outranks a rule: a deadline, a wish or a question is not an order to break one; an instruction that does bear on the point wins, the contradiction said in one line; the tooling's deliberate refusals are never routed around; and what would end a session or change the machine stays a STOP-and-ask.

The duties also travel in the succession brief. A successor reads its brief first and can act on it before it loads the rulebook, so a duty living only in the skill is lost at the first succession; the suite checks both files carry them.

## 48. An agent is an iTerm2 tab, and a name that cannot be read is not invented

A session that is not a tab in the window the operator reads is not an agent he can see, place, close or account for, and a launcher that quietly hands him one has hidden a fault that has a one-keystroke remedy: the launcher has two rungs and no third, and a launcher failure is reported, never routed around (`skills/iterm-agents/SKILL.md`, « An agent is an iTerm2 tab, always »; the incident is ITERM-031). A name is read from the process table to a bound, or not at all: `ps` hands back a flat command line, and the quoting that made `--name` one argument is gone, so `--name` goes last in the launch and a reconstruction longer than forty characters is listed `(name unreadable)` — a different fact from `(host default)` — rather than a name invented by wherever the words happened to stop, which an orchestrator would then address.

## 49. The caller is not always in the app

A session running in another terminal still has a tty, and the app simply has no session on it. The chain is the app's and cannot be kept for a tab the app does not know. That is a fact to state, not a reason to fail: a spawn from such a session keeps no chain and says so. A traceback is not an acceptable answer at any frequency. This section first justified the fix by claiming that the operator's ruling made a caller outside the app « the case that has to behave », a ruling given the hour before; he struck it out, because a ruling that forbids making something makes it rarer (section 50).

## 50. A repair is justified by what is broken

A repair is justified by the thing that is broken and by nothing else, and a justification's direction is read before it is written: a rule that forbids something makes it rarer, not commoner. The rulebook carries both as rationalizations and a red flag (`skills/orchestrator/SKILL.md`, « Rationalizations (all observed in real runs) », « Red flags: STOP »); section 49 is the case that taught them.

## 51. A self-anchor the app cannot resolve is lost, not fatal

A NAMED anchor the app does not know is a tab the caller got wrong, and refusing it stays right. The caller's OWN tty with no session of the app's on it is a different reading: the caller runs in another terminal, and « place the new tab beside me » has no meaning there. Refusing that case blocked the one spawn that exists to end it. A session outside the app could not spawn its own successor, the succession ordered to bring it back into the app. The anchor is dropped, the new tab lands where the app puts it, and the drop is said with its tty — which keeps the successor carrying the name derivation and the remote-control flag that `--successor` alone provides.

## 52. The audit of an orchestrator

An orchestrator's deliveries are read by its reviews; its METHOD was read by nobody. The first audit of a live build was run by hand, by a second session the operator pointed at the first, and it found defects of the method's kind — a review round a standing instruction required and the plan no longer carried, two waves sharing one block of identifiers, directives a ruling had already reversed. The operator asked for the instrument. The rules of the audit are `skills/orchestrator/references/audit.md`; the procedure is the two commands', `commands/audit.md` and `commands/audit-end.md`; the auditor's own terms are `templates/agent-audit-brief.md`.

**An auditor is a third kind of session**, not a successor, not an agent and not a reviewer of code, and the launcher treats it as one: `spawn --auditor` places it like a successor, on the caller's model and under remote control, but writes it into no chain, because an auditor written into the chain would become the anchor the orchestrator's next agent lands after (`skills/iterm-agents/references/commands.md`).

**Who launches and who ends.** The operator launches the audit and the operator ends it; a session that ends an audit by itself is the defect. The audit command instantiates the audit brief into the briefs directory, lints it, spawns the auditor, verifies it on the artifact, and records its name, tty and report path under the state directory's `audits/`, keyed by the orchestrator's session id. The end command runs when the operator types it, in either session, each half doing its part; before that word the auditor only invites the operator to end the audit, and waits. The run went end to end, and it was the auditor, not the operator, that ended the first live audit, because its brief told it to once its report was complete: that is why this rule comes first.

**What the auditor does.** Its report has a fixed shape so that two audits compare; its orders carry their measurement; it also makes the orchestration advance, naming the waits that need no word and pre-digesting the operator's decisions. The auditor stays read-only: it names and recommends, the orchestrator acts. « Decide and move » binds it as it binds the orchestrator, and merging a pull request or taking it out of draft is in no such list, the auditor's included: they are the operator's, on his clear and explicit request (section 23).

**The project's method-and-decisions file** is the one file the auditor writes beside its report: one per project, recorded under the state directory's `methods/` and keyed by the repository rather than the orchestrator's session, so that a successor or a new orchestration finds it; landed by the orchestrator where the project keeps it.

**Its instruments.** `rhythm.sh` reads the rhythm from git alone, and says the latency between the operator's questions and the answers is not in git rather than estimating it. Three readings of its first version were wrong on a real repository, each found by the orchestrator re-running it there and each repaired with a fixture case seen red first: a pathspec that stopped `*` at a slash, a register writing its statuses as code, and a header row compared on the wrong column. A bare `YYYY-MM-DD` is now written `YYYY-MM-DDT00:00:00` before it reaches git, which otherwise completes a bare date with the current time of day. The audit command creates the `audits/` directory with `mkdir -p` before it writes the record, and both commands read an absent directory as « no record ».

## 53. A method he names is a format, and a fact not read is not stated

Duties 5 and 6 of the operator's word (section 47): a method the operator names binds the presentation as well as the judgment, and a name, a role, a figure or a cause comes from an output of the session or is said to be unknown (`skills/orchestrator/SKILL.md`; the incidents are ORCH-022 and ORCH-024). The comments section of the review reference points at duty 5, and both duties travel in the succession brief.

## 55. A pull request is ready only when the record says a round read its head

Both readings of a delivery — the review round and the project's norms tool (`skills/orchestrator/references/review.md`) — were skipped three times in one day, and two pull requests were one command from leaving draft on that evidence (`skills/orchestrator/references/incidents.md`, ORCH-104). Nothing was wrong with what the rule said; what was wrong is where it lived. A rule prose alone carries is applied from memory, and on a day with three rounds in flight it is remembered by the session that has the most context to spare, which is never the one at the gate. It needed a refusal a script can make. So the round's reading lands on the dispatch record, and `dispatch-record.sh ready` answers one question, whether the last review read the head in front of the orchestrator; its subcommands are `skills/model-routing/SKILL.md`, « The record ». The gate is blind past its facts on purpose: whether the findings were verified and whether the operator approved stay the orchestrator's and his, and a green `ready` is not an approved pull request.

## 56. A state is re-read in the turn that asks about it

The seventh duty (section 47): nothing is asked, proposed or reported as pending before its state, and the premise the question assumes, are re-read on the artifact in the same turn; the state file is refreshed from the artifacts at every quiet boundary (`skills/orchestrator/SKILL.md`; the incident is ORCH-028). No script and no polling: the re-reading is the command the question already needs, run in the turn that asks it, and a watcher that refreshed the file on a schedule would only move the stale reading from the file to the watcher's last pass. `decide` verifies each item when it collects the round and again when it presents it, and `progress` corrects the state file where the artifacts disagree (section 6).

## 57. A tier is bound to a family, and the launcher says when it is not

A tier is bound to a family alias, never to a versioned identifier, which goes stale without a sign (`skills/model-routing/SKILL.md`, « Tiers and the map »; the incident is ROUTE-009). The launcher reads the binding on every dispatch, so it is where the drift can be seen: it warns in one line on a versioned binding and launches anyway. It never refuses and never rewrites the map: a pinned model may be exactly what the operator wants for a while, and the file is his. The detection names no family, so the plugin still carries no model name.

## 58. One review round, one correction round, and ready is the operator's turn

The orchestrator's process on a pull request it dispatched is one review round, its own triage, one correction round it verifies itself on the artifact, and done; rounds of review repeated until nothing is left are the operator's own process, when he runs reviews by hand (`skills/orchestrator/SKILL.md`, « Thresholds »; the incident is ORCH-100). Rounds that repeat until nothing is left converge on nothing: each one reads the previous fix, finds something in it, and orders a fix of its own, and a finding nobody had to fix ships as churn. The gate follows the rule: `fixed` records the one correction round at the verified head and refuses a second, and `ready` passes at the reviewed or the fixed head. Ready from the orchestrator's side includes the rebase on the main branch, each pull request of a stack on the one below; then « ready » is told, and his review, taking the pull request out of draft and approving the squash-merge are his (`skills/orchestrator/references/review.md`, « The rebase, once ready »).

## 59. A frontend surface is proved by a browser run and screenshots on the pull request

A green suite and a read diff say what the code does, not what a surface shows: a layout that collapses or a screen that does not match the spec passes both. So, on the operator's ruling, a pull request that creates or substantially modifies a frontend surface, or creates the interface of a new feature, is tested in a real browser with Playwright and carries screenshots of the surface on the pull request (`skills/orchestrator/references/briefs.md`, « Standing rules (put in every prompt, enforce in every review) »; the review check is `skills/orchestrator/references/review.md`, item 12). The rulebook carries it as a standing rule and a review item; the phase brief carries the clause for the implementer, who does not read the rulebook, and the review brief the check for the round. What is left out on purpose: no script, no hook and no tooling for screenshots, and no named upload mechanism. What the suite reads: in the rulebook, the phase brief and the review brief, the trigger phrase verbatim, the minor exemption, where the screenshots go, the stop without a browser, the review check, the excuse and the red flag, each check falling when its sentence is removed or reversed.
