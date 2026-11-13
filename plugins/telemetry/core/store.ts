// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// Every write of shared state: whole files replaced in one rename, and read-modify-write under a
// lock, so two sessions never lose each other's update and no reader sees half a file.
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
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
