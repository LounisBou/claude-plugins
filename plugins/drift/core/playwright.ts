// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// One pinned Playwright per machine, shared by every plugin that drives a browser: the
// `@playwright/test` package and its Chromium, installed once under the host's configuration
// directory, outside every plugin's cache, so a plugin update keeps it. The directory is named by
// the pin, so raising the pin installs beside the old one. An install is complete once its marker
// is written, last: a directory without it is a half-done install, removed and redone.
import { randomBytes } from 'node:crypto'
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NotInstalled } from './locate.ts'
import { configDir, type Env } from './paths.ts'
import { runInGroup } from './process-group.ts'
import { readText, writeAtomic } from './store.ts'
import { temporaryOf } from './store-io.ts'

/** The pinned version: raised here alone, with the integrity of each package, then every consumer of core ships it (docs/architecture.md). */
export const PLAYWRIGHT_VERSION = '1.65.0'

/**
 * Every package the pin installs, with the integrity the registry published for it at that
 * version (`npm view <name>@<version> dist.integrity`) and the packages it depends on. They make
 * the install's lockfile: `npm ci` refuses a tarball whose hash is not the one written here.
 */
export const PLAYWRIGHT_PACKAGES: Readonly<Record<string, { readonly integrity: string; readonly dependencies: readonly string[] }>> = {
  '@playwright/test': { integrity: 'sha512-iGURLGuKDLakSEl7Pgfv8h7f+XLT+V861Wfhz0zlEl5nyFuKUopdkFBPKqTllTUp06aOwPuH8iuUEb3yp3MpbQ==', dependencies: ['playwright'] },
  playwright: { integrity: 'sha512-F3AMWcR44qMBt4kq+6Kb6mX7bjGXshktKFOPULd7reED6ZJWevjbNRqysP7q+AATE9kdPEZBibex1BYsvpVoeA==', dependencies: ['playwright-core'] },
  'playwright-core': { integrity: 'sha512-vNSKgH6YqtN7cdT/L334zo0a+YwkrpicyrHJlWWPIm/Q+Nn2SWInil01oT0mbu96U4GgoRtCYQD9CzJQgju+lA==', dependencies: [] },
}

/** The browser installed, as Playwright names it, in its headless shell alone. */
export const PLAYWRIGHT_BROWSER = 'chromium'

/** How long the whole install (the packages, then the browser's download) may take before it is stopped. */
export const INSTALL_TIMEOUT_MS = 15 * 60_000

const MARKER = '.complete'
/** The file Playwright writes in a browser's directory once its download is whole. */
const BROWSER_MARKER = 'INSTALLATION_COMPLETE'
/** How many times a lock left by a dead install is taken over before giving up. */
const TAKEOVERS = 5
export interface Playwright {
  /** The install's directory. */
  readonly dir: string
  /** The `@playwright/test` package's directory: the path to require from. */
  readonly module: string
  /** Its command line, run with node. */
  readonly cli: string
  /** The environment every run of it needs, so the browser is found in the install. */
  readonly env: { readonly PLAYWRIGHT_BROWSERS_PATH: string }
}

/**
 * Runs `argv` without a shell in `cwd`, `env` added to this process's; resolves its exit status.
 * Stops the command, the processes it started included, when `signal` aborts.
 */
export type Run = (argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<number | null>

export interface InstallDeps {
  readonly env: Env
  readonly home?: string
  /** Defaults to runInGroup: its own process group, its output on this process's stderr. */
  readonly run?: Run
  /** Whether a process lives; defaults to a signal 0. */
  readonly alive?: (pid: number) => boolean
  /** The caller's cancellation: the install's commands are stopped, its lock released. */
  readonly signal?: AbortSignal
  /** Defaults to INSTALL_TIMEOUT_MS. */
  readonly timeoutMs?: number
}

/** The install's directory for the pinned version: `<configDir>/playwright/<version>`. */
export function playwrightDir(env: Env, home: string = homedir()): string {
  return join(configDir(env, home), 'playwright', PLAYWRIGHT_VERSION)
}

function layout(dir: string): Playwright {
  const module = join(dir, 'node_modules', '@playwright', 'test')
  return { dir, module, cli: join(module, 'cli.js'), env: { PLAYWRIGHT_BROWSERS_PATH: join(dir, 'browsers') } }
}

function installedVersion(playwright: Playwright): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readText(join(playwright.module, 'package.json')) ?? '')
    const version = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['version'] : undefined
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/** Whether the pinned browser's download is whole: its directory holds Playwright's own marker. */
function browserComplete(playwright: Playwright): boolean {
  try {
    return readdirSync(playwright.env.PLAYWRIGHT_BROWSERS_PATH).some(name => name.startsWith(PLAYWRIGHT_BROWSER) && existsSync(join(playwright.env.PLAYWRIGHT_BROWSERS_PATH, name, BROWSER_MARKER)))
  } catch {
    return false
  }
}

/** Whether the install is whole: its marker, the pinned package, and the browser it downloaded. */
function complete(playwright: Playwright): boolean {
  return readText(join(playwright.dir, MARKER)) === `${PLAYWRIGHT_VERSION}\n` && installedVersion(playwright) === PLAYWRIGHT_VERSION && browserComplete(playwright)
}

/** The pinned install, or NotInstalled carrying `fix`, the caller's command that installs it. */
export function locatePlaywright(env: Env, fix: string, home?: string): Playwright {
  const playwright = layout(playwrightDir(env, home))
  if (!complete(playwright)) throw new NotInstalled(`Playwright ${PLAYWRIGHT_VERSION} is not installed in ${playwright.dir}`, fix)
  return playwright
}

/** The bytes of every file under `dir`, links not followed. */
export function sizeOf(dir: string): number {
  let bytes = 0
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) bytes += lstatSync(join(entry.parentPath, entry.name)).size
  }
  return bytes
}

/** The install's package-lock.json: every pinned package at the pin, with its published integrity. */
export function lockfileOf(): string {
  const packages: Record<string, unknown> = { '': { dependencies: { '@playwright/test': PLAYWRIGHT_VERSION } } }
  for (const [name, { integrity, dependencies }] of Object.entries(PLAYWRIGHT_PACKAGES)) {
    packages[`node_modules/${name}`] = {
      version: PLAYWRIGHT_VERSION,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1) ?? name}-${PLAYWRIGHT_VERSION}.tgz`,
      integrity,
      ...(dependencies.length === 0 ? {} : { dependencies: Object.fromEntries(dependencies.map(dependency => [dependency, PLAYWRIGHT_VERSION])) }),
    }
  }
  return `${JSON.stringify({ lockfileVersion: 3, requires: true, packages }, null, 2)}\n`
}

/* node:coverage ignore next 8 */
const signalZero = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The lock's holder as read now: its process id (undefined when unreadable) and the file's inode; undefined when there is no lock. */
function holderOf(path: string): { pid: number | undefined; ino: number } | undefined {
  try {
    const { ino } = statSync(path)
    const text = readText(path)
    if (text === undefined) return undefined
    const pid = Number(text)
    return { pid: /^\d+\n$/.test(text) && pid > 0 ? pid : undefined, ino }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Takes the install's lock: a file holding this process's id, written whole beside it then linked
 * into place, so no reader ever sees it half-written and two takers never both win. A live
 * holder's lock is refused, and so is one naming no process: it cannot be told stale. A dead
 * holder's is read again before it is removed, so a lock another install took in between is kept.
 */
function lock(path: string, alive: (pid: number) => boolean): void {
  const mine = temporaryOf(path, `${process.pid}-${randomBytes(4).toString('hex')}`)
  writeFileSync(mine, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
  try {
    for (let takeovers = 0; ; ) {
      try {
        linkSync(mine, path)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const seen = holderOf(path)
      if (seen === undefined) continue
      if (seen.pid === undefined) throw new Error(`the install's lock ${path} names no process: remove it once no install runs`)
      if (alive(seen.pid)) throw new Error(`another install is running (pid ${seen.pid}); run it again once it ends`)
      if (++takeovers > TAKEOVERS) throw new Error(`the install's lock ${path} keeps changing hands; run it again`)
      const again = holderOf(path)
      if (again?.ino === seen.ino && again.pid === seen.pid) rmSync(path, { force: true })
    }
  } finally {
    rmSync(mine, { force: true })
  }
}

/** Runs one step of the install, stopped by `signal`; a failure, the stop included, is an error naming it. */
async function step(run: Run, what: string, argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>, signal: AbortSignal, timeoutMs: number): Promise<void> {
  const status = await run(argv, cwd, env, signal)
  if (signal.aborted) throw new Error(signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? `the install took longer than ${timeoutMs / 1000} s: ${what} stopped in ${cwd}` : `the install was interrupted: ${what} stopped in ${cwd}`)
  if (status !== 0) throw new Error(`${what} failed (exit ${status ?? 'none'}) in ${cwd}`)
}

/**
 * Installs the pinned Playwright and its browser once per machine. A complete install is left as
 * it is (`installed: false`), also when another install completed it while this one waited for
 * the lock; anything else in its directory is removed and installed again. The packages come from
 * a lockfile carrying their published integrity (`npm ci`), their scripts not run. Each command
 * runs in its own process group, stopped on the caller's signal and past the timeout.
 */
export async function installPlaywright(deps: InstallDeps): Promise<{ playwright: Playwright; installed: boolean; bytes: number }> {
  const playwright = layout(playwrightDir(deps.env, deps.home))
  if (complete(playwright)) return { playwright, installed: false, bytes: sizeOf(playwright.dir) }
  const run = deps.run ?? runInGroup
  const timeoutMs = deps.timeoutMs ?? INSTALL_TIMEOUT_MS
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(deps.signal === undefined ? [] : [deps.signal])])
  const lockPath = `${playwright.dir}.lock`
  mkdirSync(join(playwright.dir, '..'), { recursive: true })
  lock(lockPath, deps.alive ?? signalZero)
  try {
    if (complete(playwright)) return { playwright, installed: false, bytes: sizeOf(playwright.dir) }
    rmSync(playwright.dir, { recursive: true, force: true })
    writeAtomic(join(playwright.dir, 'package.json'), `${JSON.stringify({ private: true, dependencies: { '@playwright/test': PLAYWRIGHT_VERSION } }, null, 2)}\n`, 0o644)
    writeAtomic(join(playwright.dir, 'package-lock.json'), lockfileOf(), 0o644)
    await step(run, 'npm install', ['npm', 'ci', '--no-audit', '--no-fund', '--ignore-scripts'], playwright.dir, {}, signal, timeoutMs)
    const version = installedVersion(playwright)
    if (version !== PLAYWRIGHT_VERSION) throw new Error(`npm installed ${version ?? 'nothing'}, not ${PLAYWRIGHT_VERSION}, in ${playwright.dir}`)
    await step(run, 'the browser download', [process.execPath, playwright.cli, 'install', '--only-shell', PLAYWRIGHT_BROWSER], playwright.dir, playwright.env, signal, timeoutMs)
    if (!browserComplete(playwright)) throw new Error(`the browser download left no complete ${PLAYWRIGHT_BROWSER} in ${playwright.env.PLAYWRIGHT_BROWSERS_PATH}`)
    writeAtomic(join(playwright.dir, MARKER), `${PLAYWRIGHT_VERSION}\n`, 0o644)
  } finally {
    rmSync(lockPath, { force: true })
  }
  return { playwright, installed: true, bytes: sizeOf(playwright.dir) }
}
