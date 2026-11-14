// hooks/tests/review.test.ts
// The orchestrator's review verdict: from an orchestrator session the tool calls github's record
// tool with a review record, pass, fail or accepted with the points it sets aside; from any other
// session, or with an input that lacks the pull request, the verdict or an acceptance's set-asides,
// it calls nothing.
import { expect, test } from 'claude-code/testing'
import { register } from '../register.ts'
import { NOT_ORCHESTRATOR } from '../review.ts'
import { logLineOf } from './fakes.ts'

const HOME = '/tmp/h'
const ROW = `${HOME}/.claude/claude-orchestrator/store/sessions/s-one`
const WRITTEN = '/cfg/records/x/review.json\ngithub: Ready'

function fake(name: string, answer: unknown = { result: 'written' }) {
  const calls: Record<string, unknown>[] = []
  const logged: string[] = []
  const files: Record<string, string> = {
    [ROW]: JSON.stringify({ role: null, name, pid: '501', updated_at: '2026-11-13T19:00:00.000Z' }) + '\n',
  }
  const dollar = {
    session: { id: async () => 's-one' },
    env: { get: async (key: string) => ({ HOME } as Record<string, string>)[key] },
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    fs: {
      read: async (p: string) => { if (p in files) return files[p]; throw new Error(`ENOENT: ${p}`) },
    },
    process: {
      run: async (argv: readonly string[]) => {
        const line = logLineOf([...argv])
        if (line !== null) logged.push(line)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    tool: { call: async (input: Record<string, unknown>) => { calls.push(input); return answer } },
  }
  return { dollar, calls, logged }
}

// The handler registered for the review tool, its matcher read.
function handler(): (dollar: any, e: object) => Promise<any> {
  let found: Function | null = null
  register((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    if (args[0] === 'tool.call' && args.length === 3 && (args[1] as { tool?: string }).tool === 'mcp__orchestrator__review') found = args[2]
    return { catch: () => undefined }
  })
  return (dollar, e) => found!(dollar, e)
}

const ACCEPTED = {
  pr: 128, repo: 'acme/thing', dir: '/work/thing', verdict: 'accepted',
  set_asides: [{ point: 'a.ts:3', reason: 'naming only' }, { point: 'b.ts', reason: 'out of the phase\'s scope' }],
}

test('an orchestrator\'s acceptance is written through github\'s record tool, each point set aside with its reason', async () => {
  const fx = fake('Orch: belt [a1b2c3]', { result: WRITTEN })
  const out = await handler()(fx.dollar, ACCEPTED)
  expect(fx.calls).toEqual([{
    tool: 'mcp__github__record', pr: 128, repo: 'acme/thing', dir: '/work/thing', kind: 'review', result: 'accepted',
    detail: 'set aside: a.ts:3 — naming only; b.ts — out of the phase\'s scope',
  }])
  expect(out).toEqual({ result: WRITTEN })
})

for (const verdict of ['pass', 'fail']) {
  test(`an orchestrator's ${verdict} is written as a review record with its line`, async () => {
    const fx = fake('Orch: belt')
    await handler()(fx.dollar, { pr: 128, verdict, detail: 'read at 0123456' })
    expect(fx.calls).toEqual([{ tool: 'mcp__github__record', pr: 128, kind: 'review', result: verdict, detail: 'read at 0123456' }])
  })
}

test('github\'s refusal comes back as the tool\'s error', async () => {
  const fx = fake('Orch: belt', { deny: 'github: the latest review at 0123456 failed: a pass does not override it.' })
  expect(await handler()(fx.dollar, { pr: 128, verdict: 'pass' }))
    .toEqual({ result: 'github: the latest review at 0123456 failed: a pass does not override it.', isError: true })
})

for (const name of ['Agent: review record', 'Coord: general', 'Audit: method']) {
  test(`a session named ${name} is refused and calls nothing`, async () => {
    const fx = fake(name)
    expect(await handler()(fx.dollar, ACCEPTED)).toEqual({ result: NOT_ORCHESTRATOR, isError: true })
    expect(fx.calls).toEqual([])
  })
}

for (const [label, change] of [
  ['no pull request', { pr: 0 }], ['no verdict', { verdict: '' }], ['another verdict', { verdict: 'waived' }],
  ['no point set aside', { set_asides: [] }], ['a point without its reason', { set_asides: [{ point: 'a.ts', reason: ' ' }] }],
  ['set-asides on a pass', { verdict: 'pass' }],
] as const) {
  test(`a verdict with ${label} is refused and calls nothing`, async () => {
    const fx = fake('Orch: belt')
    const out = await handler()(fx.dollar, { ...ACCEPTED, ...change })
    expect(out.isError).toBe(true)
    expect(fx.calls).toEqual([])
  })
}

test('a subagent of the orchestrator records no verdict', async () => {
  const fx = fake('Orch: belt')
  expect((await handler()(fx.dollar, { ...ACCEPTED, agentId: 'a1' })).isError).toBe(true)
  expect(fx.calls).toEqual([])
})

// ---- the check plan, in place of the verdict ----

const PLAN = { e2e: 'none: docs only', norms: 'required', review: 'one-pass: a typo' }
const PLANNED = { pr: 164, repo: 'acme/thing', plan: PLAN }

test('an orchestrator\'s check plan is written through github\'s record tool', async () => {
  const fx = fake('Orch: belt [a1b2c3]', { result: 'github: check plan of acme/thing#164' })
  const out = await handler()(fx.dollar, PLANNED)
  expect(fx.calls).toEqual([{ tool: 'mcp__github__record', pr: 164, repo: 'acme/thing', plan: PLAN }])
  expect(out).toEqual({ result: 'github: check plan of acme/thing#164' })
})

for (const name of ['Agent: md-s10', 'Coord: general', 'Audit: method']) {
  test(`a session named ${name} writes no check plan`, async () => {
    const fx = fake(name)
    expect(await handler()(fx.dollar, PLANNED)).toEqual({ result: NOT_ORCHESTRATOR, isError: true })
    expect(fx.calls).toEqual([])
  })
}

for (const [label, change] of [['no plan object', { plan: 'none' }], ['a verdict beside it', { verdict: 'pass' }]] as const) {
  test(`a check plan with ${label} is refused and calls nothing`, async () => {
    const fx = fake('Orch: belt')
    expect((await handler()(fx.dollar, { ...PLANNED, ...change })).isError).toBe(true)
    expect(fx.calls).toEqual([])
  })
}

test('a subagent of the orchestrator writes no check plan', async () => {
  const fx = fake('Orch: belt')
  expect((await handler()(fx.dollar, { ...PLANNED, agentId: 'a1' })).isError).toBe(true)
  expect(fx.calls).toEqual([])
})
