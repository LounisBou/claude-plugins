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
// on, and an acknowledgment by the entry's id. Pure on purpose: the handlers hold the $
// (supervision.ts) and pass their reads in here.
import { cutQuestion, RELAY_CAP } from './relay.ts'
import { parseChoices, type RoundEntry } from './round.ts'
import { roleOf } from './session-name.ts'
import { BLOCKS_CAP } from './remote-row.ts'

// The lines' fixed heads: what the receivers key on, and nothing a person or a model writes by
// chance.
export const ASK_MARKER = '[module-ask] '
export const ACK_MARKER = '[module-ack] '
export const ANSWER_MARKER = '[module-answer] '
export const ANSWER_ACK_MARKER = '[module-ack-answer] '

// The receiver's caps on each field: a line past any of them is refused whole, never cut.
const NAME_CAP = 120                       // remote-row.ts's own
const MACHINE_CAP = 64                     // machineLabel's cut
const STAMP_CAP = 40                       // remote-row.ts's own
const SESSION_CAP = 128                    // a host session id is a uuid, 36 characters
// The fingerprint after the session id: the text's length, a dash, FNV-1a's 32 bits in hex.
const FINGERPRINT_CAP = 12 + 1 + 8
const ID_CAP = SESSION_CAP + 1 + FINGERPRINT_CAP
// The question as cutQuestion leaves it: the cap, then the cut said with the whole length,
// a length of up to twelve digits.
const QUESTION_CAP = cutQuestion('x'.repeat(RELAY_CAP + 1)).length - String(RELAY_CAP + 1).length + 12

// The cap on the whole line, derived and not guessed: the marker, the line's structure (the
// entry with every text empty, five choices and the urgent mark, its machine), and every text
// at its cap six times over — JSON writes one character as six at most (`\u001f`). The
// choices' texts are parts of the question's lines, so they count once more as the question.
const SKELETON = JSON.stringify({
  id: '', from: '', session: '', kind: 'operator', since: '', blocks: '', question: '',
  choices: 'ABCDE'.split('').map(letter => ({ letter, text: '' })), recommendation: 'A',
  status: 'open', at: '', answer: null, urgent: true, machine: '',
}).length
const JSON_ESCAPE = 6
export const ASK_LINE_CAP = ASK_MARKER.length + SKELETON
  + JSON_ESCAPE * (ID_CAP + NAME_CAP + SESSION_CAP + 2 * STAMP_CAP + BLOCKS_CAP + 2 * QUESTION_CAP + MACHINE_CAP)
const ACK_LINE_CAP = ACK_MARKER.length + JSON.stringify({ id: '', since: '' }).length + ID_CAP + STAMP_CAP

// The answer's text as the sender cuts it (cutQuestion): the question's own bound. Its readable
// rest is paneAnswerText's (supervision.ts): its own words, 97 characters, rounded up, then the
// answer, what the entry blocks and two stamps.
const ANSWER_TEXT_CAP = QUESTION_CAP
const ANSWER_WORDS = 160
const READABLE_CAP = ANSWER_WORDS + ANSWER_TEXT_CAP + BLOCKS_CAP + 2 * STAMP_CAP
// The whole answer: the marker, its object with every text at its cap six times over, the
// newline, the readable rest.
export const ANSWER_LINE_CAP = ANSWER_MARKER.length + JSON.stringify({ id: '', since: '', text: '', at: '' }).length
  + JSON_ESCAPE * (ID_CAP + 2 * STAMP_CAP + ANSWER_TEXT_CAP) + 1 + READABLE_CAP
const ANSWER_ACK_LINE_CAP = ANSWER_ACK_MARKER.length + JSON.stringify({ id: '', since: '' }).length + ID_CAP + STAMP_CAP

// The fields an ask carries: the entry's as roundEntry builds them, and the sender's machine.
// No `origin`, which only the receiver writes, and no `movedFrom`, which only a succession does.
const FIELDS = ['id', 'from', 'session', 'kind', 'since', 'blocks', 'question', 'choices', 'recommendation', 'status', 'at', 'answer', 'machine'] as const

// An id of roundEntryId's shape: the session id as the store sanitises it, then the fingerprint.
const ID_SHAPE = /^[A-Za-z0-9._-]+-\d{1,12}-[0-9a-f]{1,8}$/

// The entry of a wait as the line carries it: its question cut at the cap known to cross and
// the cut said (the operator's ruling 5.4), what it blocks cut as a row's is, and the machine
// it was asked on. A control character of what it blocks or of who asks is a space before the
// cut: the receiver's line() refuses any, and a wait's text must never make its ask refused.
export function askLine(entry: RoundEntry, machine: string): string {
  const { origin: _origin, movedFrom: _moved, ...sent } = entry
  return ASK_MARKER + JSON.stringify({
    ...sent,
    from: spaced(sent.from),
    blocks: sent.blocks === null ? null : spaced(sent.blocks).slice(0, BLOCKS_CAP),
    question: cutQuestion(sent.question),
    machine,
  })
}

export function isAsk(body: string): boolean {
  return body.trimStart().startsWith(ASK_MARKER)
}

export function isAck(body: string): boolean {
  return body.trimStart().startsWith(ACK_MARKER)
}

// The receiver's whole check: the marker, the line's cap, the exact field set (the urgent mark
// alone optional), each field's type and bounds, an open and unanswered entry of an
// orchestrator, an id of its session. The choices and the recommendation are read again from
// the question, never taken from the line. Anything else is null.
export function parseAsk(body: string): { entry: RoundEntry; machine: string } | null {
  const o = markedObject(body, ASK_MARKER, ASK_LINE_CAP)
  if (!o) return null
  const keys = Object.keys(o)
  const urgent = keys.includes('urgent')
  if (keys.length !== FIELDS.length + (urgent ? 1 : 0) || !FIELDS.every(field => keys.includes(field))) return null
  if (urgent && (o.urgent !== true || o.kind !== 'operator')) return null
  if (!line(o.from, NAME_CAP) || roleOf(o.from as string) !== 'orchestrator') return null
  if (!line(o.session, SESSION_CAP) || !idOf(o.id, o.session as string)) return null
  if (!stamp(o.since) || !stamp(o.at)) return null
  if (o.kind === 'operator') {
    if (!line(o.blocks, BLOCKS_CAP)) return null
  } else if (o.kind !== 'done' || o.blocks !== null) return null
  if (typeof o.question !== 'string' || o.question.length > QUESTION_CAP) return null
  if (!Array.isArray(o.choices) || !(o.recommendation === null || typeof o.recommendation === 'string')) return null
  if (o.status !== 'open' || o.answer !== null) return null
  if (!line(o.machine, MACHINE_CAP) || !/^[A-Za-z0-9_-]+$/.test(o.machine as string)) return null
  const { machine, ...entry } = o as unknown as RoundEntry & { machine: string }
  return { entry: { ...entry, ...parseChoices(entry.question) }, machine }
}

// The acknowledgment of an ask, by its id and the start of the wait it answers: a late one of an
// older ask of the same id must not clear a newer pending wait.
export function ackLine(id: string, since: string): string {
  return ACK_MARKER + JSON.stringify({ id, since })
}

export function parseAck(body: string): { id: string; since: string } | null {
  const o = markedObject(body, ACK_MARKER, ACK_LINE_CAP)
  if (!o || Object.keys(o).length !== 2 || !anId(o.id) || !stamp(o.since)) return null
  return { id: o.id as string, since: o.since as string }
}

// The operator's answer to an entry, sent back to the machine it came from: the marker and one
// object on the first line — the entry's id and since, the answer's text and when it was given —
// then the readable answer, the only part the sender's model reads. The text arrives cut
// (cutQuestion): its own lines stay inside the object.
export function answerLine(id: string, since: string, text: string, at: string, readable: string): string {
  return `${ANSWER_MARKER}${JSON.stringify({ id, since, text, at })}\n${readable}`
}

export function isAnswer(body: string): boolean {
  return body.trimStart().startsWith(ANSWER_MARKER)
}

export function isAnswerAck(body: string): boolean {
  return body.trimStart().startsWith(ANSWER_ACK_MARKER)
}

// The sender's whole check: the line's cap, the first line's exact object, an id of an entry's
// shape, two stamps, a text within its cap, and a readable rest that says something. The rest is
// returned whole, its own lines kept. Anything else is null.
export function parseAnswer(body: string): { id: string; since: string; text: string; at: string; readable: string } | null {
  const text = body.trimStart()
  if (text.length > ANSWER_LINE_CAP) return null
  const cut = text.indexOf('\n')
  if (cut < 0) return null
  const readable = text.slice(cut + 1)
  if (readable.trim() === '' || readable.length > READABLE_CAP) return null
  const o = markedObject(text.slice(0, cut), ANSWER_MARKER, ANSWER_LINE_CAP)
  if (!o || Object.keys(o).length !== 4 || !anId(o.id) || !stamp(o.since) || !stamp(o.at)) return null
  if (typeof o.text !== 'string' || o.text === '' || o.text.length > ANSWER_TEXT_CAP) return null
  return { id: o.id as string, since: o.since as string, text: o.text, at: o.at as string, readable }
}

// The answer's acknowledgment, by the entry's id and since: a late one of an older answer to the
// same id must not settle a newer entry.
export function answerAckLine(id: string, since: string): string {
  return ANSWER_ACK_MARKER + JSON.stringify({ id, since })
}

export function parseAnswerAck(body: string): { id: string; since: string } | null {
  const o = markedObject(body, ANSWER_ACK_MARKER, ANSWER_ACK_LINE_CAP)
  if (!o || Object.keys(o).length !== 2 || !anId(o.id) || !stamp(o.since)) return null
  return { id: o.id as string, since: o.since as string }
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
