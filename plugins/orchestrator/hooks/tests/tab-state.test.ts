// hooks/tests/tab-state.test.ts
// The state a session writes on its own window for its home session's tab bar
// (tab-state.ts, wired in supervision.ts): one word per state, written only when it changes,
// only inside a home session, and a failing tmux call never fails the hook.
import { expect, test } from 'claude-code/testing'
import { homeArgv, stateArgv, windowOf, panesArgv, panesOf, pullRequestsRead, stateAfterPr, stateAfterTurn, stateAfterMeasure, targetOf } from '../tab-state.ts'
import { register } from '../register.ts'
import { logLineOf, lockRun } from './fakes.ts'
import { capture, hooksOn, hostOf, type Captured } from '../../core/capture.ts'
import type { Events, Host, Noun } from '../../core/host.ts'

type World = Host<Noun>

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

test('the panes of the server are listed with their ttys and the state each window shows', () => {
  expect(panesArgv('tmux', SOCKET)).toEqual(['tmux', '-S', SOCKET, 'list-panes', '-a', '-F', '#{pane_tty} #{pane_id} #{@state}'])
  expect(panesOf('/dev/ttys003 %4 done\n/dev/ttys004 %5 \n/dev/ttys005 %6\n\nnot a pane\n')).toEqual([
    { tty: '/dev/ttys003', pane: '%4', shown: 'done' },
    { tty: '/dev/ttys004', pane: '%5', shown: '' },
    { tty: '/dev/ttys005', pane: '%6', shown: '' },
    { tty: 'not', pane: 'a', shown: 'pane' },
  ])
  expect(panesOf('')).toEqual([])
})

test('a merged or closed pull request puts its agent over, once; an open one moves only a delivery, by its Ready label', () => {
  for (const state of ['MERGED', 'CLOSED']) {
    for (const shown of ['', 'idle', 'held', 'review', 'done', 'gate']) expect(stateAfterPr(shown, { state, ready: true })).toBe('over')
    // The operator's pending question stays visible, and a turn begun since the read is left alone.
    for (const shown of ['asks', 'busy']) expect(stateAfterPr(shown, { state })).toBeNull()
    expect(stateAfterPr('over', { state })).toBeNull()
  }
  expect(stateAfterPr('review', { state: 'OPEN', ready: true })).toBe('done')
  expect(stateAfterPr('done', { state: 'OPEN', ready: false })).toBe('review')
  // Nothing moves a window that shows no delivery, one already right, or one whose labels were not read.
  for (const shown of ['', 'idle', 'busy', 'asks', 'gate', 'over']) {
    expect(stateAfterPr(shown, { state: 'OPEN', ready: true })).toBeNull()
    expect(stateAfterPr(shown, { state: 'OPEN', ready: false })).toBeNull()
  }
  expect(stateAfterPr('done', { state: 'OPEN', ready: true })).toBeNull()
  expect(stateAfterPr('review', { state: 'OPEN', ready: false })).toBeNull()
  expect(stateAfterPr('review', { state: 'OPEN' })).toBeNull()
  expect(stateAfterPr('review', { state: 'DRAFT' })).toBeNull()
})

test('the pull requests of one agent are read together: ready only when every open one is, over only when none is open', () => {
  const open = (ready?: boolean) => ({ state: 'OPEN', ...(ready === undefined ? {} : { ready }) })
  expect(pullRequestsRead([open(true)])).toEqual({ state: 'OPEN', ready: true })
  expect(pullRequestsRead([open(true), open(true)])).toEqual({ state: 'OPEN', ready: true })
  expect(pullRequestsRead([open(true), open(false)])).toEqual({ state: 'OPEN', ready: false })
  expect(pullRequestsRead([open(), open(false)])).toEqual({ state: 'OPEN', ready: false })
  // A label or a pull request that was not read leaves it unknown, unless another is known not Ready.
  expect(pullRequestsRead([open(true), open()])).toEqual({ state: 'OPEN' })
  expect(pullRequestsRead([open(true), null])).toEqual({ state: 'OPEN' })
  expect(pullRequestsRead([open(false), null])).toEqual({ state: 'OPEN', ready: false })
  // A merged or closed one is set aside while another is open.
  expect(pullRequestsRead([{ state: 'MERGED' }, open(true)])).toEqual({ state: 'OPEN', ready: true })
  expect(pullRequestsRead([{ state: 'CLOSED' }, open(false)])).toEqual({ state: 'OPEN', ready: false })
  // None open: merged when one merged, else closed, unknown when a read is missing.
  expect(pullRequestsRead([{ state: 'CLOSED' }, { state: 'MERGED' }])).toEqual({ state: 'MERGED' })
  expect(pullRequestsRead([{ state: 'CLOSED' }])).toEqual({ state: 'CLOSED' })
  expect(pullRequestsRead([{ state: 'MERGED' }, null])).toBeNull()
  expect(pullRequestsRead([])).toBeNull()
})

test('the window is the answer when the session carries the mark, else none', () => {
  expect(windowOf('1|home:@3.%7\n')).toBe('home:@3.%7')
  expect(windowOf('|home:@3.%7\n')).toBeNull()
  expect(windowOf('\n')).toBeNull()
})

test('a turn ends on the wait it wrote, else the gate, else idle', () => {
  // An operator wait shows ✋ only while the round holds an open entry of the session; with none, it is at rest.
  expect(stateAfterTurn('operator', false, true)).toBe('asks')
  expect(stateAfterTurn('operator', false, false)).toBe('idle')
  expect(stateAfterTurn('operator', true, false)).toBe('gate')
  expect(stateAfterTurn('question', true)).toBe('held')
  expect(stateAfterTurn('blocked', false)).toBe('held')
  // An orchestrator's own done wait names no pull request: at rest, never ✓ (done is the Ready read's alone).
  expect(stateAfterTurn('done', true)).toBe('gate')
  expect(stateAfterTurn('done', false)).toBe('idle')
  for (const waiting of ['operator', 'question', 'blocked', 'waiting', 'delivered', 'done', null] as const) {
    expect(stateAfterTurn(waiting, false)).not.toBe('done')
    expect(stateAfterTurn(waiting, true)).not.toBe('done')
  }
  // A delivery is under review until the orchestrator's read of its pull request finds it Ready.
  expect(stateAfterTurn('delivered', false)).toBe('review')
  expect(stateAfterTurn(null, true)).toBe('gate')
  expect(stateAfterTurn(null, false)).toBe('idle')
})

test('a measure moves only a window at rest, onto the gate and back', () => {
  expect(stateAfterMeasure('idle', true)).toBe('gate')
  expect(stateAfterMeasure(null, true)).toBe('gate')
  expect(stateAfterMeasure('gate', true)).toBeNull()
  expect(stateAfterMeasure('gate', false)).toBe('idle')
  expect(stateAfterMeasure('idle', false)).toBeNull()
  for (const held of ['busy', 'asks', 'held', 'review', 'done', 'over'] as const) {
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
    env['TMUX'] = `${SOCKET},4242,0`
    env['TMUX_PANE'] = over.pane
  }
  files.set(`${STATE}/store/sessions/s-one`, JSON.stringify({
    role: 'agent', name: 'Agent: belt-p3', pid: '501', tty: '/dev/ttys005', repo: null,
    context_percent: 12, context_tokens: 120000, window: 1000000, model: 'a-model', busy: false, updated_at: '2026-10-14T09:00:00.000Z',
  }) + '\n')
  const usage = { context: { tokens: over.tokens ?? 120000, window: 1000000, percent: 12 } }
  const dollar = hostOf({
    session: { id: async () => 's-one', usage: async () => usage, model: async () => 'a-model', send: async () => ({ isDelivered: true as const }) },
    env: { get: async (n: string) => env[n] },
    plugin: { root: '/plugins/orch-root' },
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
        const locked = lockRun(argv, files)
        if (locked) return locked
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
        const [verb, , from = '', to = ''] = argv
        if (verb === 'mv' && files.has(from)) {
          files.set(to, files.get(from)!)
          files.delete(from)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'rm') {
          for (const p of argv.slice(2)) files.delete(p)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        return { exitCode: 1, stdout: '', stderr: '' }
      },
    },
    ui: { toast: () => undefined, invalidate: () => undefined },
    command: { run: async () => undefined },
    prompt: { submit: async () => undefined },
  })
  const states = () => calls.filter(c => c[3] === 'set-option').map(c => c[8])
  return { dollar, files, logged, calls, usage, states }
}

function mounted(): Array<Captured<World>> {
  return capture<World>(register)
}

// The event down every hook registered on it, in their order, each one's next the one after.
async function drive<K extends keyof Events>(hooks: ReadonlyArray<Captured<World>>, event: K, dollar: World, e: Events[K]): Promise<unknown> {
  const chain = hooksOn(hooks, event)
  const run = async (i: number, ev: Events[K]): Promise<unknown> => {
    const hook = chain[i]
    return hook === undefined ? ev : hook.handler(dollar, ev, (x: Events[K]) => run(i + 1, x))
  }
  return run(0, e)
}

// A measure as the host raises it: the figures are read from $.session.usage, not from the event.
const measured = { context: { window: 1000000 } }

const turnEnd = (answer: string) => ({ answer, reason: 'answer', isAborted: false, durationMs: 1, turnId: 't' })

test('busy when a turn starts, idle when it ends with nothing pending', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%11' })
  await drive(chains, 'turn.start', fx.dollar, {})
  expect(fx.states()).toEqual(['busy'])
  expect(fx.calls[1]).toEqual(['tmux', '-S', SOCKET, 'set-option', '-w', '-t', '%11', '@state', 'busy'])
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working on the second task.'))
  expect(fx.states()).toEqual(['busy', 'idle'])
})

test('held when a wait on the orchestrator is written, not asks', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%12' })
  await drive(chains, 'turn.start', fx.dollar, {})
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Merge first or rebase?\n\nstatus: question — merge order'))
  expect(fx.states()).toEqual(['busy', 'held'])
})

test('review when a delivery is written: done only once its pull request is read Ready', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%13' })
  await drive(chains, 'turn.start', fx.dollar, {})
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('PR opened, 40 passed.\nstatus: done — PR 12'))
  expect(fx.states()).toEqual(['busy', 'review'])
})

test('gate when a measure puts a window at rest past its gate, idle when it is back under', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%14' })
  await drive(chains, 'turn.start', fx.dollar, {})
  fx.usage.context.tokens = 310000
  await drive(chains, 'session.measure', fx.dollar, measured)
  // Working: the measure is remembered, the turn's end shows it.
  expect(fx.states()).toEqual(['busy'])
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Still working.'))
  expect(fx.states()).toEqual(['busy', 'gate'])
  await drive(chains, 'session.measure', fx.dollar, measured)
  expect(fx.states()).toEqual(['busy', 'gate'])
  fx.usage.context.tokens = 40000
  await drive(chains, 'session.measure', fx.dollar, measured)
  expect(fx.states()).toEqual(['busy', 'gate', 'idle'])
})

test('the row names the window in a home session, and nothing outside one', async () => {
  const chains = mounted()
  const home = fake({ pane: '%18' })
  await drive(chains, 'session.measure', home.dollar, measured)
  expect(JSON.parse(home.files.get(`${STATE}/store/sessions/s-one`)!).tmux).toBe('home:@3.%7')
  const outside = fake({ pane: '%19', tmux: false })
  await drive(chains, 'session.measure', outside.dollar, measured)
  expect(JSON.parse(outside.files.get(`${STATE}/store/sessions/s-one`)!).tmux ?? null).toBeNull()
})

test('a state is written when it changes, never twice in a row', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%15' })
  await drive(chains, 'turn.start', fx.dollar, {})
  await drive(chains, 'turn.start', fx.dollar, {})
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('One.'))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Two.'))
  expect(fx.states()).toEqual(['busy', 'idle'])
  // The mark is read once for the window, not at every change.
  expect(fx.calls.filter(c => c[3] === 'display-message').length).toBe(1)
})

test('outside a home session nothing is called', async () => {
  const chains = mounted()
  const outside = fake({ pane: '%16', tmux: false })
  await drive(chains, 'turn.start', outside.dollar, {})
  await drive(chains, 'turn.complete', outside.dollar, turnEnd('Done.'))
  await drive(chains, 'session.measure', outside.dollar, measured)
  expect(outside.calls).toEqual([])
  expect(outside.logged.filter(l => l.includes('tab-state'))).toEqual([])
  // A tmux session the operator made by hand carries no mark: read once, never written.
  const plain = fake({ pane: '%17', home: false })
  await drive(chains, 'turn.start', plain.dollar, {})
  await drive(chains, 'turn.complete', plain.dollar, turnEnd('Done.'))
  expect(plain.states()).toEqual([])
  expect(plain.calls.length).toBe(1)
  expect(plain.logged.filter(l => l.includes('tab-state'))).toEqual([])
})

for (const fail of ['set', 'home'] as const) {
  test(`a failing tmux call (${fail}) does not fail the hook, and is logged once`, async () => {
    const chains = mounted()
    const fx = fake({ pane: `%2${fail === 'set' ? 0 : 1}`, fail })
    const start = {}
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
  await drive(chains, 'turn.start', fx.dollar, {})
  expect(tabLog(fx).map(l => l.slice(l.indexOf('tab-state')))).toEqual(['tab-state: tmux: no server running'])
  expect(fx.calls.filter(c => c[3] === 'display-message').length).toBe(1)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Done.'))
  expect(fx.calls.filter(c => c[3] === 'display-message').length).toBe(2)
})

test('a home read that fails twice is not tried again for the session', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%23', fail: 'home' })
  await drive(chains, 'turn.start', fx.dollar, {})
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Done.'))
  const before = fx.calls.length
  expect(before).toBe(2)
  await drive(chains, 'turn.start', fx.dollar, {})
  await drive(chains, 'session.measure', fx.dollar, measured)
  expect(fx.calls.length).toBe(before)
  expect(tabLog(fx).length).toBe(1)
})

test('a failure is said again after a read succeeds', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%24', script: { home: [true], set: [true] } })
  await drive(chains, 'turn.start', fx.dollar, {})
  expect(tabLog(fx).length).toBe(1)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Done.'))
  expect(tabLog(fx).length).toBe(2)
})

test('a failure is said again after a write succeeds', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%25', script: { set: [true, false, true] } })
  await drive(chains, 'turn.start', fx.dollar, {})
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Done.'))
  await drive(chains, 'turn.start', fx.dollar, {})
  expect(tabLog(fx).length).toBe(2)
})

test('a state whose write failed leaves nothing remembered, so the last one is written again when asked', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%26', script: { set: [false, true] } })
  await drive(chains, 'turn.start', fx.dollar, {})
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Done.'))
  await drive(chains, 'turn.start', fx.dollar, {})
  expect(fx.states()).toEqual(['busy', 'idle', 'busy'])
})

test('held for a wait on the orchestrator, asks stays the operator\'s alone', () => {
  expect(stateAfterTurn('operator', false, true)).toBe('asks')
  expect(stateAfterTurn('operator', false, false)).toBe('idle')
  expect(stateAfterTurn('blocked', false)).toBe('held')
  expect(stateAfterTurn('question', false)).toBe('held')
  expect(stateAfterTurn('waiting', true)).toBe('held')
})

test('held when a wait on the orchestrator is written, and asks is not shown for it', async () => {
  const chains = mounted()
  const fx = fake({ pane: '%27' })
  await drive(chains, 'turn.start', fx.dollar, {})
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Waiting on the rebase.\n\nstatus: blocked — PR 12 rebase'))
  expect(fx.states()).toEqual(['busy', 'held'])
})

// A question `ask` stores: the Asked v2 shape of a live file in the round, its sender's session the one that holds it.
const askedFile = (session: string, status: string) => JSON.stringify({
  v: 2, id: `q-${session}-1`, sender: { session, name: 'Orch: belt', role: 'orchestrator', machine: 'LounisBou' },
  subject: 'Which one', context: 'what is known', ask: 'Which one?', choices: [], recommended: null, why: null,
  blocks: 'G1', status, at: '2026-11-17T09:00:00.000Z', answer: null, seq: 1,
})

test('a turn ends with ✋ while a question its session asked is open, whatever its wait, and at rest once none is', async () => {
  for (const [status, shown] of [['open', 'asks'], ['answered', 'idle']] as const) {
    const chains = mounted()
    const fx = fake({ pane: '%31' })
    fx.files.set(`${STATE}/round/q-s-one-1.json`, askedFile('s-one', status))
    await drive(chains, 'turn.start', fx.dollar, {})
    await drive(chains, 'turn.complete', fx.dollar, turnEnd('Which one?'))
    expect(fx.states().at(-1)).toBe(shown)
  }
})
