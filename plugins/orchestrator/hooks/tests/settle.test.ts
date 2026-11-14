// hooks/tests/settle.test.ts
// The `settle` tool over a faked $: a call validated, then the one closure of a round question —
// an object `ask` stored, closed by its asker or by the coordinator, its answer sent to its asker at
// once when another session settles it, its consent recorded, the work its answer asks recorded as a
// to-do of the asker; and the relay's entry closed by its own sender as the answered tool closed it.
import { expect, test } from 'claude-code/testing'
import { askTurnStarted, callAsk, settle, registerSettle } from '../question.ts'
import { parseSettle, type SettleRequest } from '../settle.ts'
import { todoPath } from '../todo-format.ts'
import { logLineOf, lockRun } from './fakes.ts'

const HOME = '/tmp/settle-home'
const MODULE = `${HOME}/.claude/claude-orchestrator`
const ROUND = `${MODULE}/round`
const SESSIONS = `${MODULE}/store/sessions`
const NOW = new Date('2026-11-14T15:00:00Z')
const ASKER = 'Orch: acme [a1b2c3]'
const COORD = 'Coord: general [d4e5f6]'

const row = (role: string, name: string) =>
  JSON.stringify({ role, name, repo: null, context_percent: 1, context_tokens: 1, window: 100, model: 'm', busy: false, updated_at: new Date().toISOString() })

const QUESTION = {
  subject: 'merge order of acme/app#1', context: 'Two pull requests touch one file.', question: 'Which one merges first?',
  choice_a: 'acme/app#1 first', choice_b: 'acme/app#2 first', recommended: 'A', why: 'no rebase', blocks: 'acme/app#1',
}

// One machine: the asker (s-ask) and the coordinator (s-coord) share the files; `as` picks whose $ it is.
function machine(options: { refuse?: string } = {}) {
  const files = new Map<string, string>([[`${SESSIONS}/s-ask`, row('orchestrator', ASKER)], [`${SESSIONS}/s-coord`, row('coordinator', COORD)]])
  const sent: { to: unknown; text: string }[] = []
  const as = (session: string): any => ({
    plugin: { name: 'orchestrator', root: '/plugins/orch' },
    env: { get: async (key: string) => (key === 'HOME' ? HOME : undefined) },
    session: {
      id: async () => session,
      send: async (args: { to: unknown; text: string }) => {
        sent.push(args)
        return options.refuse ? { isDelivered: false, reason: options.refuse } : { isDelivered: true }
      },
    },
    clock: { sleep: async () => undefined },
    ui: { log: () => undefined, invalidate: () => undefined },
    prompt: { submit: async () => undefined },
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
        if (logLineOf(argv) !== null) return { exitCode: 0, stdout: '', stderr: '' }
        const lock = lockRun(argv, files)
        if (lock !== null) return lock
        if (argv[0] === 'hostname') return { exitCode: 0, stdout: 'box-1.local\n', stderr: '' }
        if (argv[0] === 'mv') { files.set(argv[3], files.get(argv[2])!); files.delete(argv[2]) }
        if (argv[0] === 'rm') for (const p of argv.slice(2)) files.delete(p)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  })
  return { files, sent, asker: as('s-ask'), coordinator: as('s-coord'), as }
}

// A question the asker asked with `ask`, its id.
async function asked(m: ReturnType<typeof machine>, extra: Record<string, unknown> = {}): Promise<string> {
  askTurnStarted()
  const answer = await callAsk(m.asker, { ...QUESTION, ...extra }, NOW)
  return /Asked as (\S+?):/.exec(answer.result)![1]
}

const entryOf = (m: ReturnType<typeof machine>, id: string) => JSON.parse(m.files.get(`${ROUND}/${id}.json`)!)
const request = (id: string, over: Partial<SettleRequest> = {}): SettleRequest => ({ id, outcome: 'answered-here', text: 'A', author: null, work: null, ...over })
const AT = new Date('2026-11-14T15:05:00Z')

// --- the call ------------------------------------------------------------------------------------

test('a call names its entry, its outcome and what that outcome needs; anything else is refused', () => {
  expect(parseSettle({ id: 'q-1', outcome: 'answered-here', answer: ' A ' })).toEqual({ request: request('q-1') })
  expect(parseSettle({ id: 'q-1', outcome: 'withdrawn', reason: 'merged' })).toEqual({ request: request('q-1', { outcome: 'withdrawn', text: 'merged' }) })
  expect(parseSettle({ id: 'q-1', outcome: 'answered-by-message', answer: 'B', author: 'Coord: x' })).toEqual({ request: request('q-1', { outcome: 'answered-by-message', text: 'B', author: 'Coord: x' }) })
  expect(parseSettle({ id: 'q-1', outcome: 'answered-here', answer: 'B, and port it', work: 'port the fix to next' })).toEqual({ request: request('q-1', { text: 'B, and port it', work: 'port the fix to next' }) })
  for (const [input, refusal] of [
    [{ outcome: 'answered-here', answer: 'A' }, /id is the id/],
    [{ id: '../x', outcome: 'answered-here', answer: 'A' }, /id is the id/],
    [{ id: 'q-1', outcome: 'closed', answer: 'A' }, /outcome is one of/],
    [{ id: 'q-1', outcome: 'answered-here' }, /answer is his answer/],
    [{ id: 'q-1', outcome: 'withdrawn', answer: 'A' }, /reason says why/],
    [{ id: 'q-1', outcome: 'answered-by-message', answer: 'A' }, /author is the session/],
    [{ id: 'q-1', outcome: 'withdrawn', reason: 'moot', work: 'x' }, /asks no work/],
    [{ id: 'q-1', outcome: 'answered-here', answer: 'A', work: 3 }, /work is a string/],
  ] as const) {
    const parsed = parseSettle(input as Record<string, unknown>)
    expect('error' in parsed && parsed.error).toMatch(refusal)
  }
})

test('the tool is registered with flat fields, for every main session but an agent, and a subagent\'s call is refused', async () => {
  const m = machine()
  const handlers: Record<string, Function> = {}
  registerSettle(((event: string, ...rest: any[]) => {
    const [matcher, handler] = rest.length === 2 ? rest : [{}, rest[0]]
    handlers[`${event}${matcher.tool ? `:${matcher.tool}` : ''}`] = handler
    return { catch: () => undefined }
  }) as any)
  const registered: any[] = []
  m.asker.tool = { register: async (spec: unknown) => { registered.push(spec) } }
  await handlers['session.start'](m.asker, { cwd: '/w' }, async () => undefined)
  expect(registered.map(spec => spec.name)).toEqual(['settle'])
  expect(Object.keys(registered[0].inputSchema.properties).sort()).toEqual(['answer', 'author', 'id', 'outcome', 'reason', 'work'])
  const id = await asked(m)
  expect((await handlers['tool.call:mcp__orchestrator__settle'](m.asker, { id, outcome: 'answered-here', answer: 'A', agentId: 'a-1' })).isError).toBe(true)
  expect((await handlers['tool.call:mcp__orchestrator__settle'](m.asker, { id, outcome: 'answered-here', answer: 'A' })).isError).toBeUndefined()
  expect(entryOf(m, id).status).toBe('answered')
})

// --- a question asked with ask -----------------------------------------------------------------

test('its asker settles it answered in its own tab: answered, by the tab, nothing sent', async () => {
  const m = machine()
  const id = await asked(m)
  const answer = await settle(m.asker, request(id, { text: 'A, ship it' }), AT)
  expect(answer.isError).toBeUndefined()
  expect(entryOf(m, id)).toMatchObject({ status: 'answered', seq: 2, answer: { text: 'A, ship it', by: 'tab', at: AT.toISOString(), settler: ASKER } })
  expect(entryOf(m, id).delivery).toBeUndefined()
  expect(m.sent).toEqual([])
})

test('the coordinator settles it answered in its tab: the asker is sent the answer at once, and the delivery written', async () => {
  const m = machine()
  const id = await asked(m)
  const answer = await settle(m.coordinator, request(id, { text: 'B' }), AT)
  expect(answer.result).toContain(`Sent to ${ASKER}`)
  expect(m.sent).toEqual([{ to: { sessionId: 's-ask' }, text: `[module] The operator answered your question ${id} « ${QUESTION.subject} » (blocks: acme/app#1) through ${COORD} at ${AT.toISOString()} — B` }])
  const entry = entryOf(m, id)
  expect([entry.status, entry.answer.by, entry.delivery.state, entry.delivery.attempts]).toEqual(['answered', 'coordinator', 'delivered', 1])
})

test('a send the host refuses leaves the answer, its delivery failed with the reason, and says so', async () => {
  const m = machine({ refuse: 'nobody by that name' })
  const id = await asked(m)
  const answer = await settle(m.coordinator, request(id), AT)
  expect(answer.result).toContain('Not delivered')
  expect(entryOf(m, id).delivery).toMatchObject({ state: 'failed', attempts: 1, reason: 'nobody by that name' })
  expect(entryOf(m, id).status).toBe('answered')
})

test('the coordinator withdraws it: withdrawn, and the asker told why, never that he answered', async () => {
  const m = machine()
  const id = await asked(m)
  await settle(m.coordinator, request(id, { outcome: 'withdrawn', text: 'acme/app#1 merged' }), AT)
  expect(entryOf(m, id)).toMatchObject({ status: 'withdrawn', answer: { by: 'coordinator', text: 'acme/app#1 merged' } })
  expect(m.sent.map(s => s.text)).toEqual([`[module] ${COORD} withdrew your question ${id} « ${QUESTION.subject} » (blocks: acme/app#1): acme/app#1 merged`])
})

test('an answer by message settles its asker\'s own question, with its author; another session\'s settle is refused', async () => {
  const m = machine()
  const id = await asked(m)
  m.files.set(`${SESSIONS}/s-audit`, row('auditor', 'Audit: method'))
  for (const [who, input] of [[m.coordinator, request(id, { outcome: 'answered-by-message', author: 'Orch: z' })], [m.as('s-audit'), request(id)], [m.as('s-nobody'), request(id)]] as const) {
    expect((await settle(who, input, AT)).isError).toBe(true)
  }
  expect(entryOf(m, id).status).toBe('open')
  await settle(m.asker, request(id, { outcome: 'answered-by-message', author: COORD }), AT)
  expect(entryOf(m, id)).toMatchObject({ status: 'answered', answer: { by: 'message', author: COORD } })
  expect(m.sent).toEqual([])
})

test('a question settled once is not settled again, and an id the round lacks is refused', async () => {
  const m = machine()
  const id = await asked(m)
  await settle(m.asker, request(id), AT)
  const second = await settle(m.coordinator, request(id, { text: 'B' }), AT)
  expect([second.isError, second.result]).toEqual([true, `${id} is answered already: nothing to settle.`])
  expect(entryOf(m, id).answer.text).toBe('A')
  expect((await settle(m.asker, request('q-absent'), AT)).result).toBe('no entry q-absent in the round.')
})

test('a question that asks consent is recorded as that consent, by the tab or by the coordinator; a withdrawal records none', async () => {
  const consent = { consent_kind: 'auto-merge', consent_repo: 'acme/app', choice_a: 'Accorder', choice_b: 'Refuser' }
  const m = machine()
  const mine = await asked(m, consent)
  await settle(m.asker, request(mine, { text: 'A' }), AT)
  const theirs = await asked(m, consent)
  await settle(m.coordinator, request(theirs, { text: 'A' }), AT)
  const moot = await asked(m, consent)
  await settle(m.coordinator, request(moot, { outcome: 'withdrawn', text: 'moot' }), AT)
  const records = [...m.files.entries()].filter(([p]) => p.includes('/consents/acme/app/')).map(([p, text]) => [p.slice(p.lastIndexOf('/') + 1), JSON.parse(text).by])
  expect(records.sort()).toEqual([[`${mine}.json`, 'tab'], [`${theirs}.json`, 'coordinator']].sort())
})

test('an answer that asks work records it as a to-do of the asker, in its list, sent to it when another session settles', async () => {
  const m = machine()
  const id = await asked(m)
  const answer = await settle(m.coordinator, request(id, { text: 'B, and port it', work: 'port the fix to next' }), AT)
  expect(answer.result).toContain(`Recorded as to-do 1 in the list of ${ASKER.replace(/ \[.*\]$/, '')}`)
  expect(m.files.get(todoPath(MODULE, ASKER))).toContain('port the fix to next')
  expect(m.sent.length).toBe(2)
  const own = await asked(m)
  const mine = await settle(m.asker, request(own, { work: 'write the runbook' }), AT)
  expect(mine.result).toContain('Recorded as to-do 2 in your list')
  expect(m.sent.length).toBe(2)
})

// --- an entry the relay wrote --------------------------------------------------------------------

const relayed = (over: Record<string, unknown> = {}) => ({
  id: 'r-1', from: ASKER, session: 's-ask', kind: 'operator', since: '2026-11-14T14:00:00.000Z', blocks: 'phase 3',
  question: '**Question 1 of 1**', choices: [], recommendation: null, status: 'open', at: '2026-11-14T14:00:00.000Z', answer: null, ...over,
})

test('its sender settles the relay\'s entry answered in its tab, or withdraws it: answered or withdrawn, nothing sent', async () => {
  const m = machine()
  m.files.set(`${ROUND}/r-1.json`, JSON.stringify(relayed()))
  m.files.set(`${ROUND}/r-2.json`, JSON.stringify(relayed({ id: 'r-2' })))
  await settle(m.asker, request('r-1', { text: 'B' }), AT)
  await settle(m.asker, request('r-2', { outcome: 'withdrawn', text: 'no longer needed' }), AT)
  expect(entryOf(m, 'r-1')).toMatchObject({ status: 'answered', answer: { by: 'tab', text: "answered in the sender's own tab", typed: 'B' } })
  expect(entryOf(m, 'r-2')).toMatchObject({ status: 'withdrawn', answer: { by: 'sender', text: 'no longer needed' } })
  expect(m.sent).toEqual([])
})

test('a relay\'s entry the coordinator here was shown is closed by its sender\'s settle, and the coordinator told so', async () => {
  const m = machine()
  m.files.set(`${MODULE}/coordinator.json`, JSON.stringify({ name: COORD, tty: '/dev/ttys009' }))
  m.files.set(`${ROUND}/r-1.json`, JSON.stringify(relayed()))
  m.files.set(`${MODULE}/round-listed.json`, JSON.stringify(['r-1']))
  await settle(m.asker, request('r-1', { outcome: 'answered-by-message', author: COORD }), AT)
  expect(entryOf(m, 'r-1')).toMatchObject({ status: 'closed', answer: { by: 'message', author: COORD, text: `withdrawn: answered by a message from ${COORD}` } })
  expect(m.sent.map(s => s.text)).toEqual([expect.stringContaining('[module] Settled')])
})
