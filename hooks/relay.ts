// hooks/relay.ts
// The end of an orchestrator's turn, read by the module: the machine line the stop
// gate already requires says whether the turn waits on the operator or reports its
// work done. The wait lands in the session's store row (supervision.ts), where the
// pane, /orchestrator:status and the coordinator's facts read it, and a running
// coordinator is sent one report of it: the question as the answer carried it, or
// the closing proposal. Without this, an orchestrator that asked the operator in its
// own tab looked stopped from outside, and the coordinator spent two full turns
// asking it why. Pure on purpose: the handler holds the $ (the engine fences it to
// the file that received it) and passes its reads in here.
import { MACHINE_LINE, machineLine } from './stop-gate.ts'
import type { SessionRow } from './supervision.ts'

// The question a report carries is cut past this many characters, and the cut is said:
// a coordinator's round needs the question, not a whole turn's narrative.
export const RELAY_CAP = 4000

export type Wait =
  | { kind: 'operator'; blocks: string; question: string }
  | { kind: 'done'; question: string }

// The turn's answer read for its machine line, the stop gate's own regex over the stop
// gate's own normalisation: a wait on the operator with what it blocks, or done. The
// question is the answer minus that line. No machine line: no wait.
export function parseWait(answer: string): Wait | null {
  const matched = MACHINE_LINE.exec(machineLine(answer))
  if (!matched) return null
  const lines = answer.replace(/\s+$/, '').split('\n')
  const question = lines.slice(0, -1).join('\n').trim()
  return matched[1] ? { kind: 'operator', blocks: matched[1].trim(), question } : { kind: 'done', question }
}

// The wait as its file last held it: the current wait, or the one a turn's start
// cleared (`last_waiting`, its blocks and start kept beside it).
export type PriorWait = { waiting?: 'operator' | 'done' | null; last_waiting?: 'operator' | 'done' | null; blocks?: string | null; waiting_since?: string | null }

// The wait fields for this turn's wait: `waiting_since` is kept while the same wait
// lasts (same kind, same blocks) — across the turns between, which clear it only for
// display — and starts now on a new one.
export function waitPatch(prior: PriorWait | null, wait: Wait, now: string): Pick<SessionRow, 'waiting' | 'blocks' | 'waiting_since'> {
  const blocks = wait.kind === 'operator' ? wait.blocks : null
  const kind = prior?.waiting ?? prior?.last_waiting ?? null
  const same = kind === wait.kind && (prior?.blocks ?? null) === blocks && typeof prior?.waiting_since === 'string'
  return { waiting: wait.kind, blocks, waiting_since: same ? prior!.waiting_since! : now }
}

// A wait cleared — the session works again, or its turn ended without one: nothing is
// waited on, and the wait it was is kept so that the same wait asked again keeps its start.
export function clearedWait<T extends PriorWait>(prior: T): T & { waiting: null; last_waiting: 'operator' | 'done' | null } {
  return { ...prior, waiting: null, last_waiting: prior.waiting ?? prior.last_waiting ?? null }
}

// The deduplication key: the same wait (kind, blocks and question) is reported once,
// a new question is reported. FNV-1a over the text, enough to tell two waits apart.
export function fingerprint(wait: Wait): string {
  const text = `${wait.kind}\n${wait.kind === 'operator' ? wait.blocks : ''}\n${wait.question}`
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${text.length}-${hash.toString(16)}`
}

// The report sent to the coordinator: a header naming the session and its wait, the
// address the operator's answer goes back to, then, for the operator, the question as
// the answer carried it. A report, never an order:
// it carries no approval, no merge and no undraft.
export function relayText(name: string, wait: Wait, since: string): string {
  const reply = `reply with SendMessage to: ${name}`
  if (wait.kind === 'done') return `[module] ${name} reports its work done and proposes to be closed\n${reply}`
  const header = `[module] ${name} waits for the operator since ${since} — blocks: ${wait.blocks}\n${reply}`
  if (!wait.question) return header
  const cut = wait.question.length > RELAY_CAP
  const question = cut ? `${wait.question.slice(0, RELAY_CAP)}\n[cut at ${RELAY_CAP} of ${wait.question.length} characters]` : wait.question
  return `${header}\n\n${question}`
}

// The coordinator's name out of its record (coordinator.sh's <state>/coordinator.json),
// the address SendMessage spells; null when there is no record or it names nobody.
export function coordinatorOf(recordText: string): string | null {
  try {
    const name = (JSON.parse(recordText) as { name?: unknown })?.name
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : null
  } catch {
    return null
  }
}

// The wait as the pane and /orchestrator:status show it, its start in the machine's
// local time; null when the row waits on nothing.
export function waitLabel(row: SessionRow): string | null {
  if (row.waiting !== 'operator' && row.waiting !== 'done') return null
  const at = new Date(String(row.waiting_since ?? ''))
  const since = Number.isFinite(at.getTime())
    ? ` since ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    : ''
  return row.waiting === 'done'
    ? `done${since}, proposes to be closed`
    : `waiting for the operator${since} — blocks: ${row.blocks ?? 'unsaid'}`
}
