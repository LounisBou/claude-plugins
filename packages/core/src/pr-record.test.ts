import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { acceptanceDetail, acceptedOver, accepts, answersAcceptance, DETAIL_MAX, KINDS, parsePrRecord } from './pr-record.ts'

const RECORD = {
  v: 1, repo: 'owner/name', pr: 7, head: 'a'.repeat(40), kind: 'review', result: 'pass',
  producer: 'pr-review', detail: '', session: 's', at: '2026-11-08T00:00:00Z',
}

describe('pull request records', () => {
  it('reads a record that keeps the contract', () => {
    assert.deepEqual(parsePrRecord(RECORD), RECORD)
    assert.deepEqual(KINDS, ['review', 'norms', 'e2e'])
  })

  it('refuses a record that breaks any field of it', () => {
    const broken: Record<string, unknown>[] = [
      { v: 2 }, { repo: 'owner' }, { repo: 'owner/..' }, { pr: 0 }, { pr: 1.5 }, { head: 'abc' },
      { kind: 'lint' }, { result: 'ok' }, { producer: 'Pr Review' }, { detail: 'x'.repeat(501) },
      { session: 3 }, { at: 0 },
    ]
    for (const change of broken) assert.equal(parsePrRecord({ ...RECORD, ...change }), undefined, JSON.stringify(change))
    for (const raw of [null, [], 'record']) assert.equal(parsePrRecord(raw), undefined)
  })

  it('lets a pass through the gate, and a waiver only where one is allowed', () => {
    const read = (change: Record<string, unknown>) => parsePrRecord({ ...RECORD, ...change })
    const e2eWaived = read({ kind: 'e2e', result: 'waived', detail: 'operator, 2026-11-08' })
    assert.ok(e2eWaived && accepts(e2eWaived))
    const reviewWaived = read({ result: 'waived' })
    assert.ok(reviewWaived && !accepts(reviewWaived))
    const failed = read({ result: 'fail' })
    assert.ok(failed && !accepts(failed))
  })

  it('lets an acceptance of a failed review through, and of no other kind', () => {
    const read = (change: Record<string, unknown>) => parsePrRecord({ ...RECORD, ...change })
    const accepted = read({ result: 'accepted', producer: 'orchestrator', detail: acceptanceDetail('review.x.json', 'nits only') })
    assert.ok(accepted && accepts(accepted))
    const norms = read({ kind: 'norms', result: 'accepted' })
    assert.ok(norms && !accepts(norms))
    const failed = read({ result: 'fail' })
    assert.ok(failed && answersAcceptance(failed))
    const passed = read({})
    assert.ok(passed && !answersAcceptance(passed))
  })

  it('names the failed record an acceptance answers in its detail, cut to the contract\'s length', () => {
    const detail = acceptanceDetail('review.20261113T190000Z.pr-review.json', '  two Important findings judged out of scope ')
    assert.equal(detail, 'over review.20261113T190000Z.pr-review.json: two Important findings judged out of scope')
    assert.equal(acceptedOver(detail), 'review.20261113T190000Z.pr-review.json')
    assert.equal(acceptedOver('clean at pass 2'), undefined)
    assert.equal(acceptanceDetail('r.json', 'x'.repeat(600)).length, DETAIL_MAX)
  })
})
