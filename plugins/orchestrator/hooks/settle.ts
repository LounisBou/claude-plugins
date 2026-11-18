// hooks/settle.ts
// What a close of a round question writes, decided without the host: the `settle` call validated,
// and the entry it closes — answered here (in the asker's tab, or in the coordinator's), answered by a
// message that reached its asker, or withdrawn with its reason — whichever wrote the entry: an object
// `ask` stored (question.ts, `v` 2) or an entry the relay wrote out of a turn's text (round.ts) —
// and the closes the module makes itself: an answer in the pane, the words typed in the asker's tab,
// a withdrawal at its session's end. The one closure function that writes each, under the entry's
// lock, then journals his answer and tells the asker, is question.ts's `closeRound`: the host's `$`
// cannot be handed through this strict file, which imports no file that is not.

import { TODO_OWNER_FIELDS } from './todo-format.ts'

export const SETTLE_TOOL = 'settle'

export const OUTCOMES = ['answered-here', 'answered-by-message', 'withdrawn'] as const
export type Outcome = typeof OUTCOMES[number]

/**
 * One call, validated: the entry, how it ends, his answer or the reason, the message's author, the work it
 * asks, and, when given, who takes that work or what it waits on, as the todo tool reads them.
 */
export type SettleRequest = { id: string; outcome: Outcome; text: string; author: string | null; work: string | null; owner?: Record<string, unknown> }

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
  const owner = Object.fromEntries(TODO_OWNER_FIELDS.filter(field => e[field] !== undefined).map(field => [field, e[field]]))
  return { request: { id, outcome, text: said, author: outcome === 'answered-by-message' ? author : null, work, ...(work !== null && Object.keys(owner).length > 0 ? { owner } : {}) } }
}

/** Who asked a question and where its answer goes: its session, its name, and whether it came from another machine. */
export type Asker = { session: string; name: string; remote: boolean }

/** What a close writes and what it then does. */
export type Plan = {
  entry: Fields
  asker: Asker
  /**
   * The answer sent to its asker now, submitted to the closing session's own turn when it is the
   * asker (`own`, which no message reaches), or sent to its owner's machine from a replica.
   */
  deliver: 'now' | 'own' | 'remote' | null
  /** Who answered as the operator, whose answer the journal records; null when no answer of his is recorded. */
  answeredBy: 'pane' | 'coordinator' | 'tab' | null
  /** The words of his answer, as the journal reads them. */
  answerWords: string
  /** The relay's entry: its fingerprint forgotten, and the coordinator told when the module closed it. */
  relayed: boolean
  told: boolean
}

const RELAY_TAB = "answered in the sender's own tab"

// The close of an object `ask` stored: its asker settles it any way, the coordinator answers it in
// its tab or withdraws it; it is answered or withdrawn, never closed (no coordinator holds it). The
// coordinator here that was shown it (`shown`) is told when its asker settles it, so the question
// leaves its conversation too. With no coordinator live (`coordinatorLive`, true when it cannot be
// told), the machine-wide decide stands in for it: an orchestrator settles another session's open
// question answered-here, the operator's words typed in its tab, and nothing else of another's.
export function planAsked(entry: Fields, request: SettleRequest, me: Me, at: string, shown = false, coordinatorLive = true): Plan | { error: string } {
  const sender = fields(entry['sender'])
  const asker: Asker = { session: String(sender?.['session'] ?? ''), name: String(sender?.['name'] ?? ''), remote: false }
  if (entry['status'] !== 'open') return { error: `${request.id} is ${String(entry['status'])} already: nothing to settle.` }
  const own = asker.session === me.session
  // A replica (`origin`) is its owner's: its answer travels to a coordinator there, never to a stand-in's.
  const standsIn = !own && !coordinatorLive && me.role === 'orchestrator' && request.outcome === 'answered-here' && entry['origin'] === undefined
  if (!own && me.role !== 'coordinator' && !standsIn) {
    const recorded = me.role === 'orchestrator' && request.outcome === 'answered-here' ? ' A coordinator is recorded live (or its record cannot be judged): it is its alone until `coordinator.sh clear` removes a stale record.' : ''
    return { error: `${request.id} is ${asker.name}'s question: only it, or the coordinator, settles it.${recorded}` }
  }
  if (!own && request.outcome === 'answered-by-message') return { error: 'an answer that reached you by message settles your own question only; his answer in your tab is answered-here.' }
  const by = request.outcome === 'answered-by-message' ? 'message' : !own ? 'coordinator' : request.outcome === 'withdrawn' ? 'sender' : 'tab'
  const answer = { text: request.text, by, at, settler: me.name, ...(request.author !== null ? { author: request.author } : {}) }
  const answered = request.outcome !== 'withdrawn'
  // A replica (remote-asked.ts) is settled by its owner: the answer goes there, its seq the owner's.
  if (entry['origin'] !== undefined) {
    return {
      entry: { ...entry, status: answered ? 'answered' : 'withdrawn', answer, delivery: { state: 'pending', at, attempts: 0 } },
      asker: { ...asker, remote: true }, deliver: 'remote', answeredBy: null, answerWords: request.text, relayed: false, told: false,
    }
  }
  return {
    entry: { ...entry, status: answered ? 'answered' : 'withdrawn', answer, seq: Number(entry['seq'] ?? 0) + 1 },
    asker,
    deliver: own ? null : 'now',
    // His answer is recorded from his own words only: one carried by a message is the model's word.
    answeredBy: !answered || request.outcome === 'answered-by-message' ? null : (own || standsIn) && me.role !== 'coordinator' ? 'tab' : 'coordinator',
    answerWords: request.text,
    relayed: false,
    told: own && shown && me.role !== 'coordinator',
  }
}

// The close of an entry the relay wrote, a closing proposal: its sender settles its own open entry
// (closed when the coordinator here was shown it, which is then told); the coordinator closes any
// entry not closed yet, and no answer goes back to its sender.
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
    // His answer is journaled from his own words only: in the coordinator's own tab every order of his is
    // one, so its settle is recorded as the coordinator's (the words need no exact form, as the pane's
    // and the coordinator's close of another's question); an orchestrator's own settle is its word.
    const answeredBy = request.outcome === 'answered-here' && me.role === 'coordinator' ? 'coordinator' : null
    return { entry: { ...entry, status, answer }, asker, deliver: null, answeredBy, answerWords: request.text, relayed: true, told: shown }
  }
  if (me.role !== 'coordinator') return { error: `${request.id} is ${asker.name}'s question: only it, or the coordinator, settles it.` }
  if (entry['status'] === 'closed') return { error: `${request.id} is closed already: nothing to settle.` }
  // An operator entry of an older release: the round's wake withdraws it with a notice to its sender.
  if (entry['kind'] === 'operator' && open) return { error: `${request.id} is an operator question of an older release: the round withdraws it and tells its sender to ask it with ask; nothing to settle.` }
  if (request.outcome === 'answered-by-message') return { error: 'an answer that reached you by message settles your own question only; his answer in your tab is answered-here.' }
  // A withdrawal keeps its evidence beside the text: its sender is told it was withdrawn, never that he answered.
  const answer = request.outcome === 'withdrawn'
    ? { text: `withdrawn: settled meanwhile — ${request.text}`, by: 'coordinator', at, evidence: request.text }
    : { text: request.text, by: 'coordinator', at }
  return {
    entry: { ...entry, status: 'closed', answer },
    asker,
    deliver: null,
    answeredBy: request.outcome === 'answered-here' ? 'coordinator' : null,
    answerWords: request.text,
    relayed: true,
    told: false,
  }
}

// His answer given in the coordinator's pane to an object `ask` stored, open and not claimed in its
// asker's tab (null leaves it): sent to its asker at once — submitted to the pane's own session
// when that session asked it — or to its owner's machine from a replica, whose seq stays the owner's.
export function planPane(entry: Fields, text: string, me: Me, at: string): Plan | null {
  if (entry['status'] !== 'open' || entry['claimed']) return null
  const sender = fields(entry['sender'])
  const asker: Asker = { session: String(sender?.['session'] ?? ''), name: String(sender?.['name'] ?? ''), remote: false }
  const answer = { text, by: 'pane', at, settler: me.name }
  const close = (written: Fields, deliver: 'now' | 'own' | 'remote'): Plan => (
    { entry: written, asker, deliver, answeredBy: deliver === 'remote' ? null : 'pane', answerWords: text, relayed: false, told: false }
  )
  return entry['origin'] !== undefined
    ? close({ ...entry, status: 'answered', answer, delivery: { state: 'pending', at, attempts: 0 } }, 'remote')
    : close({ ...entry, status: 'answered', answer, seq: Number(entry['seq'] ?? 0) + 1 }, asker.session !== '' && asker.session === me.session ? 'own' : 'now')
}

// An object `ask` stored that his prompt claimed in its asker's tab, its turn ended: answered there
// with his words; the coordinator here that was shown it (`shown`) is told, so the question leaves its
// conversation too.
export function planClaimed(entry: Fields, at: string, shown = false): Plan {
  const { claimed, ...rest } = entry
  const sender = fields(entry['sender'])
  const asker: Asker = { session: String(sender?.['session'] ?? ''), name: String(sender?.['name'] ?? ''), remote: false }
  const answer = { text: String(fields(claimed)?.['typed'] ?? ''), by: 'tab', at, settler: asker.name }
  return {
    entry: { ...rest, status: 'answered', answer, seq: Number(entry['seq'] ?? 0) + 1 },
    asker, deliver: null, answeredBy: null, answerWords: '', relayed: false, told: shown,
  }
}

// An entry its asker's session withdraws, as it ends or hands over: an object `ask` stored is
// withdrawn by it; the relay's entry too, or closed when the coordinator here was shown it, which
// its caller then tells.
export function planWithdrawal(entry: Fields, why: string, at: string, shown: boolean): Plan {
  const sender = fields(entry['sender'])
  if (sender !== null) {
    const asker: Asker = { session: String(sender['session'] ?? ''), name: String(sender['name'] ?? ''), remote: false }
    return {
      entry: { ...entry, status: 'withdrawn', answer: { text: why, by: 'sender', at, settler: asker.name }, seq: Number(entry['seq'] ?? 0) + 1 },
      asker, deliver: null, answeredBy: null, answerWords: why, relayed: false, told: false,
    }
  }
  const asker: Asker = { session: String(entry['session'] ?? ''), name: String(entry['from'] ?? ''), remote: fields(entry['origin']) !== null }
  const answer = { text: shown ? `withdrawn: ${why}` : why, by: 'sender', at }
  return { entry: { ...entry, status: shown ? 'closed' : 'withdrawn', answer }, asker, deliver: null, answeredBy: null, answerWords: why, relayed: true, told: false }
}

// An operator entry of an older release, still open, withdrawn by the round's wake in the
// coordinator's session (null leaves any other): its sender is told by the caller once written.
export function planOlder(entry: Fields, text: string, at: string): Plan | null {
  if (entry['kind'] !== 'operator' || entry['status'] !== 'open' || fields(entry['sender']) !== null) return null
  const asker: Asker = { session: String(entry['session'] ?? ''), name: String(entry['from'] ?? ''), remote: fields(entry['origin']) !== null }
  return {
    entry: { ...entry, status: 'withdrawn', answer: { text: `withdrawn: ${text}`, by: 'coordinator', at } },
    asker, deliver: null, answeredBy: null, answerWords: text, relayed: false, told: false,
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
