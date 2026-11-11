// drift svg against a real browser: the shared Playwright install must be in place (drift.sh
// install). A few SVG files are committed at several refs in a temporary repository, each ref
// changing one of them.
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { main } from './drift.ts'
import { sizeOfPng } from './lib/png.ts'

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

/** A square, its colour in the dark scheme `dark`. */
const DARK = (dark: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" width="8" height="8"><style>rect { fill: #000 } @media (prefers-color-scheme: dark) { rect { fill: ${dark} } }</style><rect width="8" height="8"/></svg>\n`

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
    icon('new.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="7" fill="#0a0"/></svg>\n')
    writeFileSync(join(REPO, 'readme.txt'), 'still not an svg\n')
  })
  commit('external', () => icon('external.svg', readFileSync(join(REPO, 'icons', 'external.svg'), 'utf8').replace('<rect', '<!-- a comment --><rect')))
  commit('broken', () => icon('broken.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2H10V10H2Z">\n'))
  commit('background', () => icon('square.svg', readFileSync(join(REPO, 'icons', 'square.svg'), 'utf8').replace('<path', '<rect width="24" height="24" fill="#fff"/><path')))
  commit('dark-base', () => icon('dark.svg', DARK('#fff')))
  commit('dark', () => icon('dark.svg', DARK('#eee')))
  commit('sized-base', () => {
    icon('sized.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><rect width="24" height="24" fill="#000"/></svg>\n')
    icon('aspect.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="12"><rect width="24" height="24" fill="#000"/></svg>\n')
  })
  commit('resized', () => {
    icon('sized.svg', readFileSync(join(REPO, 'icons', 'sized.svg'), 'utf8').replace('width="24" height="24">', 'width="32" height="32">'))
    icon('aspect.svg', readFileSync(join(REPO, 'icons', 'aspect.svg'), 'utf8').replace('height="12"', 'height="12" preserveAspectRatio="none"'))
  })
  commit('animated-base', () => {
    icon('smil.svg', SQUARE)
    icon('keyframes.svg', SQUARE)
  })
  commit('animated', () => {
    icon('smil.svg', SQUARE.replace('fill="#000"/>', 'fill="#000"><animate attributeName="opacity" from="1" to="0" dur="1s" repeatCount="indefinite"/></path>'))
    icon('keyframes.svg', SQUARE.replace('<path', '<style>@keyframes fade { to { opacity: 0 } } path { animation: fade 1s infinite }</style><path'))
  })
  commit('link-base', () => symlinkSync('square.svg', join(REPO, 'icons', 'link.svg')))
  commit('linked', () => {
    rmSync(join(REPO, 'icons', 'link.svg'))
    symlinkSync('new.svg', join(REPO, 'icons', 'link.svg'))
  })
  commit('refs', () => icon('external.svg', readFileSync(join(REPO, 'icons', 'external.svg'), 'utf8').replace('/x.png', '/y.png')))
  commit('every-kind', () => {
    const url = (name: string): string => external.replace('/x.png', `/${name}`)
    icon('external.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><style>@import url("${url('a.css')}"); @font-face { font-family: F; src: url(${url('f.woff')}) } text { font-family: F }</style><image href="${url('i.png')}" width="8" height="8"/><use href="${url('s.svg')}#x"/><text y="8">x</text><foreignObject width="8" height="8"><img xmlns="http://www.w3.org/1999/xhtml" src="${url('fo.png')}"/></foreignObject><rect width="4" height="4" fill="red"/></svg>\n`)
  })
  commit('renamed', () => {
    mkdirSync(join(REPO, 'renamed'))
    renameSync(join(REPO, 'icons', 'new.svg'), join(REPO, 'renamed', 'new.svg'))
    renameSync(join(REPO, 'icons', 'format.svg'), join(REPO, 'renamed', 'format.svg'))
    writeFileSync(join(REPO, 'renamed', 'format.svg'), readFileSync(join(REPO, 'renamed', 'format.svg'), 'utf8').replace('r="5"', 'r="6"'))
  })
  commit('mode', () => chmodSync(join(REPO, 'icons', 'square.svg'), 0o755))
  commit('odd-base', () => {
    icon('plain.svg', SQUARE)
    icon('percent.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="50%" height="50%"><rect width="10" height="10" fill="#000"/></svg>\n')
  })
  commit('percent', () => icon('percent.svg', readFileSync(join(REPO, 'icons', 'percent.svg'), 'utf8').replace('#000', '#111')))
  commit('no-namespace', () => icon('plain.svg', SQUARE.replace(' xmlns="http://www.w3.org/2000/svg"', '')))
  commit('undecodable', () => {
    icon('plain.svg', SQUARE)
    writeFileSync(join(REPO, 'icons', 'percent.svg'), Buffer.concat([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><!-- '), Buffer.from([0xff, 0xfe]), Buffer.from(' --><rect width="4" height="4"/></svg>\n')]))
  })
})

after(async () => {
  await new Promise<void>(done => (server === undefined ? done() : server.close(() => done())))
  rmSync(ROOT, { recursive: true, force: true })
})

interface Report {
  readonly verdict: string
  readonly differ: number
  readonly files: ReadonlyArray<{ readonly path: string; readonly verdict: string; readonly text?: string; readonly from?: string; readonly why?: string; readonly pairs?: ReadonlyArray<Record<string, unknown>> }>
  readonly external: ReadonlyArray<{ readonly path: string; readonly url: string }>
  readonly blocked: readonly string[]
}

let runs = 0

async function svg(base: string, head: string, extra: readonly string[] = [], dir = join(ROOT, `out-${++runs}`)): Promise<{ code: number; out: string[]; err: string[]; dir: string; report?: Report }> {
  const out: string[] = []
  const err: string[] = []
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
    ['1 transparent identical', '1 white identical', '2 transparent identical', '2 white identical', 'intrinsic transparent identical', 'intrinsic white identical'])
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

test('an SVG image naming resources of every kind makes no request: nothing fetched, nothing for the route to abort', async () => {
  const before = hits
  const { code, out, err, report } = await svg('refs', 'every-kind', ['--scales', '1'])
  assert.equal(code, 1, [...out, ...err].join('\n'))
  assert.equal(report?.external.length, 6)
  assert.deepEqual(report?.blocked, [])
  assert.equal(hits, before)
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

const differing = (out: readonly string[]): string[] => out.filter(line => / px differ /.test(line)).map(line => line.replace(/ in .*$/, ''))

test('a white background added shows on the transparent renderings only: the file differs', async () => {
  const { code, out, err } = await svg('broken', 'background', ['--scales', '1'])
  assert.equal(code, 1, [...out, ...err].join('\n'))
  assert.deepEqual(differing(out), ['icons/square.svg @1x transparent: 504 px differ', 'icons/square.svg @intrinsic transparent: 504 px differ'])
})

test('an SVG reading prefers-color-scheme is rendered light and dark; a change to its dark style differs', async () => {
  const { code, out, err, report } = await svg('dark-base', 'dark', ['--scales', '1'])
  assert.equal(code, 1, [...out, ...err].join('\n'))
  assert.deepEqual(differing(out), ['icons/dark.svg @1x transparent dark: 64 px differ', 'icons/dark.svg @1x white dark: 64 px differ', 'icons/dark.svg @intrinsic transparent dark: 64 px differ', 'icons/dark.svg @intrinsic white dark: 64 px differ'])
  assert.equal(report?.files[0]?.pairs?.length, 8)
})

test('a change of the root size or of its aspect handling differs at the intrinsic size, in a real browser', async () => {
  const { code, out, err } = await svg('sized-base', 'resized', ['--scales', '1'])
  assert.equal(code, 1, [...out, ...err].join('\n'))
  assert.ok(out.includes('icons/sized.svg @intrinsic white: 448 px differ in 0,0,32,32 (size 24x24 → 32x32), diff diff/1-icons-sized.svg@intrinsic-white.png'), out.join('\n'))
  assert.deepEqual(differing(out).filter(line => line.includes('@1x')), [])
  assert.deepEqual(differing(out).filter(line => line.startsWith('icons/aspect.svg')), ['icons/aspect.svg @intrinsic transparent: 144 px differ', 'icons/aspect.svg @intrinsic white: 144 px differ'])
})

test('an animated SVG, by SMIL or by CSS, is unproved: no verdict, exit 2', async () => {
  const { code, out, err, report } = await svg('animated-base', 'animated')
  assert.equal(code, 2, [...out, ...err].join('\n'))
  assert.deepEqual(out.slice(0, 3), ['drift: no verdict, 2 unproved', 'unproved: icons/keyframes.svg — animated', 'unproved: icons/smil.svg — animated'])
  assert.equal(report?.verdict, 'unproved')
})

test('a symbolic link named .svg is unproved, never compared by its target', async () => {
  const { code, out, err } = await svg('link-base', 'linked')
  assert.equal(code, 2, [...out, ...err].join('\n'))
  assert.deepEqual(out.slice(0, 2), ['drift: no verdict, 1 unproved', 'unproved: icons/link.svg — symlink'])
})

test('an external reference whose text changed makes the file differ, though nothing is fetched', async () => {
  const { code, out, err, report } = await svg('linked', 'refs')
  assert.equal(code, 1, [...out, ...err].join('\n'))
  assert.deepEqual(out.slice(0, 2), ['drift: 1 differ', 'icons/external.svg: differ, external reference changed'])
  assert.deepEqual(report?.external.map(ref => ref.url), [external, external.replace('/x.png', '/y.png')])
  assert.equal(hits, 0)
})

test('a pure rename reads identical (renamed); a renamed file also edited is compared under its new name', async () => {
  const { code, out, err, report } = await svg('every-kind', 'renamed', ['--scales', '1'])
  assert.equal(code, 1, [...out, ...err].join('\n'))
  assert.ok(out.includes('renamed/new.svg: identical (renamed from icons/new.svg)'), out.join('\n'))
  assert.ok(differing(out).some(line => line.startsWith('renamed/format.svg @1x white:')), out.join('\n'))
  assert.deepEqual(report?.files.map(file => [file.path, file.from, file.verdict]), [['renamed/format.svg', 'icons/format.svg', 'differ'], ['renamed/new.svg', 'icons/new.svg', 'identical']])
})

test('a change of mode alone reads identical, the text the same', async () => {
  const { code, out, err, report } = await svg('renamed', 'mode')
  assert.equal(code, 0, [...out, ...err].join('\n'))
  assert.deepEqual(out.slice(0, 2), ['drift: identical', 'icons/square.svg: identical'])
  assert.equal(report?.files[0]?.text, 'same')
})

test('a root sized in % falls back to 300x150, named in the report', async () => {
  const { code, out, err, dir } = await svg('odd-base', 'percent', ['--scales', '1'])
  assert.equal(code, 1, [...out, ...err].join('\n'))
  assert.ok(out.includes('fallback: icons/percent.svg 300x150 (width 50%, height 50%)'), out.join('\n'))
  assert.deepEqual(sizeOfPng(readFileSync(join(dir, 'base', '0-icons-percent.svg@1x-white.png'))), { width: 300, height: 150 })
})

test('a root outside the SVG namespace, and a file the browser cannot decode, are tool errors naming it, exit 2', async () => {
  const namespace = await svg('percent', 'no-namespace')
  assert.equal(namespace.code, 2, namespace.out.join('\n'))
  assert.match(namespace.err.join('\n'), /^drift: head: icons\/plain\.svg: not an SVG: its root is <svg>, not <svg> in the SVG namespace/)
  const undecodable = await svg('percent', 'undecodable')
  assert.equal(undecodable.code, 2, undecodable.out.join('\n'))
  assert.match(undecodable.err.join('\n'), /^drift: head: icons\/percent\.svg: not an SVG: the browser does not decode it/)
})

test('--out: a previous svg run is replaced, its report removed before anything is written; another command\'s run is refused, never emptied', async () => {
  const dir = join(ROOT, 'reused')
  assert.equal((await svg('base', 'moved', [], dir)).code, 1)
  const failed = await svg('external', 'broken', [], dir)
  assert.equal(failed.code, 2)
  assert.equal(existsSync(join(dir, 'report.json')), false)
  assert.equal(existsSync(join(dir, 'report.txt')), false)
  const other = join(ROOT, 'other')
  mkdirSync(join(other, 'base'), { recursive: true })
  writeFileSync(join(other, 'base', 'root@390.png'), 'kept')
  writeFileSync(join(other, 'report.json'), JSON.stringify({ version: 1, verdict: 'identical', pairs: [], threshold: 0 }))
  const refused = await svg('base', 'moved', [], other)
  assert.equal(refused.code, 2)
  assert.match(refused.err.join('\n'), /holds another command's run/)
  assert.equal(readFileSync(join(other, 'base', 'root@390.png'), 'utf8'), 'kept')
})
