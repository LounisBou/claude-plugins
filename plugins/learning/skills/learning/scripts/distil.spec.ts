// The distiller: the candidates code computes from the journals' events, with no model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answerEvent, findingEvent, journalDir, learningEvent, parseCandidate, subjectOf, type Evidence, type LearningEvent, type LearningKind, type Trust } from '../../../core/learning.ts'
import { distil, DISTIL_USAGE, run } from './distil.ts'

const NOW = Date.parse('2026-11-14T10:00:00Z')
const DAY = 86_400_000

interface Shape {
  readonly code?: string
  readonly kind?: LearningKind
  readonly days?: number
  readonly repo?: string | null
  readonly pr?: number | null
  readonly paths?: readonly string[]
  readonly evidence?: readonly Evidence[]
  readonly trust?: Trust
}

let serial = 0

function event(shape: Shape = {}): LearningEvent {
  const code = shape.code ?? 'github.writing.rule'
  const built = learningEvent({
    kind: shape.kind ?? 'refusal',
    at: new Date(NOW - (shape.days ?? 1) * DAY).toISOString().replace('.000Z', 'Z'),
    random: (serial++).toString(16).padStart(8, '0'),
    source: { plugin: code.slice(0, code.indexOf('.')), code },
    subject: { repo: shape.repo === undefined ? 'acme/app' : shape.repo, pr: shape.pr === undefined ? 1 : shape.pr },
    context: { paths: shape.paths ?? [] },
    evidence: shape.evidence ?? [],
    trust: shape.trust ?? 'computed',
  })
  assert.ok(built)
  return built
}

const three = (shape: Shape = {}): LearningEvent[] => [event({ ...shape, pr: 1 }), event({ ...shape, pr: 1 }), event({ ...shape, pr: 2 })]
const signatures = (events: readonly LearningEvent[]): string[] => distil(events, NOW).map(c => c.signature)

// The fixture: two signatures that reach the thresholds, in two repositories, among events that do not.
const critical: Evidence = { type: 'finding', severity: 'critical', file: 'src/a.ts' }
const FIXTURE: readonly LearningEvent[] = [
  event({ pr: 1 }), event({ pr: 1 }), event({ pr: 2 }), event({ repo: 'acme/web', pr: 9 }), event({ repo: null, pr: null }),
  event({ kind: 'finding', code: 'pr-review.finding', trust: 'review', paths: ['src/a.ts'], evidence: [critical], pr: 3 }),
  event({ kind: 'finding', code: 'pr-review.finding', trust: 'review', paths: ['src/b.ts'], evidence: [critical], pr: 4 }),
  event({ kind: 'finding', code: 'pr-review.finding', trust: 'review', paths: ['src/c.ts'], evidence: [critical], pr: 4 }),
  event({ kind: 'finding', code: 'pr-review.finding', trust: 'review', paths: ['src/a.test.ts'], evidence: [critical], pr: 5 }),
  event({ kind: 'escape', code: 'orchestrator.kill.foreign', pr: 6 }), event({ kind: 'escape', code: 'orchestrator.kill.foreign', pr: 7 }),
  event({ code: 'github.ready.no-record', days: 40, pr: 1 }), event({ code: 'github.ready.no-record', days: 41, pr: 2 }), event({ code: 'github.ready.no-record', pr: 3 }),
]

test('the fixture gives its candidates: the signature and its parts, the window, the events, the pull requests and the repositories, in order', () => {
  const ids = (from: number, to: number): string[] => FIXTURE.slice(from, to).map(e => e.id)
  assert.deepEqual(distil(FIXTURE, NOW), [
    {
      v: 1, signature: 'finding:pr-review.finding:critical:source:typescript', kind: 'finding', code: 'pr-review.finding', severity: 'critical', classes: ['source'], languages: ['typescript'],
      since: '2026-10-15T10:00:00Z', until: '2026-11-14T10:00:00Z', events: ids(5, 8), prs: ['acme/app#3', 'acme/app#4'], repos: ['acme/app'],
    },
    {
      v: 1, signature: 'refusal:github.writing.rule', kind: 'refusal', code: 'github.writing.rule', severity: null, classes: [], languages: [],
      since: '2026-10-15T10:00:00Z', until: '2026-11-14T10:00:00Z', events: ids(0, 5), prs: ['acme/app#1', 'acme/app#2', 'acme/web#9'], repos: ['acme/app', 'acme/web'],
    },
  ])
})

test('the same events give the same candidates in any order, each one a candidate of the contract', () => {
  const candidates = distil(FIXTURE, NOW)
  assert.deepEqual(distil([...FIXTURE].reverse(), NOW), candidates)
  assert.deepEqual(distil([...FIXTURE.slice(7), ...FIXTURE.slice(0, 7)], NOW), candidates)
  assert.deepEqual(candidates.map(c => parseCandidate(JSON.parse(JSON.stringify(c)))), candidates)
})

test('a cluster is a candidate at three events from two pull requests, not under either', () => {
  assert.deepEqual(signatures(three()), ['refusal:github.writing.rule'])
  assert.deepEqual(signatures(three().slice(1)), [])
  assert.deepEqual(signatures([event(), event(), event()]), [])
})

test('the same pull request number in two repositories is two pull requests', () => {
  assert.deepEqual(distil([event({ pr: 1 }), event({ pr: 1 }), event({ repo: 'acme/web', pr: 1 })], NOW).map(c => c.prs), [['acme/app#1', 'acme/web#1']])
})

test('an event that names no pull request counts as an event and as no pull request', () => {
  const bare = { repo: null, pr: null }
  assert.deepEqual(signatures([event(bare), event(bare), event(bare)]), [])
  assert.deepEqual(signatures([event({ pr: null }), event({ repo: null, pr: 2 }), event({ pr: 1 })]), [])
  assert.deepEqual(distil([event(bare), event({ pr: 1 }), event({ pr: 2 })], NOW).map(c => [c.events.length, c.prs.length]), [[3, 2]])
})

test('an event exactly a window old is inside the window, an older one is not', () => {
  assert.deepEqual(signatures([event({ days: 30, pr: 1 }), event({ pr: 1 }), event({ pr: 2 })]), ['refusal:github.writing.rule'])
  assert.deepEqual(signatures([event({ days: 31, pr: 1 }), event({ pr: 1 }), event({ pr: 2 })]), [])
})

test('events of another code, kind, severity, path class or language are another cluster', () => {
  const finding = { kind: 'finding', code: 'pr-review.finding', trust: 'review', paths: ['src/a.ts'], evidence: [critical] } as const
  const others: Shape[] = [
    { ...finding, code: 'norms.finding' },
    { ...finding, kind: 'escape' },
    { ...finding, evidence: [{ type: 'finding', severity: 'important', file: 'src/a.ts' }] },
    { ...finding, paths: ['tests/a.ts'] },
    { ...finding, paths: ['src/a.py'] },
  ]
  for (const other of others) assert.deepEqual(signatures([event({ ...finding, pr: 1 }), event({ ...finding, pr: 2 }), event({ ...other, pr: 3 })]), [], JSON.stringify(other))
  assert.equal(signatures([event({ ...finding, pr: 1 }), event({ ...finding, pr: 2 }), event({ ...finding, paths: ['lib/z.ts'], pr: 3 })]).length, 1)
})

test('a guard that observes clusters by its code like one that refuses: the orchestrator\'s escapes, github\'s refusals', () => {
  assert.deepEqual(signatures([...three({ kind: 'escape', code: 'orchestrator.kill.foreign' }), ...three({ code: 'github.draft.leave' })]), ['escape:orchestrator.kill.foreign', 'refusal:github.draft.leave'])
})

test('an external event forms no cluster; a computed, an operator\'s and a review\'s do', () => {
  assert.deepEqual(signatures(three({ trust: 'external' })), [])
  assert.deepEqual(signatures([event({ trust: 'external', pr: 1 }), event({ pr: 1 }), event({ pr: 2 })]), [])
  for (const trust of ['computed', 'operator', 'review'] as const) assert.equal(signatures(three({ trust })).length, 1, trust)
})

test("a reviewer's thread /norms:learn checked counts, external as it is: its code is the one the contract names", () => {
  const thread: Shape = { kind: 'finding', code: 'norms.thread', trust: 'external', paths: ['src/a.ts'] }
  assert.deepEqual(signatures(three(thread)), ['finding:norms.thread:source:typescript'])
  assert.deepEqual(signatures(three({ ...thread, code: 'norms.other' })), [])
})

function scratch(work: (config: string) => void): void {
  const config = mkdtempSync(join(tmpdir(), 'learning-distil-'))
  try {
    work(config)
  } finally {
    rmSync(config, { recursive: true, force: true })
  }
}

function capture(): { outs: string[]; errs: string[]; deps: { out: (l: string) => void; err: (l: string) => void; now: () => number } } {
  const outs: string[] = []
  const errs: string[] = []
  return { outs, errs, deps: { out: l => outs.push(l), err: l => errs.push(l), now: () => NOW } }
}

test('run prints one line per candidate of the journals under the configuration directory, across plugins, and nothing for none', () => {
  scratch(config => {
    const empty = capture()
    assert.equal(run(['--config', config], empty.deps), 0)
    assert.deepEqual([empty.outs, empty.errs], [[], []])
    for (const e of FIXTURE) {
      mkdirSync(journalDir(config, e.source.plugin), { recursive: true })
      writeFileSync(join(journalDir(config, e.source.plugin), `${e.id}.json`), JSON.stringify(e))
    }
    writeFileSync(join(journalDir(config, 'github'), 'foreign.json'), '{"v":1,"command":"git push"}')
    const { outs, errs, deps } = capture()
    assert.equal(run(['--config', config], deps), 0)
    assert.deepEqual(outs.map(line => JSON.parse(line)), distil(FIXTURE, NOW))
    assert.deepEqual(errs, [])
  })
})

test('run proposes nothing and says so when a journal cannot be read', () => {
  scratch(config => {
    for (const e of three()) {
      mkdirSync(journalDir(config, 'github'), { recursive: true })
      writeFileSync(join(journalDir(config, 'github'), `${e.id}.json`), JSON.stringify(e))
    }
    mkdirSync(join(config, 'norms'))
    writeFileSync(journalDir(config, 'norms'), 'a file where the journal directory should be')
    const { outs, errs, deps } = capture()
    assert.equal(run(['--config', config], deps), 1)
    assert.deepEqual([outs.length, errs.length], [0, 1])
  })
})

test('run refuses a call without a configuration directory', () => {
  const { errs, deps } = capture()
  assert.deepEqual([run([], deps), run(['--config'], deps), run(['--config', 'a', 'b'], deps)], [2, 2, 2])
  assert.deepEqual(errs, [DISTIL_USAGE, DISTIL_USAGE, DISTIL_USAGE])
})

test('the findings and the answers the writers build cluster by what found them and by what was answered, across pull requests', () => {
  const known = (pr: number) => ({
    at: new Date(NOW - DAY).toISOString().replace('.000Z', 'Z'), random: (serial++).toString(16).padStart(8, '0'),
    subject: subjectOf({ repo: 'Acme/App', pr }),
  })
  const built = [
    ...[1, 1, 2].map(pr => findingEvent({ ...known(pr), plugin: 'norms', code: 'norms.magic-values.error', severity: 'error', file: 'src/a.ts' })),
    ...[1, 2, 3].map(pr => findingEvent({ ...known(pr), plugin: 'pr-review', code: 'pr-review.finding', severity: 'critical', file: 'src/b.ts:4' })),
    ...[1, 2, 2].map(pr => answerEvent({ ...known(pr), plugin: 'orchestrator', given: { asked: 'e2e-waiver', granted: false } })),
    // A subject no writer read names no pull request: three such events are no candidate.
    ...[0, 0, 0].map(() => findingEvent({ at: known(1).at, random: (serial++).toString(16).padStart(8, '0'), plugin: 'norms', code: 'norms.naming.warning', severity: 'warning', file: 'src/a.ts' })),
  ]
  const events = built.flatMap(event => event ?? [])
  assert.equal(events.length, built.length)
  assert.deepEqual(distil(events, NOW).map(candidate => [candidate.signature, candidate.prs]), [
    ['answer:orchestrator.answer.e2e-waiver.refused', ['acme/app#1', 'acme/app#2']],
    ['finding:norms.magic-values.error:source:typescript', ['acme/app#1', 'acme/app#2']],
    ['finding:pr-review.finding:critical:source:typescript', ['acme/app#1', 'acme/app#2', 'acme/app#3']],
  ])
})
