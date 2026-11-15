// The method's formats, owned by the method plugin (decision 0006) and read by every role:
// the state file of a plan (`IMPLEMENTATION.md`), the status line that ends a report and the
// operator's question block (`**Question i of N**`). Defined here once; a role parses them
// through these functions, never with its own regex.

// ── The state file ───────────────────────────────────────────────────────────

/** A row of the state table: `| NN | title | status | milestone |`. */
export interface Row {
  readonly phase: string
  readonly title: string
  readonly status: string
  readonly milestone: string
}

export interface State {
  codename: string | null
  title: string | null
  branch: string | null
  bump: string | null
  artifacts: string | null
  base: string | null
  rows: Row[]
}

type HeaderKey = 'codename' | 'title' | 'branch' | 'bump' | 'artifacts' | 'base'

const HEADER = /^\*\*(Codename|Title|Branch|Bump|Artifacts|Base)\*\*: *(.*)$/
const ROW = /^\| *([0-9]+) *\|([^|]*)\| *([a-z]+) *\|([^|]*)\|/

/** A row's status: not begun, under way, or closed on its last commit. */
export const ROW_STATUSES = ['todo', 'doing', 'done'] as const
export type RowStatus = typeof ROW_STATUSES[number]

const isRowStatus = (value: string): value is RowStatus => ROW_STATUSES.some(status => status === value)

export function parseState(text: string): State {
  const state: State = { codename: null, title: null, branch: null, bump: null, artifacts: null, base: null, rows: [] }
  for (const line of text.split('\n')) {
    const header = HEADER.exec(line)
    if (header) {
      state[(header[1] ?? '').toLowerCase() as HeaderKey] = (header[2] ?? '').trim()
      continue
    }
    const row = ROW.exec(line)
    if (row) state.rows.push({ phase: row[1] ?? '', title: (row[2] ?? '').trim(), status: row[3] ?? '', milestone: (row[4] ?? '').trim() })
  }
  return state
}

/** The phase to run: the first row whose status is not done. */
export function nextRow(rows: readonly Row[]): Row | null {
  return rows.find(row => row.status !== 'done') ?? null
}

/** `3`, `03` and `003` all name row 03: the number is written on two digits. */
export function twoDigits(phase: string | number): string | null {
  const text = String(phase).trim()
  if (!/^[0-9]+$/.test(text)) return null
  return String(Number(text)).padStart(2, '0')
}

/** One row rewritten in place, every other line untouched. A todo row leaves the milestone empty. */
export function markRow(text: string, phase: string | number, status: string, milestone: string):
{ text: string; row: Row } | { error: string } {
  const wanted = twoDigits(phase)
  if (wanted === null) return { error: `not a phase number: ${phase}` }
  if (!isRowStatus(status)) return { error: `status must be todo, doing or done, not ${status}` }
  if (status !== 'todo' && !/^[0-9a-f]{4,40}$/.test(milestone)) return { error: `a ${status} row needs a commit sha as its milestone, not "${milestone}"` }
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    const found = ROW.exec(line)
    if (!found || twoDigits(found[1] ?? '') !== wanted) continue
    const row: Row = { phase: found[1] ?? '', title: (found[2] ?? '').trim(), status, milestone: status === 'todo' ? '' : milestone }
    lines[i] = `| ${row.phase} | ${row.title} | ${row.status} | ${row.milestone} |`
    return { text: lines.join('\n'), row }
  }
  return { error: `no row ${wanted} in the state table` }
}

// ── The line a message ends on ───────────────────────────────────────────────

const HANDLED_MARKUP_START = /^[`*_ \t]+/g
const HANDLED_MARKUP_END = /[`*_ \t]+$/g

// A line as the machine would read it, whatever the markup a model wrote it in: backticks, bold or
// italics, a quote or a bullet mark, surrounding spaces, one trailing period.
function normalise(line: string): string {
  line = line.trim()
  for (;;) {
    const before = line
    line = line.replace(HANDLED_MARKUP_START, '').replace(HANDLED_MARKUP_END, '')
    if (line.startsWith('>')) line = line.slice(1)
    else if (/^[-*]\s/.test(line)) line = line.slice(1)
    else if (line.endsWith('.')) line = line.slice(0, -1)
    if (line === before) return line
  }
}

/** The last non-empty line of a message, normalised: the line every machine ending is read on. */
export function machineLine(message: string): string {
  const lines = message.split('\n').filter(l => l.trim() !== '')
  return lines.length > 0 ? normalise(lines[lines.length - 1] ?? '') : ''
}

// ── The report's status ──────────────────────────────────────────────────────

/**
 * How a report ends, for every role: `done` (the work is delivered; concerns are named in the
 * report's deviations), `blocked` (it cannot go on without something it names), `question` (a
 * decision only the operator can take).
 */
export const REPORT_STATUSES = ['done', 'blocked', 'question'] as const
export type ReportStatus = typeof REPORT_STATUSES[number]

/** What a status line may say: a report's ending, or `waiting` while an agent's own background work runs. */
export type StatusWord = ReportStatus | 'waiting'

const STATUS_LINE = /^status:\s*(done|blocked|question|waiting)\b\s*(?:(?:—|–|--|-|:)\s*(.*))?$/i

/** The status a message ends on, read from its last non-empty line; null when it ends otherwise. */
export function reportStatus(report: string): { status: StatusWord; reason: string } | null {
  const match = STATUS_LINE.exec(machineLine(report))
  if (!match) return null
  return { status: (match[1] ?? '').toLowerCase() as StatusWord, reason: (match[2] ?? '').trim() }
}

// ── The operator's question block ────────────────────────────────────────────

/** A lettered choice of a question, `A` to `E`. */
export type Choice = { letter: string; text: string }

// A choice as `/orchestrator-decide` step 2 writes it, one per line: `- **A** : <text>`.
const CHOICE = /^\s*[-*]\s+\*\*([A-Z])\*\*\s*(?:[:.)]|—|–|-)\s*(.+?)\s*$/
// The recommendation's line, read by its shape: an italic label, `_Recommendation_ : A`, then a
// lone choice letter that ends the line or is followed by punctuation. The label's words are the
// operator's language, one or several.
const RECOMMENDATION = /^\s*_[^_\n]*[^_\s]_\s*(?::\s*)?\**([A-E])\**\s*(?:$|[.,;:—–-](?:\s|$))/
const LETTERS = 'ABCDE'

/*
 * Where a question's block starts: its numbering line (`**Question 1 of 1**`), or the top of the
 * text when it has none. A turn end may restate the lettered choices in a prose summary above the
 * block; only what the block holds is read as choices.
 */
function blockStart(lines: readonly string[]): number {
  return Math.max(0, lines.findIndex(line => NUMBER.test(line)))
}

function readChoices(question: string): { choices: Choice[]; recommendation: string | null } {
  const all = question.split('\n')
  const lines = all.slice(blockStart(all))
  const found = lines.flatMap(line => {
    const matched = CHOICE.exec(line)
    return matched ? [{ letter: matched[1] ?? '', text: matched[2] ?? '' }] : []
  })
  const lettered = found.length >= 2 && found.length <= LETTERS.length && found.every((choice, i) => choice.letter === LETTERS[i])
  const choices = lettered ? found : []
  const named = lines.map(line => RECOMMENDATION.exec(line)?.[1] ?? null).find(letter => letter !== null) ?? null
  return { choices, recommendation: named !== null && choices.some(choice => choice.letter === named) ? named : null }
}

/**
 * The lettered choices of a question and its recommendation. The choices are kept only when they
 * read A, B, … in that order, two to five of them: anything else is no choice a pane could offer.
 * The recommendation is the first line that names one, kept only when its letter is among the kept
 * choices. A text holding several numbered questions records its first one's.
 */
export function parseChoices(question: string): { choices: Choice[]; recommendation: string | null } {
  return readChoices(questionParts(question)[0] ?? '')
}

// The sender's own numbering: a line wholly bold holding two numbers, a word before the first and
// a word or a slash between them, `**Question 5 of 6**`; `**Version 1.2**` is no numbering.
const NUMBER = /^\s*\*\*([^*\n\d]*\p{L}[^*\n\d]*\d+[^*\n\d]*[\p{L}/][^*\n\d]*\d+[^*\n]*)\*\*\s*$/u

/**
 * The questions of a text, one text each: a turn may ask several in the decide shape, each under
 * its own numbering line (`**Question 3 of 4**`, in the sender's language). Two such lines or more
 * split the text before each, the first question keeping what precedes its own. One line or none:
 * the text whole.
 */
function questionParts(question: string): string[] {
  const lines = question.split('\n')
  const heads = lines.flatMap((line, i) => (NUMBER.test(line) ? [i] : []))
  if (heads.length < 2) return [question]
  return heads.map((head, k) => lines.slice(k === 0 ? 0 : head, heads[k + 1] ?? lines.length).join('\n').trimEnd())
}
