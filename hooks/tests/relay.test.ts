// hooks/tests/relay.test.ts
// An orchestrator's end of turn read by the module (relay.ts, wired in supervision.ts):
// the machine line parsed into the row's wait fields, one entry in the round of a
// coordinator on this machine per wait, one report to a coordinator on another, none
// twice, none without a coordinator, none from a session that is no orchestrator, and a
// write or a send that fails never holding the turn's end.
import { expect, test } from 'claude-code/testing'
import { parseWait, waitPatch, fingerprint, relayText, coordinatorOf, waitLabel, waitParts, heldQuestion, withdrawalText, RELAY_CAP } from '../relay.ts'
import { roundEntry, type RoundEntry } from '../round.ts'
import { parseSessionRow, paneRows, withWait, writeSession, readSessions, type SessionRow } from '../supervision.ts'
import { register } from '../register.ts'
import { logLineOf } from './fakes.ts'

const HOME = '/tmp/h'
const ROW = `${HOME}/.claude/claude-orchestrator/store/sessions/s-one`
const WAIT = `${HOME}/.claude/claude-orchestrator/store/waits/s-one`
const RECORD = `${HOME}/.claude/claude-orchestrator/coordinator.json`
const LEARNT = `${HOME}/.claude/claude-orchestrator/store/coordinator-learnt`
const ROUND = `${HOME}/.claude/claude-orchestrator/round`
const QUESTION = 'Question 1 of 1 — merge the scraper pull request now?\n_Context._ It is green.'

function answerOf(question: string, line: string): string {
  return `${question}\n\n${line}\n`
}

// --- the pure half ------------------------------------------------------------------------

test('the machine line parses into a wait: the operator with what it blocks, or done', () => {
  expect(parseWait(answerOf(QUESTION, 'waiting: operator — blocks: phase 3'))).toEqual({ kind: 'operator', blocks: 'phase 3', question: QUESTION })
  expect(parseWait(answerOf('All merged.', '**waiting: done**'))).toEqual({ kind: 'done', question: 'All merged.' })
  expect(parseWait('waiting: operator - blocks: the merge')).toEqual({ kind: 'operator', blocks: 'the merge', question: '' })
  expect(parseWait('I keep working on phase 2.')).toBeNull()
  expect(parseWait('')).toBeNull()
})

test('the row fields: the wait since now, kept while the same wait lasts', () => {
  const wait = parseWait(answerOf(QUESTION, 'waiting: operator — blocks: phase 3'))!
  const first = waitPatch(null, wait, '2026-10-14T10:00:00.000Z')
  expect(first).toEqual({ waiting: 'operator', blocks: 'phase 3', waiting_since: '2026-10-14T10:00:00.000Z' })
  const row = { ...first } as SessionRow
  expect(waitPatch(row, wait, '2026-10-14T10:05:00.000Z').waiting_since).toBe('2026-10-14T10:00:00.000Z')
  const other = parseWait(answerOf(QUESTION, 'waiting: operator — blocks: phase 4'))!
  expect(waitPatch(row, other, '2026-10-14T10:05:00.000Z').waiting_since).toBe('2026-10-14T10:05:00.000Z')
})

test('the fingerprint is the wait and its line, never the progress written above it', () => {
  const a = parseWait(answerOf(QUESTION, 'waiting: operator — blocks: phase 3'))!
  const b = parseWait(answerOf('The review of #12 has started.', 'waiting: operator — blocks: phase 3'))!
  const c = parseWait(answerOf(QUESTION, 'waiting: operator — blocks: phase 4'))!
  expect(fingerprint(a)).toBe(fingerprint(b))
  expect(fingerprint(a)).not.toBe(fingerprint(c))
  expect(fingerprint({ kind: 'delivered', blocks: 'PR #12', question: 'head abc' }))
    .not.toBe(fingerprint({ kind: 'delivered', blocks: 'PR #12', question: 'head def' }))
})

test('the report: a header naming the session and its wait, then the question, cut past the cap and said', () => {
  const wait = parseWait(answerOf(QUESTION, 'waiting: operator — blocks: phase 3'))!
  expect(relayText('Orch : belt', wait, '2026-10-14T10:00:00.000Z')).toBe(
    `[module] Orch : belt waits for the operator since 2026-10-14T10:00:00.000Z — blocks: phase 3\nreply with SendMessage to: Orch : belt\n\n${QUESTION}`)
  const long = parseWait(answerOf('x'.repeat(RELAY_CAP + 10), 'waiting: operator — blocks: phase 3'))!
  const text = relayText('Orch : belt', long, 'T')
  expect(text).toContain(`[cut at ${RELAY_CAP} of ${RELAY_CAP + 10} characters]`)
  expect(text.length).toBeLessThan(RELAY_CAP + 200)
  expect(relayText('Orch : belt', { kind: 'done', question: 'x' }, 'T')).toBe('[module] Orch : belt reports its work done and proposes to be closed\nreply with SendMessage to: Orch : belt')
})

test('the coordinator is read from its record, and no record names nobody', () => {
  expect(coordinatorOf('{"name":"Coord : ops [abc]","tty":"/dev/ttys1"}')).toBe('Coord : ops [abc]')
  expect(coordinatorOf('')).toBeNull()
  expect(coordinatorOf('{"tty":"/dev/ttys1"}')).toBeNull()
})

test('the pane and status label carry the wait', () => {
  const since = '2026-10-14T10:07:00.000Z'
  const at = new Date(since)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const row = { role: 'orchestrator', name: 'Orch : belt', repo: null, context_percent: 20, context_tokens: 1, window: 100, model: 'a-model',
    busy: false, updated_at: new Date().toISOString(), waiting: 'operator', blocks: 'phase 3', waiting_since: since } as SessionRow
  expect(waitLabel(row)).toBe(`waiting for the operator since ${hhmm} — blocks: phase 3`)
  expect(paneRows({ a: row })[0].label).toContain(`waiting for the operator since ${hhmm} — blocks: phase 3`)
  expect(waitLabel({ ...row, waiting: 'done' })).toBe(`done since ${hhmm}, proposes to be closed`)
  expect(waitLabel({ ...row, waiting: null })).toBeNull()
})

test('the wait is split at its source: the status words and what it blocks, joined back by the label', () => {
  const since = '2026-10-14T10:07:00.000Z'
  const at = new Date(since)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const row = { role: 'orchestrator', name: 'Orch : belt', repo: null, context_percent: 20, context_tokens: 1, window: 100, model: 'a-model',
    busy: false, updated_at: new Date().toISOString(), waiting: 'operator', blocks: 'phase 3', waiting_since: since } as SessionRow
  expect(waitParts(row)).toEqual({ status: `waiting for the operator since ${hhmm}`, blocks: 'phase 3' })
  expect(waitParts({ ...row, blocks: null })).toEqual({ status: `waiting for the operator since ${hhmm}`, blocks: 'unsaid' })
  expect(waitParts({ ...row, waiting: 'done' })).toEqual({ status: `done since ${hhmm}, proposes to be closed`, blocks: null })
  expect(waitParts({ ...row, waiting: null })).toBeNull()
  expect(waitParts({ ...row, waiting_since: null })).toEqual({ status: 'waiting for the operator', blocks: 'phase 3' })
})

test('a held question is the operator wait whose own fingerprint was relayed', () => {
  const key = fingerprint({ kind: 'operator', blocks: 'phase 3', question: '' })
  const held = { waiting: 'operator' as const, blocks: 'phase 3', waiting_since: 'T', relayed: key }
  expect(heldQuestion(held)).toEqual({ blocks: 'phase 3', since: 'T' })
  expect(heldQuestion({ ...held, waiting: null, last_waiting: 'operator' })).toEqual({ blocks: 'phase 3', since: 'T' })
  expect(heldQuestion({ ...held, waiting_since: null })).toEqual({ blocks: 'phase 3', since: null })
  expect(heldQuestion({ ...held, relayed: fingerprint({ kind: 'operator', blocks: 'phase 4', question: '' }) })).toBeNull()
  expect(heldQuestion({ ...held, relayed: null })).toBeNull()
  expect(heldQuestion({ ...held, waiting: 'done' })).toBeNull()
  expect(heldQuestion({ ...held, blocks: '' })).toBeNull()
  expect(heldQuestion(null)).toBeNull()
})

test('the withdrawal names the sender, the question and where it was answered', () => {
  expect(withdrawalText('Orch : belt', 'phase 3', '2026-10-14T10:00:00.000Z')).toBe(
    "[module] Orch : belt withdraws its question for the operator since 2026-10-14T10:00:00.000Z — blocks: phase 3\nthe operator answered it in Orch : belt's own tab: nothing to send back")
  expect(withdrawalText('Orch : belt', 'phase 3', null)).toContain('since ? — blocks: phase 3')
})

// --- the wiring over a faked $ ------------------------------------------------------------

// The coordinator is registered on this machine unless `remote`, where it is the one a peer
// delivery taught (coordinator-learnt). `roundWrite: 'fail'` refuses every rename into the round.
function fake(over: { name?: string; role?: SessionRow['role']; coordinator?: string | null; remote?: boolean; send?: 'reject' | 'refuse'; roundWrite?: 'fail' } = {}) {
  const files = new Map<string, string>()
  const sent: { to: unknown; text: string }[] = []
  const logged: string[] = []
  files.set(ROW, JSON.stringify({
    role: over.role === undefined ? 'orchestrator' : over.role, name: over.name ?? 'Orch : belt', pid: '501', repo: null,
    context_percent: 20, context_tokens: 1, window: 100, model: 'a-model', busy: false, updated_at: '2026-10-14T09:00:00.000Z',
  }) + '\n')
  if (over.coordinator !== null && over.remote) files.set(LEARNT, JSON.stringify({ name: over.coordinator ?? 'Coord : ops [abc]', from: null, at: 'T' }) + '\n')
  else if (over.coordinator !== null) files.set(RECORD, JSON.stringify({ name: over.coordinator ?? 'Coord : ops [abc]', tty: '/dev/ttys9' }))
  const dollar = {
    session: {
      id: async () => 's-one',
      send: async (args: { to: unknown; text: string }) => {
        if (over.send === 'reject') throw new Error('the send was rejected')
        if (over.send === 'refuse') return { isDelivered: false, reason: 'nobody by that name' }
        sent.push(args)
        return { isDelivered: true }
      },
    },
    env: { get: async (name: string) => ({ HOME } as Record<string, string>)[name] },
    plugin: { name: 'orchestrator', root: '/plugins/orch-root' },
    fs: {
      read: async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
        return files.get(p)
      },
      write: async (p: string, text: string) => { files.set(p, text) },
      exists: async (p: string) => files.has(p),
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file', size: 0, mtimeMs: 0, isLink: false })),
      stat: async (p: string) => { throw new Error(`ENOENT: ${p}`) },
    },
    process: {
      run: async (argv: readonly string[]) => {
        const line = logLineOf(argv)
        if (line !== null) logged.push(line)
        if (argv[0] === 'mv' && over.roundWrite === 'fail' && String(argv[3]).startsWith(`${ROUND}/`)) return { exitCode: 1, stdout: '', stderr: 'refused' }
        if (argv[0] === 'mv' && files.has(argv[2])) {
          files.set(argv[3], files.get(argv[2])!)
          files.delete(argv[2])
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'rm') {
          for (const p of argv.slice(2)) files.delete(p)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        return { exitCode: 1, stdout: '', stderr: '' }
      },
    },
    command: { run: async () => undefined },
    prompt: { submit: async () => undefined },
  }
  return { dollar, files, sent, logged, row: () => withWait(parseSessionRow(files.get(ROW) ?? '')!, files.get(WAIT) ?? '') }
}

// The round's entries as the files hold them, in the order their files were first written; a
// file that does not parse is no entry.
function entries(fx: ReturnType<typeof fake>): RoundEntry[] {
  return [...fx.files.entries()].filter(([p]) => p.startsWith(`${ROUND}/`)).flatMap(([, text]) => {
    try {
      return [JSON.parse(text) as RoundEntry]
    } catch {
      return []
    }
  })
}

function mounted(): Record<string, Function[]> {
  const chains: Record<string, Function[]> = {}
  register((...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => {
    ;(chains[args[0]] ??= []).push(args[args.length - 1] as Function)
    return { catch: () => undefined }
  })
  return chains
}

async function drive(chains: Record<string, Function[]>, event: string, dollar: any, e: object) {
  const run = async (i: number, ev: any): Promise<any> =>
    i >= (chains[event] ?? []).length ? ev : chains[event][i](dollar, ev, (x: any) => run(i + 1, x))
  return run(0, e)
}

const turnEnd = (answer: string) => ({ answer, reason: 'answer', isAborted: false, durationMs: 1, turnId: 't' })

test('an operator wait lands in the row and is entered once in the round of the coordinator on this machine', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3')))
  const row = fx.row()!
  expect(row.waiting).toBe('operator')
  expect(row.blocks).toBe('phase 3')
  expect(typeof row.waiting_since).toBe('string')
  expect(row.updated_at).toBe('2026-10-14T09:00:00.000Z')
  expect(parseSessionRow(fx.files.get(ROW)!)!.waiting).toBeUndefined()
  expect([...fx.files.keys()].some(p => p.includes('.tmp-'))).toBe(false)
  expect(fx.sent.length).toBe(0)
  const [entry] = entries(fx)
  expect(entries(fx).length).toBe(1)
  const wait = parseWait(answerOf(QUESTION, 'waiting: operator — blocks: phase 3'))!
  expect(entry).toEqual(roundEntry('s-one', 'Orch : belt', wait, row.waiting_since!, entry.at))
  expect(fx.files.has(`${ROUND}/${entry.id}.json`)).toBe(true)
  expect(Number.isFinite(Date.parse(entry.at))).toBe(true)
  expect(row.relayed).toBe(fingerprint(wait))
})

test('the same wait is never sent twice, whatever progress the turns between report; a new line is', async () => {
  const chains = mounted()
  const fx = fake()
  const same = turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3'))
  await drive(chains, 'turn.complete', fx.dollar, same)
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  await drive(chains, 'turn.complete', fx.dollar, same)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('The review of #12 has started.', 'waiting: operator — blocks: phase 3')))
  expect(entries(fx).length).toBe(1)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('A new question?', 'waiting: operator — blocks: phase 4')))
  expect(entries(fx).length).toBe(2)
  expect(entries(fx)[1].question).toContain('A new question?')
  expect(fx.sent.length).toBe(0)
})

test('done is one closing proposal', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Everything merged.', 'waiting: done')))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Everything merged.', 'waiting: done')))
  expect(entries(fx).map(e => [e.kind, e.from, e.blocks, e.question, e.status])).toEqual([['done', 'Orch : belt', null, 'Everything merged.', 'open']])
  expect(fx.sent.length).toBe(0)
  expect(fx.row()!.waiting).toBe('done')
})

test('a turn that starts, or ends without a machine line, clears the wait', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3')))
  await drive(chains, 'turn.start', fx.dollar, { text: 'the answer' })
  expect(fx.row()!.waiting).toBeNull()
  expect(fx.row()!.waiting_since).toBeNull()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3')))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working on phase 3.'))
  expect(fx.row()!.waiting).toBeNull()
  expect(fx.row()!.blocks).toBeNull()
})

test('no coordinator registered: the row is written, nothing is sent', async () => {
  const chains = mounted()
  const fx = fake({ coordinator: null })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3')))
  expect(fx.sent.length).toBe(0)
  expect(entries(fx)).toEqual([])
  expect(fx.row()!.waiting).toBe('operator')
})

for (const [name, role] of [['Coord : ops', 'coordinator'], ['Agent : belt-p3', 'agent'], ['Audit : method', 'auditor']] as const) {
  test(`a session that is no orchestrator (${role}) writes nothing and sends nothing`, async () => {
    const chains = mounted()
    const fx = fake({ name, role })
    const before = fx.files.get(ROW)
    await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3')))
    expect(fx.sent.length).toBe(0)
    expect(entries(fx)).toEqual([])
    expect(fx.files.get(ROW)).toBe(before)
    expect(fx.files.has(WAIT)).toBe(false)
  })
}

test("a subagent's turn and an interrupted one are not read", async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, { ...turnEnd(answerOf(QUESTION, 'waiting: done')), agentId: 'a1' })
  await drive(chains, 'turn.complete', fx.dollar, { ...turnEnd(answerOf(QUESTION, 'waiting: done')), reason: 'aborted', isAborted: true })
  expect(fx.sent.length).toBe(0)
  expect(fx.row()!.waiting).toBeUndefined()
})

for (const failure of ['reject', 'refuse'] as const) {
  test(`a send that fails (${failure}) is logged, never holds the turn's end, and is tried again on the same wait`, async () => {
    const chains = mounted()
    const fx = fake({ send: failure, remote: true })
    const e = turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3'))
    const answer = await drive(chains, 'turn.complete', fx.dollar, e)
    expect(answer).toBe(e)
    expect(fx.logged.some(l => l.includes('| supervision |') && l.includes('relay:'))).toBe(true)
    expect(fx.row()!.relayed ?? null).toBeNull()
  })
}

test('a measure write after the relay write keeps waiting, blocks and waiting_since', async () => {
  // The race the wait's own file closes: the measure read the row before the relay
  // wrote the wait, and writes its merge after it. The row's file is the measure's
  // alone, so its stale base carries no wait to put back.
  const chains = mounted()
  const fx = fake()
  const stale = fx.files.get(ROW)!
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3')))
  const since = fx.row().waiting_since
  const read = fx.dollar.fs.read
  fx.dollar.fs.read = async (p: string) => (p === ROW ? stale : read(p))
  await writeSession(fx.dollar, 's-one', { context_percent: 55 })
  fx.dollar.fs.read = read
  const row = (await readSessions(fx.dollar))['sessions/s-one']
  expect(row.context_percent).toBe(55)
  expect(row.waiting).toBe('operator')
  expect(row.blocks).toBe('phase 3')
  expect(row.waiting_since).toBe(since)
})

test('two turns ending on the same wait keep the first waiting_since, the turn between them notwithstanding', async () => {
  const chains = mounted()
  const fx = fake()
  const same = turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3'))
  await drive(chains, 'turn.complete', fx.dollar, same)
  const first = '2026-10-14T08:00:00.000Z'
  fx.files.set(WAIT, JSON.stringify({ ...JSON.parse(fx.files.get(WAIT)!), waiting_since: first }) + '\n')
  await drive(chains, 'turn.start', fx.dollar, { text: 'go on' })
  expect(fx.row().waiting).toBeNull()
  await drive(chains, 'turn.complete', fx.dollar, same)
  expect(fx.row().waiting_since).toBe(first)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 4')))
  expect(fx.row().waiting_since).not.toBe(first)
})

// --- the operator answers in the orchestrator's own tab ---------------------------------------

const QUESTION_LINE = 'waiting: operator — blocks: phase 3'
const typed = (kind: string, text = 'yes') => ({ text, origin: { kind } })

async function relayedQuestion(over: Parameters<typeof fake>[0] = {}) {
  const chains = mounted()
  const fx = fake(over)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, QUESTION_LINE)))
  fx.sent.length = 0
  return { chains, fx }
}

for (const kind of ['composer', 'bridge']) {
  test(`a ${kind} prompt in an orchestrator holding a question withdraws it and forgets the fingerprint`, async () => {
    const { chains, fx } = await relayedQuestion()
    const since = fx.row().waiting_since
    const e = typed(kind)
    expect(await drive(chains, 'prompt.submit', fx.dollar, e)).toBe(e)
    expect(fx.sent.length).toBe(0)
    const [entry] = entries(fx)
    expect([entry.status, entry.since, entry.blocks, entry.answer?.text, entry.answer?.by]).toEqual(['withdrawn', since, 'phase 3', "answered in the sender's own tab", 'tab'])
    expect(Number.isFinite(Date.parse(entry.answer!.at))).toBe(true)
    expect(fx.row().relayed ?? null).toBeNull()
    await drive(chains, 'prompt.submit', fx.dollar, typed(kind, 'and more'))
    expect(entries(fx)).toEqual([entry])
  })
}

test('a withdrawal that finds no open entry says so in the log and still forgets the fingerprint', async () => {
  const { chains, fx } = await relayedQuestion()
  const since = fx.row().waiting_since
  const matched = await relayedQuestion()
  await drive(matched.chains, 'prompt.submit', matched.fx.dollar, typed('composer'))
  expect(matched.fx.logged.filter(l => l.includes('round: no open entry matched')).length).toBe(0)
  for (const path of [...fx.files.keys()].filter(p => p.startsWith(`${ROUND}/`))) fx.files.delete(path)
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  expect(fx.logged.filter(l => l.includes(`round: no open entry matched for Orch : belt since ${since}`)).length).toBe(1)
  expect(entries(fx)).toEqual([])
  expect(fx.row().relayed ?? null).toBeNull()
})

test('the withdrawal holds when a turn start cleared the wait first', async () => {
  const { chains, fx } = await relayedQuestion()
  await drive(chains, 'turn.start', fx.dollar, { text: 'yes' })
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  expect(entries(fx)[0].status).toBe('withdrawn')
})

for (const [label, setup, kind] of [
  ['another prompt kind', {}, 'peer'],
  ['an agent session', { name: 'Agent : belt-p3', role: 'agent' as const }, 'composer'],
  ['no coordinator', { coordinator: null }, 'composer'],
] as const) {
  test(`nothing is withdrawn for ${label}`, async () => {
    const { chains, fx } = await relayedQuestion(setup)
    const before = fx.files.get(WAIT)
    const written = entries(fx)
    const e = typed(kind)
    expect(await drive(chains, 'prompt.submit', fx.dollar, e)).toBe(e)
    expect(fx.sent.length).toBe(0)
    expect(entries(fx)).toEqual(written)
    expect(fx.files.get(WAIT)).toBe(before)
  })
}

for (const text of ['/orchestrator:status', '  /x']) {
  test(`a composer prompt that is a slash command (${JSON.stringify(text)}) withdraws nothing`, async () => {
    const { chains, fx } = await relayedQuestion()
    const before = fx.files.get(WAIT)
    const written = entries(fx)
    const e = typed('composer', text)
    expect(await drive(chains, 'prompt.submit', fx.dollar, e)).toBe(e)
    expect(fx.sent.length).toBe(0)
    expect(entries(fx)).toEqual(written)
    expect(fx.files.get(WAIT)).toBe(before)
    expect(fx.row().relayed).toBeTruthy()
  })
}

test('no held question: nothing is withdrawn', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Everything merged.', 'waiting: done')))
  fx.sent.length = 0
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  expect(fx.sent.length).toBe(0)
})

test('a refused withdrawal is one log line, keeps the fingerprint and is tried again', async () => {
  const { chains, fx } = await relayedQuestion({ remote: true })
  const key = fx.row().relayed
  const send = fx.dollar.session.send
  fx.dollar.session.send = async () => ({ isDelivered: false, reason: 'nobody by that name' })
  const e = typed('composer')
  expect(await drive(chains, 'prompt.submit', fx.dollar, e)).toBe(e)
  expect(fx.logged.filter(l => l.includes('withdraw: not delivered to Coord : ops [abc]: nobody by that name')).length).toBe(1)
  expect(fx.row().relayed).toBe(key)
  fx.dollar.session.send = send
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  expect(fx.sent.length).toBe(1)
})

test('a wait rewritten while the withdrawal was being sent is left as it was written', async () => {
  const { chains, fx } = await relayedQuestion({ remote: true })
  const other = fingerprint({ kind: 'operator', blocks: 'phase 4', question: '' })
  const send = fx.dollar.session.send
  fx.dollar.session.send = async (args: { to: unknown; text: string }) => {
    const sent = await send(args)
    fx.files.set(WAIT, JSON.stringify({ ...JSON.parse(fx.files.get(WAIT)!), relayed: other }) + '\n')
    return sent
  }
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  expect(fx.sent.length).toBe(1)
  expect(JSON.parse(fx.files.get(WAIT)!).relayed).toBe(other)
})

test('the write-back forgets the fingerprint and keeps every other field of the wait', async () => {
  const { chains, fx } = await relayedQuestion()
  const before = JSON.parse(fx.files.get(WAIT)!)
  const fields = ['waiting', 'last_waiting', 'blocks', 'waiting_since', 'name', 'pid']
  const kept = (wait: Record<string, unknown>) => Object.fromEntries(fields.map(f => [f, wait[f] ?? null]))
  expect(kept(before).waiting).toBe('operator')
  expect(kept(before).name).toBe('Orch : belt')
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  const after = JSON.parse(fx.files.get(WAIT)!)
  expect(after.relayed).toBeNull()
  expect(kept(after)).toEqual(kept(before))
})

test('after a withdrawal, the same question asked again is relayed again', async () => {
  const { chains, fx } = await relayedQuestion()
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  await drive(chains, 'turn.start', fx.dollar, { text: 'yes' })
  fx.sent.length = 0
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, QUESTION_LINE)))
  expect(entries(fx).length).toBe(1)
  expect(entries(fx)[0].status).toBe('open')
  expect(fx.sent.length).toBe(0)
})

// --- a coordinator on this machine reads the round; one elsewhere is sent the message ---------

test('a coordinator on another machine is sent the wait as a message, and nothing enters a round', async () => {
  const chains = mounted()
  const fx = fake({ remote: true })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, QUESTION_LINE)))
  const row = fx.row()
  const report = fx.sent.filter(s => s.text.startsWith('[module]'))
  expect(report.length).toBe(1)
  expect(report[0].to).toBe('Coord : ops [abc]')
  expect(report[0].text).toBe(`[module] Orch : belt waits for the operator since ${row.waiting_since} — blocks: phase 3\nreply with SendMessage to: Orch : belt\n\n${QUESTION}`)
  expect(entries(fx)).toEqual([])
  expect(row.relayed).toBe(fingerprint(parseWait(answerOf(QUESTION, QUESTION_LINE))!))
})

test('a coordinator on another machine is sent the withdrawal as a message', async () => {
  const { chains, fx } = await relayedQuestion({ remote: true })
  const since = fx.row().waiting_since
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  expect(fx.sent.map(s => [s.to, s.text])).toEqual([['Coord : ops [abc]', withdrawalText('Orch : belt', 'phase 3', since)]])
  expect(fx.row().relayed ?? null).toBeNull()
  expect(entries(fx)).toEqual([])
})

test('a round entry that cannot be written is logged, never holds the turn\'s end, and is tried again on the same wait', async () => {
  const chains = mounted()
  const over: { roundWrite?: 'fail' } = { roundWrite: 'fail' }
  const fx = fake(over)
  const e = turnEnd(answerOf(QUESTION, QUESTION_LINE))
  expect(await drive(chains, 'turn.complete', fx.dollar, e)).toBe(e)
  expect(fx.logged.some(l => l.includes('| supervision |') && l.includes('relay:') && l.includes('/round/'))).toBe(true)
  expect(entries(fx)).toEqual([])
  expect(fx.row().relayed ?? null).toBeNull()
  expect(fx.sent.length).toBe(0)
  delete over.roundWrite
  await drive(chains, 'turn.complete', fx.dollar, e)
  expect(entries(fx).length).toBe(1)
  expect(fx.row().relayed).toBe(fingerprint(parseWait(e.answer)!))
})

test('the withdrawal marks only the open question of that sender with the same since and blocks', async () => {
  const { chains, fx } = await relayedQuestion()
  const [held] = entries(fx)
  const others: RoundEntry[] = [
    { ...held, id: 'other-session', session: 's-two', from: 'Orch : other' },
    { ...held, id: 'other-since', since: '2026-10-14T07:00:00.000Z' },
    { ...held, id: 'other-blocks', blocks: 'phase 4' },
    { ...held, id: 'already-closed', status: 'closed' },
  ]
  for (const other of others) fx.files.set(`${ROUND}/${other.id}.json`, JSON.stringify(other) + '\n')
  fx.files.set(`${ROUND}/broken.json`, '{"id": "broken", "status": "op')
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  const after = new Map(entries(fx).map(e => [e.id, e]))
  expect(after.get(held.id)!.status).toBe('withdrawn')
  for (const other of others) expect(after.get(other.id)).toEqual(other)
  expect(fx.files.get(`${ROUND}/broken.json`)).toBe('{"id": "broken", "status": "op')
  expect(fx.sent.length).toBe(0)
})
