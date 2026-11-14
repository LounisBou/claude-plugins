// hooks/unanswered-question.ts
// The stop gate's reading of a question still on the operator: it stays open in the round until
// he answers it, wakes the session with its answer, and is not repeated in later messages; a turn
// that leaves it out is logged, never refused. Pure: the stop gate reads the round and the
// session's wait file, this file decides on what they hold and on the turn's final message.
import { entryQuestions, outsideFences, parseChoices, questionParts, questionShape, type QuestionShape } from '../core/method.ts'
import { plainText, numberLabel, type RoundEntry } from './round.ts'
import { heldQuestion, type RelayedWait } from './relay.ts'

// The session's wait file as this rule reads it: the wait, the fingerprint the coordinator
// holds, a send not yet acknowledged by a coordinator on another machine, and the mark of a
// prompt the operator typed while it was held.
export type WaitRead = RelayedWait & { pending?: string | null; typed?: object | null }

// The question still on the operator: its round entry when this machine's round holds it, else
// only what the wait file knows of it (its blocks and its start).
export type Pending = { entry: RoundEntry | null; blocks: string; since: string | null }

// The session's question the operator has not answered, the earliest when several (one question
// per turn: the others wait behind it): an operator entry of the session still open. His answer
// settles it wherever he gives it: in the pane or to the coordinator, or typed in the sender's own
// tab, which withdraws it at once (supervision.ts withdrawOnTyped); a turn that ends on the same
// wait opens it again, and it is pending again. An entry with no numbered question block asks
// nothing the chat could show again and is passed over. With no such entry in this machine's
// round, the wait file's operator wait relayed to a coordinator elsewhere (held, or sent and not
// yet acknowledged) is the question; an entry of the same wait in the round, whatever its status,
// rules instead.
export function pendingQuestion(sessionId: string, entries: readonly RoundEntry[], wait: WaitRead | null): Pending | null {
  const own = entries.filter(entry => entry.session === sessionId && entry.kind === 'operator')
  const open = own
    .filter(entry => entry.status === 'open')
    .filter(entry => askedPart(entry) !== null)
    .sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0))
  const first = open[0]
  if (first) return { entry: first, blocks: first.blocks ?? '', since: first.since }
  const held = wait ? heldQuestion(wait) ?? sentQuestion(wait) : null
  if (!held || held.blocks === '') return null
  if (own.some(entry => entry.blocks === held.blocks && entry.since === held.since)) return null
  return { entry: null, blocks: held.blocks, since: held.since }
}

// With no coordinator on the machine, the session's own operator wait is its open question: the
// wait file's last operator wait with its blocks, until he answers it. He answers in this tab, by a
// prompt typed since the wait started (`typedAt`, or the mark such a prompt left), or the round
// holds the same wait's entry settled.
export function ownWaitOpen(sessionId: string, entries: readonly RoundEntry[], wait: WaitRead | null, typedAt: string | null): boolean {
  const kind = wait?.waiting ?? wait?.last_waiting ?? null
  if (!wait || kind !== 'operator' || typeof wait.blocks !== 'string' || wait.blocks === '' || wait.typed) return false
  const since = wait.waiting_since ?? null
  if (typedAt !== null && (since === null || typedAt >= since)) return false
  return !entries.some(entry => entry.session === sessionId && entry.kind === 'operator' && entry.status !== 'open'
    && entry.blocks === wait.blocks && entry.since === since)
}

// An operator wait sent to a coordinator on another machine and not acknowledged yet.
function sentQuestion(wait: WaitRead): { blocks: string; since: string | null } | null {
  if (wait.waiting !== 'operator' || !wait.pending || typeof wait.blocks !== 'string') return null
  return { blocks: wait.blocks, since: wait.waiting_since ?? null }
}

// The entry's question still unanswered: its first numbered question the pane has not answered
// yet (`partial` holds the answers given so far, in order), with its shape; null when none is.
function askedPart(entry: RoundEntry): { number: string; shape: QuestionShape; choices: RoundEntry['choices'] } | null {
  const numbered = entryQuestions(entry).filter(part => part.number !== null)
  const part = numbered[entry.partial?.length ?? 0]
  if (!part) return null
  const shape = questionShape(part.question, part.choices)
  return shape ? { number: part.number!, shape, choices: part.choices } : null
}

// A text as compared: its emphasis dropped, its spacing collapsed, its case kept.
const flat = (text: string) => plainText(text).replace(/\s+/g, ' ').trim()

// The measure of a turn that ends while the session's question is still on the operator and does
// not show him that question in full, which the stop gate logs and never refuses; null otherwise.
// In full: a numbered block of the message, outside code fences, with the same numbering, the
// entry's `Question` field with its text, and every choice with its letter and text. The other
// fields may be worded anew: what he must recognise is the question and what he can answer. With
// only the wait file's knowledge of the question, any numbered block with labelled fields is
// taken for it.
export function unansweredRefusal(message: string, pending: Pending | null): string | null {
  if (pending === null) return null
  const text = outsideFences(message)
  const shown = questionParts(text).map(part => {
    const { choices } = parseChoices(part)
    return { shape: questionShape(part, choices), choices }
  })
  const asked = pending.entry ? askedPart(pending.entry) : null
  if (asked === null) {
    if (shown.some(part => part.shape?.number)) return null
    return refusal(`blocks: ${pending.blocks}`, pending.blocks)
  }
  const question = questionField(asked.shape)
  const same = shown.some(({ shape, choices }) => shape !== null && shape.number !== null
    && numberLabel(shape.number) === numberLabel(asked.number)
    && (question === undefined || flat(questionField(shape) ?? '') === flat(question))
    && asked.choices.every(choice => choices.some(seen => seen.letter === choice.letter && flat(seen.text) === flat(choice.text))))
  if (same) return null
  return refusal(`**${asked.number}** — ${flat(question ?? pending.blocks)}`, pending.blocks)
}

// The text of a question's `Question` field, its label read in any case and emphasis.
const questionField = (shape: QuestionShape) => shape.fields.find(field => /^question$/i.test(flat(field.label)))?.text

function refusal(named: string, blocks: string): string {
  return `Your question to the operator is still unanswered: « ${named} ». He must see it in your own chat as well as `
    + 'in the coordinator\'s round, at every turn\'s end until he answers it (his ruling of 2026-11-03). Present it again '
    + 'IN FULL in this message, in the method\'s question format — its `**Question i of N**` line and every '
    + 'labelled field, its choices and its recommendation, as you asked it — and declare its operator wait again, '
    + `blocking on: ${blocks}.`
}
