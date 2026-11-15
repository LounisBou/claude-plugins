// hooks/tests/background.test.ts
// No session of the host runs in the background: every launch of one is refused from any session, the
// tool never asked, and a session the host started as a background one ends at start, its own
// process signalled once proved by its host record.
import { expect, test } from 'claude-code/testing'
import { BACKGROUND_DENY, BACKGROUND_END, backgroundLaunches, isBackgroundSession, register } from '../background.ts'
import { register as registerModule } from '../register.ts'
import { logLineOf } from './fakes.ts'
import { capture, hookOf, hostOf } from '../../core/capture.ts'
import { fieldsOf, type Events, type Host, type Noun, type ProcessRunResult } from '../../core/host.ts'

type World = Host<Noun>
const HOSTS = ['hostcli']
const denyOf = (answer: unknown) => fieldsOf(answer)?.['deny']

const refused: [string, string][] = [
  ['hostcli --bg', '--bg'],
  ['hostcli --background "fix the build"', '--bg'],
  ['hostcli --bg=1 -n x', '--bg'],
  ['hostcli --resume 0f3c --bg', '--bg'],
  ['hostcli -r abc --background', '--bg'],
  ['hostcli --model m1 --bg "do it"', '--bg'],
  ['/opt/bin/hostcli --bg', '--bg'],
  ['env FOO=1 hostcli --bg', '--bg'],
  ['nohup hostcli --bg &', '--bg'],
  ['/usr/bin/env hostcli --bg', '--bg'],
  ['cd /tmp && hostcli --bg', '--bg'],
  ['echo "$(hostcli --bg)"', '--bg'],
  ["sh -c 'hostcli --bg'", '--bg'],
  ["bash -lc 'cd x; hostcli --background'", '--bg'],
  ["eval 'hostcli --bg'", '--bg'],
  ["echo 'hostcli --bg' | sh", '--bg'],
  ['hostcli attach 3fa2', 'attach'],
  ['hostcli attach "Agent: x"', 'attach'],
  ['hostcli --name n attach 3fa2', 'attach'],
  ['hostcli respawn --all', 'respawn'],
  ['hostcli respawn 3fa2', 'respawn'],
  ['hostcli daemon run', 'daemon run'],
  ['hostcli daemon run ~/d.json', 'daemon run'],
  ['hostcli daemon --log-file /tmp/d.log run', 'daemon run'],
  ['hostcli daemon', 'daemon run'],
  ['echo {} | hostcli daemon', 'daemon run'],
]

const passed = [
  'hostcli -p "say hi"',
  'hostcli -p attach',
  'hostcli --print "respawn the worker" --model m2',
  'hostcli plugin test plugins/orchestrator',
  'hostcli plugin test "$ROOT"',
  'hostcli --version',
  'hostcli --help',
  'hostcli --bg --help',
  'hostcli attach --help',
  'hostcli agents --json',
  'hostcli logs 3fa2',
  'hostcli stop 3fa2',
  'hostcli rm 3fa2',
  'hostcli daemon status',
  'hostcli daemon stop --any',
  'hostcli daemon logs',
  'hostcli daemon uninstall',
  'hostcli --resume 0f3c',
  'hostcli -n "Agent: x" "read the brief"',
  'command -v hostcli',
  'git commit -m "refuse hostcli --bg"',
  'grep -rn "hostcli --bg" plugins',
  'echo hostcli --bg',
  'cat <<EOF\nhostcli --bg\nEOF',
  'ls --bg',
]

test('every background launch is read as one, with its form', () => {
  for (const [line, form] of refused) expect(backgroundLaunches(line, HOSTS), line).toEqual([form])
})

test('a foreground run, a print run, a viewer, a stop and every word that is data pass', () => {
  for (const line of passed) expect(backgroundLaunches(line, HOSTS), line).toEqual([])
})

test('a line the reader cannot read is a launch when it names the CLI, and nothing when it does not', () => {
  const wide = `${'{a,b}'.repeat(12)}`
  expect(backgroundLaunches(`hostcli ${wide}`, HOSTS)).toEqual(['a line the reader cannot read'])
  expect(backgroundLaunches(`echo ${wide}`, HOSTS)).toEqual([])
})

test('a background session is the one the host marks with its kind or its job directory', () => {
  expect(isBackgroundSession('bg', undefined)).toBe(true)
  expect(isBackgroundSession(undefined, '/u/me/jobs/3fa2')).toBe(true)
  expect(isBackgroundSession(undefined, undefined)).toBe(false)
  expect(isBackgroundSession('', '  ')).toBe(false)
})

type Fake = { env?: Record<string, string>; records?: readonly string[]; ppid?: string; failRun?: boolean }

function world(fake: Fake): { dollar: World; runs: string[][]; logs: string[]; toasts: string[] } {
  const runs: string[][] = []
  const logs: string[] = []
  const toasts: string[] = []
  const dollar = hostOf({
    env: { get: async (name: string) => ({ CLAUDE_CONFIG_DIR: '/u/cfg', ORCHESTRATOR_HOST_CLI: 'hostcli', ...fake.env })[name] },
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
  for (const line of ['hostcli -p "say hi"', 'hostcli plugin test plugins/orchestrator']) {
    const e = bash(line)
    const { answer, passedThrough } = await callBash(dollar, e)
    expect(passedThrough, line).toBe(e)
    expect(answer, line).toBe(e)
  }
})

test('the guard that could not finish denies a line that names the CLI and lets any other through', async () => {
  const { dollar } = world({})
  const net = hookOf(hooks(), 'tool.call', { tool: 'Bash' }).net!
  const failed = Object.assign(async (x: unknown) => x, { error: { message: 'budget' }, called: false })
  expect(String(denyOf(await net(dollar, bash('hostcli -p x'), failed)))).toContain(BACKGROUND_DENY)
  const e = bash('ls')
  expect(await net(dollar, e, failed)).toBe(e)
  const ran = Object.assign(async (x: unknown) => x, { error: { message: 'late' }, called: true })
  const again = bash('hostcli --bg')
  expect(await net(dollar, again, ran)).toBe(again)
})

async function start(dollar: World) {
  let passedThrough: unknown = null
  const e = { cwd: '/w' }
  const answer = await hookOf(capture<World>(on => registerModule(on)), 'session.start').handler(dollar, e, async (x: unknown) => { passedThrough = x; return x })
  return { answer, passedThrough, e }
}

test('a background session ends at start: its own process, proved by its host record, is signalled', async () => {
  for (const env of [{ CLAUDE_CODE_SESSION_KIND: 'bg' }, { CLAUDE_JOB_DIR: '/u/me/jobs/3fa2' }]) {
    const { dollar, runs, logs, toasts } = world({ env, ppid: '4242', records: ['/u/cfg/sessions/4242.json'] })
    const { passedThrough, e } = await start(dollar)
    expect(runs).toContainEqual(['kill', '-TERM', '4242'])
    expect(logs.some(line => line.endsWith(`| background | ${BACKGROUND_END}`))).toBe(true)
    expect(toasts).toEqual([BACKGROUND_END])
    expect(passedThrough).toBe(e)
  }
})

test('a background session whose process is not proved is never signalled, and the log says so', async () => {
  for (const fake of [{ ppid: '4242', records: [] }, { ppid: '1', records: ['/u/cfg/sessions/1.json'] }, { ppid: 'x' }]) {
    const { dollar, runs, logs } = world({ env: { CLAUDE_CODE_SESSION_KIND: 'bg' }, ...fake })
    await start(dollar)
    expect(runs.filter(argv => argv[0] === 'kill')).toEqual([])
    expect(logs.some(line => line.includes('could not be ended'))).toBe(true)
  }
})

test('an interactive session starts untouched: nothing run, nothing signalled', async () => {
  const { dollar, runs, toasts } = world({ env: { TERM: 'xterm' }, ppid: '4242', records: ['/u/cfg/sessions/4242.json'] })
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
