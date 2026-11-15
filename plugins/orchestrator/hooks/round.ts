// hooks/round.ts
// The coordinator's round, as the module keeps it on this machine: one file per wait an
// orchestrator ended its turn on, under the state directory's round/ (roundPath), written
// whole and renamed into place by the relay (supervision.ts) in place of a message, so a
// closing proposal waits in the round without costing the coordinator's model a turn. The
// questions for the operator are asked with `ask` (question.ts), whose objects share the
// directory; the coordinator reads the round with `coordinator.sh round` when the operator
// speaks to it, and closes an entry with the coordinator's `settle`. A file that does not
// parse is skipped by every reader, never repaired. Pure on purpose, like relay.ts: the
// handler holds the $.
import { fingerprint, type Wait } from './relay.ts'
import { type ConsentSubject } from '../core/consent-record.ts'
import { parseChoices, type Choice } from '../core/method.ts'

export type RoundChoice = Choice   // letter: one of 'A' to 'E'
// Who settled the entry: the operator from the pane (`answered`), the coordinator
// (`settle`, `closed`), the operator in the sender's own tab or the sender itself — a later
// turn waiting on something else, a newer question, its session's end or its hand-over
// (`withdrawn`). An answer relayed by another session's message is `by: 'message'` (`answered`),
// with that session's name in `author`. A question the coordinator withdrew as settled meanwhile
// (`settle`, withdrawn) is closed by it, with the evidence it read on the artifact in `evidence`.
// What the operator typed in the sender's tab (`by: 'tab'`) is kept in `typed`, cut at 500 characters
// with the cut said (tabText in supervision.ts); `text` keeps the reason. A question answered
// from the record before it reached him repeats that answer, `record` naming the question that
// holds it (question.ts).
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
  origin?: { machine: string; address: string; line?: 'q' } // a sender on another machine (remote-round.ts): its machine's label, the address its ask came from, and `q` when it came by the event line (none: an older machine's ask line, answered in that line), written by this machine's module on receipt; absent for a sender on this machine
  delivery?: RoundDelivery      // the answer's trip back to its sender, written by the coordinator's module, and pending by the coordinator's `settle`
  consent?: ConsentSubject      // the subject the question asks the operator's consent on, as its sender declared it (declare_wait): his answer is written as its consent record
}

// An answer on its way to a remote sender: `pending` written with the answer, `sent` once the host
// took the line, `acked` once the sender's module acknowledged it, `failed` when the host refused it
// or no acknowledgment came after the last send (`reason`). `at` is the last transition's time,
// `attempts` the sends so far.
// An answer to a sender on this machine: `pending` written by settle with the coordinator's
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

// An open question is due in the coordinator's tab when its sender marked it urgent, or when no
// pane of the coordinator is open to show it, the operator's ruling of 2026-10-24: whether he
// keeps the pane open decides where a question goes, and an open pane shows it for as long as
// it waits. `coordinator.sh round` marks the same entries `due`. A question the open pane shows
// puts nothing in the coordinator's conversation. A closing proposal is no question: the pane
// cannot rule it, and the tab always presents it. `now` is kept for the callers, the rule reading
// no age.
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

