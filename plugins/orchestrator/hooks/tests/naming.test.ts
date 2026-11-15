// hooks/tests/naming.test.ts
// The session's own rename: the name's shape, the tool declared at every start,
// the call that records the name and the turn's completion that runs the host's
// /rename with it — never from the call itself, which the host refuses.
import { expect, test } from 'claude-code/testing'
import type { Reply } from 'claude-code/testing'
import { journalled, logLineOf } from './fakes.ts'
import { capture, hookOf, hooksOn, hostOf, type CapturedOn } from '../../core/capture.ts'
import type { Events, Host, Noun, ProcessRunInit, ToolSpec } from '../../core/host.ts'
import { checkName, END_TOOL, register as registerNaming, RENAME_TOOL, MAIN_THREAD_ONLY, isEnding, homeArgv, resumeText, HOME_MOVE_MS, runsTakeover, TAKEN_OVER_TEXT, TAKEN_OVER_STAYED_TEXT } from '../naming.ts'

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
  const bash = toolHook('Bash')
  const send = toolHook('SendMessage')
  // The second hook on Bash: the one that reads a successor's takeover.
  const takeover = hooksOn(hooks, 'tool.call').filter(h => h.matcher?.['tool'] === 'Bash')[1]
  if (takeover === undefined) throw new Error('no takeover hook on Bash')
  const complete = hookOf(hooks, 'turn.complete')
  const handlers = {
    'session.start': callOf(start),
    'tool.call': callOf(rename),
    'tool.call:end': callOf(end),
    'tool.call:Bash': callOf(bash),
    'tool.call:SendMessage': callOf(send),
    'tool.call:takeover': callOf(takeover),
    'turn.complete': callOf(complete),
  }
  const matchers = {
    'session.start': start.matcher, 'tool.call': rename.matcher, 'tool.call:end': end.matcher,
    'tool.call:Bash': bash.matcher, 'tool.call:SendMessage': send.matcher,
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

// The rename lands when the turn ends, and a session that kept going in the same turn spawned
// its agents and messaged them under its directory-stem name: every agent got the wrong
// orchestrator address. Prose did not hold the turn's end; the module does.
const SPAWN = { tool: 'Bash', command: 'bash /p/skills/iterm-agents/scripts/iterm-agent.sh spawn --dir /w --title "Agent: belt" --prompt p' }
const ROTATE = { tool: 'Bash', command: 'bash /p/skills/iterm-agents/scripts/iterm-agent.sh rotate --tty /dev/ttys003 --prompt p' }
const SEND = { tool: 'SendMessage', to: 'Agent: belt', message: 'your brief' }
const passOn = async (e: Events['tool.call']) => ({ result: { ran: e['tool'] } })

test('while a rename is pending, a spawn, a rotate and a SendMessage run, each with one escape, until the turn ends', async () => {
  const { handlers, matchers } = mounted()
  expect(matchers['tool.call:Bash']).toEqual({ tool: 'Bash' })
  expect(matchers['tool.call:SendMessage']).toEqual({ tool: 'SendMessage' })
  const fx = fakeDollar()
  const j = journalled(fx.dollar)
  // No rename pending: every call runs.
  expect(await handlers['tool.call:Bash'](j.dollar, SPAWN, passOn)).toEqual({ result: { ran: 'Bash' } })
  expect(await handlers['tool.call:SendMessage'](j.dollar, SEND, passOn)).toEqual({ result: { ran: 'SendMessage' } })
  await handlers['tool.call'](j.dollar, { name: 'Orch: belt' })
  const reason = 'your name "Orch: belt" is taken when this turn ends: end the turn now; the module resumes you under it'
  for (const [key, call] of [['tool.call:Bash', SPAWN], ['tool.call:Bash', ROTATE], ['tool.call:SendMessage', SEND]] as const) {
    const answer = await handlers[key](j.dollar, call, passOn)
    expect(answer.deny).toBeUndefined()
  }
  expect(j.journal()).toEqual(Array(3).fill('escape orchestrator.naming.rename-pending'))
  expect(fx.logged.filter((line: string) => line.includes(reason)).length).toBe(3)
  // Any other Bash call runs with no escape: only what addresses an agent is observed.
  expect(await handlers['tool.call:Bash'](j.dollar, { tool: 'Bash', command: 'git status' }, passOn)).toEqual({ result: { ran: 'Bash' } })
  expect(await handlers['tool.call:Bash'](j.dollar, { tool: 'Bash', command: 'bash /p/iterm-agent.sh list' }, passOn)).toEqual({ result: { ran: 'Bash' } })
  await handlers['turn.complete'](j.dollar, { isAborted: false }, pass)
  // The next turn runs under the name: nothing is observed any more.
  expect(await handlers['tool.call:Bash'](j.dollar, SPAWN, passOn)).toEqual({ result: { ran: 'Bash' } })
  expect(await handlers['tool.call:SendMessage'](j.dollar, SEND, passOn)).toEqual({ result: { ran: 'SendMessage' } })
})

// The launcher named in a variable on one line and called on the next: the spawn the held
// rename let through, its agents left as tabs the move into the home session did not take.
test('while a rename is pending, a spawn or a rotate written over several commands is observed too', async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  const j = journalled(fx.dollar)
  await handlers['tool.call'](j.dollar, { name: 'Orch: belt' })
  const path = '/p/skills/iterm-agents/scripts/iterm-agent.sh'
  const held = [
    `I=${path}; D=/tmp/briefs\n$I spawn --dir /w --title "Agent: belt" --brief $D/b.md 2>&1 | tail -5`,
    `I=${path}\n"$I" spawn --dir /w --title "Agent: belt" --prompt p`,
    `I=${path}; \${I} rotate --tty /dev/ttys003`,
    `cd /w && bash ${path} spawn --dir /w --prompt p`,
    `L=/p/skills/iterm-agents/scripts && $L/iterm-agent.sh spawn --dir /w --prompt p`,
    `python3 /p/skills/iterm-agents/scripts/iterm_agent.py spawn --dir /w --prompt p`,
    `bash "${path}" spawn --dir /w --prompt p`,
    `I=${path}\n$I \\\n  spawn --dir /w --prompt p`,
    `I=${path}\n$I "spawn" --dir /w --prompt p`,
    `bash ${path} \\\n  spawn --dir /w --prompt p`,
    `I=${path}; go() { "$I" "$@"; }; go spawn --dir /w --prompt p`,
    `I=${path}\ngo() { "$I" "$@"; }\ngo spawn --dir /w --prompt p`,
    `go() { bash ${path} "$@"; }\ngo rotate --tty /dev/ttys003`,
  ]
  for (const command of held) {
    const answer = await handlers['tool.call:Bash'](j.dollar, { tool: 'Bash', command }, passOn)
    expect(answer).toEqual({ result: { ran: 'Bash' } })
  }
  expect(j.journal().length).toBe(held.length)
  // The launcher's other subcommands, and a read of its file, still run.
  // A note that names the launcher and, elsewhere, a variable before « spawn » calls nothing:
  // only a variable given the launcher's path is the launcher.
  const note = `cat > /w/notes.md <<'EOF'\nRun ${path} list first.\nThen $L spawn the agent.\nEOF`
  for (const command of [`I=${path}\n$I list`, `grep -n "def cmd_spawn" /p/skills/iterm-agents/scripts/iterm_agent.py`, `I=${path}\n$I screen --tty /dev/ttys003 | grep spawn`, note]) {
    expect(await handlers['tool.call:Bash'](j.dollar, { tool: 'Bash', command }, passOn)).toEqual({ result: { ran: 'Bash' } })
  }
  expect(j.journal().length).toBe(held.length)
})

test("a subagent's spawn or message is not the main thread's to hold", async () => {
  const { handlers } = mounted()
  const fx = fakeDollar()
  await handlers['tool.call'](fx.dollar, { name: 'Orch: belt' })
  expect(await handlers['tool.call:SendMessage'](fx.dollar, { ...SEND, agentId: 'a-1' }, passOn)).toEqual({ result: { ran: 'SendMessage' } })
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
  // The interrupted turn dropped the rename: nothing is held any more.
  expect(await handlers['tool.call:SendMessage'](fx.dollar, SEND, passOn)).toEqual({ result: { ran: 'SendMessage' } })
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
  expect(isEnding()).toBe(true)
  await handlers['turn.complete'](fx.dollar, { isAborted: true, reason: 'aborted' }, pass)
  expect(isEnding()).toBe(false)
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
function movingDollar(answer: { exitCode: number; stdout: string; stderr?: string } | Error) {
  const fx = fakeDollar()
  const processes: { argv: readonly string[]; opts: ProcessRunInit | undefined }[] = []
  const dollar: World = {
    ...fx.dollar,
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

test("a successor whose move does not happen is woken in its tab, the launcher's answer logged", async () => {
  const cases: [string, { exitCode: number; stdout: string; stderr?: string } | Error, string][] = [
    ['the launcher keeps it (stay:)', { exitCode: 0, stdout: 'stay: this session already runs in a home session\n' }, 'the launcher kept the session where it is: this session already runs in a home session'],
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

test('the takeover is read on the succession script, by either of its names', () => {
  expect(runsTakeover(TAKEOVER_LINE)).toBe(true)
  expect(runsTakeover('node /p/scripts/succession.ts takeover rec')).toBe(true)
  expect(runsTakeover('/p/scripts/succession.sh check rec')).toBe(false)
  expect(runsTakeover('/p/scripts/iterm-agent.sh takeover --tty /dev/ttys1')).toBe(false)
})
