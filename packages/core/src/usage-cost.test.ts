import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { COST_RULE, messageCost, recordOf, type Price } from './usage-cost.ts'

const OPUS: Price = { input: 4, output: 20, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2 }
const HAIKU: Price = {
  input: 0.1, output: 0.5, cache_write_5m: 0.125, cache_write_1h: 0.2, cache_read: 0.01,
  above: { tokens: 100000, input: 0.5, output: 2.5, cache_write_5m: 0.625, cache_write_1h: 1, cache_read: 0.05 },
}

function line(usage: Record<string, unknown>, over: { id?: string; type?: string; model?: string } = {}): string {
  return JSON.stringify({
    type: over.type ?? 'assistant', timestamp: '2026-11-18T10:00:00.000Z',
    message: { id: over.id ?? 'msg-1', model: over.model ?? 'opus', usage, content: [] },
  })
}

describe('the cost rule', () => {
  it('is version 1, priced per million tokens', () => {
    assert.equal(COST_RULE.version, 1)
    assert.equal(COST_RULE.per, 1_000_000)
  })

  it('reads a message from an assistant line with a model and a usage, and nothing else', () => {
    const read = recordOf(line({ input_tokens: 10, output_tokens: 20 }))
    assert.equal(read?.id, 'msg-1')
    assert.equal(read?.record.at, Date.parse('2026-11-18T10:00:00.000Z'))
    assert.equal(recordOf(line({ input_tokens: 10 }, { type: 'user' })), null)
    assert.equal(recordOf('{"type":"assistant"'), null)
    assert.equal(recordOf(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1 } } })), null)
  })

  it('skips the host\'s placeholder, a message whose counted tokens are all zero', () => {
    assert.equal(recordOf(line({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })), null)
  })

  it('prices each count at its rate, the 1-hour cache writes apart from the 5-minute ones', () => {
    const read = recordOf(line({
      input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 2_000_000, cache_creation: { ephemeral_1h_input_tokens: 500_000 },
    }))
    assert.ok(read)
    // 4 + 20 + 0.2 + 1.5 million of 5-minute writes at 5 + 0.5 million of 1-hour writes at 8
    assert.ok(Math.abs((messageCost(read.record, OPUS) ?? NaN) - (4 + 20 + 0.2 + 7.5 + 4)) < 1e-9)
  })

  it('switches to the upper rates when the prompt passes the tier\'s threshold', () => {
    const under = recordOf(line({ input_tokens: 90_000, output_tokens: 1000 }))
    const over = recordOf(line({ input_tokens: 90_000, cache_read_input_tokens: 20_000, output_tokens: 1000 }))
    assert.ok(under && over)
    assert.ok(Math.abs((messageCost(under.record, HAIKU) ?? NaN) - (0.009 + 0.0005)) < 1e-12)
    assert.ok(Math.abs((messageCost(over.record, HAIKU) ?? NaN) - (0.045 + 0.001 + 0.0025)) < 1e-12)
  })

  it('prices nothing, never NaN, when a rate is missing or no number', () => {
    const read = recordOf(line({ input_tokens: 5, output_tokens: 5 }))
    assert.ok(read)
    assert.equal(messageCost(read.record, { ...OPUS, output: Number.NaN }), null)
    assert.equal(messageCost(read.record, { input: 1 } as unknown as Price), null)
    assert.equal(messageCost(read.record, { ...OPUS, above: { tokens: 'x' } } as unknown as Price), null)
  })
})
