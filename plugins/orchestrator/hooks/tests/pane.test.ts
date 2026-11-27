// hooks/tests/pane.test.ts
// The supervision pane: the store's rows sorted by rotation urgency (past the
// gate first, then fill descending), the label the spec names (name, role, the
// fill against the gate, the reading's age) the commands print, and the wiring
// over a faked $ — no pane opened on any start, the pane opened by the
// command in a coordinator session (the orchestrators) or an orchestrator
// session (its own agents) alone, or put as its role left it at a successor's
// first turn, never by itself, and a coordinator's round's
// first question drawn under its rows, the
// measure's side reads bounded so a walk that cannot answer in time costs the row
// its name, never the measure.
import { expect, test, type Reply } from 'claude-code/testing'
import { capture, hostOf, type Captured } from '../../core/capture.ts'
import { fieldsOf, type Events, type FsEntry, type Host, type Noun, type On, type ProcessRunInit, type UiElements } from '../../core/host.ts'
import { agentPaneRows, paneRows, parseSessionRow, readRound, scrollTrack, wrapWords, register as registerSupervision, registerWake, registerPaneTool, SUPERVISION_TOOL, PANE_MAIN_THREAD_ONLY, type SessionRow } from '../supervision.ts'
import { readAsked, settle } from '../question.ts'
import { receiveReplyAck, resendReplies } from '../remote-asked.ts'
import { type RoundEntry } from '../round.ts'
import { hostRecordOf } from '../session-name.ts'
import { register as registerAll } from '../register.ts'
import { statusText } from '../commands.ts'
import { withdrawalText } from '../relay.ts'
import { logLineOf, blockOf, lockRun } from './fakes.ts'
import { drawScreen, textOf } from './screen.ts'
import { GLUED_BLOCKS } from './fixtures.ts'
import { parseQ } from '../remote-round.ts'

const HOME = '/tmp/h'
const SESSIONS = `${HOME}/.claude/claude-orchestrator/store/sessions`
const PROJECTS = `${HOME}/.claude/projects`

// --- the rows -------------------------------------------------------------------------------

test('rows sort by rotation urgency', () => {
  const rows = paneRows({
    'sessions/a': { role: 'agent', name: 'Agent: low', context_percent: 30, context_tokens: 30000, window: 100000, model: 'a-model', busy: false, updated_at: 't', repo: 'r' },
    'sessions/b': { role: 'agent', name: 'Agent: hot', context_percent: 85, context_tokens: 85000, window: 100000, model: 'a-model', busy: true, updated_at: 't', repo: 'r' },
  })
  expect(rows[0]!.label).toContain('Agent: hot')
  expect(rows[0]!.label).toContain('85%')
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
  expect(rows[0]!.label).toContain('35%')
  expect(rows[0]!.label).toContain('past the gate')
  expect(rows[1]!.label).toContain('50%')
  expect(rows[1]!.label).not.toContain('past the gate')
  expect(rows[0]!.urgency).toBeGreaterThan(rows[1]!.urgency)
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
    'sessions/named': row({ name: 'Agent: one', context_percent: 30, updated_at: new Date(Date.now() - 65000).toISOString() }),
    'sessions/quiet': row({ role: null, updated_at: 't' }),
  })
  const named = rows.find(r => r.label.includes('Agent: one'))!
  expect(named.label).toContain('agent')
  expect(named.label).toContain('30%')
  expect(named.label).toContain('1m')
  expect(named.label).not.toContain('NaN')
  const quiet = rows.find(r => !r.label.includes('Agent: one'))!
  expect(quiet.label).toContain('unnamed')
  expect(quiet.label).toContain('no role')
  expect(quiet.label).not.toContain('NaN')
})

test('an orchestrator\'s agents sort like the store rows, an unmeasured one last', () => {
  const rows = agentPaneRows([
    { name: 'Agent: fresh', status: 'busy', row: null },
    { name: 'Agent: low', status: 'idle', row: row({ context_percent: 20 }) },
    { name: 'Agent: full', status: 'busy', row: row({ context_percent: 35, context_tokens: 350000, window: 1000000 }) },
  ])
  expect(rows.map(r => r.label.split(' · ')[0])).toEqual(['Agent: full', 'Agent: low', 'Agent: fresh'])
  expect(rows[0]!.label).toContain('busy · 35% past the gate')
  expect(rows[2]!.label).toBe('Agent: fresh · busy · not measured yet')
})

test('the host record gives the id, the name without a quoted rename\'s quotes, the status', () => {
  expect(hostRecordOf('{"sessionId":"s-1","name":"\\"Orch: PTI\\"","status":"busy"}'))
    .toEqual({ sessionId: 's-1', name: 'Orch: PTI', status: 'busy' })
  expect(hostRecordOf('{"sessionId":"s-2","status":"waiting"}')).toEqual({ sessionId: 's-2', name: null, status: null })
  expect(hostRecordOf('not json')).toBeNull()
})

// --- the wiring -----------------------------------------------------------------------------

// The harness hands a test a $ of its own, reduced — neither fs nor process
// among its nouns — so the pane is exercised over a complete fake: an
// in-memory file map holding the store, recorded runs, a recorded ui.open.
type Fx = {
  dollar: World
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
  notices: string[]
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
  // The lines the module drew in its session's transcript ($.ui.log): no model turn.
  const notices: string[] = []
  // The host's $.state for the session: it outlives the module's own variables.
  const state = new Map<string, unknown>()
  const dollar = hostOf({
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
    },
    env: { get: async (name: string) => env[name] },
    plugin: { root: '/plugins/orch-root' },
    prompt: { submit: async (args: { text: string }) => { submitted.push(args.text) } },
    tool: { register: async (spec: { name: string }) => { tools.push(spec) } },
    fs: {
      read: async (p: string) => {
        const text = files.get(p)
        if (text === undefined) throw new Error(`ENOENT: ${p}`)
        return text
      },
      write: async (p: string, text: string) => {
        files.set(p, text)
      },
      stat: async (p: string) => {
        const text = files.get(p)
        if (text === undefined) throw new Error(`ENOENT: ${p}`)
        return { kind: 'file', size: text.length, mtimeMs: 0 }
      },
      list: async (dir: string) => {
        const names = new Set<string>()
        for (const p of files.keys()) {
          if (!p.startsWith(`${dir}/`)) continue
          const rest = p.slice(dir.length + 1)
          if (rest) names.add(rest.split('/')[0] ?? rest)
        }
        return [...names].map((name): FsEntry => {
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
        const locked = lockRun(argv, files)
        if (locked) return locked
        const line = logLineOf(argv)
        if (line !== null) {
          written.push(line)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        const block = blockOf(argv, (p: string) => files.get(p) ?? '')
        if (block !== null) return { exitCode: 0, stdout: block, stderr: '' }
        ran.push(argv.join(' '))
        // The module's atomic write renames its temporary file into place.
        const [, , from = '', to = ''] = argv
        if (argv[0] === 'mv' && argv[1] === '-f' && files.has(from)) {
          files.set(to, files.get(from)!)
          files.delete(from)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'rm' && argv[1] === '-f') {
          for (const p of argv.slice(2)) files.delete(p)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'sh') {
          if (over.hangWalk) return new Promise<never>(() => undefined)
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
          const name = over.launchName === null ? null : (over.launchName ?? 'Agent: belt-p3')
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
      log: (text: string) => { notices.push(text) },
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
      resolve: (e): UiElements => ({
        Box: props => ({ type: 'Box', props }),
        Text: props => ({ type: 'Text', props }),
        Button: props => ({ type: 'Button', props }),
        Link: props => ({ type: 'Link', props }),
        ...(fieldsOf(e)?.['surface'] === 'mobile' ? {} : {
          Input: props => ({ type: 'Input', props }),
          Select: props => ({ type: 'Select', props }),
        }),
      }),
    },
  })
  return { dollar, files, ran, written, opened, closed, env, timers, invalidated, focused, scrolled, later, state, submitted, tools, notices }
}

// The host every hook under test is handed: each noun, those the fake does not set throwing.
type World = Host<Noun>
// A captured hook as a test calls it: the fake's $, an event as the test writes it, a next of the
// test's own. A hook the module does not register reads undefined at run time.
type Call = (dollar: World, e: object, next?: (e: never) => unknown) => Promise<Reply>
type Handlers = { readonly [K in keyof Events]: Call }
const callOf = <H>(hook: Captured<H>): Call =>
  async (dollar, e, next) => (await hook.handler(dollar as H, e as never, next as never)) as Reply

function mounted<H>(register: (on: On<H>) => void): {
  handlers: Handlers
  matchers: Partial<Record<keyof Events, object | undefined>>
} {
  const handlers: Partial<Record<keyof Events, Call>> = {}
  const matchers: Partial<Record<keyof Events, object | undefined>> = {}
  for (const hook of capture(register)) {
    handlers[hook.event] = callOf(hook)
    matchers[hook.event] = hook.matcher
  }
  return { handlers: handlers as Handlers, matchers }
}

const startEvent = { cwd: '/tmp/w', surface: 'terminal', isInteractive: true }

// The composed chain, one list per event, driven in registration order — the
// order the host drives the chain itself.
function composedChains(): Partial<Record<keyof Events, Call[]>> {
  const chains: Partial<Record<keyof Events, Call[]>> = {}
  for (const hook of capture(registerAll)) (chains[hook.event] ??= []).push(callOf(hook))
  return chains
}

async function drive(chains: Partial<Record<keyof Events, Call[]>>, event: keyof Events, dollar: World, e: object) {
  const chain = chains[event] ?? []
  const run = async (i: number, ev: object): Promise<unknown> => {
    const hook = chain[i]
    return hook === undefined ? ev : hook(dollar, ev, (x: object) => run(i + 1, x))
  }
  return run(0, e)
}

test('no start opens the pane, whatever the role', async () => {
  // The operator's ruling: nothing is placed on screen unasked. Supervision
  // registers no start handler, and a start driven through the whole composed
  // chain opens nothing, a coordinator's included.
  const { handlers } = mounted(registerSupervision)
  expect(handlers['session.start']).toBeUndefined()
  const chains = composedChains()
  for (const launchName of ['Coord: main', 'Orch: phase-3', 'Agent: belt-p3']) {
    const fx = fakeDollar({ launchName })
    await drive(chains, 'session.start', fx.dollar, startEvent)
    expect(fx.opened).toEqual([])
  }
})

// Every command.run registration, in order: the supervision answers to two commands.
function commandRuns<H>(register: (on: On<H>) => void): { matcher: { readonly [field: string]: unknown } | undefined; handler: Call }[] {
  return capture(register).filter(hook => hook.event === 'command.run').map(hook => ({ matcher: hook.matcher, handler: callOf(hook) }))
}

// Measured live: the host hands the plugin's command as `orchestrator:<file>` and the
// installer's user command as its bare short name; the 0.80.0 `orchestrator:<short>` form stays.
// One command for both roles, the operator's ruling 229 (« B »): /orchestrator:supervision alone
// is kept, and no form of the coordinator's own name toggles the pane any more.
test('the supervision answers to every form of its one short name, one pane whichever was typed', async () => {
  const runs = commandRuns(registerSupervision)
  expect(runs.map(run => run.matcher)).toEqual([
    { command: 'orchestrator:orchestrator-supervision' },
    { command: 'orchestrator:supervision' },
    { command: 'orchestrator-supervision' },
  ])
  const [shortForm, pluginForm] = [runs[0]!.handler, runs[1]!.handler]
  for (const [opener, closer] of [[shortForm, pluginForm], [pluginForm, shortForm]] as const) {
    const coord = fakeDollar({ launchName: 'Coord: main' })
    expect((await opener(coord.dollar, { command: 'orchestrator:orchestrator-supervision', args: '' })).text).toContain('pane opened')
    expect(await closer(coord.dollar, { command: 'orchestrator:supervision', args: '' })).toEqual({ text: 'Supervision pane closed.' })
    expect(coord.opened.length).toBe(1)
    expect(coord.closed).toEqual([{ id: 'supervision' }])
  }
})

// The bare short name is /orchestrator-supervision alone, the operator's ruling 229 (« B »).
test('a bare short name toggles the pane when its user command is the plugin\'s copy, and runs as written otherwise', async () => {
  const runs = commandRuns(registerSupervision)
  const passed = (x: unknown) => ({ passed: x })
  for (const command of ['orchestrator-supervision']) {
    const hook = runs.find(run => run.matcher?.['command'] === command)!.handler
    const e = { command, args: '' }
    const marked = fakeDollar({ launchName: 'Coord: main' })
    marked.files.set(`${HOME}/.claude/commands/${command}.md`, '---\ninstalled-by: claude-orchestrator\ndescription: Open or close the supervision pane\n---\n')
    expect((await hook(marked.dollar, e, passed)).text).toContain('pane opened')
    expect(marked.opened.length).toBe(1)
    const foreign = fakeDollar({ launchName: 'Coord: main' })
    foreign.files.set(`${HOME}/.claude/commands/${command}.md`, '---\ndescription: mine\n---\n')
    expect(await hook(foreign.dollar, e, passed)).toEqual({ passed: e })
    expect(foreign.opened).toEqual([])
    const none = fakeDollar({ launchName: 'Coord: main' })
    expect(await hook(none.dollar, e, passed)).toEqual({ passed: e })
  }
  // The plugin's own file, `/orchestrator:supervision`, needs no copy.
  const plugin = runs.find(run => run.matcher?.['command'] === 'orchestrator:supervision')!.handler
  const orch = fakeDollar({ launchName: 'Orch: phase-3' })
  expect((await plugin(orch.dollar, { command: 'orchestrator:supervision', args: '' }, passed)).text).toContain('pane opened')
})

test('/orchestrator-supervision opens the pane in a coordinator or an orchestrator session alone', async () => {
  const { handlers, matchers } = mounted(registerSupervision)
  expect(matchers['ui.render']).toEqual({ component: 'Pane', requestId: 'supervision' })
  const run = { command: 'orchestrator:orchestrator-supervision', args: '' }

  const coord = fakeDollar({ launchName: 'Coord: main' })
  // The one command of both roles, the operator's ruling 229 (« B »).
  expect(await handlers['command.run'](coord.dollar, run)).toEqual({ text: 'Supervision pane opened; type /orchestrator-supervision again, or click its ✕, to close it.' })
  expect(coord.opened).toEqual([{ id: 'supervision', title: 'Sessions', focus: true }])
  // Typed again, the command closes the pane it opened.
  expect(await handlers['command.run'](coord.dollar, run)).toEqual({ text: 'Supervision pane closed.' })
  expect(coord.closed).toEqual([{ id: 'supervision' }])
  expect(coord.opened.length).toBe(1)

  const orch = fakeDollar({ launchName: 'Orch: phase-3' })
  expect(await handlers['command.run'](orch.dollar, run)).toEqual({ text: 'Supervision pane opened; type /orchestrator-supervision again, or click its ✕, to close it.' })
  expect(orch.opened).toEqual([{ id: 'supervision', title: 'Agents', focus: true }])

  for (const launchName of ['Agent: belt-p3', 'Audit: belt', null]) {
    const fx = fakeDollar({ launchName })
    const answer = await handlers['command.run'](fx.dollar, run)
    expect(answer.text).toContain('coordinator session (« Coord: … »), listing the orchestrators, auditors and coordinators, or in an orchestrator session')
    expect(answer.text).toContain('/orchestrator:status lists the sessions here')
    expect(fx.opened).toEqual([])
  }
})

// --- the tool on the operator's plain words ---------------------------------------------------

const toolCall = (action: string, over: object = {}) => ({ tool: `mcp__orchestrator__${SUPERVISION_TOOL}`, action, ...over })

test('the supervision tool is registered at every start, loaded with its schema, and opens nothing', async () => {
  const { handlers } = mounted(registerPaneTool)
  for (const launchName of ['Coord: main', 'Agent: belt-p3']) {
    const fx = fakeDollar({ launchName })
    await handlers['session.start'](fx.dollar, startEvent, (x: unknown) => x)
    expect(fx.tools.map(spec => [spec.name, spec.isDeferred])).toEqual([['supervision', false]])
    expect(JSON.stringify(fx.tools[0]?.inputSchema)).toContain('"enum":["open","close"]')
    expect(fx.opened).toEqual([])
  }
  const { matchers } = mounted(registerSupervision)
  expect(matchers['tool.call']).toEqual({ tool: 'mcp__orchestrator__supervision' })
})

test('the supervision tool opens and closes the pane the commands toggle, by the word it is given', async () => {
  const { handlers } = mounted(registerSupervision)
  for (const [launchName, title] of [['Coord: main', 'Sessions'], ['Orch: phase-3', 'Agents']] as const) {
    const fx = fakeDollar({ launchName })
    expect(await handlers['tool.call'](fx.dollar, toolCall('close'))).toEqual({ result: 'The supervision pane is not open.' })
    expect(await handlers['tool.call'](fx.dollar, toolCall('open'))).toEqual({ result: 'Supervision pane opened.' })
    expect(fx.opened).toEqual([{ id: 'supervision', title, focus: true }])
    // Not a toggle: open again leaves it open.
    expect(await handlers['tool.call'](fx.dollar, toolCall('open'))).toEqual({ result: 'The supervision pane is already open.' })
    expect(fx.opened.length).toBe(1)
    expect(await handlers['tool.call'](fx.dollar, toolCall('close'))).toEqual({ result: 'Supervision pane closed.' })
    expect(fx.closed).toEqual([{ id: 'supervision' }])
  }
  // One pane: opened by the tool, the command closes it, and the reverse.
  const fx = fakeDollar({ launchName: 'Coord: main' })
  await handlers['tool.call'](fx.dollar, toolCall('open'))
  expect(await handlers['command.run'](fx.dollar, supervisionRun)).toEqual({ text: 'Supervision pane closed.' })
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(await handlers['tool.call'](fx.dollar, toolCall('close'))).toEqual({ result: 'Supervision pane closed.' })
  expect(fx.opened.length).toBe(2)
  expect(fx.closed.length).toBe(2)
})

test('the supervision tool is refused to a subagent, outside the two roles, and on any other word', async () => {
  const { handlers } = mounted(registerSupervision)
  const coord = fakeDollar({ launchName: 'Coord: main' })
  expect(await handlers['tool.call'](coord.dollar, toolCall('open', { agentId: 'a-1' }))).toEqual({ result: PANE_MAIN_THREAD_ONLY, isError: true })
  expect(await handlers['tool.call'](coord.dollar, toolCall('toggle'))).toEqual({ result: 'action is "open" or "close"', isError: true })
  expect(coord.opened).toEqual([])
  for (const launchName of ['Agent: belt-p3', 'Audit: belt', null]) {
    const fx = fakeDollar({ launchName })
    const answer = await handlers['tool.call'](fx.dollar, toolCall('open'))
    expect(answer.isError).toBe(true)
    expect(answer.result).toContain('a coordinator session (« Coord: … ») or an orchestrator session (« Orch: … ») alone')
    expect(fx.opened).toEqual([])
    expect([...fx.state.values()]).toEqual([])
  }
})

test('the supervision tool says when the host holds the pane undrawn', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = fakeDollar({ launchName: 'Orch: phase-3' })
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
  const fx = fakeDollar({ launchName: 'Coord: main' })
  fx.files.set(`${SESSIONS}/low`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: low', context_percent: 30 })) + '\n')
  fx.files.set(`${SESSIONS}/hot`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: hot', context_percent: 85 })) + '\n')
  fx.files.set(`${SESSIONS}/agent`, JSON.stringify(row({ role: 'agent', name: 'Agent: belt', context_percent: 50 })) + '\n')
  await handlers['command.run'](fx.dollar, supervisionRun)
  const text = JSON.stringify(await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x })))
  expect(text.indexOf('Orch: hot')).toBeLessThan(text.indexOf('Orch: low'))
  expect(text).not.toContain('Agent: belt')
  // Past the gate, the fill and its words are drawn in the error colour.
  expect(text.match(/"color":"error"/g)?.length).toBe(1)
  expect(text.indexOf('"color":"error"')).toBeGreaterThan(text.indexOf('Orch: hot'))

  const { handlers: fresh } = mounted(registerSupervision)
  const empty = fakeDollar({ launchName: 'Coord: main' })
  await fresh['command.run'](empty.dollar, supervisionRun)
  expect(JSON.stringify(await fresh['ui.render'](empty.dollar, renderEvent, (x: unknown) => ({ passed: x })))).toContain('no live session')
})

test('an orchestrator\'s pane lists the agents its own tab spawned, read from the host\'s records', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = fakeDollar({ launchName: 'Orch: phase-3' })
  fx.env['ITERM_SESSION_ID'] = 'w0t1p0:OWNER-1'
  // The walk's seed puts this session on ttys001; its chain holds one agent of
  // its own and one a recycled tty's previous owner wrote.
  fx.files.set(`${HOME}/.claude/claude-orchestrator/chains/ttys001.jsonl`, [
    JSON.stringify({ tab_id: 't-9', tty: '/dev/ttys009', owner: 'OWNER-1' }),
    JSON.stringify({ tab_id: 't-8', tty: '/dev/ttys008', owner: 'SOMEONE-ELSE' }),
  ].join('\n') + '\n')
  // The fake's ps answers pid 777 on an agent's tty: its host record and store row.
  fx.files.set(`${HOME}/.claude/sessions/777.json`, JSON.stringify({ sessionId: 's-agent', name: 'Agent: belt-p3', status: 'busy' }))
  fx.files.set(`${SESSIONS}/s-agent`, JSON.stringify(row({ role: 'agent', name: 'Agent: belt-p3', context_percent: 40 })) + '\n')
  await handlers['command.run'](fx.dollar, supervisionRun)
  // The row is the name (bold) and the rest in two pieces: read as the text they draw together.
  const tree = drawnTree(await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x })))
  const text = kidsOf(tree).map(kid => pieces(kid).map(p => p.text).join('')).join('\n')
  expect(text).toContain('Agent: belt-p3 · busy · 40%')
  expect(text.match(/Agent: belt-p3/g)?.length).toBe(1)
  expect(fx.ran).toContain('ps -t ttys009 -o pid=')
  expect(fx.ran).not.toContain('ps -t ttys008 -o pid=')

  // Without the terminal's session id no entry is counted: a recycled tty's
  // occupant would be.
  const { handlers: fresh } = mounted(registerSupervision)
  const blind = fakeDollar({ launchName: 'Orch: phase-3' })
  await fresh['command.run'](blind.dollar, supervisionRun)
  expect(JSON.stringify(await fresh['ui.render'](blind.dollar, renderEvent, (x: unknown) => ({ passed: x })))).toContain('no agent running')
})

test('a pane the module no longer remembers opening asks to be opened again', async () => {
  const { handlers } = mounted(registerSupervision)
  const text = JSON.stringify(await handlers['ui.render'](fakeDollar().dollar, renderEvent, (x: unknown) => ({ passed: x })))
  // The one command of both roles, the operator's ruling 229 (« B »).
  expect(text).toContain('type /orchestrator-supervision to open the pane again')
})

test('a session in its first turn is listed: its row is written at the turn start, before any measure, and the pane lists it', async () => {
  // Row 547: a freshly placed auditor stayed out of the pane until its first turn ended, the row
  // being written only at the measure. Its row now exists from the first turn's start, and the
  // pane's rows, read from the store, list it as an auditor.
  const fx = fakeDollar({ launchName: 'Audit: Claude plugins' })
  fx.env['ORCHESTRATOR_OSASCRIPT'] = '/usr/bin/false'
  expect(fx.files.has(`${SESSIONS}/s-one`)).toBe(false)
  const { handlers } = mounted(registerSupervision)
  await handlers['turn.start'](fx.dollar, { turnId: 't' }, (x: unknown) => x)
  const stored = parseSessionRow(String(fx.files.get(`${SESSIONS}/s-one`)))
  expect(stored?.role).toBe('auditor')
  expect(stored?.name).toBe('Audit: Claude plugins')
  const listed = paneRows({ 'sessions/s-one': stored! })
  expect(listed.map(pane => pane.name)).toEqual(['Audit: Claude plugins'])
  expect(listed[0]!.head).toContain('auditor')
})

test('a name walk that cannot answer in time costs the row its name, never the measure', async () => {
  // The Task 9 review's bounded-reads carry: the measure's side reads run
  // under their own deadline, and one that loses the race is quietly no name —
  // the figures still land, the measure still answers.
  const chains = composedChains()
  const fx = fakeDollar({ hangWalk: true, origin: 'git@github.com:me/belt.git' })
  fx.env['ORCHESTRATOR_SIDE_READ_MS'] = '50'
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

test('with the module directory overridden, the measure and the pane use it, and nothing lands in the config dir', async () => {
  // A harness driving a host on the machine's own config dir sets ORCHESTRATOR_MODULE_DIR: its
  // rows and measures stay in its sandbox, and the operator's store never sees them.
  const SANDBOX = '/sandbox/module'
  const fx = fakeDollar({ launchName: 'Coord: main' })
  fx.env['ORCHESTRATOR_MODULE_DIR'] = SANDBOX
  await drive(composedChains(), 'session.measure', fx.dollar, {})
  expect(fx.files.has(`${SANDBOX}/store/sessions/s-one`)).toBe(true)
  expect(fx.files.has(`${SANDBOX}/measure/s-one.json`)).toBe(true)
  expect([...fx.files.keys()].filter(p => p.startsWith(`${HOME}/.claude/claude-orchestrator/store`) || p.startsWith(`${HOME}/.claude/claude-orchestrator/measure`))).toEqual([])
  fx.files.set(`${SANDBOX}/store/sessions/s-alpha`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: alpha', context_percent: 12 })) + '\n')
  fx.files.set(`${SESSIONS}/s-real`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: real', context_percent: 40 })) + '\n')
  const drawn = JSON.stringify(await coordinatorRender(fx))
  expect(drawn).toContain('Orch: alpha')
  expect(drawn).not.toContain('Orch: real')
})

test('an open pane redraws on its own clock while its session waits, and the clock stops with any close', async () => {
  // A render was raised only by this session's own measure: a coordinator waiting on
  // the others saw their rows frozen at its last turn. The open starts a clock that
  // re-raises the render; the command's close and the pane's own close both stop it.
  const { handlers, matchers } = mounted(registerSupervision)
  expect(matchers['ui.close']).toEqual({ id: 'supervision' })
  const fx = fakeDollar({ launchName: 'Coord: main' })
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(fx.timers.length).toBe(1)
  expect(fx.timers[0]!.ms).toBe(2000)
  fx.timers[0]!.fn()
  expect(fx.invalidated).toEqual(['ui.render'])
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(fx.timers[0]!.cancelled).toBe(true)
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(fx.timers.length).toBe(2)
  const e = { id: 'supervision', origin: { kind: 'person' } }
  expect(await handlers['ui.close'](fx.dollar, e, (x: unknown) => x)).toBe(e)
  expect(fx.timers[1]!.cancelled).toBe(true)
})

test('an open coordinator\'s pane redraws within one tick of a write in its round, and a tick that sees none draws nothing', async () => {
  // A question settled in its sender's tab or closed by the coordinator stayed drawn up to the
  // clock's 20 s. The clock now ticks every 2 s and stats the round's directory, a rename
  // into it moving its mtime: a tick redraws only when it moved since the last draw, or when the
  // last draw is 20 s old, so the ages and fills still move.
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  const roundDir = `${HOME}/.claude/claude-orchestrator/round`
  let mtime = 1000
  let stats = 0
  const stat = fx.dollar.fs.stat
  fx.dollar.fs.stat = async (p: string) => {
    if (p !== roundDir) return stat(p)
    stats++
    return { kind: 'dir', size: 0, mtimeMs: mtime }
  }
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(fx.timers.map(t => t.ms)).toEqual([2000])
  await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x }))
  const tick = async () => {
    fx.timers[0]!.fn()
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  await tick()
  expect(fx.invalidated).toEqual([])
  expect(stats).toBe(2)
  mtime = 2000
  await tick()
  expect(fx.invalidated).toEqual(['ui.render'])
  await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x }))
  await tick()
  expect(fx.invalidated).toEqual(['ui.render'])
  // No write for 20 s: the clock still redraws, its ages and fills moving.
  for (let i = 0; i < 8; i++) await tick()
  expect(fx.invalidated).toEqual(['ui.render'])
  await tick()
  expect(fx.invalidated).toEqual(['ui.render', 'ui.render'])
})

test('a coordinator\'s pane whose draw throws is not redrawn at every tick, its round absent or unmoved', async () => {
  // The round's mtime last drawn was left unset when a draw threw before reading it: every tick
  // then saw it moved, and the pane redrew every 2 s for as long as the draw kept failing.
  const roundDir = `${HOME}/.claude/claude-orchestrator/round`
  for (const mtime of [null, 1000]) {
    const { handlers } = mounted(registerSupervision)
    const fx = coordinatorSession()
    const stat = fx.dollar.fs.stat
    fx.dollar.fs.stat = async (p: string) => {
      if (p !== roundDir) return stat(p)
      if (mtime === null) throw new Error(`ENOENT: ${p}`)
      return { kind: 'dir', size: 0, mtimeMs: mtime }
    }
    const read = fx.dollar.fs.read
    fx.dollar.fs.read = (p: string) => {
      if (p === `${SESSIONS}/s-one`) throw new Error('the store cannot be read')
      return read(p)
    }
    await handlers['command.run'](fx.dollar, supervisionRun)
    const tick = async () => {
      fx.timers[0]!.fn()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }
    await tick()
    expect(fx.invalidated).toEqual(['ui.render'])
    await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x }))
    for (let i = 0; i < 5; i++) await tick()
    // A round present is redrawn once for the move the failed draw never recorded, then no more.
    expect(fx.invalidated).toEqual(mtime === null ? ['ui.render'] : ['ui.render', 'ui.render'])
  }
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

async function coordinatorRender(fx: Fx, handlers = mounted(registerSupervision).handlers) {
  await handlers['command.run'](fx.dollar, supervisionRun)
  return drawnTree(await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x })))
}

test('no open question: nothing is drawn below the rows, and an orchestrator\'s pane never draws the round', async () => {
  const bare = fakeDollar({ launchName: 'Coord: main' })
  const settled = fakeDollar({ launchName: 'Coord: main' })
  for (const fx of [bare, settled]) fx.files.set(`${SESSIONS}/low`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: low', context_percent: 30, updated_at: '2026-10-18T10:00:00.000Z' })) + '\n')
  for (const done of [entry('Orch: low', '2026-10-18T10:03:00.000Z', { status: 'closed' }), entry('Orch: low', '2026-10-18T10:04:00.000Z', { kind: 'done', blocks: null })]) {
    settled.files.set(`${ROUND}/${done.id}.json`, JSON.stringify(done) + '\n')
  }
  const settledTree = await coordinatorRender(settled)
  expect(JSON.stringify(settledTree)).toBe(JSON.stringify(await coordinatorRender(bare)))
  // The title, the block and the section's `none`: no question line below the block.
  expect(kidsOf(settledTree).length).toBe(3)
  expect(JSON.stringify(settledTree)).not.toContain('Merge it?')

  const orch = fakeDollar({ launchName: 'Orch: phase-3' })
  const asked = entry('Orch: phase-3', '2026-10-18T10:03:00.000Z')
  orch.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(asked) + '\n')
  expect(JSON.stringify(await coordinatorRender(orch))).not.toContain('pending')
})

test('the archive under the round is read by nothing: an open question planted there is neither read nor drawn', async () => {
  const fx = fakeDollar({ launchName: 'Coord: main' })
  fx.files.set(`${SESSIONS}/live`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: live', context_percent: 30 })) + '\n')
  const hidden = askedObject('live', 'Orch: live', '2026-10-18T10:03:00.000Z')
  fx.files.set(`${ROUND}/archive/${hidden.id}.json`, JSON.stringify(hidden) + '\n')
  expect(await readAsked(fx.dollar)).toEqual([])
  expect(JSON.stringify(await coordinatorRender(fx))).not.toContain('pending')
  // The same question directly under the round is drawn: only its place kept it out.
  const control = fakeDollar({ launchName: 'Coord: main' })
  control.files.set(`${SESSIONS}/live`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: live', context_percent: 30 })) + '\n')
  control.files.set(`${ROUND}/${hidden.id}.json`, JSON.stringify(hidden) + '\n')
  expect((await readAsked(control.dollar)).length).toBe(1)
  expect(JSON.stringify(await coordinatorRender(control))).toContain('Questions for you — 1 pending')
})

test('a round directory that cannot be listed is one log line and no entry; one never written is no failure', async () => {
  const fx = fakeDollar({ launchName: 'Coord: main' })
  expect(await readRound(fx.dollar)).toEqual([])
  expect(fx.written).toEqual([])
  fx.files.set(ROUND, '')
  fx.dollar.fs.list = async () => { throw new Error('EACCES: permission denied') }
  expect(await readRound(fx.dollar)).toEqual([])
  expect(fx.written.filter(l => l.includes(`round: cannot list ${ROUND}: EACCES: permission denied`)).length).toBe(1)
})

// --- the pane opens on his word, and as its role left it ------------------------------------------------------------

const firstTurn = { answer: 'Registered.', reason: 'answer', isAborted: false, durationMs: 1, turnId: 't' }

function coordinatorSession(over: { role?: SessionRow['role']; record?: boolean } = {}): Fx {
  const fx = fakeDollar({ launchName: 'Coord: main' })
  fx.files.set(`${SESSIONS}/s-one`, JSON.stringify(row({ role: 'role' in over ? over.role : 'coordinator', name: 'Coord: main' })) + '\n')
  if (over.record !== false) fx.files.set(RECORD, JSON.stringify({ name: 'Coord: main [abc]', tty: '/dev/ttys001' }))
  return fx
}

const CHOICE = `${HOME}/.claude/claude-orchestrator/pane-choice.json`

// The successor coordinator: a fresh session (the host's state of one session starts empty), a
// fresh module, the machine's files as the predecessor left them.
function successorOf(predecessor: Fx): Fx {
  const successor = coordinatorSession()
  for (const [path, text] of predecessor.files) if (!successor.files.has(path)) successor.files.set(path, text)
  return successor
}

// Everything that can happen to a coordinator's session once the pane was closed: the end of its
// turns, a start, a reload of the module, and the round's wake. None may open the pane.
async function everyTrigger(fx: Fx): Promise<void> {
  const chain = mounted(registerSupervision).handlers
  const waking = mounted(registerWake).handlers
  await waking['session.start'](fx.dollar, startEvent, (x: unknown) => x)
  await chain['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  await chain['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  await chain['turn.start'](fx.dollar, { turnId: 't' }, (x: unknown) => x)
  for (const timer of fx.later.filter(t => t.ms === 30000 && !t.cancelled)) await timer.fn()
}

test('a coordinator\'s pane is not opened by the end of its first turn, nor by any later one: it opens on his word', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  expect(await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)).toBe(firstTurn)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.opened).toEqual([])
  expect(fx.timers).toEqual([])
  expect(fx.files.has(PANE_FILE)).toBe(false)
  // The wake is armed all the same, so his questions reach the tab.
  expect(fx.later.filter(t => t.ms === 30000).length).toBe(1)
  // Opened by his command, the pane lists what the command's pane lists.
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(fx.opened).toEqual([{ id: 'supervision', title: 'Sessions', focus: true }])
  expect(fx.timers.map(t => t.ms)).toEqual([2000])
  fx.files.set(`${SESSIONS}/low`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: low', context_percent: 30 })) + '\n')
  expect(JSON.stringify(await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x })))).toContain('Orch: low')
})

test('a pane he closed, by the command, the tool or his ✕, stays closed through a start, a turn, a reload, a wake and a succession', async () => {
  const { handlers } = mounted(registerSupervision)
  const closers: [string, (fx: Fx) => Promise<unknown>][] = [
    ['the command', fx => handlers['command.run'](fx.dollar, supervisionRun)],
    ['the tool', fx => handlers['tool.call'](fx.dollar, toolCall('close'))],
    ['his ✕', async fx => { await fx.dollar.ui.close({ id: 'supervision' }); return handlers['ui.close'](fx.dollar, { id: 'supervision', origin: { kind: 'person' } }, (x: unknown) => x) }],
  ]
  for (const [, close] of closers) {
    const fx = coordinatorSession()
    await handlers['command.run'](fx.dollar, supervisionRun)
    expect(fx.opened.length).toBe(1)
    expect(fx.files.has(PANE_FILE)).toBe(true)
    await close(fx)
    expect(fx.files.has(PANE_FILE)).toBe(false)
    await everyTrigger(fx)
    expect(fx.opened.length).toBe(1)
    const successor = successorOf(fx)
    await everyTrigger(successor)
    expect(successor.opened).toEqual([])
    expect(successor.timers).toEqual([])
    expect(successor.files.has(PANE_FILE)).toBe(false)
    expect(successor.files.has(CHOICE)).toBe(false)
  }
})

// The pane's host side ends with the session that drew it: the host closes it, with no word of his.
async function endedByHost(fx: Fx, handlers: Handlers): Promise<void> {
  await fx.dollar.ui.close({ id: 'supervision' })
  await handlers['ui.close'](fx.dollar, { id: 'supervision', origin: { kind: 'host' } }, (x: unknown) => x)
  await handlers['session.end'](fx.dollar, endEvent, (x: unknown) => x)
}

// A session of `launchName`'s role over the machine's files as its predecessor left them, its
// host state its own, its first turn started by a fresh module.
async function successorStart(predecessor: Fx, launchName: string): Promise<Fx> {
  const successor = fakeDollar({ launchName })
  for (const [path, text] of predecessor.files) successor.files.set(path, text)
  await mounted(registerSupervision).handlers['turn.start'](successor.dollar, { turnId: 't' }, (x: unknown) => x)
  return successor
}

const ROLES_WITH_A_PANE = [['Coord: main', 'Sessions'], ['Orch: belt', 'Agents']] as const

test('a pane open when its session ends is open in the successor, the coordinator\'s and the orchestrator\'s', async () => {
  for (const [launchName, title] of ROLES_WITH_A_PANE) {
    const { handlers } = mounted(registerSupervision)
    const fx = fakeDollar({ launchName })
    await handlers['command.run'](fx.dollar, supervisionRun)
    await endedByHost(fx, handlers)
    const successor = await successorStart(fx, launchName)
    expect(successor.opened).toEqual([{ id: 'supervision', title, focus: true }])
    expect(successor.timers.map(t => t.ms)).toEqual([2000])
  }
})

test('the successor carries its predecessor\'s name without the host\'s reference, and a role\'s pane is its own', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = fakeDollar({ launchName: 'Orch: belt [a1b2c3]' })
  await handlers['command.run'](fx.dollar, supervisionRun)
  await endedByHost(fx, handlers)
  expect((await successorStart(fx, 'Orch: belt [zzzzzz]')).opened.length).toBe(1)
  expect((await successorStart(fx, 'Orch: other')).opened).toEqual([])
  expect((await successorStart(fx, 'Coord: main')).opened).toEqual([])
  expect((await successorStart(fx, 'Agent: belt-p3')).opened).toEqual([])
})

test('a pane closed by his word, the command, the tool or his ✕, is closed in the successor, the orchestrator\'s too', async () => {
  const closers: [string, (fx: Fx, handlers: Handlers) => Promise<unknown>][] = [
    ['the command', (fx, handlers) => handlers['command.run'](fx.dollar, supervisionRun)],
    ['the tool', (fx, handlers) => handlers['tool.call'](fx.dollar, toolCall('close'))],
    ['his ✕', async (fx, handlers) => { await fx.dollar.ui.close({ id: 'supervision' }); return handlers['ui.close'](fx.dollar, { id: 'supervision', origin: { kind: 'person' } }, (x: unknown) => x) }],
  ]
  for (const [launchName] of ROLES_WITH_A_PANE) {
    for (const [, close] of closers) {
      const { handlers } = mounted(registerSupervision)
      const fx = fakeDollar({ launchName })
      await handlers['command.run'](fx.dollar, supervisionRun)
      await close(fx, handlers)
      await endedByHost(fx, handlers)
      const successor = await successorStart(fx, launchName)
      expect(successor.opened).toEqual([])
      expect(successor.timers).toEqual([])
    }
  }
})

test('his close by the tool, the pane being gone already, is kept: the successor leaves it closed', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = fakeDollar({ launchName: 'Coord: main' })
  await handlers['command.run'](fx.dollar, supervisionRun)
  await fx.dollar.ui.close({ id: 'supervision' })
  expect(await handlers['tool.call'](fx.dollar, toolCall('close'))).toEqual({ result: 'The supervision pane is not open.' })
  expect((await successorStart(fx, 'Coord: main')).opened).toEqual([])
})

test('the pane is put as it was once per module: a pane the host closes again is not reopened by the next turn', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = fakeDollar({ launchName: 'Orch: belt' })
  await handlers['command.run'](fx.dollar, supervisionRun)
  await endedByHost(fx, handlers)
  const fresh = mounted(registerSupervision).handlers
  const successor = fakeDollar({ launchName: 'Orch: belt' })
  for (const [path, text] of fx.files) successor.files.set(path, text)
  await fresh['turn.start'](successor.dollar, { turnId: 't' }, (x: unknown) => x)
  expect(successor.opened.length).toBe(1)
  await successor.dollar.ui.close({ id: 'supervision' })
  await fresh['turn.start'](successor.dollar, { turnId: 't2' }, (x: unknown) => x)
  expect(successor.opened.length).toBe(1)
  // His ✕ in the successor is his word: the role's state goes, whatever the host's walk answers later.
  await fresh['command.run'](successor.dollar, supervisionRun)
  await fresh['ui.close'](successor.dollar, { id: 'supervision', origin: { kind: 'person' } }, (x: unknown) => x)
  expect((await successorStart(successor, 'Orch: belt')).opened).toEqual([])
})

test('a pane the module has no word about, with no close of his on record, is not opened: a missing, torn or foreign choice file opens nothing', async () => {
  for (const text of [undefined, '{ not json', '{"pane":"x"}', 'null', '{"pane":"open","at":"2026-11-15T07:00:00.000Z"}']) {
    const fx = coordinatorSession()
    if (text !== undefined) fx.files.set(CHOICE, text)
    await everyTrigger(fx)
    expect(fx.opened).toEqual([])
  }
})

test('the command and the tool answer as before in an orchestrator and a coordinator', async () => {
  const { handlers } = mounted(registerSupervision)
  const orch = fakeDollar({ launchName: 'Orch: belt' })
  orch.files.set(`${SESSIONS}/s-one`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: belt' })) + '\n')
  expect((await handlers['command.run'](orch.dollar, supervisionRun)).text).toContain('Supervision pane opened;')
  expect(await handlers['command.run'](orch.dollar, supervisionRun)).toEqual({ text: 'Supervision pane closed.' })
  const fx = coordinatorSession()
  expect((await handlers['command.run'](fx.dollar, supervisionRun)).text).toContain('Supervision pane opened;')
  expect(await handlers['tool.call'](fx.dollar, toolCall('close'))).toEqual({ result: 'Supervision pane closed.' })
  expect(await handlers['tool.call'](fx.dollar, toolCall('close'))).toEqual({ result: 'The supervision pane is not open.' })
  for (const session of [orch, fx]) expect([...session.files.keys()].some(path => path.includes('pane-choice'))).toBe(false)
})

test('with the pane closed by his word, the successor presents each due question in its tab', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  await handlers['command.run'](fx.dollar, supervisionRun)
  await handlers['command.run'](fx.dollar, supervisionRun)
  const asked = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(askedOf(asked)) + '\n')
  fx.files.set(`${SESSIONS}/${asked.session}`, JSON.stringify(row({ role: 'orchestrator', name: asked.from })) + '\n')
  const successor = successorOf(fx)
  await mounted(registerSupervision).handlers['turn.complete'](successor.dollar, firstTurn, (x: unknown) => x)
  expect(successor.opened).toEqual([])
  await successor.later.filter(t => t.ms === 30000)[0]!.fn()
  expect(successor.submitted.length).toBe(1)
  expect(successor.submitted[0]).toContain(asked.from)
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

test('a first turn that ends before the first measure wrote the row: the name is walked, the wake armed and no pane opened', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  fx.files.delete(`${SESSIONS}/s-one`)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.opened).toEqual([])
  expect(fx.later.filter(t => t.ms === 30000).length).toBe(1)
  // A row that names no role is read as it is: the session is no coordinator, nothing opens.
  const { handlers: other } = mounted(registerSupervision)
  const plain = coordinatorSession({ role: null })
  await other['turn.complete'](plain.dollar, firstTurn, (x: unknown) => x)
  expect(plain.opened).toEqual([])
})

test('a first turn that ends with no row in the store: the lookup names the coordinator, the wake is armed once and no pane opened', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  fx.files.delete(`${SESSIONS}/s-one`)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.ran.some(run => run.startsWith('ps -t ttys001'))).toBe(true)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.opened).toEqual([])
  expect(fx.later.filter(t => t.ms === 30000).length).toBe(1)
})

test('a coordinator recorded after the first turn: the wake is armed at the first turn end that finds it, and no pane opens', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession({ record: false })
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.later.filter(t => t.ms === 30000)).toEqual([])
  fx.files.set(RECORD, JSON.stringify({ name: 'Coord: main [abc]', tty: '/dev/ttys001' }))
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(fx.later.filter(t => t.ms === 30000).length).toBe(1)
  expect(fx.opened).toEqual([])
})

// --- the coordinator's pane, readable -----------------------------------------------------------

// An element of a drawn tree, as the fake's `ui.resolve` builds it: its component and its props,
// the ones the tests read named.
type El = { readonly type: string; readonly props: Props }
type Props = {
  readonly children?: unknown
  readonly key?: string
  readonly color?: string
  readonly bold?: boolean
  readonly dimColor?: boolean
  readonly position?: string
  readonly right?: number
  readonly top?: number
  readonly width?: number
  readonly href?: string
  readonly label?: string
  readonly value?: string
  readonly paddingLeft?: number
  readonly paddingRight?: number
  readonly paddingTop?: number
  readonly marginTop?: number
  readonly flexDirection?: string
  readonly flexGrow?: number
  readonly flexShrink?: number
  readonly autoFocus?: boolean
  readonly options?: readonly { readonly value: string; readonly label?: string }[]
  readonly onSelect?: (value: string) => unknown
  readonly onPress?: () => unknown
  readonly onSubmit?: (value: string) => unknown
  readonly [prop: string]: unknown
}
// A render's answer, the tree it drew.
function drawnTree(answer: unknown): El {
  return answer as El
}
const isEl = (node: unknown): node is El => typeof node === 'object' && node !== null && 'type' in node && 'props' in node
// An element's children as the elements they are, in their places.
function kidsOf(node: El): El[] {
  const children = node.props.children
  return (Array.isArray(children) ? children : [children]) as El[]
}
// The element at `path` under `node`, each step a child's index.
function elAt(node: El, ...path: number[]): El {
  return path.reduce((parent, index) => {
    const child = kidsOf(parent)[index]
    if (!isEl(child)) throw new Error(`no element at ${path.join('.')}`)
    return child
  }, node)
}
// An element's one text child.
function saidBy(node: El | undefined): string {
  const children = node?.props.children
  if (typeof children !== 'string') throw new Error('not a text element')
  return children
}

// A node's drawn pieces, depth first: the text, its colour and whether it is bold.
type Piece = { text: string; color?: string; bold: boolean }
function pieces(node: unknown): Piece[] {
  if (typeof node === 'string') return [{ text: node, bold: false }]
  if (!isEl(node)) return []
  const children = [node.props.children].flat().filter((kid: unknown) => kid !== undefined)
  if (node.type === 'Text' && children.every((kid: unknown) => typeof kid === 'string')) {
    const color = node.props.color
    return [{ text: children.join(''), ...(color === undefined ? {} : { color }), bold: node.props.bold === true }]
  }
  return children.flatMap(pieces)
}

const AGO = () => new Date(Date.now() - 3 * 60000).toISOString()
const SINCE = '2026-10-19T08:05:00.000Z'
const paneTree = async (rows: Record<string, SessionRow>, round: readonly { readonly id: string }[] = []) => {
  const fx = fakeDollar({ launchName: 'Coord: main' })
  for (const [key, value] of Object.entries(rows)) fx.files.set(`${SESSIONS}/${key}`, JSON.stringify(value) + '\n')
  for (const e of round) fx.files.set(`${ROUND}/${e.id}.json`, JSON.stringify(e) + '\n')
  return coordinatorRender(fx)
}
const orch = (name: string, over: Partial<SessionRow> = {}) => ({ ...row({ role: 'orchestrator', name, context_percent: 30, updated_at: AGO() }), ...over })

test('the coordinator\'s pane opens with a bold title above the orchestrator blocks, and says when there is none', async () => {
  const tree = await paneTree({ low: orch('Orch: low') })
  expect(pieces(elAt(tree, 1))).toEqual([{ text: 'Sessions', bold: true }])
  const empty = await paneTree({})
  expect(pieces(elAt(empty, 1))).toEqual([{ text: 'Sessions', bold: true }])
  expect(pieces(elAt(empty, 2))).toEqual([{ text: 'no live session', bold: false }])
})

const text = (nodes: { text: string }[]) => nodes.map(p => p.text).join('')

test('a plain orchestrator is one line: a dot, its bold name, then its figures in the normal colour', async () => {
  const tree = await paneTree({ low: orch('Orch: low') })
  const block = elAt(tree, 2)
  expect(kidsOf(block).length).toBe(1)
  expect(pieces(elAt(block, 0))).toEqual([
    { text: '●', color: 'suggestion', bold: false },
    { text: ' ', bold: false },
    { text: 'Orch: low', bold: true },
    { text: ' · orchestrator · ? · ? agents · ', bold: false },
    { text: '30%', bold: false },
    { text: ' · 3m', bold: false },
  ])
  expect(pieces(block).some(p => p.color === 'subtle')).toBe(false)
})

test('an orchestrator waiting for the operator draws a warning dot, a Status line and a Blocks line, both indented', async () => {
  const tree = await paneTree({ w: orch('Orch: w', { waiting: 'operator', waiting_since: SINCE, blocks: 'the merge' }) })
  const block = elAt(tree, 2)
  expect(kidsOf(block).length).toBe(3)
  expect(pieces(elAt(block, 0))[0]).toEqual({ text: '●', color: 'warning', bold: false })
  const [status, blocks] = [elAt(block, 1), elAt(block, 2)]
  expect(status.props.paddingLeft).toBe(2)
  expect(elAt(status, 0).props).toMatchObject({ width: 8, flexShrink: 0 })
  const [label, words] = pieces(status)
  expect(label).toEqual({ text: 'Status:', bold: false })
  expect(words?.color).toBe('warning')
  expect(words?.text).toMatch(/^waiting for the operator since \d\d:\d\d$/)
  expect(blocks.props.paddingLeft).toBe(2)
  expect(pieces(blocks)).toEqual([{ text: 'Blocks:', bold: false }, { text: 'the merge', bold: false }])
})

test('a long blocks text stays in a column of its own, wrapping under its first character and not under the label', async () => {
  const long = 'release out of draft and squash merge of geonative-api#1749, geonative-api#1751 and front-office#1545 (G2/G5 with #1751, G6 with #1749 + #1545)'
  const tree = await paneTree({ w: orch('Orch: w', { waiting: 'operator', waiting_since: SINCE, blocks: long }) })
  const line = elAt(tree, 2, 2)
  const [labelColumn, textColumn] = [elAt(line, 0), elAt(line, 1)]
  expect(line.props.flexDirection).toBe('row')
  expect(labelColumn.props.width).toBe(8)
  expect(labelColumn.props.flexShrink).toBe(0)
  expect(textColumn.props.flexGrow).toBe(1)
  expect(textColumn.props.flexShrink).toBe(1)
  expect(pieces(textColumn)).toEqual([{ text: long, bold: false }])
})

test('an operator wait that carries no blocks text says unsaid', async () => {
  const tree = await paneTree({ w: orch('Orch: w', { waiting: 'operator', waiting_since: SINCE }) })
  expect(pieces(elAt(tree, 2, 2))[1]?.text).toBe('unsaid')
})

test('a done orchestrator draws a success dot and one Status line in success, with no Blocks line', async () => {
  const tree = await paneTree({ d: orch('Orch: d', { waiting: 'done', waiting_since: SINCE }) })
  const block = elAt(tree, 2)
  expect(kidsOf(block).length).toBe(2)
  expect(pieces(elAt(block, 0))[0]).toEqual({ text: '●', color: 'success', bold: false })
  const [label, words] = pieces(elAt(block, 1))
  expect(label?.text).toBe('Status:')
  expect(words?.color).toBe('success')
  expect(words?.text).toMatch(/^done since \d\d:\d\d, proposes to be closed$/)
})

test('a row past the gate draws its fill and gate words in the error colour, the rest in the normal colour', async () => {
  const tree = await paneTree({ hot: orch('Orch: hot', { context_percent: 85, context_tokens: 85000 }) })
  expect(pieces(elAt(tree, 2, 0)).slice(3)).toEqual([
    { text: ' · orchestrator · ? · ? agents · ', bold: false },
    { text: '85% past the gate', color: 'error', bold: false },
    { text: ' · 3m', bold: false },
  ])
})

test('a remote orchestrator keeps its machine in its line', async () => {
  const tree = await paneTree({ r: orch('Orch: r', { machine: 'mini' }) })
  expect(text(pieces(elAt(tree, 2, 0)))).toBe('● Orch: r · orchestrator · remote mini · ? · ? agents · 30% · 3m')
})

test('one blank line separates two blocks', async () => {
  const tree = await paneTree({ a: orch('Orch: a', { context_percent: 40 }), b: orch('Orch: b') })
  const [first, second] = [elAt(tree, 2), elAt(tree, 3)]
  expect(first.props.marginTop).toBeUndefined()
  expect(second.props.marginTop).toBe(1)
  expect(pieces(elAt(first, 0))[2]?.text).toBe('Orch: a')
})

test('a done proposal is no question: no row stands out', async () => {
  const done = entry('Orch: d', '2026-10-18T10:03:00.000Z', { session: 'd', kind: 'done', blocks: null })
  const tree = await paneTree({ d: orch('Orch: d', { waiting: 'done', waiting_since: SINCE }) }, [done])
  const line = pieces(elAt(tree, 2, 0))
  expect(line.map(p => p.text)).toEqual(['●', ' ', 'Orch: d', ' · orchestrator · ? · ? agents · ', '30%', ' · 3m'])
  expect(line.some(p => p.bold && p.color === 'suggestion')).toBe(false)
})

test('no question: the section says none, or counts the orchestrators waiting when the round holds none', async () => {
  const none = await paneTree({ low: orch('Orch: low') })
  expect(pieces(elAt(none, 0))).toEqual([
    { text: 'Questions for you', color: 'suggestion', bold: true },
    { text: 'none', bold: false },
    { text: '─'.repeat(40), bold: false },
  ])
  const waits = { w1: orch('Orch: w1', { waiting: 'operator', waiting_since: SINCE }), w2: orch('Orch: w2', { waiting: 'operator', waiting_since: SINCE }), d: orch('Orch: d', { waiting: 'done', waiting_since: SINCE }) }
  const two = await paneTree(waits)
  expect(pieces(elAt(two, 0))[1]).toEqual({ text: 'none in the pane — 2 orchestrators wait for you: ask the coordinator', bold: false })
  const one = await paneTree({ w1: waits.w1 })
  expect(pieces(elAt(one, 0))[1]?.text).toBe('none in the pane — 1 orchestrator waits for you: ask the coordinator')
})

test('an orchestrator\'s own pane says no agent running in the default text colour, with no title', async () => {
  const fx = fakeDollar({ launchName: 'Orch: phase-3' })
  fx.env['ITERM_SESSION_ID'] = 'w0t1p0:OWNER-1'
  const tree = await coordinatorRender(fx)
  expect(kidsOf(tree).map(kid => [kid.props.color, kid.props.children])).toEqual([[undefined, 'no agent running']])
})

test('an orchestrator\'s own pane draws an agent past the gate in warning and the other in the default text colour, each name bold, with no title', async () => {
  const fx = fakeDollar({ launchName: 'Orch: phase-3' })
  fx.env['ITERM_SESSION_ID'] = 'w0t1p0:OWNER-1'
  fx.files.set(`${HOME}/.claude/claude-orchestrator/chains/ttys001.jsonl`, [
    JSON.stringify({ tab_id: 't-9', tty: '/dev/ttys009', owner: 'OWNER-1' }),
    JSON.stringify({ tab_id: 't-10', tty: '/dev/ttys010', owner: 'OWNER-1' }),
  ].join('\n') + '\n')
  // The fake's ps answers one pid for every agent's tty: each tab gets a pid of its own.
  const run = fx.dollar.process.run
  fx.dollar.process.run = async (argv: readonly string[]) =>
    argv[0] === 'ps' && argv[2] === 'ttys010' ? { exitCode: 0, stdout: '  778 hostcli\n', stderr: '' } : run(argv)
  fx.files.set(`${HOME}/.claude/sessions/777.json`, JSON.stringify({ sessionId: 's-past', name: 'Agent: past', status: 'busy' }))
  fx.files.set(`${HOME}/.claude/sessions/778.json`, JSON.stringify({ sessionId: 's-under', name: 'Agent: under', status: 'busy' }))
  fx.files.set(`${SESSIONS}/s-past`, JSON.stringify(row({ role: 'agent', name: 'Agent: past', context_percent: 35, context_tokens: 350000, window: 1000000 })) + '\n')
  fx.files.set(`${SESSIONS}/s-under`, JSON.stringify(row({ role: 'agent', name: 'Agent: under', context_percent: 20 })) + '\n')
  const tree = await coordinatorRender(fx)
  const [past, under] = [pieces(elAt(tree, 0)), pieces(elAt(tree, 1))]
  expect(past.map(p => p.text).join('')).toMatch(/^Agent: past · busy · 35% past the gate · /)
  expect(past.every(p => p.color === 'warning')).toBe(true)
  expect(past.filter(p => p.bold).map(p => p.text)).toEqual(['Agent: past'])
  expect(under.map(p => p.text).join('')).toMatch(/^Agent: under · busy · 20% · /)
  expect(under.some(p => p.color !== undefined)).toBe(false)
  expect(under.filter(p => p.bold).map(p => p.text)).toEqual(['Agent: under'])
})

// --- answering from the coordinator's pane ------------------------------------------------------

// Every element of a tree whose props match, depth first.
function findAll(node: unknown, match: (node: El) => boolean): El[] {
  if (!isEl(node)) return []
  const kids = [node.props.children].flat().filter((kid: unknown) => kid !== undefined)
  return [...(match(node) ? [node] : []), ...kids.flatMap(kid => findAll(kid, match))]
}
// The first element of a tree that matches; none fails the test.
function firstOf(tree: unknown, match: (node: El) => boolean): El {
  const found = findAll(tree, match)[0]
  if (found === undefined) throw new Error('no such element')
  return found
}
const button = (tree: unknown, key: string) => firstOf(tree, n => n.type === 'Button' && n.props.key === key)
const picker = (tree: unknown) => firstOf(tree, n => n.type === 'Select')
const pick = (tree: unknown, value: string) => picker(tree).props.onSelect!(value)
const texts = (tree: unknown) => findAll(tree, n => n.type === 'Text' && typeof n.props.children === 'string').map(n => n.props.children as string)
// A tree's rows as the terminal shows them, each cleared of the card's border and of the spaces
// around its words.
const shown = (tree: El, width = 200) => drawScreen(tree, width).map(line => line.replace(/^[│ ]+|[│ ]+$/g, ''))

// A coordinator with one live orchestrator asking, its send recorded (or refused), its pane drawn.
async function askingPane(asked: RoundEntry[], over: { refuse?: string; throws?: string; surface?: string } = {}) {
  const fx = fakeDollar({ launchName: 'Coord: main' })
  fx.files.set(`${SESSIONS}/low`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: low', context_percent: 30 })) + '\n')
  for (const e of asked) fx.files.set(`${ROUND}/${e.id}.json`, JSON.stringify(e) + '\n')
  const sent: { to: unknown; text: string }[] = []
  fx.dollar.session.send = async (args: { to: unknown; text: string }) => {
    sent.push(args)
    if (over.throws) throw new Error(over.throws)
    return over.refuse ? { isDelivered: false, reason: over.refuse } : { isDelivered: true }
  }
  const { handlers } = mounted(registerSupervision)
  await handlers['command.run'](fx.dollar, supervisionRun)
  const render = async (props: object = {}) => drawnTree(await handlers['ui.render'](fx.dollar, { ...renderEvent, props, surface: over.surface ?? 'terminal' }, (x: unknown) => ({ passed: x })))
  const stored = (id: string) => JSON.parse(String(fx.files.get(`${ROUND}/${id}.json`))) as RoundEntry
  // The pane's ring moved onto `element`, or off its elements when absent, by the operator.
  const ring = (element?: string) => handlers['ui.focus'](fx.dollar,
    { component: 'Pane', requestId: 'supervision', ...(element ? { plugin: 'orchestrator', element } : {}), origin: { kind: 'person' } },
    () => ({}))
  return { fx, sent, render, stored, ring, handlers }
}

// A question asked with `ask` (question.ts), as the tool stores it.
const askedObject = (session: string, name: string, at: string, over: Record<string, unknown> = {}) => ({
  v: 2, id: `q-${session}-${at.replace(/\D/g, '')}`, sender: { session, name, role: 'orchestrator', machine: 'box-1' },
  subject: 'merge order', context: 'Two pull requests touch one file.', ask: 'Which merges first?',
  choices: [{ letter: 'A', text: 'acme/app#1 first' }, { letter: 'B', text: 'acme/app#2 first' }], recommended: 'A', why: 'no rebase',
  blocks: 'acme/app#1', status: 'open', at, answer: null, seq: 1, ...over,
})

test('the pane draws the first question asked with ask from its fields, its asker once, and counts all of them', async () => {
  const { fx, render } = await askingPane([])
  const first = askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z')
  const second = askedObject('low', 'Orch: low', '2026-10-18T10:05:00.000Z', { subject: 'tag order', choices: [], recommended: null, why: null })
  for (const asked of [first, second]) fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(asked) + '\n')
  const tree = await render()
  const drawn = texts(tree)
  expect(drawn).toContain('Questions for you — 2 pending')
  expect(drawn.filter(t => t === 'Orch: low · orchestrator · box-1')).toEqual(['Orch: low · orchestrator · box-1'])
  const lines = shown(tree)
  const at = (text: string) => lines.findIndex(line => line.includes(text))
  expect(['merge order', 'Two pull requests touch one file.', 'Which merges first?', '[A] acme/app#1 first  ★', '[B] acme/app#2 first', '★ Recommendation: A — no rebase', 'Blocks: acme/app#1']
    .map(at).every((index, i, all) => index > 0 && (i === 0 || index > all[i - 1]!))).toBe(true)
  expect(at('tag order')).toBe(-1)
  expect(lines.some(line => /Question \d of \d/.test(line))).toBe(false)
})

test('a question asked with ask alone takes the place of the none line, and one whose asker has no live row is not drawn', async () => {
  const { fx, render } = await askingPane([])
  fx.files.set(`${ROUND}/q-low.json`, JSON.stringify(askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z')) + '\n')
  fx.files.set(`${ROUND}/q-gone.json`, JSON.stringify(askedObject('gone', 'Orch: gone', '2026-10-18T10:03:00.000Z')) + '\n')
  fx.files.set(`${ROUND}/q-done.json`, JSON.stringify(askedObject('low', 'Orch: low', '2026-10-18T10:02:00.000Z', { status: 'answered', subject: 'settled' })) + '\n')
  const drawn = texts(await render())
  expect(drawn).toContain('Questions for you — 1 pending')
  expect(drawn).toContain('Orch: low · orchestrator · box-1')
  expect(drawn.some(t => t.includes('Orch: gone') || t.includes('settled'))).toBe(false)
  expect(drawn).not.toContain('none')
  // The rows the pane counts for its window are the rows it draws.
  expect(await countedRows(render)).toBe(drawScreen(await render({ bodyColumns: 200 }), 198).length)
})

test('beside questions asked with ask alone, the section still counts the orchestrators waiting with none drawn, never the asker the pane draws', async () => {
  const rows = { low: orch('Orch: low', { waiting: 'operator', waiting_since: SINCE }), w1: orch('Orch: w1', { waiting: 'operator', waiting_since: SINCE }) }
  const asked = askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z')
  const drawn = texts(await paneTree(rows, [asked]))
  expect(drawn).toContain('1 orchestrator waits for you: ask the coordinator')
  expect(drawn).toContain('Orch: low · orchestrator · box-1')
  const alone = texts(await paneTree({ low: rows.low }, [asked]))
  expect(alone.some(t => /waits? for you/.test(t) || t === 'none')).toBe(false)
})

// A question asked with `ask` alone in the pane is answered there, its controls under its own lines.
async function askedPane(objects: Record<string, unknown>[], over: { refuse?: string; surface?: string } = {}) {
  const pane = await askingPane([], over)
  for (const object of objects) pane.fx.files.set(`${ROUND}/${String(object['id'])}.json`, JSON.stringify(object) + '\n')
  return pane
}

test('with no card, the first question asked with ask takes a picker under its own lines, its asker line kept', async () => {
  const first = askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z')
  const second = askedObject('low', 'Orch: low', '2026-10-18T10:05:00.000Z', { subject: 'tag order' })
  const { render, fx } = await askedPane([first, second])
  const tree = await render()
  expect(texts(tree)).toContain('Orch: low · orchestrator · box-1')
  expect(findAll(tree, n => n.type === 'Select').length).toBe(1)
  expect(picker(tree).props.options!.map(o => o.value)).toEqual(['A', 'B', 'other'])
  expect(picker(tree).props.value).toBe('A')
  const lines = shown(tree)
  const at = (text: string) => lines.findIndex(line => line.includes(text))
  expect(at('Blocks: acme/app#1')).toBeLessThan(at('Choose: A (recommended)'))
  expect(at('tag order')).toBe(-1)
  expect(lines.some(line => line.startsWith('arrows: move') || line.includes('Enter: choose'))).toBe(true)
  expect(fx.focused.map(f => f.key)).toContain(`choices:${first.id}`)
  expect(await countedRows(render)).toBe(drawScreen(await render({ bodyColumns: 200 }), 198).length)
})

test('a pick on a question asked with ask answers it by the pane, sends its asker the answer once, and draws the next', async () => {
  const first = askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z')
  const second = askedObject('low', 'Orch: low', '2026-10-18T10:05:00.000Z', { subject: 'tag order' })
  const { fx, sent, render } = await askedPane([first, second])
  fx.files.set(`${SESSIONS}/s-one`, JSON.stringify(row({ role: 'coordinator', name: 'Coord: main', context_percent: 10 })) + '\n')
  await pick(await render(), 'B')
  const stored = JSON.parse(String(fx.files.get(`${ROUND}/${first.id}.json`)))
  expect(stored.status).toBe('answered')
  expect(stored.seq).toBe(2)
  expect(stored.answer).toEqual({ text: 'B : acme/app#2 first', by: 'pane', at: stored.answer.at, settler: 'Coord: main' })
  expect(stored.delivery).toMatchObject({ state: 'delivered', attempts: 1 })
  expect(sent).toEqual([{ to: { sessionId: 'low' }, text: `[module] The operator answered your question ${first.id} « merge order » (blocks: acme/app#1) through Coord: main at ${stored.answer.at} — B : acme/app#2 first` }])
  const after = await render()
  expect(texts(after)).toContain('Questions for you — 1 pending')
  expect(picker(after).props.key).toBe(`choices:${second.id}`)
})

test('three open questions from two askers, the later asker\'s one urgent: the urgent one is drawn alone, its chooser answers it, then the earliest of the rest is drawn', async () => {
  const early = askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z', { subject: 'early one' })
  const urgent = askedObject('high', 'Orch: high', '2026-10-18T10:05:00.000Z', { subject: 'urgent one', urgent: true })
  const late = askedObject('low', 'Orch: low', '2026-10-18T10:06:00.000Z', { subject: 'late one' })
  const { fx, sent, render } = await askedPane([early, urgent, late])
  fx.files.set(`${SESSIONS}/high`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: high', context_percent: 10 })) + '\n')
  fx.files.set(`${SESSIONS}/s-one`, JSON.stringify(row({ role: 'coordinator', name: 'Coord: main', context_percent: 10 })) + '\n')
  const subjects = (tree: El) => shown(tree).filter(line => /one$/.test(line) && !line.startsWith('Orch:'))
  const askers = (tree: El) => shown(tree).filter(line => line.startsWith('Orch:') && line.includes(' · orchestrator · box-1'))
  const first = await render()
  expect(texts(first)).toContain('Questions for you — 3 pending')
  expect(subjects(first)).toEqual(['Urgent — urgent one'])
  expect(askers(first)).toEqual(['Orch: high · orchestrator · box-1'])
  expect(picker(first).props.key).toBe(`choices:${urgent.id}`)
  await pick(first, 'B')
  expect(JSON.parse(String(fx.files.get(`${ROUND}/${urgent.id}.json`))).status).toBe('answered')
  expect(sent.map(message => message.to)).toEqual([{ sessionId: 'high' }])
  for (const stays of [early, late]) expect(JSON.parse(String(fx.files.get(`${ROUND}/${stays.id}.json`))).status).toBe('open')
  const next = await render()
  expect(texts(next)).toContain('Questions for you — 2 pending')
  expect(subjects(next)).toEqual(['early one'])
  expect(askers(next)).toEqual(['Orch: low · orchestrator · box-1'])
  expect(picker(next).props.key).toBe(`choices:${early.id}`)
})

test('the Other answer of a question asked with ask is its field once picked, its words the answer; an empty field sends nothing', async () => {
  const first = askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z')
  const { fx, sent, render } = await askedPane([first])
  expect(findAll(await render(), n => n.type === 'Input').length).toBe(0)
  await pick(await render(), 'other')
  const field = input(await render())
  expect(field.props).toMatchObject({ key: `answer:${first.id}`, label: 'Other answer', rows: 4 })
  await field.props.onSubmit!('   ')
  expect(sent).toEqual([])
  await field.props.onSubmit!('  neither, merge both  ')
  expect(JSON.parse(String(fx.files.get(`${ROUND}/${first.id}.json`))).answer.text).toBe('neither, merge both')
  expect(sent.length).toBe(1)
})

// The host's terminal field wraps its text, and places its caret, at the pane's whole width less
// its label and its hint, whatever space the boxes around it take: a field drawn indented by four
// columns had lines four columns wider than its room, which the host cut with « … », its caret
// rows below at the column of a line it did not draw (the operator's report of 2026-11-18).
const sideOf = (path: El[], side: 'Left' | 'Right') => path.reduce((sum, el) => {
  const p = el.props
  return sum + Number(p[`padding${side}`] ?? p['paddingX'] ?? p['padding'] ?? 0) + Number(p[`margin${side}`] ?? p['marginX'] ?? p['margin'] ?? 0)
}, 0)
function pathTo(node: unknown, match: (node: El) => boolean): El[] | null {
  if (!isEl(node)) return null
  if (match(node)) return [node]
  for (const kid of [node.props.children].flat()) {
    const found = pathTo(kid, match)
    if (found) return [node, ...found]
  }
  return null
}

test('the Other answer field is drawn across the pane\'s whole width, the width the host wraps it at', async () => {
  const first = askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z')
  const { render } = await askedPane([first])
  await pick(await render(), 'other')
  const path = pathTo(await render(), n => n.type === 'Input')!
  expect([sideOf(path, 'Left'), sideOf(path, 'Right')]).toEqual([0, 0])
  // A window shorter than the tree draws its track in a right margin of its own: not beside the
  // field, which would lose those columns, nor over its hint. The key line stays pinned.
  await shortWindowKeepsTheKeyLine(render)
})

async function shortWindowKeepsTheKeyLine(render: (props?: object) => Promise<El>): Promise<void> {
  const short = await render({ scroll: { offset: 0, bodyRows: 6 }, bodyColumns: 80 })
  const shortPath = pathTo(short, n => n.type === 'Input')!
  expect([sideOf(shortPath, 'Left'), sideOf(shortPath, 'Right')]).toEqual([0, 0])
  const overlays = kidsOf(short).filter(k => isEl(k) && k.props.position === 'absolute')
  expect(overlays.filter(k => k.props.right === 0)).toEqual([])
  const pinned = overlays.filter(k => k.props['left'] === 0)
  expect(pinned.length).toBe(1)
  expect(texts(pinned[0]).join(' ')).toContain('Enter')
}

// The host brings a field that takes the ring into view by moving the window itself, and tells
// the module nothing of that move: the pane is drawn again once it has, so the key line is pinned
// at the window's new top.
test('the field taking the ring draws the pane again once the host has moved the window to it', async () => {
  const first = askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z', { choices: [], recommended: null, why: null })
  const { fx, render, ring } = await askedPane([first])
  await render()
  fx.later.length = 0
  fx.invalidated.length = 0
  await ring(`answer:${first.id}`)
  expect(fx.invalidated).toEqual([])
  for (const timer of fx.later) timer.fn()
  expect(fx.invalidated).toEqual(['ui.render'])
  fx.later.length = 0
  await ring(`choices:${first.id}`)
  for (const timer of fx.later) timer.fn()
  expect(fx.invalidated).toEqual(['ui.render'])
})

test('a question without choices, its field drawn at once, keeps its key line pinned in a short window, with no track', async () => {
  const first = askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z', { choices: [], recommended: null, why: null })
  const { render } = await askedPane([first])
  await shortWindowKeepsTheKeyLine(render)
})

test('a question asked with ask without choices takes the field at once', async () => {
  const first = askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z', { choices: [], recommended: null, why: null })
  const { render } = await askedPane([first])
  const tree = await render()
  expect(findAll(tree, n => n.type === 'Select').length).toBe(0)
  expect(input(tree).props.key).toBe(`answer:${first.id}`)
})

test('on a surface without a picker, a question asked with ask takes a Button per choice', async () => {
  const first = askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z')
  const { fx, sent, render } = await askedPane([first], { surface: 'mobile' })
  const tree = await render()
  expect(button(tree, 'choice:A').props.label).toBe('[A] acme/app#1 first  ★')
  await button(tree, 'choice:A').props.onPress!()
  expect(JSON.parse(String(fx.files.get(`${ROUND}/${first.id}.json`))).answer.text).toBe('A : acme/app#1 first')
  expect(sent.length).toBe(1)
})

test('a pick on a question asked with ask settled or claimed meanwhile writes and sends nothing', async () => {
  for (const over of [{ status: 'withdrawn' }, { claimed: { typed: 'B', at: '2026-10-18T10:06:00.000Z' } }]) {
    const first = askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z')
    const { fx, sent, render } = await askedPane([first])
    const drawn = await render()
    fx.files.set(`${ROUND}/${first.id}.json`, JSON.stringify({ ...first, ...over }) + '\n')
    await pick(drawn, 'A')
    expect(JSON.parse(String(fx.files.get(`${ROUND}/${first.id}.json`))).answer).toBeNull()
    expect(sent).toEqual([])
  }
})

test('the pane\'s answer writes no consent file: a consent rests on his quoted, dated words', async () => {
  const first = askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z', { choices: [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }] })
  const { fx, render } = await askedPane([first])
  await pick(await render(), 'A')
  expect([...fx.files.keys()].filter(p => p.startsWith(`${HOME}/.claude/consents/`))).toEqual([])
})

test('an answer to a question asked with ask not delivered is written failed on it and said in the pane while its asker has a row', async () => {
  const first = askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z')
  const { fx, render } = await askedPane([first], { refuse: 'nobody by that name' })
  await pick(await render(), 'A')
  expect(JSON.parse(String(fx.files.get(`${ROUND}/${first.id}.json`))).delivery).toMatchObject({ state: 'failed', reason: 'nobody by that name' })
  expect(texts(await render())).toContain('not delivered: nobody by that name — the answer to Orch: low (blocks: acme/app#1)')
  fx.files.delete(`${SESSIONS}/low`)
  expect(texts(await render()).some(t => t.startsWith('not delivered:'))).toBe(false)
})

test('the coordinator shown a question asked with ask is told in its own session once the pane answers it; one never shown, nothing', async () => {
  const shown = askedObject('low', 'Orch: low', '2026-10-18T10:04:00.000Z')
  const unseen = askedObject('low', 'Orch: low', '2026-10-18T10:05:00.000Z', { subject: 'tag order' })
  const { fx, render } = await askedPane([shown, unseen])
  fx.files.set(LISTED, JSON.stringify([shown.id]) + '\n')
  await pick(await render(), 'A')
  const answeredAt = JSON.parse(String(fx.files.get(`${ROUND}/${shown.id}.json`))).answer.at
  expect(fx.submitted).toEqual([`[module] Settled in the pane: Orch: low's question since ${shown.at} (entry ${shown.id}) — answered at ${answeredAt}. Already closed: drop it, never ask or relay it again, present the next.`])
  await pick(await render(), 'B')
  expect(fx.submitted.length).toBe(1)
})

// The pane is the coordinator's own session: a question it asked itself is reached by no message
// (« no live session … has id »), so the answer is submitted to its own turn, and that one prompt
// tells it settled, shown or not.
test('a pick on a question the pane\'s own session asked submits the answer to that session, sends no message, and draws no « not delivered »', async () => {
  const own = askedObject('s-one', 'Coord: main', '2026-10-18T10:04:00.000Z')
  const { fx, sent, render } = await askedPane([own], { refuse: 'no live session has id s-one' })
  fx.files.set(`${SESSIONS}/s-one`, JSON.stringify(row({ role: 'coordinator', name: 'Coord: main', context_percent: 10 })) + '\n')
  fx.files.set(LISTED, JSON.stringify([own.id]) + '\n')
  await pick(await render(), 'B')
  const stored = JSON.parse(String(fx.files.get(`${ROUND}/${own.id}.json`)))
  expect(stored).toMatchObject({ status: 'answered', answer: { text: 'B : acme/app#2 first', by: 'pane' }, delivery: { state: 'delivered', attempts: 1 } })
  expect(sent).toEqual([])
  expect(fx.submitted).toEqual([`[module] The operator answered your question ${own.id} « merge order » (blocks: acme/app#1) through Coord: main at ${stored.answer.at} — B : acme/app#2 first`])
  expect(texts(await render()).some(t => t.startsWith('not delivered:'))).toBe(false)
})


// --- the selector ---------------------------------------------------------------------------

const input = (tree: unknown) => firstOf(tree, n => n.type === 'Input')

test('the first draw of a question requests the focus on its picker and brings it into view once drawn, a redraw nothing more', async () => {
  const asked = askedObject('low', 'Orch: low', '2026-10-18T10:03:00.000Z')
  const { fx, render } = await askedPane([asked])
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

test('without a recommendation the picker starts on the first choice, and a new question asks the focus again', async () => {
  const first = askedObject('low', 'Orch: low', '2026-10-18T10:03:00.000Z', { recommended: null, why: null })
  const second = askedObject('low', 'Orch: low', '2026-10-18T10:05:00.000Z', { subject: 'tag order', recommended: 'B' })
  const { fx, render } = await askedPane([first, second])
  const tree = await render()
  expect(fx.focused).toEqual([{ requestId: 'supervision', key: `choices:${first.id}` }])
  expect(picker(tree).props.value).toBe('A')
  await pick(tree, 'A')
  const next = await render()
  expect(picker(next).props).toMatchObject({ key: `choices:${second.id}`, value: 'B' })
  expect(fx.focused).toEqual([{ requestId: 'supervision', key: `choices:${first.id}` }, { requestId: 'supervision', key: `choices:${second.id}` }])
})

test('the window the module moves itself is drawn again, so the track and the key line follow it', async () => {
  const asked = askedObject('low', 'Orch: low', '2026-10-18T10:03:00.000Z')
  const { fx, render } = await askedPane([asked])
  await render({ scroll: { offset: 0, bodyRows: 8 }, bodyColumns: 50 })
  fx.invalidated.length = 0
  // The host tells no `ui.scroll` for a plugin's own move: only a draw after it reads the new offset.
  for (const timer of fx.later) timer.fn()
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(fx.scrolled.length).toBe(1)
  expect(fx.invalidated).toEqual(['ui.render'])
})

test('a refused or failing focus or scroll request never blocks the draw', async () => {
  const asked = askedObject('low', 'Orch: low', '2026-10-18T10:03:00.000Z')
  const { fx, render } = await askedPane([asked])
  fx.dollar.ui.focus = async () => { throw new Error('refused') }
  fx.dollar.ui.scroll = () => { throw new Error('refused') }
  expect(picker(await render())).toBeDefined()
  for (const timer of fx.later) timer.fn()
})

// The fake host's screen draws an Input on one row whatever its `rows`, so the pane's own count
// is read from where its scroll track appears: the fewest window rows that need none.
async function countedRows(render: (props?: object) => Promise<El>, bodyColumns = 200): Promise<number> {
  for (let bodyRows = 1; bodyRows < 400; bodyRows++) {
    const tree = await render({ scroll: { offset: 0, bodyRows }, bodyColumns })
    if (kidsOf(tree).every(k => k.props?.position !== 'absolute')) return bodyRows
  }
  throw new Error('the pane never fits')
}

test('the footer says how keys reach the selector, and names no letter where none answers', async () => {
  const asked = askedObject('low', 'Orch: low', '2026-10-18T10:03:00.000Z')
  const { render } = await askedPane([asked])
  const footer = texts(await render()).at(-1)!
  for (const part of ['ctrl+x tab', 'a click', 'arrows', 'Enter', 'Esc']) expect(footer).toContain(part)
  expect(footer).not.toContain('a letter')
  const mobile = await askedPane([asked], { surface: 'mobile' })
  const tapped = texts(await mobile.render()).at(-1)!
  for (const part of ['ctrl+x tab', 'arrows or Tab', 'Enter', 'a letter', 'Esc']) expect(tapped).toContain(part)
})

// The operator's report of 2026-10-25: « A » from the pane at 21:10:00Z, then the same « A »
// relayed again from the coordinator's tab, which had presented the question. An entry the
// coordinator was shown, listed by its `round` or woken for, is settled in its tab at once.
const LISTED = `${HOME}/.claude/claude-orchestrator/round-listed.json`
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

test('the pane he opened is recorded; an orchestrator\'s pane and another session\'s record are left alone', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(JSON.parse(String(fx.files.get(PANE_FILE))).session).toBe('s-one')
  const other = JSON.stringify({ session: 's-two', pid: '777', at: '2026-10-24T10:00:00.000Z' }) + '\n'
  fx.files.set(PANE_FILE, other)
  await handlers['session.end'](fx.dollar, endEvent, (x: unknown) => x)
  expect(fx.files.get(PANE_FILE)).toBe(other)
  const orch = fakeDollar({ launchName: 'Orch: belt' })
  await mounted(registerSupervision).handlers['command.run'](orch.dollar, supervisionRun)
  expect(orch.files.has(PANE_FILE)).toBe(false)
})

const minutesAgo = (n: number) => new Date(Date.now() - n * 60000).toISOString()

// A coordinator whose round holds `asked`, each sender live, its pane open by its first turn,
// or closed by the command before it: the wake's clock is armed by the turn's end.
// An operator question as this release stores it, an object of `ask`: the entry's id, sender,
// start, what it blocks, its status, urgency and move kept; a closing proposal stays the relay's
// entry. The relay writes no operator entry, and the round's wake withdraws one left.
function askedOf(e: RoundEntry) {
  if (e.kind !== 'operator') return e
  return askedObject(e.session, e.from, e.since, {
    id: e.id, blocks: e.blocks ?? '', status: e.status,
    ...(e.urgent ? { urgent: true } : {}), ...(e.movedFrom !== undefined ? { movedFrom: e.movedFrom } : {}),
  })
}

async function wakingCoordinator(asked: RoundEntry[], over: { paneClosed?: boolean } = {}) {
  const fx = coordinatorSession()
  for (const e of asked) {
    fx.files.set(`${ROUND}/${e.id}.json`, JSON.stringify(askedOf(e)) + '\n')
    fx.files.set(`${SESSIONS}/${e.session}`, JSON.stringify(row({ role: 'orchestrator', name: e.from })) + '\n')
  }
  const { handlers } = mounted(registerSupervision)
  // The pane is open by his word, unless the test leaves it closed.
  if (!over.paneClosed) await handlers['command.run'](fx.dollar, supervisionRun)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  const tick = async () => {
    const armed = fx.later.filter(t => t.ms === 30000)
    await armed[armed.length - 1]!.fn()
  }
  return { fx, handlers, tick }
}

test('a due question wakes the coordinator once: with the pane open only an urgent one, however old the others, never one answered', async () => {
  const urgent = entry('Orch: a', minutesAgo(1), { session: 'sa', urgent: true })
  const old = entry('Orch: b', minutesAgo(90), { session: 'sb' })
  const young = entry('Orch: c', minutesAgo(1), { session: 'sc' })
  const answered = entry('Orch: d', minutesAgo(30), { session: 'sd', status: 'answered', urgent: true })
  const done = entry('Orch: e', minutesAgo(30), { session: 'se', kind: 'done', blocks: null })
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
  fx.files.set(`${ROUND}/${young.id}.json`, JSON.stringify(askedOf({ ...young, urgent: true })) + '\n')
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

test('questions recorded while no pane is open, one already presented in the tab, are drawn one at a time when the pane opens', async () => {
  const { fx, handlers, tick } = await wakingCoordinator([], { paneClosed: true })
  const plant = (asked: ReturnType<typeof askedObject>) => {
    fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(asked) + '\n')
    fx.files.set(`${SESSIONS}/${asked.sender.session}`, JSON.stringify(row({ role: 'orchestrator', name: asked.sender.name })) + '\n')
  }
  const presented = askedObject('sa', 'Orch: a', minutesAgo(5), { ask: 'Ship the first?' })
  plant(presented)
  await tick()
  expect(fx.submitted.length).toBe(1)
  expect(fx.submitted[0]).toContain('Orch: a')
  const later = askedObject('sb', 'Orch: b', minutesAgo(1), { ask: 'Ship the second?' })
  plant(later)
  expect(fx.files.has(PANE_FILE)).toBe(false)
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(fx.files.has(PANE_FILE)).toBe(true)
  const tree = drawnTree(await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x })))
  expect(elAt(tree, 0, 0).props.children).toBe('Questions for you — 2 pending')
  expect(JSON.stringify(tree)).toContain('Ship the first?')
  expect(JSON.stringify(tree)).not.toContain('Ship the second?')
  expect(JSON.parse(String(fx.files.get(`${ROUND}/${presented.id}.json`))).status).toBe('open')
  // The controls are the drawn question's: answering it draws the never-presented one.
  await pick(tree, 'A')
  const next = await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x }))
  expect(JSON.stringify(next)).toContain('Questions for you — 1 pending')
  expect(JSON.stringify(next)).toContain('Ship the second?')
})

test('a question the coordinator asked itself never wakes it; an orchestrator\'s beside it does', async () => {
  const theirs = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const { fx, tick } = await wakingCoordinator([theirs], { paneClosed: true })
  const own = entry('Coord: main', minutesAgo(2), { session: 's-one', blocks: 'its own ruling' })
  fx.files.set(`${ROUND}/${own.id}.json`, JSON.stringify(askedOf(own)) + '\n')
  await tick()
  expect(fx.submitted.length).toBe(1)
  expect(fx.submitted[0]).toContain('Orch: a')
  expect(fx.submitted[0]).not.toContain('its own ruling')
  await tick()
  expect(fx.submitted.length).toBe(1)
})

test('with the pane closed every open question is due at once; one answered in the pane before it is due wakes nothing', async () => {
  const fresh = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const { fx, tick } = await wakingCoordinator([fresh], { paneClosed: true })
  expect(fx.files.has(PANE_FILE)).toBe(false)
  await tick()
  expect(fx.submitted.length).toBe(1)
  expect(fx.submitted[0]).toContain(fresh.from)
  // One fixed start: the entry's id carries its minute, and two readings of the clock may straddle one.
  const asked = entry('Orch: b', '2026-10-24T11:59:00.000Z', { session: 'sb' })
  const quiet = await wakingCoordinator([asked])
  const settled = asked
  quiet.fx.files.set(`${ROUND}/${settled.id}.json`, JSON.stringify(askedOf({ ...settled, since: minutesAgo(20), status: 'answered' })) + '\n')
  await quiet.tick()
  expect(quiet.fx.submitted).toEqual([])
})

test('a question whose sender has ended wakes nothing, and a session that is no coordinator arms no wake', async () => {
  const fx = coordinatorSession()
  const gone = entry('Orch: gone', minutesAgo(30), { session: 'sg', urgent: true })
  fx.files.set(`${ROUND}/${gone.id}.json`, JSON.stringify(gone) + '\n')
  const { handlers } = mounted(registerSupervision)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  await fx.later.filter(t => t.ms === 30000)[0]!.fn()
  expect(fx.submitted).toEqual([])
  const orch = fakeDollar({ launchName: 'Orch: belt' })
  orch.files.set(`${SESSIONS}/s-one`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: belt' })) + '\n')
  await mounted(registerSupervision).handlers['turn.complete'](orch.dollar, firstTurn, (x: unknown) => x)
  expect(orch.later.filter(t => t.ms === 30000)).toEqual([])
})

test('the pane opened by his word, on a row that carries no pid, records the pid its walk reads and its tty, never none', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  await handlers['command.run'](fx.dollar, supervisionRun)
  const record = JSON.parse(String(fx.files.get(PANE_FILE)))
  expect([record.pid, record.tty]).toEqual(['501', '/dev/ttys001'])
})

test('a wake the host refuses or that fails is not recorded, and the next reading wakes for it', async () => {
  const urgent = entry('Orch: a', minutesAgo(1), { session: 'sa', urgent: true })
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
  const urgent = entry('Orch: a', minutesAgo(1), { session: 'sa', urgent: true })
  const { fx, tick } = await wakingCoordinator([urgent])
  await tick()
  expect(fx.submitted.length).toBe(1)
  const next = coordinatorSession()
  for (const [path, text] of fx.files) next.files.set(path, text)
  await mounted(registerSupervision).handlers['turn.complete'](next.dollar, firstTurn, (x: unknown) => x)
  await next.later.filter(t => t.ms === 30000)[0]!.fn()
  expect(next.submitted).toEqual([])
})

test('an entry another session was woken for between the reading and the wake is not woken for again', async () => {
  const urgent = entry('Orch: a', minutesAgo(1), { session: 'sa', urgent: true })
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
  const urgent = entry('Orch: a', minutesAgo(1), { session: 'sa', urgent: true })
  const fx = coordinatorSession()
  fx.files.set(`${ROUND}/${urgent.id}.json`, JSON.stringify(askedOf(urgent)) + '\n')
  fx.files.set(`${SESSIONS}/sa`, JSON.stringify(row({ role: 'orchestrator', name: urgent.from })) + '\n')
  const { handlers } = mounted(registerSupervision)
  const start = mounted(registerWake).handlers
  const wakes = () => fx.later.filter(t => t.ms === 30000)
  const wake = (i: number) => wakes()[i]!
  expect(await start['session.start'](fx.dollar, startEvent, (x: unknown) => x)).toBe(startEvent)
  expect(wakes().length).toBe(1)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  await start['session.start'](fx.dollar, startEvent, (x: unknown) => x)
  expect(wakes().length).toBe(1)
  await wake(0).fn()
  expect([fx.submitted.length, wakes().length]).toEqual([1, 2])
  // A reading already fired, run again, is no chain of its own: it arms nothing.
  await wake(0).fn()
  expect(wakes().length).toBe(2)
  await handlers['session.end'](fx.dollar, endEvent, (x: unknown) => x)
  expect(wake(1).cancelled).toBe(true)
  await wake(1).fn()
  expect(wakes().length).toBe(2)
  // No coordinator, no wake at the start.
  const orch = fakeDollar({ launchName: 'Orch: belt' })
  await mounted(registerWake).handlers['session.start'](orch.dollar, startEvent, (x: unknown) => x)
  expect(orch.later.filter(t => t.ms === 30000)).toEqual([])
})

// A session whose name walk cannot answer in time (a loaded machine: the operator's report of
// 2026-11-21, a successor coordinator never woken for twenty minutes): its round sender live, one
// open question, no pane open in its tab. `over` is the fake's own, so a test lets the walk answer.
function untoldSession(launchName: string, asked: RoundEntry | null) {
  const over = { launchName, hangWalk: true }
  const fx = fakeDollar(over)
  fx.env['ORCHESTRATOR_SIDE_READ_MS'] = '50'
  fx.files.set(RECORD, JSON.stringify({ name: 'Coord: main [abc]', tty: '/dev/ttys001' }))
  if (asked) {
    fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(askedOf(asked)) + '\n')
    fx.files.set(`${SESSIONS}/${asked.session}`, JSON.stringify(row({ role: 'orchestrator', name: asked.from })) + '\n')
  }
  const wakes = () => fx.later.filter(t => t.ms === 30000)
  return { fx, over, wakes }
}

test('a coordinator whose start and first turn end are told nothing in time is woken once its walk answers, once', async () => {
  const asked = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const { fx, over, wakes } = untoldSession('Coord: main', asked)
  // The supervision first: its register starts the round's wake memory afresh.
  const { handlers } = mounted(registerSupervision)
  await mounted(registerWake).handlers['session.start'](fx.dollar, startEvent, (x: unknown) => x)
  // The first measure's walk did not answer either: its row names no one (session.measure).
  fx.files.set(`${SESSIONS}/s-one`, JSON.stringify(row({ role: null, name: null })) + '\n')
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  expect(wakes().length).toBe(1)
  expect(fx.written.filter(l => l.includes('not told yet whether this session is the coordinator')).length).toBe(2)
  // Still untold: the reading reads no round and asks again.
  await wakes()[0]!.fn()
  expect([fx.submitted.length, wakes().length]).toEqual([0, 2])
  over.hangWalk = false
  await wakes()[1]!.fn()
  expect(fx.submitted.length).toBe(1)
  expect(fx.submitted[0]).toContain('now due in this tab')
  expect(fx.submitted[0]).toContain(asked.from)
  await wakes()[2]!.fn()
  expect(fx.submitted.length).toBe(1)
  expect(fx.opened).toEqual([])
})

test('a pane the host closed at its session\'s end leaves the successor\'s questions due: it is woken for them once its walk answers', async () => {
  const asked = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const { handlers } = mounted(registerSupervision)
  const predecessor = coordinatorSession()
  predecessor.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(askedOf(asked)) + '\n')
  predecessor.files.set(`${SESSIONS}/sa`, JSON.stringify(row({ role: 'orchestrator', name: asked.from })) + '\n')
  await handlers['command.run'](predecessor.dollar, supervisionRun)
  expect(predecessor.files.has(PANE_FILE)).toBe(true)
  await endedByHost(predecessor, handlers)
  expect(predecessor.files.has(PANE_FILE)).toBe(false)
  // The successor: the machine's files as the predecessor left them, its own row gone with its end.
  const { fx, over, wakes } = untoldSession('Coord: main', null)
  for (const [path, text] of predecessor.files) fx.files.set(path, text)
  const fresh = mounted(registerSupervision).handlers
  await mounted(registerWake).handlers['session.start'](fx.dollar, startEvent, (x: unknown) => x)
  await fresh['turn.start'](fx.dollar, { turnId: 't' }, (x: unknown) => x)
  await fresh['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  // Its walk did not answer: the pane its role left open is not put back.
  expect(fx.opened).toEqual([])
  expect(wakes().length).toBe(1)
  await wakes()[0]!.fn()
  expect(fx.submitted).toEqual([])
  over.hangWalk = false
  await wakes()[1]!.fn()
  expect(fx.submitted.length).toBe(1)
  expect(fx.submitted[0]).toContain('now due in this tab')
  expect(JSON.parse(String(fx.files.get(WOKEN_FILE)))).toEqual([asked.id])
})

test('a session told nothing at its start arms one reading, which reads no round and ends once its row names it no coordinator', async () => {
  const asked = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const { fx, wakes } = untoldSession('Agent: x', asked)
  mounted(registerSupervision)
  await mounted(registerWake).handlers['session.start'](fx.dollar, startEvent, (x: unknown) => x)
  expect(wakes().length).toBe(1)
  fx.files.set(`${SESSIONS}/s-one`, JSON.stringify(row({ role: 'agent', name: 'Agent: x' })) + '\n')
  await wakes()[0]!.fn()
  expect([wakes().length, fx.submitted.length]).toEqual([1, 0])
  expect(fx.files.has(WOKEN_FILE)).toBe(false)
})

test('a coordinator a turn end told is not asked again: its reading reads the round though its row then names no one', async () => {
  const asked = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const { fx, over, wakes } = untoldSession('Coord: main', asked)
  const { handlers } = mounted(registerSupervision)
  await mounted(registerWake).handlers['session.start'](fx.dollar, startEvent, (x: unknown) => x)
  over.hangWalk = false
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  // Asked now, this session would be untold, and its reading would read nothing.
  over.hangWalk = true
  fx.files.set(`${SESSIONS}/s-one`, JSON.stringify(row({ role: null, name: null })) + '\n')
  await wakes()[0]!.fn()
  expect(fx.submitted.length).toBe(1)
  expect(fx.submitted[0]).toContain('now due in this tab')
})

test('a session end forgets that the session was told: a start after it, not told, is asked again and reads no round', async () => {
  const asked = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const { fx, over, wakes } = untoldSession('Coord: main', asked)
  const { handlers } = mounted(registerSupervision)
  const start = mounted(registerWake).handlers['session.start']
  over.hangWalk = false
  await start(fx.dollar, startEvent, (x: unknown) => x)
  await handlers['session.end'](fx.dollar, endEvent, (x: unknown) => x)
  // The next session of this module, an agent whose start is not told in time.
  over.launchName = 'Agent: x'
  over.hangWalk = true
  await start(fx.dollar, startEvent, (x: unknown) => x)
  fx.files.set(`${SESSIONS}/s-one`, JSON.stringify(row({ role: 'agent', name: 'Agent: x' })) + '\n')
  const live = wakes().filter(t => !t.cancelled)
  expect(live.length).toBe(1)
  await live[0]!.fn()
  expect(fx.submitted).toEqual([])
})

test('a session that ends while its reading asks what it is reads no round and arms no next reading', async () => {
  const asked = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const { fx, wakes } = untoldSession('Coord: main', asked)
  const { handlers } = mounted(registerSupervision)
  await mounted(registerWake).handlers['session.start'](fx.dollar, startEvent, (x: unknown) => x)
  // Its row now names it the coordinator; the walk for its pid hangs, so the ask is still running
  // when the session ends.
  fx.files.set(`${SESSIONS}/s-one`, JSON.stringify(row({ role: 'coordinator', name: 'Coord: main' })) + '\n')
  const reading = wakes()[0]!.fn()
  await handlers['session.end'](fx.dollar, endEvent, (x: unknown) => x)
  await reading
  expect([fx.submitted.length, wakes().length]).toEqual([0, 1])
})

test('a pane record whose pid is not running, or that names none, is no pane; another session\'s live one is', async () => {
  const young = entry('Orch: a', minutesAgo(1), { session: 'sa' })
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

// The record of a pane left open in the files while no pane is shown: his tab or the session it was
// opened in is gone, the pane with it, and `coordinator.sh round` must not read it as open.
const staleRecord = (over: object = {}) => JSON.stringify({ session: 's-one', pid: '501', tty: '/dev/ttys001', at: '2026-10-24T10:00:00.000Z', ...over }) + '\n'

test('a record that says open while the host shows no pane holds nothing back: the wake presents the question and the record goes', async () => {
  const young = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const { fx, tick } = await wakingCoordinator([young], { paneClosed: true })
  // The pane went with no close of the module's: the host's, and its record stayed.
  fx.files.set(PANE_FILE, staleRecord())
  await tick()
  expect(fx.submitted.length).toBe(1)
  expect(fx.files.has(PANE_FILE)).toBe(false)
  expect(fx.written.some(l => l.includes('the record said open while the host shows no pane'))).toBe(true)
})

test('the record of the same host under another session id, a clear that gave it a new one, is judged and removed too', async () => {
  const young = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const { fx, tick } = await wakingCoordinator([young], { paneClosed: true })
  fx.files.set(PANE_FILE, staleRecord({ session: 's-before-the-clear' }))
  await tick()
  expect(fx.submitted.length).toBe(1)
  expect(fx.files.has(PANE_FILE)).toBe(false)
})

test('a record whose pane the host shows, or that another coordinator wrote, is left as it is', async () => {
  const young = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const shown = await wakingCoordinator([young])
  await shown.tick()
  expect(shown.fx.submitted).toEqual([])
  expect(shown.fx.files.has(PANE_FILE)).toBe(true)
  const other = await wakingCoordinator([young], { paneClosed: true })
  other.fx.files.set(PANE_FILE, staleRecord({ session: 's-two', pid: '777', tty: null }))
  await other.tick()
  expect(other.fx.submitted).toEqual([])
  expect(other.fx.files.has(PANE_FILE)).toBe(true)
})

test('a host the machine lists as exiting or a zombie, or on another tty than the record\'s, is no pane: its tab is gone', async () => {
  const young = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const listed = async (listing: string) => {
    // The pane is shown and its record is the command's: only the machine's listing judges it.
    const woken = await wakingCoordinator([young])
    const run = woken.fx.dollar.process.run
    woken.fx.dollar.process.run = async (argv: readonly string[], init?: object) =>
      argv[0] === 'ps' && argv[1] === '-A' ? { exitCode: 0, stdout: listing, stderr: '' } : run(argv, init)
    await woken.tick()
    return woken.fx.submitted.length
  }
  for (const listing of ['  501 ?Es ??\n', '  501 Z ttys001\n', '  501 Ss ttys009\n']) expect(await listed(listing)).toBe(1)
  // The same host running on the record's tty is a pane.
  expect(await listed('  501 Ss ttys001\n')).toBe(0)
})

test('a record of this session is dropped whatever pid it names, and one that cannot be removed is said', async () => {
  const young = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const { fx, tick } = await wakingCoordinator([young], { paneClosed: true })
  fx.files.set(PANE_FILE, staleRecord({ pid: '9999' }))
  await tick()
  expect(fx.files.has(PANE_FILE)).toBe(false)
  const stuck = await wakingCoordinator([young], { paneClosed: true })
  stuck.fx.files.set(PANE_FILE, staleRecord())
  const run = stuck.fx.dollar.process.run
  stuck.fx.dollar.process.run = async (argv: readonly string[], init?: object) =>
    argv[0] === 'rm' ? { exitCode: 1, stdout: '', stderr: 'denied' } : run(argv, init)
  await stuck.tick()
  expect(stuck.fx.files.has(PANE_FILE)).toBe(true)
  expect(stuck.fx.written.some(l => l.includes('could not be removed'))).toBe(true)
  expect(stuck.fx.written.some(l => l.includes('removed') && l.includes('said open'))).toBe(false)
})

test('a record rewritten by an open while the reconciliation ran is the pane\'s and stays', async () => {
  const { fx, handlers } = await wakingCoordinator([], { paneClosed: true })
  fx.files.set(PANE_FILE, staleRecord())
  const panes = fx.dollar.ui.panes
  fx.dollar.ui.panes = async () => {
    const shown = await panes()
    fx.files.set(PANE_FILE, staleRecord({ at: '2026-11-15T09:00:00.000Z' }))
    return shown
  }
  await handlers['turn.start'](fx.dollar, { turnId: 't' }, (x: unknown) => x)
  expect(JSON.parse(String(fx.files.get(PANE_FILE))).at).toBe('2026-11-15T09:00:00.000Z')
})

test('a turn that starts, and a start, drop the record of a pane that is gone before the round is read', async () => {
  const { fx, handlers } = await wakingCoordinator([], { paneClosed: true })
  for (const at of ['turn.start', 'session.start']) {
    fx.files.set(PANE_FILE, staleRecord())
    if (at === 'turn.start') await handlers['turn.start'](fx.dollar, { turnId: 't' }, (x: unknown) => x)
    else await mounted(registerWake).handlers['session.start'](fx.dollar, startEvent, (x: unknown) => x)
    expect(fx.files.has(PANE_FILE)).toBe(false)
  }
  // A host that cannot say which panes it shows leaves the record: unknown is not closed.
  fx.files.set(PANE_FILE, staleRecord())
  fx.dollar.ui.panes = async () => { throw new Error('no answer') }
  await handlers['turn.start'](fx.dollar, { turnId: 't' }, (x: unknown) => x)
  expect(fx.files.has(PANE_FILE)).toBe(true)
  expect(fx.written.some(l => l.includes('the record could not be checked'))).toBe(true)
})

// --- the record follows the pane the host shows ---------------------------------------------------

const KEPT_OPEN = `${HOME}/.claude/claude-orchestrator/pane-open-Coord__main`
const OWN_PANE = ['s-one', '501', '/dev/ttys001']
const recorded = (fx: Fx): unknown[] => {
  const record = JSON.parse(String(fx.files.get(PANE_FILE) ?? '{}'))
  return [record.session, record.pid, record.tty]
}
const logged = (fx: Fx, words: string): boolean => fx.written.some(l => l.includes(words))

// Two successors of one name started together: each put the pane back and wrote the one record, and
// the one that withdrew removed it at its end, as its own. The other's pane stayed on screen.
test('a pane put back at startup whose record a twin wrote over and removed at its end is recorded again before anything is due', async () => {
  const fx = coordinatorSession()
  fx.files.set(KEPT_OPEN, 'open\n')
  const asked = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(askedOf(asked)) + '\n')
  fx.files.set(`${SESSIONS}/${asked.session}`, JSON.stringify(row({ role: 'orchestrator', name: asked.from })) + '\n')
  const { handlers } = mounted(registerSupervision)
  await handlers['turn.start'](fx.dollar, { turnId: 't' }, (x: unknown) => x)
  expect(recorded(fx)).toEqual(OWN_PANE)
  await handlers['turn.complete'](fx.dollar, firstTurn, (x: unknown) => x)
  // The twin's record over this one, then its end: no file is left.
  fx.files.delete(PANE_FILE)
  await fx.later.filter(t => t.ms === 30000)[0]!.fn()
  expect(fx.submitted).toEqual([])
  expect(recorded(fx)).toEqual(OWN_PANE)
  expect(logged(fx, 'pane: recorded open')).toBe(true)
})

test('a shown pane under another session\'s dead record, a twin killed with no end, is recorded again and holds its questions', async () => {
  const young = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const { fx, tick } = await wakingCoordinator([young])
  fx.files.set(PANE_FILE, staleRecord({ session: 's-two', pid: '999' }))
  await tick()
  expect(fx.submitted).toEqual([])
  expect(recorded(fx)).toEqual(OWN_PANE)
})

test('open on a pane already shown writes its record again when it is missing or no live one, answers that it is open, and leaves a live one', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  await handlers['tool.call'](fx.dollar, toolCall('open'))
  for (const left of [undefined, '{ torn', staleRecord({ pid: '999' }), staleRecord({ session: 's-two', pid: '999' })]) {
    if (left === undefined) fx.files.delete(PANE_FILE)
    else fx.files.set(PANE_FILE, left)
    expect(await handlers['tool.call'](fx.dollar, toolCall('open'))).toEqual({ result: 'The supervision pane is already open.' })
    expect(recorded(fx)).toEqual(OWN_PANE)
  }
  const live = staleRecord({ session: 's-two', pid: '777', tty: null })
  fx.files.set(PANE_FILE, live)
  await handlers['tool.call'](fx.dollar, toolCall('open'))
  expect(fx.files.get(PANE_FILE)).toBe(live)
  expect(fx.opened.length).toBe(1)
})

test('the wake leaves another live session\'s record over a pane this one shows', async () => {
  const young = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const { fx, tick } = await wakingCoordinator([young])
  const live = staleRecord({ session: 's-two', pid: '777', tty: null })
  fx.files.set(PANE_FILE, live)
  await tick()
  expect(fx.files.get(PANE_FILE)).toBe(live)
})

// The machine's listing as it fails: a call that rejects, a non-zero exit, a listing with no pid.
const FAILED_LISTINGS: readonly [string, () => Promise<{ exitCode: number; stdout: string; stderr: string }>][] = [
  ['rejects', async () => { throw new Error('timed out') }],
  ['exits 1', async () => ({ exitCode: 1, stdout: '', stderr: 'denied' })],
  ['lists no pid', async () => ({ exitCode: 0, stdout: '', stderr: '' })],
]

for (const [how, listing] of FAILED_LISTINGS) {
  test(`a listing that ${how} leaves another session's record over a shown pane, at the wake, a turn's start and the tool's open; one that needs no listing is written again`, async () => {
    const { fx, handlers, tick } = await wakingCoordinator([])
    const run = fx.dollar.process.run
    fx.dollar.process.run = async (argv: readonly string[], init?: object) =>
      argv[0] === 'ps' && argv[1] === '-A' ? listing() : run(argv, init)
    const theirs = staleRecord({ session: 's-two', pid: '777', tty: null })
    for (const read of [
      () => tick(),
      () => handlers['turn.start'](fx.dollar, { turnId: 't' }, (x: unknown) => x),
      () => handlers['tool.call'](fx.dollar, toolCall('open')),
    ]) {
      fx.files.set(PANE_FILE, theirs)
      await read()
      expect(fx.files.get(PANE_FILE)).toBe(theirs)
    }
    // No record, a torn one, one naming no pid: nothing to ask the listing.
    for (const left of [undefined, '{ torn', staleRecord({ session: 's-two', pid: null })]) {
      for (const read of [() => tick(), () => handlers['tool.call'](fx.dollar, toolCall('open'))]) {
        if (left === undefined) fx.files.delete(PANE_FILE)
        else fx.files.set(PANE_FILE, left)
        await read()
        expect(recorded(fx)).toEqual(OWN_PANE)
      }
    }
  })
}

test('a pane the host still shows when the module starts over is taken back: drawn, its clock running, recorded, not opened twice', async () => {
  const fx = coordinatorSession()
  fx.files.set(KEPT_OPEN, 'open\n')
  await fx.dollar.ui.open({ id: 'supervision' })
  const { handlers } = mounted(registerSupervision)
  await handlers['turn.start'](fx.dollar, { turnId: 't' }, (x: unknown) => x)
  expect(recorded(fx)).toEqual(OWN_PANE)
  expect(fx.opened.length).toBe(1)
  expect(fx.timers.map(t => t.ms)).toEqual([2000])
  const drawn = JSON.stringify(await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x })))
  expect(drawn).toContain('Sessions')
  expect(drawn).not.toContain('to open the pane again')
})

test('the record\'s removal is said, and nothing writes it again for a pane closed or for an orchestrator\'s', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = coordinatorSession()
  await handlers['command.run'](fx.dollar, supervisionRun)
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect(logged(fx, 'pane: the record removed')).toBe(true)
  await handlers['turn.start'](fx.dollar, { turnId: 't' }, (x: unknown) => x)
  expect(fx.files.has(PANE_FILE)).toBe(false)
  const orch = fakeDollar({ launchName: 'Orch: belt' })
  const theirs = mounted(registerSupervision).handlers
  await theirs['command.run'](orch.dollar, supervisionRun)
  await theirs['turn.start'](orch.dollar, { turnId: 't' }, (x: unknown) => x)
  await theirs['tool.call'](orch.dollar, toolCall('open'))
  expect(orch.files.has(PANE_FILE)).toBe(false)
})

// --- one readable block -----------------------------------------------------------------------

test('the questions are drawn first, above the orchestrators, the title counting them once', async () => {
  const asked = ['merge order', 'tag order', 'release order'].map((subject, i) => askedObject('low', 'Orch: low', `2026-10-18T10:0${i + 3}:00.000Z`, { subject }))
  const { render } = await askedPane(asked)
  const tree = await render()
  const [section, title] = [elAt(tree, 0), elAt(tree, 1)]
  expect(elAt(section, 0).props.children).toBe('Questions for you — 3 pending')
  expect(title.props.children).toBe('Sessions')
  expect(JSON.stringify(tree).split('pending').length - 1).toBe(1)
})

test('answers not delivered are one line at the section\'s foot, below the next question, never above it', async () => {
  const asked = ['merge order', 'tag order', 'release order'].map((subject, i) => askedObject('low', 'Orch: low', `2026-10-18T10:0${i + 3}:00.000Z`, { subject }))
  const { render } = await askedPane(asked, { refuse: 'nobody by that name' })
  await pick(await render(), 'A')
  await pick(await render(), 'B')
  const kids = kidsOf(elAt(await render(), 0))
  const notices = kids.filter(k => k.type === 'Text' && String(k.props.children).startsWith('not delivered:'))
  expect(notices.length).toBe(1)
  expect(saidBy(notices[0]).split(' · ').length).toBe(2)
  expect(kids.at(-2)).toBe(notices[0])
  expect(texts(kids[1])[0]).toBe('Orch: low · orchestrator · box-1')
})

test('once the pane holds the keys the key line no longer says how to give them, and it is dim', async () => {
  const { render } = await askedPane([askedObject('low', 'Orch: low', '2026-10-18T10:03:00.000Z')])
  const keys = kidsOf(await render({ isFocused: true })).at(-1)!
  expect(keys.props.children).toBe('arrows: move · Enter: choose · Esc: back to the prompt')
  expect(keys.props.dimColor).toBe(true)
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
  const { render, handlers, fx } = await askedPane([askedObject('low', 'Orch: low', '2026-10-18T10:03:00.000Z')])
  const props = { scroll: { offset: 0, bodyRows: 8 }, bodyColumns: 50 }
  const counted = kidsOf(await render(props)).find(k => k.props?.position === 'absolute' && k.props.right === 0)!
  expect(kidsOf(counted).length).toBe(8)
  let moved = false
  await handlers['ui.scroll'](fx.dollar, { component: 'Pane', requestId: 'supervision', offset: 1, by: 1, bodyRows: 8, contentRows: 80, origin: { kind: 'person' } }, () => { moved = true; return {} })
  expect(moved).toBe(true)
  const thumb = (tree: El) => kidsOf(kidsOf(tree).find(k => k.props?.position === 'absolute' && k.props.right === 0)!).filter(t => t.props.children === '█').length
  expect(thumb(await render(props))).toBe(1)
  // Other content drawn: the measure was of the old one, and the module counts again.
  expect(thumb(await render({ ...props, isFocused: true }))).toBeGreaterThan(1)
  // A tree that fits draws no track.
  const fits = await render({ scroll: { offset: 0, bodyRows: 200 }, bodyColumns: 50 })
  expect(kidsOf(fits).filter(k => k.props?.position === 'absolute')).toEqual([])
  expect(fits.props.paddingRight).toBeUndefined()
})

test('over a tree taller than its window, the track and the key line are drawn at the window\'s rows and follow it, the content kept clear of both', async () => {
  const { render } = await askedPane([askedObject('low', 'Orch: low', '2026-10-18T10:03:00.000Z', { context: 'Two pull requests touch one file. '.repeat(20).trim() })])
  const at = async (offset: number) => {
    const tree = await render({ scroll: { offset, bodyRows: 12 }, bodyColumns: 50 })
    const absolute = kidsOf(tree).filter(k => k.props?.position === 'absolute')
    return { tree, track: absolute[0]!, keys: absolute[1]! }
  }
  const top = await at(0)
  expect(top.tree.props.paddingRight).toBe(2)
  expect(top.track.props).toMatchObject({ top: 0, right: 0, width: 1 })
  expect(kidsOf(top.track).length).toBe(12)
  expect(elAt(top.track, 0).props.children).toBe('█')
  expect(elAt(top.track, 11).props.children).toBe('│')
  const rows = kidsOf(top.keys).length
  expect(rows).toBe(wrapWords('ctrl+x tab or a click: give the pane the keys · arrows: move · Enter: choose · Esc: back to the prompt', 48).length)
  expect(top.tree.props.paddingTop).toBe(rows)
  expect(top.keys.props).toMatchObject({ top: 0, left: 0, width: 48 })
  expect(kidsOf(top.keys).every(t => saidBy(t).length === 48 && t.props.dimColor === true)).toBe(true)
  expect(kidsOf(top.keys).map(t => saidBy(t).trimEnd()).join(' ')).toContain('Enter: choose')
  // The key line is pinned: not drawn a second time in the flow.
  expect(texts(top.tree).filter(t => t.includes('Enter: choose')).length).toBe(1)
  const down = await at(28)
  expect(down.track.props.top).toBe(28)
  expect(down.keys.props.top).toBe(28)
  expect(elAt(down.track, 11).props.children).toBe('█')
  expect(elAt(down.track, 0).props.children).toBe('│')
})

test('the pane opens asking the keys, so its picker answers at once over an empty prompt', async () => {
  const { handlers } = mounted(registerSupervision)
  const fx = fakeDollar({ launchName: 'Coord: main' })
  await handlers['command.run'](fx.dollar, supervisionRun)
  expect((fx.opened[0] as { focus?: boolean }).focus).toBe(true)
})

test('the rows the module counts are the rows the tree draws: a track exactly when they pass the window', async () => {
  // At 200 columns nothing wraps: the window that holds every drawn row needs no track, one row less does.
  const { render } = await askedPane([askedObject('low', 'Orch: low', '2026-10-18T10:03:00.000Z')])
  const rows = drawScreen(await render({ bodyColumns: 200 }), 198).length
  const track = async (bodyRows: number) => kidsOf(await render({ scroll: { offset: 0, bodyRows }, bodyColumns: 200 }))
    .filter(k => k.props?.position === 'absolute').length
  expect(await track(rows)).toBe(0)
  expect(await track(rows - 1)).toBe(2)
})

// --- one question at a time -----------------------------------------------------------------

// --- the references to a pull request --------------------------------------------------------

const links = (tree: El) => findAll(tree, n => n.type === 'Link').map(n => [n.props.children, n.props.href])

test('each pull request a blocks text names is a link of its own, a glued pair two links', async () => {
  const tree = await paneTree({
    w: orch('Orch: w', { waiting: 'operator', waiting_since: SINCE, blocks: GLUED_BLOCKS }),
    i: orch('Orch: i', { repo: 'acme/infra' }),
    g: orch('Orch: g', { repo: 'acme/geo-git-flow' }),
  })
  expect(links(tree)).toEqual([
    ['infra#195', 'https://github.com/acme/infra/pull/195'],
    ['infra#196', 'https://github.com/acme/infra/pull/196'],
    ['geo-git-flow#21', 'https://github.com/acme/geo-git-flow/pull/21'],
    ['geo-git-flow#22', 'https://github.com/acme/geo-git-flow/pull/22'],
  ])
  // The text reads as it was written, the slash between the two links plain.
  const blocks = findAll(tree, n => n.type === 'Box' && n.props.flexDirection === 'row' && n.props.paddingLeft === 2).at(-1)!
  expect(textOf(elAt(blocks, 1))).toBe(GLUED_BLOCKS)
})

test('a reference whose owner the module does not know stays plain text', async () => {
  const tree = await paneTree({ w: orch('Orch: w', { waiting: 'operator', waiting_since: SINCE, blocks: GLUED_BLOCKS }), i: orch('Orch: i', { repo: 'acme/infra' }) })
  expect(links(tree).map(([words]) => words)).toEqual(['infra#195', 'infra#196'])
  expect(texts(tree).some(t => t.includes('geo-git-flow#21/geo-git-flow#22'))).toBe(true)
  expect(links(await paneTree({ w: orch('Orch: w', { waiting: 'operator', waiting_since: SINCE, blocks: GLUED_BLOCKS }) }))).toEqual([])
})

// The host tells nothing of a surface's hyperlinks: where one is not drawn, it writes the URL after
// the link's text. The module counts that case, the longer one, so its track is never short.
function withUrls(node: El): El
function withUrls(node: unknown): unknown
function withUrls(node: unknown): unknown {
  if (!isEl(node)) return node
  if (node.type === 'Link') return { type: 'Text', props: { children: `${textOf(node)} ${String(node.props.href)}` } }
  const kids = node.props.children
  return { ...node, props: { ...node.props, ...(kids === undefined ? {} : { children: Array.isArray(kids) ? kids.map(kid => withUrls(kid)) : withUrls(kids) }) } }
}

test('at 60 columns the rows counted for a text of links are the rows drawn where the URL is written after each', async () => {
  const { fx, render } = await askingPane([])
  for (const [key, value] of Object.entries({
    w: orch('Orch: w', { waiting: 'operator', waiting_since: SINCE, blocks: GLUED_BLOCKS }),
    i: orch('Orch: i', { repo: 'acme/infra' }),
    g: orch('Orch: g', { repo: 'acme/geo-git-flow' }),
  })) fx.files.set(`${SESSIONS}/${key}`, JSON.stringify(value) + '\n')
  const rows = drawScreen(withUrls(await render({ bodyColumns: 60 })), 58).length
  expect(rows).toBeGreaterThan(drawScreen(await render({ bodyColumns: 60 }), 58).length)
  const track = async (bodyRows: number) => kidsOf(await render({ scroll: { offset: 0, bodyRows }, bodyColumns: 60 }))
    .filter(k => k.props?.position === 'absolute' && k.props.right === 0).length
  expect(await track(rows)).toBe(0)
  expect(await track(rows - 1)).toBe(1)
})

test('a dim rule line, the pane\'s width wide, stands between the questions and the orchestrators', async () => {
  for (const [props, width] of [[{}, 40], [{ bodyColumns: 60 }, 58]] as const) {
    const { render } = await askingPane([entry('Orch: low', '2026-10-18T10:03:00.000Z', { session: 'low', choices: CHOICES, recommendation: 'B' })])
    const tree = await render(props)
    const [section, heading] = [elAt(tree, 0), elAt(tree, 1)]
    const rule = kidsOf(section).at(-1)!
    expect(rule.props.marginTop).toBe(1)
    expect(rule.props.children).toHaveLength(1)
    expect(elAt(rule, 0).props).toMatchObject({ dimColor: true, wrap: 'truncate-end', children: '─'.repeat(width) })
    expect(texts(heading)).toEqual(['Sessions'])
  }
})

// --- a remote orchestrator's question, drawn and answered from the pane -----------------------

const REMOTE_DIR = `${HOME}/.claude/claude-orchestrator/store/remote`
const FAR = 'uds:/tmp/cc-socks/far.sock'
const remoteEntry = (over: Partial<RoundEntry> = {}) => entry('Orch: belt', '2026-10-30T10:03:00.000Z', {
  session: 's-far', choices: CHOICES, recommendation: 'A', origin: { machine: 'far', address: FAR }, ...over,
})
// The remote row of `name` measured on `machine`, as the coordinator's module stores it.
function remoteRow(fx: Fx, name: string, machine: string, updatedAt = new Date().toISOString()) {
  fx.files.set(`${REMOTE_DIR}/${name.replace(/[^A-Za-z0-9._-]/g, '_')}`, JSON.stringify({
    name, role: 'orchestrator', context_tokens: 1, context_percent: 30, window: 100, waiting: 'operator', blocks: 'phase 3',
    waiting_since: '2026-10-30T10:03:00.000Z', updated_at: updatedAt, machine, repo: null, prs: [],
  }) + '\n')
}

test('a replica of a question asked with ask on another machine is drawn only while a live remote row of its asker was measured on that machine', async () => {
  const replica = askedObject('s-far', 'Orch: belt', '2026-10-30T10:04:00.000Z', { origin: { machine: 'far', address: FAR } })
  const { fx, render } = await askedPane([replica])
  const drawnNow = async () => texts(await render())
  // No remote row: not drawn, not counted.
  expect((await drawnNow()).some(t => t === 'Orch: belt · orchestrator · box-1' || t.startsWith('Questions for you —'))).toBe(false)
  // A row of its asker's name measured on another machine: still not drawn.
  remoteRow(fx, 'Orch: belt', 'near')
  expect((await drawnNow()).some(t => t === 'Orch: belt · orchestrator · box-1' || t.startsWith('Questions for you —'))).toBe(false)
  remoteRow(fx, 'Orch: belt', 'far')
  const drawn = await drawnNow()
  expect(drawn).toContain('Questions for you — 1 pending')
  expect(drawn).toContain('Orch: belt · orchestrator · box-1')
  // Answered here, on its way to its owner: said being delivered, then not delivered once the owner says it settled it first.
  const answered = { ...replica, status: 'answered', answer: { text: 'A : acme/app#1 first', by: 'pane', at: '2026-10-30T10:05:00.000Z', settler: 'Coord: main' } }
  fx.files.set(`${ROUND}/${replica.id}.json`, JSON.stringify({ ...answered, delivery: { state: 'sent', at: '2026-10-30T10:05:00.000Z', attempts: 1 } }) + '\n')
  expect(await drawnNow()).toContain('being delivered: the answer to Orch: belt on far (blocks: acme/app#1) — sent 1 of 3, not acknowledged yet')
  fx.files.set(`${ROUND}/${replica.id}.json`, JSON.stringify({ ...answered, delivery: { state: 'failed', at: '2026-10-30T10:05:00.000Z', attempts: 1, reason: 'already answered in its own tab' } }) + '\n')
  expect(await drawnNow()).toContain('not delivered: already answered in its own tab — the answer to Orch: belt on far (blocks: acme/app#1)')
  // Withdrawn by its sender afterwards: nobody waits for that answer any more, so no notice stays drawn.
  fx.files.set(`${ROUND}/${replica.id}.json`, JSON.stringify({ ...replica, status: 'withdrawn', answer: { text: 'merged it myself', by: 'sender', at: '2026-10-30T10:06:00.000Z', settler: 'Orch: belt' }, delivery: { state: 'failed', at: '2026-10-30T10:05:00.000Z', attempts: 1, reason: 'already answered in its own tab' } }) + '\n')
  expect((await drawnNow()).some(t => t.startsWith('not delivered:'))).toBe(false)
  // Withdrawn here by the coordinator, its withdrawal never acknowledged: its asker still waits, so it stays drawn.
  fx.files.set(`${ROUND}/${replica.id}.json`, JSON.stringify({ ...replica, status: 'withdrawn', answer: { text: 'moot', by: 'coordinator', at: '2026-10-30T10:06:00.000Z', settler: 'Coord: main' }, delivery: { state: 'failed', at: '2026-10-30T10:06:00.000Z', attempts: 3, reason: 'no acknowledgment after 3 sends' } }) + '\n')
  expect(await drawnNow()).toContain('not delivered: no acknowledgment after 3 sends — the answer to Orch: belt on far (blocks: acme/app#1)')
})

// A replica whose answer given here failed after its sends, its asker's row measured on its machine.
const failedReplica = () => askedObject('s-far', 'Orch: belt', '2026-10-30T10:04:00.000Z', {
  origin: { machine: 'far', address: FAR }, status: 'answered',
  answer: { text: 'A : acme/app#1 first', by: 'pane', at: '2026-10-30T10:05:00.000Z', settler: 'Coord: main' },
  delivery: { state: 'failed', at: '2026-10-30T10:06:00.000Z', attempts: 3, reason: 'no acknowledgment after 3 sends' },
})
const LISTED_ANEW = ['This session is Coord: main [abc] — the name other sessions use to message it', '', 'Peer sessions (1):',
  '  Orch: belt [ref-live]  ·  Remote Control  ·  idle'].join('\n')
const NOT_DELIVERED = 'not delivered: no acknowledgment after 3 sends — the answer to Orch: belt on far (blocks: acme/app#1)'

test('a failed answer sent again is said sent again to its asker, and is drawn no more once delivered', async () => {
  const replica = failedReplica()
  const { fx, sent, render } = await askedPane([replica])
  remoteRow(fx, 'Orch: belt', 'far')
  fx.dollar.tool.call = async () => ({ text: LISTED_ANEW })
  const drawnNow = async () => texts(await render())
  expect(await drawnNow()).toContain(NOT_DELIVERED)
  await resendReplies(fx.dollar)
  expect(sent.map(s => s.to)).toEqual(['Orch: belt [ref-live]'])
  const during = await drawnNow()
  expect(during).toContain('being delivered: the answer to Orch: belt on far (blocks: acme/app#1) — sent again to Orch: belt, 1 of 3, not acknowledged yet')
  expect(during.some(t => t.startsWith('not delivered:'))).toBe(false)
  await receiveReplyAck(fx.dollar, 'bridge:session_new', 'Orch: belt', { id: replica.id, seq: 1, of: 'reply' })
  expect((await drawnNow()).some(t => t.startsWith('not delivered:') || t.startsWith('being delivered:'))).toBe(false)
})

test('the lines not delivered are cleared from the pane: recorded on each entry, logged, drawn and sent no more', async () => {
  const replicas = [failedReplica(), { ...failedReplica(), id: 'q-s-far-second', blocks: 'acme/app#2' }]
  const { fx, sent, render } = await askedPane(replicas)
  remoteRow(fx, 'Orch: belt', 'far')
  const tree = await render()
  // The line stays the section's foot, its action over it.
  const kids = kidsOf(elAt(tree, 0))
  expect(saidBy(kids.at(-2))).toBe(`${NOT_DELIVERED} · no acknowledgment after 3 sends — the answer to Orch: belt on far (blocks: acme/app#2)`)
  expect(kids.at(-3)).toBe(button(tree, 'clear-failed'))
  expect(button(tree, 'clear-failed').props['hotkey']).toBe('x')
  await button(tree, 'clear-failed').props.onPress!()
  for (const replica of replicas) {
    const stored = JSON.parse(String(fx.files.get(`${ROUND}/${replica.id}.json`)))
    expect(stored.delivery).toMatchObject({ state: 'failed', reason: 'no acknowledgment after 3 sends' })
    expect(typeof stored.delivery.cleared).toBe('string')
    expect(fx.written.filter(l => l.endsWith(`the answer to ${replica.id} not delivered: its line cleared in the pane`)).length).toBe(1)
  }
  const cleared = await render()
  expect(texts(cleared).some(t => t.startsWith('not delivered:'))).toBe(false)
  expect(findAll(cleared, n => n.type === 'Button' && n.props.key === 'clear-failed')).toEqual([])
  fx.dollar.tool.call = async () => ({ text: LISTED_ANEW })
  await resendReplies(fx.dollar)
  expect(sent).toEqual([])
})

test('the action clearing the lines not delivered counts its row', async () => {
  const { fx, render } = await askedPane([failedReplica()])
  remoteRow(fx, 'Orch: belt', 'far')
  expect(await countedRows(render)).toBe(drawScreen(await render({ bodyColumns: 200 }), 198).length)
})

// --- a remote orchestrator's open questions, reconciled with its latest row --------------------

const BLOCKS_SINCE = '2026-10-30T10:03:00.000Z'

test('a withdrawal message settles the open entry it names at once; a lost, late or doubled one changes nothing', async () => {
  const asked = remoteEntry()
  const { fx, handlers, stored } = await askingPane([asked])
  const message = withdrawalText('Orch: belt', 'phase 3', BLOCKS_SINCE, 'yes')
  const envelope = `<cross-session-message from="${FAR}" from-name="Orch: belt" from-mode="prompting">\n${message}\n</cross-session-message>`
  const receive = () => handlers['session.receive'](fx.dollar, { origin: { kind: 'peer' }, text: envelope }, (x: unknown) => ({ passed: x }))
  expect(await receive()).toEqual({ consumed: 'coordinator: a remote withdrawal, applied' })
  const settled = stored(asked.id)
  // The words the message quotes are a peer's: never kept as the operator's typed answer.
  expect([settled.status, settled.answer!.by, settled.answer!.typed]).toEqual(['withdrawn', 'tab', undefined])
  // Doubled: the entry is settled already and stays as it was written.
  await receive()
  expect(stored(asked.id)).toEqual(settled)
  // Late: the same question asked again, a new start, is not the one the message names.
  const again = { ...asked, since: '2026-10-30T12:00:00.000Z', at: new Date().toISOString(), status: 'open', answer: null }
  fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(again) + '\n')
  await receive()
  expect(stored(asked.id).status).toBe('open')
})

test('a withdrawal from another peer naming the same sender, start and blocks leaves the entry open', async () => {
  const asked = remoteEntry()
  const { fx, handlers, stored } = await askingPane([asked])
  const message = withdrawalText('Orch: belt', 'phase 3', BLOCKS_SINCE)
  const envelope = `<cross-session-message from="uds:/tmp/cc-socks/other.sock" from-name="Orch: belt" from-mode="prompting">\n${message}\n</cross-session-message>`
  const received = await handlers['session.receive'](fx.dollar, { origin: { kind: 'peer' }, text: envelope }, (x: unknown) => ({ passed: x }))
  expect(received).toEqual({ consumed: 'coordinator: a remote withdrawal, applied' })
  expect(stored(asked.id).status).toBe('open')
})

// --- a closing proposal settled by the coordinator ------------------------------------------

// The sends of a coordinator's module, delivered or refused with `refuse`.
function sends(fx: Fx, refuse?: string) {
  const sent: { to: unknown; text: string }[] = []
  fx.dollar.session.send = async (args: { to: unknown; text: string }) => {
    sent.push(args)
    return refuse ? { isDelivered: false, reason: refuse } : { isDelivered: true }
  }
  return sent
}

const storedIn = (fx: Fx, id: string) => JSON.parse(String(fx.files.get(`${ROUND}/${id}.json`))) as RoundEntry

// The operator's ruling 6.3 of 2026-10-31: each ruling relayed at once by the module, nothing
// shown between questions — the coordinator's settle sends the answer in the same call, not at the
// round's next reading up to 30 seconds later.
const settleHere = (id: string, answer = 'A, ship it') => ({ id, outcome: 'answered-here' as const, text: answer, author: null, work: null })

// An operator entry of an older release left in the round (the relay writes none now): the
// round's wake withdraws it, by the coordinator, and tells its sender to ask it with ask — a
// session here by a message, one on another machine by an answer on the event line — once; it is
// never due.
test('an open operator entry of an older release is withdrawn by the wake, its sender told once to ask it again, never woken for', async () => {
  const { fx, tick } = await wakingCoordinator([])
  const sent = sends(fx)
  const here = entry('Orch: a', minutesAgo(1), { session: 'sa', urgent: true })
  // A remote entry's id in the shape the lines between machines carry.
  const there = entry('Orch: b', minutesAgo(2), { id: 'sb-17-abc1', session: 'sb', urgent: true, origin: { machine: 'bench-mac', address: 'bridge:peer' } })
  const old = entry('Orch: c', minutesAgo(3), { id: 'sc-17-abc2', session: 'sc', urgent: true, origin: { machine: 'bench-mac', address: 'bridge:old' } })
  for (const e of [here, there, old]) {
    fx.files.set(`${ROUND}/${e.id}.json`, JSON.stringify(e) + '\n')
    fx.files.set(`${SESSIONS}/${e.session}`, JSON.stringify(row({ role: 'orchestrator', name: e.from })) + '\n')
  }
  await tick()
  for (const e of [here, there, old]) expect(storedIn(fx, e.id)).toMatchObject({ status: 'withdrawn', answer: { by: 'coordinator', text: `withdrawn: Your question ${e.id} was withdrawn: the coordinator's machine runs a newer release, which takes questions through the ask tool only. Ask it again with the ask tool.` } })
  expect(sent.length).toBe(3)
  expect(sent.find(s => JSON.stringify(s.to) === JSON.stringify({ sessionId: 'sa' }))?.text).toBe(`[module] Your question ${here.id} was withdrawn: the coordinator's machine runs a newer release, which takes questions through the ask tool only. Ask it again with the ask tool.`)
  const q = parseQ(sent.find(s => s.to === 'bridge:peer')!.text)
  expect(q?.event.kind === 'answer' ? [q.id, q.event.since, q.event.readable.endsWith('Ask it again with the ask tool.')] : null).toEqual([there.id, there.since, true])
  // Every remote sender is answered by the event line, whichever machine it is on.
  const fromOld = parseQ(sent.find(s => s.to === 'bridge:old')!.text)
  expect(fromOld?.event.kind === 'answer' ? [fromOld.id, fromOld.event.since, fromOld.event.readable.endsWith('Ask it again with the ask tool.')] : null).toEqual([old.id, old.since, true])
  expect([fx.notices, fx.submitted]).toEqual([[], []])
  expect(fx.written.filter(l => l.includes('| round: an operator question of an older release withdrawn:')).length).toBe(3)
  await tick()
  expect(sent.length).toBe(3)
})

test('a settle refused, or one from a session that is no coordinator, sends nothing and closes nothing', async () => {
  const open = entry('Orch: a', minutesAgo(1), { session: 'sa', kind: 'done', blocks: null })
  const { fx } = await wakingCoordinator([open])
  const sent = sends(fx)
  expect((await settle(fx.dollar, { ...settleHere(open.id), outcome: 'answered-by-message', author: 'Orch: z' })).isError).toBe(true)
  expect((await settle(fx.dollar, settleHere('absent'))).isError).toBe(true)
  const orch = fakeDollar({ launchName: 'Orch: belt' })
  orch.files.set(`${SESSIONS}/s-one`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: belt' })) + '\n')
  orch.files.set(`${ROUND}/${open.id}.json`, JSON.stringify(open) + '\n')
  const elsewhere: unknown[] = []
  orch.dollar.session.send = async (args: unknown) => { elsewhere.push(args); return { isDelivered: true } }
  expect((await settle(orch.dollar, settleHere(open.id))).isError).toBe(true)
  expect([sent.length, elsewhere.length, storedIn(fx, open.id).status, storedIn(orch, open.id).status]).toEqual([0, 0, 'open', 'open'])
})

test('an orchestrator\'s pane in tmux lists the agents its own pane spawned, not a sibling pane\'s sharing the server\'s ITERM_SESSION_ID', async () => {
  const owned = JSON.stringify({ tab_id: 'tmux:/private/tmp/tmux-501/orch:@1', tty: '/dev/ttys009', owner: 'tmux:/private/tmp/tmux-501/orch:%3' }) + '\n'
  const paneText = async (pane: string) => {
    const fx = fakeDollar({ launchName: 'Orch: phase-3' })
    Object.assign(fx.env, { ITERM_SESSION_ID: 'w0t1p0:OWNER-1', TMUX: '/private/tmp/tmux-501/orch,4242,0', TMUX_PANE: pane })
    fx.files.set(`${HOME}/.claude/claude-orchestrator/chains/ttys001.jsonl`, owned)
    fx.files.set(`${HOME}/.claude/sessions/777.json`, JSON.stringify({ sessionId: 's-agent', name: 'Agent: belt-p3', status: 'busy' }))
    fx.files.set(`${SESSIONS}/s-agent`, JSON.stringify(row({ role: 'agent', name: 'Agent: belt-p3', context_percent: 40 })) + '\n')
    const { handlers } = mounted(registerSupervision)
    await handlers['command.run'](fx.dollar, supervisionRun)
    return JSON.stringify(await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x })))
  }
  expect(await paneText('%3')).toContain('Agent: belt-p3')
  expect(await paneText('%4')).toContain('no agent running')
})

// --- a new question and the coordinator's conversation -----------------------------------------

// With the pane open a question goes to the pane and not to the coordinator's conversation: no
// line is drawn there and no turn of its model starts.
test('with the pane open, a new question puts nothing in the coordinator\'s conversation and wakes no turn, entered by the relay or asked with ask', async () => {
  const relayed = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const { fx, tick } = await wakingCoordinator([relayed])
  const plain = askedObject('sb', 'Orch: b', minutesAgo(2))
  fx.files.set(`${ROUND}/${plain.id}.json`, JSON.stringify(plain) + '\n')
  fx.files.set(`${SESSIONS}/sb`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: b' })) + '\n')
  expect(fx.files.has(PANE_FILE)).toBe(true)
  await tick()
  await tick()
  expect([fx.notices, fx.submitted]).toEqual([[], []])
})

test('with the pane closed a new question reaches the coordinator\'s conversation by its due wake alone, once', async () => {
  const fresh = entry('Orch: a', minutesAgo(1), { session: 'sa' })
  const { fx, tick } = await wakingCoordinator([fresh], { paneClosed: true })
  await tick()
  await tick()
  expect(fx.notices).toEqual([])
  expect(fx.submitted.length).toBe(1)
})

// A question asked with `ask` reaches the coordinator as the relay's entries did: due in its tab
// when urgent or with its pane closed, while its asker lives here.
test('a question asked with ask wakes the coordinator once when urgent, and not once settled', async () => {
  const { fx, tick } = await wakingCoordinator([])
  const urgent = askedObject('sa', 'Orch: a', minutesAgo(1), { urgent: true })
  const plain = askedObject('sb', 'Orch: b', minutesAgo(2))
  const settled = askedObject('sc', 'Orch: c', minutesAgo(3), { status: 'answered', urgent: true })
  for (const [asked, name] of [[urgent, 'Orch: a'], [plain, 'Orch: b'], [settled, 'Orch: c']] as const) {
    fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(asked) + '\n')
    fx.files.set(`${SESSIONS}/${asked.sender.session}`, JSON.stringify(row({ role: 'orchestrator', name })) + '\n')
  }
  await tick()
  expect(fx.submitted.length).toBe(1)
  expect(String(fx.submitted[0])).toContain('Orch: a')
  await tick()
  expect(fx.submitted.length).toBe(1)
  expect(fx.notices).toEqual([])
})

test('a question asked with ask claimed by his prompt in its asker\'s tab is not woken for, until that turn\'s end gives it back', async () => {
  const { fx, tick } = await wakingCoordinator([])
  const claimed = askedObject('sa', 'Orch: a', minutesAgo(1), { urgent: true, claimed: { typed: 'B', at: minutesAgo(0) } })
  fx.files.set(`${ROUND}/${claimed.id}.json`, JSON.stringify(claimed) + '\n')
  fx.files.set(`${SESSIONS}/sa`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: a' })) + '\n')
  await tick()
  expect(fx.submitted).toEqual([])
  const given = { ...claimed, claimed: undefined }
  fx.files.set(`${ROUND}/${claimed.id}.json`, JSON.stringify(given) + '\n')
  await tick()
  expect(fx.submitted.length).toBe(1)
})

// A render driven again on the same handlers.
const redraw = async (fx: Fx, handlers: Handlers) => drawnTree(await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x })))

// --- a question moved to a successor not measured yet ------------------------------------------

// (d2): a successor has no row until its first turn ends, minutes after the move; its session runs
// all the same, and the host's own record of it says so.
test('a question asked with ask moved to a successor not measured yet is drawn', async () => {
  const moved = askedObject('s-two', 'Orch: belt-2', '2026-11-04T17:10:00.000Z', { id: 'q-moved-1', movedFrom: 's-old', seq: 2 })
  const drawnWith = async (record: object | null, asked: Record<string, unknown> = moved) => {
    const fx = fakeDollar({ launchName: 'Coord: main' })
    fx.files.set(`${ROUND}/${String(asked['id'])}.json`, JSON.stringify(asked) + '\n')
    if (record) fx.files.set(`${HOME}/.claude/sessions/${(record as { pid: number }).pid}.json`, JSON.stringify(record))
    return JSON.stringify(await coordinatorRender(fx))
  }
  expect(await drawnWith({ pid: 777, sessionId: 's-two', name: 'Orch: belt-2' })).toContain('Questions for you — 1 pending')
  // The host's record of a process that no longer runs, or of another session, is no successor.
  for (const record of [{ pid: 999, sessionId: 's-two', name: 'Orch: belt-2' }, { pid: 777, sessionId: 's-other', name: 'Orch: belt-2' }, null]) {
    expect(await drawnWith(record)).not.toContain('pending')
  }
  // A question no successor took, its session with no row, is not drawn on a live record alone.
  const { movedFrom: _from, ...plain } = moved as Record<string, unknown>
  expect(await drawnWith({ pid: 777, sessionId: 's-two' }, plain)).not.toContain('pending')
})

// A move whose successor's session was not resolved names none: the host's record of a live
// session of the successor's name draws it, the predecessor's own record never.
test('a question asked with ask moved to a successor by its name alone is drawn on a live session of that name only, never its predecessor\'s', async () => {
  const moved = askedObject('', 'Orch: belt-2', '2026-11-04T17:10:00.000Z', { id: 'q-moved-1', movedFrom: 's-old', seq: 2 })
  const drawnWith = async (record: object | null) => {
    const fx = fakeDollar({ launchName: 'Coord: main' })
    fx.files.set(`${ROUND}/${moved.id}.json`, JSON.stringify(moved) + '\n')
    if (record) fx.files.set(`${HOME}/.claude/sessions/${(record as { pid: number }).pid}.json`, JSON.stringify(record))
    return JSON.stringify(await coordinatorRender(fx))
  }
  expect(await drawnWith({ pid: 777, sessionId: 's-two', name: 'Orch: belt-2' })).toContain('Questions for you — 1 pending')
  for (const record of [{ pid: 999, sessionId: 's-two', name: 'Orch: belt-2' }, { pid: 777, sessionId: 's-old', name: 'Orch: belt-2' }, { pid: 777, sessionId: 's-two', name: 'Orch: other' }, null]) {
    expect(await drawnWith(record)).not.toContain('pending')
  }
})

// D2 of the round-2 verdict: no withdrawal nor move matches an entry naming no session, so the
// read that judges it by its successor's name closes it once no session of that name runs.
test('a closing proposal moved to a successor by its name alone stays open while a session of that name runs, and is withdrawn once none does', async () => {
  const moved = entry('Orch: belt-2', '2026-11-04T17:10:00.000Z', { kind: 'done', blocks: null, session: '', movedFrom: 's-old' })
  const nameless = entry('Orch: belt-2', '2026-11-04T17:11:00.000Z', { kind: 'done', blocks: null, session: '' })
  const { fx, tick } = await wakingCoordinator([])
  for (const e of [moved, nameless]) fx.files.set(`${ROUND}/${e.id}.json`, JSON.stringify(e) + '\n')
  const record = `${HOME}/.claude/sessions/777.json`
  fx.files.set(record, JSON.stringify({ pid: 777, sessionId: 's-two', name: 'Orch: belt-2' }))
  const statusOf = (e: RoundEntry) => JSON.parse(String(fx.files.get(`${ROUND}/${e.id}.json`)))
  await tick()
  expect(statusOf(moved).status).toBe('open')
  // The successor's process ends, its record left behind: a process table that cannot be read
  // judges nothing, and the entry stays open.
  fx.files.set(record, JSON.stringify({ pid: 999, sessionId: 's-two', name: 'Orch: belt-2' }))
  const run = fx.dollar.process.run
  fx.dollar.process.run = async (argv: readonly string[], init?: object) =>
    argv[0] === 'ps' && argv[1] === '-A' ? { exitCode: 1, stdout: '', stderr: 'denied' } : run(argv, init)
  await tick()
  expect(statusOf(moved).status).toBe('open')
  // A registry that cannot be listed says nothing of who runs: the entry stays open.
  fx.dollar.process.run = run
  const list = fx.dollar.fs.list
  fx.dollar.fs.list = async (dir: string) => {
    if (dir === `${HOME}/.claude/sessions`) throw new Error('EACCES')
    return list(dir)
  }
  await tick()
  expect(statusOf(moved).status).toBe('open')
  // Both read: no session of that name runs, the entry is withdrawn by its sender.
  fx.dollar.fs.list = list
  await tick()
  expect(statusOf(moved).status).toBe('withdrawn')
  expect(statusOf(moved).answer.by).toBe('sender')
  // An entry no succession moved is not judged by a name.
  expect(statusOf(nameless).status).toBe('open')
})

test('an entry moved to a successor by its name alone is due in the tab with the pane closed', async () => {
  const moved = entry('Orch: belt-2', minutesAgo(1), { session: '', movedFrom: 's-old' })
  const { fx, tick } = await wakingCoordinator([moved], { paneClosed: true })
  fx.files.delete(`${SESSIONS}/`)
  fx.files.set(`${HOME}/.claude/sessions/777.json`, JSON.stringify({ pid: 777, sessionId: 's-two', name: 'Orch: belt-2' }))
  await tick()
  expect(fx.submitted.length).toBe(1)
  expect(fx.submitted[0]).toContain('Orch: belt-2')
})

test('an entry moved to a successor not measured yet is due in the tab with the pane closed', async () => {
  const moved = entry('Orch: belt-2', minutesAgo(1), { session: 's-two', movedFrom: 's-old' })
  const { fx, tick } = await wakingCoordinator([moved], { paneClosed: true })
  fx.files.delete(`${SESSIONS}/s-two`)
  fx.files.set(`${HOME}/.claude/sessions/777.json`, JSON.stringify({ pid: 777, sessionId: 's-two', name: 'Orch: belt-2' }))
  await tick()
  expect(fx.submitted.length).toBe(1)
  expect(fx.submitted[0]).toContain('Orch: belt-2')
})

// A question asked with `ask` moved to a successor by its name alone follows the same rule: drawn and
// due while a live session of that name runs, its session written once known, withdrawn once none runs.
test('a question asked with ask moved to a successor by its name alone is drawn while a live session of that name runs, and takes its session', async () => {
  const moved = askedObject('', 'Orch: belt-2', '2026-11-04T17:10:00.000Z', { id: 'q-moved-1', movedFrom: 's-old', seq: 2 })
  const fx = fakeDollar({ launchName: 'Coord: main' })
  fx.files.set(`${ROUND}/${moved.id}.json`, JSON.stringify(moved) + '\n')
  fx.files.set(`${HOME}/.claude/sessions/777.json`, JSON.stringify({ pid: 777, sessionId: 's-two', name: 'Orch: belt-2' }))
  const tree = await coordinatorRender(fx)
  expect(JSON.stringify(tree)).toContain('Questions for you — 1 pending')
  expect(texts(tree)).toContain('Orch: belt-2 · orchestrator · box-1')
  const read = JSON.parse(String(fx.files.get(`${ROUND}/${moved.id}.json`)))
  expect([read.sender.session, read.status, read.seq]).toEqual(['s-two', 'open', 3])
})

test('a question asked with ask moved to a successor by its name alone is withdrawn once no session of that name runs', async () => {
  const moved = askedObject('', 'Orch: belt-2', '2026-11-04T17:10:00.000Z', { id: 'q-moved-1', movedFrom: 's-old', seq: 2 })
  const fx = fakeDollar({ launchName: 'Coord: main' })
  fx.files.set(`${ROUND}/${moved.id}.json`, JSON.stringify(moved) + '\n')
  fx.files.set(`${HOME}/.claude/sessions/999.json`, JSON.stringify({ pid: 999, sessionId: 's-two', name: 'Orch: belt-2' }))
  expect(JSON.stringify(await coordinatorRender(fx))).not.toContain('pending')
  const read = JSON.parse(String(fx.files.get(`${ROUND}/${moved.id}.json`)))
  expect([read.status, read.answer?.by, read.answer?.text]).toEqual(['withdrawn', 'sender', "the sender's session ended"])
})

test('a question asked with ask moved to a successor by its name alone is due in the tab with the pane closed', async () => {
  const { fx, tick } = await wakingCoordinator([], { paneClosed: true })
  const moved = askedObject('', 'Orch: belt-2', minutesAgo(1), { id: 'q-moved-1', movedFrom: 's-old', seq: 2 })
  fx.files.set(`${ROUND}/${moved.id}.json`, JSON.stringify(moved) + '\n')
  fx.files.set(`${HOME}/.claude/sessions/777.json`, JSON.stringify({ pid: 777, sessionId: 's-two', name: 'Orch: belt-2' }))
  await tick()
  expect(fx.submitted.length).toBe(1)
  expect(fx.submitted[0]).toContain('Orch: belt-2')
})

// --- the render's own reads, bounded ---------------------------------------------------------

test('a git that hangs holds no render: the origin read is bounded, and a render past its bound is logged with its duration', async () => {
  const fx = fakeDollar({ launchName: 'Coord: main' })
  fx.files.set(`${SESSIONS}/low`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: low' })) + '\n')
  const run = fx.dollar.process.run
  let skew = 0
  const asked: (object | undefined)[] = []
  fx.dollar.process.run = async (argv: readonly string[], init?: { timeoutMs?: number }) => {
    if (argv[0] !== 'git') return run(argv, init)
    asked.push(init)
    // A git that never answers: the host ends it at the bound given, else never.
    if (typeof init?.timeoutMs !== 'number') return new Promise(() => undefined)
    skew += init.timeoutMs
    throw new Error(`still running after ${init.timeoutMs} ms`)
  }
  fx.dollar.clock.now = async () => Date.now() + skew
  {
    const hung = new Promise(resolve => setTimeout(() => resolve('hung'), 1000))
    const { handlers } = mounted(registerSupervision)
    const tree = await Promise.race([coordinatorRender(fx, handlers), hung])
    expect(tree).not.toBe('hung')
    expect(JSON.stringify(tree)).toContain('Orch: low')
    expect((asked[0] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(2000)
    // A render whose reads took longer than its bound says so, once, with its duration: here the
    // process listing its live row's pid sends the store's read to.
    fx.files.set(`${SESSIONS}/low`, JSON.stringify({ ...row({ role: 'orchestrator', name: 'Orch: low' }), pid: '501' }) + '\n')
    fx.dollar.process.run = async (argv: readonly string[], init?: { timeoutMs?: number }) => {
      if (argv[0] === 'ps') skew += 6000
      return run(argv, init)
    }
    await redraw(fx, handlers)
    expect(fx.written.filter(l => /\| supervision \| pane: the render took 6\d{3} ms, past its bound of 5000 ms$/.test(l)).length).toBe(1)
    expect(fx.written.filter(l => l.includes('pane: the render took')).length).toBe(1)
  }
})

// A pane redraws every few seconds: a render past its bound is said once per crossing of it, not
// at every redraw while the reads stay slow.
test('renders past their bound are logged once per crossing of it', async () => {
  const fx = fakeDollar({ launchName: 'Coord: main' })
  fx.files.set(`${SESSIONS}/low`, JSON.stringify({ ...row({ role: 'orchestrator', name: 'Orch: low' }), pid: '501' }) + '\n')
  const run = fx.dollar.process.run
  let skew = 0
  let slow = true
  fx.dollar.process.run = async (argv: readonly string[], init?: { timeoutMs?: number }) => {
    if (argv[0] === 'ps' && slow) skew += 6000
    return run(argv, init)
  }
  fx.dollar.clock.now = async () => Date.now() + skew
  const { handlers } = mounted(registerSupervision)
  await coordinatorRender(fx, handlers)
  await redraw(fx, handlers)
  await redraw(fx, handlers)
  const said = () => fx.written.filter(l => l.includes('pane: the render took')).length
  expect(said()).toBe(1)
  slow = false
  await redraw(fx, handlers)
  slow = true
  await redraw(fx, handlers)
  await redraw(fx, handlers)
  expect(said()).toBe(2)
})

// This session's repository is read once and kept: a read that timed out is no answer, and the
// next render reads it again, while one that answered is never read twice.
test('an origin read that timed out is read again at the next render, one that answered is kept', async () => {
  const fx = fakeDollar({ launchName: 'Coord: main' })
  fx.files.set(`${SESSIONS}/low`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: low' })) + '\n')
  let gits = 0
  let answer: 'thrown' | 'ended' | 'none' | 'origin' = 'thrown'
  const gitAnswering = (run: World['process']['run']) => async (argv: readonly string[], init?: ProcessRunInit) => {
    if (argv[0] !== 'git') return run(argv, init)
    gits++
    if (answer === 'thrown') throw new Error(`still running after ${init?.timeoutMs} ms`)
    // Ended at its bound by a signal, before it printed a word.
    if (answer === 'ended') return { exitCode: 143, stdout: '', stderr: '' }
    if (answer === 'none') return { exitCode: 2, stdout: '', stderr: "error: No such remote 'origin'\n" }
    return { exitCode: 0, stdout: 'git@github.com:Owner/repo.git\n', stderr: '' }
  }
  fx.dollar.process.run = gitAnswering(fx.dollar.process.run)
  const { handlers } = mounted(registerSupervision)
  await coordinatorRender(fx, handlers)
  expect(gits).toBe(1)
  answer = 'ended'
  await redraw(fx, handlers)
  expect(gits).toBe(2)
  answer = 'origin'
  await redraw(fx, handlers)
  expect(gits).toBe(3)
  await redraw(fx, handlers)
  expect(gits).toBe(3)
  // No origin is an answer too: kept, never read again.
  const bare = fakeDollar({ launchName: 'Coord: main' })
  bare.files.set(`${SESSIONS}/low`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: low' })) + '\n')
  bare.dollar.process.run = gitAnswering(bare.dollar.process.run)
  answer = 'none'
  const fresh = mounted(registerSupervision).handlers
  await coordinatorRender(bare, fresh)
  await redraw(bare, fresh)
  expect(gits).toBe(4)
})

// --- the pull requests nobody attends ------------------------------------------------------------

const UNATTENDED = { at: SINCE, line: 'En anomalie : acme/app#8 (sans agent depuis 2026-10-19T08:05Z)', prs: [{ repo: 'acme/app', pr: 8, since: SINCE }], unread: ['acme/lib'] }
const local = (iso: string) => { const at = new Date(iso); return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` }

// A row of the unattended lines as the screen draws it: its words, the label column's padding squeezed.
const said = (tree: El, label: string) => shown(tree).filter(line => line.startsWith(label)).map(line => line.replace(/\s+/g, ' '))

test('an orchestrator with pull requests nobody attends draws them under its block, grouped by state under a label, the repository without its owner, in local time, the unread repositories said unknown', async () => {
  const rows = paneRows({ 'sessions/u': orch('Orch: u', { unattended: UNATTENDED }), 'sessions/c': orch('Orch: c') })
  const lines = [
    { anomaly: true, label: 'Sans agent', text: 'app#8', wraps: false, time: local(SINCE) },
    { anomaly: true, label: 'Inconnues', text: 'acme/lib (forge illisible)', wraps: true },
  ]
  expect(rows.map(r => [r.name, r.unattended])).toEqual([['Orch: u', lines], ['Orch: c', null]])
  const tree = await paneTree({ u: orch('Orch: u', { unattended: UNATTENDED }) })
  const block = elAt(tree, 2)
  expect(kidsOf(block).length).toBe(2)
  const drawn = kidsOf(elAt(block, 1))
  expect(drawn.map(node => pieces(node).map(piece => piece.text)).map(([label, ...words]) => [label, words.join('')])).toEqual([['Sans agent', `app#8 · ${local(SINCE)}`], ['Inconnues', 'acme/lib (forge illisible)']])
  // The label and the words carry the colour; a link is the host's to colour.
  expect(drawn.map(node => [pieces(node)[0]?.color, pieces(node).at(-1)?.color])).toEqual([['warning', 'warning'], ['warning', 'warning']])
  const none = await paneTree({ c: orch('Orch: c', { unattended: { at: SINCE, line: null, prs: [], unread: [] } }) })
  expect(kidsOf(elAt(none, 2)).length).toBe(1)
})

const SPLIT = {
  at: SINCE,
  line: null,
  prs: [
    { repo: 'acme/app', pr: 4, since: SINCE, waits: { why: 'ready' } },
    { repo: 'acme/app', pr: 5, since: SINCE, waits: { why: 'hold' } },
    { repo: 'acme/lib', pr: 6, since: SINCE, waits: { why: 'hold' } },
    { repo: 'acme/app', pr: 7, since: SINCE, waits: { why: 'record', on: 'ton merge' } },
    { repo: 'acme/app', pr: 9, since: SINCE, waits: { why: 'record', on: 'la livraison' } },
    { repo: 'acme/app', pr: 8, since: SINCE },
    { repo: 'acme/app', pr: 10, since: SINCE, conflict: true },
  ],
  unread: [],
}
const SPLIT_SAID = [
  'Ready app#4',
  'En pause app#5 · lib#6',
  `Attend app#7 ton merge · ${local(SINCE)}`,
  `app#9 la livraison · ${local(SINCE)}`,
  'En conflit app#10',
  `Sans agent app#8 · ${local(SINCE)}`,
]

test('what waits on the operator and what is in anomaly are groups under a label: Ready and En pause on one line each, each Attend and Sans agent on a line of its own with its time last, only the anomaly in the warning colour', async () => {
  const tree = await paneTree({ s: orch('Orch: s', { unattended: SPLIT as never }) })
  const lines = shown(tree).map(line => line.replace(/\s+/g, ' '))
  const at = lines.indexOf(SPLIT_SAID[0]!)
  expect(at).toBeGreaterThan(0)
  expect(lines.slice(at, at + SPLIT_SAID.length)).toEqual(SPLIT_SAID)
  // The label column: the continuation of Attend is blank under its label, the words start in one column.
  const raw = drawScreen(tree, 200).map(line => line.replace(/^[│ ]*?(?=Ready|En pause|Attend|app#9|En conflit|Sans agent)/, ''))
  expect(raw.filter(line => /^(Ready|En pause|Attend|En conflit|Sans agent| {11}app#9)/.test(line)).map(line => line.search(/app#|lib#/)).every(column => column === 11)).toBe(true)
  const colours = kidsOf(elAt(elAt(tree, 2), 1)).map(node => pieces(node)[0]?.color)
  expect(colours).toEqual([undefined, undefined, undefined, undefined, 'warning', 'warning'])
  // Only what waits on him: no line in the warning colour.
  const waits = { ...SPLIT, prs: SPLIT.prs.slice(0, 5) }
  const calm = await paneTree({ s: orch('Orch: s', { unattended: waits as never }) })
  expect(JSON.stringify(calm)).not.toContain('warning')
})

test('a published row\'s unattended view is read with its kinds; a malformed kind drops the view, and a row of an older module (no kind) is all anomaly', () => {
  const stored = (waits: unknown) => JSON.stringify({ ...row({ role: 'orchestrator', name: 'Orch: s' }), unattended: { ...SPLIT, prs: [{ repo: 'acme/app', pr: 4, since: SINCE, ...(waits === undefined ? {} : { waits }) }] } })
  expect(parseSessionRow(stored({ why: 'ready' }))?.unattended?.prs[0]?.waits).toEqual({ why: 'ready' })
  expect(parseSessionRow(stored({ why: 'record', on: 'ton merge' }))?.unattended?.prs[0]?.waits).toEqual({ why: 'record', on: 'ton merge' })
  for (const bad of [{ why: 'later' }, { why: 'record', on: 3 }, 'ready', null]) expect(parseSessionRow(stored(bad))?.unattended, JSON.stringify(bad)).toBe(undefined)
  expect(parseSessionRow(stored(undefined))?.unattended?.prs[0]?.waits).toBe(undefined)
})

test('an orchestrator\'s own pane draws the same groups above its agents, the anomaly alone in warning', async () => {
  const fx = fakeDollar({ launchName: 'Orch: phase-3' })
  fx.files.set(`${SESSIONS}/s-one`, JSON.stringify(row({ role: 'orchestrator', name: 'Orch: phase-3' })) + '\n')
  const { handlers } = mounted(registerSupervision)
  const bare = await coordinatorRender(fx, handlers)
  expect(JSON.stringify(bare)).not.toContain('Sans agent')
  fx.files.set(`${SESSIONS}/s-one`, JSON.stringify({ ...row({ role: 'orchestrator', name: 'Orch: phase-3' }), unattended: SPLIT }) + '\n')
  const tree = drawnTree(await handlers['ui.render'](fx.dollar, renderEvent, (x: unknown) => ({ passed: x })))
  const lines = SPLIT_SAID.map((_, i) => pieces(elAt(tree, i)))
  expect(lines.map(line => line.map(piece => piece.text).join(' ').replace(/\s+/g, ' ').trim())).toEqual(SPLIT_SAID.map(line => line.replace(/^(Attend|Ready|En pause|En conflit|Sans agent) /, '$1 ')))
  expect(lines.map(line => line[0]?.color)).toEqual([undefined, undefined, undefined, undefined, 'warning', 'warning'])
})

// The pull request a record names, its wait on the operator in words far wider than the pane.
const LONG_ON = `le merge de l'opérateur, ${'après la relecture de toutes les pièces jointes, '.repeat(4)}puis le déploiement`
const LONG = {
  at: SINCE,
  line: null,
  prs: [{ repo: 'acme/app', pr: 4, since: SINCE, waits: { why: 'record', on: LONG_ON } }, { repo: 'acme/app', pr: 5, since: SINCE, waits: { why: 'ready' } }],
  unread: [],
}

test('a wait of 200 characters is cut to the pane\'s width on one line, its time last, never wrapped; the pull request stays a link, and the rows counted are the rows drawn', async () => {
  expect(LONG_ON.length).toBeGreaterThan(200)
  const fx = fakeDollar({ launchName: 'Coord: main' })
  fx.files.set(`${SESSIONS}/s-one`, JSON.stringify({ ...row({ role: 'orchestrator', name: 'Orch: long', updated_at: AGO(), repo: 'acme/app' }), unattended: LONG }) + '\n')
  const { handlers } = mounted(registerSupervision)
  await coordinatorRender(fx, handlers)
  const render = async (props: object = {}) => drawnTree(await handlers['ui.render'](fx.dollar, { ...renderEvent, props }, (x: unknown) => ({ passed: x })))
  for (const columns of [60, 200]) {
    const lines = drawScreen(await render({ bodyColumns: columns }), columns - 2).map(line => line.replace(/^[│ ]+|[│ ]+$/g, ''))
    const at = lines.findIndex(line => line.startsWith('Attend'))
    expect(at, lines.join('\n')).toBeGreaterThan(0)
    // Its group above it, one line, its time last, whatever the width.
    expect(lines[at - 1]).toMatch(/^Ready +app#5$/)
    expect(lines[at]).toMatch(/^Attend +app#4 {2}le merge de l'opérateur.*… · \d\d:\d\d$/)
    expect(lines[at]!.endsWith(` · ${local(SINCE)}`)).toBe(true)
    expect(lines[at]!.length).toBeLessThanOrEqual(columns - 2)
  }
  const narrow = await render({ bodyColumns: 60 })
  expect(links(narrow)).toEqual([['app#5', 'https://github.com/acme/app/pull/5'], ['app#4', 'https://github.com/acme/app/pull/4']])
  // The line of the wait is cut by the host too; the group above it, which wraps, is not.
  const truncated = findAll(narrow, n => n.props?.['wrap'] === 'truncate-end').map(n => pieces(n).map(piece => piece.text).join(''))
  expect(truncated.filter(words => words.includes('app#'))).toEqual([expect.stringContaining('app#4')])
  expect(await countedRows(render)).toBe(drawScreen(await render({ bodyColumns: 200 }), 198).length)
  expect(await countedRows(render, 60)).toBe(drawScreen(narrow, 58).length)
  // The orchestrator's own pane, cut at its edge too.
  const own = mounted(registerSupervision)
  const ownFx = fakeDollar({ launchName: 'Orch: phase-3' })
  ownFx.files.set(`${SESSIONS}/s-one`, JSON.stringify({ ...row({ role: 'orchestrator', name: 'Orch: phase-3' }), unattended: LONG }) + '\n')
  await coordinatorRender(ownFx, own.handlers)
  const drawn = drawnTree(await own.handlers['ui.render'](ownFx.dollar, { ...renderEvent, props: { bodyColumns: 50 } }, (x: unknown) => ({ passed: x })))
  const attend = pieces(elAt(drawn, 1)).map(piece => piece.text)
  expect(attend[0]).toBe('Attend')
  expect(attend[1]!.length).toBe(50 - 2 - 11)
  expect(attend[1]!.endsWith(` · ${local(SINCE)}`)).toBe(true)
  expect(findAll(drawn, n => n.props?.['wrap'] === 'truncate-end').length).toBe(1)
})

// --- a consent question worded with unlettered choices draws them once ----------------------------

// --- each orchestrator's account and live agent count -------------------------------------------

const OWNER = 'tmux:/tmp/tmux-501/orch-a:%0'
const PLAN2 = [HOME, '.claude'].join('/') + '-bis'
// An orchestrator's row as its measure writes it: its host on `tty`, its configuration directory and the owner its chain's entries name.
// No row's tokens over its window give its percent: a pane that estimates the fill draws another figure.
const fleetRow = (name: string, over: Partial<SessionRow> = {}) =>
  orch(name, { pid: '900', tty: '/dev/ttys002', config: PLAN2, chain_owner: OWNER, context_tokens: 47000, ...over })
const chainOf = (...entries: { tty: string; owner?: string }[]) =>
  entries.map((e, i) => JSON.stringify({ tab_id: `t-${i}-${e.tty}`, tty: `/dev/${e.tty}`, owner: e.owner ?? OWNER })).join('\n') + '\n'
// The machine's process table, `pid stat tty` a line, read afresh at each listing; the orchestrator's host among them.
function fleet(rows: Record<string, SessionRow>, agents: Record<string, string>) {
  const fx = fakeDollar({ launchName: 'Coord: main' })
  for (const [key, value] of Object.entries(rows)) fx.files.set(`${SESSIONS}/${key}`, JSON.stringify(value) + '\n')
  const table = new Map<string, string>([['900', 'S+ ttys002'], ['901', 'S+ ttys003'], ['911', 'S+ ttys003'], ['902', 'S+ ttys004']])
  const run = fx.dollar.process.run
  let listing: 'answers' | 'fails' = 'answers'
  fx.dollar.process.run = async (argv: readonly string[]) => argv[0] === 'ps' && argv[1] === '-A'
    ? listing === 'fails' ? { exitCode: 1, stdout: '', stderr: 'no' } : { exitCode: 0, stdout: [...table].map(([pid, rest]) => `  ${pid} ${rest}`).join('\n') + '\n', stderr: '' }
    : run(argv)
  // The host's record of each live agent, in the configuration directory its orchestrator runs on.
  for (const [pid, session] of Object.entries(agents)) fx.files.set(`${PLAN2}/sessions/${pid}.json`, JSON.stringify({ sessionId: session, name: `Agent: ${session}`, status: 'busy' }))
  const { handlers } = mounted(registerSupervision)
  const draw = async (props: object = {}) => drawnTree(await handlers['ui.render'](fx.dollar, { ...renderEvent, props }, (x: unknown) => ({ passed: x })))
  const open = () => handlers['command.run'](fx.dollar, supervisionRun)
  const lineOf = async (name: string) => shown(await draw()).find(line => line.includes(name))
  return { fx, table, open, draw, lineOf, failListing: () => { listing = 'fails' } }
}
const CHAIN = `${HOME}/.claude/claude-orchestrator/chains/ttys002.jsonl`

test('an orchestrator on plan 2 with two live agents and one dead reads its account and 2 agents', async () => {
  const pane = fleet({ a: fleetRow('Orch: a') }, { '901': 's-1', '902': 's-2', '903': 's-dead' })
  pane.fx.files.set(CHAIN, chainOf({ tty: 'ttys003' }, { tty: 'ttys004' }, { tty: 'ttys005' }))
  await pane.open()
  expect(await pane.lineOf('Orch: a')).toBe('● Orch: a · orchestrator · plan 2 · 2 agents · 30% · 3m')
})

test('an agent ending between two draws of the pane lowers the count at the next one', async () => {
  const pane = fleet({ a: fleetRow('Orch: a') }, { '901': 's-1', '902': 's-2' })
  pane.fx.files.set(CHAIN, chainOf({ tty: 'ttys003' }, { tty: 'ttys004' }))
  await pane.open()
  expect(await pane.lineOf('Orch: a')).toContain(' · 2 agents · ')
  pane.table.delete('902')
  expect(await pane.lineOf('Orch: a')).toContain(' · 1 agent · ')
  pane.table.set('901', 'Z+ ttys003')
  expect(await pane.lineOf('Orch: a')).toBe('● Orch: a · orchestrator · plan 2 · 30% · 3m')
})

test('two orchestrators on two accounts each count their own agents', async () => {
  const pane = fleet({
    a: fleetRow('Orch: a'),
    b: fleetRow('Orch: b', { pid: '920', tty: '/dev/ttys006', config: [HOME, '.claude'].join('/'), chain_owner: 'OWNER-B', context_percent: 20 }),
  }, { '901': 's-1', '902': 's-2' })
  pane.table.set('920', 'S+ ttys006').set('921', 'S+ ttys007')
  pane.fx.files.set(`${HOME}/.claude/sessions/921.json`, JSON.stringify({ sessionId: 's-b', name: 'Agent: b', status: 'idle' }))
  pane.fx.files.set(CHAIN, chainOf({ tty: 'ttys003' }, { tty: 'ttys004' }))
  pane.fx.files.set(`${HOME}/.claude/claude-orchestrator/chains/ttys006.jsonl`, chainOf({ tty: 'ttys007', owner: 'OWNER-B' }))
  await pane.open()
  expect(await pane.lineOf('Orch: a')).toBe('● Orch: a · orchestrator · plan 2 · 2 agents · 30% · 3m')
  expect(await pane.lineOf('Orch: b')).toBe('● Orch: b · orchestrator · plan 1 · 1 agent · 20% · 3m')
})

test('a recycled tty\'s entries of another owner are not counted, and an agent named twice is counted once', async () => {
  const pane = fleet({ a: fleetRow('Orch: a') }, { '901': 's-1', '902': 's-2' })
  pane.fx.files.set(CHAIN, chainOf({ tty: 'ttys003' }, { tty: 'ttys003' }, { tty: 'ttys004', owner: 'SOMEONE-ELSE' }))
  await pane.open()
  expect(await pane.lineOf('Orch: a')).toContain(' · 1 agent · ')
})

test('an orchestrator that spawned no agent draws no count', async () => {
  const pane = fleet({ a: fleetRow('Orch: a') }, {})
  await pane.open()
  expect(await pane.lineOf('Orch: a')).toBe('● Orch: a · orchestrator · plan 2 · 30% · 3m')
})

test('an account or a count the facts do not carry reads « ? »', async () => {
  const pane = fleet({ a: fleetRow('Orch: a', { config: '/opt/other', chain_owner: null }) }, { '901': 's-1' })
  pane.fx.files.set(CHAIN, chainOf({ tty: 'ttys003' }))
  await pane.open()
  expect(await pane.lineOf('Orch: a')).toContain(' · orchestrator · ? · ? agents · ')
  // A row written before rows carried either.
  const older = await paneTree({ low: orch('Orch: low') })
  expect(shown(older).find(line => line.includes('Orch: low'))).toBe('● Orch: low · orchestrator · ? · ? agents · 30% · 3m')
  // A remote orchestrator: its row carries neither.
  const remote = await paneTree({ r: orch('Orch: r', { machine: 'mini' }) })
  expect(shown(remote).find(line => line.includes('Orch: r'))).toBe('● Orch: r · orchestrator · remote mini · ? · ? agents · 30% · 3m')
})

test('a process listing that fails reads « ? agents », never the count drawn before', async () => {
  const pane = fleet({ a: fleetRow('Orch: a') }, { '901': 's-1' })
  pane.fx.files.set(CHAIN, chainOf({ tty: 'ttys003' }))
  await pane.open()
  expect(await pane.lineOf('Orch: a')).toContain(' · 1 agent · ')
  pane.failListing()
  expect(await pane.lineOf('Orch: a')).toContain(' · plan 2 · ? agents · ')
})

test('at a phone\'s width the line wraps with the account and the count whole, and its rows are counted', async () => {
  const pane = fleet({ a: fleetRow('Orch: a') }, { '901': 's-1' })
  pane.fx.files.set(CHAIN, chainOf({ tty: 'ttys003' }))
  await pane.open()
  const lines = shown(await pane.draw(), 40)
  expect(lines.join(' ')).toContain('plan 2 · 1 agent')
  expect(await countedRows(pane.draw, 40)).toBe(drawScreen(await pane.draw({ bodyColumns: 40 }), 38).length)
})

// --- the auditors and the coordinators beside the orchestrators ---------------------------------

const PLAN1 = [HOME, '.claude'].join('/')
const AUDIT_OWNER = 'tmux:/tmp/tmux-501/audit-a:%0'
const COORD_OWNER = 'tmux:/tmp/tmux-501/coord:%0'
// An auditor on plan 1, host on ttys010, and the pane's own coordinator on plan 2, host on ttys012: each
// row under its own role, its fill its own. The coordinator's row is the pane's session's (s-one).
const auditorRow = (over: Partial<SessionRow> = {}) =>
  fleetRow('Audit: a', { role: 'auditor', pid: '930', tty: '/dev/ttys010', config: PLAN1, chain_owner: AUDIT_OWNER, context_percent: 12, context_tokens: 38000, ...over })
const coordRow = (over: Partial<SessionRow> = {}) =>
  fleetRow('Coord: main', { role: 'coordinator', pid: '940', tty: '/dev/ttys012', chain_owner: COORD_OWNER, context_percent: 21, context_tokens: 44000, ...over })
function allRoles(agents: Record<string, string> = {}) {
  const pane = fleet({ a: fleetRow('Orch: a'), u: auditorRow(), 's-one': coordRow() }, agents)
  pane.table.set('930', 'S+ ttys010').set('940', 'S+ ttys012').set('931', 'S+ ttys011').set('941', 'S+ ttys013').set('942', 'S+ ttys014')
  return pane
}
const AUDIT_CHAIN = `${HOME}/.claude/claude-orchestrator/chains/ttys010.jsonl`
const COORD_CHAIN = `${HOME}/.claude/claude-orchestrator/chains/ttys012.jsonl`

test('an auditor and a coordinator are listed beside the orchestrators, each with its role, account and context, the pane\'s own marked', async () => {
  const pane = allRoles()
  await pane.open()
  expect(shown(await pane.draw()).filter(line => line.startsWith('●'))).toEqual([
    '● Orch: a · orchestrator · plan 2 · 30% · 3m',
    '● Coord: main · coordinator (this session) · plan 2 · 21% · 3m',
    '● Audit: a · auditor · plan 1 · 12% · 3m',
  ])
  expect(pieces(elAt(await pane.draw(), 1))).toEqual([{ text: 'Sessions', bold: true }])
  expect(pane.fx.opened).toEqual([{ id: 'supervision', title: 'Sessions', focus: true }])
})

test('another coordinator is listed without the mark, and an implementer agent or a row of no role is not listed', async () => {
  const pane = fleet({
    other: coordRow({ name: 'Coord: other', pid: '900', tty: '/dev/ttys002' }),
    g: fleetRow('Agent: belt', { role: 'agent' }),
    n: fleetRow('somebody', { role: null }),
  }, {})
  await pane.open()
  expect(shown(await pane.draw()).filter(line => line.startsWith('●'))).toEqual(['● Coord: other · coordinator · plan 2 · 21% · 3m'])
})

test('each role counts its own live agents: 2 reads 2 agents, none draws no count', async () => {
  // The auditor's two readers on plan 1, the coordinator's one agent on plan 2, none of the orchestrator's.
  const pane = allRoles({ '941': 's-c' })
  for (const [pid, session] of [['931', 's-r1'], ['942', 's-r2']] as const) {
    pane.fx.files.set(`${PLAN1}/sessions/${pid}.json`, JSON.stringify({ sessionId: session, name: `Agent: ${session}`, status: 'busy' }))
  }
  pane.fx.files.set(AUDIT_CHAIN, chainOf({ tty: 'ttys011', owner: AUDIT_OWNER }, { tty: 'ttys014', owner: AUDIT_OWNER }))
  pane.fx.files.set(COORD_CHAIN, chainOf({ tty: 'ttys013', owner: COORD_OWNER }))
  await pane.open()
  expect(await pane.lineOf('Audit: a')).toBe('● Audit: a · auditor · plan 1 · 2 agents · 12% · 3m')
  expect(await pane.lineOf('Coord: main')).toBe('● Coord: main · coordinator (this session) · plan 2 · 1 agent · 21% · 3m')
  expect(await pane.lineOf('Orch: a')).toBe('● Orch: a · orchestrator · plan 2 · 30% · 3m')
})

test('the context of every role is the measured fill /orchestrator:status prints, past the gate in the error colour', async () => {
  const rows = { u: orch('Audit: a', { role: 'auditor', context_percent: 85, context_tokens: 82000 }), c: orch('Coord: b', { role: 'coordinator', context_percent: 17, context_tokens: 25000 }) }
  const tree = await paneTree(rows)
  expect(pieces(elAt(tree, 2, 0)).slice(-2)).toEqual([{ text: '85% past the gate', color: 'error', bold: false }, { text: ' · 3m', bold: false }])
  expect(pieces(elAt(tree, 3, 0)).slice(-2)).toEqual([{ text: '17%', bold: false }, { text: ' · 3m', bold: false }])
  const status = statusText(rows)
  expect(status).toMatch(/Audit: a +auditor +85% +3m +past the gate/)
  expect(status).toMatch(/Coord: b +coordinator +17% +3m/)
})

test('only the orchestrators waiting are counted in the line that names orchestrators', async () => {
  const waiting = { waiting: 'operator' as const, waiting_since: SINCE }
  const drawn = texts(await paneTree({ u: orch('Audit: a', { role: 'auditor', ...waiting }), a: orch('Orch: a', waiting) }))
  expect(drawn).toContain('none in the pane — 1 orchestrator waits for you: ask the coordinator')
})

test('at a phone\'s width each role\'s line wraps with its role, account and count whole, and its rows are counted', async () => {
  const pane = allRoles({ '941': 's-c' })
  pane.fx.files.set(COORD_CHAIN, chainOf({ tty: 'ttys013', owner: COORD_OWNER }))
  await pane.open()
  const drawn = shown(await pane.draw(), 40).join(' ')
  for (const said of ['orchestrator · plan 2', 'auditor · plan 1', '(this session)', 'plan 2 · 1 agent', '30%', '21%', '12%']) expect(drawn).toContain(said)
  expect(await countedRows(pane.draw, 40)).toBe(drawScreen(await pane.draw({ bodyColumns: 40 }), 38).length)
})
