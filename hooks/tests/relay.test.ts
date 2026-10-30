// hooks/tests/relay.test.ts
// An orchestrator's end of turn read by the module (relay.ts, wired in supervision.ts):
// the machine line parsed into the row's wait fields, one entry in the round of a
// coordinator on this machine per wait, one report to a coordinator on another, none
// twice, none without a coordinator, none from a session that is no orchestrator, and a
// write or a send that fails never holding the turn's end.
import { expect, test } from 'claude-code/testing'
import { parseWait, waitPatch, fingerprint, relayText, coordinatorOf, waitLabel, waitParts, heldQuestion, withdrawalText, RELAY_CAP } from '../relay.ts'
import { paneQuestions, waitsInTab, roundEntry, type RoundEntry } from '../round.ts'
import { answerFromPane, settledText, parseSessionRow, paneRows, withWait, writeSession, readSessions, type SessionRow } from '../supervision.ts'
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

// The ending of a turn whose open work the operator deferred asks him nothing: no wait at all,
// so no round entry, no report and no alert (the stop gate takes it: stop-gate.test.ts).
test('the deferred line is no wait', () => {
  expect(parseWait(answerOf('Nothing left to move.', 'waiting: deferred — row 5, G5, G6'))).toBeNull()
  expect(parseWait(answerOf('Nothing left to move.', '**waiting: deferred - G5**'))).toBeNull()
})

test('a wait its sender marked urgent parses as urgent; the plain form is not', () => {
  expect(parseWait(answerOf(QUESTION, 'waiting: operator (urgent) — blocks: x')))
    .toEqual({ kind: 'operator', blocks: 'x', question: QUESTION, urgent: true })
  expect(parseWait('waiting: operator (Urgent) - blocks: the deadline')).toEqual({ kind: 'operator', blocks: 'the deadline', question: '', urgent: true })
  expect(parseWait(answerOf(QUESTION, 'waiting: operator — blocks: x'))!.urgent).toBeUndefined()
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
// delivery taught (coordinator-learnt). `roundWrite: 'fail'` refuses every rename into the round,
// `refuseInto` the renames into that one file.
function fake(over: { name?: string; role?: SessionRow['role']; coordinator?: string | null; remote?: boolean; send?: 'reject' | 'refuse'; roundWrite?: 'fail'; refuseInto?: string } = {}) {
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
        if (argv[0] === 'mv' && over.refuseInto !== undefined && argv[3] === over.refuseInto) return { exitCode: 1, stdout: '', stderr: 'refused' }
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

test('a wait marked urgent is entered in the round urgent, what it blocks read without the mark', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator (urgent) — blocks: the production fault')))
  expect(fx.row()!.blocks).toBe('the production fault')
  const [entry] = entries(fx)
  expect(entries(fx).length).toBe(1)
  expect([entry.urgent, entry.blocks]).toEqual([true, 'the production fault'])
})

test('a plain wait asked again urgent rewrites its entry urgent, on the same id, and back again', async () => {
  const chains = mounted()
  const fx = fake()
  const choices = 'Merge #12 now?\n- **A** : merge it\n- **B** : wait'
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(choices, 'waiting: operator — blocks: phase 3')))
  const [plain] = entries(fx)
  expect(plain.urgent).toBeUndefined()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(choices, 'waiting: operator (urgent) — blocks: phase 3')))
  expect(entries(fx).map(e => [e.id, e.urgent])).toEqual([[plain.id, true]])
  // Asked urgent again with no choice, the entry keeps the choices it has and stays urgent.
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Still waiting.', 'waiting: operator — blocks: phase 3')))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Still waiting.', 'waiting: operator (urgent) — blocks: phase 3')))
  expect(entries(fx).map(e => [e.id, e.urgent, e.choices.length])).toEqual([[plain.id, true, 2]])
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(choices, 'waiting: operator — blocks: phase 3')))
  expect(entries(fx).map(e => [e.id, e.urgent])).toEqual([[plain.id, undefined]])
  expect(fx.sent.length).toBe(0)
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

// The operator types in the tab, the turn starts, then ends on `answer`.
async function typedTurn(chains: Record<string, Function[]>, fx: ReturnType<typeof fake>, answer: string, kind = 'composer') {
  await drive(chains, 'prompt.submit', fx.dollar, typed(kind))
  await drive(chains, 'turn.start', fx.dollar, { text: 'yes' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answer))
}

async function relayedQuestion(over: Parameters<typeof fake>[0] = {}) {
  const chains = mounted()
  const fx = fake(over)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, QUESTION_LINE)))
  fx.sent.length = 0
  return { chains, fx }
}

for (const kind of ['composer', 'bridge']) {
  test(`a ${kind} prompt in an orchestrator holding a question withdraws it at the turn's end and forgets the fingerprint`, async () => {
    const { chains, fx } = await relayedQuestion()
    const since = fx.row().waiting_since
    const e = typed(kind)
    expect(await drive(chains, 'prompt.submit', fx.dollar, e)).toBe(e)
    expect(fx.sent.length).toBe(0)
    expect(entries(fx)[0].status).toBe('open')
    await drive(chains, 'turn.start', fx.dollar, { text: 'yes' })
    await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working.'))
    const [entry] = entries(fx)
    expect([entry.status, entry.since, entry.blocks, entry.answer?.text, entry.answer?.by]).toEqual(['withdrawn', since, 'phase 3', "answered in the sender's own tab", 'tab'])
    expect(Number.isFinite(Date.parse(entry.answer!.at))).toBe(true)
    expect(fx.row().relayed ?? null).toBeNull()
    await typedTurn(chains, fx, 'Working.', kind)
    expect(entries(fx)).toEqual([entry])
  })
}

test('a withdrawal that finds no open entry says so in the log and still forgets the fingerprint', async () => {
  const { chains, fx } = await relayedQuestion()
  const since = fx.row().waiting_since
  const matched = await relayedQuestion()
  await typedTurn(matched.chains, matched.fx, 'Working.')
  expect(matched.fx.logged.filter(l => l.includes('round: no open entry matched')).length).toBe(0)
  for (const path of [...fx.files.keys()].filter(p => p.startsWith(`${ROUND}/`))) fx.files.delete(path)
  await typedTurn(chains, fx, 'Working.')
  expect(fx.logged.filter(l => l.includes(`round: no open entry matched for Orch : belt since ${since}`)).length).toBe(1)
  expect(entries(fx)).toEqual([])
  expect(fx.row().relayed ?? null).toBeNull()
})

test('the withdrawal holds when a turn start cleared the wait first', async () => {
  const { chains, fx } = await relayedQuestion()
  await drive(chains, 'turn.start', fx.dollar, { text: 'yes' })
  await typedTurn(chains, fx, 'Working.')
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

test('a refused withdrawal is one log line at the turn\'s end, keeps the fingerprint and is tried again', async () => {
  const { chains, fx } = await relayedQuestion({ remote: true })
  const key = fx.row().relayed
  const send = fx.dollar.session.send
  fx.dollar.session.send = async () => ({ isDelivered: false, reason: 'nobody by that name' })
  await typedTurn(chains, fx, 'Working.')
  expect(fx.logged.filter(l => l.includes('withdraw: not delivered to Coord : ops [abc]: nobody by that name')).length).toBe(1)
  expect(fx.row().relayed).toBe(key)
  fx.dollar.session.send = send
  await typedTurn(chains, fx, 'Working.')
  expect(fx.sent.filter(m => m.text.startsWith('[module]')).length).toBe(1)
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
  await typedTurn(chains, fx, 'Working.')
  expect(fx.sent.filter(m => m.text.startsWith('[module]')).length).toBe(1)
  expect(JSON.parse(fx.files.get(WAIT)!).relayed).toBe(other)
})

test('the write-back forgets the fingerprint and keeps every other field of the wait', async () => {
  const { chains, fx } = await relayedQuestion()
  const before = JSON.parse(fx.files.get(WAIT)!)
  const fields = ['blocks', 'waiting_since', 'name', 'pid']
  const kept = (wait: Record<string, unknown>) => Object.fromEntries(fields.map(f => [f, wait[f] ?? null]))
  expect(before.waiting).toBe('operator')
  expect(kept(before).name).toBe('Orch : belt')
  await typedTurn(chains, fx, 'Working.')
  const after = JSON.parse(fx.files.get(WAIT)!)
  expect(after.relayed).toBeNull()
  expect([after.waiting, after.last_waiting, after.typed ?? null]).toEqual([null, 'operator', null])
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

test('a coordinator on another machine is sent the withdrawal as a message at the turn\'s end', async () => {
  const { chains, fx } = await relayedQuestion({ remote: true })
  const since = fx.row().waiting_since
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  expect(fx.sent.length).toBe(0)
  await drive(chains, 'turn.start', fx.dollar, { text: 'yes' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working.'))
  expect(fx.sent.filter(m => m.text.startsWith('[module]')).map(s => [s.to, s.text])).toEqual([['Coord : ops [abc]', withdrawalText('Orch : belt', 'phase 3', since)]])
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
  await typedTurn(chains, fx, 'Working.')
  const after = new Map(entries(fx).map(e => [e.id, e]))
  expect(after.get(held.id)!.status).toBe('withdrawn')
  for (const other of others) expect(after.get(other.id)).toEqual(other)
  expect(fx.files.get(`${ROUND}/broken.json`)).toBe('{"id": "broken", "status": "op')
  expect(fx.sent.length).toBe(0)
})

// --- an entry its sender no longer waits on ---------------------------------------------------

test('a typed turn on another wait withdraws the sender\'s own open entry; the same wait keeps it open', async () => {
  const chains = mounted()
  const fx = fake()
  const first = turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3'))
  await drive(chains, 'turn.complete', fx.dollar, first)
  const [asked] = entries(fx)
  const other: RoundEntry = { ...asked, id: 'other-session', session: 's-two', from: 'Orch : other' }
  const settled: RoundEntry = { ...asked, id: 'already-closed', status: 'closed' }
  for (const kept of [other, settled]) fx.files.set(`${ROUND}/${kept.id}.json`, JSON.stringify(kept) + '\n')
  // The same wait again, typed in or not: still what it waits on.
  await drive(chains, 'turn.complete', fx.dollar, first)
  await typedTurn(chains, fx, first.answer)
  expect(entries(fx).find(e => e.id === asked.id)!.status).toBe('open')
  await typedTurn(chains, fx, answerOf('A new question?', 'waiting: operator — blocks: phase 4'))
  const after = new Map(entries(fx).map(e => [e.id, e]))
  const stale = after.get(asked.id)!
  expect(stale.status).toBe('withdrawn')
  expect(stale.answer!.text).toBe("answered in the sender's own tab")
  expect(stale.answer!.by).toBe('tab')
  expect(Number.isFinite(Date.parse(stale.answer!.at))).toBe(true)
  expect(after.get(other.id)).toEqual(other)
  expect(after.get(settled.id)).toEqual(settled)
  expect(entries(fx).filter(e => e.session === 's-one' && e.status === 'open').map(e => e.blocks)).toEqual(['phase 4'])
  expect([...fx.files.keys()].some(p => p.includes('.tmp-'))).toBe(false)
})

test('a later operator wait, not typed in, supersedes the sender\'s open entry and adds the new one', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3')))
  const [asked] = entries(fx)
  await drive(chains, 'turn.start', fx.dollar, { text: '[module] a peer message' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('A new question?', 'waiting: operator — blocks: phase 4')))
  expect(entries(fx).map(e => [e.blocks, e.status])).toEqual([['phase 3', 'withdrawn'], ['phase 4', 'open']])
  expect([entries(fx)[0].answer?.text, entries(fx)[0].answer?.by]).toEqual([`superseded by ${entries(fx)[1].id}`, 'sender'])
})

test('a new operator wait supersedes every older open entry of its session, one presented in the tab included, and no other session\'s', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3')))
  const [asked] = entries(fx)
  const woken: RoundEntry = { ...asked, id: 'woken', blocks: 'phase 2', since: '2026-10-14T07:00:00.000Z' }
  const done: RoundEntry = { ...asked, id: 'done', kind: 'done', blocks: null, since: '2026-10-14T06:00:00.000Z' }
  const other: RoundEntry = { ...asked, id: 'other-session', session: 's-two', from: 'Orch : other' }
  for (const kept of [woken, done, other]) fx.files.set(`${ROUND}/${kept.id}.json`, JSON.stringify(kept) + '\n')
  fx.files.set(`${HOME}/.claude/claude-orchestrator/round-woken.json`, JSON.stringify(['woken']) + '\n')
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('A new question?', 'waiting: operator — blocks: phase 4')))
  const after = new Map(entries(fx).map(e => [e.id, e]))
  const fresh = entries(fx).find(e => e.blocks === 'phase 4')!
  expect(fresh.status).toBe('open')
  for (const id of [asked.id, 'woken', 'done']) {
    // The one the coordinator was woken for is closed by the module itself.
    const [status, text] = id === 'woken' ? ['closed', `withdrawn: superseded by ${fresh.id}`] : ['withdrawn', `superseded by ${fresh.id}`]
    expect([after.get(id)!.status, after.get(id)!.answer?.text, after.get(id)!.answer?.by]).toEqual([status, text, 'sender'])
    expect(fx.logged.filter(l => l.includes(`round: withdrawn by the sender: ${id}`)).length).toBe(1)
  }
  expect(after.get(other.id)).toEqual(other)
  expect(fx.row().relayed).toBe(fingerprint(parseWait(answerOf('A new question?', 'waiting: operator — blocks: phase 4'))!))
})

// The operator's report of 2026-10-25: a question with choices, then a turn ending on a status
// report that waits on the same answer, its blocks one item shorter. The report superseded the
// question, and the pane had nothing left to draw. A wait that asks nothing is now entered as
// its own entry, beside the question with choices, which stays as it was asked.
const STAGING_QUESTION = 'Question 1 of 1\n\n_Question_ : which version ends the campaign?\n\n_Choices_ :\n- **A** : the new versions\n- **B** : as A, with the lot tested\n- **C** : stop here\n\n_Recommendation_ : A.'
const STAGING_REPORT = 'The front-office checks on the old versions passed.\n\nYour choice A, B or C on the lot, asked above, decides what the three agents do next.'
const STAGING_LINE = 'waiting: operator — blocks: fin de B14, a4 b, BO §3.21/§3.22, gestes G2-G6, report.md'
const REPORT_LINE = 'waiting: operator — blocks: fin de B14, BO §3.21/§3.22, gestes G2-G6, report.md'

// A question with choices in the round, then the operator's next turn on `answer`.
async function choicesThen(answer: string) {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(STAGING_QUESTION, STAGING_LINE)))
  const [asked] = entries(fx)
  expect(asked.choices.map(c => c.letter)).toEqual(['A', 'B', 'C'])
  await drive(chains, 'turn.start', fx.dollar, { text: '[module] a peer message' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answer))
  return { chains, fx, asked }
}

test('a choice-less turn end is entered as its own entry beside the open question with choices, which stays as asked, and the pane draws the question, the wait having a line', async () => {
  const { chains, fx, asked } = await choicesThen(answerOf(STAGING_REPORT, REPORT_LINE))
  const row = fx.row()!
  const wait = roundEntry('s-one', 'Orch : belt', parseWait(answerOf(STAGING_REPORT, REPORT_LINE))!, row.waiting_since!, 'T')
  expect(entries(fx)).toEqual([asked, { ...wait, at: entries(fx)[1].at }])
  expect(fx.logged.some(l => l.includes('round: withdrawn by the sender'))).toBe(false)
  expect(row.relayed).toBe(fingerprint(parseWait(answerOf(STAGING_REPORT, REPORT_LINE))!))
  expect(paneQuestions(entries(fx)).map(e => e.id)).toEqual([asked.id])
  expect(waitsInTab(entries(fx)).map(e => e.id)).toEqual([wait.id])
  // The same report again is the same wait: nothing more is written.
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(STAGING_REPORT, REPORT_LINE)))
  expect(entries(fx).length).toBe(2)
  expect(fx.sent.length).toBe(0)
})

test('a prose question after a question with choices is entered beside it, and the pane draws both as cards', async () => {
  const { fx, asked } = await choicesThen(answerOf('Shall I also tag the release?', 'waiting: operator — blocks: phase 4'))
  const [first, prose] = entries(fx)
  expect(first).toEqual(asked)
  expect([prose.status, prose.blocks, prose.question, prose.choices]).toEqual(['open', 'phase 4', 'Shall I also tag the release?', []])
  expect(paneQuestions(entries(fx)).map(e => e.id)).toEqual([asked.id, prose.id])
  expect(waitsInTab(entries(fx)).map(e => e.id)).toEqual([])
})

test('a prose wait ending with a full stop after a question with choices is entered beside it, and the pane draws the question, the prose having a line', async () => {
  const { fx, asked } = await choicesThen(answerOf('I will also tag the release.', 'waiting: operator — blocks: phase 4'))
  const [first, prose] = entries(fx)
  expect(first).toEqual(asked)
  expect([prose.status, prose.blocks, prose.question, prose.choices]).toEqual(['open', 'phase 4', 'I will also tag the release.', []])
  expect(paneQuestions(entries(fx)).map(e => e.id)).toEqual([asked.id])
  expect(waitsInTab(entries(fx)).map(e => e.id)).toEqual([prose.id])
})

test('a done turn after a question with choices absorbs nothing and withdraws nothing', async () => {
  const { fx, asked } = await choicesThen(answerOf('All merged.', 'waiting: done'))
  expect(entries(fx).map(e => [e.id === asked.id, e.kind, e.status])).toEqual([[true, 'operator', 'open'], [false, 'done', 'open']])
  expect(entries(fx)[0]).toEqual(asked)
})

test('a choice-less wait marked urgent copies its mark onto the question with choices, and its plain repeat removes none', async () => {
  const { chains, fx, asked } = await choicesThen(answerOf('Still waiting on the lot.', 'waiting: operator (urgent) — blocks: phase 3 and 4'))
  const [kept, wait] = entries(fx)
  expect(kept).toEqual({ ...asked, urgent: true })
  expect([wait.status, wait.blocks, wait.urgent]).toEqual(['open', 'phase 3 and 4', true])
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Still waiting.', 'waiting: operator — blocks: phase 4')))
  const after = new Map(entries(fx).map(e => [e.id, e]))
  expect(after.get(asked.id)).toEqual({ ...asked, urgent: true })
  expect([after.get(wait.id)!.status, after.get(wait.id)!.answer?.text]).toEqual(['withdrawn', `superseded by ${entries(fx)[2].id}`])
  expect(entries(fx)[2].status).toBe('open')
})

for (const [label, question] of [['choices', 'Which one?\n- **A** : this\n- **B** : that'], ['labelled fields', '_Question_ : Rename it?']] as const) {
  test(`a later wait with ${label} still supersedes the question with choices and the choice-less wait`, async () => {
    const { chains, fx, asked } = await choicesThen(answerOf(STAGING_REPORT, REPORT_LINE))
    const [, wait] = entries(fx)
    await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(question, 'waiting: operator — blocks: phase 4')))
    const fresh = entries(fx)[2]
    const after = new Map(entries(fx).map(e => [e.id, e]))
    for (const id of [asked.id, wait.id]) expect([after.get(id)!.status, after.get(id)!.answer?.text]).toEqual(['withdrawn', `superseded by ${fresh.id}`])
    expect([fresh.status, fresh.blocks]).toEqual(['open', 'phase 4'])
  })
}

for (const [label, answer] of [['another wait', answerOf('Something else.', 'waiting: operator — blocks: phase 5')], ['done', answerOf('All merged.', 'waiting: done')]] as const) {
  test(`a prompt typed in the tab, then a turn ending on ${label}, withdraws both the question with choices and the choice-less wait`, async () => {
    const { chains, fx, asked } = await choicesThen(answerOf(STAGING_REPORT, REPORT_LINE))
    const [, wait] = entries(fx)
    await typedTurn(chains, fx, answer)
    const after = new Map(entries(fx).map(e => [e.id, e]))
    expect([after.get(wait.id)!.status, after.get(wait.id)!.answer?.by]).toEqual(['withdrawn', 'tab'])
    expect([after.get(asked.id)!.status, after.get(asked.id)!.answer?.text, after.get(asked.id)!.answer?.by]).toEqual(['withdrawn', "answered in the sender's own tab", 'sender'])
    expect(paneQuestions(entries(fx)).filter(e => e.session === 's-one' && e.id !== entries(fx)[2]?.id).length).toBe(0)
  })
}

test('an answer from the pane to the question with choices leaves the choice-less wait to the sender\'s next turn end', async () => {
  const { chains, fx, asked } = await choicesThen(answerOf(STAGING_REPORT, REPORT_LINE))
  const [, wait] = entries(fx)
  const pane = { opened: null, ticker: null, other: new Set<string>(), writing: null, undelivered: new Map(), answering: new Set<string>() }
  await answerFromPane({ ...fx.dollar, ui: { invalidate: () => undefined } }, pane, asked, asked.choices[0])
  expect(new Map(entries(fx).map(e => [e.id, e.status]))).toEqual(new Map([[asked.id, 'answered'], [wait.id, 'open']]))
  // The same wait again leaves it open; a turn on another wait supersedes it.
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(STAGING_REPORT, REPORT_LINE)))
  expect(entries(fx).find(e => e.id === wait.id)!.status).toBe('open')
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Next?', 'waiting: operator — blocks: phase 5')))
  expect([entries(fx).find(e => e.id === wait.id)!.status, entries(fx).find(e => e.id === asked.id)!.status]).toEqual(['withdrawn', 'answered'])
})

for (const [label, end, why] of [
  ['its session ending', async (chains: Record<string, Function[]>, fx: ReturnType<typeof fake>) => drive(chains, 'session.end', fx.dollar, { sessionId: 's-one', reason: 'exit' }), "the sender's session ended"],
  ['its hand-over', async (chains: Record<string, Function[]>, fx: ReturnType<typeof fake>) => drive(chains, 'session.send', fx.dollar, { to: 'Orch : belt-2', text: 'handed over', origin: { kind: 'model' } }), 'handed over to its successor'],
] as const) {
  test(`${label} withdraws both the question with choices and the choice-less wait`, async () => {
    const { chains, fx } = await choicesThen(answerOf(STAGING_REPORT, REPORT_LINE))
    await end(chains, fx)
    expect(entries(fx).map(e => [e.status, e.answer?.text])).toEqual([['withdrawn', why], ['withdrawn', why]])
  })
}

test('a done wait supersedes nothing', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3')))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('All merged.', 'waiting: done')))
  expect(entries(fx).map(e => [e.kind, e.status])).toEqual([['operator', 'open'], ['done', 'open']])
})

test('a later turn that ends on no machine line leaves the sender\'s open entries as they are', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3')))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working on phase 3.'))
  expect(entries(fx).map(e => [e.status, e.answer])).toEqual([['open', null]])
  expect(fx.logged.some(l => l.includes('round: withdrawn by the sender'))).toBe(false)
})

for (const [label, line] of [['another operator wait', 'waiting: operator — blocks: phase 4'], ['done', 'waiting: done']] as const) {
  test(`a typed turn on ${label} withdraws the held entry by the tab and the sender's other open entry by the sender, one log line`, async () => {
    const { chains, fx } = await relayedQuestion()
    const [asked] = entries(fx)
    const older: RoundEntry = { ...asked, id: 'older', blocks: 'phase 2', since: '2026-10-14T07:00:00.000Z' }
    fx.files.set(`${ROUND}/older.json`, JSON.stringify(older) + '\n')
    await typedTurn(chains, fx, answerOf('Something else.', line))
    const after = new Map(entries(fx).map(e => [e.id, e]))
    expect([after.get(asked.id)!.status, after.get(asked.id)!.answer?.by]).toEqual(['withdrawn', 'tab'])
    expect([after.get('older')!.status, after.get('older')!.answer?.by]).toEqual(['withdrawn', 'sender'])
    expect(fx.logged.filter(l => l.includes('round: withdrawn by the sender: older')).length).toBe(1)
    expect(fx.logged.some(l => l.includes(`round: withdrawn by the sender: ${asked.id}`))).toBe(false)
  })
}

test('an entry withdrawn by a typed turn, its fingerprint forgotten: the same line asked again is entered again', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, QUESTION_LINE)))
  const [asked] = entries(fx)
  // The later wait withdraws the first, and its own entry cannot be written: nothing else
  // replaces the first wait's fingerprint.
  const later = turnEnd(answerOf('A new question?', 'waiting: operator — blocks: phase 4'))
  const laterId = roundEntry('s-one', 'Orch : belt', parseWait(later.answer)!, 'T', 'T').id
  const over = fake({ refuseInto: `${ROUND}/${laterId}.json` })
  over.files.clear()
  for (const [p, text] of fx.files) over.files.set(p, text)
  await typedTurn(chains, over, later.answer)
  expect(entries(over).find(e => e.id === asked.id)!.status).toBe('withdrawn')
  expect(over.row().relayed ?? null).toBeNull()
  await drive(chains, 'turn.complete', over.dollar, turnEnd(answerOf(QUESTION, QUESTION_LINE)))
  expect(entries(over).find(e => e.id === asked.id)!.status).toBe('open')
})

test('a stale entry that cannot be written is one log line, and the wait and its new entry are written all the same', async () => {
  const chains = mounted()
  const first = fake()
  await drive(chains, 'turn.complete', first.dollar, turnEnd(answerOf(QUESTION, QUESTION_LINE)))
  const [asked] = entries(first)
  const fx = fake({ refuseInto: `${ROUND}/${asked.id}.json` })
  fx.files.clear()
  for (const [p, text] of first.files) fx.files.set(p, text)
  const later = turnEnd(answerOf('A new question?', 'waiting: operator — blocks: phase 4'))
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  await drive(chains, 'turn.start', fx.dollar, { text: 'yes' })
  expect(await drive(chains, 'turn.complete', fx.dollar, later)).toBe(later)
  expect(fx.logged.filter(l => l.includes(`round: the file ${ROUND}/${asked.id}.json could not be renamed into place`)).length).toBe(1)
  expect(fx.logged.filter(l => l.includes(`withdraw: the file ${ROUND}/${asked.id}.json could not be renamed into place`)).length).toBe(1)
  expect(entries(fx).find(e => e.id === asked.id)!.status).toBe('open')
  expect(entries(fx).filter(e => e.blocks === 'phase 4').map(e => e.status)).toEqual(['open'])
  expect(fx.row().blocks).toBe('phase 4')
  expect(fx.row().relayed).toBe(fingerprint(parseWait(later.answer)!))
})

// --- an entry the operator answered from the coordinator's pane --------------------------------

test('after an answer from the pane, the same question asked again is entered again', async () => {
  const { chains, fx } = await relayedQuestion()
  const [asked] = entries(fx)
  const pane = { opened: null, ticker: null, other: new Set<string>(), undelivered: new Map(), answering: new Set<string>() }
  await answerFromPane({ ...fx.dollar, ui: { invalidate: () => undefined } }, pane, asked, { letter: 'A', text: 'merge it' })
  expect(entries(fx)[0].status).toBe('answered')
  expect(fx.row().relayed ?? null).toBeNull()
  await drive(chains, 'turn.start', fx.dollar, { text: 'A : merge it' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, QUESTION_LINE)))
  expect(entries(fx).map(e => [e.id, e.status])).toEqual([[asked.id, 'open']])
})

test('an answer from the pane drops the mark of a typed prompt from the wait file', async () => {
  const { chains, fx } = await relayedQuestion()
  const [asked] = entries(fx)
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer', 'what is the status of the build?'))
  expect(JSON.parse(fx.files.get(WAIT)!).typed).toBeTruthy()
  const pane = { opened: null, ticker: null, other: new Set<string>(), undelivered: new Map(), answering: new Set<string>() }
  await answerFromPane({ ...fx.dollar, ui: { invalidate: () => undefined } }, pane, asked, { letter: 'A', text: 'merge it' })
  expect(JSON.parse(fx.files.get(WAIT)!).typed ?? null).toBeNull()
})


test('an answer from the pane leaves a wait file that holds another fingerprint as it is', async () => {
  const { fx } = await relayedQuestion()
  const [asked] = entries(fx)
  const other = fingerprint({ kind: 'operator', blocks: 'phase 9', question: '' })
  fx.files.set(WAIT, JSON.stringify({ ...JSON.parse(fx.files.get(WAIT)!), relayed: other }) + '\n')
  const pane = { opened: null, ticker: null, other: new Set<string>(), undelivered: new Map(), answering: new Set<string>() }
  await answerFromPane({ ...fx.dollar, ui: { invalidate: () => undefined } }, pane, asked, { letter: 'A', text: 'merge it' })
  expect(fx.row().relayed).toBe(other)
})

// --- a question stays until it is answered ------------------------------------------------------

const CHOICED = 'Which way?\n- **A** : merge it now\n- **B** : wait a day\n_Recommendation_ : A'
const NOTE = 'The review of #12 has started.'

test('a prompt typed while a question is held only marks it; a turn ending on the same wait leaves it open', async () => {
  const { chains, fx } = await relayedQuestion()
  const key = fx.row().relayed
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer', 'what is the status of the build?'))
  expect(entries(fx).map(e => e.status)).toEqual(['open'])
  expect(fx.row().relayed).toBe(key)
  await drive(chains, 'turn.start', fx.dollar, { text: 'what is the status of the build?' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(NOTE, QUESTION_LINE)))
  expect(entries(fx).map(e => [e.status, e.answer])).toEqual([['open', null]])
  expect(fx.row().relayed).toBe(key)
  expect(JSON.parse(fx.files.get(WAIT)!).typed ?? null).toBeNull()
  // The mark was this turn's alone: a later turn on another line, not typed in, withdraws nothing.
  await drive(chains, 'turn.start', fx.dollar, { text: 'go on' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Done.', 'waiting: done')))
  expect(entries(fx).map(e => [e.blocks, e.status])).toEqual([['phase 3', 'open'], [null, 'open']])
})

for (const [label, line] of [['another operator wait', 'waiting: operator — blocks: phase 4'], ['done', 'waiting: done'], ['deferred', 'waiting: deferred — G5, G6'], ['no machine line', '']] as const) {
  test(`a prompt typed in, then a turn ending on ${label}, withdraws the held question by the tab`, async () => {
    const { chains, fx } = await relayedQuestion()
    const since = fx.row().waiting_since
    await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
    await drive(chains, 'turn.start', fx.dollar, { text: 'yes' })
    await drive(chains, 'turn.complete', fx.dollar, turnEnd(line ? answerOf('Something else.', line) : 'Working.'))
    const held = entries(fx).find(e => e.blocks === 'phase 3')!
    expect([held.status, held.since, held.answer?.text, held.answer?.by]).toEqual(['withdrawn', since, "answered in the sender's own tab", 'tab'])
    expect(fx.sent.length).toBe(0)
    expect(JSON.parse(fx.files.get(WAIT)!).typed ?? null).toBeNull()
    await drive(chains, 'turn.start', fx.dollar, { text: 'yes' })
    await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, QUESTION_LINE)))
    expect(entries(fx).find(e => e.blocks === 'phase 3')!.status).toBe('open')
  })
}

test('a mark left by a turn that ended without an answer does not make a later untyped turn withdraw', async () => {
  const { chains, fx } = await relayedQuestion()
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer', 'what is the status of the build?'))
  await drive(chains, 'turn.start', fx.dollar, { text: 'what is the status of the build?' })
  await drive(chains, 'turn.complete', fx.dollar, { ...turnEnd(''), reason: 'interrupt', isAborted: true })
  expect(JSON.parse(fx.files.get(WAIT)!).typed ?? null).toBeNull()
  await drive(chains, 'turn.start', fx.dollar, { text: '[module] a peer message' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Done.', 'waiting: done')))
  expect(entries(fx).map(e => [e.blocks, e.status])).toEqual([['phase 3', 'open'], [null, 'open']])
})


test('a question left open after an untyped turn ended on done is withdrawn by the tab once the operator types in', async () => {
  const { chains, fx } = await relayedQuestion()
  const since = fx.row().waiting_since
  await drive(chains, 'turn.start', fx.dollar, { text: '[module] a peer message' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Done.', 'waiting: done')))
  expect(entries(fx).find(e => e.blocks === 'phase 3')!.status).toBe('open')
  await typedTurn(chains, fx, answerOf('Done.', 'waiting: done'))
  const held = entries(fx).find(e => e.blocks === 'phase 3')!
  expect([held.status, held.since, held.answer?.text, held.answer?.by]).toEqual(['withdrawn', since, "answered in the sender's own tab", 'tab'])
  expect(JSON.parse(fx.files.get(WAIT)!).typed ?? null).toBeNull()
})


test('a coordinator on another machine is sent the withdrawal at the turn\'s end, not at the prompt', async () => {
  const { chains, fx } = await relayedQuestion({ remote: true })
  const since = fx.row().waiting_since
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  await drive(chains, 'turn.start', fx.dollar, { text: 'yes' })
  expect(fx.sent.length).toBe(0)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(NOTE, QUESTION_LINE)))
  expect(fx.sent.length).toBe(0)
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Something else.', 'waiting: operator — blocks: phase 4')))
  const [withdrawal, report] = fx.sent
  expect([withdrawal.to, withdrawal.text]).toEqual(['Coord : ops [abc]', withdrawalText('Orch : belt', 'phase 3', since)])
  expect(report.text).toContain('blocks: phase 4')
})

for (const [label, line] of [['done', 'waiting: done']] as const) {
  test(`a turn the operator did not start, ending on ${label}, leaves every open entry open`, async () => {
    const { chains, fx } = await relayedQuestion()
    const [asked] = entries(fx)
    await drive(chains, 'turn.start', fx.dollar, { text: '[module] a peer message' })
    await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Something else.', line)))
    expect(entries(fx).find(e => e.id === asked.id)).toEqual(asked)
    expect(fx.logged.some(l => l.includes('round: withdrawn by the sender'))).toBe(false)
    expect(entries(fx).length).toBe(2)
  })
}

test('a turn the operator did not start, ending on deferred, leaves every open entry open and enters none', async () => {
  const { chains, fx } = await relayedQuestion()
  const [asked] = entries(fx)
  await drive(chains, 'turn.start', fx.dollar, { text: '[module] a peer message' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Nothing left to move.', 'waiting: deferred — G5, G6')))
  expect(entries(fx)).toEqual([asked])
  expect(fx.logged.some(l => l.includes('round: withdrawn by the sender'))).toBe(false)
  expect(fx.row().waiting ?? null).toBeNull()
})

test('a turn the operator typed in, ending on deferred, withdraws the session\'s other open entries by the sender', async () => {
  const { chains, fx } = await relayedQuestion()
  const [held] = entries(fx)
  const older: RoundEntry = { ...held, id: 'older', blocks: 'phase 2', since: '2026-10-14T07:00:00.000Z' }
  fx.files.set(`${ROUND}/older.json`, JSON.stringify(older) + '\n')
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  await drive(chains, 'turn.start', fx.dollar, { text: 'yes' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Nothing left to move.', 'waiting: deferred — G5, G6')))
  const after = new Map(entries(fx).map(e => [e.id, e]))
  expect([after.get(held.id)!.status, after.get(held.id)!.answer?.by]).toEqual(['withdrawn', 'tab'])
  expect([after.get('older')!.status, after.get('older')!.answer?.by]).toEqual(['withdrawn', 'sender'])
  expect(after.size).toBe(2)
})

test('a turn the operator typed in withdraws the session\'s other open entries by the sender', async () => {
  const { chains, fx } = await relayedQuestion()
  const [held] = entries(fx)
  const older: RoundEntry = { ...held, id: 'older', blocks: 'phase 2', since: '2026-10-14T07:00:00.000Z' }
  fx.files.set(`${ROUND}/older.json`, JSON.stringify(older) + '\n')
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  await drive(chains, 'turn.start', fx.dollar, { text: 'yes' })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Something else.', 'waiting: operator — blocks: phase 4')))
  const after = new Map(entries(fx).map(e => [e.id, e]))
  expect([after.get(held.id)!.status, after.get(held.id)!.answer?.by]).toEqual(['withdrawn', 'tab'])
  expect([after.get('older')!.status, after.get('older')!.answer?.by]).toEqual(['withdrawn', 'sender'])
})

test('a text without choices, under the same wait, keeps the entry\'s question, choices and recommendation', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(CHOICED, QUESTION_LINE)))
  const [asked] = entries(fx)
  expect(asked.choices.map(c => c.letter)).toEqual(['A', 'B'])
  // The fingerprint forgotten (a failed write, a pane answer elsewhere): the note must not replace the entry.
  fx.files.set(WAIT, JSON.stringify({ ...JSON.parse(fx.files.get(WAIT)!), relayed: null }) + '\n')
  await drive(chains, 'turn.start', fx.dollar, { text: 'go on' })
  const written = [...fx.files.keys()].filter(p => p.startsWith(`${ROUND}/`))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(NOTE, QUESTION_LINE)))
  expect(entries(fx)).toEqual([asked])
  expect([...fx.files.keys()].filter(p => p.startsWith(`${ROUND}/`))).toEqual(written)
  expect(fx.row().relayed).toBe(fingerprint(parseWait(answerOf(NOTE, QUESTION_LINE))!))
})

test('a text that carries choices replaces the entry\'s question', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(CHOICED, QUESTION_LINE)))
  fx.files.set(WAIT, JSON.stringify({ ...JSON.parse(fx.files.get(WAIT)!), relayed: null }) + '\n')
  const again = 'Which now?\n- **A** : ship\n- **B** : hold\n- **C** : drop'
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(again, QUESTION_LINE)))
  const [now] = entries(fx)
  expect([entries(fx).length, now.status, now.choices.map(c => c.letter), now.recommendation]).toEqual([1, 'open', ['A', 'B', 'C'], null])
})

// --- a sender that is gone or handed over ----------------------------------------------------

// A sender with one open question in the round, beside another session's and a settled one.
async function senderWithEntries() {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, QUESTION_LINE)))
  const [asked] = entries(fx)
  const other: RoundEntry = { ...asked, id: 'other-session', session: 's-two', from: 'Orch : other' }
  const settled: RoundEntry = { ...asked, id: 'already-closed', status: 'closed', answer: { text: 'x', by: 'coordinator', at: 'T' } }
  for (const kept of [other, settled]) fx.files.set(`${ROUND}/${kept.id}.json`, JSON.stringify(kept) + '\n')
  return { chains, fx, asked, other, settled }
}

function expectWithdrawn(fx: ReturnType<typeof fake>, asked: RoundEntry, other: RoundEntry, settled: RoundEntry, why: string) {
  const after = new Map(entries(fx).map(e => [e.id, e]))
  expect([after.get(asked.id)!.status, after.get(asked.id)!.answer?.text, after.get(asked.id)!.answer?.by]).toEqual(['withdrawn', why, 'sender'])
  expect(fx.logged.filter(l => l.includes(`round: withdrawn by the sender: ${asked.id}`)).length).toBe(1)
  expect(after.get(other.id)).toEqual(other)
  expect(after.get(settled.id)).toEqual(settled)
}

test('the sender\'s session ending withdraws its open entries, and no other session\'s', async () => {
  const { chains, fx, asked, other, settled } = await senderWithEntries()
  await drive(chains, 'session.end', fx.dollar, { sessionId: 's-one', reason: 'exit' })
  expectWithdrawn(fx, asked, other, settled, "the sender's session ended")
})

test('the sender\'s row is deleted before the withdrawal runs, and a withdrawal that hangs does not hold the end past what the host leaves', async () => {
  const { chains, fx, asked } = await senderWithEntries()
  let rowThere: boolean | null = null
  const list = fx.dollar.fs.list
  fx.dollar.fs.list = async (dir: string) => {
    if (dir !== ROUND) return list(dir)
    rowThere = fx.files.has(ROW)
    return new Promise<never>(() => undefined)
  }
  const ended = { sessionId: 's-one', reason: 'exit' }
  const budget = { ms: 1500, remainingMs: 20 }
  const run = async (i: number, ev: any): Promise<any> =>
    i >= chains['session.end'].length ? ev : chains['session.end'][i](fx.dollar, ev, Object.assign((x: any) => run(i + 1, x), { budget }))
  expect(await run(0, ended)).toBe(ended)
  expect(rowThere).toBe(false)
  expect(fx.files.has(ROW)).toBe(false)
  expect(fx.logged.some(l => l.includes('round: did not finish within 20 ms'))).toBe(true)
  expect(entries(fx).find(e => e.id === asked.id)!.status).toBe('open')
})

for (const text of ['handed over', '**Handed over.**']) {
  test(`the sender's own message ${JSON.stringify(text)} to its successor withdraws its open entries, the message sent all the same`, async () => {
    const { chains, fx, asked, other, settled } = await senderWithEntries()
    const send = { to: 'Orch : belt-2', text, origin: { kind: 'model' } }
    expect(await drive(chains, 'session.send', fx.dollar, send)).toBe(send)
    expectWithdrawn(fx, asked, other, settled, 'handed over to its successor')
  })
}

test('a refused hand-over leaves the sender\'s open entries open', async () => {
  const { chains, fx, asked } = await senderWithEntries()
  const send = { to: 'Orch : belt-2', text: 'handed over', origin: { kind: 'model' } }
  const refused = { isDelivered: false, reason: 'nobody by that name' }
  expect(await chains['session.send'][0](fx.dollar, send, async () => refused)).toBe(refused)
  expect(entries(fx).find(e => e.id === asked.id)!.status).toBe('open')
  expect(fx.logged.some(l => l.includes('withdrawn by the sender'))).toBe(false)
})

test('another session\'s end, and another session\'s hand-over, leave this sender\'s open entries open', async () => {
  const { chains, fx, asked } = await senderWithEntries()
  await drive(chains, 'session.end', fx.dollar, { sessionId: 's-two', reason: 'exit' })
  expect(entries(fx).find(e => e.id === asked.id)!.status).toBe('open')
  const id = fx.dollar.session.id
  fx.dollar.session.id = async () => 's-two'
  await drive(chains, 'session.send', fx.dollar, { to: 'Orch : belt-2', text: 'handed over', origin: { kind: 'model' } })
  fx.dollar.session.id = id
  expect(entries(fx).find(e => e.id === asked.id)!.status).toBe('open')
})

test('a turn whose last line is « handed over » withdraws the sender\'s open entries', async () => {
  const { chains, fx, asked, other, settled } = await senderWithEntries()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Takeover confirmed by the successor.\n\nhanded over'))
  expectWithdrawn(fx, asked, other, settled, 'handed over to its successor')
})

test('a non-orchestrator\'s turn ending on « handed over » withdraws nothing', async () => {
  const chains = mounted()
  const ask = fake()
  await drive(chains, 'turn.complete', ask.dollar, turnEnd(answerOf(QUESTION, QUESTION_LINE)))
  const [asked] = entries(ask)
  const agent = fake({ name: 'Agent : belt-p3', role: 'agent' })
  agent.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(asked) + '\n')
  await drive(chains, 'turn.complete', agent.dollar, turnEnd('Takeover confirmed by the successor.\n\nhanded over'))
  expect(entries(agent).find(e => e.id === asked.id)!.status).toBe('open')
  expect(agent.logged.some(l => l.includes('withdrawn by the sender'))).toBe(false)
})

test('a turn whose last line is a wait after « handed over » withdraws nothing on that account', async () => {
  const { chains, fx, asked } = await senderWithEntries()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(`handed over\n\n${QUESTION}\n\n${QUESTION_LINE}`))
  expect(entries(fx).some(e => e.answer?.text === 'handed over to its successor')).toBe(false)
  expect(entries(fx).find(e => e.id === asked.id)!.status).toBe('open')
})

for (const [label, send] of [
  ['another message of the model', { to: 'Orch : belt-2', text: 'not handed over yet', origin: { kind: 'model' } }],
  ['a plugin\'s send', { to: 'Orch : belt-2', text: 'handed over', origin: { kind: 'plugin', name: 'other' } }],
  ['a subagent\'s send', { to: 'Orch : belt-2', text: 'handed over', origin: { kind: 'model' }, agentId: 'a-1' }],
] as const) {
  test(`${label} withdraws nothing`, async () => {
    const { chains, fx, asked } = await senderWithEntries()
    await drive(chains, 'session.send', fx.dollar, send)
    expect(entries(fx).find(e => e.id === asked.id)!.status).toBe('open')
  })
}

// --- a settled question leaves the coordinator's tab -------------------------------------------

// The operator answered « A » in the pane at 21:10:00Z, then the coordinator, which had presented
// the same question in its tab, relayed the same « A » again at 21:10:30Z (his report of
// 2026-10-25). An entry the coordinator was shown — listed by its `round`, or woken for — is
// closed by the module when its sender withdraws it, and the coordinator told once, with no
// command to run; one it never saw is only withdrawn, and tells it nothing.
const LISTED = `${HOME}/.claude/claude-orchestrator/round-listed.json`
const WOKEN = `${HOME}/.claude/claude-orchestrator/round-woken.json`
const DROP = 'Already closed: drop it, never ask or relay it again, present the next.'

test('the settled notice is worded by the answer the entry was closed with, and carries no command', () => {
  const asked = roundEntry('s-one', 'Orch : belt', parseWait(answerOf(QUESTION, QUESTION_LINE))!, '2026-10-25T21:00:00.000Z', 'T')
  const head = `Orch : belt's question since 2026-10-25T21:00:00.000Z (entry ${asked.id})`
  const at = '2026-10-25T21:10:00.000Z'
  for (const [text, by, expected] of [
    ['answered from the pane: A : "ship" it', 'pane', `[module] Settled in the pane: ${head} — answered at ${at}. ${DROP}`],
    ["withdrawn: answered in the sender's own tab", 'tab', `[module] Settled in Orch : belt's tab: ${head} — answered there. ${DROP}`],
    ["withdrawn: answered in the sender's own tab", 'sender', `[module] Settled in Orch : belt's tab: ${head} — answered there. ${DROP}`],
    ['withdrawn: superseded by s-one-17-abc', 'sender', `[module] Settled superseded: ${head} — by s-one-17-abc, present that one. ${DROP}`],
    ["withdrawn: the sender's session ended", 'sender', `[module] Settled: ${head} — session ended. ${DROP}`],
    ['withdrawn: handed over to its successor', 'sender', `[module] Settled: ${head} — handed over to its successor. ${DROP}`],
  ] as const) {
    expect(settledText(asked, { text, by, at })).toBe(expected)
  }
  expect(settledText(asked, { text: 'answered from the pane: A : "ship" it', by: 'pane', at })).not.toContain('ship')
})

for (const [label, file] of [['listed by its round', LISTED], ['woken for', WOKEN]] as const) {
  test(`a superseded entry the coordinator was ${label} is closed and tells it once, with the newer entry to present`, async () => {
    const chains = mounted()
    const fx = fake()
    await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, QUESTION_LINE)))
    const [asked] = entries(fx)
    fx.files.set(file, JSON.stringify([asked.id]) + '\n')
    await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('A new question?', 'waiting: operator — blocks: phase 4')))
    const [closed, fresh] = entries(fx)
    expect([closed.status, closed.answer?.text, closed.answer?.by]).toEqual(['closed', `withdrawn: superseded by ${fresh.id}`, 'sender'])
    expect(fx.sent).toEqual([{ to: 'Coord : ops [abc]', text: `[module] Settled superseded: Orch : belt's question since ${asked.since} (entry ${asked.id}) — by ${fresh.id}, present that one. ${DROP}` }])
  })
}

test('an entry the coordinator was never shown, neither listed nor woken for, is only withdrawn and tells it nothing', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, QUESTION_LINE)))
  fx.files.set(LISTED, JSON.stringify(['another-entry']) + '\n')
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('A new question?', 'waiting: operator — blocks: phase 4')))
  expect(entries(fx)[0].status).toBe('withdrawn')
  expect(fx.sent).toEqual([])
})

test('an entry the operator answered in the sender\'s own tab is closed and tells the coordinator that showed it', async () => {
  const { chains, fx } = await relayedQuestion()
  const [asked] = entries(fx)
  fx.files.set(LISTED, JSON.stringify([asked.id]) + '\n')
  await typedTurn(chains, fx, 'Working on phase 3.')
  expect([entries(fx)[0].status, entries(fx)[0].answer?.text, entries(fx)[0].answer?.by]).toEqual(['closed', "withdrawn: answered in the sender's own tab", 'tab'])
  expect(fx.sent).toEqual([{ to: 'Coord : ops [abc]', text: `[module] Settled in Orch : belt's tab: Orch : belt's question since ${asked.since} (entry ${asked.id}) — answered there. ${DROP}` }])
})

// A coordinator recorded by its bare name shares it with another session the host lists (a
// session of the same name kept by the host's remote control, say): the host refuses a send to
// that name as ambiguous, and the settled notice would be lost. The registry's own record of the
// session on this machine gives it unambiguously; without one, the refusal names it.
const AMBIGUOUS = "2 agents are named 'Coord : e2e'. Re-send with the ref of the one you mean:\n"
  + '  Coord : e2e [abc] — a session, on this machine, active 36s ago\n'
  + '  Coord : e2e [xyz] — a session, on another machine (Remote Control), active 30m ago'
async function ambiguousCoordinator(registry: Record<string, object>) {
  const { chains, fx } = await relayedQuestion()
  fx.files.set(RECORD, JSON.stringify({ name: 'Coord : e2e' }))
  for (const [pid, record] of Object.entries(registry)) fx.files.set(`${HOME}/.claude/sessions/${pid}.json`, JSON.stringify(record))
  const tried: unknown[] = []
  fx.dollar.session.send = async (args: { to: unknown; text: string }) => {
    tried.push(args.to)
    if (args.to === 'Coord : e2e') return { isDelivered: false, reason: AMBIGUOUS }
    fx.sent.push(args)
    return { isDelivered: true }
  }
  const [asked] = entries(fx)
  fx.files.set(LISTED, JSON.stringify([asked.id]) + '\n')
  await typedTurn(chains, fx, 'Noted.\n\nwaiting: done')
  return { fx, asked, tried }
}

test('a coordinator recorded by a name another session shares is sent the settled notice by its session id', async () => {
  const { fx, asked, tried } = await ambiguousCoordinator({
    4242: { pid: 4242, sessionId: 'coord-session', name: 'Coord : e2e', kind: 'interactive' },
    4343: { pid: 4343, sessionId: 'other-session', name: 'Orch : belt', kind: 'interactive' },
  })
  expect(entries(fx)[0].status).toBe('closed')
  expect(tried).toEqual([{ sessionId: 'coord-session' }])
  expect(fx.sent).toEqual([{ to: { sessionId: 'coord-session' }, text: `[module] Settled in Orch : belt's tab: Orch : belt's question since ${asked.since} (entry ${asked.id}) — answered there. ${DROP}` }])
})

test('with no record of it in the registry, the refusal of an ambiguous name is sent again to the one on this machine', async () => {
  const { fx, tried } = await ambiguousCoordinator({})
  expect(tried).toEqual(['Coord : e2e', 'Coord : e2e [abc]'])
  expect(fx.sent.map(s => s.to)).toEqual(['Coord : e2e [abc]'])
  expect(fx.logged).toEqual([])
})

test('an entry withdrawn by a typed turn ending on another wait is answered in the tab too', async () => {
  const { chains, fx } = await relayedQuestion()
  const [asked] = entries(fx)
  const older: RoundEntry = { ...asked, id: 'older', blocks: 'phase 2', since: '2026-10-14T07:00:00.000Z' }
  fx.files.set(`${ROUND}/older.json`, JSON.stringify(older) + '\n')
  fx.files.set(LISTED, JSON.stringify(['older']) + '\n')
  await typedTurn(chains, fx, answerOf('Something else.', 'waiting: operator — blocks: phase 4'))
  const closed = entries(fx).find(e => e.id === 'older')!
  expect([closed.status, closed.answer?.text, closed.answer?.by]).toEqual(['closed', "withdrawn: answered in the sender's own tab", 'sender'])
  expect(fx.sent.map(s => s.text)).toEqual([`[module] Settled in Orch : belt's tab: Orch : belt's question since ${older.since} (entry older) — answered there. ${DROP}`])
})

for (const [label, end, why] of [
  ['its session ending', async (chains: Record<string, Function[]>, fx: ReturnType<typeof fake>) => drive(chains, 'session.end', fx.dollar, { sessionId: 's-one', reason: 'exit' }), 'session ended'],
  ['its hand-over', async (chains: Record<string, Function[]>, fx: ReturnType<typeof fake>) => drive(chains, 'turn.complete', fx.dollar, turnEnd('Takeover confirmed.\n\nhanded over')), 'handed over to its successor'],
  ['its hand-over message', async (chains: Record<string, Function[]>, fx: ReturnType<typeof fake>) => drive(chains, 'session.send', fx.dollar, { to: 'Orch : belt-2', text: 'handed over', origin: { kind: 'model' } }), 'handed over to its successor'],
] as const) {
  test(`${label} closes every entry the coordinator was shown before it tells it of the first`, async () => {
    const { chains, fx, asked } = await senderWithEntries()
    const second: RoundEntry = { ...asked, id: 'second', blocks: 'phase 9' }
    fx.files.set(`${ROUND}/second.json`, JSON.stringify(second) + '\n')
    fx.files.set(LISTED, JSON.stringify([asked.id, 'second']) + '\n')
    const seen: string[][] = []
    const send = fx.dollar.session.send
    fx.dollar.session.send = async (args: { to: unknown; text: string }) => {
      if (args.text.startsWith('[module] Settled')) seen.push([asked.id, 'second'].map(id => entries(fx).find(e => e.id === id)!.status))
      return send(args)
    }
    await end(chains, fx)
    expect(seen).toEqual([['closed', 'closed'], ['closed', 'closed']])
    expect(fx.sent.filter(s => s.text.startsWith('[module] Settled')).map(s => s.text)).toEqual([asked, second].map(e =>
      `[module] Settled: Orch : belt's question since ${e.since} (entry ${e.id}) — ${why}. ${DROP}`))
  })
}

test('a notice that does not fit in what the session end leaves is one log line, the entries closed all the same', async () => {
  const { chains, fx, asked } = await senderWithEntries()
  const second: RoundEntry = { ...asked, id: 'second', blocks: 'phase 9' }
  fx.files.set(`${ROUND}/second.json`, JSON.stringify(second) + '\n')
  fx.files.set(LISTED, JSON.stringify([asked.id, 'second']) + '\n')
  fx.dollar.session.send = () => new Promise<never>(() => undefined)
  const ended = { sessionId: 's-one', reason: 'exit' }
  const budget = { ms: 1500, remainingMs: 60 }
  const run = async (i: number, ev: any): Promise<any> =>
    i >= chains['session.end'].length ? ev : chains['session.end'][i](fx.dollar, ev, Object.assign((x: any) => run(i + 1, x), { budget }))
  expect(await run(0, ended)).toBe(ended)
  expect([asked.id, 'second'].map(id => entries(fx).find(e => e.id === id)!.status)).toEqual(['closed', 'closed'])
  for (const id of [asked.id, 'second']) expect(fx.logged.filter(l => l.endsWith(`| round: no time left to tell Coord : ops [abc] that ${id} is settled`)).length).toBe(1)
})

test('a coordinator on another machine is told nothing of a withdrawal in this round, and the entry is only withdrawn', async () => {
  const chains = mounted()
  const fx = fake({ remote: true })
  // The round on this machine holds the sender's entry, listed as if shown: only a coordinator on
  // this machine reads it, so it is neither closed nor told.
  const asked = roundEntry('s-one', 'Orch : belt', parseWait(answerOf(QUESTION, QUESTION_LINE))!, '2026-10-25T21:00:00.000Z', 'T')
  fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(asked) + '\n')
  fx.files.set(LISTED, JSON.stringify([asked.id]) + '\n')
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Takeover confirmed.\n\nhanded over'))
  expect([entries(fx)[0].status, entries(fx)[0].answer?.text]).toEqual(['withdrawn', 'handed over to its successor'])
  expect(fx.sent.filter(s => s.text.startsWith('[module] Settled'))).toEqual([])
})

// --- what a turn truly waits on ------------------------------------------------------------

// A turn that waits on a command of its own, or that declares a wait on the operator blocking
// nothing, asks him nothing: neither is entered in the round, nor sent, nor kept as a wait.
test('neither a tool wait nor an operator wait blocking nothing is a wait', () => {
  expect(parseWait(answerOf('Deploys started.', 'waiting: tool — the deploy monitor'))).toBeNull()
  for (const blocks of ['nothing', 'Nothing.', 'none', 'nothing yet', 'n/a', '-', '']) {
    expect([blocks, parseWait(answerOf('Watching.', `waiting: operator — blocks: ${blocks}`))]).toEqual([blocks, null])
  }
  expect(parseWait(answerOf('Watching.', 'waiting: operator (urgent) — blocks: none'))).toBeNull()
})

for (const line of ['waiting: tool — the deploy monitor', 'waiting: operator — blocks: nothing', 'waiting: deferred — row 5, G5, G6']) {
  test(`a turn ending on « ${line} » enters nothing, sends nothing, and clears the wait`, async () => {
    const chains = mounted()
    const local = fake()
    await drive(chains, 'turn.complete', local.dollar, turnEnd(answerOf('Monitor event: deploy 1 done.', line)))
    expect(entries(local).length).toBe(0)
    expect(local.sent.length).toBe(0)
    expect(local.row()!.waiting ?? null).toBeNull()
    expect(local.row()!.blocks ?? null).toBeNull()
    const remote = fake({ remote: true })
    await drive(chains, 'turn.complete', remote.dollar, turnEnd(answerOf('Monitor event: deploy 1 done.', line)))
    // The row the measure sends a remote coordinator may follow; no wait is reported in it.
    expect(remote.sent.filter(s => /waits for the operator|reports its work done/.test(s.text))).toEqual([])
    expect(remote.sent.every(s => !s.text.includes('the deploy monitor') && !s.text.includes('blocks: nothing'))).toBe(true)
  })
}

// The loop: every monitor event woke a turn, each ended on a wait for the operator that blocked
// nothing. Such turns, many in a row, leave a real question entered before them as it was.
test('turns that wait on a tool, one per monitor event, leave the open question and its entry untouched', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3')))
  const [entry] = entries(fx)
  for (let i = 0; i < 3; i++) {
    await drive(chains, 'turn.start', fx.dollar, { text: '' })
    await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(`Monitor event ${i}.`, i % 2 ? 'waiting: operator — blocks: nothing' : 'waiting: tool — the monitor')))
  }
  expect(entries(fx)).toEqual([entry])
  expect(fx.sent.length).toBe(0)
})
