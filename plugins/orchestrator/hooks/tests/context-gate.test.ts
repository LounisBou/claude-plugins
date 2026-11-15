// hooks/tests/context-gate.test.ts
import { expect, test } from 'claude-code/testing'
import { roleLine, gateAnnouncement, versionAnnouncement, register as registerGuards } from '../guards.ts'
import { register as registerGauge, driftAnnouncement } from '../gauge.ts'
import { logLineOf, blockOf, disk } from './fakes.ts'
import { capture, hooksOn, hostOf, type Captured } from '../../core/capture.ts'
import type { Events, Host, Noun } from '../../core/host.ts'

type World = Host<Noun>
type Prompt = Events['prompt.submit']

test('each role gets its own line, verbatim from the shell gate', () => {
  expect(roleLine('orchestrator')).toBe('Succeed at the next quiet boundary — run /orchestrator-succeed: spawn the successor in the operator\'s decision mode, then tell the user; do not ask.')
  expect(roleLine('agent')).toBe('Finish the unit in progress, end your turn on your status line, and stop; no new phase is dispatched to you.')
  expect(roleLine('coordinator')).toContain('skills/coordination/SKILL.md')
  expect(roleLine('coordinator', '/plugins/orch-root')).toContain('/plugins/orch-root/skills/coordination/SKILL.md')
  expect(roleLine('auditor')).toContain('auditor-succession-brief.md')
  expect(roleLine('none')).toBe('')
})

test('the announcement names what was read', () => {
  const a = gateAnnouncement({ tripped: true, words: '80% (gate 80%)' }, 'agent') // the gate: the smaller of 300,000 tokens (30 %) and 80 % of the reported window: 300,000 on 1,000,000; 160,000 on 200,000
  expect(a).toBe('CONTEXT GATE: this session is at 80% (gate 80%). ' + roleLine('agent')) // the gate: the smaller of 300,000 tokens (30 %) and 80 % of the reported window: 300,000 on 1,000,000; 160,000 on 200,000
})

test('below the gate nothing is said', () => {
  expect(gateAnnouncement({ tripped: false, words: '' }, 'orchestrator')).toBe('')
})

test("the auditor's brief is named openably, from any cwd", () => {
  // An auditor's cwd is the audited repo, not the checkout, so the line carries
  // the plugin root the host sets; a trailing slash on the root changes nothing.
  // Without a root the spelling stays relative — the shell gate still
  // absolutizes it until Task 12 retires it.
  expect(roleLine('auditor', '/plugins/orch-root')).toContain('/plugins/orch-root/templates/auditor-succession-brief.md')
  expect(roleLine('auditor', '/plugins/orch-root/')).toContain('/plugins/orch-root/templates/auditor-succession-brief.md')
  expect(roleLine('auditor')).toContain('templates/auditor-succession-brief.md')
})

// The wiring half. prompt.submit's input carries no transcript path (the
// settings hook's payload did), so the gate finds the transcript the gauge's
// own way, by session id under the projects directory, and reads the session's
// name through the same seams the module does: the process table for the launch
// name, the transcript's blocks for a rename. The fake spells those seams the
// way session-name.test.ts and the band test fake theirs.
const HOME = '/tmp/h'
const TRANSCRIPT = `${HOME}/.claude/projects/-a-project/s-gate.jsonl`
const MEASURE = `${HOME}/.claude/claude-orchestrator/measure/s-gate.json`

// The transcript of a session a turn has answered; the rename on the last line
// is padded — the unmeasured test below reads the session's name from it alone.
const ANSWERED_RENAMED = [
  '{"type":"assistant","message":{"role":"assistant","content":"an answer"}}',
  '{"type":"custom-title","customTitle":"  Agent: padded  "}',
].join('\n') + '\n'

const MEASURED_84 = JSON.stringify({
  context_tokens: 84000, context_window: 100000, context_percent: 84, model: 'a-model', updated_at: 't',
})

type Setup = {
  transcript?: string
  measure?: string
  env?: Record<string, string>
  noTty?: boolean
  noLaunchName?: boolean
  launchName?: string
  noSession?: boolean
  root?: string
  installed?: string
  // What `diff -rq` over two installed commits answers; by default a runtime file changed.
  diff?: { exitCode: number; stdout: string }
}

function fakeDollar(setup: Setup): { dollar: World; written: string[] } {
  const written: string[] = []
  const env: Record<string, string> = { HOME, ORCHESTRATOR_HOST_CLI: '/usr/local/bin/host', ...(setup.env ?? {}) }
  const dollar = hostOf({
    session: {
      id: async () => {
        if (setup.noSession) throw new Error('no session id')
        return 's-gate'
      },
    },
    // The plugin's directory comes from the engine, never from the
    // environment: the module's environment carries no CLAUDE_PLUGIN_ROOT.
    plugin: { root: setup.root ?? '/plugins/orch-root' },
    env: { get: async (name: string) => env[name] },
    fs: {
      read: async (p: string) => {
        if (p === MEASURE) {
          if (setup.measure === undefined) throw new Error('ENOENT')
          return setup.measure
        }
        if (p === '/cfg/deploys/lounisbou/installed.json' && setup.installed !== undefined) return setup.installed
        throw new Error(`unread: ${p}`)
      },
      write: async () => undefined,
      stat: async (p: string) => {
        if (p === TRANSCRIPT && setup.transcript !== undefined) {
          return { kind: 'file' as const, size: setup.transcript.length }
        }
        throw new Error('ENOENT')
      },
      list: async (p: string) => (
        p === `${HOME}/.claude/projects`
          ? [{ name: '-a-project', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }]
          : []
      ),
      exists: async (p: string) => p === TRANSCRIPT && setup.transcript !== undefined,
    },
    process: {
      run: async (argv: readonly string[]) => {
        const line = logLineOf(argv)
        if (line !== null) {
          written.push(line)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        const block = blockOf(argv, (p: string) => setup.transcript ?? '')
        if (block !== null) return { exitCode: 0, stdout: block, stderr: '' }
        if (argv[0] === 'sh') {
          // selfTty's seed: a controlling tty, or none for a headless run.
          return { exitCode: 0, stdout: setup.noTty ? '123 ??\n' : '123 ttys001\n', stderr: '' }
        }
        if (argv[1] === '-t') {
          // The session's own process, as the listing prints it.
          return { exitCode: 0, stdout: setup.noLaunchName ? '  501 host\n' : `  501 host --name ${setup.launchName ?? 'Agent: belt'}\n`, stderr: '' }
        }
        if (argv[0] === 'ps') return { exitCode: 0, stdout: '1 ??\n', stderr: '' }
        if (argv[0] === 'diff') {
          const own = String(argv.at(-2))
          return { stderr: '', ...(setup.diff ?? { exitCode: 1, stdout: `Files ${own}/orchestrator/hooks/guards.ts and ${String(argv.at(-1))}/orchestrator/hooks/guards.ts differ\n` }) }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  })
  return { dollar, written }
}

// The hooks the guards register; their .catch nets are kept apart — the body's own catch is what
// the wiring tests.
function mounted(): Array<Captured<World>> {
  return capture<World>(on => registerGuards(on))
}

async function submit(hooks: ReadonlyArray<Captured<World>>, dollar: World, e: Prompt = { text: 'go', origin: { kind: 'user' } }) {
  const box: { seen: Prompt | null } = { seen: null }
  await hooksOn(hooks, 'prompt.submit').at(-1)!.handler(dollar, e, async (x: Prompt) => { box.seen = x; return x })
  if (box.seen === null) throw new Error('the prompt was not passed on')
  return box.seen
}

test('past the gate the role line rides the prompt as one context block', async () => {
  const { dollar } = fakeDollar({ transcript: ANSWERED_RENAMED, measure: MEASURED_84 })
  const seen = await submit(mounted(), dollar)
  expect(seen).toMatchObject({
    text: 'go',
    context: [`CONTEXT GATE: this session is at 84% (gate 80%). ${roleLine('agent')}`], // the gate: the smaller of 300,000 tokens (30 %) and 80 % of the reported window: 300,000 on 1,000,000; 160,000 on 200,000
  })
})

test('the gate an env var lowered trips on a fill the default lets by', async () => {
  const { dollar } = fakeDollar({
    transcript: ANSWERED_RENAMED,
    measure: JSON.stringify({ context_tokens: 42000, context_window: 100000, context_percent: 42, model: 'a-model', updated_at: 't' }),
    env: { ORCHESTRATOR_CONTEXT_GATE: '1' },
  })
  const seen = await submit(mounted(), dollar)
  expect(seen.context?.[0]).toContain('42% (gate 1%)')
  // Live finding: a session shown a test threshold with no source declined to
  // rotate, reading it as a fault. The line names the variable and says it binds.
  expect(seen.context?.[0]).toContain('This threshold is set by ORCHESTRATOR_CONTEXT_GATE=1 in this session\'s environment: it is binding, not a fault.')
})

test('below the gate the prompt passes on untouched, context included', async () => {
  const { dollar } = fakeDollar({
    transcript: ANSWERED_RENAMED,
    measure: JSON.stringify({ context_tokens: 42000, context_window: 100000, context_percent: 42, model: 'a-model', updated_at: 't' }),
  })
  const e = { text: 'go', wait: false, origin: { kind: 'user' }, context: ['a prior block'] }
  const seen = await submit(mounted(), dollar, e)
  expect(seen).toBe(e)
})

test('an unmeasured session past its first turn is told nothing', async () => {
  const { dollar } = fakeDollar({ transcript: ANSWERED_RENAMED, noLaunchName: true })
  const seen = await submit(mounted(), dollar)
  expect(seen).toMatchObject({ text: 'go' })
  expect(seen.context).toBeUndefined()
})

test('a session whose first prompt this is stays silent', async () => {
  // No measure file and no transcript at all: the tap has not rendered for this
  // session yet, which is not a failure it reports.
  const { dollar } = fakeDollar({})
  const seen = await submit(mounted(), dollar)
  expect(seen).toMatchObject({ text: 'go' })
  expect(seen.context).toBeUndefined()
})

test('a session no tty names is never spoken to', async () => {
  const { dollar } = fakeDollar({ noTty: true, transcript: ANSWERED_RENAMED, measure: MEASURED_84 })
  const e = { text: 'go', wait: false, origin: { kind: 'user' } }
  expect(await submit(mounted(), dollar, e)).toBe(e)
})

test('a rename that names nothing leaves the gate silent past the gate itself', async () => {
  // No launch name, so the session is named by its renames alone; the last one
  // names nothing, and the walk must not resurrect the Agent: rename before
  // it — the session is unnamed, and no role is spoken to.
  const renamedAway = [
    '{"type":"assistant","message":{"role":"assistant","content":"an answer"}}',
    '{"type":"custom-title","customTitle":"Agent: earlier"}',
    '{"type":"custom-title","customTitle":"   "}',
  ].join('\n') + '\n'
  const { dollar } = fakeDollar({ transcript: renamedAway, measure: MEASURED_84, noLaunchName: true })
  const e = { text: 'go', wait: false, origin: { kind: 'user' } }
  expect(await submit(mounted(), dollar, e)).toBe(e)
})

test("an auditor past the gate is shown the brief's absolute place", async () => {
  const { dollar } = fakeDollar({
    transcript: ANSWERED_RENAMED,
    measure: MEASURED_84,
    launchName: 'Audit: 1712',
  })
  const seen = await submit(mounted(), dollar)
  expect(seen.context?.[0]).toContain('/plugins/orch-root/templates/auditor-succession-brief.md')
  expect(seen.context?.[0]).not.toContain(' succeed — templates/')
})

test('a handler that fails lets the prompt through and logs one line', async () => {
  const { dollar, written } = fakeDollar({ transcript: ANSWERED_RENAMED, measure: MEASURED_84, noSession: true })
  const e = { text: 'go', wait: false, origin: { kind: 'user' } }
  expect(await submit(mounted(), dollar, e)).toBe(e)
  expect(written.length).toBe(1)
  expect(written[0]).toContain('| guards |')
})

test("a coordinator past the gate is shown its skill's absolute place", async () => {
  const { dollar } = fakeDollar({ transcript: ANSWERED_RENAMED, measure: MEASURED_84, launchName: 'Coord: main' })
  const seen = await submit(mounted(), dollar)
  expect(seen.context?.[0]).toContain('/plugins/orch-root/skills/coordination/SKILL.md')
})

test('a model drift the gauge measured rides the next prompt to the model, once, whatever the role', async () => {
  const measure = hooksOn(capture<World>(registerGauge), 'session.measure').at(-1)!.handler
  let model = 'a-model'
  const g = hostOf({
    ...disk(),
    session: { usage: async () => ({ context: { tokens: 1, window: 2, percent: 3 } }), model: async () => model, id: async () => 's-gate' },
    env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
    ui: { toast: () => undefined, invalidate: () => undefined },
  })
  // The gauge reads the figures from $.session.usage, not from the event.
  const measured = { context: { window: 2 } }
  await measure(g, measured, async (x: unknown) => x)
  model = 'another-model'
  await measure(g, measured, async (x: unknown) => x)
  // A session with no role at all is still told.
  const { dollar } = fakeDollar({ noLaunchName: true })
  const handlers = mounted()
  const seen = await submit(handlers, dollar)
  expect(seen.context).toEqual([driftAnnouncement('another-model', 'a-model')])
  expect((await submit(handlers, dollar)).context).toBeUndefined()
})

// The newer installed commit, on the gate's channel: the plugin's own root names the commit the
// session runs, the deploy's state file the one installed.
const RUNNING = 'a'.repeat(40)
const INSTALLED = 'b'.repeat(40)
const DEPLOYED = `/cfg/deploys/lounisbou/${RUNNING}/plugins/orchestrator`
const installedState = (...history: string[]): string => JSON.stringify({
  version: 1, repo: 'owner/name', marketplace: 'lounisbou', history: history.map(commit => ({ commit, at: '2026-01-01T00:00:00Z' })), skipped: [], pending: false, plugins: {},
})

const DIRS_OF = (installed: string) => ({ ownDir: `/cfg/deploys/lounisbou/${RUNNING}`, installedDir: `/cfg/deploys/lounisbou/${installed}` })
// An orchestrator's generation that has lived, by its context, below the gate.
const LIVED = JSON.stringify({ context_tokens: 160000, context_window: 1000000, context_percent: 16, model: 'a-model', updated_at: 't' })
const YOUNG = JSON.stringify({ context_tokens: 40000, context_window: 1000000, context_percent: 4, model: 'a-model', updated_at: new Date().toISOString(), start: { tokens: 1, at: new Date().toISOString(), brief: null, brief_bytes: null } })

test('an orchestrator and a coordinator are told of a newer installed commit once, then of the next one', async () => {
  for (const launchName of ['Orch: belt', 'Coord: belt']) {
    const setup: Setup = { root: DEPLOYED, installed: installedState(INSTALLED, RUNNING), launchName, measure: LIVED }
    const { dollar } = fakeDollar(setup)
    const handlers = mounted()
    const role = launchName.startsWith('Orch') ? 'orchestrator' : 'coordinator'
    expect((await submit(handlers, dollar)).context).toEqual([versionAnnouncement({ own: RUNNING, installed: INSTALLED, ...DIRS_OF(INSTALLED) }, role, role === 'coordinator' ? DEPLOYED : '')])
    expect((await submit(handlers, dollar)).context).toBeUndefined()
    const next = 'c'.repeat(40)
    setup.installed = installedState(next, INSTALLED, RUNNING)
    expect((await submit(handlers, dollar)).context).toEqual([versionAnnouncement({ own: RUNNING, installed: next, ...DIRS_OF(next) }, role, role === 'coordinator' ? DEPLOYED : '')])
  }
})

test('a newer commit that changes no runtime file of a loaded plugin is not told, the next one that does is', async () => {
  const setup: Setup = {
    root: DEPLOYED, installed: installedState(INSTALLED, RUNNING), launchName: 'Coord: belt',
    diff: { exitCode: 1, stdout: `Files /cfg/deploys/lounisbou/${RUNNING}/plugins/orchestrator/README.md and /cfg/deploys/lounisbou/${INSTALLED}/plugins/orchestrator/README.md differ\n` },
  }
  const { dollar } = fakeDollar(setup)
  const handlers = mounted()
  expect((await submit(handlers, dollar)).context).toBeUndefined()
  setup.diff = { exitCode: 0, stdout: '' }
  expect((await submit(handlers, dollar)).context).toBeUndefined()
  const next = 'c'.repeat(40)
  setup.installed = installedState(next, INSTALLED, RUNNING)
  delete setup.diff
  expect((await submit(handlers, dollar)).context).toEqual([versionAnnouncement({ own: RUNNING, installed: next, ...DIRS_OF(next) }, 'coordinator', DEPLOYED)])
})

test('a comparison that cannot be made gives the notice', async () => {
  const { dollar } = fakeDollar({ root: DEPLOYED, installed: installedState(INSTALLED, RUNNING), launchName: 'Coord: belt', diff: { exitCode: 2, stdout: '' } })
  expect((await submit(mounted(), dollar)).context).toEqual([versionAnnouncement({ own: RUNNING, installed: INSTALLED, ...DIRS_OF(INSTALLED) }, 'coordinator', DEPLOYED)])
})

test('a young orchestrator generation is not told of a newer commit until it has lived', async () => {
  const setup: Setup = { root: DEPLOYED, installed: installedState(INSTALLED, RUNNING), launchName: 'Orch: belt', measure: YOUNG }
  const { dollar } = fakeDollar(setup)
  const handlers = mounted()
  expect((await submit(handlers, dollar)).context).toBeUndefined()
  setup.measure = LIVED
  expect((await submit(handlers, dollar)).context).toEqual([versionAnnouncement({ own: RUNNING, installed: INSTALLED, ...DIRS_OF(INSTALLED) }, 'orchestrator', '')])
})

test('a /clear starts the memo over: the new session is told of the newer commit too', async () => {
  const { dollar } = fakeDollar({ root: DEPLOYED, installed: installedState(INSTALLED, RUNNING), launchName: 'Coord: belt' })
  const handlers = mounted()
  expect((await submit(handlers, dollar)).context).toHaveLength(1)
  expect((await submit(handlers, dollar)).context).toBeUndefined()
  dollar.session.id = async () => 's-two'
  expect((await submit(handlers, dollar)).context).toHaveLength(1)
})

test('a session running the installed commit, an agent, and a session with no readable state file are told nothing', async () => {
  const quiet: Setup[] = [
    { root: DEPLOYED, installed: installedState(RUNNING), launchName: 'Orch: belt', measure: LIVED },
    { root: DEPLOYED, installed: installedState(INSTALLED, RUNNING), launchName: 'Agent: belt' },
    { root: DEPLOYED, launchName: 'Orch: belt', measure: LIVED },
    { installed: installedState(INSTALLED, RUNNING), launchName: 'Orch: belt', measure: LIVED },
  ]
  for (const setup of quiet) {
    const { dollar, written } = fakeDollar(setup)
    expect((await submit(mounted(), dollar)).context).toBeUndefined()
    expect(written).toEqual([])
  }
})
