// The spend flag: the last hour's `api_call` events of every session priced by the orchestrator's
// prices and core's cost rule, the threshold read from the environment, the episode's start kept
// across rewrites, and the file recomputed no more often than every few minutes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SPEND_FLAG_EVERY_MS, SPEND_FLAG_STALE_AFTER_MS, SPEND_TOP_MAX, type SpendFlag } from '../../../../core/spend-flag.ts'
import type { Prices } from '../../../../core/usage-cost.ts'
import { makeEvent, type Event } from '../../../../hooks/collect.ts'
import {
  computeSpend, readPrices, readSpendFlag, recentCalls, refreshSpend, SPEND_THRESHOLD_DEFAULT, SPEND_THRESHOLD_VARIABLE, SPEND_WINDOW_MS, spendFlagPath, spendLine, spendThreshold, titleOfSession,
} from './spend.ts'

const NOW = Date.parse('2026-11-18T20:00:00Z')
const MINUTE = 60_000
const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const PRICES: Prices = {
  big: { input: 10, output: 50, cache_write_5m: 12.5, cache_write_1h: 20, cache_read: 0.25 },
  small: { input: 1, output: 5, cache_write_5m: 1.25, cache_write_1h: 2, cache_read: 0.1 },
}

/** One call of `million` output tokens, so a `big` call costs 50 dollars and a `small` one 5. */
function call(session: string, message: string, over: { model?: string; agoMs?: number; title?: string; agent?: string; million?: number } = {}): Event {
  return makeEvent('api_call', NOW - (over.agoMs ?? MINUTE), session, {
    message, model: over.model ?? 'big', title: over.title, agent: over.agent,
    usage: { input_tokens: 0, output_tokens: (over.million ?? 1) * 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
}
const flag = (events: Event[], over: { threshold?: number; previous?: SpendFlag | null; prices?: Prices } = {}): SpendFlag =>
  computeSpend({ events, prices: over.prices ?? PRICES, now: NOW, threshold: over.threshold ?? 100, previous: over.previous ?? null })

test('the rate is the window\'s priced calls in dollars an hour, over the threshold or not', () => {
  const calls = [call(A, 'm1'), call(A, 'm2', { model: 'small' })]
  const under = flag(calls, { threshold: 100 })
  assert.equal(under.rate_usd_per_hour, 55)
  assert.equal(under.over, false)
  assert.equal(under.since, null)
  assert.equal(under.calls, 2)
  const over = flag(calls, { threshold: 54 })
  assert.equal(over.over, true)
  assert.equal(over.since, NOW)
  assert.equal(over.threshold_usd_per_hour, 54)
  assert.equal(over.window_ms, SPEND_WINDOW_MS)
})

test('a call recorded twice is one, and a subagent\'s calls are its session\'s spend', () => {
  const result = flag([call(A, 'm1', { title: 'Orch: one' }), call(A, 'm1', { title: 'Orch: one' }), call(A, 'm2', { agent: 'child-1' }), call(B, 'm1', { model: 'small', title: 'Agent: two' })])
  assert.equal(result.rate_usd_per_hour, 105)
  assert.deepEqual(result.top, [{ session: A, name: 'Orch: one', usd: 100 }, { session: B, name: 'Agent: two', usd: 5 }])
})

test('a model with no price is counted as unpriced and left out of the rate', () => {
  const result = flag([call(A, 'm1'), call(A, 'm2', { model: 'mystery' })])
  assert.equal(result.rate_usd_per_hour, 50)
  assert.equal(result.unpriced, 1)
  assert.equal(result.calls, 2)
  assert.equal(flag([call(A, 'm1')], { prices: {} }).rate_usd_per_hour, 0)
})

test('the host\'s placeholder, a call with no counted token, is no call', () => {
  const placeholder = makeEvent('api_call', NOW - MINUTE, A, { message: 'm0', model: 'big', usage: { input_tokens: 0, output_tokens: 0 } })
  assert.equal(flag([placeholder]).calls, 0)
})

test('the top names at most the biggest spenders, most first, a session without a title by the start of its id', () => {
  const sessions = ['1', '2', '3', '4'].map(n => `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-000000000000`)
  const result = flag(sessions.map((s, i) => call(s, `m${s}`, { million: i + 1 })))
  assert.equal(result.top.length, SPEND_TOP_MAX)
  assert.deepEqual(result.top.map(s => s.name), ['44444444', '33333333', '22222222'])
  assert.match(result.line, /past 100 \$\/h — top: 44444444 200 \$, 33333333 150 \$, 22222222 100 \$/)
})

test('the line names the spenders only while the rate is over', () => {
  assert.equal(spendLine(55.4, 100, false, [{ session: A, name: 'x', usd: 55 }]), 'spend 55 $/h over the last hour, under 100 $/h')
  assert.equal(spendLine(500, 100, true, []), 'spend 500 $/h over the last hour, past 100 $/h')
  assert.match(spendLine(500, 100, true, [{ session: A, name: 'n'.repeat(60), usd: 400 }]), /n{39}… 400 \$$/)
  assert.equal(spendLine(500, 100, true, [{ session: A, name: 'a\nb\u001b[2Jc', usd: 400 }]), 'spend 500 $/h over the last hour, past 100 $/h — top: a b [2Jc 400 $')
  assert.equal(spendLine(0, 100, false, [], 3), 'spend 0 $/h over the last hour, under 100 $/h — 3 call(s) with no price, left out')
})

test('an episode keeps its start while it lasts, and starts again after a gap or a drop', () => {
  const first = flag([call(A, 'm1')], { threshold: 10 })
  const later = computeSpend({ events: [call(A, 'm1')], prices: PRICES, now: NOW + 5 * MINUTE, threshold: 10, previous: first })
  assert.equal(later.since, NOW)
  const afterGap = computeSpend({ events: [call(A, 'm1')], prices: PRICES, now: NOW + SPEND_FLAG_STALE_AFTER_MS + 1, threshold: 10, previous: first })
  assert.equal(afterGap.since, NOW + SPEND_FLAG_STALE_AFTER_MS + 1)
  const dropped = computeSpend({ events: [], prices: PRICES, now: NOW + MINUTE, threshold: 10, previous: first })
  assert.equal(dropped.over, false)
  assert.equal(dropped.since, null)
  assert.equal(computeSpend({ events: [call(A, 'm1')], prices: PRICES, now: NOW + 2 * MINUTE, threshold: 10, previous: dropped }).since, NOW + 2 * MINUTE)
})

test('the threshold is the environment\'s, else ~/.env\'s, else the default; a value that is no positive number is none', () => {
  assert.equal(spendThreshold({ [SPEND_THRESHOLD_VARIABLE]: '250' }, new Map()), 250)
  assert.equal(spendThreshold({}, new Map([[SPEND_THRESHOLD_VARIABLE, '300']])), 300)
  assert.equal(spendThreshold({ [SPEND_THRESHOLD_VARIABLE]: '250' }, new Map([[SPEND_THRESHOLD_VARIABLE, '300']])), 250)
  for (const bad of ['0', '-5', 'many', '']) assert.equal(spendThreshold({ [SPEND_THRESHOLD_VARIABLE]: bad }, new Map()), SPEND_THRESHOLD_DEFAULT)
  assert.equal(spendThreshold({}, new Map()), SPEND_THRESHOLD_DEFAULT)
})

function rig(work: (r: { dir: string; events: string; state: string; config: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-spend-'))
  try {
    const config = join(dir, 'config')
    const state = join(config, 'telemetry')
    const events = join(state, 'events')
    mkdirSync(events, { recursive: true })
    work({ dir, events, state, config })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const store = (dir: string, day: string, events: Event[]): void => writeFileSync(join(dir, `${day}.jsonl`), `${events.map(e => JSON.stringify(e)).join('\n')}\n`)

test('the calls of the window are read from the day files that overlap it, nothing older or later', () => {
  rig(({ events }) => {
    const midnight = Date.parse('2026-11-19T00:10:00Z')
    const at = (agoMin: number, message: string): Event => makeEvent('api_call', midnight - agoMin * MINUTE, A, { message, model: 'big', usage: { output_tokens: 1 } })
    store(events, '2026-11-18', [at(20, 'before-midnight'), at(90, 'too-old'), makeEvent('turn_end', midnight - MINUTE, A, {})])
    store(events, '2026-11-19', [at(5, 'after-midnight'), at(-5, 'future')])
    const found = recentCalls(events, midnight).map(e => e['message'])
    assert.deepEqual(found.sort(), ['after-midnight', 'before-midnight'])
    assert.deepEqual(recentCalls(join(events, 'nowhere'), midnight), [])
  })
})

test('the prices are the orchestrator\'s file, none when it is absent or no object', () => {
  rig(({ dir }) => {
    assert.deepEqual(readPrices(dir), {})
    mkdirSync(join(dir, 'routing'))
    writeFileSync(join(dir, 'routing', 'prices.json'), JSON.stringify(PRICES))
    assert.deepEqual(readPrices(dir), PRICES)
    writeFileSync(join(dir, 'routing', 'prices.json'), '[1]')
    assert.deepEqual(readPrices(dir), {})
    writeFileSync(join(dir, 'routing', 'prices.json'), '{"torn":')
    assert.deepEqual(readPrices(dir), {})
  })
})

test('the refresh writes the flag, and leaves a flag younger than its period alone unless forced', () => {
  rig(({ dir, events, state, config }) => {
    mkdirSync(join(dir, 'orch', 'routing'), { recursive: true })
    writeFileSync(join(dir, 'orch', 'routing', 'prices.json'), JSON.stringify(PRICES))
    store(events, '2026-11-18', [call(A, 'm1', { title: 'Orch: one' })])
    const options = { stateDir: state, eventsDir: events, config, env: { ORCHESTRATOR_MODULE_DIR: join(dir, 'orch'), [SPEND_THRESHOLD_VARIABLE]: '10' }, secrets: new Map<string, string>(), now: NOW }
    const written = refreshSpend(options)
    assert.equal(written?.over, true)
    assert.deepEqual(readSpendFlag(state), written)
    assert.equal(JSON.parse(readFileSync(spendFlagPath(state), 'utf8')).version, 1)
    assert.equal(refreshSpend({ ...options, now: NOW + SPEND_FLAG_EVERY_MS - 1 }), undefined)
    assert.equal(refreshSpend({ ...options, now: NOW + SPEND_FLAG_EVERY_MS - 1, force: true })?.since, NOW)
    assert.equal(refreshSpend({ ...options, now: NOW + 2 * SPEND_FLAG_EVERY_MS - 1 })?.since, NOW)
  })
})

test('a flag file that is no flag is rewritten, a clock that went back too', () => {
  rig(({ events, state, config }) => {
    writeFileSync(spendFlagPath(state), 'not json')
    const options = { stateDir: state, eventsDir: events, config, env: {}, secrets: new Map<string, string>(), now: NOW }
    assert.equal(readSpendFlag(state), null)
    assert.equal(refreshSpend(options)?.rate_usd_per_hour, 0)
    assert.equal(refreshSpend({ ...options, now: NOW - MINUTE })?.at, NOW - MINUTE)
  })
})

test('a spender no event names takes the name its transcript\'s head carries, else the start of its id', () => {
  rig(({ dir, events, state, config }) => {
    mkdirSync(join(config, 'projects', '-w'), { recursive: true })
    writeFileSync(join(config, 'projects', '-w', `${A}.jsonl`), `{"type":"custom-title","customTitle":"Orch: from the head"}\n{"type":"user"}\n`)
    writeFileSync(join(config, 'projects', '-w', `${B}.jsonl`), '{"type":"user"}\n')
    assert.equal(titleOfSession(config, A), 'Orch: from the head')
    assert.equal(titleOfSession(config, B), undefined)
    assert.equal(titleOfSession(config, 'cccccccc-0000-4000-8000-000000000003'), undefined)
    store(events, '2026-11-18', [call(A, 'm1'), call(B, 'm2', { million: 2 })])
    mkdirSync(join(dir, 'orch', 'routing'), { recursive: true })
    writeFileSync(join(dir, 'orch', 'routing', 'prices.json'), JSON.stringify(PRICES))
    const written = refreshSpend({ stateDir: state, eventsDir: events, config, env: { ORCHESTRATOR_MODULE_DIR: join(dir, 'orch') }, secrets: new Map<string, string>(), now: NOW })
    assert.deepEqual(written?.top.map(s => s.name), ['bbbbbbbb', 'Orch: from the head'])
  })
})
