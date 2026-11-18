// hooks/remote-round.ts
// An orchestrator's question, entered in the round of a coordinator on another machine. The
// round is the one record of every question (round.ts), and it lives on the coordinator's
// machine: a remote orchestrator's module sends the entry its turn's end built as one marked
// line, and the coordinator's module takes that line out of the delivery before any model
// reads it, as the remote rows are (remote-row.ts), writes the entry with where it came from
// (`origin`), and acknowledges it by its id. Until that acknowledgment the sender holds the
// entry as pending in its wait file and sends it again at its next turn's end. The operator's
// answer from the coordinator's pane travels back the same way: one marked line the sender's
// module takes out before its model reads it, the readable answer under it the only part passed
// on, and an acknowledgment by the entry's id. Both trips travel as one event line (`[module-q]`,
// below) and its acknowledgment. Pure on purpose: the handlers hold the $ (supervision.ts) and
// pass their reads in here.
import { cutQuestion, RELAY_CAP } from './relay.ts'
import { parseChoices } from '../core/method.ts'
import type { RoundEntry } from './round.ts'
import { roleOf } from './session-name.ts'
import { BLOCKS_CAP, cleanBlocks, ROW_MARKER } from './remote-row.ts'
import { parseConsentSubject } from '../core/consent-record.ts'

// The receiver's caps on each field: a line past any of them is refused whole, never cut.
const NAME_CAP = 120                       // remote-row.ts's own
const MACHINE_CAP = 64                     // machineLabel's cut
const STAMP_CAP = 40                       // remote-row.ts's own
const SESSION_CAP = 128                    // a host session id is a uuid, 36 characters
// The repository of a consent subject: GitHub's 39 characters of owner, a slash, 100 of name.
export const CONSENT_REPO_CAP = 140
// The fingerprint after the session id: the text's length, a dash, FNV-1a's 32 bits in hex.
const FINGERPRINT_CAP = 12 + 1 + 8
const ID_CAP = SESSION_CAP + 1 + FINGERPRINT_CAP
// The question as cutQuestion leaves it: the cap, then the cut said with the whole length,
// a length of up to twelve digits.
const QUESTION_CAP = cutQuestion('x'.repeat(RELAY_CAP + 1)).length - String(RELAY_CAP + 1).length + 12

// The cap on an ask's object, derived and not guessed: its structure (the entry with every text
// empty, five choices, the urgent mark and the consent subject, its machine), and every text
// at its cap six times over — JSON writes one character as six at most (`\u001f`). The
// choices' texts are parts of the question's lines, so they count once more as the question.
const SKELETON = JSON.stringify({
  id: '', from: '', session: '', kind: 'operator', since: '', blocks: '', question: '',
  choices: 'ABCDE'.split('').map(letter => ({ letter, text: '' })), recommendation: 'A',
  status: 'open', at: '', answer: null, urgent: true, consent: { kind: 'norms-waiver', repo: '', pr: Number.MAX_SAFE_INTEGER }, machine: '',
}).length
const JSON_ESCAPE = 6
export const ASK_CAP = SKELETON
  + JSON_ESCAPE * (ID_CAP + NAME_CAP + SESSION_CAP + 2 * STAMP_CAP + BLOCKS_CAP + 2 * QUESTION_CAP + CONSENT_REPO_CAP + MACHINE_CAP)

// The answer's text as the sender cuts it (cutQuestion): the question's own bound. Its readable
// rest is paneAnswerText's (supervision.ts): its own words, 97 characters, rounded up, then the
// answer, what the entry blocks and two stamps.
const ANSWER_TEXT_CAP = QUESTION_CAP
const ANSWER_WORDS = 160
const READABLE_CAP = ANSWER_WORDS + ANSWER_TEXT_CAP + BLOCKS_CAP + 2 * STAMP_CAP
// The whole answer: its object with every text, the readable rest among them, at its cap six
// times over.
export const ANSWER_CAP = JSON.stringify({ id: '', since: '', text: '', at: '', readable: '' }).length
  + JSON_ESCAPE * (ID_CAP + 2 * STAMP_CAP + ANSWER_TEXT_CAP + READABLE_CAP)

// The fields an ask carries: the entry's as roundEntry builds them, and the sender's machine.
// No `origin`, which only the receiver writes, and no `movedFrom`, which only a succession does.
// The urgent mark and the consent subject are carried when the entry has them.
const FIELDS = ['id', 'from', 'session', 'kind', 'since', 'blocks', 'question', 'choices', 'recommendation', 'status', 'at', 'answer', 'machine'] as const

// An id of roundEntryId's shape: the session id as the store sanitises it, then the fingerprint.
const ID_SHAPE = /^[A-Za-z0-9._-]+-\d{1,12}-[0-9a-f]{1,8}$/

// The entry of a wait as an ask carries it: its question cut at the cap known to cross and
// the cut said (the operator's ruling 5.4), what it blocks cut as a row's is, and the machine
// it was asked on. A control character of what it blocks or of who asks is a space before the
// cut: the receiver's line() refuses any, and a wait's text must never make its ask refused.
function askObject(entry: RoundEntry, machine: string): Record<string, unknown> {
  const { origin: _origin, movedFrom: _moved, ...sent } = entry
  return {
    ...sent,
    from: spaced(sent.from),
    blocks: sent.blocks === null ? null : cleanBlocks(sent.blocks),
    question: cutQuestion(sent.question),
    machine,
  }
}

// The receiver's whole check of an ask: the exact field set (the urgent mark and the consent
// subject alone optional), each field's type and bounds, an open and unanswered entry of an
// orchestrator, an id of its session. The choices and the recommendation are read again from
// the question, never taken from the line. Anything else is null.
function askOf(o: Record<string, unknown>): { entry: RoundEntry; machine: string } | null {
  const keys = Object.keys(o)
  const urgent = keys.includes('urgent')
  const consent = keys.includes('consent') ? parseConsentSubject(o['consent']) : undefined
  if (keys.length !== FIELDS.length + (urgent ? 1 : 0) + (keys.includes('consent') ? 1 : 0) || !FIELDS.every(field => keys.includes(field))) return null
  if (urgent && (o['urgent'] !== true || o['kind'] !== 'operator')) return null
  if (keys.includes('consent') && (consent === undefined || consent.repo.length > CONSENT_REPO_CAP || o['kind'] !== 'operator')) return null
  if (!line(o['from'], NAME_CAP) || roleOf(o['from'] as string) !== 'orchestrator') return null
  if (!line(o['session'], SESSION_CAP) || !idOf(o['id'], o['session'] as string)) return null
  if (!stamp(o['since']) || !stamp(o['at'])) return null
  if (o['kind'] === 'operator') {
    if (!line(o['blocks'], BLOCKS_CAP)) return null
  } else if (o['kind'] !== 'done' || o['blocks'] !== null) return null
  if (typeof o['question'] !== 'string' || o['question'].length > QUESTION_CAP) return null
  if (!Array.isArray(o['choices']) || !(o['recommendation'] === null || typeof o['recommendation'] === 'string')) return null
  if (o['status'] !== 'open' || o['answer'] !== null) return null
  if (!line(o['machine'], MACHINE_CAP) || !/^[A-Za-z0-9_-]+$/.test(o['machine'] as string)) return null
  const { machine, ...entry } = o as unknown as RoundEntry & { machine: string }
  return { entry: { ...entry, ...parseChoices(entry.question), ...(consent ? { consent } : {}) }, machine }
}

// The answer's check: an id of an entry's shape, two stamps, a text within its cap, and a
// readable rest that says something, returned whole, its own lines kept. Anything else is null.
function answerOf(o: Record<string, unknown>, readable: unknown): { id: string; since: string; text: string; at: string; readable: string } | null {
  if (typeof readable !== 'string' || readable.trim() === '' || readable.length > READABLE_CAP) return null
  if (!anId(o['id']) || !stamp(o['since']) || !stamp(o['at'])) return null
  if (typeof o['text'] !== 'string' || o['text'] === '' || o['text'].length > ANSWER_TEXT_CAP) return null
  return { id: o['id'] as string, since: o['since'] as string, text: o['text'], at: o['at'] as string, readable }
}

// The one line a question's events travel by between two machines.
// The question's owner is its asker's machine; the coordinator's machine keeps a replica, its
// round entry with an origin. `seq` orders a question's events: an entry of the relay carries no
// counter, so its seq is its wait's start in milliseconds, a newer ask of the same id a newer
// start. Two events: `ask`, the asker's entry with its machine, sent to the replica; `answer`, the
// operator's answer from the pane, sent to the owner, its readable rest the only part a model
// reads. Each is acknowledged by `[module-q-ack]`, naming the event it takes; `already` says the
// owner had settled the question first, in its own tab: the answer that crossed it is not applied.
export const Q_MARKER = '[module-q] '
export const Q_ACK_MARKER = '[module-q-ack] '
//
// A question asked with `ask` (question.ts) travels by the same line, as two more events and their
// acknowledgments: `asked`, the owner's object whole at its `seq`, sent to the replica at its
// creation and at each change its owner makes; `reply`, the operator's answer or the coordinator's
// withdrawal given on the replica's machine, sent to the owner, its `seq` the replica's when given.
export type QEvent =
  | { kind: 'ask'; entry: RoundEntry; machine: string }
  | { kind: 'answer'; since: string; text: string; at: string; readable: string }
  | { kind: 'asked'; object: Record<string, unknown> }
  | { kind: 'reply'; reply: QReply }
export type QReply = { status: 'answered' | 'withdrawn'; text: string; by: 'pane' | 'coordinator'; at: string; settler: string }
export type QAck = { id: string; seq: number; of: QEvent['kind']; already?: true }
const Q_KINDS: readonly string[] = ['ask', 'answer', 'asked', 'reply']

// An object `ask` made crosses whole: past this many characters its owner sends none and says so.
export const ASKED_LINE_CAP = 32 * 1024
// The id `ask` gives (question.ts askId): `q-`, the session's twelve characters, the instant and a random part, in base 36.
const ASKED_ID_SHAPE = /^q-[A-Za-z0-9_-]{1,12}-[0-9a-z]{1,12}-[0-9a-z]{4}$/
// A reply's own texts: the answer as the pane's field takes it, a name, a stamp.
const REPLY_TEXT_CAP = 8000

// The cap on the whole line: the marker, the id and seq around the event, and any event at its cap.
export const Q_LINE_CAP = Q_MARKER.length + JSON.stringify({ id: '', seq: Number.MAX_SAFE_INTEGER, event: { kind: 'answer', entry: '' } }).length + ID_CAP
  + Math.max(ASK_CAP, ANSWER_CAP, ASKED_LINE_CAP, JSON_ESCAPE * (REPLY_TEXT_CAP + NAME_CAP + STAMP_CAP))
const Q_ACK_LINE_CAP = Q_ACK_MARKER.length + JSON.stringify({ id: '', seq: Number.MAX_SAFE_INTEGER, of: 'answer', already: true }).length + ID_CAP

export function seqOf(since: string): number {
  return Date.parse(since)
}

export function qAskLine(entry: RoundEntry, machine: string): string {
  return Q_MARKER + JSON.stringify({ id: entry.id, seq: seqOf(entry.since), event: { kind: 'ask', entry: askObject(entry, machine) } })
}

export function qAnswerLine(id: string, since: string, text: string, at: string, readable: string): string {
  return Q_MARKER + JSON.stringify({ id, seq: seqOf(since), event: { kind: 'answer', since, text, at, readable } })
}

/** The owner's object at its seq, sent to the replica; null when it is past the line's cap. */
export function qAskedLine(object: { id: string; seq: number }): string | null {
  const text = Q_MARKER + JSON.stringify({ id: object.id, seq: object.seq, event: { kind: 'asked', object } })
  return text.length > ASKED_LINE_CAP ? null : text
}

/** The answer or withdrawal given on the replica's machine, sent to the owner, at the seq the replica held. */
export function qReplyLine(id: string, seq: number, reply: QReply): string {
  return Q_MARKER + JSON.stringify({ id, seq, event: { kind: 'reply', reply: { ...reply, text: reply.text.slice(0, REPLY_TEXT_CAP) } } })
}

// The marked lines a message holds when it carries several, in the order they were sent: a
// turn's end sends the coordinator one message whatever it has to say (the entry of its wait, its
// row). Each line is one JSON object on one line; a text that holds any other line is no batch.
export function joinLines(lines: readonly string[]): string {
  return lines.join('\n')
}

export function splitLines(body: string): string[] | null {
  const lines = body.trim().split('\n')
  // Only what a turn's end sends: rows and the owner's questions. A reply or an answer is read alone, its readable part passed on.
  const sendable = (line: string) => line.startsWith(ROW_MARKER) || (line.startsWith(Q_MARKER) && ['ask', 'asked'].includes(parseQ(line)?.event.kind ?? ''))
  return lines.length > 1 && lines.every(sendable) ? lines : null
}

export function isQ(body: string): boolean {
  return body.trimStart().startsWith(Q_MARKER)
}

export function isQAck(body: string): boolean {
  return body.trimStart().startsWith(Q_ACK_MARKER)
}

// The receiver's whole check: the marker, the cap, the three fields, an event of a known kind
// passing its own check, an ask's id the line's. Anything else is null.
export function parseQ(body: string): { id: string; seq: number; event: QEvent } | null {
  const o = markedObject(body, Q_MARKER, Q_LINE_CAP)
  if (!o || Object.keys(o).length !== 3 || !(anId(o['id']) || askedId(o['id'])) || !Number.isSafeInteger(o['seq'])) return null
  const raw = o['event']
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { kind, ...fields } = raw as Record<string, unknown>
  let event: QEvent | null = null
  if (kind === 'ask' && Object.keys(fields).length === 1 && fields['entry'] && typeof fields['entry'] === 'object' && !Array.isArray(fields['entry'])) {
    const asked = askOf(fields['entry'] as Record<string, unknown>)
    event = asked && { kind, ...asked }
    if (event && event.entry.id !== o['id']) return null
  } else if (kind === 'answer' && Object.keys(fields).length === 4) {
    const { readable, ...rest } = fields
    const answer = answerOf({ id: o['id'], ...rest }, readable)
    event = answer && { kind, since: answer.since, text: answer.text, at: answer.at, readable: answer.readable }
  } else if (kind === 'asked' && askedId(o['id']) && Object.keys(fields).length === 1) {
    // The object's own fields are checked by its reader (question.ts parseAsked): here its id and seq, the line's.
    const object = fields['object']
    if (object && typeof object === 'object' && !Array.isArray(object) && (object as Record<string, unknown>)['id'] === o['id'] && (object as Record<string, unknown>)['seq'] === o['seq']) {
      event = { kind, object: object as Record<string, unknown> }
    }
  } else if (kind === 'reply' && askedId(o['id']) && Object.keys(fields).length === 1) {
    const reply = replyOf(fields['reply'])
    event = reply && { kind, reply }
  }
  return event ? { id: o['id'] as string, seq: o['seq'] as number, event } : null
}

export function qAckLine(ack: QAck): string {
  return Q_ACK_MARKER + JSON.stringify(ack)
}

export function parseQAck(body: string): QAck | null {
  const o = markedObject(body, Q_ACK_MARKER, Q_ACK_LINE_CAP)
  if (!o || !(anId(o['id']) || askedId(o['id'])) || !Number.isSafeInteger(o['seq']) || !Q_KINDS.includes(String(o['of']))) return null
  const already = Object.keys(o).length === 4 && o['already'] === true
  if (Object.keys(o).length !== (already ? 4 : 3)) return null
  return { id: o['id'] as string, seq: o['seq'] as number, of: o['of'] as QAck['of'], ...(already ? { already: true as const } : {}) }
}

function askedId(v: unknown): boolean {
  return typeof v === 'string' && ASKED_ID_SHAPE.test(v)
}

// A reply's exact fields: its status, its text within its cap, who gave it, when, and its settler's name.
function replyOf(v: unknown): QReply | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (Object.keys(o).length !== 5) return null
  if (o['status'] !== 'answered' && o['status'] !== 'withdrawn') return null
  if (o['by'] !== 'pane' && o['by'] !== 'coordinator') return null
  if (typeof o['text'] !== 'string' || o['text'].trim() === '' || o['text'].length > REPLY_TEXT_CAP) return null
  if (!stamp(o['at']) || !line(o['settler'], NAME_CAP)) return null
  return { status: o['status'], text: o['text'], by: o['by'], at: o['at'] as string, settler: o['settler'] as string }
}

function anId(v: unknown): boolean {
  return typeof v === 'string' && v.length <= ID_CAP && ID_SHAPE.test(v)
}

function spaced(text: string): string {
  return text.replace(/[\u0000-\u001f]/g, ' ')
}

function markedObject(body: string, marker: string, cap: number): Record<string, unknown> | null {
  const text = body.trim()
  if (!text.startsWith(marker) || text.length > cap) return null
  try {
    const raw: unknown = JSON.parse(text.slice(marker.length))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  } catch {
    return null
  }
}

// A one-line text, not empty, within its cap.
function line(v: unknown, cap: number): boolean {
  return typeof v === 'string' && v.length > 0 && v.length <= cap && !/[\u0000-\u001f]/.test(v)
}

function stamp(v: unknown): boolean {
  return line(v, STAMP_CAP) && Number.isFinite(Date.parse(v as string))
}

// An id of the entry's own session: roundEntryId's sanitising of it, then the fingerprint.
function idOf(id: unknown, session: string): boolean {
  if (typeof id !== 'string' || id.length > ID_CAP || !ID_SHAPE.test(id)) return false
  const prefix = `${session.replace(/[^A-Za-z0-9._-]/g, '_')}-`
  return id.startsWith(prefix) && /^\d{1,12}-[0-9a-f]{1,8}$/.test(id.slice(prefix.length))
}
