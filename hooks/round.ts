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
import { fingerprint, type Wait } from './relay.ts'

export type RoundChoice = { letter: string; text: string }   // letter: one of 'A' to 'E'
// Who settled the entry: the operator from the pane (`answered`), the coordinator
// (`round-close`, `closed`), the operator in the sender's own tab or the sender itself — a later
// turn waiting on something else, a newer question, its session's end or its hand-over
// (`withdrawn`).
export type RoundAnswer = { text: string; by: 'pane' | 'coordinator' | 'tab' | 'sender'; at: string }
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
}

// A choice as `/orchestrator-decide` step 2 writes it, one per line: `- **A** : <text>`. A line
// of that shape lettered past E is read too, so a sixth choice spoils the list instead of
// leaving the first five looking whole.
const CHOICE = /^\s*[-*]\s+\*\*([A-Z])\*\*\s*(?:[:.)]|—|–|-)\s*(.+?)\s*$/
// The recommendation's line, read by its shape: an italic label, `_Recommendation_ : A`, then a
// lone choice letter that ends the line or is followed by punctuation. The label's words are the
// operator's language, one or several.
const RECOMMENDATION = /^\s*_[^_\n]*[^_\s]_\s*(?::\s*)?\**([A-E])\**\s*(?:$|[.,;:—–-](?:\s|$))/
const LETTERS = 'ABCDE'

// The lettered choices of a question and its recommendation. The choices are kept only
// when they read A, B, … in that order, two to five of them: anything else is no choice
// the pane could offer, and the question is answered in words. The recommendation is the
// first line that names one, kept only when its letter is among the kept choices.
// An entry holding several numbered questions (questionParts) records its first one's: the
// pane reads every question's own from the text (entryQuestions).
export function parseChoices(question: string): { choices: RoundChoice[]; recommendation: string | null } {
  return readChoices(questionParts(question)[0])
}

function readChoices(question: string): { choices: RoundChoice[]; recommendation: string | null } {
  const lines = question.split('\n')
  const found = lines.flatMap(line => {
    const matched = CHOICE.exec(line)
    return matched ? [{ letter: matched[1], text: matched[2] }] : []
  })
  const lettered = found.length >= 2 && found.length <= LETTERS.length && found.every((choice, i) => choice.letter === LETTERS[i])
  const choices = lettered ? found : []
  const named = lines.map(line => RECOMMENDATION.exec(line)?.[1] ?? null).find(letter => letter !== null) ?? null
  return { choices, recommendation: named !== null && choices.some(choice => choice.letter === named) ? named : null }
}

// The question as the pane shows it above its choices: the whole text, less the choice lines
// and the recommendation's line when the choices were read, since the pane draws them below.
export function questionBody(entry: Pick<RoundEntry, 'question' | 'choices'>): string {
  if (entry.choices.length === 0) return entry.question.trim()
  return entry.question.split('\n').filter(line => !CHOICE.test(line) && !RECOMMENDATION.test(line)).join('\n').trim()
}

// A field of a question in the decide shape, `_<label>_ : <text>`, the label in the operator's
// language and read by its shape alone. The colon may have spaces around it or none: one with a
// space before it is drawn « label : text », one without « label: text ».
const FIELD = /^\s*_([^_\n]*[^_\s])_(\s*:\s*)(.*?)\s*$/
// The sender's own numbering: a line wholly bold holding two numbers, a word before the first and
// a word or a slash between them, `**Question 5 of 6**`; `**Version 1.2**` is no numbering.
const NUMBER = /^\s*\*\*([^*\n\d]*\p{L}[^*\n\d]*\d+[^*\n\d]*[\p{L}/][^*\n\d]*\d+[^*\n]*)\*\*\s*$/u
// A field after the choices whose text starts with a lone choice letter: the recommendation.
const NAMES_LETTER = /^\**([A-E])\**(?:$|[\s.,;:—–-])/

// The questions of an entry, one text each: a turn may ask several in the decide shape, each
// under its own numbering line (`**Question 3 of 4**`, in the sender's language). Two such lines
// or more split the text before each, the first question keeping what precedes its own (the
// previous answer's record, which questionShape drops). One line or none: the text whole.
export function questionParts(question: string): string[] {
  const lines = question.split('\n')
  const heads = lines.flatMap((line, i) => (NUMBER.test(line) ? [i] : []))
  if (heads.length < 2) return [question]
  return heads.map((head, k) => lines.slice(k === 0 ? 0 : head, heads[k + 1] ?? lines.length).join('\n').trimEnd())
}

// One question of an entry as the pane presents it: its own text, the sender's numbering, its
// choices and its recommendation. An entry of one question keeps what it recorded; one of
// several reads each question's from its own text.
export type QuestionPart = { question: string; number: string | null; choices: RoundChoice[]; recommendation: string | null }
export function entryQuestions(entry: Pick<RoundEntry, 'question' | 'choices' | 'recommendation'>): QuestionPart[] {
  const parts = questionParts(entry.question)
  const read = parts.length < 2
    ? [{ question: entry.question, choices: entry.choices, recommendation: entry.recommendation }]
    : parts.map(part => ({ question: part, ...readChoices(part) }))
  return read.map(part => ({
    question: part.question,
    number: questionShape(part.question, part.choices)?.number ?? null,
    choices: part.choices,
    recommendation: part.recommendation,
  }))
}

export type QuestionField = { label: string; separator: string; text: string }
export type QuestionShape = { number: string | null; fields: QuestionField[]; recommendation: QuestionField | null }

// A question in the decide shape as the pane draws it: the sender's numbering, its labelled
// fields in the order written (a field runs on until a blank line, the next field or a choice;
// an empty one is a heading) and its recommendation, the first field after the choices that
// names one of them. Nothing else of the turn is kept: what comes before the numbering line (the
// previous answer's record), lines no field holds, anything after the recommendation. A question
// with no labelled field before its choices is in an older shape: null, and the pane draws its
// body whole (questionBody).
export function questionShape(question: string, choices: readonly RoundChoice[]): QuestionShape | null {
  const lines = question.split('\n')
  const header = lines.findIndex(line => NUMBER.test(line))
  const choiceAt = (line: string) => choices.length > 0 && CHOICE.test(line)
  const lastChoice = lines.reduce((last, line, i) => (i > header && choiceAt(line) ? i : last), -1)
  const fields: QuestionField[] = []
  let recommendation: QuestionField | null = null
  let current: QuestionField | null = null
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i]
    if (choiceAt(line)) {
      current = null
      continue
    }
    const field = FIELD.exec(line)
    if (field) {
      const read = { label: field[1].trim(), separator: /^\s/.test(field[2]) ? ' : ' : ': ', text: field[3] }
      if (lastChoice >= 0 && i > lastChoice) {
        const letter = NAMES_LETTER.exec(read.text)?.[1]
        if (letter && choices.some(choice => choice.letter === letter)) {
          recommendation = read
          break
        }
        current = null
        continue
      }
      fields.push(read)
      current = read
      continue
    }
    if (line.trim() === '') current = null
    else if (current) current.text = current.text === '' ? line.trim() : `${current.text}\n${line.trim()}`
  }
  if (fields.length === 0) return null
  return { number: header >= 0 ? NUMBER.exec(lines[header])![1].trim() : null, fields, recommendation }
}

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
    const repo = found[2].replace(/^[.-]+/, '')
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
    if (!found) continue
    if (owners.has(found[2]) && owners.get(found[2]) !== found[1]) ambiguous.add(found[2])
    else owners.set(found[2], found[1])
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

// The entry of an orchestrator's wait, open and unanswered, its question whole.
export function roundEntry(sessionId: string, from: string, wait: Wait, since: string, at: string): RoundEntry {
  if (wait.kind !== 'operator' && wait.kind !== 'done') throw new Error(`a ${wait.kind} wait is no round entry`)
  const { choices, recommendation } = parseChoices(wait.question)
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

// The open entries in the round's own order (the coordination skill's): grouped by sender,
// so one orchestrator's questions stay together; the groups by their earliest wait, each in
// the order its waits began. The stamps are the module's own ISO strings, compared as text.
export function openEntries(entries: readonly RoundEntry[]): RoundEntry[] {
  const open = entries.filter(entry => entry.status === 'open')
  const bySince = (a: RoundEntry, b: RoundEntry) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0)
  const groups = new Map<string, RoundEntry[]>()
  for (const entry of [...open].sort(bySince)) groups.set(entry.from, [...(groups.get(entry.from) ?? []), entry])
  return [...groups.values()].flat()
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
  return lines.length > 0 && lines[lines.length - 1].endsWith('?')
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
    ...read.filter(({ first }) => first.choices.length > 0),
    ...read.filter(({ first }) => first.choices.length === 0),
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

// The open operator entry a session keeps in sight in its own tab: its own, whatever it asks,
// the pane's first question first (choices, then labelled fields) and a wait that asks nothing
// after them. Null when it has none open.
export function tabQuestion(entries: readonly RoundEntry[], session: string): RoundEntry | null {
  const own = entries.filter(entry => entry.session === session)
  return paneQuestions(own)[0] ?? waitsInTab(own)[0] ?? null
}

// An open question is due in the coordinator's tab when its sender marked it urgent, or when no
// pane of the coordinator is open to show it, the operator's ruling of 2026-10-24: whether he
// keeps the pane open decides where a question goes, and an open pane shows it for as long as
// it waits. `coordinator.sh round` marks the same entries `due`. A closing proposal is no
// question: the pane cannot rule it, and the tab always presents it. `now` is kept for the
// callers, the rule reading no age.
export function isDue(entry: RoundEntry, _now: number, paneOpen: boolean): boolean {
  if (entry.status !== 'open' || entry.kind !== 'operator') return false
  return entry.urgent === true || !paneOpen
}

// The coordinator's wake for the questions just due: a report, never an order — it names them,
// and the round is read the usual way.
export function dueText(entries: readonly RoundEntry[]): string {
  const each = entries.map(entry => `${entry.from}, since ${entry.since} — blocks: ${entry.blocks ?? '-'}${entry.urgent ? ' (urgent)' : ''}`)
  return `[module] ${entries.length === 1 ? 'A question of the round is' : `${entries.length} questions of the round are`} now due in this tab: `
    + `${each.join('; ')}. Run coordinator.sh round and present the entries it marks due.`
}
