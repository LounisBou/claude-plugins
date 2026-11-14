// The hooks module over a fake host: the health command is answered from the script's output.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register, scriptArgv, type Host } from '../../../hooks/register.ts'

type Handler = ($: Host, e: Record<string, unknown>) => Promise<unknown>

function mounted(): Handler {
  let found: Handler | undefined
  const names: string[] = []
  register((event, matcher, hook) => {
    names.push(`${event}:${matcher['command']}`)
    found = hook
  })
  assert.deepEqual(names, ['command.run:learning:health'])
  assert.ok(found)
  return found
}

function host(run: Host['process']['run'], env: Record<string, string> = {}): Host {
  return { plugin: { root: '/p/learning' }, env: { get: async name => env[name] }, process: { run } }
}

test('scriptArgv runs the health script under node, on the config directory', () => {
  assert.deepEqual(scriptArgv('/r', '/c'), ['node', '--experimental-strip-types', '--no-warnings', '/r/skills/learning/scripts/health.ts', '--config', '/c'])
})

test('the health command answers the script\'s output, over the configuration directory the host names', async () => {
  const calls: string[][] = []
  const $ = host(async argv => (calls.push([...argv]), { exitCode: 0, stdout: 'learning health: ok\n', stderr: '' }), { CLAUDE_CONFIG_DIR: '/cfg' })
  assert.deepEqual(await mounted()($, {}), { text: 'learning health: ok' })
  assert.deepEqual(calls, [scriptArgv('/p/learning', '/cfg')])
})

test('the health command falls back to the home directory\'s .claude when no configuration directory is set', async () => {
  const calls: string[][] = []
  const $ = host(async argv => (calls.push([...argv]), { exitCode: 0, stdout: 'x', stderr: '' }), { HOME: '/home/u' })
  await mounted()($, {})
  assert.equal(calls[0]?.at(-1), '/home/u/.claude')
})

test('a script that fails answers what it printed, or its exit status', async () => {
  assert.deepEqual(await mounted()(host(async () => ({ exitCode: 2, stdout: '', stderr: 'usage: health.ts\n' })), {}), { text: 'usage: health.ts' })
  assert.deepEqual(await mounted()(host(async () => ({ exitCode: 3, stdout: '', stderr: '' })), {}), { text: 'health exited 3' })
})

test('a script that cannot start is said in a line, and never thrown into the host', async () => {
  const answer = await mounted()(host(async () => { throw new Error('spawn node ENOENT') }), {})
  assert.deepEqual(answer, { text: 'learning: the health report did not run: spawn node ENOENT' })
})
