import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { acceptanceDetail, accepts, DETAIL_MAX, KINDS, parsePrRecord } from './pr-record.ts'

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

  it('lets an E2E not applicable through the gate, never a review or a norms check', () => {
    const read = (change: Record<string, unknown>) => parsePrRecord({ ...RECORD, ...change })
    const e2eNone = read({ kind: 'e2e', result: 'not-applicable', detail: 'documentation only' })
    assert.ok(e2eNone && accepts(e2eNone))
    for (const kind of ['review', 'norms']) {
      const none = read({ kind, result: 'not-applicable', detail: 'documentation only' })
      assert.ok(none && !accepts(none), kind)
    }
  })

  it('lets an acceptance of a review through on its own, and of no other kind', () => {
    const read = (change: Record<string, unknown>) => parsePrRecord({ ...RECORD, ...change })
    const accepted = read({ result: 'accepted', producer: 'orchestrator', detail: acceptanceDetail([{ point: 'a.ts:3', reason: 'naming only' }]) })
    assert.ok(accepted && accepts(accepted))
    const norms = read({ kind: 'norms', result: 'accepted' })
    assert.ok(norms && !accepts(norms))
  })

  it('names each point an acceptance sets aside with its reason, cut to the contract\'s length', () => {
    const detail = acceptanceDetail([{ point: ' a.ts:3 ', reason: 'naming only ' }, { point: 'b.ts', reason: 'out of scope' }])
    assert.equal(detail, 'set aside: a.ts:3 — naming only; b.ts — out of scope')
    assert.equal(acceptanceDetail([{ point: 'r', reason: 'x'.repeat(600) }]).length, DETAIL_MAX)
  })
})
