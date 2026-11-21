// The unit costs of the report on fixture events: the figures per day, a session whose events name
// no tier, the 50 % flag with and without the floor of five, a reader priced from its calls, the
// pull requests merged, the dispatch rows and the escapes joined to the review that read them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Prices } from '../../../../core/usage-cost.ts'
import { readPrices, UnitCosts, type UnitInput } from './unitcosts.ts'

const PRICES: Prices = { 'claude-sonnet-5-5': { input: 2, output: 10, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.2 } }
const D1 = '2026-11-20'
const D2 = '2026-11-21'
const S = (n: number): string => `0000000${n}-0000-0000-0000-000000000000`
const ev = (day: string, event: string, session: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({ v: 1, ts: `${day}T12:00:00.000Z`, event, session, ...fields })
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** An agent's turn: its role and tier as its events carry them, and the cost of the turn. */
const turn = (day: string, session: string, cost: number, fields: Record<string, unknown> = {}): Record<string, unknown> =>
  ev(day, 'turn_end', session, { role: 'agent', launch_tier: 'deep', effort: 'xhigh', turn_cost_usd: cost, ...fields })

const build = (events: Record<string, unknown>[], prices: Prices | undefined = PRICES): UnitCosts => {
  const unit = new UnitCosts(prices, D1, D2)
  for (const e of events) unit.add(e, String(e['ts']).slice(0, 10))
  return unit
}
const input = (over: Partial<UnitInput> = {}): UnitInput => ({ days: [D1, D2], prices: PRICES, noPrices: '', merged: { why: 'none listed' }, rows: undefined, dayOf, ...over })
const lines = (events: Record<string, unknown>[], over: Partial<UnitInput> = {}): string[] => build(events, 'prices' in over ? over.prices : PRICES).lines(input(over))

/** A reader's run end, its calls, on a model: one million input tokens a call, $2 at the fixture's price. */
const reader = (day: string, n: number, { effort = 'high', repo = 'o/r', pr = 7, head = 'abcdef0123456789', calls = 1, model = 'claude-sonnet-5-5' } = {}): Record<string, unknown>[] => [
  ev(day, 'agent_closed', S(1), { kind: 'subagent', child: `c${n}`, run: 1, subagent_type: 'orchestrator:lens', lens: 'correctness', models: [model], effort, target: { repo, pr }, range: `origin/main..${head}` }),
  ...Array.from({ length: calls }, (_, i) => ev(day, 'api_call', S(1), { agent: `c${n}`, message: `m${n}-${i}`, model, usage: { input_tokens: 1_000_000, output_tokens: 0 } })),
]

test('an agent session costs its turns, per day, by tier and effort; other roles are left out', () => {
  const out = lines([
    turn(D1, S(2), 1), turn(D1, S(2), 2), turn(D1, S(3), 1),
    turn(D2, S(2), 4),
    ev(D1, 'turn_end', S(4), { role: 'orchestrator', turn_cost_usd: 50 }),
  ])
  assert.ok(out.includes('  2026-11-20  deep/xhigh $2.00 (2 sessions)'), out.join('\n'))
  assert.ok(out.includes('  2026-11-21  deep/xhigh $4.00 (1 sessions)'), out.join('\n'))
  assert.equal(out.filter(l => l.includes('$50')).length, 0)
})

test('a session whose events name no tier or no effort prints under unknown', () => {
  const out = lines([
    ev(D1, 'turn_end', S(2), { role: 'agent', turn_cost_usd: 3 }),
    ev(D1, 'turn_end', S(3), { role: 'agent', launch_tier: 'light', turn_cost_usd: 1 }),
    ev(D1, 'session_end', S(3), { effort: 'medium' }),
  ])
  assert.ok(out.includes('  2026-11-20  light/medium $1.00 (1 sessions); unknown/unknown $3.00 (1 sessions)'), out.join('\n'))
})

test('a unit cost that moved more than 50 % with five sessions on both days is flagged, up or down', () => {
  const day = (d: string, cost: number, n = 5): Record<string, unknown>[] => Array.from({ length: n }, (_, i) => turn(d, S(10 + i), cost))
  const up = lines([...day(D1, 1), ...day(D2, 2)])
  assert.ok(up.includes('  agent sessions deep/xhigh on 2026-11-21: 1.00 → 2.00 USD (5 sessions)'), up.join('\n'))
  const down = lines([...day(D1, 2), ...day(D2, 0.5)])
  assert.ok(down.includes('  agent sessions deep/xhigh on 2026-11-21: 2.00 → 0.50 USD (5 sessions)'), down.join('\n'))
})

test('no flag under the floor of five on either day, nor at a move of exactly 50 %', () => {
  const day = (d: string, cost: number, n: number): Record<string, unknown>[] => Array.from({ length: n }, (_, i) => turn(d, S(10 + i), cost))
  for (const events of [[...day(D1, 1, 5), ...day(D2, 3, 4)], [...day(D1, 1, 4), ...day(D2, 3, 5)], [...day(D1, 1, 5), ...day(D2, 1.5, 5)]]) {
    const out = lines(events)
    assert.ok(!out.some(l => l.includes('USD (')), out.join('\n'))
    assert.equal(out.at(-1), '  none')
  }
})

test('the first day of the window is compared with the day before it', () => {
  const unit = new UnitCosts(PRICES, '2026-11-19', D2)
  for (const [day, cost] of [['2026-11-19', 1], [D1, 2]] as const) for (let i = 0; i < 5; i++) unit.add(turn(day, S(10 + i), cost), day)
  const out = unit.lines(input({ days: [D1, D2] }))
  assert.ok(out.includes('  agent sessions deep/xhigh on 2026-11-20: 1.00 → 2.00 USD (5 sessions)'), out.join('\n'))
})

test('a reader costs its calls at the price file, once however often a call is read, by model and effort', () => {
  const calls = reader(D1, 1, { calls: 2 })
  const out = lines([...calls, ...calls.slice(1), ...reader(D1, 2, { effort: 'medium' })])
  assert.ok(out.includes('  2026-11-20  claude-sonnet-5-5/high $4.00 (1 readers); claude-sonnet-5-5/medium $2.00 (1 readers)'), out.join('\n'))
})

test('a reader whose calls no price covers, or that has none, is counted and left out of the cost', () => {
  const out = lines([...reader(D1, 1, { model: 'claude-other-1' }), ev(D1, 'agent_closed', S(1), { kind: 'subagent', child: 'bare', lens: 'tests', models: ['claude-sonnet-5-5'], effort: 'high' }), ...reader(D1, 3)])
  assert.ok(out.includes('  2026-11-20  claude-sonnet-5-5/high $2.00 (1 readers); 2 reader(s) with no price or no recorded call, left out'), out.join('\n'))
})

test('a reader\'s calls read before its run end, and a later run, are one reader on the day of its first run', () => {
  const [closed, call] = reader(D1, 1) as [Record<string, unknown>, Record<string, unknown>]
  const later = { ...closed, ts: `${D2}T01:00:00.000Z`, run: 2, effort: 'xhigh' }
  const out = lines([call, closed, later])
  assert.ok(out.includes('  2026-11-20  claude-sonnet-5-5/xhigh $2.00 (1 readers)'), out.join('\n'))
  assert.ok(out.includes('  2026-11-21  none'), out.join('\n'))
})

test('without a price file the readers\' cost is n/a and says why, their count stays', () => {
  const out = lines(reader(D1, 1), { prices: undefined, noPrices: '/x/prices.json is not readable (ENOENT)' })
  assert.ok(out.includes('  review readers: n/a — /x/prices.json is not readable (ENOENT)'), out.join('\n'))
  assert.ok(out.includes('  2026-11-20  1 readers, merged pull requests: n/a — none listed'), out.join('\n'))
})

test('readers per merged pull request, by day', () => {
  const out = lines([...reader(D1, 1), ...reader(D1, 2), ...reader(D1, 3)], { merged: { byDay: new Map([[D1, 2]]), unlisted: 1 } })
  assert.ok(out.includes('  2026-11-20  3 readers, 2 merged = 1.5 per pull request (1 repository listing(s) n/a)'), out.join('\n'))
  assert.ok(out.includes('  2026-11-21  0 readers, 0 merged (1 repository listing(s) n/a)'), out.join('\n'))
})

test('the share of closed rows reviewed in two rounds or more, among those reviewed at all', () => {
  const at = (day: string): number => Date.parse(`${day}T12:00:00Z`)
  const out = lines([], { rows: [{ closed: at(D1), rounds: 0 }, { closed: at(D1), rounds: 1 }, { closed: at(D1), rounds: 2 }, { closed: at(D1), rounds: 3 }, { closed: at(D1), rounds: 1 }] })
  assert.ok(out.includes('  2026-11-20  2 of 4 (50 %)'), out.join('\n'))
  assert.ok(out.includes('  2026-11-21  no reviewed row closed'), out.join('\n'))
})

test('no dispatch record readable: the line says so', () => {
  const out = lines([], { rows: undefined })
  assert.ok(out.includes('  n/a — no closed row in any readable dispatch record (no record registry, or none of its paths exists)'), out.join('\n'))
  assert.equal(out.filter(l => l.includes('reviewed')).length, 1)
})

test('an escape is joined to the review that read the pull request it names: its head and its readers\' model and effort', () => {
  const out = lines([
    ...reader(D1, 1, { repo: 'o/r', pr: 7, head: 'aaaaaaaaaaaa1111' }),
    { ...reader(D1, 2, { repo: 'o/r', pr: 7, head: 'bbbbbbbbbbbb2222', effort: 'xhigh' })[0], ts: `${D1}T13:00:00.000Z` },
    ev(D2, 'escape', S(5), { source: 'pull_request', names: ['o/r#7', '#7', 'r#7', 'o/r#99'], target: { repo: 'o/r' } }),
    // The same fix, written twice with its target once with the pull request: one escape.
    ev(D2, 'escape', S(5), { source: 'pull_request', names: ['o/r#7', '#7', 'r#7', 'o/r#99'], target: { repo: 'o/r', pr: 12 } }),
  ])
  const day = out.slice(out.findIndex(l => l.startsWith('  2026-11-21  1 escape(s)')))
  assert.deepEqual(day.slice(0, 5), [
    '  2026-11-21  1 escape(s) naming 4 pull request(s), 3 joined to a review',
    '      o/r#7: read at bbbbbbbbbbbb by 1 reader(s) on claude-sonnet-5-5/xhigh',
    '      #7: read at bbbbbbbbbbbb by 1 reader(s) on claude-sonnet-5-5/xhigh',
    '      r#7: read at bbbbbbbbbbbb by 1 reader(s) on claude-sonnet-5-5/xhigh',
    '      o/r#99: no review reader of it in the store',
  ])
  assert.ok(out.includes('  2026-11-20  0 escape(s) naming 0 pull request(s), 0 joined to a review'), out.join('\n'))
})

test('a name that is no pull request, or a bare number with no repository, joins nothing', () => {
  const out = lines([...reader(D1, 1), ev(D2, 'escape', S(5), { source: 'commit', names: ['#7', 'nonsense'] })])
  assert.ok(out.includes('  2026-11-21  1 escape(s) naming 2 pull request(s), 0 joined to a review'), out.join('\n'))
})

test('readPrices: the file\'s models, or why there are none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unitcosts-'))
  try {
    const file = join(dir, 'prices.json')
    assert.deepEqual(readPrices(file), { why: `${file} is not readable (ENOENT)` })
    writeFileSync(file, '[1]')
    assert.deepEqual(readPrices(file), { why: `${file} holds no JSON object` })
    writeFileSync(file, '{"a": {"input": 1}, "b": 3}')
    assert.deepEqual(readPrices(file), { prices: { a: { input: 1 } } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
