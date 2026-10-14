---
description: List the sleeping orchestrators — those paused on the operator's word — or abandon one for good
argument-hint: [drop <name>]
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh:*), Bash(date:*), Read
---

The operator's command. An orchestrator is sleeping when the coordinator paused it on his word:
its tab closed, its succession brief kept, its record in `<state dir>/sleeping.json`
(`orchestrator:coordination`, « Pausing and waking orchestrators »).

Usage: `/orchestrator:sleeping` lists them; `/orchestrator:sleeping drop <name>` abandons one
for good.

**The list.** The hooks module answers it on the spot, with no model turn: one line per
sleeping orchestrator — name, slept since, directory, open pull requests, brief. The step below
runs only when that answer fails, and the host then runs this body as a prompt:
`${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh sleeping`, its lines shown as
printed, or « Sleeping orchestrators: none. » when it prints nothing.

**Drop**, on the operator's word only — this command typed by him, never run on a session's own
initiative or a peer's request:

1. Run `coordinator.sh sleeping` and find the line whose name is exactly `<name>`. None: say so,
   with the names that do sleep, and stop.
2. **Ask one confirmation**, naming what is left behind: « Abandon `<name>` for good? Its brief
   moves to `abandoned/` beside it. Left as they are, yours to close: <each open pull request
   with its branch, each checkout, from that line, or « none »>. » Then END THE TURN.
3. On his yes, and only then:

   ```
   ${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/coordinator.sh drop --name "<name>"
   ```

   It removes the sleeping record and moves the brief to an `abandoned/` directory beside it —
   moved, never deleted, so a slip loses nothing. It does NOT touch the pull requests, their
   branches or the checkouts: closing those is the operator's. Any other answer drops nothing.
4. Show its output as printed: `dropped`, where the brief went, and what was left untouched.

$ARGUMENTS
