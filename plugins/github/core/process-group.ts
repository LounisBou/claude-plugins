// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// A command that starts commands of its own (a package manager, a server, a browser) runs as the
// leader of its own process group, so stopping it stops what it started: SIGTERM to the whole
// group, then SIGKILL once the grace has passed.
import { spawn } from 'node:child_process'

/** How long a stopped process group has after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 5000

/** Sends `name` to the process group `pid` leads; a no-op once the group is gone. */
export function signalGroup(pid: number | undefined, name: NodeJS.Signals): void {
  try {
    if (pid !== undefined) process.kill(-pid, name)
  } catch {
    // the group is gone already
  }
}

/**
 * Runs `argv` without a shell in `cwd`, `env` added to this process's, its output on this
 * process's stderr, as the leader of its own process group. On `signal` the whole group gets
 * SIGTERM, then SIGKILL past the grace. Never rejects: resolves the exit status, null when the
 * command could not start or ended by a signal.
 */
export function runInGroup(argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>, signal: AbortSignal): Promise<number | null> {
  return new Promise(done => {
    const [command = '', ...args] = argv
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 2, 2], detached: true })
    let killer: NodeJS.Timeout | undefined
    const stop = (): void => {
      signalGroup(child.pid, 'SIGTERM')
      killer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS)
    }
    const settle = (status: number | null): void => {
      signal.removeEventListener('abort', stop)
      clearTimeout(killer)
      // A stopped leader may leave a child that ignored SIGTERM: the group goes with it.
      if (signal.aborted) signalGroup(child.pid, 'SIGKILL')
      done(status)
    }
    child.once('error', () => settle(null))
    child.once('close', code => settle(code))
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
}
