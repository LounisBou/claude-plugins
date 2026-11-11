// The project's server for one side: started without a shell as the leader of its own process
// group, waited for until its URL answers, and stopped with that whole group, so the processes it
// started (a package manager's child, a bundler's workers) end with it. Its environment is an
// allow list: what any server needs to run, and the config's own variables, never the caller's
// secrets.
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { connect } from 'node:net'
import { KILL_GRACE_MS, signalGroup } from '../../../../core/index.ts'
import { DriftError } from './compare.ts'

export interface Server {
  readonly pid: number
  /** Stops the group and resolves once the leader closed and the port is free, SIGKILL past the grace. */
  readonly stop: () => Promise<void>
}

export interface ServerSpec {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>> | undefined
  readonly port: number
  readonly url: string
  readonly startTimeoutMs: number
  /** Where its output is appended. */
  readonly log: string
}

const POLL_MS = 200
/** How long a probe of the port waits for a connection before reading it free. */
const PROBE_TIMEOUT_MS = 1000
/** How long one request to the server's URL waits for an answer while it starts. */
const ANSWER_TIMEOUT_MS = 2000
/** The variables of this process the server inherits; the config's `env` is added to them. */
export const SERVER_ENV = ['PATH', 'HOME', 'NODE_ENV'] as const
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

/** Whether something accepts connections on `port` of `host`, over IPv4 or IPv6. */
export function portTaken(host: string, port: number): Promise<boolean> {
  return new Promise(done => {
    const socket = connect({ host, port, autoSelectFamily: true })
    socket.setTimeout(PROBE_TIMEOUT_MS)
    const end = (taken: boolean): void => {
      socket.destroy()
      done(taken)
    }
    socket.once('connect', () => end(true))
    socket.once('timeout', () => end(false))
    socket.once('error', () => end(false))
  })
}

/** The server's environment: SERVER_ENV from `from`, those it has, then `added`. */
export function serverEnv(from: Readonly<Record<string, string | undefined>>, added: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of SERVER_ENV) {
    const value = from[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, ...added }
}

/** Starts the server and waits until its URL answers, whatever the status; a tool error otherwise, the server stopped. */
export async function startServer(spec: ServerSpec, signal: AbortSignal | undefined): Promise<Server> {
  // An IPv6 host name keeps its brackets in a URL, never in a socket's address.
  const host = new URL(spec.url).hostname.replace(/^\[(.*)\]$/, '$1')
  if (await portTaken(host, spec.port)) throw new DriftError(`port ${spec.port} is in use: stop what listens there, or set "shots.port" to a free one`)
  const [command = '', ...args] = spec.argv
  const fd = openSync(spec.log, 'a')
  const child = spawn(command, args, {
    cwd: spec.cwd,
    detached: true,
    env: serverEnv(process.env, spec.env),
    stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  let exit: string | undefined
  const closed = new Promise<void>(done => {
    child.once('error', error => {
      exit = error.message
      done()
    })
    child.once('close', code => {
      exit = `exit ${code ?? 'by a signal'}`
      done()
    })
  })
  const stop = async (): Promise<void> => {
    signalGroup(child.pid, 'SIGTERM')
    const deadline = Date.now() + KILL_GRACE_MS
    while (Date.now() < deadline && (exit === undefined || (await portTaken(host, spec.port)))) await sleep(POLL_MS)
    signalGroup(child.pid, 'SIGKILL')
    await Promise.race([closed, sleep(KILL_GRACE_MS)])
  }
  const deadline = Date.now() + spec.startTimeoutMs
  try {
    for (;;) {
      if (signal?.aborted === true) throw new DriftError('interrupted')
      if (exit !== undefined) throw new DriftError(`the server stopped before answering (${exit}); its log: ${spec.log}`)
      try {
        await fetch(spec.url, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS), redirect: 'manual' })
        break
      } catch {
        if (Date.now() > deadline) throw new DriftError(`the server did not answer at ${spec.url} within ${spec.startTimeoutMs / 1000} s; its log: ${spec.log}`)
        await sleep(POLL_MS)
      }
    }
  } catch (error) {
    await stop()
    throw error
  }
  return { pid: child.pid ?? 0, stop }
}
