// The hooks module over a fake host: each hook passes the call through untouched, buffers its
// events, writes them at the main turn's end and at the session's, and fails open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Collector } from '../../../../hooks/collect.ts'
import { mount, register, scriptArgv, type Host } from '../../../../hooks/register.ts'

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../tests/fixtures/hook-inputs.json', import.meta.url)), 'utf8')) as Record<string, Record<string, unknown>>
const F = (name: string): Record<string, unknown> => fixture[name] ?? {}
const S = '60ed5626-9879-4041-892a-5db0ff0bad69'

type Handler = ($: Host, e: Record<string, unknown>, next: (e: unknown) => Promise<unknown>) => Promise<unknown>

function host(options: { exitCode?: number; failUsage?: boolean } = {}) {
  let clock = Date.parse('2026-11-13T20:00:00.000Z')
  const runs: { argv: readonly string[]; stdin: string | undefined }[] = []
  const logs: string[] = []
  const $: Host = {
    plugin: { root: '/p/telemetry' },
    env: { get: async name => ({ HOME: '/home/u', ORCHESTRATOR_SPAWNED: '1' } as Record<string, string>)[name] },
    clock: { now: async () => (clock += 100) },
    process: { run: async (argv, init) => (runs.push({ argv, stdin: init?.stdin }), { exitCode: options.exitCode ?? 0, stdout: 'export: done\n', stderr: '' }) },
    session: {
      id: async () => S,
      model: async () => 'claude-opus-5-5',
      usage: async () => {
        if (options.failUsage) throw new Error('no usage')
        return fixture['usage']
      },
    },
    ui: { log: text => logs.push(text) },
  }
  return { $, runs, logs }
}

function hooks(collector = new Collector()) {
  const map = new Map<string, Handler>()
  mount((event, ...rest) => {
    const handler = rest[rest.length - 1] as Handler
    const matcher = rest.length === 2 ? (rest[0] as Record<string, string>) : undefined
    map.set(matcher?.['command'] ? `${event}:${matcher['command']}` : event, handler)
  }, collector)
  const hook = (name: string): Handler => {
    const handler = map.get(name)
    if (handler === undefined) throw new Error(`no hook ${name}`)
    return handler
  }
  return { hook, names: [...map.keys()] }
}

const through = (answer: unknown) => async () => answer

test('register mounts the observers and the export command', () => {
  const names: string[] = []
  register((event: string, ...rest: unknown[]) => names.push(rest.length === 2 ? `${event}:${(rest[0] as Record<string, string>)['command']}` : event))
  assert.deepEqual(names, ['session.start', 'turn.start', 'turn.complete', 'tool.check', 'tool.call', 'agent.spawn', 'session.end', 'command.run:telemetry:export'])
  assert.deepEqual(scriptArgv('/r', 'append', '/c'), ['node', '--experimental-strip-types', '--no-warnings', '/r/skills/telemetry/scripts/telemetry.ts', 'append', '--config', '/c'])
})

test('a session: every result passes through, the events are written at the main turn\'s end and at the session\'s', async () => {
  const { $, runs } = host()
  const { hook } = hooks()
  const ok = F('result.ok')
  assert.deepEqual(await hook('session.start')($, F('session.start'), through({ cwd: '/w' })), { cwd: '/w' })
  assert.deepEqual(await hook('turn.start')($, { text: '', turnId: 't1' }, through({ turnId: 't1' })), { turnId: 't1' })
  await hook('turn.start')($, { text: '', turnId: 't2' }, through({ turnId: 't2' }))
  assert.equal(await hook('tool.check')($, { tool: 'Bash', input: {}, tool_use_id: 'toolu_01Bash' }, through(F('tool.check.ask'))), F('tool.check.ask'))
  assert.equal(await hook('tool.call')($, F('tool.call.bash'), through(F('result.user'))), F('result.user'))
  assert.equal(await hook('agent.spawn')($, F('agent.spawn'), through(F('agent.spawn.result'))), F('agent.spawn.result'))
  await hook('turn.complete')($, F('turn.complete.child'), through({ text: '' }))
  assert.equal(runs.length, 0)
  assert.equal(await hook('turn.complete')($, F('turn.complete'), through(ok)), ok)
  assert.equal(runs.length, 1)
  const written = (runs[0]?.stdin ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  assert.deepEqual(written.map(e => e['event']), ['session_start', 'first_turn', 'tool_call', 'agent_spawned', 'turn_end', 'agent_closed', 'turn_end'])
  assert.equal(written[0]?.['spawned'], true)
  assert.deepEqual([written[2]?.['outcome'], written[2]?.['decided_by'], written[2]?.['duration_ms']], ['refused', 'user', 100])
  assert.equal(await hook('session.end')($, F('session.end'), through({ sessionId: S })) !== undefined, true)
  assert.equal(runs.length, 2)
  const last = JSON.parse(runs[1]?.stdin ?? '{}') as Record<string, unknown>
  assert.deepEqual([last['event'], last['turns']], ['session_end', 1])
})

test('past the threshold a tool call writes without waiting for the turn\'s end', async () => {
  const { $, runs } = host()
  const collector = new Collector()
  const { hook } = hooks(collector)
  for (let i = 0; i < 100; i++) await hook('tool.call')($, F('tool.call.skill'), through(F('result.ok')))
  assert.equal(runs.length, 1)
  assert.equal(collector.size, 0)
})

test('fails open: a host that cannot answer, or a writer that fails, changes no result', async () => {
  const { $, logs } = host({ failUsage: true, exitCode: 1 })
  const { hook } = hooks()
  assert.deepEqual(await hook('session.start')($, F('session.start'), through({ cwd: '/w' })), { cwd: '/w' })
  assert.deepEqual(await hook('turn.complete')($, F('turn.complete'), through({ text: 'a' })), { text: 'a' })
  const broken = { ...$, clock: { now: async () => { throw new Error('no clock') } } }
  assert.equal(await hook('tool.call')(broken, F('tool.call.bash'), through(F('result.ok'))), F('result.ok'))
  assert.ok(logs.length >= 3, logs.join('\n'))
  assert.ok(logs.every(line => line.startsWith('telemetry: ')))
})

test('the export command flushes, runs the export and answers its output without a turn', async () => {
  const { $, runs } = host()
  const { hook } = hooks()
  await hook('tool.call')($, F('tool.call.skill'), through(F('result.ok')))
  assert.deepEqual(await hook('command.run:telemetry:export')($, { command: 'telemetry:export', args: '' }, through(undefined)), { text: 'export: done' })
  assert.deepEqual(runs.map(r => r.argv[4]), ['append', 'export'])
  const failing = { ...$, process: { run: async () => { throw new Error('no node') } } }
  assert.deepEqual(await hook('command.run:telemetry:export')(failing, {}, through(undefined)), { text: 'telemetry: the export did not run: no node' })
})
