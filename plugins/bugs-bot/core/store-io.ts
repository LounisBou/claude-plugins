// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The store's convention (store.ts) for a caller that has no node:fs: a hooks module reaches the
// file system only through the host's `$`, which writes a file but cannot rename, remove or
// create one exclusively. The same three rules hold over the I/O the caller hands in: whole
// files replaced in one rename through a temporary file of a unique name beside them, a
// read-modify-write under the lock `<path>.lock` holding the holder's pid, and a lock or a
// temporary file older than STALE_MS left by a holder that died, so it is taken over or removed.
// No module of node is imported here, so a hooks module imports this one.

/** A lock or a temporary file older than this was left by a process that died. */
export const STALE_MS = 30_000

/**
 * The convention as data, for a writer in another language (`store.json` in each plugin's copy):
 * the same lock and temporary names, the same age past which a holder is dead.
 */
export const STORE_CONTRACT = { version: 1, lock_suffix: '.lock', temporary_mark: '.tmp-', stale_ms: STALE_MS } as const

/** The lock of `path`, the same for every writer of it, whatever its language. */
export function lockOf(path: string): string {
  return `${path}${STORE_CONTRACT.lock_suffix}`
}

/** The temporary file a write of `path` goes through: beside it, named by a unique `tag`. */
export function temporaryOf(path: string, tag: string): string {
  return `${path}${STORE_CONTRACT.temporary_mark}${tag}`
}

/** Whether a directory entry is a write in flight (or left by a dead writer), never a record. */
export function isTemporary(name: string): boolean {
  return name.includes(STORE_CONTRACT.temporary_mark)
}

/** The entries of `dir` a dead writer left: temporary files older than `staleMs`, as paths. */
export function staleTemporaries(
  dir: string,
  entries: readonly { readonly name: string; readonly kind: string; readonly mtimeMs?: number }[],
  now: number,
  staleMs: number = STALE_MS,
): string[] {
  return entries
    .filter(entry => entry.kind === 'file' && isTemporary(entry.name) && now - (entry.mtimeMs ?? 0) > staleMs)
    .map(entry => `${dir}/${entry.name}`)
}

/** What the caller's process runner answers. */
export interface RunResult {
  readonly exitCode: number
  readonly stderr?: string
}

/** The I/O the store runs over, each function a closure of the caller's own. */
export interface StoreIo {
  /** Writes `text` to `path`, creating its directories. Need not be atomic. */
  readonly write: (path: string, text: string) => Promise<void>
  /** The text of `path`, undefined when it does not exist. */
  readonly read: (path: string) => Promise<string | undefined>
  /** Runs a command (no shell is built from text: every argument is its own). */
  readonly run: (argv: readonly string[]) => Promise<RunResult>
  /** The modification time of `path`, undefined when it does not exist. */
  readonly mtimeMs: (path: string) => Promise<number | undefined>
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  /** A part of a temporary name no other write uses at the same time. */
  readonly tag: () => string
}

/** The commands the store runs, so a caller's fake answers them by shape. */
export function renameArgv(from: string, to: string): string[] {
  return ['mv', '-f', from, to]
}

export function removeArgv(...paths: string[]): string[] {
  return ['rm', '-f', ...paths]
}

// The lock taken by an exclusive create (the shell's noclobber), its directory made first, in one process.
export function takeLockArgv(lock: string): string[] {
  return ['sh', '-c', 'mkdir -p -- "${1%/*}" && set -C && echo "$$" > "$1"', 'sh', lock]
}

export interface AsyncLockOptions {
  /** How many times a held lock is polled before giving up. */
  readonly tries?: number
  readonly pollMs?: number
  readonly staleMs?: number
}

const TRIES = 100
const POLL_MS = 20

/** Replaces `path` with `text` in one rename; a write that fails leaves no temporary file. */
export async function writeAtomicOver(io: StoreIo, path: string, text: string): Promise<void> {
  const temporary = temporaryOf(path, io.tag())
  try {
    await io.write(temporary, text)
    const moved = await io.run(renameArgv(temporary, path))
    if (moved.exitCode !== 0) throw new Error(`the file ${path} could not be renamed into place${moved.stderr ? `: ${moved.stderr.trim()}` : ''}`)
  } catch (error) {
    await io.run(removeArgv(temporary)).catch(() => undefined)
    throw error
  }
}

/** Runs `work` holding the lock of `path`, released whatever `work` does. */
export async function withLockOver<T>(io: StoreIo, path: string, work: () => Promise<T>, options: AsyncLockOptions = {}): Promise<T> {
  const lock = lockOf(path)
  const tries = options.tries ?? TRIES
  for (let tried = 0; ; tried++) {
    const taken = await io.run(takeLockArgv(lock))
    if (taken.exitCode === 0) break
    const since = await io.mtimeMs(lock)
    if (since !== undefined && io.now() - since > (options.staleMs ?? STALE_MS)) {
      await io.run(removeArgv(lock))
      continue
    }
    if (tried >= tries) throw new Error(`${path} stayed locked by another process`)
    await io.sleep(options.pollMs ?? POLL_MS)
  }
  try {
    return await work()
  } finally {
    await io.run(removeArgv(lock)).catch(() => undefined)
  }
}

/**
 * Reads `path`, applies `change` to its text (undefined when absent) and writes the result,
 * under the lock. A change that answers undefined writes nothing. Answers what was written.
 */
export async function updateOver(
  io: StoreIo,
  path: string,
  change: (current: string | undefined) => string | undefined,
  options?: AsyncLockOptions,
): Promise<string | undefined> {
  return withLockOver(io, path, async () => {
    const next = change(await io.read(path))
    if (next !== undefined) await writeAtomicOver(io, path, next)
    return next
  }, options)
}
