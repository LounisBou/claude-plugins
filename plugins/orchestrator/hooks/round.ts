// hooks/round.ts
// The coordinator's round, as the module keeps it on this machine: one file per wait an
// orchestrator ended its turn on, under the state directory's round/ (roundPath), written
// whole and renamed into place by the relay (supervision.ts) in place of a message, so a
// question waits in the round without costing the coordinator's model a turn. The pane of
// the coordinator draws the first open question whole, with its lettered choices the operator
// answers from (the entry then `answered` by the pane, his choice sent); the coordinator
// reads the round with `coordinator.sh round` when the operator speaks to it, and closes an
// entry with `coordinator.sh round-close`. A file that does not parse is skipped by every
// reader, never repaired. Pure on purpose, like relay.ts: the handler holds the $.
import { fingerprint, type HeldQuestion, type Wait } from './relay.ts'
import { answersChoice, CONSENT_GRANT, CONSENT_REFUSE, givenAnswer, type ConsentSubject } from '../core/consent-record.ts'
import { entryQuestions, numberOfLine, parseChoices, questionParts, questionShape, type Choice } from '../core/method.ts'
import { parseSessionName } from '../core/names.ts'

export type RoundChoice = Choice   // letter: one of 'A' to 'E'
// Who settled the entry: the operator from the pane (`answered`), the coordinator
// (`round-close`, `closed`), the operator in the sender's own tab or the sender itself — a later
// turn waiting on something else, a newer question, its session's end or its hand-over
// (`withdrawn`). An answer relayed by another session's message is `by: 'message'` (`answered`),
// with that session's name in `author`. A question the coordinator withdrew as settled meanwhile
// (`round-close --withdraw`) is closed by it, with the evidence it read on the artifact in `evidence`.
// What the operator typed in the sender's tab (`by: 'tab'`) is kept in `typed`, cut at 500 characters
// with the cut said (tabText in supervision.ts); `text` keeps the reason. An entry answered from
// the record before it reached him (recordedAnswer) repeats that answer, `record` naming the entry
// that holds it.
export type RoundAnswer = { text: string; by: 'pane' | 'coordinator' | 'tab' | 'sender' | 'message'; at: string; author?: string; evidence?: string; typed?: string; record?: string }
export type RoundEntry = {
  id: string                    // `${sanitised session id}-${fingerprint(wait)}`, its wait unmarked, sanitised as supervision.ts sanitises store ids
  from: string                  // the sender's name (what relayText puts after « reply with SendMessage to: »), the answer's address when `session` is not live here
  session: string               // the sender's session id, as its $.session.id() answers: the answer's address, `{ sessionId }`, one session even when two share the name
  kind: 'operator' | 'done'
  since: string                 // the wait's waiting_since, ISO
  blocks: string | null         // null for 'done'
  question: string              // the turn's whole text above the machine line: the pane shows it whole (relayText cuts the message a remote coordinator receives)
  choices: RoundChoice[]        // empty, or 2 to 5 entries
  recommendation: string | null // a letter present in choices, or null
  status: 'open' | 'answered' | 'withdrawn' | 'closed'
  at: string                    // when the module wrote the entry, ISO
  answer: RoundAnswer | null
  urgent?: true                 // the sender marked its wait `(urgent)`: `coordinator.sh round` makes it due at once
  movedFrom?: string            // the session id of the predecessor this entry was moved from at a succession: the successor's own later question never supersedes it
  origin?: { machine: string; address: string } // a sender on another machine (remote-round.ts): its machine's label and the address its ask came from, written by this machine's module on receipt; absent for a sender on this machine
  delivery?: RoundDelivery      // the answer's trip back to its sender, written by the coordinator's module, and pending by `coordinator.sh round-close`
  partial?: string[]            // the answers the pane gave so far to an entry that asks several questions, each with its question's number
  consent?: ConsentSubject      // the subject the question asks the operator's consent on, as its sender declared it (declare_wait): his answer is written as its consent record
}

// An answer on its way to a remote sender: `pending` written with the answer, `sent` once the host
// took the line, `acked` once the sender's module acknowledged it, `failed` when the host refused it
// or no acknowledgment came after the last send (`reason`). `at` is the last transition's time,
// `attempts` the sends so far.
// An answer to a sender on this machine: `pending` written by round-close with the coordinator's
// answer, `delivered` once the host took the coordinator module's send, `failed` when it refused
// it or the send threw (`reason`), the pane's own sends written only when they fail. `answerAt` is
// the stamp of the answer it carries, so that a later answer is never said failed by it.
export type RoundDelivery = { state: 'pending' | 'sent' | 'acked' | 'delivered' | 'failed'; at: string; attempts: number; answerAt?: string; reason?: string }

// The question's text as the pane draws it: the emphasis markers around a span — `**x**`,
// `__x__`, `*x*`, `_x_` and backticks — dropped, the words kept; a marker inside a word
// (snake_case) or before a space (a `* ` list item) is no emphasis. Each span stays on its
// line. The entry itself keeps the text verbatim.
export function plainText(text: string): string {
  return textSpans(text).map(span => span.text).join('')
}

// The same text cut into the spans the pane draws, each mark it carried kept as a style: inline
// code, bold, italic. Joined, the spans are plainText's text. The markers are found as plainText
// always found them, then read as an opening and a closing mark around each span.
export type TextSpan = { text: string; code?: true; bold?: true; italic?: true }
const MARK = { code: ['\uE000', '\uE001'], bold: ['\uE002', '\uE003'], italic: ['\uE004', '\uE005'] } as const
export function textSpans(text: string): TextSpan[] {
  const marked = text
    .replace(/`([^`\n]+)`/g, `${MARK.code[0]}$1${MARK.code[1]}`)
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, `${MARK.bold[0]}$2${MARK.bold[1]}`)
    .replace(/(^|[^\w*])\*(?=[^\s*])([^\n*]*?[^\s*])\*(?![\w*])/gm, `$1${MARK.italic[0]}$2${MARK.italic[1]}`)
    .replace(/(^|[^\w])_(?=[^\s_])([^\n_]*?[^\s_])_(?!\w)/gm, `$1${MARK.italic[0]}$2${MARK.italic[1]}`)
  const spans: TextSpan[] = []
  const on = { code: 0, bold: 0, italic: 0 }
  let run = ''
  const flush = () => {
    if (run === '') return
    spans.push({ text: run, ...(on.code ? { code: true as const } : {}), ...(on.bold ? { bold: true as const } : {}), ...(on.italic ? { italic: true as const } : {}) })
    run = ''
  }
  for (const char of marked) {
    const mark = (Object.keys(MARK) as (keyof typeof MARK)[]).find(name => MARK[name].includes(char as never))
    if (!mark) {
      run += char
      continue
    }
    flush()
    on[mark] += char === MARK[mark][0] ? 1 : -1
  }
  flush()
  return spans
}

// The references to a pull request a text names, `<repository>#<number>`, one each wherever they
// stand: glued to another by a slash, a comma or nothing, each is its own. `at` is where it
// starts in the text. A sign `.` or `-` stuck before the repository's name is no part of it. An
// owner written before the name, `other/infra#5`, is kept as `owner`.
export type PrReference = { at: number; text: string; repo: string; number: number; owner?: string }
export function prReferences(text: string): PrReference[] {
  return [...text.matchAll(/(?:([A-Za-z0-9_.-]+)\/)?([A-Za-z0-9_.-]+)#(\d+)/g)].flatMap(found => {
    const owner = found[1]?.replace(/^[.-]+/, '')
    const repo = (found[2] ?? '').replace(/^[.-]+/, '')
    if (repo === '') return []
    const start = found.index! + found[0].length - `${repo}#${found[3]}`.length - (owner ? owner.length + 1 : 0)
    return [{ at: start, text: text.slice(start, found.index! + found[0].length), repo, number: Number(found[3]), ...(owner ? { owner } : {}) }]
  })
}

// The owner of each repository the module knows, by the repository's name: from the addresses
// it holds (`owner/name`, a pull request's `owner/name#<n>` too). A name two owners hold is
// ambiguous and has no owner: no guess. Anything else is no address and is skipped.
export function repositoryOwners(addresses: readonly (string | null | undefined)[]): Map<string, string> {
  const owners = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const address of addresses) {
    const found = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#\d+)?$/.exec(address ?? '')
    const [, owner, name] = found ?? []
    if (owner === undefined || name === undefined) continue
    if (owners.has(name) && owners.get(name) !== owner) ambiguous.add(name)
    else owners.set(name, owner)
  }
  for (const name of ambiguous) owners.delete(name)
  return owners
}

// A text cut at the references to a pull request it names: each reference with an owner, the one
// written before it or else the one known for its repository, is a link of its own to the pull
// request, the text around it plain. A name stuck to a word by a dot (`end.infra#195`) is read
// by what follows the dot when the whole is no known repository. A reference with no owner
// stays in the text.
export type PrLink = { href: string; text: string }
export function prPieces(text: string, owners: ReadonlyMap<string, string>): (string | PrLink)[] {
  const pieces: (string | PrLink)[] = []
  let at = 0
  for (const found of prReferences(text)) {
    let ref = found
    if (ref.owner === undefined && !owners.has(ref.repo) && ref.repo.includes('.')) {
      const cut = ref.repo.length - ref.repo.slice(ref.repo.lastIndexOf('.') + 1).length
      ref = { ...ref, at: ref.at + cut, text: ref.text.slice(cut), repo: ref.repo.slice(cut) }
    }
    const owner = ref.owner ?? owners.get(ref.repo)
    if (owner === undefined || ref.repo === '') continue
    if (ref.at > at) pieces.push(text.slice(at, ref.at))
    pieces.push({ href: `https://github.com/${owner}/${ref.repo}/pull/${ref.number}`, text: ref.text })
    at = ref.at + ref.text.length
  }
  if (at < text.length || pieces.length === 0) pieces.push(text.slice(at))
  return pieces
}

// The sender's numbering (`Question 3 of 4`, in its language) drawn as its two numbers with a
// slash between them, the same in every language: `Question 3 / 4`.
export function numberLabel(number: string): string {
  return number.replace(/(\d+)\D+?(\d+)/, '$1 / $2')
}

// The sender's latest row as the reconciliation reads it: when its reading was made and the operator
// questions it holds open, whatever the session is doing; null when the row does not say (a row of an
// older release, a wait file that vouches for nothing): unknown, never « none open ».
export type SenderState = { at: string; held: readonly HeldQuestion[] | null }

// How old an entry is before a row can drop it: the sender writes the entry, then its wait file, and a
// reading made between the two holds nothing yet.
export const SETTLE_MS = 5000

// An open operator question its sender's latest row no longer holds: the row is newer than the entry,
// says what it holds, and the question is not among it. An entry moved to a successor is the
// successor's by construction, and a question with choices stands beside another the sender holds
// (a wait that asks nothing never withdraws it, supervision.ts supersede).
export function droppedBy(entry: RoundEntry, sender: SenderState | null, now: number): boolean {
  if (!sender?.held || entry.status !== 'open' || entry.kind !== 'operator' || entry.movedFrom !== undefined) return false
  const [placed, read] = [Date.parse(entry.at), Date.parse(sender.at)]
  if (!Number.isFinite(placed) || !Number.isFinite(read) || read <= placed || now - placed < SETTLE_MS) return false
  if (sender.held.some(held => held.since === entry.since && held.blocks === (entry.blocks ?? ''))) return false
  return !(carriesChoices(entry) && sender.held.length > 0)
}

// The fingerprint of the wait an entry was written for, as the sender's wait file keeps it.
export function entryFingerprint(entry: Pick<RoundEntry, 'kind' | 'blocks' | 'question' | 'urgent'>): string {
  return fingerprint(entry.kind === 'operator'
    ? { kind: 'operator', blocks: entry.blocks ?? '', question: entry.question, ...(entry.urgent ? { urgent: true as const } : {}) }
    : { kind: 'done', question: entry.question })
}

// The id of a wait's entry: the session's and the wait's own fingerprint, so the same wait
// entered again lands on the same file, marked urgent or not. The store's own sanitising
// (supervision.ts sessionKey): an id is never trusted as a path.
export function roundEntryId(sessionId: string, wait: Wait): string {
  const plain = wait.kind === 'operator' ? { kind: wait.kind, blocks: wait.blocks, question: wait.question } : wait
  return `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}-${fingerprint(plain)}`
}

// The two choices of a consent question as the tool's description words them, « Accorder » then
// « Refuser », each a bold label opening a line with no letter before it: read as A and B, the
// label alone the choice's text (the answer a record quotes), the line itself staying in the body.
const NAMED_CHOICE = /^\s*[-*]\s+\*\*([^*\n]+)\*\*\s*(?:[:.)]|—|–|-|$)/
function namedChoices(question: string): Choice[] {
  const lines = question.split('\n')
  const block = lines.slice(Math.max(0, lines.findLastIndex(line => numberOfLine(line) !== null)))
  const labels = block.flatMap(line => NAMED_CHOICE.exec(line)?.[1]?.trim() ?? [])
  const [grant, refuse] = [CONSENT_GRANT, CONSENT_REFUSE]
  return labels.length === 2 && labels[0]?.toLowerCase() === grant.toLowerCase() && labels[1]?.toLowerCase() === refuse.toLowerCase()
    ? [{ letter: 'A', text: grant }, { letter: 'B', text: refuse }]
    : []
}

// The entry of an orchestrator's wait, open and unanswered, its question whole.
export function roundEntry(sessionId: string, from: string, wait: Wait, since: string, at: string): RoundEntry {
  if (wait.kind !== 'operator' && wait.kind !== 'done') throw new Error(`a ${wait.kind} wait is no round entry`)
  const parsed = parseChoices(wait.question)
  const { recommendation } = parsed
  const choices = parsed.choices.length > 0 || wait.kind !== 'operator' ? parsed.choices : namedChoices(wait.question)
  return {
    id: roundEntryId(sessionId, wait),
    from,
    session: sessionId,
    kind: wait.kind,
    since,
    blocks: wait.kind === 'operator' ? wait.blocks : null,
    question: wait.question,
    choices,
    recommendation,
    status: 'open',
    at,
    answer: null,
    ...(wait.kind === 'operator' && wait.urgent ? { urgent: true as const } : {}),
  }
}

export function roundPath(stateDir: string, id: string): string {
  return `${stateDir}/round/${id}.json`
}

// The open entries in the round's own order, the operator's ruling of 2026-10-31 (6.2): the
// urgent first, then the others; within each level grouped by sender, so one orchestrator's
// questions stay together, the groups by their earliest wait in that level, each in the order its
// waits began. `coordinator.sh round` prints the same order, with or without --by-urgency. The
// stamps are the module's own ISO strings, compared as text.
export function openEntries(entries: readonly RoundEntry[]): RoundEntry[] {
  const open = entries.filter(entry => entry.status === 'open')
  const bySince = (a: RoundEntry, b: RoundEntry) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0)
  return [true, false].flatMap(urgent => {
    const groups = new Map<string, RoundEntry[]>()
    for (const entry of open.filter(e => (e.urgent === true) === urgent).sort(bySince)) groups.set(entry.from, [...(groups.get(entry.from) ?? []), entry])
    return [...groups.values()].flat()
  })
}

// A wait whose text asks nothing the pane could offer: no question of it carries a lettered
// choice or a labelled field. A status report still waiting on an answer asked earlier, say.
export function asksNothing(entry: Pick<RoundEntry, 'question' | 'choices' | 'recommendation'>): boolean {
  return entryQuestions(entry).every(part => part.choices.length === 0 && questionShape(part.question, part.choices) === null)
}

// A question asked in prose: its text, by its last non-empty line trimmed, ends with « ? ». The
// pane draws it as a card with its free-text field, though it has no lettered choice and no
// labelled field; a status report ends otherwise and stays a line.
export function endsAsQuestion(entry: Pick<RoundEntry, 'question'>): boolean {
  const lines = entry.question.split('\n').map(line => line.trim()).filter(line => line !== '')
  return lines.length > 0 && (lines.at(-1) ?? '').endsWith('?')
}

// What the pane draws as a card: an operator entry that asks something, by its shape or by its
// closing « ? ». `asksNothing` alone stays the relay's reading of a wait, which withdraws nothing.
function isPaneQuestion(entry: RoundEntry): boolean {
  return entry.kind === 'operator' && (!asksNothing(entry) || endsAsQuestion(entry))
}

// An operator question that carries lettered choices, in any of its questions: the one a later
// wait asking nothing never withdraws. A closing proposal is none, whatever its text.
export function carriesChoices(entry: RoundEntry): boolean {
  return entry.kind === 'operator' && entryQuestions(entry).some(part => part.choices.length > 0)
}

// The open operator questions in the order the pane draws them: those that carry choices
// first, in the round's order among themselves, then those without. A question the operator can
// only answer in its session never hides one he can answer from the pane. A wait that asks
// nothing, with no lettered choice, no labelled field and no closing « ? », is no question: it has
// no card and is not counted, `waitsInTab` lists it for the line of its orchestrator's row. An entry that asks
// several questions is read by its first.
export function paneQuestions(entries: readonly RoundEntry[]): RoundEntry[] {
  const read = openEntries(entries)
    .filter(isPaneQuestion)
    .map(entry => ({ entry, first: entryQuestions(entry)[0] }))
  return [
    ...read.filter(({ first }) => (first?.choices.length ?? 0) > 0),
    ...read.filter(({ first }) => (first?.choices.length ?? 0) === 0),
  ].map(({ entry }) => entry)
}

// The open operator waits that ask nothing, in the round's order: the pane draws none as a card,
// and keeps the operator informed that the orchestrator waits on him, in its tab, with one line
// on that orchestrator's row (the open wait missing from the pane left the operator before an
// empty pane, his report of 2026-10-25).
export function waitsInTab(entries: readonly RoundEntry[]): RoundEntry[] {
  return openEntries(entries).filter(entry => entry.kind === 'operator' && !isPaneQuestion(entry))
}

// What the row's line says of such a wait: what it blocks, or the first line of its text.
export function waitSummary(entry: Pick<RoundEntry, 'blocks' | 'question'>): string {
  const blocks = (entry.blocks ?? '').trim()
  if (blocks !== '') return blocks
  return plainText(entry.question.split('\n').find(line => line.trim() !== '') ?? '').trim()
}

// An open question is due in the coordinator's tab when its sender marked it urgent, or when no
// pane of the coordinator is open to show it, the operator's ruling of 2026-10-24: whether he
// keeps the pane open decides where a question goes, and an open pane shows it for as long as
// it waits. `coordinator.sh round` marks the same entries `due`. Due or not, each new question is
// also told in one line to the coordinator's conversation (toldText), his ruling of 2026-11-04. A closing proposal is no
// question: the pane cannot rule it, and the tab always presents it. `now` is kept for the
// callers, the rule reading no age.
export function isDue(entry: RoundEntry, _now: number, paneOpen: boolean): boolean {
  if (entry.status !== 'open' || entry.kind !== 'operator') return false
  return entry.urgent === true || !paneOpen
}

// The one line the coordinator's conversation shows for a new question, pane open or not: its
// sender and what it blocks, never the question's text, which the round and the pane hold.
export function toldText(entry: Pick<RoundEntry, 'from' | 'blocks' | 'urgent'>): string {
  return `Question pending from ${entry.from} — blocks: ${(entry.blocks ?? '').trim() || '-'}${entry.urgent ? ' (urgent)' : ''}`
}

// The coordinator's wake for the questions just due: a report, never an order — it names them,
// and the round is read the usual way.
export function dueText(entries: readonly RoundEntry[]): string {
  const each = entries.map(entry => `${entry.from}, since ${entry.since} — blocks: ${entry.blocks ?? '-'}${entry.urgent ? ' (urgent)' : ''}`)
  return `[module] ${entries.length === 1 ? 'A question of the round is' : `${entries.length} questions of the round are`} now due in this tab: `
    + `${each.join('; ')}. Run coordinator.sh round and present the entries it marks due.`
}

// The prefix of the answer an entry the coordinator was shown is closed with by the pane.
export const PANE_CLOSED = 'answered from the pane: '

// The operator's own answer an entry holds, the record every later session of its project reads
// before he is asked again (recordedAnswer): his choice, its letter and text, or his own words,
// with its channel and the module's date. Given in the pane's picker, through the coordinator's
// round-close, or typed in the sender's tab when it names one choice unambiguously
// (answersChoice). A withdrawal on evidence, a sender's own settling or an answer relayed by
// message holds none.
export type RecordedAnswer = { letter: string | null; text: string; by: RoundAnswer['by']; at: string }
export function operatorAnswer(entry: RoundEntry): RecordedAnswer | null {
  const answer = entry.answer
  if (entry.kind !== 'operator' || !answer) return null
  const stamp = { by: answer.by, at: answer.at }
  if (answer.by === 'tab') {
    const chosen = answer.typed === undefined ? undefined : answersChoice(answer.typed, entry.choices)
    return chosen ? { letter: chosen.letter, text: chosen.text, ...stamp } : null
  }
  const own = answer.by === 'pane' || (answer.by === 'coordinator' && answer.evidence === undefined)
  if (!own) return null
  const text = answer.by === 'pane' && answer.text.startsWith(PANE_CLOSED) ? answer.text.slice(PANE_CLOSED.length) : answer.text
  return { ...givenAnswer(text, entry.choices), ...stamp }
}

const flatText = (text: string) => plainText(text).replace(/\s+/g, ' ').trim()

// What makes two questions one for the record, exactly: the sender's project (its session name's
// subject), what the question blocks (its parts split by `, `, spacing and case aside), the consent
// it asks, and the question block itself, its labelled fields, choices and recommendation as
// questionShape reads them, so that neither the text above the numbering line nor the numbering
// counts. An entry of several questions, a question in no shape or one that blocks nothing has no
// key, and is never answered from the record.
export function questionKey(entry: RoundEntry): string | null {
  if (entry.kind !== 'operator' || questionParts(entry.question).length !== 1) return null
  const shape = questionShape(entry.question, entry.choices)
  const blocks = (entry.blocks ?? '').split(', ').map(part => flatText(part).toLowerCase()).filter(part => part !== '').sort()
  if (!shape || blocks.length === 0) return null
  const consent = entry.consent ? [entry.consent.kind, entry.consent.repo.toLowerCase(), 'pr' in entry.consent ? entry.consent.pr : 'env' in entry.consent ? entry.consent.env : null] : null
  return JSON.stringify([
    parseSessionName(entry.from)?.subject ?? entry.from, blocks, consent,
    shape.fields.map(field => [flatText(field.label), flatText(field.text)]),
    entry.choices.map(choice => [choice.letter, flatText(choice.text)]),
    shape.recommendation ? flatText(shape.recommendation.text) : null,
  ])
}

// The record that answers an entry before it reaches the operator: of the entries of the round
// and its archive asking the same (questionKey), the newest answer of his own. The file of the
// entry's own id counts: the same session asking the same wait again lands on it.
export function recordedAnswer(entries: readonly RoundEntry[], entry: RoundEntry): { entry: RoundEntry; answer: RecordedAnswer } | null {
  const key = questionKey(entry)
  if (key === null) return null
  let found: { entry: RoundEntry; answer: RecordedAnswer } | null = null
  for (const other of entries) {
    if (questionKey(other) !== key) continue
    const answer = operatorAnswer(other)
    if (answer && (!found || answer.at > found.answer.at)) found = { entry: other, answer }
  }
  return found
}

// His recorded answer as it reads: the choice's letter and text, or his own words.
export function recordedChoice(answer: Pick<RecordedAnswer, 'letter' | 'text'>): string {
  return answer.letter === null ? answer.text : `${answer.letter} : ${answer.text}`
}

// What the asking session receives for a question answered from the record: when and where he
// answered it, and his answer.
export function recordedText(entry: RoundEntry, record: { entry: RoundEntry; answer: RecordedAnswer }): string {
  return `[module] Answered from the record, not asked again: the operator answered this question on ${record.answer.at} by ${record.answer.by} — `
    + `${recordedChoice(record.answer)} (entry ${record.entry.id}; question since ${entry.since}, blocks: ${entry.blocks})`
}
