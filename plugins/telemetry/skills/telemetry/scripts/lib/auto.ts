// The automatic export, run from a session's end: at most once a UTC day, retried after a failure
// no sooner than RETRY_MS, never two at once on a machine, said once when the repository is unset.
// A session's end starts it detached so it is not held; the detached run is the one that pushes.
import { join } from 'node:path'
import { readText, update, writeAtomic } from '../../../../core/store.ts'
import { exportExclusive, REPO_VARIABLE, type ExportOptions, type ExportResult } from './export.ts'

/** After a failed export the next automatic one waits this long. */
export const RETRY_MS = 3_600_000

export interface AutoState {
  /** The UTC day of the last export that finished, null before any. */
  readonly exported_day: string | null
  /** When the last export was tried, in ms since the epoch. */
  readonly attempted_at: number | null
  /** Whether the unset repository was said already. */
  readonly unset_noticed: boolean
}

export interface AutoOptions extends ExportOptions {
  readonly now: () => number
  /** Run the export here; otherwise hand it to `detach` and return. */
  readonly foreground: boolean
  readonly detach: () => void
}

const NONE: AutoState = { exported_day: null, attempted_at: null, unset_noticed: false }
const statePath = (stateDir: string): string => join(stateDir, 'auto.json')
const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10)

/** The state in `raw`, or none when it is absent or no state. */
function parseState(raw: string | undefined): AutoState {
  if (raw === undefined) return NONE
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    const day = value['exported_day']
    const at = value['attempted_at']
    return {
      exported_day: typeof day === 'string' ? day : null,
      attempted_at: typeof at === 'number' && Number.isFinite(at) ? at : null,
      unset_noticed: value['unset_noticed'] === true,
    }
  } catch {
    return NONE
  }
}

export const readAuto = (stateDir: string): AutoState => parseState(readText(statePath(stateDir)))

/** Edits the state file under its lock. */
function change(stateDir: string, edit: (state: AutoState) => AutoState): void {
  update(statePath(stateDir), current => `${JSON.stringify(edit(parseState(current)))}\n`)
}

/** Whether an automatic export is due at `now`: the day is not the one exported, and the last try is old enough. */
export function isDue(state: AutoState, now: number): boolean {
  return state.exported_day !== dayOf(now) && (state.attempted_at === null || now - state.attempted_at >= RETRY_MS)
}

/** The foreground work: holds the export lock without waiting, re-reads the state under it, exports, records. */
export function exportDue(options: AutoOptions): ExportResult {
  const { stateDir, now } = options
  const result = exportExclusive(options, {
    waitMs: 0,
    when: () => {
      if (!isDue(readAuto(stateDir), now())) return false
      change(stateDir, state => ({ ...state, attempted_at: now() }))
      return true
    },
  })
  // Another export running, or the day already done by it: nothing to say.
  if (result.busy || result.skipped === true) return { lines: [], code: 0 }
  change(stateDir, state => (result.code === 0 ? { ...state, exported_day: dayOf(now()) } : state))
  writeAtomic(join(stateDir, 'export.log'), `${result.lines.join('\n')}\n`)
  return { lines: result.lines, code: result.code }
}

/** One automatic export attempt: silent unless it has something to say, and it says unset once. */
export function runAuto(options: AutoOptions): ExportResult {
  const { stateDir, repo, now } = options
  const state = readAuto(stateDir)
  if (repo === undefined) {
    if (state.unset_noticed) return { lines: [], code: 0 }
    change(stateDir, s => ({ ...s, unset_noticed: true }))
    return { lines: [`telemetry: ${REPO_VARIABLE} is not set; the events stay local and nothing is pushed (said once)`], code: 0 }
  }
  if (state.unset_noticed) change(stateDir, s => ({ ...s, unset_noticed: false }))
  if (!isDue(state, now())) return { lines: [], code: 0 }
  if (!options.foreground) {
    options.detach()
    return { lines: [], code: 0 }
  }
  return exportDue(options)
}
