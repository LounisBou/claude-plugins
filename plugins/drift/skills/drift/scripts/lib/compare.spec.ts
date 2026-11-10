import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { compareTrees, DEFAULT_HASH_PATTERN, keyed, render, signed, stripName, type Report, type Tree } from './compare.ts'
import { encodeVlq } from './sourcemap.ts'

const HASH = new RegExp(DEFAULT_HASH_PATTERN)
const tree = (files: Record<string, string>): Tree => new Map(Object.entries(files).map(([path, text]) => [path, Buffer.from(text, 'utf8')]))

test('the default pattern strips a Vite or Rollup hash, never a word', () => {
  assert.equal(stripName('assets/index-BxY_3-a1.js', HASH), 'assets/index.js')
  assert.equal(stripName('assets/index-D4kL9xQz.js.map', HASH), 'assets/index.js.map')
  assert.equal(stripName('assets/Foo.vue_vue_type_script_setup_true_lang-CxQz12aB.js', HASH), 'assets/Foo.vue_vue_type_script_setup_true_lang.js')
  assert.equal(stripName('assets/logo-9f8e7d6c.svg', HASH), 'assets/logo.svg')
  assert.equal(stripName('assets/icon-settings.svg', HASH), 'assets/icon-settings.svg')
  assert.equal(stripName('assets/use-dropdown.js', HASH), 'assets/use-dropdown.js')
  assert.equal(stripName('index.html', HASH), 'index.html')
  // only the file name is read: a hashed directory name stays
  assert.equal(stripName('a-B1234567/x.js', HASH), 'a-B1234567/x.js')
})

test('files of one side that read as the same name keep their full name as their key', () => {
  const { keys, ambiguous } = keyed(['a/x-B1234567.js', 'a/x-C7654321.js', 'b.js', 'a-B1234567.js'], HASH)
  assert.deepEqual([...keys], [['a.js', 'a-B1234567.js'], ['a/x-B1234567.js', 'a/x-B1234567.js'], ['a/x-C7654321.js', 'a/x-C7654321.js'], ['b.js', 'b.js']])
  assert.deepEqual(ambiguous, ['a/x-B1234567.js', 'a/x-C7654321.js'])
})

test('two same-named chunks pair by their hashed name: the same build reads identical, and names them', () => {
  const files = { 'app/Alerts-B1234567.js': 'one', 'app/Alerts-C7654321.js': 'two', 'index.html': 'Alerts-B1234567.js Alerts-C7654321.js' }
  assert.deepEqual(compareTrees(tree(files), tree(files), HASH, 'dist'), { files: [], normalised: 0, ambiguous: ['app/Alerts-B1234567.js', 'app/Alerts-C7654321.js'] })
})

test('one of two same-named chunks changed reads removed and added, never identical', () => {
  const base = tree({ 'app/Alerts-B1234567.js': 'one', 'app/Alerts-C7654321.js': 'two' })
  const head = tree({ 'app/Alerts-B1234567.js': 'one', 'app/Alerts-D9999999.js': 'TWO' })
  const { files, ambiguous } = compareTrees(base, head, HASH, 'dist')
  assert.deepEqual(files.map(file => [file.status, file.path]), [['removed', 'app/Alerts-C7654321.js'], ['added', 'app/Alerts-D9999999.js']])
  assert.deepEqual(ambiguous, ['app/Alerts-B1234567.js', 'app/Alerts-C7654321.js', 'app/Alerts-D9999999.js'])
})

test('the same files read identical, with nothing normalised', () => {
  const files = { 'index.html': '<script src="a-B1234567.js">', 'a-B1234567.js': 'x' }
  const result = compareTrees(tree(files), tree(files), HASH, 'dist')
  assert.deepEqual(result, { files: [], normalised: 0, ambiguous: [] })
})

test('a hash-only rename reads identical, its references normalised and counted', () => {
  const base = tree({ 'index.html': '<script src="a-B1234567.js">', 'a-B1234567.js': 'x' })
  const head = tree({ 'index.html': '<script src="a-C7654321.js">', 'a-C7654321.js': 'x' })
  assert.deepEqual(compareTrees(base, head, HASH, 'dist'), { files: [], normalised: 1, ambiguous: [] })
})

test('changed, added and removed files carry their raw and gzip deltas, sorted by path', () => {
  const base = tree({ 'b.js': 'same', 'gone.css': 'abc', 'm.js': 'aaaa' })
  const head = tree({ 'b.js': 'same', 'm.js': 'aaaaaaaa', 'new-B1234567.js': 'hello' })
  const { files } = compareTrees(base, head, HASH, 'dist')
  assert.deepEqual(files.map(file => [file.status, file.path, file.raw]), [
    ['removed', 'gone.css', -3],
    ['changed', 'm.js', 4],
    ['added', 'new.js', 5],
  ])
  const added = files[2]
  assert.equal(added?.head?.name, 'new-B1234567.js')
  assert.equal(added?.base, undefined)
  assert.ok((added?.gzip ?? 0) > 0)
  assert.equal(files[0]?.head, undefined)
})

/** A one-line bundle of modules, each `name:text;`, with a map from each module's text to its source. */
function bundle(name: string, modules: [string, string][]): Record<string, string> {
  let code = ''
  const segments: string[] = []
  let column = 0
  modules.forEach(([, text], k) => {
    segments.push([column, k === 0 ? 0 : 1, 0, 0].map(encodeVlq).join(''))
    column = text.length
    code += text
  })
  const map = JSON.stringify({ version: 3, sources: modules.map(([source]) => `../src/${source}`), mappings: segments.join(',') })
  return { [`assets/${name}`]: `${code}\n//# sourceMappingURL=${name}.map`, [`assets/${name}.map`]: map }
}

test('a changed file with a map on both sides names the modules whose output changed', () => {
  const base = tree(bundle('index-B1234567.js', [['a.js', 'A();'], ['b.js', 'B();']]))
  const head = tree(bundle('index-C7654321.js', [['a.js', 'A();'], ['b.js', 'B(1);']]))
  const { files } = compareTrees(base, head, HASH, 'dist')
  assert.deepEqual(files.map(file => [file.status, file.path, file.sources]), [
    ['changed', 'assets/index.js', ['dist/src/b.js']],
  ])
})

test('an inline data: map is read too, and an unreadable map names nothing', () => {
  const inline = (code: string): string => {
    const map = JSON.stringify({ version: 3, sources: ['m.js'], mappings: 'AAAA' })
    return `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString('base64')}`
  }
  const { files } = compareTrees(tree({ 'x.js': inline('one') }), tree({ 'x.js': inline('two') }), HASH, 'out')
  assert.deepEqual(files[0]?.sources, ['out/m.js'])
  const broken = compareTrees(tree({ 'x.js': 'a\n//# sourceMappingURL=x.js.map', 'x.js.map': '{"version":3,"sources":["m"],"mappings":"!"}' }),
    tree({ 'x.js': 'b\n//# sourceMappingURL=x.js.map', 'x.js.map': '{"version":3,"sources":["m"],"mappings":"!"}' }), HASH, 'out')
  assert.deepEqual(broken.files.map(file => file.sources), [undefined])
  const missing = compareTrees(tree({ 'x.js': 'a' }), tree({ 'x.js': 'b', 'x.js.map': '{"version":3,"sources":["m"],"mappings":"AAAA"}' }), HASH, 'out')
  assert.deepEqual(missing.files.map(file => [file.path, file.sources]), [['x.js', undefined], ['x.js.map', undefined]])
})

test('without a sourceMappingURL comment the map beside the file is read', () => {
  const map = (mappings: string): string => JSON.stringify({ version: 3, sources: ['m.js'], mappings })
  const { files } = compareTrees(tree({ 'x.js': 'one', 'x.js.map': map('AAAA') }), tree({ 'x.js': 'two', 'x.js.map': map('AAAA') }), HASH, 'out')
  assert.deepEqual(files.map(file => [file.path, file.sources]), [['x.js', ['out/m.js']]])
})

const report = (files: Report['files'], normalised = 0, ambiguous: string[] = []): Report => ({
  version: 1,
  verdict: files.length === 0 ? 'identical' : 'differ',
  differ: files.length,
  normalised,
  ambiguous,
  hashPattern: DEFAULT_HASH_PATTERN,
  base: { ref: 'origin/main', sha: 'a'.repeat(40) },
  head: { ref: 'HEAD', sha: 'b'.repeat(40) },
  files,
})

test('the text starts with the verdict and says when references were normalised', () => {
  assert.deepEqual(render(report([])), ['drift: identical', 'base aaaaaaa (origin/main), head bbbbbbb (HEAD)'])
  assert.equal(render(report([], 3))[0], 'drift: identical (hash references normalised in 3 files)')
  assert.equal(render(report([], 1))[0], 'drift: identical (hash references normalised in 1 file)')
  assert.deepEqual(render(report([], 0, ['app/A-B1234567.js', 'app/A-C7654321.js'])), [
    'drift: identical',
    'ambiguous: 2 files paired by their hashed name',
    '  app/A-B1234567.js',
    '  app/A-C7654321.js',
    'base aaaaaaa (origin/main), head bbbbbbb (HEAD)',
  ])
  const lines = render(report([
    { path: 'a.js', status: 'changed', raw: 3, gzip: -1, sources: ['src/b.js'], base: { name: 'a.js', raw: 1, gzip: 2 }, head: { name: 'a.js', raw: 4, gzip: 1 } },
    { path: 'n.js', status: 'added', raw: 5, gzip: 0, head: { name: 'n.js', raw: 5, gzip: 0 } },
  ]))
  assert.deepEqual(lines, ['drift: 2 differ', 'changed a.js raw +3 gzip -1', '  source src/b.js', 'added n.js raw +5 gzip 0', 'base aaaaaaa (origin/main), head bbbbbbb (HEAD)'])
})

test('a delta is signed, zero bare', () => {
  assert.deepEqual([signed(4), signed(-4), signed(0)], ['+4', '-4', '0'])
})
