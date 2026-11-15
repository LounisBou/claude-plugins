// Every write of shared state: whole files replaced in one rename, and read-modify-write under a
// lock, so two sessions never lose each other's update and no reader sees half a file.
import { randomBytes } from 'node:crypto'
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { lockOf, STALE_MS, temporaryOf } from './store-io.ts'

export interface LockOptions {
  /** How long to wait for a lock before giving up, in milliseconds. */
  readonly waitMs?: number
  /** A lock older than this is a holder that died; it is taken over. */
  readonly staleMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => void
}

const WAIT_MS = 5_000
const POLL_MS = 20

/** Replaces `path` with `text` in one rename, through a temporary file of a unique name beside it. */
export function writeAtomic(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = temporaryOf(path, `${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    writeFileSync(temporary, text, { mode, flag: 'wx' })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** The text of `path`, or undefined when it does not exist. */
export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** Runs `work` holding the lock of `path` (`<path>.lock`), released whatever `work` does. */
export function withLock<T>(path: string, work: () => T, options: LockOptions = {}): T {
  const lock = lockOf(path)
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? sleepSync
  const deadline = now() + (options.waitMs ?? WAIT_MS)
  mkdirSync(dirname(path), { recursive: true })
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600)
      writeSync(fd, `${process.pid}\n`)
      closeSync(fd)
      break
    } catch (error) {
      if (!isTaken(error)) throw error
      if (isStale(lock, now(), options.staleMs ?? STALE_MS)) {
        rmSync(lock, { force: true })
        continue
      }
      if (now() >= deadline) throw new Error(`${path} stayed locked for ${options.waitMs ?? WAIT_MS} ms`)
      sleep(POLL_MS)
    }
  }
  try {
    return work()
  } finally {
    rmSync(lock, { force: true })
  }
}

/** Reads `path`, applies `change` to its text (undefined when absent) and writes the result, under the lock. */
export function update(path: string, change: (current: string | undefined) => string, options?: LockOptions): string {
  return withLock(path, () => {
    const next = change(readText(path))
    writeAtomic(path, next)
    return next
  }, options)
}

/**
 * Creates `path` holding `content` only when nothing is there: of two first writers, one stands.
 * The content is written beside it first and linked into place, so the file is never seen empty.
 */
export function createOnly(path: string, content: string, mode = 0o644): boolean {
  const temporary = temporaryOf(path, `${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    const fd = openSync(temporary, 'wx', mode)
    try {
      writeSync(fd, content)
    } finally {
      closeSync(fd)
    }
    linkSync(temporary, path)
    return true
  } catch {
    return false
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** An owner file's owner after a claim, and whether this claim made it. */
export interface Claim {
  readonly owner: string
  readonly claimed: boolean
}

/**
 * Claims the owner file `path` for `me` when it names no owner yet: created only when absent, so of
 * two first claims one stands and the other reads the winner back; written over when it exists
 * empty. `form` reads the file's first line as an owner's name. Answers the owner the file names
 * afterwards. A claim that cannot be written leaves the file as it was.
 */
export function claimOwner(path: string, me: string, form: (line: string) => string = line => line.trim()): Claim {
  const before = form(firstLineOf(path))
  if (before !== '' || me === '') return { owner: before, claimed: false }
  let claimed = createOnly(path, `${me}\n`)
  if (!claimed && !nonEmpty(path)) {
    try {
      writeAtomic(path, `${me}\n`, 0o644)
      claimed = true
    } catch {
      // Unclaimed: the owner read back decides.
    }
  }
  return { owner: form(firstLineOf(path)), claimed }
}

/** Gives a claim back: removes the owner file `path` while it still names `me`. */
export function releaseOwner(path: string, me: string, form: (line: string) => string = line => line.trim()): void {
  if (form(firstLineOf(path)) === me) rmSync(path, { force: true })
}

/** The first line of `path`, '' when it is absent or cannot be read. */
export function firstLineOf(path: string): string {
  try {
    return (readText(path) ?? '').split('\n')[0] ?? ''
  } catch {
    return ''
  }
}

function nonEmpty(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}

function isStale(lock: string, now: number, staleMs: number): boolean {
  try {
    return now - statSync(lock).mtimeMs > staleMs
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

const isMissing = (error: unknown): boolean => codeOf(error) === 'ENOENT'
const isTaken = (error: unknown): boolean => codeOf(error) === 'EEXIST'
