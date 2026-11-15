// Forget and check over fixtures: a merged remedy waits its window, then holds or reopens its
// candidate; a learned guard silent over two windows is proposed for removal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { candidateStateDir, candidateStateFile, journalDir, judged, learningEvent, moved, parseCandidate, type CandidateState, type LearningEvent } from '../../../core/learning.ts'
import { check, FORGET_USAGE, run } from './forget.ts'

const DAY = 86_400_000
const CODE = 'github.writing.rule'
const MERGED_AT = '2026-11-01T00:00:00Z'
const MERGED = Date.parse(MERGED_AT)
let serial = 0

function refusal(ms: number, code = CODE): LearningEvent {
  const event = learningEvent({
    at: `${new Date(ms).toISOString().slice(0, 19)}Z`, random: (serial++).toString(16).padStart(8, '0'), kind: 'refusal', source: { plugin: 'github', code }, trust: 'computed',
  })
  assert.ok(event)
  return event
}

const spread = (from: number, count: number, code?: string) => Array.from({ length: count }, (_, i) => refusal(from + i * 3_600_000, code))

function state(rung: string, merged = true): CandidateState {
  const events = ['20261001T101500Z-0a1b2c3d', '20261002T101500Z-0a1b2c3d', '20261003T101500Z-0a1b2c3d']
  const candidate = parseCandidate({
    v: 1, signature: `refusal:${CODE}`, kind: 'refusal', code: CODE, severity: null, classes: [], languages: [],
    since: '2026-09-15T10:00:00Z', until: '2026-10-15T10:00:00Z', events, prs: ['acme/app#7', 'acme/app#8'], repos: ['acme/app'],
  })
  assert.ok(candidate)
  const cause = { resolved: true, first_failure: 'a step', counterfactual: 'it passes', evidence: [events[0]], alternatives: ['another'], confidence: 'low' }
  const proposed = judged(candidate, { signature: candidate.signature, cause, remedy: { scope: 'project', rung, target: 'acme/app', proof: { type: 'test', path: 'hooks/tests/a.test.ts' } } }, '2026-10-20T00:00:00Z')
  assert.ok(typeof proposed !== 'string', String(proposed))
  if (!merged) return proposed
  const done = moved(proposed, { state: 'merged', pr: 'acme/app#9' }, MERGED_AT)
  assert.ok(typeof done !== 'string', String(done))
  return done
}

test('a remedy not merged is not checked; one merged under a window ago waits its date', () => {
  assert.deepEqual(check([state('test', false)], [], MERGED + 40 * DAY), { lines: [], reopened: [] })
  assert.deepEqual(check([state('test')], [], MERGED + 5 * DAY).lines, [`  refusal:${CODE}: test acme/app#9 merged at ${MERGED_AT}, checked at 2026-12-01T00:00:00Z`])
})

test('a signature that fell by half holds; one that did not reopens its candidate, ineffective', () => {
  const before = spread(MERGED - 10 * DAY, 4)
  const held = check([state('test')], [...before, ...spread(MERGED + DAY, 2)], MERGED + 31 * DAY)
  assert.deepEqual(held, { lines: [`  refusal:${CODE}: test acme/app#9 held, 4 events before its merge, 2 after`], reopened: [] })
  const kept = check([state('test')], [...before, ...spread(MERGED + DAY, 3)], MERGED + 31 * DAY)
  assert.equal(kept.reopened.length, 1)
  assert.equal(kept.reopened[0]?.state, 'ineffective')
  assert.equal(kept.reopened[0]?.pr, 'acme/app#9')
  assert.match(kept.lines[0] ?? '', /ineffective, 4 events before its merge, 3 after: reopened, its remedy proposed for removal/)
})

test('a learned guard silent over two windows is proposed for removal; one that still answers is not', () => {
  const now = MERGED + 61 * DAY
  const before = spread(MERGED - 10 * DAY, 2)
  assert.match(check([state('guard')], before, now).lines.join('\n'), /learned guard acme\/app#9 silent over two windows, proposed for removal/)
  assert.doesNotMatch(check([state('guard')], [...before, refusal(MERGED + 50 * DAY)], now).lines.join('\n'), /silent/)
  assert.doesNotMatch(check([state('test')], before, now).lines.join('\n'), /silent/)
})

test('the command line keeps the reopened state, says when there is nothing to check, and refuses any other call', () => {
  const config = mkdtempSync(join(tmpdir(), 'learning-forget-'))
  const outs: string[] = []
  const errs: string[] = []
  const deps = { out: (l: string) => outs.push(l), err: (l: string) => errs.push(l), now: () => MERGED + 31 * DAY }
  try {
    assert.equal(run(['--config', config], deps), 0)
    assert.equal(outs.at(-1), 'learning forget: no merged remedy to check.')
    mkdirSync(journalDir(config, 'github'), { recursive: true })
    for (const e of [...spread(MERGED - 10 * DAY, 2), ...spread(MERGED + DAY, 2)]) writeFileSync(join(journalDir(config, 'github'), `${e.id}.json`), JSON.stringify(e))
    mkdirSync(candidateStateDir(config), { recursive: true })
    const file = join(candidateStateDir(config), candidateStateFile(`refusal:${CODE}`))
    writeFileSync(file, JSON.stringify(state('test')))
    assert.equal(run(['--config', config], deps), 0)
    assert.match(outs.at(-1) ?? '', /reopened/)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).state, 'ineffective')
    // Reopened, it is no merged remedy any more.
    assert.equal(run(['--config', config], deps), 0)
    assert.equal(outs.at(-1), 'learning forget: no merged remedy to check.')
    assert.equal(run(['--config'], deps), 2)
    assert.equal(errs.at(-1), FORGET_USAGE)
    rmSync(candidateStateDir(config), { recursive: true })
    writeFileSync(candidateStateDir(config), '')
    assert.equal(run(['--config', config], deps), 1)
    assert.match(errs.at(-1) ?? '', /nothing is done/)
  } finally {
    rmSync(config, { recursive: true, force: true })
  }
})
