// hooks/tests/module-io.test.ts
// The module's own I/O over a handler's $ (module-io.ts), written once for every domain: the
// host's config dir, the scripts' state root, the log line, the atomic write and the context
// gate's thresholds, each read over a fake $ that answers only the nouns it names.
import { expect, test } from 'claude-code/testing'
import { configDir, gateEnv, logLine, stateDir, writeAtomic } from '../module-io.ts'
import { logLineOf, lockRun } from './fakes.ts'

function envOf(vars: Record<string, string>) {
  return { env: { get: async (name: string) => vars[name] } }
}

test('the config dir is CLAUDE_CONFIG_DIR, else .claude under HOME; an empty value is unset', async () => {
  expect(await configDir(envOf({ CLAUDE_CONFIG_DIR: '/cfg', HOME: '/h' }))).toBe('/cfg')
  expect(`${await configDir(envOf({ HOME: '/h' }))}/`).toBe('/h/.claude/')
  expect(`${await configDir(envOf({ CLAUDE_CONFIG_DIR: '', HOME: '/h' }))}/`).toBe('/h/.claude/')
})

test('the state root is ORCHESTRATOR_STATE_DIR, else the config dir\'s claude-orchestrator', async () => {
  expect(await stateDir(envOf({ HOME: '/h' }))).toBe('/h/.claude/claude-orchestrator')
  expect(await stateDir(envOf({ HOME: '/h', ORCHESTRATOR_STATE_DIR: '/state' }))).toBe('/state')
  expect(await stateDir(envOf({ HOME: '/h', ORCHESTRATOR_STATE_DIR: '' }))).toBe('/h/.claude/claude-orchestrator')
})

test('a log line is one append to the module\'s log, stamped with the half that wrote it', async () => {
  const runs: (readonly string[])[] = []
  const $ = {
    ...envOf({ HOME: '/h', ORCHESTRATOR_MODULE_DIR: '/mod' }),
    plugin: { root: '/plugin' },
    process: { run: async (argv: readonly string[]) => { runs.push(argv); return { exitCode: 0, stdout: '', stderr: '' } } },
  }
  await logLine($, 'guards', 'stop gate: x')
  expect(runs.length).toBe(1)
  expect(runs[0]?.slice(0, 3)).toEqual(['sh', '/plugin/hooks/log-append.sh', '/mod/hooks-module.log'])
  expect(logLineOf(runs[0] ?? [])).toMatch(/^\S+ \| guards \| stop gate: x$/)
})

test('a log line never throws, whatever the run does', async () => {
  const $ = {
    ...envOf({ HOME: '/h' }),
    plugin: { root: '/plugin' },
    process: { run: async () => { throw new Error('no process') } },
  }
  await logLine($, 'wait', 'x')
})

test('an atomic write goes through a temporary file beside its target, then one rename', async () => {
  const files = new Map<string, string>()
  const runs: (readonly string[])[] = []
  const $ = {
    fs: {
      write: async (path: string, text: string) => { files.set(path, text) },
      read: async (path: string) => { const text = files.get(path); if (text === undefined) throw new Error('ENOENT'); return text },
      stat: async () => { throw new Error('ENOENT') },
    },
    process: {
      run: async (argv: readonly string[]) => {
        runs.push(argv)
        const lock = lockRun(argv, files)
        if (lock) return lock
        if (argv[0] === 'mv') { files.set(String(argv[3]), files.get(String(argv[2])) ?? ''); files.delete(String(argv[2])) }
        if (argv[0] === 'rm') for (const path of argv.slice(2)) files.delete(path)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    clock: { sleep: async () => undefined },
  }
  await writeAtomic($, '/s/deck.json', '{"v":1}\n')
  expect(files.get('/s/deck.json')).toBe('{"v":1}\n')
  expect([...files.keys()]).toEqual(['/s/deck.json'])
  const rename = runs.find(argv => argv[0] === 'mv')
  expect(String(rename?.[2])).toMatch(/^\/s\/deck\.json\.tmp-/)
})

test('the gate\'s thresholds are the positive numbers the two variables carry, any other value unset', async () => {
  expect(await gateEnv(envOf({ ORCHESTRATOR_CONTEXT_GATE: '70', ORCHESTRATOR_CONTEXT_GATE_TOKENS: '200000' }))).toEqual({ gate: 70, gateTokens: 200000 })
  expect(await gateEnv(envOf({ ORCHESTRATOR_CONTEXT_GATE: 'x', ORCHESTRATOR_CONTEXT_GATE_TOKENS: '-1' }))).toEqual({})
  expect(await gateEnv(envOf({}))).toEqual({})
})
