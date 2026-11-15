// hooks/question.ts
// The `ask` tool: a question to the operator made by one call, its fields flat (the host once dropped a
// nested field), validated against the method's question format
// (plugins/method/skills/lifecycle/references/questions.md) and stored as its own object in the
// round, `round/<id>.json`, with a format version that tells it from the closing proposals the relay
// writes (round.ts). The id is the module's, given at creation; each call is one
// object, settled and delivered on its own. The module writes the question block into the
// transcript itself, so the model does not write it. Any main session that keeps a list asks with
// it: an orchestrator, a coordinator, an auditor; an agent asks the session that launched it.
//
// The `settle` tool closes a question by its id, here: its one closure function writes every close
// of a round question, the object `ask` stored or the relay's entry (settle.ts decides what it
// writes), then records the consent it asked, sends the answer of a question asked with `ask` to its
// asker at once when another session settles it, and records the work the answer asks as a to-do of
// the asker. The pane, the words typed in the asker's tab and its session's end close through the
// same function (closeRound).
import { updateOver } from '../core/store-io.ts'
import { consentPath } from '../core/consent-record.ts'
import { answersChoice, CONSENT_GRANT, CONSENT_KINDS, CONSENT_REFUSE, DEPLOY_ENVS, grants, parseConsentSubject, type ConsentSubject } from '../core/consent-record.ts'
import { typedByOperator } from './models-guard.ts'
import { DECLARATIONS } from './wait.ts'
import { machineLabel } from './remote-row.ts'
import { plainText, type RoundEntry } from './round.ts'
import { parseSessionName } from '../core/names.ts'
import { callTodo, whoAmI } from './todo.ts'
import { closesItself, forgetRelayed, parseRoundEntry, readBlock, readSessions, sessionKey, sessionRole, tellSettled, transcriptPathOf, writeConsent } from './supervision.ts'
import { scanTail } from './session-name.ts'
import { asksWords, isHisTurn, humanTurn, judgeWords, parseWords, wordsRecord, WORDS_FIELDS, type Words } from './consent-words.ts'
import { OUTCOMES, SETTLE_TOOL, parseSettle, planAsked, planClaimed, planPane, planRelayed, planWithdrawal, settledMessage, type Fields, type Me, type Plan, type SettleRequest } from './settle.ts'
import { configDir, logLine, stateDir, storeIo, writeAtomic } from './module-io.ts'
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
  consent?: ConsentSubject
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
   * answer given here on its way to the owner (pending, then sent), delivered once acknowledged.
   */
  delivery?: { state: 'pending' | 'sent' | 'delivered' | 'failed'; at: string; attempts: number; reason?: string }
  /** A replica (remote-asked.ts): the owner's machine, and the address its last push came from. */
  origin?: { machine: string; address: string }
  /** On the owner's machine: the push of this `seq` to the coordinator on another machine, and how it went. */
  replica?: { seq: number; state: 'sent' | 'acked' | 'failed'; attempts: number; at: string; reason?: string }
  /** The session it was asked by, before a succession moved it to its successor. */
  movedFrom?: string
  /** What the operator typed in its asker's tab while it was open: off the pane until that turn's end answers it. */
  claimed?: { typed: string; at: string }
  seq: number
}

type Answer = { result: string; isError?: true }
const refuse = (result: string): Answer => ({ result, isError: true })

const trimmed = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** The call's fields as the method's question, or why they are none. */
export function parseAsk(e: Record<string, unknown>): { fields: AskFields } | { error: string } {
  for (const field of ['subject', 'context', 'question', 'recommended', 'why', 'blocks', ...CHOICE_FIELDS, 'consent_kind', 'consent_repo', 'consent_env']) {
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
  const choices = given.slice(0, count).map((text, i) => ({ letter: LETTERS[i] as string, text: text as string }))
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
  const consented = consentOf(e, choices)
  if (consented !== null && 'error' in consented) return consented
  return {
    fields: {
      subject, context, ask, choices, recommended: letter, why, blocks,
      ...(e['urgent'] === true ? { urgent: true as const } : {}),
      ...(consented !== null ? { consent: consented.consent } : {}),
    },
  }
}

// The consent the question asks, its subject read as declare_wait reads it; its choices are then the
// two the consent record knows, « Accorder » then « Refuser », so that his answer grants or refuses.
function consentOf(e: Record<string, unknown>, choices: readonly AskedChoice[]): { consent: ConsentSubject } | { error: string } | null {
  const given = Object.fromEntries([['kind', e['consent_kind']], ['repo', e['consent_repo']], ['pr', e['consent_pr']], ['env', e['consent_env']]].filter(([, value]) => value !== undefined))
  if (Object.keys(given).length === 0) return null
  const consent = parseConsentSubject(given)
  if (consent === undefined) {
    return { error: `consent is consent_kind with consent_repo (owner/name): "e2e-waiver" or "norms-waiver" with consent_pr, "e2e-exemption" or "auto-merge" alone, "auto-deploy" with consent_env (${DEPLOY_ENVS.join(', ')}).` }
  }
  const named = choices.length === 2 && choices[0]?.text === CONSENT_GRANT && choices[1]?.text === CONSENT_REFUSE
  if (!named) return { error: `a question that asks consent offers two choices: choice_a "${CONSENT_GRANT}", choice_b "${CONSENT_REFUSE}".` }
  return { consent }
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

const isText = (value: unknown): value is string => typeof value === 'string'
const ASKED_STATUSES: readonly string[] = ['open', 'answered', 'withdrawn']

/** An object `ask` stored, read back with each field of its type; null for anything else, the relay's entries included. */
export function parseAsked(text: string): Asked | null {
  let e: unknown
  try {
    e = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return null
  const o = e as Record<string, unknown>
  const sender = o['sender'] as Record<string, unknown> | null | undefined
  const fine = o['v'] === ASK_VERSION
    && [o['id'], o['subject'], o['context'], o['ask'], o['blocks'], o['at']].every(isText)
    && typeof sender === 'object' && sender !== null && ['session', 'name', 'role', 'machine'].every(key => isText(sender[key]))
    && Array.isArray(o['choices']) && o['choices'].every((c: unknown) => typeof c === 'object' && c !== null && isText((c as AskedChoice).letter) && isText((c as AskedChoice).text))
    && (o['recommended'] === null || isText(o['recommended'])) && (o['why'] === null || isText(o['why']))
    && isText(o['status']) && ASKED_STATUSES.includes(o['status'])
    && typeof o['seq'] === 'number'
    && (o['consent'] === undefined || parseConsentSubject(o['consent']) !== undefined)
    && (o['origin'] === undefined || (typeof o['origin'] === 'object' && o['origin'] !== null && ['machine', 'address'].every(key => isText((o['origin'] as Record<string, unknown>)[key]))))
  return fine ? o as unknown as Asked : null
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
 * The block as the transcript shows it: one line per row, the host drawing a row's text as one line,
 * its markup dropped, which a transcript row does not draw.
 */
export function shownLines(block: string): string[] {
  return block.split('\n').map(line => plainText(line))
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
  const dir = `${await stateDir($)}/round`
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
async function changeOpenAsked($: Host<'env' | 'fs' | 'process' | 'clock'>, session: string, change: (entry: Asked) => Asked | null): Promise<Asked[]> {
  return changeAsked($, entry => entry.sender.session === session, change)
}

// The open questions `takes` selects, each read again and rewritten under its lock by `change`,
// then pushed to the coordinator on another machine. A replica is its owner's to change: never here.
async function changeAsked($: Host<'env' | 'fs' | 'process' | 'clock'>, takes: (entry: Asked) => boolean, change: (entry: Asked) => Asked | null): Promise<Asked[]> {
  const dir = `${await stateDir($)}/round`
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
  return changed
}

/** Its session ended, or handed over with no successor: its open questions are withdrawn by it, with why. Answers the objects withdrawn. */
export async function withdrawAsked($: Held, session: string, why: string, now: Date = new Date()): Promise<Asked[]> {
  return withdrawWhere($, entry => entry.sender.session === session, why, now)
}

/** Questions moved to a successor by its name alone that no session of that name runs: withdrawn by their asker, as its end would. */
export async function withdrawAskedIds($: Held, ids: readonly string[], why: string, now: Date = new Date()): Promise<Asked[]> {
  return ids.length === 0 ? [] : withdrawWhere($, entry => entry.sender.session === '' && ids.includes(entry.id), why, now)
}

async function withdrawWhere($: Held, takes: (entry: Asked) => boolean, why: string, now: Date): Promise<Asked[]> {
  const at = now.toISOString()
  const withdrawn: Asked[] = []
  for (const id of await openAskedIds($, takes)) {
    const done = await closeOwnAsked($, id, takes, at, entry => planWithdrawal(entry as never, why, at, false))
    if (done === null) continue
    withdrawn.push(done)
    await logLine($, 'question', `${id} withdrawn by its asker: ${why}`)
  }
  return withdrawn
}

/** Its session handed over to a successor it learnt: its open questions are the successor's, still open. Answers the objects moved. */
export async function moveAsked($: Host<'env' | 'fs' | 'process' | 'clock'>, session: string, successor: { session: string; name: string }): Promise<Asked[]> {
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
export async function nameMovedAsked($: Host<'env' | 'fs' | 'process' | 'clock'>, named: ReadonlyMap<string, string>): Promise<void> {
  if (named.size === 0) return
  const written = await changeAsked($, entry => entry.sender.session === '' && named.has(entry.id), entry => ({
    ...entry, sender: { ...entry.sender, session: named.get(entry.id) as string }, seq: entry.seq + 1,
  }))
  for (const entry of written) await logLine($, 'question', `${entry.id} now names its successor's session ${entry.sender.session}`)
}

// What the operator typed, as an answer keeps it: past this many characters it is cut, the cut said.
const TYPED_CAP = 500

/**
 * A prompt the operator typed in the asker's own tab (never the model's, never a command): its open
 * questions are claimed with his words, and leave the pane at once. Answers the ids claimed.
 */
export async function claimAsked($: Host<'env' | 'fs' | 'process' | 'clock' | 'session'>, kind: string, text: string, now: Date = new Date()): Promise<string[]> {
  if (!typedByOperator(kind) || text.trimStart().startsWith('/')) return []
  const said = text.trim()
  const typed = said.length > TYPED_CAP ? `${said.slice(0, TYPED_CAP)}\n[cut at ${TYPED_CAP} of ${said.length} characters]` : said
  if (typed === '') return []
  const claimed = await changeOpenAsked($, await $.session.id(), entry => (entry.claimed ? null : { ...entry, claimed: { typed, at: now.toISOString() }, seq: entry.seq + 1 }))
  return claimed.map(entry => entry.id)
}

/**
 * The asker's turn ended: each question claimed in it is answered in its tab with his words, its
 * consent recorded when they name « Accorder » alone, unless the turn's operator wait keeps it
 * (`kept`): then it is open again, drawn again.
 */
export async function settleClaimed($: Held, kept: readonly string[], now: Date = new Date()): Promise<void> {
  const at = now.toISOString()
  const session = await $.session.id()
  await changeOpenAsked($, session, entry => {
    if (!entry.claimed || !kept.includes(entry.id)) return null
    const { claimed: _claimed, ...rest } = entry
    return { ...rest, seq: entry.seq + 1 }
  })
  const takes = (entry: Asked) => entry.sender.session === session && !!entry.claimed && !kept.includes(entry.id)
  for (const id of await openAskedIds($, takes)) {
    let refused = false
    const done = await closeOwnAsked($, id, takes, at, entry => {
      const asked = entry as unknown as Asked
      const chosen = asked.consent ? answersChoice(asked.claimed?.typed ?? '', asked.choices) : null
      refused = !!asked.consent && (!chosen || !grants(chosen.text))
      return planClaimed(entry, chosen && !refused ? `${chosen.letter} : ${chosen.text}` : null, at)
    })
    if (done === null) continue
    await logLine($, 'question', `${id} answered in its asker's tab`)
    if (refused) await logLine($, 'question', `the words typed for ${id} are not one unambiguous « ${CONSENT_GRANT} », no consent recorded`)
  }
}

// The ids of the open questions asked here that `takes` selects; a replica is its owner's to close.
async function openAskedIds($: Host<'env' | 'fs'>, takes: (entry: Asked) => boolean): Promise<string[]> {
  return (await readAsked($)).filter(entry => entry.status === 'open' && entry.origin === undefined && takes(entry)).map(entry => entry.id)
}

// One question asked here closed by the module through `closeRound`, read again under its lock and
// left as it is unless still open and selected by `takes`. A write that fails is one log line, so
// the others still close. Answers the object closed, or null.
async function closeOwnAsked($: Held, id: string, takes: (entry: Asked) => boolean, at: string, plan: (entry: Fields) => Plan): Promise<Asked | null> {
  try {
    // Its asker closes it: nothing is sent, so the closer's name is never read.
    const me: Me = { session: await $.session.id(), name: '', role: '' }
    const closed = await closeRound($, `${await stateDir($)}/round/${id}.json`, current => {
      const fresh = current === undefined ? null : parseAsked(current)
      return fresh === null || fresh.status !== 'open' || fresh.origin !== undefined || !takes(fresh) ? null : plan(fresh as unknown as Fields)
    }, me, at)
    return closed === null || 'error' in closed ? null : closed.plan.entry as unknown as Asked
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
  const first = (group: readonly Asked[]) => [...group].sort(urgentFirst)[0] as Asked
  return [...groups.values()].sort((a, b) => urgentFirst(first(a), first(b))).map(group => [...group].sort(urgentFirst))
}

/** One line the pane draws for a question asked with `ask`: its text, how it looks, how far it is indented. */
export type AskedLine = { text: string; look: 'asker' | 'label' | 'subject' | 'context' | 'question' | 'choice' | 'recommended' | 'plain'; indent: number }

/**
 * What the pane draws of the open questions asked with `ask`, read from their fields, never from a
 * text: each asker once, its name, role and machine, then each of its questions — subject, context,
 * question, the lettered choices with the recommended one marked, the recommendation, what it blocks.
 */
export function askedLines(entries: readonly Asked[]): AskedLine[] {
  return askedGroups(entries).flatMap(group => {
    const sender = group[0]?.sender
    if (sender === undefined) return []
    const head: AskedLine = { text: `${sender.name} · ${sender.role} · ${sender.machine}`, look: 'asker', indent: 0 }
    return [head, ...group.flatMap((entry, k): AskedLine[] => [
      { text: `${entry.urgent ? 'Urgent — ' : ''}Question ${k + 1} of ${group.length}: ${entry.subject}`, look: 'subject', indent: 2 },
      { text: entry.context, look: 'context', indent: 4 },
      { text: entry.ask, look: 'question', indent: 4 },
      ...entry.choices.map((choice): AskedLine => choice.letter === entry.recommended
        ? { text: `[${choice.letter}] ${choice.text}  ★`, look: 'recommended', indent: 4 }
        : { text: `[${choice.letter}] ${choice.text}`, look: 'choice', indent: 4 }),
      ...(entry.why !== null ? [{ text: `★ Recommendation: ${entry.recommended !== null ? `${entry.recommended} — ` : ''}${entry.why}`, look: 'plain' as const, indent: 4 }] : []),
      { text: `Blocks: ${entry.blocks}`, look: 'label', indent: 4 },
    ])]
  })
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

// The questions asked in the main thread's current turn, by id: what « Question i of N » counts. A
// turn's start empties it (registerQuestion's turn.start).
const thisTurn: string[] = []

/** The main thread's turn started: the questions it asks next are numbered from one. */
export function askTurnStarted(): void {
  thisTurn.length = 0
}

const flatText = (text: string): string => plainText(text).replace(/\s+/g, ' ').trim()

/**
 * What makes two questions one for the record: the asker's project (its session name's subject),
 * what it blocks (its parts split by `, `, spacing and case aside), the consent it asks, and its
 * fields, choices and recommendation as given.
 */
export function askedKey(entry: Pick<Asked, 'sender' | 'blocks' | 'consent' | 'subject' | 'context' | 'ask' | 'choices' | 'recommended' | 'why'>): string {
  const blocks = entry.blocks.split(', ').map(part => flatText(part).toLowerCase()).filter(part => part !== '').sort()
  const consent = entry.consent ? [entry.consent.kind, entry.consent.repo.toLowerCase(), 'pr' in entry.consent ? entry.consent.pr : 'env' in entry.consent ? entry.consent.env : null] : null
  return JSON.stringify([
    parseSessionName(entry.sender.name)?.subject ?? entry.sender.name, blocks, consent,
    [entry.subject, entry.context, entry.ask].map(flatText), entry.choices.map(choice => [choice.letter, flatText(choice.text)]),
    entry.recommended, entry.why === null ? null : flatText(entry.why),
  ])
}

// The answers that are the operator's own: given in the asker's tab (naming one choice), in the pane
// or through the coordinator. An answer relayed by a message, or a withdrawal, records nothing.
const OWN_ANSWERS: readonly string[] = ['tab', 'pane', 'coordinator']

/** The newest answer of his own to a question asking the same, in the round or its archive; null when none. */
export async function recordedAsked($: Host<'env' | 'fs'>, entry: Asked): Promise<Asked | null> {
  const key = askedKey(entry)
  const archived: Asked[] = []
  const dir = `${await stateDir($)}/round/archive`
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
export async function callAsk($: Held, e: Record<string, unknown>, now: Date = new Date()): Promise<Answer> {
  if (e['agentId']) return refuse('a subagent asks its session, in its answer: only the main thread asks the operator.')
  const parsed = parseAsk(e)
  if ('error' in parsed) return refuse(parsed.error)
  const me = await whoAmI($)
  if (me === null) {
    return refuse('Only an orchestrator, a coordinator or an auditor asks with `ask`, once the host names it; an agent asks the session that launched it, by message.')
  }
  const sessionId = await $.session.id()
  const sender = { session: sessionId, name: me.name, role: me.role, machine: await machineOf($) }
  const made = askedEntry(parsed.fields, sender, askId(sessionId, now), now)
  // A question its project already had him answer is answered from that record, and not put to him again.
  const record = await recordedAsked($, made).catch(() => null)
  const entry: Asked = record?.answer
    ? { ...made, status: 'answered', answer: { text: record.answer.text, by: record.answer.by, at: record.answer.at, settler: me.name, record: record.id } }
    : made
  const path = `${await stateDir($)}/round/${entry.id}.json`
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
  if (record?.answer) {
    return { result: `Answered from the record, not asked again: the operator answered this question on ${record.answer.at} by ${record.answer.by} — ${record.answer.text} (question ${record.id}). Stored as ${entry.id}, answered.` }
  }
  // Numbered among the questions asked in this turn: several asked in one turn read 1 of 1, then 2 of 2;
  // one asked in a later turn reads 1 of 1 again, whatever stays open from before.
  const asked = thisTurn.push(entry.id)
  const block = questionBlock(entry, { i: asked, n: asked })
  try {
    for (const line of shownLines(block)) $.ui.log(line)
  } catch (err) {
    await logLine($, 'question', `question ${entry.id} stored, its block not written to the transcript: ${messageOf(err)}`)
    return { result: `Asked as ${entry.id}, but its block could not be shown in this chat (${messageOf(err)}): write it in your message as it stands.\n\n${block}` }
  }
  return { result: `Asked as ${entry.id}: the question is in the round and shown to the operator in this chat, as a block. Do not write it again.` }
}

/**
 * The `settle` tool: the entry closed through `closeRound` as `planAsked` or `planRelayed` decides,
 * then the work the answer asks added to the asker's list. Answers the tool's reply.
 */
export async function settle($: Held, request: SettleRequest, now: Date = new Date()): Promise<Answer> {
  const who = await whoAmI($)
  if (who === null) return refuse('Only an orchestrator, a coordinator or an auditor settles a question, once the host names it.')
  const me: Me = { ...who, session: await $.session.id() }
  const path = `${await stateDir($)}/round/${request.id}.json`
  const at = now.toISOString()
  // Read before the lock, the one fact the lock cannot read: whether the coordinator here was shown it.
  const shown = await closesItself($, request.id)
  let closed: Awaited<ReturnType<typeof closeRound>>
  try {
    closed = await closeRound($, path, current => {
      const asked = current === undefined ? null : parseAsked(current)
      const relayed = asked !== null || current === undefined ? null : parseRoundEntry(current)
      if (asked !== null) return planAsked(asked, request, me, at)
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
    const made = await callTodo($, { action: 'add', words: request.work, ...(own ? {} : { to: done.asker.name }) }, now)
    said.push(made.isError ? `The work it asks is not recorded: ${made.result}` : made.result)
  }
  return { result: said.join(' ') }
}

/**
 * A consent he gave in words, with no question before it (`settle` with no id): recorded as the
 * consent record of its subject only when the words are a message he typed himself in this
 * session's tab, read from its transcript (a user turn of origin « human », never a message another
 * session sent, a tool result or text an agent wrote), and judgeWords finds them a plain grant of
 * that subject. The record's time is the turn's own. Answers the tool's reply.
 */
export async function settleWords($: Held, words: Words, now: Date = new Date()): Promise<Answer> {
  const who = await whoAmI($)
  if (who === null) return refuse('Only an orchestrator, a coordinator or an auditor records a consent, once the host names it.')
  const judged = judgeWords(words, now.getTime())
  if ('refuse' in judged) return refuse(judged.refuse)
  const session = await $.session.id()
  const path = await transcriptPathOf($, session)
  if (path === '') return refuse('nothing recorded: this session\'s transcript is not found, so it cannot show that he typed these words here.')
  const read = Date.now() + 5000
  const found = await scanTail(
    async (file: string) => Number((await $.fs.stat(file)).size),
    (file: string, index: number) => readBlock($, file, index, Math.max(1, read - Date.now())),
    path, line => isHisTurn(line, words),
  )
  const turn = found.line === null ? null : humanTurn(found.line)
  if (turn === null) {
    return refuse(found.complete
      ? 'nothing recorded: no message he typed in this tab says exactly these words (a message another session sent, a tool result and text an agent wrote are not his): answer is his message, whole, as he typed it.'
      : 'nothing recorded: this session\'s transcript could not be read to its start, and the words are not in what was read; try again.')
  }
  const record = wordsRecord(words, judged.ok, who.role === 'coordinator' ? 'coordinator' : 'tab', turn.at)
  if (record === undefined) return refuse('nothing recorded: the record this makes breaks the consent contract.')
  try {
    const file = consentPath(await configDir($), record)
    const made = await $.process.run(['mkdir', '-p', '--', file.slice(0, file.lastIndexOf('/'))], { timeoutMs: 5000 })
    if (made.exitCode !== 0) throw new Error(made.stderr || `mkdir exited ${made.exitCode}`)
    await writeAtomic($, file, JSON.stringify(record) + '\n')
  } catch (err) {
    await logLine($, 'question', `the consent in words of ${words.subject.repo} not recorded: ${messageOf(err)}`)
    return refuse(`nothing recorded: the record could not be written (${messageOf(err)}); settle again.`)
  }
  await logLine($, 'question', `consent in words recorded: ${record.entry} (${words.subject.kind} of ${words.subject.repo}), by ${record.by}, he said it at ${record.at}`)
  return { result: `Recorded his consent, typed in this tab at ${record.at}: ${record.question.slice(record.question.lastIndexOf('— ') + 2)}. The record is ${record.entry}; its readers quote his message.` }
}

/**
 * His answer given in the coordinator's pane to a question asked with `ask`: the object read again
 * and written under its lock, answered by the pane, so a question settled, withdrawn or claimed in
 * its asker's tab meanwhile is left as it is; then its consent recorded and the answer sent to its
 * asker at once, a send not delivered written on the object, which the pane then shows. Answers
 * the object answered, or null when it was not.
 */
export async function answerAskedFromPane($: Held, id: string, text: string, now: Date = new Date()): Promise<Asked | null> {
  const said = text.trim()
  if (said === '') return null
  const who = await whoAmI($)
  const me: Me = { session: await $.session.id(), name: who?.name ?? "the coordinator's pane", role: who?.role ?? 'coordinator' }
  const path = `${await stateDir($)}/round/${id}.json`
  const at = now.toISOString()
  try {
    const closed = await closeRound($, path, current => {
      const entry = current === undefined ? null : parseAsked(current)
      return entry === null ? null : planPane(entry as unknown as Fields, said, me, at)
    }, me, at, () => logLine($, 'question', `${id} answered in the pane`))
    return closed === null || 'error' in closed ? null : closed.plan.entry as unknown as Asked
  } catch (err) {
    await logLine($, 'question', `${id} not answered from the pane: ${messageOf(err)}`)
    return null
  }
}

/**
 * The one closure of a round entry (design §4.3), whoever closes it — `settle`, the pane, the words
 * typed in its asker's tab, its session's end: the entry read again and written under its lock as
 * `decide` plans it (null leaves it), `written` run once it is, then its consent recorded, the
 * relay's fingerprint forgotten, the coordinator here told, the answer sent to its asker or to its
 * owner's machine, and the object pushed to a coordinator on another machine. Answers the plan and
 * what its steps said, the refusal, or null; a write that fails throws.
 */
export async function closeRound(
  $: Held, path: string, decide: (current: string | undefined) => Plan | { error: string } | null, me: Me, at: string,
  written?: () => Promise<void>,
): Promise<{ plan: Plan; said: string[] } | { error: string } | null> {
  let plan: Plan | { error: string } | null = null
  await updateOver(storeIo($), path, current => {
    plan = decide(current)
    return plan === null || 'error' in plan ? undefined : `${JSON.stringify(plan.entry)}\n`
  })
  const done = plan as Plan | { error: string } | null
  if (done === null) return null
  if ('error' in done) return { error: done.error }
  await written?.()
  const said: string[] = []
  if (done.consentBy !== null) {
    const question = typeof done.entry['ask'] === 'string' ? done.entry['ask'] : done.entry['question']
    const missed = await writeConsent($, { ...done.entry, question } as never, done.consentText, done.consentBy, at)
    if (missed !== null) said.push(`The consent is not recorded (${missed}): ask again for it if it is still needed.`)
  }
  if (done.relayed) await forgetRelayed($, done.entry as never)
  if (done.told) await tellSettled($, [{ entry: done.entry, answer: done.entry['answer'] }] as never)
  if (done.deliver === 'now') said.push(await deliverSettled($, path, done, me, at))
  if (done.deliver === 'remote') {
    const refused = await sendReply($, String(done.entry['id']))
    said.push(refused === null ? `The answer goes to ${done.asker.name} on its machine now.` : `Not delivered yet to ${done.asker.name} (${refused}): the round's next readings send it again, or say it failed.`)
  }
  if (done.deliver !== 'remote' && done.entry['v'] === ASK_VERSION) await replicate($, done.entry as unknown as Asked)
  return { plan: done, said }
}

// The answer sent to its asker at once — its session while it has a row here (two sessions may share
// a name), else its name — then its outcome written on the entry while it still holds that answer:
// delivered, or failed with the host's reason, which the pane then shows.
async function deliverSettled($: Held, path: string, done: Plan, me: Me, at: string): Promise<string> {
  let reason: string | null = null
  try {
    const live = done.asker.session !== '' && sessionKey(done.asker.session) in await readSessions($)
    const sent = await $.session.send({ to: (live ? { sessionId: done.asker.session } : done.asker.name) as string, text: settledMessage(done.entry, me) })
    if (!sent?.isDelivered) reason = sent?.reason ?? 'no answer'
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
async function agentAtStart($: Held): Promise<boolean> {
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
        description: 'Asks the operator one question, in the method\'s format: the module stores it in the round, where the pane draws it, and shows it in this chat; do not write the block yourself. '
          + 'One call per question; several calls make several questions, each answered on its own. '
          + 'subject (a few words), context (two to six sentences: the stake, what is known), question (one sentence ending in « ? »), '
          + 'choice_a to choice_e (none, or two to five, each a different piece of work with its cost and gain), recommended (the letter) and why (its argument against the others), '
          + 'blocks (what waits on the answer), urgent (true to have it presented at once). '
          + 'A question that asks his consent names consent_kind and consent_repo, with consent_pr or consent_env as its kind needs, and offers choice_a "Accorder", choice_b "Refuser". '
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
            consent_kind: { type: 'string', enum: [...CONSENT_KINDS] },
            consent_repo: { type: 'string' },
            consent_pr: { type: 'integer' },
            consent_env: { type: 'string', enum: [...DEPLOY_ENVS] },
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

  // His prompt in the asker's own tab claims its open questions: they leave the pane at once.
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
          + '`withdrawn` (reason: the evidence, or what made it moot). work: the work his answer asks, in his words, recorded as a to-do of the asker. '
          + 'With no id, consent_kind and consent_repo (consent_pr or consent_env, until for an exemption\'s limit): his message, whole as answer, recorded as a consent when he typed it in this tab. '
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
            consent_kind: { type: 'string', enum: [...CONSENT_KINDS] },
            consent_repo: { type: 'string' },
            consent_pr: { type: 'integer' },
            consent_env: { type: 'string', enum: [...DEPLOY_ENVS] },
            until: { type: 'string' },
            said_at: { type: 'string' },
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
    if (asksWords(e)) {
      const words = parseWords(e)
      return 'error' in words ? refuse(words.error) : settleWords($, words.words)
    }
    if (e['id'] !== undefined && WORDS_FIELDS.some(field => e[field] !== undefined)) return refuse(`${WORDS_FIELDS.join(', ')} go with no id: a consent he gave in words, with no question before it. To answer a question, give its id alone.`)
    const parsed = parseSettle(e)
    return 'error' in parsed ? refuse(parsed.error) : settle($, parsed.request)
  }).catch(async ($, e, next) => {
    await logLine($, 'question', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: 'the question could not be settled; the module\'s log says why', isError: true }
  })
}
