// agent-row — the launcher puts an agent on its row: a spawn or a rotation given a brief reads the row
// the brief was printed for (`Row: <id>`, hooks/row-owner.ts) and has `dispatch-record.sh agent` write the
// agent's name on that row of the dispatch record, the one fact every reader of « who holds this row »
// reads against the live sessions. The record is the orchestration's own: one that holds the row open among
// those the calling session registered (core's registry) and those beside the brief, the one beside the
// brief first. A successor orchestrator registered none: the brief's own directory finds the record for it.
//
// The pull request's ledger line follows the agent (`dispatch-record.sh pr`, said in the hooks module's log):
// for a row's brief (`--working`), each line of that record whose pull request the row's label names before its
// detail (` (`, where it cites others), or that names the row's agent before this spawn when no other open row
// names it; for a review brief (hooks/review-reading.ts, `--review`), the line of the pull request it reads. A
// line parked, or waiting on the operator, is his, left as it is.
//
// The agent is already running when this is said: a record that cannot be written, or a brief that cannot
// be read, is told on stderr and the launch stays what it was.
import { dirname, join } from 'node:path'
import type { LauncherRequest } from '../../../core/launcher.ts'
import { recordsRegistryPath } from '../../../core/orchestration.ts'
import { agentsOf, everyAgentOf, ledgerLines, namesPr, prKey, waitsOnOperator, type LedgerLine } from '../../../core/pr-ledger.ts'
import { setting, type Env } from '../../../core/paths.ts'
import { readingOf, type Reading } from '../../../hooks/review-reading.ts'
import { isAgent, rowOfBrief } from '../../../hooks/row-owner.ts'
import { stateRoot } from '../../orchestrator/scripts/dispatch-record.ts'
import type { Run } from '../../orchestrator/scripts/lib/process.ts'

/** What putting an agent on its row reads outside the request. */
export interface RowDeps {
  readonly env: Env
  /** A file's text, or null when no file is there. */
  readonly read: (path: string) => string | null
  /** The names of the files of a directory, empty when it cannot be read. */
  readonly list: (dir: string) => readonly string[]
  readonly run: Run
  /** `dispatch-record.sh`. */
  readonly script: string
  readonly warn: (line: string) => void
  /** One line in the hooks module's log. */
  readonly log: (line: string) => Promise<void>
}

/** The spawn's options a request launches an agent with: its own, or its rotation's. */
function spawnOf(request: LauncherRequest): LauncherRequest['options'] | null {
  if (request.command === 'spawn') return request.options
  return request.command === 'rotate' && request.rest !== undefined ? request.rest.options : null
}

/** The open rows of a record's text. */
function openRows(text: string): Record<string, unknown>[] {
  return text.split('\n').flatMap(line => {
    try {
      const row: unknown = JSON.parse(line)
      const read = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>
      return read['state'] === 'open' ? [read] : []
    } catch {
      return []
    }
  })
}

/** The open row of that id in a record's text, or undefined when it holds none. */
const openRow = (text: string, id: number): Record<string, unknown> | undefined => openRows(text).find(row => row['id'] === id)

/**
 * The agent a row named until now, whose pull requests pass to the one spawned for it; none when another open row
 * names it too, which they may be of.
 */
function formerAgent(text: string, id: number): string | undefined {
  const held = openRow(text, id)?.['agent']
  if (typeof held !== 'string') return undefined
  return openRows(text).some(row => row['id'] !== id && isAgent(row['agent'], held)) ? undefined : held
}

/** The records an agent of this brief may stand in: those the calling session registered, and those beside the brief. */
function recordsOf(brief: string, deps: RowDeps): string[] {
  const session = setting(deps.env, 'CLAUDE_CODE_SESSION_ID') ?? ''
  const registry = session === '' ? '' : deps.read(recordsRegistryPath(stateRoot(deps.env), session)) ?? ''
  const beside = deps.list(dirname(brief)).filter(name => name.endsWith('.jsonl') && !name.endsWith('.archive.jsonl')).map(name => join(dirname(brief), name))
  const known = registry.split('\n').map(path => path.trim()).filter(path => path !== '')
  return [...new Set([...known, ...beside])]
}

/** Whether a line is the operator's: parked, or waiting on him. */
const isOperators = (line: LedgerLine): boolean => line.status === 'parked' || (line.status === 'waiting' && waitsOnOperator(line.on))

/** Puts the agent, by `flag`, on the ledger lines of a record's text that `pick` takes; `why` says in the log what binds it to them. */
async function attach(title: string, flag: '--working' | '--review', record: string, text: string, pick: (line: LedgerLine) => boolean, why: string, deps: RowDeps): Promise<void> {
  for (const line of ledgerLines(text)) {
    if (isOperators(line) || agentsOf(line)[0] === title || !pick(line)) continue
    const key = prKey(line.repo, line.pr)
    const said = await deps.run(['bash', deps.script, 'pr', record, key, flag, title], { stderr: 'pipe' })
    if (said.status !== 0) deps.warn(`spawn: warning: ${title} was not attached to ${key} of ${record}: ${(said.stderr || said.stdout).trim()}`)
    else await deps.log(`${key} attached to ${title}, ${why} ${record}`)
  }
}

/** A review session stands on no row: it is attached to the line of the pull request its brief reads. */
async function recordReviewer(title: string, brief: string, read: Reading, deps: RowDeps): Promise<void> {
  const reads = (line: LedgerLine): boolean => line.pr === read.pr && line.repo.split('/')[1]?.toLowerCase() === read.project.toLowerCase()
  for (const record of recordsOf(brief, deps)) await attach(title, '--review', record, deps.read(record) ?? '', reads, 'spawned for its review in', deps)
}

/**
 * Writes the agent a request launched on its row of the dispatch record, and on its pull request's ledger line.
 * Nothing for a launch with no brief, a title that is no agent's, or a brief that names no row and reads no pull
 * request (a comments pass).
 */
export async function recordAgent(request: LauncherRequest, deps: RowDeps): Promise<void> {
  const options = spawnOf(request)
  const brief = typeof options?.['start_brief'] === 'string' ? options['start_brief'] : ''
  const title = typeof options?.['title'] === 'string' ? options['title'] : ''
  if (brief === '' || !title.startsWith('Agent: ')) return
  const text = deps.read(brief)
  if (text === null) {
    deps.warn(`spawn: warning: ${title} is on no row: its brief ${brief} cannot be read; put it there with dispatch-record.sh agent <record> <id> "${title}"`)
    return
  }
  const reading = readingOf(text)
  if (reading !== null) return recordReviewer(title, brief, reading, deps)
  const row = rowOfBrief(text)
  if (row === undefined) return
  const holding = recordsOf(brief, deps).filter(path => openRow(deps.read(path) ?? '', Number(row)) !== undefined)
  const nearest = holding.filter(path => dirname(path) === dirname(brief))
  const record = nearest.length === 1 ? nearest[0] : holding.length === 1 ? holding[0] : undefined
  if (record === undefined) {
    deps.warn(`spawn: warning: ${title} is on no row: ${holding.length === 0 ? `no dispatch record this session registered or beside its brief holds row ${row} open` : `row ${row} is open in ${holding.join(', ')}`}; put it there with dispatch-record.sh agent <record> ${row} "${title}"`)
    return
  }
  // Read before the write, which puts the spawned agent in its place.
  const before = deps.read(record) ?? ''
  const former = formerAgent(before, Number(row))
  const said = await deps.run(['bash', deps.script, 'agent', record, row, title], { stderr: 'pipe' })
  if (said.status !== 0) {
    deps.warn(`spawn: warning: ${title} was not put on row ${row} of ${record}: ${(said.stderr || said.stdout).trim()}`)
    return
  }
  const label = openRow(before, Number(row))?.['label']
  const named = typeof label === 'string' ? label.split(/\s\(/u)[0] ?? '' : ''
  const ofRow = (line: LedgerLine): boolean => namesPr(named, line) || (former !== undefined && everyAgentOf(line).some(name => isAgent(name, former)))
  await attach(title, '--working', record, before, ofRow, `spawned for row ${row} of`, deps)
}
