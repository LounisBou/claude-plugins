// The coordinator's own record, <state>/coordinator.json {"name","tty","started","pid"}: written
// at registration under the lock, read by lookup, removed by clear. The pid is the host CLI's on
// the tty at registration; a record with no pid, written before it was kept, is read by its tty
// alone.
import { readFileSync, rmSync, statSync } from 'node:fs'
import { writeAtomic } from '../../../core/store.ts'
import { die, recordPath, say, utc, type Context } from './context.ts'
import { alive, ttyPid } from './liveness.ts'
import { withCoordinatorLock } from './lock.ts'

export interface RecordFields {
  readonly name: string
  readonly tty: string
  readonly pid: string
}

/** A field as text, the way a reader of the record takes it: absent, null or false is empty. */
function field(value: unknown): string {
  if (value === undefined || value === null || value === false) return ''
  if (typeof value === 'string') return value
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** The fields of a record's text; a text that is no JSON object reads as an empty record. */
export function parseRecord(text: string): RecordFields {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { name: '', tty: '', pid: '' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { name: '', tty: '', pid: '' }
  const record = value as Record<string, unknown>
  return { name: field(record['name']), tty: field(record['tty']), pid: field(record['pid']) }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readRecord(path: string): RecordFields {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // Unreadable: an empty record, replaced like a stale one.
  }
  return parseRecord(text)
}

/** Writes `text` and a newline over `path` in one rename; a directory there is refused. */
export function writeWhole(path: string, text: string): void {
  if (isDirectory(path)) die(`cannot write ${path}: it is a directory`)
  try {
    writeAtomic(path, `${text}\n`)
  } catch {
    die(`cannot write ${path}`)
  }
}

/** Reads `--name <value>` and `--tty <value>` pairs: an option with no value, or another option, is refused. */
function options(sub: string, args: readonly string[], known: readonly string[]): Map<string, string> {
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i] ?? ''
    if (!known.includes(option)) die(`${sub}: unknown option ${option}`)
    const value = args[i + 1]
    if (value === undefined) die(`${sub}: ${option} needs a value`)
    values.set(option, value)
  }
  return values
}

export function register(ctx: Context, args: readonly string[]): number {
  const values = options('register', args, ['--name', '--tty'])
  const name = values.get('--name') ?? ''
  const tty = values.get('--tty') ?? ''
  if (name === '' || tty === '') die('register: usage: register --name "<name [ref]>" --tty /dev/ttysNNN')
  const path = recordPath(ctx.env)
  withCoordinatorLock(ctx, 'registration', () => {
    if (isFile(path)) {
      const old = readRecord(path)
      if (old.tty !== '' && alive(ctx, old.tty, old.pid)) die(`refused: a live coordinator is recorded: ${old.name} on ${old.tty}`)
      say(ctx, `replaced a stale record: ${old.name === '' ? 'an unreadable record' : old.name}`)
    }
    const pid = ttyPid(ctx, tty)
    const record = { name, tty, started: utc(ctx.now()), ...(pid === '' ? {} : { pid: Number(pid) }) }
    writeWhole(path, JSON.stringify(record, null, 2))
  })
  ctx.out(`registered ${name}`)
  return 0
}

export function clear(ctx: Context, args: readonly string[]): number {
  if (args.length > 0) die(`clear: unexpected argument ${args[0]}`)
  const path = recordPath(ctx.env)
  try {
    rmSync(path, { force: true })
  } catch {
    die(`clear: cannot remove ${path}`)
  }
  return 0
}

export function lookup(ctx: Context, args: readonly string[]): number {
  if (args.length > 0) die(`lookup: unexpected argument ${args[0]}`)
  const path = recordPath(ctx.env)
  if (!isFile(path)) return 0
  const { name, tty, pid } = readRecord(path)
  if (name !== '' && tty !== '' && alive(ctx, tty, pid)) ctx.out(name)
  else say(ctx, `stale record: ${name === '' ? 'an unreadable record' : name} on ${tty === '' ? 'no tty' : tty}`)
  return 0
}
