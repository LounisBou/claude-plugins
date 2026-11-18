// agent-row — the launcher puts an agent on its row: a spawn or a rotation given a brief reads the row
// the brief was printed for (`Row: <id>`, hooks/row-owner.ts) and has `dispatch-record.sh agent` write the
// agent's name on that row of the dispatch record, the one fact every reader of « who holds this row »
// reads against the live sessions. The record is the orchestration's own: one that holds the row open among
// those the calling session registered (core's registry) and those beside the brief, the one beside the
// brief first. A successor orchestrator registered none: the brief's own directory finds the record for it.
//
// The agent is already running when this is said: a record that cannot be written, or a brief that cannot
// be read, is told on stderr and the launch stays what it was.
import { dirname, join } from 'node:path'
import type { LauncherRequest } from '../../../core/launcher.ts'
import { recordsRegistryPath } from '../../../core/orchestration.ts'
import { setting, type Env } from '../../../core/paths.ts'
import { rowOfBrief } from '../../../hooks/row-owner.ts'
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
}

/** The spawn's options a request launches an agent with: its own, or its rotation's. */
function spawnOf(request: LauncherRequest): LauncherRequest['options'] | null {
  if (request.command === 'spawn') return request.options
  return request.command === 'rotate' && request.rest !== undefined ? request.rest.options : null
}

/** Whether the record's text holds an open row of that id. */
function holdsOpen(text: string, id: number): boolean {
  return text.split('\n').some(line => {
    try {
      const row: unknown = JSON.parse(line)
      const { id: found, state } = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>
      return found === id && state === 'open'
    } catch {
      return false
    }
  })
}

/**
 * Writes the agent a request launched on its row of the dispatch record. Nothing for a launch with no
 * brief, a title that is no agent's, or a brief that names no row (a review, a comments pass).
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
  const row = rowOfBrief(text)
  if (row === undefined) return
  const session = setting(deps.env, 'CLAUDE_CODE_SESSION_ID') ?? ''
  const registry = session === '' ? '' : deps.read(recordsRegistryPath(stateRoot(deps.env), session)) ?? ''
  const beside = deps.list(dirname(brief)).filter(name => name.endsWith('.jsonl') && !name.endsWith('.archive.jsonl')).map(name => join(dirname(brief), name))
  const known = registry.split('\n').map(path => path.trim()).filter(path => path !== '')
  const holding = [...new Set([...known, ...beside])].filter(path => holdsOpen(deps.read(path) ?? '', Number(row)))
  const nearest = holding.filter(path => dirname(path) === dirname(brief))
  const record = nearest.length === 1 ? nearest[0] : holding.length === 1 ? holding[0] : undefined
  if (record === undefined) {
    deps.warn(`spawn: warning: ${title} is on no row: ${holding.length === 0 ? `no dispatch record this session registered or beside its brief holds row ${row} open` : `row ${row} is open in ${holding.join(', ')}`}; put it there with dispatch-record.sh agent <record> ${row} "${title}"`)
    return
  }
  const said = await deps.run(['bash', deps.script, 'agent', record, row, title], { stderr: 'pipe' })
  if (said.status !== 0) deps.warn(`spawn: warning: ${title} was not put on row ${row} of ${record}: ${(said.stderr || said.stdout).trim()}`)
}
