// hooks/question.ts
// The `ask` tool: a question to the operator made by one call, its fields flat (the host once dropped a
// nested field), validated against the method's question format
// (plugins/method/skills/lifecycle/references/questions.md) and stored as its own object in the
// round, `round/<id>.json`, with a format version that tells it from the closing proposals the relay
// writes (round.ts). The id is the module's, given at creation; each call is one
// object, settled and delivered on its own. The model writes the question block, in its turn's
// last text: a viewer on Remote Control is shown that text alone. The tool's result says so, and
// `declare_wait`'s says it again (wait.ts). Any main session that keeps a list asks with it: an
// orchestrator, a coordinator, an auditor; an agent asks the session that launched it.
//
// The `settle` tool closes a question by its id, here: its one closure function writes every close
// of a round question, the object `ask` stored or the relay's entry (settle.ts decides what it
// writes), then journals his answer, sends the answer of a question asked with `ask` to its
// asker at once when another session settles it, and records the work the answer asks as a to-do of
// the asker. The pane, the words typed in the asker's tab and its session's end close through the
// same function (closeRound).
import { updateOver } from '../core/store-io.ts'
import { ROUND_ARCHIVE_DIR, ROUND_DIR, roundEntryPath } from '../core/orchestration.ts'
import { answerEvent, answerGiven, subjectOf } from '../core/learning.ts'
import { write, type Memory } from './observe.ts'
import { PLUGIN } from './audit-events.ts'
import { answersChoice } from '../core/round-question.ts'
import { typedByOperator } from './models-guard.ts'
import { DECLARATIONS } from './wait.ts'
import { machineLabel } from './remote-row.ts'
import type { RoundEntry } from './round.ts'
import { askedKey } from './asked-key.ts'
import { callTodo, whoAmI } from './todo.ts'
import { setSessionWindow, closesItself, coordinatorRuns, forgetRelayed, isRoundAnswer, parseRoundEntry, readSessions, sessionKey, sessionRole, tellSettled } from './supervision.ts'
import { OUTCOMES, SETTLE_TOOL, parseSettle, planAsked, planClaimed, planPane, planRelayed, planWithdrawal, settledMessage, type Fields, type Me, type Plan, type SettleRequest } from './settle.ts'
import { configDir, dataDir, logLine, storeIo } from './module-io.ts'
import { messageOf, type Host, type On } from './host.ts'
import { replicate, resendReplicas, sendReply } from './remote-asked.ts'

type Held = Host<'plugin' | 'env' | 'process' | 'tool' | 'session' | 'fs' | 'clock' | 'ui'>

export const ASK_TOOL = 'ask'

/** The format version of an object `ask` made; the relay's entries carry none. */
export const ASK_VERSION = 2

/** What `blocks` holds at most, as declare_wait's (wait.ts BLOCKS_MAX). */
const ASK_BLOCKS_MAX = 300

const LETTERS = ['A', 'B', 'C', 'D', 'E'] as const
const CHOICE_FIELDS = LETTERS.map(letter => `choice_${letter.toLowerCase()}`)

export type AskedChoice = { letter: string; text: string }
export type AskedSender = { session: string; name: string; role: string; machine: string }

/** The question as the call gave it, validated: the method's fields, its choices lettered in order. */
export type AskFields = {
  subject: string
  context: string
  ask: string
  choices: AskedChoice[]
  recommended: string | null
  why: string | null
  blocks: string
  urgent?: true
}

/** How a question asked here was settled (settle.ts): the answer or the reason, who settled it, when, and the message's author. */
export type AskedAnswer = { text: string; by: 'tab' | 'pane' | 'coordinator' | 'sender' | 'message'; at: string; settler: string; author?: string; record?: string }

/** One question in the round, as `ask` writes it, then as `settle` closes it, its answer's trip to its asker in `delivery`. */
export type Asked = AskFields & {
  v: typeof ASK_VERSION
  id: string
  sender: AskedSender
  status: 'open' | 'answered' | 'withdrawn'
  at: string
  answer: AskedAnswer | null
  /**
   * The answer's trip to its asker: on the owner's machine, delivered or failed; on a replica, its
   * answer given here on its way to the owner (pending, then sent), delivered once acknowledged. A
   * replica's last send, refused: the address that refused it, and its refusals in a row; the
   * addresses it was sent to, none of them taken again once it failed; sent again after a failure;
   * failed, then cleared by the operator in the pane, drawn and sent no more.
   */
  delivery?: { state: 'pending' | 'sent' | 'delivered' | 'failed'; at: string; attempts: number; reason?: string; refused?: { to: string; sends: number }; tried?: string[]; again?: true; cleared?: string }
  /** A replica (remote-asked.ts): the owner's machine, and the address its last push came from, or the one the host's listing gave since. */
  origin?: { machine: string; address: string }
  /** On the owner's machine: the push of this `seq` to the coordinator on another machine, and how it went; `unreached`, its last send reached nobody. */
  replica?: { seq: number; state: 'sent' | 'acked' | 'failed'; attempts: number; at: string; reason?: string; unreached?: true }
  /** The session it was asked by, before a succession moved it to its successor. */
  movedFrom?: string
  /** What the operator typed in its asker's tab that names one of its choices: off the pane until that turn's end answers it with those words. */
  claimed?: { typed: string; at: string }
  seq: number
}

type Answer = { result: string; isError?: true }
const refuse = (result: string): Answer => ({ result, isError: true })

const trimmed = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** The call's fields as the method's question, or why they are none. */
export function parseAsk(e: Record<string, unknown>): { fields: AskFields } | { error: string } {
  for (const field of ['subject', 'context', 'question', 'recommended', 'why', 'blocks', ...CHOICE_FIELDS]) {
    if (e[field] !== undefined && typeof e[field] !== 'string') return { error: `${field} is a string.` }
  }
  const subject = trimmed(e['subject'])
  const context = trimmed(e['context'])
  const ask = trimmed(e['question'])
  if (subject === null) return { error: 'subject names what the question is about, in a few words.' }
  if (context === null) return { error: 'context gives the stake and what is known, in two to six sentences.' }
  if (ask === null || !ask.endsWith('?')) return { error: 'question is one sentence ending in a question mark.' }
  // Each choice where its letter says, with no gap: an empty field is no choice.
  const given = CHOICE_FIELDS.map(field => trimmed(e[field]))
  const count = given.filter(text => text !== null).length
  if (given.slice(0, count).some(text => text === null)) return { error: 'the choices run from choice_a on, with no letter skipped.' }
  if (count === 1) return { error: 'a question offers no choice, or two to five: one choice is no choice.' }
  const choices = given.slice(0, count).flatMap((text, i) => (text === null ? [] : [{ letter: LETTERS[i] ?? '', text }]))
  const letter = trimmed(e['recommended'])?.toUpperCase() ?? null
  const why = trimmed(e['why'])
  if (count === 0 && letter !== null) return { error: 'recommended names one of the choices: a question without choices recommends none.' }
  if (count > 0 && (letter === null || !choices.some(choice => choice.letter === letter))) {
    return { error: `recommended is the letter of one of the choices: ${choices.map(choice => choice.letter).join(', ')}.` }
  }
  if (count > 0 && (why === null || /^[A-E]\W*$/i.test(why))) return { error: 'why argues the recommended choice against the others: a bare letter is no recommendation.' }
  const blocks = String(e['blocks'] ?? '').replace(/\s+/g, ' ').trim()
  if (blocks === '') return { error: 'blocks names what waits on his answer.' }
  if (blocks.length > ASK_BLOCKS_MAX) return { error: `blocks holds at most ${ASK_BLOCKS_MAX} characters.` }
  if (e['urgent'] !== undefined && typeof e['urgent'] !== 'boolean') return { error: 'urgent is true or false.' }
  return {
    fields: {
      subject, context, ask, choices, recommended: letter, why, blocks,
      ...(e['urgent'] === true ? { urgent: true as const } : {}),
    },
  }
}

/** A new question's id: the asking session's, the instant, and a random part, safe as a file name. */
export function askId(sessionId: string, now: Date, random: number = Math.random()): string {
  const session = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 12) || 'session'
  return `q-${session}-${now.getTime().toString(36)}-${Math.floor(random * 36 ** 4).toString(36).padStart(4, '0')}`
}

/** The object `ask` stores for one call. */
export function askedEntry(fields: AskFields, sender: AskedSender, id: string, now: Date): Asked {
  return { v: ASK_VERSION, id, sender, ...fields, status: 'open', at: now.toISOString(), answer: null, seq: 1 }
}

const turnFull = (id: string | undefined): string =>
  `this turn already asked ${id ?? 'a question'}: one question per turn. Ask this one after his answer (it wakes you), and say in the first question's blocks what waits on the others.`
const TURN_FULL = turnFull(undefined)

const isText = (value: unknown): value is string => typeof value === 'string'
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const ASKED_STATUSES: readonly Asked['status'][] = ['open', 'answered', 'withdrawn']
const ANSWER_BYS: readonly AskedAnswer['by'][] = ['tab', 'pane', 'coordinator', 'sender', 'message']
const DELIVERY_STATES: readonly NonNullable<Asked['delivery']>['state'][] = ['pending', 'sent', 'delivered', 'failed']
const REPLICA_STATES: readonly NonNullable<Asked['replica']>['state'][] = ['sent', 'acked', 'failed']

// Each optional text of a record: its value when a text, `null` when present and of another type.
function texts<K extends string>(read: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, string>> | null {
  const kept: Partial<Record<K, string>> = {}
  for (const key of keys) {
    const value = read[key]
    if (value === undefined) continue
    if (!isText(value)) return null
    kept[key] = value
  }
  return kept
}

function answerOf(read: unknown): AskedAnswer | null | undefined {
  if (read === null) return null
  if (!isRecord(read)) return undefined
  const by = ANSWER_BYS.find(known => known === read['by'])
  const [text, at, settler] = [read['text'], read['at'], read['settler']]
  const extra = texts(read, ['author', 'record'] as const)
  return by !== undefined && isText(text) && isText(at) && isText(settler) && extra !== null ? { text, by, at, settler, ...extra } : undefined
}

function deliveryOf(read: unknown): Asked['delivery'] | null {
  if (!isRecord(read)) return null
  const state = DELIVERY_STATES.find(known => known === read['state'])
  const [at, attempts] = [read['at'], read['attempts']]
  const extra = texts(read, ['reason', 'cleared'] as const)
  const refused = read['refused'] === undefined ? undefined : refusedOf(read['refused'])
  const tried = read['tried']
  if (tried !== undefined && !(Array.isArray(tried) && tried.every(isText))) return null
  return state !== undefined && isText(at) && isCount(attempts) && extra !== null && refused !== null
    ? { state, at, attempts, ...extra, ...(refused !== undefined ? { refused } : {}), ...(tried !== undefined ? { tried } : {}), ...(read['again'] === true ? { again: true as const } : {}) }
    : null
}

function refusedOf(read: unknown): NonNullable<Asked['delivery']>['refused'] | null {
  if (!isRecord(read)) return null
  const [to, sends] = [read['to'], read['sends']]
  return isText(to) && isCount(sends) ? { to, sends } : null
}

function replicaOf(read: unknown): Asked['replica'] | null {
  if (!isRecord(read)) return null
  const state = REPLICA_STATES.find(known => known === read['state'])
  const [seq, attempts, at] = [read['seq'], read['attempts'], read['at']]
  const extra = texts(read, ['reason'] as const)
  const unreached = read['unreached'] === true ? { unreached: true as const } : {}
  return state !== undefined && typeof seq === 'number' && isCount(attempts) && isText(at) && extra !== null ? { seq, state, attempts, at, ...extra, ...unreached } : null
}

/** An object `ask` stored, read back with each field of its type; null for anything else, the relay's entries included. */
export function parseAsked(text: string): Asked | null {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(o) || o['v'] !== ASK_VERSION) return null
  const [id, subject, context, ask, blocks, at, recommended, why, seq] = [o['id'], o['subject'], o['context'], o['ask'], o['blocks'], o['at'], o['recommended'], o['why'], o['seq']]
  if (!isText(id) || !isText(subject) || !isText(context) || !isText(ask) || !isText(blocks) || !isText(at) || typeof seq !== 'number') return null
  if ((recommended !== null && !isText(recommended)) || (why !== null && !isText(why))) return null
  const status = ASKED_STATUSES.find(known => known === o['status'])
  const senderRead = o['sender']
  if (status === undefined || !isRecord(senderRead)) return null
  const [session, name, role, machine] = [senderRead['session'], senderRead['name'], senderRead['role'], senderRead['machine']]
  if (!isText(session) || !isText(name) || !isText(role) || !isText(machine)) return null
  const choicesRead = o['choices']
  if (!Array.isArray(choicesRead)) return null
  const choices: AskedChoice[] = []
  for (const c of choicesRead) {
    if (!isRecord(c) || !isText(c['letter']) || !isText(c['text'])) return null
    choices.push({ letter: c['letter'], text: c['text'] })
  }
  const answer = answerOf(o['answer'] ?? null)
  if (answer === undefined) return null
  const originRead = o['origin']
  const origin = originRead === undefined ? undefined
    : isRecord(originRead) && isText(originRead['machine']) && isText(originRead['address']) ? { machine: originRead['machine'], address: originRead['address'] } : null
  const delivery = o['delivery'] === undefined ? undefined : deliveryOf(o['delivery'])
  const replica = o['replica'] === undefined ? undefined : replicaOf(o['replica'])
  const claimedRead = o['claimed']
  const claimed = claimedRead === undefined ? undefined
    : isRecord(claimedRead) && isText(claimedRead['typed']) && isText(claimedRead['at']) ? { typed: claimedRead['typed'], at: claimedRead['at'] } : null
  const movedFrom = o['movedFrom']
  if (origin === null || delivery === null || replica === null || claimed === null || (movedFrom !== undefined && !isText(movedFrom))) return null
  return {
    v: ASK_VERSION, id, sender: { session, name, role, machine }, subject, context, ask, choices, recommended, why, blocks,
    status, at, answer, seq,
    ...(o['urgent'] === true ? { urgent: true as const } : {}),
    ...(origin !== undefined ? { origin } : {}),
    ...(delivery !== undefined ? { delivery } : {}),
    ...(replica !== undefined ? { replica } : {}),
    ...(movedFrom !== undefined ? { movedFrom } : {}),
    ...(claimed !== undefined ? { claimed } : {}),
  }
}

/** The question in the method's shape, numbered among the questions asked in its turn, its id after the number. */
export function questionBlock(entry: Asked, number: { i: number; n: number }): string {
  return [
    `**Question ${number.i} of ${number.n}** (${entry.id})`,
    `_Subject_ : ${entry.subject}`,
    `_Context_ : ${entry.context}`,
    `_Question_ : ${entry.ask}`,
    ...(entry.choices.length > 0 ? ['_Choices_ :', ...entry.choices.map(choice => `- **${choice.letter}** : ${choice.text}`)] : []),
    '_Free answer_ : or answer in your own words',
    ...(entry.recommended !== null ? [`_Recommendation_ : ${entry.recommended} — ${entry.why ?? ''}`] : entry.why !== null ? [`_Recommendation_ : ${entry.why}`] : []),
  ].join('\n')
}

/**
 * A question asked with `ask` as the readers of the relay's entries see it, for what they only read
 * (the coordinator's told line and due wake): its sender's name and session, its stamp as its start,
 * what it blocks, its block from its fields. Never written back.
 */
export function askedAsEntry(entry: Asked): RoundEntry {
  return {
    id: entry.id, from: entry.sender.name, session: entry.sender.session, kind: 'operator', since: entry.at, blocks: entry.blocks,
    question: questionBlock(entry, { i: 1, n: 1 }).split('\n').slice(1).join('\n'), choices: entry.choices, recommendation: entry.recommended,
    status: entry.status, at: entry.at, answer: null, ...(entry.urgent ? { urgent: true as const } : {}),
    ...(entry.movedFrom !== undefined ? { movedFrom: entry.movedFrom } : {}),
    ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
    ...(entry.delivery !== undefined ? { delivery: entry.delivery } : {}),
  }
}

/** Every object `ask` stored in this machine's round, open or not; a file that is no such object is skipped. */
export async function readAsked($: Host<'env' | 'fs'>): Promise<Asked[]> {
  const dir = `${await dataDir($)}/${ROUND_DIR}`
  const found: Asked[] = []
  for (const file of await $.fs.list(dir).catch(() => [])) {
    if (file.kind !== 'file' || !file.name.endsWith('.json') || file.name.includes('.tmp-')) continue
    const entry = parseAsked(String(await $.fs.read(`${dir}/${file.name}`).catch(() => '')))
    if (entry !== null) found.push(entry)
  }
  return found
}

/**
 * The open questions a session asked with `ask`, each rewritten under its lock by `change` (null
 * leaves it): what its session's end and its hand-over do to them. Answers the objects written.
 */
async function changeOpenAsked($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, session: string, change: (entry: Asked) => Asked | null): Promise<Asked[]> {
  return changeAsked($, entry => entry.sender.session === session, change)
}

// The open questions `takes` selects, each read again and rewritten under its lock by `change`,
// then pushed to the coordinator on another machine. A replica is its owner's to change: never here.
async function changeAsked($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, takes: (entry: Asked) => boolean, change: (entry: Asked) => Asked | null): Promise<Asked[]> {
  const dir = `${await dataDir($)}/${ROUND_DIR}`
  const changed: Asked[] = []
  for (const entry of await readAsked($)) {
    if (entry.status !== 'open' || entry.origin !== undefined || !takes(entry)) continue
    try {
      await updateOver(storeIo($), `${dir}/${entry.id}.json`, current => {
        const fresh = current === undefined ? null : parseAsked(current)
        if (fresh === null || fresh.status !== 'open' || fresh.origin !== undefined || !takes(fresh)) return undefined
        const next = change(fresh)
        if (next === null) return undefined
        changed.push(next)
        return `${JSON.stringify(next)}\n`
      })
    } catch (err) {
      // One question not written leaves the others to change: said, never thrown.
      await logLine($, 'question', `${entry.id} not changed: ${messageOf(err)}`)
    }
  }
  for (const entry of changed) await replicate($, entry)
  for (const session of new Set(changed.filter(entry => entry.status !== 'open').map(entry => entry.sender.session))) await settleWindow($, session)
  return changed
}

// A session whose last open question closed leaves its window at rest: the ✋ belongs to the questions, not to the turn.
async function settleWindow($: Host<'env' | 'fs' | 'plugin' | 'process'>, session: string): Promise<void> {
  if (!(await readAsked($)).some(entry => entry.status === 'open' && entry.sender.session === session)) await setSessionWindow($, session, 'idle')
}

/** Its session ended, or handed over with no successor: its open questions are withdrawn by it, with why. Answers the objects withdrawn. */
export async function withdrawAsked($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, session: string, why: string, now: Date = new Date()): Promise<Asked[]> {
  return withdrawWhere($, entry => entry.sender.session === session, why, now)
}

/** Questions moved to a successor by its name alone that no session of that name runs: withdrawn by their asker, as its end would. */
export async function withdrawAskedIds($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, ids: readonly string[], why: string, now: Date = new Date()): Promise<Asked[]> {
  return ids.length === 0 ? [] : withdrawWhere($, entry => entry.sender.session === '' && ids.includes(entry.id), why, now)
}

async function withdrawWhere($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, takes: (entry: Asked) => boolean, why: string, now: Date): Promise<Asked[]> {
  const at = now.toISOString()
  const withdrawn: Asked[] = []
  for (const id of await openAskedIds($, takes)) {
    const done = await closeOwnAsked($, id, takes, at, entry => planWithdrawal(entry, why, at, false))
    if (done === null) continue
    withdrawn.push(done)
    await logLine($, 'question', `${id} withdrawn by its asker: ${why}`)
  }
  return withdrawn
}

/** Its session handed over to a successor it learnt: its open questions are the successor's, still open. Answers the objects moved. */
export async function moveAsked($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, session: string, successor: { session: string; name: string }): Promise<Asked[]> {
  const moved = await changeOpenAsked($, session, entry => ({
    ...entry, sender: { ...entry.sender, session: successor.session, name: successor.name }, movedFrom: session, seq: entry.seq + 1,
  }))
  for (const entry of moved) await logLine($, 'question', `${entry.id} moved to the successor ${successor.name}`)
  return moved
}

/**
 * Questions moved to a successor by its name alone, whose session a live record of that name now
 * names (`named`, by id): their session written, so its end and its hand-over find them.
 */
export async function nameMovedAsked($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, named: ReadonlyMap<string, string>): Promise<void> {
  if (named.size === 0) return
  const written = await changeAsked($, entry => entry.sender.session === '' && named.has(entry.id), entry => ({
    ...entry, sender: { ...entry.sender, session: named.get(entry.id) ?? entry.sender.session }, seq: entry.seq + 1,
  }))
  for (const entry of written) await logLine($, 'question', `${entry.id} now names its successor's session ${entry.sender.session}`)
}

/**
 * A prompt the operator typed in the asker's own tab (never the model's, never a command) that names
 * one open question's choice (`answersChoice`) claims that question, which leaves the pane at once.
 * Only a prompt that names exactly one open question claims: a letter two open questions both offer
 * names neither. Words that name no choice claim nothing: the question stays open and drawn, for the
 * asker to settle with its own words. Answers the ids claimed.
 */
export async function claimAsked($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, kind: string, text: string, now: Date = new Date()): Promise<string[]> {
  if (!typedByOperator(kind) || text.trimStart().startsWith('/')) return []
  const said = text.trim()
  if (said === '') return []
  const session = await $.session.id()
  const named = (await readAsked($)).filter(entry => entry.sender.session === session && entry.status === 'open' && !entry.claimed && answersChoice(said, entry.choices) !== undefined)
  if (named.length !== 1) return []
  const [target] = named
  const claimed = await changeOpenAsked($, session, entry => (entry.id !== target!.id || entry.claimed ? null : { ...entry, claimed: { typed: said, at: now.toISOString() }, seq: entry.seq + 1 }))
  return claimed.map(entry => entry.id)
}

/**
 * The asker's turn ended: each question claimed in it is answered in its tab with his words,
 * unless the turn's operator wait keeps it (`kept`): then it is open again, drawn again.
 */
export async function settleClaimed($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, kept: readonly string[], now: Date = new Date()): Promise<void> {
  const at = now.toISOString()
  const session = await $.session.id()
  await changeOpenAsked($, session, entry => {
    if (!entry.claimed || !kept.includes(entry.id)) return null
    const { claimed: _claimed, ...rest } = entry
    return { ...rest, seq: entry.seq + 1 }
  })
  const takes = (entry: Asked) => entry.sender.session === session && !!entry.claimed && !kept.includes(entry.id)
  for (const id of await openAskedIds($, takes)) {
    // Read before the lock, as the lock cannot: whether the coordinator here was shown it.
    const shown = await closesItself($, id)
    const done = await closeOwnAsked($, id, takes, at, asked => planClaimed(asked, at, shown))
    if (done === null) continue
    await logLine($, 'question', `${id} answered in its asker's tab`)
  }
}

// The ids of the open questions asked here that `takes` selects; a replica is its owner's to close.
async function openAskedIds($: Host<'env' | 'fs'>, takes: (entry: Asked) => boolean): Promise<string[]> {
  return (await readAsked($)).filter(entry => entry.status === 'open' && entry.origin === undefined && takes(entry)).map(entry => entry.id)
}

// One question asked here closed by the module through `closeRound`, read again under its lock and
// left as it is unless still open and selected by `takes`. A write that fails is one log line, so
// the others still close. Answers the object closed, or null.
async function closeOwnAsked($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, id: string, takes: (entry: Asked) => boolean, at: string, plan: (entry: Asked) => Plan): Promise<Asked | null> {
  try {
    // Its asker closes it: nothing is sent, so the closer's name is never read.
    const me: Me = { session: await $.session.id(), name: '', role: '' }
    const closed = await closeRound($, roundEntryPath(await dataDir($), id), current => {
      const fresh = current === undefined ? null : parseAsked(current)
      return fresh === null || fresh.status !== 'open' || fresh.origin !== undefined || !takes(fresh) ? null : plan(fresh)
    }, me, at)
    return closed === null || 'error' in closed ? null : parseAsked(JSON.stringify(closed.plan.entry))
  } catch (err) {
    await logLine($, 'question', `${id} not changed: ${messageOf(err)}`)
    return null
  }
}

/**
 * The open questions in the pane's order, grouped by asker, those claimed by his prompt in their
 * asker's tab left out: the askers with an urgent question
 * first, then by their earliest question; within a group, the urgent first, then in the order asked.
 */
export function askedGroups(entries: readonly Asked[]): Asked[][] {
  const byAt = (a: Asked, b: Asked) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)
  const urgentFirst = (a: Asked, b: Asked) => Number(b.urgent === true) - Number(a.urgent === true) || byAt(a, b)
  const groups = new Map<string, Asked[]>()
  for (const entry of entries.filter(e => e.status === 'open' && !e.claimed).sort(byAt)) groups.set(entry.sender.session, [...(groups.get(entry.sender.session) ?? []), entry])
  const first = (group: readonly Asked[]) => group.reduce((best, entry) => (urgentFirst(entry, best) < 0 ? entry : best))
  return [...groups.values()].sort((a, b) => urgentFirst(first(a), first(b))).map(group => [...group].sort(urgentFirst))
}

/** One line the pane draws for a question asked with `ask`: its text, how it looks, how far it is indented. */
export type AskedLine = { text: string; look: 'asker' | 'label' | 'subject' | 'context' | 'question' | 'choice' | 'recommended' | 'plain'; indent: number }

/**
 * What the pane draws of the open questions asked with `ask`: the first one only, in the pane's
 * order, read from its fields, never from a text — its asker's name, role and machine, then its
 * subject, context, question, the lettered choices with the recommended one marked, the
 * recommendation, what it blocks. The others stay stored; the next is drawn once this one is closed.
 */
export function askedLines(entries: readonly Asked[]): AskedLine[] {
  const entry = askedGroups(entries).flat()[0]
  if (entry === undefined) return []
  const { sender } = entry
  return [
    { text: `${sender.name} · ${sender.role} · ${sender.machine}`, look: 'asker', indent: 0 },
    { text: `${entry.urgent ? 'Urgent — ' : ''}${entry.subject}`, look: 'subject', indent: 2 },
    { text: entry.context, look: 'context', indent: 4 },
    { text: entry.ask, look: 'question', indent: 4 },
    ...entry.choices.map((choice): AskedLine => choice.letter === entry.recommended
      ? { text: `[${choice.letter}] ${choice.text}  ★`, look: 'recommended', indent: 4 }
      : { text: `[${choice.letter}] ${choice.text}`, look: 'choice', indent: 4 }),
    ...(entry.why !== null ? [{ text: `★ Recommendation: ${entry.recommended !== null ? `${entry.recommended} — ` : ''}${entry.why}`, look: 'plain' as const, indent: 4 }] : []),
    { text: `Blocks: ${entry.blocks}`, look: 'label', indent: 4 },
  ]
}

/** How the pane styles each kind of line: the asker and the question bold, the context dim, the recommended choice bold in `success`. */
export function askedLook(look: AskedLine['look']): Record<string, unknown> {
  switch (look) {
    case 'asker': return { bold: true, color: 'suggestion' }
    case 'subject': case 'question': return { bold: true }
    case 'context': return { dimColor: true }
    case 'recommended': return { bold: true, color: 'success' }
    default: return {}
  }
}

// The host name, read once per module load: the machine an asker runs on.
let machine: string | null = null
async function machineOf($: Host<'process'>): Promise<string> {
  if (machine === null) {
    const run = await $.process.run(['hostname', '-s'], { timeoutMs: 2000 }).catch(() => null)
    machine = machineLabel(run?.exitCode === 0 ? String(run.stdout ?? '') : '')
  }
  return machine
}

// The questions asked in the main thread's current turn, by id: a turn asks one (callAsk refuses a second,
// so the operator is never given two blocks at once). A turn's start empties it (registerQuestion's turn.start).
const thisTurn: string[] = []

// The open questions this turn asked again, which stored nothing (askOne): none uses up the turn's question.
const askedAgain = new Set<string>()

// Held by the `ask` call that is storing this turn's question, from the check to the end: two calls made
// together find the place taken, whatever order their awaits finish in.
let asking = false

/** The main thread's turn started: it may ask one question again. */
export function askTurnStarted(): void {
  thisTurn.length = 0
  askedAgain.clear()
  asking = false
}

/** A question was asked in this turn: the turn has asked its one. */
export function askedInTurn(id: string): void {
  thisTurn.push(id)
}

/** Whether the main thread's current turn asked this question. */
export function isAskedInTurn(id: string): boolean {
  return thisTurn.includes(id)
}

/** Whether the main thread's current turn asked this open question again. */
export function isAskedAgainInTurn(id: string): boolean {
  return askedAgain.has(id)
}

// The answers that are the operator's own: given in the asker's tab (naming one choice), in the pane
// or through the coordinator. An answer relayed by a message, or a withdrawal, records nothing.
const OWN_ANSWERS: readonly string[] = ['tab', 'pane', 'coordinator']

/** The newest answer of his own to a question asking the same, in the round or its archive; null when none. */
export async function recordedAsked($: Host<'env' | 'fs'>, entry: Asked): Promise<Asked | null> {
  const key = askedKey(entry)
  const archived: Asked[] = []
  const dir = `${await dataDir($)}/${ROUND_DIR}/${ROUND_ARCHIVE_DIR}`
  for (const file of await $.fs.list(dir).catch(() => [])) {
    if (file.kind !== 'file' || !file.name.endsWith('.json') || file.name.includes('.tmp-')) continue
    const read = parseAsked(String(await $.fs.read(`${dir}/${file.name}`).catch(() => '')))
    if (read !== null) archived.push(read)
  }
  let found: Asked | null = null
  for (const other of [...await readAsked($), ...archived]) {
    if (other.status !== 'answered' || other.answer === null || !OWN_ANSWERS.includes(other.answer.by) || other.answer.record !== undefined) continue
    if (askedKey(other) !== key) continue
    // Words typed in a tab are his answer only when they name one choice unambiguously, as the relay's record holds.
    if (other.answer.by === 'tab' && !answersChoice(other.answer.text, other.choices)) continue
    if (found === null || other.answer.at > (found.answer?.at ?? '')) found = other
  }
  return found
}

/** What the tool answers to one call; `now` is the instant it records. */
export async function callAsk($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'tool'>, e: Record<string, unknown>, now: Date = new Date()): Promise<Answer> {
  if (e['agentId']) return refuse('a subagent asks its session, in its answer: only the main thread asks the operator.')
  const parsed = parseAsk(e)
  if ('error' in parsed) return refuse(parsed.error)
  // One question per turn, by construction: the place is taken here, before any await, so two calls made together
  // find it taken; askOne refuses a question that would be stored as a second (a twin or a record is no second).
  if (asking) return refuse(TURN_FULL)
  asking = true
  try {
    return await askOne($, parsed.fields, now)
  } finally {
    asking = false
  }
}

// The one question of this turn, validated: stored in the round, or answered from its record or its open twin.
async function askOne($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'tool'>, fields: AskFields, now: Date): Promise<Answer> {
  const me = await whoAmI($)
  if (me === null) {
    return refuse('Only an orchestrator, a coordinator or an auditor asks with `ask`, once the host names it; an agent asks the session that launched it, by message.')
  }
  const sessionId = await $.session.id()
  const sender = { session: sessionId, name: me.name, role: me.role, machine: await machineOf($) }
  const made = askedEntry(fields, sender, askId(sessionId, now), now)
  // A question its project already had him answer is answered from that record, and not put to him again.
  const record = await recordedAsked($, made).catch(() => null)
  const entry: Asked = record?.answer
    ? { ...made, status: 'answered', answer: { text: record.answer.text, by: record.answer.by, at: record.answer.at, settler: me.name, record: record.id } }
    : made
  // A question still open in the round is not stored twice: the oldest entry already there is the one he
  // answers. A replica is its owner's, and a claimed question is off the pane, closed by the next turn's
  // end with his typed words: neither holds a new ask back. The asker's session is not compared: the key
  // is the project's.
  let twin: Asked | null = null
  if (!record?.answer) {
    const key = askedKey(made)
    for (const other of await readAsked($).catch(async err => {
      await logLine($, 'question', `open twin of ${made.id} not looked for: ${messageOf(err)}`)
      return []
    })) {
      if (other.status !== 'open' || other.origin !== undefined || other.claimed !== undefined || askedKey(other) !== key) continue
      if (twin === null || other.at < twin.at) twin = other
    }
  }
  if (twin !== null) {
    // Open is not seen: whether its block ever reached him is nowhere recorded, so showing it again stays possible.
    askedAgain.add(twin.id)
    return { result: `Not stored: this question is already open as ${twin.id}, asked ${twin.at}. Refer to it by its subject and do not write it again in the chat, unless he never got its block in a turn's last text or you present it to him again: then write it in this turn's last text, after every tool call (declare_wait included). Its block:\n\n${questionBlock(twin, { i: 1, n: 1 })}` }
  }
  if (!record?.answer && thisTurn.length > 0) return refuse(turnFull(thisTurn[0]))
  const path = roundEntryPath(await dataDir($), entry.id)
  let taken = false
  try {
    await updateOver(storeIo($), path, current => {
      taken = current !== undefined
      return taken ? undefined : `${JSON.stringify(entry)}\n`
    })
  } catch (err) {
    await logLine($, 'question', `question not stored for ${me.name}: ${messageOf(err)}`)
    return refuse(`the question could not be stored (${messageOf(err)}); nothing was shown to the operator, ask again.`)
  }
  if (taken) return refuse(`a question with the id ${entry.id} is already in the round; ask again.`)
  await replicate($, entry)
  // The ✋ is the question's: the asker's window shows it while the question is open.
  await setSessionWindow($, entry.sender.session, 'asks')
  if (record?.answer) {
    return { result: `Answered from the record, not asked again: the operator answered this question on ${record.answer.at} by ${record.answer.by} — ${record.answer.text} (question ${record.id}). Stored as ${entry.id}, answered.` }
  }
  // The turn's one question: « Question 1 of 1 », whatever stays open from an earlier turn.
  askedInTurn(entry.id)
  const block = questionBlock(entry, { i: 1, n: 1 })
  // The block goes in the asker's own message: a line of the host's log does not reach the operator's chat.
  return { result: `Asked as ${entry.id}: stored in the round. Write this block in your message as it stands, once, in your turn's last text, after every tool call (declare_wait included): the operator may see that text alone.\n\n${block}` }
}

/**
 * The `settle` tool: the entry closed through `closeRound` as `planAsked` or `planRelayed` decides,
 * then the work the answer asks added to the asker's list. Answers the tool's reply.
 */
export async function settle($: Held, request: SettleRequest, now: Date = new Date()): Promise<Answer> {
  const who = await whoAmI($)
  if (who === null) return refuse('Only an orchestrator, a coordinator or an auditor settles a question, once the host names it.')
  const me: Me = { ...who, session: await $.session.id() }
  const path = roundEntryPath(await dataDir($), request.id)
  const at = now.toISOString()
  // Read before the lock, the one fact the lock cannot read: whether the coordinator here was shown it.
  const shown = await closesItself($, request.id)
  // Read only where it can matter: the machine-wide decide is an orchestrator's. A coordinator that
  // registers between this read and the lock is not seen: the one race, the width of one `ps`.
  const coordinatorLive = me.role === 'orchestrator' ? await coordinatorRuns($) : true
  let closed: Awaited<ReturnType<typeof closeRound>>
  try {
    closed = await closeRound($, path, current => {
      const asked = current === undefined ? null : parseAsked(current)
      const relayed = asked !== null || current === undefined ? null : parseRoundEntry(current)
      if (asked !== null) return planAsked(asked, request, me, at, shown, coordinatorLive)
      if (relayed !== null) return planRelayed(relayed, request, me, at, shown)
      if (current !== undefined) return { error: `${request.id} is no round entry settle can read (half-written, or of another shape): nothing changed.` }
      return { error: `no entry ${request.id} in the round.` }
    }, me, at)
  } catch (err) {
    await logLine($, 'question', `${request.id} not settled: ${messageOf(err)}`)
    return refuse(`${request.id} could not be written (${messageOf(err)}); nothing changed, settle it again.`)
  }
  if (closed === null) return refuse(`no entry ${request.id} in the round.`)
  if ('error' in closed) return refuse(closed.error)
  const done = closed.plan
  const said = [`Settled ${request.id}: ${String(done.entry['status'])}.`, ...closed.said]
  if (request.work !== null) {
    const own = done.asker.session === me.session
    const made = await callTodo($, { ...request.owner, action: 'add', words: request.work, ...(own ? {} : { to: done.asker.name }) }, now)
    said.push(made.isError ? `The work it asks is not recorded: ${made.result}` : made.result)
  }
  return { result: said.join(' ') }
}

/**
 * His answer given in the coordinator's pane to a question asked with `ask`: the object read again
 * and written under its lock, answered by the pane, so a question settled, withdrawn or claimed in
 * its asker's tab meanwhile is left as it is; then the answer sent to its
 * asker at once, a send not delivered written on the object, which the pane then shows. Answers
 * the object answered, or null when it was not.
 */
export async function answerAskedFromPane($: Held & Host<'prompt'>, id: string, text: string, now: Date = new Date()): Promise<Asked | null> {
  const said = text.trim()
  if (said === '') return null
  const who = await whoAmI($)
  const me: Me = { session: await $.session.id(), name: who?.name ?? "the coordinator's pane", role: who?.role ?? 'coordinator' }
  const path = roundEntryPath(await dataDir($), id)
  const at = now.toISOString()
  try {
    const closed = await closeRound($, path, current => {
      const entry = current === undefined ? null : parseAsked(current)
      return entry === null ? null : planPane(entry, said, me, at)
    }, me, at, () => logLine($, 'question', `${id} answered in the pane`))
    if (closed === null || 'error' in closed) return null
    if (closed.plan.deliver === 'own') await deliverSettled($, path, closed.plan, at, () => submitSettled($, closed.plan, me))
    return parseAsked(JSON.stringify(closed.plan.entry))
  } catch (err) {
    await logLine($, 'question', `${id} not answered from the pane: ${messageOf(err)}`)
    return null
  }
}

// The journal's memory for the answers: pruned once per process, at its first write.
const answering: Memory = { now: () => new Date(), pruned: false, pending: null }

// The operator's answer to a question of the round, in the orchestrator's journal (core's
// answerEvent): what was asked and how he answered, never his words, the entry's file under the
// configuration directory as its ruling. A journal that cannot be written is one log line (observe.ts).
async function journalAnswer($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>, path: string, done: Plan): Promise<void> {
  const config = await configDir($)
  const ruling = path.startsWith(`${config}/`) ? path.slice(config.length + 1) : null
  const entry = done.entry
  const choicesRead = entry['choices']
  const choices = Array.isArray(choicesRead)
    ? choicesRead.flatMap(c => (isRecord(c) && isText(c['letter']) && isText(c['text']) ? [{ letter: c['letter'], text: c['text'] }] : []))
    : []
  const recommendedRead = entry['v'] === ASK_VERSION ? entry['recommended'] : entry['recommendation']
  const recommended = isText(recommendedRead) ? recommendedRead : null
  await write($, answering, stamp => {
    const event = answerEvent({
      at: stamp.at, random: stamp.random(), plugin: PLUGIN,
      subject: subjectOf({}),
      context: { session: stamp.session, role: stamp.role },
      given: answerGiven(done.answerWords, { choices, recommended }),
      ruling,
    })
    return event === undefined ? [] : [event]
  })
}

/**
 * The one closure of a round entry (design §4.3), whoever closes it — `settle`, the pane, the words
 * typed in its asker's tab, its session's end: the entry read again and written under its lock as
 * `decide` plans it (null leaves it), `written` run once it is, then his answer journaled, the
 * relay's fingerprint forgotten, the coordinator here told, the answer sent to its asker or to its
 * owner's machine (an answer to the closing session's own question, `own`, is its caller's to
 * submit: answerAskedFromPane), and the object pushed to a coordinator on another machine. Answers the plan and
 * what its steps said, the refusal, or null; a write that fails throws.
 */
export async function closeRound(
  $: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, path: string, decide: (current: string | undefined) => Plan | { error: string } | null, me: Me, at: string,
  written?: () => Promise<void>,
): Promise<{ plan: Plan; said: string[] } | { error: string } | null> {
  const held: { plan: Plan | { error: string } | null } = { plan: null }
  await updateOver(storeIo($), path, current => {
    const plan = held.plan = decide(current)
    return plan === null || 'error' in plan ? undefined : `${JSON.stringify(plan.entry)}\n`
  })
  const done = held.plan
  if (done === null) return null
  if ('error' in done) return { error: done.error }
  await written?.()
  const said: string[] = []
  if (done.answeredBy !== null) await journalAnswer($, path, done)
  const relay = done.entry['v'] === ASK_VERSION ? null : parseRoundEntry(JSON.stringify(done.entry))
  const asked = done.entry['v'] === ASK_VERSION ? parseAsked(JSON.stringify(done.entry)) : null
  if (asked !== null && asked.status !== 'open') await settleWindow($, asked.sender.session)
  if (done.relayed && relay !== null) await forgetRelayed($, relay)
  if (done.told) {
    // The notice reads a relay entry's fields: an object `ask` stored is told as one.
    const told = asked ? askedAsEntry(asked) : relay
    const answer = done.entry['answer']
    if (told !== null && isRoundAnswer(answer)) await tellSettled($, [{ entry: told, answer }])
  }
  if (done.deliver === 'now') said.push(await deliverSettled($, path, done, at, () => sendSettled($, done, me)))
  if (done.deliver === 'remote') {
    const refused = await sendReply($, String(done.entry['id']))
    said.push(refused === null ? `The answer goes to ${done.asker.name} on its machine now.` : `Not delivered yet to ${done.asker.name} (${refused}): the round's next readings send it again, or say it failed.`)
  }
  if (done.deliver !== 'remote' && asked !== null) await replicate($, asked)
  return { plan: done, said }
}

/**
 * The answers not delivered the operator clears from the pane: each one still failed is marked
 * cleared on its object, then drawn and sent no more. A write that fails is a log line.
 */
export async function clearFailed($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process'>, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    try {
      let written = false
      await updateOver(storeIo($), roundEntryPath(await dataDir($), id), current => {
        const now = current === undefined ? null : parseAsked(current)
        written = now?.delivery?.state === 'failed'
        return written ? `${JSON.stringify({ ...now, delivery: { ...now!.delivery, cleared: new Date().toISOString() } })}\n` : undefined
      })
      if (written) await logLine($, 'question', `the answer to ${id} not delivered: its line cleared in the pane`)
    } catch (err) {
      await logLine($, 'question', `the line of the answer to ${id} not cleared: ${messageOf(err)}`)
    }
  }
}

// The answer sent to its asker by message — its session while it has a row here (two sessions may
// share a name), else its name: the host's reason when it is not delivered, else null.
async function sendSettled($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, done: Plan, me: Me): Promise<string | null> {
  const live = done.asker.session !== '' && sessionKey(done.asker.session) in await readSessions($)
  const sent = await $.session.send({ to: live ? { sessionId: done.asker.session } : done.asker.name, text: settledMessage(done.entry, me) })
  return sent?.isDelivered ? null : sent?.reason ?? 'no answer'
}

// The answer submitted to this session's own turn, when it asked the question itself: no message
// reaches the session that sends it. The host's reason when it drops the prompt, else null.
async function submitSettled($: Host<'prompt'>, done: Plan, me: Me): Promise<string | null> {
  const taken = await $.prompt.submit({ text: settledMessage(done.entry, me) })
  return taken && typeof taken === 'object' && 'drop' in taken && taken.drop ? String(taken.drop) : null
}

// The answer taken to its asker at once by `send`, then its outcome written on the entry while it
// still holds that answer: delivered, or failed with the host's reason, which the pane then shows.
async function deliverSettled($: Host<'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'ui'>, path: string, done: Plan, at: string, send: () => Promise<string | null>): Promise<string> {
  let reason: string | null = null
  try {
    reason = await send()
  } catch (err) {
    reason = messageOf(err)
  }
  const delivery = { state: reason === null ? 'delivered' : 'failed', at: new Date().toISOString(), attempts: 1, ...(reason !== null ? { reason } : {}) }
  try {
    await updateOver(storeIo($), path, current => {
      const now = current === undefined ? null : parseAsked(current)
      return now !== null && now.answer?.at === at ? `${JSON.stringify({ ...now, delivery })}\n` : undefined
    })
  } catch (err) {
    await logLine($, 'question', `the delivery of ${String(done.entry['id'])} not written: ${messageOf(err)}`)
  }
  if (reason === null) return `Sent to ${done.asker.name}.`
  await logLine($, 'question', `the answer to ${String(done.entry['id'])} was not delivered to ${done.asker.name}: ${reason}`)
  return `Not delivered to ${done.asker.name} (${reason}): the entry says so; tell it by message.`
}

// Whether the session is an agent at its start; a role that cannot be told keeps the tool.
async function agentAtStart($: Host<'env' | 'fs' | 'plugin' | 'process' | 'session'>): Promise<boolean> {
  try {
    return await sessionRole($, await $.session.id()) === 'agent'
  } catch (err) {
    await logLine($, 'question', `role at start not read: ${messageOf(err)}`)
    return false
  }
}

export function register(on: On<Held>): void {
  on('session.start', {}, async ($, e, next) => {
    try {
      // An agent asks its launcher, never the operator: the tool is not registered for it.
      if (await agentAtStart($)) return next(e)
      await $.tool.register({
        name: ASK_TOOL,
        isDeferred: false,
        description: 'Asks the operator one question, in the method\'s format: the module stores it in the round, where the pane draws it, and answers its block, which you write in your message as it stands. '
          + 'One question per turn: a second call in the same turn is refused, ask it after his answer. '
          + 'subject (a few words), context (two to six sentences: the stake, what is known), question (one sentence ending in « ? »), '
          + 'choice_a to choice_e (none, or two to five, each a different piece of work with its cost and gain), recommended (the letter) and why (its argument against the others), '
          + 'blocks (what waits on the answer), urgent (true to have it presented at once). '
          + 'For an orchestrator, a coordinator or an auditor.',
        inputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string' },
            context: { type: 'string' },
            question: { type: 'string' },
            ...Object.fromEntries(CHOICE_FIELDS.map(field => [field, { type: 'string' }])),
            recommended: { type: 'string', enum: [...LETTERS] },
            why: { type: 'string' },
            blocks: { type: 'string', maxLength: ASK_BLOCKS_MAX },
            urgent: { type: 'boolean' },
          },
          required: ['subject', 'context', 'question', 'blocks'],
        },
      })
    } catch (err) {
      await logLine($, 'question', `${ASK_TOOL} not registered: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'question', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('turn.start', {}, async ($, e, next) => {
    if (e.agentId === undefined) askTurnStarted()
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'question', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // His prompt in the asker's own tab claims the one open question its choice names, if any: it leaves the pane at once.
  on('prompt.submit', {}, async ($, e, next) => {
    try {
      await claimAsked($, String(e.origin?.kind ?? ''), String(e.text ?? ''))
    } catch (err) {
      await logLine($, 'question', `claim: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'question', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  // The asker's turn ended: what it claimed is answered with his words, but what its operator wait keeps.
  on('turn.complete', {}, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // Read before the first await: a message queued for the session starts its next turn as this one ends.
    const wait = DECLARATIONS.current()
    const kept = wait?.kind === 'operator' ? wait.asked ?? [] : []
    try {
      await settleClaimed($, kept)
    } catch (err) {
      await logLine($, 'question', `claimed: ${messageOf(err)}`)
    }
    try {
      await resendReplicas($)
    } catch (err) {
      await logLine($, 'question', `pushes: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'question', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('tool.call', { tool: `mcp__orchestrator__${ASK_TOOL}` }, async ($, e) => callAsk($, e)).catch(async ($, e, next) => {
    await logLine($, 'question', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: 'the question could not be asked; the module\'s log says why', isError: true }
  })
}

// The settle tool, registered at each start beside ask, for every main session but an agent's.
export function registerSettle(on: On<Held>): void {
  on('session.start', {}, async ($, e, next) => {
    try {
      if (await agentAtStart($)) return next(e)
      await $.tool.register({
        name: SETTLE_TOOL,
        isDeferred: false,
        description: 'Closes a question of the round by its id; one asked with ask is sent its answer at once. '
          + 'outcome: `answered-here` (he answered in this tab; answer: his words or letter), `answered-by-message` (his answer to your own question reached you by a message; answer, and author: that session), '
          + '`withdrawn` (reason: the evidence, or what made it moot). work: the work his answer asks, in his words, recorded as a to-do of the asker, '
          + 'with who takes it or what it waits on as todo add takes them (row, agent, or waits_on, why, until and deadline). '
          + 'For an orchestrator, a coordinator or an auditor.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            outcome: { type: 'string', enum: [...OUTCOMES] },
            answer: { type: 'string' },
            reason: { type: 'string' },
            author: { type: 'string' },
            work: { type: 'string' },
            row: { type: 'integer' },
            agent: { type: 'string' },
            waits_on: { type: 'string' },
            why: { type: 'string' },
            until: { type: 'string' },
            deadline: { type: 'string' },
          },
          required: [],
        },
      })
    } catch (err) {
      await logLine($, 'question', `${SETTLE_TOOL} not registered: ${messageOf(err)}`)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await logLine($, 'question', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('tool.call', { tool: `mcp__orchestrator__${SETTLE_TOOL}` }, async ($, e) => {
    if (e['agentId']) return refuse('a subagent settles nothing: only the main thread settles a question.')
    const parsed = parseSettle(e)
    return 'error' in parsed ? refuse(parsed.error) : settle($, parsed.request)
  }).catch(async ($, e, next) => {
    await logLine($, 'question', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: 'the question could not be settled; the module\'s log says why', isError: true }
  })
}
