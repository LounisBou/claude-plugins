// hooks/tests/context-gate.test.ts
import { expect, test } from 'claude-code/testing'
import { roleLine, gateAnnouncement, register as registerGuards } from '../guards.ts'
import { register as registerGauge, driftAnnouncement } from '../gauge.ts'
import { logLineOf, blockOf } from './fakes.ts'

test('each role gets its own line, verbatim from the shell gate', () => {
  expect(roleLine('orchestrator')).toBe('Succeed at the next quiet boundary — run /orchestrator-succeed: spawn the successor in the operator\'s decision mode, then tell the user; do not ask.')
  expect(roleLine('agent')).toBe('Finish the unit in progress, end your turn on your status line, and stop; no new phase is dispatched to you.')
  expect(roleLine('coordinator')).toContain('skills/coordination/SKILL.md')
  expect(roleLine('coordinator', '/plugins/orch-root')).toContain('/plugins/orch-root/skills/coordination/SKILL.md')
  expect(roleLine('auditor')).toContain('auditor-succession-brief.md')
  expect(roleLine('none' as any)).toBe('')
})

test('the announcement names what was read', () => {
  const a = gateAnnouncement({ tripped: true, words: '80% (gate 80%)' }, 'agent') // the gate: 300,000 tokens (30 %) on a window of 1,000,000 tokens or more, the common case, and 80 % of a smaller window
  expect(a).toBe('CONTEXT GATE: this session is at 80% (gate 80%). ' + roleLine('agent')) // the gate: 300,000 tokens (30 %) on a window of 1,000,000 tokens or more, the common case, and 80 % of a smaller window
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
  '{"type":"custom-title","customTitle":"  Agent : padded  "}',
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
}

function fakeDollar(setup: Setup): { dollar: any; written: string[] } {
  const written: string[] = []
  const env = { HOME, ORCHESTRATOR_HOST_CLI: '/usr/local/bin/host', ...(setup.env ?? {}) }
  const dollar = {
    session: {
      id: async () => {
        if (setup.noSession) throw new Error('no session id')
        return 's-gate'
      },
    },
    // The plugin's directory comes from the engine, never from the
    // environment: the module's environment carries no CLAUDE_PLUGIN_ROOT.
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    env: { get: async (name: string) => env[name] },
    fs: {
      read: async (p: string) => {
        if (p === MEASURE) {
          if (setup.measure === undefined) throw new Error('ENOENT')
          return setup.measure
        }
        throw new Error(`unread: ${p}`)
      },
      write: async () => undefined,
      stat: async (p: string) => {
        if (p === TRANSCRIPT && setup.transcript !== undefined) {
          return { kind: 'file', size: setup.transcript.length }
        }
        throw new Error('ENOENT')
      },
      list: async (p: string) => (
        p === `${HOME}/.claude/projects`
          ? [{ name: '-a-project', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
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
          return { exitCode: 0, stdout: setup.noLaunchName ? '  501 host\n' : `  501 host --name ${setup.launchName ?? 'Agent : belt'}\n`, stderr: '' }
        }
        if (argv[0] === 'ps') return { exitCode: 0, stdout: '1 ??\n', stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  }
  return { dollar, written }
}

function mounted(): Record<string, Function> {
  const handlers: Record<string, Function> = {}
  registerGuards((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    handlers[args[0]] = args[args.length - 1] as Function
    // The engine's on returns a registration taking one .catch; the fake
    // accepts it and drops it — the body's own catch is what the wiring tests.
    return { catch: () => undefined }
  })
  return handlers
}

async function submit(handlers: Record<string, Function>, dollar: any, e: object = { text: 'go', wait: false, origin: { kind: 'user' } }) {
  let seen: unknown = null
  await handlers['prompt.submit'](dollar, e, (x: unknown) => { seen = x; return x })
  return seen
}

test('past the gate the role line rides the prompt as one context block', async () => {
  const { dollar } = fakeDollar({ transcript: ANSWERED_RENAMED, measure: MEASURED_84 })
  const seen = await submit(mounted(), dollar)
  expect(seen).toMatchObject({
    text: 'go',
    context: [`CONTEXT GATE: this session is at 84% (gate 80%). ${roleLine('agent')}`], // the gate: 300,000 tokens (30 %) on a window of 1,000,000 tokens or more, the common case, and 80 % of a smaller window
  })
})

test('the gate an env var lowered trips on a fill the default lets by', async () => {
  const { dollar } = fakeDollar({
    transcript: ANSWERED_RENAMED,
    measure: JSON.stringify({ context_tokens: 42000, context_window: 100000, context_percent: 42, model: 'a-model', updated_at: 't' }),
    env: { ORCHESTRATOR_CONTEXT_GATE: '1' },
  })
  const seen = await submit(mounted(), dollar)
  expect((seen as any).context[0]).toContain('42% (gate 1%)')
  // Live finding: a session shown a test threshold with no source declined to
  // rotate, reading it as a fault. The line names the variable and says it binds.
  expect((seen as any).context[0]).toContain('This threshold is set by ORCHESTRATOR_CONTEXT_GATE=1 in this session\'s environment: it is binding, not a fault.')
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

test('an unmeasured session is told so once, after a turn has answered', async () => {
  // No launch name, so the session is named by the padded rename alone — the
  // reading the Carries line normalized, proven here through the gate itself.
  const { dollar } = fakeDollar({ transcript: ANSWERED_RENAMED, noLaunchName: true })
  const handlers = mounted()
  const first = await submit(handlers, dollar)
  expect(first).toMatchObject({
    context: ['CONTEXT GATE: unmeasured: the measure file carries no figure; the next turn fills it. The gate (300,000 tokens on a window of 1,000,000 or more, 80% of a smaller window) cannot be read; measure by hand before dispatching or rotating.'], // the gate: 300,000 tokens (30 %) on a window of 1,000,000 tokens or more, the common case, and 80 % of a smaller window
  })
  // Once per session: the next prompt meets the same silence as a low fill.
  const second = await submit(handlers, dollar)
  expect(second).toMatchObject({ text: 'go' })
  expect((second as any).context).toBeUndefined()
})

test('a session whose first prompt this is stays silent', async () => {
  // No measure file and no transcript at all: the tap has not rendered for this
  // session yet, which is not a failure it reports.
  const { dollar } = fakeDollar({})
  const seen = await submit(mounted(), dollar)
  expect(seen).toMatchObject({ text: 'go' })
  expect((seen as any).context).toBeUndefined()
})

test('a session no tty names is never spoken to', async () => {
  const { dollar } = fakeDollar({ noTty: true, transcript: ANSWERED_RENAMED, measure: MEASURED_84 })
  const e = { text: 'go', wait: false, origin: { kind: 'user' } }
  expect(await submit(mounted(), dollar, e)).toBe(e)
})

test('a rename that names nothing leaves the gate silent past the gate itself', async () => {
  // No launch name, so the session is named by its renames alone; the last one
  // names nothing, and the walk must not resurrect the Agent : rename before
  // it — the session is unnamed, and no role is spoken to.
  const renamedAway = [
    '{"type":"assistant","message":{"role":"assistant","content":"an answer"}}',
    '{"type":"custom-title","customTitle":"Agent : earlier"}',
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
    launchName: 'Audit : 1712',
  })
  const seen = await submit(mounted(), dollar)
  expect((seen as any).context[0]).toContain('/plugins/orch-root/templates/auditor-succession-brief.md')
  expect((seen as any).context[0]).not.toContain(' succeed — templates/')
})

test('a handler that fails lets the prompt through and logs one line', async () => {
  const { dollar, written } = fakeDollar({ transcript: ANSWERED_RENAMED, measure: MEASURED_84, noSession: true })
  const e = { text: 'go', wait: false, origin: { kind: 'user' } }
  expect(await submit(mounted(), dollar, e)).toBe(e)
  expect(written.length).toBe(1)
  expect(written[0]).toContain('| guards |')
})

test("a coordinator past the gate is shown its skill's absolute place", async () => {
  const { dollar } = fakeDollar({ transcript: ANSWERED_RENAMED, measure: MEASURED_84, launchName: 'Coord : main' })
  const seen = await submit(mounted(), dollar)
  expect((seen as any).context[0]).toContain('/plugins/orch-root/skills/coordination/SKILL.md')
})

test('a /clear starts the memo over: the new session is told it is unmeasured too', async () => {
  // After a /clear the session id changes and no start fires: a memo held across it
  // named the old transcript and kept the line already said.
  const { dollar } = fakeDollar({ transcript: ANSWERED_RENAMED, noLaunchName: true })
  const handlers = mounted()
  expect((await submit(handlers, dollar) as any).context[0]).toContain('unmeasured')
  const next = `${HOME}/.claude/projects/-a-project/s-two.jsonl`
  const stat = dollar.fs.stat
  dollar.session.id = async () => 's-two'
  dollar.fs.exists = async (p: string) => p === next
  dollar.fs.stat = async (p: string) => (p === next ? { kind: 'file', size: ANSWERED_RENAMED.length } : stat(p))
  expect((await submit(handlers, dollar) as any).context[0]).toContain('unmeasured')
})

test('a model drift the gauge measured rides the next prompt to the model, once, whatever the role', async () => {
  const gauge: Record<string, Function> = {}
  registerGauge((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    gauge[args[0]] = args[args.length - 1] as Function
    return { catch: () => undefined }
  })
  let model = 'a-model'
  const g = {
    session: { usage: async () => ({ context: { tokens: 1, window: 2, percent: 3 } }), model: async () => model, id: async () => 's-gate' },
    fs: { write: async () => undefined },
    env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
    ui: { toast: () => undefined, invalidate: () => undefined },
  }
  await gauge['session.measure'](g, {}, (x: unknown) => x)
  model = 'another-model'
  await gauge['session.measure'](g, {}, (x: unknown) => x)
  // A session with no role at all is still told.
  const { dollar } = fakeDollar({ noLaunchName: true })
  const handlers = mounted()
  const seen = await submit(handlers, dollar)
  expect((seen as any).context).toEqual([driftAnnouncement('another-model', 'a-model')])
  expect((await submit(handlers, dollar) as any).context).toBeUndefined()
})
