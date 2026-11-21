// hooks/tests/permission-wait.test.ts
// An agent parked on a permission dialog, told to its orchestrator as the dialog appears
// (permission-wait.ts): one line per dialog, sent after the hook has answered, so nothing the relay
// reads or sends holds the dialog; the ask `tool.check` announced gives the call's id and the host's
// reason; the call's end is the dialog's answer, and a dialog still open past the busy bound is
// reminded once. An orchestrator's own dialog, or one a settings hook answered, sends nothing.
import { expect, test } from 'claude-code/testing'
import { capture, hookOf, hooksOn, hostOf, type HostParts } from '../../core/capture.ts'
import type { Events, Host, Noun, SessionSendResult } from '../../core/host.ts'
import { NOTICE_TTL_MS } from '../stop-gate.ts'
import { register as registerModule } from '../register.ts'
import {
  dialogLine, dialogTarget, newDialogMemory, noteAsk, openDialog, register, settleCall, ASKS_KEPT, REASON_ROOM, TARGET_ROOM,
} from '../permission-wait.ts'
import { logLineOf } from './fakes.ts'

type World = Host<Noun>

const HOME = '/tmp/h'
const STATE = `${HOME}/.claude/claude-orchestrator`
const AGENT = 'Agent: belt-p3'
const ORCH = 'Orch: belt'
const FILE = '/w/outside/notes.txt'
const REASON = 'Claude requested permissions to write to /w/outside/notes.txt, which is a sensitive file.'
const LINE = `[module] ${AGENT} waits on a permission dialog: Write ${FILE} — Claude requested permissions to write to /w/outside/notes.txt, which is a sensitive file; the operator answers it in its tab (ttys005)`

// Lets the relay the hook left running finish: its reads and its send answer at once here.
const settled = () => new Promise(resolve => setTimeout(resolve, 0))

type Fake = { parts: HostParts; sent: { to: unknown; text: string }[]; logged: string[]; timers: { ms: number; run: () => unknown }[] }

// A machine where this session is `name` on ttys005, its orchestrator Orch: belt on ttys001, whose
// launcher chain names ttys005; `send` answers each send.
function fake(over: { name?: string; role?: string; send?: () => Promise<SessionSendResult> } = {}): Fake {
  const name = over.name ?? AGENT
  const files = new Map<string, string>([
    [`${STATE}/store/sessions/s-one`, JSON.stringify({ role: over.role ?? 'agent', name, pid: '501', tty: '/dev/ttys005', repo: null, context_percent: 1, context_tokens: 1, window: 1, model: 'm', busy: true, updated_at: 'T' })],
    [`${STATE}/store/sessions/s-orch`, JSON.stringify({ role: 'orchestrator', name: ORCH, pid: '400', tty: '/dev/ttys001', repo: null, context_percent: 1, context_tokens: 1, window: 1, model: 'm', busy: false, updated_at: 'T' })],
    [`${STATE}/chains/ttys001.jsonl`, JSON.stringify({ tab_id: 'tab-a', tty: '/dev/ttys005', owner: 'own' }) + '\n'],
  ])
  const sent: Fake['sent'] = []
  const logged: string[] = []
  const timers: Fake['timers'] = []
  const parts: HostParts = {
    plugin: { root: '/plugins/orch-root' },
    env: { get: async (n: string) => (n === 'HOME' ? HOME : undefined) },
    session: {
      id: async () => 's-one',
      send: async (args: { to: string | { sessionId: string }; text: string }) => {
        if (over.send) return over.send()
        sent.push(args)
        return { isDelivered: true as const }
      },
    },
    fs: {
      read: async (p: string) => {
        const text = files.get(p)
        if (text === undefined) throw new Error(`ENOENT: ${p}`)
        return text
      },
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
    },
    process: {
      run: async (argv: readonly string[]) => {
        const line = logLineOf(argv)
        if (line !== null) logged.push(line)
        return { exitCode: line === null ? 1 : 0, stdout: '', stderr: '' }
      },
    },
    clock: { after: (ms: number, run: () => unknown) => { timers.push({ ms, run }); return { cancel: () => undefined } } },
  }
  return { parts, sent, logged, timers }
}

// The three hooks the file registers, each called as the engine would over `parts`.
function mounted(bound?: number) {
  const hooks = capture<World>(on => register(on, bound))
  const check = hookOf(hooks, 'tool.check')
  const request = hookOf(hooks, 'classic.PermissionRequest')
  const call = hookOf(hooks, 'tool.call')
  return {
    check: (f: Fake, e: Events['tool.check'], verdict: unknown) => check.handler(hostOf(f.parts), e, async () => verdict),
    request: (f: Fake, e: Events['classic.PermissionRequest'], answer: unknown = {}) => request.handler(hostOf(f.parts), e, async () => answer),
    call: (f: Fake, e: Events['tool.call'], answer: unknown = { result: 'ok' }) => call.handler(hostOf(f.parts), e, async () => answer),
  }
}

const CHECK: Events['tool.check'] = { tool: 'Write', input: { file_path: FILE, content: 'x' }, tool_use_id: 'toolu_1' }
const ASK = { decision: 'ask', reason: REASON }
const REQUEST: Events['classic.PermissionRequest'] = { tool_name: 'Write', tool_input: { file_path: FILE, content: 'x' }, permission_mode: 'default' }
const CALL: Events['tool.call'] = { tool: 'Write', tool_use_id: 'toolu_1', file_path: FILE, content: 'x' }

// --- the pure half --------------------------------------------------------------------------

test('the target is what the arguments name plainly, on one line; an argument list that names none has none', () => {
  expect(dialogTarget({ file_path: FILE, content: 'x' })).toBe(FILE)
  expect(dialogTarget({ command: 'rm -rf build &&\n  npm test' })).toBe('rm -rf build && npm test')
  expect(dialogTarget({ url: 'https://example.com/a' })).toBe('https://example.com/a')
  expect(dialogTarget({ notebook_path: '/w/a.ipynb' })).toBe('/w/a.ipynb')
  expect(dialogTarget({ prompt: 'do it' })).toBe('')
  expect(dialogTarget('not an object')).toBe('')
})

test('the line names the agent, the tool, the target and the reason, each cut, and the tab it waits in', () => {
  const dialog = { id: 'toolu_1', tool: 'Write', loop: '', target: FILE, reason: REASON }
  expect(dialogLine(AGENT, dialog, '/dev/ttys005')).toBe(LINE)
  expect(dialogLine(AGENT, { ...dialog, reason: null }, null)).toBe(`[module] ${AGENT} waits on a permission dialog: Write ${FILE}; the operator answers it in its tab`)
  expect(dialogLine(AGENT, { ...dialog, target: '' }, null, true))
    .toBe(`[module] ${AGENT} still waits on a permission dialog after 2h00: Write — Claude requested permissions to write to /w/outside/notes.txt, which is a sensitive file; the operator answers it in its tab`)
  const long = dialogLine(AGENT, { ...dialog, target: 'p'.repeat(TARGET_ROOM + 10), reason: 'r'.repeat(REASON_ROOM + 10) }, null)
  expect(long).toContain(`${'p'.repeat(TARGET_ROOM - 1)}… — ${'r'.repeat(REASON_ROOM - 1)}…;`)
})

test('a dialog takes the ask of its tool and loop when it is the only one, else the one of its target, else none', () => {
  const memory = newDialogMemory()
  noteAsk(memory, { tool: 'Read', input: { file_path: '/a' }, tool_use_id: 'r1' }, { decision: 'ask', reason: 'outside' })
  noteAsk(memory, { tool: 'Read', input: { file_path: '/b' }, tool_use_id: 'r2' }, { decision: 'ask' })
  noteAsk(memory, { tool: 'Read', input: { file_path: '/b' }, tool_use_id: 'r3', agentId: 'sub' }, { decision: 'ask' })
  // Neither an allow nor a query without an id is an ask the module keeps.
  noteAsk(memory, { tool: 'Read', input: { file_path: '/c' }, tool_use_id: 'r4' }, { decision: 'allow' })
  noteAsk(memory, { tool: 'Read', input: { file_path: '/c' } }, { decision: 'ask' })
  expect(openDialog(memory, 'Read', { file_path: '/b' }, '')).toEqual({ id: 'r2', tool: 'Read', loop: '', target: '/b', reason: null })
  expect(openDialog(memory, 'Read', { file_path: '/b' }, 'sub')).toMatchObject({ id: 'r3', loop: 'sub' })
  expect(openDialog(memory, 'Read', { file_path: '/elsewhere' }, '')).toMatchObject({ id: 'r1', reason: 'outside' })
  // Two asks of the tool, neither of the target: no guess.
  noteAsk(memory, { tool: 'Bash', input: { command: 'a' }, tool_use_id: 'b1' }, { decision: 'ask' })
  noteAsk(memory, { tool: 'Bash', input: { command: 'b' }, tool_use_id: 'b2' }, { decision: 'ask' })
  expect(openDialog(memory, 'Bash', { command: 'c' }, '')).toMatchObject({ id: null, target: 'c', reason: null })
})

test('a request for a dialog still open is the same dialog; the call\'s end closes it, and the next request is a new one', () => {
  const memory = newDialogMemory()
  noteAsk(memory, CHECK, ASK)
  expect(openDialog(memory, 'Write', REQUEST.tool_input, '')).toMatchObject({ id: 'toolu_1' })
  expect(openDialog(memory, 'Write', REQUEST.tool_input, '')).toBeNull()
  settleCall(memory, CALL)
  expect(memory.open).toEqual([])
  expect(openDialog(memory, 'Write', REQUEST.tool_input, '')).toMatchObject({ id: null })
  // A dialog no ask matched closes when a call of its tool in its loop ends.
  settleCall(memory, { tool: 'Write', tool_use_id: 'toolu_9' })
  expect(memory.open).toEqual([])
})

test('the module keeps a bounded number of asks, the oldest dropped', () => {
  const memory = newDialogMemory()
  for (let i = 0; i <= ASKS_KEPT; i++) noteAsk(memory, { tool: 'Bash', input: { command: `c${i}` }, tool_use_id: `t${i}` }, { decision: 'ask' })
  expect(memory.asks.length).toBe(ASKS_KEPT)
  expect(memory.asks[0]!.id).toBe('t1')
})

// --- the hooks --------------------------------------------------------------------------------

test("a supervised agent's permission dialog sends its orchestrator exactly one line, with the host's reason", async () => {
  const hooks = mounted()
  const f = fake()
  expect(await hooks.check(f, CHECK, ASK)).toBe(ASK)
  const answer = {}
  expect(await hooks.request(f, REQUEST, answer)).toBe(answer)
  await settled()
  expect(f.sent).toEqual([{ to: ORCH, text: LINE }])
})

test('the hook answers before any host call: a session id and a send that never settle hold nothing', async () => {
  const hooks = mounted()
  const f = fake({ send: () => new Promise<never>(() => undefined) })
  f.parts = { ...f.parts, session: { id: () => new Promise<never>(() => undefined), send: () => new Promise<never>(() => undefined) } }
  hooks.check(f, CHECK, ASK)
  const answer = {}
  expect(await hooks.request(f, REQUEST, answer)).toBe(answer)
  // The call goes on to its end with the relay still pending.
  const done = { result: 'written' }
  expect(await hooks.call(f, CALL, done)).toBe(done)
})

test('a send that never settles is given up at the bound and logged; one that throws is logged; the dialog goes on', async () => {
  const hung = fake({ send: () => new Promise<never>(() => undefined) })
  expect(await mounted(20).request(hung, REQUEST)).toEqual({})
  await new Promise(resolve => setTimeout(resolve, 60))
  expect(hung.logged.some(l => l.includes('permission: the line of Agent: belt-p3 did not go within 20 ms'))).toBe(true)
  const thrown = fake({ send: () => Promise.reject(new Error('the peer is gone')) })
  expect(await mounted(20).request(thrown, REQUEST)).toEqual({})
  await settled()
  expect(thrown.logged.some(l => l.includes('permission: the peer is gone'))).toBe(true)
  const refused = fake({ send: async () => ({ isDelivered: false, reason: 'nobody by that name' }) })
  await mounted(20).request(refused, REQUEST)
  await settled()
  expect(refused.logged.some(l => l.includes(`permission: not delivered to ${ORCH}: nobody by that name`))).toBe(true)
})

test('a second request in the same dialog sends nothing; the next dialog after the answer sends again', async () => {
  const hooks = mounted()
  const f = fake()
  await hooks.check(f, CHECK, ASK)
  await hooks.request(f, REQUEST)
  await hooks.request(f, REQUEST)
  await settled()
  expect(f.sent.length).toBe(1)
  await hooks.call(f, CALL, { deny: 'refused by the operator' })
  await hooks.check(f, { ...CHECK, tool_use_id: 'toolu_2' }, ASK)
  await hooks.request(f, REQUEST)
  await settled()
  expect(f.sent.length).toBe(2)
})

test("an orchestrator's own dialog, a session with no role's, and one a settings hook answered send nothing", async () => {
  const hooks = mounted()
  for (const f of [fake({ name: ORCH, role: 'orchestrator' }), fake({ name: 'Coord: ops', role: 'coordinator' })]) {
    await hooks.check(f, CHECK, ASK)
    await hooks.request(f, REQUEST)
    await settled()
    expect(f.sent).toEqual([])
    expect(f.timers).toEqual([])
  }
  const answered = fake()
  const decided = { decision: { behavior: 'allow' } }
  expect(await hooks.request(answered, REQUEST, decided)).toBe(decided)
  await settled()
  expect(answered.sent).toEqual([])
})

test('a dialog still open past the busy bound is reminded once; one answered before its bound is reminded nothing', async () => {
  const hooks = mounted()
  const f = fake()
  await hooks.check(f, CHECK, ASK)
  await hooks.request(f, REQUEST)
  await settled()
  expect(f.timers.map(t => t.ms)).toEqual([NOTICE_TTL_MS])
  await f.timers[0]!.run()
  await settled()
  await f.timers[0]!.run()
  await settled()
  expect(f.sent.map(s => s.text)).toEqual([LINE, LINE.replace('waits on a permission dialog:', 'still waits on a permission dialog after 2h00:')])
  // Answered before the bound: its timer finds it closed.
  const other = mounted()
  const g = fake()
  await other.check(g, { ...CHECK, tool_use_id: 'toolu_3' }, ASK)
  await other.request(g, REQUEST)
  await settled()
  await other.call(g, { ...CALL, tool_use_id: 'toolu_3' })
  await g.timers[0]!.run()
  await settled()
  expect(g.sent.length).toBe(1)
})

test('a dialog no announced ask matches still sends its line, without a reason, and arms no reminder', async () => {
  const hooks = mounted()
  const f = fake()
  await hooks.request(f, REQUEST)
  await settled()
  expect(f.sent.map(s => s.text)).toEqual([`[module] ${AGENT} waits on a permission dialog: Write ${FILE}; the operator answers it in its tab (ttys005)`])
  expect(f.timers).toEqual([])
})

test('a call that throws still closes its dialog, and the throw goes on to the caller', async () => {
  const hooks = capture<World>(on => register(on))
  const request = hookOf(hooks, 'classic.PermissionRequest')
  const call = hookOf(hooks, 'tool.call')
  const f = fake()
  await request.handler(hostOf(f.parts), REQUEST, async () => ({}))
  await expect(call.handler(hostOf(f.parts), CALL, async () => { throw new Error('boom') })).rejects.toThrow('boom')
  await request.handler(hostOf(f.parts), REQUEST, async () => ({}))
  await settled()
  expect(f.sent.length).toBe(2)
})

test('the module mounts the dialog hooks', () => {
  const hooks = capture<World>(registerModule)
  expect(hooksOn(hooks, 'classic.PermissionRequest').length).toBe(1)
  expect(hooksOn(hooks, 'tool.check').length).toBe(1)
})
