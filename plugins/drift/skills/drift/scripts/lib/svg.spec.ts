import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DriftError } from './compare.ts'
import { changesOf, checkRendered, externalRefs, isAnimated, rendersOf, renderSvg, schemesOf, type Item, type SvgReport } from './svg.ts'

const refused = (pattern: RegExp) => (error: unknown): boolean => error instanceof DriftError && pattern.test(error.message)

const Z = '0000000000000000000000000000000000000000'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const raw = (...records: Array<[string, string, string, string, string, ...string[]]>): string =>
  records.map(([baseMode, headMode, baseSha, headSha, status, ...paths]) => `:${baseMode} ${headMode} ${baseSha} ${headSha} ${status}\0${paths.join('\0')}\0`).join('')

test('the changed SVG files of a raw diff, sorted: changed, added, removed, renamed; a link or a submodule unproved; other files left out', () => {
  const listed = changesOf(raw(
    ['100644', '100644', A, B, 'M', 'icons/z.svg'],
    ['000000', '100644', Z, B, 'A', 'icons/new.SVG'],
    ['100644', '000000', A, Z, 'D', 'icons/gone.svg'],
    ['100644', '100755', A, A, 'M', 'icons/mode.svg'],
    ['100644', '120000', A, B, 'T', 'icons/link.svg'],
    ['120000', '120000', A, B, 'M', 'icons/both-links.svg'],
    ['160000', '160000', A, B, 'M', 'icons/module.svg'],
    ['100644', '100644', A, A, 'R100', 'old/same.svg', 'icons/same.svg'],
    ['100644', '100644', A, B, 'R087', 'old/edited.svg', 'icons/edited.svg'],
    ['100644', '100644', A, A, 'R100', 'old/was.png.txt', 'icons/now.svg'],
    ['100644', '100644', A, A, 'R100', 'old/left.svg', 'icons/left.txt'],
    ['100644', '100644', A, B, 'M', 'src/app.ts'],
    ['100644', '100644', A, B, 'M', 'weird name\twith tab.svg'],
  ))
  assert.deepEqual(listed, [
    { path: 'icons/both-links.svg', status: 'unproved', why: 'symlink' },
    { path: 'icons/edited.svg', status: 'changed', from: 'old/edited.svg', base: A, head: B },
    { path: 'icons/gone.svg', status: 'removed', base: A },
    { path: 'icons/link.svg', status: 'unproved', why: 'symlink' },
    { path: 'icons/mode.svg', status: 'changed', base: A, head: A },
    { path: 'icons/module.svg', status: 'unproved', why: 'submodule' },
    { path: 'icons/new.SVG', status: 'added', head: B },
    { path: 'icons/now.svg', status: 'added', head: A },
    { path: 'icons/same.svg', status: 'changed', from: 'old/same.svg', base: A, head: A },
    { path: 'icons/z.svg', status: 'changed', base: A, head: B },
    { path: 'old/left.svg', status: 'removed', base: A },
    { path: 'weird name\twith tab.svg', status: 'changed', base: A, head: B },
  ])
  assert.deepEqual(changesOf(''), [])
  assert.throws(() => changesOf('garbage\0'), refused(/unreadable git diff/))
})

test('an animation, SMIL or CSS, is found; a colour-scheme preference renders light and dark', () => {
  for (const text of ['<animate attributeName="x"/>', '<svg:animateTransform/>', '<animateMotion/>', '<set to="1"/>', '@keyframes spin {}', 'path { animation: spin 1s }', 'path { animation-name: spin }']) assert.equal(isAnimated(text), true, text)
  for (const text of ['<settings/>', '<path d="M0 0"/>', '<rect class="animation"/>']) assert.equal(isAnimated(text), false, text)
  assert.deepEqual(schemesOf('@media (prefers-color-scheme: dark) {}'), ['light', 'dark'])
  assert.deepEqual(schemesOf('<path/>'), ['light'])
})

test('the renderings of a file: each scale then the intrinsic size, each scheme, each background, named apart', () => {
  assert.deepEqual(rendersOf('0-a.svg', [1], ['light']).map(render => render.png), ['0-a.svg@1x-transparent.png', '0-a.svg@1x-white.png', '0-a.svg@intrinsic-transparent.png', '0-a.svg@intrinsic-white.png'])
  const dark = rendersOf('0-a.svg', [2], ['light', 'dark'])
  assert.equal(dark.length, 8)
  assert.deepEqual(dark[3], { png: '0-a.svg@2x-white-dark.png', scale: 2, background: 'white', scheme: 'dark' })
  assert.equal(new Set(dark.map(render => render.png)).size, 8)
})

test('a rendering run that failed, or left a rendering out, is a tool error; a file\'s own error is named first', () => {
  const out = mkdtempSync(join(tmpdir(), 'drift-svg-spec-'))
  try {
    const renders = rendersOf('0-a.svg', [1], ['light'])
    const items: Item[] = [{ side: 'head', name: '0-a.svg', path: 'a.svg', file: join(out, 'a.svg'), out, renders }]
    assert.throws(() => checkRendered(items, 1, '/log'), refused(/^the rendering failed \(exit 1\); its log: \/log$/))
    for (const render of renders) writeFileSync(join(out, render.png), '')
    assert.throws(() => checkRendered(items, null, '/log'), refused(/^the rendering failed \(exit none\)/))
    checkRendered(items, 0, '/log')
    rmSync(join(out, renders[0]?.png ?? ''))
    assert.throws(() => checkRendered(items, 0, '/log'), refused(/^the rendering failed \(exit 0\)/))
    writeFileSync(join(out, '0-a.svg.error.txt'), 'not an SVG: x\n')
    assert.throws(() => checkRendered(items, 1, '/log'), refused(/^head: a\.svg: not an SVG: x$/))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('the external references of an SVG text: href, xlink:href, src, url() and @import outside the file; fragments and data: URLs are not', () => {
  const text = [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
    '<style>@import url("https://fonts.example.com/a.css"); @import \'b.css\'; .x { fill: url(#grad) } .y { background: url( https://cdn.example.com/bg.png ) }</style>',
    '<use href="#icon"/><use xlink:href=\'sprite.svg#x\'/><image href="https://img.example.com/p.png"/>',
    '<image xlink:href="data:image/png;base64,AAAA"/><script src="//evil.example.com/s.js"/>',
    '<image href="https://img.example.com/p.png"/>',
    '</svg>',
  ].join('')
  assert.deepEqual(externalRefs(text), ['//evil.example.com/s.js', 'b.css', 'https://cdn.example.com/bg.png', 'https://fonts.example.com/a.css', 'https://img.example.com/p.png', 'sprite.svg#x'])
  assert.deepEqual(externalRefs('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'), [])
})

const REPORT: SvgReport = {
  version: 1,
  verdict: 'unproved',
  differ: 4,
  unproved: 1,
  scales: [1, 4],
  base: { ref: 'origin/main', sha: '1111111aaaa' },
  head: { ref: 'HEAD', sha: '2222222bbbb' },
  files: [
    { path: 'a.svg', verdict: 'added' },
    { path: 'b.svg', verdict: 'identical', text: 'differs' },
    { path: 'c.svg', verdict: 'identical', text: 'same' },
    {
      path: 'd.svg', verdict: 'differ', text: 'differs', pairs: [
        { scale: 1, background: 'transparent', verdict: 'identical' },
        { scale: 4, background: 'white', verdict: 'differ', pixels: 12, box: { x: 4, y: 5, width: 6, height: 2 }, size: { base: [96, 96], head: [96, 100] }, diff: 'diff/3-d.svg@4x-white.png' },
        { scale: 'intrinsic', background: 'transparent', scheme: 'dark', verdict: 'differ', pixels: 1, box: { x: 0, y: 0, width: 1, height: 1 }, diff: 'diff/3-d.svg@intrinsic-transparent-dark.png' },
      ],
    },
    { path: 'e.svg', verdict: 'removed' },
    { path: 'f.svg', verdict: 'unproved', why: 'symlink' },
    { path: 'g.svg', verdict: 'identical', from: 'old/g.svg', text: 'same' },
    { path: 'h.svg', verdict: 'identical', from: 'old/h.svg', text: 'differs' },
    { path: 'i.svg', verdict: 'differ', text: 'differs', external: 'changed', fallback: 'width 50%, height 2em', pairs: [] },
  ],
  external: [{ path: 'b.svg', url: 'https://cdn.example.com/x.png' }],
  blocked: ['https://cdn.example.com/x.png'],
}

test('the text report: the verdict, one line per file and per differing rendering, what was left out, the refs', () => {
  assert.deepEqual(renderSvg(REPORT), [
    'drift: no verdict, 1 unproved',
    'added a.svg',
    'b.svg: identical (text differs)',
    'c.svg: identical',
    'd.svg @4x white: 12 px differ in 4,5,6,2 (size 96x96 → 96x100), diff diff/3-d.svg@4x-white.png',
    'd.svg @intrinsic transparent dark: 1 px differ in 0,0,1,1, diff diff/3-d.svg@intrinsic-transparent-dark.png',
    'removed e.svg',
    'unproved: f.svg — symlink',
    'g.svg: identical (renamed from old/g.svg)',
    'h.svg: identical (text differs, renamed from old/h.svg)',
    'i.svg: differ, external reference changed',
    'fallback: i.svg 300x150 (width 50%, height 2em)',
    'external: b.svg https://cdn.example.com/x.png',
    'blocked: https://cdn.example.com/x.png',
    'base 1111111 (origin/main), head 2222222 (HEAD)',
  ])
  assert.equal(renderSvg({ ...REPORT, verdict: 'differ', unproved: 0 })[0], 'drift: 4 differ')
  assert.deepEqual(renderSvg({ ...REPORT, verdict: 'identical', differ: 0, unproved: 0, files: [], external: [], blocked: [] }), [
    'drift: identical', 'no SVG file changed', 'base 1111111 (origin/main), head 2222222 (HEAD)',
  ])
})
