// hooks/tests/retrospective.test.ts
// The learning retrospective started when an orchestrator's turn ends on a `done` wait, over a faked
// $: only where the learning plugin is enabled and installed, one line of the module's log for what
// the start said, and nothing that throws out of the turn's end.
import { expect, test } from 'claude-code/testing'
import { register as registerWait, Declarations, RETROSPECTIVE_TIMEOUT_MS, startRetrospective } from '../wait.ts'
import { logLineOf } from './fakes.ts'

const HOME = '/tmp/retro-home'
const RECORD = `${HOME}/.claude/plugins/installed_plugins.json`
const ROOT = '/cache/learning/0.3.0'
const SCRIPT = `${ROOT}/skills/learning/scripts/retrospective.ts`

type World = { enabled?: boolean; record?: string | null; script?: boolean; answer?: { exitCode: number; stdout: string; stderr: string }; settingsThrow?: boolean }

function world(w: World = {}) {
  const logs: string[] = []
  const runs: { argv: string[]; timeoutMs: number | undefined }[] = []
  const files = new Map<string, string>()
  const record = w.record === undefined ? JSON.stringify({ plugins: { 'learning@lounisbou': [{ installPath: ROOT }] } }) : w.record
  if (record !== null) files.set(RECORD, record)
  if (w.script !== false) files.set(SCRIPT, '')
  const dollar: any = {
    plugin: { name: 'orchestrator', root: '/plugins/orch' },
    env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
    settings: {
      read: async () => {
        if (w.settingsThrow) throw new Error('settings unreadable')
        return { enabledPlugins: { 'learning@lounisbou': w.enabled ?? true } }
      },
    },
    fs: {
      read: async (p: string) => { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p)! },
      exists: async (p: string) => files.has(p),
    },
    process: {
      run: async (argv: readonly string[], init?: { timeoutMs?: number }) => {
        const log = logLineOf(argv)
        if (log !== null) { logs.push(log); return { exitCode: 0, stdout: '', stderr: '' } }
        runs.push({ argv: [...argv], timeoutMs: init?.timeoutMs })
        return w.answer ?? { exitCode: 0, stdout: 'learning retrospective: not started, 0 candidates wait and it starts at 3\n', stderr: '' }
      },
    },
  }
  return { dollar, logs, runs }
}

test('an enabled, installed learning plugin is asked to start its retrospective, and its line is logged', async () => {
  const { dollar, logs, runs } = world()
  await startRetrospective(dollar)
  expect(runs).toEqual([{ argv: ['node', '--experimental-strip-types', '--no-warnings', SCRIPT, 'start', '--config', `${HOME}/.claude`], timeoutMs: RETROSPECTIVE_TIMEOUT_MS }])
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('learning retrospective: not started, 0 candidates wait and it starts at 3')
})

test('disabled, missing from the install record, or without its script, nothing is started and nothing is logged but a broken record', async () => {
  for (const w of [{ enabled: false }, { script: false }, { record: JSON.stringify({ plugins: {} }) }]) {
    const { dollar, logs, runs } = world(w)
    await startRetrospective(dollar)
    expect(runs).toEqual([])
    expect(logs).toEqual([])
  }
  const { dollar, logs, runs } = world({ record: null })
  await startRetrospective(dollar)
  expect(runs).toEqual([])
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('the learning retrospective was not started')
})

test('a start that fails, or settings that cannot be read, is one line of the log and never a throw', async () => {
  const failed = world({ answer: { exitCode: 1, stdout: '', stderr: 'learning retrospective: the session did not start (exit 127)\n' } })
  await startRetrospective(failed.dollar)
  expect(failed.logs.length).toBe(1)
  expect(failed.logs[0]).toContain('the session did not start (exit 127)')
  const silent = world({ answer: { exitCode: 3, stdout: '', stderr: '' } })
  await startRetrospective(silent.dollar)
  expect(silent.logs[0]).toContain("the learning retrospective's start exited 3")
  const unreadable = world({ settingsThrow: true })
  await startRetrospective(unreadable.dollar)
  expect(unreadable.runs).toEqual([])
  expect(unreadable.logs[0]).toContain('not started: settings unreadable')
})

test('the turn that ends on a done wait starts the retrospective; another wait or no wait does not', async () => {
  const handlers: Record<string, Function> = {}
  const declarations = new Declarations()
  registerWait(((...args: any[]) => { handlers[args[0]] = args[args.length - 1]; return { catch: () => undefined } }) as any, declarations)
  const next = async (e: { answer?: string }) => ({ text: e.answer })
  const turn = async (dollar: any, wait: { kind: 'done' | 'deferred'; blocks: string } | null, agentId?: string) => {
    await handlers['turn.start'](dollar, agentId ? { agentId } : {}, async () => undefined)
    if (wait !== null) declarations.declare(wait)
    return handlers['turn.complete'](dollar, { answer: 'all goals met', ...(agentId ? { agentId } : {}) }, next)
  }
  const { dollar, runs } = world()
  expect(await turn(dollar, { kind: 'done', blocks: '' })).toEqual({ text: 'all goals met' })
  expect(runs.length).toBe(1)
  await turn(dollar, { kind: 'deferred', blocks: '2 items' })
  await turn(dollar, null)
  expect(runs.length).toBe(1)
})
