# Brief

Read before dispatching a row: how its brief is printed, and the tier its dispatch names.

## The brief is printed, never typed

Open the row first (`dispatch-record.sh open`, its tier and model chosen below), make its checkout (`workspace.sh create`), then print its brief:

```
<base>/scripts/brief.sh phase --record <dispatch record> --row <id> --plan <the phase's plan file> --worktree <checkout> --branch <branch> --orchestrator "<your exact ListAgents name and reference>" --out <briefs dir>/<subject>.md [--phase "<the phase's plan heading>"] [--base <ref>] [--spec <path>] [--mode build|investigate] [--scope "<what the plan does not say>"]
```

It fills `templates/agent-phase-brief.md` from the row (label, note, tier, model), the plan's phase, the spec `goals.md` names, the base's head, and writes it to `--out`; with `--phase`, a plan holding every phase is named by that section's heading and lines, and the spec by the sections it cites (`§<n>`), so the agent reads those, not both files whole. `--scope` carries only what neither the plan nor the row says; never retype the plan. Then `iterm-agent.sh spawn --brief <path> --orchestrator "<your name and reference>"` lints it and spawns the session (`references/agents.md`). A rotation runs `brief.sh rotation` (`references/rotation.md`); a review round runs `review-brief.sh`; a succession writes none, `succession.sh takeover` prints it. The path survives until the row is reviewed.

## Every dispatch names its tier

At the dispatch gate, read the agent's fill on `/orchestrator:status` against the module's gate, then choose the model/effort pair the work needs. `orchestrator:model-routing` informs, you decide.

**Route by size.** A small task (one plugin, prose or a small fix, a few files) goes to one session that writes, fixes the kept findings and merges where allowed; its review is the one pass `review-round.md` sizes by risk, the full multi-lens round being for risk alone.
