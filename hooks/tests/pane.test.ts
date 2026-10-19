// hooks/tests/pane.test.ts
// The supervision pane: the store's rows sorted by rotation urgency (past the
// gate first, then fill descending), the label the spec names (name, role, the
// fill against the gate, the reading's age) the commands print, and the wiring
// over a faked $ — no pane opened on any start, the pane opened by the
// command in a coordinator session (the orchestrators) or an orchestrator
// session (its own agents) alone, a coordinator's opened by itself once at the
// end of its first turn and its round's first question drawn under its rows, the
// measure's side reads bounded so a walk that cannot answer in time costs the row
// its name, never the measure.
import { expect, test } from 'claude-code/testing'
import { agentPaneRows, paneRows, readRound, roundLines, register as registerSupervision, type SessionRow } from '../supervision.ts'
import type { RoundEntry } from '../round.ts'
import { hostRecordOf } from '../session-name.ts'
import { register as registerAll } from '../register.ts'
import { logLineOf, blockOf } from './fakes.ts'

const HOME = '/tmp/h'
const SESSIONS = `${HOME}/.claude/claude-orchestrator/store/sessions`
const PROJECTS = `${HOME}/.claude/projects`

// --- the rows -------------------------------------------------------------------------------

test('rows sort by rotation urgency', () => {
  const rows = paneRows({
    'sessions/a': { role: 'agent', name: 'Agent : low', context_percent: 30, context_tokens: 30000, window: 100000, model: 'a-model', busy: false, updated_at: 't', repo: 'r' },
    'sessions/b': { role: 'agent', name: 'Agent : hot', context_percent: 85, context_tokens: 85000, window: 100000, model: 'a-model', busy: true, updated_at: 't', repo: 'r' },
  })
  expect(rows[0].label).toContain('Agent : hot')
  expect(rows[0].label).toContain('85%')
})

// A row with every figure a real measure writes, overridable field by field.
function row(over: {
  role?: SessionRow['role']
  name?: string | null
  repo?: string | null
  context_percent?: number
  context_tokens?: number
  window?: number
  busy?: boolean
  updated_at?: string
} = {}): SessionRow {
  return {
    // `in`, not `??`: a row may carry an explicit null role, and `??` would
    // read it back as the default agent.
    role: 'role' in over ? over.role : 'agent',
    name: 'name' in over ? over.name : null,
    repo: over.repo ?? null,
    context_percent: over.context_percent ?? 0,
    context_tokens: over.context_tokens ?? 0,
    window: over.window ?? 100000,
    model: 'a-model',
    busy: over.busy ?? false,
    updated_at: over.updated_at ?? new Date().toISOString(),
  }
}

test('a row past the token gate outranks a fuller row still below the percent gate', () => {
  // 35% of a 1,000,000 window is 350,000 tokens: past the gate the token half
  // trips, so it leads a session holding 50% of a 100,000 window.
  const rows = paneRows({
    'sessions/big': row({ context_percent: 35, context_tokens: 350000, window: 1000000 }),
    'sessions/small': row({ context_percent: 50, context_tokens: 50000, window: 100000 }),
  })
  expect(rows[0].label).toContain('35%')
  expect(rows[0].label).toContain('past the gate')
  expect(rows[1].label).toContain('50%')
  expect(rows[1].label).not.toContain('past the gate')
  expect(rows[0].urgency).toBeGreaterThan(rows[1].urgency)
})

test('on each side of the gate the fill descends', () => {
  const rows = paneRows({
    'sessions/low': row({ context_percent: 30 }),
    'sessions/mid': row({ context_percent: 50 }),
    'sessions/hot': row({ context_percent: 85 }),
    'sessions/full': row({ context_percent: 95 }),
  })
  const fills = rows.map(r => / (\d+)%/.exec(r.label)?.[1])
  expect(fills).toEqual(['95', '85', '50', '30'])
})

test('the label carries the name, the role, the fill against the gate and the reading age', () => {
  const rows = paneRows({
    'sessions/named': row({ name: 'Agent : one', context_percent: 30, updated_at: new Date(Date.now() - 65000).toISOString() }),
    'sessions/quiet': row({ role: null, updated_at: 't' }),
  })
  const named = rows.find(r => r.label.includes('Agent : one'))!
  expect(named.label).toContain('agent')
  expect(named.label).toContain('30%')
  expect(named.label).toContain('1m')
  expect(named.label).not.toContain('NaN')
  const quiet = rows.find(r => !r.label.includes('Agent : one'))!
  expect(quiet.label).toContain('unnamed')
  expect(quiet.label).toContain('no role')
  expect(quiet.label).not.toContain('NaN')
})

test('an orchestrator\'s agents sort like the store rows, an unmeasured one last', () => {
  const rows = agentPaneRows([
    { name: 'Agent : fresh', status: 'busy', row: null },
    { name: 'Agent : low', status: 'idle', row: row({ context_percent: 20 }) },
    { name: 'Agent : full', status: 'busy', row: row({ context_percent: 35, context_tokens: 350000, window: 1000000 }) },
  ])
  expect(rows.map(r => r.label.split(' · ')[0])).toEqual(['Agent : full', 'Agent : low', 'Agent : fresh'])
  expect(rows[0].label).toContain('busy · 35% past the gate')
  expect(rows[2].label).toBe('Agent : fresh · busy · not measured yet')
})

test('the host record gives the id, the name without a quoted rename\'s quotes, the status', () => {
  expect(hostRecordOf('{"sessionId":"s-1","name":"\\"Orch : PTI\\"","status":"busy"}'))
    .toEqual({ sessionId: 's-1', name: 'Orch : PTI', status: 'busy' })
  expect(hostRecordOf('{"sessionId":"s-2","status":"waiting"}')).toEqual({ sessionId: 's-2', name: null, status: null })
  expect(hostRecordOf('not json')).toBeNull()
})

// --- the wiring -----------------------------------------------------------------------------

// The harness hands a test a $ of its own, reduced — neither fs nor process
// among its nouns — so the pane is exercised over a complete fake: an
// in-memory file map holding the store, recorded runs, a recorded ui.open.
type Fx = {
  dollar: any
  files: Map<string, string>
  ran: string[]
  written: string[]
  opened: object[]
  closed: object[]
  env: Record<string, string>
  timers: { ms: number; fn: () => void; cancelled: boolean }[]
  invalidated: string[]
  state: Map<string, unknown>
}

function fakeDollar(over: {
  launchName?: string | null
  origin?: string
  hangWalk?: boolean
} = {}): Fx {
  const files = new Map<string, string>()
  const ran: string[] = []
  const written: string[] = []
  const opened: object[] = []
  const closed: object[] = []
  const open = new Set<string>()
  const env: Record<string, string> = { HOME, ORCHESTRATOR_HOST_CLI: 'hostcli' }
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
  const invalidated: string[] = []
  // The host's $.state for the session: it outlives the module's own variables.
  const state = new Map<string, unknown>()
  const dollar = {
    state: {
      get: async (ref: { plugin: string; key: string }) => ({ value: state.get(`${ref.plugin}/${ref.key}`), version: 0 }),
      set: async (ref: { plugin: string; key: string }, value: unknown) => {
        state.set(`${ref.plugin}/${ref.key}`, value)
        return { isSet: true, version: 1 }
      },
    },
    session: {
      id: async () => 's-one',
      usage: async () => ({ context: { tokens: 30000, window: 100000, percent: 30 } }),
      model: async () => 'a-model',
      surfaces: async () => ['terminal'],
    },
    env: { get: async (name: string) => env[name] },
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    fs: {
      read: async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
        return files.get(p)
      },
      write: async (p: string, text: string) => {
        files.set(p, text)
      },
      stat: async (p: string) => {
        const text = files.get(p)
        if (text === undefined) throw new Error(`ENOENT: ${p}`)
        return { kind: 'file', size: text.length, mtimeMs: 0, isLink: false }
      },
      list: async (dir: string) => {
        const names = new Set<string>()
        for (const p of files.keys()) {
          if (!p.startsWith(`${dir}/`)) continue
          const rest = p.slice(dir.length + 1)
          if (rest) names.add(rest.split('/')[0])
        }
        return [...names].map(name => {
          const text = files.get(`${dir}/${name}`)
          return text !== undefined
            ? { name, kind: 'file', size: text.length, mtimeMs: 0, isLink: false }
            : { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
        })
      },
      exists: async (p: string) => files.has(p),
    },
    process: {
      run: async (argv: readonly string[]) => {
        const line = logLineOf(argv)
        if (line !== null) {
          written.push(line)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        const block = blockOf(argv, (p: string) => files.get(p) ?? '')
        if (block !== null) return { exitCode: 0, stdout: block, stderr: '' }
        ran.push(argv.join(' '))
        if (argv[0] === 'sh') {
          if (over.hangWalk) return new Promise(() => undefined)
          return { exitCode: 0, stdout: '123 ttys001\n', stderr: '' }
        }
        if (argv[0] === 'ps' && argv[1] === '-t' && argv[2] !== 'ttys001') {
          // Another tab's host process: an agent's, pid 777.
          return { exitCode: 0, stdout: '  777 hostcli\n', stderr: '' }
        }
        if (argv[0] === 'ps' && argv[1] === '-t') {
          const name = over.launchName === null ? null : (over.launchName ?? 'Agent : belt-p3')
          return { exitCode: 0, stdout: name ? `  501 hostcli --name ${name}\n` : '  501 hostcli\n', stderr: '' }
        }
        if (argv[0] === 'git' && argv[1] === 'remote') {
          return over.origin ? { exitCode: 0, stdout: `${over.origin}\n`, stderr: '' } : { exitCode: 128, stdout: '', stderr: 'no origin' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    clock: {
      every: (ms: number, fn: () => void) => {
        const timer = { ms, fn, cancelled: false, cancel: () => { timer.cancelled = true } }
        timers.push(timer)
        return timer
      },
    },
    ui: {
      open: async (pane: { id: string }) => {
        opened.push(pane)
        open.add(pane.id)
        return { isPlaced: true }
      },
      close: async (pane: { id: string }) => {
        closed.push(pane)
        open.delete(pane.id)
      },
      panes: async () => [...open].map(id => ({ id, title: '' })),
      toast: () => undefined,
      invalidate: (what: string) => { invalidated.push(what) },
      resolve: (_e: unknown) => ({
        Box: (props: { flexDirection?: string; children?: unknown[] }) => ({ type: 'Box', props }),
        Text: (props: { color?: string; bold?: boolean; children?: string }) => ({ type: 'Text', props }),
      }),
    },
  }
  return { dollar, files, ran, written, opened, closed, env, timers, invalidated, state }
}

function mounted(register: (on: any) => void): {
  handlers: Record<string, Function>
  matchers: Record<string, object | undefined>
} {
  const handlers: Record<string, Function> = {}
  const matchers: Record<string, object | undefined> = {}
  register((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    handlers[args[0]] = args[args.length - 1] as Function
    matchers[args[0]] = args.length === 3 ? args[1] : undefined
    return { catch: () => undefined }
  })
  return { handlers, matchers }
}

const startEvent = { cwd: '/tmp/w', surface: 'terminal', isInteractive: true }

// The composed chain, one list per event, driven in registration order — the
// order the host drives the chain itself.
function composedChains(): Record<string, Function[]> {
  const chains: Record<string, Function[]> = {}
  registerAll((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
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

test('no start opens the pane, whatever the role', async () => {
  // The operator's ruling: nothing is placed on screen unasked. Supervision
  // registers no start handler, and a start driven through the whole composed
  // chain opens nothing, a coordinator's included.
  const { handlers } = mounted(registerSupervision)
  expect(handlers['session.start']).toBeUndefined()
  const chains = composedChains()
  for (const launchName of ['Coord : main', 'Orch : phase-3', 'Agent : belt-p3']) {
    const fx = fakeDollar({ launchName })
    await drive(chains, 'session.start', fx.dollar, startEvent)
    expect(fx.opened).toEqual([])
  }
})

test('/orchestrator:supervision opens the pane in a coordinator or an orchestrator session alone', async () => {
  const { handlers, matchers } = mounted(registerSupervision)
  expect(matchers['command.run']).toEqual({ command: 'orchestrator:supervision' })
  expect(matchers['ui.render']).toEqual({ component: 'Pane', requestId: 'supervision' })
  const run = { command: 'orchestrator:supervision', args: '' }

  const coord = fakeDollar({ launchName: 'Coord : main' })
  expect(await handlers['command.run'](coord.dollar, run)).toEqual({ text: 'Supervision pane opened; type /orchestrator:supervision again, or click its ✕, to close it.' })
  expect(coord.opened).toEqual([{ id: 'supervision', title: 'Orchestrators' }])
  // Typed again, the command closes the pane it opened.
  expect(await handlers['command.run'](coord.dollar, run)).toEqual({ text: 'Supervision pane closed.' })
  expect(coord.closed).toEqual([{ id: 'supervision' }])
  expect(coord.opened.length).toBe(1)

  const orch = fakeDollar({ launchName: 'Orch : phase-3' })
  await handlers['command.run'](orch.dollar, run)
  expect(orch.opened).toEqual([{ id: 'supervision', title: 'Agents' }])

  for (const launchName of ['Agent : belt-p3', 'Audit : belt', null]) {
    const fx = fakeDollar({ launchName })
    const answer = await handlers['command.run'](fx.dollar, run)
    expect(answer.text).toContain('coordinator session (« Coord : … »), listing the orchestrators, or in an orchestrator session')
    expect(fx.opened).toEqual([])
  }
})

const renderEvent = { surface: 'terminal', component: 'Pane', requestId: 'supervision', props: {} }
const supervisionRun = { command: 'orchestrator:supervision', args: '' }

test('a coordinator\'s pane lists the live orchestrators alone, the urgent first and warned', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = fakeDollar({ launchName: 'Coord : main' })
  fx.files.set(`${SESSIONS}/low`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch : low', context_percent: 30 })) + '\n')
  fx.files.set(`${SESSIONS}/hot`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch : hot', context_percent: 85 })) + '\n')
  fx.files.set(`${SESSIONS}/agent`, JSON.stringify(row({ role: 'agent', name: 'Agent : belt', context_percent: 50 })) + '\n')
  await handlers['command.run'](fx.dollar, supervisionRun)
  const text = JSON.stringify(await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x })))
  expect(text.indexOf('Orch : hot')).toBeLessThan(text.indexOf('Orch : low'))
  expect(text).not.toContain('Agent : belt')
  // Past the gate, the fill and its words are drawn in the error colour.
  expect(text.match(/"color":"error"/g)?.length).toBe(1)
  expect(text.indexOf('"color":"error"')).toBeGreaterThan(text.indexOf('Orch : hot'))

  const { handlers: fresh } = mounted(registerSupervision)
  const empty = fakeDollar({ launchName: 'Coord : main' })
  await fresh['command.run'](empty.dollar, supervisionRun)
  expect(JSON.stringify(await fresh['ui.render'](empty.dollar, renderEvent, (x: unknown) => ({ passed: x })))).toContain('no live orchestrator')
})

test('an orchestrator\'s pane lists the agents its own tab spawned, read from the host\'s records', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = fakeDollar({ launchName: 'Orch : phase-3' })
  fx.env.ITERM_SESSION_ID = 'w0t1p0:OWNER-1'
  // The walk's seed puts this session on ttys001; its chain holds one agent of
  // its own and one a recycled tty's previous owner wrote.
  fx.files.set(`${HOME}/.claude/claude-orchestrator/chains/ttys001.jsonl`, [
    JSON.stringify({ tab_id: 't-9', tty: '/dev/ttys009', owner: 'OWNER-1' }),
    JSON.stringify({ tab_id: 't-8', tty: '/dev/ttys008', owner: 'SOMEONE-ELSE' }),
  ].join('\n') + '\n')
  // The fake's ps answers pid 777 on an agent's tty: its host record and store row.
  fx.files.set(`${HOME}/.claude/sessions/777.json`, JSON.stringify({ sessionId: 's-agent', name: 'Agent : belt-p3', status: 'busy' }))
  fx.files.set(`${SESSIONS}/s-agent`, JSON.stringify(row({ role: 'agent', name: 'Agent : belt-p3', context_percent: 40 })) + '\n')
  await handlers['command.run'](fx.dollar, supervisionRun)
  const text = JSON.stringify(await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x })))
  expect(text).toContain('Agent : belt-p3 · busy · 40%')
  expect(text.match(/Agent : belt-p3/g)?.length).toBe(1)
  expect(fx.ran).toContain('ps -t ttys009 -o pid=')
  expect(fx.ran).not.toContain('ps -t ttys008 -o pid=')

  // Without the terminal's session id no entry is counted: a recycled tty's
  // occupant would be.
  const { handlers: fresh } = mounted(registerSupervision)
  const blind = fakeDollar({ launchName: 'Orch : phase-3' })
  await fresh['command.run'](blind.dollar, supervisionRun)
  expect(JSON.stringify(await fresh['ui.render'](blind.dollar, renderEvent, (x: unknown) => ({ passed: x })))).toContain('no agent running')
})

test('a pane the module no longer remembers opening asks to be opened again', async () => {
  const { handlers } = mounted(registerSupervision)
  const text = JSON.stringify(await handlers['ui.render'](fakeDollar().dollar, renderEvent, (x: unknown) => ({ passed: x })))
  expect(text).toContain('type /orchestrator:supervision to open the pane again')
})

test('a name walk that cannot answer in time costs the row its name, never the measure', async () => {
  // The Task 9 review's bounded-reads carry: the measure's side reads run
  // under their own deadline, and one that loses the race is quietly no name —
  // the figures still land, the measure still answers.
  const chains = composedChains()
  const fx = fakeDollar({ hangWalk: true, origin: 'git@github.com:me/belt.git' })
  fx.env.ORCHESTRATOR_SIDE_READ_MS = '50'
  const e = {}
  const answered = await drive(chains, 'session.measure', fx.dollar, e)
  expect(answered).toBe(e)
  const stored = JSON.parse(String(fx.files.get(`${SESSIONS}/s-one`)))
  expect(stored.name).toBeNull()
  expect(stored.role).toBeNull()
  expect(stored.repo).toBe('me/belt')
  expect(stored.context_percent).toBe(30)
  expect(stored.model).toBe('a-model')
})

test('an open pane redraws on its own clock while its session waits, and the clock stops with any close', async () => {
  // A render was raised only by this session's own measure: a coordinator waiting on
  // the others saw their rows frozen at its last turn. The open starts a clock that
  // re-raises the render; the command's close and the pane's own close both stop it.
  const { handlers, matchers } = mounted(registerSupervision)
  expect(matchers['ui.close']).toEqual({ id: 'supervision' })
  const fx = fakeDollar({ launchName: 'Coord : main' })
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(fx.timers.length).toBe(1)
  expect(fx.timers[0].ms).toBe(20000)
  fx.timers[0].fn()
  expect(fx.invalidated).toEqual(['ui.render'])
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(fx.timers[0].cancelled).toBe(true)
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(fx.timers.length).toBe(2)
  const e = { id: 'supervision', origin: { kind: 'person' } }
  expect(await handlers['ui.close'](fx.dollar, e, (x: unknown) => x)).toBe(e)
  expect(fx.timers[1].cancelled).toBe(true)
})

// --- the coordinator's round ------------------------------------------------------------------

const ROUND = `${HOME}/.claude/claude-orchestrator/round`
const RECORD = `${HOME}/.claude/claude-orchestrator/coordinator.json`

function entry(from: string, since: string, over: Partial<RoundEntry> = {}): RoundEntry {
  return {
    id: `${from.replace(/\W/g, '')}-${since.slice(11, 13)}${since.slice(14, 16)}`, from, session: `s-${from}`, kind: 'operator', since,
    blocks: 'phase 3', question: 'Merge it?', choices: [], recommendation: null, status: 'open', at: since, answer: null, ...over,
  }
}

const CHOICES = [
  { letter: 'A', text: 'merge it now — the release goes out today' },
  { letter: 'B', text: 'wait for the next review — a day lost' },
  { letter: 'C', text: 'close it — the work is dropped' },
]

test('the round\'s first open question is drawn with its choices, the recommended one marked and bold', () => {
  const asked = entry('Orch : a', '2026-10-18T10:03:00.000Z', { choices: CHOICES, recommendation: 'B' })
  expect(roundLines([asked, entry('Orch : a', '2026-10-18T10:05:00.000Z')])).toEqual([
    { letter: null, text: 'Question 1 of 2 — from Orch : a — blocks: phase 3', bold: false },
    { letter: 'A', text: 'merge it now — the release goes out today', bold: false },
    { letter: 'B', text: 'wait for the next review — a day lost  (recommended)', bold: true },
    { letter: 'C', text: 'close it — the work is dropped', bold: false },
  ])
})

test('the first question is the round\'s order\'s, done proposals and closed entries left out of it and of the count', () => {
  const entries = [
    entry('Orch : a', '2026-10-18T10:03:00.000Z', { choices: CHOICES, recommendation: 'B' }),
    entry('Orch : b', '2026-10-18T10:01:00.000Z', { blocks: 'the merge' }),
    entry('Orch : c', '2026-10-18T09:00:00.000Z', { kind: 'done', blocks: null }),
    entry('Orch : d', '2026-10-18T08:00:00.000Z', { status: 'closed' }),
    entry('Orch : e', '2026-10-18T08:30:00.000Z', { status: 'withdrawn' }),
  ]
  expect(roundLines(entries)).toEqual([
    { letter: null, text: 'Question 1 of 2 — from Orch : b — blocks: the merge', bold: false },
    { letter: null, text: 'no lettered choices: answer in this tab', bold: false },
  ])
  expect(roundLines(entries.slice(2))).toEqual([])
  expect(roundLines([])).toEqual([])
})

async function coordinatorRender(fx: Fx, handlers = mounted(registerSupervision).handlers) {
  await handlers['command.run'](fx.dollar, supervisionRun)
  return handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x }))
}

test('a coordinator\'s pane draws the round\'s first question under the orchestrator rows', async () => {
  const fx = fakeDollar({ launchName: 'Coord : main' })
  fx.files.set(`${SESSIONS}/low`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch : low', context_percent: 30 })) + '\n')
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(asked) + '\n')
  fx.files.set(`${ROUND}/broken.json`, '{"id": "broken", "status": "op')
  fx.files.set(`${ROUND}/x.tmp-1.json`, JSON.stringify({ ...asked, from: 'Orch : half' }))
  const tree = await coordinatorRender(fx)
  const [, rows, round] = tree.props.children
  expect(JSON.stringify(rows)).toContain('Orch : low')
  expect(round.type).toBe('Box')
  expect(round.props.marginTop).toBe(1)
  expect(round.props.children.slice(1).map((t: any) => t.type === 'Text' ? [t.props.children, t.props.bold === true] : [t.props.children.map((cell: any) => cell.props.children[0].props.children), t.props.children[1].props.children[0].props.bold === true])).toEqual([
    ['Question 1 of 1 — from Orch : low — blocks: phase 3', true],
    [['A', 'merge it now — the release goes out today'], false],
    [['B', 'wait for the next review — a day lost  (recommended)'], true],
    [['C', 'close it — the work is dropped'], false],
  ])
})

test('a choice is a row whose letter has a column of its own, so a long text wraps under the text', async () => {
  const fx = fakeDollar({ launchName: 'Coord : main' })
  fx.files.set(`${SESSIONS}/low`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch : low', context_percent: 30 })) + '\n')
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(asked) + '\n')
  const [, , round] = (await coordinatorRender(fx)).props.children
  const [, header, ...choices] = round.props.children
  expect(header.type).toBe('Text')
  for (const choice of choices) {
    expect(choice.type).toBe('Box')
    expect(choice.props.flexDirection).toBe('row')
    const [letter, text] = choice.props.children
    expect(letter.props).toMatchObject({ width: 3, flexShrink: 0 })
    expect(text.props).toMatchObject({ flexGrow: 1, flexShrink: 1 })
    expect(letter.props.children[0].type).toBe('Text')
    expect(text.props.children[0].type).toBe('Text')
  }
})

test('no open question: nothing is drawn below the rows, and an orchestrator\'s pane never draws the round', async () => {
  const bare = fakeDollar({ launchName: 'Coord : main' })
  const settled = fakeDollar({ launchName: 'Coord : main' })
  for (const fx of [bare, settled]) fx.files.set(`${SESSIONS}/low`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch : low', context_percent: 30, updated_at: '2026-10-18T10:00:00.000Z' })) + '\n')
  for (const done of [entry('Orch : low', '2026-10-18T10:03:00.000Z', { status: 'closed' }), entry('Orch : low', '2026-10-18T10:04:00.000Z', { kind: 'done', blocks: null })]) {
    settled.files.set(`${ROUND}/${done.id}.json`, JSON.stringify(done) + '\n')
  }
  const settledTree = await coordinatorRender(settled)
  expect(JSON.stringify(settledTree)).toBe(JSON.stringify(await coordinatorRender(bare)))
  // The title, the block and the section's `none`: no question line below the block.
  expect(settledTree.props.children.length).toBe(3)
  expect(JSON.stringify(settledTree)).not.toContain('Question 1 of')

  const orch = fakeDollar({ launchName: 'Orch : phase-3' })
  const asked = entry('Orch : phase-3', '2026-10-18T10:03:00.000Z')
  orch.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(asked) + '\n')
  expect(JSON.stringify(await coordinatorRender(orch))).not.toContain('Question 1 of')
})

test('a question whose sender has ended is not drawn, nor counted: only the live sessions\' questions are', async () => {
  const fx = fakeDollar({ launchName: 'Coord : main' })
  fx.files.set(`${SESSIONS}/live`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch : live', context_percent: 30 })) + '\n')
  const gone = entry('Orch : gone', '2026-10-18T10:01:00.000Z', { session: 'ended', blocks: 'the old merge' })
  const asked = entry('Orch : live', '2026-10-18T10:03:00.000Z', { session: 'live', choices: CHOICES, recommendation: 'B' })
  for (const e of [gone, asked]) fx.files.set(`${ROUND}/${e.id}.json`, JSON.stringify(e) + '\n')
  const [, , round] = (await coordinatorRender(fx)).props.children
  expect(round.props.children[1].props.children).toBe('Question 1 of 1 — from Orch : live — blocks: phase 3')
  expect(JSON.stringify(round)).not.toContain('Orch : gone')
  // Every sender ended: nothing is drawn below the rows.
  fx.files.delete(`${SESSIONS}/live`)
  expect(JSON.stringify(await coordinatorRender(fx))).not.toContain('Question 1 of')
  expect(JSON.stringify(await coordinatorRender(fx))).toContain('"none"')
})

test('a round directory that cannot be listed is one log line and no entry; one never written is no failure', async () => {
  const fx = fakeDollar({ launchName: 'Coord : main' })
  expect(await readRound(fx.dollar)).toEqual([])
  expect(fx.written).toEqual([])
  fx.files.set(ROUND, '')
  fx.dollar.fs.list = async () => { throw new Error('EACCES: permission denied') }
  expect(await readRound(fx.dollar)).toEqual([])
  expect(fx.written.filter(l => l.includes(`round: cannot list ${ROUND}: EACCES: permission denied`)).length).toBe(1)
})

// --- the pane opens by itself with the coordinator ----------------------------------------------

const firstTurn = { answer: 'Registered.', reason: 'answer', isAborted: false, durationMs: 1, turnId: 't' }

function coordinatorSession(over: { role?: SessionRow['role']; record?: boolean } = {}): Fx {
  const fx = fakeDollar({ launchName: 'Coord : main' })
  fx.files.set(`${SESSIONS}/s-one`, JSON.stringify(row({ role: 'role' in over ? over.role : 'coordinator', name: 'Coord : main' })) + '\n')
  if (over.record !== false) fx.files.set(RECORD, JSON.stringify({ name: 'Coord : main [abc]', tty: '/dev/ttys001' }))
  return fx
}

test('a coordinator\'s pane opens by itself at the end of its first turn, as the command opens it, once', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  expect(await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)).toBe(firstTurn)
  expect(fx.opened).toEqual([{ id: 'supervision', title: 'Orchestrators' }])
  expect(fx.timers.map(t => t.ms)).toEqual([20000])
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.opened.length).toBe(1)
  expect(fx.timers.length).toBe(1)
  // Opened by the module, the pane lists what the command's pane lists.
  fx.files.set(`${SESSIONS}/low`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch : low', context_percent: 30 })) + '\n')
  expect(JSON.stringify(await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x })))).toContain('Orch : low')
})

test('a pane the operator closed with the command stays closed, the module reloaded or not', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(await handlers['command.run'](fx.dollar, supervisionRun)).toEqual({ text: 'Supervision pane closed.' })
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  // A reload starts the module's variables over; the host's $.state keeps the flag.
  const { handlers: reloaded } = mounted(registerSupervision)
  await reloaded['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.opened.length).toBe(1)
  expect(fx.closed).toEqual([{ id: 'supervision' }])
})

test('a pane the command opened and closed before the first turn ended is not opened again', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  await handlers['command.run'](fx.dollar, supervisionRun)
  await handlers['command.run'](fx.dollar, supervisionRun)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.opened.length).toBe(1)
})

for (const [label, fx, e] of [
  ['an orchestrator', () => coordinatorSession({ role: 'orchestrator' }), firstTurn],
  ['no coordinator recorded', () => coordinatorSession({ record: false }), firstTurn],
  ['a subagent\'s turn', () => coordinatorSession(), { ...firstTurn, agentId: 'a1' }],
] as const) {
  test(`the pane does not open by itself for ${label}`, async () => {
    const { handlers } = mounted(registerSupervision)
    const session = fx()
    await handlers['turn.complete'](session.dollar, e, (x: unknown) => x)
    expect(session.opened).toEqual([])
    expect([...session.state.values()]).toEqual([])
  })
}

test('a first turn that ends before the first measure wrote the row: the name is walked, and the pane opens', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  fx.files.delete(`${SESSIONS}/s-one`)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.opened).toEqual([{ id: 'supervision', title: 'Orchestrators' }])
  // A row that names no role is read as it is: the session is no coordinator, nothing opens.
  const { handlers: other } = mounted(registerSupervision)
  const plain = coordinatorSession({ role: null })
  await other['turn.complete'](plain.dollar, firstTurn, (x: unknown) => x)
  expect(plain.opened).toEqual([])
})

test('a first turn that ends with no row in the store: the lookup names the coordinator, and the pane opens once', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  fx.files.delete(`${SESSIONS}/s-one`)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.ran.some(run => run.startsWith('ps -t ttys001'))).toBe(true)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.opened).toEqual([{ id: 'supervision', title: 'Orchestrators' }])
  expect(fx.timers.length).toBe(1)
})

test('a coordinator recorded after the first turn: the pane opens at the first turn end that finds it', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession({ record: false })
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.opened).toEqual([])
  fx.files.set(RECORD, JSON.stringify({ name: 'Coord : main [abc]', tty: '/dev/ttys001' }))
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.opened).toEqual([{ id: 'supervision', title: 'Orchestrators' }])
})

// --- the coordinator's pane, readable -----------------------------------------------------------

// A node's drawn pieces, depth first: the text, its colour and whether it is bold.
function pieces(node: any): { text: string; color?: string; bold: boolean }[] {
  if (typeof node === 'string') return [{ text: node, bold: false }]
  const kids = [node.props.children].flat().filter((kid: unknown) => kid !== undefined)
  if (node.type === 'Text' && kids.every((kid: unknown) => typeof kid === 'string')) {
    return [{ text: kids.join(''), color: node.props.color, bold: node.props.bold === true }]
  }
  return kids.flatMap(pieces)
}

const AGO = () => new Date(Date.now() - 3 * 60000).toISOString()
const SINCE = '2026-10-19T08:05:00.000Z'
const paneTree = async (rows: Record<string, SessionRow>, round: RoundEntry[] = []) => {
  const fx = fakeDollar({ launchName: 'Coord : main' })
  for (const [key, value] of Object.entries(rows)) fx.files.set(`${SESSIONS}/${key}`, JSON.stringify(value) + '\n')
  for (const e of round) fx.files.set(`${ROUND}/${e.id}.json`, JSON.stringify(e) + '\n')
  return coordinatorRender(fx)
}
const orch = (name: string, over: Partial<SessionRow> = {}) => ({ ...row({ role: 'orchestrator', name, context_percent: 30, updated_at: AGO() }), ...over })

test('the coordinator\'s pane opens with a bold title above the orchestrator blocks, and says when there is none', async () => {
  const tree = await paneTree({ low: orch('Orch : low') })
  expect(pieces(tree.props.children[0])).toEqual([{ text: 'Orchestrators', bold: true }])
  const empty = await paneTree({})
  expect(pieces(empty.props.children[0])).toEqual([{ text: 'Orchestrators', bold: true }])
  expect(pieces(empty.props.children[1])).toEqual([{ text: 'no live orchestrator', bold: false }])
})

const text = (nodes: { text: string }[]) => nodes.map(p => p.text).join('')

test('a plain orchestrator is one line: a dot, its bold name, then its figures in the normal colour', async () => {
  const tree = await paneTree({ low: orch('Orch : low') })
  const block = tree.props.children[1]
  expect(block.props.children.length).toBe(1)
  expect(pieces(block.props.children[0])).toEqual([
    { text: '●', color: 'suggestion', bold: false },
    { text: ' ', bold: false },
    { text: 'Orch : low', bold: true },
    { text: ' · orchestrator · ', bold: false },
    { text: '30%', bold: false },
    { text: ' · 3m', bold: false },
  ])
  expect(pieces(block).some(p => p.color === 'subtle')).toBe(false)
})

test('an orchestrator waiting for the operator draws a warning dot, a Status line and a Blocks line, both indented', async () => {
  const tree = await paneTree({ w: orch('Orch : w', { waiting: 'operator', waiting_since: SINCE, blocks: 'the merge' }) })
  const block = tree.props.children[1]
  expect(block.props.children.length).toBe(3)
  expect(pieces(block.props.children[0])[0]).toEqual({ text: '●', color: 'warning', bold: false })
  const [, status, blocks] = block.props.children
  expect(status.props.paddingLeft).toBe(2)
  const [label, words] = pieces(status)
  expect(label).toEqual({ text: 'Status: ', bold: false })
  expect(words.color).toBe('warning')
  expect(words.text).toMatch(/^waiting for the operator since \d\d:\d\d$/)
  expect(blocks.props.paddingLeft).toBe(2)
  expect(pieces(blocks)).toEqual([{ text: 'Blocks:', bold: false }, { text: 'the merge', bold: false }])
})

test('a long blocks text stays in a column of its own, wrapping under its first character and not under the label', async () => {
  const long = 'release out of draft and squash merge of geonative-api#1749, geonative-api#1751 and front-office#1545 (G2/G5 with #1751, G6 with #1749 + #1545)'
  const tree = await paneTree({ w: orch('Orch : w', { waiting: 'operator', waiting_since: SINCE, blocks: long }) })
  const line = tree.props.children[1].props.children[2]
  const [labelColumn, textColumn] = line.props.children
  expect(line.props.flexDirection).toBe('row')
  expect(labelColumn.props.width).toBe(8)
  expect(labelColumn.props.flexShrink).toBe(0)
  expect(textColumn.props.flexGrow).toBe(1)
  expect(textColumn.props.flexShrink).toBe(1)
  expect(pieces(textColumn)).toEqual([{ text: long, bold: false }])
})

test('an operator wait that carries no blocks text says unsaid', async () => {
  const tree = await paneTree({ w: orch('Orch : w', { waiting: 'operator', waiting_since: SINCE }) })
  expect(pieces(tree.props.children[1].props.children[2])[1].text).toBe('unsaid')
})

test('a done orchestrator draws a success dot and one Status line in success, with no Blocks line', async () => {
  const tree = await paneTree({ d: orch('Orch : d', { waiting: 'done', waiting_since: SINCE }) })
  const block = tree.props.children[1]
  expect(block.props.children.length).toBe(2)
  expect(pieces(block.props.children[0])[0]).toEqual({ text: '●', color: 'success', bold: false })
  const [label, words] = pieces(block.props.children[1])
  expect(label.text).toBe('Status: ')
  expect(words.color).toBe('success')
  expect(words.text).toMatch(/^done since \d\d:\d\d, proposes to be closed$/)
})

test('a row past the gate draws its fill and gate words in the error colour, the rest in the normal colour', async () => {
  const tree = await paneTree({ hot: orch('Orch : hot', { context_percent: 85, context_tokens: 85000 }) })
  expect(pieces(tree.props.children[1].props.children[0]).slice(3)).toEqual([
    { text: ' · orchestrator · ', bold: false },
    { text: '85% past the gate', color: 'error', bold: false },
    { text: ' · 3m', bold: false },
  ])
})

test('a remote orchestrator keeps its machine in its line', async () => {
  const tree = await paneTree({ r: orch('Orch : r', { machine: 'mini' }) })
  expect(text(pieces(tree.props.children[1].props.children[0]))).toBe('● Orch : r · orchestrator · remote mini · 30% · 3m')
})

test('no empty line separates two blocks', async () => {
  const tree = await paneTree({ a: orch('Orch : a', { context_percent: 40 }), b: orch('Orch : b') })
  const [, first, second] = tree.props.children
  expect(first.props.marginTop).toBeUndefined()
  expect(second.props.marginTop).toBeUndefined()
  expect(pieces(first.props.children[0])[2].text).toBe('Orch : a')
})

test('the orchestrator that asked the open question stands out: its whole line bold in suggestion, the others plain', async () => {
  const asked = entry('Orch : a', '2026-10-18T10:03:00.000Z', { session: 'a', choices: CHOICES, recommendation: 'B' })
  const tree = await paneTree({ a: orch('Orch : a', { context_percent: 40 }), b: orch('Orch : b') }, [asked])
  const [, speaker, other] = tree.props.children
  expect(pieces(speaker.props.children[0])).toEqual([
    { text: '●', color: 'suggestion', bold: false },
    { text: ' ', bold: false },
    { text: 'Orch : a', color: 'suggestion', bold: true },
    { text: ' · orchestrator · ', color: 'suggestion', bold: true },
    { text: '40%', color: 'suggestion', bold: true },
    { text: ' · 3m', color: 'suggestion', bold: true },
  ])
  expect(pieces(other.props.children[0]).slice(2).every(p => p.color === undefined && p.bold === (p.text === 'Orch : b'))).toBe(true)
})

test('the speaker is matched by its session, not its name, and keeps the error colour past the gate', async () => {
  const asked = entry('Orch : same', '2026-10-18T10:03:00.000Z', { session: 'hot', choices: CHOICES })
  const tree = await paneTree({
    hot: orch('Orch : hot', { context_percent: 85, context_tokens: 85000 }),
    twin: orch('Orch : same', { context_percent: 20 }),
  }, [asked])
  const [, first, second] = tree.props.children
  expect(pieces(first.props.children[0]).slice(3)).toEqual([
    { text: ' · orchestrator · ', color: 'suggestion', bold: true },
    { text: '85% past the gate', color: 'error', bold: true },
    { text: ' · 3m', color: 'suggestion', bold: true },
  ])
  expect(pieces(second.props.children[0]).some(p => p.color === 'suggestion' && p.bold)).toBe(false)
})

test('a done proposal is no question: no row stands out', async () => {
  const done = entry('Orch : d', '2026-10-18T10:03:00.000Z', { session: 'd', kind: 'done', blocks: null })
  const tree = await paneTree({ d: orch('Orch : d', { waiting: 'done', waiting_since: SINCE }) }, [done])
  const line = pieces(tree.props.children[1].props.children[0])
  expect(line.map(p => p.text)).toEqual(['●', ' ', 'Orch : d', ' · orchestrator · ', '30%', ' · 3m'])
  expect(line.some(p => p.bold && p.color === 'suggestion')).toBe(false)
})

test('the questions section is titled in bold suggestion, with an open question styled', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  const tree = await paneTree({ low: orch('Orch : low') }, [asked])
  const section = tree.props.children[2]
  expect(section.props.marginTop).toBe(1)
  const [title, header, a, b, c] = section.props.children
  expect(pieces(title)).toEqual([{ text: 'Questions for you', color: 'suggestion', bold: true }])
  expect(pieces(header)).toEqual([{ text: 'Question 1 of 1 — from Orch : low — blocks: phase 3', bold: true }])
  expect(pieces(a)).toEqual([{ text: 'A', color: 'suggestion', bold: true }, { text: 'merge it now — the release goes out today', bold: false }])
  expect(pieces(b)).toEqual([{ text: 'B', color: 'success', bold: true }, { text: 'wait for the next review — a day lost  (recommended)', color: 'success', bold: true }])
  expect(pieces(c)[0]).toEqual({ text: 'C', color: 'suggestion', bold: true })
})

test('no question: the section says none, or counts the orchestrators waiting when the round holds none', async () => {
  const none = await paneTree({ low: orch('Orch : low') })
  expect(pieces(none.props.children[2])).toEqual([
    { text: 'Questions for you', color: 'suggestion', bold: true },
    { text: 'none', bold: false },
  ])
  const waits = { w1: orch('Orch : w1', { waiting: 'operator', waiting_since: SINCE }), w2: orch('Orch : w2', { waiting: 'operator', waiting_since: SINCE }), d: orch('Orch : d', { waiting: 'done', waiting_since: SINCE }) }
  const two = await paneTree(waits)
  expect(pieces(two.props.children[4])[1]).toEqual({ text: 'none in the pane — 2 orchestrators wait for you: ask the coordinator', bold: false })
  const one = await paneTree({ w1: waits.w1 })
  expect(pieces(one.props.children[2])[1].text).toBe('none in the pane — 1 orchestrator waits for you: ask the coordinator')
})

test('an orchestrator\'s own pane keeps its flat subtle rows, with no title', async () => {
  const fx = fakeDollar({ launchName: 'Orch : phase-3' })
  fx.env.ITERM_SESSION_ID = 'w0t1p0:OWNER-1'
  const tree = await coordinatorRender(fx)
  expect(tree.props.children.map((kid: any) => [kid.props.color, kid.props.children])).toEqual([['subtle', 'no agent running']])
})

test('an orchestrator\'s own pane draws an agent past the gate in warning and the other in subtle, with no title', async () => {
  const fx = fakeDollar({ launchName: 'Orch : phase-3' })
  fx.env.ITERM_SESSION_ID = 'w0t1p0:OWNER-1'
  fx.files.set(`${HOME}/.claude/claude-orchestrator/chains/ttys001.jsonl`, [
    JSON.stringify({ tab_id: 't-9', tty: '/dev/ttys009', owner: 'OWNER-1' }),
    JSON.stringify({ tab_id: 't-10', tty: '/dev/ttys010', owner: 'OWNER-1' }),
  ].join('\n') + '\n')
  // The fake's ps answers one pid for every agent's tty: each tab gets a pid of its own.
  const run = fx.dollar.process.run
  fx.dollar.process.run = async (argv: readonly string[]) =>
    argv[0] === 'ps' && argv[2] === 'ttys010' ? { exitCode: 0, stdout: '  778 hostcli\n', stderr: '' } : run(argv)
  fx.files.set(`${HOME}/.claude/sessions/777.json`, JSON.stringify({ sessionId: 's-past', name: 'Agent : past', status: 'busy' }))
  fx.files.set(`${HOME}/.claude/sessions/778.json`, JSON.stringify({ sessionId: 's-under', name: 'Agent : under', status: 'busy' }))
  fx.files.set(`${SESSIONS}/s-past`, JSON.stringify(row({ role: 'agent', name: 'Agent : past', context_percent: 35, context_tokens: 350000, window: 1000000 })) + '\n')
  fx.files.set(`${SESSIONS}/s-under`, JSON.stringify(row({ role: 'agent', name: 'Agent : under', context_percent: 20 })) + '\n')
  const tree = await coordinatorRender(fx)
  expect(tree.props.children.map((kid: any) => [kid.props.color, kid.props.children])).toEqual([
    ['warning', expect.stringMatching(/^Agent : past · busy · 35% past the gate · /)],
    ['subtle', expect.stringMatching(/^Agent : under · busy · 20% · /)],
  ])
})
