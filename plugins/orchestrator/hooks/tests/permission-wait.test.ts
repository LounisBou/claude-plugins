// hooks/tests/permission-wait.test.ts
// An agent parked on a permission dialog, told to its orchestrator as the dialog appears
// (permission-wait.ts): one line per dialog, sent after the hook has answered, so nothing the relay
// reads or sends holds the dialog; the ask `tool.check` announced, bound by core's rule, gives the
// call's id and the host's reason; the call's end, or its loop's turn end, is the dialog's answer, and
// a dialog still open past the busy bound is reminded once. The target and the reason are cut between
// words. An orchestrator's own dialog, a role-less session's, or one a settings hook answered sends nothing.
import { expect, test } from 'claude-code/testing'
import { capture, hookOf, hooksOn, hostOf, type HostParts } from '../../core/capture.ts'
import type { Events, Host, Noun, SessionSendResult } from '../../core/host.ts'
import { NOTICE_TTL_MS } from '../stop-gate.ts'
import { register as registerModule } from '../register.ts'
import {
  cutWords, dialogLine, dialogTarget, newDialogMemory, noteAsk, openDialog, register, settleCall, settleLoop, ASKS_KEPT, REASON_ROOM, TARGET_ROOM, type Dialog,
} from '../permission-wait.ts'
import { logLineOf } from './fakes.ts'

type World = Host<Noun>

const HOME = '/tmp/h'
const STATE = `${HOME}/.claude/claude-orchestrator`
const AGENT = 'Agent: belt-p3'
const ORCH = 'Orch: belt'
const FILE = '/w/outside/notes.txt'
const REASON = 'Permission is needed to write to /w/outside/notes.txt, which is a sensitive file.'
const LINE = `[module] ${AGENT} waits on a permission dialog: Write ${FILE} — Permission is needed to write to /w/outside/notes.txt, which is a sensitive file; the operator answers it in its tab (ttys005)`
const REMINDER = `[module] ${AGENT}: the call that opened a permission dialog 2h00 ago has not ended: Write ${FILE} — Permission is needed to write to /w/outside/notes.txt, which is a sensitive file; its dialog may still wait in the operator's tab (ttys005), or the call runs on`

// Lets the relay the hook left running finish: its reads and its send answer at once here.
const settled = () => new Promise(resolve => setTimeout(resolve, 0))
const later = <T>(ms: number, value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms))

type Fake = { parts: HostParts; sent: { to: unknown; text: string }[]; logged: string[]; timers: { ms: number; run: () => unknown }[] }

// A machine where this session is `name` on ttys005, its orchestrator Orch: belt on ttys001, whose
// launcher chain names ttys005 (none when `orphan`); `send` answers each send, `id` the session's id,
// and a listing of a folder answers after `listMs`.
function fake(over: { name?: string; role?: string | null; send?: () => Promise<SessionSendResult>; id?: () => Promise<string>; orphan?: boolean; listMs?: number } = {}): Fake {
  const name = over.name ?? AGENT
  const files = new Map<string, string>([
    [`${STATE}/store/sessions/s-one`, JSON.stringify({ role: over.role === undefined ? 'agent' : over.role, name, pid: '501', tty: '/dev/ttys005', repo: null, context_percent: 1, context_tokens: 1, window: 1, model: 'm', busy: true, updated_at: 'T' })],
    [`${STATE}/store/sessions/s-orch`, JSON.stringify({ role: 'orchestrator', name: ORCH, pid: '400', tty: '/dev/ttys001', repo: null, context_percent: 1, context_tokens: 1, window: 1, model: 'm', busy: false, updated_at: 'T' })],
  ])
  if (!over.orphan) files.set(`${STATE}/chains/ttys001.jsonl`, JSON.stringify({ tab_id: 'tab-a', tty: '/dev/ttys005', owner: 'own' }) + '\n')
  const sent: Fake['sent'] = []
  const logged: string[] = []
  const timers: Fake['timers'] = []
  const parts: HostParts = {
    plugin: { root: '/plugins/orch-root' },
    env: { get: async (n: string) => (n === 'HOME' ? HOME : undefined) },
    session: {
      id: over.id ?? (async () => 's-one'),
      send: async (args: { to: string | { sessionId: string }; text: string }) => {
        const answer = over.send ? await over.send() : { isDelivered: true as const }
        if (answer.isDelivered) sent.push(args)
        return answer
      },
    },
    fs: {
      read: async (p: string) => {
        const text = files.get(p)
        if (text === undefined) throw new Error(`ENOENT: ${p}`)
        return text
      },
      list: async (dir: string) => {
        if (over.listMs !== undefined) await later(over.listMs, null)
        return [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
          .map(p => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))
      },
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

// The hooks the file registers, each called as the engine would over `parts`.
function mounted(bound?: number) {
  const hooks = capture<World>(on => register(on, bound))
  const check = hookOf(hooks, 'tool.check')
  const request = hookOf(hooks, 'classic.PermissionRequest')
  const call = hookOf(hooks, 'tool.call', {})
  const turn = hookOf(hooks, 'turn.complete', {})
  return {
    check: (f: Fake, e: Events['tool.check'], verdict: unknown) => check.handler(hostOf(f.parts), e, async () => verdict),
    request: (f: Fake, e: Events['classic.PermissionRequest'], answer: unknown = {}) => request.handler(hostOf(f.parts), e, async () => answer),
    call: (f: Fake, e: Events['tool.call'], answer: unknown = { result: 'ok' }) => call.handler(hostOf(f.parts), e, async () => answer),
    turn: (f: Fake, e: Events['turn.complete']) => turn.handler(hostOf(f.parts), e, async () => undefined),
  }
}

const INPUT = { file_path: FILE, content: 'x' }
const CHECK: Events['tool.check'] = { tool: 'Write', input: INPUT, tool_use_id: 'toolu_1' }
const ASK = { decision: 'ask', reason: REASON }
const REQUEST: Events['classic.PermissionRequest'] = { tool_name: 'Write', tool_input: INPUT, permission_mode: 'default' }
const CALL: Events['tool.call'] = { tool: 'Write', tool_use_id: 'toolu_1', file_path: FILE, content: 'x' }
const DIALOG: Dialog = { id: 'toolu_1', tool: 'Write', agent: undefined, input: '', target: FILE, reason: REASON }

// --- the pure half --------------------------------------------------------------------------

test('the target is what the arguments name plainly, on one line; an argument list that names none has none', () => {
  expect(dialogTarget({ file_path: FILE, content: 'x' })).toBe(FILE)
  expect(dialogTarget({ command: 'rm -rf build &&\n  npm test' })).toBe('rm -rf build && npm test')
  expect(dialogTarget({ url: 'https://example.com/a' })).toBe('https://example.com/a')
  expect(dialogTarget({ notebook_path: '/w/a.ipynb' })).toBe('/w/a.ipynb')
  expect(dialogTarget({ prompt: 'do it' })).toBe('')
  expect(dialogTarget('not an object')).toBe('')
})

test('the line names the agent, the tool, the target and the reason, and the tab it waits in', () => {
  expect(dialogLine(AGENT, DIALOG, '/dev/ttys005')).toBe(LINE)
  expect(dialogLine(AGENT, { ...DIALOG, reason: null }, null)).toBe(`[module] ${AGENT} waits on a permission dialog: Write ${FILE}; the operator answers it in its tab`)
  expect(dialogLine(AGENT, { ...DIALOG, target: '' }, null, true))
    .toBe(`[module] ${AGENT}: the call that opened a permission dialog 2h00 ago has not ended: Write — Permission is needed to write to /w/outside/notes.txt, which is a sensitive file; its dialog may still wait in the operator's tab, or the call runs on`)
})

test('a text past its room is cut between words, so a secret in it is kept whole or left out', () => {
  expect(cutWords('short enough', 20)).toBe('short enough')
  const secret = 'https://deploy:Hunter2Password@host.example/releases/v1/archive.tar.gz'
  const command = `curl -fsS --retry 3 -o /tmp/out ${secret}`
  for (let room = 30; room < command.length; room++) {
    const cut = cutWords(command, room)
    expect(cut.length).toBeLessThanOrEqual(room)
    expect(cut.endsWith(' …')).toBe(true)
    expect(cut.includes('Hunter2')).toBe(false)
  }
  expect(cutWords(command, 40)).toBe('curl -fsS --retry 3 -o /tmp/out …')
  // One word too long for the room: a path by its end, a URL by its origin, anything else left out.
  const path = `/private/tmp/${'d'.repeat(150)}/outside/.claude/settings.json`
  expect(cutWords(path, TARGET_ROOM)).toBe(`…${path.slice(path.length - TARGET_ROOM + 1)}`)
  expect(cutWords(path, TARGET_ROOM).endsWith('/outside/.claude/settings.json')).toBe(true)
  expect(cutWords(`${secret}?q=${'z'.repeat(TARGET_ROOM)}`, TARGET_ROOM)).toBe('https://host.example…')
  expect(cutWords('t'.repeat(TARGET_ROOM + 10), TARGET_ROOM)).toBe('…')
  // On the line: the target within its room, the reason within its own.
  const long = dialogLine(AGENT, { ...DIALOG, target: 'p '.repeat(TARGET_ROOM), reason: 'r '.repeat(REASON_ROOM) }, null)
  expect(long).toContain(`Write ${'p '.repeat(TARGET_ROOM / 2 - 1)}… — ${'r '.repeat(REASON_ROOM / 2 - 1)}…;`)
})

test('a dialog takes the ask with its tool, loop and arguments; another call\'s ask, or two alike, leave it without a reason', () => {
  const memory = newDialogMemory()
  noteAsk(memory, { tool: 'Read', input: { file_path: '/a' }, tool_use_id: 'r1' }, { decision: 'ask', reason: 'outside' })
  noteAsk(memory, { tool: 'Read', input: { file_path: '/b' }, tool_use_id: 'r2' }, { decision: 'ask' })
  noteAsk(memory, { tool: 'Read', input: { file_path: '/b' }, tool_use_id: 'r3', agentId: 'sub' }, { decision: 'ask' })
  // Neither an allow nor a query without an id is an ask the module keeps.
  noteAsk(memory, { tool: 'Read', input: { file_path: '/c' }, tool_use_id: 'r4' }, { decision: 'allow' })
  noteAsk(memory, { tool: 'Read', input: { file_path: '/c' } }, { decision: 'ask' })
  expect(memory.asks.map(a => a.id)).toEqual(['r1', 'r2', 'r3'])
  expect(openDialog(memory, 'Read', { file_path: '/b' }, undefined)).toMatchObject({ id: 'r2', target: '/b', reason: null })
  expect(openDialog(memory, 'Read', { file_path: '/b' }, 'sub')).toMatchObject({ id: 'r3', agent: 'sub' })
  // The only Read ask left is the one of /a: a dialog of /elsewhere is not given its reason.
  expect(openDialog(memory, 'Read', { file_path: '/elsewhere' }, undefined)).toMatchObject({ id: null, reason: null })
  expect(openDialog(memory, 'Read', { file_path: '/a' }, undefined)).toMatchObject({ id: 'r1', reason: 'outside' })
  noteAsk(memory, { tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'b1' }, { decision: 'ask' })
  noteAsk(memory, { tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'b2' }, { decision: 'ask' })
  expect(openDialog(memory, 'Bash', { command: 'ls' }, undefined)).toMatchObject({ id: null, target: 'ls', reason: null })
})

test('a request for a dialog still open is the same dialog; the call\'s end closes it, and the next request is a new one', () => {
  const memory = newDialogMemory()
  noteAsk(memory, CHECK, ASK)
  expect(openDialog(memory, 'Write', INPUT, undefined)).toMatchObject({ id: 'toolu_1' })
  expect(openDialog(memory, 'Write', INPUT, undefined)).toBeNull()
  settleCall(memory, CALL)
  expect(memory.open).toEqual([])
  expect(openDialog(memory, 'Write', INPUT, undefined)).toMatchObject({ id: null })
  // A dialog no ask matched closes when a call of its tool in its loop ends.
  settleCall(memory, { tool: 'Write', tool_use_id: 'toolu_9' })
  expect(memory.open).toEqual([])
})

test("a call's end closes its own dialog only: another call's, another tool's or another loop's stays open", () => {
  const memory = newDialogMemory()
  noteAsk(memory, CHECK, ASK)
  noteAsk(memory, { ...CHECK, input: { file_path: '/w/other', content: 'y' }, tool_use_id: 'toolu_2' }, ASK)
  noteAsk(memory, { ...CHECK, tool_use_id: 'toolu_s', agentId: 'sub' }, ASK)
  openDialog(memory, 'Write', INPUT, undefined)
  openDialog(memory, 'Write', { file_path: '/w/other', content: 'y' }, undefined)
  openDialog(memory, 'Write', INPUT, 'sub')
  openDialog(memory, 'Bash', { command: 'ls' }, undefined)
  openDialog(memory, 'Write', { file_path: '/w/third', content: 'z' }, 'sub')
  settleCall(memory, CALL)
  expect(memory.open.map(d => [d.id, d.tool, d.agent])).toEqual([['toolu_2', 'Write', undefined], ['toolu_s', 'Write', 'sub'], [null, 'Bash', undefined], [null, 'Write', 'sub']])
  // A call of the main loop's Write ends: the subagent's unmatched Write dialog stays.
  settleCall(memory, { tool: 'Write', tool_use_id: 'toolu_2' })
  expect(memory.open.map(d => d.id)).toEqual(['toolu_s', null, null])
})

test('a new ask for the arguments of a dialog left open is a new dialog: the one whose end was not seen gives way', () => {
  const memory = newDialogMemory()
  noteAsk(memory, CHECK, ASK)
  const first = openDialog(memory, 'Write', INPUT, undefined)
  noteAsk(memory, { ...CHECK, tool_use_id: 'toolu_2' }, ASK)
  const second = openDialog(memory, 'Write', INPUT, undefined)
  expect(second).toMatchObject({ id: 'toolu_2', reason: REASON })
  expect(memory.open).toEqual([second])
  expect(memory.open.includes(first!)).toBe(false)
  expect(memory.asks).toEqual([])
})

test('a loop\'s turn end forgets its dialogs and its asks, and only its own', () => {
  const memory = newDialogMemory()
  noteAsk(memory, CHECK, ASK)
  noteAsk(memory, { ...CHECK, tool_use_id: 'toolu_s', agentId: 'sub' }, ASK)
  noteAsk(memory, { ...CHECK, input: { file_path: '/w/other', content: 'y' }, tool_use_id: 'toolu_3' }, ASK)
  noteAsk(memory, { ...CHECK, input: { file_path: '/w/later', content: 'y' }, tool_use_id: 'toolu_t', agentId: 'sub' }, ASK)
  openDialog(memory, 'Write', INPUT, undefined)
  openDialog(memory, 'Write', INPUT, 'sub')
  settleLoop(memory, undefined)
  expect(memory.asks.map(a => a.id)).toEqual(['toolu_t'])
  expect(memory.open.map(d => d.id)).toEqual(['toolu_s'])
  settleLoop(memory, 'sub')
  expect(memory.asks).toEqual([])
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

test('the hook answers at once: before any timer runs, with a session id and a send that never settle', async () => {
  const hooks = mounted()
  const f = fake({ id: () => new Promise<never>(() => undefined), send: () => new Promise<never>(() => undefined) })
  hooks.check(f, CHECK, ASK)
  const answer = {}
  const first = await Promise.race([hooks.request(f, REQUEST, answer), later(0, 'a timer ran first')])
  expect(first).toBe(answer)
  // The call goes on to its end with the relay still pending.
  const done = { result: 'written' }
  expect(await Promise.race([hooks.call(f, CALL, done), later(0, 'a timer ran first')])).toBe(done)
})

test('a send that never settles is given up at the bound and logged; one that throws is logged; the dialog goes on', async () => {
  const hung = fake({ send: () => new Promise<never>(() => undefined) })
  expect(await mounted(20).request(hung, REQUEST)).toEqual({})
  await later(60, null)
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

test('a lookup that ends past the bound sends nothing, and the reminder is armed all the same', async () => {
  const slow = fake({ id: () => later(40, 's-one') })
  await mounted(20).request(slow, REQUEST)
  await later(80, null)
  expect(slow.sent).toEqual([])
  expect(slow.logged.some(l => l.includes('permission: the line of this session did not go within 20 ms'))).toBe(true)
  expect(slow.timers.map(t => t.ms)).toEqual([NOTICE_TTL_MS])
  // The session known in time, its orchestrator found past the bound: nothing is sent after the log.
  const late = fake({ listMs: 30 })
  await mounted(20).request(late, REQUEST)
  // Long enough for the lookup to end (two listings) and a send to follow it, were one made.
  await later(150, null)
  expect(late.sent).toEqual([])
  expect(late.logged.some(l => l.includes(`permission: the line of ${AGENT} did not go within 20 ms`))).toBe(true)
  expect(late.timers.map(t => t.ms)).toEqual([NOTICE_TTL_MS])
})

test('an agent whose orchestrator is found nowhere sends nothing and leaves one log line', async () => {
  const f = fake({ orphan: true })
  await mounted().request(f, REQUEST)
  await settled()
  await settled()
  expect(f.sent).toEqual([])
  expect(f.logged.some(l => l.includes(`permission: no orchestrator found for ${AGENT} on /dev/ttys005`))).toBe(true)
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

test("an orchestrator's, a coordinator's or a role-less session's dialog sends and arms nothing, and so does one a settings hook answered", async () => {
  for (const f of [fake({ name: ORCH, role: 'orchestrator' }), fake({ name: 'Coord: ops', role: 'coordinator' }), fake({ name: 'scratch notes', role: null })]) {
    const hooks = mounted()
    await hooks.check(f, CHECK, ASK)
    await hooks.request(f, REQUEST)
    await settled()
    expect(f.sent).toEqual([])
    expect(f.timers).toEqual([])
  }
  const answered = fake()
  const decided = { decision: { behavior: 'allow' } }
  expect(await mounted().request(answered, REQUEST, decided)).toBe(decided)
  await settled()
  expect(answered.sent).toEqual([])
  expect(answered.timers).toEqual([])
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
  // The reminder arms no reminder of its own.
  expect(f.timers.length).toBe(1)
  await f.timers[0]!.run()
  await settled()
  expect(f.sent.map(s => s.text)).toEqual([LINE, REMINDER])
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

test('an approved call still running at the bound is reminded as a call not ended, never as a dialog that still waits', async () => {
  // The host raises nothing at the operator's answer: an approved call runs inside its tool.call, whose end comes after the run.
  const hooks = mounted()
  const f = fake()
  await hooks.check(f, CHECK, ASK)
  await hooks.request(f, REQUEST)
  await settled()
  await f.timers[0]!.run()
  await settled()
  const reminder = f.sent[1]!.text
  expect(reminder).toBe(REMINDER)
  expect(reminder.includes('still waits')).toBe(false)
  expect(reminder.endsWith('or the call runs on')).toBe(true)
})

test('a dialog once reminded is forgotten: a later request of its arguments, whose call end was missed, is told again', async () => {
  const hooks = mounted()
  const f = fake()
  await hooks.request(f, REQUEST)
  await settled()
  await f.timers[0]!.run()
  await settled()
  await hooks.request(f, REQUEST)
  await settled()
  expect(f.sent.length).toBe(3)
  expect(f.sent[2]!.text).toBe(f.sent[0]!.text)
})

test('a dialog no announced ask matches sends its line without a reason, and is reminded like any other', async () => {
  const hooks = mounted()
  const f = fake()
  await hooks.request(f, REQUEST)
  await settled()
  expect(f.sent.map(s => s.text)).toEqual([`[module] ${AGENT} waits on a permission dialog: Write ${FILE}; the operator answers it in its tab (ttys005)`])
  expect(f.timers.map(t => t.ms)).toEqual([NOTICE_TTL_MS])
  await f.timers[0]!.run()
  await settled()
  expect(f.sent.length).toBe(2)
})

test("a subagent's dialog takes its own ask, and outlives the main loop's turn end until its own", async () => {
  const hooks = mounted()
  const f = fake()
  await hooks.check(f, { ...CHECK, tool_use_id: 'toolu_s', agentId: 'sub' }, ASK)
  await hooks.request(f, { ...REQUEST, agent_id: 'sub' })
  await settled()
  expect(f.sent.map(s => s.text)).toEqual([LINE])
  await hooks.turn(f, {})
  await f.timers[0]!.run()
  await settled()
  expect(f.sent.map(s => s.text)).toEqual([LINE, REMINDER])
  const g = fake()
  await hooks.request(g, { ...REQUEST, tool_input: { file_path: '/w/again', content: 'x' }, agent_id: 'sub' })
  await settled()
  await hooks.turn(g, { agentId: 'sub' })
  await g.timers[0]!.run()
  await settled()
  expect(g.sent.length).toBe(1)
})

test('a dialog whose turn ended without its call\'s end is reminded nothing', async () => {
  const hooks = mounted()
  const f = fake()
  await hooks.check(f, CHECK, ASK)
  await hooks.request(f, REQUEST)
  await settled()
  await hooks.turn(f, { isAborted: true })
  await f.timers[0]!.run()
  await settled()
  expect(f.sent.map(s => s.text)).toEqual([LINE])
})

test('a call that throws still closes its dialog, and the throw goes on to the caller', async () => {
  const hooks = capture<World>(on => register(on))
  const request = hookOf(hooks, 'classic.PermissionRequest')
  const call = hookOf(hooks, 'tool.call', {})
  const f = fake()
  await request.handler(hostOf(f.parts), REQUEST, async () => ({}))
  await expect(call.handler(hostOf(f.parts), CALL, async () => { throw new Error('boom') })).rejects.toThrow('boom')
  await request.handler(hostOf(f.parts), REQUEST, async () => ({}))
  await settled()
  expect(f.sent.length).toBe(2)
})

test('an ask or a dialog the module cannot read leaves one log line, and the verdict and the dialog stand', async () => {
  const hooks = mounted()
  const f = fake()
  const unreadable = { get decision(): string { throw new Error('a verdict that throws') } }
  // Compared by identity: the kit's toBe prints its operands, which reads the getter.
  expect(await hooks.check(f, CHECK, unreadable) === unreadable).toBe(true)
  const input = { get file_path(): string { throw new Error('arguments that throw') } }
  const answer = {}
  expect(await hooks.request(f, { ...REQUEST, tool_input: input }, answer)).toBe(answer)
  await settled()
  expect(f.sent).toEqual([])
  expect(f.logged.some(l => l.includes('permission: an ask was not kept: a verdict that throws'))).toBe(true)
  expect(f.logged.some(l => l.includes('permission: a dialog was not told: arguments that throw'))).toBe(true)
})

test('the module mounts the dialog hooks, and takes no event twice without a matcher', () => {
  const hooks = capture<World>(registerModule)
  expect(hooksOn(hooks, 'classic.PermissionRequest').length).toBe(1)
  expect(hooksOn(hooks, 'tool.check').length).toBe(1)
  // The host refuses to load a module that registers one event twice without a matcher.
  const bare = hooks.filter(h => h.matcher === undefined).map(h => h.event)
  expect(bare.filter((event, i) => bare.indexOf(event) !== i)).toEqual([])
})

test("the dialog's call end is taken outside every tool hook of the module but the audit's, which always calls its tool", () => {
  // A chain answers in registration order: a guard that refuses a call without calling its tool runs inside this hook.
  const hooks = capture<World>(registerModule)
  const request = hooks.findIndex(h => h.event === 'classic.PermissionRequest')
  const own = hooks.findIndex((h, i) => i > request && h.event === 'tool.call')
  expect(hooks.slice(0, own).filter(h => h.event === 'tool.call').length).toBe(1)
})
