// hooks/row-owner.ts
// Who owns an open row of a dispatch record, as the takeover prints « Row owners » and the module's
// merge wake reads it: the live agent whose launch brief was printed for the row (the id the dispatch
// recorded, in the record of the brief's directory), else, for an agent whose brief names no row, the rows
// that name it in their `agent` field (`dispatch-record.sh agent`). Pure: the reading of the files is the caller's.
import { isLedgerMarked } from '../core/pr-ledger.ts'

/** An agent's name without its role prefix. */
export const bareName = (name: string): string => name.replace(/^Agent:\s*/, '').trim()

/** Whether the name a row carries in its `agent` field is that agent's: the same name, its reference and its case apart. */
export function isAgent(named: unknown, agent: string): boolean {
  const name = bareName(agent).replace(/ \[[^\]]*\]$/, '').toLowerCase()
  return typeof named === 'string' && name !== '' && bareName(named).replace(/ \[[^\]]*\]$/, '').toLowerCase() === name
}

/**
 * The row a brief was printed for, the id the dispatch recorded: a phase brief's « You are the
 * implementer of row <id> » or its `Row: <id>` line, a rotation brief's « resume brief for row <id>: ».
 * Undefined for any other text: a row mentioned in passing binds nothing.
 */
export function rowOfBrief(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const found = /^You are the implementer of row ([1-9][0-9]*) of the dispatch record\b/m.exec(text)
    ?? /^# .*\bresume brief for row ([1-9][0-9]*):/m.exec(text)
    ?? /^Row: ([1-9][0-9]*)\b/m.exec(text)
  return found?.[1]
}

/** The newest launch script the launcher wrote for an agent's title (`launch-<title>-<ms>.sh`) among `files`. */
export function newestLaunch(files: readonly string[], name: string): string | undefined {
  const safe = `launch-${name.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40)}-`
  let newest: { ms: number; file: string } | undefined
  for (const file of files) {
    const ms = file.startsWith(safe) && file.endsWith('.sh') ? Number(file.slice(safe.length, -3)) : NaN
    if (Number.isInteger(ms) && (newest === undefined || ms > newest.ms)) newest = { ms, file }
  }
  return newest?.file
}

/** The brief a launch script names: its `export ORCHESTRATOR_BRIEF=…`; undefined when it names none. */
export function briefOfLaunch(script: string): string | undefined {
  const found = /export ORCHESTRATOR_BRIEF=(?:'([^']*)'|([^\s;&]+))/.exec(script)
  return found === null ? undefined : (found[1] ?? found[2])
}

/** A record of the orchestration: its path and its text. */
export type RecordText = { readonly path: string; readonly text: string }

/** An open row of a record, the pair that names it: ids are per record. */
export type HeldRow = { readonly path: string; readonly id: number }

/** The directory of a path. */
export const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))

/**
 * The open rows, not deferred, that an agent owns, in any record. `bound` is the row its brief names
 * (`row`) and the directory of that brief: the row of that id in the record beside the brief, or in
 * every record when none sits there. An agent with no such brief owns the rows whose `agent` field names it.
 */
export function rowsOwnedBy(agent: string, bound: { row: number; dir: string } | undefined, records: readonly RecordText[]): HeldRow[] {
  const beside = bound === undefined ? [] : records.filter(record => dirOf(record.path) === bound.dir)
  const read = bound === undefined ? records : beside.length > 0 ? beside : records
  const found: HeldRow[] = []
  for (const { path, text } of read) {
    for (const line of text.split('\n')) {
      let row: unknown
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
      if (isLedgerMarked(row)) continue
      const { id, state, agent: named, deferred } = row as Record<string, unknown>
      if (typeof id !== 'number' || state !== 'open' || (typeof deferred === 'string' && deferred.trim() !== '')) continue
      if (bound === undefined ? isAgent(named, agent) : id === bound.row) found.push({ path, id })
    }
  }
  return found
}
