// hooks/tests/usage.test.ts
// A session's token use and its API-equivalent cost (usage.ts): routing.py's cost rule
// spelled again over transcript lines, the day and the week in Paris time, and the book
// that keeps the sums current from the lines appended since the last read.
import { expect, test } from 'claude-code/testing'
import {
  periodStarts, recordOf, messageCost, sumsOf, newBook, settle, ingest, rewind, forget, usageOf, consumedOf,
  type Prices,
} from '../usage.ts'

const PRICES: Prices = {
  'a-model': { input: 4, output: 20, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2 },
  'b-model': {
    input: 0.1, output: 0.5, cache_write_5m: 0.125, cache_write_1h: 0.2, cache_read: 0.01,
    above: { tokens: 100000, input: 0.5, output: 2.5, cache_write_5m: 0.625, cache_write_1h: 1, cache_read: 0.05 },
  },
}

type Over = { id?: string | null; model?: string; at?: string; input?: number; output?: number; read?: number; write?: number; hour?: number; type?: string }
function line(over: Over = {}): string {
  const usage: Record<string, unknown> = {
    input_tokens: over.input ?? 10, output_tokens: over.output ?? 20,
    cache_read_input_tokens: over.read ?? 0, cache_creation_input_tokens: over.write ?? 0,
  }
  if (over.hour !== undefined) usage.cache_creation = { ephemeral_1h_input_tokens: over.hour, ephemeral_5m_input_tokens: (over.write ?? 0) - over.hour }
  const message: Record<string, unknown> = { model: over.model ?? 'a-model', usage, content: [] }
  if (over.id !== null) message.id = over.id ?? 'msg-1'
  return JSON.stringify({ type: over.type ?? 'assistant', timestamp: over.at ?? '2026-10-28T10:00:00.000Z', message })
}

const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-12

// --- the cost rule --------------------------------------------------------------------

test('a message is read from an assistant line with a model and a usage; anything else is none', () => {
  expect(recordOf(line())?.id).toBe('msg-1')
  expect(recordOf(line())?.record.at).toBe(Date.parse('2026-10-28T10:00:00.000Z'))
  expect(recordOf(line({ type: 'user' }))).toBeNull()
  expect(recordOf('{"type":"assistant"')).toBeNull()
  expect(recordOf(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1 } } }))).toBeNull()
  expect(recordOf(line({ id: null }))?.id).toBeNull()
})

test('a message whose four token counts are zero is the host\'s placeholder: no record', () => {
  expect(recordOf(line({ input: 0, output: 0, read: 0, write: 0 }))).toBeNull()
  expect(recordOf(line({ input: 0, output: 0, read: 0, write: 3 }))).not.toBeNull()
})

test('the 5-minute and the 1-hour cache writes are priced apart', () => {
  const record = recordOf(line({ input: 0, output: 0, write: 1000, hour: 400 }))!.record
  expect(near(messageCost(record, PRICES['a-model']), (600 * 5 + 400 * 8) / 1e6)).toBe(true)
  const unsplit = recordOf(line({ input: 0, output: 0, write: 1000 }))!.record
  expect(near(messageCost(unsplit, PRICES['a-model']), 1000 * 5 / 1e6)).toBe(true)
})

test('a tiered price switches to its upper rates past the threshold of the whole prompt', () => {
  const below = recordOf(line({ model: 'b-model', input: 50000, read: 50000, output: 10 }))!.record
  expect(near(messageCost(below, PRICES['b-model']), (50000 * 0.1 + 50000 * 0.01 + 10 * 0.5) / 1e6)).toBe(true)
  const above = recordOf(line({ model: 'b-model', input: 50000, read: 50000, write: 1, output: 10 }))!.record
  expect(near(messageCost(above, PRICES['b-model']), (50000 * 0.5 + 50000 * 0.05 + 1 * 0.625 + 10 * 2.5) / 1e6)).toBe(true)
})

test('one usage per message id, the last line of it read; a message without id counts each time', () => {
  const book = newBook()
  settle(book, Date.parse('2026-10-28T12:00:00Z'), PRICES, 'p')
  ingest(book, '/t.jsonl', 0, [line({ output: 5 }), line({ output: 7 }), line({ id: null }), line({ id: null })].join('\n') + '\n', 100)
  const usage = usageOf(book, Date.parse('2026-10-28T12:00:00Z'))
  expect(usage.day.tokens).toEqual({ input: 30, output: 47, cache_read: 0, cache_write: 0 })
})

test('a period where one message\'s model has no price costs null; its tokens still count', () => {
  const records = [recordOf(line())!.record, recordOf(line({ model: 'c-model', input: 5 }))!.record]
  const sums = sumsOf(records, PRICES, -Infinity)
  expect(sums.cost).toBeNull()
  expect(sums.tokens.input).toBe(15)
  expect(sumsOf(records.slice(0, 1), PRICES, -Infinity).cost).not.toBeNull()
})

test('a message without a timestamp is in no period, and in the whole transcript\'s sum', () => {
  const record = recordOf(JSON.stringify({ type: 'assistant', message: { id: 'x', model: 'a-model', usage: { input_tokens: 3 } } }))!.record
  expect(Number.isNaN(record.at)).toBe(true)
  expect(sumsOf([record], PRICES, Date.parse('2026-10-26T00:00:00Z')).tokens.input).toBe(0)
  expect(sumsOf([record], PRICES, -Infinity).tokens.input).toBe(3)
})

// --- the periods ----------------------------------------------------------------------

test('the day starts at midnight Paris, summer and winter alike', () => {
  expect(new Date(periodStarts(Date.parse('2026-07-15T12:00:00Z')).day).toISOString()).toBe('2026-07-14T22:00:00.000Z')
  expect(new Date(periodStarts(Date.parse('2026-12-15T12:00:00Z')).day).toISOString()).toBe('2026-12-14T23:00:00.000Z')
  expect(new Date(periodStarts(Date.parse('2026-07-14T22:30:00Z')).day).toISOString()).toBe('2026-07-14T22:00:00.000Z')
  expect(new Date(periodStarts(Date.parse('2026-07-14T21:30:00Z')).day).toISOString()).toBe('2026-07-13T22:00:00.000Z')
})

test('2026-10-25 lasts 25 hours: it starts in summer time and the next day in winter time', () => {
  const late = periodStarts(Date.parse('2026-10-25T22:30:00Z'))       // 23:30 Paris, still the 25th
  expect(new Date(late.day).toISOString()).toBe('2026-10-24T22:00:00.000Z')
  const next = periodStarts(Date.parse('2026-10-25T23:30:00Z'))       // 00:30 Paris on the 26th
  expect(new Date(next.day).toISOString()).toBe('2026-10-25T23:00:00.000Z')
  expect(next.day - late.day).toBe(25 * 3600 * 1000)
})

test('the week starts on Monday at midnight Paris: a minute after it is the new week', () => {
  const sunday = periodStarts(Date.parse('2026-10-25T22:59:00Z'))     // Sunday 23:59 Paris
  expect(new Date(sunday.week).toISOString()).toBe('2026-10-18T22:00:00.000Z')
  const monday = periodStarts(Date.parse('2026-10-25T23:01:00Z'))     // Monday 00:01 Paris
  expect(new Date(monday.week).toISOString()).toBe('2026-10-25T23:00:00.000Z')
  expect(monday.day).toBe(monday.week)
  const thursday = periodStarts(Date.parse('2026-10-29T09:00:00Z'))
  expect(new Date(thursday.week).toISOString()).toBe('2026-10-25T23:00:00.000Z')
})

// --- the book -------------------------------------------------------------------------

const NOW = Date.parse('2026-10-28T12:00:00Z')    // Wednesday 13:00 Paris

test('a message counts in a period by its timestamp: yesterday is in the week, not the day', () => {
  const book = newBook()
  settle(book, NOW, PRICES, 'p')
  ingest(book, '/t.jsonl', 0, [
    line({ id: 'today', at: '2026-10-28T08:00:00Z' }),
    line({ id: 'yesterday', at: '2026-10-27T08:00:00Z' }),
    line({ id: 'last-week', at: '2026-10-25T08:00:00Z' }),
  ].join('\n') + '\n', 300)
  const usage = usageOf(book, NOW)
  expect(usage.day.from).toBe('2026-10-27T23:00:00.000Z')
  expect(usage.week.from).toBe('2026-10-25T23:00:00.000Z')
  expect(usage.day.tokens.input).toBe(10)
  expect(usage.week.tokens.input).toBe(20)
  expect(near(usage.week.cost_usd, 2 * (10 * 4 + 20 * 20) / 1e6)).toBe(true)
  expect(usage.at).toBe(new Date(NOW).toISOString())
})

test('the offset moves by what was consumed, and the next read adds only its own lines', () => {
  const book = newBook()
  settle(book, NOW, PRICES, 'p')
  ingest(book, '/t.jsonl', 0, line({ id: 'a' }) + '\n', 120)
  expect(book.files.get('/t.jsonl')?.offset).toBe(120)
  ingest(book, '/t.jsonl', 120, line({ id: 'b' }) + '\n', 80)
  expect(book.files.get('/t.jsonl')?.offset).toBe(200)
  expect(usageOf(book, NOW).day.tokens.input).toBe(20)
})

test('a rewritten file is forgotten and read again from the start', () => {
  const book = newBook()
  settle(book, NOW, PRICES, 'p')
  ingest(book, '/t.jsonl', 0, [line({ id: 'a' }), line({ id: null })].join('\n') + '\n', 500)
  ingest(book, '/sub.jsonl', 0, line({ id: 's' }) + '\n', 100)
  rewind(book, '/t.jsonl')
  expect(book.files.get('/t.jsonl')?.offset).toBe(0)
  expect(usageOf(book, NOW).day.tokens.input).toBe(10)
  ingest(book, '/t.jsonl', 0, line({ id: 'a' }) + '\n', 120)
  expect(usageOf(book, NOW).day.tokens.input).toBe(20)
})

test('a boundary passed resets the period from the kept records, without a read', () => {
  const book = newBook()
  settle(book, NOW, PRICES, 'p')
  ingest(book, '/t.jsonl', 0, [
    line({ id: 'wed', at: '2026-10-28T08:00:00Z' }),
    line({ id: 'thu', at: '2026-10-28T23:30:00Z' }),   // 00:30 Paris on Thursday
  ].join('\n') + '\n', 300)
  expect(usageOf(book, NOW).day.tokens.input).toBe(20)
  const thursday = Date.parse('2026-10-29T09:00:00Z')
  settle(book, thursday, PRICES, 'p')
  const usage = usageOf(book, thursday)
  expect(usage.day.from).toBe('2026-10-28T23:00:00.000Z')
  expect(usage.day.tokens.input).toBe(10)
  expect(usage.week.tokens.input).toBe(20)
})

test('new prices reprice the kept records', () => {
  const book = newBook()
  settle(book, NOW, PRICES, 'p')
  ingest(book, '/t.jsonl', 0, line({ model: 'c-model' }) + '\n', 100)
  expect(usageOf(book, NOW).day.cost_usd).toBeNull()
  settle(book, NOW, { ...PRICES, 'c-model': PRICES['a-model'] }, 'q')
  expect(near(usageOf(book, NOW).day.cost_usd, (10 * 4 + 20 * 20) / 1e6)).toBe(true)
})

test('the reader\'s answer is the matched lines, then the byte count of the complete ones', () => {
  expect(consumedOf(`${line()}\n\x1e1234\n`)).toEqual({ text: `${line()}\n`, consumed: 1234 })
  expect(consumedOf('\x1e\n')).toEqual({ text: '', consumed: 0 })
  expect(consumedOf('')).toBeNull()
  expect(consumedOf('garbage\n')).toBeNull()
})

test('a message two files carry stays while either still does: forgetting or rewinding one keeps it', () => {
  const book = newBook()
  settle(book, NOW, PRICES, 'p')
  ingest(book, '/main.jsonl', 0, line({ id: 'shared' }) + '\n', 100)
  ingest(book, '/sub.jsonl', 0, line({ id: 'shared' }) + '\n', 100)
  forget(book, '/sub.jsonl')
  expect(usageOf(book, NOW).day.tokens.input).toBe(10)
  ingest(book, '/sub.jsonl', 0, line({ id: 'shared' }) + '\n', 100)
  rewind(book, '/main.jsonl')
  expect(usageOf(book, NOW).day.tokens.input).toBe(10)
  forget(book, '/sub.jsonl')
  expect(usageOf(book, NOW).day.tokens.input).toBe(0)
  expect(book.records.size).toBe(0)
})

test('a price missing a rate, or with a rate that is no finite number, is no price: the cost is null, never NaN', () => {
  const record = recordOf(line({ write: 100, hour: 40 }))!.record
  const { cache_write_1h, ...partial } = PRICES['a-model']
  const broken: Prices = {
    partial: partial as any,
    text: { ...PRICES['a-model'], input: '4' as any },
    none: { ...PRICES['a-model'], output: null as any },
    tier: { ...PRICES['b-model'], above: { ...PRICES['b-model'].above!, tokens: 'x' as any } },
    upper: { ...PRICES['b-model'], above: { ...PRICES['b-model'].above!, cache_read: null as any } },
  }
  for (const model of Object.keys(broken)) {
    expect(messageCost(record, broken[model])).toBeNull()
    const sums = sumsOf([{ ...record, model }], broken, -Infinity)
    expect(sums.cost).toBeNull()
    expect(sums.tokens.input).toBe(10)
  }
  // An upper tier that leaves a rate out takes the base one, as routing.py's rate.update does.
  const { cache_read, ...upperPartial } = PRICES['b-model'].above!
  const big = recordOf(line({ model: 'b-model', input: 200000, read: 1000, output: 10 }))!.record
  const cost = messageCost(big, { ...PRICES['b-model'], above: upperPartial as any })
  expect(near(cost, (200000 * 0.5 + 1000 * 0.01 + 10 * 2.5) / 1e6)).toBe(true)
})

test('the records older than the current week are pruned when the periods settle', () => {
  const book = newBook()
  settle(book, NOW, PRICES, 'p')
  ingest(book, '/t.jsonl', 0, [
    line({ id: 'old', at: '2026-10-20T08:00:00Z' }),
    line({ id: 'wed', at: '2026-10-28T08:00:00Z' }),
  ].join('\n') + '\n', 300)
  expect(book.records.has('old')).toBe(true)
  settle(book, Date.parse('2026-10-29T09:00:00Z'), PRICES, 'p')
  expect(book.records.has('old')).toBe(false)
  expect(book.records.has('wed')).toBe(true)
  expect(book.files.get('/t.jsonl')?.keys.has('old')).toBe(false)
  expect(usageOf(book, Date.parse('2026-10-29T09:00:00Z')).week.tokens.input).toBe(10)
})

test('a line that is no JSON is dropped and counted', () => {
  const book = newBook()
  settle(book, NOW, PRICES, 'p')
  ingest(book, '/t.jsonl', 0, [line({ id: 'a' }), '{"type":"assistant","message":{"usage":', line({ type: 'user' })].join('\n') + '\n', 300)
  expect(book.malformed).toBe(1)
  expect(usageOf(book, NOW).day.tokens.input).toBe(10)
})
