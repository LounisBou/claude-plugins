# Brief

Read before dispatching a row: how its brief is printed, and the tier its dispatch names.

## The brief is printed, never typed

Open the row first (`dispatch-record.sh open`, its tier and model chosen below), make its checkout (`workspace.sh create`), then print its brief:

```
<base>/scripts/brief.sh phase --record <dispatch record> --row <id> --plan <the phase's plan file> --worktree <checkout> --branch <branch> --orchestrator "<your exact ListAgents name and reference>" --out <briefs dir>/<subject>.md [--base <ref>] [--spec <path>] [--mode build|investigate] [--scope "<what the plan does not say>"]
```

It fills `templates/agent-phase-brief.md` from the row (label, note, tier, model), the plan's phase, the spec `goals.md` names, the base's head, and writes it to `--out`; the agent reads the spec, the plan and the sources itself. `--scope` carries only what neither the plan nor the row says; never retype the plan. Then `iterm-agent.sh spawn --brief <path> --orchestrator "<your name and reference>"` lints it and spawns the session (`references/agents.md`). A rotation fills `agent-rotation-brief.md`; a review round runs `review-brief.sh`; a succession writes none, `succession.sh takeover` prints it. The path survives until the row is reviewed.

## Every dispatch names its tier

At the dispatch gate, read the agent's fill on `/orchestrator-status` against the module's gate, then choose the model/effort pair the work needs. `orchestrator:model-routing` informs, you decide and write your choice, its reason and the reading that chose it in the brief, so the agent can say when the work outgrew it; it names the servers the session was given, so no agent reaches for a tool it lacks.

**Route by size.** A small task (one plugin, prose or a small fix, a few files) goes to one session that writes, self-reviews, fixes the kept findings and merges where allowed; its review is the one pass `review-round.md` sizes by risk, the full multi-lens round being for risk alone.
