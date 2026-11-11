import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { encodePng, type Image } from './png.ts'
import { generate, judgePair, playwrightConfig, renderShots, requestsFileOf, type ShotsReport } from './shots.ts'

const REPORT: ShotsReport = {
  version: 1,
  verdict: 'differ',
  differ: 2,
  threshold: 0,
  base: { ref: 'origin/main', sha: '1111111aaaa' },
  head: { ref: 'HEAD', sha: '2222222bbbb' },
  pairs: [
    { route: '/', width: 1440, verdict: 'identical' },
    { route: '/', width: 390, verdict: 'differ', pixels: 12, box: { x: 4, y: 5, width: 6, height: 2 }, diff: 'diff/root@390.png' },
    { route: '/long', width: 390, verdict: 'differ', pixels: 3900, box: { x: 0, y: 844, width: 390, height: 10 }, size: { base: [390, 844], head: [390, 854] }, diff: 'diff/long@390.png' },
  ],
  blocked: ['https://tiles.example.com/1.png'],
  unmocked: ['GET https://api.example.com/v1/x'],
}

test('the text report: the verdict, one line per pair with its box and any change of size, what was left out, the refs', () => {
  assert.deepEqual(renderShots(REPORT), [
    'drift: 2 differ',
    '/ @1440: identical',
    '/ @390: 12 px differ in 4,5,6,2, diff diff/root@390.png',
    '/long @390: 3900 px differ in 0,844,390,10 (size 390x844 → 390x854), diff diff/long@390.png',
    'blocked: https://tiles.example.com/1.png',
    'unmocked: GET https://api.example.com/v1/x',
    'base 1111111 (origin/main), head 2222222 (HEAD)',
  ])
  assert.deepEqual(renderShots({ ...REPORT, verdict: 'identical', differ: 0, pairs: [REPORT.pairs[0]!], blocked: [], unmocked: [] }), [
    'drift: identical', '/ @1440: identical', 'base 1111111 (origin/main), head 2222222 (HEAD)',
  ])
})

test('a report at a threshold above 0 says what it may not count', () => {
  assert.equal(renderShots({ ...REPORT, threshold: 0.1 })[4], 'threshold 0.1: colour differences within it and pixels taken for anti-aliasing are not counted')
  assert.equal(renderShots(REPORT).some(line => line.startsWith('threshold')), false)
})

test('a generated spec carries the module path as it is, $& and $1 included', () => {
  const text = generate('capture.pw.cjs', { module: '/opt/$&/$1/x' })
  assert.ok(text.includes('require("/opt/$&/$1/x")'))
  assert.equal(text.includes('__PLAYWRIGHT_MODULE__'), false)
})

test('a requests file is read as lists of strings, anything else dropped', () => {
  assert.deepEqual(requestsFileOf({ blocked: ['a', 3], unmocked: ['GET b'] }), { blocked: ['a'], unmocked: ['GET b'] })
  assert.deepEqual(requestsFileOf(['x']), { blocked: [], unmocked: [] })
  assert.deepEqual(requestsFileOf(null), { blocked: [], unmocked: [] })
})

test('every capture launches Chromium with grayscale text anti-aliasing only, so a page renders the same on each run', () => {
  const config = JSON.parse(playwrightConfig('/spec', 'capture.spec.cjs', '/results', 1000).replace(/^module\.exports = /, ''))
  assert.deepEqual(config.use.launchOptions.args, ['--disable-lcd-text'])
})

const blank = (width: number, height: number): Image => ({ width, height, data: Buffer.alloc(width * height * 4) })

test('a capture whose size changed differs, even when the area it gained is transparent, at any threshold', () => {
  const small = encodePng(blank(4, 3))
  const large = encodePng(blank(4, 5))
  for (const threshold of [0, 0.1]) {
    const judged = judgePair(small, large, threshold, undefined)
    assert.ok(judged.verdict === 'differ' && judged.image !== undefined)
    assert.equal(judged.pixels, 0)
    assert.deepEqual(judged.size, { base: [4, 3], head: [4, 5] })
  }
  assert.deepEqual(judgePair(small, small, 0, undefined), { verdict: 'identical' })
})

test('above threshold 0, a pair of one size is judged by the diff image the comparator left, or identical without one', () => {
  const dot = blank(4, 3)
  dot.data.set([255, 0, 0, 255], (1 * 4 + 2) * 4)
  const small = encodePng(blank(4, 3))
  assert.deepEqual(judgePair(small, small, 0.1, encodePng(dot)), { verdict: 'differ', pixels: 1, box: { x: 2, y: 1, width: 1, height: 1 } })
  assert.deepEqual(judgePair(small, small, 0.1, undefined), { verdict: 'identical' })
})
