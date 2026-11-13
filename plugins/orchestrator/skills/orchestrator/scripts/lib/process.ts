// What a script of the orchestrator's skill reaches outside itself: the commands it runs and the
// streams it writes. Passed in as values, so a test stands in for each one.
import { spawn } from 'node:child_process'
import { closeSync, openSync, writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export interface Ran {
  /** The exit status, or null when the command was killed or could not start. */
  readonly status: number | null
  readonly stdout: string
  /** The command's stderr when it was asked for (`stderr: 'pipe'`), else ''. */
  readonly stderr: string
}

export interface RunOptions {
  /** Aborting it kills the command. */
  readonly signal?: AbortSignal
  /** Where the command's stderr goes: this process's own, nowhere (the default), or `Ran.stderr`. */
  readonly stderr?: 'inherit' | 'ignore' | 'pipe'
  /**
   * A file that takes both of the command's streams, truncated first unless `append`; nothing is
   * collected then. A file that cannot be opened runs nothing and reads as status 1, as a shell's
   * failed redirection does.
   */
  readonly log?: { readonly path: string; readonly append: boolean }
  readonly cwd?: string
  /** Variables added to this process's own environment for the command. */
  readonly env?: Readonly<Record<string, string>>
}

export type Run = (argv: readonly [string, ...string[]], options?: RunOptions) => Promise<Ran>

/** Runs `argv` without a shell and collects its stdout; never rejects. */
export const run: Run = (argv, options = {}) =>
  new Promise(resolve => {
    const [command, ...args] = argv
    let fd: number | undefined
    if (options.log !== undefined) {
      try {
        fd = openSync(options.log.path, options.log.append ? 'a' : 'w')
      } catch {
        resolve({ status: 1, stdout: '', stderr: '' })
        return
      }
    }
    const child = spawn(command, args, {
      stdio: fd === undefined ? ['ignore', 'pipe', options.stderr ?? 'ignore'] : ['ignore', fd, fd],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    })
    if (fd !== undefined) closeSync(fd)
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
    let settled = false
    const settle = (status: number | null): void => {
      if (settled) return
      settled = true
      resolve({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
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
