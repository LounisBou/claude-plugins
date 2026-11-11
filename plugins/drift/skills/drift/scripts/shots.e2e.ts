// drift shots against a real browser: the shared Playwright install must be in place (drift.sh
// install). A fixture app (tests/shots-fixture: a static page served by a tiny server) is committed
// at a few refs in a temporary repository, its API answered from tests/shots-api.
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { main } from './drift.ts'
import { decodePng } from './lib/png.ts'
import { portTaken } from './lib/server.ts'

const TESTS = fileURLToPath(new URL('../../../tests', import.meta.url))
const ROOT = mkdtempSync(join(tmpdir(), 'drift-shots-'))
const REPO = join(ROOT, 'repo')
const PID_FILE = join(ROOT, 'server.pid')
const sha: Record<string, string> = {}
let port = 0

const git = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=drift', '-c', 'user.email=drift@example.com', '-c', 'commit.gpgsign=false', '-C', REPO, ...args], { encoding: 'utf8' }).trim()

function commit(name: string, change: () => void): void {
  change()
  git('add', '-A')
  git('commit', '-q', '-m', name)
  sha[name] = git('rev-parse', 'HEAD')
}

function freePort(): Promise<number> {
  return new Promise(done => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => done(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

before(async () => {
  port = await freePort()
  cpSync(join(TESTS, 'shots-fixture'), REPO, { recursive: true })
  git('init', '-q', '-b', 'main')
  commit('base', () => undefined)
  commit('dot', () => {
    const page = join(REPO, 'public', 'index.html')
    writeFileSync(page, readFileSync(page, 'utf8').replace('background: #336699', 'background: #336698'))
  })
  const column = join(REPO, 'public', 'column.html')
  commit('column', () => writeFileSync(column, readFileSync(column, 'utf8').replace('rgb(128, 128, 128)', 'rgb(100, 100, 100)')))
  commit('taller', () => writeFileSync(column, readFileSync(column, 'utf8').replace('body { margin: 0;', 'body { margin: 0; min-height: 1200px;')))
})

after(() => rmSync(ROOT, { recursive: true, force: true }))

function config(name: string, shots: Record<string, unknown>): string {
  const path = join(ROOT, `${name}.json`)
  writeFileSync(path, JSON.stringify({
    env: { FIXTURE_PID_FILE: PID_FILE },
    shots: { server: ['node', 'server.mjs', String(port)], port, url: `http://127.0.0.1:${port}`, fixtures: join(TESTS, 'shots-api'), api: ['api.fixture.test'], ...shots },
  }))
  return path
}

interface Report {
  readonly verdict: string
  readonly pairs: ReadonlyArray<{ readonly verdict: string; readonly pixels?: number; readonly box?: unknown; readonly size?: unknown; readonly diff?: string }>
  readonly blocked: readonly string[]
  readonly unmocked: readonly string[]
}

let runs = 0

async function shots(configPath: string, base: string, head: string, extra: readonly string[] = []): Promise<{ code: number; out: string[]; err: string[]; dir: string; work: string; report?: Report }> {
  const out: string[] = []
  const err: string[] = []
  const work = join(ROOT, `tmp-${++runs}`)
  mkdirSync(work)
  const dir = join(ROOT, `out-${runs}`)
  const code = await main(['shots', '--repo', REPO, '--out', dir, '--config', configPath, '--base', sha[base] ?? '', '--head', sha[head] ?? '', ...extra], {
    tmp: work, home: process.env['HOME'] ?? ROOT, env: process.env, out: line => out.push(line), err: line => err.push(line),
  })
  const reportPath = join(dir, 'report.json')
  return { code, out, err, dir, work, ...(existsSync(reportPath) ? { report: JSON.parse(readFileSync(reportPath, 'utf8')) as Report } : {}) }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('an unchanged page reads identical on three runs in a row, the same report each time; a blocked host and a missing fixture are listed', async () => {
  const path = config('same', { routes: ['/', '/missing.html'] })
  const reports: string[] = []
  for (let k = 0; k < 3; k++) {
    const { code, out, err, dir, report, work } = await shots(path, 'base', 'base')
    assert.equal(code, 0, [...out, ...err].join("\n"))
    assert.equal(out[0], 'drift: identical')
    assert.deepEqual(out.slice(1, 5), ['/ @1440: identical', '/ @390: identical', '/missing.html @1440: identical', '/missing.html @390: identical'])
    assert.deepEqual(report?.blocked, ['https://tiles.blocked.test/tile.png'])
    assert.deepEqual(report?.unmocked, ['GET https://api.fixture.test/v1/absent'])
    assert.ok(out.includes('blocked: https://tiles.blocked.test/tile.png'))
    assert.ok(out.includes('unmocked: GET https://api.fixture.test/v1/absent'))
    reports.push(readFileSync(join(dir, 'report.json'), 'utf8'))
    assert.deepEqual(readdirSync(work), [])
  }
  assert.equal(new Set(reports).size, 1)
})

test('a one-pixel colour change is found with its box and a diff image, exit 1', async () => {
  const { code, out, dir, report } = await shots(config('dot', { routes: ['/'] }), 'base', 'dot')
  assert.equal(code, 1, out.join('\n'))
  assert.equal(out[0], 'drift: 2 differ')
  assert.deepEqual(out.slice(1, 3), ['/ @1440: 1 px differ in 10,20,1,1, diff diff/root@1440.png', '/ @390: 1 px differ in 10,20,1,1, diff diff/root@390.png'])
  assert.deepEqual(report?.pairs[0], { route: '/', width: 1440, verdict: 'differ', pixels: 1, box: { x: 10, y: 20, width: 1, height: 1 }, diff: 'diff/root@1440.png' })
  assert.ok(existsSync(join(dir, 'diff', 'root@1440.png')))
  assert.equal((await shots(config('dot-masked', { routes: ['/'], ignore: [{ selector: '#dot' }] }), 'base', 'dot')).code, 0)
})

test('a page that never gets ready is a tool error, its server stopped, its port freed, no checkout left', async () => {
  const { code, err, work } = await shots(config('stuck', { routes: [{ path: '/', waitFor: '#never' }], timeout: 1 }), 'base', 'base')
  assert.equal(code, 2)
  assert.match(err.join('\n'), /base: root@1440 could not be captured: .*; its log: /)
  const pid = Number(readFileSync(PID_FILE, 'utf8'))
  assert.equal(alive(pid), false)
  assert.equal(await portTaken('127.0.0.1', port), false)
  assert.deepEqual(readdirSync(work), [])
  assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1)
})

/**
 * A server of the test's own on another port, counting the requests it gets. Its port is drawn
 * until it sorts, as text, before or after the fixture server's: the report lists URLs as text.
 */
async function sideServer(order: 'before' | 'after'): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
  let hits = 0
  const server = createHttpServer((_request, response) => {
    hits++
    response.writeHead(404)
    response.end()
  })
  let sidePort = await freePort()
  while ((String(sidePort) < String(port)) !== (order === 'before')) sidePort = await freePort()
  await new Promise<void>(done => server.listen(sidePort, '127.0.0.1', done))
  return { port: sidePort, hits: () => hits, close: () => new Promise(done => server.close(() => done())) }
}

for (const order of ['before', 'after'] as const) {
test(`nothing leaves the page unrouted, the other port sorting ${order} the server's: a redirect, a chain without end, another port of an allowed host, a WebSocket are blocked and listed; a malformed path answers 400`, async () => {
  const side = await sideServer(order)
  try {
    const route = `/guard.html?port=${side.port}`
    const blocking = await shots(config('guard', { routes: [route], viewports: [390], allow: ['127.0.0.1'] }), 'base', 'base')
    assert.equal(blocking.code, 0, [...blocking.out, ...blocking.err].join('\n'))
    const blocked = [`http://127.0.0.1:${port}/loop`, `http://127.0.0.1:${side.port}/pixel.png`, `http://127.0.0.1:${side.port}/popup.html`, 'https://hop.blocked.test/landing.png', 'https://relay.blocked.test/end.png', 'wss://socket.blocked.test/live']
    assert.deepEqual(blocking.report?.blocked, blocked.sort())
    assert.equal(side.hits(), 0)
    const allowing = await shots(config('guard-allowed', { routes: [route], viewports: [390], allow: [`127.0.0.1:${side.port}`] }), 'base', 'base')
    assert.equal(allowing.code, 0, [...allowing.out, ...allowing.err].join('\n'))
    assert.deepEqual(allowing.report?.blocked, [`http://127.0.0.1:${port}/loop`, 'https://hop.blocked.test/landing.png', 'https://relay.blocked.test/end.png', 'wss://socket.blocked.test/live'].sort())
    assert.equal(side.hits(), 4)
  } finally {
    await side.close()
  }
})
}

test('a route answering an error status is a tool error on its side, never identical', async () => {
  const { code, err, report } = await shots(config('absent', { routes: ['/absent.html'], viewports: [390] }), 'base', 'base')
  assert.equal(code, 2)
  assert.match(err.join('\n'), /base: absent\.html@390 could not be captured: \/absent\.html answered 404/)
  assert.equal(report, undefined)
})

test('at threshold 0 a one-pixel-wide grey column a shade darker is found, every pixel of it', async () => {
  const { code, out, report } = await shots(config('column', { routes: ['/column.html'], viewports: [390] }), 'base', 'column')
  assert.equal(code, 1, out.join('\n'))
  assert.deepEqual(report?.pairs[0], { route: '/column.html', width: 390, verdict: 'differ', pixels: 30, box: { x: 50, y: 10, width: 1, height: 30 }, diff: 'diff/column.html@390.png' })
})

test('a page that changes size reads both sizes', async () => {
  const { code, out, report } = await shots(config('taller', { routes: ['/column.html'], viewports: [390] }), 'column', 'taller')
  assert.equal(code, 1, out.join('\n'))
  assert.deepEqual(report?.pairs[0]?.size, { base: [390, 900], head: [390, 1200] })
  assert.equal(out[1], '/column.html @390: 117000 px differ in 0,900,390,300 (size 390x900 → 390x1200), diff diff/column.html@390.png')
})

test('a threshold above 0 forgives a colour change within it, and the report says what it may not count', async () => {
  const { code, out } = await shots(config('dot-threshold', { routes: ['/'], viewports: [390] }), 'base', 'dot', ['--threshold', '0.1'])
  assert.equal(code, 0, out.join('\n'))
  assert.ok(out.includes('threshold 0.1: colour differences within it and pixels taken for anti-aliasing are not counted'))
})

test('a box ignored on a route masks the change inside it', async () => {
  const { code, out } = await shots(config('dot-box', { routes: ['/'], viewports: [390], ignore: [{ route: '/', box: [8, 18, 5, 5] }] }), 'base', 'dot')
  assert.equal(code, 0, out.join('\n'))
})

test('the page\'s animations are stopped by the capture\'s own style before it is taken', async () => {
  const { code, dir } = await shots(config('still', { routes: ['/still.html'], viewports: [390] }), 'base', 'base')
  assert.equal(code, 0)
  const { width, data } = decodePng(readFileSync(join(dir, 'base', 'still.html@390.png')))
  const at = (21 * width + 31) * 4
  assert.deepEqual([...data.subarray(at, at + 3)], [0, 255, 0])
})
