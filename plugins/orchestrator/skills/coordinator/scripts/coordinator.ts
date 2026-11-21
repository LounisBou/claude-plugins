// The coordinator's commands; coordinator.sh, their launcher, documents them.
import { spawnSync } from 'node:child_process'
import { constants } from 'node:os'
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Refusal, type Context, type RunOptions, type RunResult } from './context.ts'
import { releaseHeld } from './lock.ts'
import { clear, lookup, register } from './record.ts'
import { checkCommand, factsCommand, ownersCommand, rootsCommand } from './facts.ts'
import { round, roundArchive } from './round.ts'
import { drop, sleep, sleeping, wakeDone } from './sleeping.ts'

export const COMMANDS: Readonly<Record<string, (ctx: Context, args: readonly string[]) => number>> = {
  register,
  clear,
  lookup,
  facts: factsCommand,
  owners: ownersCommand,
  check: checkCommand,
  roots: rootsCommand,
  sleep,
  sleeping,
  'wake-done': wakeDone,
  drop,
  round,
  'round-archive': roundArchive,
}

/** Runs one subcommand; a refusal is said on the error stream and exits 1. */
export function main(ctx: Context, argv: readonly string[]): number {
  const [command = '', ...args] = argv
  try {
    if (command === '') throw new Refusal(`usage: coordinator.sh {${Object.keys(COMMANDS).join('|')}} ... (see header)`)
    const run = COMMANDS[command]
    if (run === undefined) throw new Refusal(`unknown subcommand: ${command} (expected ${Object.keys(COMMANDS).slice(0, -1).join(', ')} or ${Object.keys(COMMANDS).at(-1)})`)
    return run(ctx, args)
  } catch (error) {
    ctx.err(`coordinator: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/* node:coverage disable */
// The process itself: what cannot run under a test, kept to plumbing.
function run(command: string, args: readonly string[], options: RunOptions = {}): RunResult {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options })
  if (result.error !== undefined) return { status: 127, stdout: '', stderr: result.error.message }
  return { status: result.status ?? 128 + (result.signal === null ? 0 : constants.signals[result.signal]), stdout: result.stdout, stderr: result.stderr }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
  }
}

export function processContext(): Context {
  return {
    env: process.env,
    here: dirname(fileURLToPath(import.meta.url)),
    pid: process.pid,
    now: () => new Date(),
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
    run,
    sleep: ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    isRunning,
  }
}

function isEntry(): boolean {
  const script = process.argv[1]
  return script !== undefined && realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
}

if (isEntry()) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      releaseHeld()
      process.exit(1)
    })
  }
  process.exitCode = main(processContext(), process.argv.slice(2))
}
/* node:coverage enable */
