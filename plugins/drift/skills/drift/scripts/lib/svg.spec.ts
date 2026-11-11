import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { DriftError } from './compare.ts'
import { encodePng, type Image } from './png.ts'
import { changesOf, comparePair, externalRefs, parseSvgArgs, renderSvg, type SvgReport } from './svg.ts'

const refused = (pattern: RegExp) => (error: unknown): boolean => error instanceof DriftError && pattern.test(error.message)

test('the svg command line: the refs and --out as the other commands, scales 1 and 4 by default, no config', () => {
  assert.deepEqual(parseSvgArgs(['svg']), { repo: '.', base: 'origin/main', head: 'HEAD', config: undefined, out: undefined, scales: [1, 4] })
  assert.deepEqual(parseSvgArgs(['svg', '--repo', 'r', '--base', 'b', '--head', 'h', '--out', 'o', '--scales', '2,0.5,2']),
    { repo: 'r', base: 'b', head: 'h', config: undefined, out: 'o', scales: [0.5, 2] })
  for (const bad of ['0', '-1', 'x', '1,,2', '17', '']) assert.throws(() => parseSvgArgs(['svg', '--scales', bad]), refused(/--scales (needs a value|must be)/))
  assert.throws(() => parseSvgArgs(['svg', '--config', 'c.json']), refused(/drift svg reads no config/))
  assert.throws(() => parseSvgArgs(['svg', '--threshold', '0.1']), refused(/unknown option --threshold/))
  assert.throws(() => parseSvgArgs(['build']), refused(/^usage/))
})

const Z = '0000000000000000000000000000000000000000'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const raw = (...records: Array<[string, string, string, string, string, string]>): string =>
  records.map(([baseMode, headMode, baseSha, headSha, status, path]) => `:${baseMode} ${headMode} ${baseSha} ${headSha} ${status}\0${path}\0`).join('')

test('the changed SVG files of a raw diff, sorted: changed, added, removed; a link or a submodule skipped; other files left out', () => {
  const listed = changesOf(raw(
    ['100644', '100644', A, B, 'M', 'icons/z.svg'],
    ['000000', '100644', Z, B, 'A', 'icons/new.SVG'],
    ['100644', '000000', A, Z, 'D', 'icons/gone.svg'],
    ['100644', '100755', A, A, 'M', 'icons/mode.svg'],
    ['100644', '120000', A, B, 'T', 'icons/link.svg'],
    ['120000', '120000', A, B, 'M', 'icons/both-links.svg'],
    ['100644', '100644', A, B, 'M', 'src/app.ts'],
    ['100644', '100644', A, B, 'M', 'weird name\twith tab.svg'],
  ))
  assert.deepEqual(listed.changes, [
    { path: 'icons/gone.svg', status: 'removed', base: A },
    { path: 'icons/mode.svg', status: 'changed', base: A, head: A },
    { path: 'icons/new.SVG', status: 'added', head: B },
    { path: 'icons/z.svg', status: 'changed', base: A, head: B },
    { path: 'weird name\twith tab.svg', status: 'changed', base: A, head: B },
  ])
  assert.deepEqual(listed.skipped, ['icons/both-links.svg', 'icons/link.svg'])
  assert.deepEqual(changesOf(''), { changes: [], skipped: [] })
  assert.throws(() => changesOf('garbage\0'), refused(/unreadable git diff/))
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

const image = (width: number, height: number, paint: (x: number, y: number) => number): Image => {
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.writeUInt32BE(paint(x, y) >>> 0, (y * width + x) * 4)
  return { width, height, data }
}

test('a pair of renderings: identical when every byte matches, else the differing pixels, their box and a diff image; a size change differs even when no pixel does', () => {
  const blank = encodePng(image(4, 3, () => 0))
  assert.deepEqual(comparePair(blank, blank), { verdict: 'identical' })
  const dot = encodePng(image(4, 3, (x, y) => (x === 2 && y === 1 ? 0x000000ff : 0)))
  const found = comparePair(blank, dot)
  assert.ok(found.verdict === 'differ')
  assert.equal(found.pixels, 1)
  assert.deepEqual(found.box, { x: 2, y: 1, width: 1, height: 1 })
  assert.equal(found.size, undefined)
  assert.ok(found.image.length > 0)
  const wider = comparePair(blank, encodePng(image(5, 3, () => 0)))
  assert.ok(wider.verdict === 'differ')
  assert.deepEqual(wider.size, { base: [4, 3], head: [5, 3] })
})

const REPORT: SvgReport = {
  version: 1,
  verdict: 'differ',
  differ: 3,
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
      ],
    },
    { path: 'e.svg', verdict: 'removed' },
  ],
  external: [{ path: 'b.svg', url: 'https://cdn.example.com/x.png' }],
  skipped: ['f.svg'],
  blocked: ['https://cdn.example.com/x.png'],
}

test('the text report: the verdict, one line per file and per differing rendering, what was left out, the refs', () => {
  assert.deepEqual(renderSvg(REPORT), [
    'drift: 3 differ',
    'added a.svg',
    'b.svg: identical (text differs)',
    'c.svg: identical',
    'd.svg @4x white: 12 px differ in 4,5,6,2 (size 96x96 → 96x100), diff diff/3-d.svg@4x-white.png',
    'removed e.svg',
    'external: b.svg https://cdn.example.com/x.png',
    'skipped: f.svg (not a regular file)',
    'blocked: https://cdn.example.com/x.png',
    'base 1111111 (origin/main), head 2222222 (HEAD)',
  ])
  assert.deepEqual(renderSvg({ ...REPORT, verdict: 'identical', differ: 0, files: [], external: [], skipped: [], blocked: [] }), [
    'drift: identical', 'no SVG file changed', 'base 1111111 (origin/main), head 2222222 (HEAD)',
  ])
})
