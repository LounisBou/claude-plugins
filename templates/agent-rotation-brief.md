# {{PROJECT}} — resume brief for Phase {{PHASE_NUMBER}}: {{PHASE_TITLE}}

You replace a previous implementer whose context grew too large. Its work is on the branch; nothing you need lives in its memory. Read §1, verify §2, then continue from §3.

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

You run at the **{{TIER}}** tier. {{TIER_ESCALATION}}

When this rotation is an escalation, that line names what triggered it: the finding that survived the previous round, the ambiguity two STOPs did not close, or the gate crossed without a push. Read it as scope, not as a verdict on the session you replace — and do not repeat the round it failed.

## 6. Protocol

Unchanged from the phase brief: your orchestrator is the session **`{{ORCHESTRATOR_NAME}}`** (exact `ListAgents` name and reference) and no other; message it first (the handshake), apply the silence rule (fifteen minutes without answer → fresh `ListAgents`, re-send to the matching NAME, else tell the user). Report to it on start (with your measured context from `{{GAUGE}}`), on each push, on any blocker, and at the end. STOP-and-ask for anything outside §3.
