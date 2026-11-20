// What the reconciler copies between the machine and the forge at a head: the newer side wins, for each record kind,
// the check plan and the exemption, and only the operator's own statuses are read.
import { expect, test } from 'claude-code/testing'
import type { ForgeStatus } from '../core/forge-status.ts'
import { parsePrRecord, type PrRecord } from '../core/pr-record.ts'
import { parsePlan, type CheckPlan } from './check-plan.ts'
import { parseExemption, type Exemption } from './e2e-scope.ts'
import { AHEAD_MS, exemptionBody, exemptionFromBody, forgeSync, planBody, planFromBody, SETTLE_MS, type ForgeSides } from './forge-sync.ts'

const HEAD = 'a'.repeat(40)
const T = '2026-11-19T10:00:00Z'
const LATER = '2026-11-19T10:05:00Z'
const LISTED = Date.parse('2026-11-19T11:00:00Z')

const record = (over: Partial<PrRecord> = {}): PrRecord => {
  const read = parsePrRecord({ v: 1, repo: 'acme/app', pr: 7, head: HEAD, kind: 'review', result: 'pass', producer: 'orchestrator', detail: '', session: 's', at: T, ...over })
  if (!read) throw new Error('bad record')
  return read
}
const status = (context: string, state: string, description: string, creator = 'operator'): ForgeStatus => ({ context, state, description, creator })
const plan = (at = T): CheckPlan => {
  const read = parsePlan({ v: 1, repo: 'acme/app', pr: 7, e2e: { need: 'none', reason: 'docs only' }, norms: { need: 'required', reason: '' }, review: { need: 'required', reason: '', max: 2 }, at })
  if (!read) throw new Error('bad plan')
  return read
}
const exemption = (over: Record<string, unknown> = {}): Exemption => {
  const read = parseExemption({ v: 1, repo: 'acme/app', exempt: true, paths: ['docs/**'], labels: [], detail: '« ok », 2026-11-19', session: 's', at: T, ...over })
  if (!read) throw new Error('bad exemption')
  return read
}
const sides = (over: Partial<ForgeSides> = {}): ForgeSides => ({
  repo: 'acme/app', statuses: [], viewer: 'operator', records: [], plan: undefined, exemption: undefined, listedAt: LISTED, ...over,
})

test('a record the forge holds newer than the machine is imported, one the machine holds newer is posted', () => {
  const fail = status('readiness/review', 'failure', 'v1 ' + LATER + ' fail orchestrator')
  expect(forgeSync(sides({ statuses: [fail], records: [record()] })).records).toEqual([{ kind: 'review', result: 'fail', producer: 'orchestrator', at: LATER }])
  const older = status('readiness/review', 'failure', 'v1 ' + T + ' fail orchestrator')
  const synced = forgeSync(sides({ statuses: [older], records: [record({ at: LATER })] }))
  expect(synced.records).toEqual([])
  expect(synced.posts).toEqual([{ name: 'review', state: 'success', description: 'v1 ' + LATER + ' pass orchestrator' }])
})

test('the same record on both sides is neither imported nor posted, and the newest of a kind is the one compared', () => {
  const same = status('readiness/review', 'success', 'v1 ' + LATER + ' pass orchestrator')
  expect(forgeSync(sides({ statuses: [same], records: [record({ at: LATER }), record({ result: 'fail' })] }))).toEqual({ records: [], posts: [], unposted: [] })
})

test('two records of one second with different results: the failure wins on both machines, so they end on the same one', () => {
  // The machine holds a pass, the forge a fail: the fail is imported.
  const fail = status('readiness/review', 'failure', 'v1 ' + T + ' fail orchestrator')
  expect(forgeSync(sides({ statuses: [fail], records: [record()] })).records).toEqual([{ kind: 'review', result: 'fail', producer: 'orchestrator', at: T }])
  // The machine holds a fail, the forge a pass: the fail is posted over it.
  const pass = status('readiness/review', 'success', 'v1 ' + T + ' pass orchestrator')
  const synced = forgeSync(sides({ statuses: [pass], records: [record({ result: 'fail' })] }))
  expect([synced.records, synced.posts]).toEqual([[], [{ name: 'review', state: 'failure', description: 'v1 ' + T + ' fail orchestrator' }]])
  // Once the forge holds the fail, neither side moves.
  expect(forgeSync(sides({ statuses: [fail], records: [record({ result: 'fail' })] }))).toEqual({ records: [], posts: [], unposted: [] })
})

test('of two local records of one second the failure is the one compared with the forge', () => {
  const pass = status('readiness/review', 'success', 'v1 ' + T + ' pass orchestrator')
  const both = [record({ producer: 'one' }), record({ result: 'fail', producer: 'two' })]
  const there = forgeSync(sides({ statuses: [pass], records: both })).posts
  expect(there).toEqual([{ name: 'review', state: 'failure', description: 'v1 ' + T + ' fail two' }])
  expect(forgeSync(sides({ statuses: [pass], records: both.reverse() })).posts).toEqual(there)
})

test('a record the machine just wrote is left to its tool for a beat before the reconciler posts it', () => {
  const fresh = new Date(LISTED - SETTLE_MS + 1000).toISOString().replace(/\.\d+Z$/, 'Z')
  expect(forgeSync(sides({ records: [record({ at: fresh })] })).posts).toEqual([])
  expect(forgeSync(sides({ records: [record()] })).posts.map((post) => post.name)).toEqual(['review'])
})

test('a copy left to its tool says so, that the reconciler reads the head again at the next beat', () => {
  const fresh = new Date(LISTED - SETTLE_MS + 1000).toISOString().replace(/\.\d+Z$/, 'Z')
  expect(forgeSync(sides({ records: [record({ at: fresh })] })).waiting).toBe(true)
  expect(forgeSync(sides({ plan: plan(fresh) })).waiting).toBe(true)
  expect(forgeSync(sides({ records: [record()] })).waiting).toBeUndefined()
})

test('a failure the machine just wrote is posted at once, never left to its tool; the passes left are named as deferred', () => {
  const fresh = new Date(LISTED - SETTLE_MS + 1000).toISOString().replace(/\.\d+Z$/, 'Z')
  const failed = forgeSync(sides({ records: [record({ at: fresh, result: 'fail' })] }))
  expect([failed.posts.map((post) => post.state), failed.waiting, failed.deferred]).toEqual([['failure'], undefined, undefined])
  const passed = forgeSync(sides({ records: [record({ at: fresh })], plan: plan(fresh) }))
  expect([passed.posts, passed.deferred?.map((post) => post.name)]).toEqual([[], ['review', 'plan']])
  const exempted = forgeSync(sides({ exemption: exemption({ at: fresh }) }))
  expect([exempted.posts, exempted.deferred?.map((post) => post.name), exempted.waiting]).toEqual([[], ['exemption'], true])
  expect(forgeSync(sides({ records: [record()] })).deferred).toBeUndefined()
})

test('a status dated ahead of the listing is not imported, and said', () => {
  const ahead = new Date(LISTED + AHEAD_MS + 1000).toISOString().replace(/\.\d+Z$/, 'Z')
  const near = new Date(LISTED + AHEAD_MS).toISOString().replace(/\.\d+Z$/, 'Z')
  const sync = forgeSync(sides({
    statuses: [status('readiness/review', 'success', 'v1 ' + ahead + ' pass orchestrator'), status('readiness/plan', 'success', 'v1 ' + ahead + ' e2e=none norms=none review=none')],
  }))
  expect([sync.records, sync.plan]).toEqual([[], undefined])
  expect(sync.unposted).toEqual([
    'github: readiness/review of acme/app on the forge is dated ' + ahead + ', ahead of this machine\'s clock: it is not copied here',
    'github: readiness/plan of acme/app on the forge is dated ' + ahead + ', ahead of this machine\'s clock: it is not copied here',
  ])
  expect(forgeSync(sides({ statuses: [status('readiness/review', 'success', 'v1 ' + near + ' pass orchestrator')] })).records.map((r) => r.at)).toEqual([near])
})

test('a status another account posted, or none of the gate\'s, copies nothing; with no account known nothing is trusted', () => {
  const forged = status('readiness/review', 'success', 'v1 ' + LATER + ' pass orchestrator', 'someone')
  expect(forgeSync(sides({ statuses: [forged] })).records).toEqual([])
  const mine = status('readiness/review', 'success', 'v1 ' + LATER + ' pass orchestrator')
  expect(forgeSync(sides({ statuses: [mine], viewer: '' })).records).toEqual([])
  // Untrusted, the forge holds nothing: the machine's record is posted over it.
  expect(forgeSync(sides({ statuses: [forged], records: [record()] })).posts.map((post) => post.name)).toEqual(['review'])
})

test('the plan travels as its needs, the reasons the forge does not keep read as a copy\'s', () => {
  expect(planBody(plan())).toBe('e2e=none norms=required review=required/2')
  const checks = planFromBody('e2e=none norms=required review=required/2')
  expect(checks?.e2e).toEqual({ need: 'none', reason: 'copied from the forge' })
  expect(checks?.norms).toEqual({ need: 'required', reason: '' })
  expect(checks?.review).toEqual({ need: 'required', reason: '', max: 2 })
  for (const body of ['e2e=maybe norms=required review=required/2', 'e2e=none norms=required', 'e2e=none norms=required review=required/9 x=1', 'garbage']) {
    expect(planFromBody(body)).toBeUndefined()
  }
  const there = status('readiness/plan', 'success', 'v1 ' + LATER + ' e2e=screenshots norms=none review=required/1')
  expect(forgeSync(sides({ statuses: [there], plan: plan() })).plan?.at).toBe(LATER)
  expect(forgeSync(sides({ statuses: [there], plan: plan(LATER) }))).toEqual({ records: [], posts: [], unposted: [] })
  expect(forgeSync(sides({ plan: plan() })).posts).toEqual([{ name: 'plan', state: 'success', description: 'v1 ' + T + ' e2e=none norms=required review=required/2' }])
})

test('the exemption travels as its rules and its end, a revocation too, and one too long for the forge is said', () => {
  const body = exemptionBody(exemption({ until: '2026-12-01T00:00:00Z' }))
  expect(body).toBe('{"e":true,"p":["docs/**"],"l":[],"u":"2026-12-01T00:00:00Z"}')
  const copied = exemptionFromBody(body, 'Acme/App', LATER, 'operator')
  expect(copied).toEqual({ v: 1, repo: 'acme/app', exempt: true, paths: ['docs/**'], labels: [], detail: 'copied from the forge, posted by operator', session: 'forge', at: LATER, until: '2026-12-01T00:00:00Z' })
  expect(exemptionFromBody('{"e":"yes"}', 'acme/app', LATER, 'operator')).toBeUndefined()
  expect(exemptionFromBody('not json', 'acme/app', LATER, 'operator')).toBeUndefined()
  const revoked = status('readiness/exemption', 'success', 'v1 ' + LATER + ' {"e":false,"p":[],"l":[]}')
  expect(forgeSync(sides({ statuses: [revoked], exemption: exemption() })).exemption?.exempt).toBe(false)
  expect(forgeSync(sides({ exemption: exemption() })).posts.map((post) => post.name)).toEqual(['exemption'])
  const long = forgeSync(sides({ exemption: exemption({ paths: ['x'.repeat(150)] }) }))
  expect(long.posts).toEqual([])
  expect(long.unposted[0]).toContain('too long for the forge')
})
