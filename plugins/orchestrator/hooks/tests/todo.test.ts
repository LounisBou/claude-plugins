// hooks/tests/todo.test.ts
// The `todo` tool over a faked $: a request recorded in the holder's own list, written by the module
// alone under the store's lock; a request for another session written into that session's list first
// and sent after, in one call; one for a session on another machine only sent, and said not recorded.
import { expect, test } from 'claude-code/testing'
import { SURFACE_TICK_MS, TODO_TOOL, callTodo, register as registerTodo, registerSurface, surfaceDue } from '../todo.ts'
import { TODO_OWNER_FIELDS, todoItems } from '../todo-format.ts'
import { register as registerWait, Declarations } from '../wait.ts'
import { WAIT_TOOL } from '../../core/orchestration.ts'
import { registerEnd, statusText } from '../commands.ts'
import type { SessionRow } from '../supervision.ts'
import { todoCounts } from '../todo.ts'
import { logLineOf, lockRun } from './fakes.ts'
import { capture, hooksOn, hostOf } from '../../core/capture.ts'
import { fieldsOf, type Events, type Hook, type Host, type Noun, type ToolSpec } from '../../core/host.ts'

type World = Host<Noun>
// What a tool or a command answers, as far as these tests read it.
type Out = { readonly result?: unknown; readonly isError?: boolean; readonly passed?: unknown }

const HOME = '/tmp/todo-home'
const MODULE = `${HOME}/.claude/claude-orchestrator`
const LISTS = `${MODULE}/todo`
const NOW = new Date('2026-11-14T15:00:00Z')
const SAID = '2026-11-14T14:58:00Z'

const row = (role: string, name: string) =>
  JSON.stringify({ role, name, repo: null, context_percent: 1, context_tokens: 1, window: 100, model: 'm', busy: false, updated_at: new Date().toISOString() })

type Options = { me?: [role: string, name: string]; send?: (args: { to: unknown; text: string }) => { isDelivered: true } | { isDelivered: false; reason: string }; files?: Record<string, string>; unreadable?: string[]; launchName?: string | null }

function world(options: Options = {}) {
  const [role, name] = options.me ?? ['orchestrator', 'Orch: billing [ref-1]']
  const files = new Map<string, string>([
    [`${MODULE}/store/sessions/s-me`, row(role, name)],
    [`${MODULE}/store/sessions/s-coord`, row('coordinator', 'Coord: general')],
    ...Object.entries(options.files ?? {}),
  ])
  const sent: { to: unknown; text: string }[] = []
  const writes: string[] = []
  const logs: string[] = []
  const dollar = hostOf({
    plugin: { root: '/plugins/orch' },
    env: { get: async (key: string) => (key === 'HOME' ? HOME : key === 'ORCHESTRATOR_HOST_CLI' ? 'hostcli' : undefined) },
    session: {
      id: async () => 's-me',
      send: async (args: { to: unknown; text: string }) => {
        sent.push(args)
        return (options.send ?? (() => ({ isDelivered: true as const })))(args)
      },
    },
    clock: { sleep: async () => undefined },
    fs: {
      read: async (p: string) => {
        if (options.unreadable?.includes(p)) throw new Error('EIO: i/o error, read')
        if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)!
      },
      write: async (p: string, text: string) => { files.set(p, text) },
      stat: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return { kind: 'file' as const, size: 1, mtimeMs: NOW.getTime() } },
      exists: async (p: string) => files.has(p),
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: 1, isLink: false })),
    },
    process: {
      run: async (argv: readonly string[]) => {
        const log = logLineOf(argv)
        if (log !== null) { logs.push(log); return { exitCode: 0, stdout: '', stderr: '' } }
        const lock = lockRun(argv, files)
        if (lock !== null) return lock
        // The walk of the session's own name: its tty, then the host process on it, named by its launch.
        if (argv[0] === 'sh' && String(argv[2]).startsWith('ps -o ppid=')) return { exitCode: 0, stdout: '1 ttys001\n', stderr: '' }
        if (argv[0] === 'sh' && String(argv[2]).startsWith('command -v')) return { exitCode: 1, stdout: '', stderr: '' }
        if (argv[0] === 'ps' && argv[1] === '-t') return { exitCode: 0, stdout: options.launchName ? `  501 hostcli --name ${options.launchName}\n` : '  501 hostcli\n', stderr: '' }
        if (argv[0] === 'mv') { writes.push(argv[3]!); files.set(argv[3]!, files.get(argv[2]!)!); files.delete(argv[2]!) }
        if (argv[0] === 'rm') for (const p of argv.slice(2)) files.delete(p)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  })
  return { dollar, files, sent, writes, logs }
}

// An add names who takes it: the tests that read something else give it to an agent.
const TAKER = { agent: 'Agent: takes-it [9]' }
const bare = (dollar: World, input: Record<string, unknown>) => callTodo(dollar, { tool: `mcp__orchestrator__${TODO_TOOL}`, ...input }, NOW)
const call = (dollar: World, input: Record<string, unknown>) =>
  bare(dollar, input['action'] === 'add' && !TODO_OWNER_FIELDS.some(field => field in input) ? { ...TAKER, ...input } : input)
const listOf = (files: Map<string, string>, name: string) => todoItems(files.get(`${LISTS}/${name}.jsonl`) ?? '')

test('add records his words, dated, in the caller\'s own list, named for the session without its reference', async () => {
  const { dollar, files, sent, writes } = world()
  const answered = await call(dollar, { action: 'add', words: 'merge acme/app#46 once ready', said_at: SAID })
  expect(answered.isError).toBe(undefined)
  expect(answered.result).toContain('1')
  const items = listOf(files, 'Orch: billing')
  expect(items.map(item => [item.id, item.state, item.words, item.said_at, item.from])).toEqual([[1, 'open', 'merge acme/app#46 once ready', SAID, 'Orch: billing']])
  expect(items[0]?.opened).toBe('2026-11-14T15:00:00Z')
  // The write is one rename under the store's lock, and the lock is gone.
  expect(writes).toEqual([`${LISTS}/Orch: billing.jsonl`])
  expect([...files.keys()].filter(path => path.endsWith('.lock'))).toEqual([])
  expect(sent).toEqual([])
  const second = await call(dollar, { action: 'add', words: 'another', label: 'the other' })
  expect(second.isError).toBe(undefined)
  expect(listOf(files, 'Orch: billing').map(item => [item.id, item.label, item.said_at])).toEqual([[1, 'merge acme/app#46 once ready', SAID], [2, 'the other', '2026-11-14T15:00:00Z']])
})

test('add keeps the images he gave, lists them, and refuses what is no list of absolute paths', async () => {
  const { dollar, files } = world()
  expect((await call(dollar, { action: 'add', words: 'this screen is wrong', said_at: SAID, images: ['/tmp/shots/a.png'] })).isError).toBe(undefined)
  expect(listOf(files, 'Orch: billing').map(item => item.images)).toEqual([['/tmp/shots/a.png']])
  expect((await call(dollar, { action: 'list' })).result).toContain('images: /tmp/shots/a.png')
  const refused = await call(dollar, { action: 'add', words: 'x', images: ['a.png'] })
  expect(refused.isError).toBe(true)
  expect(listOf(files, 'Orch: billing').length).toBe(1)
})

test('add with to writes the recipient\'s list first, then sends the message the module drafts, in the same call', async () => {
  const order: string[] = []
  const { dollar, files, sent } = world({
    send: () => { order.push(`sent while the list holds ${listOf(files, 'Coord: general').length} item`); return { isDelivered: true } },
  })
  const answered = await call(dollar, { action: 'add', words: 'run the audit', said_at: SAID, to: 'Coord: general [ref-2]' })
  expect(answered.isError).toBe(undefined)
  expect(order).toEqual(['sent while the list holds 1 item'])
  expect(listOf(files, 'Coord: general').map(item => [item.id, item.words, item.from])).toEqual([[1, 'run the audit', 'Orch: billing']])
  expect(listOf(files, 'Orch: billing')).toEqual([])
  expect(sent.map(message => message.to)).toEqual(['Coord: general [ref-2]'])
  const text = sent[0]?.text ?? ''
  for (const part of ['run the audit', SAID, 'Orch: billing', '2026-11-14T15:00:00Z']) expect(text).toContain(part)
  expect(text).toContain('To-do 1')
})

test('a send that fails leaves the item written, and the answer says so', async () => {
  const { dollar, files } = world({ send: () => ({ isDelivered: false, reason: 'no such session' }) })
  const answered = await call(dollar, { action: 'add', words: 'tell him', to: 'Coord: general' })
  expect(answered.isError).toBe(true)
  expect(answered.result).toContain('Recorded as to-do 1')
  expect(answered.result).toContain('not sent')
  expect(answered.result).toContain('no such session')
  expect(listOf(files, 'Coord: general')).toHaveLength(1)
})

test('a list that cannot be read is left byte for byte as it is: no add writes over it', async () => {
  const path = `${LISTS}/Orch: billing.jsonl`
  const before = '{"v":1,"id":1,"opened":"2026-11-14T14:00:00Z","label":"keep","state":"open","verdict":"","words":"keep","said_at":"2026-11-14T13:59:00Z","from":"Orch: billing"}\n'
  const { dollar, files, writes, logs } = world({ files: { [path]: before }, unreadable: [path] })
  const answered = await call(dollar, { action: 'add', words: 'a new request' })
  expect(answered.isError).toBe(true)
  expect(answered.result).toContain('EIO')
  expect(files.get(path)).toBe(before)
  expect(writes).toEqual([])
  expect([...files.keys()].filter(file => file.endsWith('.lock'))).toEqual([])
  expect(logs.some(line => line.includes('EIO'))).toBe(true)
  for (const input of [{ action: 'done', id: 1, outcome: 'x' }, { action: 'defer', id: 1, words: 'later' }]) {
    expect((await call(dollar, input)).isError).toBe(true)
    expect(files.get(path)).toBe(before)
  }
})

test('an absent list is an empty one: the first add starts it', async () => {
  const { dollar, files } = world()
  expect(files.has(`${LISTS}/Orch: billing.jsonl`)).toBe(false)
  expect((await call(dollar, { action: 'add', words: 'first' })).isError).toBe(undefined)
  expect(listOf(files, 'Orch: billing')).toHaveLength(1)
})

test('a send that throws after the write leaves one item and says it was recorded, so no retry duplicates it', async () => {
  const { dollar, files } = world({ send: () => { throw new Error('the session is gone') } })
  const answered = await call(dollar, { action: 'add', words: 'tell him', to: 'Coord: general' })
  expect(answered.isError).toBe(true)
  expect(answered.result).toBe('Recorded as to-do 1 in the list of Coord: general; the send failed: the session is gone')
  expect(listOf(files, 'Coord: general')).toHaveLength(1)
})

test('add to the caller\'s own name records once and sends nothing', async () => {
  const { dollar, files, sent } = world()
  const answered = await call(dollar, { action: 'add', words: 'mine', to: 'Orch: billing [ref-1]' })
  expect(answered.isError).toBe(undefined)
  expect(listOf(files, 'Orch: billing')).toHaveLength(1)
  expect(sent).toEqual([])
})

test('add to a session on another machine sends the message and says it is not recorded there', async () => {
  const remote = JSON.stringify({ name: 'Orch: elsewhere', role: 'orchestrator', context_tokens: 1, context_percent: 1, window: 100, waiting: null, blocks: null, waiting_since: null, updated_at: new Date().toISOString(), machine: 'iznoserver', repo: null, prs: [], held: null })
  const { dollar, files, sent } = world({ files: { [`${MODULE}/store/remote/Orch__elsewhere`]: remote } })
  const answered = await call(dollar, { action: 'add', words: 'rebase it', said_at: SAID, to: 'Orch: elsewhere [ref-3]' })
  expect(answered.isError).toBe(undefined)
  expect(answered.result).toContain('not recorded there')
  expect(sent.map(message => message.to)).toEqual(['Orch: elsewhere [ref-3]'])
  expect(sent[0]?.text).toContain('rebase it')
  expect([...files.keys()].filter(path => path.startsWith(LISTS))).toEqual([])
})

test('add to a coordinator whose address a peer taught, on another machine, is also only sent', async () => {
  const learnt = JSON.stringify({ name: 'Coord: far', from: 'bridge:session_01', at: 'T' })
  const { dollar, files, sent } = world({ files: { [`${MODULE}/store/coordinator-learnt`]: learnt + '\n' } })
  const answered = await call(dollar, { action: 'add', words: 'look', to: 'Coord: far' })
  expect(answered.result).toContain('not recorded there')
  expect(sent).toHaveLength(1)
  expect([...files.keys()].filter(path => path.startsWith(LISTS))).toEqual([])
})

test('done closes an item with its outcome; drop and defer take his words; list shows what is open', async () => {
  const { dollar, files } = world()
  for (const words of ['one', 'two', 'three', 'four']) await call(dollar, { action: 'add', words })
  expect((await call(dollar, { action: 'done', id: 1, outcome: 'row 170' })).isError).toBe(undefined)
  expect((await call(dollar, { action: 'drop', id: 2, words: 'forget it, he said, 2026-11-14' })).isError).toBe(undefined)
  expect((await call(dollar, { action: 'defer', id: 3, words: 'after the release, 2026-11-14' })).isError).toBe(undefined)
  const items = listOf(files, 'Orch: billing')
  expect(items.map(item => [item.id, item.state, item.verdict, item.deferred ?? ''])).toEqual([
    [1, 'closed', 'row 170', ''],
    [2, 'closed', 'dropped: forget it, he said, 2026-11-14', ''],
    [3, 'open', '', 'after the release, 2026-11-14'],
    [4, 'open', '', ''],
  ])
  const listed = await call(dollar, { action: 'list' })
  expect(listed.isError).toBe(undefined)
  expect(listed.result).toContain('3 (three)')
  expect(listed.result).toContain('after the release, 2026-11-14')
  expect(listed.result).toContain('4 (four)')
  expect(listed.result).not.toContain('(one)')
  expect((await call(dollar, { action: 'done', id: 1, outcome: 'again' })).result).toContain('already closed')
  expect((await call(dollar, { action: 'done', id: 9, outcome: 'x' })).isError).toBe(true)
})

test('row names the dispatch rows an item turned into, each once, and keeps it open; a closed item or a bad row is refused', async () => {
  const { dollar, files } = world()
  await call(dollar, { action: 'add', words: 'ship the blocker field' })
  await call(dollar, { action: 'add', words: 'done already' })
  expect((await call(dollar, { action: 'row', id: 1, row: 205 })).result).toContain('rows 205')
  expect((await call(dollar, { action: 'row', id: 1, row: 204 })).result).toContain('rows 204, 205')
  expect((await call(dollar, { action: 'row', id: 1, row: 204 })).result).toContain('rows 204, 205')
  expect((await call(dollar, { action: 'row', id: 1, row: 0 })).isError).toBe(true)
  expect((await call(dollar, { action: 'row', id: 1 })).isError).toBe(true)
  await call(dollar, { action: 'done', id: 2, outcome: 'acme/app#1' })
  expect((await call(dollar, { action: 'row', id: 2, row: 3 })).result).toContain('already closed')
  const [one] = listOf(files, 'Orch: billing')
  expect([one?.state, one?.rows]).toEqual(['open', [204, 205]])
  expect((await call(dollar, { action: 'list' })).result).toContain(', rows 204, 205')
})

test('an empty list says so', async () => {
  const { dollar } = world()
  expect((await call(dollar, { action: 'list' })).result).toContain('no open to-do')
})

test('each action refuses an input that leaves out what it needs', async () => {
  const { dollar, files } = world()
  const refused = async (input: Record<string, unknown>) => (await call(dollar, input)).isError
  expect(await refused({})).toBe(true)
  expect(await refused({ action: 'wish' })).toBe(true)
  expect(await refused({ action: 'add' })).toBe(true)
  expect(await refused({ action: 'add', words: '  ' })).toBe(true)
  expect(await refused({ action: 'add', words: 'x', to: '' })).toBe(true)
  expect(await refused({ action: 'done', id: 1 })).toBe(true)
  expect(await refused({ action: 'done', outcome: 'x' })).toBe(true)
  expect(await refused({ action: 'drop', id: 1 })).toBe(true)
  expect(await refused({ action: 'defer', id: 1 })).toBe(true)
  expect(await refused({ action: 'done', id: '1', outcome: 'x' })).toBe(true)
  expect([...files.keys()].filter(path => path.startsWith(LISTS))).toEqual([])
})

test('only an orchestrator, a coordinator or an auditor keeps a list: an agent, a session of no name, or a subagent does not', async () => {
  for (const me of [['agent', 'Agent: seven [1]'], ['orchestrator', ''], ['coordinator', 'Coord: general [1]'], ['auditor', 'Audit: todo [2]']] as const) {
    const { dollar, files } = world({ me: [me[0], me[1]] })
    const answered = await call(dollar, { action: 'add', words: 'x' })
    const keeps = me[1] !== '' && me[0] !== 'agent'
    expect(answered.isError).toBe(keeps ? undefined : true)
    expect([...files.keys()].some(path => path.startsWith(LISTS))).toBe(keeps)
  }
  const { dollar } = world()
  const tool = hooksOn(capture<World>(registerTodo), 'tool.call').at(-1)!.handler
  const sub = await tool(dollar, { tool: `mcp__orchestrator__${TODO_TOOL}`, action: 'list', agentId: 'a-1' }, async () => undefined) as Out
  expect(sub.isError).toBe(true)
})

test('the tool is registered loaded, not deferred, with flat fields', async () => {
  const registrations: ToolSpec[] = []
  const start = hooksOn(capture<World>(registerTodo), 'session.start').at(-1)!.handler
  const partial = hostOf({ tool: { register: async (spec: ToolSpec) => { registrations.push(spec) } }, plugin: { root: '/p' }, env: { get: async () => undefined }, process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) } })
  await start(partial, { cwd: '/w' }, async (e: unknown) => e)
  expect(registrations).toHaveLength(1)
  expect(registrations[0]?.name).toBe(TODO_TOOL)
  expect(registrations[0]?.isDeferred).toBe(false)
  expect(Object.keys(fieldsOf(registrations[0]?.inputSchema?.['properties']) ?? {})).toEqual(['action', 'words', 'said_at', 'to', 'label', 'images', 'id', 'outcome', 'row', 'agent', 'waits_on', 'why', 'until', 'deadline'])
  expect(registrations[0]?.inputSchema?.['required']).toEqual(['action'])
})

// What the session start registers, over a world: the tools the module declares to this session.
async function registeredAt(dollar: World): Promise<string[]> {
  const names: string[] = []
  const start = hooksOn(capture<World>(registerTodo), 'session.start').at(-1)!.handler
  dollar.tool.register = async (spec: { name: string }) => { names.push(spec.name) }
  await start(dollar, { cwd: '/w' }, async (e: unknown) => e)
  return names
}

test('an agent carries no todo tool: it is not registered for a session whose row names an agent', async () => {
  expect(await registeredAt(world({ me: ['agent', 'Agent: belt-p3 [1]'] }).dollar)).toEqual([])
})

test('an agent carries no todo tool: nor for one whose row is not written yet but whose launch name is an agent\'s', async () => {
  const { dollar, files } = world({ launchName: 'Agent: belt-p3' })
  files.delete(`${MODULE}/store/sessions/s-me`)
  expect(await registeredAt(dollar)).toEqual([])
})

test('an orchestrator, a coordinator, an auditor and a session of no known role carry the todo tool', async () => {
  for (const me of [['orchestrator', 'Orch: billing [1]'], ['coordinator', 'Coord: general [1]'], ['auditor', 'Audit: todo [2]']] as const) {
    expect(await registeredAt(world({ me: [me[0], me[1]] }).dollar)).toEqual([TODO_TOOL])
  }
  const { dollar, files } = world()
  files.delete(`${MODULE}/store/sessions/s-me`)
  expect(await registeredAt(dollar)).toEqual([TODO_TOOL])
})

function declarer() {
  const declarations = new Declarations()
  const tool = hooksOn(capture<World>(on => registerWait(on, declarations)), 'tool.call').at(-1)!.handler
  return { declarations, declare: async (dollar: World, input: object) => await tool(dollar, { tool: `mcp__orchestrator__${WAIT_TOOL}`, ...input }, async () => undefined) as Out }
}

test('declare_wait refuses done while an item is open, and deferred while one he did not put off is, naming each', async () => {
  const { declare, declarations } = declarer()
  const { dollar } = world()
  expect((await declare(dollar, { kind: 'done' })).isError).toBe(undefined)
  await call(dollar, { action: 'add', words: 'ship it' })
  const done = await declare(dollar, { kind: 'done' })
  expect(done.isError).toBe(true)
  expect(done.result).toContain('to-do 1 (ship it) is open')
  const deferred = await declare(dollar, { kind: 'deferred', blocks: '1 items' })
  expect(deferred.isError).toBe(true)
  expect(deferred.result).toContain('1 (ship it)')
})

test('an item he put off holds a done but takes a deferred wait; a closed one holds nothing', async () => {
  const { declare } = declarer()
  const { dollar } = world()
  await call(dollar, { action: 'add', words: 'later' })
  await call(dollar, { action: 'defer', id: 1, words: 'after the release, 2026-11-14' })
  expect((await declare(dollar, { kind: 'done' })).isError).toBe(true)
  expect((await declare(dollar, { kind: 'deferred', blocks: '1 items' })).isError).toBe(undefined)
  await call(dollar, { action: 'done', id: 1, outcome: 'acme/app#230' })
  expect((await declare(dollar, { kind: 'done' })).isError).toBe(undefined)
})

test('a coordinator or an auditor with an open item is held the same; an agent, which keeps no list, is not', async () => {
  for (const [role, name, held] of [['coordinator', 'Coord: general [1]', true], ['auditor', 'Audit: todo [2]', true], ['agent', 'Agent: seven [3]', false]] as const) {
    const { declare } = declarer()
    const { dollar } = world({ me: [role, name] })
    if (held) await call(dollar, { action: 'add', words: 'an order' })
    expect((await declare(dollar, { kind: 'done' })).isError).toBe(held ? true : undefined)
  }
})

// The orchestrator's dispatch record, registered under its session: one row per entry, open unless closed.
const RECORD = '/w/docs/dispatch.jsonl'
const recorded = (rows: readonly Record<string, unknown>[]) => ({
  [`${MODULE}/records/s-me`]: `${RECORD}\n`,
  [RECORD]: rows.map(r => JSON.stringify({ rounds: 0, ...r })).join('\n'),
})

test('declare_wait refuses done while the dispatch record holds an open row, naming it, and says to declare nothing for an agent', async () => {
  const { declare } = declarer()
  const { dollar } = world({ files: recorded([{ id: 51, label: 'merged', state: 'closed' }, { id: 52, label: 'rotation', state: 'open' }]) })
  const done = await declare(dollar, { kind: 'done' })
  expect(done.isError).toBe(true)
  expect(done.result).toContain('row 52 (rotation) is open')
  expect(done.result).toContain('declare nothing')
})

test('declare_wait refuses done while a goal of the spec is open, naming it', async () => {
  const { declare } = declarer()
  const { dollar, files } = world({ files: recorded([{ id: 1, label: 'p1', state: 'closed' }]) })
  files.set('/w/docs/goals.md', '# goals')
  const goals = JSON.stringify({ ok: false, open: ['G3'], deferred: [], faults: [], notes: [] })
  const run = dollar.process.run
  const answering = hostOf({ ...dollar, process: { run: async (argv: readonly string[]) => (String(argv[1]).endsWith('goals.sh') ? { exitCode: 1, stdout: goals, stderr: '' } : run(argv)) } })
  const done = await declare(answering, { kind: 'done' })
  expect(done.isError).toBe(true)
  expect(done.result).toContain('G3 open')
})

test('declare_wait refuses deferred when the operator put nothing off: waiting on an agent is no deferral', async () => {
  const { declare } = declarer()
  const { dollar } = world({ files: recorded([{ id: 52, label: 'rotation', state: 'open' }]) })
  const deferred = await declare(dollar, { kind: 'deferred', blocks: '4 items: row 52 rotation reply pending' })
  expect(deferred.isError).toBe(true)
  expect(deferred.result).toContain('row 52 (rotation) is open')
  expect(deferred.result).toContain('declare nothing')
  const none = await declare(world().dollar, { kind: 'deferred', blocks: '1 items' })
  expect(none.isError).toBe(true)
  expect(none.result).toContain('Nothing is deferred')
})

test('declare_wait takes deferred when the count matches the rows and to-dos he put off, and refuses a wrong count', async () => {
  const { declare } = declarer()
  const { dollar } = world({ files: recorded([{ id: 52, label: 'rotation', state: 'open', deferred: 'after the release, 2026-11-15' }]) })
  await call(dollar, { action: 'add', words: 'later' })
  await call(dollar, { action: 'defer', id: 1, words: 'after the release, 2026-11-14' })
  const wrong = await declare(dollar, { kind: 'deferred', blocks: '1 items' })
  expect(wrong.isError).toBe(true)
  expect(wrong.result).toContain('the right count is 2 items')
  expect((await declare(dollar, { kind: 'deferred', blocks: '2 items' })).isError).toBe(undefined)
  expect((await declare(dollar, { kind: 'done' })).isError).toBe(true)
})

test('the dispatch record holds no coordinator\'s done: only an orchestrator\'s records are read', async () => {
  const { declare } = declarer()
  const { dollar } = world({ me: ['coordinator', 'Coord: general [1]'], files: recorded([{ id: 52, label: 'rotation', state: 'open' }]) })
  expect((await declare(dollar, { kind: 'done' })).isError).toBe(undefined)
})

function ender() {
  const handlers: Record<string, Hook<World, Events['command.run']>> = {}
  for (const hook of hooksOn(capture<World>(registerEnd), 'command.run')) handlers[String(hook.matcher?.['command'])] = hook.handler
  const run = async (dollar: World, command = 'orchestrator:coordinator-end') => await handlers[command]!(dollar, { command, args: '' }, async (e: unknown) => ({ passed: e })) as Out
  return { handlers, run }
}

test('/coordinator-end with open to-dos ends all the same: the open items in the log, one escape in the journal', async () => {
  const { run, handlers } = ender()
  expect(Object.keys(handlers).sort()).toEqual(['coordinator-end', 'orchestrator:coordinator-end'])
  const { dollar, files, logs } = world({ me: ['coordinator', 'Coord: general [ref-2]'] })
  const escapes = () => [...files.entries()].filter(([p]) => p.includes('/.claude/orchestrator/journal/')).map(([, text]) => JSON.parse(text)).map(e => `${e.kind} ${e.source.code}`)
  expect(await run(dollar)).toEqual({ passed: { command: 'orchestrator:coordinator-end', args: '' } })
  expect(escapes()).toEqual([])
  await call(dollar, { action: 'add', words: 'relay the order to the billing orchestrator', said_at: SAID })
  await call(dollar, { action: 'add', words: 'ask for the numbers' })
  await call(dollar, { action: 'add', words: 'check the release later' })
  await call(dollar, { action: 'defer', id: 3, words: 'after the release, 2026-11-14' })
  expect(await run(dollar)).toEqual({ passed: { command: 'orchestrator:coordinator-end', args: '' } })
  expect(escapes()).toEqual(['escape orchestrator.coordinator-end.todo-open'])
  expect(logs.some(line => line.includes('coordinator-end let through with 2 to-do open'))).toBe(true)
})

test('/coordinator-end from another session than the coordinator runs as it always did', async () => {
  const { run } = ender()
  const { dollar } = world()
  await call(dollar, { action: 'add', words: 'mine' })
  expect((await run(dollar)).passed).toBeDefined()
})

test('status shows each session\'s open to-do count beside its row, and nothing for a session with none', async () => {
  const sessions: Record<string, SessionRow> = {
    'sessions/a': { role: 'orchestrator', name: 'Orch: billing [ref-1]', repo: null, context_percent: 5, context_tokens: 1, window: 100, model: 'm', busy: false, updated_at: new Date().toISOString() },
    'sessions/b': { role: 'coordinator', name: 'Coord: general', repo: null, context_percent: 4, context_tokens: 1, window: 100, model: 'm', busy: false, updated_at: new Date().toISOString() },
  }
  const { dollar } = world()
  await call(dollar, { action: 'add', words: 'one' })
  await call(dollar, { action: 'add', words: 'two' })
  await call(dollar, { action: 'add', words: 'three' })
  await call(dollar, { action: 'done', id: 1, outcome: 'x' })
  const counts = await todoCounts(dollar)
  const lines = statusText(sessions, counts).split('\n')
  expect(lines.find(line => line.includes('Orch: billing'))).toContain('2 to-dos')
  expect(lines.find(line => line.includes('Coord: general'))).not.toContain('to-do')
  expect(statusText(sessions)).not.toContain('to-do')
})

// --- no to-do left aside: who takes it, or what it waits on and until when --------------------------

const WAIT = { waits_on: 'acme/app#46 merged', why: 'the port needs its fix', until: '2026-11-15T09:00:00Z', deadline: '2026-11-17T18:00:00Z' }

test('add refuses an item that names neither who takes it nor what it waits on, and writes nothing', async () => {
  const { dollar, files } = world()
  const refused = await bare(dollar, { action: 'add', words: 'port the fix' })
  expect(refused.isError).toBe(true)
  expect(refused.result).toContain('who takes it')
  for (const input of [
    { waits_on: 'x', why: 'y', until: '2026-11-15T09:00:00Z' },
    { ...WAIT, until: 'tomorrow' },
    { ...WAIT, until: '2026-11-15T09:00:00' },
    { ...WAIT, deadline: 'Nov 20 2026' },
    { ...WAIT, deadline: '2026-11-15T08:00:00Z' },
    { row: 0 },
    { agent: '  ' },
    { agent: 'Orch: billing [ref-7]' },
  ]) expect((await bare(dollar, { action: 'add', words: 'port the fix', ...input })).isError).toBe(true)
  expect([...files.keys()].filter(path => path.startsWith(LISTS))).toEqual([])
})

test('add keeps the row or the agent that takes it, or the wait, its dates as UTC instants; list shows them', async () => {
  const { dollar, files } = world()
  expect((await bare(dollar, { action: 'add', words: 'one', row: 339 })).isError).toBe(undefined)
  expect((await bare(dollar, { action: 'add', words: 'two', agent: 'Agent: belt-p3 [2]' })).isError).toBe(undefined)
  expect((await bare(dollar, { action: 'add', words: 'three', ...WAIT, until: '2026-11-15T10:00:00+01:00' })).isError).toBe(undefined)
  const items = listOf(files, 'Orch: billing')
  expect(items.map(item => [item.rows, item.agent, item.waits])).toEqual([
    [[339], undefined, undefined],
    [undefined, 'Agent: belt-p3 [2]', undefined],
    [undefined, undefined, { on: WAIT.waits_on, why: WAIT.why, until: '2026-11-15T09:00:00Z', deadline: WAIT.deadline }],
  ])
  const listed = String((await bare(dollar, { action: 'list' })).result)
  for (const part of ['rows 339', 'taken by Agent: belt-p3 [2]', `waits on ${WAIT.waits_on} (${WAIT.why}) until 2026-11-15T09:00:00Z, deadline ${WAIT.deadline}`]) expect(listed).toContain(part)
})

test('add to another session records the owner in its list', async () => {
  const { dollar, files } = world()
  expect((await bare(dollar, { action: 'add', words: 'run the audit', to: 'Coord: general', ...WAIT })).isError).toBe(undefined)
  expect(listOf(files, 'Coord: general').map(item => item.waits?.on)).toEqual([WAIT.waits_on])
  expect((await bare(dollar, { action: 'add', words: 'yours', to: 'Coord: general', agent: 'Coord: general [ref-2]' })).isError).toBe(true)
  expect((await bare(dollar, { action: 'add', words: 'no owner', to: 'Coord: general' })).isError).toBe(true)
  expect(listOf(files, 'Coord: general')).toHaveLength(1)
})

// A world whose clock and prompt the surfacing reads: the prompts it was given, and a submit that may drop.
function surfacing(drop = false) {
  const made = world()
  const prompts: string[] = []
  made.dollar.prompt.submit = async ({ text }: { text: string }) => { prompts.push(text); return drop ? { drop: 'busy' } : undefined }
  return { ...made, prompts }
}

test('the module surfaces an item when its wait ends, once, then again when its deadline passes; closed, owned or early items are not', async () => {
  const { dollar, files, prompts } = surfacing()
  await bare(dollar, { action: 'add', words: 'port the fix', ...WAIT })
  await bare(dollar, { action: 'add', words: 'owned', row: 12 })
  await bare(dollar, { action: 'add', words: 'closed one', ...WAIT })
  await bare(dollar, { action: 'done', id: 3, outcome: 'acme/app#47' })
  expect(await surfaceDue(dollar, 'Orch: billing [ref-1]', Date.parse('2026-11-15T08:59:59Z'))).toEqual([])
  const at = Date.parse('2026-11-15T09:00:00Z')
  expect((await surfaceDue(dollar, 'Orch: billing [ref-1]', at)).map(due => [due.item.id, due.date])).toEqual([[1, 'until']])
  expect(prompts).toHaveLength(1)
  for (const part of ['[module]', 'to-do 1 (port the fix)', WAIT.waits_on, 'its wait ended at 2026-11-15T09:00:00Z', 'todo wait']) expect(prompts[0]).toContain(part)
  expect(listOf(files, 'Orch: billing')[0]?.surfaced).toEqual(['until'])
  expect(await surfaceDue(dollar, 'Orch: billing [ref-1]', at + SURFACE_TICK_MS)).toEqual([])
  expect((await surfaceDue(dollar, 'Orch: billing [ref-1]', Date.parse(WAIT.deadline))).map(due => due.date)).toEqual(['deadline'])
  expect(prompts[1]).toContain(`its deadline ${WAIT.deadline} passed`)
  expect(await surfaceDue(dollar, 'Orch: billing [ref-1]', Date.parse(WAIT.deadline) + 1)).toEqual([])
})

test('an item whose two dates passed unseen is told once, for its deadline', async () => {
  const { dollar, files, prompts } = surfacing()
  await bare(dollar, { action: 'add', words: 'port the fix', ...WAIT })
  expect((await surfaceDue(dollar, 'Orch: billing', Date.parse('2026-11-18T00:00:00Z'))).map(due => due.date)).toEqual(['deadline'])
  expect(listOf(files, 'Orch: billing')[0]?.surfaced).toEqual(['until', 'deadline'])
  expect(prompts).toHaveLength(1)
})

test('a wake the host drops marks nothing: the item is told again at the next reading', async () => {
  const { dollar, files, prompts } = surfacing(true)
  await bare(dollar, { action: 'add', words: 'port the fix', ...WAIT })
  await expect(surfaceDue(dollar, 'Orch: billing', Date.parse('2026-11-15T10:00:00Z'))).rejects.toThrow('dropped')
  expect(listOf(files, 'Orch: billing')[0]?.surfaced).toBe(undefined)
  expect(prompts).toHaveLength(1)
})

test('an item whose wait is set anew while it is told is not marked for the new wait: it is told again', async () => {
  const { dollar, files, prompts } = surfacing()
  await bare(dollar, { action: 'add', words: 'port the fix', ...WAIT })
  dollar.prompt.submit = async ({ text }: { text: string }) => {
    prompts.push(text)
    await bare(dollar, { action: 'wait', id: 1, ...WAIT, until: '2026-11-15T09:30:00Z' })
    return undefined
  }
  await surfaceDue(dollar, 'Orch: billing', Date.parse('2026-11-15T10:00:00Z'))
  expect(listOf(files, 'Orch: billing')[0]?.surfaced).toBe(undefined)
  expect((await surfaceDue(dollar, 'Orch: billing', Date.parse('2026-11-15T10:00:00Z'))).map(due => due.item.waits?.until)).toEqual(['2026-11-15T09:30:00Z'])
})

test('wait sets a new wait on an open item and starts its surfacing over; a closed item or a partial wait is refused', async () => {
  const { dollar, files } = surfacing()
  await bare(dollar, { action: 'add', words: 'port the fix', ...WAIT })
  await surfaceDue(dollar, 'Orch: billing', Date.parse('2026-11-15T10:00:00Z'))
  const again = await bare(dollar, { action: 'wait', id: 1, ...WAIT, until: '2026-11-16T09:00:00Z' })
  expect(again.isError).toBe(undefined)
  expect(again.result).toContain('until 2026-11-16T09:00:00Z')
  const [one] = listOf(files, 'Orch: billing')
  expect([one?.waits?.until, one?.surfaced]).toEqual(['2026-11-16T09:00:00Z', undefined])
  expect((await bare(dollar, { action: 'wait', id: 1 })).isError).toBe(true)
  expect((await bare(dollar, { action: 'wait', id: 1, waits_on: 'x' })).isError).toBe(true)
  await bare(dollar, { action: 'done', id: 1, outcome: 'row 3' })
  expect((await bare(dollar, { action: 'wait', id: 1, ...WAIT })).result).toContain('already closed')
})

test('the reading is armed at a keeper\'s turn end, once per session, read at once; an agent\'s turn end arms none', async () => {
  const turnEnd = hooksOn(capture<World>(registerSurface), 'turn.complete').at(-1)!.handler
  const { dollar, prompts } = surfacing()
  await bare(dollar, { action: 'add', words: 'port the fix', ...WAIT, until: '2026-11-01T09:00:00Z' })
  const every: number[] = []
  dollar.clock.every = (ms: number) => { every.push(ms); return { cancel: () => undefined } }
  await turnEnd(dollar, {}, async () => undefined)
  await turnEnd(dollar, {}, async () => undefined)
  expect(every).toEqual([SURFACE_TICK_MS])
  expect(prompts).toHaveLength(1)
  const agent = world({ me: ['agent', 'Agent: seven [1]'] }).dollar
  const armed: number[] = []
  agent.clock.every = (ms: number) => { armed.push(ms); return { cancel: () => undefined } }
  await hooksOn(capture<World>(registerSurface), 'turn.complete').at(-1)!.handler(agent, {}, async () => undefined)
  expect(armed).toEqual([])
})
