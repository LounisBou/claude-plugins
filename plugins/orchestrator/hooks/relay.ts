// hooks/relay.ts
// The end of an orchestrator's turn, read by the module: the machine line the stop
// gate already requires says whether the turn waits on the operator or reports its
// work done. An agent's turn ends the same way on its status line, reported to its
// orchestrator instead, and its gate crossing too (supervision.ts). The wait lands in the session's store row (supervision.ts), where the
// pane, /orchestrator-status and the coordinator's facts read it, and once in the
// coordinator's hands: an entry of its round when it runs on this machine (round.ts), one
// report sent when it runs on another — the question as the answer carried it, or
// the closing proposal. Without this, an orchestrator that asked the operator in its
// own tab looked stopped from outside, and the coordinator spent two full turns
// asking it why. When the operator types in the orchestrator's own tab and the turn he
// started ends on another line, its entry is marked withdrawn, or the coordinator elsewhere is
// sent one withdrawal, and the fingerprint is forgotten, so the same question asked again is
// relayed again. Pure on
// purpose: the handler holds the $ (the engine fences it to the file that received it) and
// passes its reads in here.
import { MACHINE_LINE, URGENT_LINE, blocksNothing, chainEntries } from './stop-gate.ts'
import { machineLine, reportStatus } from '../core/method.ts'
import type { SessionRow } from './supervision.ts'
import { cutAt, shorten, VERDICT_LIMIT } from '../core/verdict.ts'

// The question a report carries is cut past this many characters, and the cut is said:
// a coordinator's round needs the question, not a whole turn's narrative.
export const RELAY_CAP = 4000

// An orchestrator waits on the operator or is done; an agent of one (parseStatus) has
// delivered, is blocked, asks or waits on its own background work, `blocks` then its status
// line's own words.
// A wait on the operator its sender marked `(urgent)` carries `urgent: true`; the plain
// form carries no such field. In the fingerprint, so a wait marked urgent or unmarked is
// entered again, but never in the round entry's id (round.ts roundEntryId): the same entry.
export type Wait =
  | { kind: 'operator'; blocks: string; question: string; urgent?: true }
  | { kind: 'done'; question: string }
  | { kind: 'delivered' | 'blocked' | 'question' | 'waiting'; blocks: string; question: string }
export type WaitKind = Wait['kind']

// The turn's answer read for its machine line, the stop gate's own regex over the stop
// gate's own normalisation: a wait on the operator with what it blocks, or done. The
// question is the answer minus that line. No machine line: no wait. Neither is a wait on a
// tool of the session's own (`waiting: tool — …`, its own tab's business), nor the ending on work
// the operator deferred (`waiting: deferred — …`, his ruling recorded), nor a wait on the
// operator that blocks nothing: he is asked nothing, so nothing is entered, sent or kept.
export function parseWait(answer: string): Wait | null {
  const line = machineLine(answer)
  const matched = MACHINE_LINE.exec(line)
  if (!matched || blocksNothing(line)) return null
  const lines = answer.replace(/\s+$/, '').split('\n')
  const question = lines.slice(0, -1).join('\n').trim()
  if (!matched[1]) return { kind: 'done', question }
  const wait: Wait = { kind: 'operator', blocks: matched[1].trim(), question }
  return URGENT_LINE.test(line) ? { ...wait, urgent: true } : wait
}

// A predecessor's last word in a succession, « handed over » (succeed.md), read as the stop gate
// reads it: the text's last line alone, its markup dropped. Its successor took the work over.
export function handsOver(text: string): boolean {
  return /^handed over$/i.test(machineLine(text))
}

// A successor's word to its predecessor, « takeover confirmed » (the succession brief), read on
// the text's first line, its markup dropped as handsOver drops it. The phrase opens the line and
// anything may follow it: a successor reports on the same line (« takeover confirmed — <its name>
// holds the orchestration; … », 2026-11-04), and a whole-line match read that as no takeover, so
// the hand-over withdrew the open questions it should have moved.
export function confirmsTakeover(text: string): boolean {
  return /^takeover confirmed\b/i.test(machineLine(text.split('\n').find(line => line.trim() !== '') ?? ''))
}

// An agent's last line, its brief's own: `status: done|blocked|question — <one line>`, or
// `status: waiting — <what is watched>` while its own background work runs, read
// by core's reportStatus. The text above it is its report or question.
const STATUS_KIND = { done: 'delivered', blocked: 'blocked', question: 'question', waiting: 'waiting' } as const

export function parseStatus(answer: string): Wait | null {
  const status = reportStatus(answer)
  if (!status) return null
  const lines = answer.replace(/\s+$/, '').split('\n')
  return { kind: STATUS_KIND[status.status], blocks: status.reason, question: lines.slice(0, -1).join('\n').trim() }
}

// An agent's turn text held to the verdict limit before it is relayed: whole under it, else its
// status line kept whole and the text above it cut, the cut naming the report the text names, or
// saying it names none (the stop gate refused that turn once already: its text still goes up).
export function heldReport(answer: string): string {
  const text = answer.trim()
  const short = shorten(text)
  if (short.kind === 'whole') return answer
  const lines = text.split('\n')
  const status = lines.length > 1 && parseStatus(text) ? lines[lines.length - 1] : ''
  const body = status ? lines.slice(0, -1).join('\n') : text
  const cut = cutAt(body, status ? Math.max(0, VERDICT_LIMIT - status.length - 1) : VERDICT_LIMIT, short.kind === 'cut' ? short.path : null)
  return status ? `${cut}\n${status}` : cut
}

// The refusal of an agent's message over the limit that names no report file: the one line
// that says what to do instead.
export function unnamedReport(length: number): string {
  return `Your message to the orchestrator is ${length} characters, over its ${VERDICT_LIMIT}: write the full report to a file first, then send its verdict line naming it (report: <absolute path>).`
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
// nothing, keeps the turn's text in the key: a second delivery is news. A wait marked urgent
// keys apart from the plain one. FNV-1a over the text, enough to tell two waits apart.
export function fingerprint(wait: Wait): string {
  const blocks = 'blocks' in wait ? wait.blocks : ''
  const said = wait.kind === 'delivered' || !blocks ? wait.question : ''
  const urgent = wait.kind === 'operator' && wait.urgent ? '\nurgent' : ''
  const text = `${wait.kind}\n${blocks}\n${said}${urgent}`
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
    : wait.kind === 'waiting' ? `[module] ${name} waits on its background work`
    : `[module] ${name} ${wait.kind === 'blocked' ? 'is blocked' : 'asks'}`
  const said = 'blocks' in wait && wait.kind !== 'operator' && wait.blocks ? ` — ${wait.blocks}` : ''
  if (!wait.question) return `${header}${said}\n${reply}`
  return `${header}${said}\n${reply}\n\n${cutQuestion(wait.question)}`
}

// The question as a report carries it, the coordinator's round entry included: cut past
// the cap, and the cut said.
export function cutQuestion(question: string): string {
  return question.length > RELAY_CAP ? `${question.slice(0, RELAY_CAP)}\n[cut at ${RELAY_CAP} of ${question.length} characters]` : question
}

// The wait file as the withdrawal reads it: the wait, and the fingerprint last delivered.
export type RelayedWait = PriorWait & { relayed?: string | null; pending_key?: string | null }

// The question the coordinator holds, if any: an operator wait (the current one, or the
// one a turn's start cleared) whose own fingerprint, plain or urgent, was delivered. Its blocks
// and start are what the coordinator's round file carries in the question's header.
export function heldQuestion(prior: RelayedWait | null): { blocks: string; since: string | null } | null {
  const kind = prior?.waiting ?? prior?.last_waiting ?? null
  const blocks = prior?.blocks
  if (kind !== 'operator' || typeof blocks !== 'string' || blocks === '') return null
  const plain: Wait = { kind: 'operator', blocks, question: '' }
  if (prior!.relayed !== fingerprint(plain) && prior!.relayed !== fingerprint({ ...plain, urgent: true })) return null
  return { blocks, since: prior!.waiting_since ?? null }
}

// An operator question a sender holds open: the start and the blocks that name its wait.
export type HeldQuestion = { since: string; blocks: string }

// The operator questions a sender's wait file vouches for, the one source of what its row says it
// holds open whatever the session is doing: the held question, delivered or sent and not yet
// acknowledged. A file whose wait is on something else than the operator (a closing proposal, none
// ever) says nothing of the questions beside it: null, unknown, never « none open »; so does an
// operator wait whose blocks is empty, which no entry's header can match.
export function openQuestions(prior: RelayedWait | null): HeldQuestion[] | null {
  if ((prior?.waiting ?? prior?.last_waiting ?? null) !== 'operator') return null
  if (typeof prior?.blocks !== 'string' || prior.blocks === '') return null
  const held = heldQuestion(prior) ?? heldQuestion({ ...prior, relayed: prior?.pending_key ?? null })
  return held && held.since !== null ? [{ since: held.since, blocks: held.blocks }] : []
}

// The report that the operator answered in the orchestrator's own tab: a report, never an
// order, and nothing is to be sent back.
export function withdrawalText(name: string, blocks: string, since: string | null, said?: string): string {
  const words = said ? ` (he typed: "${said.replace(/\s*\n\s*/g, ' ')}")` : ''
  return `[module] ${name} withdraws its question for the operator since ${since ?? '?'} — blocks: ${blocks}\n`
    + `the operator answered it in ${name}'s own tab${words}: nothing to send back`
}

// A withdrawal as withdrawalText wrote it, read back by the coordinator's module: who withdraws,
// the wait's start (null for « ? »), what it blocks and the words the operator typed, when kept.
const WITHDRAWAL = /^\[module\] (.+?) withdraws its question for the operator since (\S+) — blocks: (.*)\nthe operator answered it in .*'s own tab(?: \(he typed: "(.*)"\))?: nothing to send back$/
export function parseWithdrawal(body: string): { name: string; since: string | null; blocks: string; said: string | null } | null {
  const matched = WITHDRAWAL.exec(body.trim())
  if (!matched) return null
  return { name: matched[1] ?? '', since: matched[2] === '?' ? null : matched[2] ?? null, blocks: matched[3] ?? '', said: matched[4] ?? null }
}

// An agent's measure crossing the gate its session runs under, the one line sent to its
// orchestrator once per crossing: the figures, never an instruction.
export function gateText(name: string, tokens: number, percent: number): string {
  return `[module] ${name} context ${tokens.toLocaleString('en-US')} (${percent}%) — at the gate`
}

// The deduplication key of an agent's turn that ended without its status line, kept in the
// wait file's `relayed` like a status line's fingerprint. It names the turn, never the kind:
// one turn handled twice is one key, and the turn after it is another, so a report written
// without its status line is never taken for the silent turn before it. The host's turn id
// is the identity; an event that carries none gets a key of its own time and text length, so
// it is sent rather than dropped.
export const NO_STATUS_KEY = 'no-status'

export function noStatusKey(turnId: unknown, text: string, now: number = Date.now()): string {
  return typeof turnId === 'string' && turnId !== '' ? `${NO_STATUS_KEY}:${turnId}` : `${NO_STATUS_KEY}:${now}-${text.length}`
}

// The one line sent to the orchestrator when an agent ends a turn without its status line:
// the figure when it is known, then the address the answer goes back to and the turn's last
// text, cut past the cap and said like a question is. Never an instruction.
export function noStatusText(name: string, context: string | null, text: string = ''): string {
  const header = `[module] ${name} ended a turn without its status line${context ? ` — context ${context}` : ''}`
  const said = text.trim()
  return said === '' ? header : `${header}\nreply with SendMessage to: ${name}\n\n${cutQuestion(said)}`
}

// The orchestrator's tty an agent's tty belongs to: the launcher's chains, one file per
// orchestrator tty, each entry an agent's tty. A chain outlives its tab and a tty is
// recycled, so a chain counts only while its owner (the tty that names the file) is one
// `ownerLives` says carries a live orchestrator; of those naming this tty the one written
// last wins — the spawn that put this agent there appended to it. Without `ownerLives`
// every chain counts. Null when no chain counts.
export function chainOwnerTty(chains: readonly { name: string; mtimeMs: number; text: string }[], tty: string,
  ownerLives?: (ownerTty: string) => boolean): string | null {
  const named = chains.filter(c => c.name.endsWith('.jsonl') && chainEntries(c.text).some(e => e.tty === tty)
    && (ownerLives === undefined || ownerLives(`/dev/${c.name.slice(0, -'.jsonl'.length)}`)))
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

// The wait in its two parts, the one definition every surface reads: the status words, with
// their start in the machine's local time, and for a wait on the operator what it blocks
// (« unsaid » when the row carries none; null for a proposal to close). Null when the row
// waits on nothing.
export function waitParts(row: SessionRow): { status: string; blocks: string | null } | null {
  if (row.waiting !== 'operator' && row.waiting !== 'done') return null
  const at = new Date(String(row.waiting_since ?? ''))
  const since = Number.isFinite(at.getTime())
    ? ` since ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    : ''
  return row.waiting === 'done'
    ? { status: `done${since}, proposes to be closed`, blocks: null }
    : { status: `waiting for the operator${since}`, blocks: row.blocks ?? 'unsaid' }
}

// The wait as the pane and /orchestrator-status show it on one line; null when the row waits
// on nothing.
export function waitLabel(row: SessionRow): string | null {
  const parts = waitParts(row)
  if (parts === null) return null
  return parts.blocks === null ? parts.status : `${parts.status} — blocks: ${parts.blocks}`
}
