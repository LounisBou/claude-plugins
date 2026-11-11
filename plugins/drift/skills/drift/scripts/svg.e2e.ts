// drift svg against a real browser: the shared Playwright install must be in place (drift.sh
// install). A few SVG files are committed at several refs in a temporary repository, each ref
// changing one of them.
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { main } from './drift.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'drift-svg-'))
const REPO = join(ROOT, 'repo')
const sha: Record<string, string> = {}
let hits = 0
let server: Server | undefined
let external = ''

const git = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=drift', '-c', 'user.email=drift@example.com', '-c', 'commit.gpgsign=false', '-C', REPO, ...args], { encoding: 'utf8' }).trim()

const icon = (name: string, text: string): void => writeFileSync(join(REPO, 'icons', name), text)

function commit(name: string, change: () => void): void {
  change()
  git('add', '-A')
  git('commit', '-q', '-m', name)
  sha[name] = git('rev-parse', 'HEAD')
}

const SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path d="M2 2H10V10H2Z" fill="#000"/></svg>\n'

before(async () => {
  server = createServer((_request, response) => {
    hits++
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>(done => server?.listen(0, '127.0.0.1', done))
  const address = server.address()
  external = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/x.png`
  mkdirSync(join(REPO, 'icons'), { recursive: true })
  git('init', '-q', '-b', 'main')
  commit('base', () => {
    icon('square.svg', SQUARE)
    icon('format.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="#336699" stroke="#000" stroke-width="1"/></svg>\n')
    icon('gone.svg', SQUARE)
    icon('external.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><image href="${external}" width="8" height="8"/><rect width="4" height="4" fill="red"/></svg>\n`)
    icon('broken.svg', SQUARE)
    writeFileSync(join(REPO, 'readme.txt'), 'not an svg\n')
  })
  commit('moved', () => icon('square.svg', SQUARE.replace('H10V10', 'H11V10')))
  commit('reformatted', () => icon('format.svg', [
    '<svg viewBox="0 0 16 16"',
    '     xmlns="http://www.w3.org/2000/svg">',
    '  <circle stroke-width="1" stroke="#000" fill="#336699" r="5" cy="8" cx="8" />',
    '</svg>',
    '',
  ].join('\n')))
  commit('churn', () => {
    rmSync(join(REPO, 'icons', 'gone.svg'))
    icon('new.svg', SQUARE)
    writeFileSync(join(REPO, 'readme.txt'), 'still not an svg\n')
  })
  commit('external', () => icon('external.svg', readFileSync(join(REPO, 'icons', 'external.svg'), 'utf8').replace('<rect', '<!-- a comment --><rect')))
  commit('broken', () => icon('broken.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2H10V10H2Z">\n'))
})

after(async () => {
  await new Promise<void>(done => (server === undefined ? done() : server.close(() => done())))
  rmSync(ROOT, { recursive: true, force: true })
})

interface Report {
  readonly verdict: string
  readonly differ: number
  readonly files: ReadonlyArray<{ readonly path: string; readonly verdict: string; readonly text?: string; readonly pairs?: ReadonlyArray<Record<string, unknown>> }>
  readonly external: ReadonlyArray<{ readonly path: string; readonly url: string }>
  readonly blocked: readonly string[]
}

let runs = 0

async function svg(base: string, head: string, extra: readonly string[] = []): Promise<{ code: number; out: string[]; err: string[]; dir: string; report?: Report }> {
  const out: string[] = []
  const err: string[] = []
  const dir = join(ROOT, `out-${++runs}`)
  const code = await main(['svg', '--repo', REPO, '--out', dir, '--base', sha[base] ?? '', '--head', sha[head] ?? '', ...extra], {
    tmp: ROOT, home: process.env['HOME'] ?? ROOT, env: process.env, out: line => out.push(line), err: line => err.push(line),
  })
  const reportPath = join(dir, 'report.json')
  return { code, out, err, dir, ...(existsSync(reportPath) ? { report: JSON.parse(readFileSync(reportPath, 'utf8')) as Report } : {}) }
}

test('an SVG changed by one path coordinate is found with its box at each scale and on each background, exit 1', async () => {
  const { code, out, err, dir, report } = await svg('base', 'moved')
  assert.equal(code, 1, [...out, ...err].join('\n'))
  assert.deepEqual(out.slice(0, 5), [
    'drift: 1 differ',
    'icons/square.svg @1x transparent: 8 px differ in 10,2,1,8, diff diff/0-icons-square.svg@1x-transparent.png',
    'icons/square.svg @1x white: 8 px differ in 10,2,1,8, diff diff/0-icons-square.svg@1x-white.png',
    'icons/square.svg @4x transparent: 128 px differ in 40,8,4,32, diff diff/0-icons-square.svg@4x-transparent.png',
    'icons/square.svg @4x white: 128 px differ in 40,8,4,32, diff diff/0-icons-square.svg@4x-white.png',
  ])
  assert.equal(report?.files[0]?.verdict, 'differ')
  assert.ok(existsSync(join(dir, 'diff', '0-icons-square.svg@4x-white.png')))
})

test('an SVG only reformatted, its attributes reordered, reads identical (text differs), exit 0', async () => {
  const { code, out, err, report } = await svg('moved', 'reformatted', ['--scales', '1,2'])
  assert.equal(code, 0, [...out, ...err].join('\n'))
  assert.deepEqual(out.slice(0, 2), ['drift: identical', 'icons/format.svg: identical (text differs)'])
  assert.deepEqual(report?.files[0]?.pairs?.map(pair => `${String(pair['scale'])} ${String(pair['background'])} ${String(pair['verdict'])}`),
    ['1 transparent identical', '1 white identical', '2 transparent identical', '2 white identical'])
})

test('an SVG added and one removed are listed, not rendered, and differ', async () => {
  const { code, out, err, report } = await svg('reformatted', 'churn')
  assert.equal(code, 1, [...out, ...err].join('\n'))
  assert.deepEqual(out.slice(0, 3), ['drift: 2 differ', 'removed icons/gone.svg', 'added icons/new.svg'])
  assert.deepEqual(report?.files, [{ path: 'icons/gone.svg', verdict: 'removed' }, { path: 'icons/new.svg', verdict: 'added' }])
})

test('an SVG referencing an external resource is listed and never fetched', async () => {
  const { code, out, err, report } = await svg('churn', 'external')
  assert.equal(code, 0, [...out, ...err].join('\n'))
  assert.ok(out.includes('icons/external.svg: identical (text differs)'))
  assert.ok(out.includes(`external: icons/external.svg ${external}`))
  assert.deepEqual(report?.external, [{ path: 'icons/external.svg', url: external }])
  assert.equal(hits, 0)
})

test('a malformed SVG is a tool error naming the file, exit 2, never identical', async () => {
  const { code, out, err, report } = await svg('external', 'broken')
  assert.equal(code, 2, out.join('\n'))
  assert.match(err.join('\n'), /^drift: head: icons\/broken\.svg: not an SVG: /)
  assert.equal(report, undefined)
})

test('the same refs give the same report', async () => {
  const first = await svg('base', 'external')
  const second = await svg('base', 'external')
  assert.equal(first.code, 1)
  assert.equal(readFileSync(join(first.dir, 'report.json'), 'utf8'), readFileSync(join(second.dir, 'report.json'), 'utf8'))
})
