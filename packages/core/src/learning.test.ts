import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DATA_FILES } from './data.ts'
import {
  AUDIT_CONTRACT, AUDIT_KINDS, AUDIT_VERSION, auditEvent, CANDIDATE_CONTRACT, CANDIDATE_STATE_CONTRACT, candidateStateDir, candidateStateFile, isDue, judged, moved, parseCandidateState, readCandidateState, retrospectiveStartArgv, scopeFits, eventId, parseCandidate, signatureFrom, journalDir, journalEntryOf, journalFileOf, JOURNAL_MAX_AGE_DAYS,
  JOURNAL_MAX_EVENTS, languagesOf, LEARNING_CONTRACT, LEARNING_VERSION, LEARNING_WINDOW_DAYS, learningEvent, parseAuditEvent,
  answerEvent, answerGiven, findingEvent, repoPath, subjectOf,
  afterLanding, FORGET_CONTRACT, isSilentGuard, prOutcomeOf, provedWrong, guardPhase, isEnforceable, LEARNED_GUARD_CONTRACT, learnedDecision, tallyOf, wouldBeRefusals, wouldBeVerdict, type WouldBeVerdict,
  foldDropped, foldedText, foldWeekly, JOURNAL_FOLD_FILE, mergeFolded, parseFold, parseFolded, parseJournalEvent, parseLearningEvent, pathClassesOf, prRefsOf, prunable, signatureOf,
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

  it('sets the window at 30 days, the retention at 90 and the count at 6,000', () => {
    assert.equal(LEARNING_WINDOW_DAYS, 30)
    assert.equal(JOURNAL_MAX_AGE_DAYS, 90)
    assert.equal(JOURNAL_MAX_EVENTS, 6000)
  })

  const NOW = '2026-11-14T10:15:00Z'
  const at = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString().replace('.000Z', 'Z')
  const entry = (name: string, days: number) => ({ id: name, at: at(days) })

  it('drops what is older than the retention, keeps what is exactly as old', () => {
    const events = [entry('old', 91), entry('edge', 90), entry('new', 1)]
    assert.deepEqual(prunable(events, NOW), ['old'])
  })

  it('drops the oldest past the count, whatever the order it is given in', () => {
    const events = Array.from({ length: JOURNAL_MAX_EVENTS + 3 }, (_, i) => ({ id: `e${i}`, at: at(80 - i / 100) }))
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

describe('the weekly fold of the events a journal drops', () => {
  const refusal = (when: string, code = 'github.ready.missing-review') => {
    const event = learningEvent({ kind: 'refusal', at: when, random: '0a1b2c3d', source: { plugin: 'github', code }, trust: 'computed' })
    assert.ok(event, when)
    return event
  }

  it('names the class of each path once, in order: a test by its directory or its name, docs and configuration by directory or extension, source otherwise', () => {
    assert.deepEqual(pathClassesOf([]), [])
    assert.deepEqual(pathClassesOf(['src/a.ts', 'Makefile']), ['source'])
    assert.deepEqual(pathClassesOf(['plugins/x/tests/run.sh', 'src/a.test.ts', 'src/b.spec.ts', 'pkg/c_test.go']), ['test'])
    assert.deepEqual(pathClassesOf(['docs/build.ts', 'README.md']), ['docs'])
    assert.deepEqual(pathClassesOf(['package.json', 'ci/build.YML']), ['configuration'])
    assert.deepEqual(pathClassesOf(['tests/fixture.json', 'docs/tests.md']), ['docs', 'test'])
    assert.deepEqual(pathClassesOf(['src/a.ts', 'a.md', 'a.toml', 'a.test.ts']), ['configuration', 'docs', 'source', 'test'])
    assert.deepEqual(pathClassesOf(['src/latest/contest.ts']), ['source'])
  })

  it('names a signature by kind and code, and by severity, path classes and languages when the event has them', () => {
    assert.equal(signatureOf(refusal(AT)), 'refusal:github.ready.missing-review')
    const finding = parseLearningEvent({
      ...EVENT, kind: 'finding', evidence: [{ type: 'finding', severity: 'critical', file: 'plugins/github/hooks/ready.ts' }],
    })
    assert.ok(finding)
    assert.equal(signatureOf(finding), 'finding:github.ready.missing-review:critical:docs:source:typescript')
  })

  it('counts one line per signature and week, by week then signature, the week named by its Monday in UTC', () => {
    const folded = foldWeekly([
      refusal('2026-11-09T00:00:00Z'), refusal('2026-11-15T23:59:59Z'), refusal('2026-11-16T00:00:00Z'),
      refusal('2026-11-10T08:00:00Z', 'norms.push-ask'),
    ])
    assert.deepEqual(folded, [
      { signature: 'refusal:github.ready.missing-review', week: '2026-11-09', count: 2 },
      { signature: 'refusal:norms.push-ask', week: '2026-11-09', count: 1 },
      { signature: 'refusal:github.ready.missing-review', week: '2026-11-16', count: 1 },
    ])
  })

  it('answers nothing for nothing, whatever the order the events come in', () => {
    assert.deepEqual(foldWeekly([]), [])
    const events = [refusal('2026-11-16T00:00:00Z'), refusal('2026-11-09T00:00:00Z')]
    assert.deepEqual(foldWeekly(events), foldWeekly([...events].reverse()))
  })
})

describe('the fold file of a journal', () => {
  const line = (signature: string, week: string, count: number) => ({ signature, week, count })
  const made = (at: string, code = 'github.ready.missing-review') => learningEvent({ kind: 'refusal', at, random: '0a1b2c3d', source: { plugin: 'github', code }, trust: 'computed' })
  const dropped = (at: string, code = 'github.ready.missing-review') => ({ id: made(at, code)?.id ?? '', text: JSON.stringify(made(at, code)) })

  it('is one file named by the contract, which is not an entry of the journal', () => {
    assert.equal(JOURNAL_FOLD_FILE, 'folded.json')
    assert.equal(LEARNING_CONTRACT.fold_file, JOURNAL_FOLD_FILE)
    assert.equal(journalEntryOf(JOURNAL_FOLD_FILE), undefined)
  })

  it('adds counts of the same signature and week, and keeps the others, in order', () => {
    const merged = mergeFolded([line('refusal:a.b', '2026-11-09', 2)], [line('refusal:a.b', '2026-11-09', 3), line('refusal:a.b', '2026-11-02', 1)])
    assert.deepEqual(merged, [line('refusal:a.b', '2026-11-02', 1), line('refusal:a.b', '2026-11-09', 5)])
  })

  it('is written whole and read back whole; an absent file is no counts, an unreadable one is undefined', () => {
    const counts = [line('refusal:a.b', '2026-11-09', 2)]
    assert.deepEqual(parseFolded(foldedText(counts)), counts)
    assert.deepEqual(parseFolded(undefined), [])
    for (const bad of ['', 'x', '[]', '{"v":2,"counts":[]}', '{"v":1}', '{"v":1,"counts":[{"signature":"a","week":"2026-11-09","count":0}]}',
      '{"v":1,"counts":[{"signature":"a","week":"soon","count":1}]}', '{"v":1,"counts":[{"signature":"a","week":"2026-11-09","count":1,"more":1}]}']) {
      assert.equal(parseFolded(bad), undefined, bad)
    }
  })

  it('folds the dropped events into the current counts, whatever version they are, and skips what is no event', () => {
    const current = foldedText([line('refusal:github.ready.missing-review', '2026-11-09', 4)])
    const text = foldDropped([dropped('2026-11-10T08:00:00Z'), { id: 'a', text: '{}' }, { id: 'b', text: undefined }, { id: 'c', text: 'not json' }, dropped('2026-11-17T08:00:00Z')], current)
    assert.deepEqual(parseFolded(text), [
      line('refusal:github.ready.missing-review', '2026-11-09', 5),
      line('refusal:github.ready.missing-review', '2026-11-16', 1),
    ])
  })

  it('writes nothing when no dropped event can be read, and refuses to overwrite a fold it cannot read', () => {
    assert.equal(foldDropped([{ id: 'a', text: '{}' }, { id: 'b', text: undefined }], undefined), undefined)
    assert.equal(foldDropped([], foldedText([])), undefined)
    assert.throws(() => foldDropped([dropped('2026-11-10T08:00:00Z')], 'garbled'), /fold/)
  })

  it('names the events it counted as pending, and counts an event it finds pending once only', () => {
    const first = dropped('2026-11-10T08:00:00Z')
    const second = dropped('2026-11-17T08:00:00Z')
    const counted = foldDropped([first], undefined)
    assert.deepEqual(parseFold(counted)?.pending, [first.id])
    // The removal did not happen: the same event comes back, with a new one beside it.
    const again = foldDropped([first, second], counted)
    assert.equal(parseFolded(again)?.reduce((sum, line) => sum + line.count, 0), 2)
    assert.deepEqual(parseFold(again)?.pending, [first.id, second.id])
    // Only events already counted come back: there is nothing to write, and the removal can go on.
    assert.equal(foldDropped([first], counted), undefined)
  })

  it('reads and writes the pending ids with the counts, and refuses an id that is no event\'s', () => {
    const counts = [line('refusal:a.b', '2026-11-09', 2)]
    assert.deepEqual(parseFold(foldedText(counts, ['20261114T101500Z-0a1b2c3d'])), { counts, pending: ['20261114T101500Z-0a1b2c3d'] })
    assert.deepEqual(parseFold(foldedText(counts)), { counts, pending: [] })
    assert.equal(parseFold('{"v":1,"counts":[],"pending":["x"]}'), undefined)
    assert.equal(parseFold('{"v":1,"counts":[],"pending":"x"}'), undefined)
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
    for (const kind of AUDIT_KINDS.filter(k => AUDIT_CONTRACT.kind_versions[k] === 2)) {
      const event = { ...STEP, kind, fact: facts[kind] }
      assert.deepEqual(parseAuditEvent(event), event, kind)
    }
    assert.deepEqual([...AUDIT_KINDS], ['link', 'step', 'review', 'decision', 'wait', 'failure', 'dispatch'])
    assert.equal(AUDIT_VERSION, 3)
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

  it('reads a dispatch at version 3, and no version 2 kind there', () => {
    const DISPATCH = { ...STEP, v: 3, kind: 'dispatch', fact: { sub: 'open' as const, record: 'claude-orchestrator/briefs/p/dispatch.jsonl', row: 3, class: 'plugin', tier: null, model: 'claude-opus-4-5[1m]', effort: 'high' as const, verdict: null } }
    assert.deepEqual(parseAuditEvent(DISPATCH), DISPATCH)
    assert.deepEqual(parseJournalEvent(DISPATCH), DISPATCH)
    assert.ok(parseAuditEvent({ ...DISPATCH, fact: { ...DISPATCH.fact, sub: 'close', model: null, effort: null, tier: 'light', verdict: 'merged' } }))
    const broken: Record<string, unknown>[] = [
      { v: 2 }, { fact: { ...DISPATCH.fact, sub: 'summary' } }, { fact: { ...DISPATCH.fact, tier: 'cheap' } },
      { fact: { ...DISPATCH.fact, effort: 'huge' } }, { fact: { ...DISPATCH.fact, verdict: 'merged after two rounds' } },
      { fact: { ...DISPATCH.fact, model: 'two words' } }, { fact: { ...DISPATCH.fact, class: 'Some Class' } }, { fact: { ...DISPATCH.fact, line: 'x' } },
    ]
    for (const change of broken) assert.equal(parseAuditEvent({ ...DISPATCH, ...change }), undefined, JSON.stringify(change))
    assert.equal(parseAuditEvent({ ...STEP, v: 3 }), undefined)
    const built = auditEvent({ at: AT, random: '0a1b2c3d', source: { plugin: 'orchestrator', code: 'orchestrator.dispatch.open' }, trust: 'computed', kind: 'dispatch', fact: DISPATCH.fact })
    assert.equal(built?.v, 3)
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
describe('the candidate', () => {
  const CANDIDATE = {
    v: 1, signature: 'finding:pr-review.finding:critical:source:test:python:typescript', kind: 'finding', code: 'pr-review.finding', severity: 'critical',
    classes: ['source', 'test'], languages: ['python', 'typescript'], since: '2026-10-15T10:00:00Z', until: '2026-11-14T10:00:00Z',
    events: ['20261101T101500Z-0a1b2c3d', '20261102T101500Z-0a1b2c3d', '20261103T101500Z-0a1b2c3d'], prs: ['owner/name#7', 'owner/other#7'], repos: ['owner/name', 'owner/other', 'owner/third'],
  }
  const read = (change: Record<string, unknown>) => parseCandidate({ ...CANDIDATE, ...change })

  it('reads a candidate that keeps the contract, whole', () => {
    assert.deepEqual(parseCandidate(CANDIDATE), CANDIDATE)
    assert.deepEqual(read({ signature: 'refusal:github.writing.rule', kind: 'refusal', code: 'github.writing.rule', severity: null, classes: [], languages: [] })?.severity, null)
  })

  it('refuses a field the contract does not name, a missing one, and what is not an object', () => {
    assert.equal(read({ scope: 'method' }), undefined)
    const { repos: _repos, ...short } = CANDIDATE
    for (const bad of [short, null, [], 'candidate']) assert.equal(parseCandidate(bad), undefined)
  })

  it('refuses a signature that is not the one its parts give', () => {
    assert.equal(signatureFrom({ kind: 'finding', code: 'pr-review.finding', severity: 'critical', classes: ['source', 'test'], languages: ['python', 'typescript'] }), CANDIDATE.signature)
    for (const change of [{ signature: 'finding:pr-review.finding' }, { kind: 'refusal' }, { code: 'norms.finding' }, { severity: 'important' }, { severity: null }, { classes: ['source'] }, { languages: ['python'] }]) {
      assert.equal(read(change), undefined, JSON.stringify(change))
    }
  })

  it('refuses a part outside its list, and a list out of order or with a value twice', () => {
    const bad = [
      { v: 2 }, { kind: 'link' }, { code: 'no-dot' }, { severity: 'minor' }, { classes: ['vendor'] }, { classes: ['test', 'source'] }, { languages: ['cobol'] },
      { languages: ['typescript', 'python'] }, { languages: 'python' }, { events: [...CANDIDATE.events].reverse() }, { events: ['a', 'b', 'c'] },
      { events: [CANDIDATE.events[0], CANDIDATE.events[0], CANDIDATE.events[1]] }, { prs: ['owner/other#7', 'owner/name#7'] }, { repos: ['owner/other', 'owner/name'] },
    ]
    for (const change of bad) assert.equal(read(change), undefined, JSON.stringify(change))
  })

  it('refuses a cluster under the thresholds', () => {
    assert.deepEqual([CANDIDATE_CONTRACT.min_events, CANDIDATE_CONTRACT.min_prs], [3, 2])
    assert.equal(read({ events: CANDIDATE.events.slice(0, 2) }), undefined)
    assert.equal(read({ prs: ['owner/name#7'] }), undefined)
  })

  it('refuses a pull request not named with its repository, or in a repository the candidate does not name', () => {
    for (const prs of [['#7', 'owner/name#7'], ['owner/name#7', 'owner/name#x'], ['name#7', 'owner/name#7'], ['owner/name#0', 'owner/name#7'], ['owner/name#7', 'owner/name#7#8'], [7, 8]]) {
      assert.equal(read({ prs }), undefined, JSON.stringify(prs))
    }
    assert.equal(read({ repos: ['owner/name'] }), undefined)
    assert.equal(read({ repos: ['owner/name', '../other'] }), undefined)
  })

  it('refuses a window that does not end after it starts, or a time that is none', () => {
    for (const change of [{ since: CANDIDATE.until }, { since: '2026-11-15T10:00:00Z' }, { until: 'soon' }, { since: '2026-10-15' }]) assert.equal(read(change), undefined, JSON.stringify(change))
  })
})

describe('what a writer names: the subject', () => {
  it('keeps each field that fits the contract, the repository in lower case', () => {
    assert.deepEqual(subjectOf({ repo: ' Owner/Name ', pr: 7, head: HEAD.toUpperCase() }), { repo: 'owner/name', pr: 7, head: HEAD })
  })

  it('reads a field it cannot take as unknown, so the event is never lost for it', () => {
    assert.deepEqual(subjectOf({ repo: 'not a repository', pr: '7', head: 'abc' }), { repo: null, pr: null, head: null })
    assert.deepEqual(subjectOf({ repo: 'owner/name', pr: 0 }), { repo: 'owner/name', pr: null, head: null })
    assert.deepEqual(subjectOf({}), { repo: null, pr: null, head: null })
    assert.notEqual(learningEvent({ at: AT, random: '0a1b2c3d', kind: 'refusal', source: EVENT.source, trust: 'computed', subject: subjectOf({ repo: '../x', pr: -1 }) }), undefined)
  })
})

describe('a finding as an event', () => {
  const known = { at: AT, random: '0a1b2c3d', plugin: 'pr-review', subject: subjectOf({ repo: 'Owner/Name', pr: 7, head: HEAD }), context: { session: 'abc-123', role: null } }

  it('reads a file as a path of the repository', () => {
    assert.equal(repoPath('./src/a.ts:12'), 'src/a.ts')
    assert.equal(repoPath('src/a.ts:12-14'), 'src/a.ts')
    assert.equal(repoPath('/clone/repo/src/a.ts', '/clone/repo/'), 'src/a.ts')
    for (const file of ['/elsewhere/a.ts', 'the whole diff', '../a.ts', '']) assert.equal(repoPath(file, '/clone/repo'), undefined)
    assert.equal(repoPath('/a.ts', '/'), undefined)
  })

  it('holds the code, the file as its path and the pointer a signature reads, in the trust of a review', () => {
    const event = findingEvent({ ...known, code: 'pr-review.finding', severity: 'critical', file: 'src/a.ts:3' })
    assert.deepEqual(parseLearningEvent(event), event)
    assert.equal(event?.kind, 'finding')
    assert.equal(event?.trust, 'review')
    assert.deepEqual(event?.subject, { repo: 'owner/name', pr: 7, head: HEAD })
    assert.deepEqual(event?.context, { role: null, mode: null, paths: ['src/a.ts'], languages: ['typescript'], session: 'abc-123' })
    assert.deepEqual(event?.evidence, [{ type: 'finding', severity: 'critical', file: 'src/a.ts' }])
    assert.equal(event && signatureOf(event), 'finding:pr-review.finding:critical:source:typescript')
  })

  it('keeps a finding whose severity is not the contract\'s, or whose file is no path, without the pointer', () => {
    const norms = findingEvent({ ...known, plugin: 'norms', code: 'norms.magic-values.warning', severity: 'warning', file: 'tests/a.test.ts' })
    assert.deepEqual(norms?.evidence, [])
    assert.equal(norms && signatureOf(norms), 'finding:norms.magic-values.warning:test:typescript')
    const lost = findingEvent({ ...known, code: 'pr-review.finding', severity: 'critical', file: 'the whole diff' })
    assert.deepEqual([lost?.evidence, lost?.context.paths], [[], []])
    assert.equal(findingEvent({ at: AT, random: '0a1b2c3d', plugin: 'norms', code: 'norms.agent.info', severity: 'info', file: 'a.md' })?.subject.pr, null)
  })

  it('answers nothing for a code the contract refuses', () => {
    assert.equal(findingEvent({ ...known, code: 'Not A Code', severity: 'critical', file: 'src/a.ts' }), undefined)
  })
})

describe('the operator\'s answer as an event', () => {
  const known = { at: AT, random: '0a1b2c3d', plugin: 'orchestrator' }
  const consent = [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }]
  const choices = [{ letter: 'A', text: 'split the pull request' }, { letter: 'B', text: 'keep it whole' }]

  it('reads a consent\'s answer as its kind, granted or refused', () => {
    assert.deepEqual(answerGiven('A : Accorder', { consent: { kind: 'e2e-waiver' }, choices: consent }), { asked: 'e2e-waiver', granted: true })
    assert.deepEqual(answerGiven('Refuser', { consent: { kind: 'e2e-waiver' }, choices: consent }), { asked: 'e2e-waiver', granted: false })
    assert.deepEqual(answerGiven('do as you see fit', { consent: { kind: 'auto-merge' }, choices: consent }), { asked: 'auto-merge', granted: false })
  })

  it('reads any other answer as the letter it opens with, beside the recommended one', () => {
    assert.deepEqual(answerGiven('b — keep it whole', { choices, recommended: 'A' }), { letter: 'B', recommended: 'A' })
    assert.deepEqual(answerGiven('neither, drop it', { choices, recommended: 'A' }), { letter: null, recommended: 'A' })
    assert.deepEqual(answerGiven('yes', {}), { letter: null, recommended: null })
  })

  it('names what was asked and how he answered in its code, in his trust, and none of his words', () => {
    const subject = subjectOf({ repo: 'Owner/Name', pr: 7 })
    const granted = answerEvent({ ...known, subject, context: { session: 'abc-123', role: 'orchestrator' }, given: { asked: 'e2e-waiver', granted: true }, ruling: 'orchestrator/round/q-1.json' })
    assert.deepEqual(parseLearningEvent(granted), granted)
    assert.deepEqual([granted?.kind, granted?.trust, granted?.source.code], ['answer', 'operator', 'orchestrator.answer.e2e-waiver.granted'])
    assert.deepEqual(granted?.subject, { repo: 'owner/name', pr: 7, head: null })
    assert.deepEqual(granted?.evidence, [{ type: 'ruling', path: 'orchestrator/round/q-1.json', line: 1 }])
    const code = (given: Parameters<typeof answerEvent>[0]['given']) => answerEvent({ ...known, given })?.source.code
    assert.equal(code({ asked: 'push', granted: false }), 'orchestrator.answer.push.refused')
    assert.equal(code({ letter: 'a', recommended: 'A' }), 'orchestrator.answer.recommended')
    assert.equal(code({ letter: 'B', recommended: 'A' }), 'orchestrator.answer.other')
    assert.equal(code({ letter: 'B', recommended: null }), 'orchestrator.answer.other')
    assert.equal(code({ letter: null, recommended: 'A' }), 'orchestrator.answer.own-words')
  })

  it('leaves out a ruling that is no path of the contract, and refuses a grant that is no code', () => {
    assert.deepEqual(answerEvent({ ...known, given: { letter: null, recommended: null }, ruling: '/home/op/.claude/round/q 1.json' })?.evidence, [])
    assert.deepEqual(answerEvent({ ...known, given: { letter: null, recommended: null }, ruling: null })?.evidence, [])
    assert.equal(answerEvent({ ...known, given: { asked: 'Not A Kind', granted: true } }), undefined)
  })
})

describe("the candidate's state", () => {
  const EVENTS = ['20261101T101500Z-0a1b2c3d', '20261102T101500Z-0a1b2c3d', '20261103T101500Z-0a1b2c3d']
  const CANDIDATE = {
    v: 1, signature: 'refusal:github.writing.rule', kind: 'refusal', code: 'github.writing.rule', severity: null, classes: [], languages: [],
    since: '2026-10-15T10:00:00Z', until: '2026-11-14T10:00:00Z', events: EVENTS, prs: ['owner/name#7', 'owner/name#8'], repos: ['owner/name'],
  }
  const CAUSE = { resolved: true, first_failure: 'the rules are read after the text is written', counterfactual: 'read first, the commit passes at once', evidence: [EVENTS[0]], alternatives: ['the rules changed between two commits'], confidence: 'medium' }
  const REMEDY = { scope: 'project', rung: 'guard', target: 'owner/name', proof: { type: 'test', path: 'hooks/tests/writing.test.ts' } }
  const AT = '2026-11-14T11:00:00Z'
  const candidate = parseCandidate(CANDIDATE)
  assert.ok(candidate)
  const judge = (change: Record<string, unknown> = {}) => judged(candidate, { signature: CANDIDATE.signature, cause: CAUSE, remedy: REMEDY, ...change }, AT)
  const proposed = judge()
  assert.ok(typeof proposed !== 'string', String(proposed))

  it('a judgment with its cause and its remedy is a proposed state that reads back whole', () => {
    assert.deepEqual(proposed, { v: 1, signature: CANDIDATE.signature, state: 'proposed', at: AT, candidate: CANDIDATE, cause: CAUSE, remedy: REMEDY, pr: null, ruling: null })
    assert.deepEqual(parseCandidateState(JSON.parse(JSON.stringify(proposed))), proposed)
    assert.equal(parseCandidateState({ ...proposed, scope: 'method' }), undefined)
    assert.equal(parseCandidateState({ ...proposed, v: 2 }), undefined)
    assert.equal(parseCandidateState({ ...proposed, signature: 'refusal:github.other.rule' }), undefined)
  })

  it('refuses a cause without a part of its claim, and evidence that is no event of the candidate', () => {
    for (const part of ['first_failure', 'counterfactual', 'evidence', 'alternatives', 'confidence']) {
      const { [part]: _dropped, ...short } = CAUSE as Record<string, unknown>
      assert.equal(typeof judge({ cause: short }), 'string', part)
    }
    for (const change of [{ evidence: [] }, { evidence: ['20261104T101500Z-0a1b2c3d'] }, { alternatives: [] }, { confidence: 'certain' }, { first_failure: ' ' }, { counterfactual: 'x'.repeat(CANDIDATE_STATE_CONTRACT.text_max + 1) }, { resolved: 'yes' }]) {
      assert.equal(typeof judge({ cause: { ...CAUSE, ...change } }), 'string', JSON.stringify(change))
    }
  })

  it('an unresolved cause names the observation that would have decided, and has no remedy', () => {
    const cause = { resolved: false, observation: 'the step that wrote the text, which no event points at' }
    const unresolved = judge({ cause, remedy: null })
    assert.ok(typeof unresolved !== 'string')
    assert.equal(unresolved.state, 'unresolved')
    assert.match(String(judge({ cause })), /unresolved one has none/)
    assert.match(String(judge({ remedy: null })), /resolved cause has a remedy/)
    assert.equal(typeof judge({ cause: { resolved: false }, remedy: null }), 'string')
    assert.equal(parseCandidateState({ ...unresolved, state: 'proposed' }), undefined)
  })

  it('refuses a remedy without its scope, its rung, its target or its proof, and a proof that is not its rung\'s', () => {
    for (const part of ['scope', 'rung', 'target', 'proof']) {
      const { [part]: _dropped, ...short } = REMEDY as Record<string, unknown>
      assert.equal(typeof judge({ remedy: short }), 'string', part)
    }
    const bad = [{ scope: 'team' }, { rung: 'reminder' }, { target: 'name' }, { proof: { type: 'test', path: '../x.ts' } }, { proof: { type: 'eval-case', case: 'writing-rule' } }, { rung: 'prompt-rule' }, { proof: { type: 'none' } }]
    for (const change of bad) assert.equal(typeof judge({ remedy: { ...REMEDY, ...change } }), 'string', JSON.stringify(change))
    assert.ok(typeof judge({ remedy: { ...REMEDY, rung: 'prompt-rule', proof: { type: 'eval-case', case: 'writing-rule' } } }) !== 'string')
    assert.equal(typeof judge({ signature: 'refusal:github.other.rule' }), 'string')
  })

  it('places a scope by the candidate\'s repositories and kind', () => {
    const wide = { ...candidate, repos: ['owner/name', 'owner/other'] }
    assert.deepEqual(CANDIDATE_STATE_CONTRACT.scopes.map(scope => scopeFits(candidate, scope)), [true, false, false, false])
    assert.deepEqual(CANDIDATE_STATE_CONTRACT.scopes.map(scope => scopeFits(wide, scope)), [false, true, true, false])
    assert.equal(scopeFits({ ...candidate, kind: 'answer' }, 'personal'), true)
    assert.match(String(judge({ remedy: { ...REMEDY, scope: 'method' } })), /do not place a lesson at the scope method/)
    assert.match(String(judge({ remedy: { ...REMEDY, target: 'owner/other' } })), /lands in the repository of its events, owner\/name/)
  })

  it('moves to merged with its pull request, to rejected with its ruling, and refuses either without', () => {
    assert.match(String(moved(proposed, { state: 'merged' }, AT)), /names its pull request/)
    const opened = moved(proposed, { state: 'proposed', pr: 'owner/name#9' }, AT)
    assert.ok(typeof opened !== 'string')
    const merged = moved(opened, { state: 'merged' }, '2026-11-15T11:00:00Z')
    assert.ok(typeof merged !== 'string')
    assert.deepEqual([merged.state, merged.pr, merged.at], ['merged', 'owner/name#9', '2026-11-15T11:00:00Z'])
    const ineffective = moved(merged, { state: 'ineffective' }, AT)
    assert.ok(typeof ineffective !== 'string')
    assert.match(String(moved(proposed, { state: 'rejected' }, AT)), /holds the ruling/)
    const rejected = moved(proposed, { state: 'rejected', ruling: 'not worth a guard' }, AT)
    assert.ok(typeof rejected !== 'string')
    assert.equal(rejected.ruling, 'not worth a guard')
    const again = moved(rejected, { state: 'proposed' }, AT)
    assert.ok(typeof again !== 'string')
    assert.equal(again.ruling, null)
    assert.equal(typeof moved(proposed, { state: 'merged', pr: '#9' }, AT), 'string')
    assert.equal(typeof moved(proposed, { state: 'merged', pr: 'owner/name#9' }, 'soon'), 'string')
  })

  it('a candidate is judged once, and again when rejected or unresolved only at twice its events', () => {
    const rejected = moved(proposed, { state: 'rejected', ruling: 'no' }, AT)
    const unresolved = judge({ cause: { resolved: false, observation: 'the step' }, remedy: null })
    assert.ok(typeof rejected !== 'string' && typeof unresolved !== 'string')
    const grown = (count: number) => ({ ...candidate, events: Array.from({ length: count }, (_, i) => `2026110${i + 1}T101500Z-0a1b2c3d`) })
    assert.equal(isDue(candidate, undefined), true)
    assert.equal(isDue(grown(9), proposed), false)
    for (const state of [rejected, unresolved]) {
      assert.equal(isDue(grown(5), state), false)
      assert.equal(isDue(grown(6), state), true)
    }
    const merged = moved(proposed, { state: 'merged', pr: 'owner/name#9' }, AT)
    assert.ok(typeof merged !== 'string')
    assert.equal(isDue(candidate, merged), false)
    const reopened = moved(merged, { state: 'ineffective' }, AT)
    assert.ok(typeof reopened !== 'string')
    assert.equal(isDue(candidate, reopened), true)
  })

  it('names the state file by the signature, under the learning plugin\'s directory, and the command that starts a retrospective', () => {
    assert.equal(candidateStateDir('/c'), '/c/learning/candidates')
    assert.equal(candidateStateFile('finding:pr-review.finding:critical:source:python'), 'finding_pr-review.finding_critical_source_python.json')
    assert.deepEqual(retrospectiveStartArgv('/p/learning/', '/c'), ['node', '--experimental-strip-types', '--no-warnings', '/p/learning/skills/learning/scripts/retrospective.ts', 'start', '--config', '/c'])
    assert.equal(typeof readCandidateState(null), 'string')
    assert.equal(typeof readCandidateState({ ...proposed, candidate: null }), 'string')
  })
})

describe('a learned guard: warn, then enforce', () => {
  const EVENTS = ['20261101T101500Z-0a1b2c3d', '20261102T101500Z-0a1b2c3d', '20261103T101500Z-0a1b2c3d']
  const candidate = parseCandidate({
    v: 1, signature: 'refusal:github.writing.rule', kind: 'refusal', code: 'github.writing.rule', severity: null, classes: [], languages: [],
    since: '2026-10-15T10:00:00Z', until: '2026-11-14T10:00:00Z', events: EVENTS, prs: ['owner/name#7', 'owner/name#8'], repos: ['owner/name'],
  })
  assert.ok(candidate)
  const cause = { resolved: true, first_failure: 'the rules are read after the text is written', counterfactual: 'read first, the commit passes at once', evidence: [EVENTS[0]], alternatives: ['the rules changed'], confidence: 'medium' }
  const stateOf = (rung: string, pr: string | null) => {
    const proposed = judged(candidate, { signature: candidate.signature, cause, remedy: { scope: 'project', rung, target: 'owner/name', proof: { type: 'test', path: 'hooks/tests/a.test.ts' } } }, '2026-11-14T11:00:00Z')
    assert.ok(typeof proposed !== 'string', String(proposed))
    if (pr === null) return proposed
    const merged = moved(proposed, { state: 'merged', pr }, '2026-11-15T11:00:00Z')
    assert.ok(typeof merged !== 'string', String(merged))
    return merged
  }
  const right = (n: number): WouldBeVerdict[] => Array.from({ length: n }, () => 'right')

  it('reads a would-be refusal as right when its pull request was corrected, wrong when it merged as it was, open before', () => {
    assert.equal(wouldBeVerdict({ merged: true, corrected: true }), 'right')
    assert.equal(wouldBeVerdict({ merged: false, corrected: true }), 'right')
    assert.equal(wouldBeVerdict({ merged: true, corrected: false }), 'wrong')
    assert.equal(wouldBeVerdict({ merged: false, corrected: false }), 'open')
  })

  it('is enforceable at nine in ten of at least five decided would-be refusals, open ones left out', () => {
    assert.equal(LEARNED_GUARD_CONTRACT.min_decided, 5)
    assert.equal(isEnforceable(tallyOf(right(5))), true)
    assert.equal(isEnforceable(tallyOf([...right(4), 'open', 'open'])), false)
    assert.equal(isEnforceable(tallyOf([...right(9), 'wrong'])), true)
    assert.equal(isEnforceable(tallyOf([...right(8), 'wrong'])), false)
    assert.deepEqual(tallyOf(['right', 'wrong', 'open', 'open']), { right: 1, wrong: 1, open: 2 })
  })

  it('a guard the retrospective proposed warns until it merged and its would-be refusals reach the precision, then enforces', () => {
    assert.equal(guardPhase(stateOf('guard', null), right(10)), 'warn')
    assert.equal(guardPhase(stateOf('guard', 'owner/name#9'), right(4)), 'warn')
    assert.equal(guardPhase(stateOf('guard', 'owner/name#9'), right(5)), 'enforce')
    assert.equal(guardPhase(stateOf('test', 'owner/name#9'), right(5)), undefined)
  })

  it('in warn the call goes through and leaves an escape; enforced it is refused and leaves a refusal', () => {
    assert.deepEqual(learnedDecision('warn', 'github: no'), { deny: undefined, kind: 'escape' })
    assert.deepEqual(learnedDecision('enforce', 'github: no'), { deny: 'github: no', kind: 'refusal' })
  })

  it("gathers a guard's would-be refusals by the pull request each names", () => {
    const escape = (random: string, pr: number | null, code = 'github.learned.rule') => learningEvent({
      at: AT, random, kind: 'escape', source: { plugin: 'github', code }, trust: 'computed', evidence: [{ type: 'refusal', code }], subject: subjectOf({ repo: 'owner/name', pr }),
    })
    const events = [escape('00000001', 7), escape('00000002', 7), escape('00000003', 8), escape('00000004', null), escape('00000005', 7, 'github.other.rule')].filter(e => e !== undefined)
    const byPr = wouldBeRefusals(events, 'github.learned.rule')
    assert.deepEqual([...byPr.keys()], ['owner/name#7', 'owner/name#8'])
    assert.equal(byPr.get('owner/name#7')?.length, 2)
  })
})

describe('the outcome of a would-be refusal, and forgetting', () => {
  const DAY = 86_400_000
  const EVENTS = ['20261101T101500Z-0a1b2c3d', '20261102T101500Z-0a1b2c3d', '20261103T101500Z-0a1b2c3d']
  const candidate = parseCandidate({
    v: 1, signature: 'refusal:github.writing.rule', kind: 'refusal', code: 'github.writing.rule', severity: null, classes: [], languages: [],
    since: '2026-10-15T10:00:00Z', until: '2026-11-14T10:00:00Z', events: EVENTS, prs: ['owner/name#7', 'owner/name#8'], repos: ['owner/name'],
  })
  assert.ok(candidate)
  const cause = { resolved: true, first_failure: 'the rules are read after the text', counterfactual: 'read first, it passes', evidence: [EVENTS[0]], alternatives: ['the rules changed'], confidence: 'low' }
  const MERGED_AT = '2026-11-01T00:00:00Z'
  const stateOf = (rung: string, merged = true) => {
    const proposed = judged(candidate, { signature: candidate.signature, cause, remedy: { scope: 'project', rung, target: 'owner/name', proof: { type: 'test', path: 'hooks/tests/a.test.ts' } } }, '2026-10-30T00:00:00Z')
    assert.ok(typeof proposed !== 'string', String(proposed))
    if (!merged) return proposed
    const done = moved(proposed, { state: 'merged', pr: 'owner/name#9' }, MERGED_AT)
    assert.ok(typeof done !== 'string', String(done))
    return done
  }
  const refusalAt = (ms: number, n: number, code = 'github.writing.rule') => learningEvent({
    at: `${new Date(ms).toISOString().slice(0, 19)}Z`, random: n.toString(16).padStart(8, '0'), kind: 'refusal', source: { plugin: 'github', code }, trust: 'computed',
  })
  const merged = Date.parse(MERGED_AT)
  const many = (from: number, count: number, code?: string) => Array.from({ length: count }, (_, i) => refusalAt(from + i * 3_600_000, i + from / 1000, code)).filter(e => e !== undefined)

  it('reads a pull request corrected when a commit follows the refusal and comes before the merge', () => {
    assert.deepEqual(prOutcomeOf({ mergedAt: null, commits: ['2026-11-01T00:00:00Z'] }, '2026-11-01T01:00:00Z'), { merged: false, corrected: false })
    assert.deepEqual(prOutcomeOf({ mergedAt: null, commits: ['2026-11-01T02:00:00Z'] }, '2026-11-01T01:00:00Z'), { merged: false, corrected: true })
    assert.deepEqual(prOutcomeOf({ mergedAt: '2026-11-01T03:00:00Z', commits: ['2026-11-01T00:00:00Z'] }, '2026-11-01T01:00:00Z'), { merged: true, corrected: false })
    assert.deepEqual(prOutcomeOf({ mergedAt: '2026-11-01T03:00:00Z', commits: ['2026-11-01T02:00:00Z'] }, '2026-11-01T01:00:00Z'), { merged: true, corrected: true })
    assert.deepEqual(prOutcomeOf({ mergedAt: '2026-11-01T03:00:00Z', commits: ['2026-11-01T04:00:00Z'] }, '2026-11-01T01:00:00Z'), { merged: true, corrected: false })
  })

  it('a guard is proved wrong once enough would-be refusals are decided and too few are right', () => {
    assert.equal(provedWrong(tallyOf(['right', 'wrong', 'wrong'])), false)
    assert.equal(provedWrong({ right: 3, wrong: 2, open: 9 }), true)
    assert.equal(provedWrong({ right: 9, wrong: 1, open: 0 }), false)
  })

  it('a merged remedy waits a window, then holds when its signature fell by half and is ineffective when it did not', () => {
    assert.equal(FORGET_CONTRACT.fall_ratio, 0.5)
    assert.equal(afterLanding(stateOf('test', false), [], merged + 40 * DAY), undefined)
    assert.deepEqual(afterLanding(stateOf('test'), [], merged + 10 * DAY), { verdict: 'pending', due: '2026-12-01T00:00:00Z' })
    const before = many(merged - 10 * DAY, 4)
    assert.deepEqual(afterLanding(stateOf('test'), [...before, ...many(merged + DAY, 2)], merged + 31 * DAY), { verdict: 'held', before: 4, after: 2 })
    assert.deepEqual(afterLanding(stateOf('test'), [...before, ...many(merged + DAY, 3)], merged + 31 * DAY), { verdict: 'ineffective', before: 4, after: 3 })
    // Another signature, and events outside both windows, are not counted.
    const other = [...many(merged + DAY, 5, 'github.other.rule'), ...many(merged - 40 * DAY, 5), ...many(merged + 31 * DAY, 5)]
    assert.deepEqual(afterLanding(stateOf('test'), [...before, ...other], merged + 62 * DAY), { verdict: 'held', before: 4, after: 0 })
  })

  it('a merged learned guard with no event under its code over two windows is silent; any other is not', () => {
    const now = merged + 61 * DAY
    assert.equal(isSilentGuard(stateOf('guard'), [], now), true)
    assert.equal(isSilentGuard(stateOf('guard'), many(merged + 50 * DAY, 1), now), false)
    assert.equal(isSilentGuard(stateOf('guard'), many(merged + 50 * DAY, 1, 'github.other.rule'), now), true)
    assert.equal(isSilentGuard(stateOf('guard'), [], merged + 59 * DAY), false)
    assert.equal(isSilentGuard(stateOf('test'), [], now), false)
    assert.equal(isSilentGuard(stateOf('guard', false), [], now), false)
  })
})
