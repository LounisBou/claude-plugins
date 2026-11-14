# Rotation

## Context rotation

The module says when a gate trips; this is what you do then.

Rotation = you write a **resume prompt** (`agent-rotation-brief.md`) for a fresh session: phase state, branch state, remaining scope, decisions already taken (marked non-reopenable), same protocol. Below the threshold, prefer REUSING the same agent session across phases: it keeps the interfaces it built in mind and a continuation prompt costs a fraction of a cold start — « reuse » names an agent with a NEXT phase to start now; a tab kept in case is the standing-by tab the lifecycle forbids. The same rule applies to you: hand over with a resume brief before degrading, with the traps this session paid for, not only the state.

**Execute the rotation yourself where the platform allows** (macOS + iTerm2): once the dispatch gate trips and the resume brief is written, use the `orchestrator:iterm-agents` skill, « Safety order for a live rotation »: stand the old agent down and wait for its acknowledgment, `rotate --right-of self`, and verify the replacement in both the tab list and ListAgents before calling it done. Where no such tooling exists, stop and tell the operator why.

## Your own context (the orchestrator is not exempt)

- **Staying compaction-ready** is SKILL.md's principle 10, **refreshing the state from the artifacts** its principle 4, and **measuring your own context** its principle 7.
- **Keep your turn light**: a repository measurement, or a large file you need only a conclusion from, goes to a read-only subagent that returns it. A CI wait is one background `ci-watch.sh` per pull request, reporting its terminal state, never polled output; a long list or log is filtered to what the decision needs or read by that subagent.
- **When your own session lacks what the role needs** — a PATH, a credential, a tool the launch did not carry — the repair is a successor spawned with it, never a favour asked of a peer or the operator.
