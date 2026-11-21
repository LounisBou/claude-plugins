import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  FORGE, forgeContext, forgeDescription, forgeName, parseForgeDescription, parseRecordStatus, trustedStatuses, type ForgeStatus,
} from './forge-status.ts'

describe('records copied to the forge', () => {
  it('reads back the record a status copies, and nothing from one whose state says another result', () => {
    const status: ForgeStatus = { context: 'readiness/review', state: 'failure', description: 'v1 2026-11-19T10:00:00Z fail orchestrator', creator: 'me' }
    assert.deepEqual(parseRecordStatus(status), { kind: 'review', result: 'fail', producer: 'orchestrator', at: '2026-11-19T10:00:00Z' })
    assert.equal(parseRecordStatus({ ...status, state: 'success' }), undefined)
    for (const description of ['v2 2026-11-19T10:00:00Z fail orchestrator', 'v1 yesterday fail orchestrator', 'v1 2026-11-19T10:00:00Z ok orchestrator',
      'v1 2026-11-19T10:00:00Z fail Orchestrator', 'v1 2026-11-19T10:00:00Z fail orchestrator extra', 'v1 2026-11-19T10:00:00Z fail']) {
      assert.equal(parseRecordStatus({ ...status, description }), undefined, description)
    }
    assert.equal(parseRecordStatus({ ...status, context: 'readiness/plan' }), undefined)
    assert.equal(parseRecordStatus({ ...status, context: 'ci/review' }), undefined)
  })

  it('names the contexts under its prefix only, and keeps a description to what GitHub keeps', () => {
    assert.equal(forgeContext('plan'), 'readiness/plan')
    assert.equal(forgeName('readiness/exemption'), 'exemption')
    assert.equal(forgeName('readiness/lint'), undefined)
    assert.equal(forgeName('review'), undefined)
    assert.equal(forgeDescription('2026-11-19T10:00:00Z', 'x'.repeat(FORGE.description_max)), undefined)
    assert.deepEqual(parseForgeDescription('v1 2026-11-19T10:00:00Z e2e=none norms=required'), { v: 1, at: '2026-11-19T10:00:00Z', body: 'e2e=none norms=required' })
  })

  it('trusts only the statuses the operator\'s account created under the prefix', () => {
    const mine: ForgeStatus = { context: 'readiness/review', state: 'success', description: 'v1 2026-11-19T10:00:00Z pass orchestrator', creator: 'Operator' }
    const statuses = [mine, { ...mine, context: 'readiness/norms', creator: 'someone' }, { ...mine, context: 'ci/tests' }]
    assert.deepEqual([...trustedStatuses(statuses, 'operator').keys()], ['review'])
    assert.equal(trustedStatuses(statuses, '').size, 0)
  })
})
