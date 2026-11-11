// What both commands share: running a command in its own process group, the target repository
// and its two refs, the temporary checkout of a ref, and the run directory.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Run } from '../../../../core/index.ts'
import { DriftError } from './compare.ts'
import { configPathOf, scratchpadOf, slugOf, type Options } from './config.ts'

export interface Deps {
  /** Where the temporary checkouts are made, and the run directory when no scratchpad is found. */
  readonly tmp: string
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** The host's temp root, under which a session's scratchpad is searched. */
  readonly hostTmp?: string
  readonly signal?: AbortSignal
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  /** How `drift install` runs npm and the browser download; a real spawn when unset. */
  readonly installRun?: Run
}

export interface Ran {
  readonly status: number | null
  readonly stdout: string
}

/** How long an aborted command's process group has after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5000

/**
 * Runs `argv` without a shell, `env` added to this process's environment; its streams go to `log`
 * (appended) or are collected. Never rejects. The command leads its own process group: on abort the
 * whole group is stopped, the processes it started included, and the promise settles once it closed.
 */
export function exec(argv: readonly string[], cwd: string, signal: AbortSignal | undefined, log?: string, env?: Readonly<Record<string, string>>): Promise<Ran> {
  return new Promise(done => {
    const [command = '', ...args] = argv
    const fd = log === undefined ? undefined : openSync(log, 'a')
    const child = spawn(command, args, {
      cwd,
      detached: true,
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      stdio: fd === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', fd, fd],
    })
    if (fd !== undefined) closeSync(fd)
    const out: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    let killer: NodeJS.Timeout | undefined
    const group = (name: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, name)
      } catch {
        // the group is gone already
      }
    }
    const abort = (): void => {
      group('SIGTERM')
      killer = setTimeout(() => group('SIGKILL'), KILL_GRACE_MS)
    }
    let settled = false
    const settle = (status: number | null): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      clearTimeout(killer)
      done({ status, stdout: Buffer.concat(out).toString('utf8').trim() })
    }
    child.on('error', () => settle(null))
    child.on('close', code => settle(code))
    if (signal?.aborted === true) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}


export const interrupted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new DriftError('interrupted')
}


/** Removes a checkout made by `buildSide`, its record in the repository too; a no-op when there is none. */
export async function removeCheckout(top: string, tree: string): Promise<void> {
  if (!existsSync(tree)) return
  const removed = await exec(['git', '-C', top, 'worktree', 'remove', '--force', tree], top, undefined)
  if (removed.status === 0 && !existsSync(tree)) return
  rmSync(tree, { recursive: true, force: true })
  await exec(['git', '-C', top, 'worktree', 'prune'], top, undefined)
}

export async function git(top: string, args: readonly string[], signal: AbortSignal | undefined): Promise<string | undefined> {
  const ran = await exec(['git', '-C', top, ...args], top, signal)
  interrupted(signal)
  return ran.status === 0 ? ran.stdout : undefined
}

/** A config file's JSON, or a tool error naming the file. */
export function readJson(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new DriftError(`no config at ${path}: write one, or name it with --config`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new DriftError(`${path}: not JSON`)
  }
}

export function runDirectory(out: string | undefined, deps: Deps): string {
  if (out !== undefined) {
    const dir = resolve(out)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const uid = process.getuid?.() ?? 0
  const pad = scratchpadOf(deps.env, deps.hostTmp ?? `/tmp/claude-${uid}`)
  return mkdtempSync(join(pad ?? deps.tmp, 'drift-'))
}


/** The repository the refs are read in, the config file, and the two refs as commits. */
export interface Target {
  readonly top: string
  readonly configPath: string
  readonly baseSha: string
  readonly headSha: string
}

export async function targetOf(options: Options, deps: Deps): Promise<Target> {
  const { signal } = deps
  const repo = resolve(options.repo)
  const top = existsSync(repo) ? await git(repo, ['rev-parse', '--show-toplevel'], signal) : undefined
  if (top === undefined) throw new DriftError(`${repo} is not a git repository`)
  let configPath = options.config
  if (configPath === undefined) {
    const slug = slugOf((await git(top, ['remote', 'get-url', 'origin'], signal)) ?? '')
    if (slug === undefined) throw new DriftError('no origin to name the config after: name it with --config')
    configPath = configPathOf(deps.home, slug, deps.env)
  }
  configPath = resolve(configPath)
  readJson(configPath)
  const resolveRef = async (side: string, ref: string): Promise<string> => {
    const found = await git(top, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], signal)
    if (found === undefined) throw new DriftError(`${side}: ${ref} is not a commit`)
    return found
  }
  return { top, configPath, baseSha: await resolveRef('base', options.base), headSha: await resolveRef('head', options.head) }
}

/** Runs one step of a side, its output appended to the side's log; a failure is a tool error naming it. */
export type Step = (what: string, argv: readonly string[], cwd: string, env?: Readonly<Record<string, string>>) => Promise<void>

export function stepper(side: string, log: string, signal: AbortSignal | undefined): Step {
  writeFileSync(log, '')
  return async (what, argv, cwd, env) => {
    interrupted(signal)
    const ran = await exec(argv, cwd, signal, log, env)
    interrupted(signal)
    if (ran.status !== 0) throw new DriftError(`${side}: ${what} failed (exit ${ran.status ?? 'none'}); its log: ${log}`)
  }
}

/** Checks `sha` out at `tree`, outside the target checkout, then runs the config's install there. */
export async function checkout(step: Step, top: string, sha: string, tree: string, install: readonly string[] | undefined, env: Readonly<Record<string, string>> | undefined): Promise<void> {
  await step('checkout', ['git', '-C', top, 'worktree', 'add', '--detach', tree, sha], top)
  if (install !== undefined) await step('install', install, tree, env)
}
