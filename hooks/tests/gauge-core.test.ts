// hooks/tests/gauge-core.test.ts
import { expect, test } from 'claude-code/testing'
import { tripGate, parseMeasure, measureFilePath } from '../gauge-core.ts'
import { driftAnnouncement, writeMeasure, takeDrift, register as registerGauge } from '../gauge.ts'

test('the gate trips at 80 percent of the window', () => {
  expect(tripGate(79, 79000, 100000).tripped).toBe(false)
  expect(tripGate(80, 80000, 100000).tripped).toBe(true)
})

test('the gate trips at 300,000 tokens on a window of 1,000,000 or more', () => {
  expect(tripGate(29, 299999, 1000000).tripped).toBe(false)
  expect(tripGate(30, 300000, 1000000).tripped).toBe(true)
  expect(tripGate(31, 310000, 1200000).tripped).toBe(true)
})

test('a 300,000 window, an agent compacting there, trips at 240,000 and a 1,000,000 window still at 300,000', () => {
  expect(tripGate(79, 239999, 300000).tripped).toBe(false)
  expect(tripGate(80, 240000, 300000).tripped).toBe(true)
  expect(tripGate(29, 299999, 1000000).tripped).toBe(false)
  expect(tripGate(30, 300000, 1000000).tripped).toBe(true)
})

test('a window under a million no longer defers the token gate', () => {
  expect(tripGate(50, 300000, 400000).tripped).toBe(true)
  expect(tripGate(50, 299999, 400000).tripped).toBe(false)
})

test('an unreadable reading never trips', () => {
  expect(tripGate(null, null, null).tripped).toBe(false)
})

test('the tripped words name what was read', () => {
  expect(tripGate(80, 80000, 100000).words).toBe('80% (gate 80%)') // the gate: the smaller of 300,000 tokens (30 %) and 80 % of the reported window: 300,000 on 1,000,000, 533,000 or 400,000; 160,000 on 200,000
  expect(tripGate(30, 300000, 1000000).words).toBe('300,000 tokens (gate 300,000 on a 1M window)')
})

test('env overrides move the thresholds', () => {
  expect(tripGate(50, 50000, 100000, { gate: 50 }).tripped).toBe(true)
  expect(tripGate(10, 100000, 1000000, { gateTokens: 100000 }).tripped).toBe(true)
})

test('the measure file is one JSON line at the session path', async () => {
  const writes: [string, string][] = []
  const $ = {
    fs: { write: async (p: string, c: string) => { writes.push([p, c]) } },
    env: { get: async (name: string) => (name === 'CLAUDE_CONFIG_DIR' ? '/cfg' : undefined) },
  }
  await writeMeasure($, 's1',
    { context_tokens: 123, context_window: 1000, context_percent: 12, model: 'a-model', updated_at: 't' })
  expect(measureFilePath('/cfg', 's1')).toBe('/cfg/claude-orchestrator/measure/s1.json')
  expect(measureFilePath('/cfg', 's1', '/sandbox/module')).toBe('/sandbox/module/measure/s1.json')
  expect(writes[0][0]).toBe('/cfg/claude-orchestrator/measure/s1.json')
  expect(writes[0][1]).toBe('{"context_tokens":123,"context_window":1000,"context_percent":12,"model":"a-model","updated_at":"t"}\n')
})

test('a model change is announced once, naming both models', () => {
  const a = driftAnnouncement('a-model', 'another-model')
  expect(a).toBe('MODEL DRIFT: this session now answers as a-model; it answered as another-model until now. The host switched on its own (a refusal, an outage): say it to the operator in your next message; a succession does not repair it.')
})

test('a partial or empty measure line reads as unmeasured, never throws', () => {
  expect(parseMeasure('')).toBeNull()
  expect(parseMeasure('{"context_tokens":123')).toBeNull()
  expect(parseMeasure('{"context_tokens":123,"context_window":1000,"context_percent":12,"model":"a-model","updated_at":"t"}')).toMatchObject({ context_tokens: 123 })
})

test('a fresh module load announces no drift, and a later change is announced once', async () => {
  // A reload re-evaluates the module file, so lastModel starts at null on every
  // load (the host refuses import() in module code, so the reload is pinned by its
  // observable rule): the first measure of a load announces nothing — there is no
  // previous model to drift from — and a change between two measures of the same
  // load is announced exactly once, never re-announced on the next measure.
  const toasts: string[] = []
  let answersAs = 'a-model'
  const handlers: Record<string, Function> = {}
  // The engine's on returns a registration taking one .catch; the fake
  // accepts it and drops it — the body's own catch is what this test drives.
  registerGauge((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    handlers[args[0]] = args[args.length - 1] as Function
    return { catch: () => undefined }
  })
  const $ = {
    session: {
      usage: async () => ({ context: { tokens: 1, window: 2, percent: 3 } }),
      model: async () => answersAs,
      id: async () => 's1',
    },
    fs: { write: async () => undefined },
    env: { get: async (name: string) => (name === 'HOME' ? '/tmp/h' : undefined) },
    ui: { toast: (text: string) => { toasts.push(text) }, invalidate: () => undefined },
  }
  const through = (e: unknown) => e
  await handlers['session.measure']($, {}, through)
  expect(toasts).toEqual([])
  answersAs = 'another-model'
  await handlers['session.measure']($, {}, through)
  expect(toasts).toEqual([driftAnnouncement('another-model', 'a-model')])
  await handlers['session.measure']($, {}, through)
  expect(toasts).toEqual([driftAnnouncement('another-model', 'a-model')])
  // The toast fades; the line itself waits for the model's next prompt, handed once.
  expect(takeDrift()).toBe(driftAnnouncement('another-model', 'a-model'))
  expect(takeDrift()).toBeNull()
})

test('a compaction empties the measure file, and a measure without figures forgets the old ones', async () => {
  // After /compact the figures measured before it are no longer the conversation's:
  // the gate reads the measure file, and the next prompt was told the old fill.
  const handlers: Record<string, Function> = {}
  registerGauge((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    handlers[args[0]] = args[args.length - 1] as Function
    return { catch: () => undefined }
  })
  const writes: [string, string][] = []
  let usage: object = { context: { tokens: 850, window: 1000, percent: 85 } }
  const $ = {
    session: { usage: async () => usage, model: async () => 'a-model', id: async () => 's-compact' },
    fs: { write: async (p: string, t: string) => { writes.push([p, t]) } },
    env: { get: async (name: string) => (name === 'CLAUDE_CONFIG_DIR' ? '/tmp/cfg' : undefined) },
    ui: { toast: () => undefined, invalidate: () => undefined },
  }
  const path = measureFilePath('/tmp/cfg', 's-compact')
  await handlers['session.measure']($, {}, (x: unknown) => x)
  const e = { trigger: 'manual', messages: [] }
  expect(await handlers['session.compact']($, e, (x: unknown) => x)).toBe(e)
  expect(writes[writes.length - 1]).toEqual([path, ''])
  // A subagent's compaction is its own.
  writes.length = 0
  await handlers['session.compact']($, { ...e, agentId: 'a-1' }, (x: unknown) => x)
  expect(writes).toEqual([])
  // Measured again, then a measure with no token count: the figures are forgotten.
  await handlers['session.measure']($, {}, (x: unknown) => x)
  usage = { context: { window: 1000 } }
  await handlers['session.measure']($, {}, (x: unknown) => x)
  expect(writes[writes.length - 1]).toEqual([path, ''])
  takeDrift()
})

test('a measure before the first answer writes nothing and logs nothing', async () => {
  // Live finding: the host leaves the token count and the percentage out until the
  // session's first answer, and a reading carrying them as undefined crashed every
  // reader on toLocaleString. Such a measure is no measure: no file, no log line.
  const handlers: Record<string, Function> = {}
  registerGauge((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    handlers[args[0]] = args[args.length - 1] as Function
    return { catch: () => undefined }
  })
  const writes: string[] = []
  const $ = {
    session: {
      usage: async () => ({ context: { window: 1000000 } }),
      model: async () => 'a-model',
      id: async () => 's-early',
    },
    fs: { write: async (p: string) => { writes.push(p) }, read: async () => '' },
    env: { get: async (name: string) => (name === 'HOME' ? '/tmp/h' : undefined) },
    ui: { toast: () => undefined, invalidate: () => undefined },
  }
  const e = {}
  expect(await handlers['session.measure']($, e, (x: unknown) => x)).toBe(e)
  expect(writes).toEqual([])
})

test('a measure line without its figures reads as unmeasured', () => {
  expect(parseMeasure('{"context_window":1000000,"model":"a-model","updated_at":"t"}')).toBeNull()
  expect(parseMeasure('{"context_tokens":null,"context_window":1000,"context_percent":1}')).toBeNull()
  expect(parseMeasure('null')).toBeNull()
})

test('an orchestrator launched with a 75 percent gate trips at 300,000 tokens on either reading', () => {
  const env = { gate: 75 }
  expect(tripGate(29, 299999, 1000000, env).tripped).toBe(false)
  expect(tripGate(30, 300000, 1000000, env).tripped).toBe(true)
  expect(tripGate(74, 299999, 400000, env).tripped).toBe(false)
  expect(tripGate(75, 300000, 400000, env).tripped).toBe(true)
  expect(tripGate(75, 300000, 400000, env).words).toBe('75% (gate 75%)')
})

test('an explicit 75 percent gate trips at 300,000 tokens on a 400,000 window', () => {
  expect(tripGate(75, 300000, 400000, { gate: 75 }).tripped).toBe(true)
  expect(tripGate(88, 350000, 400000, { gate: 75 }).tripped).toBe(true)
})

// The gate is a token count no window moves: the smaller of the gate in tokens and the
// percentage of the reported window. The operator sets the host's compaction window, so a
// session may report 533,000 and must hand over at the same token count as on 1,000,000.
const SMALL_WINDOW = 200000
const SMALL_GATE = SMALL_WINDOW * 4 / 5

test('an orchestrator trips at the same token count on 1,000,000 and on 533,000, and by percentage on a small window', () => {
  for (const window of [1000000, 533000]) {
    expect(tripGate(56, 299999, window).tripped).toBe(false)
    expect(tripGate(56, 300000, window).tripped).toBe(true)
  }
  expect(tripGate(79, SMALL_GATE - 1, SMALL_WINDOW).tripped).toBe(false)
  expect(tripGate(80, SMALL_GATE, SMALL_WINDOW).tripped).toBe(true)
})

test('an agent trips at the same token count on 1,000,000 and on 533,000, and by percentage on a small window', () => {
  const env = { gateTokens: 240000 }
  for (const window of [1000000, 533000]) {
    expect(tripGate(45, 239999, window, env).tripped).toBe(false)
    expect(tripGate(45, 240000, window, env).tripped).toBe(true)
  }
  expect(tripGate(79, SMALL_GATE - 1, SMALL_WINDOW, env).tripped).toBe(false)
  expect(tripGate(80, SMALL_GATE, SMALL_WINDOW, env).tripped).toBe(true)
})

test('on 533,000 the words name the token gate, not the percentage', () => {
  expect(tripGate(57, 304000, 533000).words).toBe('304,000 tokens (gate 300,000 on a 533,000 window)')
})
