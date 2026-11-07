// hooks/tests/tab-state.test.ts
// The state a session writes on its own window for its home session's tab bar
// (tab-state.ts, wired in supervision.ts): one word per state, written only when it changes,
// only inside a home session, and a failing tmux call never fails the hook.
import { expect, test } from 'claude-code/testing'
import { homeArgv, stateArgv, windowOf, stateAfterTurn, stateAfterMeasure, targetOf } from '../tab-state.ts'
import { register } from '../register.ts'
import { logLineOf } from './fakes.ts'

const HOME = '/tmp/h'
const STATE = `${HOME}/.claude/claude-orchestrator`
const SOCKET = '/private/tmp/tmux-501/orch-home'

// --- the pure half ------------------------------------------------------------------------

test('the target is the socket of $TMUX and the pane, or none outside tmux', () => {
  expect(targetOf(`${SOCKET},4242,0`, '%3')).toEqual({ socket: SOCKET, pane: '%3' })
  expect(targetOf(undefined, '%3')).toBeNull()
  expect(targetOf('', '%3')).toBeNull()
  expect(targetOf(`${SOCKET},4242,0`, undefined)).toBeNull()
})

test('the argv of the mark read and of the state write', () => {
  const target = { socket: SOCKET, pane: '%3' }
  expect(homeArgv('tmux', target)).toEqual(['tmux', '-S', SOCKET, 'display-message', '-p', '-t', '%3', '#{@orchestrator-home}|#{session_name}:#{window_id}.#{pane_id}'])
  expect(stateArgv('tmux', target, 'busy')).toEqual(['tmux', '-S', SOCKET, 'set-option', '-w', '-t', '%3', '@state', 'busy'])
})

test('the window is the answer when the session carries the mark, else none', () => {
  expect(windowOf('1|home:@3.%7\n')).toBe('home:@3.%7')
  expect(windowOf('|home:@3.%7\n')).toBeNull()
  expect(windowOf('\n')).toBeNull()
})

test('a turn ends on the wait it wrote, else the gate, else idle', () => {
  expect(stateAfterTurn('operator', false)).toBe('asks')
  expect(stateAfterTurn('question', true)).toBe('asks')
  expect(stateAfterTurn('blocked', false)).toBe('asks')
  expect(stateAfterTurn('done', true)).toBe('done')
  expect(stateAfterTurn('delivered', false)).toBe('done')
  expect(stateAfterTurn(null, true)).toBe('gate')
  expect(stateAfterTurn(null, false)).toBe('idle')
})

test('a measure moves only a window at rest, onto the gate and back', () => {
  expect(stateAfterMeasure('idle', true)).toBe('gate')
  expect(stateAfterMeasure(null, true)).toBe('gate')
  expect(stateAfterMeasure('gate', true)).toBeNull()
  expect(stateAfterMeasure('gate', false)).toBe('idle')
  expect(stateAfterMeasure('idle', false)).toBeNull()
  for (const held of ['busy', 'asks', 'done'] as const) {
    expect(stateAfterMeasure(held, true)).toBeNull()
    expect(stateAfterMeasure(held, false)).toBeNull()
  }
})

// --- the wiring over a faked $ ------------------------------------------------------------

// script: per call, in order, whether it fails (true) or succeeds; once exhausted, calls succeed.
type Over = { tmux?: boolean; home?: boolean; fail?: 'set' | 'home'; script?: { home?: boolean[]; set?: boolean[] }; pane: string; tokens?: number }

function fake(over: Over) {
  const files = new Map<string, string>()
  const logged: string[] = []
  const calls: string[][] = []
  const env: Record<string, string> = { HOME, ORCHESTRATOR_HOST_CLI: 'hostcli' }
  if (over.tmux !== false) {
    env.TMUX = `${SOCKET},4242,0`
    env.TMUX_PANE = over.pane
  }
  files.set(`${STATE}/store/sessions/s-one`, JSON.stringify({
    role: 'agent', name: 'Agent : belt-p3', pid: '501', tty: '/dev/ttys005', repo: null,
    context_percent: 12, context_tokens: 120000, window: 1000000, model: 'a-model', busy: false, updated_at: '2026-10-14T09:00:00.000Z',
  }) + '\n')
  const usage = { context: { tokens: over.tokens ?? 120000, window: 1000000, percent: 12 } }
  const dollar = {
    session: { id: async () => 's-one', usage: async () => usage, model: async () => 'a-model', surfaces: async () => [], send: async () => ({ isDelivered: true }) },
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
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file', size: 0, mtimeMs: 0, isLink: false })),
      stat: async (p: string) => { throw new Error(`ENOENT: ${p}`) },
    },
    process: {
      run: async (argv: readonly string[]) => {
        const line = logLineOf(argv)
        if (line !== null) {
          logged.push(line)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'tmux') {
          calls.push([...argv])
          const reading = argv[3] === 'display-message'
          if (over.fail === (reading ? 'home' : 'set')) throw new Error('tmux: no server running')
          if (over.script?.[reading ? 'home' : 'set']?.shift()) throw new Error('tmux: no server running')
          return { exitCode: 0, stdout: reading ? (over.home === false ? '|plain:@0.%0\n' : '1|home:@3.%7\n') : '', stderr: '' }
        }
        if (argv[0] === 'mv' && files.has(argv[2])) {
          files.set(argv[3], files.get(argv[2])!)
          files.delete(argv[2])
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' }
        return { exitCode: 1, stdout: '', stderr: '' }
      },
    },
    ui: { toast: () => undefined, invalidate: () => undefined },
    command: { run: async () => undefined },
    prompt: { submit: async () => undefined },
  }
  const states = () => calls.filter(c => c[3] === 'set-option').map(c => c[8])
  return { dollar, files, logged, calls, usage, states }
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

test('busy when a turn starts, idle when it ends with nothing pending', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%11' })
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  expect(fx.states()).toEqual(['busy'])
  expect(fx.calls[1]).toEqual(['tmux', '-S', SOCKET, 'set-option', '-w', '-t', '%11', '@state', 'busy'])
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working on the second task.'))
  expect(fx.states()).toEqual(['busy', 'idle'])
})

test('asks when a wait for the operator is written', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%12' })
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Merge first or rebase?\n\nstatus: question — merge order'))
  expect(fx.states()).toEqual(['busy', 'asks'])
})

test('done when a delivery is written', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%13' })
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('PR opened, 40 passed.\nstatus: done — PR 12'))
  expect(fx.states()).toEqual(['busy', 'done'])
})

test('gate when a measure puts a window at rest past its gate, idle when it is back under', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%14' })
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  fx.usage.context.tokens = 310000
  await drive(chains, 'session.measure', fx.dollar, {})
  // Working: the measure is remembered, the turn's end shows it.
  expect(fx.states()).toEqual(['busy'])
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Still working.'))
  expect(fx.states()).toEqual(['busy', 'gate'])
  await drive(chains, 'session.measure', fx.dollar, {})
  expect(fx.states()).toEqual(['busy', 'gate'])
  fx.usage.context.tokens = 40000
  await drive(chains, 'session.measure', fx.dollar, {})
  expect(fx.states()).toEqual(['busy', 'gate', 'idle'])
})

test('the row names the window in a home session, and nothing outside one', async () => {
  const chains = mounted()
  const home = fake({ pane: '%18' })
  await drive(chains, 'session.measure', home.dollar, {})
  expect(JSON.parse(home.files.get(`${STATE}/store/sessions/s-one`)!).tmux).toBe('home:@3.%7')
  const outside = fake({ pane: '%19', tmux: false })
  await drive(chains, 'session.measure', outside.dollar, {})
  expect(JSON.parse(outside.files.get(`${STATE}/store/sessions/s-one`)!).tmux ?? null).toBeNull()
})

test('a state is written when it changes, never twice in a row', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%15' })
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('One.'))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Two.'))
  expect(fx.states()).toEqual(['busy', 'idle'])
  // The mark is read once for the window, not at every change.
  expect(fx.calls.filter(c => c[3] === 'display-message').length).toBe(1)
})

test('outside a home session nothing is called', async () => {
  const chains = mounted()
  const outside = fake({ pane: '%16', tmux: false })
  await drive(chains, 'turn.start', outside.dollar, { text: '' })
  await drive(chains, 'turn.complete', outside.dollar, turnEnd('Done.'))
  await drive(chains, 'session.measure', outside.dollar, {})
  expect(outside.calls).toEqual([])
  expect(outside.logged.filter(l => l.includes('tab-state'))).toEqual([])
  // A tmux session the operator made by hand carries no mark: read once, never written.
  const plain = fake({ pane: '%17', home: false })
  await drive(chains, 'turn.start', plain.dollar, { text: '' })
  await drive(chains, 'turn.complete', plain.dollar, turnEnd('Done.'))
  expect(plain.states()).toEqual([])
  expect(plain.calls.length).toBe(1)
  expect(plain.logged.filter(l => l.includes('tab-state'))).toEqual([])
})

for (const fail of ['set', 'home'] as const) {
  test(`a failing tmux call (${fail}) does not fail the hook, and is logged once`, async () => {
    const chains = mounted()
    const fx = fake({ pane: `%2${fail === 'set' ? 0 : 1}`, fail })
    const start = { text: '' }
    expect(await drive(chains, 'turn.start', fx.dollar, start)).toBe(start)
    const end = turnEnd('Done.')
    expect(await drive(chains, 'turn.complete', fx.dollar, end)).toBe(end)
    expect(fx.logged.filter(l => l.includes('tab-state')).length).toBe(1)
  })
}

const tabLog = (fx: { logged: string[] }) => fx.logged.filter(l => l.includes('tab-state'))

test('a failing home read is logged with its cause, and tried again at the next change', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%22', fail: 'home' })
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  expect(tabLog(fx).map(l => l.slice(l.indexOf('tab-state')))).toEqual(['tab-state: tmux: no server running'])
  expect(fx.calls.filter(c => c[3] === 'display-message').length).toBe(1)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Done.'))
  expect(fx.calls.filter(c => c[3] === 'display-message').length).toBe(2)
})

test('a home read that fails twice is not tried again for the session', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%23', fail: 'home' })
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Done.'))
  const before = fx.calls.length
  expect(before).toBe(2)
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  await drive(chains, 'session.measure', fx.dollar, {})
  expect(fx.calls.length).toBe(before)
  expect(tabLog(fx).length).toBe(1)
})

test('a failure is said again after a read succeeds', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%24', script: { home: [true], set: [true] } })
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  expect(tabLog(fx).length).toBe(1)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Done.'))
  expect(tabLog(fx).length).toBe(2)
})

test('a failure is said again after a write succeeds', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%25', script: { set: [true, false, true] } })
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Done.'))
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  expect(tabLog(fx).length).toBe(2)
})

test('a state whose write failed leaves nothing remembered, so the last one is written again when asked', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%26', script: { set: [false, true] } })
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Done.'))
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  expect(fx.states()).toEqual(['busy', 'idle', 'busy'])
})
