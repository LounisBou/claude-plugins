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
// (`round-close`, `closed`), the operator in the sender's own tab or the sender's later turn
// waiting on something else (`withdrawn`).
export type RoundAnswer = { text: string; by: 'pane' | 'coordinator' | 'tab' | 'sender'; at: string }
export type RoundEntry = {
  id: string                    // `${sanitised session id}-${fingerprint(wait)}`, sanitised as supervision.ts sanitises store ids
  from: string                  // the sender's name, the address its answer goes back to (what relayText puts after « reply with SendMessage to: »)
  session: string               // the sender's session id
  kind: 'operator' | 'done'
  since: string                 // the wait's waiting_since, ISO
  blocks: string | null         // null for 'done'
  question: string              // the turn's whole text above the machine line: the pane shows it whole (relayText cuts the message a remote coordinator receives)
  choices: RoundChoice[]        // empty, or 2 to 5 entries
  recommendation: string | null // a letter present in choices, or null
  status: 'open' | 'answered' | 'withdrawn' | 'closed'
  at: string                    // when the module wrote the entry, ISO
  answer: RoundAnswer | null
}

// A choice as `/orchestrator:decide` step 2 writes it, one per line: `- **A** : <text>`. A line
// of that shape lettered past E is read too, so a sixth choice spoils the list instead of
// leaving the first five looking whole.
const CHOICE = /^\s*[-*]\s+\*\*([A-Z])\*\*\s*(?:[:.)]|—|–|-)\s*(.+?)\s*$/
// The recommendation's line, read by its shape: one italic word, `_Recommendation_ : A`, then a
// lone choice letter that ends the line or is followed by punctuation. The label's word is the
// operator's language.
const RECOMMENDATION = /^\s*_[^_\s]+\.?_\s*(?::\s*)?\**([A-E])\**\s*(?:$|[.,;:—–-](?:\s|$))/
const LETTERS = 'ABCDE'

// The lettered choices of a question and its recommendation. The choices are kept only
// when they read A, B, … in that order, two to five of them: anything else is no choice
// the pane could offer, and the question is answered in words. The recommendation is the
// first line that names one, kept only when its letter is among the kept choices.
export function parseChoices(question: string): { choices: RoundChoice[]; recommendation: string | null } {
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

// The question's text as the pane draws it: the emphasis markers around a span — `**x**`,
// `__x__`, `*x*`, `_x_` and backticks — dropped, the words kept; a marker inside a word
// (snake_case) or before a space (a `* ` list item) is no emphasis. Each span stays on its
// line. The entry itself keeps the text verbatim.
export function plainText(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^\n*]*?[^\s*])\*(?![\w*])/gm, '$1$2')
    .replace(/(^|[^\w])_(?=[^\s_])([^\n_]*?[^\s_])_(?!\w)/gm, '$1$2')
}

// The fingerprint of the wait an entry was written for, as the sender's wait file keeps it.
export function entryFingerprint(entry: Pick<RoundEntry, 'kind' | 'blocks' | 'question'>): string {
  return fingerprint(entry.kind === 'operator'
    ? { kind: 'operator', blocks: entry.blocks ?? '', question: entry.question }
    : { kind: 'done', question: entry.question })
}

// The id of a wait's entry: the session's and the wait's own fingerprint, so the same wait
// entered again lands on the same file. The store's own sanitising (supervision.ts
// sessionKey): an id is never trusted as a path.
export function roundEntryId(sessionId: string, wait: Wait): string {
  return `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}-${fingerprint(wait)}`
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

// The open operator questions in the order the pane draws them: those that carry choices
// first, in the round's order among themselves, then those without. A question the operator can
// only answer in its session never hides one he can answer from the pane.
export function paneQuestions(entries: readonly RoundEntry[]): RoundEntry[] {
  const questions = openEntries(entries).filter(entry => entry.kind === 'operator')
  return [...questions.filter(entry => entry.choices.length > 0), ...questions.filter(entry => entry.choices.length === 0)]
}
