// hooks/tests/naming.test.ts
// The session's own rename: the name's shape, the tool declared at every start,
// the call that records the name and the turn's completion that runs the host's
// /rename with it — never from the call itself, which the host refuses.
import { expect, test } from 'claude-code/testing'
import { checkName, END_TOOL, register as registerNaming, RENAME_TOOL, MAIN_THREAD_ONLY, isEnding, homeArgv, resumeText, HOME_MOVE_MS } from '../naming.ts'

// A registration is keyed by its event, and a tool call by its tool too: the
// file serves two tools.
function mounted(): { handlers: Record<string, Function>; matchers: Record<string, object | undefined> } {
  const handlers: Record<string, Function> = {}
  const matchers: Record<string, object | undefined> = {}
  registerNaming((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    const tool = args.length === 3 ? (args[1] as any).tool : undefined
    const key = tool === `mcp__orchestrator__${END_TOOL}` ? 'tool.call:end'
      : tool === 'Bash' || tool === 'SendMessage' ? `tool.call:${tool}` : args[0]
    handlers[key] = args[args.length - 1] as Function
    matchers[key] = args.length === 3 ? args[1] : undefined
    return { catch: () => undefined }
  })
  return { handlers, matchers }
}

function fakeDollar(): { dollar: any; registered: any[]; runs: any[]; submits: any[]; order: string[] } {
  const registered: any[] = []
  const runs: any[] = []
  const submits: any[] = []
  // What the turn's completion queued, in the order it queued it: the rename before the
  // prompt that resumes the session under it.
  const order: string[] = []
  const dollar = {
    env: { get: async (name: string) => (name === 'HOME' ? '/tmp/h' : undefined) },
    fs: { read: async () => '', write: async () => undefined },
    tool: { register: async (spec: any) => { registered.push(spec); return {} } },
    command: { run: (input: any) => { runs.push(input); order.push(`command:${input.command}`); return Promise.resolve({ text: '' }) } },
    prompt: { submit: (input: any) => { submits.push(input); order.push('prompt'); return Promise.resolve({ text: input.text }) } },
  }
  return { dollar, registered, runs, submits, order }
}

test('a session names itself Orch or Coord, the subject in the launcher\'s shape', () => {
  expect(checkName('Orch : PTI améliorations UI')).toEqual({ name: 'Orch : PTI améliorations UI' })
  expect(checkName('Coord : main')).toEqual({ name: 'Coord : main' })
  expect(checkName('Orch : x')).toEqual({ name: 'Orch : x' })
  for (const bad of ['Agent : belt', 'Orch: no-space', 'Orch :  padded', 'Orch : padded ', 'Orch : ' + 'a'.repeat(26), '', 42]) {
    expect('refused' in checkName(bad)).toBe(true)
  }
  expect('refused' in checkName('Orch : ' + 'a'.repeat(25))).toBe(false)
})

test('every start declares the tool with its schema in the prompt', async () => {
  const { handlers, matchers } = mounted()
  expect(matchers['session.start']).toEqual({})
  expect(matchers['tool.call']).toEqual({ tool: `mcp__orchestrator__${RENAME_TOOL}` })
  const fx = fakeDollar()
  const e = {}
  expect(await handlers['session.start'](fx.dollar, e, (x: unknown) => x)).toBe(e)
  expect(fx.registered.map((spec: any) => spec.name)).toEqual(['rename_session', 'end_session'])
  expect(fx.registered.every((spec: any) => spec.isDeferred === false)).toBe(true)
})

test('the end is asked by a call and run when the turn completes, after the rename', async () => {
  const { handlers, matchers } = mounted()
  expect(matchers['tool.call:end']).toEqual({ tool: `mcp__orchestrator__${END_TOOL}` })
  const fx = fakeDollar()
  await handlers['tool.call'](fx.dollar, { name: 'Orch : phase-3' })
  expect(await handlers['tool.call:end'](fx.dollar, {})).toEqual({ result: 'This session ends when this turn ends.' })
  expect(fx.runs).toEqual([])
  await handlers['turn.complete'](fx.dollar, {}, (x: unknown) => x)
  expect(fx.runs).toEqual([{ command: 'rename', args: 'Orch : phase-3' }, { command: 'exit' }])
  await handlers['turn.complete'](fx.dollar, {}, (x: unknown) => x)
  expect(fx.runs.length).toBe(2)
})

test('the call records the name and the turn\'s completion runs the rename, once', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  const answer = await handlers['tool.call'](fx.dollar, { name: 'Orch : phase-3' })
  expect(answer).toEqual({ result: 'This session is renamed "Orch : phase-3" when this turn ends.' })
  // Nothing runs from the call itself: the host refuses a run the turn waits on.
  expect(fx.runs).toEqual([])
  const done = {}
  expect(await handlers['turn.complete'](fx.dollar, done, (x: unknown) => x)).toBe(done)
  expect(fx.runs).toEqual([{ command: 'rename', args: 'Orch : phase-3' }])
  await handlers['turn.complete'](fx.dollar, done, (x: unknown) => x)
  expect(fx.runs.length).toBe(1)
})

// The rename lands when the turn ends, and a session that kept going in the same turn spawned
// its agents and messaged them under its directory-stem name: every agent got the wrong
// orchestrator address. Prose did not hold the turn's end; the module does.
const SPAWN = { tool: 'Bash', command: 'bash /p/skills/iterm-agents/scripts/iterm-agent.sh spawn --dir /w --title "Agent : belt" --prompt p' }
const ROTATE = { tool: 'Bash', command: 'bash /p/skills/iterm-agents/scripts/iterm-agent.sh rotate --tty /dev/ttys003 --prompt p' }
const SEND = { tool: 'SendMessage', to: 'Agent : belt', message: 'your brief' }
const passOn = async (e: any) => ({ result: { ran: e.tool } })

test('while a rename is pending, a spawn, a rotate and a SendMessage are refused until the turn ends', async () => {
  const { handlers, matchers } = mounted()
  expect(matchers['tool.call:Bash']).toEqual({ tool: 'Bash' })
  expect(matchers['tool.call:SendMessage']).toEqual({ tool: 'SendMessage' })
  const fx = fakeDollar()
  // No rename pending: every call runs.
  expect(await handlers['tool.call:Bash'](fx.dollar, SPAWN, passOn)).toEqual({ result: { ran: 'Bash' } })
  expect(await handlers['tool.call:SendMessage'](fx.dollar, SEND, passOn)).toEqual({ result: { ran: 'SendMessage' } })
  await handlers['tool.call'](fx.dollar, { name: 'Orch : belt' })
  const reason = 'your name "Orch : belt" is taken when this turn ends: end the turn now; the module resumes you under it'
  for (const [key, call] of [['tool.call:Bash', SPAWN], ['tool.call:Bash', ROTATE], ['tool.call:SendMessage', SEND]] as const) {
    const answer = await handlers[key](fx.dollar, call, passOn)
    expect(answer.deny).toContain(reason)
  }
  // Any other Bash call runs: only what addresses an agent waits for the name.
  expect(await handlers['tool.call:Bash'](fx.dollar, { tool: 'Bash', command: 'git status' }, passOn)).toEqual({ result: { ran: 'Bash' } })
  expect(await handlers['tool.call:Bash'](fx.dollar, { tool: 'Bash', command: 'bash /p/iterm-agent.sh list' }, passOn)).toEqual({ result: { ran: 'Bash' } })
  await handlers['turn.complete'](fx.dollar, { isAborted: false }, (x: unknown) => x)
  // The next turn runs under the name: nothing is refused any more.
  expect(await handlers['tool.call:Bash'](fx.dollar, SPAWN, passOn)).toEqual({ result: { ran: 'Bash' } })
  expect(await handlers['tool.call:SendMessage'](fx.dollar, SEND, passOn)).toEqual({ result: { ran: 'SendMessage' } })
})

test("a subagent's spawn or message is not the main thread's to hold", async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  await handlers['tool.call'](fx.dollar, { name: 'Orch : belt' })
  expect(await handlers['tool.call:SendMessage'](fx.dollar, { ...SEND, agentId: 'a-1' }, passOn)).toEqual({ result: { ran: 'SendMessage' } })
})

test('the turn that renamed resumes the session under its name, the prompt queued after the rename', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  await handlers['tool.call'](fx.dollar, { name: 'Orch : belt' })
  await handlers['turn.complete'](fx.dollar, { isAborted: false }, (x: unknown) => x)
  expect(fx.submits).toEqual([{ text: 'Your name "Orch : belt" is taken. Continue where you left off.' }])
  expect(fx.order).toEqual(['command:rename', 'prompt'])
  // Once: the next turn's end queues nothing.
  await handlers['turn.complete'](fx.dollar, { isAborted: false }, (x: unknown) => x)
  expect(fx.submits.length).toBe(1)
})

test('no resume on an interrupted turn, for a subagent, or for a session that ends', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  await handlers['tool.call'](fx.dollar, { name: 'Orch : belt' })
  await handlers['turn.complete'](fx.dollar, { agentId: 'a-1', isAborted: false }, (x: unknown) => x)
  await handlers['turn.complete'](fx.dollar, { isAborted: true, reason: 'aborted' }, (x: unknown) => x)
  expect(fx.submits).toEqual([])
  // The interrupted turn dropped the rename: nothing is held any more.
  expect(await handlers['tool.call:SendMessage'](fx.dollar, SEND, passOn)).toEqual({ result: { ran: 'SendMessage' } })
  await handlers['tool.call'](fx.dollar, { name: 'Orch : belt' })
  await handlers['tool.call:end'](fx.dollar, {})
  await handlers['turn.complete'](fx.dollar, { isAborted: false }, (x: unknown) => x)
  expect(fx.order).toEqual(['command:rename', 'command:exit'])
  expect(fx.submits).toEqual([])
})

test('a resume that fails is said in the log, never thrown at the turn', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  const logged: string[] = []
  fx.dollar.plugin = { root: '/plugins/orch-root' }
  fx.dollar.process = { run: async (argv: readonly string[]) => { logged.push(String(argv[3] ?? '')); return { exitCode: 0, stdout: '', stderr: '' } } }
  fx.dollar.prompt.submit = () => Promise.reject(new Error('the session is gone'))
  await handlers['tool.call'](fx.dollar, { name: 'Orch : belt' })
  const done = {}
  expect(await handlers['turn.complete'](fx.dollar, done, (x: unknown) => x)).toBe(done)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(logged.some(line => line.includes('the resume under "Orch : belt" failed: the session is gone'))).toBe(true)
})

test('a session the launcher opened sees the end tool alone, and neither renames nor ends itself without a move', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  fx.dollar.env.get = async (name: string) => (name === 'ORCHESTRATOR_SPAWNED' ? '1' : name === 'HOME' ? '/tmp/h' : undefined)
  const e = {}
  expect(await handlers['session.start'](fx.dollar, e, (x: unknown) => x)).toBe(e)
  expect(fx.registered.map((spec: any) => spec.name)).toEqual([END_TOOL])
  const answer = await handlers['tool.call'](fx.dollar, { name: 'Coord : norms check' })
  expect(answer.isError).toBe(true)
  expect((await handlers['tool.call:end'](fx.dollar, {})).isError).toBe(true)
  await handlers['turn.complete'](fx.dollar, {}, (x: unknown) => x)
  expect(fx.runs).toEqual([])
})

test('a refused name is said to the model and renames nothing', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  const answer = await handlers['tool.call'](fx.dollar, { name: 'Agent : belt' })
  expect(answer.isError).toBe(true)
  expect(answer.result).toContain('"Orch : <subject>" or "Coord : <subject>"')
  await handlers['turn.complete'](fx.dollar, {}, (x: unknown) => x)
  expect(fx.runs).toEqual([])
})

test("a subagent neither names nor ends the session, and its turn's end runs nothing the main loop asked", async () => {
  // A review subagent once renamed its session; one could end the operator's. And a
  // subagent's turn.complete fired inside the main turn took the main loop's rename.
  const { handlers } = mounted()
  const fx = fakeDollar()
  expect(await handlers['tool.call'](fx.dollar, { name: 'Coord : norms check', agentId: 'a-1' })).toEqual({ result: MAIN_THREAD_ONLY, isError: true })
  expect(await handlers['tool.call:end'](fx.dollar, { agentId: 'a-1' })).toEqual({ result: MAIN_THREAD_ONLY, isError: true })
  await handlers['tool.call'](fx.dollar, { name: 'Orch : phase-3' })
  await handlers['turn.complete'](fx.dollar, { agentId: 'a-2', isAborted: false }, (x: unknown) => x)
  expect(fx.runs).toEqual([])
  await handlers['turn.complete'](fx.dollar, { isAborted: false }, (x: unknown) => x)
  expect(fx.runs).toEqual([{ command: 'rename', args: 'Orch : phase-3' }])
})

test('an interrupted turn runs neither the rename nor the end it asked', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  await handlers['tool.call'](fx.dollar, { name: 'Orch : phase-3' })
  await handlers['tool.call:end'](fx.dollar, {})
  expect(isEnding()).toBe(true)
  await handlers['turn.complete'](fx.dollar, { isAborted: true, reason: 'aborted' }, (x: unknown) => x)
  expect(isEnding()).toBe(false)
  await handlers['turn.complete'](fx.dollar, { isAborted: false }, (x: unknown) => x)
  expect(fx.runs).toEqual([])
})

test('the end tool is offered to an orchestrator or a coordinator that has handed over', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  await handlers['session.start'](fx.dollar, {}, (x: unknown) => x)
  expect(fx.registered.find((spec: any) => spec.name === END_TOOL).description)
    .toContain('Only for an orchestrator or a coordinator that has handed over and whose successor asks it to end its session.')
})

// The move into a home session: at the end of the turn that named an orchestrator, the
// launcher's `home` is run; on `moved:` the session ends and window 0 resumes it with the
// resume's prompt, on anything else the session is resumed where it is, as before.
function movingDollar(answer: { exitCode: number; stdout: string; stderr?: string } | Error) {
  const fx = fakeDollar()
  const processes: any[] = []
  const dollar = {
    ...fx.dollar,
    plugin: { root: '/plugin' },
    session: { id: async () => 'S-1' },
    process: {
      run: async (argv: string[], opts: any) => {
        if (argv[1] === 'home') {
          processes.push({ argv, opts })
          if (answer instanceof Error) throw answer
          return answer
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  }
  return { ...fx, dollar, processes }
}

test("an orchestrator's naming turn moves it into its home session, then ends it there", async () => {
  const { handlers } = mounted()
  const fx = movingDollar({ exitCode: 0, stdout: 'moved: orch-S1, shown on /dev/ttys970\n' })
  await handlers['tool.call'](fx.dollar, { name: 'Orch : phase-3' })
  await handlers['turn.complete'](fx.dollar, {}, (x: unknown) => x)
  expect(fx.processes).toEqual([{ argv: ['/plugin/skills/iterm-agents/scripts/iterm-agent.sh', 'home', '--session', 'S-1', '--name', 'Orch : phase-3', '--prompt', resumeText('Orch : phase-3')], opts: { timeoutMs: HOME_MOVE_MS } }])
  expect(fx.order).toEqual(['command:rename', 'command:exit'])
  expect(fx.submits).toEqual([])
})

test('a session the launcher keeps, or a move that fails, is resumed where it is', async () => {
  for (const answer of [{ exitCode: 0, stdout: 'stay: this session already runs in a home session\n' },
    { exitCode: 1, stdout: '', stderr: 'ERROR: home: this session is not a tab of iTerm2s' },
    new Error('spawn failed')]) {
    const { handlers } = mounted()
    const fx = movingDollar(answer)
    await handlers['tool.call'](fx.dollar, { name: 'Orch : phase-3' })
    await handlers['turn.complete'](fx.dollar, {}, (x: unknown) => x)
    expect(fx.processes.length).toBe(1)
    expect(fx.order).toEqual(['command:rename', 'prompt'])
  }
})

test('a coordinator never moves, and neither does a session that asked to end', async () => {
  const { handlers } = mounted()
  const fx = movingDollar({ exitCode: 0, stdout: 'moved: orch-S1\n' })
  await handlers['tool.call'](fx.dollar, { name: 'Coord : main' })
  await handlers['turn.complete'](fx.dollar, {}, (x: unknown) => x)
  expect(fx.processes).toEqual([])
  expect(fx.order).toEqual(['command:rename', 'prompt'])
  const ending = mounted()
  const fy = movingDollar({ exitCode: 0, stdout: 'moved: orch-S1\n' })
  await ending.handlers['tool.call'](fy.dollar, { name: 'Orch : phase-3' })
  await ending.handlers['tool.call:end'](fy.dollar, {})
  await ending.handlers['turn.complete'](fy.dollar, {}, (x: unknown) => x)
  expect(fy.processes).toEqual([])
  expect(fy.order).toEqual(['command:rename', 'command:exit'])
})

test('the move is the launcher with the session, its name and the resume prompt', () => {
  expect(homeArgv('/r', 'S', 'Orch : x')).toEqual(['/r/skills/iterm-agents/scripts/iterm-agent.sh', 'home', '--session', 'S', '--name', 'Orch : x', '--prompt', 'Your name "Orch : x" is taken. Continue where you left off.'])
})
