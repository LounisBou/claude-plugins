// What the coordinator's commands read from their process, passed in so a test stands in for
// it: the environment, the clock, the script's own directory, the commands it runs and the
// streams it writes. A refusal is thrown as a Refusal and said once, by the entry point.
import { join } from 'node:path'
import { setting, stateDir, type Env } from '../../../core/paths.ts'

export interface RunResult {
  /** The exit status; 128 + the signal's number when a signal ended the command. */
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

export interface Context {
  readonly env: Env
  /** The directory holding coordinator.sh, from which the plugin's other scripts are found. */
  readonly here: string
  readonly pid: number
  readonly now: () => Date
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  /** Runs a command with no input and returns what it printed and how it ended. */
  readonly run: (command: string, args: readonly string[]) => RunResult
  readonly sleep: (ms: number) => void
  /** Whether a process of that id exists. */
  readonly isRunning: (pid: number) => boolean
}

/** A refusal or a failure: the entry point prints `coordinator: <message>` and exits 1. */
export class Refusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Refusal'
  }
}

export function die(message: string): never {
  throw new Refusal(message)
}

/** Says something on the error stream, the way every line of the coordinator is said. */
export function say(ctx: Context, message: string): void {
  ctx.err(`coordinator: ${message}`)
}

const PLUGIN = 'claude-orchestrator'

/** The orchestrator's state directory: ORCHESTRATOR_STATE_DIR, else the plugin's under the configuration directory. */
export function stateOf(env: Env): string {
  return setting(env, 'ORCHESTRATOR_STATE_DIR') ?? stateDir(PLUGIN, env)
}

/** The hooks module's own directory (its store): ORCHESTRATOR_MODULE_DIR, as the module reads it. */
export function moduleOf(env: Env): string {
  return setting(env, 'ORCHESTRATOR_MODULE_DIR') ?? stateDir(PLUGIN, env)
}

/** A UTC time to the second, as every record of the coordinator stamps it. */
export function utc(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`
}

/** The record of the coordinator itself. */
export function recordPath(env: Env): string {
  return join(stateOf(env), 'coordinator.json')
}
