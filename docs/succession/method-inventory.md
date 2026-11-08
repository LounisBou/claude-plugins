# Method inventory — what `method` must own (decision 0006, program goal 19)

Paths: `impl/` = plugins/implement, `orch/` = plugins/orchestrator, `orch/sk/` = plugins/orchestrator/skills/orchestrator,
`gh/` = plugins/github. Line numbers are as of this read. Quotes are trimmed to one line.

## 1. Lifecycle — the stages each plugin states

Target (docs/decisions/0006-one-method-run-in-modes.md:9-10): « spec, goals, plan, brief, implementation, review on evidence, ready, the operator's merge ».

### implement (one session, local feature lifecycle)
| Stage | Where | Quote |
|---|---|---|
| whole cycle | impl/README.md:3 | « brainstorm, branch, plan, phases, close » |
| prepare (spec+plan, no branch) | impl/skills/prepare/SKILL.md:9-12 | « the brainstorm, the codename and the bump type confirmed once, the plan written phase by phase » |
| spec = DESIGN.md (brainstorm) | impl/skills/feature/SKILL.md:95-99 | « `superpowers:brainstorming`, architectural path … this skill writes that design itself » |
| confirm (one question) | feature/SKILL.md:106-120 | « One question, asked once, carrying four proposed values » |
| branch | feature/SKILL.md:137-145 | « git checkout -b <feat-or-fix>/"$CODENAME" "$MAIN" » |
| plan | feature/SKILL.md:149-164 | « `superpowers:writing-plans` on `DESIGN.md` » |
| state | feature/SKILL.md:168-185 | « Write `docs/features/<codename>/IMPLEMENTATION.md` in this exact shape » |
| implementation, per sub-phase | phase/SKILL.md:120-146 | « Tests first … The code … The gate … The commit … The check » |
| review (same session, self-check) | phase/SKILL.md:141-146; check/SKILL.md:10-13 | « `implement:check <recorded sha>..HEAD --phase <N>` » |
| close (full gate, bump, cleanup) | close/SKILL.md:10-13 | « the project's full gate, the version bump … the removal of the local working notes » |
| after close (push/PR/merge) | close/SKILL.md:33-35; phase/SKILL.md:225-227 | « A push, a pull request (draft or ready) or a merge … carried out without asking » |
| no goals stage, no ready stage, no other-session review | — | (absent; decision 0006 wants « its review made by another session ») |

### orchestrator (supervises implementer sessions)
| Stage | Where | Quote |
|---|---|---|
| core loop | orch/sk/SKILL.md:29 | « plan → brief → launch → verify → review → terminate → replace » |
| spec + plan + goals before dispatch | orch/sk/references/briefs.md:46 | « A validated spec and a phase plan … No dispatch without both, and a `goals.md` » |
| goals | dispatch-record.sh:335 | « open: no goals.md beside $record: write the spec's goals first » |
| brief | briefs.md:5-20 | « Its parts, in order: » (8 parts) |
| launch/verify/terminate/replace | references/lifecycle.md:103-107 | « Launch. … Verify the spawn on the artifact … Terminate … Replace » |
| phase = PR | briefs.md:50 | « One agent = one phase = one draft PR, stacked on the previous phase's branch head » |
| review (other session) | review.md:53 | « Spawn a REVIEW agent (read-only on the code …) » |
| correction (N-bis) | review.md:15; briefs.md:53 | « ONE N-bis carrying the kept items and nothing else » |
| last phase = final verification | briefs.md:54 | « spec-conformity pass … every row of `goals.md` ticked on its artifact » |
| ready | review.md:17 | « Ready is the operator's turn, and the pull request stays in draft » |
| rebase after ready | review.md:43 | « `ready` is read at the verified head, BEFORE the rebase » |
| merge | orch/sk/SKILL.md:74 | « merging a pull request and taking it out of draft are his … unless … auto-merge » |
| orchestration done | orch/sk/SKILL.md:47 | « every goal in `goals.md` met or ruled out by him → waiting: done » |
| succession | lifecycle.md:129-135; commands/succeed.md:9-53 | « Succession is YOURS to trigger — do not wait for the operator, and do not ASK » |

### github / pr-review / norms (roles feeding the ready gate)
| Stage | Where | Quote |
|---|---|---|
| ready gate | gh/engine/WRITING.md:169-173; gh/README.md:138-150 | « ready when four things hold at its current head commit » |
| merge | gh/engine/WRITING.md:129-135 | « merging also need the operator's explicit word … In a repository in auto-merge … need no approval » |
| review record | plugins/pr-review/README.md:118-126 | « it leaves a review record at the pull request's head » |
| norms record | plugins/norms/README.md:67-69 | « `pass` when no finding is left open, `fail` otherwise » |

## 2. Definitions of done / ready

| # | Definition | Where | Quote |
|---|---|---|---|
| D1 | implement phase done | impl/skills/phase/SKILL.md:203; :214 | « `DONE` when every sub-phase is green and its check passed » / « NEVER mark a phase done while its check is red or its gate is untested » |
| D2 | implement check PASS | impl/skills/check/SKILL.md:179-183 | « `DONE` on a clean `PASS`, `DONE_WITH_CONCERNS` when every failing row is cosmetic » |
| D3 | implement feature closable | impl/README.md:105-106; close/SKILL.md:29 | « `/implement:close` refuses while a row is not done » |
| D4 | implement report status vocabulary | phase:200, check:180, close:228, feature:243, prepare:131 | « DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_DECISION » |
| D5 | orch principle | orch/sk/SKILL.md:14 | « « Written » and « green » are not « done » » ; « an item closes when the measurement … reads clean » |
| D6 | orch ready (prose) | orch/sk/references/review.md:17 | « implemented, nothing pending, no decision waiting … draft, review round and norms check done … E2E line settled … `ready` green at that head — and the branch rebased » |
| D7 | orch ready (code) | dispatch-record.sh:448-558 (`ready)`) | refuses: no surface; `--ui` PR with no image / no clean audit at head; no `E2E:` line; `E2E: none` without dated waiver/exempt; head ≠ reviewed or fixed head. **Warns only** (exit 0) when no review is recorded (:539-542) |
| D8 | orch build done | orch/sk/SKILL.md:47; stop-gate.ts:597 `checkWakeDone` | « every goal in `goals.md` met or ruled out by him → waiting: done » + no agent left, no open dispatch row |
| D9 | goal met | goals.py:25-36 | « `met` needs at least one token a local read verifies: a path … or `commit:<sha>` » |
| D10 | agent delivery done | orch/sk/references/briefs.md:19; templates/agent-phase-brief.md:76 | « Delivery ends at the push: the suite green locally on the final head, the pull request opened … final report » |
| D11 | github ready | gh/engine/WRITING.md:169-173; gh/hooks/ready.ts:351 `missingItems`; :410 `notReadyRefusal` | « a clean review, a passed norms check, passed E2E and green CI are all at its current head » |
| D12 | pr-review clean | plugins/pr-review/hooks/loop.ts:159 `verdict`; README.md:120-126 | « A loop stopped by the pass limit writes `pass` when the last review's agents reported nothing Critical or Important » |
| D13 | norms pass | plugins/norms/hooks/record.ts:73 `checkDone`; README.md:67-69 | « `pass` when no finding is left open » (from counts the model passes in) |
| D14 | program | docs/specs/program-design.md:18 | « Ready means done. The definition of done guarantees the work is done, done well and complete. » |

Where they differ:
- **Review head.** D11 needs a review record AT the current head; D7 accepts the « fixed » head (correction verified by the orchestrator, not re-reviewed) and, with no review recorded, only warns.
- **CI.** D11 requires green CI; D6/D7 never read CI (ci-watch is separate, review.md:41); D1-D3 have no CI at all.
- **Screenshots.** D7 refuses a `--ui` PR without audited images; D11 has no surface condition.
- **Rebase.** D6 reads ready BEFORE the rebase (review.md:43); D11: « a new commit makes the pull request not ready until the four hold again ».
- **Who reviews.** D1/D2 is a self-check in the implementing session; D11 and conventions.md:43-45 want another session (session id is in the record, `pr-record.ts:34`, but `missingItems` never compares it to the implementer).
- **Pass with findings.** D12 passes after 5 passes with Minor findings left; D11 text says « came out clean » (WRITING.md:170).
- **Goals.** Only D8 measures done against the spec's goals; implement has no goals file at all.
- **Statuses.** implement DONE/DONE_WITH_CONCERNS/BLOCKED/NEEDS_DECISION vs orchestrator agents `status: done|blocked|question` (relay.ts:66) vs goals `open|met|ruled-out|deferred` (goals.py:52) vs IMPLEMENTATION rows `todo|doing|done` (core.ts:34) vs records `pass|fail|waived` (pr-record.ts:23).

## 3. Artifact formats

| Artifact | Required sections / fields | Defined at | Enforced by |
|---|---|---|---|
| Spec (implement) `DESIGN.md` | none fixed; title from its heading | impl/skills/feature/SKILL.md:112-113, 132 | prose only |
| Spec (orchestrator) | `## Goals` numbered list; `aim:` verbatim in spec | goals.py:34-36 | code: goals.py `spec_goals` :116, `spec_aim` :140, `assess` :241 |
| goals.md | header `spec:`, `repo:`, `aim:`; table `\| id \| status \| goal (verbatim from the spec) \| plan \| evidence or ruling \|`; statuses open/met/ruled-out/deferred; ruling `operator: « … »` | goals.py:24-36, 52-56 | code: goals.py `assess` :241, `evidence_faults` :227, `ruling_of` :234, `cmd_check` :469; read by stop-gate.ts `parseGoalsCheck` :643 |
| Plan (implement) | `plan/INDEX.md` + `plan/phase-NN-<slug>.md`: sub-phases, files, tests, definition of done | impl/README.md:83-84; feature/SKILL.md:151-164 | prose (superpowers:writing-plans); only `[ -d "$DOCS/plan" ]` check/SKILL.md:74 |
| Plan (orchestrator) | per phase: scope, files, exact interface signatures, test matrix, definition of done, review focus; every figure with its command | orch/sk/references/briefs.md:46 | prose only |
| Plan header (superpowers) | « REQUIRED SUB-SKILL » header to drop | feature/SKILL.md:155-158; briefs.md:34 | prose (orch's own plans still carry it: orch/docs/plans/2026-10-07-hooks-module-plan.md:3) |
| State `IMPLEMENTATION.md` | 6 header lines `**Codename/Title/Branch/Bump/Artifacts/Base**:`; table `\| phase \| title \| status \| milestone \|`, status todo/doing/done | feature/SKILL.md:170-189; README.md:91-104 | code: impl/hooks/core.ts `parseState` :36, `markRow` :65, `nextRow` :52; bash greps close/SKILL.md:61-62 |
| ROADMAP.md line | `- <codename> — <title> (<bump>)` | prepare/SKILL.md:100 | prose |
| Phase brief | 8 sections: Required reading, Environment, Scope (deliverables, contracts verbatim, non-goals + STOP-and-ask), Method, Forbidden, Communication, Delivery, Resource envelope | briefs.md:13-20; templates/agent-phase-brief.md | code (partial): brief-lint.sh checks 1-5, 7, 9, 10, 13, 14 (:47-390) — placeholders, vars, paths, one address, non-goals, STOP-and-ask, background, post-delivery duties, CI watch, title ≤60, `Not Ready` |
| Review brief | reading, env, lenses + fixed norms lens, report shape, forbidden, communication, envelope | templates/agent-review-brief.md | brief-lint.sh check 6 :110 (`norms-check:` line) |
| Rotation (resume) brief | Required reading, State, Remaining scope, Decisions NOT reopenable, Tier, Protocol | templates/agent-rotation-brief.md:5-30; lifecycle.md:122 | brief-lint generic checks only |
| Comments / audit briefs | templates/agent-comments-brief.md, agent-audit-brief.md | same | brief-lint generic checks |
| Succession brief (orch) | Live state: 6 fields (rows, PRs, agents, rulings, open questions verbatim, next step); first-task steps 1-5; pointers (state, spec, plan, runbook, briefs, goals); ≤10,000 chars excl. open questions | templates/orchestrator-succession-brief.md:17-53; lifecycle.md:131; succeed.md:16-20 | brief-lint.sh check 11 :294 (size), 15 :327 (open-questions field), 12 :348 (predecessor close) |
| Succession brief (coordinator, auditor) | templates/coordinator-succession-brief.md, auditor-succession-brief.md | — | brief-lint generic |
| Implementer report | ≤12 lines / 1,000 chars: PR number, head SHA, suite exit + counts, `E2E:` line, deviations, « wrong or doubtful » line; last line `status: question\|blocked\|done — <one line>` | briefs.md:18; agent-phase-brief.md:66-67 | status line: relay.ts `parseStatus` :69 (STATUS_LINE :66); cap: prose only |
| E2E line | `E2E: <paths> — <command> — passed` or `E2E: none — <reason>` | review.md:37; briefs.md:31 | code: dispatch-record.sh `ready)` E2E block (:500-525) |
| Review report | one line per finding `[severity] file:line — claim — evidence — fix` (≤200 chars); rest ≤1,000 chars; last line `norms-check: tool\|none <head>` | agent-review-brief.md:40-44 | prose (+ lint that the brief asks for it) |
| Verdict message (orch → agent) | findings list, approved decisions, answers to every flagged question | review.md:47 | prose |
| implement skill report | `branch: commits: files: gate: checks: deviations: open questions: status:` | phase/SKILL.md:190-201 (same in feature:235-244, close:218-229, prepare:122-131) | prose only |
| implement check report | table `\| check \| evidence \| result \|`, 7 rows; verdict `PASS` or `FAIL: <rows>`; status | check/SKILL.md:164-183 | code: impl/hooks/core.ts `isVerdict` :393 (table header + verdict line regex :389-390) |
| Dispatch record | JSON lines; subcommands open/round/review/fixed/surface/audit/ready/exempt/close/defer/undefer/escaped/cost/summary/goals; `<record>.owner` | dispatch-record.sh:4-20, 104-111 | code: dispatch-record.sh (bash+jq) |
| PR record (github) | `{v, repo, pr, head, kind: review\|norms\|e2e, result: pass\|fail\|waived, producer, detail, session, at}` | packages/core/src/pr-record.ts:22-36 | code: core `parsePrRecord` :65, `accepts` :77 |
| PR description | summary + optional `**TODO Staging:**`, `**TODO Prod:**`, `**PRs Dependency:**`, `**Related PRs:**`; TODO items `- [ ]` | briefs.md:27 | prose |
| Screenshot audit | one line per image `<image>: clean` / `<image>: <defect>` | references/screenshot-checklist.md:13 | recorded via dispatch-record `audit` (count/defects only) |
| Decision round file | `decision-round.md`: number, title, source, status | commands/decide.md:40-42 | prose |

## 4. Question format and consent protocol

| Plugin | Mechanism | Where | Quote / shape |
|---|---|---|---|
| implement | free-text « one question », asked once, then WAIT | feature/SKILL.md:108-120; prepare/SKILL.md:76-80 | « Show the four proposed values together, in one message, and **WAIT** » |
| implement | stops: one line, wait | phase/SKILL.md:180-184 | « Each stop asks once, in one line, and waits » |
| implement | consent from prompt words (guard release) | impl/hooks/core.ts:404 `userAsked`, regexes :399-403; README.md:73-74 | `'commit': /\bcommit/i` — « the user naming the action in a prompt (`agent`, `commit`, `stage`) » |
| orchestrator | decision round: one question per message, waves | commands/decide.md:9-16, 127-129 | « never ask two things in one message » |
| orchestrator | question shape | decide.md:55-71 | `**Question i of N**`, `_Subject_ :`, `_Context_ :` (2-6 sentences), `_Question_ :`, `_Choices_ :` 2-4 `- **A** : …` with cost+gain, `_Recommendation_ : A — <reason>`, « You decide: A or B? », last line `waiting: operator — blocks: <…>` |
| orchestrator | arbitration (SKILL) | orch/sk/SKILL.md:76 | « what the thing is, two readings, what each costs, one recommendation, one at a time » |
| orchestrator | consent = order or « yes » | orch/sk/SKILL.md:20 | « only an order, or his « yes » to a proposal, authorises a change » |
| orchestrator | ruling recording | decide.md:85-97 | « Recorded: <ruling> » + durable write + `dispatch-record.sh goals … rule-out/defer --ruling "<his words, dated>"` |
| orchestrator | re-present after interruption; ruling not reopened | decide.md:104-111 | « re-present the question IN FULL » |
| orchestrator (coordinator) | relayed round | commands/coordinator-decide.md:10-41; skills/coordination/SKILL.md:213 | « Question i of N — from `<sender's exact name>` » |
| orchestrator code | parse/validate shape | hooks/round.ts `parseChoices` :66 (CHOICE :53, RECOMMENDATION :57, 2-5 letters A-E), `questionShape` :137 (FIELD :92, NUMBER :95), `questionParts` :103, `entryQuestions` :114; hooks/one-question.ts `oneQuestionRefusal` :45, `operatorWaitRefusal` :53, `asksTheOperator` :67; unanswered-question.ts `unansweredRefusal` :68 | stop gate refuses 2 blocks / an operator wait with no block |
| orchestrator code | wait declared by last line (not tool call) | hooks/stop-gate.ts `MACHINE_LINE` :146, `TOOL_LINE` :160, deferred :151 | `waiting: operator — blocks: …` / `waiting: done` / `waiting: tool — …` / `waiting: deferred — <n>` |
| orchestrator | agents' questions | agent-phase-brief.md:66 | last line `status: question\|blocked\|done — <one line>`, relayed by module |
| github, cloudflare, bugs-bot, norms, pr-review | `$.ui.ask(question, options)` permission dialogs | gh/hooks/register.ts:143, :211; plugins/cloudflare/hooks/register.ts:87, :101; plugins/bugs-bot/hooks/tool.ts:38; plugins/norms/hooks/guards.ts:62; plugins/pr-review/hooks/walkthrough.ts:65 | options `['Allow','Deny']` or `['Allow','Allow for this session','Deny']` |
| norms | `AskUserQuestion` allowed in commands | plugins/norms/commands/check.md:4, :46; learn.md:4 | « Ask no question (no `AskUserQuestion`) » in auto mode |
| norms, pr-review | consent from last prompt words | plugins/norms/hooks/guards.ts:33 `editDecision`, :71 `commitDecision`; norms/README.md:64; plugins/pr-review/hooks/policy.ts:54 `grantsEdit`, :67 `grantsResolve` | « no `git push` unless the user's last words ask for one » |
| target rule | structured consent, `declare_wait` | docs/conventions.md:39-42; decisions/0004:7-10; specs/orchestrator-refoundation-design.md:38 | « never inferred from words in a prompt » |

## 5. Contradictions and duplicates

Contradictions
1. Choices count: decide.md:65 « two to four » vs round.ts:66-70 accepts 2 to 5 (A-E).
2. Numbering line: decide.md:58 « `**Question i of N**`, alone on its line » vs coordinator-decide.md:28 / coordination/SKILL.md:213 « Question i of N — from `<sender>` » (round.ts NUMBER :95 requires the bold span to end the line: check which form parses).
3. Ready vs rebase: review.md:43 ready read « BEFORE the rebase » vs gh/engine/WRITING.md:172-173 a new commit voids ready.
4. Ready with no review: dispatch-record.sh:539-542 exits 0 with a warning vs gh ready.ts:351 `missingItems` requires a review record at head.
5. Ready at the « fixed » head (dispatch-record.sh:549-551) vs github: review record must be at current head.
6. Who writes ready records: gh/README.md:147-148 and gh/hooks/ready.ts:468 name « the orchestrator's ready » as a record producer, but dispatch-record.sh « never calls the network » (:37-38) and no orchestrator file writes `pr-records` / `mcp__github__record`.
7. Review separation: implement's check runs in the implementing session (phase/SKILL.md:141) vs conventions.md:43-45 and 0006:13 (« its review made by another session »).
8. Merge: implement phase:225-227 / close:33-35 « carried out without asking » vs orch/sk/SKILL.md:74 (operator's, unless auto-merge) and gh/engine/WRITING.md:129-131 (operator's explicit word through the tool); implement never mentions the ready gate.
9. Round counts: orch « One review round, one correction round » (review.md:15) vs implement « A `FAIL` is repaired inline and re-checked once » (phase:144-146, then BLOCKED) vs pr-review up to 5 passes (README.md:116).
10. pr-review `pass` with Minor findings left (loop.ts:163) vs WRITING.md:170 « came out clean ».
11. Brief lint: briefs.md:9 « a finding warns on stderr — the launch goes on » vs brief-lint.sh:9 exits 1 on any finding and succeed.md:25-26 « any finding is repaired before the spawn ».
12. Consent from words: core.ts:404, norms guards.ts:33/:71, pr-review policy.ts:54/:67, orch SKILL.md:20 (« his « yes » ») vs conventions.md:39-40.
13. Gate on last-line wording: stop-gate.ts:146 `MACHINE_LINE`, relay.ts:66 `STATUS_LINE` vs conventions.md:41-42 (transitional per 0004:14-15).
14. Plan header: briefs.md:34 says replace superpowers' « REQUIRED SUB-SKILL » header; orch's own plan orch/docs/plans/2026-10-07-hooks-module-plan.md:3 keeps it.
15. Stale name: gh/README.md:146 « claude-review's auto-fix-loop » (plugin is pr-review).

Duplicates
- Ready definition: gh/engine/WRITING.md:169-173, gh/README.md:138-150, gh/hooks/ready.ts:410-414 (refusal text), orch review.md:17, dispatch-record.sh header :39-95, model-routing/SKILL.md:136.
- Draft + `Not Ready` at open: briefs.md:19, :26; agent-phase-brief.md:73; review.md:19; brief-lint check 14 :376; gh/README.md:77.
- E2E rule: briefs.md:31, review.md:37, agent-phase-brief.md:47, agent-review-brief.md:34, dispatch-record.sh:84-95, gh WRITING.md:167.
- Report cap 12 lines / 1,000 chars: briefs.md:18, agent-phase-brief.md:67, agent-review-brief.md:42.
- Gate discovery (CLAUDE.md, else CONTRIBUTING.md, else tests): impl phase:125-129, check:125-130, close:90-94.
- Artifact ignore guard bash block: copied verbatim in feature:43-50, prepare:42-50, phase:57-66, close:63-72, and in core.ts `ignoreVerdict` :109.
- implement report shape: 5 copies (§3).
- Question rules: decide.md, coordinator-decide.md:10-15, orch/sk/SKILL.md:76-82, orchestrator-succession-brief.md:13, one-question.ts:13-24 (refusal texts restate the shape).
- « Written/green is not done »: orch/sk/SKILL.md:14 and review.md:7 (« Treat claimed command output as a claim »), check/SKILL.md:27-35.
- Statuses vocabularies: five sets (§2, last bullet).

## 6. Code that already checks any of this (candidates for packages/core)

TypeScript
- impl/hooks/core.ts:36 `parseState(text: string): State`; :52 `nextRow(rows: readonly Row[]): Row | null`; :57 `twoDigits(phase: string | number): string | null`; :65 `markRow(text, phase, status, milestone): { text; row } | { error }` — state/plan-progress format.
- impl/hooks/core.ts:393 `isVerdict(answer: string): boolean` — check report shape.
- impl/hooks/core.ts:109 `ignoreVerdict(mode, docsGiven, docsIgnored, roadmapIgnored): string`; :93 `modeOf(implementJson: string | null)` — artifact location policy.
- impl/hooks/core.ts:404 `userAsked(what, typed): boolean` — word-based consent (to retire, not move).
- orch/hooks/round.ts:66 `parseChoices(question)`, :103 `questionParts(question)`, :114 `entryQuestions(entry)`, :137 `questionShape(question, choices): QuestionShape | null`, :329 `asksNothing`, :336 `endsAsQuestion` — the question format parser.
- orch/hooks/one-question.ts:29 `outsideFences(message)`, :45 `oneQuestionRefusal(message): string | null`, :53 `operatorWaitRefusal(message): string | null`, :67 `asksTheOperator(message): boolean`.
- orch/hooks/unanswered-question.ts:29 `pendingQuestion(sessionId, entries, wait)`, :68 `unansweredRefusal(message, pending): string | null`.
- orch/hooks/stop-gate.ts:146 `MACHINE_LINE`, :153 `deferredIds(line)`, :169 `blocksNothing(line)`, :196 `machineLine(message)`, :597 `checkWakeDone(left): Held | null` (build done), :643 `parseGoalsCheck(path, text): GoalsReading | null`, :710 `presentGoals(readings, shown)`.
- orch/hooks/relay.ts:69 `parseStatus(answer: string): Wait | null` — agent report status line.
- orch/hooks/remote-round.ts:74 `askLine(entry, machine)`, :97 `parseAsk(body)` — question transport (orchestrator-specific; format only is method's).
- gh/hooks/ready.ts:351 `missingItems(gate: Gate, files: RecordFile[], sha?: string): string[]` — the ready definition in code; :338 `parseGate(text)`; :400 `ciUndraft(gate)`; :404 `carriesReady(gate)`; :410 `notReadyRefusal(...)`.
- packages/core/src/pr-record.ts:65 `parsePrRecord(raw: unknown): PrRecord | undefined`, :77 `accepts(record: PrRecord): boolean` — already in core.
- plugins/pr-review/hooks/loop.ts:159 `verdict(exit: string): { result; detail } | null`; plugins/pr-review/hooks/report.ts:51 `passFindings(reports)`.
- plugins/norms/hooks/record.ts:73 `checkDone($, input)` — record from model-supplied counts (program-design.md:129 defect).

Not TypeScript (would need porting per decision 0003, one rule one language)
- orch/sk/scripts/goals.py: `assess(path)` :241, `spec_goals(text)` :116, `spec_aim(text)` :140, `evidence_faults(cell, repo)` :227, `ruling_of(cell)` :234, `cmd_check` :469 — goals format and « met » rule.
- orch/sk/scripts/dispatch-record.sh: `ready)` :448 (surface, audit, E2E line, head binding), `review)` :358, `fixed)` :385, `open)` goals precondition :335, `same_commit` :284.
- orch/sk/scripts/brief-lint.sh: checks 1-15 (:47-390) — brief format; `is_class` :99 reads the role from « You are the … ».
- impl/skills/close/SKILL.md:61 bash grep « a phase is not done » (duplicates `nextRow`).
