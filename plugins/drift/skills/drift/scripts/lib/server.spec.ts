import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DriftError } from './compare.ts'
import { portTaken, startServer } from './server.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'drift-server-'))
after(() => rmSync(ROOT, { recursive: true, force: true }))

function freePort(): Promise<number> {
  return new Promise(done => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => done(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A server that starts a child of its own, writes that child's pid, then listens on `port` after `delayMs`. */
const serverScript = (port: number, pidFile: string, delayMs = 0): string[] => ['node', '-e', `
  const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 60000)'], { stdio: 'ignore' })
  require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))
  setTimeout(() => require('node:http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1'), ${delayMs})
`]

const spec = (argv: readonly string[], port: number, startTimeoutMs = 20_000) =>
  ({ argv, cwd: ROOT, env: { DRIFT_X: '1' }, port, url: `http://127.0.0.1:${port}`, startTimeoutMs, log: join(ROOT, `server-${port}.log`) })

test('a server is waited for until it answers, then stopped with every process it started, its port freed', async () => {
  const port = await freePort()
  const pidFile = join(ROOT, 'child.pid')
  const server = await startServer(spec(serverScript(port, pidFile, 300), port), undefined)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ok')
  const grandchild = Number(readFileSync(pidFile, 'utf8'))
  await server.stop()
  assert.equal(alive(server.pid), false)
  assert.equal(alive(grandchild), false)
  assert.equal(await portTaken('127.0.0.1', port), false)
})

test('a port already in use is refused before anything starts', async () => {
  const port = await freePort()
  const busy = createServer().listen(port, '127.0.0.1')
  await new Promise(done => busy.once('listening', done))
  try {
    const marker = join(ROOT, 'never.pid')
    await assert.rejects(startServer(spec(serverScript(port, marker), port), undefined), (e: unknown) => e instanceof DriftError && new RegExp(`port ${port} is in use`).test(e.message))
    assert.equal(existsSync(marker), false)
  } finally {
    busy.close()
  }
})

test('a server that exits before answering, or never answers in time, is a tool error, nothing left running', async () => {
  const port = await freePort()
  await assert.rejects(startServer(spec(['node', '-e', 'console.log("boom"); process.exit(3)'], port), undefined), /the server stopped before answering \(exit 3\); its log: /)
  assert.match(readFileSync(join(ROOT, `server-${port}.log`), 'utf8'), /boom/)
  const pidFile = join(ROOT, 'slow.pid')
  await assert.rejects(startServer(spec(serverScript(port, pidFile, 60_000), port, 800), undefined), /did not answer at .* within 0\.8 s/)
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false)
  await assert.rejects(startServer(spec(['/no/such/command'], port), undefined), /the server stopped before answering/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(startServer(spec(serverScript(port, join(ROOT, 'aborted.pid'), 60_000), port), controller.signal), /interrupted/)
})
