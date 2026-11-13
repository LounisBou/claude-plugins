// hooks/tests/accept.test.ts
// The orchestrator's acceptance of a failed review: from an orchestrator session the tool calls
// github's record tool with an acceptance over the file it names; from any other session, or
// with an input that lacks the pull request, the file or the decision, it calls nothing.
import { expect, test } from 'claude-code/testing'
import { register } from '../register.ts'
import { NOT_ORCHESTRATOR } from '../accept.ts'
import { logLineOf } from './fakes.ts'

const HOME = '/tmp/h'
const ROW = `${HOME}/.claude/claude-orchestrator/store/sessions/s-one`
const FAILED = 'review.20261113T190000Z.pr-review.json'

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

// The handler registered for the accept tool, its matcher read.
function handler(): (dollar: any, e: object) => Promise<any> {
  let found: Function | null = null
  register((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    if (args[0] === 'tool.call' && args.length === 3 && (args[1] as { tool?: string }).tool === 'mcp__orchestrator__accept') found = args[2]
    return { catch: () => undefined }
  })
  return (dollar, e) => found!(dollar, e)
}

const INPUT = { pr: 128, repo: 'acme/thing', over: FAILED, decision: 'both findings are out of the phase\'s scope' }

test('an orchestrator\'s acceptance is written through github\'s record tool, as a review accepted over the file named', async () => {
  const fx = fake('Orch: belt [a1b2c3]', { result: '/cfg/pr-records/x/review.json\ngithub: Ready' })
  const out = await handler()(fx.dollar, INPUT)
  expect(fx.calls).toEqual([{
    tool: 'mcp__github__record', pr: 128, repo: 'acme/thing', kind: 'review', result: 'accepted', over: FAILED,
    detail: 'both findings are out of the phase\'s scope',
  }])
  expect(out).toEqual({ result: '/cfg/pr-records/x/review.json\ngithub: Ready' })
})

test('github\'s refusal comes back as the tool\'s error', async () => {
  const fx = fake('Orch: belt', { deny: 'github: x is no failed review record at 0123456' })
  expect(await handler()(fx.dollar, INPUT)).toEqual({ result: 'github: x is no failed review record at 0123456', isError: true })
})

for (const name of ['Agent: accept record', 'Coord: general', 'Audit: method']) {
  test(`a session named ${name} is refused and calls nothing`, async () => {
    const fx = fake(name)
    expect(await handler()(fx.dollar, INPUT)).toEqual({ result: NOT_ORCHESTRATOR, isError: true })
    expect(fx.calls).toEqual([])
  })
}

for (const [label, change] of [
  ['no pull request', { pr: 0 }], ['no failed record named', { over: ' ' }], ['no decision', { decision: '' }],
] as const) {
  test(`an acceptance with ${label} is refused and calls nothing`, async () => {
    const fx = fake('Orch: belt')
    const out = await handler()(fx.dollar, { ...INPUT, ...change })
    expect(out.isError).toBe(true)
    expect(fx.calls).toEqual([])
  })
}

test('a subagent of the orchestrator does not accept', async () => {
  const fx = fake('Orch: belt')
  expect((await handler()(fx.dollar, { ...INPUT, agentId: 'a1' })).isError).toBe(true)
  expect(fx.calls).toEqual([])
})
