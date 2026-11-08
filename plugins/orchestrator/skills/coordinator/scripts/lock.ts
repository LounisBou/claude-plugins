// The coordinator's lock: the directory <state>/coordinator.lock, taken by one mkdir, the one
// test-and-set every caller shares, the hooks module and the suite included. Its holder writes
// `<pid> <operation>` into it, so a refusal names who holds it and whether it still runs. A
// caller waits five seconds at most, then refuses; a lock is never broken here, since a holder
// read as dead may be one whose process table read failed. Only the holder removes it.
import { accessSync, constants, mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { die, stateOf, type Context } from './context.ts'

const TRIES = 50
const POLL_MS = 100

export function lockPath(state: string): string {
  return join(state, 'coordinator.lock')
}

/** Who holds the lock, as far as its holder file says, and nothing guessed. */
export function lockHolder(ctx: Context, lock: string): string {
  let line = ''
  try {
    line = readFileSync(join(lock, 'holder'), 'utf8').split('\n', 1)[0] ?? ''
  } catch {
    // No holder file: the lock names no holder.
  }
  const [pid = '', ...rest] = line.trim().split(/[ \t]+/)
  const operation = rest.join(' ')
  if (!/^[0-9]+$/.test(pid)) return `the coordinator's lock is held: ${lock} names no holder`
  const state = ctx.isRunning(Number(pid)) ? 'running' : 'dead'
  const who = operation === '' ? "the coordinator's lock is held" : `a ${operation} holds the lock`
  return `${who}: ${lock} held by pid ${pid} (${state})`
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Runs `work` holding the coordinator's lock for `operation`; refuses after five seconds. */
export function withCoordinatorLock<T>(ctx: Context, operation: string, work: () => T): T {
  const state = stateOf(ctx.env)
  try {
    mkdirSync(state, { recursive: true })
  } catch {
    die(`cannot create the state directory ${state}`)
  }
  try {
    accessSync(state, constants.W_OK)
  } catch {
    die(`cannot write into the state directory ${state}`)
  }
  const lock = lockPath(state)
  for (let tries = 0; ; ) {
    try {
      mkdirSync(lock)
      break
    } catch {
      if (!isDirectory(lock)) die(`cannot create the lock ${lock}`)
      tries++
      if (tries >= TRIES) die(`refused: ${lockHolder(ctx, lock)}: remove ${lock}`)
      ctx.sleep(POLL_MS)
    }
  }
  const release = (): void => {
    rmSync(join(lock, 'holder'), { force: true })
    try {
      rmdirSync(lock)
    } catch {
      // A lock that cannot be removed is left for the operator, whose refusal names it.
    }
  }
  held.add(release)
  try {
    writeFileSync(join(lock, 'holder'), `${ctx.pid} ${operation}\n`)
    return work()
  } finally {
    held.delete(release)
    release()
  }
}

const held = new Set<() => void>()

/** Releases every lock this process holds: the entry point calls it when a signal ends it. */
export function releaseHeld(): void {
  for (const release of held) release()
  held.clear()
}
