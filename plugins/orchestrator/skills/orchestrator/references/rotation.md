# Rotation

## Context rotation

The module says when a gate trips; this is what you do then. It also tells the agent itself, which cannot read its own figure, but that line does not stand it down: a gate notice for an agent with work left gets your stand-down in the same turn, never left to its brief's gate line. It says the same when a newer version of the plugins is installed: hand over at the end of the step in progress, at once when a defect of the running version blocks you.

Rotation = a **resume brief** for a fresh session, printed from the state, never typed. The stand-down asks the agent to finish the unit in hand, stop, and answer two lines: what is in flight, the decisions taken (a message to your own agent carries no `notify_when_idle`: its reply wakes you). On its answer — or at once, with neither line, when it is gone (ended by the host or by an error) — print the brief:

```
brief.sh rotation --record <dispatch record> --row <id> --phase-brief <its phase brief> --worktree <its checkout> --orchestrator "<your name [ref]>" --tty <its tty> --title "<its title>" --out <briefs dir>/<row>-r<n>.md [--plan <plan> --phase "<heading>"] [--report <its report path>] [--in-flight "<line>"] [--decisions "<line>"]
```

It fills branch, head, the commits landed since the base, what is uncommitted, the last verdict, the plan's open items and the old report from the row and git, and says the `rotate` line to run; you neither read nor retype the brief, the launcher lints it. Below the threshold, prefer REUSING the same agent session across phases: it keeps the interfaces it built in mind and a continuation prompt costs a fraction of a cold start — « reuse » names an agent with a NEXT phase to start now; a tab kept in case is a forbidden standing-by tab. The same rule applies to you: hand over before degrading.

**Execute the rotation yourself where the platform allows** (macOS + iTerm2): run the `rotate` line `brief.sh rotation` printed, `rotate --old-tty <tty> --dir <checkout> --title "<title>" --brief <path> --orchestrator "<name [ref]>" --right-of self`, its lines the proof, after the agent stood down (« Safety order for a live rotation » of `orchestrator:iterm-agents`). Without such tooling, stop and say why.

## An agent the host stopped

`[module] <agent> stopped: …` (the host's limit text, or an API error) means the host ended the agent's turn itself: it sits idle and answers nothing until the reset, whatever it had running. Do not wait on its reply: rotate it onto a fresh session from its pushed branch, on its own tier (never a lower one), its resume brief written by you from the branch, the pull request and the dispatch record, since it cannot write one. An API error that leaves its tab answering: send it one prompt to resume first.

## Your own context (the orchestrator is not exempt)

- SKILL.md's principles: 10 stay compaction-ready, 4 refresh the state from the artifacts, 7 measure your own context.
- **Keep your turn light**: a repository measurement, or a large file you need only a conclusion from, goes to a read-only subagent that returns it. A CI wait is one background `ci-watch.sh` per pull request, reporting its terminal state, never polled output; a long list or log is filtered to what the decision needs.
- **When your own session lacks what the role needs** — a PATH, a credential, a tool the launch did not carry — the repair is a successor spawned with it, never a favour asked of a peer or the operator.
