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
import { agentPaneRows, paneRows, readRound, roundLines, scrollTrack, wrapWords, register as registerSupervision, registerWake, registerPaneTool, SUPERVISION_TOOL, PANE_MAIN_THREAD_ONLY, type SessionRow } from '../supervision.ts'
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
  tools: { name: string; isDeferred?: boolean; inputSchema?: unknown }[]
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
  // The tools the module registered at a start.
  const tools: { name: string; isDeferred?: boolean; inputSchema?: unknown }[] = []
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
    tool: { register: async (spec: { name: string }) => { tools.push(spec) } },
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
  return { dollar, files, ran, written, opened, closed, env, timers, invalidated, focused, scrolled, later, state, submitted, tools }
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

// Every command.run registration, in order: the supervision answers to two commands.
function commandRuns(register: (on: any) => void): { matcher: object | undefined; handler: Function }[] {
  const runs: { matcher: object | undefined; handler: Function }[] = []
  register((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    if (args[0] === 'command.run') runs.push({ matcher: args.length === 3 ? args[1] : undefined, handler: args[args.length - 1] as Function })
    return { catch: () => undefined }
  })
  return runs
}

// Measured live: the host hands a command carrying `name: <short>` to the hook as
// `<plugin>:<short>`, typed as `/<short>`, `/<plugin>:<file>` or `/<plugin>:<short>` alike;
// the file's own stem never reaches the matcher.
test('the supervision answers to its two short names, one pane whichever was typed', async () => {
  const runs = commandRuns(registerSupervision)
  expect(runs.map(run => run.matcher)).toEqual([
    { command: 'orchestrator:orchestrator-supervision' },
    { command: 'orchestrator:coordinator-supervision' },
  ])
  const [orchestratorForm, coordinatorForm] = runs.map(run => run.handler)
  for (const [opener, closer] of [[orchestratorForm, coordinatorForm], [coordinatorForm, orchestratorForm]]) {
    const coord = fakeDollar({ launchName: 'Coord : main' })
    expect((await opener(coord.dollar, { command: 'orchestrator:orchestrator-supervision', args: '' })).text).toContain('pane opened')
    expect(await closer(coord.dollar, { command: 'orchestrator:coordinator-supervision', args: '' })).toEqual({ text: 'Supervision pane closed.' })
    expect(coord.opened.length).toBe(1)
    expect(coord.closed).toEqual([{ id: 'supervision' }])
  }
})

test('/orchestrator-supervision opens the pane in a coordinator or an orchestrator session alone', async () => {
  const { handlers, matchers } = mounted(registerSupervision)
  expect(matchers['ui.render']).toEqual({ component: 'Pane', requestId: 'supervision' })
  const run = { command: 'orchestrator:orchestrator-supervision', args: '' }

  const coord = fakeDollar({ launchName: 'Coord : main' })
  expect(await handlers['command.run'](coord.dollar, run)).toEqual({ text: 'Supervision pane opened; type /coordinator-supervision again, or click its ✕, to close it.' })
  expect(coord.opened).toEqual([{ id: 'supervision', title: 'Orchestrators', focus: true }])
  // Typed again, the command closes the pane it opened.
  expect(await handlers['command.run'](coord.dollar, run)).toEqual({ text: 'Supervision pane closed.' })
  expect(coord.closed).toEqual([{ id: 'supervision' }])
  expect(coord.opened.length).toBe(1)

  const orch = fakeDollar({ launchName: 'Orch : phase-3' })
  expect(await handlers['command.run'](orch.dollar, run)).toEqual({ text: 'Supervision pane opened; type /orchestrator-supervision again, or click its ✕, to close it.' })
  expect(orch.opened).toEqual([{ id: 'supervision', title: 'Agents', focus: true }])

  for (const launchName of ['Agent : belt-p3', 'Audit : belt', null]) {
    const fx = fakeDollar({ launchName })
    const answer = await handlers['command.run'](fx.dollar, run)
    expect(answer.text).toContain('coordinator session (« Coord : … »), listing the orchestrators, or in an orchestrator session')
    expect(answer.text).toContain('/orchestrator-status lists the sessions here')
    expect(fx.opened).toEqual([])
  }
})

// --- the tool on the operator's plain words ---------------------------------------------------

const toolCall = (action: string, over: object = {}) => ({ tool: `mcp__orchestrator__${SUPERVISION_TOOL}`, action, ...over })

test('the supervision tool is registered at every start, loaded with its schema, and opens nothing', async () => {
  const { handlers } = mounted(registerPaneTool)
  for (const launchName of ['Coord : main', 'Agent : belt-p3']) {
    const fx = fakeDollar({ launchName })
    await handlers['session.start'](fx.dollar, startEvent, (x: unknown) => x)
    expect(fx.tools.map(spec => [spec.name, spec.isDeferred])).toEqual([['supervision', false]])
    expect(JSON.stringify(fx.tools[0].inputSchema)).toContain('"enum":["open","close"]')
    expect(fx.opened).toEqual([])
  }
  const { matchers } = mounted(registerSupervision)
  expect(matchers['tool.call']).toEqual({ tool: 'mcp__orchestrator__supervision' })
})

test('the supervision tool opens and closes the pane the commands toggle, by the word it is given', async () => {
  const { handlers } = mounted(registerSupervision)
  for (const [launchName, title] of [['Coord : main', 'Orchestrators'], ['Orch : phase-3', 'Agents']]) {
    const fx = fakeDollar({ launchName })
    expect(await handlers['tool.call'](fx.dollar, toolCall('close'))).toEqual({ result: 'The supervision pane is not open.' })
    expect(await handlers['tool.call'](fx.dollar, toolCall('open'))).toEqual({ result: 'Supervision pane opened.' })
    expect(fx.opened).toEqual([{ id: 'supervision', title, focus: true }])
    // Not a toggle: open again leaves it open.
    expect(await handlers['tool.call'](fx.dollar, toolCall('open'))).toEqual({ result: 'The supervision pane is already open.' })
    expect(fx.opened.length).toBe(1)
    expect(await handlers['tool.call'](fx.dollar, toolCall('close'))).toEqual({ result: 'Supervision pane closed.' })
    expect(fx.closed).toEqual([{ id: 'supervision' }])
    // The pane is his from then on, as after the command.
    expect(fx.state.get('orchestrator/paneOpened')).toBe(true)
  }
  // One pane: opened by the tool, the command closes it, and the reverse.
  const fx = fakeDollar({ launchName: 'Coord : main' })
  await handlers['tool.call'](fx.dollar, toolCall('open'))
  expect(await handlers['command.run'](fx.dollar, supervisionRun)).toEqual({ text: 'Supervision pane closed.' })
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(await handlers['tool.call'](fx.dollar, toolCall('close'))).toEqual({ result: 'Supervision pane closed.' })
  expect(fx.opened.length).toBe(2)
  expect(fx.closed.length).toBe(2)
})

test('the supervision tool is refused to a subagent, outside the two roles, and on any other word', async () => {
  const { handlers } = mounted(registerSupervision)
  const coord = fakeDollar({ launchName: 'Coord : main' })
  expect(await handlers['tool.call'](coord.dollar, toolCall('open', { agentId: 'a-1' }))).toEqual({ result: PANE_MAIN_THREAD_ONLY, isError: true })
  expect(await handlers['tool.call'](coord.dollar, toolCall('toggle'))).toEqual({ result: 'action is "open" or "close"', isError: true })
  expect(coord.opened).toEqual([])
  for (const launchName of ['Agent : belt-p3', 'Audit : belt', null]) {
    const fx = fakeDollar({ launchName })
    const answer = await handlers['tool.call'](fx.dollar, toolCall('open'))
    expect(answer.isError).toBe(true)
    expect(answer.result).toContain('a coordinator session (« Coord : … ») or an orchestrator session (« Orch : … ») alone')
    expect(fx.opened).toEqual([])
    expect(fx.state.get('orchestrator/paneOpened')).toBeUndefined()
  }
})

test('the supervision tool says when the host holds the pane undrawn', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = fakeDollar({ launchName: 'Orch : phase-3' })
  fx.dollar.ui.open = async (pane: { id: string }) => {
    fx.opened.push(pane)
    return { isPlaced: false, reason: 'no-surface' }
  }
  expect(await handlers['tool.call'](fx.dollar, toolCall('open'))).toEqual({ result: 'Supervision pane opened, not drawn yet: no-surface.' })
})

const renderEvent = { surface: 'terminal', component: 'Pane', requestId: 'supervision', props: {} }
const supervisionRun = { command: 'orchestrator:orchestrator-supervision', args: '' }

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
  expect(text).toContain('type /coordinator-supervision or /orchestrator-supervision to open the pane again')
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
    blocks: 'phase 3', question: '_Question_ : Merge it?', choices: [], recommendation: null, status: 'open', at: since, answer: null, ...over,
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
    { letter: null, text: 'Orch : a', bold: false },
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
    { letter: null, text: 'Orch : a', bold: false },
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
  const [round, , rows] = tree.props.children
  expect(JSON.stringify(rows)).toContain('Orch : low')
  expect(round.type).toBe('Box')
  expect(round.props.marginBottom).toBe(1)
  const kids = round.props.children
  expect(kids.slice(1, 3).map((t: any) => [t.props.children, t.props.bold === true])).toEqual([
    ['Orch : low', true],
    ['Question : Merge it?', false],
  ])
  const drawn = (t: any): string => t.type === 'Text' ? `Text ${t.props.children}` : t.type === 'Box' ? t.props.children.map(drawn).join(' | ') : `${t.type} ${t.props.label}`
  expect(kids.slice(3).map(drawn)).toEqual([
    'Text A) merge it now — the release goes out today | Text B) wait for the next review — a day lost  (recommended) | Text C) close it — the work is dropped',
    'Select Choose',
    'Input Other answer',
  ])
  expect(texts(tree).at(-1)).toBe('ctrl+x tab or a click: give the pane the keys · arrows: move · Enter: choose · Esc: back to the prompt')
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
  expect(JSON.stringify(settledTree)).not.toContain('Merge it?')

  const orch = fakeDollar({ launchName: 'Orch : phase-3' })
  const asked = entry('Orch : phase-3', '2026-10-18T10:03:00.000Z')
  orch.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(asked) + '\n')
  expect(JSON.stringify(await coordinatorRender(orch))).not.toContain('pending')
})

test('the archive under the round is read by nothing: an open entry planted there is neither read nor drawn', async () => {
  const fx = fakeDollar({ launchName: 'Coord : main' })
  fx.files.set(`${SESSIONS}/live`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch : live', context_percent: 30 })) + '\n')
  const hidden = entry('Orch : live', '2026-10-18T10:03:00.000Z', { session: 'live' })
  fx.files.set(`${ROUND}/archive/${hidden.id}.json`, JSON.stringify(hidden) + '\n')
  expect(await readRound(fx.dollar)).toEqual([])
  expect(JSON.stringify(await coordinatorRender(fx))).not.toContain('pending')
  // The same entry directly under the round is drawn: only its place kept it out.
  const control = fakeDollar({ launchName: 'Coord : main' })
  control.files.set(`${SESSIONS}/live`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch : live', context_percent: 30 })) + '\n')
  control.files.set(`${ROUND}/${hidden.id}.json`, JSON.stringify(hidden) + '\n')
  expect((await readRound(control.dollar)).length).toBe(1)
  expect(JSON.stringify(await coordinatorRender(control))).toContain('Questions for you — 1 pending')
})

test('a question whose sender has ended is not drawn, nor counted: only the live sessions\' questions are', async () => {
  const fx = fakeDollar({ launchName: 'Coord : main' })
  fx.files.set(`${SESSIONS}/live`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch : live', context_percent: 30 })) + '\n')
  const gone = entry('Orch : gone', '2026-10-18T10:01:00.000Z', { session: 'ended', blocks: 'the old merge' })
  const asked = entry('Orch : live', '2026-10-18T10:03:00.000Z', { session: 'live', choices: CHOICES, recommendation: 'B' })
  for (const e of [gone, asked]) fx.files.set(`${ROUND}/${e.id}.json`, JSON.stringify(e) + '\n')
  const [round] = (await coordinatorRender(fx)).props.children
  expect(round.props.children.slice(0, 2).map((t: any) => t.props.children)).toEqual(['Questions for you — 1 pending', 'Orch : live'])
  expect(JSON.stringify(round)).not.toContain('Orch : gone')
  // Every sender ended: nothing is drawn below the rows.
  fx.files.delete(`${SESSIONS}/live`)
  expect(JSON.stringify(await coordinatorRender(fx))).not.toContain('pending')
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
  expect(fx.opened).toEqual([{ id: 'supervision', title: 'Orchestrators', focus: true }])
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
  expect(fx.opened).toEqual([{ id: 'supervision', title: 'Orchestrators', focus: true }])
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
  expect(fx.opened).toEqual([{ id: 'supervision', title: 'Orchestrators', focus: true }])
  expect(fx.timers.length).toBe(1)
})

test('a coordinator recorded after the first turn: the pane opens at the first turn end that finds it', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession({ record: false })
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.opened).toEqual([])
  fx.files.set(RECORD, JSON.stringify({ name: 'Coord : main [abc]', tty: '/dev/ttys001' }))
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.opened).toEqual([{ id: 'supervision', title: 'Orchestrators', focus: true }])
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
  expect(pieces(tree.props.children[1])).toEqual([{ text: 'Orchestrators', bold: true }])
  const empty = await paneTree({})
  expect(pieces(empty.props.children[1])).toEqual([{ text: 'Orchestrators', bold: true }])
  expect(pieces(empty.props.children[2])).toEqual([{ text: 'no live orchestrator', bold: false }])
})

const text = (nodes: { text: string }[]) => nodes.map(p => p.text).join('')

test('a plain orchestrator is one line: a dot, its bold name, then its figures in the normal colour', async () => {
  const tree = await paneTree({ low: orch('Orch : low') })
  const block = tree.props.children[2]
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
  const block = tree.props.children[2]
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
  const line = tree.props.children[2].props.children[2]
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
  expect(pieces(tree.props.children[2].props.children[2])[1].text).toBe('unsaid')
})

test('a done orchestrator draws a success dot and one Status line in success, with no Blocks line', async () => {
  const tree = await paneTree({ d: orch('Orch : d', { waiting: 'done', waiting_since: SINCE }) })
  const block = tree.props.children[2]
  expect(block.props.children.length).toBe(2)
  expect(pieces(block.props.children[0])[0]).toEqual({ text: '●', color: 'success', bold: false })
  const [label, words] = pieces(block.props.children[1])
  expect(label.text).toBe('Status: ')
  expect(words.color).toBe('success')
  expect(words.text).toMatch(/^done since \d\d:\d\d, proposes to be closed$/)
})

test('a row past the gate draws its fill and gate words in the error colour, the rest in the normal colour', async () => {
  const tree = await paneTree({ hot: orch('Orch : hot', { context_percent: 85, context_tokens: 85000 }) })
  expect(pieces(tree.props.children[2].props.children[0]).slice(3)).toEqual([
    { text: ' · orchestrator · ', bold: false },
    { text: '85% past the gate', color: 'error', bold: false },
    { text: ' · 3m', bold: false },
  ])
})

test('a remote orchestrator keeps its machine in its line', async () => {
  const tree = await paneTree({ r: orch('Orch : r', { machine: 'mini' }) })
  expect(text(pieces(tree.props.children[2].props.children[0]))).toBe('● Orch : r · orchestrator · remote mini · 30% · 3m')
})

test('no empty line separates two blocks', async () => {
  const tree = await paneTree({ a: orch('Orch : a', { context_percent: 40 }), b: orch('Orch : b') })
  const [, , first, second] = tree.props.children
  expect(first.props.marginTop).toBeUndefined()
  expect(second.props.marginTop).toBeUndefined()
  expect(pieces(first.props.children[0])[2].text).toBe('Orch : a')
})

test('the orchestrator that asked the open question stands out: its whole line bold in suggestion, the others plain', async () => {
  const asked = entry('Orch : a', '2026-10-18T10:03:00.000Z', { session: 'a', choices: CHOICES, recommendation: 'B' })
  const tree = await paneTree({ a: orch('Orch : a', { context_percent: 40 }), b: orch('Orch : b') }, [asked])
  const [, , speaker, other] = tree.props.children
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
  const [, , first, second] = tree.props.children
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
  const line = pieces(tree.props.children[2].props.children[0])
  expect(line.map(p => p.text)).toEqual(['●', ' ', 'Orch : d', ' · orchestrator · ', '30%', ' · 3m'])
  expect(line.some(p => p.bold && p.color === 'suggestion')).toBe(false)
})

test('the questions section is titled in bold suggestion, with an open question styled', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  const tree = await paneTree({ low: orch('Orch : low') }, [asked])
  const section = tree.props.children[0]
  expect(section.props.marginBottom).toBe(1)
  const [title, header, body, list] = section.props.children
  const [a, b, c] = list.props.children
  expect(pieces(body)).toEqual([{ text: 'Question : Merge it?', bold: false }])
  expect(pieces(title)).toEqual([{ text: 'Questions for you — 1 pending', color: 'suggestion', bold: true }])
  expect(pieces(header)).toEqual([{ text: 'Orch : low', bold: true }])
  expect([a, b, c].map(choice => [choice.type, choice.props.children])).toEqual([
    ['Text', 'A) merge it now — the release goes out today'],
    ['Text', 'B) wait for the next review — a day lost  (recommended)'],
    ['Text', 'C) close it — the work is dropped'],
  ])
  expect(pieces(b)).toEqual([{ text: 'B) wait for the next review — a day lost  (recommended)', color: 'success', bold: true }])
  expect([a, c].map(choice => [choice.props.bold, choice.props.color])).toEqual([[undefined, undefined], [undefined, undefined]])
})

test('no question: the section says none, or counts the orchestrators waiting when the round holds none', async () => {
  const none = await paneTree({ low: orch('Orch : low') })
  expect(pieces(none.props.children[0])).toEqual([
    { text: 'Questions for you', color: 'suggestion', bold: true },
    { text: 'none', bold: false },
  ])
  const waits = { w1: orch('Orch : w1', { waiting: 'operator', waiting_since: SINCE }), w2: orch('Orch : w2', { waiting: 'operator', waiting_since: SINCE }), d: orch('Orch : d', { waiting: 'done', waiting_since: SINCE }) }
  const two = await paneTree(waits)
  expect(pieces(two.props.children[0])[1]).toEqual({ text: 'none in the pane — 2 orchestrators wait for you: ask the coordinator', bold: false })
  const one = await paneTree({ w1: waits.w1 })
  expect(pieces(one.props.children[0])[1].text).toBe('none in the pane — 1 orchestrator waits for you: ask the coordinator')
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
  const render = (props: object = {}) => handlers['ui.render'](fx.dollar, { ...renderEvent, props, surface: over.surface ?? 'terminal' }, (x: unknown) => ({ passed: x }))
  const stored = (id: string) => JSON.parse(String(fx.files.get(`${ROUND}/${id}.json`))) as RoundEntry
  // The pane's ring moved onto `element`, or off its elements when absent, by the operator.
  const ring = (element?: string) => handlers['ui.focus'](fx.dollar,
    { component: 'Pane', requestId: 'supervision', ...(element ? { plugin: 'orchestrator', element } : {}), origin: { kind: 'person' } },
    () => ({}))
  return { fx, sent, render, stored, ring, handlers }
}

const LONG = `Question 1 of 1 — ${'every word of the context the operator needs to decide. '.repeat(45)}`.slice(0, 2499).trimEnd().padEnd(2500, '.')

test('a 2,500-character question is drawn whole in the pane, above its choices', async () => {
  const question = `${LONG}\n- **A** : one\n- **B** : two\n_Recommendation_ : B`
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', question, choices: [{ letter: 'A', text: 'one' }, { letter: 'B', text: 'two' }], recommendation: 'B' })
  const { render } = await askingPane([asked])
  const drawn = texts(await render())
  expect(drawn).toContain(LONG)
  expect(drawn.some(t => t.includes('[cut at'))).toBe(false)
  expect(drawn.indexOf(LONG)).toBeGreaterThan(drawn.indexOf('Orch : low'))
  expect(drawn.indexOf('Orch : low')).toBeGreaterThan(-1)
})

test('a message without lettered choices shows its text and the Other answer field, no choice Button, never a bare blocks line', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', question: `_Question_ : ${LONG}` })
  const { render } = await askingPane([asked])
  const tree = await render()
  expect(texts(tree)).toContain(`Question : ${LONG}`)
  expect(input(tree).props).toMatchObject({ label: 'Other answer' })
  expect(findAll(tree, n => n.type === 'Button').length).toBe(0)
  expect(JSON.stringify(tree)).not.toContain('no lettered choices')
})

test('a pick of a choice answers the entry from the pane, sends the asking orchestrator the choice once, and draws the next question', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  const next = entry('Orch : low', '2026-10-18T10:05:00.000Z', { session: 'low', blocks: 'phase 4', question: '_Question_ : Rename it?' })
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
  expect(texts(after)).toContain('Questions for you — 1 pending')
  expect(texts(after)).toContain('Question : Rename it?')
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
  expect(texts(await render())).toContain('Questions for you — 1 pending')
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
  const question = '_Question_ : **merge** it?\n_Context_ : The __review__ is *green*, _really_, see `pr-219` and snake_case_name.\n* a list item'
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', question })
  const { render, stored } = await askingPane([asked])
  const drawn = texts(await render())
  expect(drawn).toContain('Question : merge it?')
  expect(drawn).toContain('Context : The review is green, really, see pr-219 and snake_case_name.\n* a list item')
  expect(stored(asked.id).question).toBe(question)
})

test('a question without choices never hides one that has them, and the count is the total', () => {
  const entries = [
    entry('Orch : a', '2026-10-18T10:01:00.000Z', { blocks: 'the note' }),
    entry('Orch : b', '2026-10-18T10:02:00.000Z', { choices: CHOICES, recommendation: 'B', blocks: 'the merge' }),
    entry('Orch : c', '2026-10-18T10:03:00.000Z', { blocks: 'the other note' }),
  ]
  const lines = roundLines(entries)
  expect(lines[0]).toEqual({ letter: null, text: 'Orch : b', bold: false })
  expect(lines.map(l => l.letter)).toEqual([null, 'A', 'B', 'C'])
  // Without any choiced entry, the round's own order.
  expect(roundLines(entries.filter(e => e.choices.length === 0))[0].text).toContain('Orch : a')
})

// A takeover report that asks nothing, ended on a wait for the operator: no labelled field, no choice.
const REPORT = 'Takeover done.\n\n| PR | state |\n|---|---|\n| speculoos#53 | ready |\n| speculoos#54 | ready |'
const BLOCKS = 'line 239 (merge of speculoos#53) and the next ready PRs'

test('a wait that asks nothing, no field and no choice, is no question: neither drawn under the questions nor counted, its row still shows what it blocks', async () => {
  const report = entry('Orch : w', '2026-10-18T10:03:00.000Z', { session: 'w', question: REPORT, blocks: BLOCKS })
  expect(roundLines([report])).toEqual([])
  const tree = await paneTree({ w: orch('Orch : w', { waiting: 'operator', waiting_since: SINCE, blocks: BLOCKS }) }, [report])
  const [section, , block] = tree.props.children
  expect(texts(section)).toEqual(['Questions for you', 'none in the pane — 1 orchestrator waits for you: ask the coordinator'])
  expect(JSON.stringify(tree)).not.toContain('Takeover done')
  expect(JSON.stringify(tree)).not.toContain('pending')
  const [, status, blocks] = block.props.children
  expect(pieces(status)[1].text).toMatch(/^waiting for the operator since \d\d:\d\d$/)
  expect(pieces(blocks)).toEqual([{ text: 'Blocks:', bold: false }, { text: BLOCKS, bold: false }])
})

test('a question in the old shape with lettered choices is still drawn and counted', async () => {
  const asked = entry('Orch : w', '2026-10-18T10:03:00.000Z', { session: 'w', question: 'Merge it?', choices: CHOICES, recommendation: 'B' })
  const tree = await paneTree({ w: orch('Orch : w') }, [asked])
  const drawn = texts(tree.props.children[0])
  expect(drawn.slice(0, 3)).toEqual(['Questions for you — 1 pending', 'Orch : w', 'Merge it?'])
})

test('a labelled question without choices is still drawn and counted, beside a wait that asks nothing', async () => {
  const open = entry('Orch : w', '2026-10-18T10:03:00.000Z', { session: 'w', question: '_Question_ : Rename it?' })
  const report = entry('Orch : w', '2026-10-18T10:05:00.000Z', { session: 'w', question: REPORT, blocks: BLOCKS })
  expect(roundLines([report, open])).toEqual([{ letter: null, text: 'Orch : w', bold: false }])
  const drawn = texts((await paneTree({ w: orch('Orch : w') }, [open, report])).props.children[0])
  expect(drawn.slice(0, 3)).toEqual(['Questions for you — 1 pending', 'Orch : w', 'Question : Rename it?'])
  expect(drawn.join('\n')).not.toContain('Takeover done')
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
      { value: 'A', label: 'A' },
      { value: 'B', label: 'B (recommended)' },
      { value: 'C', label: 'C' },
      { value: 'other', label: 'Other answer: type it below' },
    ],
  })
  // A picker's option is one line cut at the pane's width: each text is drawn whole above it,
  // the recommended one in its own look.
  const lines = findAll(tree, n => n.type === 'Text' && /^[A-C]\) /.test(String(n.props.children)))
  expect(lines.map(n => [n.props.children, n.props.bold === true, n.props.color])).toEqual([
    ['A) merge it now — the release goes out today', false, undefined],
    ['B) wait for the next review — a day lost  (recommended)', true, 'success'],
    ['C) close it — the work is dropped', false, undefined],
  ])
})

test('where the pane has no picker (mobile) each choice is one Button carrying its full text, hotkey its lowercase letter', async () => {
  const asked = entry('Orch : low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })
  const { sent, render, stored } = await askingPane([asked], { surface: 'mobile' })
  const tree = await render()
  expect(picker(tree)).toBeUndefined()
  const buttons = findAll(tree, n => n.type === 'Button' && String(n.props.key).startsWith('choice:'))
  expect(buttons.map(n => [n.props.key, n.props.label, n.props.hotkey])).toEqual([
    ['choice:A', 'A) merge it now — the release goes out today', 'a'],
    ['choice:B', 'B) wait for the next review — a day lost  (recommended)', 'b'],
    ['choice:C', 'C) close it — the work is dropped', 'c'],
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
  const kids = tree.props.children[0].props.children
  expect(kids[kids.length - 1]).toBe(input(tree))
  const keys = tree.props.children.at(-1)
  expect(keys.props.children).toContain('Enter: choose')
  expect(keys.props.dimColor).toBeUndefined()
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
  const next = entry('Orch : low', '2026-10-18T10:05:00.000Z', { session: 'low', blocks: 'phase 4', question: '_Question_ : Rename it?' })
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
  expect(texts(await render())).toContain('Question : Rename it?')
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

test('a due question wakes the coordinator once: with the pane open only an urgent one, however old the others, never one answered', async () => {
  const urgent = entry('Orch : a', minutesAgo(1), { session: 'sa', urgent: true })
  const old = entry('Orch : b', minutesAgo(90), { session: 'sb' })
  const young = entry('Orch : c', minutesAgo(1), { session: 'sc' })
  const answered = entry('Orch : d', minutesAgo(30), { session: 'sd', status: 'answered', urgent: true })
  const done = entry('Orch : e', minutesAgo(30), { session: 'se', kind: 'done', blocks: null })
  const { fx, handlers, tick } = await wakingCoordinator([urgent, old, young, answered, done])
  expect(fx.opened.length).toBe(1)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.later.filter(t => t.ms === 30000).length).toBe(1)
  await tick()
  expect(fx.submitted.length).toBe(1)
  expect(fx.submitted[0]).toContain(urgent.from)
  for (const quiet of [old, young, answered, done]) expect(fx.submitted[0]).not.toContain(quiet.from)
  expect(fx.submitted[0]).toContain('coordinator.sh round')
  await tick()
  expect(fx.submitted.length).toBe(1)
  // A plain wait asked again urgent, on the same id, is due at the next reading.
  fx.files.set(`${ROUND}/${young.id}.json`, JSON.stringify({ ...young, urgent: true }) + '\n')
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

test('questions recorded while no pane is open, one already presented in the tab, are all drawn when the pane opens', async () => {
  const presented = entry('Orch : a', minutesAgo(5), { session: 'sa', question: '_Question_ : Ship the first?', choices: CHOICES })
  const { fx, handlers, tick } = await wakingCoordinator([presented], { paneClosed: true })
  await tick()
  expect(fx.submitted.length).toBe(1)
  expect(fx.submitted[0]).toContain(presented.from)
  const later = entry('Orch : b', minutesAgo(1), { session: 'sb', question: '_Question_ : Ship the second?' })
  fx.files.set(`${ROUND}/${later.id}.json`, JSON.stringify(later) + '\n')
  fx.files.set(`${SESSIONS}/${later.session}`, JSON.stringify(row({ role: 'orchestrator', name: later.from })) + '\n')
  expect(fx.files.has(PANE_FILE)).toBe(false)
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(fx.files.has(PANE_FILE)).toBe(true)
  const tree = await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x }))
  expect(tree.props.children[0].props.children[0].props.children).toBe('Questions for you — 2 pending')
  expect(JSON.stringify(tree)).toContain('Ship the first?')
  expect(JSON.parse(String(fx.files.get(`${ROUND}/${presented.id}.json`))).status).toBe('open')
  // The pane draws one question at a time: answering the first brings the never-presented one.
  await pick(tree, 'A')
  const next = await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x }))
  expect(JSON.stringify(next)).toContain('Questions for you — 1 pending')
  expect(JSON.stringify(next)).toContain('Ship the second?')
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

// --- one readable block -----------------------------------------------------------------------

// A question in the decide shape, the previous answer's record above it and the closing line
// below: the pane keeps the fields alone.
const SHAPED = [
  'Recorded: B, the wave goes on.',
  '',
  '**Question 5 of 6**',
  '_Subject_ : the numbering of the pane\'s questions',
  '_Context_ : the pane shows « 1 of 1 » and « 5 of 6 ».',
  '_Question_ : which one stays?',
  '_Choices_ :',
  '- **A** : the orchestrator\'s — it follows its wave',
  '- **B** : the pane\'s — it counts the queue',
  '_Recommendation of the orchestrator_ : A — one numbering, its own',
  '',
  'You decide: A or B?',
].join('\n')
const shapedEntry = (over: Partial<RoundEntry> = {}) => entry('Orch : low', '2026-10-18T10:03:00.000Z', {
  session: 'low', question: SHAPED, recommendation: 'A',
  choices: [{ letter: 'A', text: 'the orchestrator\'s — it follows its wave' }, { letter: 'B', text: 'the pane\'s — it counts the queue' }], ...over,
})

test('a question in the decide shape is one block: the sender and its own numbering, its fields as labelled, nothing else of its turn', async () => {
  const { render } = await askingPane([shapedEntry()])
  const tree = await render()
  const section = tree.props.children[0]
  const drawn = texts(section)
  expect(drawn.slice(0, 6)).toEqual([
    'Questions for you — 1 pending',
    'Orch : low — Question 5 of 6',
    'Subject : the numbering of the pane\'s questions',
    'Context : the pane shows « 1 of 1 » and « 5 of 6 ».',
    'Question : which one stays?',
    'Choices :',
  ])
  expect(drawn).toContain('Recommendation of the orchestrator : A — one numbering, its own')
  for (const gone of ['Recorded', 'You decide', 'blocks:', '1 of 1 —']) expect(drawn.some(t => t.startsWith(gone))).toBe(false)
  // One numbering: the sender's; the pane's own count is the title's alone.
  expect(drawn.filter(t => / of \d/.test(t) && !t.startsWith('Context')).length).toBe(1)
})

test('the choices are a blank line apart, and the recommendation and the picker each a blank line below what precedes', async () => {
  const { render } = await askingPane([shapedEntry()])
  const kids = (await render()).props.children[0].props.children
  const list = kids.find((k: any) => k.type === 'Box' && k.props.gap === 1)
  expect(list.props.flexDirection).toBe('column')
  expect(list.props.children.map((t: any) => t.props.children)).toEqual([
    'A) the orchestrator\'s — it follows its wave  (recommended)',
    'B) the pane\'s — it counts the queue',
  ])
  const after = kids.slice(kids.indexOf(list) + 1)
  expect(after.map((k: any) => [k.props.marginTop, k.props.children[0].type])).toEqual([[1, 'Text'], [1, 'Select']])
})

test('each choice\'s text is drawn once: the picker\'s options carry their letter, the collapsed line a prompt to choose', async () => {
  const { render } = await askingPane([shapedEntry()])
  const tree = await render()
  const json = JSON.stringify(tree)
  expect(json.split('it counts the queue').length - 1).toBe(1)
  expect(picker(tree).props.label).toBe('Choose')
  expect(picker(tree).props.options.map((o: any) => o.label)).toEqual(['A (recommended)', 'B', 'Other answer: type it below'])
})

test('the questions are drawn first, above the orchestrators, the title counting them once', async () => {
  const asked = ['phase 3', 'phase 4', 'phase 5'].map((blocks, i) =>
    entry('Orch : low', `2026-10-18T10:0${i + 3}:00.000Z`, { session: 'low', blocks, choices: CHOICES }))
  const { render } = await askingPane(asked)
  const tree = await render()
  const [section, title] = tree.props.children
  expect(section.props.children[0].props.children).toBe('Questions for you — 3 pending')
  expect(title.props.children).toBe('Orchestrators')
  expect(JSON.stringify(tree).split('pending').length - 1).toBe(1)
})

test('answers not delivered are one line at the section\'s foot, below the next question, never above it', async () => {
  const asked = ['phase 3', 'phase 4', 'phase 5'].map((blocks, i) =>
    entry('Orch : low', `2026-10-18T10:0${i + 3}:00.000Z`, { session: 'low', blocks, choices: CHOICES }))
  const { render } = await askingPane(asked, { refuse: 'nobody by that name' })
  await pick(await render(), 'A')
  await pick(await render(), 'B')
  const kids = (await render()).props.children[0].props.children
  const notices = kids.filter((k: any) => k.type === 'Text' && String(k.props.children).startsWith('not delivered:'))
  expect(notices.length).toBe(1)
  expect(notices[0].props.children.split(' · ').length).toBe(2)
  expect(kids.at(-1)).toBe(notices[0])
  expect(kids[1].props.children).toBe('Orch : low')
})

test('once the pane holds the keys the key line no longer says how to give them, and it is never dim', async () => {
  const { render } = await askingPane([shapedEntry()])
  const keys = (await render({ isFocused: true })).props.children.at(-1)
  expect(keys.props.children).toBe('arrows: move · Enter: choose · Esc: back to the prompt')
  expect(keys.props.dimColor).toBeUndefined()
})

test('the track has one cell per window row, its thumb the window\'s share and place; none when the tree fits', () => {
  expect(scrollTrack(0, 10, 10)).toBeNull()
  expect(scrollTrack(0, 10, 8)).toBeNull()
  const top = scrollTrack(0, 10, 40)!
  expect(top.length).toBe(10)
  expect(top.map(Number).join('')).toBe('1110000000')
  expect(scrollTrack(30, 10, 40)!.map(Number).join('')).toBe('0000000111')
  expect(scrollTrack(15, 10, 40)!.map(Number).join('')).toBe('0000111000')
  expect(scrollTrack(0, 4, 400)!.filter(Boolean).length).toBe(1)
})

test('a line is cut into rows at its spaces, a word longer than a row cut where the row ends', () => {
  expect(wrapWords('arrows: move · Enter: choose', 14)).toEqual(['arrows: move ·', 'Enter: choose'])
  expect(wrapWords('short', 20)).toEqual(['short'])
  expect(wrapWords('abcdefghij kl', 4)).toEqual(['abcd', 'efgh', 'ij', 'kl'])
})

test('the person\'s move gives the tree\'s height for the content it measured, and goes on; until then the module counts the rows', async () => {
  const { render, handlers, fx } = await askingPane([shapedEntry()])
  const props = { scroll: { offset: 0, bodyRows: 8 }, bodyColumns: 50 }
  const counted = (await render(props)).props.children.find((k: any) => k.props?.position === 'absolute' && k.props.right === 0)
  expect(counted.props.children.length).toBe(8)
  let moved = false
  await handlers['ui.scroll'](fx.dollar, { component: 'Pane', requestId: 'supervision', offset: 1, by: 1, bodyRows: 8, contentRows: 80, origin: { kind: 'person' } }, () => { moved = true; return {} })
  expect(moved).toBe(true)
  const thumb = (tree: any) => tree.props.children.find((k: any) => k.props?.position === 'absolute' && k.props.right === 0).props.children.filter((t: any) => t.props.children === '█').length
  expect(thumb(await render(props))).toBe(1)
  // Other content drawn: the measure was of the old one, and the module counts again.
  expect(thumb(await render({ ...props, isFocused: true }))).toBeGreaterThan(1)
  // A tree that fits draws no track.
  const fits = await render({ scroll: { offset: 0, bodyRows: 200 }, bodyColumns: 50 })
  expect(fits.props.children.filter((k: any) => k.props?.position === 'absolute')).toEqual([])
  expect(fits.props.paddingRight).toBeUndefined()
})

test('over a tree taller than its window, the track and the key line are drawn at the window\'s rows and follow it, the content kept clear of both', async () => {
  const { render } = await askingPane([shapedEntry()])
  const at = async (offset: number) => {
    const tree = await render({ scroll: { offset, bodyRows: 12 }, bodyColumns: 50 })
    const absolute = tree.props.children.filter((k: any) => k.props?.position === 'absolute')
    return { tree, track: absolute[0], keys: absolute[1] }
  }
  const top = await at(0)
  expect(top.tree.props.paddingRight).toBe(2)
  expect(top.track.props).toMatchObject({ top: 0, right: 0, width: 1 })
  expect(top.track.props.children.length).toBe(12)
  expect(top.track.props.children[0].props.children).toBe('█')
  expect(top.track.props.children[11].props.children).toBe('│')
  const rows = top.keys.props.children.length
  expect(rows).toBe(wrapWords('ctrl+x tab or a click: give the pane the keys · arrows: move · Enter: choose · Esc: back to the prompt', 48).length)
  expect(top.tree.props.paddingTop).toBe(rows)
  expect(top.keys.props).toMatchObject({ top: 0, left: 0, width: 48 })
  expect(top.keys.props.children.every((t: any) => t.props.children.length === 48 && t.props.dimColor === undefined)).toBe(true)
  expect(top.keys.props.children.map((t: any) => t.props.children.trimEnd()).join(' ')).toContain('Enter: choose')
  // The key line is pinned: not drawn a second time in the flow.
  expect(texts(top.tree).filter(t => t.includes('Enter: choose')).length).toBe(1)
  const down = await at(28)
  expect(down.track.props.top).toBe(28)
  expect(down.keys.props.top).toBe(28)
  expect(down.track.props.children[11].props.children).toBe('█')
  expect(down.track.props.children[0].props.children).toBe('│')
})

test('the pane opens asking the keys, so its picker answers at once over an empty prompt', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = fakeDollar({ launchName: 'Coord : main' })
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect((fx.opened[0] as { focus?: boolean }).focus).toBe(true)
})

test('the rows the module counts are the rows the tree draws: a track exactly when they pass the window', async () => {
  // At 200 columns nothing wraps. The section: its title, the header, four fields, A, a blank,
  // B, a blank, the recommendation, a blank, the picker (13); its bottom margin (1); the
  // orchestrators' title (1) and one row (1); the key line pinned above them (1): 17.
  const { render } = await askingPane([shapedEntry()])
  const track = async (bodyRows: number) => (await render({ scroll: { offset: 0, bodyRows }, bodyColumns: 200 }))
    .props.children.filter((k: any) => k.props?.position === 'absolute').length
  expect(await track(17)).toBe(0)
  expect(await track(16)).toBe(2)
})
