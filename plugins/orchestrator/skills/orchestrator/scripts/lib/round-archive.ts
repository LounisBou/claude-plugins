// The round's archive: the entries of <state>/round/ settled over a day ago, moved into round/archive/,
// the withdrawn ones into round/archive/withdrawn/. Run by `round-archive` and by `succession.sh live`.
// The entries are the hooks module's (hooks/round.ts, hooks/question.ts), each moved under the lock
// the module writes it under.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { withLock } from '../../../../core/store.ts'

/** A directory or a move of the archive that failed: its message names which. */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveError'
  }
}

type Fields = Record<string, unknown>

/** One JSON object of `text`, or undefined when it holds anything else. */
function object(text: string): Fields | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : undefined
}

/** An entry of the round: an object whose id, from, since, status, kind and question are text. */
export function parseEntry(text: string): Fields | undefined {
  const entry = object(text)
  if (entry === undefined) return undefined
  const textual = ['id', 'from', 'since', 'status', 'kind', 'question'].every(key => typeof entry[key] === 'string')
  return textual ? entry : undefined
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const isSet = (value: unknown): boolean => value !== undefined && value !== null && value !== false

export const DAY_MS = 24 * 60 * 60 * 1000

const SETTLED: readonly unknown[] = ['closed', 'answered', 'withdrawn']

/**
 * When a settled entry was settled, as epoch milliseconds, or null for an entry still to keep: one
 * open, of a shape neither the relay's nor `ask`'s (hooks/question.ts, `v` 2), or whose answer is
 * still to reach its asker (a delivery pending, sent or failed: the pane shows a failure).
 */
export function settledAt(text: string): number | null {
  const entry = object(text)
  if (entry === undefined || !SETTLED.includes(entry['status'])) return null
  const asked = entry['v'] === 2 && typeof entry['id'] === 'string'
  if (!asked && parseEntry(text) === undefined) return null
  const delivery = entry['delivery'] as Fields | undefined | null
  if (isSet(delivery) && (delivery as Fields)['state'] !== 'delivered') return null
  const answered = entry['answer'] as Fields | undefined | null
  const at = isSet(answered) && typeof (answered as Fields)['at'] === 'string' ? (answered as Fields)['at'] : asked ? entry['at'] : entry['since']
  const ms = typeof at === 'string' ? Date.parse(at) : NaN
  return Number.isFinite(ms) ? ms : null
}

/**
 * Moves into round/archive/ each entry settled over a day ago (settledAt), the withdrawn ones into
 * round/archive/withdrawn/: the module reads the newest of archive/ itself for the answers it
 * recorded, and a withdrawal answers nothing. Each under its lock, read again before the move.
 * Answers how many moved; a directory or a move that fails is thrown as an ArchiveError.
 */
export function archiveSettled(round: string, now: Date): number {
  let names: string[]
  try {
    names = readdirSync(round).sort()
  } catch {
    names = []
  }
  let moved = 0
  for (const name of names) {
    const path = join(round, name)
    if (!name.endsWith('.json') || !isFile(path)) continue
    // Under the entry's lock: an entry reopened or answered meanwhile is read here, and stays.
    let archived = false
    try {
      archived = withLock(path, () => {
        const text = read(path)
        const at = text === undefined ? null : settledAt(text)
        if (at === null || now.getTime() - at <= DAY_MS) return false
        const into = object(text as string)?.['status'] === 'withdrawn' ? join(round, 'archive', 'withdrawn') : join(round, 'archive')
        try {
          mkdirSync(into, { recursive: true })
        } catch {
          throw new ArchiveError(`round-archive: cannot create ${into}`)
        }
        try {
          renameSync(path, join(into, name))
        } catch {
          throw new ArchiveError(`round-archive: cannot move ${path}`)
        }
        return true
      })
    } catch (error) {
      if (error instanceof ArchiveError) throw error
      throw new ArchiveError(`round-archive: cannot move ${path}`)
    }
    if (archived) moved++
  }
  return moved
}
