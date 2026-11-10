import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { changedSources, decodeVlq, encodeVlq, mapUrlOf, parseSourceMap, textBySource, type SourceMap } from './sourcemap.ts'

test('a VLQ segment decodes to its signed fields', () => {
  assert.deepEqual(decodeVlq('AAAA'), [0, 0, 0, 0])
  assert.deepEqual(decodeVlq('AACA'), [0, 0, 1, 0])
  assert.deepEqual(decodeVlq('D'), [-1])
  assert.deepEqual(decodeVlq('gB'), [16])
})

test('encoding then decoding gives the values back', () => {
  for (const values of [[0], [1, -1, 15, -16], [1000, -2048, 3]]) assert.deepEqual(decodeVlq(values.map(encodeVlq).join('')), values)
})

test('a character outside base64 is refused', () => {
  assert.throws(() => decodeVlq('A!'), /not a base64 digit/)
})

test('a version 3 map with sources and mappings parses; anything else does not', () => {
  assert.deepEqual(parseSourceMap('{"version":3,"sources":["a.js"],"mappings":"AAAA","sourceRoot":"src"}'), { sources: ['a.js'], mappings: 'AAAA', sourceRoot: 'src' })
  assert.deepEqual(parseSourceMap('{"version":3,"sources":["a.js"],"mappings":""}'), { sources: ['a.js'], mappings: '', sourceRoot: '' })
  assert.equal(parseSourceMap('not json'), undefined)
  assert.equal(parseSourceMap('[]'), undefined)
  assert.equal(parseSourceMap('{"version":2,"sources":[],"mappings":""}'), undefined)
  assert.equal(parseSourceMap('{"version":3,"sources":[1],"mappings":""}'), undefined)
  assert.equal(parseSourceMap('{"version":3,"sections":[]}'), undefined)
})

const map = (sources: string[], lines: number[][][]): SourceMap => ({
  sources,
  sourceRoot: '',
  mappings: lines.map(line => line.map(segment => segment.map(encodeVlq).join('')).join(',')).join(';'),
})

test('the generated text is grouped by the source each segment maps to', () => {
  // line 0: cols 0-3 from source 0, cols 4- from source 1; line 1: unmapped prefix, then source 0
  const generated = 'aaa;bbb;\nxx;ccc;'
  const m = map(['a.js', 'b.js'], [[[0, 0, 0, 0], [4, 1, 0, 0]], [[3, -1, 1, 0]]])
  const grouped = textBySource(generated, m, 'assets')
  assert.deepEqual([...grouped.entries()], [
    ['assets/a.js', 'aaa;\nccc;'],
    ['assets/b.js', 'bbb;'],
    ['(unmapped)', 'xx;'],
  ])
})

test('source paths resolve against the map directory and the source root', () => {
  const m: SourceMap = { sources: ['../../src/a.ts'], sourceRoot: '', mappings: 'AAAA' }
  assert.deepEqual([...textBySource('x', m, 'dist/assets').keys()], ['src/a.ts'])
  const rooted: SourceMap = { sources: ['a.ts'], sourceRoot: '../lib/', mappings: 'AAAA' }
  assert.deepEqual([...textBySource('x', rooted, 'dist').keys()], ['lib/a.ts'])
  const url: SourceMap = { sources: ['webpack://app/a.ts'], sourceRoot: '', mappings: 'AAAA' }
  assert.deepEqual([...textBySource('x', url, 'dist').keys()], ['webpack://app/a.ts'])
})

test('a segment with one field maps to no source; a source index out of range too', () => {
  const m = map(['a.js'], [[[0], [2, 5, 0, 0]]])
  assert.deepEqual([...textBySource('abcd', m, '').entries()], [['(unmapped)', 'ab\ncd']])
})

test('a broken mapping throws, so the caller can say the map is unreadable', () => {
  assert.throws(() => textBySource('x', { sources: ['a'], sourceRoot: '', mappings: 'A$' }, ''), /not a base64 digit/)
})

test('the changed sources are those whose generated text differs, or that one side lacks', () => {
  const base = { text: 'aaa;bbb;', map: map(['a.js', 'b.js'], [[[0, 0, 0, 0], [4, 1, 0, 0]]]) }
  const same = { text: 'aaa;bbb;', map: map(['a.js', 'b.js'], [[[0, 0, 0, 0], [4, 1, 0, 0]]]) }
  const changed = { text: 'aaa;BBB;', map: map(['a.js', 'b.js'], [[[0, 0, 0, 0], [4, 1, 0, 0]]]) }
  const moved = { text: 'aaa;ccc;', map: map(['a.js', 'c.js'], [[[0, 0, 0, 0], [4, 1, 0, 0]]]) }
  assert.deepEqual(changedSources(base, same, 'x'), [])
  assert.deepEqual(changedSources(base, changed, 'x'), ['x/b.js'])
  assert.deepEqual(changedSources(base, moved, 'x'), ['x/b.js', 'x/c.js'])
})

test('the map URL is read from the last sourceMappingURL comment, JS or CSS', () => {
  assert.equal(mapUrlOf('a\n//# sourceMappingURL=index.js.map\n'), 'index.js.map')
  assert.equal(mapUrlOf('a{}\n/*# sourceMappingURL=style.css.map */'), 'style.css.map')
  assert.equal(mapUrlOf('//@ sourceMappingURL=old.map\n//# sourceMappingURL=new.map'), 'new.map')
  assert.equal(mapUrlOf('no comment'), undefined)
})
