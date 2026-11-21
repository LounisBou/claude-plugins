import { strict as assert } from 'node:assert'
import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fdWriter, isEntry, openLog, resolvedPath, run } from './process.ts'

const node = process.execPath

test('run collects stdout and the exit status, without a shell', async () => {
  assert.deepEqual(await run([node, '-e', 'process.stdout.write("a $HOME;"); process.exit(3)']), { status: 3, stdout: 'a $HOME;', stderr: '' })
  assert.deepEqual(await run([node, '-e', 'process.stdout.write(process.cwd())'], { cwd: '/' }), { status: 0, stdout: '/', stderr: '' })
  assert.deepEqual(await run([node, '-e', 'process.stdout.write(process.env.RUN_SPEC_VAR ?? "unset")'], { env: { RUN_SPEC_VAR: 'set' } }), { status: 0, stdout: 'set', stderr: '' })
  assert.deepEqual(await run([node, '-e', 'process.stdout.write(process.env.RUN_SPEC_VAR ?? "unset")']), { status: 0, stdout: 'unset', stderr: '' })
  assert.deepEqual(await run([node, '-e', 'process.stderr.write("why")'], { stderr: 'pipe' }), { status: 0, stdout: '', stderr: 'why' })
})

test('run: a log takes both streams, truncated or appended; a log that cannot open runs nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'process-'))
  try {
    const log = join(dir, 'log')
    writeFileSync(log, 'old\n')
    const both = 'process.stdout.write("o\\n"); process.stderr.write("e\\n")'
    assert.deepEqual(await run([node, '-e', both], { log: { path: log, append: false } }), { status: 0, stdout: '', stderr: '' })
    await run([node, '-e', both], { log: { path: log, append: true } })
    assert.deepEqual(readFileSync(log, 'utf8').split('\n').sort(), ['', 'e', 'e', 'o', 'o'])
    assert.deepEqual(await run([node, '-e', 'process.exit(0)'], { log: { path: join(dir, 'no', 'log'), append: true } }), { status: 1, stdout: '', stderr: '' })
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('run: the input is the command\'s stdin, and none is an empty one', async () => {
  assert.deepEqual(await run(['cat'], { input: 'gate\n' }), { status: 0, stdout: 'gate\n', stderr: '' })
  assert.deepEqual(await run(['cat']), { status: 0, stdout: '', stderr: '' })
})

test('run: a command that cannot start has no status', async () => {
  assert.deepEqual(await run(['/no/such/command']), { status: null, stdout: '', stderr: '' })
})

test('run: aborting the signal kills the command', async () => {
  const controller = new AbortController()
  const ran = run([node, '-e', 'setTimeout(() => {}, 60000)'], { signal: controller.signal, stderr: 'inherit' })
  controller.abort()
  assert.equal((await ran).status, null)
})

test('fdWriter writes every byte, retries a busy descriptor, and stops quietly at a closed pipe', () => {
  const written: string[] = []
  let busy = true
  const write = fdWriter(1, (_fd, bytes) => {
    if (busy) {
      busy = false
      throw Object.assign(new Error('busy'), { code: 'EAGAIN' })
    }
    const half = Math.max(1, bytes.length >> 1)
    written.push(Buffer.from(bytes.subarray(0, half)).toString())
    return half
  })
  write('héllo')
  assert.equal(written.join(''), 'héllo')

  let calls = 0
  const closed = fdWriter(1, () => {
    calls++
    throw Object.assign(new Error('closed'), { code: 'EPIPE' })
  })
  closed('a')
  closed('b')
  assert.equal(calls, 1)
  assert.throws(() => fdWriter(1, () => { throw new Error('other') })('a'), /other/)
})

test('isEntry: the module node was started with', () => {
  assert.equal(isEntry(pathToFileURL('/x/a.ts').href, '/x/a.ts'), true)
  assert.equal(isEntry(pathToFileURL('/x/a.ts').href, '/x/b.ts'), false)
  assert.equal(isEntry(pathToFileURL('/x/a.ts').href, undefined), false)
})

test('isEntry: a script reached through a symbolic link is its own entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'entry-'))
  try {
    const real = join(dir, 'real.ts')
    const link = join(dir, 'link.ts')
    writeFileSync(real, '')
    symlinkSync(real, link)
    assert.equal(isEntry(pathToFileURL(real).href, link), true)
    assert.equal(isEntry(pathToFileURL(real).href, join(dir, 'other.ts')), false)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('a script run through a symbolic link prints what it prints when run directly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'entry-'))
  try {
    const link = join(dir, 'workspace.ts')
    symlinkSync(fileURLToPath(new URL('../workspace.ts', import.meta.url)), link)
    const direct = await run([node, '--experimental-strip-types', '--no-warnings', fileURLToPath(new URL('../workspace.ts', import.meta.url))], { stderr: 'pipe' })
    const viaLink = await run([node, '--experimental-strip-types', '--no-warnings', link], { stderr: 'pipe' })
    assert.notEqual(viaLink.stdout + viaLink.stderr, '')
    assert.deepEqual(viaLink, direct)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('resolvedPath keeps a path that does not exist, and such a path is no entry', () => {
  const missing = join(tmpdir(), 'entry-missing', 'script.ts')
  assert.equal(resolvedPath(missing), missing)
  assert.equal(isEntry(pathToFileURL(join(tmpdir(), 'entry-missing', 'other.ts')).href, missing), false)
})

test('openLog refuses a link at the log\'s name or for its directory, and leaves what the link points at as it was', () => {
  const dir = mkdtempSync(join(tmpdir(), 'process-'))
  try {
    const target = join(dir, 'target')
    writeFileSync(target, 'protected\n')
    mkdirSync(join(dir, 'logs'))
    symlinkSync(target, join(dir, 'logs', 'a.log'))
    assert.throws(() => openLog(join(dir, 'logs', 'a.log'), true), { code: 'ELOOP' })
    assert.throws(() => openLog(join(dir, 'logs', 'a.log'), false), { code: 'ELOOP' })
    mkdirSync(join(dir, 'real'))
    symlinkSync(join(dir, 'real'), join(dir, 'linked'))
    assert.throws(() => openLog(join(dir, 'linked', 'b.log'), true), /is a link/)
    assert.equal(readFileSync(target, 'utf8'), 'protected\n')
    // A plain name opens, appends and truncates.
    closeSync(openLog(join(dir, 'logs', 'c.log'), true))
    writeFileSync(join(dir, 'logs', 'c.log'), 'old\n')
    closeSync(openLog(join(dir, 'logs', 'c.log'), false))
    assert.equal(readFileSync(join(dir, 'logs', 'c.log'), 'utf8'), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
