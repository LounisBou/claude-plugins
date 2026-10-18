// hooks/relay.ts
// The end of an orchestrator's turn, read by the module: the machine line the stop
// gate already requires says whether the turn waits on the operator or reports its
// work done. An agent's turn ends the same way on its status line, reported to its
// orchestrator instead, and its gate crossing too (supervision.ts). The wait lands in the session's store row (supervision.ts), where the
// pane, /orchestrator:status and the coordinator's facts read it, and a running
// coordinator is sent one report of it: the question as the answer carried it, or
// the closing proposal. Without this, an orchestrator that asked the operator in its
// own tab looked stopped from outside, and the coordinator spent two full turns
// asking it why. When the operator answers that question in the orchestrator's own tab,
// the coordinator is sent one withdrawal and the fingerprint is forgotten, so the same
// question asked again is relayed again. Pure on purpose: the handler holds the $ (the
// engine fences it to the file that received it) and passes its reads in here.
import { MACHINE_LINE, machineLine, chainEntries } from './stop-gate.ts'
import type { SessionRow } from './supervision.ts'

// The question a report carries is cut past this many characters, and the cut is said:
// a coordinator's round needs the question, not a whole turn's narrative.
export const RELAY_CAP = 4000

// An orchestrator waits on the operator or is done; an agent of one (parseStatus) has
// delivered, is blocked or asks, `blocks` then its status line's own words.
export type Wait =
  | { kind: 'operator'; blocks: string; question: string }
  | { kind: 'done'; question: string }
  | { kind: 'delivered' | 'blocked' | 'question'; blocks: string; question: string }
export type WaitKind = Wait['kind']

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

// An agent's last line, its brief's own: `status: done|blocked|question — <one line>`,
// read over the stop gate's normalisation. The text above it is its report or question.
const STATUS_LINE = /^status:\s*(done|blocked|question)\b\s*(?:(?:—|–|--|-|:)\s*(.*))?$/i
const STATUS_KIND = { done: 'delivered', blocked: 'blocked', question: 'question' } as const

export function parseStatus(answer: string): Wait | null {
  const matched = STATUS_LINE.exec(machineLine(answer))
  if (!matched) return null
  const lines = answer.replace(/\s+$/, '').split('\n')
  const kind = STATUS_KIND[matched[1].toLowerCase() as keyof typeof STATUS_KIND]
  return { kind, blocks: (matched[2] ?? '').trim(), question: lines.slice(0, -1).join('\n').trim() }
}

// The wait as its file last held it: the current wait, or the one a turn's start
// cleared (`last_waiting`, its blocks and start kept beside it).
export type PriorWait = { waiting?: WaitKind | null; last_waiting?: WaitKind | null; blocks?: string | null; waiting_since?: string | null }

// The wait fields for this turn's wait: `waiting_since` is kept while the same wait
// lasts (same kind, same blocks) — across the turns between, which clear it only for
// display — and starts now on a new one.
export function waitPatch(prior: PriorWait | null, wait: Wait, now: string): Pick<SessionRow, 'waiting' | 'blocks' | 'waiting_since'> {
  const blocks = 'blocks' in wait ? wait.blocks : null
  const kind = prior?.waiting ?? prior?.last_waiting ?? null
  const same = kind === wait.kind && (prior?.blocks ?? null) === blocks && typeof prior?.waiting_since === 'string'
  return { waiting: wait.kind, blocks, waiting_since: same ? prior!.waiting_since! : now }
}

// A wait cleared — the session works again, or its turn ended without one: nothing is
// waited on, and the wait it was is kept so that the same wait asked again keeps its start.
export function clearedWait<T extends PriorWait>(prior: T): T & { waiting: null; last_waiting: WaitKind | null } {
  return { ...prior, waiting: null, last_waiting: prior.waiting ?? prior.last_waiting ?? null }
}

// The deduplication key: a wait is its kind and its line, reported once however the turns
// it spans read above that line; a new line is a new wait. A delivery, or a line saying
// nothing, keeps the turn's text in the key: a second delivery is news. FNV-1a over the
// text, enough to tell two waits apart.
export function fingerprint(wait: Wait): string {
  const blocks = 'blocks' in wait ? wait.blocks : ''
  const said = wait.kind === 'delivered' || !blocks ? wait.question : ''
  const text = `${wait.kind}\n${blocks}\n${said}`
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${text.length}-${hash.toString(16)}`
}

// The report sent up: to the coordinator for an orchestrator, to its orchestrator for an
// agent. A header naming the session and its state, the address the answer goes back to,
// then the text the turn carried, cut past the cap and said. A report, never an order:
// it carries no approval, no merge, no undraft and no stand-down.
export function relayText(name: string, wait: Wait, since: string, context: string | null = null): string {
  const reply = `reply with SendMessage to: ${name}`
  if (wait.kind === 'done') return `[module] ${name} reports its work done and proposes to be closed\n${reply}`
  const header = wait.kind === 'operator' ? `[module] ${name} waits for the operator since ${since} — blocks: ${wait.blocks}`
    : wait.kind === 'delivered' ? `[module] ${name} reports its delivery; verify on the artifact${context ? ` — context ${context}` : ''}`
    : `[module] ${name} ${wait.kind === 'blocked' ? 'is blocked' : 'asks'}`
  const said = 'blocks' in wait && wait.kind !== 'operator' && wait.blocks ? ` — ${wait.blocks}` : ''
  if (!wait.question) return `${header}${said}\n${reply}`
  const cut = wait.question.length > RELAY_CAP
  const question = cut ? `${wait.question.slice(0, RELAY_CAP)}\n[cut at ${RELAY_CAP} of ${wait.question.length} characters]` : wait.question
  return `${header}${said}\n${reply}\n\n${question}`
}

// The wait file as the withdrawal reads it: the wait, and the fingerprint last delivered.
export type RelayedWait = PriorWait & { relayed?: string | null }

// The question the coordinator holds, if any: an operator wait (the current one, or the
// one a turn's start cleared) whose own fingerprint was delivered. Its blocks and start
// are what the coordinator's round file carries in the question's header.
export function heldQuestion(prior: RelayedWait | null): { blocks: string; since: string | null } | null {
  const kind = prior?.waiting ?? prior?.last_waiting ?? null
  const blocks = prior?.blocks
  if (kind !== 'operator' || typeof blocks !== 'string' || blocks === '') return null
  if (prior!.relayed !== fingerprint({ kind: 'operator', blocks, question: '' })) return null
  return { blocks, since: prior!.waiting_since ?? null }
}

// The report that the operator answered in the orchestrator's own tab: a report, never an
// order, and nothing is to be sent back.
export function withdrawalText(name: string, blocks: string, since: string | null): string {
  return `[module] ${name} withdraws its question for the operator since ${since ?? '?'} — blocks: ${blocks}\n`
    + `the operator answered it in ${name}'s own tab: nothing to send back`
}

// An agent's measure crossing the gate its session runs under, the one line sent to its
// orchestrator once per crossing: the figures, never an instruction.
export function gateText(name: string, tokens: number, percent: number): string {
  return `[module] ${name} context ${tokens.toLocaleString('en-US')} (${percent}%) — at the gate`
}

// The deduplication key of an agent's turn that ended without its status line, kept in the
// wait file's `relayed` like a status line's fingerprint.
export const NO_STATUS_KEY = 'no-status'

// The one line sent to the orchestrator when an agent ends a turn without its status line:
// the figure when it is known, never an instruction.
export function noStatusText(name: string, context: string | null): string {
  return `[module] ${name} ended a turn without its status line${context ? ` — context ${context}` : ''}`
}

// The orchestrator's tty an agent's tty belongs to: the launcher's chains, one file per
// orchestrator tty, each entry an agent's tty. A chain outlives its tab and a tty is
// recycled, so of the chains naming this tty the one written last wins — the spawn that
// put this agent there appended to it. Null when no chain names it.
export function chainOwnerTty(chains: readonly { name: string; mtimeMs: number; text: string }[], tty: string): string | null {
  const named = chains.filter(c => c.name.endsWith('.jsonl') && chainEntries(c.text).some(e => e.tty === tty))
  if (named.length === 0) return null
  const last = named.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a))
  return `/dev/${last.name.slice(0, -'.jsonl'.length)}`
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
