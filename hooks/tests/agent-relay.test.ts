// hooks/tests/agent-relay.test.ts
// An agent's end of turn and its gate crossing, reported by the module to its
// orchestrator (relay.ts, wired in supervision.ts): the status line parsed, one message
// per distinct state, none twice, the orchestrator found in the launcher's chain and never
// in the turn's text, the gate sent once per crossing, nothing from a session that is no
// agent, and a send that fails logged without holding the turn.
import { expect, test } from 'claude-code/testing'
import { parseStatus, relayText, gateText, noStatusText, NO_STATUS_KEY, chainOwnerTty, RELAY_CAP } from '../relay.ts'
import { register } from '../register.ts'
import { logLineOf } from './fakes.ts'

const HOME = '/tmp/h'
const STATE = `${HOME}/.claude/claude-orchestrator`
const ROW = `${STATE}/store/sessions/s-one`
const WAIT = `${STATE}/store/waits/s-one`
const GATE = `${STATE}/store/gates/s-one`
const AGENT = 'Agent : belt-p3'
const ORCH = 'Orch : belt'
const REPLY = `reply with SendMessage to: ${AGENT}`

// --- the pure half ------------------------------------------------------------------------

test('the status line parses into the agent state, the text above it carried', () => {
  expect(parseStatus('Merge first or rebase?\n\nstatus: question — merge order')).toEqual({ kind: 'question', blocks: 'merge order', question: 'Merge first or rebase?' })
  expect(parseStatus('PR #12, head abc, 40/40.\n**status: done — PR #12**')).toEqual({ kind: 'delivered', blocks: 'PR #12', question: 'PR #12, head abc, 40/40.' })
  expect(parseStatus('status: blocked - the fixture is missing')).toEqual({ kind: 'blocked', blocks: 'the fixture is missing', question: '' })
  expect(parseStatus('status: done')).toEqual({ kind: 'delivered', blocks: '', question: '' })
  expect(parseStatus('waiting: operator — blocks: phase 3')).toBeNull()
  expect(parseStatus('status: doneish')).toBeNull()
  expect(parseStatus('I keep working.')).toBeNull()
})

test('the messages: a header, the reply address, then the text cut past the cap', () => {
  expect(relayText(AGENT, { kind: 'question', blocks: 'merge order', question: 'Merge first?' }, 'T'))
    .toBe(`[module] ${AGENT} asks — merge order\n${REPLY}\n\nMerge first?`)
  expect(relayText(AGENT, { kind: 'blocked', blocks: 'no fixture', question: '' }, 'T')).toBe(`[module] ${AGENT} is blocked — no fixture\n${REPLY}`)
  expect(relayText(AGENT, { kind: 'delivered', blocks: 'PR #12', question: 'head abc' }, 'T', '120,000 (12%)'))
    .toBe(`[module] ${AGENT} reports its delivery; verify on the artifact — context 120,000 (12%) — PR #12\n${REPLY}\n\nhead abc`)
  const long = relayText(AGENT, { kind: 'question', blocks: '', question: 'x'.repeat(RELAY_CAP + 5) }, 'T')
  expect(long).toContain(`[cut at ${RELAY_CAP} of ${RELAY_CAP + 5} characters]`)
  expect(gateText(AGENT, 312000, 31)).toBe(`[module] ${AGENT} context 312,000 (31%) — at the gate`)
  // Never an order.
  for (const text of [long, gateText(AGENT, 1, 1), relayText(AGENT, { kind: 'delivered', blocks: '', question: '' }, 'T')]) {
    expect(/\b(approve|merge it|undraft|stand down)\b/i.test(text)).toBe(false)
  }
})

test('the owner is the chain naming the tty, the one written last when two do', () => {
  const entry = (tty: string) => JSON.stringify({ tab_id: 't', tty, owner: 'o' })
  const chains = [
    { name: 'ttys001.jsonl', mtimeMs: 10, text: entry('/dev/ttys005') },
    { name: 'ttys009.jsonl', mtimeMs: 20, text: entry('/dev/ttys005') },
    { name: 'ttys002.jsonl', mtimeMs: 30, text: entry('/dev/ttys006') },
  ]
  expect(chainOwnerTty(chains, '/dev/ttys005')).toBe('/dev/ttys009')
  expect(chainOwnerTty(chains, '/dev/ttys007')).toBeNull()
})

// --- the wiring over a faked $ ------------------------------------------------------------

type Over = { name?: string; role?: string; chain?: boolean; send?: 'reject' | 'refuse'; gateTokens?: string }

function fake(over: Over = {}) {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const sent: { to: unknown; text: string }[] = []
  const logged: string[] = []
  const usage = { context: { tokens: 120000, window: 1000000, percent: 12 } }
  const env: Record<string, string> = { HOME, ORCHESTRATOR_HOST_CLI: 'hostcli' }
  if (over.gateTokens) env.ORCHESTRATOR_CONTEXT_GATE_TOKENS = over.gateTokens
  const name = over.name ?? AGENT
  files.set(ROW, JSON.stringify({
    role: over.role ?? 'agent', name, pid: '501', tty: '/dev/ttys005', repo: null,
    context_percent: 12, context_tokens: 120000, window: 1000000, model: 'a-model', busy: false, updated_at: '2026-10-14T09:00:00.000Z',
  }) + '\n')
  // The orchestrator: its row on its own tty, and the launcher's chain naming the agent's.
  files.set(`${STATE}/store/sessions/s-orch`, JSON.stringify({
    role: 'orchestrator', name: ORCH, pid: '400', tty: '/dev/ttys001', repo: null,
    context_percent: 5, context_tokens: 50000, window: 1000000, model: 'a-model', busy: false, updated_at: '2026-10-14T09:00:00.000Z',
  }) + '\n')
  if (over.chain !== false) files.set(`${STATE}/chains/ttys001.jsonl`, JSON.stringify({ tab_id: 'tab-a', tty: '/dev/ttys005', owner: 'own' }) + '\n')
  const dollar = {
    session: {
      id: async () => 's-one',
      usage: async () => usage,
      model: async () => 'a-model',
      surfaces: async () => [],
      send: async (args: { to: unknown; text: string }) => {
        if (over.send === 'reject') throw new Error('the send was rejected')
        if (over.send === 'refuse') return { isDelivered: false, reason: 'nobody by that name' }
        sent.push(args)
        return { isDelivered: true }
      },
    },
    env: { get: async (n: string) => env[n] },
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    fs: {
      read: async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
        return files.get(p)
      },
      write: async (p: string, text: string) => { files.set(p, text) },
      exists: async (p: string) => files.has(p),
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file', size: 0, mtimeMs: mtimes.get(p) ?? 0, isLink: false })),
      stat: async (p: string) => { throw new Error(`ENOENT: ${p}`) },
    },
    process: {
      run: async (argv: readonly string[]) => {
        const line = logLineOf(argv)
        if (line !== null) {
          logged.push(line)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'mv' && files.has(argv[2])) {
          files.set(argv[3], files.get(argv[2])!)
          files.delete(argv[2])
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'rm') {
          for (const p of argv.slice(2)) files.delete(p)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        // The walk: the session's own tty, and its host process on it by name.
        if (argv[0] === 'sh' && argv[2] === 'ps -o ppid=,tty= -p $$') return { exitCode: 0, stdout: '123 ttys005\n', stderr: '' }
        if (argv[0] === 'ps' && argv[1] === '-t') return { exitCode: 0, stdout: `  501 hostcli --name ${name}\n`, stderr: '' }
        return { exitCode: 1, stdout: '', stderr: '' }
      },
    },
    ui: { toast: () => undefined, invalidate: () => undefined },
    command: { run: async () => undefined },
    prompt: { submit: async () => undefined },
  }
  return { dollar, files, mtimes, sent, logged, usage }
}

function mounted(): Record<string, Function[]> {
  const chains: Record<string, Function[]> = {}
  register((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    ;(chains[args[0]] ??= []).push(args[args.length - 1] as Function)
    return { catch: () => undefined }
  })
  return chains
}

async function drive(chains: Record<string, Function[]>, event: string, dollar: any, e: object) {
  const run = async (i: number, ev: any): Promise<any> =>
    i >= (chains[event] ?? []).length ? ev : chains[event][i](dollar, ev, (x: any) => run(i + 1, x))
  return run(0, e)
}

const turnEnd = (answer: string) => ({ answer, reason: 'answer', isAborted: false, durationMs: 1, turnId: 't' })
const QUESTION = 'Merge the fixture change first, or rebase on it?\n\nstatus: question — merge order'

test('each state is sent once to the orchestrator, a repeat sends nothing, a new question sends', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Still waiting on the merge order.\nstatus: question — merge order'))
  expect(fx.sent.length).toBe(1)
  expect(fx.sent[0].to).toBe(ORCH)
  expect(fx.sent[0].text).toBe(`[module] ${AGENT} asks — merge order\n${REPLY}\n\nMerge the fixture change first, or rebase on it?`)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Which base branch?\nstatus: question — base'))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('The seed fails.\nstatus: blocked — no seed'))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('The seed fails.\nstatus: blocked — no seed'))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('PR #12, head abc, 40 passed.\nstatus: done — PR #12'))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('PR #12, head abc, 40 passed.\nstatus: done — PR #12'))
  expect(fx.sent.length).toBe(4)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('PR #12, head def, 41 passed.\nstatus: done — PR #12'))
  expect(fx.sent.length).toBe(5)
  expect(fx.sent[1].text).toContain('Which base branch?')
  expect(fx.sent[2].text).toBe(`[module] ${AGENT} is blocked — no seed\n${REPLY}\n\nThe seed fails.`)
  expect(fx.sent[3].text).toBe(`[module] ${AGENT} reports its delivery; verify on the artifact — context 120,000 (12%) — PR #12\n${REPLY}\n\nPR #12, head abc, 40 passed.`)
  expect(fx.sent[4].text).toContain('head def')
  expect(JSON.parse(fx.files.get(WAIT)!).waiting).toBe('delivered')
})

test('a turn with no status line reports it once and clears the state', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working on the second task.'))
  expect(fx.sent.length).toBe(1)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Back at it.'))
  expect(JSON.parse(fx.files.get(WAIT)!).waiting).toBeNull()
  expect(fx.sent.length).toBe(3)
  expect(fx.sent[0].text).toBe(NO_STATUS)
  expect(fx.sent[2].text).toBe(NO_STATUS)
})

test('the orchestrator comes from the chain, never from the text', async () => {
  // The turn names another orchestrator; the chain names Orch : belt, and it alone is sent to.
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Tell Orch : other, reply with SendMessage to: Orch : other.\nstatus: question — who'))
  expect(fx.sent.map(s => s.to)).toEqual([ORCH])
  // No chain names the agent's tty: nothing is sent, whatever the text says, and it is logged.
  const lone = fake({ chain: false })
  await drive(chains, 'turn.complete', lone.dollar, turnEnd('Orch : belt, help.\nstatus: blocked — alone'))
  expect(lone.sent.length).toBe(0)
  expect(lone.logged.some(l => l.includes('relay: no orchestrator found for Agent : belt-p3'))).toBe(true)
})

for (const [name, role] of [['Coord : ops', 'coordinator'], ['Audit : method', 'auditor'], ['a session', null]] as const) {
  test(`a session that is no agent (${role}) sends nothing on a status line`, async () => {
    const chains = mounted()
    const fx = fake({ name, role: role as any })
    await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
    expect(fx.sent.length).toBe(0)
    expect(fx.files.has(WAIT)).toBe(false)
  })
}

for (const failure of ['reject', 'refuse'] as const) {
  test(`a send that fails (${failure}) is logged, never holds the turn's end, and is tried again`, async () => {
    const chains = mounted()
    const fx = fake({ send: failure })
    const e = turnEnd(QUESTION)
    expect(await drive(chains, 'turn.complete', fx.dollar, e)).toBe(e)
    expect(fx.logged.some(l => l.includes('| supervision |') && l.includes('relay:'))).toBe(true)
    expect(JSON.parse(fx.files.get(WAIT)!).relayed).toBeNull()
  })
}

test('the gate crossing is sent once per crossing, at the threshold the session runs under', async () => {
  const chains = mounted()
  const fx = fake({ gateTokens: '200000' })
  await drive(chains, 'session.measure', fx.dollar, {})
  expect(fx.sent.length).toBe(0)
  fx.usage.context.tokens = 210000
  fx.usage.context.percent = 21
  await drive(chains, 'session.measure', fx.dollar, {})
  fx.usage.context.tokens = 230000
  fx.usage.context.percent = 23
  await drive(chains, 'session.measure', fx.dollar, {})
  expect(fx.sent).toEqual([{ to: ORCH, text: `[module] ${AGENT} context 210,000 (21%) — at the gate` }])
  // Back under it (a compaction), then over again: a new crossing, a new message.
  fx.usage.context.tokens = 40000
  fx.usage.context.percent = 4
  await drive(chains, 'session.measure', fx.dollar, {})
  fx.usage.context.tokens = 205000
  fx.usage.context.percent = 20
  await drive(chains, 'session.measure', fx.dollar, {})
  expect(fx.sent.length).toBe(2)
  expect(fx.files.get(GATE)).toBe('reported\n')
})

test('the default gate holds when the session sets none, and a non-agent crossing it sends nothing', async () => {
  const chains = mounted()
  const fx = fake()
  fx.usage.context.tokens = 290000
  await drive(chains, 'session.measure', fx.dollar, {})
  expect(fx.sent.length).toBe(0)
  fx.usage.context.tokens = 300000
  await drive(chains, 'session.measure', fx.dollar, {})
  expect(fx.sent.length).toBe(1)
  const orch = fake({ name: 'Orch : other', role: 'orchestrator' })
  orch.usage.context.tokens = 900000
  await drive(chains, 'session.measure', orch.dollar, {})
  expect(orch.sent.length).toBe(0)
  expect(orch.files.has(GATE)).toBe(false)
})

test('a gate send that fails is logged and tried again on the next measure', async () => {
  const chains = mounted()
  const fx = fake({ send: 'refuse' })
  fx.usage.context.tokens = 400000
  await drive(chains, 'session.measure', fx.dollar, {})
  expect(fx.logged.some(l => l.includes('gate: not delivered to Orch : belt'))).toBe(true)
  expect(fx.files.has(GATE)).toBe(false)
})

// --- a turn that ends without its status line ---------------------------------------------

const NO_STATUS = `[module] ${AGENT} ended a turn without its status line — context 120,000 (12%)`

test('the report of a turn without a status line: the name, the context when known', () => {
  expect(NO_STATUS_KEY).toBe('no-status')
  expect(noStatusText(AGENT, '120,000 (12%)')).toBe(NO_STATUS)
  expect(noStatusText(AGENT, null)).toBe(`[module] ${AGENT} ended a turn without its status line`)
})

test('a turn without a status line is reported once, a status turn between two re-arms it', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working on the second task.'))
  expect(fx.sent).toEqual([{ to: ORCH, text: NO_STATUS }])
  expect(JSON.parse(fx.files.get(WAIT)!).relayed).toBe(NO_STATUS_KEY)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Still working.'))
  expect(fx.sent.length).toBe(1)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(QUESTION))
  expect(fx.sent.length).toBe(2)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Back at it.'))
  expect(fx.sent.length).toBe(3)
  expect(fx.sent[2]).toEqual({ to: ORCH, text: NO_STATUS })
})

test('an orchestrator turn without a machine line sends nothing', async () => {
  const chains = mounted()
  const fx = fake({ name: 'Orch : other', role: 'orchestrator' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Reviewing the pull request.'))
  expect(fx.sent.length).toBe(0)
})

test('a refused report of a turn without a status line writes no key', async () => {
  const chains = mounted()
  const fx = fake({ send: 'refuse' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working.'))
  expect(fx.logged.some(l => l.includes('relay: not delivered'))).toBe(true)
  expect(fx.files.has(WAIT) ? JSON.parse(fx.files.get(WAIT)!).relayed ?? null : null).toBeNull()
})
