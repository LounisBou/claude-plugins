// hooks/tests/short-commands.test.ts
// The short commands' sync at each session start: the writer's own `sync` run from an
// installed plugin, never from a checkout unless an override names the directory, bounded, its
// failure logged, the start going on either way. What the writer rewrites (a copy whose root
// differs) and leaves (a current copy, a foreign file, a removed one) is tested on the script
// itself in tests/run-tests.sh; here, through a fake $, what the module asks of it.
import { expect, test } from 'claude-code/testing'
import { register, syncArgv, startBoundMs, SYNC_TIMEOUT_MS, START_BOUND_MS } from '../short-commands.ts'
import { logLineOf } from './fakes.ts'

const HOME = '/tmp/h'
const INSTALLED = `${HOME}/.claude/plugins/cache/lounisbou/orchestrator/0.82.0-abc`

function fakeDollar(over: { root?: string; env?: Record<string, string>; run?: (argv: readonly string[]) => any } = {}) {
  const runs: { argv: readonly string[]; timeoutMs?: number }[] = []
  const written: string[] = []
  const env: Record<string, string> = { HOME, ...over.env }
  const dollar = {
    env: { get: async (name: string) => env[name] },
    plugin: { name: 'orchestrator', root: over.root ?? INSTALLED },
    process: {
      run: async (argv: readonly string[], opts: { timeoutMs?: number } = {}) => {
        const line = logLineOf(argv)
        if (line !== null) { written.push(line); return { exitCode: 0, stdout: '', stderr: '' } }
        runs.push({ argv, timeoutMs: opts.timeoutMs })
        return over.run ? over.run(argv) : { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  }
  return { dollar, runs, written }
}

function startHook(): { matcher: object | undefined; handler: Function } {
  const hooks: { event: string; matcher: object | undefined; handler: Function }[] = []
  register((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : undefined, handler: args[args.length - 1] as Function })
    return { catch: () => undefined }
  })
  expect(hooks.map(h => h.event)).toEqual(['session.start'])
  return hooks[0]
}

const start = { cwd: '/w', surface: 'terminal', isInteractive: true }
const passed = (x: unknown) => ({ passed: x })

test('the writer is asked from an installed plugin, or wherever an override points, never from a checkout', () => {
  expect(syncArgv(INSTALLED, `${HOME}/.claude`, undefined)).toEqual(['bash', `${INSTALLED}/short-commands.sh`, 'sync', '--dir', `${HOME}/.claude/commands`])
  expect(syncArgv('/work/claude-orchestrator', `${HOME}/.claude`, undefined)).toBeNull()
  expect(syncArgv('/work/claude-orchestrator', `${HOME}/.claude`, '/sandbox/work/.claude/commands'))
    .toEqual(['bash', '/work/claude-orchestrator/short-commands.sh', 'sync', '--dir', '/sandbox/work/.claude/commands'])
})

test('a start runs the sync, bounded, and goes on', async () => {
  const fx = fakeDollar()
  expect(await startHook().handler(fx.dollar, start, passed)).toEqual({ passed: start })
  expect(fx.runs).toEqual([{ argv: ['bash', `${INSTALLED}/short-commands.sh`, 'sync', '--dir', `${HOME}/.claude/commands`], timeoutMs: SYNC_TIMEOUT_MS }])
  expect(fx.written).toEqual([])
})

test('a start from a checkout runs nothing', async () => {
  const fx = fakeDollar({ root: '/work/claude-orchestrator' })
  expect(await startHook().handler(fx.dollar, start, passed)).toEqual({ passed: start })
  expect(fx.runs).toEqual([])
})

test('a sync that fails, or never answers, is logged and the start goes on', async () => {
  const refused = fakeDollar({ run: () => ({ exitCode: 1, stdout: '', stderr: 'mktemp: Permission denied\n' }) })
  expect(await startHook().handler(refused.dollar, start, passed)).toEqual({ passed: start })
  expect(refused.written.some(l => l.includes('| short-commands | short commands not synced (exit 1): mktemp: Permission denied'))).toBe(true)
  const hung = fakeDollar({ run: () => { throw new Error('timed out after 5000 ms') } })
  expect(await startHook().handler(hung.dollar, start, passed)).toEqual({ passed: start })
  expect(hung.written.some(l => l.includes('| short-commands | short commands not synced: timed out after 5000 ms'))).toBe(true)
})

test('the start is bound by the smaller of the host budget and 1500 ms', () => {
  expect([startBoundMs(undefined), startBoundMs(20), startBoundMs(5000)]).toEqual([START_BOUND_MS, 20, START_BOUND_MS])
  expect(START_BOUND_MS).toBe(1500)
})

test('a sync that never answers never holds the start past the bound', async () => {
  const hung = fakeDollar({ run: () => new Promise(() => {}) })
  const next = Object.assign((x: unknown) => passed(x), { budget: { ms: 1500, remainingMs: 40 } })
  const began = Date.now()
  expect(await startHook().handler(hung.dollar, start, next)).toEqual({ passed: start })
  expect(Date.now() - began).toBeLessThan(1000)
  expect(hung.written.some(l => l.includes('| short-commands | short commands not synced: did not finish within 40 ms'))).toBe(true)
})

test('an empty config dir is an unset one: the sync reads the home directory\'s', async () => {
  const fx = fakeDollar({ env: { CLAUDE_CONFIG_DIR: '' } })
  await startHook().handler(fx.dollar, start, passed)
  expect(fx.runs.map(r => r.argv)).toEqual([['bash', `${INSTALLED}/short-commands.sh`, 'sync', '--dir', `${HOME}/.claude/commands`]])
})
