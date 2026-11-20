// hooks/tests/naming.test.ts
// The session's own rename: the name's shape, the tool declared at every start,
// the call that records the name and the turn's completion that runs the host's
// /rename with it — never from the call itself, which the host refuses.
import { expect, test } from 'claude-code/testing'
import type { Reply } from 'claude-code/testing'
import { journalled, logLineOf } from './fakes.ts'
import { capture, hookOf, hooksOn, hostOf, type CapturedOn } from '../../core/capture.ts'
import type { Events, Host, Noun, ProcessRunInit, ToolSpec } from '../../core/host.ts'
import { checkName, END_TOOL, register as registerNaming, RENAME_TOOL, MAIN_THREAD_ONLY, homeArgv, resumeText, HOME_MOVE_MS, HOME_GRACE_MS, movedPromptLine, runsTakeover, TAKEN_OVER_TEXT, TAKEN_OVER_STAYED_TEXT, TAKEN_OVER_HOME_TEXT } from '../naming.ts'

type World = Host<Noun>

// A registration is keyed by its event, and a tool call by its tool too: the
// file serves two tools.
type Pass<E> = (e: E) => Promise<unknown>
const pass = async <E>(x: E): Promise<E> => x
const noNext = async (): Promise<never> => { throw new Error('no next in this test') }
// A captured hook, called with the test's own $, event and next; its answer read as a reply.
const callOf = <K extends keyof Events>(h: CapturedOn<World, K>) =>
  async (dollar: World, e: Events[K], next: Pass<Events[K]> = noNext): Promise<Reply> => (await h.handler(dollar, e, next)) as Reply

function mounted() {
  const hooks = capture<World>(registerNaming)
  const toolHook = (tool: string): CapturedOn<World, 'tool.call'> => {
    const found = hooksOn(hooks, 'tool.call').find(h => h.matcher?.['tool'] === tool)
    if (found === undefined) throw new Error(`no hook on ${tool}`)
    return found
  }
  const start = hookOf(hooks, 'session.start', {})
  const rename = toolHook(`mcp__orchestrator__${RENAME_TOOL}`)
  const end = toolHook(`mcp__orchestrator__${END_TOOL}`)
  // The hook on Bash: the one that reads a successor's takeover.
  const takeover = toolHook('Bash')
  const complete = hookOf(hooks, 'turn.complete')
  const handlers = {
    'session.start': callOf(start),
    'tool.call': callOf(rename),
    'tool.call:end': callOf(end),
    'tool.call:takeover': callOf(takeover),
    'turn.complete': callOf(complete),
    'prompt.submit': callOf(hookOf(hooks, 'prompt.submit', {})),
    'command.run': callOf(hookOf(hooks, 'command.run', { command: 'exit' })),
  }
  const matchers = {
    'session.start': start.matcher, 'tool.call': rename.matcher, 'tool.call:end': end.matcher,
  }
  return { handlers, matchers }
}

type Run = { readonly command: string; readonly args?: string }
function fakeDollar(): { dollar: World; registered: ToolSpec[]; runs: Run[]; submits: { text: string }[]; order: string[]; logged: string[] } {
  const logged: string[] = []
  const registered: ToolSpec[] = []
  const runs: Run[] = []
  const submits: { text: string }[] = []
  // What the turn's completion queued, in the order it queued it: the rename before the
  // prompt that resumes the session under it.
  const order: string[] = []
  const dollar = hostOf({
    plugin: { root: '/plugins/orch-root' },
    env: { get: async (name: string) => (name === 'HOME' ? '/tmp/h' : undefined) },
    fs: { read: async () => '', write: async () => undefined, list: async () => [] },
    session: { id: async () => 'a1b2c3' },
    // The module's log lines, kept; any other run answers nothing.
    process: { run: async (argv: readonly string[]) => { const line = logLineOf(argv); if (line !== null) logged.push(line); return { exitCode: 0, stdout: '', stderr: '' } } },
    tool: { register: async (spec: ToolSpec) => { registered.push(spec); return {} } },
    command: { run: (input: Run) => { runs.push(input); order.push(`command:${input.command}`); return Promise.resolve({ text: '' }) } },
    prompt: { submit: (input: { text: string }) => { submits.push(input); order.push('prompt'); return Promise.resolve({ text: input.text }) } },
  })
  return { dollar, registered, runs, submits, order, logged }
}

test('a session names itself Orch or Coord, the subject in the launcher\'s shape', () => {
  expect(checkName('Orch: PTI améliorations UI')).toEqual({ name: 'Orch: PTI améliorations UI' })
  expect(checkName('Coord: main')).toEqual({ name: 'Coord: main' })
  expect(checkName('Orch: x')).toEqual({ name: 'Orch: x' })
  // The former shape, a blank before the colon, is taken written the current way.
  expect(checkName('Orch : x')).toEqual({ name: 'Orch: x' })
  expect(checkName('Coord : main')).toEqual({ name: 'Coord: main' })
  for (const bad of ['Agent: belt', 'Agent : belt', 'Orch:no-space', 'Orch:  padded', 'Orch: padded ', 'Orch: ' + 'a'.repeat(26), '', 42]) {
    expect('refused' in checkName(bad)).toBe(true)
  }
  expect('refused' in checkName('Orch: ' + 'a'.repeat(25))).toBe(false)
})

test('every start declares the tool with its schema in the prompt', async () => {
  const { handlers, matchers } = mounted()
  expect(matchers['session.start']).toEqual({})
  expect(matchers['tool.call']).toEqual({ tool: `mcp__orchestrator__${RENAME_TOOL}` })
  const fx = fakeDollar()
  const e = { cwd: '/w' }
  expect(await handlers['session.start'](fx.dollar, e, pass)).toBe(e)
  expect(fx.registered.map(spec => spec.name)).toEqual(['rename_session', 'end_session'])
  expect(fx.registered.every(spec => spec.isDeferred === false)).toBe(true)
})

test('the end is asked by a call and run when the turn completes, after the rename', async () => {
  const { handlers, matchers } = mounted()
  expect(matchers['tool.call:end']).toEqual({ tool: `mcp__orchestrator__${END_TOOL}` })
  const fx = fakeDollar()
  await handlers['tool.call'](fx.dollar, { name: 'Orch: phase-3' })
  expect(await handlers['tool.call:end'](fx.dollar, {})).toEqual({ result: 'This session ends when this turn ends.' })
  expect(fx.runs).toEqual([])
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.runs).toEqual([{ command: 'rename', args: 'Orch: phase-3' }, { command: 'exit' }])
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.runs.length).toBe(2)
})

test('the call records the name and the turn\'s completion runs the rename, once', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  const answer = await handlers['tool.call'](fx.dollar, { name: 'Orch: phase-3' })
  expect(answer).toEqual({ result: 'This session is renamed "Orch: phase-3" when this turn ends.' })
  // Nothing runs from the call itself: the host refuses a run the turn waits on.
  expect(fx.runs).toEqual([])
  const done = {}
  expect(await handlers['turn.complete'](fx.dollar, done, pass)).toBe(done)
  expect(fx.runs).toEqual([{ command: 'rename', args: 'Orch: phase-3' }])
  await handlers['turn.complete'](fx.dollar, done, pass)
  expect(fx.runs.length).toBe(1)
})

test('the turn that renamed resumes the session under its name, the prompt queued after the rename', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  await handlers['tool.call'](fx.dollar, { name: 'Orch: belt' })
  await handlers['turn.complete'](fx.dollar, { isAborted: false }, pass)
  expect(fx.submits).toEqual([{ text: 'Your name "Orch: belt" is taken. Continue where you left off.' }])
  expect(fx.order).toEqual(['command:rename', 'prompt'])
  // Once: the next turn's end queues nothing.
  await handlers['turn.complete'](fx.dollar, { isAborted: false }, pass)
  expect(fx.submits.length).toBe(1)
})

test('no resume on an interrupted turn, for a subagent, or for a session that ends', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  await handlers['tool.call'](fx.dollar, { name: 'Orch: belt' })
  await handlers['turn.complete'](fx.dollar, { agentId: 'a-1', isAborted: false }, pass)
  await handlers['turn.complete'](fx.dollar, { isAborted: true, reason: 'aborted' }, pass)
  expect(fx.submits).toEqual([])
  await handlers['tool.call'](fx.dollar, { name: 'Orch: belt' })
  await handlers['tool.call:end'](fx.dollar, {})
  await handlers['turn.complete'](fx.dollar, { isAborted: false }, pass)
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
  await handlers['tool.call'](fx.dollar, { name: 'Orch: belt' })
  const done = {}
  expect(await handlers['turn.complete'](fx.dollar, done, pass)).toBe(done)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(logged.some(line => line.includes('the resume under "Orch: belt" failed: the session is gone'))).toBe(true)
})

test('a session the launcher opened sees neither tool, and neither renames nor ends itself', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  fx.dollar.env.get = async (name: string) => (name === 'ORCHESTRATOR_SPAWNED' ? '1' : name === 'HOME' ? '/tmp/h' : undefined)
  const e = { cwd: '/w' }
  expect(await handlers['session.start'](fx.dollar, e, pass)).toBe(e)
  expect(fx.registered).toEqual([])
  const answer = await handlers['tool.call'](fx.dollar, { name: 'Coord: norms check' })
  expect(answer.isError).toBe(true)
  expect((await handlers['tool.call:end'](fx.dollar, {})).isError).toBe(true)
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.runs).toEqual([])
})

test('a refused name is said to the model and renames nothing', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  const answer = await handlers['tool.call'](fx.dollar, { name: 'Agent: belt' })
  expect(answer.isError).toBe(true)
  expect(answer.result).toContain('"Orch: <subject>" or "Coord: <subject>"')
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.runs).toEqual([])
})

test("a subagent neither names nor ends the session, and its turn's end runs nothing the main loop asked", async () => {
  // A review subagent once renamed its session; one could end the operator's. And a
  // subagent's turn.complete fired inside the main turn took the main loop's rename.
  const { handlers } = mounted()
  const fx = fakeDollar()
  expect(await handlers['tool.call'](fx.dollar, { name: 'Coord: norms check', agentId: 'a-1' })).toEqual({ result: MAIN_THREAD_ONLY, isError: true })
  expect(await handlers['tool.call:end'](fx.dollar, { agentId: 'a-1' })).toEqual({ result: MAIN_THREAD_ONLY, isError: true })
  await handlers['tool.call'](fx.dollar, { name: 'Orch: phase-3' })
  await handlers['turn.complete'](fx.dollar, { agentId: 'a-2', isAborted: false }, pass)
  expect(fx.runs).toEqual([])
  await handlers['turn.complete'](fx.dollar, { isAborted: false }, pass)
  expect(fx.runs).toEqual([{ command: 'rename', args: 'Orch: phase-3' }])
})

test('an interrupted turn runs neither the rename nor the end it asked', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  await handlers['tool.call'](fx.dollar, { name: 'Orch: phase-3' })
  await handlers['tool.call:end'](fx.dollar, {})
  await handlers['turn.complete'](fx.dollar, { isAborted: true, reason: 'aborted' }, pass)
  await handlers['turn.complete'](fx.dollar, { isAborted: false }, pass)
  expect(fx.runs).toEqual([])
})

test('the end tool is offered to an orchestrator or a coordinator that has handed over', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  await handlers['session.start'](fx.dollar, { cwd: '/w' }, pass)
  expect(fx.registered.find(spec => spec.name === END_TOOL)?.description)
    .toContain('Only for an orchestrator or a coordinator that has handed over and whose successor asks it to end its session.')
})

// The move into a home session: at the end of the turn that named an orchestrator, the
// launcher's `home` is run; on `moved:` the session ends and window 0 resumes it with the
// resume's prompt, on anything else the session is resumed where it is, as before.
// The session's row in the store names it: an orchestrator unless the test says otherwise, the
// role a takeover's move and wake are for.
function movingDollar(answer: { exitCode: number; stdout: string; stderr?: string } | Error, name = 'Orch: plugins') {
  const fx = fakeDollar()
  const processes: { argv: readonly string[]; opts: ProcessRunInit | undefined }[] = []
  const row = JSON.stringify({ name, updated_at: '2026-11-15T20:00:00.000Z' })
  const dollar: World = {
    ...fx.dollar,
    fs: { ...fx.dollar.fs, read: async (path: string) => (path.endsWith('/store/sessions/S-1') ? row : '') },
    plugin: { root: '/plugin' },
    session: { ...fx.dollar.session, id: async () => 'S-1' },
    process: {
      run: async (argv: readonly string[], opts?: ProcessRunInit) => {
        if (argv[1] === 'home') {
          processes.push({ argv, opts })
          if (answer instanceof Error) throw answer
          return { stderr: '', ...answer }
        }
        const line = logLineOf(argv)
        if (line !== null) fx.logged.push(line)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  }
  return { ...fx, dollar, processes }
}

test("an orchestrator's naming turn moves it into its home session, then ends it there", async () => {
  const { handlers } = mounted()
  const fx = movingDollar({ exitCode: 0, stdout: 'moved: orch-S1, shown on /dev/ttys970\n' })
  await handlers['tool.call'](fx.dollar, { name: 'Orch: phase-3' })
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.processes).toEqual([{ argv: ['/plugin/skills/iterm-agents/scripts/iterm-agent.sh', 'home', '--session', 'S-1', '--name', 'Orch: phase-3', '--prompt', resumeText('Orch: phase-3')], opts: { timeoutMs: HOME_MOVE_MS } }])
  expect(fx.order).toEqual(['command:rename', 'command:exit'])
  expect(fx.submits).toEqual([])
})

// A prompt typed once the move is made never starts a turn in the old host: the old host would run
// it ahead of the queued exit and go on in its old tab, window 0 waiting for a session that never
// ends. The launcher says how long window 0 waits (`wait:`), and the module holds the typed prompts
// no longer than that, the old host having then failed to end.
const MOVED_WAITING = { exitCode: 0, stdout: 'moved: orch-S1, shown on /dev/ttys970\nwait: 120\n' }
const typed = { origin: { kind: 'composer' }, text: 'and the next phase?' }

// A host with the clock and the toast a held move reads: the timers armed, the toasts said.
function heldDollar(answer: Parameters<typeof movingDollar>[0], gate?: Promise<void>) {
  const fx = movingDollar(answer)
  const timers: { ms: number; run: () => unknown }[] = []
  const toasts: string[] = []
  const dollar: World = {
    ...fx.dollar,
    clock: { ...fx.dollar.clock, after: (ms: number, run: () => unknown) => { timers.push({ ms, run }); return {} } },
    ui: { ...fx.dollar.ui, toast: (text: string) => { toasts.push(text) } },
    process: {
      ...fx.dollar.process,
      run: async (argv: readonly string[], opts?: ProcessRunInit) => { if (argv[1] === 'home') await gate; return fx.dollar.process.run(argv, opts) },
    },
  }
  return { ...fx, dollar, timers, toasts }
}

test('a prompt typed after the move is refused with the new tab named, and the old host ends', async () => {
  const { handlers } = mounted()
  const fx = heldDollar(MOVED_WAITING)
  await handlers['tool.call'](fx.dollar, { name: 'Orch: phase-3' })
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.order).toEqual(['command:rename', 'command:exit'])
  const answer = await handlers['prompt.submit'](fx.dollar, typed, noNext)
  expect(answer).toEqual({ drop: movedPromptLine('Orch: phase-3') })
  expect(movedPromptLine('Orch: phase-3')).toContain('Orch: phase-3')
  // A delivery that is not the operator's own typing goes on: only his prompt is turned away.
  const peer = { origin: { kind: 'peer' }, text: 'a report' }
  expect(await handlers['prompt.submit'](fx.dollar, peer, pass)).toBe(peer)
})

test('a turn that ends after the move asks the exit again, so the old host ends whatever ran in it', async () => {
  const { handlers } = mounted()
  const fx = heldDollar(MOVED_WAITING)
  await handlers['tool.call'](fx.dollar, { name: 'Orch: phase-3' })
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.order).toEqual(['command:rename', 'command:exit'])
  await handlers['turn.complete'](fx.dollar, {}, pass)
  await handlers['turn.complete'](fx.dollar, { isAborted: true, reason: 'aborted' }, pass)
  expect(fx.order).toEqual(['command:rename', 'command:exit', 'command:exit', 'command:exit'])
  // A subagent's turn is inside the main one: it asks nothing.
  await handlers['turn.complete'](fx.dollar, { agentId: 'sub' }, pass)
  expect(fx.runs.length).toBe(4)
  // Once the wait is over and the session is still here, a turn end asks nothing more.
  await fx.timers[0]!.run()
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.runs.length).toBe(4)
})

test('a prompt typed while the move is still being made waits for its answer', async () => {
  const { handlers } = mounted()
  let release: () => void = () => undefined
  const fx = heldDollar(MOVED_WAITING, new Promise<void>(done => { release = done }))
  await handlers['tool.call'](fx.dollar, { name: 'Orch: phase-3' })
  const turn = handlers['turn.complete'](fx.dollar, {}, pass)
  const prompt = handlers['prompt.submit'](fx.dollar, typed, noNext)
  release()
  await turn
  expect(await prompt).toEqual({ drop: movedPromptLine('Orch: phase-3') })
  // The same prompt, the move having failed, is the session's own turn.
  const failed = heldDollar({ exitCode: 1, stdout: '', stderr: 'ERROR: home: no tab' }, Promise.resolve())
  const again = mounted()
  await again.handlers['tool.call'](failed.dollar, { name: 'Orch: phase-3' })
  await again.handlers['turn.complete'](failed.dollar, {}, pass)
  expect(await again.handlers['prompt.submit'](failed.dollar, typed, pass)).toBe(typed)
})

test('a timer that cannot be armed holds no prompt', async () => {
  const { handlers } = mounted()
  const fx = heldDollar(MOVED_WAITING)
  const broken: World = { ...fx.dollar, clock: { ...fx.dollar.clock, after: () => { throw new Error('no clock') } } }
  await handlers['tool.call'](broken, { name: 'Orch: phase-3' })
  await handlers['turn.complete'](broken, {}, pass)
  expect(await handlers['prompt.submit'](broken, typed, pass)).toBe(typed)
})

test('a move that says no wait holds no prompt and arms no timer', async () => {
  const { handlers } = mounted()
  const fx = heldDollar({ exitCode: 0, stdout: 'moved: orch-S1, shown on /dev/ttys970\n' })
  await handlers['tool.call'](fx.dollar, { name: 'Orch: phase-3' })
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.timers).toEqual([])
  expect(await handlers['prompt.submit'](fx.dollar, typed, pass)).toBe(typed)
})

test('an old host that does not end says so, takes prompts again, and moves cleanly on the next naming turn', async () => {
  const { handlers } = mounted()
  const fx = heldDollar(MOVED_WAITING)
  await handlers['tool.call'](fx.dollar, { name: 'Orch: phase-3' })
  await handlers['turn.complete'](fx.dollar, {}, pass)
  // Armed once window 0's wait is over, with its grace: the timer firing means the host is still here.
  expect(fx.timers.map(t => t.ms)).toEqual([120_000 + HOME_GRACE_MS])
  expect(fx.toasts).toEqual([])
  await fx.timers[0]!.run()
  expect(fx.toasts.length).toBe(1)
  expect(fx.toasts[0]).toContain('did not end')
  expect(fx.logged.some(l => l.includes('the old session did not end within 120s') && l.includes('stays here'))).toBe(true)
  expect(await handlers['prompt.submit'](fx.dollar, typed, pass)).toBe(typed)
  // The next naming turn tries the whole move again.
  await handlers['tool.call'](fx.dollar, { name: 'Orch: phase-3' })
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.processes.length).toBe(2)
  expect(fx.order.filter(o => o === 'command:exit').length).toBe(2)
  expect(await handlers['prompt.submit'](fx.dollar, typed, noNext)).toEqual({ drop: movedPromptLine('Orch: phase-3') })
})

test('an exit the failed move left queued is dropped when it runs late, and never ends the session', async () => {
  const { handlers } = mounted()
  const fx = heldDollar(MOVED_WAITING)
  await handlers['tool.call'](fx.dollar, { name: 'Orch: phase-3' })
  await handlers['turn.complete'](fx.dollar, {}, pass)
  // A turn that ended past the move asked the exit again: two are queued in the host.
  await handlers['turn.complete'](fx.dollar, {}, pass)
  await fx.timers[0]!.run()
  const fromPlugin = { command: 'exit', args: '', origin: { kind: 'plugin', name: 'orchestrator' } }
  const ran = (e: typeof fromPlugin) => handlers['command.run'](fx.dollar, e, async () => ({ text: 'exit ran' }))
  // The host goes idle later and runs what was queued: both are dropped, the session goes on.
  expect(await ran(fromPlugin)).toEqual({ text: expect.stringContaining('dropped') })
  expect(await ran(fromPlugin)).toEqual({ text: expect.stringContaining('dropped') })
  expect(fx.logged.filter(l => l.includes('exit queued by the failed move')).length).toBe(2)
  // An exit that is not left over from the move runs: the operator's own, and a later one of the module.
  expect(await ran(fromPlugin)).toEqual({ text: 'exit ran' })
  expect(await ran({ command: 'exit', args: '', origin: { kind: 'composer' } } as typeof fromPlugin)).toEqual({ text: 'exit ran' })
})

test('an exit runs when the move did not fail', async () => {
  const { handlers } = mounted()
  const fx = heldDollar(MOVED_WAITING)
  await handlers['tool.call'](fx.dollar, { name: 'Orch: phase-3' })
  await handlers['turn.complete'](fx.dollar, {}, pass)
  const e = { command: 'exit', args: '', origin: { kind: 'plugin', name: 'orchestrator' } }
  expect(await handlers['command.run'](fx.dollar, e, async () => ({ text: 'exit ran' }))).toEqual({ text: 'exit ran' })
})

test("a successor's move holds its typed prompts the same way, naming the tab without a name", async () => {
  const { handlers } = mounted()
  const fx = heldDollar(MOVED_WAITING)
  await handlers['tool.call:takeover'](fx.dollar, { command: TAKEOVER_LINE }, async () => ({ result: 'printed' }))
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(await handlers['prompt.submit'](fx.dollar, typed, noNext)).toEqual({ drop: movedPromptLine('') })
})

// An orchestrator the operator resumed outside its home session is already named
// Orch: …, so no turn of its own calls the rename: the end of its first uninterrupted turn moves it.
const RESUMED = { exitCode: 0, stdout: 'moved: orch-S1, shown on /dev/ttys970\nwait: 120\n' }

test('an orchestrator resumed outside its home session is moved at the end of its first turn, whatever the turn did', async () => {
  const { handlers } = mounted()
  const fx = heldDollar(RESUMED)
  await handlers['session.start'](fx.dollar, { cwd: '/w' }, pass)
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.processes).toEqual([{ argv: ['/plugin/skills/iterm-agents/scripts/iterm-agent.sh', 'home', '--session', 'S-1', '--name', 'Orch: plugins', '--prompt', resumeText('Orch: plugins')], opts: { timeoutMs: HOME_MOVE_MS } }])
  expect(fx.order).toEqual(['command:exit'])
  // Once: the next turn end moves nothing more.
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.processes.length).toBe(1)
})

test('an interrupted first turn moves nothing, and the next turn end moves it', async () => {
  const { handlers } = mounted()
  const fx = heldDollar(RESUMED)
  await handlers['session.start'](fx.dollar, { cwd: '/w' }, pass)
  await handlers['turn.complete'](fx.dollar, { isAborted: true, reason: 'aborted' }, pass)
  expect(fx.processes).toEqual([])
  await handlers['turn.complete'](fx.dollar, { agentId: 'sub' }, pass)
  expect(fx.processes).toEqual([])
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.processes.length).toBe(1)
  expect(fx.order).toEqual(['command:exit'])
})

test('a naming turn that was interrupted is moved at the next turn end, the session being named already', async () => {
  const { handlers } = mounted()
  const fx = heldDollar(RESUMED)
  await handlers['session.start'](fx.dollar, { cwd: '/w' }, pass)
  await handlers['tool.call'](fx.dollar, { name: 'Orch: plugins' })
  await handlers['turn.complete'](fx.dollar, { isAborted: true, reason: 'aborted' }, pass)
  expect(fx.processes).toEqual([])
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.processes.length).toBe(1)
  expect(fx.order).toEqual(['command:exit'])
})

test('a resumed orchestrator the launcher keeps, or whose move fails, is tried once and goes on where it is', async () => {
  for (const answer of [{ exitCode: 0, stdout: 'stay: this session already runs in a home session\n' },
    { exitCode: 1, stdout: '', stderr: 'ERROR: home: this session is not a tab of iTerm2s' }, new Error('spawn failed')]) {
    const { handlers } = mounted()
    const fx = heldDollar(answer)
    await handlers['session.start'](fx.dollar, { cwd: '/w' }, pass)
    await handlers['turn.complete'](fx.dollar, {}, pass)
    await handlers['turn.complete'](fx.dollar, {}, pass)
    expect(fx.processes.length).toBe(1)
    expect(fx.order).toEqual([])
    expect(fx.submits).toEqual([])
  }
})

test('a session the launcher opened, or that is no orchestrator, is not moved by a turn end alone', async () => {
  const spawned = mounted()
  const fx = heldDollar(RESUMED)
  const dollar: World = { ...fx.dollar, env: { get: async (name: string) => (name === 'ORCHESTRATOR_SPAWNED' ? '1' : undefined) } }
  await spawned.handlers['session.start'](dollar, { cwd: '/w' }, pass)
  await spawned.handlers['turn.complete'](dollar, {}, pass)
  expect(fx.processes).toEqual([])
  for (const name of ['Coord: main', 'Agent: x', 'plugins']) {
    const { handlers } = mounted()
    const fy = movingDollar(RESUMED, name)
    await handlers['session.start'](fy.dollar, { cwd: '/w' }, pass)
    await handlers['turn.complete'](fy.dollar, {}, pass)
    expect(fy.processes, name).toEqual([])
  }
  // A session this module never saw start is left to the rename and the takeover.
  const unseen = mounted()
  const fz = heldDollar(RESUMED)
  await unseen.handlers['turn.complete'](fz.dollar, {}, pass)
  expect(fz.processes).toEqual([])
})

test('a session the launcher keeps, or a move that fails, is resumed where it is', async () => {
  for (const answer of [{ exitCode: 0, stdout: 'stay: this session already runs in a home session\n' },
    { exitCode: 1, stdout: '', stderr: 'ERROR: home: this session is not a tab of iTerm2s' },
    new Error('spawn failed')]) {
    const { handlers } = mounted()
    const fx = movingDollar(answer)
    await handlers['tool.call'](fx.dollar, { name: 'Orch: phase-3' })
    await handlers['turn.complete'](fx.dollar, {}, pass)
    expect(fx.processes.length).toBe(1)
    expect(fx.order).toEqual(['command:rename', 'prompt'])
  }
})

test('a coordinator never moves, and neither does a session that asked to end', async () => {
  const { handlers } = mounted()
  const fx = movingDollar({ exitCode: 0, stdout: 'moved: orch-S1\n' })
  await handlers['tool.call'](fx.dollar, { name: 'Coord: main' })
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.processes).toEqual([])
  expect(fx.order).toEqual(['command:rename', 'prompt'])
  const ending = mounted()
  const fy = movingDollar({ exitCode: 0, stdout: 'moved: orch-S1\n' })
  await ending.handlers['tool.call'](fy.dollar, { name: 'Orch: phase-3' })
  await ending.handlers['tool.call:end'](fy.dollar, {})
  await ending.handlers['turn.complete'](fy.dollar, {}, pass)
  expect(fy.processes).toEqual([])
  expect(fy.order).toEqual(['command:rename', 'command:exit'])
})

test('the move is the launcher with the session, its name and the resume prompt', () => {
  expect(homeArgv('/r', 'S', 'Orch: x')).toEqual(['/r/skills/iterm-agents/scripts/iterm-agent.sh', 'home', '--session', 'S', '--name', 'Orch: x', '--prompt', 'Your name "Orch: x" is taken. Continue where you left off.'])
})

// A successor the launcher opened has no rename: the end of the turn that ran its takeover makes
// the same move, without a name (the launcher reads the session's own on its tty).
const TAKEOVER_LINE = '/p/skills/orchestrator/scripts/succession.sh takeover /w/dispatch-record.jsonl --mode build --tty /dev/ttys009'

test("a successor's takeover turn moves it into its home session, then ends it there", async () => {
  const { handlers } = mounted()
  const fx = movingDollar({ exitCode: 0, stdout: 'moved: orch-S1, shown on /dev/ttys970\n' })
  await handlers['tool.call:takeover'](fx.dollar, { command: TAKEOVER_LINE }, async () => ({ result: 'printed' }))
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.processes).toEqual([{ argv: ['/plugin/skills/iterm-agents/scripts/iterm-agent.sh', 'home', '--session', 'S-1', '--prompt', TAKEN_OVER_TEXT], opts: { timeoutMs: HOME_MOVE_MS } }])
  expect(fx.order).toEqual(['command:exit'])
  // The next turn ran no takeover: nothing more moves.
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.processes.length).toBe(1)
})

test("a successor the launcher finds already in its home session goes on to step 4 there, the answer logged", async () => {
  const { handlers } = mounted()
  const fx = movingDollar({ exitCode: 0, stdout: 'stay: this session already runs in a home session\n' })
  await handlers['tool.call:takeover'](fx.dollar, { command: TAKEOVER_LINE }, async () => ({ result: 'printed' }))
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.processes.length).toBe(1)
  expect(fx.order).toEqual(['prompt'])
  expect(fx.submits).toEqual([{ text: TAKEN_OVER_HOME_TEXT }])
  expect(fx.logged.some(line => line.includes('the launcher kept the session where it is: this session already runs in a home session'))).toBe(true)
  expect(TAKEN_OVER_HOME_TEXT).toContain('step 4')
  expect(TAKEN_OVER_HOME_TEXT).not.toContain('did not happen')
  // The wake is for the takeover's turn alone: the next turn wakes nothing.
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.submits.length).toBe(1)
})

test("a successor whose move does not happen is woken in its tab, the launcher's answer logged", async () => {
  const cases: [string, { exitCode: number; stdout: string; stderr?: string } | Error, string][] = [
    ['the launcher keeps it for another reason (stay:)', { exitCode: 0, stdout: 'stay: only an orchestrator moves into a home session, and this session is named "Agent: x"\n' }, 'the launcher kept the session where it is: only an orchestrator moves into a home session'],
    ['the launcher answers nothing', { exitCode: 0, stdout: '' }, 'the launcher kept the session where it is: no answer'],
    ['the move fails', { exitCode: 1, stdout: '', stderr: 'ERROR: home: this session is not a tab of iTerm2s' }, 'the move into a home session failed, the session stays where it is: ERROR: home: this session is not a tab of iTerm2s'],
    ['the move cannot run', new Error('spawn failed'), 'the move into a home session could not run, the session stays where it is: spawn failed'],
  ]
  for (const [what, answer, logged] of cases) {
    const { handlers } = mounted()
    const fx = movingDollar(answer)
    await handlers['tool.call:takeover'](fx.dollar, { command: TAKEOVER_LINE }, async () => ({ result: 'printed' }))
    await handlers['turn.complete'](fx.dollar, {}, pass)
    expect(fx.processes.length, what).toBe(1)
    expect(fx.order, what).toEqual(['prompt'])
    expect(fx.submits, what).toEqual([{ text: TAKEN_OVER_STAYED_TEXT }])
    expect(fx.logged.some(line => line.includes(logged)), `${what}: ${fx.logged.join(' | ')}`).toBe(true)
    // The wake is for the takeover's turn alone: the next turn wakes nothing.
    await handlers['turn.complete'](fx.dollar, {}, pass)
    expect(fx.submits.length, what).toBe(1)
  }
  expect(TAKEN_OVER_STAYED_TEXT).toContain('step 4')
})

test('a takeover that failed, was interrupted, ended the session or was run by a subagent moves and wakes nothing', async () => {
  for (const [e, answer, done] of [
    [{ command: TAKEOVER_LINE }, { result: 'succession: no dispatch record', isError: true }, {}],
    [{ command: TAKEOVER_LINE }, { result: 'printed' }, { isAborted: true }],
    [{ command: TAKEOVER_LINE, agentId: 'sub' }, { result: 'printed' }, {}],
    [{ command: 'ls /w' }, { result: '' }, {}],
  ] as const) {
    const { handlers } = mounted()
    const fy = movingDollar({ exitCode: 0, stdout: 'moved: orch-S1\n' })
    await handlers['tool.call:takeover'](fy.dollar, e, async () => answer)
    await handlers['turn.complete'](fy.dollar, done, pass)
    expect(fy.processes).toEqual([])
    expect(fy.order).toEqual([])
  }
  const ending = mounted()
  const fz = movingDollar({ exitCode: 0, stdout: 'moved: orch-S1\n' })
  await ending.handlers['tool.call:takeover'](fz.dollar, { command: TAKEOVER_LINE }, async () => ({ result: 'printed' }))
  await ending.handlers['tool.call:end'](fz.dollar, {})
  await ending.handlers['turn.complete'](fz.dollar, {}, pass)
  expect(fz.processes).toEqual([])
  expect(fz.submits).toEqual([])
})

// Seen 2026-11-15: an agent that ran the succession script's takeover in its checkout (its own
// tests, a review's proof) was sent « go on to step 4 of your takeover »; the move and the wake
// are a successor orchestrator's alone.
test('a takeover run by a session that is not an orchestrator moves and wakes nothing', async () => {
  for (const name of ['Agent: takeoversense', 'Review: app#396']) {
    const { handlers } = mounted()
    const fx = movingDollar({ exitCode: 0, stdout: 'stay: not a tab\n' }, name)
    await handlers['tool.call:takeover'](fx.dollar, { command: TAKEOVER_LINE }, async () => ({ result: 'printed' }))
    await handlers['turn.complete'](fx.dollar, {}, pass)
    expect(fx.processes, name).toEqual([])
    expect(fx.submits, name).toEqual([])
    expect(fx.logged.some(line => line.includes('a takeover run by a session that is not an orchestrator')), `${name}: ${fx.logged.join(' | ')}`).toBe(true)
  }
  // A role that cannot be read moves nothing, said in the log, and the command's answer stands.
  const { handlers } = mounted()
  const fx = movingDollar({ exitCode: 0, stdout: 'moved: orch-S1\n' })
  const unread: World = { ...fx.dollar, session: { ...fx.dollar.session, id: async () => { throw new Error('no session id') } } }
  expect(await handlers['tool.call:takeover'](unread, { command: TAKEOVER_LINE }, async () => ({ result: 'printed' }))).toEqual({ result: 'printed' })
  await handlers['turn.complete'](fx.dollar, {}, pass)
  expect(fx.processes).toEqual([])
  expect(fx.submits).toEqual([])
  expect(fx.logged.some(line => line.includes("the takeover's session role could not be read, nothing moves: no session id")), fx.logged.join(' | ')).toBe(true)
})

test('the takeover is read on the succession script, by either of its names', () => {
  expect(runsTakeover(TAKEOVER_LINE)).toBe(true)
  expect(runsTakeover('node /p/scripts/succession.ts takeover rec')).toBe(true)
  expect(runsTakeover('/p/scripts/succession.sh check rec')).toBe(false)
  expect(runsTakeover('/p/scripts/iterm-agent.sh takeover --tty /dev/ttys1')).toBe(false)
})
