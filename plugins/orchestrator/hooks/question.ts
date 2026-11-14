// hooks/question.ts
// The `ask` tool: a question to the operator made by one call, its fields flat (the host dropped a
// nested one, claude-plugins#218), validated against the method's question format
// (plugins/method/skills/lifecycle/references/questions.md) and stored as its own object in the
// round, `round/<id>.json`, with a format version that tells it from the entries the relay writes
// out of a turn's text (round.ts). The id is the module's, given at creation; each call is one
// object, settled and delivered on its own. The module writes the question block into the
// transcript itself, so the model does not write it. Any main session that keeps a list asks with
// it: an orchestrator, a coordinator, an auditor; an agent asks the session that launched it.
// The old path, a block written in the turn's text, stays as it is beside it.
import { updateOver } from '../core/store-io.ts'
import { CONSENT_GRANT, CONSENT_KINDS, CONSENT_REFUSE, DEPLOY_ENVS, parseConsentSubject, type ConsentSubject } from '../core/consent-record.ts'
import { machineLabel } from './remote-row.ts'
import { plainText } from './round.ts'
import { whoAmI } from './todo.ts'
import { sessionRole } from './supervision.ts'
import { logLine, stateDir, storeIo } from './module-io.ts'
import { messageOf, type Host, type On } from './host.ts'

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

/** One question in the round, as `ask` writes it. Settling it (`answer`, a status other than open) is the next tool's. */
export type Asked = AskFields & {
  v: typeof ASK_VERSION
  id: string
  sender: AskedSender
  status: 'open' | 'answered' | 'withdrawn'
  at: string
  answer: null
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
  return fine ? o as unknown as Asked : null
}

/** The question in the method's shape, numbered among its sender's open questions, its id after the number. */
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
 * The open questions in the pane's order, grouped by asker: the askers with an urgent question
 * first, then by their earliest question; within a group, the urgent first, then in the order asked.
 */
export function askedGroups(entries: readonly Asked[]): Asked[][] {
  const byAt = (a: Asked, b: Asked) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)
  const urgentFirst = (a: Asked, b: Asked) => Number(b.urgent === true) - Number(a.urgent === true) || byAt(a, b)
  const groups = new Map<string, Asked[]>()
  for (const entry of entries.filter(e => e.status === 'open').sort(byAt)) groups.set(entry.sender.session, [...(groups.get(entry.sender.session) ?? []), entry])
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

/** What the tool answers to one call; `now` is the instant it records. */
export async function callAsk($: Held, e: Record<string, unknown>, now: Date = new Date()): Promise<Answer> {
  if (e['agentId']) return refuse('a subagent asks its session, in its answer: only the main thread asks the operator.')
  const parsed = parseAsk(e)
  if ('error' in parsed) return refuse(parsed.error)
  const me = await whoAmI($)
  if (me === null) {
    return refuse('Only an orchestrator, a coordinator or an auditor asks with `ask`, once its name is known (after its first turn); an agent asks the session that launched it, by message.')
  }
  const sessionId = await $.session.id()
  const sender = { session: sessionId, name: me.name, role: me.role, machine: await machineOf($) }
  const entry = askedEntry(parsed.fields, sender, askId(sessionId, now), now)
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
  // Numbered among its asker's open questions: several asked in one turn read 1 of 2, 2 of 2.
  const own = askedGroups(await readAsked($)).flat().filter(open => open.sender.session === sessionId)
  const at = own.findIndex(open => open.id === entry.id)
  const block = questionBlock(entry, { i: at < 0 ? own.length + 1 : at + 1, n: Math.max(own.length, 1) })
  try {
    for (const line of shownLines(block)) $.ui.log(line)
  } catch (err) {
    await logLine($, 'question', `question ${entry.id} stored, its block not written to the transcript: ${messageOf(err)}`)
    return { result: `Asked as ${entry.id}, but its block could not be shown in this chat (${messageOf(err)}): write it in your message as it stands.\n\n${block}` }
  }
  return { result: `Asked as ${entry.id}: the question is in the round and shown to the operator in this chat, as a block. Do not write it again.` }
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
          + 'A question that asks his consent names consent_kind and consent_repo, with consent_pr or consent_env as declare_wait takes them, and offers choice_a "Accorder", choice_b "Refuser". '
          + 'For a coordinator or an auditor; an orchestrator asks as orchestrator:decide says, until declare_wait takes a question asked here.',
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

  on('tool.call', { tool: `mcp__orchestrator__${ASK_TOOL}` }, async ($, e) => callAsk($, e)).catch(async ($, e, next) => {
    await logLine($, 'question', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return { result: 'the question could not be asked; the module\'s log says why', isError: true }
  })
}
