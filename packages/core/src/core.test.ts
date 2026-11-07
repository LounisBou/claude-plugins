import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { configDir, DeadlineExceeded, installRecordPath, locatePlugin, NotInstalled, parseSessionName, readText, sessionName, setting, stateDir, update, withDeadline, withLock, writeAtomic } from './index.ts'

const scratch = (): string => mkdtempSync(join(tmpdir(), 'core-'))

describe('paths', () => {
  it('reads an empty variable as unset', () => {
    assert.equal(setting({ X: '' }, 'X'), undefined)
    assert.equal(setting({ X: 'v' }, 'X'), 'v')
  })

  it('puts the configuration under the home unless CLAUDE_CONFIG_DIR names it', () => {
    assert.equal(configDir({}, '/home/u'), '/home/u/.claude')
    assert.equal(configDir({ CLAUDE_CONFIG_DIR: '' }, '/home/u'), '/home/u/.claude')
    assert.equal(configDir({ CLAUDE_CONFIG_DIR: '/c' }, '/home/u'), '/c')
  })

  it('gives each plugin its own state directory and refuses a name that is not one', () => {
    assert.equal(stateDir('orchestrator', { CLAUDE_CONFIG_DIR: '/c' }), '/c/orchestrator')
    assert.throws(() => stateDir('../x', {}), /not a plugin name/)
  })
})

describe('store', () => {
  it('writes in one rename and leaves no temporary file', () => {
    const dir = scratch()
    const path = join(dir, 'deep', 'a.json')
    writeAtomic(path, 'one')
    writeAtomic(path, 'two')
    assert.equal(readText(path), 'two')
    assert.deepEqual(readdirSync(join(dir, 'deep')), ['a.json'])
  })

  it('reads a missing file as undefined and rethrows any other error', () => {
    const dir = scratch()
    assert.equal(readText(join(dir, 'none')), undefined)
    assert.throws(() => readText(dir), /EISDIR/)
  })

  it('removes its temporary file when the rename fails', () => {
    const dir = scratch()
    const target = join(dir, 'target')
    mkdirSync(join(target, 'occupied'), { recursive: true })
    assert.throws(() => writeAtomic(target, 'x'))
    assert.deepEqual(readdirSync(dir), ['target'])
  })

  it('updates under the lock, from absent to present', () => {
    const path = join(scratch(), 'count')
    assert.equal(update(path, current => String(Number(current ?? '0') + 1)), '1')
    assert.equal(update(path, current => String(Number(current ?? '0') + 1)), '2')
  })

  it('releases the lock when the work throws', () => {
    const path = join(scratch(), 'x')
    assert.throws(() => withLock(path, () => { throw new Error('boom') }), /boom/)
    assert.equal(withLock(path, () => 'free'), 'free')
  })

  it('takes over a lock its holder left behind', () => {
    const path = join(scratch(), 'x')
    writeFileSync(`${path}.lock`, '1\n')
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${path}.lock`, old, old)
    assert.equal(withLock(path, () => 'taken'), 'taken')
  })

  it('gives up on a lock held past the wait', () => {
    const path = join(scratch(), 'x')
    writeFileSync(`${path}.lock`, '1\n')
    let clock = 0
    assert.throws(() => withLock(path, () => 'never', { waitMs: 50, now: () => clock, sleep: ms => { clock += ms } }), /stayed locked for 50 ms/)
  })

  it('loses no update when processes write at the same time', async () => {
    const path = join(scratch(), 'count')
    const store = fileURLToPath(new URL('./store.ts', import.meta.url))
    const program = `import { update } from ${JSON.stringify(store)}
for (let i = 0; i < 25; i++) update(${JSON.stringify(path)}, c => String(Number(c ?? '0') + 1))`
    const writers = Array.from({ length: 4 }, () => new Promise<number | null>(resolve => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', program], { stdio: 'ignore' })
      child.on('exit', resolve)
    }))
    assert.deepEqual(await Promise.all(writers), [0, 0, 0, 0])
    assert.equal(readFileSync(path, 'utf8'), '100')
  })
})

describe('deadline', () => {
  it('returns what finished in time', async () => {
    assert.equal(await withDeadline(1_000, async () => 'done'), 'done')
  })

  it('aborts the work at the deadline, so it can stop before writing', async () => {
    let wrote = false
    await assert.rejects(
      withDeadline(10, signal => new Promise(resolve => {
        signal.addEventListener('abort', () => resolve(undefined))
        setTimeout(() => { if (!signal.aborted) wrote = true; resolve(undefined) }, 50)
      })),
      (error: unknown) => error instanceof DeadlineExceeded && error.ms === 10,
    )
    assert.equal(wrote, false)
  })
})

describe('names', () => {
  it('reads the role and subject of each shape', () => {
    assert.deepEqual(parseSessionName('Orch : billing'), { role: 'orchestrator', subject: 'billing' })
    assert.deepEqual(parseSessionName('Agent : P3 cache'), { role: 'agent', subject: 'P3 cache' })
    assert.equal(parseSessionName('Coord : x')?.role, 'coordinator')
    assert.equal(parseSessionName('Audit : y')?.role, 'auditor')
  })

  it('gives no role to other names, an empty, padded or long subject', () => {
    for (const name of ['billing', 'Orch: x', 'Orch : ', 'Orch :  x', 'Orch : x ', `Orch : ${'a'.repeat(26)}`]) assert.equal(parseSessionName(name), null, name)
    assert.ok(parseSessionName(`Orch : ${'a'.repeat(25)}`))
  })

  it('counts characters, not bytes', () => {
    assert.ok(parseSessionName(`Orch : ${'é'.repeat(25)}`))
  })

  it('builds a name, or refuses a subject that does not fit', () => {
    assert.equal(sessionName('Orch', 'billing'), 'Orch : billing')
    assert.throws(() => sessionName('Agent', ' x'), /not a session subject/)
  })
})

describe('locate', () => {
  function host(plugins: unknown): { env: { CLAUDE_CONFIG_DIR: string }; root: string } {
    const root = scratch()
    mkdirSync(join(root, 'plugins'))
    if (plugins !== undefined) writeFileSync(join(root, 'plugins', 'installed_plugins.json'), typeof plugins === 'string' ? plugins : JSON.stringify(plugins))
    return { env: { CLAUDE_CONFIG_DIR: root }, root }
  }

  it('finds the install path the host recorded, in the order of the marketplaces', () => {
    const { env, root } = host(undefined)
    const installed = join(root, 'cache', 'github')
    mkdirSync(installed, { recursive: true })
    writeFileSync(installRecordPath(env), JSON.stringify({ plugins: { 'github@old': [{ installPath: join(root, 'gone') }], 'github@lounisbou': ['junk', { installPath: installed }] } }))
    assert.equal(locatePlugin('github', ['old', 'lounisbou'], env), installed)
  })

  it('lets an override name a checkout, and refuses one that is not a directory', () => {
    const { env, root } = host(undefined)
    assert.equal(locatePlugin('github', ['lounisbou'], { ...env, ROOT: root }, { override: 'ROOT' }), root)
    assert.throws(() => locatePlugin('github', ['lounisbou'], { ...env, ROOT: join(root, 'none') }, { override: 'ROOT' }), /ROOT is not a directory/)
  })

  it('says what is wrong and how to fix it', () => {
    const cases: [unknown, RegExp][] = [
      [undefined, /no install record/],
      ['{', /is not JSON/],
      [{ other: 1 }, /has no plugins/],
      [{ plugins: { 'github@lounisbou': [{ installPath: '' }] } }, /is not installed \(looked for github@lounisbou\)/],
    ]
    for (const [record, problem] of cases) {
      assert.throws(() => locatePlugin('github', ['lounisbou'], host(record).env), (error: unknown) =>
        error instanceof NotInstalled && problem.test(error.message) && error.fix === '/plugin install github@lounisbou')
    }
  })
})
