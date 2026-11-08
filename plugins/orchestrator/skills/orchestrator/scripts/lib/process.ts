// What a script of the orchestrator's skill reaches outside itself: the commands it runs and the
// streams it writes. Passed in as values, so a test stands in for each one.
import { spawn } from 'node:child_process'
import { writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export interface Ran {
  /** The exit status, or null when the command was killed or could not start. */
  readonly status: number | null
  readonly stdout: string
}

export interface RunOptions {
  /** Aborting it kills the command. */
  readonly signal?: AbortSignal
  /** Where the command's stderr goes: this process's own, or nowhere (the default). */
  readonly stderr?: 'inherit' | 'ignore'
  readonly cwd?: string
}

export type Run = (argv: readonly [string, ...string[]], options?: RunOptions) => Promise<Ran>

/** Runs `argv` without a shell and collects its stdout; never rejects. */
export const run: Run = (argv, options = {}) =>
  new Promise(resolve => {
    const [command, ...args] = argv
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', options.stderr ?? 'ignore'],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    let settled = false
    const settle = (status: number | null): void => {
      if (settled) return
      settled = true
      resolve({ status, stdout: Buffer.concat(chunks).toString('utf8') })
    }
    child.on('error', () => settle(null))
    child.on('close', code => settle(code))
  })

export interface Io {
  /** Writes text to stdout as given; a reader that went away is not an error. */
  readonly out: (text: string) => void
  readonly err: (text: string) => void
}

/** A write that is done when it returns, so an exit never cuts it, and that a closed pipe ends quietly. */
export function fdWriter(fd: number, write: (fd: number, bytes: Uint8Array) => number = writeSync): (text: string) => void {
  let closed = false
  return text => {
    let bytes: Uint8Array = Buffer.from(text, 'utf8')
    while (!closed && bytes.length > 0) {
      try {
        bytes = bytes.subarray(write(fd, bytes))
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        if (code === 'EAGAIN') continue
        if (code !== 'EPIPE') throw error
        closed = true
      }
    }
  }
}

export const processIo: Io = { out: fdWriter(1), err: fdWriter(2) }

/** Whether the module at `moduleUrl` is the script node was started with. */
export function isEntry(moduleUrl: string, script: string | undefined = process.argv[1]): boolean {
  return script !== undefined && moduleUrl === pathToFileURL(script).href
}
