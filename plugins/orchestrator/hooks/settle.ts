// hooks/settle.ts
// What a close of a round question writes, decided without the host: the `settle` call validated,
// and the entry it closes — answered here (in the asker's tab, or in the coordinator's), answered by a
// message that reached its asker, or withdrawn with its reason — whichever wrote the entry: an object
// `ask` stored (question.ts, `v` 2) or an entry the relay wrote out of a turn's text (round.ts). The
// one closure function that writes it, under the entry's lock, and then records the consent, tells
// the asker and records the work asked, is question.ts's `settle`: the host's `$` cannot be handed
// through this strict file, which imports no file that is not.
import type { Answerer } from '../core/consent-record.ts'

export const SETTLE_TOOL = 'settle'

export const OUTCOMES = ['answered-here', 'answered-by-message', 'withdrawn'] as const
export type Outcome = typeof OUTCOMES[number]

/** One call, validated: the entry, how it ends, his answer or the reason, the message's author, the work it asks. */
export type SettleRequest = { id: string; outcome: Outcome; text: string; author: string | null; work: string | null }

/** The session that settles. */
export type Me = { session: string; name: string; role: string }

export type Fields = Record<string, unknown>

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
export const fields = (value: unknown): Fields | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : null)

/** The call's fields as a request, or why they are none. */
export function parseSettle(e: Record<string, unknown>): { request: SettleRequest } | { error: string } {
  const id = text(e['id'])
  if (id === null || !/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') return { error: 'id is the id of a round entry, as the question block or `coordinator.sh round` names it.' }
  const outcome = OUTCOMES.find(known => known === e['outcome'])
  if (outcome === undefined) return { error: `outcome is one of ${OUTCOMES.join(', ')}.` }
  const said = outcome === 'withdrawn' ? text(e['reason']) : text(e['answer'])
  if (said === null) return { error: outcome === 'withdrawn' ? 'reason says why it is withdrawn: the evidence read, or what made it moot.' : 'answer is his answer, his words or his letter as he gave it.' }
  const author = text(e['author'])
  if (outcome === 'answered-by-message' && author === null) return { error: 'author is the session whose message carried his answer.' }
  if (e['work'] !== undefined && typeof e['work'] !== 'string') return { error: 'work is a string: the work his answer asks, in his words.' }
  const work = outcome === 'withdrawn' ? null : text(e['work'])
  if (outcome === 'withdrawn' && text(e['work']) !== null) return { error: 'a withdrawn question asks no work.' }
  return { request: { id, outcome, text: said, author: outcome === 'answered-by-message' ? author : null, work } }
}

/** Who asked a question and where its answer goes: its session, its name, and whether it came from another machine. */
export type Asker = { session: string; name: string; remote: boolean }

/** What a close writes and what it then does. */
export type Plan = {
  entry: Fields
  asker: Asker
  /** v2: the answer sent to its asker now; relay: the pending delivery handed to the supervision. */
  deliver: 'now' | 'pending' | null
  consentBy: Answerer | null
  /** The relay's entry: its fingerprint forgotten, and the coordinator told when the module closed it. */
  relayed: boolean
  told: boolean
}

const RELAY_TAB = "answered in the sender's own tab"

// The close of an object `ask` stored: its asker settles it any way, the coordinator answers it in
// its tab or withdraws it; it is answered or withdrawn, never closed (no coordinator holds it).
export function planAsked(entry: Fields, request: SettleRequest, me: Me, at: string): Plan | { error: string } {
  const sender = fields(entry['sender'])
  const asker: Asker = { session: String(sender?.['session'] ?? ''), name: String(sender?.['name'] ?? ''), remote: false }
  if (entry['status'] !== 'open') return { error: `${request.id} is ${String(entry['status'])} already: nothing to settle.` }
  const own = asker.session === me.session
  if (!own && me.role !== 'coordinator') return { error: `${request.id} is ${asker.name}'s question: only it, or the coordinator, settles it.` }
  if (!own && request.outcome === 'answered-by-message') return { error: 'an answer that reached you by message settles your own question only; his answer in your tab is answered-here.' }
  const by = request.outcome === 'answered-by-message' ? 'message' : !own ? 'coordinator' : request.outcome === 'withdrawn' ? 'sender' : 'tab'
  const answer = { text: request.text, by, at, settler: me.name, ...(request.author !== null ? { author: request.author } : {}) }
  const answered = request.outcome !== 'withdrawn'
  return {
    entry: { ...entry, status: answered ? 'answered' : 'withdrawn', answer, seq: Number(entry['seq'] ?? 0) + 1 },
    asker,
    deliver: own ? null : 'now',
    // His consent is recorded from his answer only: one carried by a message is the model's word.
    consentBy: !answered || request.outcome === 'answered-by-message' ? null : own ? 'tab' : 'coordinator',
    relayed: false,
    told: false,
  }
}

// The close of an entry the relay wrote, as the two commands it replaces closed one: its sender
// settles its own open entry (closed when the coordinator here was shown it, which is then told);
// the coordinator closes any entry not closed yet, an open one's answer left pending for delivery.
export function planRelayed(entry: Fields, request: SettleRequest, me: Me, at: string, shown: boolean): Plan | { error: string } {
  const origin = fields(entry['origin'])
  const asker: Asker = { session: String(entry['session'] ?? ''), name: String(entry['from'] ?? ''), remote: origin !== null }
  const open = entry['status'] === 'open'
  if (asker.session !== '' && asker.session === me.session) {
    if (!open) return { error: `${request.id} is ${String(entry['status'])} already: nothing to settle.` }
    const why = request.outcome === 'answered-by-message' ? `answered by a message from ${request.author ?? ''}`
      : request.outcome === 'answered-here' ? RELAY_TAB : request.text
    const by = request.outcome === 'answered-by-message' ? 'message' : request.outcome === 'answered-here' ? 'tab' : 'sender'
    const answer = {
      text: shown ? `withdrawn: ${why}` : why, by, at,
      ...(request.author !== null ? { author: request.author } : {}),
      ...(request.outcome === 'answered-here' ? { typed: request.text } : {}),
    }
    const status = shown ? 'closed' : request.outcome === 'withdrawn' ? 'withdrawn' : 'answered'
    return { entry: { ...entry, status, answer }, asker, deliver: null, consentBy: null, relayed: true, told: shown }
  }
  if (me.role !== 'coordinator') return { error: `${request.id} is ${asker.name}'s question: only it, or the coordinator, settles it.` }
  if (entry['status'] === 'closed') return { error: `${request.id} is closed already: nothing to settle.` }
  if (request.outcome === 'answered-by-message') return { error: 'an answer that reached you by message settles your own question only; his answer in your tab is answered-here.' }
  // A withdrawal keeps its evidence beside the text: its sender is told it was withdrawn, never that he answered.
  const answer = request.outcome === 'withdrawn'
    ? { text: `withdrawn: settled meanwhile — ${request.text}`, by: 'coordinator', at, evidence: request.text }
    : { text: request.text, by: 'coordinator', at }
  // An open question's sender waits on the answer: its delivery is left pending, stamped as the answer.
  const waits = open && entry['kind'] === 'operator'
  const delivery = waits ? { delivery: { state: 'pending', at, attempts: 0, ...(asker.remote ? {} : { answerAt: at }) } } : {}
  return {
    entry: { ...entry, status: 'closed', answer, ...delivery },
    asker,
    deliver: waits ? 'pending' : null,
    consentBy: request.outcome === 'answered-here' ? 'coordinator' : null,
    relayed: true,
    told: false,
  }
}

/** The message an asker receives when another session settled its question asked with `ask`. */
export function settledMessage(entry: Fields, me: Me): string {
  const answer = fields(entry['answer']) ?? {}
  const about = `your question ${String(entry['id'])} « ${String(entry['subject'])} » (blocks: ${String(entry['blocks'])})`
  return entry['status'] === 'withdrawn'
    ? `[module] ${me.name} withdrew ${about}: ${String(answer['text'])}`
    : `[module] The operator answered ${about} through ${me.name} at ${String(answer['at'])} — ${String(answer['text'])}`
}
