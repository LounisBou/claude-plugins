// The round's closing commands: round-close closes one entry of <state>/round/ with the answer
// relayed or the evidence it was settled on, and forgets its fingerprint in the sender's wait
// file; round-archive moves the closed entries into round/archive/. The entries and the wait
// files are the hooks module's (hooks/round.ts, hooks/relay.ts): each is rewritten as the module
// writes it, a temporary file beside it and one rename.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { withLock, writeAtomic } from '../../../core/store.ts'
import { die, moduleOf, stateOf, utc, type Context } from './context.ts'

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

/** A value as a template of the module's prints it: text as it is, anything else as JSON. */
function shown(value: unknown): string {
  if (typeof value === 'string') return value
  return value === undefined ? 'null' : JSON.stringify(value)
}

const isSet = (value: unknown): boolean => value !== undefined && value !== null && value !== false

/**
 * The fingerprint of the wait an entry was written for, as the hooks module computes it
 * (round.ts entryFingerprint over relay.ts fingerprint): the length of
 * "<kind>\n<blocks>\n<question when no blocks>[\nurgent]" in UTF-16 units, a dash, and its
 * 32-bit FNV-1a hash over those units in hexadecimal.
 */
export function entryFingerprint(entry: Fields): string {
  const operator = entry['kind'] === 'operator'
  const blocks = operator && isSet(entry['blocks']) ? shown(entry['blocks']) : ''
  const urgent = operator && isSet(entry['urgent']) ? '\nurgent' : ''
  const text = `${shown(entry['kind'])}\n${blocks}\n${blocks === '' ? shown(entry['question']) : ''}${urgent}`
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  return `${text.length}-${hash.toString(16)}`
}

/** A store key as the module makes one: every character outside A-Za-z0-9._- becomes an underscore. */
export function storeKey(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * The closed entry's fingerprint forgotten in its sender's wait file (the module's
 * forgetRelayed), so the same question asked again is entered again: rewritten only while its
 * `relayed` is still that fingerprint. Whatever fails is said and changes nothing: the close is done.
 */
export function forgetRelayed(ctx: Context, entry: Fields): void {
  const session = isSet(entry['session']) ? shown(entry['session']) : ''
  if (session === '') return
  const wait = join(moduleOf(ctx.env), 'store', 'waits', storeKey(session))
  if (!isFile(wait)) return
  const text = read(wait)
  const fields = text === undefined ? undefined : object(text)
  if (fields === undefined) {
    // A wait file of another shape is no wait of this entry's; only one unreadable is said.
    if (text === undefined || !isJson(text)) ctx.err(`coordinator: round-close: cannot read ${wait}, its fingerprint is not forgotten`)
    return
  }
  if (fields['relayed'] !== entryFingerprint(entry)) return
  const { typed: _typed, ...rest } = fields
  try {
    writeAtomic(wait, `${JSON.stringify({ ...rest, relayed: null })}\n`)
  } catch {
    ctx.err(`coordinator: round-close: cannot write ${wait}, its fingerprint is not forgotten`)
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

const CLOSE_USAGE = 'round-close: usage: round-close <id> --answer "<text>" | --withdraw "<evidence>"'

export function roundClose(ctx: Context, args: readonly string[]): number {
  const [id = '', ...options] = args
  if (id === '') die(CLOSE_USAGE)
  let answer: string | undefined
  let evidence: string | undefined
  for (let i = 0; i < options.length; i += 2) {
    const option = options[i]
    const value = options[i + 1]
    if (option === '--answer') {
      if (value === undefined) die('round-close: --answer needs a value')
      answer = value
    } else if (option === '--withdraw') {
      if (value === undefined || value === '') die('round-close: --withdraw needs the evidence read on the artifact')
      evidence = value
    } else {
      die(`round-close: unknown option ${option}`)
    }
  }
  if ((answer === undefined) === (evidence === undefined)) die(CLOSE_USAGE)
  const round = join(stateOf(ctx.env), 'round')
  // An id names a file of the round, never a path: the module's ids are sanitised the same way.
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') die(`round-close: no entry ${id} in ${round}`)
  const path = join(round, `${id}.json`)
  // Under the entry's lock (`<path>.lock`), the module's too: a pane answer or a withdrawal
  // written meanwhile is read here, never written over.
  const closed = withLock(path, (): Fields => {
    const text = read(path)
    const entry = text === undefined ? undefined : object(text)
    if (entry === undefined || entry['id'] !== id) die(`round-close: no entry ${id} in ${round}`)
    const at = utc(ctx.now())
    const open = entry['status'] === 'open'
    // A withdrawal is closed as an answer is, its evidence kept beside the text: the module tells
    // the sender its question was withdrawn, never that the operator answered it.
    const closed: Fields = {
      ...entry,
      status: 'closed',
      answer: evidence === undefined
        ? { text: answer, by: 'coordinator', at }
        : { text: `withdrawn: settled meanwhile — ${evidence}`, by: 'coordinator', at, evidence },
    }
    // An open question's sender waits on the answer: its delivery is left pending for the module.
    if (open && entry['kind'] === 'operator') closed['delivery'] = { state: 'pending', at, attempts: 0, ...(isSet(entry['origin']) ? {} : { answerAt: at }) }
    try {
      writeAtomic(path, `${JSON.stringify(closed)}\n`)
    } catch {
      die(`round-close: cannot write ${path}`)
    }
    return closed
  })
  forgetRelayed(ctx, closed)
  ctx.out(`closed ${id}`)
  return 0
}

const DAY_MS = 24 * 60 * 60 * 1000

export function roundArchive(ctx: Context, args: readonly string[]): number {
  if (args.length > 0) die(`round-archive: unexpected argument ${args[0]}`)
  const round = join(stateOf(ctx.env), 'round')
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
    const text = read(path)
    if (text === undefined || parseEntry(text)?.['status'] !== 'closed') continue
    try {
      mkdirSync(join(round, 'archive'), { recursive: true })
    } catch {
      die(`round-archive: cannot create ${join(round, 'archive')}`)
    }
    try {
      renameSync(path, join(round, 'archive', name))
    } catch {
      die(`round-archive: cannot move ${path}`)
    }
    moved++
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
