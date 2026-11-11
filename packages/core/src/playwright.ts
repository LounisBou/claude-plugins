// One pinned Playwright per machine, shared by every plugin that drives a browser: the
// `@playwright/test` package and its Chromium, installed once under the host's configuration
// directory, outside every plugin's cache, so a plugin update keeps it. The directory is named by
// the pin, so raising the pin installs beside the old one. An install is complete once its marker
// is written, last: a directory without it is a half-done install, removed and redone.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NotInstalled } from './locate.ts'
import { configDir, type Env } from './paths.ts'
import { readText, writeAtomic } from './store.ts'

/** The pinned version: raised here alone, then every consumer of core ships it (docs/architecture.md). */
export const PLAYWRIGHT_VERSION = '1.65.0'

/** The browser installed, as Playwright names it, in its headless shell alone. */
export const PLAYWRIGHT_BROWSER = 'chromium'

const MARKER = '.complete'

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

/** Runs `argv` without a shell in `cwd`, `env` added to this process's; resolves its exit status. */
export type Run = (argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>) => Promise<number | null>

export interface InstallDeps {
  readonly env: Env
  readonly home?: string
  /** Defaults to a spawn whose output goes to this process's stderr. */
  readonly run?: Run
  /** Whether a process lives; defaults to a signal 0. */
  readonly alive?: (pid: number) => boolean
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

/** Whether the install is whole: its marker, the pinned package, and the browser it downloaded. */
function complete(playwright: Playwright): boolean {
  if (readText(join(playwright.dir, MARKER)) !== `${PLAYWRIGHT_VERSION}\n`) return false
  if (installedVersion(playwright) !== PLAYWRIGHT_VERSION) return false
  try {
    return readdirSync(playwright.env.PLAYWRIGHT_BROWSERS_PATH).some(name => name.startsWith(PLAYWRIGHT_BROWSER))
  } catch {
    return false
  }
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

/* node:coverage ignore next 9 */
const spawnRun: Run = (argv, cwd, env) =>
  new Promise(done => {
    const [command = '', ...args] = argv
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 2, 2] })
    child.on('error', () => done(null))
    child.on('close', code => done(code))
  })

/* node:coverage ignore next 8 */
const signalZero = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Takes the install's lock, a file holding this process's id; a live holder's is refused. */
function lock(path: string, alive: (pid: number) => boolean): void {
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      writeSync(fd, `${process.pid}\n`)
      closeSync(fd)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = Number((readText(path) ?? '').trim())
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) throw new Error(`another install is running (pid ${holder}); run it again once it ends`)
      rmSync(path, { force: true })
    }
  }
}

/**
 * Installs the pinned Playwright and its browser once per machine. A complete install is left as
 * it is (`installed: false`); anything else in its directory is removed and installed again.
 */
export async function installPlaywright(deps: InstallDeps): Promise<{ playwright: Playwright; installed: boolean; bytes: number }> {
  const playwright = layout(playwrightDir(deps.env, deps.home))
  if (complete(playwright)) return { playwright, installed: false, bytes: sizeOf(playwright.dir) }
  const run = deps.run ?? spawnRun
  const lockPath = `${playwright.dir}.lock`
  mkdirSync(join(playwright.dir, '..'), { recursive: true })
  lock(lockPath, deps.alive ?? signalZero)
  try {
    rmSync(playwright.dir, { recursive: true, force: true })
    writeAtomic(join(playwright.dir, 'package.json'), `${JSON.stringify({ private: true, dependencies: { '@playwright/test': PLAYWRIGHT_VERSION } }, null, 2)}\n`, 0o644)
    const npm = await run(['npm', 'install', '--no-audit', '--no-fund', '--ignore-scripts'], playwright.dir, {})
    if (npm !== 0) throw new Error(`npm install failed (exit ${npm ?? 'none'}) in ${playwright.dir}`)
    const version = installedVersion(playwright)
    if (version !== PLAYWRIGHT_VERSION) throw new Error(`npm installed ${version ?? 'nothing'}, not ${PLAYWRIGHT_VERSION}, in ${playwright.dir}`)
    const browser = await run([process.execPath, playwright.cli, 'install', '--only-shell', PLAYWRIGHT_BROWSER], playwright.dir, playwright.env)
    if (browser !== 0 || !existsSync(playwright.env.PLAYWRIGHT_BROWSERS_PATH)) throw new Error(`the browser download failed (exit ${browser ?? 'none'}) in ${playwright.dir}`)
    writeAtomic(join(playwright.dir, MARKER), `${PLAYWRIGHT_VERSION}\n`, 0o644)
  } finally {
    rmSync(lockPath, { force: true })
  }
  if (!complete(playwright)) throw new Error(`the install in ${playwright.dir} is not complete`)
  return { playwright, installed: true, bytes: sizeOf(playwright.dir) }
}
