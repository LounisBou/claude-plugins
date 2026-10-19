// hooks/round.ts
// The coordinator's round, as the module keeps it on this machine: one file per wait an
// orchestrator ended its turn on, under the state directory's round/ (roundPath), written
// whole and renamed into place by the relay (supervision.ts) in place of a message, so a
// question waits in the round without costing the coordinator's model a turn. The pane of
// the coordinator draws the first open question with its lettered choices; the coordinator
// reads the round with `coordinator.sh round` when the operator speaks to it, and closes an
// entry with `coordinator.sh round-close`. A file that does not parse is skipped by every
// reader, never repaired. Pure on purpose, like relay.ts: the handler holds the $.
import { cutQuestion, fingerprint, type Wait } from './relay.ts'

export type RoundChoice = { letter: string; text: string }   // letter: one of 'A' to 'E'
export type RoundAnswer = { text: string; by: 'pane' | 'coordinator' | 'tab'; at: string }
export type RoundEntry = {
  id: string                    // `${sanitised session id}-${fingerprint(wait)}`, sanitised as supervision.ts sanitises store ids
  from: string                  // the sender's name, the address its answer goes back to (what relayText puts after « reply with SendMessage to: »)
  session: string               // the sender's session id
  kind: 'operator' | 'done'
  since: string                 // the wait's waiting_since, ISO
  blocks: string | null         // null for 'done'
  question: string              // the turn's text above the machine line, cut past RELAY_CAP and the cut said, exactly as relayText cuts it
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

// The entry of an orchestrator's wait, open and unanswered. Its id is the session's and the
// wait's own fingerprint, so the same wait entered again lands on the same file. The choices
// are read from the whole question, so a question cut past the cap keeps them.
export function roundEntry(sessionId: string, from: string, wait: Wait, since: string, at: string): RoundEntry {
  if (wait.kind !== 'operator' && wait.kind !== 'done') throw new Error(`a ${wait.kind} wait is no round entry`)
  const { choices, recommendation } = parseChoices(wait.question)
  return {
    // The store's own sanitising (supervision.ts sessionKey): an id is never trusted as a path.
    id: `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}-${fingerprint(wait)}`,
    from,
    session: sessionId,
    kind: wait.kind,
    since,
    blocks: wait.kind === 'operator' ? wait.blocks : null,
    question: cutQuestion(wait.question),
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
