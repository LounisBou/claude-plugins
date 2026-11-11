import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { NotInstalled } from './locate.ts'
import { installPlaywright, locatePlaywright, PLAYWRIGHT_VERSION, playwrightDir, sizeOf, type InstallDeps } from './playwright.ts'

const FIX = 'run /x:install'

interface Call {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

/** A machine whose npm and browser download write what the real ones would, unless told to fail. */
function machine(options: { failNpm?: boolean; failBrowser?: boolean; version?: string } = {}): { deps: InstallDeps; calls: Call[]; config: string } {
  const config = mkdtempSync(join(tmpdir(), 'core-pw-'))
  const calls: Call[] = []
  const deps: InstallDeps = {
    env: { CLAUDE_CONFIG_DIR: config },
    run: async (argv, cwd, env) => {
      calls.push({ argv, cwd, env })
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
    assert.deepEqual(calls[0]?.argv.slice(0, 2), ['npm', 'install'])
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

  it('sizes a directory by the bytes of its files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-size-'))
    mkdirSync(join(dir, 'a'))
    writeFileSync(join(dir, 'a', 'b'), '12345')
    writeFileSync(join(dir, 'c'), '678')
    assert.equal(sizeOf(dir), 8)
  })
})
