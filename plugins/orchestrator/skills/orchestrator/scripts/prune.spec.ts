import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { archiveOf, markerOf, pruneFile, pruneRulings, pruneState } from './prune.ts'

let dir = ''
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prune-')) })
test.afterEach(() => rmSync(dir, { recursive: true, force: true }))

const NOW = new Date('2026-11-13T22:30:00Z')

const RULINGS = [
  '# Standing rulings — Orch: belt',
  '',
  'Each dated and quoted.',
  '',
  '- 2026-11-08T00:00:00Z « Réponds-moi en français. » — the operator in French. [standing]',
  '- 2026-11-09T10:00:00Z « Merge #12 » → merge acme/app#12. [done: acme/app#12]',
  '- 2026-11-10T06:41:14Z « A » → port into next. [superseded: 2026-11-10T06:55:24Z]',
  '- 2026-11-10T06:55:24Z « A » → rebuild on home instead.',
  '- 2026-11-11T08:00:00Z « B » → a relay that spans',
  '  two lines. [superseded: 2026-11-12T15:18:34Z]',
  '- 2026-11-12T15:18:34Z « the four sections always » — every PR body.',
  '- 2026-11-12T16:00:00Z « C » → replaced by a ruling nobody wrote. [superseded: 2026-12-01T00:00:00Z]',
  '',
  'Not rulings of their own words:',
  '',
  'Standing (brief of 2026-11-09): no attribution anywhere.',
  '',
].join('\n')

test('a carried-out or superseded ruling moves, a standing or unmarked one stays, prose stays', () => {
  const pruned = pruneRulings(RULINGS, '')
  assert.deepEqual(pruned.moved, [
    '- 2026-11-09T10:00:00Z « Merge #12 » → merge acme/app#12. [done: acme/app#12]',
    '- 2026-11-10T06:41:14Z « A » → port into next. [superseded: 2026-11-10T06:55:24Z]',
    '- 2026-11-11T08:00:00Z « B » → a relay that spans\n  two lines. [superseded: 2026-11-12T15:18:34Z]',
  ])
  for (const kept of ['Réponds-moi en français', 'rebuild on home instead', 'the four sections always', 'Not rulings of their own words:', 'no attribution anywhere'])
    assert.ok(pruned.kept.includes(kept), kept)
  assert.ok(!pruned.kept.includes('Merge #12') && !pruned.kept.includes('two lines.'))
})

test('a supersession naming no ruling of the file or its archive stays, and says why', () => {
  const pruned = pruneRulings(RULINGS, '')
  assert.ok(pruned.kept.includes('replaced by a ruling nobody wrote'))
  assert.deepEqual(pruned.warnings, ['ruling 2026-11-12T16:00:00Z kept: superseded by 2026-12-01T00:00:00Z, which no ruling of the file or its archive opens on'])
  // Once the superseding ruling is in the archive, it moves.
  const later = pruneRulings(RULINGS, '- 2026-12-01T00:00:00Z « D » → the replacement. [done: x]\n')
  assert.ok(!later.kept.includes('replaced by a ruling nobody wrote'))
  assert.deepEqual(later.warnings, [])
})

test('the markers are read at the end of an entry only', () => {
  assert.deepEqual(markerOf('- x « y » [standing]'), { kind: 'standing' })
  assert.deepEqual(markerOf('- x « y » [done: acme/app#12, row 4]  '), { kind: 'done', ref: 'acme/app#12, row 4' })
  assert.deepEqual(markerOf('- x « y » [superseded: 2026-11-10T06:55:24Z]'), { kind: 'superseded', by: '2026-11-10T06:55:24Z' })
  assert.equal(markerOf('- x « [done: a] » the words quote a marker'), undefined)
  assert.equal(markerOf('- x « y » [superseded: yesterday]'), undefined)
  assert.equal(markerOf('- x « y » [done: ]'), undefined)
})

const STATE = [
  '# State — Orch: belt',
  '',
  'Checkout: /work/belt.',
  '',
  '## Live',
  '- 2026-11-13T21:13:41Z [a1b2c3] gen 25 took over. Agent: accept name running.',
  '- 2026-11-13T09:00:00Z [aa] morning journal, finished.',
  '- 2026-11-12T20:00:00Z LIVE SUMMARY [bb] an older summary.',
  '- Merged: #100.',
  '- 2026-11-13T21:08:23Z LIVE SUMMARY [a1b2c3] (journal moved to state-archive.md).',
  '- Merged: #141.',
  '- Ready, not merged: #130.',
  '- 2026-11-13T21:08:23Z [a1b2c3] written at the summary.',
  '',
  '## Notes',
  '- 2026-11-01T00:00:00Z a dated note outside the live section.',
  '',
].join('\n')

test('the journal older than the latest live summary moves, with its own undated lines; the rest stays', () => {
  const pruned = pruneState(STATE)
  assert.deepEqual(pruned.moved, [
    '- 2026-11-13T09:00:00Z [aa] morning journal, finished.',
    '- 2026-11-12T20:00:00Z LIVE SUMMARY [bb] an older summary.\n- Merged: #100.',
  ])
  assert.equal(pruned.kept, STATE
    .replace('- 2026-11-13T09:00:00Z [aa] morning journal, finished.\n', '')
    .replace('- 2026-11-12T20:00:00Z LIVE SUMMARY [bb] an older summary.\n- Merged: #100.\n', ''))
  assert.deepEqual(pruned.warnings, [])
})

test('a file with no marker, or a state file with no live summary, is left whole', () => {
  const unmarked = RULINGS.replace(/ \[(standing|done: [^\]]+|superseded: [^\]]+)\]/g, '')
  const rulings = pruneRulings(unmarked, '')
  assert.equal(rulings.kept, unmarked)
  assert.deepEqual(rulings.moved, [])
  const state = STATE.replaceAll('LIVE SUMMARY', 'summary')
  assert.deepEqual(pruneState(state), { kept: state, moved: [], warnings: [] })
})

test('pruneFile appends to the archive beside the file, never rewriting it, then writes the file', () => {
  const rulings = join(dir, 'rulings.md')
  const archive = archiveOf(rulings)
  assert.equal(archive, join(dir, 'rulings-archive.md'))
  writeFileSync(rulings, RULINGS)
  const before = '# Rulings archive — Orch: belt\n\n- 2026-11-01T00:00:00Z « old » → carried out. [done: x]\n'
  writeFileSync(archive, before)
  const result = pruneFile(rulings, pruneRulings, NOW)
  assert.deepEqual({ moved: result.moved, before: result.before }, { moved: 3, before: RULINGS.length })
  const after = readFileSync(archive, 'utf8')
  assert.ok(after.startsWith(before), 'the archive keeps its bytes, the moved entries after them')
  assert.ok(after.includes('## Moved 2026-11-13T22:30:00Z from rulings.md\n\n- 2026-11-09T10:00:00Z « Merge #12 »'))
  assert.equal(readFileSync(rulings, 'utf8'), pruneRulings(RULINGS, before).kept)
  assert.equal(result.after, readFileSync(rulings, 'utf8').length)
  // A second run moves nothing and leaves both files as they are.
  const again = pruneFile(rulings, pruneRulings, NOW)
  assert.equal(again.moved, 0)
  assert.equal(readFileSync(archive, 'utf8'), after)
})

test('pruneFile creates the archive when there is none, and leaves an absent file alone', () => {
  const state = join(dir, 'state.md')
  writeFileSync(state, STATE)
  assert.equal(pruneFile(state, pruneState, NOW).moved, 2)
  assert.match(readFileSync(join(dir, 'state-archive.md'), 'utf8'), /^## Moved 2026-11-13T22:30:00Z from state\.md\n\n- 2026-11-13T09:00:00Z/)
  assert.deepEqual(pruneFile(join(dir, 'none.md'), pruneState, NOW), { moved: 0, before: 0, after: 0, warnings: [] })
})
