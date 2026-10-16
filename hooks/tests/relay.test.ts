// hooks/tests/relay.test.ts
// An orchestrator's end of turn read by the module (relay.ts, wired in supervision.ts):
// the machine line parsed into the row's wait fields, one report to a running
// coordinator per wait, none twice, none without a coordinator, none from a session
// that is no orchestrator, and a send that fails never holding the turn's end.
import { expect, test } from 'claude-code/testing'
import { parseWait, waitPatch, fingerprint, relayText, coordinatorOf, waitLabel, heldQuestion, withdrawalText, RELAY_CAP } from '../relay.ts'
import { parseSessionRow, paneRows, withWait, writeSession, readSessions, type SessionRow } from '../supervision.ts'
import { register } from '../register.ts'
import { logLineOf } from './fakes.ts'

const HOME = '/tmp/h'
const ROW = `${HOME}/.claude/claude-orchestrator/store/sessions/s-one`
const WAIT = `${HOME}/.claude/claude-orchestrator/store/waits/s-one`
const RECORD = `${HOME}/.claude/claude-orchestrator/coordinator.json`
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

function fake(over: { name?: string; role?: SessionRow['role']; coordinator?: string | null; send?: 'reject' | 'refuse' } = {}) {
  const files = new Map<string, string>()
  const sent: { to: unknown; text: string }[] = []
  const logged: string[] = []
  files.set(ROW, JSON.stringify({
    role: over.role === undefined ? 'orchestrator' : over.role, name: over.name ?? 'Orch : belt', pid: '501', repo: null,
    context_percent: 20, context_tokens: 1, window: 100, model: 'a-model', busy: false, updated_at: '2026-10-14T09:00:00.000Z',
  }) + '\n')
  if (over.coordinator !== null) files.set(RECORD, JSON.stringify({ name: over.coordinator ?? 'Coord : ops [abc]', tty: '/dev/ttys9' }))
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

test('an operator wait lands in the row and is sent to the coordinator once', async () => {
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
  expect(fx.sent.length).toBe(1)
  expect(fx.sent[0].to).toBe('Coord : ops [abc]')
  expect(fx.sent[0].text).toBe(`[module] Orch : belt waits for the operator since ${row.waiting_since} — blocks: phase 3\nreply with SendMessage to: Orch : belt\n\n${QUESTION}`)
})

test('the same wait is never sent twice, whatever progress the turns between report; a new line is', async () => {
  const chains = mounted()
  const fx = fake()
  const same = turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3'))
  await drive(chains, 'turn.complete', fx.dollar, same)
  await drive(chains, 'turn.start', fx.dollar, { text: '' })
  await drive(chains, 'turn.complete', fx.dollar, same)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('The review of #12 has started.', 'waiting: operator — blocks: phase 3')))
  expect(fx.sent.length).toBe(1)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('A new question?', 'waiting: operator — blocks: phase 4')))
  expect(fx.sent.length).toBe(2)
  expect(fx.sent[1].text).toContain('A new question?')
})

test('done is one closing proposal', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Everything merged.', 'waiting: done')))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Everything merged.', 'waiting: done')))
  expect(fx.sent.map(s => s.text)).toEqual(['[module] Orch : belt reports its work done and proposes to be closed\nreply with SendMessage to: Orch : belt'])
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
  expect(fx.row()!.waiting).toBe('operator')
})

for (const [name, role] of [['Coord : ops', 'coordinator'], ['Agent : belt-p3', 'agent'], ['Audit : method', 'auditor']] as const) {
  test(`a session that is no orchestrator (${role}) writes nothing and sends nothing`, async () => {
    const chains = mounted()
    const fx = fake({ name, role })
    const before = fx.files.get(ROW)
    await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3')))
    expect(fx.sent.length).toBe(0)
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
    const fx = fake({ send: failure })
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
    expect(fx.sent.length).toBe(1)
    expect(fx.sent[0].to).toBe('Coord : ops [abc]')
    expect(fx.sent[0].text).toBe(withdrawalText('Orch : belt', 'phase 3', since))
    expect(fx.row().relayed ?? null).toBeNull()
    await drive(chains, 'prompt.submit', fx.dollar, typed(kind, 'and more'))
    expect(fx.sent.length).toBe(1)
  })
}

test('the withdrawal holds when a turn start cleared the wait first', async () => {
  const { chains, fx } = await relayedQuestion()
  await drive(chains, 'turn.start', fx.dollar, { text: 'yes' })
  await drive(chains, 'prompt.submit', fx.dollar, typed('composer'))
  expect(fx.sent.length).toBe(1)
})

for (const [label, setup, kind] of [
  ['another prompt kind', {}, 'peer'],
  ['an agent session', { name: 'Agent : belt-p3', role: 'agent' as const }, 'composer'],
  ['no coordinator', { coordinator: null }, 'composer'],
] as const) {
  test(`nothing is withdrawn for ${label}`, async () => {
    const { chains, fx } = await relayedQuestion(setup)
    const before = fx.files.get(WAIT)
    const e = typed(kind)
    expect(await drive(chains, 'prompt.submit', fx.dollar, e)).toBe(e)
    expect(fx.sent.length).toBe(0)
    expect(fx.files.get(WAIT)).toBe(before)
  })
}

for (const text of ['/orchestrator:status', '  /x']) {
  test(`a composer prompt that is a slash command (${JSON.stringify(text)}) withdraws nothing`, async () => {
    const { chains, fx } = await relayedQuestion()
    const before = fx.files.get(WAIT)
    const e = typed('composer', text)
    expect(await drive(chains, 'prompt.submit', fx.dollar, e)).toBe(e)
    expect(fx.sent.length).toBe(0)
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
  const { chains, fx } = await relayedQuestion()
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
  const { chains, fx } = await relayedQuestion()
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
  expect(fx.sent.length).toBe(1)
  expect(fx.sent[0].text).toContain('waits for the operator')
})
