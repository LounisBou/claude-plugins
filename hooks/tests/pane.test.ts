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
import { agentPaneRows, paneRows, readRound, roundLines, register as registerSupervision, registerWake, type SessionRow } from '../supervision.ts'
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
  focused: { requestId: string; key: string }[]
  scrolled: { to: unknown; in?: string }[]
  later: { ms: number; fn: () => unknown; cancelled: boolean }[]
  state: Map<string, unknown>
  submitted: string[]
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
  const focused: { requestId: string; key: string }[] = []
  const scrolled: { to: unknown; in?: string }[] = []
  const later: { ms: number; fn: () => unknown; cancelled: boolean }[] = []
  // What the module submitted to its own session: the wake of a coordinator.
  const submitted: string[] = []
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
    prompt: { submit: async (args: { text: string }) => { submitted.push(args.text) } },
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
        // The module's atomic write renames its temporary file into place.
        if (argv[0] === 'mv' && argv[1] === '-f' && files.has(argv[2])) {
          files.set(argv[3], files.get(argv[2])!)
          files.delete(argv[2])
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'rm' && argv[1] === '-f') {
          for (const p of argv.slice(2)) files.delete(p)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'sh') {
          if (over.hangWalk) return new Promise(() => undefined)
          return { exitCode: 0, stdout: '123 ttys001\n', stderr: '' }
        }
        if (argv[0] === 'ps' && argv[1] === '-A') {
          // The machine's live pids: this session's host process and an agent's.
          return { exitCode: 0, stdout: '  501\n  777\n', stderr: '' }
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
      after: (ms: number, fn: () => unknown) => {
        const timer = { ms, fn, cancelled: false }
        later.push(timer)
        return { cancel: () => { timer.cancelled = true } }
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
      focus: async (args: { requestId: string; key: string }) => {
        focused.push(args)
        return {}
      },
      scroll: async (args: { to: unknown; in?: string }) => {
        scrolled.push(args)
        return {}
      },
      // The mobile table has no Input and no Select, as the reference says; the terminal's,
      // the desktop's and the editor's have both.
      resolve: (e: { surface?: string }) => ({
        Box: (props: { flexDirection?: string; children?: unknown[] }) => ({ type: 'Box', props }),
        Text: (props: { color?: string; bold?: boolean; children?: string }) => ({ type: 'Text', props }),
        Button: (props: { key?: string; label?: string; hotkey?: string; onPress: () => void }) => ({ type: 'Button', props }),
        ...(e.surface === 'mobile' ? {} : {
          Input: (props: { key: string; label?: string; onSubmit: (value: string) => void }) => ({ type: 'Input', props }),
          Select: (props: { key: string; label?: string; options: { value: string; label?: string }[]; value?: string; onSelect: (value: string) => void }) => ({ type: 'Select', props }),
        }),
      }),
    },
  }
  return { dollar, files, ran, written, opened, closed, env, timers, invalidated, focused, scrolled, later, state, submitted }
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
  // The row is the name (bold) and the rest in two pieces: read as the text they draw together.
  const tree = await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x }))
  const text = tree.props.children.map((kid: any) => pieces(kid).map((p: any) => p.text).join('')).join('\n')
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
    { letter: null, text: 'Question 1 of 2 — from Orch : a — blocks: phase 3', bold: false },
    { letter: 'A', text: 'merge it now — the release goes out today', bold: false },
    { letter: 'B', text: 'wait for the next review — a day lost  (recommended)', bold: true },
    { letter: 'C', text: 'close it — the work is dropped', bold: false },
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
  const { handlers } = mounted(registerSupervision)
  const first = await coordinatorRender(fx, handlers)
  // The field is drawn once « Other answer » is picked.
  expect(findAll(first, n => n.type === 'Input')).toEqual([])
  await findAll(first, n => n.type === 'Select')[0].props.onSelect('other')
  const tree = await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x }))
  const [, rows, round] = tree.props.children
  expect(JSON.stringify(rows)).toContain('Orch : low')
  expect(round.type).toBe('Box')
  expect(round.props.marginTop).toBe(1)
  const kids = round.props.children
  expect(kids.slice(1, 3).map((t: any) => [t.props.children, t.props.bold === true])).toEqual([
    ['Question 1 of 1 — from Orch : low — blocks: phase 3', true],
    ['Merge it?', false],
  ])
  expect(kids.slice(3).map((t: any) => t.type === 'Text' ? `Text ${t.props.children}` : `${t.type} ${t.props.label}`)).toEqual([
    'Text A  merge it now — the release goes out today',
    'Text B  wait for the next review — a day lost  (recommended)',
    'Text C  close it — the work is dropped',
    'Select Answer',
    'Input Other answer',
    'Text ctrl+x tab or a click: give the pane the keys · arrows: move · Enter: choose · Esc: back to the prompt',
  ])
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

test('the archive under the round is read by nothing: an open entry planted there is neither read nor drawn', async () => {
  const fx = fakeDollar({ launchName: 'Coord : main' })
  fx.files.set(`${SESSIONS}/live`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch : live', context_percent: 30 })) + '\n')
  const hidden = entry('Orch : live', '2026-10-18T10:03:00.000Z', { session: 'live' })
  fx.files.set(`${ROUND}/archive/${hidden.id}.json`, JSON.stringify(hidden) + '\n')
  expect(await readRound(fx.dollar)).toEqual([])
  expect(JSON.stringify(await coordinatorRender(fx))).not.toContain('Question 1 of')
  // The same entry directly under the round is drawn: only its place kept it out.
  const control = fakeDollar({ launchName: 'Coord : main' })
  control.files.set(`${SESSIONS}/live`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch : live', context_percent: 30 })) + '\n')
  control.files.set(`${ROUND}/${hidden.id}.json`, JSON.stringify(hidden) + '\n')
  expect((await readRound(control.dollar)).length).toBe(1)
  expect(JSON.stringify(await coordinatorRender(control))).toContain('Question 1 of 1')
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
  const [title, header, body, a, b, c] = section.props.children
  expect(pieces(body)).toEqual([{ text: 'Merge it?', bold: false }])
  expect(pieces(title)).toEqual([{ text: 'Questions for you', color: 'suggestion', bold: true }])
  expect(pieces(header)).toEqual([{ text: 'Question 1 of 1 — from Orch : low — blocks: phase 3', bold: true }])
  expect([a, b, c].map(choice => [choice.type, choice.props.children])).toEqual([
    ['Text', 'A  merge it now — the release goes out today'],
    ['Text', 'B  wait for the next review — a day lost  (recommended)'],
    ['Text', 'C  close it — the work is dropped'],
  ])
  expect(pieces(b)).toEqual([{ text: 'B  wait for the next review — a day lost  (recommended)', color: 'success', bold: true }])
  expect([a, c].map(choice => [choice.props.bold, choice.props.color])).toEqual([[undefined, undefined], [undefined, undefined]])
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

test('an orchestrator\'s own pane says no agent running in the default text colour, with no title', async () => {
  const fx = fakeDollar({ launchName: 'Orch : phase-3' })
  fx.env.ITERM_SESSION_ID = 'w0t1p0:OWNER-1'
  const tree = await coordinatorRender(fx)
  expect(tree.props.children.map((kid: any) => [kid.props.color, kid.props.children])).toEqual([[undefined, 'no agent running']])
})

test('an orchestrator\'s own pane draws an agent past the gate in warning and the other in the default text colour, each name bold, with no title', async () => {
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
  const [past, under] = tree.props.children.map((kid: any) => pieces(kid))
  expect(past.map((p: any) => p.text).join('')).toMatch(/^Agent : past · busy · 35% past the gate · /)
  expect(past.every((p: any) => p.color === 'warning')).toBe(true)
  expect(past.filter((p: any) => p.bold).map((p: any) => p.text)).toEqual(['Agent : past'])
  expect(under.map((p: any) => p.text).join('')).toMatch(/^Agent : under · busy · 20% · /)
  expect(under.some((p: any) => p.color !== undefined)).toBe(false)
  expect(under.filter((p: any) => p.bold).map((p: any) => p.text)).toEqual(['Agent : under'])
})

// --- answering from the coordinator's pane ------------------------------------------------------

// Every element of a tree whose props match, depth first.
function findAll(node: any, match: (node: any) => boolean): any[] {
  if (!node || typeof node !== 'object') return []
  const kids = [node.props?.children].flat().filter((kid: unknown) => kid !== undefined)
  return [...(match(node) ? [node] : []), ...kids.flatMap((kid: any) => findAll(kid, match))]
}
const button = (tree: any, key: string) => findAll(tree, n => n.type === 'Button' && n.props.key === key)[0]
const picker = (tree: any) => findAll(tree, n => n.type === 'Select')[0]
const pick = (tree: any, value: string) => picker(tree).props.onSelect(value)
const texts = (tree: any) => findAll(tree, n => n.type === 'Text' && typeof n.props.children === 'string').map(n => n.props.children as string)

// A coordinator with one live orchestrator asking, its send recorded (or refused), its pane drawn.
async function askingPane(asked: RoundEntry[], over: { refuse?: string; throws?: string; surface?: string } = {}) {
  const fx = fakeDollar({ launchName: 'Coord : main' })
  fx.files.set(`${SESSIONS}/low`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch : low', context_percent: 30 })) + '\n')
  for (const e of asked) fx.files.set(`${ROUND}/${e.id}.json`, JSON.stringify(e) + '\n')
  const sent: { to: string; text: string }[] = []
  fx.dollar.session.send = async (args: { to: string; text: string }) => {
    sent.push(args)
    if (over.throws) throw new Error(over.throws)
    return over.refuse ? { isDelivered: false, reason: over.refuse } : { isDelivered: true }
  }
  const { handlers } = mounted(registerSupervision)
  await handlers['command.run'](fx.dollar, supervisionRun)
  const render = () => handlers['ui.render'](fx.dollar, { ...renderEvent, surface: over.surface ?? 'terminal' }, (x: unknown) => ({ passed: x }))
  const stored = (id: string) => JSON.parse(String(fx.files.get(`${ROUND}/${id}.json`))) as RoundEntry
  // The pane's ring moved onto `element`, or off its elements when absent, by the operator.
  const ring = (element?: string) => handlers['ui.focus'](fx.dollar,
    { component: 'Pane', requestId: 'supervision', ...(element ? { plugin: 'orchestrator', element } : {}), origin: { kind: 'person' } },
    () => ({}))
  return { fx, sent, render, stored, ring }
}

const LONG = `Question 1 of 1 — ${'every word of the context the operator needs to decide. '.repeat(45)}`.slice(0, 2499).trimEnd().padEnd(2500, '.')

test('a 2,500-character question is drawn whole in the pane, above its choices', async () => {
  const question = `${LONG}\n- **A** : one\n- **B** : two\n_Recommendation_ : B`
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', question, choices: [{ letter: 'A', text: 'one' }, { letter: 'B', text: 'two' }], recommendation: 'B' })
  const { render } = await askingPane([asked])
  const drawn = texts(await render())
  expect(drawn).toContain(LONG)
  expect(drawn.some(t => t.includes('[cut at'))).toBe(false)
  expect(drawn.indexOf(LONG)).toBeGreaterThan(drawn.indexOf('Question 1 of 1 — from Orch : low — blocks: phase 3'))
})

test('a message without lettered choices shows its text and the Other answer field, no choice Button, never a bare blocks line', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', question: LONG })
  const { render } = await askingPane([asked])
  const tree = await render()
  expect(texts(tree)).toContain(LONG)
  expect(input(tree).props).toMatchObject({ label: 'Other answer' })
  expect(findAll(tree, n => n.type === 'Button').length).toBe(0)
  expect(JSON.stringify(tree)).not.toContain('no lettered choices')
})

test('a pick of a choice answers the entry from the pane, sends the asking orchestrator the choice once, and draws the next question', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  const next = entry('Orch : low', '2026-10-18T10:05:00.000Z', { session: 'low', blocks: 'phase 4', question: 'Rename it?' })
  const { fx, sent, render, stored } = await askingPane([asked, next])
  await pick(await render(), 'B')
  const answered = stored(asked.id)
  expect(answered.status).toBe('answered')
  expect(answered.answer).toEqual({ text: 'B : wait for the next review — a day lost', by: 'pane', at: answered.answer!.at })
  expect(Number.isFinite(Date.parse(answered.answer!.at))).toBe(true)
  expect([...fx.files.keys()].some(p => p.includes('.tmp-'))).toBe(false)
  expect(sent).toEqual([{
    to: 'Orch : low',
    text: `[module] The operator answered from the coordinator's pane at ${answered.answer!.at} — B : wait for the next review — a day lost (question since 2026-10-18T10:03:00.000Z, blocks: phase 3)`,
  }])
  expect(fx.invalidated).toContain('ui.render')
  const after = await render()
  expect(texts(after)).toContain('Question 1 of 1 — from Orch : low — blocks: phase 4')
  expect(texts(after)).toContain('Rename it?')
})

test('a pick on a drawing whose entry was settled meanwhile writes and sends nothing', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES })
  const { fx, sent, render, stored } = await askingPane([asked])
  const drawn = await render()
  fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify({ ...asked, status: 'closed' }) + '\n')
  await pick(drawn, 'A')
  expect(stored(asked.id).status).toBe('closed')
  expect(sent).toEqual([])
})

test('an answer not delivered keeps the entry answered, is logged, and is said until a render finds the sender gone', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES })
  const { fx, sent, render, stored } = await askingPane([asked], { refuse: 'nobody by that name' })
  await pick(await render(), 'A')
  expect(stored(asked.id).status).toBe('answered')
  expect(sent.length).toBe(1)
  expect(fx.written.filter(l => l.includes("round: the pane's answer was not delivered to Orch : low: nobody by that name")).length).toBe(1)
  expect(texts(await render()).some(t => t.startsWith('not delivered: nobody by that name'))).toBe(true)
  expect(texts(await render()).some(t => t.startsWith('not delivered: nobody by that name'))).toBe(true)
  fx.files.delete(`${SESSIONS}/low`)
  expect(texts(await render()).some(t => t.startsWith('not delivered:'))).toBe(false)
  fx.files.set(`${SESSIONS}/low`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch : low', context_percent: 30 })) + '\n')
  expect(texts(await render()).some(t => t.startsWith('not delivered:'))).toBe(false)
})

test('an entry its sender withdrew is out of the pane and of its count', async () => {
  const stale = entry('Orch : low', '2026-10-18T10:01:00.000Z', { session: 'low', status: 'withdrawn', answer: { text: '', by: 'sender', at: '2026-10-18T10:02:00.000Z' } })
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', blocks: 'phase 4' })
  const { render } = await askingPane([stale, asked])
  expect(texts(await render())).toContain('Question 1 of 1 — from Orch : low — blocks: phase 4')
})

test('a send that throws is said in the pane as an answer not delivered, its reason the error\'s, and logged', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES })
  const { fx, render, stored } = await askingPane([asked], { throws: 'the bridge is down' })
  await pick(await render(), 'A')
  expect(stored(asked.id).status).toBe('answered')
  expect(fx.written.filter(l => l.includes("round: the pane's answer was not delivered to Orch : low: the bridge is down")).length).toBe(1)
  expect(texts(await render()).some(t => t.startsWith('not delivered: the bridge is down'))).toBe(true)
})

test('every letter picked answers with its own letter', async () => {
  const asked = ['phase 3', 'phase 4', 'phase 5'].map((blocks, i) =>
    entry('Orch : low', `2026-10-18T10:0${i + 3}:00.000Z`, { session: 'low', blocks, choices: CHOICES }))
  const { sent, render, stored } = await askingPane(asked)
  for (const letter of ['A', 'B', 'C']) await pick(await render(), letter)
  expect(asked.map(e => stored(e.id).answer!.text)).toEqual(CHOICES.map(c => `${c.letter} : ${c.text}`))
  expect(sent.length).toBe(3)
})

test('a second pick while the answer is in flight, or after it, writes and sends nothing more', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES })
  const { fx, sent, render, stored } = await askingPane([asked])
  const drawn = await render()
  const writes = () => fx.ran.filter(r => r.startsWith('mv -f') && r.endsWith(`${ROUND}/${asked.id}.json`)).length
  await Promise.all([pick(drawn, 'A'), pick(drawn, 'A')])
  await pick(drawn, 'A')
  expect(stored(asked.id).status).toBe('answered')
  expect(writes()).toBe(1)
  expect(sent.length).toBe(1)
})

test('the question\'s body is drawn without its emphasis markers, its stored text verbatim', async () => {
  const question = 'Question 1 of 1 — **merge** it?\n_Context._ The __review__ is *green*, see `pr-219` and snake_case_name.\n* a list item'
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', question })
  const { render, stored } = await askingPane([asked])
  expect(texts(await render())).toContain('Question 1 of 1 — merge it?\nContext. The review is green, see pr-219 and snake_case_name.\n* a list item')
  expect(stored(asked.id).question).toBe(question)
})

test('a question without choices never hides one that has them, and the count is the total', () => {
  const entries = [
    entry('Orch : a', '2026-10-18T10:01:00.000Z', { blocks: 'the note' }),
    entry('Orch : b', '2026-10-18T10:02:00.000Z', { choices: CHOICES, recommendation: 'B', blocks: 'the merge' }),
    entry('Orch : c', '2026-10-18T10:03:00.000Z', { blocks: 'the other note' }),
  ]
  const lines = roundLines(entries)
  expect(lines[0]).toEqual({ letter: null, text: 'Question 1 of 3 — from Orch : b — blocks: the merge', bold: false })
  expect(lines.map(l => l.letter)).toEqual([null, 'A', 'B', 'C'])
  // Without any choiced entry, the round's own order.
  expect(roundLines(entries.filter(e => e.choices.length === 0))[0].text).toContain('from Orch : a')
})

// --- the selector ---------------------------------------------------------------------------

const input = (tree: any) => findAll(tree, n => n.type === 'Input')[0]

test('where the surface draws a picker the choices are one Select, its whole texts drawn above it, and no choice is a Button a click or a stray letter presses', async () => {
  // A focused pane taller than its body scrolls on the arrows (the reference's Pane.isFocused:
  // « the arrows scroll »), so a ring of choice Buttons could not be walked there, and a click
  // on one answered. A Select holds the arrows while it has the ring; a click only gives it.
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  const { render } = await askingPane([asked])
  const tree = await render()
  expect(findAll(tree, n => n.type === 'Button').length).toBe(0)
  expect(findAll(tree, n => n.props?.hotkey !== undefined)).toEqual([])
  expect(findAll(tree, n => n.type === 'Select').length).toBe(1)
  expect(picker(tree).props).toMatchObject({
    key: `choices:${asked.id}`,
    value: 'B',
    autoFocus: true,
    options: [
      { value: 'A', label: 'A  merge it now — the release goes out today' },
      { value: 'B', label: 'B  wait for the next review — a day lost  (recommended)' },
      { value: 'C', label: 'C  close it — the work is dropped' },
      { value: 'other', label: 'Other answer: type it below' },
    ],
  })
  // A picker's option is one line cut at the pane's width: each text is drawn whole above it,
  // the recommended one in its own look.
  const lines = findAll(tree, n => n.type === 'Text' && /^[A-C]  /.test(String(n.props.children)))
  expect(lines.map(n => [n.props.children, n.props.bold === true, n.props.color])).toEqual([
    ['A  merge it now — the release goes out today', false, undefined],
    ['B  wait for the next review — a day lost  (recommended)', true, 'success'],
    ['C  close it — the work is dropped', false, undefined],
  ])
})

test('where the pane has no picker (mobile) each choice is one Button carrying its full text, hotkey its lowercase letter', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  const { sent, render, stored } = await askingPane([asked], { surface: 'mobile' })
  const tree = await render()
  expect(picker(tree)).toBeUndefined()
  const buttons = findAll(tree, n => n.type === 'Button' && String(n.props.key).startsWith('choice:'))
  expect(buttons.map(n => [n.props.key, n.props.label, n.props.hotkey])).toEqual([
    ['choice:A', 'A  merge it now — the release goes out today', 'a'],
    ['choice:B', 'B  wait for the next review — a day lost  (recommended)', 'b'],
    ['choice:C', 'C  close it — the work is dropped', 'c'],
  ])
  expect(findAll(tree, n => n.type === 'Box' && n.props.flexWrap === 'wrap')).toEqual([])
  expect(findAll(tree, n => n.type === 'Button' && n.props.label === 'B').length).toBe(0)
  // The recommended choice keeps its look inside its Button.
  expect(findAll(button(tree, 'choice:B'), n => n.type === 'Text').map(n => [n.props.bold, n.props.color])).toEqual([[true, 'success']])
  await button(tree, 'choice:B').props.onPress()
  expect(stored(asked.id).answer!.text).toBe('B : wait for the next review — a day lost')
  expect(sent.length).toBe(1)
})

test('picking Other answer moves the ring to the text field and answers nothing', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  const { fx, sent, render, stored } = await askingPane([asked])
  const tree = await render()
  fx.focused.length = 0
  await pick(tree, 'other')
  expect(fx.focused).toEqual([{ requestId: 'supervision', key: input(await render()).props.key }])
  expect(stored(asked.id).status).toBe('open')
  expect(sent).toEqual([])
})

test('where the surface draws a picker the text field is drawn only once Other answer is picked, so Tab reaches no field before', async () => {
  // The operator's order: text is typed only once the free-text row is selected. A field drawn
  // beside the picker is a stop of the pane's ring, which Tab reaches from a choice.
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  const { fx, render } = await askingPane([asked])
  const tree = await render()
  expect(input(tree)).toBeUndefined()
  fx.invalidated.length = 0
  await pick(tree, 'other')
  expect(fx.invalidated).toContain('ui.render')
  expect(input(await render()).props).toMatchObject({ key: `answer:${asked.id}`, label: 'Other answer' })
})

test('the ring leaving the text field, back to the picker or off the pane, takes the field away until Other answer is picked again', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  const { fx, render, ring } = await askingPane([asked])
  await pick(await render(), 'other')
  await ring(`answer:${asked.id}`)
  expect(input(await render())).toBeDefined()
  fx.invalidated.length = 0
  await ring(`choices:${asked.id}`)
  expect(fx.invalidated).toContain('ui.render')
  expect(input(await render())).toBeUndefined()
  await pick(await render(), 'other')
  expect(input(await render())).toBeDefined()
  await ring()
  expect(input(await render())).toBeUndefined()
})

test('the first draw of an entry requests the focus on its picker and brings it into view once drawn, a redraw nothing more', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  const { fx, render } = await askingPane([asked])
  const tree = await render()
  expect(fx.focused).toEqual([{ requestId: 'supervision', key: `choices:${asked.id}` }])
  // The scroll names the picker by its key, which the engine knows once the draw has landed.
  expect(fx.scrolled).toEqual([])
  for (const timer of fx.later) timer.fn()
  expect(fx.scrolled).toEqual([{ to: { key: `choices:${asked.id}` }, in: 'supervision' }])
  await render()
  for (const timer of fx.later) timer.fn()
  expect(fx.focused.length).toBe(1)
  expect(fx.later.length).toBe(1)
  // For a pane that does not hold the keys yet, the ring starts on the same picker.
  expect(picker(tree).props.autoFocus).toBe(true)
})

test('without a recommendation the picker starts on the first choice, and a new entry asks the focus again', async () => {
  const first = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES })
  const second = entry('Orch : low', '2026-10-18T10:05:00.000Z', { session: 'low', blocks: 'phase 4', choices: CHOICES, recommendation: 'C' })
  const { fx, render } = await askingPane([first, second])
  const tree = await render()
  expect(fx.focused).toEqual([{ requestId: 'supervision', key: `choices:${first.id}` }])
  expect(picker(tree).props.value).toBe('A')
  await pick(tree, 'A')
  const next = await render()
  expect(picker(next).props).toMatchObject({ key: `choices:${second.id}`, value: 'C' })
  expect(fx.focused).toEqual([{ requestId: 'supervision', key: `choices:${first.id}` }, { requestId: 'supervision', key: `choices:${second.id}` }])
})

test('a refused or failing focus or scroll request never blocks the draw', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES })
  const { fx, render } = await askingPane([asked])
  fx.dollar.ui.focus = async () => { throw new Error('refused') }
  fx.dollar.ui.scroll = () => { throw new Error('refused') }
  expect(picker(await render())).toBeDefined()
  for (const timer of fx.later) timer.fn()
})

test('the Other answer field comes last, labelled, and replaces the in-session Button', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  const { render } = await askingPane([asked])
  await pick(await render(), 'other')
  const tree = await render()
  expect(input(tree).props).toMatchObject({ label: 'Other answer' })
  expect(typeof input(tree).props.submitLabel).toBe('string')
  expect(button(tree, 'other')).toBeUndefined()
  expect(JSON.stringify(tree)).not.toContain('in the session')
  const kids = tree.props.children[2].props.children
  expect(kids[kids.length - 2]).toBe(input(tree))
  expect(kids[kids.length - 1].props.dimColor).toBe(true)
})

test('the footer says how keys reach the selector, and names no letter where none answers', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES })
  const { render } = await askingPane([asked])
  const footer = texts(await render()).at(-1)!
  for (const part of ['ctrl+x tab', 'a click', 'arrows', 'Enter', 'Esc']) expect(footer).toContain(part)
  expect(footer).not.toContain('a letter')
  const mobile = await askingPane([asked], { surface: 'mobile' })
  const tapped = texts(await mobile.render()).at(-1)!
  for (const part of ['ctrl+x tab', 'arrows or Tab', 'Enter', 'a letter', 'Esc']) expect(tapped).toContain(part)
})

test('a submitted text answers the entry from the pane and is sent to its sender', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  const next = entry('Orch : low', '2026-10-18T10:05:00.000Z', { session: 'low', blocks: 'phase 4', question: 'Rename it?' })
  const { fx, sent, render, stored } = await askingPane([asked, next])
  await pick(await render(), 'other')
  await input(await render()).props.onSubmit('  some text  ')
  const answered = stored(asked.id)
  expect(answered.status).toBe('answered')
  expect(answered.answer).toEqual({ text: 'some text', by: 'pane', at: answered.answer!.at })
  expect(sent).toEqual([{
    to: 'Orch : low',
    text: `[module] The operator answered from the coordinator's pane at ${answered.answer!.at} — some text (question since 2026-10-18T10:03:00.000Z, blocks: phase 3)`,
  }])
  expect([...fx.files.keys()].some(p => p.includes('.tmp-'))).toBe(false)
  expect(texts(await render())).toContain('Rename it?')
})

test('an empty or blank submit writes and sends nothing', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES })
  const { fx, sent, render, stored } = await askingPane([asked])
  const before = fx.files.get(`${ROUND}/${asked.id}.json`)
  await pick(await render(), 'other')
  const field = input(await render())
  await field.props.onSubmit('')
  await field.props.onSubmit('  \n ')
  expect(fx.files.get(`${ROUND}/${asked.id}.json`)).toBe(before)
  expect(stored(asked.id).status).toBe('open')
  expect(sent).toEqual([])
})

test('a submitted text not delivered keeps the entry answered and leaves its notice', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES })
  const { fx, render, stored } = await askingPane([asked], { refuse: 'nobody by that name' })
  await pick(await render(), 'other')
  await input(await render()).props.onSubmit('some text')
  expect(stored(asked.id).status).toBe('answered')
  expect(fx.written.filter(l => l.includes("round: the pane's answer was not delivered to Orch : low: nobody by that name")).length).toBe(1)
  expect(texts(await render()).some(t => t.startsWith('not delivered: nobody by that name'))).toBe(true)
})

test('a submit on an entry settled meanwhile writes and sends nothing', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES })
  const { fx, sent, render, stored } = await askingPane([asked])
  await pick(await render(), 'other')
  const drawn = await render()
  fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify({ ...asked, status: 'closed' }) + '\n')
  await input(drawn).props.onSubmit('some text')
  expect(stored(asked.id).status).toBe('closed')
  expect(sent).toEqual([])
})

test('where the pane has no field (mobile) the in-session Button and its line stay, and no Input is drawn', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  const { fx, sent, render } = await askingPane([asked], { surface: 'mobile' })
  const tree = await render()
  expect(input(tree)).toBeUndefined()
  expect(button(tree, 'other').props).toMatchObject({ label: 'Other answer: in the session', hotkey: 'o' })
  const before = fx.files.get(`${ROUND}/${asked.id}.json`)
  await button(tree, 'other').props.onPress()
  expect(fx.files.get(`${ROUND}/${asked.id}.json`)).toBe(before)
  expect(sent).toEqual([])
  expect(fx.invalidated).toContain('ui.render')
  expect(texts(await render())).toContain("type your answer in this tab, or in Orch : low's tab")
})

// --- the pane as the coordinator's round reads it, and the wake of a due question ------------

const PANE_FILE = `${HOME}/.claude/claude-orchestrator/pane.json`
const endEvent = { sessionId: 's-one', reason: 'exit' }

test('the coordinator\'s pane, once open, is recorded for coordinator.sh round, and every close removes the record', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  await handlers['command.run'](fx.dollar, supervisionRun)
  const record = JSON.parse(String(fx.files.get(PANE_FILE)))
  expect([record.session, record.pid, Number.isFinite(Date.parse(record.at))]).toEqual(['s-one', '501', true])
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(fx.files.has(PANE_FILE)).toBe(false)
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(fx.files.has(PANE_FILE)).toBe(true)
  await handlers['ui.close'](fx.dollar, { id: 'supervision', origin: { kind: 'person' } }, (x: unknown) => x)
  expect(fx.files.has(PANE_FILE)).toBe(false)
  await handlers['command.run'](fx.dollar, supervisionRun)
  await handlers['session.end'](fx.dollar, endEvent, (x: unknown) => x)
  expect(fx.files.has(PANE_FILE)).toBe(false)
  expect([...fx.files.keys()].some(p => p.includes('.tmp-'))).toBe(false)
})

test('the pane opened by itself at the first turn is recorded too; an orchestrator\'s pane and another session\'s record are left alone', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(JSON.parse(String(fx.files.get(PANE_FILE))).session).toBe('s-one')
  const other = JSON.stringify({ session: 's-two', pid: '777', at: '2026-10-24T10:00:00.000Z' }) + '\n'
  fx.files.set(PANE_FILE, other)
  await handlers['session.end'](fx.dollar, endEvent, (x: unknown) => x)
  expect(fx.files.get(PANE_FILE)).toBe(other)
  const orch = fakeDollar({ launchName: 'Orch : belt' })
  await mounted(registerSupervision).handlers['command.run'](orch.dollar, supervisionRun)
  expect(orch.files.has(PANE_FILE)).toBe(false)
})

const minutesAgo = (n: number) => new Date(Date.now() - n * 60000).toISOString()

// A coordinator whose round holds `asked`, each sender live, its pane open by its first turn,
// or closed by the command before it: the wake's clock is armed by the turn's end.
async function wakingCoordinator(asked: RoundEntry[], over: { paneClosed?: boolean } = {}) {
  const fx = coordinatorSession()
  for (const e of asked) {
    fx.files.set(`${ROUND}/${e.id}.json`, JSON.stringify(e) + '\n')
    fx.files.set(`${SESSIONS}/${e.session}`, JSON.stringify(row({ role: 'orchestrator', name: e.from })) + '\n')
  }
  const { handlers } = mounted(registerSupervision)
  if (over.paneClosed) {
    await handlers['command.run'](fx.dollar, supervisionRun)
    await handlers['command.run'](fx.dollar, supervisionRun)
  }
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  const tick = async () => {
    const armed = fx.later.filter(t => t.ms === 30000)
    await armed[armed.length - 1].fn()
  }
  return { fx, handlers, tick }
}

test('a due question wakes the coordinator once: urgent at once, otherwise at 15 minutes in the pane, never one answered', async () => {
  const urgent = entry('Orch : a', minutesAgo(1), { session: 'sa', urgent: true })
  const old = entry('Orch : b', minutesAgo(16), { session: 'sb' })
  const young = entry('Orch : c', minutesAgo(14), { session: 'sc' })
  const answered = entry('Orch : d', minutesAgo(30), { session: 'sd', status: 'answered', urgent: true })
  const done = entry('Orch : e', minutesAgo(30), { session: 'se', kind: 'done', blocks: null })
  const { fx, handlers, tick } = await wakingCoordinator([urgent, old, young, answered, done])
  expect(fx.opened.length).toBe(1)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.later.filter(t => t.ms === 30000).length).toBe(1)
  await tick()
  expect(fx.submitted.length).toBe(1)
  for (const asked of [urgent, old]) expect(fx.submitted[0]).toContain(asked.from)
  for (const quiet of [young, answered, done]) expect(fx.submitted[0]).not.toContain(quiet.from)
  expect(fx.submitted[0]).toContain('coordinator.sh round')
  await tick()
  expect(fx.submitted.length).toBe(1)
  fx.files.set(`${ROUND}/${young.id}.json`, JSON.stringify({ ...young, since: minutesAgo(15) }) + '\n')
  await tick()
  expect(fx.submitted.length).toBe(2)
  expect(fx.submitted[1]).toContain(young.from)
  expect(fx.submitted[1]).not.toContain(old.from)
  // The host keeps the entries woken for: a reload of the module wakes for none of them again.
  const reloaded = mounted(registerSupervision).handlers
  await reloaded['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  await tick()
  expect(fx.submitted.length).toBe(2)
})

test('with the pane closed every open question is due at once; one answered in the pane before it is due wakes nothing', async () => {
  const fresh = entry('Orch : a', minutesAgo(1), { session: 'sa' })
  const { fx, tick } = await wakingCoordinator([fresh], { paneClosed: true })
  expect(fx.files.has(PANE_FILE)).toBe(false)
  await tick()
  expect(fx.submitted.length).toBe(1)
  expect(fx.submitted[0]).toContain(fresh.from)
  // One fixed start: the entry's id carries its minute, and two readings of the clock may straddle one.
  const asked = entry('Orch : b', '2026-10-24T11:59:00.000Z', { session: 'sb' })
  const quiet = await wakingCoordinator([asked])
  const settled = asked
  quiet.fx.files.set(`${ROUND}/${settled.id}.json`, JSON.stringify({ ...settled, since: minutesAgo(20), status: 'answered' }) + '\n')
  await quiet.tick()
  expect(quiet.fx.submitted).toEqual([])
})

test('a question whose sender has ended wakes nothing, and a session that is no coordinator arms no wake', async () => {
  const fx = coordinatorSession()
  const gone = entry('Orch : gone', minutesAgo(30), { session: 'sg', urgent: true })
  fx.files.set(`${ROUND}/${gone.id}.json`, JSON.stringify(gone) + '\n')
  const { handlers } = mounted(registerSupervision)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  await fx.later.filter(t => t.ms === 30000)[0].fn()
  expect(fx.submitted).toEqual([])
  const orch = fakeDollar({ launchName: 'Orch : belt' })
  orch.files.set(`${SESSIONS}/s-one`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch : belt' })) + '\n')
  await mounted(registerSupervision).handlers['turn.complete'](orch.dollar, firstTurn, (x: unknown) => x)
  expect(orch.later.filter(t => t.ms === 30000)).toEqual([])
})

test('the pane opened at the first turn by a row that carries no pid records the pid its walk reads, never none', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(JSON.parse(String(fx.files.get(PANE_FILE))).pid).toBe('501')
})

test('a wake the host refuses or that fails is not recorded, and the next reading wakes for it', async () => {
  const urgent = entry('Orch : a', minutesAgo(1), { session: 'sa', urgent: true })
  const { fx, tick } = await wakingCoordinator([urgent])
  const submit = fx.dollar.prompt.submit
  fx.dollar.prompt.submit = async () => { throw new Error('the session is busy') }
  await tick()
  fx.dollar.prompt.submit = async () => ({ drop: 'refused' })
  await tick()
  expect(fx.submitted).toEqual([])
  fx.dollar.prompt.submit = submit
  await tick()
  expect(fx.submitted.length).toBe(1)
  await tick()
  expect(fx.submitted.length).toBe(1)
})

const WOKEN_FILE = `${HOME}/.claude/claude-orchestrator/round-woken.json`

test('a successor over the same state directory, its host state its own, wakes for nothing its predecessor was woken for', async () => {
  const urgent = entry('Orch : a', minutesAgo(1), { session: 'sa', urgent: true })
  const { fx, tick } = await wakingCoordinator([urgent])
  await tick()
  expect(fx.submitted.length).toBe(1)
  const next = coordinatorSession()
  for (const [path, text] of fx.files) next.files.set(path, text)
  await mounted(registerSupervision).handlers['turn.complete'](next.dollar, firstTurn, (x: unknown) => x)
  await next.later.filter(t => t.ms === 30000)[0].fn()
  expect(next.submitted).toEqual([])
})

test('an entry another session was woken for between the reading and the wake is not woken for again', async () => {
  const urgent = entry('Orch : a', minutesAgo(1), { session: 'sa', urgent: true })
  const { fx, tick } = await wakingCoordinator([urgent])
  const read = fx.dollar.fs.read
  let reads = 0
  fx.dollar.fs.read = async (p: string) => {
    // The first reading finds no entry woken for; another session records this one before the second.
    if (p === WOKEN_FILE && ++reads === 1) {
      fx.files.set(WOKEN_FILE, JSON.stringify([urgent.id]) + '\n')
      throw new Error(`ENOENT: ${p}`)
    }
    return read(p)
  }
  await tick()
  expect(reads).toBe(2)
  expect(fx.submitted).toEqual([])
})

test('a reload arms the wake with no turn after it; a second arm starts no second chain; the session\'s end stops it', async () => {
  const urgent = entry('Orch : a', minutesAgo(1), { session: 'sa', urgent: true })
  const fx = coordinatorSession()
  fx.files.set(`${ROUND}/${urgent.id}.json`, JSON.stringify(urgent) + '\n')
  fx.files.set(`${SESSIONS}/sa`, JSON.stringify(row({ role: 'orchestrator', name: urgent.from })) + '\n')
  const { handlers } = mounted(registerSupervision)
  const start = mounted(registerWake).handlers
  const wakes = () => fx.later.filter(t => t.ms === 30000)
  expect(await start['session.start'](fx.dollar, startEvent, (x: unknown) => x)).toBe(startEvent)
  expect(wakes().length).toBe(1)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  await start['session.start'](fx.dollar, startEvent, (x: unknown) => x)
  expect(wakes().length).toBe(1)
  await wakes()[0].fn()
  expect([fx.submitted.length, wakes().length]).toEqual([1, 2])
  // A reading already fired, run again, is no chain of its own: it arms nothing.
  await wakes()[0].fn()
  expect(wakes().length).toBe(2)
  await handlers['session.end'](fx.dollar, endEvent, (x: unknown) => x)
  expect(wakes()[1].cancelled).toBe(true)
  await wakes()[1].fn()
  expect(wakes().length).toBe(2)
  // No coordinator, no wake at the start.
  const orch = fakeDollar({ launchName: 'Orch : belt' })
  await mounted(registerWake).handlers['session.start'](orch.dollar, startEvent, (x: unknown) => x)
  expect(orch.later.filter(t => t.ms === 30000)).toEqual([])
})

test('a pane record whose pid is not running, or that names none, is no pane; another session\'s live one is', async () => {
  const young = entry('Orch : a', minutesAgo(1), { session: 'sa' })
  for (const record of [{ session: 's-one', pid: '999' }, { session: 's-one' }, { session: 's-one', pid: null }]) {
    const { fx, tick } = await wakingCoordinator([young])
    fx.files.set(PANE_FILE, JSON.stringify({ ...record, at: '2026-10-24T10:00:00.000Z' }) + '\n')
    await tick()
    expect(fx.submitted.length).toBe(1)
  }
  const { fx, tick } = await wakingCoordinator([young])
  fx.files.set(PANE_FILE, JSON.stringify({ session: 's-two', pid: '777', at: '2026-10-24T10:00:00.000Z' }) + '\n')
  await tick()
  expect(fx.submitted).toEqual([])
})
