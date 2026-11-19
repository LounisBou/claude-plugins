// The reconciler's pure decisions: its listing, its fingerprint, its schedule and its lease.
import { expect, test } from 'claude-code/testing'
import {
  fingerprintOf, FLAP_UNDONE, flapCheck, flapWrote, IDLE_MAX_MS, LEASE_MS, leaseDue, leaseOf, nextListing, parseLease, parseListing, QUOTA_LOW, QUOTA_WAIT_MS, RECENT_MS, reconciledRepos, takenLease, TICK_MS,
  type Flap, type ListedPr, type Local,
} from './reconcile.ts'

const HEAD = 'a'.repeat(40)
const row = (over: Partial<ListedPr> = {}): ListedPr => ({ number: 7, draft: false, head: HEAD, base: 'main', labels: ['Not Ready'], rollup: 'SUCCESS', ...over })
const LOCAL: Local = { records: 1, plan: 0, exemption: 0, expired: false }
const COUNTS = { since: '2026-11-19T10:00:00.000Z', ticks: 1, listings: 1, gates: 0, moves: 0 }
const T0 = Date.parse('2026-11-19T10:00:00Z')

test('the listing keeps each open pull request with a head, and the quota left with its reset', () => {
  const listing = parseListing(JSON.stringify({
    rows: [{ number: 7, draft: true, head: HEAD, base: 'develop', labels: ['Ready', 3], rollup: 'PENDING' }, { number: 8, head: 'nope' }, { number: 0, head: HEAD }],
    rate: { remaining: 42, resetAt: '2026-11-19T11:00:00Z', cost: 1 },
  }))
  expect(listing).toEqual({ rows: [{ number: 7, draft: true, head: HEAD, base: 'develop', labels: ['Ready'], rollup: 'PENDING' }], rate: { remaining: 42, resetAt: Date.parse('2026-11-19T11:00:00Z') } })
  expect(parseListing(JSON.stringify({ rows: [] }))).toEqual({ rows: [], rate: {} })
  expect(() => parseListing('[]')).toThrow('no rows')
})

test('the listing keeps each pull request\'s mergeability and merge state, when it lists them', () => {
  const listing = parseListing(JSON.stringify({
    rows: [{ number: 7, draft: false, head: HEAD, base: 'main', labels: [], rollup: null, mergeable: 'CONFLICTING', mergeState: 'DIRTY' }, { number: 8, draft: false, head: HEAD, base: 'main', labels: [], rollup: null }],
    rate: {},
  }))
  expect(listing.rows[0]).toMatchObject({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' })
  expect(listing.rows[1]).not.toHaveProperty('mergeable')
})

test('the fingerprint changes with each input of the gate, and not with the labels\' order or case', () => {
  const base = fingerprintOf(row(), LOCAL)
  expect(fingerprintOf(row({ labels: ['not ready'] }), LOCAL)).toBe(base)
  expect(fingerprintOf(row(), LOCAL, ['Not Ready'])).toBe(base)
  for (const changed of [
    fingerprintOf(row({ head: 'b'.repeat(40) }), LOCAL), fingerprintOf(row({ base: 'develop' }), LOCAL), fingerprintOf(row({ draft: true }), LOCAL),
    fingerprintOf(row({ rollup: 'FAILURE' }), LOCAL), fingerprintOf(row({ labels: ['Ready'] }), LOCAL), fingerprintOf(row(), { ...LOCAL, records: 2 }),
    fingerprintOf(row({ mergeable: 'CONFLICTING' }), LOCAL), fingerprintOf(row({ mergeable: 'UNKNOWN' }), LOCAL), fingerprintOf(row({ mergeState: 'DIRTY' }), LOCAL),
    fingerprintOf(row(), { ...LOCAL, plan: 3 }), fingerprintOf(row(), { ...LOCAL, exemption: 4 }), fingerprintOf(row(), { ...LOCAL, expired: true }),
  ]) expect(changed).not.toBe(base)
})

test('a mergeability GitHub is still computing keeps the repository listed at the next beat, a settled one does not', () => {
  expect(nextListing({ nextAt: T0, idle: 3 }, T0, false, [row({ mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' })], {})).toEqual({ nextAt: T0 + TICK_MS, idle: 0 })
  expect(nextListing(undefined, T0, false, [row({ mergeable: 'MERGEABLE', mergeState: 'CLEAN' })], {})).toEqual({ nextAt: T0 + 2 * TICK_MS, idle: 1 })
})

test('a repository is listed at the next beat while something changes or a CI runs, later and later while idle', () => {
  expect(nextListing(undefined, T0, true, [row()], {})).toEqual({ nextAt: T0 + TICK_MS, idle: 0 })
  expect(nextListing({ nextAt: T0, idle: 3 }, T0, false, [row({ rollup: 'PENDING' })], {})).toEqual({ nextAt: T0 + TICK_MS, idle: 0 })
  expect(nextListing(undefined, T0, false, [row()], {})).toEqual({ nextAt: T0 + 2 * TICK_MS, idle: 1 })
  expect(nextListing({ nextAt: T0, idle: 1 }, T0, false, [row({ rollup: null })], {})).toEqual({ nextAt: T0 + 4 * TICK_MS, idle: 2 })
  expect(nextListing({ nextAt: T0, idle: 6 }, T0, false, [], {})).toEqual({ nextAt: T0 + IDLE_MAX_MS, idle: 7 })
})

test('a low quota waits for its reset, or QUOTA_WAIT_MS when the reset is unknown or past', () => {
  expect(nextListing(undefined, T0, true, [row()], { remaining: QUOTA_LOW - 1, resetAt: T0 + 1_234_000 })).toEqual({ nextAt: T0 + 1_234_000, idle: 0 })
  expect(nextListing(undefined, T0, true, [row()], { remaining: 0 })).toEqual({ nextAt: T0 + QUOTA_WAIT_MS, idle: 0 })
  expect(nextListing(undefined, T0, true, [row()], { remaining: 3, resetAt: T0 - 1 })).toEqual({ nextAt: T0 + QUOTA_WAIT_MS, idle: 0 })
  expect(nextListing(undefined, T0, true, [row()], { remaining: QUOTA_LOW })).toEqual({ nextAt: T0 + TICK_MS, idle: 0 })
})

test('the repositories followed are those with records changed within thirty days and those named, each once, lowercased', () => {
  const records = [{ repo: 'Acme/App', mtimeMs: T0 - RECENT_MS }, { repo: 'acme/old', mtimeMs: T0 - RECENT_MS - 1 }]
  expect(reconciledRepos(records, ['acme/app', 'Other/Thing'], T0)).toEqual(['acme/app', 'other/thing'])
  expect(reconciledRepos([], [], T0)).toEqual([])
})

test('of two sessions taking the lease, one holds it; the other takes it once it runs out', () => {
  const first = takenLease(undefined, 's1', T0, COUNTS)
  expect(first).toBeDefined()
  expect(takenLease(first, 's2', T0 + 1000, COUNTS)).toBeUndefined()
  expect(leaseOf(parseLease(first), 's1', T0 + 1000)).toBe('mine')
  expect(leaseOf(parseLease(first), 's2', T0 + 1000)).toBe('other')
  expect(leaseOf(parseLease(first), 's2', T0 + LEASE_MS)).toBe('free')
  expect(parseLease(takenLease(first, 's2', T0 + LEASE_MS, COUNTS))?.holder).toBe('s2')
  expect(parseLease(first)).toEqual({ v: 1, holder: 's1', until: T0 + LEASE_MS, counts: COUNTS })
})

test('the holder renews its lease only when it runs low; a lease that does not parse is free', () => {
  const lease = parseLease(takenLease(undefined, 's1', T0, COUNTS))
  expect(leaseDue(lease, 's1', T0 + TICK_MS)).toBe(false)
  expect(leaseDue(lease, 's1', T0 + 2 * TICK_MS + 1)).toBe(true)
  expect(leaseDue(lease, 's2', T0 + TICK_MS)).toBe(false)
  expect(leaseDue(undefined, 's2', T0)).toBe(true)
  for (const text of ['{', '{"v":2,"holder":"x","until":1}', '{"v":1,"holder":3,"until":1}']) expect(parseLease(text)).toBeUndefined()
  expect(parseLease('{"v":1,"holder":"x","until":1,"counts":{"since":"s","ticks":-1}}')).toEqual({ v: 1, holder: 'x', until: 1 })
})

test('a label put again after this machine wrote it is held past FLAP_UNDONE of them, said once, at that head only', () => {
  const OTHER_HEAD = 'b'.repeat(40)
  let flap: Flap = flapWrote(undefined, HEAD, 'ready')
  for (let i = 1; i <= FLAP_UNDONE; i++) {
    expect([i, flapCheck(flap, HEAD, 'ready').hold]).toEqual([i, false])
    flap = flapWrote(flap, HEAD, 'ready')
  }
  // A check counts nothing: a write that fails, or a head that moved, leaves the count where it was.
  expect(flapCheck(flap, HEAD, 'ready')).toEqual({ hold: true, say: true, flap: { ...flap, said: true } })
  expect(flapCheck({ ...flap, said: true }, HEAD, 'ready')).toEqual({ hold: true, say: false, flap: { ...flap, said: true } })
  // Another head, another label (a verdict that changed), or none written before: not held.
  expect(flapCheck(flap, OTHER_HEAD, 'ready')).toEqual({ hold: false, say: false })
  expect(flapCheck(flap, HEAD, 'not-ready')).toEqual({ hold: false, say: false })
  expect(flapCheck(undefined, HEAD, 'ready')).toEqual({ hold: false, say: false })
  // The other label written in between starts the count again.
  expect(flapWrote(flap, HEAD, 'not-ready')).toEqual({ head: HEAD, wrote: 'not-ready', undone: 0, said: false })
  expect(flapWrote(flapWrote(flap, HEAD, 'not-ready'), HEAD, 'ready').undone).toBe(0)
  expect(flapWrote(flap, OTHER_HEAD, 'ready')).toEqual({ head: OTHER_HEAD, wrote: 'ready', undone: 0, said: false })
})
