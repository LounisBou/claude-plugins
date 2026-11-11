import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { NotInstalled } from './locate.ts'
import { installPlaywright, locatePlaywright, lockfileOf, PLAYWRIGHT_PACKAGES, PLAYWRIGHT_VERSION, playwrightDir, sizeOf, type InstallDeps, type Run } from './playwright.ts'

const FIX = 'run /x:install'

interface Call {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  /** Whether the install's marker was already there when the command ran. */
  readonly marked: boolean
}

/** A machine whose npm and browser download write what the real ones would, unless told to fail. */
function machine(options: { failNpm?: boolean; failBrowser?: boolean; partialBrowser?: boolean; version?: string } = {}): { deps: InstallDeps; calls: Call[]; config: string } {
  const config = mkdtempSync(join(tmpdir(), 'core-pw-'))
  const calls: Call[] = []
  const deps: InstallDeps = {
    env: { CLAUDE_CONFIG_DIR: config },
    run: async (argv, cwd, env) => {
      calls.push({ argv, cwd, env, marked: existsSync(join(cwd, '.complete')) })
      if (argv[0] === 'npm') {
        if (options.failNpm === true) return 1
        const module = join(cwd, 'node_modules', '@playwright', 'test')
        mkdirSync(module, { recursive: true })
        writeFileSync(join(module, 'package.json'), JSON.stringify({ name: '@playwright/test', version: options.version ?? PLAYWRIGHT_VERSION }))
        writeFileSync(join(module, 'cli.js'), '')
        return 0
      }
      if (options.failBrowser === true) return 1
      const shell = join(env['PLAYWRIGHT_BROWSERS_PATH'] ?? '', 'chromium_headless_shell-1')
      mkdirSync(shell, { recursive: true })
      writeFileSync(join(shell, 'chrome'), 'x'.repeat(1000))
      if (options.partialBrowser !== true) writeFileSync(join(shell, 'INSTALLATION_COMPLETE'), '')
      return 0
    },
  }
  return { deps, calls, config }
}

describe('playwright', () => {
  it('lives in one directory per pinned version under the configuration directory', () => {
    assert.equal(playwrightDir({ CLAUDE_CONFIG_DIR: '/c' }), `/c/playwright/${PLAYWRIGHT_VERSION}`)
    assert.equal(playwrightDir({}, '/home/u'), `/home/u/.claude/playwright/${PLAYWRIGHT_VERSION}`)
  })

  it('is not found before an install, with the caller\'s fix', () => {
    const { deps } = machine()
    assert.throws(() => locatePlaywright(deps.env, FIX), (error: unknown) => error instanceof NotInstalled && /not installed/.test(error.message) && error.fix === FIX)
  })

  it('installs the pinned package and its browser into the shared directory, then is located there', async () => {
    const { deps, calls, config } = machine()
    const result = await installPlaywright(deps)
    const dir = join(config, 'playwright', PLAYWRIGHT_VERSION)
    assert.equal(result.installed, true)
    assert.equal(result.playwright.dir, dir)
    assert.ok(result.bytes >= 1000)
    assert.deepEqual(calls[0]?.argv, ['npm', 'ci', '--no-audit', '--no-fund', '--ignore-scripts'])
    assert.equal(calls[0]?.cwd, dir)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies, { '@playwright/test': PLAYWRIGHT_VERSION })
    assert.equal(calls[1]?.argv[1], join(dir, 'node_modules', '@playwright', 'test', 'cli.js'))
    assert.deepEqual(calls[1]?.argv.slice(2), ['install', '--only-shell', 'chromium'])
    assert.equal(calls[1]?.env['PLAYWRIGHT_BROWSERS_PATH'], join(dir, 'browsers'))
    const found = locatePlaywright(deps.env, FIX)
    assert.deepEqual(found, result.playwright)
    assert.equal(found.module, join(dir, 'node_modules', '@playwright', 'test'))
    assert.deepEqual(found.env, { PLAYWRIGHT_BROWSERS_PATH: join(dir, 'browsers') })
    assert.equal(existsSync(join(config, 'playwright', `${PLAYWRIGHT_VERSION}.lock`)), false)
  })

  it('does nothing the second time, and says so', async () => {
    const { deps, calls } = machine()
    await installPlaywright(deps)
    const again = await installPlaywright(deps)
    assert.equal(again.installed, false)
    assert.equal(calls.length, 2)
  })

  it('redoes a half-done install: a failed browser download leaves nothing located, the next call installs it all again', async () => {
    const failing = machine({ failBrowser: true })
    await assert.rejects(installPlaywright(failing.deps), /browser download failed \(exit 1\)/)
    assert.throws(() => locatePlaywright(failing.deps.env, FIX), /not installed/)
    const dir = playwrightDir(failing.deps.env)
    writeFileSync(join(dir, 'stale'), '')
    const healthy = machine()
    const result = await installPlaywright({ ...healthy.deps, env: failing.deps.env })
    assert.equal(result.installed, true)
    assert.equal(existsSync(join(dir, 'stale')), false)
    assert.equal(healthy.calls.length, 2)
  })

  it('reads an install whose browser is gone as half-done', async () => {
    const { deps } = machine()
    const { playwright } = await installPlaywright(deps)
    rmSync(playwright.env.PLAYWRIGHT_BROWSERS_PATH, { recursive: true })
    assert.throws(() => locatePlaywright(deps.env, FIX), /not installed/)
  })

  it('fails on a failed npm, and on a package of another version', async () => {
    await assert.rejects(installPlaywright(machine({ failNpm: true }).deps), /npm install failed \(exit 1\)/)
    await assert.rejects(installPlaywright(machine({ version: '0.0.1' }).deps), new RegExp(`installed 0\\.0\\.1, not ${PLAYWRIGHT_VERSION.replace(/\./g, '\\.')}`))
  })

  it('refuses while another live install holds the lock, and takes a dead one\'s over', async () => {
    const { deps, config } = machine()
    mkdirSync(join(config, 'playwright'), { recursive: true })
    writeFileSync(join(config, 'playwright', `${PLAYWRIGHT_VERSION}.lock`), '4242\n')
    await assert.rejects(installPlaywright({ ...deps, alive: pid => pid === 4242 }), /another install is running \(pid 4242\)/)
    const taken = await installPlaywright({ ...deps, alive: () => false })
    assert.equal(taken.installed, true)
  })

  it('installs from a lockfile pinning every package at the pin with its published integrity', async () => {
    const { deps } = machine()
    const { playwright } = await installPlaywright(deps)
    const lock = JSON.parse(readFileSync(join(playwright.dir, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string; integrity?: string; resolved?: string; dependencies?: Record<string, string> }> }
    assert.equal(readFileSync(join(playwright.dir, 'package-lock.json'), 'utf8'), lockfileOf())
    assert.deepEqual(Object.keys(lock.packages).sort(), ['', 'node_modules/@playwright/test', 'node_modules/playwright', 'node_modules/playwright-core'])
    for (const name of ['@playwright/test', 'playwright-core']) {
      const entry = lock.packages[`node_modules/${name}`]
      assert.equal(entry?.version, PLAYWRIGHT_VERSION)
      assert.match(entry?.integrity ?? '', /^sha512-[A-Za-z0-9+/]{86}==$/)
      assert.equal(entry?.integrity, PLAYWRIGHT_PACKAGES[name]?.integrity)
    }
    assert.equal(lock.packages['node_modules/@playwright/test']?.resolved, `https://registry.npmjs.org/@playwright/test/-/test-${PLAYWRIGHT_VERSION}.tgz`)
    assert.deepEqual(lock.packages['node_modules/playwright']?.dependencies, { 'playwright-core': PLAYWRIGHT_VERSION })
  })

  it('writes its marker last, once the browser is in place', async () => {
    const { deps, calls } = machine()
    await installPlaywright(deps)
    assert.deepEqual(calls.map(call => call.marked), [false, false])
  })

  it('reads a browser whose download did not finish as half-done, and redoes it', async () => {
    const partial = machine({ partialBrowser: true })
    await assert.rejects(installPlaywright(partial.deps), /left no complete chromium/)
    const dir = playwrightDir(partial.deps.env)
    assert.equal(existsSync(join(dir, '.complete')), false)
    const healthy = machine()
    const { playwright } = await installPlaywright({ ...healthy.deps, env: partial.deps.env })
    rmSync(join(playwright.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium_headless_shell-1', 'INSTALLATION_COMPLETE'))
    assert.throws(() => locatePlaywright(partial.deps.env, FIX), /not installed/)
    const again = await installPlaywright({ ...healthy.deps, env: partial.deps.env })
    assert.equal(again.installed, true)
    assert.equal(healthy.calls.length, 4)
  })

  it('keeps an install another one finished while it waited for the lock', async () => {
    const { deps, calls, config } = machine()
    const dir = playwrightDir(deps.env)
    mkdirSync(join(config, 'playwright'), { recursive: true })
    writeFileSync(`${dir}.lock`, '4242\n')
    const result = await installPlaywright({
      ...deps,
      alive: () => {
        // The holder finished the install, then died before releasing its lock.
        mkdirSync(join(dir, 'node_modules', '@playwright', 'test'), { recursive: true })
        writeFileSync(join(dir, 'node_modules', '@playwright', 'test', 'package.json'), JSON.stringify({ version: PLAYWRIGHT_VERSION }))
        mkdirSync(join(dir, 'browsers', 'chromium_headless_shell-1'), { recursive: true })
        writeFileSync(join(dir, 'browsers', 'chromium_headless_shell-1', 'INSTALLATION_COMPLETE'), '')
        writeFileSync(join(dir, '.complete'), `${PLAYWRIGHT_VERSION}\n`)
        return false
      },
    })
    assert.equal(result.installed, false)
    assert.equal(calls.length, 0)
    assert.ok(existsSync(join(dir, '.complete')))
    assert.deepEqual(readdirSync(join(config, 'playwright')), [PLAYWRIGHT_VERSION])
  })

  it('refuses a lock naming no process, and leaves no file of its own behind', async () => {
    const { deps, config } = machine()
    mkdirSync(join(config, 'playwright'), { recursive: true })
    writeFileSync(join(config, 'playwright', `${PLAYWRIGHT_VERSION}.lock`), '')
    await assert.rejects(installPlaywright({ ...deps, alive: () => false }), /names no process/)
    assert.deepEqual(readdirSync(join(config, 'playwright')), [`${PLAYWRIGHT_VERSION}.lock`])
  })

  it('stops its command on the caller\'s signal and past its timeout, and releases its lock', async () => {
    const lockPath = (config: string): string => join(config, 'playwright', `${PLAYWRIGHT_VERSION}.lock`)
    const hanging = (signals: AbortSignal[]): Run => (_argv, _cwd, _env, signal) => {
      signals.push(signal)
      return new Promise(done => signal.addEventListener('abort', () => done(null), { once: true }))
    }
    const timed = machine()
    const seen: AbortSignal[] = []
    await assert.rejects(installPlaywright({ ...timed.deps, run: hanging(seen), timeoutMs: 50 }), /took longer than 0\.05 s: npm install stopped/)
    assert.equal(seen[0]?.aborted, true)
    assert.equal(existsSync(lockPath(timed.config)), false)
    const caller = new AbortController()
    const interrupted = machine()
    const pending = installPlaywright({ ...interrupted.deps, run: hanging([]), signal: caller.signal })
    setTimeout(() => caller.abort(), 20)
    await assert.rejects(pending, /install was interrupted: npm install stopped/)
    assert.equal(existsSync(lockPath(interrupted.config)), false)
  })

  it('sizes a directory by the bytes of its files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-size-'))
    mkdirSync(join(dir, 'a'))
    writeFileSync(join(dir, 'a', 'b'), '12345')
    writeFileSync(join(dir, 'c'), '678')
    assert.equal(sizeOf(dir), 8)
  })
})
