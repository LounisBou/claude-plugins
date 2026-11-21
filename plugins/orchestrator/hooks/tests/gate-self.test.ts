// hooks/tests/gate-self.test.ts
// An agent crossing its context gate is told in its own session (relay.ts gateSelfText, sent by
// supervision.ts reportGate), once per crossing, whether or not its orchestrator is reached; the
// orchestrator still gets its own line once, at the measure that crossed, even while the host holds
// the agent's own line for the end of its turn.
import { expect, test } from 'claude-code/testing'
import { gateSelfText, gateText } from '../relay.ts'
import { reportGate } from '../supervision.ts'
import { logLineOf } from './fakes.ts'

const HOME = '/tmp/gs'
const GATE = `${HOME}/.claude/claude-orchestrator/store/gates/s-one`
const AGENT = 'Agent: belt-p3'
const ORCH = 'Orch: belt'

// How the host answers each of the agent's own lines in turn, the rest taken at once: `hold` keeps it
// for the end of the agent's turn (release), `hold-drop` keeps it and drops it then, `reject` refuses it.
type Submit = 'take' | 'hold' | 'hold-drop' | 'reject'
// How each send to the orchestrator answers in turn, the rest delivered: delivered or not, `hang`
// never answering, `late` delivered at release, `throw` failing.
type Deliver = boolean | 'hang' | 'late' | 'throw'

function fake(over: { orchestrator?: boolean; drop?: boolean; submits?: Submit[]; deliver?: Deliver[] } = {}) {
  const files = new Map<string, string>()
  const submitted: string[] = []
  const held: (() => void)[] = []
  const submits = [...over.submits ?? []]
  const deliver = [...over.deliver ?? []]
  const sent: { to: unknown; text: string }[] = []
  const logged: string[] = []
  const env: Record<string, string> = { HOME, ORCHESTRATOR_CONTEXT_GATE_TOKENS: '200000' }
  if (over.orchestrator !== false) {
    env['ORCHESTRATOR_REPORTS_TO'] = `${ORCH} [a1b2c3]`
    files.set(`${HOME}/.claude/sessions/620.json`, JSON.stringify({ pid: 620, sessionId: 's-orch', name: ORCH, startedAt: 1, kind: 'interactive', entrypoint: 'cli' }))
  }
  const dollar = {
    env: { get: async (name: string) => env[name] },
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    fs: {
      read: async (p: string) => {
        const text = files.get(p)
        if (text === undefined) throw new Error(`ENOENT: ${p}`)
        return text
      },
      write: async (p: string, text: string) => { files.set(p, text) },
      exists: async (p: string) => files.has(p),
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
      stat: async (p: string) => { throw new Error(`ENOENT: ${p}`) },
    },
    process: {
      run: async (argv: readonly string[]) => {
        const line = logLineOf(argv)
        if (line !== null) logged.push(line)
        if (argv[0] === 'ps' && argv[1] === '-A') return { exitCode: 0, stdout: '620\n', stderr: '' }
        return { exitCode: line !== null ? 0 : 1, stdout: '', stderr: '' }
      },
    },
    prompt: {
      submit: async ({ text }: { text: string }) => {
        if (over.drop) return { drop: 'busy' }
        const how = submits.shift() ?? 'take'
        if (how === 'reject') throw new Error('the host is gone')
        submitted.push(text)
        if (how === 'hold') return new Promise<undefined>(resolve => held.push(() => resolve(undefined)))
        if (how === 'hold-drop') return new Promise<{ drop: string }>(resolve => held.push(() => resolve({ drop: 'interrupted' })))
        return undefined
      },
    },
    session: {
      id: async () => 's-one',
      send: async (args: { to: unknown; text: string }) => {
        sent.push(args)
        const how = deliver.shift() ?? true
        if (how === 'hang') return new Promise<never>(() => undefined)
        if (how === 'late') return new Promise<{ isDelivered: boolean }>(resolve => held.push(() => resolve({ isDelivered: true })))
        if (how === 'throw') throw new Error('the peer is gone')
        return { isDelivered: how }
      },
    },
  }
  // The agent's turn ends: the host answers every line it held.
  const release = () => held.splice(0).forEach(take => take())
  return { dollar, files, submitted, sent, logged, release }
}

const reading = (tokens: number) => ({ context_tokens: tokens, context_percent: Math.round(tokens / 10000), context_window: 1000000 })
// The fake holds only the nouns reportGate calls.
const report = (fx: ReturnType<typeof fake>, tokens: number, bound?: number) => reportGate(fx.dollar as never, 's-one', AGENT, '/dev/ttys005', reading(tokens), bound)
// A report's bound where one is meant to run out, and the time a test gives what waits on it.
const BOUND = 50
const within = (work: Promise<unknown>, ms: number) => Promise.race([work.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms))])
const toOrchestrator = (tokens: number) => ({ to: { sessionId: 's-orch' }, text: gateText(AGENT, tokens, Math.round(tokens / 10000)) })
const toAgent = (tokens: number) => gateSelfText(tokens, Math.round(tokens / 10000))
// Every promise the fake's nouns answer is settled by the next macrotask: they run no timer.
const settled = () => new Promise<void>(resolve => setTimeout(resolve, 0))
// Whether a report is over once the work it queued has run, rather than waiting on a line the host holds.
const over = (work: Promise<unknown>) => Promise.race([work.then(() => true), settled().then(() => false)])
// A measure's report, and the host's answers to what it put, all written.
const measure = async (fx: ReturnType<typeof fake>, tokens: number) => {
  await report(fx, tokens)
  await settled()
}

test('the agent is told at its own gate once per crossing, and its orchestrator once', async () => {
  const fx = fake()
  await report(fx, 120000)
  expect(fx.submitted).toEqual([])
  await report(fx, 210000)
  await report(fx, 230000)
  expect(fx.submitted).toEqual([gateSelfText(210000, 21)])
  expect(fx.sent).toEqual([{ to: { sessionId: 's-orch' }, text: `[module] ${AGENT} context 210,000 (21%) — at the gate` }])
  // Back under the gate (a compaction), then over again: a new crossing, told again.
  await report(fx, 40000)
  await report(fx, 205000)
  expect(fx.submitted.length).toBe(2)
  expect(fx.files.get(GATE)).toBe('reported\n')
})

test('the agent is told even when no orchestrator is found, and not told again while it is looked for', async () => {
  const fx = fake({ orchestrator: false })
  await report(fx, 210000)
  await report(fx, 220000)
  expect(fx.submitted).toEqual([gateSelfText(210000, 21)])
  expect(fx.sent).toEqual([])
  expect(fx.files.get(GATE)).toBe('told\n')
})

test('a line the host drops is tried again at the next measure', async () => {
  const fx = fake({ drop: true })
  await report(fx, 210000)
  expect(fx.files.get(GATE)).toBe('sent\n')
  expect(fx.logged.some(line => line.includes('dropped'))).toBe(true)
  expect(fx.sent.length).toBe(1)
})

test("a crossing mid-turn reaches the orchestrator at the measure that crossed, once, and the agent once, whose line the host holds", async () => {
  const fx = fake({ submits: ['hold'] })
  expect(await over(report(fx, 210000))).toBe(true)
  expect(fx.sent).toEqual([toOrchestrator(210000)])
  expect(await over(report(fx, 220000))).toBe(true)
  expect(await over(report(fx, 230000))).toBe(true)
  expect(fx.sent).toEqual([toOrchestrator(210000)])
  expect(fx.submitted).toEqual([toAgent(210000)])
  // The agent's turn ends and the host takes its line: the crossing is reported, and said no more.
  fx.release()
  await settled()
  expect(fx.files.get(GATE)).toBe('reported\n')
  await measure(fx, 240000)
  expect(fx.sent).toEqual([toOrchestrator(210000)])
  expect(fx.submitted).toEqual([toAgent(210000)])
})

test('two measures at once past the gate send one line to the orchestrator and one to the agent', async () => {
  const fx = fake()
  await Promise.all([report(fx, 210000), report(fx, 211000)])
  await settled()
  expect(fx.sent).toEqual([toOrchestrator(210000)])
  expect(fx.submitted).toEqual([toAgent(210000)])
  expect(fx.files.get(GATE)).toBe('reported\n')
})

test("a line not delivered to the orchestrator is sent at the next measure, and a new crossing is reported again", async () => {
  const fx = fake({ deliver: [false] })
  await measure(fx, 210000)
  expect(fx.files.get(GATE)).toBe('told\n')
  await measure(fx, 220000)
  expect(fx.sent).toEqual([toOrchestrator(210000), toOrchestrator(220000)])
  expect(fx.files.get(GATE)).toBe('reported\n')
  await measure(fx, 230000)
  await measure(fx, 40000)
  await measure(fx, 205000)
  expect(fx.sent).toEqual([toOrchestrator(210000), toOrchestrator(220000), toOrchestrator(205000)])
  expect(fx.submitted).toEqual([toAgent(210000), toAgent(205000)])
})

test("a line not delivered while the host holds the agent's: the agent's, once taken, marks it told alone, and the orchestrator's goes at a later measure", async () => {
  const fx = fake({ submits: ['hold'], deliver: [false, false] })
  expect(await over(report(fx, 210000))).toBe(true)
  fx.release()
  await settled()
  expect(fx.files.get(GATE)).toBe('told\n')
  await measure(fx, 220000)
  expect(fx.files.get(GATE)).toBe('told\n')
  await measure(fx, 230000)
  expect(fx.sent).toEqual([toOrchestrator(210000), toOrchestrator(220000), toOrchestrator(230000)])
  expect(fx.submitted).toEqual([toAgent(210000)])
  expect(fx.files.get(GATE)).toBe('reported\n')
})

test("a fall back under the gate while the host holds the agent's line: taken later, it marks nothing, and the next crossing tells the agent again", async () => {
  const fx = fake({ submits: ['hold'] })
  expect(await over(report(fx, 210000))).toBe(true)
  await measure(fx, 40000)
  fx.release()
  await settled()
  expect(fx.files.get(GATE)).toBe('')
  await measure(fx, 205000)
  expect(fx.submitted).toEqual([toAgent(210000), toAgent(205000)])
  expect(fx.sent).toEqual([toOrchestrator(210000), toOrchestrator(205000)])
  expect(fx.files.get(GATE)).toBe('reported\n')
})

test("an agent's line the host refuses leaves the orchestrator's delivered, and is tried again at the next measure", async () => {
  const fx = fake({ submits: ['reject'] })
  await measure(fx, 210000)
  expect(fx.sent).toEqual([toOrchestrator(210000)])
  expect(fx.files.get(GATE)).toBe('sent\n')
  expect(fx.logged.some(line => line.includes('gate:') && line.includes('the host is gone'))).toBe(true)
  await measure(fx, 220000)
  expect(fx.submitted).toEqual([toAgent(220000)])
  expect(fx.sent).toEqual([toOrchestrator(210000)])
  expect(fx.files.get(GATE)).toBe('reported\n')
})

test('a send that throws fails its own measure alone: the next one sends and reports the crossing', async () => {
  const fx = fake({ deliver: ['throw'] })
  await report(fx, 210000).catch(() => undefined)
  await settled()
  await measure(fx, 220000)
  expect(fx.sent).toEqual([toOrchestrator(210000), toOrchestrator(220000)])
  expect(fx.files.get(GATE)).toBe('reported\n')
})

test("a send that never answers holds no later measure past its bound: the next one sends, and the stuck one is logged", async () => {
  const fx = fake({ deliver: ['hang'] })
  void report(fx, 210000, BOUND)
  await settled()
  expect(await within(measure(fx, 220000), BOUND * 10)).toBe(true)
  expect(fx.sent).toEqual([toOrchestrator(210000), toOrchestrator(220000)])
  expect(fx.files.get(GATE)).toBe('reported\n')
  expect(fx.logged.some(line => line.includes(`gate: a report of ${AGENT} did not finish within ${BOUND} ms`))).toBe(true)
})

test('a fall under the gate behind a send that never answers still clears the mark, and the next crossing is reported', async () => {
  const fx = fake({ deliver: ['hang'] })
  void report(fx, 210000, BOUND)
  await settled()
  expect(await within(measure(fx, 40000), BOUND * 10)).toBe(true)
  expect(fx.files.get(GATE)).toBe('')
  await measure(fx, 205000)
  expect(fx.submitted).toEqual([toAgent(210000), toAgent(205000)])
  expect(fx.sent).toEqual([toOrchestrator(210000), toOrchestrator(205000)])
  expect(fx.files.get(GATE)).toBe('reported\n')
})

test('a send delivered past its bound writes nothing: a fall behind it stays cleared, and the next crossing is sent', async () => {
  const fx = fake({ deliver: ['late'] })
  void report(fx, 210000, BOUND)
  await settled()
  expect(await within(measure(fx, 40000), BOUND * 10)).toBe(true)
  fx.release()
  await settled()
  expect(fx.files.get(GATE)).toBe('')
  await measure(fx, 205000)
  expect(fx.sent).toEqual([toOrchestrator(210000), toOrchestrator(205000)])
  expect(fx.files.get(GATE)).toBe('reported\n')
})

test('two lines held across a fall and a new crossing, taken together: the crossing is reported and the agent told no third time', async () => {
  const fx = fake({ submits: ['hold', 'hold'] })
  await report(fx, 210000)
  await measure(fx, 40000)
  await report(fx, 205000)
  fx.release()
  await settled()
  expect(fx.files.get(GATE)).toBe('reported\n')
  await measure(fx, 206000)
  expect(fx.submitted).toEqual([toAgent(210000), toAgent(205000)])
})

test('a fall under the gate with nothing delivered yet forgets the held line too: the next crossing tells the agent', async () => {
  const fx = fake({ submits: ['hold'], deliver: [false] })
  await report(fx, 210000)
  await measure(fx, 40000)
  fx.release()
  await settled()
  expect(fx.files.get(GATE) ?? '').toBe('')
  await measure(fx, 205000)
  expect(fx.submitted).toEqual([toAgent(210000), toAgent(205000)])
})

test('a held line the host drops after its crossing ended is logged, and marks nothing', async () => {
  const fx = fake({ submits: ['hold-drop'] })
  await report(fx, 210000)
  await measure(fx, 40000)
  fx.release()
  await settled()
  expect(fx.logged.some(line => line.includes(`the host dropped ${AGENT}'s own line: interrupted`))).toBe(true)
  expect(fx.files.get(GATE)).toBe('')
})

test('the line tells the agent what to do at its gate', () => {
  expect(gateSelfText(311645, 31).startsWith('[module] Your context is 311,645 (31%)')).toBe(true)
})
