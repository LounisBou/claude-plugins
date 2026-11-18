// hooks/tests/question.test.ts
// The `ask` tool over a faked $: the call's flat fields validated against the method's question
// format, one object stored in the round per call with the module's own id, the asker and a format
// version that the relay's entries do not carry, its block written to the transcript by the module;
// and the lines the pane draws from those objects, grouped by asker.
import { expect, test } from 'claude-code/testing'
import { ASK_TOOL, ASK_VERSION, askTurnStarted, askedGroups, askedLines, askId, callAsk, claimAsked, parseAsk, parseAsked, questionBlock, settleClaimed, register as registerQuestion, type Asked } from '../question.ts'
import { parseRoundEntry } from '../supervision.ts'
import { DECLARATIONS } from '../wait.ts'
import { logLineOf, lockRun } from './fakes.ts'
import { capture, hookOf, hostOf } from '../../core/capture.ts'
import { fieldsOf, type Events, type Host, type Next, type Noun, type ToolSpec } from '../../core/host.ts'

const HOME = '/tmp/ask-home'
const MODULE = `${HOME}/.claude/claude-orchestrator`
const ROUND = `${MODULE}/round`
const NOW = new Date('2026-11-14T15:00:00Z')

const row = (role: string, name: string) =>
  JSON.stringify({ role, name, repo: null, context_percent: 1, context_tokens: 1, window: 100, model: 'm', busy: false, updated_at: new Date().toISOString() })

// A row written by a measure whose walk did not finish: no name, no role.
const bareRow = () => JSON.stringify({ ...JSON.parse(row('orchestrator', 'x')), role: null, name: null })

// Every field of the call filled, as the method's question.
const FULL = {
  subject: 'merge order of acme/app#1',
  context: 'Two pull requests touch the same file. Merging acme/app#1 first spares a rebase of acme/app#2.',
  question: 'Which one merges first?',
  choice_a: 'acme/app#1 first — cost: none — gain: no rebase',
  choice_b: 'acme/app#2 first — cost: a rebase — gain: the fix ships an hour sooner',
  choice_c: 'hold both — cost: a day — gain: one review for both',
  recommended: 'A',
  why: 'it costs nothing, and the hour B saves buys nobody anything today',
  blocks: 'acme/app#1, acme/app#2',
  urgent: true,
}

// `walk`: the name the host holds for the session, on its tty (the walk's own reads: the process table and
// the host's record of the process). `bare`: a row written by a measure whose walk did not finish.
type Options = { me?: [role: string, name: string] | null; logThrows?: string; files?: Record<string, string>; walk?: string; bare?: boolean; session?: string }

function world(options: Options = {}) {
  // Each world is a fresh turn of the main thread: the questions it asks are numbered from one.
  askTurnStarted()
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  const me: [role: string, name: string] | null = options.me === undefined ? ['coordinator', 'Coord: general [a1b2c3]'] : options.me
  const sid = options.session ?? 's-me'
  if (me !== null) files.set(`${MODULE}/store/sessions/${sid}`, options.bare ? bareRow() : row(me[0], me[1]))
  if (options.walk !== undefined) files.set(`${HOME}/.claude/sessions/4242.json`, JSON.stringify({ pid: 4242, sessionId: sid, name: options.walk, status: 'busy' }))
  const shown: string[] = []
  const logs: string[] = []
  const dollar = hostOf({
    plugin: { root: '/plugins/orch' },
    env: { get: async (key: string) => (key === 'HOME' ? HOME : undefined) },
    session: { id: async () => sid },
    clock: { sleep: async () => undefined },
    ui: {
      log: (text: string) => {
        if (options.logThrows) throw new Error(options.logThrows)
        shown.push(text)
      },
    },
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
        if (options.walk !== undefined && argv[0] === 'sh' && String(argv[2]).startsWith('ps -o ppid=')) return { exitCode: 0, stdout: '1 ttys001\n', stderr: '' }
        if (options.walk !== undefined && argv[0] === 'ps') return { exitCode: 0, stdout: '4242 host --resume 043603d9 --name Orch: launched\n', stderr: '' }
        if (argv[0] === 'hostname') return { exitCode: 0, stdout: 'box-1.local\n', stderr: '' }
        const [verb, , from = '', to = ''] = argv
        if (verb === 'mv') { files.set(to, files.get(from)!); files.delete(from) }
        if (verb === 'rm') for (const p of argv.slice(2)) files.delete(p)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  })
  return { dollar, files, shown, logs }
}

const stored = (files: Map<string, string>): Asked[] =>
  [...files.entries()].filter(([p]) => p.startsWith(`${ROUND}/`) && p.endsWith('.json')).map(([, text]) => JSON.parse(text) as Asked)

// Two entries, in their order: a test that asked two questions reads both.
const pair = (entries: Asked[]): [Asked, Asked] => {
  const [first, second] = entries
  if (first === undefined || second === undefined) throw new Error(`two entries expected, ${entries.length} stored`)
  return [first, second]
}

const ask = (dollar: Host<Noun>, input: Record<string, unknown>, now = NOW) => callAsk(dollar, { tool: `mcp__orchestrator__${ASK_TOOL}`, ...input }, now)

// --- validation ---------------------------------------------------------------------------------

test('a question in the method\'s format is taken, its choices lettered in order', () => {
  const parsed = parseAsk(FULL)
  expect('fields' in parsed).toBe(true)
  if (!('fields' in parsed)) return
  expect(parsed.fields).toEqual({
    subject: FULL.subject, context: FULL.context, ask: FULL.question,
    choices: [{ letter: 'A', text: FULL.choice_a }, { letter: 'B', text: FULL.choice_b }, { letter: 'C', text: FULL.choice_c }],
    recommended: 'A', why: FULL.why, blocks: FULL.blocks, urgent: true,
  })
})

test('a question with no choice is taken, recommending none', () => {
  const { choice_a: _a, choice_b: _b, choice_c: _c, recommended: _r, why: _w, ...free } = FULL
  const parsed = parseAsk(free)
  expect('fields' in parsed && parsed.fields.choices).toEqual([])
  expect('fields' in parsed && parsed.fields.recommended).toBe(null)
})

for (const [name, input, refusal] of [
  ['one choice alone', { ...FULL, choice_b: undefined, choice_c: undefined }, /one choice is no choice/],
  ['a skipped letter', { ...FULL, choice_b: undefined }, /no letter skipped/],
  ['six choices', { ...FULL, choice_d: 'd', choice_e: 'e', choice_f: 'f' }, null],
  ['no recommendation beside choices', { ...FULL, recommended: undefined }, /letter of one of the choices: A, B, C/],
  ['a recommendation no choice holds', { ...FULL, recommended: 'D' }, /letter of one of the choices/],
  ['a recommendation with no argument', { ...FULL, why: '' }, /bare letter is no recommendation/],
  ['a bare letter for argument', { ...FULL, why: 'A.' }, /bare letter is no recommendation/],
  ['a recommendation without choices', { subject: 's', context: 'c', question: 'q?', recommended: 'A', blocks: 'b' }, /recommends none/],
  ['a question with no question mark', { ...FULL, question: 'Which one merges first' }, /ending in a question mark/],
  ['no subject', { ...FULL, subject: ' ' }, /subject/],
  ['no context', { ...FULL, context: undefined }, /context/],
  ['nothing blocked', { ...FULL, blocks: '' }, /blocks names what waits/],
  ['a nested field instead of a flat one', { ...FULL, choices: ['x', 'y'], choice_a: undefined, choice_b: undefined, choice_c: undefined }, /recommends none|letter of one/],
  ['a number for a text', { ...FULL, context: 3 }, /context is a string/],
] as const) test(`a question with ${name} is ${refusal === null ? 'read for its five letters alone' : 'refused'}`, () => {
  const parsed = parseAsk(input as Record<string, unknown>)
  if (refusal === null) {
    expect('fields' in parsed && parsed.fields.choices.map(c => c.letter)).toEqual(['A', 'B', 'C', 'D', 'E'])
    return
  }
  expect('error' in parsed && parsed.error).toMatch(refusal)
})

test('a question that asks consent offers Accorder then Refuser, and keeps its subject', () => {
  const consent = { consent_kind: 'e2e-waiver', consent_repo: 'acme/app', consent_pr: 7 }
  const base = { ...FULL, choice_c: undefined, ...consent }
  expect('error' in parseAsk(base) && (parseAsk(base) as { error: string }).error).toMatch(/choice_a "Accorder", choice_b "Refuser"/)
  const parsed = parseAsk({ ...base, choice_a: 'Accorder', choice_b: 'Refuser' })
  expect('fields' in parsed && parsed.fields.consent).toEqual({ kind: 'e2e-waiver', repo: 'acme/app', pr: 7 })
  expect('error' in parseAsk({ ...base, choice_a: 'Accorder', choice_b: 'Refuser', consent_pr: undefined })).toBe(true)
})

// --- creation -----------------------------------------------------------------------------------

test('a call stores one object in the round with every field it was given, its id the module\'s, and shows its block', async () => {
  const { dollar, files, shown } = world()
  const answer = await ask(dollar, FULL)
  expect(answer.isError).toBeUndefined()
  const entry = stored(files)[0]!
  expect(stored(files).length).toBe(1)
  expect(entry).toEqual({
    v: ASK_VERSION,
    id: entry.id,
    sender: { session: 's-me', name: 'Coord: general [a1b2c3]', role: 'coordinator', machine: 'box-1' },
    subject: FULL.subject, context: FULL.context, ask: FULL.question,
    choices: [{ letter: 'A', text: FULL.choice_a }, { letter: 'B', text: FULL.choice_b }, { letter: 'C', text: FULL.choice_c }],
    recommended: 'A', why: FULL.why, blocks: FULL.blocks, urgent: true,
    status: 'open', at: NOW.toISOString(), answer: null, seq: 1,
  })
  expect(files.has(`${ROUND}/${entry.id}.json`)).toBe(true)
  expect(entry.id).toMatch(/^q-s-me-[a-z0-9]+-[a-z0-9]{4}$/)
  expect(answer.result).toContain(`Asked as ${entry.id}`)
  expect(answer.result).toContain('Write this block in your message as it stands')
  expect(answer.result).toContain(questionBlock(entry, { i: 1, n: 1 }))
  expect(shown).toEqual([])
  expect([...files.keys()].some(p => p.includes('.tmp-') || p.endsWith('.lock'))).toBe(false)
})

test('the block is the method\'s shape, from the fields alone', () => {
  const entry = { id: 'q-1', subject: 's', context: 'c', ask: 'q?', choices: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }], recommended: 'B', why: 'cheaper' } as Asked
  expect(questionBlock(entry, { i: 2, n: 3 })).toBe([
    '**Question 2 of 3** (q-1)', '_Subject_ : s', '_Context_ : c', '_Question_ : q?',
    '_Choices_ :', '- **A** : a', '- **B** : b', '_Free answer_ : or answer in your own words', '_Recommendation_ : B — cheaper',
  ].join('\n'))
})

test('a turn asks one question: a second call in it is refused and stores nothing, the first block stays the only one', async () => {
  const { dollar, files } = world()
  const first = await ask(dollar, FULL)
  const second = await ask(dollar, { ...FULL, subject: 'a second matter', urgent: undefined }, new Date(NOW.getTime() + 1))
  const [only, ...rest] = stored(files)
  expect(rest).toEqual([])
  expect([only?.status, only?.seq]).toEqual(['open', 1])
  expect(first.result).toContain(`Question 1 of 1** (${only?.id})`)
  expect(second.isError).toBe(true)
  expect(second.result).toContain(`this turn already asked ${only?.id}: one question per turn`)
  expect(second.result).not.toContain('Question 1 of 1')
})

test('the same question asked again in the turn is answered by its open twin, not refused', async () => {
  const { dollar, files } = world()
  const first = await ask(dollar, FULL)
  const again = await ask(dollar, FULL, new Date(NOW.getTime() + 1))
  expect(again.isError).toBeUndefined()
  expect(again.result).toContain(`already open as ${stored(files)[0]?.id}`)
  expect(first.result).toContain('Write this block in your message as it stands')
  expect(stored(files).length).toBe(1)
})

test('two calls made together in one turn store one: the place is taken before any write is awaited', async () => {
  const { dollar, files } = world()
  const calls = await Promise.all([ask(dollar, FULL), ask(dollar, { ...FULL, subject: 'a second matter' }, new Date(NOW.getTime() + 1))])
  expect(stored(files).length).toBe(1)
  expect(calls.map(call => call.isError === true).sort()).toEqual([false, true])
})

test('a call that stores nothing leaves the turn its question: a refused field or a failed write', async () => {
  const { dollar, files } = world()
  expect((await ask(dollar, { ...FULL, question: 'no question mark' })).isError).toBe(true)
  const write = dollar.process.run
  dollar.process.run = async (argv: readonly string[]) => (argv[0] === 'mv' ? { exitCode: 1, stdout: '', stderr: 'refused' } : write(argv))
  expect((await ask(dollar, FULL)).isError).toBe(true)
  dollar.process.run = write
  expect(stored(files)).toEqual([])
  const made = await ask(dollar, FULL)
  expect(made.isError).toBeUndefined()
  expect(made.result).toContain('Write this block in your message as it stands')
})

test('a later turn asks again, the first still open: each turn\'s block reads 1 of 1', async () => {
  const { dollar, files } = world()
  const heads: string[] = []
  const head = (answer: { readonly result: string }) => heads.push(String(/Question \d+ of \d+/.exec(String(answer.result))?.[0]))
  head(await ask(dollar, FULL))
  await mounted()['turn.start'](dollar, {}, async () => undefined)
  head(await ask(dollar, { ...FULL, subject: 'a later matter' }, new Date(NOW.getTime() + 1)))
  const [first, second] = pair(stored(files).sort((a, b) => (a.at < b.at ? -1 : 1)))
  expect([first.status, second.status]).toEqual(['open', 'open'])
  expect(heads).toEqual(['Question 1 of 1', 'Question 1 of 1'])
  // A subagent's turn is not the main thread's: it starts no new place.
  await mounted()['turn.start'](dollar, { agentId: 'a-1' }, async () => undefined)
  expect((await ask(dollar, { ...FULL, subject: 'a third matter' }, new Date(NOW.getTime() + 2))).isError).toBe(true)
  expect(stored(files).length).toBe(2)
})

test('an object ask stored is no entry of the relay\'s, and an entry of the relay\'s is no object of ask\'s', async () => {
  const { dollar, files } = world()
  await ask(dollar, FULL)
  const [text = ''] = [...files.entries()].filter(([p]) => p.startsWith(`${ROUND}/`)).map(([, t]) => t)
  expect(parseAsked(text)).not.toBeNull()
  expect(parseRoundEntry(text)).toBeNull()
  const old = JSON.stringify({ id: 'x', from: 'Orch: a', session: 's', kind: 'operator', since: 't', blocks: 'b', question: 'q', choices: [], recommendation: null, status: 'open', at: 't', answer: null })
  expect(parseRoundEntry(old)).not.toBeNull()
  expect(parseAsked(old)).toBeNull()
})

test('an invalid call stores nothing and shows nothing', async () => {
  const { dollar, files, shown } = world()
  const answer = await ask(dollar, { ...FULL, recommended: 'E' })
  expect(answer.isError).toBe(true)
  expect(stored(files)).toEqual([])
  expect(shown).toEqual([])
})

for (const [who, me] of [['an agent', ['agent', 'Agent: a1']], ['a session whose name is not known yet', null]] as const) {
  test(`${who} is refused, and told to ask the session that launched it`, async () => {
    const { dollar, files, shown } = world({ me: me as [string, string] | null })
    const answer = await ask(dollar, FULL)
    expect(answer.isError).toBe(true)
    expect(answer.result).toContain('an agent asks the session that launched it')
    expect(stored(files)).toEqual([])
    expect(shown).toEqual([])
  })
}

for (const role of ['coordinator', 'auditor']) {
  test(`${role === 'auditor' ? 'an' : 'a'} ${role} asks, named as its row names it`, async () => {
    const { dollar, files } = world({ me: [role, `${role === 'auditor' ? 'Audit' : 'Coord'}: acme [a1b2c3]`] })
    expect((await ask(dollar, FULL)).isError).toBeUndefined()
    expect(stored(files)[0]?.sender.role).toBe(role)
  })
}

// A woken orchestrator has no row in its first turn (the measure writes it when a turn ends), and a
// row written while the walk did not finish carries no name: the name the host holds answers.
for (const [when, options] of [
  ['in its first turn, no row written yet', { me: null, walk: 'Orch: acme', session: 's-first' }],
  ['after a turn whose measure could not name it', { me: ['orchestrator', 'Orch: acme'], bare: true, walk: 'Orch: acme', session: 's-bare' }],
] as const) {
  test(`a woken orchestrator asks ${when}, named as the host names it`, async () => {
    const { dollar, files } = world(options as Options)
    const answer = await ask(dollar, FULL)
    expect(answer.isError).toBeUndefined()
    expect(stored(files)[0]?.sender).toMatchObject({ role: 'orchestrator', name: 'Orch: acme' })
    expect(answer.result).toContain(`Question 1 of 1** (${stored(files)[0]?.id})`)
  })
}

for (const [who, options] of [
  ['an agent with no row yet', { me: null, walk: 'Agent: a1', session: 's-agent' }],
  ['an operator\'s session named by no role', { me: null, walk: 'Fix the login bug', session: 's-operator' }],
  ['a session whose walk finds nothing', { me: null, session: 's-nothing' }],
] as const) {
  test(`${who} is still refused: no keeper's name is known`, async () => {
    const { dollar, files } = world(options as Options)
    expect((await ask(dollar, FULL)).isError).toBe(true)
    expect(stored(files)).toEqual([])
  })
}

test('a row naming an agent is refused without a walk, whatever its host names', async () => {
  const { dollar, files } = world({ me: ['agent', 'Agent: a1'], walk: 'Orch: acme', session: 's-agent-row' })
  expect((await ask(dollar, FULL)).isError).toBe(true)
  expect(stored(files)).toEqual([])
})

test('a walk that does not finish is said in the log, and the question refused', async () => {
  const { dollar, files, logs } = world({ me: null, walk: 'Orch: acme', session: 's-unfinished' })
  const run = dollar.process.run
  dollar.process.run = async (argv: readonly string[]) => (argv[0] === 'sh' && String(argv[2]).startsWith('ps -o ppid=') ? Promise.reject(new Error('ps timed out')) : run(argv))
  expect((await ask(dollar, FULL)).isError).toBe(true)
  expect(stored(files)).toEqual([])
  expect(logs.join('\n')).toMatch(/own name not walked/)
})

test('an orchestrator asks as well, its question stored and shown', async () => {
  const { dollar, files } = world({ me: ['orchestrator', 'Orch: acme [a1b2c3]'] })
  const answer = await ask(dollar, FULL)
  expect(answer.isError).toBeUndefined()
  expect(stored(files)[0]?.sender.role).toBe('orchestrator')
  expect(answer.result).toContain(`Question 1 of 1** (${stored(files)[0]?.id})`)
})

// The operator's answer already recorded (§ 4.7 d): a question of the same project asking the same,
// answered by him in a tab, the pane or through the coordinator, is answered from it and not asked again.
test('a question its project already had answered is answered from the newest record, not asked again; a message or a withdrawal is no record', async () => {
  const fields = { ...FULL, urgent: undefined }
  const before = world()
  await ask(before.dollar, fields)
  const first = stored(before.files)[0]!
  const answered = (id: string, by: string, at: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ ...first, id, sender: { ...first.sender, session: 's-old' }, status: 'answered', answer: { text: `B from ${id}`, by, at, settler: 'x' }, ...over })
  const { dollar, files, shown } = world({
    files: {
      [`${ROUND}/q-old.json`]: answered('q-old', 'tab', '2026-11-10T10:00:00.000Z'),
      [`${ROUND}/archive/q-newer.json`]: answered('q-newer', 'coordinator', '2026-11-12T10:00:00.000Z'),
      [`${ROUND}/q-message.json`]: answered('q-message', 'message', '2026-11-13T10:00:00.000Z'),
      [`${ROUND}/q-moot.json`]: answered('q-moot', 'sender', '2026-11-13T11:00:00.000Z', { status: 'withdrawn' }),
      [`${ROUND}/q-other.json`]: answered('q-other', 'tab', '2026-11-13T12:00:00.000Z', { blocks: 'another thing' }),
    },
  })
  const answer = await ask(dollar, fields)
  const mine = stored(files).find(entry => entry.sender.session === 's-me')!
  expect(mine.status).toBe('answered')
  expect(mine.answer).toEqual({ text: 'B from q-newer', by: 'coordinator', at: '2026-11-12T10:00:00.000Z', settler: 'Coord: general [a1b2c3]', record: 'q-newer' })
  expect(answer.result).toContain('Answered from the record, not asked again')
  expect(answer.result).toContain('B from q-newer')
  expect(shown).toEqual([])
})

// An identical question still open in the round is not stored a second time: the call answers with
// the entry already there and says it is not to be written again.
test('a question identical to one still open stores nothing: the open entry\'s id and block come back, to be written no more', async () => {
  const fields = { ...FULL, urgent: undefined }
  const { dollar, files, shown } = world()
  const first = await ask(dollar, fields)
  const open = stored(files)[0]!
  // Asked again later, by a successor's session: the same project, so the same question.
  const later = world({ files: Object.fromEntries(files), session: 's-successor' })
  const again = await ask(later.dollar, fields, new Date(NOW.getTime() + 60_000))
  expect(again.isError).toBeUndefined()
  expect(stored(later.files).length).toBe(1)
  expect(stored(later.files)[0]).toEqual(open)
  expect(first.result).toContain('Write this block in your message as it stands')
  expect(again.result).toContain(`already open as ${open.id}`)
  expect(again.result).toContain('do not write it again in the chat')
  expect(again.result).toContain(questionBlock(open, { i: 1, n: 1 }))
  expect(again.result).not.toContain('Write this block in your message as it stands')
  expect(shown).toEqual([])
  // The same session asking it again, in a later turn, is no other.
  const twice = await ask(dollar, fields, new Date(NOW.getTime() + 1))
  expect(stored(files).length).toBe(1)
  expect(twice.result).toContain(`already open as ${open.id}`)
})

test('a question that differs by one field, or whose twin is withdrawn or answered by a message, is stored as a new entry', async () => {
  const fields = { ...FULL, urgent: undefined }
  const before = world()
  await ask(before.dollar, fields)
  const first = stored(before.files)[0]!
  const twin = (id: string, over: Record<string, unknown>) => JSON.stringify({ ...first, id, sender: { ...first.sender, session: 's-old' }, ...over })
  const answer = { text: 'B', by: 'message', at: '2026-11-13T10:00:00.000Z', settler: 'x' }
  const { dollar, files } = world({
    files: {
      [`${ROUND}/q-withdrawn.json`]: twin('q-withdrawn', { status: 'withdrawn', answer: { ...answer, by: 'sender' } }),
      [`${ROUND}/q-message.json`]: twin('q-message', { status: 'answered', answer }),
      [`${ROUND}/q-other-project.json`]: twin('q-other-project', { sender: { ...first.sender, session: 's-old', name: 'Coord: another' } }),
      // Open, but a replica of another machine's question, or claimed by the words he typed: neither is a twin.
      [`${ROUND}/q-replica.json`]: twin('q-replica', { origin: { machine: 'box-2', address: 'box-2.local' } }),
      [`${ROUND}/q-claimed.json`]: twin('q-claimed', { claimed: { typed: 'let me think', at: '2026-11-13T10:00:00.000Z' } }),
    },
  })
  const same = await ask(dollar, fields)
  expect(same.result).toContain('Write this block in your message as it stands')
  expect(stored(files).filter(entry => entry.sender.session === 's-me').map(entry => entry.status)).toEqual(['open'])
  // A different key, now that an open entry exists, asked in a later turn: another entry, not the first's.
  askTurnStarted()
  const other = await ask(dollar, { ...fields, question: 'Which one merges last?' }, new Date(NOW.getTime() + 1))
  expect(other.result).toContain('Write this block in your message as it stands')
  expect(stored(files).filter(entry => entry.sender.session === 's-me').length).toBe(2)
})

test('an open twin does not hold back an answered record: the record still answers the new question', async () => {
  const fields = { ...FULL, urgent: undefined }
  const before = world()
  await ask(before.dollar, fields)
  const first = stored(before.files)[0]!
  const { dollar, files } = world({
    files: {
      [`${ROUND}/q-open.json`]: JSON.stringify({ ...first, id: 'q-open', sender: { ...first.sender, session: 's-old' } }),
      [`${ROUND}/q-done.json`]: JSON.stringify({ ...first, id: 'q-done', sender: { ...first.sender, session: 's-old' }, status: 'answered', answer: { text: 'b', by: 'pane', at: '2026-11-12T10:00:00.000Z', settler: 'x' } }),
    },
  })
  const answer = await ask(dollar, fields)
  expect(answer.result).toContain('Answered from the record, not asked again')
  expect(stored(files).find(entry => entry.sender.session === 's-me')?.status).toBe('answered')
})

test('words typed in a tab are a record only when they name one choice: free prose newer than a lettered answer is passed over', async () => {
  const fields = { ...FULL, urgent: undefined }
  const before = world()
  await ask(before.dollar, fields)
  const first = stored(before.files)[0]!
  const typed = (id: string, text: string, at: string) =>
    JSON.stringify({ ...first, id, sender: { ...first.sender, session: 's-old' }, status: 'answered', answer: { text, by: 'tab', at, settler: 'x' } })
  const { dollar, files } = world({
    files: {
      [`${ROUND}/q-lettered.json`]: typed('q-lettered', 'b', '2026-11-10T10:00:00.000Z'),
      [`${ROUND}/q-prose.json`]: typed('q-prose', 'hold on, look at the logs first', '2026-11-12T10:00:00.000Z'),
    },
  })
  await ask(dollar, fields)
  const mine = stored(files).find(entry => entry.sender.session === 's-me')!
  expect(mine.answer).toMatchObject({ text: 'b', by: 'tab', record: 'q-lettered' })
})

// His answer typed in the asker's own tab (§ 4.3): the prompt claims its open questions, which leave
// the pane at once; the turn's end answers each with his words, unless its operator wait keeps it.
test('a prompt he types claims the asker\'s open questions; the turn\'s end answers them with his words, but those its wait keeps', async () => {
  const { dollar, files } = world()
  await ask(dollar, { ...FULL, urgent: undefined })
  askTurnStarted()
  await ask(dollar, { ...FULL, urgent: undefined, subject: 'tag order' })
  const [first, second] = pair(stored(files).sort((a, b) => (a.subject < b.subject ? -1 : 1)))
  // A model's own prompt, or a command, claims nothing.
  expect(await claimAsked(dollar, 'model', 'B')).toEqual([])
  expect(await claimAsked(dollar, 'composer', '/compact')).toEqual([])
  expect((await claimAsked(dollar, 'composer', '  B, and tag it after  ', NOW)).sort()).toEqual([first.id, second.id].sort())
  expect(stored(files).every(entry => entry.status === 'open' && entry.claimed?.typed === 'B, and tag it after')).toBe(true)
  expect(askedGroups(stored(files))).toEqual([])
  await settleClaimed(dollar, [second.id], new Date('2026-11-14T15:01:00Z'))
  const after = new Map(stored(files).map(entry => [entry.id, entry]))
  expect(after.get(first.id)).toMatchObject({ status: 'answered', answer: { text: 'B, and tag it after', by: 'tab', at: '2026-11-14T15:01:00.000Z', settler: 'Coord: general [a1b2c3]' } })
  expect(after.get(first.id)!.claimed).toBeUndefined()
  expect(after.get(second.id)).toMatchObject({ status: 'open' })
  expect(after.get(second.id)!.claimed).toBeUndefined()
})

// The kept question's reopening is written first; when that write fails it stays claimed, and the
// close that follows still leaves it: the wait keeps it, his words answer it at no turn's end.
test('a question the wait keeps whose reopening cannot be written is never answered by the turn\'s end', async () => {
  const { dollar, files, logs } = world()
  await ask(dollar, { ...FULL, urgent: undefined })
  const kept = stored(files)[0]!
  await claimAsked(dollar, 'composer', 'B', NOW)
  const run = dollar.process.run
  let refused = 0
  dollar.process.run = async (argv: readonly string[]) => {
    if (argv[0] === 'mv' && argv[3] === `${ROUND}/${kept.id}.json` && refused++ === 0) return { exitCode: 1, stdout: '', stderr: 'refused' }
    return run(argv)
  }
  await settleClaimed(dollar, [kept.id], new Date('2026-11-14T15:01:00Z'))
  expect(stored(files)[0]).toMatchObject({ status: 'open', claimed: { typed: 'B' } })
  expect(logs.some(line => line.includes(`${kept.id} answered in its asker's tab`))).toBe(false)
})

test('a consent question answered « Accorder » in the asker\'s tab is recorded as that consent; other words record none', async () => {
  const consent = { consent_kind: 'auto-merge', consent_repo: 'acme/app', choice_a: 'Accorder', choice_b: 'Refuser', choice_c: undefined, recommended: 'A' }
  const records = async (typed: string) => {
    const { dollar, files } = world()
    await ask(dollar, { ...FULL, urgent: undefined, ...consent })
    await claimAsked(dollar, 'composer', typed, NOW)
    await settleClaimed(dollar, [], NOW)
    return [...files.keys()].filter(p => p.includes('/consents/acme/app/'))
  }
  expect((await records('A')).length).toBe(1)
  expect((await records('let me think')).length).toBe(0)
})

test('words around « Accorder » typed in any session\'s own tab record no consent: the question is answered by its letter', async () => {
  const consent = { consent_kind: 'auto-merge', consent_repo: 'acme/app', choice_a: 'Accorder', choice_b: 'Refuser', choice_c: undefined, recommended: 'A' }
  const records = async (me: [string, string], typed: string) => {
    const { dollar, files } = world({ me })
    await ask(dollar, { ...FULL, urgent: undefined, ...consent })
    await claimAsked(dollar, 'composer', typed, NOW)
    await settleClaimed(dollar, [], NOW)
    return [...files.entries()].filter(([p]) => p.includes('/consents/acme/app/')).map(([, text]) => JSON.parse(text).answer)
  }
  for (const me of [['coordinator', 'Coord: general [a1b2c3]'], ['orchestrator', 'Orch: belt [a1b2c3]']] as [string, string][]) {
    expect(await records(me, 'A')).toEqual(['Accorder'])
    expect(await records(me, 'Accorder')).toEqual(['Accorder'])
    expect(await records(me, 'Accorder la dispense et fusionner, merci')).toEqual([])
    expect(await records(me, "Ok Accorder pour l'auto-merge !!! \n\nLAnce le push forcé go !")).toEqual([])
    expect(await records(me, 'Accorder ?')).toEqual([])
    expect(await records(me, 'Refuser')).toEqual([])
    expect(await records(me, 'Accorder pour acme/other')).toEqual([])
  }
})

test('words cut at the cap grant nothing, whatever their first line says: the tail was never read', async () => {
  const consent = { consent_kind: 'auto-merge', consent_repo: 'acme/app', choice_a: 'Accorder', choice_b: 'Refuser', choice_c: undefined, recommended: 'A' }
  const { dollar, files } = world({ me: ['coordinator', 'Coord: general [a1b2c3]'] })
  await ask(dollar, { ...FULL, urgent: undefined, ...consent })
  const long = `Accorder l'auto-merge !\n\n${'Lance le push forcé et range les logs. '.repeat(14)}\nMais seulement si la CI est verte, sinon annule tout.`
  expect(long.length).toBeGreaterThan(500)
  await claimAsked(dollar, 'composer', long, NOW)
  expect(stored(files)[0]?.claimed?.typed).toMatch(/\[cut at 500 of \d+ characters\]$/)
  await settleClaimed(dollar, [], NOW)
  expect(stored(files)[0]).toMatchObject({ status: 'answered' })
  expect([...files.keys()].filter(p => p.includes('/consents/acme/app/'))).toEqual([])
})

test('his words typed in place of a choice answer the entry whole, which its asker reads, and record no consent', async () => {
  const consent = { consent_kind: 'auto-merge', consent_repo: 'acme/app', choice_a: 'Accorder', choice_b: 'Refuser', choice_c: undefined, recommended: 'A' }
  const { dollar, files } = world({ me: ['orchestrator', 'Orch: belt [a1b2c3]'] })
  await ask(dollar, { ...FULL, urgent: undefined, ...consent })
  const typedWords = "Ok Accorder pour l'auto-merge !!!\n\nLAnce le push forcé go !"
  await claimAsked(dollar, 'composer', typedWords, NOW)
  await settleClaimed(dollar, [], NOW)
  expect(stored(files)[0]).toMatchObject({ status: 'answered', answer: { text: typedWords, by: 'tab' } })
  expect([...files.keys()].filter(p => p.includes('/consents/acme/app/')).length).toBe(0)
})

test('a subagent\'s call is refused', async () => {
  const { dollar, files } = world()
  expect((await ask(dollar, { ...FULL, agentId: 'agent-1' })).isError).toBe(true)
  expect(stored(files)).toEqual([])
})

test('an id is safe as a file name and differs by instant and draw', () => {
  expect(askId('a/b c', NOW, 0)).toBe(`q-a_b_c-${NOW.getTime().toString(36)}-0000`)
  expect(askId('s', NOW, 0.5)).not.toBe(askId('s', NOW, 0.25))
})

// --- registration -------------------------------------------------------------------------------

function mounted() {
  const hooks = capture(registerQuestion)
  const tool = `mcp__orchestrator__${ASK_TOOL}`
  return {
    'session.start': (dollar: Host<Noun>, e: Events['session.start'], next: Next<Events['session.start']>) => hookOf(hooks, 'session.start', {}).handler(dollar, e, next),
    'turn.start': (dollar: Host<Noun>, e: Events['turn.start'], next: Next<Events['turn.start']>) => hookOf(hooks, 'turn.start', {}).handler(dollar, e, next),
    'prompt.submit': (dollar: Host<Noun>, e: Events['prompt.submit'], next: Next<Events['prompt.submit']>) => hookOf(hooks, 'prompt.submit', {}).handler(dollar, e, next),
    'turn.complete': (dollar: Host<Noun>, e: Events['turn.complete'], next: Next<Events['turn.complete']>) => hookOf(hooks, 'turn.complete', {}).handler(dollar, e, next),
    // The tool's hook answers the call itself: nothing beneath it is called.
    [`tool.call:${tool}`]: (dollar: Host<Noun>, e: Events['tool.call']) => hookOf(hooks, 'tool.call', { tool }).handler(dollar, e, async () => { throw new Error('the tool calls nothing beneath') }),
  }
}

test('the tool is registered with flat fields only, and answers its calls', async () => {
  const { dollar, files } = world()
  const registered: ToolSpec[] = []
  dollar.tool.register = async (spec: ToolSpec) => { registered.push(spec) }
  const handlers = mounted()
  await handlers['session.start'](dollar, { cwd: '/w' }, async () => undefined)
  expect(registered.map(spec => spec.name)).toEqual([ASK_TOOL])
  const properties = fieldsOf(registered[0]?.inputSchema?.['properties']) ?? {}
  expect(Object.values(properties).every(p => fieldsOf(p)?.['type'] !== 'object' && fieldsOf(p)?.['type'] !== 'array')).toBe(true)
  expect(Object.keys(properties).sort()).toEqual(['blocks', 'choice_a', 'choice_b', 'choice_c', 'choice_d', 'choice_e', 'consent_env', 'consent_kind', 'consent_pr', 'consent_repo', 'context', 'question', 'recommended', 'subject', 'urgent', 'why'])
  await handlers[`tool.call:mcp__orchestrator__${ASK_TOOL}`](dollar, FULL)
  expect(stored(files).length).toBe(1)
})

test('his prompt in the tab claims through the hook, and the turn\'s end answers, keeping what its declared operator wait waits on', async () => {
  const { dollar, files } = world()
  await ask(dollar, { ...FULL, urgent: undefined })
  const entry = stored(files)[0]!
  const handlers = mounted()
  const next = async (x: unknown) => x
  await handlers['prompt.submit'](dollar, { origin: { kind: 'composer' }, text: 'B' }, next)
  expect(stored(files)[0]?.claimed?.typed).toBe('B')
  DECLARATIONS.turnStarted()
  DECLARATIONS.declare({ kind: 'operator', blocks: entry.blocks, asked: [entry.id] })
  await handlers['turn.complete'](dollar, { reason: 'answer', answer: 'Noted.' }, next)
  expect(stored(files)[0]).toMatchObject({ status: 'open' })
  expect(stored(files)[0]?.claimed).toBeUndefined()
  await handlers['prompt.submit'](dollar, { origin: { kind: 'composer' }, text: 'B' }, next)
  DECLARATIONS.turnStarted()
  await handlers['turn.complete'](dollar, { reason: 'answer', answer: 'Merging acme/app#2 first.' }, next)
  expect(stored(files)[0]).toMatchObject({ status: 'answered', answer: { text: 'B', by: 'tab' } })
})

// --- the pane's lines ---------------------------------------------------------------------------

const asked = (session: string, name: string, at: string, over: Partial<Asked> = {}): Asked => ({
  v: ASK_VERSION, id: `q-${session}-${at}`, sender: { session, name, role: 'orchestrator', machine: 'box-1' },
  subject: `subject of ${at}`, context: 'what is known', ask: 'Which?', choices: [{ letter: 'A', text: 'one' }, { letter: 'B', text: 'two' }],
  recommended: 'B', why: 'cheaper', blocks: 'acme/app#1', status: 'open', at, answer: null, seq: 1, ...over,
})

test('the open questions are grouped by asker, the askers with an urgent one first, each group\'s urgent first, then in the order asked', () => {
  const entries = [
    asked('s1', 'Orch: one', '2026-11-14T10:00:00Z'),
    asked('s2', 'Orch: two', '2026-11-14T10:01:00Z'),
    asked('s1', 'Orch: one', '2026-11-14T10:02:00Z'),
    asked('s3', 'Audit: three', '2026-11-14T10:03:00Z', { urgent: true }),
    asked('s2', 'Orch: two', '2026-11-14T10:04:00Z', { status: 'answered' }),
    asked('s2', 'Orch: two', '2026-11-14T10:05:00Z', { urgent: true }),
  ]
  expect(askedGroups(entries).map(group => group.map(entry => entry.id))).toEqual([
    ['q-s3-2026-11-14T10:03:00Z'],
    ['q-s2-2026-11-14T10:05:00Z', 'q-s2-2026-11-14T10:01:00Z'],
    ['q-s1-2026-11-14T10:00:00Z', 'q-s1-2026-11-14T10:02:00Z'],
  ])
})

test('the pane draws one question only, the first in its order: its asker once, then its fields, the recommended choice marked, no numbering', () => {
  const lines = askedLines([
    asked('s1', 'Orch: one', '2026-11-14T10:00:00Z'),
    asked('s1', 'Orch: one', '2026-11-14T10:02:00Z', { choices: [], recommended: null, why: null, urgent: true }),
  ])
  expect(lines).toEqual([
    { text: 'Orch: one · orchestrator · box-1', look: 'asker', indent: 0 },
    { text: 'Urgent — subject of 2026-11-14T10:02:00Z', look: 'subject', indent: 2 },
    { text: 'what is known', look: 'context', indent: 4 },
    { text: 'Which?', look: 'question', indent: 4 },
    { text: 'Blocks: acme/app#1', look: 'label', indent: 4 },
  ])
  expect(askedLines([asked('s1', 'Orch: one', '2026-11-14T10:00:00Z')]).slice(4)).toEqual([
    { text: '[A] one', look: 'choice', indent: 4 },
    { text: '[B] two  ★', look: 'recommended', indent: 4 },
    { text: '★ Recommendation: B — cheaper', look: 'plain', indent: 4 },
    { text: 'Blocks: acme/app#1', look: 'label', indent: 4 },
  ])
  expect(askedLines([])).toEqual([])
})

test('of three open questions from two askers, the later asker\'s one urgent, the pane draws the urgent one, then the earliest of the rest once it is closed', () => {
  const entries = [
    asked('s1', 'Orch: one', '2026-11-14T10:00:00Z'),
    asked('s1', 'Orch: one', '2026-11-14T10:02:00Z'),
    asked('s2', 'Orch: two', '2026-11-14T10:03:00Z', { urgent: true }),
  ]
  const drawn = (list: readonly Asked[]) => askedLines(list).filter(line => line.look === 'subject' || line.look === 'asker').map(line => line.text)
  expect(drawn(entries)).toEqual(['Orch: two · orchestrator · box-1', 'Urgent — subject of 2026-11-14T10:03:00Z'])
  const settled = entries.map(entry => (entry.urgent ? { ...entry, status: 'answered' as const } : entry))
  expect(drawn(settled)).toEqual(['Orch: one · orchestrator · box-1', 'subject of 2026-11-14T10:00:00Z'])
})
