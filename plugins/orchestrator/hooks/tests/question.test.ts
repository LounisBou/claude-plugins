// hooks/tests/question.test.ts
// The `ask` tool over a faked $: the call's flat fields validated against the method's question
// format, one object stored in the round per call with the module's own id, the asker and a format
// version that the relay's entries do not carry, its block written to the transcript by the module;
// and the lines the pane draws from those objects, grouped by asker.
import { expect, test } from 'claude-code/testing'
import { ASK_TOOL, ASK_VERSION, askTurnStarted, askedGroups, askedLines, askId, callAsk, parseAsk, parseAsked, questionBlock, shownLines, register as registerQuestion, type Asked } from '../question.ts'
import { parseRoundEntry } from '../supervision.ts'
import { logLineOf, lockRun } from './fakes.ts'

const HOME = '/tmp/ask-home'
const MODULE = `${HOME}/.claude/claude-orchestrator`
const ROUND = `${MODULE}/round`
const NOW = new Date('2026-11-14T15:00:00Z')

const row = (role: string, name: string) =>
  JSON.stringify({ role, name, repo: null, context_percent: 1, context_tokens: 1, window: 100, model: 'm', busy: false, updated_at: new Date().toISOString() })

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

type Options = { me?: [role: string, name: string] | null; logThrows?: string; files?: Record<string, string> }

function world(options: Options = {}) {
  // Each world is a fresh turn of the main thread: the questions it asks are numbered from one.
  askTurnStarted()
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  const me = options.me === undefined ? ['coordinator', 'Coord: general [a1b2c3]'] : options.me
  if (me !== null) files.set(`${MODULE}/store/sessions/s-me`, row(me[0], me[1]))
  const shown: string[] = []
  const logs: string[] = []
  const dollar: any = {
    plugin: { name: 'orchestrator', root: '/plugins/orch' },
    env: { get: async (key: string) => (key === 'HOME' ? HOME : undefined) },
    session: { id: async () => 's-me' },
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
        if (argv[0] === 'hostname') return { exitCode: 0, stdout: 'box-1.local\n', stderr: '' }
        if (argv[0] === 'mv') { files.set(argv[3], files.get(argv[2])!); files.delete(argv[2]) }
        if (argv[0] === 'rm') for (const p of argv.slice(2)) files.delete(p)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  }
  return { dollar, files, shown, logs }
}

const stored = (files: Map<string, string>): Asked[] =>
  [...files.entries()].filter(([p]) => p.startsWith(`${ROUND}/`) && p.endsWith('.json')).map(([, text]) => JSON.parse(text) as Asked)

const ask = (dollar: any, input: Record<string, unknown>, now = NOW) => callAsk(dollar, { tool: `mcp__orchestrator__${ASK_TOOL}`, ...input }, now)

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
  const [entry] = stored(files)
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
  expect(answer.result).toContain('Do not write it again')
  expect(shown).toEqual(shownLines(questionBlock(entry, { i: 1, n: 1 })))
  expect(shown[0]).toBe(`Question 1 of 1 (${entry.id})`)
  expect(shown).toContain('- A : acme/app#1 first — cost: none — gain: no rebase')
  expect([...files.keys()].some(p => p.includes('.tmp-') || p.endsWith('.lock'))).toBe(false)
})

test('the block is the method\'s shape, from the fields alone', () => {
  const entry = { id: 'q-1', subject: 's', context: 'c', ask: 'q?', choices: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }], recommended: 'B', why: 'cheaper' } as Asked
  expect(questionBlock(entry, { i: 2, n: 3 })).toBe([
    '**Question 2 of 3** (q-1)', '_Subject_ : s', '_Context_ : c', '_Question_ : q?',
    '_Choices_ :', '- **A** : a', '- **B** : b', '_Free answer_ : or answer in your own words', '_Recommendation_ : B — cheaper',
  ].join('\n'))
})

test('several calls in one turn make several objects, each its own id, numbered among the asker\'s open questions', async () => {
  const { dollar, files, shown } = world()
  await ask(dollar, FULL)
  await ask(dollar, { ...FULL, subject: 'a second matter', urgent: undefined }, new Date(NOW.getTime() + 1))
  const entries = stored(files)
  expect(entries.length).toBe(2)
  expect(new Set(entries.map(entry => entry.id)).size).toBe(2)
  expect(entries.every(entry => entry.status === 'open' && entry.seq === 1)).toBe(true)
  expect(shown.filter(line => /^Question \d+ of \d+/.test(line))).toEqual([`Question 1 of 1 (${entries[0].id})`, `Question 2 of 2 (${entries[1].id})`])
})

test('an object ask stored is no entry of the relay\'s, and an entry of the relay\'s is no object of ask\'s', async () => {
  const { dollar, files } = world()
  await ask(dollar, FULL)
  const [text] = [...files.entries()].filter(([p]) => p.startsWith(`${ROUND}/`)).map(([, t]) => t)
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
    expect(stored(files)[0].sender.role).toBe(role)
  })
}

test('an orchestrator asks as well, its question stored and shown', async () => {
  const { dollar, files, shown } = world({ me: ['orchestrator', 'Orch: acme [a1b2c3]'] })
  expect((await ask(dollar, FULL)).isError).toBeUndefined()
  expect(stored(files)[0].sender.role).toBe('orchestrator')
  expect(shown[0]).toBe(`Question 1 of 1 (${stored(files)[0].id})`)
})

test('« Question i of N » counts this turn\'s questions only: one asked in a later turn reads 1 of 1, whatever stays open', async () => {
  const { dollar, files, shown } = world()
  await ask(dollar, FULL)
  await mounted()['turn.start'](dollar, {}, async () => undefined)
  await ask(dollar, { ...FULL, subject: 'a later matter' }, new Date(NOW.getTime() + 1))
  const [first, second] = stored(files).sort((a, b) => (a.at < b.at ? -1 : 1))
  expect([first.status, second.status]).toEqual(['open', 'open'])
  expect(shown.filter(line => /^Question \d+ of \d+/.test(line))).toEqual([`Question 1 of 1 (${first.id})`, `Question 1 of 1 (${second.id})`])
  // A subagent's turn is not the main thread's: it starts no count.
  await ask(dollar, { ...FULL, subject: 'a third matter' }, new Date(NOW.getTime() + 2))
  await mounted()['turn.start'](dollar, { agentId: 'a-1' }, async () => undefined)
  await ask(dollar, { ...FULL, subject: 'a fourth matter' }, new Date(NOW.getTime() + 3))
  expect(shown.filter(line => /^Question \d+ of \d+/.test(line)).slice(2).map(line => line.slice(0, 14))).toEqual(['Question 2 of ', 'Question 3 of '])
})

test('a subagent\'s call is refused', async () => {
  const { dollar, files } = world()
  expect((await ask(dollar, { ...FULL, agentId: 'agent-1' })).isError).toBe(true)
  expect(stored(files)).toEqual([])
})

test('a transcript that refuses the block keeps the object and hands the block to the model, logged', async () => {
  const { dollar, files, logs } = world({ logThrows: 'no transcript' })
  const answer = await ask(dollar, FULL)
  const [entry] = stored(files)
  expect(answer.result).toContain(questionBlock(entry, { i: 1, n: 1 }))
  expect(answer.result).toContain('write it in your message')
  expect(logs.some(line => line.includes(`question ${entry.id} stored, its block not written to the transcript: no transcript`))).toBe(true)
})

test('an id is safe as a file name and differs by instant and draw', () => {
  expect(askId('a/b c', NOW, 0)).toBe(`q-a_b_c-${NOW.getTime().toString(36)}-0000`)
  expect(askId('s', NOW, 0.5)).not.toBe(askId('s', NOW, 0.25))
})

// --- registration -------------------------------------------------------------------------------

function mounted() {
  const handlers: Record<string, Function> = {}
  const on = (event: string, ...rest: any[]) => {
    const [matcher, handler] = rest.length === 2 ? rest : [{}, rest[0]]
    handlers[`${event}${matcher.tool ? `:${matcher.tool}` : ''}`] = handler
    return { catch: () => undefined }
  }
  registerQuestion(on as any)
  return handlers
}

test('the tool is registered with flat fields only, and answers its calls', async () => {
  const { dollar, files } = world()
  const registered: any[] = []
  dollar.tool = { register: async (spec: unknown) => { registered.push(spec) } }
  const handlers = mounted()
  await handlers['session.start'](dollar, { cwd: '/w' }, async () => undefined)
  expect(registered.map(spec => spec.name)).toEqual([ASK_TOOL])
  const properties = registered[0].inputSchema.properties
  expect(Object.values(properties).every((p: any) => p.type !== 'object' && p.type !== 'array')).toBe(true)
  expect(Object.keys(properties).sort()).toEqual(['blocks', 'choice_a', 'choice_b', 'choice_c', 'choice_d', 'choice_e', 'consent_env', 'consent_kind', 'consent_pr', 'consent_repo', 'context', 'question', 'recommended', 'subject', 'urgent', 'why'])
  await handlers[`tool.call:mcp__orchestrator__${ASK_TOOL}`](dollar, FULL)
  expect(stored(files).length).toBe(1)
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

test('the pane draws each asker once, then each question\'s fields, the recommended choice marked', () => {
  const lines = askedLines([
    asked('s1', 'Orch: one', '2026-11-14T10:00:00Z'),
    asked('s1', 'Orch: one', '2026-11-14T10:02:00Z', { choices: [], recommended: null, why: null, urgent: true }),
  ])
  expect(lines).toEqual([
    { text: 'Orch: one · orchestrator · box-1', look: 'asker', indent: 0 },
    { text: 'Urgent — Question 1 of 2: subject of 2026-11-14T10:02:00Z', look: 'subject', indent: 2 },
    { text: 'what is known', look: 'context', indent: 4 },
    { text: 'Which?', look: 'question', indent: 4 },
    { text: 'Blocks: acme/app#1', look: 'label', indent: 4 },
    { text: 'Question 2 of 2: subject of 2026-11-14T10:00:00Z', look: 'subject', indent: 2 },
    { text: 'what is known', look: 'context', indent: 4 },
    { text: 'Which?', look: 'question', indent: 4 },
    { text: '[A] one', look: 'choice', indent: 4 },
    { text: '[B] two  ★', look: 'recommended', indent: 4 },
    { text: '★ Recommendation: B — cheaper', look: 'plain', indent: 4 },
    { text: 'Blocks: acme/app#1', look: 'label', indent: 4 },
  ])
})
