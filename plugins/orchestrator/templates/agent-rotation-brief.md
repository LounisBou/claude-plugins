# {{PROJECT}} — resume brief for row {{ROW_ID}}: {{TITLE}}

You are the ROTATION agent, replacing an implementer whose context grew too large. Its work is on the branch; nothing you need lives in its memory.

Phase brief: `{{PHASE_BRIEF}}`, binding in full (reading, scope, rules, delivery). This brief only adds state, printed from the dispatch record and git.

## State — verify with `git log --oneline -5` and `git status --short`, do not believe

Checkout: `{{WORKTREE}}`
Branch: `{{BRANCH}}`, from `{{BASE}}`, which stood at {{BASE_HEAD}} when this brief was printed; head {{HEAD}}.
Landed since the base: {{LANDED}}
Uncommitted when printed: {{UNCOMMITTED}}
In flight, as the agent stood down said it: {{IN_FLIGHT}}
Last gate: {{LAST_GATE}}
Last report of the agent replaced: {{LAST_REPORT}}

## Remaining scope

{{REMAINING}}

## Decisions already taken — not reopenable

{{DECISIONS}}

## Tier and protocol

Tier: {{TIER}}

Your orchestrator is **`{{ORCHESTRATOR}}`**; the phase brief's communication rules hold. A question, a blocker or the final report ends your turn on one line, `status: question|blocked|done — <one line>`. The hooks module sends it to the orchestrator. The hooks module reports your measured context to the orchestrator at the gate. The final report goes to {{REPORT_PATH}}; your turn ends on `<repo>#<pr> <head7> — <verdict> — blocking: <file:line, …|none> — report: {{REPORT_PATH}}`, then the status line. STOP-and-ask for anything outside the remaining scope.
