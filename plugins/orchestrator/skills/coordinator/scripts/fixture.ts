// A context for the tests: a state directory of its own, a pinned clock, captured streams and a
// stand-in for every command the coordinator runs.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context, RunResult } from './context.ts'

export interface Fixture {
  readonly ctx: Context
  readonly root: string
  readonly state: string
  readonly out: string[]
  readonly err: string[]
  readonly runs: string[][]
  readonly slept: number[]
}

export interface FixtureOptions {
  readonly env?: Readonly<Record<string, string>>
  readonly run?: (command: string, args: readonly string[]) => RunResult
  readonly running?: (pid: number) => boolean
  readonly here?: string
}

export const NOW = new Date('2026-10-18T10:06:07.123Z')

export function fixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'coordinator-'))
  const state = join(root, 'state')
  const out: string[] = []
  const err: string[] = []
  const runs: string[][] = []
  const slept: number[] = []
  const ctx: Context = {
    env: { ORCHESTRATOR_STATE_DIR: state, ...options.env },
    here: options.here ?? join(root, 'skills', 'coordinator', 'scripts'),
    pid: 4242,
    now: () => NOW,
    out: line => { out.push(line) },
    err: line => { err.push(line) },
    run: (command, args) => {
      runs.push([command, ...args])
      return options.run?.(command, args) ?? { status: 1, stdout: '', stderr: '' }
    },
    sleep: ms => { slept.push(ms) },
    isRunning: options.running ?? (() => false),
  }
  return { ctx, root, state, out, err, runs, slept }
}

/** A liveness check that finds a host CLI on each tty of `live`, with that pid. */
export function liveOn(live: Readonly<Record<string, number | null>>): (command: string, args: readonly string[]) => RunResult {
  return (_command, args) => {
    const at = args.indexOf('--tty')
    const tty = args[at + 1] ?? ''
    const pidAt = args.indexOf('--pid')
    const asked = pidAt < 0 ? undefined : args[pidAt + 1]
    const pid = live[tty]
    if (pid === undefined) return { status: 1, stdout: '', stderr: '' }
    if (asked !== undefined && String(pid) !== asked) return { status: 1, stdout: '', stderr: '' }
    return { status: 0, stdout: pid === null ? `running on ${tty}\n` : `running on ${tty} (pid ${pid})\n`, stderr: '' }
  }
}
