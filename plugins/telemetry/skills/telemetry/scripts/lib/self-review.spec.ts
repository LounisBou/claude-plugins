// The self_review tool over a fake host: listed at the session's start, one event per finding
// handed to the writer with the session's title and role; a call it cannot record says why and
// writes nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Collector, cutFields } from '../../../../hooks/collect.ts'
import { mount, type Host } from '../../../../hooks/register.ts'
import { SELF_REVIEW_TOOL } from '../../../../hooks/self-review.ts'

const S = '60ed5626-9879-4041-892a-5db0ff0bad69'

type Handler = ($: Host, e: Record<string, unknown>, next: (e: unknown) => Promise<unknown>) => Promise<unknown>

function host(options: { exitCode?: number; registerFails?: boolean } = {}) {
  const runs: { argv: readonly string[]; stdin: string | undefined }[] = []
  const tools: unknown[] = []
  const logs: string[] = []
  const $: Host = {
    plugin: { root: '/p/telemetry' },
    env: { get: async name => ({ HOME: '/home/u' } as Record<string, string>)[name] },
    clock: { now: async () => Date.parse('2026-11-18T22:00:00.000Z') },
    process: { run: async (argv, init) => { runs.push({ argv, stdin: init?.stdin }); return { exitCode: options.exitCode ?? 0, stdout: '', stderr: '' } } },
    session: { id: async () => S, model: async () => 'claude-opus-5-5', usage: async () => ({}), info: async () => ({}), messages: async () => [], repo: async () => null },
    ui: { log: line => logs.push(line) },
    tool: { register: async (spec: unknown) => { if (options.registerFails) throw new Error('no tools'); tools.push(spec) } },
  }
  return { $, runs, tools, logs }
}

function hooks() {
  const map = new Map<string, Handler>()
  mount((event, ...rest) => { if (rest.length === 1) map.set(event, rest[0] as Handler) }, new Collector())
  return (name: string): Handler => map.get(name) as Handler
}

const call = (input: Record<string, unknown>) => ({ tool: SELF_REVIEW_TOOL, tool_use_id: 'toolu_1', ...input })
const unreached = async () => { throw new Error('next is never called for the module\'s own tool') }
const written = (stdin: string | undefined): Record<string, unknown>[] => (stdin ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)

test('self_review: listed at the session\'s start, not deferred; a host that refuses it starts the session all the same', async () => {
  const ok = host()
  assert.equal(await hooks()('session.start')(ok.$, { session_title: 'Agent: x' }, async () => 'started'), 'started')
  assert.deepEqual(ok.tools.map(spec => [(spec as Record<string, unknown>)['name'], (spec as Record<string, unknown>)['isDeferred']]), [['self_review', false]])
  const refused = host({ registerFails: true })
  assert.equal(await hooks()('session.start')(refused.$, {}, async () => 'started'), 'started')
  assert.match(refused.logs.join('\n'), /the self_review tool skipped: no tools/)
})

test('self_review: one event per finding, fixed or answered with its reason, naming its pull request and the session; the answer is the report\'s line', async () => {
  const { $, runs } = host()
  const hook = hooks()
  await hook('session.start')($, { session_title: 'Agent: x' }, async () => ({}))
  const answer = await hook('tool.call')($, call({
    repo: 'o/r', pr: 12, agentId: 'a1',
    findings: [
      { lens: 'correctness', file: 'a.ts', line: 3, severity: 'important', outcome: 'fixed' },
      { lens: 'tests', severity: 'bogus', outcome: 'answered', reason: 'covered by the suite end to end' },
    ],
  }), unreached)
  assert.deepEqual(answer, { result: 'self-review: 2 recorded, 1 fixed, 1 answered' })
  assert.equal(runs.length, 1)
  assert.deepEqual(runs[0]?.argv.slice(-3), ['append', '--config', '/home/u/.claude'])
  // The call writes at once, with what the session had buffered before it.
  assert.deepEqual(written(runs[0]?.stdin).map(e => e['event']), ['session_start', 'self_review', 'self_review'])
  const [, fixed, answered] = written(runs[0]?.stdin)
  assert.deepEqual(fixed, { v: 1, ts: '2026-11-18T22:00:00.000Z', event: 'self_review', session: S, agent: 'a1', lens: 'correctness', file: 'a.ts', line: 3, severity: 'important', outcome: 'fixed', target: { repo: 'o/r', pr: 12 }, title: 'Agent: x', role: 'agent' })
  assert.deepEqual([answered?.['severity'], answered?.['outcome'], answered?.['reason'], answered?.['file']], [undefined, 'answered', 'covered by the suite end to end', undefined])
})

test('self_review: no finding, a finding with no lens or outcome, an answered one with no reason, or a writer that fails record nothing and say why', async () => {
  for (const [input, why] of [
    [{}, 'no finding given'],
    [{ findings: [{ outcome: 'fixed' }] }, 'finding 1: a lens and an outcome (fixed or answered) are needed'],
    [{ findings: [{ lens: 'x', outcome: 'fixed' }, { lens: 'x', outcome: 'answered', reason: '  ' }] }, 'finding 2: an answered finding needs its reason'],
  ] as const) {
    const { $, runs } = host()
    assert.deepEqual(await hooks()('tool.call')($, call(input), unreached), { result: `self-review: not recorded — ${why}`, isError: true })
    assert.equal(runs.length, 0)
  }
  const failing = host({ exitCode: 2 })
  const answer = await hooks()('tool.call')(failing.$, call({ findings: [{ lens: 'x', outcome: 'fixed' }] }), unreached) as Record<string, unknown>
  assert.equal(answer['isError'], true)
  assert.match(String(answer['result']), /^self-review: not recorded — append exited 2/)
})

test('self_review: a reason is cut like any kept text', () => {
  assert.equal(String((cutFields({ reason: 'x'.repeat(200) }) as Record<string, unknown>)['reason']).length <= 81, true)
})
