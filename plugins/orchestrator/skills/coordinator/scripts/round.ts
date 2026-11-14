// The round's archive: round-archive moves the entries of <state>/round/ settled over a day ago into
// round/archive/ (archiveSettled, which succession.sh live runs too). The entries are the hooks
// module's (hooks/round.ts, hooks/question.ts), each moved under the lock the module writes it under.
// A question is closed by the module's `settle` tool, no longer by a command here.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { withLock } from '../../../core/store.ts'
import { die, Refusal, stateOf, type Context } from './context.ts'

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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const isSet = (value: unknown): boolean => value !== undefined && value !== null && value !== false

const DAY_MS = 24 * 60 * 60 * 1000

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
 * Answers how many moved; a directory or a move that fails is thrown as a Refusal.
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
          die(`round-archive: cannot create ${into}`)
        }
        try {
          renameSync(path, join(into, name))
        } catch {
          die(`round-archive: cannot move ${path}`)
        }
        return true
      })
    } catch (error) {
      if (error instanceof Refusal) throw error
      die(`round-archive: cannot move ${path}`)
    }
    if (archived) moved++
  }
  return moved
}

export function roundArchive(ctx: Context, args: readonly string[]): number {
  if (args.length > 0) die(`round-archive: unexpected argument ${args[0]}`)
  const round = join(stateOf(ctx.env), 'round')
  const moved = archiveSettled(round, ctx.now())
  let names: string[]
  try {
    names = readdirSync(round).sort()
  } catch {
    names = []
  }
  // A write that died between its temporary file and the rename leaves the temporary behind;
  // one a day old is no write in flight.
  const now = ctx.now().getTime()
  for (const name of names) {
    if (!/\.json\.tmp-/.test(name)) continue
    const path = join(round, name)
    try {
      const stat = statSync(path)
      if (stat.isFile() && now - stat.mtimeMs > DAY_MS) rmSync(path, { force: true })
    } catch {
      // Gone meanwhile, or unreadable: nothing to remove.
    }
  }
  ctx.out(`archived ${moved}`)
  return 0
}
