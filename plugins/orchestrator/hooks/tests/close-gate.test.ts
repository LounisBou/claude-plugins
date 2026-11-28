// hooks/tests/close-gate.test.ts
// The close gate in the session a close is asked of (his order of 2026-11-28): (a) three minutes
// since his last prompt and an empty box, a dictation's words in it included; (b) « succession
// engagée » shown; (c) a minute: « vas-y » goes, « patiente » or another prompt goes back to (a),
// silence goes.
import { expect, test } from 'claude-code/testing'
import type { Reply } from 'claude-code/testing'
import { capture, hookOf, hostOf, type CapturedOn } from '../../core/capture.ts'
import type { Events, Host, Noun } from '../../core/host.ts'
import {
  CLOSE_GATE_NOTICE_MS, CLOSE_GATE_QUIET_MS, CLOSE_GATE_TICK_MS, gateAskPath, gateHerePath, gateStatePath, parseGateState, type GateState,
} from '../../core/close-gate.ts'
import { answerContext, draftOf, look, NOTICE_TEXT, register, stepGate, type GateFacts } from '../close-gate.ts'

type World = Host<Noun>
const SID = 's-coord'
const ASK_AT = '2026-11-28T11:47:30.000Z'
const T0 = Date.parse(ASK_AT)
const MIN = 60_000

const facts = (over: Partial<GateFacts> = {}): GateFacts => ({ now: T0, askAt: ASK_AT, spoken: { at: T0 - 4 * MIN, text: 'une question' }, box: '', ...over })

// The gate walked look after look over a clock and his prompts, as the module walks it.
function walk() {
  let state: GateState | null = null
  const notices: number[] = []
  const at = (now: number, over: Partial<GateFacts> = {}) => {
    const out = stepGate(state, facts({ now, ...over }), SID)
    state = out.state
    if (out.notice) notices.push(now)
    return out.state
  }
  return { at, notices }
}

test('(a): no notice while his last prompt is under three minutes old', () => {
  const w = walk()
  const spoken = { at: T0 - MIN, text: 'je réponds' }
  expect(w.at(T0, { spoken }).phase).toBe('wait')
  expect(w.at(T0 + MIN, { spoken }).phase).toBe('wait')
  expect(w.notices).toEqual([])
  expect(w.at(T0 + 2 * MIN, { spoken }).phase).toBe('notice')
  expect(w.notices).toEqual([T0 + 2 * MIN])
})

test('(a): a box holding his words, a dictation still heard among them, or a box not read keeps it waiting', () => {
  const w = walk()
  expect(w.at(T0, { box: 'je dicte ma réponse' }).why).toMatch(/box holds text/)
  expect(w.at(T0 + MIN, { box: null }).why).toMatch(/cannot be read/)
  expect(w.notices).toEqual([])
  expect(w.at(T0 + 2 * MIN, { box: '  ' }).phase).toBe('notice')
})

test('(b) then (c): silence a minute after the notice releases the close', () => {
  const w = walk()
  expect(w.at(T0).phase).toBe('notice')
  expect(w.at(T0 + CLOSE_GATE_NOTICE_MS - CLOSE_GATE_TICK_MS).phase).toBe('notice')
  const go = w.at(T0 + CLOSE_GATE_NOTICE_MS)
  expect(go.phase).toBe('go')
  expect(go.why).toMatch(/no answer/)
  expect(w.notices).toEqual([T0])
})

test('(c): « vas-y » releases it at once', () => {
  const w = walk()
  w.at(T0)
  expect(w.at(T0 + 10_000, { spoken: { at: T0 + 5_000, text: 'Vas-y' } }).phase).toBe('go')
  expect(w.at(T0 + 15_000, { spoken: { at: T0 + 5_000, text: 'vas y' } }).phase).toBe('go')
})

test('(c): « patiente » goes back to (a), three minutes from it, and a new notice follows', () => {
  const w = walk()
  w.at(T0)
  const spoken = { at: T0 + 5_000, text: 'patiente' }
  expect(w.at(T0 + 10_000, { spoken }).phase).toBe('wait')
  expect(w.at(T0 + 10_000 + CLOSE_GATE_NOTICE_MS, { spoken }).phase).toBe('wait')
  expect(w.at(spoken.at + CLOSE_GATE_QUIET_MS, { spoken }).phase).toBe('notice')
  expect(w.notices).toEqual([T0, spoken.at + CLOSE_GATE_QUIET_MS])
})

test('(c): any other prompt of his, or his box filling, goes back to (a)', () => {
  const w = walk()
  w.at(T0)
  expect(w.at(T0 + 10_000, { spoken: { at: T0 + 5_000, text: 'attends, une dernière chose' } }).phase).toBe('wait')
  const v = walk()
  v.at(T0)
  expect(v.at(T0 + 10_000, { box: 'je commence' }).phase).toBe('wait')
})

test('a released gate is taken back by a prompt of his or his box until the close comes', () => {
  const w = walk()
  w.at(T0)
  expect(w.at(T0 + CLOSE_GATE_NOTICE_MS).phase).toBe('go')
  expect(w.at(T0 + CLOSE_GATE_NOTICE_MS + 5_000).phase).toBe('go')
  expect(w.at(T0 + CLOSE_GATE_NOTICE_MS + 10_000, { box: 'oh' }).phase).toBe('wait')
  const v = walk()
  v.at(T0)
  v.at(T0 + 5_000, { spoken: { at: T0 + 1_000, text: 'vas-y' } })
  expect(v.at(T0 + 10_000, { spoken: { at: T0 + 1_000, text: 'vas-y' } }).phase).toBe('go')
  expect(v.at(T0 + 20_000, { spoken: { at: T0 + 15_000, text: 'non, attends' } }).phase).toBe('wait')
})

test('a state of another ask is no state: a new close starts at (a)', () => {
  const w = walk()
  w.at(T0)
  expect(w.at(T0 + CLOSE_GATE_NOTICE_MS).phase).toBe('go')
  const other = stepGate(parseGateState(JSON.stringify(w.at(T0 + CLOSE_GATE_NOTICE_MS + 1))), facts({ now: T0 + 2 * MIN, askAt: '2026-11-28T12:00:00.000Z' }), SID)
  expect(other.state.phase).toBe('notice')
  expect(other.notice).toBe(true)
})

test('his answer to the notice is told to the model beside it; outside the notice nothing is added', () => {
  expect(answerContext('patiente', 'notice')).toMatch(/« patiente »/)
  expect(answerContext('vas-y', 'notice')).toMatch(/« vas-y »/)
  expect(answerContext('patiente', 'wait')).toBeNull()
  expect(answerContext('autre chose', 'notice')).toBeNull()
})

test('the box\'s draft as the host answers it', () => {
  expect(draftOf({ text: 'je dicte', cursor: 8 })).toBe('je dicte')
  expect(draftOf(undefined)).toBeNull()
})

// A host over files in memory, the box and the clock the test's.
function world(box: () => unknown) {
  const files = new Map<string, string>()
  const shown: string[] = []
  let now = T0
  const $ = hostOf({
    plugin: { root: '/plugin' },
    env: { get: async (name: string) => (name === 'ORCHESTRATOR_MODULE_DIR' ? '/mod' : name === 'HOME' ? '/home' : undefined) },
    fs: {
      read: async (p: string) => { const text = files.get(p); if (text === undefined) throw new Error('ENOENT'); return text },
      write: async (p: string, text: string) => { files.set(p, text) },
      stat: async () => { throw new Error('ENOENT') },
    },
    process: {
      run: async (argv: readonly string[]) => {
        if (argv[0] === 'mv') { const text = files.get(String(argv[argv.length - 2])); if (text !== undefined) files.set(String(argv[argv.length - 1]), text) }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    clock: { now: async () => now, sleep: async () => undefined },
    prompt: { read: async () => box() },
    ui: { log: (text: string) => { shown.push(`log:${text}`) }, toast: (text: string) => { shown.push(`toast:${text}`) } },
  })
  return { $, files, shown, at: (ms: number) => { now = ms } }
}

test('a look reads the box through the host, writes the state, and shows the notice in the session once', async () => {
  let draft = 'je dicte'
  const w = world(() => ({ text: draft, cursor: 0 }))
  expect(await look(w.$, SID, { at: T0 - 4 * MIN, text: '' })).toBeNull()
  w.files.set(gateAskPath('/mod/store', SID), JSON.stringify({ v: 1, sid: SID, at: ASK_AT, by: 'takeover' }))
  expect((await look(w.$, SID, { at: T0 - 4 * MIN, text: '' }))?.phase).toBe('wait')
  expect(w.shown).toEqual([])
  draft = ''
  w.at(T0 + 5_000)
  expect((await look(w.$, SID, { at: T0 - 4 * MIN, text: '' }))?.phase).toBe('notice')
  w.at(T0 + 10_000)
  await look(w.$, SID, { at: T0 - 4 * MIN, text: '' })
  expect(w.shown).toEqual([`log:${NOTICE_TEXT}`, `toast:${NOTICE_TEXT}`])
  const state = parseGateState(w.files.get(gateStatePath('/mod/store', SID)) ?? '')
  expect(state?.phase).toBe('notice')
  expect(state?.ask_at).toBe(ASK_AT)
})

test('the module counts his prompts, not a peer\'s, and tells the model of his « patiente » during the notice', async () => {
  const w = world(() => ({ text: '', cursor: 0 }))
  const ticks: Array<() => void> = []
  const $ = { ...w.$, session: { ...w.$.session, id: async () => SID }, clock: { ...w.$.clock, every: (_ms: number, fn: () => void) => { ticks.push(fn); return { cancel: () => undefined } } } } as World
  const hooks = capture<World>(register)
  const submit = hookOf(hooks, 'prompt.submit', {}) as CapturedOn<World, 'prompt.submit'>
  const pass = async (e: Events['prompt.submit']) => e
  const tick = async () => { ticks[0]?.(); for (let i = 0; i < 200; i++) await Promise.resolve() }
  w.files.set(gateAskPath('/mod/store', SID), JSON.stringify({ v: 1, sid: SID, at: ASK_AT, by: 'close' }))
  // His prompt at T0: three minutes from it before any notice; a peer's message counts for nothing.
  await submit.handler($, { text: 'une question', origin: { kind: 'composer' } }, pass)
  w.at(T0 + CLOSE_GATE_QUIET_MS - 1)
  await submit.handler($, { text: 'takeover confirmed', origin: { kind: 'peer' } }, pass)
  await tick()
  expect(parseGateState(w.files.get(gateStatePath('/mod/store', SID)) ?? '')?.phase).toBe('wait')
  // Its first look says the module runs here: the launcher asks a gate of this session only then.
  expect(JSON.parse(w.files.get(gateHerePath('/mod/store', SID)) ?? '{}')).toMatchObject({ v: 1, sid: SID })
  w.at(T0 + CLOSE_GATE_QUIET_MS)
  await tick()
  expect(parseGateState(w.files.get(gateStatePath('/mod/store', SID)) ?? '')?.phase).toBe('notice')
  w.at(T0 + CLOSE_GATE_QUIET_MS + 5_000)
  const answered = await submit.handler($, { text: 'patiente', origin: { kind: 'bridge' } }, pass) as Reply
  expect(answered.context?.join('\n')).toMatch(/« patiente »/)
  w.at(T0 + CLOSE_GATE_QUIET_MS + CLOSE_GATE_NOTICE_MS + 5_000)
  await tick()
  expect(parseGateState(w.files.get(gateStatePath('/mod/store', SID)) ?? '')?.phase).toBe('wait')
})
