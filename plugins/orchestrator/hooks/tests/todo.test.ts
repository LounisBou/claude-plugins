// hooks/tests/todo.test.ts
// The `todo` tool over a faked $: a request recorded in the holder's own list, written by the module
// alone under the store's lock; a request for another session written into that session's list first
// and sent after, in one call; one for a session on another machine only sent, and said not recorded.
import { expect, test } from 'claude-code/testing'
import { TODO_TOOL, callTodo, register as registerTodo } from '../todo.ts'
import { todoItems } from '../../core/todo.ts'
import { logLineOf, lockRun } from './fakes.ts'

const HOME = '/tmp/todo-home'
const MODULE = `${HOME}/.claude/claude-orchestrator`
const LISTS = `${MODULE}/todo`
const NOW = new Date('2026-11-14T15:00:00Z')
const SAID = '2026-11-14T14:58:00Z'

const row = (role: string, name: string) =>
  JSON.stringify({ role, name, repo: null, context_percent: 1, context_tokens: 1, window: 100, model: 'm', busy: false, updated_at: new Date().toISOString() })

type Options = { me?: [role: string, name: string]; send?: (args: { to: string; text: string }) => { isDelivered: boolean; reason?: string }; files?: Record<string, string> }

function world(options: Options = {}) {
  const [role, name] = options.me ?? ['orchestrator', 'Orch: Claude plugins [08eb0d]']
  const files = new Map<string, string>([
    [`${MODULE}/store/sessions/s-me`, row(role, name)],
    [`${MODULE}/store/sessions/s-coord`, row('coordinator', 'Coord: general')],
    ...Object.entries(options.files ?? {}),
  ])
  const sent: { to: string; text: string }[] = []
  const writes: string[] = []
  const logs: string[] = []
  const dollar: any = {
    plugin: { name: 'orchestrator', root: '/plugins/orch' },
    env: { get: async (key: string) => (key === 'HOME' ? HOME : undefined) },
    session: {
      id: async () => 's-me',
      send: async (args: { to: string; text: string }) => {
        sent.push(args)
        return (options.send ?? (() => ({ isDelivered: true })))(args)
      },
    },
    clock: { sleep: async () => undefined },
    fs: {
      read: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)! },
      write: async (p: string, text: string) => { files.set(p, text) },
      stat: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return { kind: 'file', size: 1, mtimeMs: NOW.getTime() } },
      exists: async (p: string) => files.has(p),
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file', size: 1, isLink: false })),
    },
    process: {
      run: async (argv: readonly string[]) => {
        const log = logLineOf(argv)
        if (log !== null) { logs.push(log); return { exitCode: 0, stdout: '', stderr: '' } }
        const lock = lockRun(argv, files)
        if (lock !== null) return lock
        if (argv[0] === 'mv') { writes.push(argv[3]); files.set(argv[3], files.get(argv[2])!); files.delete(argv[2]) }
        if (argv[0] === 'rm') for (const p of argv.slice(2)) files.delete(p)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  }
  return { dollar, files, sent, writes, logs }
}

const call = (dollar: any, input: Record<string, unknown>) => callTodo(dollar, { tool: `mcp__orchestrator__${TODO_TOOL}`, ...input }, NOW)
const listOf = (files: Map<string, string>, name: string) => todoItems(files.get(`${LISTS}/${name}.jsonl`) ?? '')

test('add records his words, dated, in the caller\'s own list, named for the session without its reference', async () => {
  const { dollar, files, sent, writes } = world()
  const answered = await call(dollar, { action: 'add', words: 'merge claude-code#46 once ready', said_at: SAID })
  expect(answered.isError).toBe(undefined)
  expect(answered.result).toContain('1')
  const items = listOf(files, 'Orch: Claude plugins')
  expect(items.map(item => [item.id, item.state, item.words, item.said_at, item.from])).toEqual([[1, 'open', 'merge claude-code#46 once ready', SAID, 'Orch: Claude plugins']])
  expect(items[0]?.opened).toBe('2026-11-14T15:00:00Z')
  // The write is one rename under the store's lock, and the lock is gone.
  expect(writes).toEqual([`${LISTS}/Orch: Claude plugins.jsonl`])
  expect([...files.keys()].filter(path => path.endsWith('.lock'))).toEqual([])
  expect(sent).toEqual([])
  const second = await call(dollar, { action: 'add', words: 'another', label: 'the other' })
  expect(second.isError).toBe(undefined)
  expect(listOf(files, 'Orch: Claude plugins').map(item => [item.id, item.label, item.said_at])).toEqual([[1, 'merge claude-code#46 once ready', SAID], [2, 'the other', '2026-11-14T15:00:00Z']])
})

test('add with to writes the recipient\'s list first, then sends the message the module drafts, in the same call', async () => {
  const order: string[] = []
  const { dollar, files, sent } = world({
    send: () => { order.push(`sent while the list holds ${listOf(files, 'Coord: general').length} item`); return { isDelivered: true } },
  })
  const answered = await call(dollar, { action: 'add', words: 'run the audit', said_at: SAID, to: 'Coord: general [7952fb]' })
  expect(answered.isError).toBe(undefined)
  expect(order).toEqual(['sent while the list holds 1 item'])
  expect(listOf(files, 'Coord: general').map(item => [item.id, item.words, item.from])).toEqual([[1, 'run the audit', 'Orch: Claude plugins']])
  expect(listOf(files, 'Orch: Claude plugins')).toEqual([])
  expect(sent.map(message => message.to)).toEqual(['Coord: general [7952fb]'])
  const text = sent[0]?.text ?? ''
  for (const part of ['run the audit', SAID, 'Orch: Claude plugins', '2026-11-14T15:00:00Z']) expect(text).toContain(part)
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

test('add to the caller\'s own name records once and sends nothing', async () => {
  const { dollar, files, sent } = world()
  const answered = await call(dollar, { action: 'add', words: 'mine', to: 'Orch: Claude plugins [08eb0d]' })
  expect(answered.isError).toBe(undefined)
  expect(listOf(files, 'Orch: Claude plugins')).toHaveLength(1)
  expect(sent).toEqual([])
})

test('add to a session on another machine sends the message and says it is not recorded there', async () => {
  const remote = JSON.stringify({ name: 'Orch: elsewhere', role: 'orchestrator', context_tokens: 1, context_percent: 1, window: 100, waiting: null, blocks: null, waiting_since: null, updated_at: new Date().toISOString(), machine: 'iznoserver', repo: null, prs: [], held: null })
  const { dollar, files, sent } = world({ files: { [`${MODULE}/store/remote/Orch__elsewhere`]: remote } })
  const answered = await call(dollar, { action: 'add', words: 'rebase it', said_at: SAID, to: 'Orch: elsewhere [abc123]' })
  expect(answered.isError).toBe(undefined)
  expect(answered.result).toContain('not recorded there')
  expect(sent.map(message => message.to)).toEqual(['Orch: elsewhere [abc123]'])
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
  const items = listOf(files, 'Orch: Claude plugins')
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
  const registered: Record<string, Function> = {}
  registerTodo((...args: any[]) => { registered[args[0]] = args[args.length - 1]; return { catch: () => undefined } })
  const sub = await registered['tool.call'](dollar, { tool: `mcp__orchestrator__${TODO_TOOL}`, action: 'list', agentId: 'a-1' })
  expect(sub.isError).toBe(true)
})

test('the tool is registered loaded, not deferred, with flat fields', async () => {
  const registrations: any[] = []
  const handlers: Record<string, Function> = {}
  registerTodo((...args: any[]) => { handlers[args[0]] = args[args.length - 1]; return { catch: () => undefined } })
  await handlers['session.start']({ tool: { register: async (spec: unknown) => { registrations.push(spec) } }, plugin: { root: '/p' }, env: { get: async () => undefined }, process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) } }, {}, (e: unknown) => e)
  expect(registrations).toHaveLength(1)
  expect(registrations[0].name).toBe(TODO_TOOL)
  expect(registrations[0].isDeferred).toBe(false)
  expect(Object.keys(registrations[0].inputSchema.properties)).toEqual(['action', 'words', 'said_at', 'to', 'label', 'id', 'outcome'])
  expect(registrations[0].inputSchema.required).toEqual(['action'])
})
