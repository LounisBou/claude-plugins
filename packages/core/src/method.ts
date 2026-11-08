// The method's formats, owned by the method plugin (decision 0006) and read by every role:
// the state file of a plan (`IMPLEMENTATION.md`) and the status line that ends a report.
// Defined here once; a role parses them through these functions, never with its own regex.

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

// ── The report's status ──────────────────────────────────────────────────────

/**
 * How a report ends, for every role: `done` (the work is delivered; concerns are named in the
 * report's deviations), `blocked` (it cannot go on without something it names), `question` (a
 * decision only the operator can take).
 */
export const REPORT_STATUSES = ['done', 'blocked', 'question'] as const
export type ReportStatus = typeof REPORT_STATUSES[number]

const STATUS_LINE = /^status: *(done|blocked|question)(?: *— *(.*))?$/

/** The status a report ends on, read from its last non-empty line; null when it ends otherwise. */
export function reportStatus(report: string): { status: ReportStatus; reason: string } | null {
  const last = report.split('\n').map(line => line.trim()).filter(line => line !== '').at(-1) ?? ''
  const match = STATUS_LINE.exec(last)
  if (!match) return null
  return { status: match[1] as ReportStatus, reason: (match[2] ?? '').trim() }
}
