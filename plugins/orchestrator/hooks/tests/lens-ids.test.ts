// hooks/tests/lens-ids.test.ts
// A review reader's answer reaches its review session with each finding line's id at its end: the
// answer of a reader run in the foreground, the hand-back of one run in the background. A reader
// whose description names no lens, another agent type, and the rest of an answer pass as they came.
import { expect, test } from 'claude-code/testing'
import { register } from '../register.ts'
import { register as registerLensIds } from '../lens-ids.ts'
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
