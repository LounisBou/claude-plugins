// The goals file of a build (`goals.md`, beside its dispatch record): its header and its table,
// parsed and written here alone. `goals.ts` keeps the file; `succession.ts` reads it for the
// takeover's project sheet.
//
// The file is Markdown: `# Goals`, a header (`spec:`, `repo:`, `aim:`), then one table row per
// goal, `| id | status | goal | plan | evidence or ruling |`. A literal `|` in a cell is `\|`.

import { atWord } from '../../../../core/pr-ledger.ts'

export const STATUSES = ['open', 'met', 'ruled-out', 'deferred'] as const
export const HEADER = '| id | status | goal (verbatim from the spec) | plan | evidence or ruling |'
export const RULE = '|---|---|---|---|---|'
export const COMMENT = '<!-- Evidence is the goal\'s OUTCOME on an artifact, never the tool that would produce it. -->'

export interface GoalsHead {
  spec: string
  repo: string
  aim: string
}

export interface GoalRow {
  id: string
  status: string
  goal: string
  plan: string
  evidence: string
}

export interface GoalsFile {
  readonly head: GoalsHead
  readonly rows: GoalRow[]
}

/** A goals file that does not parse; its message names the file. */
export class GoalsFault extends Error {}

const CELLS = ['id', 'status', 'goal', 'plan', 'evidence'] as const

/** The text with every run of whitespace one space, and none at either end. */
export function collapse(text: string): string {
  return text.split(/\s+/).filter(word => word !== '').join(' ')
}

/** A cell as the file writes it: collapsed, a pipe escaped. */
export function escape(text: string): string {
  return collapse(text).replaceAll('|', '\\|')
}

/** The cells of one table row, `\|` read as a literal pipe. */
export function splitRow(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let k = 0; k < body.length; k++) {
    if (body[k] === '\\' && body[k + 1] === '|') {
      cell += '|'
      k++
    } else if (body[k] === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += body[k]
  }
  cells.push(cell.trim())
  return cells
}

/** The header and rows of a goals file's text; `path` names it in a fault. */
export function parseGoals(text: string, path: string): GoalsFile {
  const head: GoalsHead = { spec: '', repo: '', aim: '' }
  const rows: GoalRow[] = []
  for (const line of text.split('\n')) {
    const field = /^(spec|repo|aim):\s?(.*)$/s.exec(line)
    if (field && rows.length === 0) {
      head[field[1] as keyof GoalsHead] = (field[2] ?? '').trim()
      continue
    }
    const bare = line.trim()
    if (!line.startsWith('|') || bare === HEADER || bare === RULE || /^\|[-| :]+\|$/.test(bare)) continue
    const cells = splitRow(line)
    if (cells[0]?.toLowerCase() === 'id') continue
    if (cells.length !== CELLS.length) throw new GoalsFault(`${path}: a row does not have five cells: ${bare}`)
    const [id = '', status = '', goal = '', plan = '', evidence = ''] = cells
    rows.push({ id, status, goal, plan, evidence })
  }
  if (head.spec === '') throw new GoalsFault(`${path}: no spec: line`)
  return { head, rows }
}

/** One row as the table writes it. */
export function rowLine(row: GoalRow): string {
  return `| ${CELLS.map(key => escape(row[key])).join(' | ')} |`
}

/** The most of a goal's text its name keeps, cut at a word. */
const GOAL_WORDS_MAX = 60

/**
 * The goals still to reach, each by its words with its id after them, as the operator reads them:
 * « open: <words> (G2, plan: <phase>) ; <words> (G3, no phase) », then « — deferred: <words> (G4) ; … »
 * when one is deferred; « open: none » when none is open.
 */
export function namedGoals(rows: readonly GoalRow[]): string {
  const words = (row: GoalRow): string => atWord(row.goal, GOAL_WORDS_MAX) || row.id
  const open = rows.filter(row => row.status === 'open')
    .map(row => `${words(row)} (${row.id}, ${row.plan.trim() === '' ? 'no phase' : `plan: ${collapse(row.plan)}`})`)
  const deferred = rows.filter(row => row.status === 'deferred').map(row => `${words(row)} (${row.id})`)
  return `open: ${open.join(' ; ') || 'none'}${deferred.length === 0 ? '' : ` — deferred: ${deferred.join(' ; ')}`}`
}

/** The table: its header, its rule and one line per row. */
export function goalsTable(rows: readonly GoalRow[]): string {
  return [HEADER, RULE, ...rows.map(rowLine)].join('\n')
}

/** The whole file's text. */
export function renderGoals({ head, rows }: GoalsFile): string {
  return `${['# Goals', `spec: ${head.spec}`, `repo: ${head.repo}`, `aim: ${head.aim}`, COMMENT, '', goalsTable(rows)].join('\n')}\n`
}
