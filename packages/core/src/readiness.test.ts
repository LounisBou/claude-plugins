import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePrRecord, type Kind, type PrRecord } from './pr-record.ts'
import { blocks, carriesAcross, CI_CHECK, heldBy, missingEvidence, PLAN_NEEDS, WAIVABLE, type HeadEvidence } from './readiness.ts'

const record = (kind: Kind, result: string, producer = 'orchestrator'): PrRecord => {
  const read = parsePrRecord({ v: 1, repo: 'o/n', pr: 1, head: 'a'.repeat(40), kind, result, producer, detail: '', session: 's', at: '2026-11-14T00:00:00Z' })
  assert.ok(read)
  return read
}

const evidence = (change: Partial<HeadEvidence> = {}): HeadEvidence => ({
  latest: new Map(), excused: new Set(), required: new Set(), carried: new Set(), ciGreen: true, ...change,
})

const conditions = (e: HeadEvidence) => missingEvidence(e).map((m) => m.condition + (m.record ? ':' + m.record.result : ''))

describe('readiness', () => {
  it('is met by a passing review and E2E with CI green, norms on demand', () => {
    assert.deepEqual(conditions(evidence({ latest: new Map<Kind, PrRecord>([['review', record('review', 'pass')], ['e2e', record('e2e', 'pass')]]) })), [])
  })

  it('names each condition missing, the failed record with it, CI held by GitHub', () => {
    const e = evidence({ latest: new Map<Kind, PrRecord>([['review', record('review', 'fail')]]), ciGreen: false })
    assert.deepEqual(conditions(e), ['review:fail', 'e2e', 'ci'])
    assert.deepEqual(heldBy(missingEvidence(e), 'gate').map((m) => m.condition), ['review', 'e2e'])
    assert.deepEqual(heldBy(missingEvidence(e), 'github').map((m) => m.condition), ['ci'])
  })

  it('takes the orchestrator\'s acceptance as a passing review', () => {
    assert.deepEqual(conditions(evidence({ latest: new Map<Kind, PrRecord>([['review', record('review', 'accepted')]]), excused: new Set(['e2e']) })), [])
  })

  it('requires norms only where the plan requires them, and a failed run blocks anyway', () => {
    const base = { latest: new Map<Kind, PrRecord>([['review', record('review', 'pass')]]), excused: new Set<Kind>(['e2e']) }
    assert.deepEqual(conditions(evidence({ ...base, required: new Set(['norms']) })), ['norms'])
    const failed = new Map<Kind, PrRecord>([...base.latest, ['norms', record('norms', 'fail', 'norms')]])
    assert.deepEqual(conditions(evidence({ ...base, latest: failed, excused: new Set(['e2e', 'norms']) })), ['norms:fail'])
  })

  it('lets an excuse or a carried record stand for a kind with no record, never over a failure', () => {
    const review = new Map<Kind, PrRecord>([['review', record('review', 'pass')]])
    assert.deepEqual(conditions(evidence({ latest: review, excused: new Set(['e2e']) })), [])
    assert.deepEqual(conditions(evidence({ latest: review, carried: new Set(['e2e']) })), [])
    const failed = new Map<Kind, PrRecord>([...review, ['e2e', record('e2e', 'fail', 'session-e2e')]])
    assert.deepEqual(conditions(evidence({ latest: failed, carried: new Set(['e2e']), excused: new Set(['e2e']) })), ['e2e:fail'])
  })

  it('says which findings block a review, and which records cross to a head of the same diff', () => {
    assert.deepEqual(['critical', 'Important', 'suggestion'].map(blocks), [true, true, false])
    assert.ok(carriesAcross(record('review', 'pass')) && !carriesAcross(record('review', 'fail')))
  })

  it('names the required CI check, the plan\'s needs strictest first, the kinds a waiver lifts', () => {
    assert.equal(CI_CHECK, 'ci')
    assert.deepEqual([PLAN_NEEDS.e2e[0], PLAN_NEEDS.norms[0]], ['required', 'required'])
    assert.deepEqual(WAIVABLE, ['e2e', 'norms'])
  })
})
