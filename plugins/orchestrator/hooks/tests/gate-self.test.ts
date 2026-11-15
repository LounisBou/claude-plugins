// hooks/tests/gate-self.test.ts
// An agent crossing its context gate is told in its own session (relay.ts gateSelfText, sent by
// supervision.ts reportGate), once per crossing, whether or not its orchestrator is reached; the
// orchestrator still gets its own line once.
import { expect, test } from 'claude-code/testing'
import { gateSelfText } from '../relay.ts'
import { reportGate } from '../supervision.ts'
import { logLineOf } from './fakes.ts'

const HOME = '/tmp/gs'
const GATE = `${HOME}/.claude/claude-orchestrator/store/gates/s-one`
const AGENT = 'Agent: belt-p3'
const ORCH = 'Orch: belt'

function fake(over: { orchestrator?: boolean; drop?: boolean } = {}) {
  const files = new Map<string, string>()
  const submitted: string[] = []
  const sent: { to: unknown; text: string }[] = []
  const logged: string[] = []
  const env: Record<string, string> = { HOME, ORCHESTRATOR_CONTEXT_GATE_TOKENS: '200000' }
  if (over.orchestrator !== false) {
    env.ORCHESTRATOR_REPORTS_TO = `${ORCH} [a1b2c3]`
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
        submitted.push(text)
        return undefined
      },
    },
    session: {
      id: async () => 's-one',
      send: async (args: { to: unknown; text: string }) => {
        sent.push(args)
        return { isDelivered: true }
      },
    },
  }
  return { dollar, files, submitted, sent, logged }
}

const reading = (tokens: number) => ({ context_tokens: tokens, context_percent: Math.round(tokens / 10000), context_window: 1000000 })
// The fake holds only the nouns reportGate calls.
const report = (fx: ReturnType<typeof fake>, tokens: number) => reportGate(fx.dollar as never, 's-one', AGENT, '/dev/ttys005', reading(tokens))

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

test('the line tells the agent what to do at its gate', () => {
  expect(gateSelfText(311645, 31).startsWith('[module] Your context is 311,645 (31%)')).toBe(true)
})
