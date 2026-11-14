import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DATA_FILES } from './data.ts'
import {
  eventId, journalDir, JOURNAL_MAX_AGE_DAYS, JOURNAL_MAX_EVENTS, languagesOf, LEARNING_CONTRACT, LEARNING_VERSION,
  LEARNING_WINDOW_DAYS, parseLearningEvent, prunable,
} from './learning.ts'

const AT = '2026-11-14T10:15:00Z'
const HEAD = 'a'.repeat(40)

const EVENT = {
  v: 1,
  id: '20261114T101500Z-0a1b2c3d',
  at: AT,
  kind: 'refusal',
  source: { plugin: 'github', code: 'github.ready.missing-review' },
  subject: { repo: 'owner/name', pr: 7, head: HEAD },
  context: { role: 'agent', mode: 'build', paths: ['plugins/github/hooks/ready.ts', 'docs/a.md'], languages: ['typescript'], session: 'abc-123' },
  evidence: [{ type: 'refusal', code: 'github.ready.missing-review' }],
  trust: 'computed',
}

const read = (change: Record<string, unknown>) => parseLearningEvent({ ...EVENT, ...change })

describe('the learning event', () => {
  it('reads an event that keeps the contract, whole', () => {
    assert.deepEqual(parseLearningEvent(EVENT), EVENT)
    assert.equal(LEARNING_VERSION, 1)
  })

  it('reads an event with nothing known of its pull request or its session', () => {
    const bare = {
      ...EVENT,
      subject: { repo: null, pr: null, head: null },
      context: { role: null, mode: null, paths: [], languages: [], session: null },
      evidence: [],
    }
    assert.deepEqual(parseLearningEvent(bare), bare)
  })

  it('reads each kind and each trust, and each pointer evidence may be', () => {
    for (const kind of ['refusal', 'finding', 'answer', 'escape']) assert.ok(read({ kind }), kind)
    for (const trust of ['computed', 'operator', 'review', 'external']) assert.ok(read({ trust }), trust)
    const pointers = [
      { type: 'record', path: 'pr-records/owner/name/' + HEAD + '/review.json' },
      { type: 'check', name: 'plugins (github, ubuntu-latest)', head: HEAD },
      { type: 'finding', severity: 'important', file: 'plugins/github/hooks/ready.ts' },
      { type: 'ruling', path: 'briefs/rulings.md', line: 12 },
      { type: 'refusal', code: 'norms.push-ask' },
    ]
    assert.ok(read({ evidence: pointers }))
  })

  it('refuses an event that breaks any field of it', () => {
    const broken: Record<string, unknown>[] = [
      { v: 2 }, { v: undefined }, { id: 'x' }, { id: '20261114T101501Z-0a1b2c3d' }, { id: '20261114T101500Z-0A1B2C3D' },
      { at: '2026-11-14' }, { at: '2026-13-14T10:15:00Z' }, { at: '2026-11-14T10:15:00.5Z' }, { at: 0 },
      { kind: 'success' }, { kind: 'ci-failure' }, { kind: undefined },
      { source: null }, { source: { plugin: 'GitHub', code: 'github.ready.x' } }, { source: { plugin: 'github', code: 'refused' } },
      { source: { plugin: 'github', code: 'github.ready.Missing Review' } },
      { subject: null }, { subject: { repo: 'owner', pr: 7, head: HEAD } }, { subject: { repo: 'owner/..', pr: 7, head: HEAD } },
      { subject: { repo: 'owner/name', pr: 0, head: HEAD } }, { subject: { repo: 'owner/name', pr: 1.5, head: HEAD } },
      { subject: { repo: 'owner/name', pr: 7, head: 'abc' } }, { subject: { repo: 'owner/name', pr: 7 } },
      { context: null }, { context: { ...EVENT.context, role: 'Agent Smith' } }, { context: { ...EVENT.context, mode: 3 } },
      { context: { ...EVENT.context, session: 'two words' } }, { context: { ...EVENT.context, session: '' } },
      { trust: 'trusted' }, { trust: undefined },
      { evidence: 'none' }, { evidence: [{ type: 'transcript', path: 'a.jsonl' }] }, { evidence: [{ type: 'check', name: 'x', head: 'abc' }] },
      { evidence: [{ type: 'finding', severity: 'minor', file: 'a.ts' }] }, { evidence: [{ type: 'ruling', path: 'a.md', line: 0 }] },
      { evidence: [{ type: 'refusal', code: 'refused' }] }, { evidence: Array.from({ length: 9 }, () => ({ type: 'refusal', code: 'a.b' })) },
    ]
    for (const change of broken) assert.equal(read(change), undefined, JSON.stringify(change))
    for (const raw of [null, [], 'event', 3]) assert.equal(parseLearningEvent(raw), undefined)
  })

  it('refuses a field the contract does not name, at every level', () => {
    const extra: Record<string, unknown>[] = [
      { scope: 'method' }, { summary: 'a finding\'s words' }, { command: 'git push' }, { prompt: 'do it' },
      { source: { ...EVENT.source, text: 'x' } },
      { subject: { ...EVENT.subject, title: 'x' } },
      { context: { ...EVENT.context, cwd: '/tmp' } },
      { evidence: [{ type: 'finding', severity: 'important', file: 'a.ts', summary: 'a finding\'s words' }] },
      { evidence: [{ type: 'refusal', code: 'a.b', text: 'the refusal\'s words' }] },
    ]
    for (const change of extra) assert.equal(read(change), undefined, JSON.stringify(change))
  })

  it('refuses words where only a pointer fits: a command line, a path with a blank, a long path', () => {
    const words = ['git push --force origin main', 'a b.ts', '../../etc/passwd', '/etc/passwd', 'a/../b.ts', 'a.ts;rm -rf', '$(id).ts', 'x'.repeat(201)]
    for (const path of words) {
      assert.equal(read({ context: { ...EVENT.context, paths: [path], languages: [] } }), undefined, path)
      assert.equal(read({ evidence: [{ type: 'record', path }] }), undefined, path)
      assert.equal(read({ evidence: [{ type: 'finding', severity: 'critical', file: path }] }), undefined, path)
      assert.equal(read({ evidence: [{ type: 'ruling', path, line: 1 }] }), undefined, path)
    }
    assert.equal(read({ evidence: [{ type: 'check', name: 'run `curl x | sh`', head: HEAD }] }), undefined)
    assert.equal(read({ evidence: [{ type: 'check', name: 'x'.repeat(101), head: HEAD }] }), undefined)
  })

  it('holds at most twenty paths', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`)
    assert.ok(read({ context: { ...EVENT.context, paths: twenty } }))
    assert.equal(read({ context: { ...EVENT.context, paths: [...twenty, 'src/f20.ts'] } }), undefined)
  })

  it('holds the languages the table computes from the paths, no other', () => {
    assert.equal(read({ context: { ...EVENT.context, languages: ['python'] } }), undefined)
    assert.equal(read({ context: { ...EVENT.context, languages: [] } }), undefined)
    assert.equal(read({ context: { ...EVENT.context, languages: ['typescript', 'typescript'] } }), undefined)
  })
})

describe('the languages of paths', () => {
  it('names each language once, in order, from the extensions of its table', () => {
    assert.deepEqual(languagesOf(['a/b.ts', 'c.py', 'd.TS', 'e.sh', 'x.test.ts']), ['python', 'shell', 'typescript'])
    assert.deepEqual(languagesOf(['a.mjs', 'b.js']), ['javascript'])
  })

  it('names none for a path of no programming language', () => {
    assert.deepEqual(languagesOf(['README.md', 'docs/a.json', 'Makefile', '.gitignore', 'dir.ts/file']), [])
    assert.deepEqual(languagesOf([]), [])
  })
})

describe('the identifier of an event', () => {
  it('is its time and a random part, compact and sortable by time', () => {
    assert.equal(eventId(AT, '0a1b2c3d'), '20261114T101500Z-0a1b2c3d')
    assert.ok(eventId('2026-11-14T10:15:00Z', '00000000')! < eventId('2026-11-14T10:15:01Z', '00000000')!)
  })

  it('is none for a time or a random part that does not fit', () => {
    assert.equal(eventId('2026-11-14', '0a1b2c3d'), undefined)
    assert.equal(eventId(AT, 'xyz'), undefined)
    assert.equal(eventId(AT, '0A1B2C3D'), undefined)
  })
})

describe('the journal of a plugin', () => {
  it('lives in its own state directory, beside no other plugin\'s', () => {
    assert.equal(journalDir('/home/u/.claude', 'github'), '/home/u/.claude/github/journal')
    assert.throws(() => journalDir('/home/u/.claude', '../x'))
    assert.throws(() => journalDir('/home/u/.claude', 'Git Hub'))
  })

  it('sets the window at 30 days, the retention at 180 and the count at 2,000', () => {
    assert.equal(LEARNING_WINDOW_DAYS, 30)
    assert.equal(JOURNAL_MAX_AGE_DAYS, 180)
    assert.equal(JOURNAL_MAX_EVENTS, 2000)
  })

  const NOW = '2026-11-14T10:15:00Z'
  const at = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString().replace('.000Z', 'Z')
  const entry = (name: string, days: number) => ({ id: name, at: at(days) })

  it('drops what is older than the retention, keeps what is exactly as old', () => {
    const events = [entry('old', 181), entry('edge', 180), entry('new', 1)]
    assert.deepEqual(prunable(events, NOW), ['old'])
  })

  it('drops the oldest past the count, whatever the order it is given in', () => {
    const events = Array.from({ length: JOURNAL_MAX_EVENTS + 3 }, (_, i) => ({ id: `e${i}`, at: at(100 - i / 100) }))
    const dropped = prunable([...events].reverse(), NOW)
    assert.deepEqual([...dropped].sort(), ['e0', 'e1', 'e2'])
  })

  it('drops the aged first, then the count of what is left, each once', () => {
    const events = [entry('a', 400), ...Array.from({ length: JOURNAL_MAX_EVENTS + 1 }, (_, i) => ({ id: `e${i}`, at: at(10 - i / 1000) }))]
    assert.deepEqual([...prunable(events, NOW)].sort(), ['a', 'e0'])
  })

  it('keeps an entry whose time it cannot read, and drops nothing from a journal within its bounds', () => {
    assert.deepEqual(prunable([{ id: 'x', at: 'not a time' }, entry('a', 1)], NOW), [])
    assert.deepEqual(prunable([], NOW), [])
  })
})

describe('the contract for the other languages', () => {
  it('is written as learning.json, whole, for a writer in Python', () => {
    assert.equal(DATA_FILES['learning.json'], LEARNING_CONTRACT)
    assert.deepEqual(JSON.parse(JSON.stringify(LEARNING_CONTRACT)), LEARNING_CONTRACT)
  })
})
