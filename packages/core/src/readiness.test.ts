import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePrRecord, type Kind, type PrRecord } from './pr-record.ts'
import { blocks, carriesAcross, CI_CHECK, heldBy, missingEvidence, PLAN_NEEDS, PLAN_OMITTED, REVIEW_ROUNDS, reviewNeed, reviewRounds, WAIVABLE, type HeadEvidence } from './readiness.ts'

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

  it('reads a review need: required with its rounds from 1 to the cap, the cap when it names none, one-pass, or a former need as a required review', () => {
    assert.deepEqual(PLAN_NEEDS.review, ['required', 'one-pass'])
    assert.equal(PLAN_OMITTED.review, 'required')
    assert.equal(REVIEW_ROUNDS.cap, 3)
    assert.deepEqual(reviewNeed('required', ''), { need: 'required', max: 3 })
    assert.deepEqual(reviewNeed('Required', 'Max 2'), { need: 'required', max: 2 })
    assert.deepEqual(reviewNeed('required', 'max 3'), { need: 'required', max: 3 })
    assert.deepEqual(reviewNeed('none', 'docs only'), { need: 'required', max: 1 })
    assert.deepEqual(reviewNeed('full', ''), { need: 'required', max: 3 })
    assert.deepEqual(reviewNeed('one-pass', 'a typo'), { need: 'required', max: 1 })
    for (const rest of ['max 0', 'max 4', 'max two', 'a big change', 'max 2 rounds']) {
      assert.equal(reviewNeed('required', rest), 'review required runs from 1 to 3 rounds: "required" or "required: max <n>", got: required: ' + rest)
    }
    assert.equal(reviewNeed('maybe', ''), 'review is one of required, one-pass, got: maybe')
  })

  it('gives a loop the rounds of a stored review need, capped, one for a one-pass or a former none, and the cap for anything else', () => {
    assert.equal(reviewRounds({ need: 'required', reason: '', max: 2 }), 2)
    assert.equal(reviewRounds({ need: 'required', max: 3 }), 3)
    assert.equal(reviewRounds({ need: 'required', max: 9 }), 3)
    assert.equal(reviewRounds({ need: 'required' }), 3)
    assert.equal(reviewRounds({ need: 'one-pass', reason: 'x' }), 1)
    assert.equal(reviewRounds({ need: 'full', reason: '' }), 3)
    assert.equal(reviewRounds({ need: 'none', reason: 'docs' }), 1)
    for (const odd of [undefined, null, 'required', [], { need: 'required', max: 0 }, { need: 'required', max: 1.5 }, { need: 'required', max: '2' }]) assert.equal(reviewRounds(odd), 3)
  })
})
