// Whether a session is alive: the launcher's `verify --tty <tty> [--pid <pid>]` (or the command
// COORDINATOR_VERIFY names, called the same way) finds that process as the host CLI on its tty,
// so another host CLI on a reused tty reads as dead. Only the check's own « not running »,
// exit 1 and silent, is dead; a check that cannot run or fails is refused, since a live
// coordinator read as dead has its record taken.
import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'
import { setting } from '../../../core/paths.ts'
import { die, say, type Context } from './context.ts'

export interface Verified {
  readonly alive: boolean
  readonly stdout: string
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function launcherPath(here: string): string {
  return join(here, '..', '..', 'iterm-agents', 'scripts', 'iterm-agent.sh')
}

/** Asks the check about `tty`, and with a pid whether that very process is the host CLI there. */
export function verify(ctx: Context, tty: string, pid = ''): Verified {
  const args = ['--tty', tty, ...(pid === '' ? [] : ['--pid', pid])]
  const custom = setting(ctx.env, 'COORDINATOR_VERIFY')
  let result
  if (custom !== undefined) {
    if (!isFile(custom) || !isExecutable(custom)) die(`the liveness command ${custom} is missing or not executable`)
    result = ctx.run(custom, args)
  } else {
    const launcher = launcherPath(ctx.here)
    if (!isFile(launcher)) die(`the launcher ${launcher} is missing`)
    result = ctx.run('bash', [launcher, 'verify', ...args])
  }
  const error = result.stderr.replace(/\n+$/, '')
  if (result.status === 0) return { alive: true, stdout: result.stdout }
  if (result.status === 1 && error === '') return { alive: false, stdout: result.stdout }
  return die(`the liveness check failed on ${tty}: ${error === '' ? `exit ${result.status}` : error}`)
}

/** The session on `tty` is alive, and when a pid was recorded, that same process is. */
export function alive(ctx: Context, tty: string, pid = ''): boolean {
  return verify(ctx, tty, pid).alive
}

/**
 * The pid of the host CLI on `tty`, read from the check's « (pid N) »; empty when nothing runs
 * there or the check names no pid, the latter said in one line since the record is then read
 * by its tty alone.
 */
export function ttyPid(ctx: Context, tty: string): string {
  const verified = verify(ctx, tty)
  if (!verified.alive) return ''
  const pid = /\(pid ([0-9]+)\)/.exec(verified.stdout)?.[1]
  if (pid === undefined) {
    say(ctx, `no process id found on ${tty}: the record is written without one`)
    return ''
  }
  return pid
}
