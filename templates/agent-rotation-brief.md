# {{PROJECT}} — resume brief for Phase {{PHASE_NUMBER}}: {{PHASE_TITLE}}

You are the ROTATION agent, replacing a previous implementer whose context grew too large. Its work is on the branch; nothing you need lives in its memory. Read §1, verify §2, then continue from §3.

## 1. Required reading

The phase brief `{{PHASE_BRIEF}}` stays binding in full — reading list, environment, scope, method, forbidden list, protocol, delivery. This brief only adds state.

## 2. State — verify, do not believe

- Branch `{{BRANCH}}`, expected head `{{HEAD}}`: run `git log --oneline -5` and `git status --short`.
- Landed: {{LANDED}}
- In flight (uncommitted or unpushed — check the working tree): {{IN_FLIGHT}}
- Last gate result: {{LAST_GATE}}

## 3. Remaining scope

{{REMAINING}}

## 4. Decisions already taken — NOT reopenable

{{DECISIONS}}

## 5. Tier

You run at the **{{TIER}}** tier, chosen because {{TIER_REASON}}. Your model: {{TIER_MODEL}}, because {{TIER_MODEL_REASON}} (the operator's binding of the tier, or, where the tier is unbound, the model the orchestrator chose and its reason). {{TIER_ESCALATION}}

When this rotation is an escalation, that line names what triggered it: the finding that survived the previous round, the ambiguity two STOPs did not close, or the gate crossed without a push. Read it as scope, not as a verdict on the session you replace — and do not repeat the round it failed.

## 6. Protocol

Unchanged from the phase brief: your orchestrator is the session **`{{ORCHESTRATOR_NAME}}`** (exact `ListAgents` name and reference) and no other. Its messages carry the name alone: check the reference beside it in `ListAgents`, never refuse one for lacking it. Report to it on start and on each push, 3 lines at most. A question (one for the operator included), a blocker or the final report: end your turn on it: write it, then one last line, plain text: `status: question|blocked|done — <one line>`. The hooks module sends it to the orchestrator; never send it yourself too. The orchestrator relays a question for the operator verbatim, and his answer back verbatim. Report cap: a report is at most 12 lines / 1,000 characters: pull request number, head SHA, suite exit code and counts, deviations from this brief, and anything you saw that is wrong or doubtful — this last line is never cut to fit the cap. Details go in the pull request body or a file of the repository's, cited by path. The hooks module reports your measured context to the orchestrator at the gate and with your delivery: never read or estimate it yourself. STOP-and-ask for anything outside §3.
