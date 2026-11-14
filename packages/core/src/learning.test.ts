import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DATA_FILES } from './data.ts'
import {
  AUDIT_CONTRACT, AUDIT_KINDS, AUDIT_VERSION, auditEvent, eventId, journalDir, journalEntryOf, journalFileOf, JOURNAL_MAX_AGE_DAYS,
  JOURNAL_MAX_EVENTS, languagesOf, LEARNING_CONTRACT, LEARNING_VERSION, LEARNING_WINDOW_DAYS, learningEvent, parseAuditEvent,
  parseJournalEvent, parseLearningEvent, prRefsOf, prunable,
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

describe('the audit event, version 2 of the contract', () => {
  const STEP = {
    v: 2,
    id: '20261114T101500Z-0a1b2c3d',
    at: AT,
    kind: 'step',
    source: { plugin: 'orchestrator', code: 'orchestrator.dispatch.open' },
    subject: { repo: null, pr: null, head: null },
    context: { role: 'orchestrator', mode: null, paths: [], languages: [], session: 'abc-123' },
    evidence: [],
    trust: 'computed',
    fact: { step: 'implement', edge: 'start', record: 'claude-orchestrator/briefs/p/dispatch.jsonl', row: 3, result: null },
  }
  const audit = (change: Record<string, unknown>) => parseAuditEvent({ ...STEP, ...change })

  it('reads an event of each kind with its fact, whole', () => {
    assert.deepEqual(parseAuditEvent(STEP), STEP)
    const facts: Record<string, unknown> = {
      link: { record: null, row: 3, session: 'agent-9', goal: 'G2', prs: ['claude-plugins#182', 'owner/name#7'] },
      step: { step: 'ci-wait', edge: 'end', record: null, row: null, result: 'green' },
      review: { verdict: 'accepted', kept: 0, set_aside: 2 },
      decision: { decision: 'set-aside', severity: 'minor', file: 'plugins/a/hooks/b.ts', line: 12 },
      wait: { wait: 'operator', edge: 'end', span: '20261114T101400Z-00000000', on: 'operator' },
      failure: { failure: 'fix-after-merge', count: null, prs: ['claude-plugins#180'] },
    }
    for (const kind of AUDIT_KINDS) {
      const event = { ...STEP, kind, fact: facts[kind] }
      assert.deepEqual(parseAuditEvent(event), event, kind)
    }
    assert.deepEqual([...AUDIT_KINDS], ['link', 'step', 'review', 'decision', 'wait', 'failure'])
    assert.equal(AUDIT_VERSION, 2)
  })

  it('reads a fact whose every field is unknown, as null', () => {
    assert.ok(audit({ kind: 'link', fact: { record: null, row: null, session: null, goal: null, prs: [] } }))
    assert.ok(audit({ kind: 'decision', fact: { decision: 'kept', severity: null, file: null, line: null } }))
    assert.ok(audit({ kind: 'wait', fact: { wait: 'done', edge: 'start', span: null, on: null } }))
  })

  it('refuses a fact that is not its kind\'s, or breaks a field of it', () => {
    const broken: Record<string, unknown>[] = [
      { v: 1 }, { kind: 'refusal' }, { kind: 'success' }, { fact: null }, { fact: undefined },
      { kind: 'review', fact: STEP.fact },
      { fact: { ...STEP.fact, step: 'deploy' } }, { fact: { ...STEP.fact, edge: 'middle' } }, { fact: { ...STEP.fact, row: 0 } },
      { fact: { ...STEP.fact, record: '/abs/path.jsonl' } }, { fact: { ...STEP.fact, result: 'Green light' } },
      { kind: 'review', fact: { verdict: 'waived', kept: 0, set_aside: 0 } }, { kind: 'review', fact: { verdict: 'pass', kept: -1, set_aside: 0 } },
      { kind: 'decision', fact: { decision: 'ignored', severity: null, file: null, line: null } },
      { kind: 'decision', fact: { decision: 'kept', severity: 'nit', file: null, line: null } },
      { kind: 'link', fact: { record: null, row: null, session: 'two words', goal: null, prs: [] } },
      { kind: 'link', fact: { record: null, row: null, session: null, goal: 'goal two', prs: [] } },
      { kind: 'link', fact: { record: null, row: null, session: null, goal: null, prs: ['#12'] } },
      { kind: 'link', fact: { record: null, row: null, session: null, goal: null, prs: Array.from({ length: 9 }, (_, i) => `r#${i + 1}`) } },
      { kind: 'wait', fact: { wait: 'operator', edge: 'end', span: 'x', on: 'operator' } },
      { kind: 'wait', fact: { wait: 'operator', edge: 'end', span: null, on: 'agent' } },
      { kind: 'failure', fact: { failure: 'flaky', count: null, prs: [] } }, { kind: 'failure', fact: { failure: 'succession-lost-state', count: 1.5, prs: [] } },
    ]
    for (const change of broken) assert.equal(audit(change), undefined, JSON.stringify(change))
  })

  it('refuses words in a fact: a summary, a reason, a command line', () => {
    const extra: Record<string, unknown>[] = [
      { fact: { ...STEP.fact, summary: 'a finding\'s words' } },
      { kind: 'decision', fact: { decision: 'set-aside', severity: null, file: null, line: null, reason: 'naming only' } },
      { kind: 'decision', fact: { decision: 'set-aside', severity: null, file: 'a.ts — naming only', line: null } },
      { kind: 'wait', fact: { wait: 'tool', edge: 'start', span: null, on: 'tool', blocks: 'ci-watch.sh 7' } },
      { command: 'git push' },
    ]
    for (const change of extra) assert.equal(audit(change), undefined, JSON.stringify(change))
  })

  it('is read beside version 1, each by its own version', () => {
    assert.deepEqual(parseJournalEvent(EVENT), EVENT)
    assert.deepEqual(parseJournalEvent(STEP), STEP)
    assert.equal(parseLearningEvent(STEP), undefined)
    assert.equal(parseAuditEvent(EVENT), undefined)
    assert.equal(parseJournalEvent({ ...STEP, v: 3 }), undefined)
  })

  it('is written as learning-audit.json, beside version 1', () => {
    assert.equal(DATA_FILES['learning-audit.json'], AUDIT_CONTRACT)
    assert.deepEqual(JSON.parse(JSON.stringify(AUDIT_CONTRACT)), AUDIT_CONTRACT)
  })
})

describe('an event built by a writer', () => {
  const base = { at: AT, random: '0a1b2c3d', source: { plugin: 'orchestrator', code: 'orchestrator.kill.refused' }, trust: 'computed' as const }

  it('gets its identifier from its time, its languages from its paths, and null for what it does not know', () => {
    const event = learningEvent({ ...base, kind: 'refusal', context: { paths: ['a/b.py'] }, evidence: [{ type: 'refusal', code: 'orchestrator.kill.refused' }] })
    assert.deepEqual(event, {
      v: 1, id: '20261114T101500Z-0a1b2c3d', at: AT, kind: 'refusal', source: base.source,
      subject: { repo: null, pr: null, head: null },
      context: { role: null, mode: null, paths: ['a/b.py'], languages: ['python'], session: null },
      evidence: [{ type: 'refusal', code: 'orchestrator.kill.refused' }], trust: 'computed',
    })
    const step = auditEvent({ ...base, kind: 'review', subject: { repo: 'o/n', pr: 3 }, fact: { verdict: 'fail', kept: 2, set_aside: 1 } })
    assert.equal(step?.v, 2)
    assert.deepEqual(step?.subject, { repo: 'o/n', pr: 3, head: null })
    assert.deepEqual(step?.fact, { verdict: 'fail', kept: 2, set_aside: 1 })
  })

  it('is none when a field breaks the contract', () => {
    assert.equal(learningEvent({ ...base, kind: 'refusal', random: 'xyz' }), undefined)
    assert.equal(learningEvent({ ...base, kind: 'refusal', context: { session: 'two words' } }), undefined)
    assert.equal(auditEvent({ ...base, kind: 'review', fact: { verdict: 'fail', kept: -1, set_aside: 0 } }), undefined)
  })
})

describe('the entries of a journal', () => {
  it('are named by the event\'s identifier, the time read back from the name', () => {
    assert.equal(journalFileOf('20261114T101500Z-0a1b2c3d'), '20261114T101500Z-0a1b2c3d.json')
    assert.deepEqual(journalEntryOf('20261114T101500Z-0a1b2c3d.json'), { id: '20261114T101500Z-0a1b2c3d', at: AT })
    for (const name of ['x.json', '20261114T101500Z-0a1b2c3d.json.tmp-1', '20261114T101500Z-0a1b2c3d', '20261399T101500Z-0a1b2c3d.json']) {
      assert.equal(journalEntryOf(name), undefined, name)
    }
  })
})

describe('the pull requests a text names', () => {
  it('are its references with a repository, each once, at most eight', () => {
    assert.deepEqual(prRefsOf('claude-plugins#95 merged 87586ec; see LounisBou/claude-plugins#96 and claude-plugins#95'), ['claude-plugins#95', 'LounisBou/claude-plugins#96'])
    assert.deepEqual(prRefsOf('fix (#12), issue #4, a#0, x/y/z#3, mail@host#5'), [])
    assert.equal(prRefsOf(Array.from({ length: 12 }, (_, i) => `r#${i + 1}`).join(' ')).length, 8)
  })
})
