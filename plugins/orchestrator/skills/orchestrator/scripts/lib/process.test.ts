import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { fdWriter, isEntry, run } from './process.ts'

const node = process.execPath

test('run collects stdout and the exit status, without a shell', async () => {
  assert.deepEqual(await run([node, '-e', 'process.stdout.write("a $HOME;"); process.exit(3)']), { status: 3, stdout: 'a $HOME;' })
  assert.deepEqual(await run([node, '-e', 'process.stdout.write(process.cwd())'], { cwd: '/' }), { status: 0, stdout: '/' })
})

test('run: a command that cannot start has no status', async () => {
  assert.deepEqual(await run(['/no/such/command']), { status: null, stdout: '' })
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
