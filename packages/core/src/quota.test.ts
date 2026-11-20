import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseQuota, planOfConfig, quotaFilePath, quotaLine, QUOTA_STALE_AFTER_MS } from './quota.ts'

const FILE = {
  version: 1, account: '97b96c6c-03c9-4e84-bd43-34a597fa667c', config: '/Users/me/.claude-bis',
  five_hour: { used_percentage: 41.6, resets_at: 1763650000 }, seven_day: { used_percentage: 7, resets_at: 1764200000 },
  at: '2026-11-20T14:00:00Z',
}
const AT = Date.parse(FILE.at)

describe('a quota file', () => {
  it('reads both windows, or one alone', () => {
    assert.equal(parseQuota(FILE)?.five_hour?.used_percentage, 41.6)
    const { seven_day: _gone, ...fiveOnly } = FILE
    assert.equal(parseQuota(fiveOnly)?.seven_day, undefined)
    assert.equal(parseQuota(fiveOnly)?.five_hour?.resets_at, 1763650000)
  })

  it('reads no reading from a torn, foreign or windowless file', () => {
    const { five_hour: _a, seven_day: _b, ...none } = FILE
    for (const bad of [null, 'x', [], { ...FILE, version: 2 }, { ...FILE, account: '../x' }, { ...FILE, config: '' }, { ...FILE, at: 'yesterday' },
      { ...FILE, five_hour: { used_percentage: 'a', resets_at: 1 } }, { ...FILE, seven_day: {} }, none]) {
      assert.equal(parseQuota(bad), null, JSON.stringify(bad))
    }
  })

  it('lies under the quota directory of the state, by account', () => {
    assert.equal(quotaFilePath('/s', 'abc-1'), '/s/quota/abc-1.json')
  })
})

describe('the plan a configuration is', () => {
  it('names the two plans by their directories, any other by its path', () => {
    assert.equal(planOfConfig('/Users/me/.claude', '/Users/me'), 'plan1')
    assert.equal(planOfConfig('/Users/me/.claude-bis/', '/Users/me'), 'plan2')
    assert.equal(planOfConfig('/opt/other', '/Users/me'), '/opt/other')
  })
})

describe('the quota line', () => {
  const quota = parseQuota(FILE)
  it('says the plan, both windows rounded and the time it was read', () => {
    assert.ok(quota)
    assert.equal(quotaLine(quota, '/Users/me', AT + 60_000), 'quota plan2 | 5h 42% | 7d 7% | read 2026-11-20T14:00:00Z')
  })

  it('marks a reading no session refreshed for over 30 minutes, and says a missing window', () => {
    const { seven_day: _gone, ...fiveOnly } = FILE
    const only = parseQuota(fiveOnly)
    assert.ok(only)
    assert.equal(quotaLine(only, '/Users/me', AT + QUOTA_STALE_AFTER_MS), 'quota plan2 | 5h 42% | 7d - | read 2026-11-20T14:00:00Z')
    assert.equal(quotaLine(only, '/Users/me', AT + QUOTA_STALE_AFTER_MS + 1), 'quota plan2 | 5h 42% | 7d - | read 2026-11-20T14:00:00Z (stale)')
  })
})
