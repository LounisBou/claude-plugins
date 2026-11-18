import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findingCounts, findingId, lensDescription, lensSlug, parseFindingId, parseLensDescription, parseLensFindings, withFindingIds } from './lens.ts'

const ANSWER = [
  'Read the diff and the two files it names.',
  '[important] src/a.ts:12 — the lock is released before the write — line 14 writes after unlock()',
  '- [critical] `src/b.ts:3` — the token reaches the log — logger.info(token)',
  '[minor] README.md:40-42 — the example names a removed flag — --legacy',
  '[bogus] src/c.ts:1 — not a severity — x',
  '[minor] no location — a claim — evidence',
].join('\n')

describe('lens readers', () => {
  it('a lens name is a slug: lower case, words joined by a dash', () => {
    assert.equal(lensSlug('Silent failures'), 'silent-failures')
    assert.equal(lensSlug(' Spec conformity! '), 'spec-conformity')
    assert.equal(lensSlug('***'), undefined)
  })

  it('the description a launcher gives a reader names its lens, its pull request and its range, and reads back', () => {
    const text = lensDescription({ lens: 'Silent failures', repo: 'acme/thing', pr: 12, base: 'origin/main', head: '0123456789abcdef' })
    assert.equal(text, 'lens silent-failures acme/thing#12 origin/main..0123456789ab')
    assert.deepEqual(parseLensDescription(text), { lens: 'silent-failures', repo: 'acme/thing', pr: 12, base: 'origin/main', head: '0123456789ab' })
    assert.equal(parseLensDescription('Lens: correctness'), undefined)
    assert.equal(parseLensDescription('lens x acme/thing#0 a..b'), undefined)
  })

  it('a finding line reads as its severity, file, line and claim; a line of another shape is none', () => {
    assert.deepEqual(parseLensFindings(ANSWER), [
      { severity: 'important', file: 'src/a.ts', line: 12, claim: 'the lock is released before the write' },
      { severity: 'critical', file: 'src/b.ts', line: 3, claim: 'the token reaches the log' },
      { severity: 'minor', file: 'README.md', line: 40, claim: 'the example names a removed flag' },
    ])
    assert.deepEqual(findingCounts(parseLensFindings(ANSWER)), { critical: 1, important: 1, minor: 1 })
    assert.deepEqual(findingCounts(parseLensFindings('no findings: read the diff')), { critical: 0, important: 0, minor: 0 })
  })

  it('a finding id is stable over lens, file, line and claim (case and spacing of the claim aside), and names its lens', () => {
    const id = findingId('correctness', 'src/a.ts', 12, 'the lock is released before the write')
    assert.match(id, /^correctness:[0-9a-f]{10}$/)
    assert.equal(findingId('correctness', 'src/a.ts', 12, '  The lock is   released before the write '), id)
    assert.notEqual(findingId('tests', 'src/a.ts', 12, 'the lock is released before the write'), id)
    assert.notEqual(findingId('correctness', 'src/a.ts', 13, 'the lock is released before the write'), id)
    assert.notEqual(findingId('correctness', 'src/a.ts', 12, 'the lock is held'), id)
    assert.deepEqual(parseFindingId(`see ${id} there`), { id, lens: 'correctness' })
    assert.equal(parseFindingId('no id'), undefined)
  })

  it('a reader\'s answer gets each finding line\'s id at its end; the rest of the answer is kept as it came', () => {
    const marked = withFindingIds(ANSWER, 'correctness')
    const lines = marked.split('\n')
    assert.equal(lines[0], 'Read the diff and the two files it names.')
    assert.equal(lines[1], `[important] src/a.ts:12 — the lock is released before the write — line 14 writes after unlock() — id ${findingId('correctness', 'src/a.ts', 12, 'the lock is released before the write')}`)
    assert.equal(lines[4], '[bogus] src/c.ts:1 — not a severity — x')
    // Marked twice, a line keeps one id; the ids read back from the marked answer are the same.
    assert.equal(withFindingIds(marked, 'correctness'), marked)
    assert.deepEqual(parseLensFindings(marked), parseLensFindings(ANSWER))
  })
})
