// hooks/tests/settle.test.ts
// The `settle` tool over a faked $: a call validated, then the one closure of a round question —
// an object `ask` stored, closed by its asker or by the coordinator, its answer sent to its asker at
// once when another session settles it, its consent recorded, the work its answer asks recorded as a
// to-do of the asker; and the relay's entry closed by its own sender as the answered tool closed it.
import { expect, test } from 'claude-code/testing'
import { grants } from '../../core/consent-record.ts'
import { answerAskedFromPane, askTurnStarted, callAsk, settle, registerSettle } from '../question.ts'
import { parseSettle, planClaimed, planPane, planWithdrawal, type SettleRequest } from '../settle.ts'
import { todoPath } from '../todo-format.ts'
import { waitKey } from '../supervision.ts'
import { entryFingerprint, type RoundEntry } from '../round.ts'
import { logLineOf, lockRun } from './fakes.ts'
import { capture, hooksOn, hostOf } from '../../core/capture.ts'
import { fieldsOf, type Host, type Noun, type ToolSpec } from '../../core/host.ts'

type World = Host<Noun>
// What the settle tool answers: its text, and whether it is an error.
type Out = { readonly result: string; readonly isError?: boolean }

const HOME = '/tmp/settle-home'
const MODULE = `${HOME}/.claude/claude-orchestrator`
const ROUND = `${MODULE}/round`
const SESSIONS = `${MODULE}/store/sessions`
const NOW = new Date('2026-11-14T15:00:00Z')
const ASKER = 'Orch: acme [a1b2c3]'
const COORD = 'Coord: general'

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
  const as = (session: string): World => hostOf({
    plugin: { root: '/plugins/orch' },
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
      stat: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return { kind: 'file' as const, size: 1, mtimeMs: NOW.getTime() } },
      exists: async (p: string) => files.has(p),
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: 1, isLink: false })),
    },
    process: {
      run: async (argv: readonly string[]) => {
        if (logLineOf(argv) !== null) return { exitCode: 0, stdout: '', stderr: '' }
        const lock = lockRun(argv, files)
        if (lock !== null) return lock
        if (argv[0] === 'hostname') return { exitCode: 0, stdout: 'box-1.local\n', stderr: '' }
        if (argv[0] === 'mv') { files.set(argv[3]!, files.get(argv[2]!)!); files.delete(argv[2]!) }
        if (argv[0] === 'rm') for (const p of argv.slice(2)) files.delete(p)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  })
  return { files, sent, asker: as('s-ask'), coordinator: as('s-coord'), as }
}

// A question the asker asked with `ask`, its id. Each asks its own, so that none is answered from
// the record of one settled before it (question.ts recordedAsked).
let askedCount = 0
async function asked(m: ReturnType<typeof machine>, extra: Record<string, unknown> = {}): Promise<string> {
  askTurnStarted()
  askedCount += 1
  const answer = await callAsk(m.asker, { ...QUESTION, context: `${QUESTION.context} (${askedCount})`, ...extra }, NOW)
  return /Asked as (\S+?):/.exec(answer.result)![1]!
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
  const hooks = capture<World>(registerSettle)
  const registered: ToolSpec[] = []
  m.asker.tool.register = async (spec: ToolSpec) => { registered.push(spec) }
  await hooksOn(hooks, 'session.start').at(-1)!.handler(m.asker, { cwd: '/w' }, async () => undefined)
  expect(registered.map(spec => spec.name)).toEqual(['settle'])
  const settleHook = hooksOn(hooks, 'tool.call').filter(h => h.matcher?.['tool'] === 'mcp__orchestrator__settle').at(-1)!
  const call = async (dollar: World, e: Record<string, unknown>) => await settleHook.handler(dollar, e, async () => undefined) as Out
  expect(Object.keys(fieldsOf(registered[0]?.inputSchema?.['properties']) ?? {}).sort()).toEqual(['answer', 'author', 'consent_env', 'consent_kind', 'consent_pr', 'consent_repo', 'id', 'outcome', 'reason', 'said_at', 'until', 'work'])
  const id = await asked(m)
  expect((await call(m.asker, { id, outcome: 'answered-here', answer: 'A', agentId: 'a-1' })).isError).toBe(true)
  expect((await call(m.asker, { id, outcome: 'answered-here', answer: 'A' })).isError).toBeUndefined()
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

test('an answer that names its choice by text then letter, as the coordinator relays it, is recorded as that choice, and « Accorder » grants', async () => {
  const consent = { consent_kind: 'e2e-waiver', consent_repo: 'acme/app', consent_pr: 7, choice_a: 'Accorder', choice_b: 'Refuser' }
  const m = machine()
  const granted = await asked(m, consent)
  await settle(m.coordinator, request(granted, { text: 'Accorder (A)' }), AT)
  const refused = await asked(m, consent)
  await settle(m.coordinator, request(refused, { text: 'Refuser (B)' }), AT)
  const answers = (id: string) => JSON.parse(m.files.get([...m.files.keys()].find(p => p.endsWith(`/consents/acme/app/${id}.json`))!)!).answer
  expect([answers(granted), answers(refused)]).toEqual(['Accorder', 'Refuser'])
})

test('an answer by message on its asker\'s own question records no consent: the model\'s word is no answer of the operator', async () => {
  const m = machine()
  const id = await asked(m, { consent_kind: 'auto-merge', consent_repo: 'acme/app', choice_a: 'Accorder', choice_b: 'Refuser' })
  await settle(m.asker, request(id, { outcome: 'answered-by-message', text: 'A', author: COORD }), AT)
  expect(entryOf(m, id).status).toBe('answered')
  expect([...m.files.keys()].filter(p => p.includes('/consents/'))).toEqual([])
})

test('a consent that cannot be recorded leaves the question settled, and the reply says so', async () => {
  const consent = { consent_kind: 'auto-merge', consent_repo: 'acme/app', choice_a: 'Accorder', choice_b: 'Refuser' }
  const m = machine()
  const blocked = await asked(m, consent)
  const run = m.coordinator.process.run
  m.coordinator.process.run = async (argv: readonly string[]) => (argv[0] === 'mkdir' ? { exitCode: 1, stdout: '', stderr: 'read-only file system' } : run(argv))
  const failed = await settle(m.coordinator, request(blocked, { text: 'A' }), AT)
  expect(failed.isError).toBeUndefined()
  expect(entryOf(m, blocked).status).toBe('answered')
  expect(failed.result).toContain('The consent is not recorded')
  expect(failed.result).toContain('read-only file system')
  expect([...m.files.keys()].filter(p => p.includes('/consents/'))).toEqual([])
})

test('a half-written entry is refused, and stays as it was', async () => {
  const m = machine()
  m.files.set(`${ROUND}/r-half.json`, '{"id":"r-half","status":"op')
  const answer = await settle(m.coordinator, request('r-half'), AT)
  expect(answer.isError).toBe(true)
  expect(answer.result).toContain('r-half')
  expect(m.files.get(`${ROUND}/r-half.json`)).toBe('{"id":"r-half","status":"op')
  expect(m.sent).toEqual([])
})

test('a store write that fails is refused, nothing changed, nothing sent', async () => {
  const m = machine()
  const id = await asked(m)
  const before = m.files.get(`${ROUND}/${id}.json`)
  const write = m.coordinator.fs.write
  m.coordinator.fs.write = async (p: string, text: string) => { if (p.startsWith(`${ROUND}/`)) throw new Error('disk full'); return write(p, text) }
  const answer = await settle(m.coordinator, request(id, { text: 'B' }), AT)
  expect([answer.isError, answer.result]).toEqual([true, `${id} could not be written (disk full); nothing changed, settle it again.`])
  expect(m.files.get(`${ROUND}/${id}.json`)).toBe(before)
  expect(m.sent).toEqual([])
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

// --- a closing proposal the relay wrote --------------------------------------------------------------------

const relayed = (over: Record<string, unknown> = {}) => ({
  id: 'r-1', from: ASKER, session: 's-ask', kind: 'done', since: '2026-11-14T14:00:00.000Z', blocks: null,
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

// The coordinator's own tab is the operator's: his plain confirmations given there are his consent, for a
// question whichever orchestrator's pull request it is about. Words that add a limit, a condition, a
// question or another subject record nothing and the settle says why; an orchestrator's own settle is its word.
const GRANT_WORDS = 'Accorder la dispense de acme/app#7 et fusionner, merci'
const LIMIT_WORDS = "Accorder la dispense et fusionner. Valable jusqu'au 16/11/2026 12h00"
const consentOf = (id: string) => ({ consent: { kind: 'e2e-waiver', repo: 'acme/app', pr: 7 }, choices: [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }], kind: 'operator', question: 'Waive E2E on acme/app#7?', id })
const recordsOf = (m: ReturnType<typeof machine>) => [...m.files.entries()].filter(([p]) => p.includes('/consents/acme/app/')).map(([, text]) => JSON.parse(text))
const CONSENT_ASK = { consent_kind: 'e2e-waiver', consent_repo: 'acme/app', consent_pr: 7, choice_a: 'Accorder', choice_b: 'Refuser' }

test('the coordinator settles its own wait that asks consent, answered in its tab with a plain confirmation: the consent record is « Accorder », by the coordinator', async () => {
  const m = machine()
  m.files.set(`${ROUND}/r-1.json`, JSON.stringify(relayed({ ...consentOf('r-1'), from: COORD, session: 's-coord' })))
  await settle(m.coordinator, request('r-1', { text: GRANT_WORDS }), AT)
  expect(recordsOf(m)).toMatchObject([{ answer: 'Accorder', by: 'coordinator', entry: 'r-1', subject: { kind: 'e2e-waiver', repo: 'acme/app', pr: 7 } }])
})

test('the coordinator settling its own ask that asks consent takes the same path: « Accorder » by the coordinator, a limit records none and says why', async () => {
  const m = machine()
  askTurnStarted()
  const made = await callAsk(m.coordinator, { ...QUESTION, ...CONSENT_ASK }, NOW)
  const id = /Asked as (\S+?):/.exec(made.result)![1]!
  const limited = await settle(m.coordinator, request(id, { text: LIMIT_WORDS }), AT)
  expect(recordsOf(m)).toEqual([])
  expect(limited.result).toContain('The consent is not recorded')
  const again = await settle(m.coordinator, request(id, { text: GRANT_WORDS }), AT)
  expect(again.result).toContain('is answered already')
  askTurnStarted()
  const second = /Asked as (\S+?):/.exec((await callAsk(m.coordinator, { ...QUESTION, context: 'second', ...CONSENT_ASK }, NOW)).result)![1]!
  await settle(m.coordinator, request(second, { text: GRANT_WORDS }), AT)
  expect(recordsOf(m).map(r => [r.entry, r.answer, r.by])).toEqual([[second, 'Accorder', 'coordinator']])
})

test('the coordinator\'s settle of an exemption question that states its expiry, answered with his sentence worded in Paris time, records his sentence whole; another instant records none, and a waiver question with a limit records none', async () => {
  const exemption = { consent_kind: 'e2e-exemption', consent_repo: 'acme/app', choice_a: 'Accorder', choice_b: 'Refuser' }
  const sentence = "Accorder la dispense de app et fusionner les PRS. Dispense valable jusqu'au 16/11/2026 12h00 heure de Paris !"
  const m = machine()
  const ask = async (until: string) => {
    askTurnStarted()
    const made = await callAsk(m.coordinator, { ...QUESTION, context: `until ${until}`, question: `Exempt acme/app from E2E until ${until}?`, ...exemption }, NOW)
    return /Asked as (\S+?):/.exec(made.result)![1]!
  }
  const right = await ask('2026-11-16T11:00:00Z')
  await settle(m.coordinator, request(right, { text: sentence }), AT)
  const wrong = await ask('2026-11-16T12:00:00Z')
  const refused = await settle(m.coordinator, request(wrong, { text: sentence }), AT)
  expect(refused.result).toContain('The consent is not recorded')
  expect(recordsOf(m).map(r => [r.entry, r.answer, r.by, r.subject.kind])).toEqual([[right, sentence, 'coordinator', 'e2e-exemption']])
  askTurnStarted()
  const waiver = /Asked as (\S+?):/.exec((await callAsk(m.coordinator, { ...QUESTION, context: 'waiver', question: 'Waive E2E on acme/app#7 until 2026-11-16T11:00:00Z?', ...CONSENT_ASK }, NOW)).result)![1]!
  expect((await settle(m.coordinator, request(waiver, { text: sentence }), AT)).result).toContain('adds words after its choice')
  expect(recordsOf(m).length).toBe(1)
})

test('an orchestrator settling its own wait that asks consent records none: its words are its own, and a withdrawal records none', async () => {
  const m = machine()
  m.files.set(`${ROUND}/r-1.json`, JSON.stringify(relayed(consentOf('r-1'))))
  m.files.set(`${ROUND}/r-2.json`, JSON.stringify(relayed({ ...consentOf('r-2'), from: COORD, session: 's-coord' })))
  await settle(m.asker, request('r-1', { text: GRANT_WORDS }), AT)
  await settle(m.coordinator, request('r-2', { outcome: 'withdrawn', text: 'moot' }), AT)
  expect(recordsOf(m)).toEqual([])
})

test('an orchestrator settling its own question with words after « Accorder » records them whole, which grants nothing', async () => {
  const m = machine()
  const own = await asked(m, CONSENT_ASK)
  await settle(m.asker, request(own, { text: 'Accorder, mais pas avant lundi' }), AT)
  expect(recordsOf(m).map(r => [r.entry, r.answer, r.by, grants(r.answer)])).toEqual([[own, 'Accorder, mais pas avant lundi', 'tab', false]])
})

test('the coordinator closing another orchestrator\'s question: a plain confirmation records « Accorder », « Refuser » words record « Refuser », and a limit or another subject records none and says why', async () => {
  const m = machine()
  const granted = await asked(m, CONSENT_ASK)
  await settle(m.coordinator, request(granted, { text: GRANT_WORDS }), AT)
  const refused = await asked(m, CONSENT_ASK)
  await settle(m.coordinator, request(refused, { text: 'Refuser, pas ce soir' }), AT)
  expect(recordsOf(m).map(r => [r.entry, r.answer, r.by]).sort()).toEqual([[granted, 'Accorder', 'coordinator'], [refused, 'Refuser', 'coordinator']].sort())
  const limited = await settle(m.coordinator, request(await asked(m, CONSENT_ASK), { text: LIMIT_WORDS }), AT)
  expect(limited.result).toContain('adds words after its choice')
  const other = await settle(m.coordinator, request(await asked(m, CONSENT_ASK), { text: 'Accorder pour acme/other#32' }), AT)
  expect(other.result).toContain("other than the question's own")
  expect(recordsOf(m).length).toBe(2)
})

test('a question asked with ask the coordinator here was shown is settled by its asker in its own tab, and the coordinator told once; one never shown, or settled by the coordinator, tells it nothing', async () => {
  const m = machine()
  m.files.set(`${MODULE}/coordinator.json`, JSON.stringify({ name: COORD, tty: '/dev/ttys009' }))
  const [shown, unseen, held] = [await asked(m), await asked(m), await asked(m)]
  m.files.set(`${MODULE}/round-listed.json`, JSON.stringify([shown, held]))
  await settle(m.asker, request(unseen), AT)
  expect(m.sent).toEqual([])
  await settle(m.asker, request(shown), AT)
  expect(entryOf(m, shown)).toMatchObject({ status: 'answered', answer: { by: 'tab' } })
  expect(m.sent.length).toBe(1)
  expect(m.sent[0]?.text).toContain(shown)
  expect(JSON.stringify(m.sent[0]?.to)).not.toContain('s-ask')
  // The coordinator's own settle sends the answer to its asker, and itself no notice.
  await settle(m.coordinator, request(held), AT)
  expect(m.sent.length).toBe(2)
  expect(m.sent[1]?.to).toEqual({ sessionId: 's-ask' })
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

test('its sender settles only its open relay\'s entry; the coordinator closes one and forgets its fingerprint in the sender\'s wait', async () => {
  const m = machine()
  m.files.set(`${ROUND}/r-1.json`, JSON.stringify(relayed({ status: 'withdrawn', answer: { text: 'moot', by: 'sender', at: 'T' } })))
  expect((await settle(m.asker, request('r-1'), AT)).result).toBe('r-1 is withdrawn already: nothing to settle.')
  const open = relayed({ id: 'r-2' })
  m.files.set(`${ROUND}/r-2.json`, JSON.stringify(open))
  const wait = `${MODULE}/store/${waitKey('s-ask')}`
  m.files.set(wait, JSON.stringify({ waiting: 'done', relayed: entryFingerprint(open as RoundEntry) }))
  await settle(m.coordinator, request('r-2', { text: 'B' }), AT)
  expect(entryOf(m, 'r-2')).toMatchObject({ status: 'closed', answer: { text: 'B', by: 'coordinator' } })
  expect(JSON.parse(m.files.get(wait)!).relayed).toBeNull()
})

test('the coordinator closes a relay\'s entry, of this machine or of another, and sends its sender nothing', async () => {
  const m = machine()
  m.files.set(`${ROUND}/r-1.json`, JSON.stringify(relayed()))
  m.files.set(`${ROUND}/r-2.json`, JSON.stringify(relayed({ id: 'r-2', origin: { machine: 'bench-mac', address: 'bridge:peer' } })))
  const here = await settle(m.coordinator, request('r-1', { text: 'B' }), AT)
  const there = await settle(m.coordinator, request('r-2', { text: 'B' }), AT)
  expect([here.result, there.result]).toEqual(['Settled r-1: closed.', 'Settled r-2: closed.'])
  expect([entryOf(m, 'r-1').status, entryOf(m, 'r-2').status]).toEqual(['closed', 'closed'])
  expect(m.sent).toEqual([])
})

// An operator entry of an older release left in the round: the round's wake withdraws it with a
// notice to its sender (pane.test.ts); the coordinator's settle neither closes it nor sends.
test('the coordinator\'s settle of an open operator entry of an older release is refused, sends nothing, and leaves it open', async () => {
  const m = machine()
  const older = relayed({ id: 'r-3', kind: 'operator', blocks: 'phase 3' })
  const remote = relayed({ id: 'r-4', kind: 'operator', blocks: 'phase 3', origin: { machine: 'bench-mac', address: 'bridge:peer' } })
  m.files.set(`${ROUND}/r-3.json`, JSON.stringify(older))
  m.files.set(`${ROUND}/r-4.json`, JSON.stringify(remote))
  for (const id of ['r-3', 'r-4']) {
    const refused = await settle(m.coordinator, request(id, { text: 'B' }), AT)
    expect(refused.result).toBe(`${id} is an operator question of an older release: the round withdraws it and tells its sender to ask it with ask; nothing to settle.`)
  }
  expect([entryOf(m, 'r-3'), entryOf(m, 'r-4')]).toEqual([older, remote])
  expect(m.sent).toEqual([])
})

// --- the planners every module close goes through (closeRound) ----------------------------------------

const ME = { session: 's-coord', name: COORD, role: 'coordinator' }
const object = (over: Record<string, unknown> = {}) => ({
  v: 2, id: 'q-1', sender: { session: 's-ask', name: ASKER, role: 'orchestrator', machine: 'box-1' }, subject: 's', context: 'c', ask: 'a',
  choices: [{ letter: 'A', text: 'yes' }], recommended: 'A', why: null, blocks: 'b', status: 'open', at: 'T0', answer: null, seq: 3, ...over,
})

test('the pane\'s plan: an open question answered and sent to its asker now, a replica sent to its owner, its seq the owner\'s; none closed or claimed', () => {
  expect(planPane(object({ status: 'answered' }), 'A : yes', ME, 'T1')).toBeNull()
  expect(planPane(object({ claimed: { typed: 'B', at: 'T1' } }), 'A : yes', ME, 'T1')).toBeNull()
  const here = planPane(object(), 'A : yes', ME, 'T1')!
  expect(here).toMatchObject({ deliver: 'now', consentBy: 'pane', consentText: 'A : yes', relayed: false, told: false, asker: { session: 's-ask', name: ASKER, remote: false } })
  expect(here.entry).toMatchObject({ status: 'answered', seq: 4, answer: { text: 'A : yes', by: 'pane', at: 'T1', settler: COORD } })
  const origin = { machine: 'box-2', address: 'bridge:peer' }
  const there = planPane(object({ origin }), 'A : yes', ME, 'T1')!
  expect(there).toMatchObject({ deliver: 'remote', consentBy: null })
  expect(there.entry).toMatchObject({ status: 'answered', seq: 3, origin, delivery: { state: 'pending', at: 'T1', attempts: 0 } })
})

test('the tab\'s plan: the claim goes, his words the answer by the tab, its consent from the choice they name only', () => {
  const claimed = object({ claimed: { typed: 'A', at: 'T1' } })
  const granted = planClaimed(claimed, 'A : yes', 'T2')
  expect('claimed' in granted.entry).toBe(false)
  expect(granted.entry).toMatchObject({ status: 'answered', seq: 4, answer: { text: 'A', by: 'tab', at: 'T2', settler: ASKER } })
  expect(granted).toMatchObject({ deliver: null, consentBy: 'tab', consentText: 'A : yes', relayed: false, told: false })
  expect(planClaimed(claimed, null, 'T2')).toMatchObject({ consentBy: null, consentText: '' })
  // The coordinator here that was shown the question is told it was answered in its asker's tab; one that was not is told nothing.
  expect(planClaimed(claimed, null, 'T2').told).toBe(false)
  expect(planClaimed(claimed, null, 'T2', true).told).toBe(true)
})

test('the withdrawal\'s plan: a question asked with ask withdrawn by its asker; the relay\'s entry withdrawn, or closed when the coordinator here was shown it', () => {
  const asked = planWithdrawal(object(), 'ended', 'T1', true)
  expect(asked.entry).toMatchObject({ status: 'withdrawn', seq: 4, answer: { text: 'ended', by: 'sender', at: 'T1', settler: ASKER } })
  expect(asked).toMatchObject({ deliver: null, consentBy: null, relayed: false, told: false })
  const quiet = planWithdrawal(relayed(), 'ended', 'T1', false)
  expect(quiet.entry).toMatchObject({ status: 'withdrawn', answer: { text: 'ended', by: 'sender', at: 'T1' } })
  expect(quiet).toMatchObject({ relayed: true, told: false, asker: { session: 's-ask', name: ASKER, remote: false } })
  expect(planWithdrawal(relayed(), 'ended', 'T1', true).entry).toMatchObject({ status: 'closed', answer: { text: 'withdrawn: ended' } })
  expect(planWithdrawal(relayed({ origin: { machine: 'box-2', address: 'bridge:peer' } }), 'ended', 'T1', false).asker.remote).toBe(true)
})

// The pane's answer goes through closeRound, which pushes a question to a coordinator on another
// machine: the pane is the coordinator's own, so nothing but the answer is sent.
test('the pane\'s answer to a question asked here sends its asker the answer and pushes nothing', async () => {
  const m = machine()
  m.files.set(`${MODULE}/coordinator.json`, JSON.stringify({ name: COORD, tty: '/dev/ttys009' }))
  const id = await asked(m)
  m.sent.length = 0
  await answerAskedFromPane(m.coordinator, id, 'B : acme/app#2 first', AT)
  expect(entryOf(m, id)).toMatchObject({ status: 'answered', answer: { by: 'pane' } })
  expect(m.sent.map(s => s.text)).toEqual([expect.stringMatching(/^\[module\] The operator answered your question/)])
})

test('an answer of the operator is kept in the journal as what was asked and how he answered, never his words; a withdrawal keeps none', async () => {
  const m = machine()
  const chosen = await asked(m)
  await settle(m.coordinator, request(chosen, { text: 'B : acme/app#2 first' }), AT)
  const moot = await asked(m)
  await settle(m.coordinator, request(moot, { outcome: 'withdrawn', text: 'moot' }), AT)
  const events = [...m.files.entries()].filter(([p]) => p.startsWith(`${HOME}/.claude/orchestrator/`) && p.endsWith('.json')).map(([, text]) => JSON.parse(text))
  expect(events.map(event => [event.kind, event.trust, event.source.code])).toEqual([['answer', 'operator', 'orchestrator.answer.other']])
  expect(events[0].evidence).toEqual([{ type: 'ruling', path: `claude-orchestrator/round/${chosen}.json`, line: 1 }])
  expect(JSON.stringify(events)).not.toContain('acme/app#2 first')
})
