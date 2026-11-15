// hooks/tests/background.test.ts
// No Claude session runs in the background: every launch of one is refused from any session, the
// tool never asked, and a session the host started as a background one ends at start, its own
// process signalled once proved by its host record.
import { expect, test } from 'claude-code/testing'
import { BACKGROUND_DENY, BACKGROUND_END, backgroundLaunches, isBackgroundSession, register } from '../background.ts'
import { register as registerModule } from '../register.ts'
import { logLineOf } from './fakes.ts'
import { capture, hookOf, hostOf } from '../../core/capture.ts'
import { fieldsOf, type Events, type Host, type Noun, type ProcessRunResult } from '../../core/host.ts'

type World = Host<Noun>
const denyOf = (answer: unknown) => fieldsOf(answer)?.['deny']

const refused: [string, string][] = [
  ['claude --bg', 'claude --bg'],
  ['claude --background "fix the build"', 'claude --bg'],
  ['claude --bg=1 -n x', 'claude --bg'],
  ['claude --resume 0f3c --bg', 'claude --bg'],
  ['claude -r abc --background', 'claude --bg'],
  ['claude --model opus --bg "do it"', 'claude --bg'],
  ['/Users/me/.local/bin/claude --bg', 'claude --bg'],
  ['env FOO=1 claude --bg', 'claude --bg'],
  ['nohup claude --bg &', 'claude --bg'],
  ['/usr/bin/env claude --bg', 'claude --bg'],
  ['cd /tmp && claude --bg', 'claude --bg'],
  ['echo "$(claude --bg)"', 'claude --bg'],
  ["sh -c 'claude --bg'", 'claude --bg'],
  ["bash -lc 'cd x; claude --background'", 'claude --bg'],
  ["eval 'claude --bg'", 'claude --bg'],
  ["echo 'claude --bg' | sh", 'claude --bg'],
  ['npx @anthropic-ai/claude-code --bg', 'claude --bg'],
  ['npx -y @anthropic-ai/claude-code@latest --bg', 'claude --bg'],
  ['claude attach 3fa2', 'claude attach'],
  ['claude attach "Agent: x"', 'claude attach'],
  ['claude --name n attach 3fa2', 'claude attach'],
  ['claude respawn --all', 'claude respawn'],
  ['claude respawn 3fa2', 'claude respawn'],
  ['claude daemon run', 'claude daemon run'],
  ['claude daemon run ~/.claude/daemon.json', 'claude daemon run'],
  ['claude daemon --log-file /tmp/d.log run', 'claude daemon run'],
  ['claude daemon', 'claude daemon run'],
  ['echo {} | claude daemon', 'claude daemon run'],
]

const passed = [
  'claude -p "say hi"',
  'claude -p attach',
  'claude --print "respawn the worker" --model haiku',
  'claude plugin test plugins/orchestrator',
  'claude plugin test "$ROOT"',
  'claude --version',
  'claude --help',
  'claude --bg --help',
  'claude attach --help',
  'claude agents --json',
  'claude logs 3fa2',
  'claude stop 3fa2',
  'claude rm 3fa2',
  'claude daemon status',
  'claude daemon stop --any',
  'claude daemon logs',
  'claude daemon uninstall',
  'claude --resume 0f3c',
  'claude -n "Agent: x" "read the brief"',
  'command -v claude',
  'git commit -m "refuse claude --bg"',
  'grep -rn "claude --bg" plugins',
  'echo claude --bg',
  'cat <<EOF\nclaude --bg\nEOF',
  'ls --bg',
]

test('every background launch is read as one, with its form', () => {
  for (const [line, form] of refused) expect(backgroundLaunches(line), line).toEqual([form])
})

test('a foreground run, a print run, a viewer, a stop and every word that is data pass', () => {
  for (const line of passed) expect(backgroundLaunches(line), line).toEqual([])
})

test('a line the reader cannot read is a launch when it names claude, and nothing when it does not', () => {
  const wide = `${'{a,b}'.repeat(12)}`
  expect(backgroundLaunches(`claude ${wide}`)).toEqual(['a line the reader cannot read'])
  expect(backgroundLaunches(`echo ${wide}`)).toEqual([])
})

test('a background session is the one the host marks with its kind or its job directory', () => {
  expect(isBackgroundSession('bg', undefined)).toBe(true)
  expect(isBackgroundSession(undefined, '/Users/me/.claude/jobs/3fa2')).toBe(true)
  expect(isBackgroundSession(undefined, undefined)).toBe(false)
  expect(isBackgroundSession('', '  ')).toBe(false)
})

type Fake = { env?: Record<string, string>; records?: readonly string[]; ppid?: string; failRun?: boolean }

function world(fake: Fake): { dollar: World; runs: string[][]; logs: string[]; toasts: string[] } {
  const runs: string[][] = []
  const logs: string[] = []
  const toasts: string[] = []
  const dollar = hostOf({
    env: { get: async (name: string) => ({ HOME: '/home/me', ...fake.env })[name] },
    fs: { exists: async (path: string) => (fake.records ?? []).includes(path) },
    process: {
      run: async (argv: readonly string[]): Promise<ProcessRunResult> => {
        const line = logLineOf(argv)
        if (line !== null) { logs.push(line); return { exitCode: 0, stdout: '', stderr: '' } }
        if (fake.failRun) throw new Error('no process')
        runs.push([...argv])
        if (argv[0] === 'sh' && argv[2] === 'echo $PPID') return { exitCode: 0, stdout: `${fake.ppid ?? ''}\n`, stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    ui: { toast: (text: string) => { toasts.push(text) } },
  } as Parameters<typeof hostOf>[0])
  return { dollar, runs, logs, toasts }
}

const hooks = () => capture<World>(on => register(on))
const bash = (command: string): Events['tool.call'] => ({ tool: 'Bash', command })

async function callBash(dollar: World, e: Events['tool.call']) {
  let passedThrough: unknown = null
  const answer = await hookOf(hooks(), 'tool.call', { tool: 'Bash' }).handler(dollar, e, async (x: unknown) => { passedThrough = x; return x })
  return { answer, passedThrough }
}

test('a background launch is denied in any session, the tool never asked, the order named', async () => {
  for (const env of [{}, { ORCHESTRATOR_SPAWNED: '1' }]) {
    const { dollar } = world({ env })
    for (const [line, form] of refused) {
      const { answer, passedThrough } = await callBash(dollar, bash(line))
      expect(denyOf(answer), line).toBe(`${BACKGROUND_DENY} Seen: ${form}.`)
      expect(passedThrough, line).toBeNull()
    }
  }
})

test('a print run and the plugin test reach the tool untouched', async () => {
  const { dollar } = world({})
  for (const line of ['claude -p "say hi"', 'claude plugin test plugins/orchestrator']) {
    const e = bash(line)
    const { answer, passedThrough } = await callBash(dollar, e)
    expect(passedThrough, line).toBe(e)
    expect(answer, line).toBe(e)
  }
})

test('the guard that could not finish denies a line that names claude and lets any other through', async () => {
  const { dollar } = world({})
  const net = hookOf(hooks(), 'tool.call', { tool: 'Bash' }).net!
  const failed = Object.assign(async (x: unknown) => x, { error: { message: 'budget' }, called: false })
  expect(String(denyOf(await net(dollar, bash('claude -p x'), failed)))).toContain(BACKGROUND_DENY)
  const e = bash('ls')
  expect(await net(dollar, e, failed)).toBe(e)
  const ran = Object.assign(async (x: unknown) => x, { error: { message: 'late' }, called: true })
  const again = bash('claude --bg')
  expect(await net(dollar, again, ran)).toBe(again)
})

async function start(dollar: World) {
  let passedThrough: unknown = null
  const e = { cwd: '/w' }
  const answer = await hookOf(capture<World>(on => registerModule(on)), 'session.start').handler(dollar, e, async (x: unknown) => { passedThrough = x; return x })
  return { answer, passedThrough, e }
}

test('a background session ends at start: its own process, proved by its host record, is signalled', async () => {
  for (const env of [{ CLAUDE_CODE_SESSION_KIND: 'bg' }, { CLAUDE_JOB_DIR: '/home/me/.claude/jobs/3fa2' }]) {
    const { dollar, runs, logs, toasts } = world({ env, ppid: '4242', records: ['/home/me/.claude/sessions/4242.json'] })
    const { passedThrough, e } = await start(dollar)
    expect(runs).toContainEqual(['kill', '-TERM', '4242'])
    expect(logs.some(line => line.endsWith(`| background | ${BACKGROUND_END}`))).toBe(true)
    expect(toasts).toEqual([BACKGROUND_END])
    expect(passedThrough).toBe(e)
  }
})

test('a background session whose process is not proved is never signalled, and the log says so', async () => {
  for (const fake of [{ ppid: '4242', records: [] }, { ppid: '1', records: ['/home/me/.claude/sessions/1.json'] }, { ppid: 'x' }]) {
    const { dollar, runs, logs } = world({ env: { CLAUDE_CODE_SESSION_KIND: 'bg' }, ...fake })
    await start(dollar)
    expect(runs.filter(argv => argv[0] === 'kill')).toEqual([])
    expect(logs.some(line => line.includes('could not be ended'))).toBe(true)
  }
})

test('an interactive session starts untouched: nothing run, nothing signalled', async () => {
  const { dollar, runs, toasts } = world({ env: { CLAUDE_CODE_SESSION_ATTENDED: '1' }, ppid: '4242', records: ['/home/me/.claude/sessions/4242.json'] })
  const { passedThrough, e } = await start(dollar)
  expect(runs).toEqual([])
  expect(toasts).toEqual([])
  expect(passedThrough).toBe(e)
})

test('a start the guard could not read goes on, and the log says why', async () => {
  const { dollar, logs } = world({ env: { CLAUDE_CODE_SESSION_KIND: 'bg' }, failRun: true })
  const { passedThrough, e } = await start(dollar).catch(() => ({ passedThrough: 'threw', e: null }))
  expect(passedThrough).toBe('threw')
  const net = hookOf(capture<World>(on => registerModule(on)), 'session.start').net!
  const failed = Object.assign(async (x: unknown) => x, { error: { message: 'no process' }, called: false })
  const again = { cwd: '/w' }
  expect(await net(dollar, again, failed)).toBe(again)
  expect(logs.some(line => line.endsWith('| register | unhandled (failure): no process'))).toBe(true)
  expect(e).toBeNull()
})
