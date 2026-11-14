// hooks/agent-stop.ts
// The stop of an agent's turn, told what to end on. Its orchestrator is reported the turn's
// end (relay.ts), but nothing told the agent itself: a turn that waited on its own background
// work ended on no status line and was reported again each time, and a turn that said it waited
// on work that was not running woke nobody. The host's own list of the session's tasks decides:
// pure on purpose, the handler in guards.ts passes the stop's facts in.
import { parseStatus } from './relay.ts'

// The tasks named in the nudge, each cut, so a long command never crowds the line.
const NAMED = 3
const NAME_CAP = 80

function named(tasks: readonly string[]): string {
  const shown = tasks.slice(0, NAMED).map(t => (t.length > NAME_CAP ? `${t.slice(0, NAME_CAP)}…` : t))
  return tasks.length > NAMED ? `${shown.join(', ')} and ${tasks.length - NAMED} more` : shown.join(', ')
}

const ENDINGS = 'status: done|blocked|question — <one line>'

// The reason the stop of an agent's turn is refused, once per turn (the caller steps aside on a
// re-fired stop): its background work runs and the turn ends on no status line, or says
// `status: waiting` with nothing running. Null lets the turn end: it ends on a status that fits,
// or the host gave no task list (`tasks` null, a host that does not say).
export function agentStopNudge(message: string, tasks: readonly string[] | null): string | null {
  if (tasks === null) return null
  const status = parseStatus(message)
  if (status?.kind === 'waiting') {
    if (tasks.length > 0) return null
    return `Nothing of yours runs in the background: status: waiting fits only while a command, monitor or subagent you started still runs, and nothing will wake you. Run what you announced, or end on ${ENDINGS}.`
  }
  if (status) return null
  if (tasks.length > 0) {
    return `Your background work still runs (${named(tasks)}): end the turn on one last line, plain text: status: waiting — <what is watched>. The module sends it to your orchestrator once, and the end of that work wakes you.`
  }
  return `Nothing of yours runs in the background, and nothing will wake you. Do the work now, or end the turn on one last line, plain text: ${ENDINGS}.`
}
