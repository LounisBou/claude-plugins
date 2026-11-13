# Design — correcting the method's drift: pull requests no longer go all the way

Date: 2026-11-13. Author: `Coord : general [76269c]`, after a brainstorming with the operator. Status: to be validated by the operator, then handed to `Orch: Claude plugins` as a work item of `LounisBou/claude-plugins`.

## 1. Intent and why

A pull request must go all the way. In a repository in auto-merge, it is ready and merged without waiting. Elsewhere, it is ready and waits only for the operator's review and merge: nothing is left to do on it. Today this is no longer the case.

Observed on 13 November 2026 on the claude-plugins orchestration itself:

- 18 pull requests opened since the day before, 5 merged; 15 in draft « Not Ready », 11 of them in conflict with `main`.
- 40 work items open in the register, 23 of them created that same evening from reviews (« follow-up points »).
- Almost every review marked « failed » on important but non-blocking points; the rule « review still failed after a correction: ask the operator » turns every failure into a question for the operator.
- The E2E waiver typed three times by the operator in the same evening: the tool accepts only words typed in its own session, and the orchestrator was relieved five times in about two and a half hours (from 70–90 k tokens at the start to 300 k within 25 to 35 minutes).
- Each pull request raises by itself the version of the plugin it touches (two manifests and a shared copy of code): the first one merged puts every other one of the same plugin in conflict; two red CIs came from version-raise mistakes.
- No automatic follow-up: a conflict or a red CI waits for the orchestrator to see it; eight work items stayed « waiting, nobody » until the coordinator pointed it out.

The defect is not the absence of an owner: it is that the orchestrator does not play its role. The method makes it send back to the operator decisions that are its own, and it does too much execution itself to keep the overall view.

## 2. What the operator decided

Their words, rephrased and validated by them on 13 November 2026. Each decision is given in English, then in the French in which it was validated.

1. **The orchestrator is responsible for each pull request until its merge.** It hands out the tasks and makes sure the work goes to the merge, or to « ready, waiting only for the operator » outside auto-merge. It is responsible for its agents. It is the one who answers their questions.

   > **L'orchestrateur est responsable de chaque PR jusqu'à son merge.** Il distribue les tâches et s'assure que le travail va jusqu'au merge, ou jusqu'à « prête, n'attend que l'opérateur » hors auto-merge. Il est responsable de ses agents. C'est lui qui répond à leurs questions.

2. **The design settles, the orchestrator decides.** Before a feature is launched, everything is settled in the brainstorming with the operator: design, architecture, framing. Then, for each point raised by a review, by the norms or by an agent, the orchestrator asks itself: is it critical, that is, contrary to the design or to the architecture? Yes: it has it fixed, and starts by itself a second round of correction and review if it judges it necessary. No (overcorrection, detail, style, edge case): it leaves it aside, with no follow-up point and no question.

   > **Le design tranche, l'orchestrateur décide.** Avant de lancer une fonctionnalité, tout se règle au brainstorming avec l'opérateur : design, architecture, cadrage. Ensuite, pour chaque point remonté par une relecture, des normes ou un agent, l'orchestrateur se demande : est-ce critique, c'est-à-dire contraire au design ou à l'architecture ? Oui : il fait corriger, et lance de lui-même un deuxième tour de correction et de relecture s'il le juge nécessaire. Non (surcorrection, détail, style, cas marginal) : il laisse de côté, sans point de suivi et sans question.

3. **The operator receives only the real doubts**: a point that seems critical to the orchestrator and that it cannot settle with the design. Everything else moves forward without them.

   > **L'opérateur ne reçoit que les vrais doutes** : un point qui semble critique à l'orchestrateur et qu'il ne peut pas trancher avec le design. Tout le reste avance sans lui.

4. **The verifications are decided upstream, pull request by pull request, not repository by repository.** A framing agent reads the scope of the work and sets, according to its complexity and its criticality, the necessary verifications: end-to-end test or not, norms or not, depth of the review. The operator's examples: documentation, text, translation, a small graphical change (where screenshots are enough) need no E2E; a large piece of work on a sensitive scope needs one; an E2E can also be judged counter-productive.

   > **Les vérifications se décident en amont, PR par PR, pas par dépôt.** Un agent de cadrage lit le périmètre du travail et fixe, selon sa complexité et sa criticité, les vérifications nécessaires : test de bout en bout ou non, normes ou non, profondeur de la relecture. Exemples de l'opérateur : documentation, texte, traduction, petit changement graphique (où des captures d'écran suffisent) n'ont pas besoin d'E2E ; un gros travail sur un périmètre sensible en a besoin ; un E2E peut aussi être jugé contre-productif.

5. **A waiver is asked for only to go back on a verification planned as necessary.** At the end, what was planned is applied; if a planned E2E turns out to be useless, a waiver is asked for. Never a waiver for what was not planned.

   > **Une dispense ne se demande que pour revenir sur une vérification prévue comme nécessaire.** À la fin, on applique ce qui était prévu ; si un E2E prévu s'avère inutile, on demande une dispense. Jamais de dispense pour ce qui n'était pas prévu.

6. **claude-plugins#139 is merged as it is** (decision B), the « whole repository » exemption never being used. This design relies on its `not-applicable` result and on its scope by label.

   > **claude-plugins#139 est mergée telle quelle** (décision B), l'exemption « tout le dépôt » n'étant jamais utilisée. Cette conception s'appuie sur son résultat `not-applicable` et sur sa portée par étiquette.

## 3. Objectives

- **O1 — Follow-up to the merge.** Each open pull request has, at every moment, a written and durable state: owner (the orchestrator), next step, what it is waiting for. A pull request in conflict, with a red CI or without proof is taken up again by the orchestrator without waiting to be told. No pull request stays in draft more than one day without work in progress.
- **O2 — Judgment against the design.** A review's verdict no longer blocks by itself. Each point is classed critical or not against the feature's design; only the critical ones are fixed. The others are set aside, not turned into work items. The Ready gate counts the orchestrator's decision (already made possible by claude-plugins#141 and claude-plugins#143).
- **O3 — Verification plan per pull request.** At framing, a written plan sets for the pull request: E2E required / not necessary (with its one-line reason) / replaced by desktop and mobile screenshots; norms yes/no; full review or one pass. The Ready gate reads this plan. The plan is visible in the pull request and survives relays.
- **O4 — Rare and durable waivers.** A waiver covers only a verification that the plan declared required. It is recorded durably, attached to the pull request (not to a session's words), and survives relays.
- **O5 — Questions to the operator limited to the real doubts.** The method's rules that send the orchestrator's decisions up are removed: « review failed after a correction: ask », « waiver: only the operator's words, typed in the session », « everything waits for the answer ». A pending question blocks only what it concerns (claude-plugins#137).
- **O6 — An orchestrator that holds.** It keeps the decisions and hands the execution (update on `main`, version raise, recording of proofs, CI watching, move to Ready) to agents that send it back one line. Reports reach it as a short verdict (work item 92). A relay rereads little and loses nothing (work item 93).
- **O7 — Precondition to launch.** The orchestrator does not launch a feature without its design validated by the operator; this is where the questions of substance are asked, not during the work.
- **O8 — A succession rebuilt, not written** (the operator's request). The succession does not depend on what the outgoing orchestrator thinks of writing: it is rebuilt from the durable elements already written — the state file, the pull requests in progress and their state, the agents in progress, the design, each pull request's verification plan, the operator's decisions, where the work stands. It is idempotent: rerun at any moment, from the same elements, it produces the same succession. The successor's prompt is short and only points to these elements; everything it needs is at its disposal, read on demand.
- **O9 — Prompts and context that do not grow** (the operator's request). Each addition of this design is paid for in text read by a session; it is offset or avoided. The method's rules, the agents' instructions and the relay prompt stay short: the detail lives in files read only when needed, never loaded by default. An orchestrator's context at the start of its relay does not exceed what it is today at the start, and falls if possible.

## 4. Success criteria (validated by the operator)

In two weeks:

1. Pull requests go all the way: merged in auto-merge, or ready and waiting only for the operator; none in draft more than one day without work in progress.
2. The operator is far less solicited: no more waiver to retype, no more « review failed, what do we do? »; a few real questions a day, not one an hour.
3. The work no longer swells: reviews no longer create dozens of follow-up points; the number of open work items falls.
4. The orchestrator holds: a few relays a day, no loss at the relay; a relay rebuilds itself from the written state, with a short prompt, and its starting context does not grow.
5. The data prove it: the collection of claude-plugins#132 measures the lifetime of pull requests, the number of questions, the frequency of relays and the size of sessions.

## 5. Non-objectives

- Removing verifications on critical work: the plan can require everything when the scope calls for it.
- An E2E exemption for a whole repository.
- Taking away from the operator the review and the merge in repositories that are not in auto-merge.

## 6. Anti-objectives (failure even if « it works »)

- The orchestrator declares « not necessary » everywhere to go fast: each choice of the plan carries its reason and stays visible in the pull request.
- The orchestrator sets aside a defect that is really contrary to the design.
- A relay loses a decision, a waiver or a pull request in progress.
- The operator receives more questions than before.
- The prompts, the rules or the starting context of a session grow because of this design.
- Two relays made from the same state produce different successions, or a relay depends on notes that the outgoing orchestrator forgot to write.

## 7. Constraints

- The secrets and the values of `~/.env` never leave the machine.
- The Ready gate remains the only way to Ready; auto-merge by repository remains the operator's list.
- Build on what exists or is in progress: claude-plugins#135 (proportionate reviews and tests), claude-plugins#139 (`not-applicable`, scope by label), claude-plugins#141 and claude-plugins#143 (acceptance of a failed review), claude-plugins#134 (waiver given from the supervision window), claude-plugins#137 (questions do not block), claude-plugins#132 (data collection), work items 92 (short verdicts) and 93 (light relays).

## 8. Details drawn from the conversation

- **The design is a mandatory artifact** (O7): it exists, validated by the operator, before the feature is launched, at a path that the orchestrator's brief and the agents' briefs cite. When it is silent on a point that seems critical, the orchestrator raises it to the operator (decision 3); when it is silent on a non-critical point, it decides alone.
- **Only the operator grants a waiver** (decision 5): the orchestrator asks for it, it never grants it to itself. The operator's answer, through any channel (their tab, the supervision window, the coordinator), is recorded once as a durable agreement attached to the pull request (an extension of claude-plugins#134), and not as words valid in a single session.
- **State of the work in progress on 13 November 2026, 23:30 (Paris)**: merged claude-plugins#130, claude-plugins#141, and claude-plugins#142 (into the branch of claude-plugins#139); open claude-plugins#124, claude-plugins#126, claude-plugins#128, claude-plugins#129, claude-plugins#131 to claude-plugins#140, claude-plugins#143, claude-plugins#144; work items 92 and 93 in progress at `Orch: Claude plugins`. The builder starts from the state of `main` at the moment it begins and rereads these pull requests.

## 9. Coordinator's choices, not decided by the operator (to confirm or correct)

- **How the operator learns that a framing was wrong** (question asked, left unanswered): the plan and its reason are in the pull request's description, and the operator can contest them; the data collection then links regressions to pull requests and to their plan.
- **Where the verification plan lives**: a record of the github plugin attached to the pull request (not to a commit, to survive new commits and relays) is authoritative; a section of the pull request's description and the label of claude-plugins#139 are its visible copies, rewritten from the record.
- **What the Ready gate does**: it applies the plan. A required verification with neither proof nor waiver blocks; a verification declared not necessary, with its reason, is satisfied. A pull request without a plan (existing pull requests, projects without framing) keeps today's behaviour. The orchestrator's decision to set aside a non-critical point is recorded (mechanism of claude-plugins#141), the gate does not judge it.
- **Who does the framing**: a dedicated agent, launched by the orchestrator before development, which reads the design and the scope; the orchestrator validates its plan.
- **Follow-up of blocked pull requests** (O1): it is part of the orchestrator's loop, from its state file and CI watching; each pull request's state is written in this file so that a successor takes the follow-up over without losing anything.
- **Version raises**: stop raising the version in each pull request. It is raised automatically at the merge, once, on `main`; the test that checks that the two manifests agree remains.
- **CI**: run on a pull request only the suites of the plugins it touches (today the orchestrator suite, about 8 minutes, runs on all of them); the branch protection's required checks are adapted so that a suite not launched does not block.

## 10. Left to the builder

The split into pull requests and their order, the exact form of the records and the messages, the thresholds (for example the duration after which an inactive pull request is taken up again), the content of the framing agent's instructions, and the way of rewriting the method's rules concerned (`method:lifecycle`, the orchestrator's rulebook, `orchestrator:decide`).

## 11. Amendment after the full analysis (2026-11-13) — remove first

Sources: four read-only analyses (gates in the code and the plugins, history, questions, context). The operator's principle: « by wanting to add safeguards, we do worse rather than better » — the correction removes and simplifies before it adds.

### 11.1 Established causes

1. **The cut thread.** The Ready gate requires a review, the norms check and E2E, recorded at the head commit (`plugins/github/hooks/ready.ts:578`). Only the `pr-review:auto-fix-loop` loop can write a review (`packages/core/src/pr-record.ts:22`, `register.ts:1703`); the orchestrator's review never launches it. In an orchestrated build there is no path to Ready without the operator.
2. **A moving head cancels everything.** Every correction or update on `main` cancels the three proofs, and `review.md:47` then demands a new review. `f283aef` (25 September) had settled this (one review and one correction); `97f4e07` (8 November) brought it back. Review rounds per pull request: 1.0 (claude-plugins#95 to claude-plugins#121) → 2.3 (claude-plugins#122 to claude-plugins#144).
3. **E2E without a route.** No brief records E2E; a pull request without an E2E test becomes a question (`review.md:43`, `dispatch-record.ts:674`), and the waiver accepts only words typed in the session (`register.ts:1714`): typed again 4 times for claude-plugins#123 on the 12th, 3 times on the 13th. No forged waiver has ever been observed.
4. **Rules piled up, never removed.** Code of the github hooks: 0 → 504 KB; the orchestrator's prose 70 → 297 KB (moved from SKILL.md to references and guards). 26 removals approved on 31 October, none delivered. Share of the work spent on control: 16–26 % (September) → 49 % (claude-plugins, 11–13 November).
5. **Relays too frequent that lose the answers.** 300 k reached in 23–33 min on the 13th; `pr-status` returns the raw JSON (≈ 5.8 k tokens per call, `plugins/github/engine/ghlib/pr.py:49`, +45–55 k at each resumption). 154 questions asked again by a new session, 96 of them already answered.
6. **The questions.** 1,571 from 19 October to 13 November, median answer time 85 min. 55–65 % should not have reached the operator: merge/Ready/draft in repositories in auto-merge (30 %), tooling (17 %), waivers (12 %), successions (11 %), state notes (4 %).

### 11.2 New goal O0 — reconnect the thread (before everything else)

The orchestrator's review (its readers plus its judgment, O2) writes the review record itself, and its decision to set aside a non-critical point counts as acceptance (an extension of claude-plugins#141). The rule of `f283aef` returns: one review, one correction verified by the orchestrator, no new full review. An update with no change of content keeps its proofs (claude-plugins#124). Without O0, O2–O5 stay without effect.

### 11.3 To remove (without replacement)

- G2: refusal of the Ready label set by hand (duplicate of the gate).
- G17: refusal of `not-applicable` by the session that pushed (G18 already checks the files).
- G22: obligation to reread the written files in full before writing (G21 checks the text).
- G21, second stage: the dialog to the operator after two refused texts (the first refusal stays).
- O1: refusal of a stop that asks several questions; O3: refusal beyond 5 choices or of a recommendation judged unargued; O6: refusal of a malformed machine line (replaced by `declare_wait`); O10: refusal of a stop to display the goals table.
- O21 and the E2E branch of O18: « no E2E → the operator's validation pull request by pull request » (replaced by the O3 plan).
- O22: new review demanded after the correction (back to `f283aef`).
- Deliver the 26 removals approved on 31 October that never were.

### 11.4 Carried pull request by pull request (O3 verification plan)

G1/M1 (the proofs required are those of the plan), G12 (waiver only on a planned verification, durable, attached to the pull request), G18, G25/O32 (screenshots for interface pull requests only), N5, the interface part of O18, O23 (proofs kept after a clean update).

### 11.5 Returned to the orchestrator's judgment

G20 (acceptance, no longer only on a failed review at the same commit), N6 (an open norms point can be set aside, with its reason), P4, O25, I1 (an implementer's subagent: the orchestrator decides, not a dialog to the operator), I4 (the stops of the implement skills: the orchestrator answers in an orchestrated build).

### 11.6 Kept (55)

Everything that protects the secrets, production, merge and leaving draft outside auto-merge, the shape of consent, review by another session, the core of the stop gate (O4, O5, O7, O8), the guards of interactive walkthroughs, Cloudflare and bugs-bot.

### 11.7 Context cuts

- `pr-status` returns a summary of a few lines; the full JSON only on request (`json: true`).
- `rulings.md` read by index, not in full at each resumption; it is the source of the operator's decisions that the relay takes over (end of questions asked again).
- The orchestrator opens without the tools it does not call (cloudflare, bugs-bot, norms, implement: ≈ 8.5 k tokens), through `--drop-tool`.
- Reports and briefs in files, one line in the thread (work item 92); short messages between sessions.

### 11.8 Questions that no longer go up

Merge, leaving draft and Ready in a repository in auto-merge; successions and handovers; tool workarounds (decide, note the defect, continue); state notes without a question; a question already settled in `rulings.md`.

### 11.9 Order and measure

1. O0 + the removals of 11.3 (pull requests that remove more lines than they add). 2. Compact `pr-status` and light relay. 3. Per-pull-request plan (O3) and durable waiver (O4). Each pull request states the lines of guard and of prose it removes and adds; the balance of the whole is negative. The data collection (claude-plugins#132) measures the criteria of §4 before and after.
