# Rotation

## Context rotation

The module measures the gate and says when one trips; this is what you do then.

Rotation = you write a **resume prompt** (template `agent-rotation-brief.md`) for a fresh session: phase state, branch state, remaining scope, decisions already taken (marked non-reopenable), same protocol. Below the threshold, prefer REUSING the same agent session across phases, because it keeps the interfaces it built in mind and a continuation prompt costs a fraction of a cold start — « reuse » names an agent with a NEXT phase to start now; a tab kept in case is not reuse, it is the standing-by tab the lifecycle forbids. The same rule applies to you: hand over with a resume brief before degrading, and write into it the traps this session paid for, not only the state.

**Execute the rotation yourself when the platform allows it** (macOS + iTerm2): once the pre-dispatch gate trips and the resume brief is written, use the `orchestrator:iterm-agents` skill, « Safety order for a live rotation »: stand the old agent down and wait for its acknowledgment, `rotate --right-of self`, and verify the replacement in BOTH the tab list and ListAgents before calling the rotation done. Where no such tooling exists, you stop and tell the operator why.

## Your own context (the orchestrator is not exempt)

- **Staying compaction-ready** is SKILL.md's principle 10, **refreshing the state from the artifacts** its principle 4, and **measuring your own context** its principle 7.
- **When your own session lacks what the role needs** — a PATH, a credential, a tool the launch did not carry — the repair is a successor spawned with it, never a favour asked of a peer or of the operator.
