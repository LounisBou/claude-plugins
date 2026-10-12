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

Unchanged from the phase brief: your orchestrator is the session **`{{ORCHESTRATOR_NAME}}`** (exact `ListAgents` name and reference) and no other. Report to it on start, on each push, on any blocker, and at the end. Report cap: every report to the orchestrator is at most 12 lines / 1,000 characters: status (done|blocked|question), pull request number, head SHA, suite exit code and counts, your context_tokens in the final report, deviations from this brief, and anything you saw that is wrong or doubtful — this last line is never cut to fit the cap. Details go in the pull request body or a file of the repository's, cited by path. Intermediate messages: 3 lines at most. Report your measured context, from your own measure file — the one JSON line the hooks module rewrites on every turn, your session id's file under `claude-orchestrator/measure/` in the host's configuration directory (`<config dir>/claude-orchestrator/measure/<session id>.json`: `printenv CLAUDE_CODE_SESSION_ID` prints the id, `printenv CLAUDE_CONFIG_DIR` the directory, `~/.claude` when it prints nothing) — as it nears the gate — 300,000 tokens (30 %) on a window of 1,000,000 tokens or more, the common case, and 80 % of a smaller window — when the orchestrator asks, and in the final report, its `context_tokens` figure with its `context_percent` figure on a window of 1,000,000 tokens or more. If it is not there, say so and give no figure: an estimate presented as a measurement is worse than an admitted gap. STOP-and-ask for anything outside §3. A question for the operator is sent to the orchestrator, never left only in your tab; it relays the question to the operator verbatim and sends the answer back verbatim.
