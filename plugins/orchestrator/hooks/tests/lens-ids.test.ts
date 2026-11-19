// hooks/tests/lens-ids.test.ts
// A review reader's answer reaches its review session with each finding line's id at its end: the
// answer of a reader run in the foreground, the hand-back of one run in the background. A reader
// whose description names no lens, another agent type, and the rest of an answer pass as they came.
import { expect, test } from 'claude-code/testing'
import { register } from '../register.ts'
import { LENS_GENERIC_CODE, register as registerLensIds } from '../lens-ids.ts'
import { findingId } from '../../core/lens.ts'
import { capture, hookOf, hostOf } from '../../core/capture.ts'
import type { Host, Noun } from '../../core/host.ts'

type World = Host<Noun>
const ANSWER = 'Read the diff.\n[important] src/a.ts:12 — the lock is lost — unlock() first'
const MARKED = `Read the diff.\n[important] src/a.ts:12 — the lock is lost — unlock() first — id ${findingId('correctness', 'src/a.ts', 12, 'the lock is lost')}`
const LENS = { tool: 'Agent', subagent_type: 'orchestrator:lens', description: 'lens correctness acme/thing#12 origin/main..0123456789ab', prompt: 'read' }

const hooks = capture<World>(registerLensIds)
const agent = hookOf(hooks, 'tool.call', { tool: 'Agent' })
const handback = hookOf(hooks, 'tool.call', { tool: 'SubagentHandback' })
const $ = hostOf({ fs: { write: async () => undefined }, process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) } })

test('a reader run in the foreground: each finding line of its answer gets its id, wherever the answer holds its text', async () => {
  expect(await agent.handler($, LENS as never, (async () => ({ result: ANSWER })) as never)).toEqual({ result: MARKED })
  const nested = { result: { status: 'completed', content: [{ type: 'text', text: ANSWER }] } }
  expect(await agent.handler($, LENS as never, (async () => nested) as never)).toEqual({ result: { status: 'completed', content: [{ type: 'text', text: MARKED }] } })
})

test('another agent, or a reader whose description names no lens, passes as it came', async () => {
  for (const call of [{ ...LENS, subagent_type: 'Explore' }, { ...LENS, description: 'Lens: correctness' }]) {
    expect(await agent.handler($, call as never, (async () => ({ result: ANSWER })) as never)).toEqual({ result: ANSWER })
  }
})

test('a reader run in the background: its hand-back carries the ids; another agent\'s hand-back is as it came', async () => {
  const launched = { result: { status: 'async_launched', agentId: 'a-lens-1' } }
  expect(await agent.handler($, LENS as never, (async () => launched) as never)).toEqual(launched)
  let sent: unknown
  await handback.handler($, { tool: 'SubagentHandback', agentId: 'a-lens-1', message: ANSWER } as never, (async (e: unknown) => { sent = e; return { result: 'ok' } }) as never)
  expect((sent as Record<string, unknown>)['message']).toBe(MARKED)
  await handback.handler($, { tool: 'SubagentHandback', agentId: 'other', message: ANSWER } as never, (async (e: unknown) => { sent = e; return { result: 'ok' } }) as never)
  expect((sent as Record<string, unknown>)['message']).toBe(ANSWER)
})

test('the module mounts the readers\' ids', () => {
  const all = capture<World>(register)
  expect(all.some(h => h.event === 'tool.call' && h.matcher?.['tool'] === 'SubagentHandback')).toBe(true)
})

// A machine whose install record gives the toolkit at /tk, with the agents named in `agents`.
const RECORD = JSON.stringify({ version: 2, plugins: { 'pr-review-toolkit@official': [{ scope: 'user', installPath: '/tk' }] } })
const machine = (agents: Record<string, string>, record: string | undefined = RECORD) => hostOf({
  env: { get: async (name: string) => (name === 'HOME' ? '/u/me' : undefined) },
  fs: {
    write: async () => undefined,
    read: async (path: string) => {
      const text = path === '/u/me/.claude/plugins/installed_plugins.json' ? record : agents[path]
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
  },
  process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
})
const launched = async (world: World, call: Record<string, unknown>): Promise<Record<string, unknown>> => {
  let sent: Record<string, unknown> = {}
  await agent.handler(world, call as never, (async (e: Record<string, unknown>) => { sent = e; return { result: ANSWER } }) as never)
  return sent
}

test('a launch with a toolkit method whose prompt names its file passes through the tool.call hook with its input unchanged, the same object', async () => {
  const world = machine({ '/tk/agents/silent-failure-hunter.md': '---\nname: silent-failure-hunter\n---\nHunt every swallowed error.\n' })
  const call = { ...LENS, description: 'lens silent-failures acme/thing#12 origin/main..0123456789ab', prompt: 'read /tk/agents/silent-failure-hunter.md first' }
  expect(await launched(world, call)).toBe(call)
})

test('a toolkit launch whose prompt names no method file is refused, the reader never runs, and the refusal names the file', async () => {
  const world = machine({ '/tk/agents/silent-failure-hunter.md': 'Hunt every swallowed error.\n' })
  const call = { ...LENS, description: 'lens silent-failures acme/thing#12 origin/main..0123456789ab' }
  let ran = false
  const answer = await agent.handler(world, call as never, (async () => { ran = true; return { result: ANSWER } }) as never)
  expect(ran).toBe(false)
  expect(String((answer as Record<string, unknown>)['deny'])).toContain('/tk/agents/silent-failure-hunter.md')
})

test('an angle with no toolkit agent stays the generic lens: its launch as it came', async () => {
  const world = machine({ '/tk/agents/code-reviewer.md': 'Review the code.' })
  const call = { ...LENS, description: 'lens security acme/thing#12 origin/main..0123456789ab' }
  expect(await launched(world, call)).toEqual(call)
})

test('a missing toolkit falls back to the generic lens: no record, no install, or no agent file', async () => {
  for (const world of [machine({}, undefined), machine({}, JSON.stringify({ version: 2, plugins: {} })), machine({})]) {
    expect(await launched(world, LENS)).toEqual(LENS)
  }
})

test('a reader whose lens has a method: the answer is still marked with its finding ids', async () => {
  const world = machine({ '/tk/agents/code-reviewer.md': 'Review the code.' })
  const named = { ...LENS, prompt: 'read /tk/agents/code-reviewer.md first' }
  expect(await agent.handler(world, named as never, (async () => ({ result: ANSWER })) as never)).toEqual({ result: MARKED })
})

test('a relevant angle launched generic is journaled under its code and launches as it came; a failure to read the machine launches the reader as it came', async () => {
  const written: string[] = []
  const journaled = (env: { get: (name: string) => Promise<string | undefined> }) => hostOf({
    env,
    fs: { read: async () => { throw new Error('ENOENT') }, write: async (_path: string, text: string) => { written.push(text) }, list: async () => [] },
    session: { id: async () => '3f1c2a7e-9b4d-4e8a-8c2f-5d6e7f8a9b0c' },
    process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
  } as never)
  const home = { get: async (name: string) => (name === 'HOME' ? '/u/me' : undefined) }
  expect(await launched(journaled(home), LENS)).toEqual(LENS)
  expect(written.some(text => text.includes(LENS_GENERIC_CODE))).toBe(true)
  const broken = hostOf({ env: { get: async () => { throw new Error('no env') } }, fs: machine({}).fs } as never)
  expect(await launched(broken, LENS)).toEqual(LENS)
})
