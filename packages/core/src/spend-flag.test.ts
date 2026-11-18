import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSpendFlag, raisedFlag, SPEND_FLAG_STALE_AFTER_MS, type SpendFlag } from './spend-flag.ts'

const FLAG: SpendFlag = {
  version: 1, at: 1_000_000, window_ms: 3_600_000, rate_usd_per_hour: 860, threshold_usd_per_hour: 400, over: true, since: 900_000,
  calls: 12, unpriced: 0, top: [{ session: 's1', name: 'Orch: a', usd: 300 }], line: 'spend 860 $/h',
}

describe('the spend flag', () => {
  it('is read back from its text', () => {
    assert.deepEqual(parseSpendFlag(JSON.stringify(FLAG)), FLAG)
  })

  it('is no flag when torn, of another version or of another shape', () => {
    assert.equal(parseSpendFlag('{"version":1,'), null)
    assert.equal(parseSpendFlag('[]'), null)
    assert.equal(parseSpendFlag(JSON.stringify({ ...FLAG, version: 2 })), null)
    assert.equal(parseSpendFlag(JSON.stringify({ ...FLAG, rate_usd_per_hour: '860' })), null)
    assert.equal(parseSpendFlag(JSON.stringify({ ...FLAG, top: [{ session: 's' }] })), null)
    assert.equal(parseSpendFlag(JSON.stringify({ ...FLAG, since: undefined })), null)
  })

  it('is raised while it says over and its stamp is recent, never from a frozen or future file', () => {
    assert.equal(raisedFlag(FLAG, FLAG.at + 1000), FLAG)
    assert.equal(raisedFlag(FLAG, FLAG.at + SPEND_FLAG_STALE_AFTER_MS + 1), null)
    assert.equal(raisedFlag(FLAG, FLAG.at - SPEND_FLAG_STALE_AFTER_MS - 1), null)
    assert.equal(raisedFlag({ ...FLAG, over: false, since: null }, FLAG.at), null)
    assert.equal(raisedFlag(null, FLAG.at), null)
  })
})
