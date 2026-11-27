// hooks/tests/relay.test.ts
// An orchestrator's end of turn read by the module (relay.ts, wired in supervision.ts):
// the machine line parsed into the row's wait fields, one entry in the round of a
// coordinator on this machine per wait, one report to a coordinator on another, none
// twice, none without a coordinator, none from a session that is no orchestrator, and a
// write or a send that fails never holding the turn's end.
import { expect, test } from 'claude-code/testing'
import { declaredWait, waitPatch, fingerprint, relayText, coordinatorOf, waitLabel, waitParts, heldQuestion, openQuestions, withdrawalText, confirmsTakeover, RELAY_CAP } from '../relay.ts'
import { roundEntry, type RoundEntry } from '../round.ts'
import { settledText, successorText, parseSessionRow, paneRows, withWait, writeSession, readSessions, WORKS_AGAIN, HANDED_ON, type SessionRow } from '../supervision.ts'
import { register } from '../register.ts'
import { answerAskedFromPane, askTurnStarted, callAsk, settle } from '../question.ts'
import { forgetResendTimer, resendReplies } from '../remote-asked.ts'
import { DECLARATIONS } from '../wait.ts'
import type { DeclaredWait } from '../stop-gate.ts'
import { logLineOf, lockRun } from './fakes.ts'
import { capture, hookOf, hooksOn, hostOf, type Captured } from '../../core/capture.ts'
import { fieldsOf, type Events, type Host, type Noun, type SessionSendResult } from '../../core/host.ts'
import { Q_MARKER, qAskLine, qAckLine, qReplyLine, parseQ, parseQAck, seqOf, splitLines } from '../remote-round.ts'

// The lines written between machines: the event line (remote-round.ts) and its acknowledgment.
const askLine = qAskLine
const ackLine = (id: string, since: string) => qAckLine({ id, seq: seqOf(since), of: 'ask' })
const isAskLine = (text: string) => parseQ(text)?.event.kind === 'ask'
const askObject = (text: string) => JSON.parse(text.slice(Q_MARKER.length)).event.entry
function parseAsk(text: string) {
  const q = parseQ(text)
  return q?.event.kind === 'ask' ? { entry: q.event.entry, machine: q.event.machine } : null
}

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

// A test's turn as its model ends it: the wait its last line names is the one it declared
// (declare_wait), and the line is no part of the answer the relay reads.
function declaredOf(answer: string): { wait: DeclaredWait | null; text: string } {
  const lines = answer.replace(/\s+$/, '').split('\n')
  const last = (lines.at(-1) ?? '').replace(/\*/g, '').trim()
  const text = lines.slice(0, -1).join('\n').trim()
  const operator = /^waiting:\s*operator\s*(\(urgent\)\s*)?(?:—|–|--|-)\s*blocks:\s*(.*)$/i.exec(last)
  if (operator) return { wait: { kind: 'operator', blocks: (operator[2] ?? '').trim(), ...(operator[1] ? { urgent: true as const } : {}) }, text }
  if (/^waiting:\s*done$/i.test(last)) return { wait: { kind: 'done', blocks: '' }, text }
  const deferred = /^waiting:\s*deferred\s*(?:—|–|--|-)\s*(.+)$/i.exec(last)
  if (deferred) return { wait: { kind: 'deferred', blocks: (deferred[1] ?? '').trim() }, text }
  return { wait: null, text: answer }
}
const parseWait = (answer: string) => {
  const declared = declaredOf(answer)
  return declaredWait(declared.wait, declared.text)
}

// A turn that ends on the closing proposal: the relay's one round entry.
const PROPOSAL = answerOf('Everything merged.', 'waiting: done')

// --- the pure half ------------------------------------------------------------------------

test('the declared wait is the relay\'s: the operator with what it blocks, or done, the answer its question', () => {
  expect(declaredWait({ kind: 'operator', blocks: 'phase 3' }, `${QUESTION}\n`)).toEqual({ kind: 'operator', blocks: 'phase 3', question: QUESTION })
  expect(declaredWait({ kind: 'done', blocks: '' }, 'All merged.')).toEqual({ kind: 'done', question: 'All merged.' })
  expect(declaredWait({ kind: 'operator', blocks: 'x', urgent: true }, QUESTION)).toEqual({ kind: 'operator', blocks: 'x', question: QUESTION, urgent: true })
  // No declaration is no wait, whatever the answer's last line says; the deferred ending asks him nothing.
  expect(declaredWait(null, answerOf('All merged.', 'waiting: done'))).toBeNull()
  expect(declaredWait({ kind: 'deferred', blocks: 'row 5, G5, G6' }, 'Nothing left to move.')).toBeNull()
})

test('the row fields: the wait since now, kept while the same wait lasts', () => {
  const wait = parseWait(answerOf(QUESTION, 'waiting: operator — blocks: phase 3'))!
  const first = waitPatch(null, wait, '2026-10-14T10:00:00.000Z')
  expect(first).toEqual({ waiting: 'operator', blocks: 'phase 3', waiting_since: '2026-10-14T10:00:00.000Z' })
  const row = { ...first }
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
  expect(relayText('Orch: belt', wait, '2026-10-14T10:00:00.000Z')).toBe(
    `[module] Orch: belt waits for the operator since 2026-10-14T10:00:00.000Z — blocks: phase 3\nreply with SendMessage to: Orch: belt\n\n${QUESTION}`)
  const long = parseWait(answerOf('x'.repeat(RELAY_CAP + 10), 'waiting: operator — blocks: phase 3'))!
  const text = relayText('Orch: belt', long, 'T')
  expect(text).toContain(`[cut at ${RELAY_CAP} of ${RELAY_CAP + 10} characters]`)
  expect(text.length).toBeLessThan(RELAY_CAP + 200)
  expect(relayText('Orch: belt', { kind: 'done', question: 'x' }, 'T')).toBe('[module] Orch: belt reports its work done and proposes to be closed\nreply with SendMessage to: Orch: belt')
})

test('the coordinator is read from its record, and no record names nobody', () => {
  expect(coordinatorOf('{"name":"Coord: ops [abc]","tty":"/dev/ttys1"}')).toBe('Coord: ops [abc]')
  expect(coordinatorOf('')).toBeNull()
  expect(coordinatorOf('{"tty":"/dev/ttys1"}')).toBeNull()
})

test('the pane and status label carry the wait', () => {
  const since = '2026-10-14T10:07:00.000Z'
  const at = new Date(since)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const row: SessionRow = { role: 'orchestrator', name: 'Orch: belt', repo: null, context_percent: 20, context_tokens: 1, window: 100, model: 'a-model',
    busy: false, updated_at: new Date().toISOString(), waiting: 'operator', blocks: 'phase 3', waiting_since: since }
  expect(waitLabel(row)).toBe(`waiting for the operator since ${hhmm} — blocks: phase 3`)
  expect(only(paneRows({ a: row })).label).toContain(`waiting for the operator since ${hhmm} — blocks: phase 3`)
  expect(waitLabel({ ...row, waiting: 'done' })).toBe(`done since ${hhmm}, proposes to be closed`)
  expect(waitLabel({ ...row, waiting: null })).toBeNull()
})

test('the wait is split at its source: the status words and what it blocks, joined back by the label', () => {
  const since = '2026-10-14T10:07:00.000Z'
  const at = new Date(since)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const row: SessionRow = { role: 'orchestrator', name: 'Orch: belt', repo: null, context_percent: 20, context_tokens: 1, window: 100, model: 'a-model',
    busy: false, updated_at: new Date().toISOString(), waiting: 'operator', blocks: 'phase 3', waiting_since: since }
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

test('a live operator wait whose blocks is empty vouches for nothing: unknown, never none held', () => {
  const key = fingerprint({ kind: 'operator', blocks: '', question: '' })
  const wait = { waiting: 'operator' as const, blocks: '', waiting_since: 'T', relayed: key }
  expect(openQuestions(wait)).toBeNull()
  expect(openQuestions({ ...wait, blocks: 'phase 3', relayed: fingerprint({ kind: 'operator', blocks: 'phase 3', question: '' }) })).toEqual([{ since: 'T', blocks: 'phase 3' }])
})

test('the withdrawal names the sender, the question and where it was answered', () => {
  expect(withdrawalText('Orch: belt', 'phase 3', '2026-10-14T10:00:00.000Z')).toBe(
    "[module] Orch: belt withdraws its question for the operator since 2026-10-14T10:00:00.000Z — blocks: phase 3\nthe operator answered it in Orch: belt's own tab: nothing to send back")
  expect(withdrawalText('Orch: belt', 'phase 3', null)).toContain('since ? — blocks: phase 3')
})

// --- the wiring over a faked $ ------------------------------------------------------------

// The coordinator is registered on this machine unless `remote`, where it is the one a peer
// delivery taught (coordinator-learnt). `roundWrite: 'fail'` refuses every rename into the round,
// `refuseInto` the renames into that one file. `staleAt` is an address the host answers as stale, as a
// bridge does once its session ended, and the address the peer delivery taught.
function fake(over: { name?: string; role?: SessionRow['role']; coordinator?: string | null; remote?: boolean; send?: 'reject' | 'refuse'; roundWrite?: 'fail'; refuseInto?: string; staleAt?: string } = {}) {
  const files = new Map<string, string>()
  const sent: Parameters<World['session']['send']>[0][] = []
  // The messages as sent, a turn's end being one of several lines.
  const messages: string[] = []
  const logged: string[] = []
  const later: { ms: number; fn: () => unknown; cancelled: boolean }[] = []
  const invalidated: string[] = []
  files.set(ROW, JSON.stringify({
    role: over.role === undefined ? 'orchestrator' : over.role, name: over.name ?? 'Orch: belt', pid: '501', repo: null,
    context_percent: 20, context_tokens: 1, window: 100, model: 'a-model', busy: false, updated_at: '2026-10-14T09:00:00.000Z',
  }) + '\n')
  if (over.coordinator !== null && over.remote) files.set(LEARNT, JSON.stringify({ name: over.coordinator ?? 'Coord: ops [abc]', from: over.staleAt ?? null, at: 'T' }) + '\n')
  else if (over.coordinator !== null) files.set(RECORD, JSON.stringify({ name: over.coordinator ?? 'Coord: ops [abc]', tty: '/dev/ttys9' }))
  const dollar: World = hostOf({
    session: {
      id: async () => 's-one',
      send: async (args: Parameters<World['session']['send']>[0]): Promise<SessionSendResult> => {
        if (over.send === 'reject') throw new Error('the send was rejected')
        if (over.send === 'refuse') return { isDelivered: false, reason: 'nobody by that name' }
        if (over.staleAt !== undefined && args.to === over.staleAt) return { isDelivered: false, reason: `Failed to send to ${over.staleAt}: HTTP 409 — the peer session may have ended or restarted, so this bridge ID is stale.` }
        // A turn's end is one message of several lines: each line is read as a send of its own here.
        messages.push(args.text)
        for (const text of splitLines(args.text) ?? [args.text]) sent.push({ ...args, text })
        return { isDelivered: true }
      },
    },
    env: { get: async (name: string) => ({ HOME } as Record<string, string>)[name] },
    plugin: { root: '/plugins/orch-root' },
    fs: {
      read: async (p: string) => {
        const text = files.get(p)
        if (text === undefined) throw new Error(`ENOENT: ${p}`)
        return text
      },
      write: async (p: string, text: string) => { files.set(p, text) },
      exists: async (p: string) => files.has(p),
      list: async (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
      stat: async (p: string) => { throw new Error(`ENOENT: ${p}`) },
    },
    process: {
      run: async (argv: readonly string[]) => {
        const locked = lockRun(argv, files)
        if (locked) return locked
        const line = logLineOf(argv)
        if (line !== null) logged.push(line)
        if (argv[0] === 'mv' && over.roundWrite === 'fail' && String(argv[3]).startsWith(`${ROUND}/`)) return { exitCode: 1, stdout: '', stderr: 'refused' }
        if (argv[0] === 'mv' && over.refuseInto !== undefined && argv[3] === over.refuseInto) return { exitCode: 1, stdout: '', stderr: 'refused' }
        const [, , from = '', to = ''] = argv
        if (argv[0] === 'mv' && files.has(from)) {
          files.set(to, files.get(from)!)
          files.delete(from)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'mkdir') return { exitCode: 0, stdout: '', stderr: '' }
        if (argv[0] === 'rm') {
          for (const p of argv.slice(2)) files.delete(p)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        return { exitCode: 1, stdout: '', stderr: '' }
      },
    },
    command: { run: async () => undefined },
    prompt: { submit: async () => undefined },
    settings: { read: async () => ({}) },
    // The coordinator's round wake is armed on the clock, and a round write redraws the pane.
    clock: {
      after: (ms: number, fn: () => unknown) => {
        const timer = { ms, fn, cancelled: false }
        later.push(timer)
        return { cancel: () => { timer.cancelled = true } }
      },
      every: () => ({ cancel: () => undefined }),
    },
    ui: { invalidate: (what: string) => { invalidated.push(what) } },
  })
  return { dollar, files, sent, messages, logged, later, invalidated, row: () => withWait(parseSessionRow(files.get(ROW) ?? '')!, files.get(WAIT) ?? '') }
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

// The host a hook under test is handed: every noun, those a test does not set throwing.
type World = Host<Noun>
type Hooks = Array<Captured<World>>

function mounted(): Hooks {
  return capture<World>(register)
}

// Raises `event` through the module's hooks on it, in their order, each one's `next` the one after;
// `budget` is the bound the host leaves them.
async function drive<K extends keyof Events>(chains: Hooks, event: K, dollar: World, e: Events[K], budget?: { readonly remainingMs: number }): Promise<unknown> {
  const chain = hooksOn(chains, event)
  const declared = declaredIn.get(e)
  if (declared !== undefined) {
    DECLARATIONS.turnStarted()
    if (declared !== null) DECLARATIONS.declare(declared)
  }
  const run = async (i: number, ev: Events[K]): Promise<unknown> => {
    const hook = chain[i]
    return hook === undefined ? ev : hook.handler(dollar, ev, Object.assign((x: Events[K]) => run(i + 1, x), budget === undefined ? {} : { budget }))
  }
  return run(0, e)
}

// The item at `i` of a list the test expects it in.
function only<T>(items: readonly T[], i = 0): T {
  const item = items[i]
  if (item === undefined) throw new Error(`no item ${i} among ${items.length}`)
  return item
}

// What a delivery's chain answered, as the tests read it: consumed by the module, or passed on with its text.
async function receive(chains: Hooks, dollar: World, e: Events['session.receive']): Promise<{ consumed: unknown; text: unknown }> {
  const answer = fieldsOf(await drive(chains, 'session.receive', dollar, e))
  return { consumed: answer?.['consumed'], text: answer?.['text'] }
}

// A turn's end: driven, it is a new turn of the session, the wait its answer's last line names declared in it.
const declaredIn = new WeakMap<object, DeclaredWait | null>()
const waitOfEnd = (e: { answer: string }) => declaredWait(declaredIn.get(e) ?? null, e.answer)
const turnEnd = (answer: string) => {
  const declared = declaredOf(answer)
  const e = { answer: declared.text, reason: 'answer', isAborted: false, turnId: 't' }
  declaredIn.set(e, declared.wait)
  return e
}

// The operator's ruling of 2026-11-14 (a): a wait on questions asked with `ask` is no entry of the
// relay's, the questions being their own objects in the round; its row still shows it waiting.
test('an operator wait on questions asked with ask enters no entry and sends nothing, and its row shows it waiting', async () => {
  const chains = mounted()
  const fx = fake()
  DECLARATIONS.turnStarted()
  DECLARATIONS.declare({ kind: 'operator', blocks: 'phase 3', asked: ['q-s-one-1'] })
  await drive(chains, 'turn.complete', fx.dollar, { answer: 'J\'attends sa réponse.', reason: 'answer', isAborted: false, turnId: 't' })
  expect(entries(fx)).toEqual([])
  expect(fx.sent.length).toBe(0)
  const row = fx.row()!
  expect([row.waiting, row.blocks]).toEqual(['operator', 'phase 3'])
  expect(only(paneRows({ a: row })).label).toContain('waiting for the operator since')
  expect(only(paneRows({ a: row })).label).toContain('blocks: phase 3')
  // The next turn ends on the closing proposal: that one is entered.
  DECLARATIONS.turnStarted()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(PROPOSAL))
  expect(entries(fx).length).toBe(1)
})

test('done is one closing proposal', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Everything merged.', 'waiting: done')))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Everything merged.', 'waiting: done')))
  expect(entries(fx).map(e => [e.kind, e.from, e.blocks, e.question, e.status])).toEqual([['done', 'Orch: belt', null, 'Everything merged.', 'open']])
  expect(fx.sent.length).toBe(0)
  expect(fx.row()!.waiting).toBe('done')
})

test('a turn that starts, or ends without a machine line, clears the wait', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 3')))
  await drive(chains, 'turn.start', fx.dollar, {})
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

for (const [name, role] of [['Agent: belt-p3', 'agent']] as const) {
  test(`a session that is no orchestrator, coordinator or auditor (${role}) writes nothing and sends nothing`, async () => {
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
    const e = turnEnd(PROPOSAL)
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
  const row = (await readSessions(fx.dollar))['sessions/s-one']!
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
  await drive(chains, 'turn.start', fx.dollar, {})
  expect(fx.row().waiting).toBeNull()
  await drive(chains, 'turn.complete', fx.dollar, same)
  expect(fx.row().waiting_since).toBe(first)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf(QUESTION, 'waiting: operator — blocks: phase 4')))
  expect(fx.row().waiting_since).not.toBe(first)
})

// --- a closing proposal entered in the round ---------------------------------------------------

const QUESTION_LINE = 'waiting: operator — blocks: phase 3'
const typed = (kind: string, text = 'yes') => ({ text, origin: { kind } })

async function relayedProposal(over: Parameters<typeof fake>[0] = {}) {
  const chains = mounted()
  const fx = fake(over)
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(PROPOSAL))
  // A coordinator on another machine acknowledges the entry it was sent: the proposal is then held.
  if (over.remote) await drive(chains, 'session.receive', fx.dollar, {
    text: `<cross-session-message from="bridge:session_coord" from-name="Coord: ops [abc]">\n${ackLine(JSON.parse(fx.files.get(WAIT)!).pending, JSON.parse(fx.files.get(WAIT)!).waiting_since)}\n</cross-session-message>`,
    origin: { kind: 'peer' },
  })
  fx.sent.length = 0
  return { chains, fx }
}

// --- a coordinator on this machine reads the round; one elsewhere is sent the message ---------

test('a coordinator on another machine is sent the wait as an entry of its round, and nothing enters a round here', async () => {
  const chains = mounted()
  const fx = fake({ remote: true })
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(PROPOSAL))
  const row = fx.row()
  const report = fx.sent.filter(s => s.text.startsWith('[module]') || isAskLine(s.text))
  expect(report.length).toBe(1)
  expect(only(report).to).toBe('Coord: ops [abc]')
  const sent = askObject(only(report).text)
  const entry = roundEntry('s-one', 'Orch: belt', parseWait(PROPOSAL)!, row.waiting_since!, sent.at)
  expect(only(report).text).toBe(askLine(entry, 'unknown'))
  expect(entries(fx)).toEqual([])
  expect([JSON.parse(fx.files.get(WAIT)!).pending, row.relayed ?? null]).toEqual([entry.id, null])
})

test('a round entry that cannot be written is logged, never holds the turn\'s end, and is tried again on the same wait', async () => {
  const chains = mounted()
  const over: { roundWrite?: 'fail' } = { roundWrite: 'fail' }
  const fx = fake(over)
  const e = turnEnd(PROPOSAL)
  expect(await drive(chains, 'turn.complete', fx.dollar, e)).toBe(e)
  expect(fx.logged.some(l => l.includes('| supervision |') && l.includes('relay:') && l.includes('/round/'))).toBe(true)
  expect(entries(fx)).toEqual([])
  expect(fx.row().relayed ?? null).toBeNull()
  expect(fx.sent.length).toBe(0)
  delete over.roundWrite
  await drive(chains, 'turn.complete', fx.dollar, e)
  expect(entries(fx).length).toBe(1)
  expect(fx.row().relayed).toBe(fingerprint(waitOfEnd(e)!))
})

// --- an entry its sender no longer waits on ---------------------------------------------------

test('a later turn that ends on no machine line leaves the sender\'s open entries as they are', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(PROPOSAL))
  await drive(chains, 'turn.complete', fx.dollar, turnEnd('Working on phase 3.'))
  expect(entries(fx).map(e => [e.status, e.answer])).toEqual([['open', null]])
  expect(fx.logged.some(l => l.includes('round: withdrawn by the sender'))).toBe(false)
})

test('a turn the operator did not start, ending on deferred, withdraws the closing proposal alone, leaves every other open entry open and enters none', async () => {
  const { chains, fx } = await relayedProposal()
  const proposal = only(entries(fx))
  const question: RoundEntry = { ...proposal, id: 's-one-question', kind: 'operator', blocks: 'phase 3', question: QUESTION }
  fx.files.set(`${ROUND}/${question.id}.json`, JSON.stringify(question) + '\n')
  await drive(chains, 'turn.start', fx.dollar, {})
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(answerOf('Nothing left to move.', 'waiting: deferred — G5, G6')))
  const after = new Map(entries(fx).map(e => [e.id, e]))
  expect(after.size).toBe(2)
  expect(after.get(question.id)).toEqual(question)
  expect([after.get(proposal.id)!.status, after.get(proposal.id)!.answer?.text, after.get(proposal.id)!.answer?.by]).toEqual(['withdrawn', WORKS_AGAIN, 'sender'])
  expect(fx.logged.filter(l => l.includes('round: withdrawn by the sender')).map(l => l.slice(l.indexOf('round:')))).toEqual([`round: withdrawn by the sender: ${proposal.id}`])
  expect(fx.row().waiting ?? null).toBeNull()
})

// --- a sender that is gone or handed over ----------------------------------------------------

// A sender with one open operator question in the round, beside another session's and a settled one. Its
// turn ended on a closing proposal, whose entry gives way to the question: a closing proposal is never moved.
async function senderWithEntries() {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(PROPOSAL))
  const proposal = only(entries(fx))
  fx.files.delete(`${ROUND}/${proposal.id}.json`)
  const asked = roundEntry('s-one', 'Orch: belt', parseWait(answerOf(QUESTION, QUESTION_LINE))!, proposal.since, proposal.at)
  fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(asked) + '\n')
  const other: RoundEntry = { ...asked, id: 'other-session', session: 's-two', from: 'Orch: other' }
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

// The operator's report of 2026-11-18: Orch: Blitz's closing proposal of 13:01Z, moved through two
// successions, was still presented at 19:14Z while its third session worked. A done says the
// orchestrator has nothing left to do: the moment its session works again, its turn starting,
// the proposal is no longer what it waits on, and its own turn end enters a new one if it is.
test('a turn that starts withdraws the session\'s open closing proposal, moved to it or its own, and nothing else', async () => {
  const { chains, fx, asked: question, other, settled } = await senderWithEntries()
  const own: RoundEntry = { ...question, id: 's-one-done', kind: 'done', blocks: null, question: 'Everything merged.' }
  const moved: RoundEntry = { ...own, id: 's-zero-moved', since: '2026-11-18T13:01:19.813Z', movedFrom: 's-zero' }
  for (const kept of [own, moved]) fx.files.set(`${ROUND}/${kept.id}.json`, JSON.stringify(kept) + '\n')
  await drive(chains, 'turn.start', fx.dollar, {})
  const after = new Map(entries(fx).map(e => [e.id, e]))
  for (const done of [own, moved]) {
    expect([after.get(done.id)!.status, after.get(done.id)!.answer?.text, after.get(done.id)!.answer?.by]).toEqual(['withdrawn', WORKS_AGAIN, 'sender'])
  }
  expect(after.get(question.id)).toEqual(question)
  expect(after.get(other.id)).toEqual(other)
  expect(after.get(settled.id)).toEqual(settled)
  // The turn ends on done again: a new proposal, open.
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(PROPOSAL))
  expect(entries(fx).filter(e => e.kind === 'done' && e.status === 'open').length).toBe(1)
})

test('the sender\'s session ending withdraws its open entries, and no other session\'s', async () => {
  const { chains, fx, asked, other, settled } = await senderWithEntries()
  await drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' })
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
  const ended = { sessionId: 's-one' }
  const budget = { remainingMs: 20 }
  expect(await drive(chains, 'session.end', fx.dollar, ended, budget)).toBe(ended)
  expect(rowThere).toBe(false)
  expect(fx.files.has(ROW)).toBe(false)
  expect(fx.logged.some(l => l.includes('round: did not finish within 20 ms'))).toBe(true)
  expect(entries(fx).find(e => e.id === asked.id)!.status).toBe('open')
})

test('another session\'s end leaves this sender\'s open entries open', async () => {
  const { chains, fx, asked } = await senderWithEntries()
  await drive(chains, 'session.end', fx.dollar, { sessionId: 's-two' })
  expect(entries(fx).find(e => e.id === asked.id)!.status).toBe('open')
})

for (const [label, send] of [
  ['the model\'s own « handed over »', { text: 'handed over', origin: { kind: 'model' } }],
  ['another message of the model', { text: 'not handed over yet', origin: { kind: 'model' } }],
  ['a plugin\'s send', { text: 'handed over', origin: { kind: 'plugin' } }],
  ['a subagent\'s send', { text: 'handed over', origin: { kind: 'model' }, agentId: 'a-1' }],
] as const) {
  test(`${label} withdraws nothing`, async () => {
    const { chains, fx, asked } = await senderWithEntries()
    await drive(chains, 'session.send', fx.dollar, send)
    expect(entries(fx).find(e => e.id === asked.id)!.status).toBe('open')
  })
}

// --- the successor holds the open questions -------------------------------------------------

// The operator's report of 2026-10-30: a question withdrawn when its sender's tab was closed by
// its successor, which never asked it again. The successor's « takeover confirmed » teaches the
// sender who it is; the hand-over and the session end then move the open entries to it.
const SUCCESSOR_FROM = 'uds:/tmp/peer-s-two.sock'
const confirmed = (name: string, body = 'takeover confirmed') => ({
  origin: { kind: 'peer' },
  text: `<cross-session-message from="${SUCCESSOR_FROM}" from-name="${name}" from-mode="prompting">\n${body}\n</cross-session-message>`,
})

// The successor runs on this machine: the host's registry names its session, and its row is live.
function successorRunning(fx: ReturnType<typeof fake>, name = 'Orch: belt-2') {
  fx.files.set(`${HOME}/.claude/sessions/9002.json`, JSON.stringify({ pid: 9002, sessionId: 's-two', name }))
  fx.files.set(`${HOME}/.claude/claude-orchestrator/store/sessions/s-two`, JSON.stringify({
    role: 'orchestrator', name, pid: '9002', repo: null, context_percent: 5, context_tokens: 1, window: 100,
    model: 'a-model', busy: false, updated_at: '2026-10-30T16:20:00.000Z',
  }) + '\n')
}

function expectMoved(fx: ReturnType<typeof fake>, asked: RoundEntry, other: RoundEntry, settled: RoundEntry) {
  const after = new Map(entries(fx).map(e => [e.id, e]))
  expect(after.get(asked.id)).toEqual({ ...asked, session: 's-two', from: 'Orch: belt-2', movedFrom: 's-one' })
  expect(fx.logged.filter(l => l.includes(`round: moved to the successor Orch: belt-2: ${asked.id}`)).length).toBe(1)
  expect(fx.logged.some(l => l.includes('withdrawn by the sender'))).toBe(false)
  expect(after.get(other.id)).toEqual(other)
  expect(after.get(settled.id)).toEqual(settled)
}

for (const [label, end] of [
  ['the turn end of the session that spawned it', async (chains: Hooks, fx: ReturnType<typeof fake>) => {
    DECLARATIONS.handOver('s-one')
    try {
      await drive(chains, 'turn.complete', fx.dollar, turnEnd('Takeover confirmed by the successor.'))
    } finally {
      DECLARATIONS.handOver('')
    }
  }],
  ['the session end', async (chains: Hooks, fx: ReturnType<typeof fake>) => drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' })],
] as const) {
  test(`« takeover confirmed » from an orchestrator, then ${label}, moves the open entries to it, still open`, async () => {
    const { chains, fx, asked, other, settled } = await senderWithEntries()
    successorRunning(fx)
    await drive(chains, 'session.receive', fx.dollar, confirmed('Orch: belt-2'))
    await end(chains, fx)
    expectMoved(fx, asked, other, settled)
    expect(entries(fx).find(e => e.id === asked.id)?.session).toBe('s-two')
  })
}

// The operator's report of 2026-11-18: a closing proposal moved through two successions stayed open
// while the orchestration worked on. The successor working, the proposal is withdrawn at the hand-over.
test('at the hand-over a closing proposal is withdrawn, never moved, and the open questions move', async () => {
  const { chains, fx, asked, other, settled } = await senderWithEntries()
  const proposal: RoundEntry = { ...asked, id: 's-one-done', kind: 'done', blocks: null, question: 'Everything merged.' }
  fx.files.set(`${ROUND}/${proposal.id}.json`, JSON.stringify(proposal) + '\n')
  successorRunning(fx)
  await drive(chains, 'session.receive', fx.dollar, confirmed('Orch: belt-2'))
  DECLARATIONS.handOver('s-one')
  try {
    await drive(chains, 'turn.complete', fx.dollar, turnEnd('Takeover confirmed by the successor.'))
  } finally {
    DECLARATIONS.handOver('')
  }
  const after = new Map(entries(fx).map(e => [e.id, e]))
  expect([after.get(proposal.id)!.session, after.get(proposal.id)!.status, after.get(proposal.id)!.answer?.text, after.get(proposal.id)!.answer?.by])
    .toEqual(['s-one', 'withdrawn', HANDED_ON, 'sender'])
  expect(after.get(proposal.id)!.movedFrom).toBeUndefined()
  expect(after.get(asked.id)).toEqual({ ...asked, session: 's-two', from: 'Orch: belt-2', movedFrom: 's-one' })
  expect(after.get(other.id)).toEqual(other)
  expect(after.get(settled.id)).toEqual(settled)
})

test('a session that spawned its successor hands it the open entries at its « takeover confirmed », and tells its agents who it is', async () => {
  const { chains, fx, asked, other, settled } = await senderWithEntries()
  successorRunning(fx)
  // The successor's tty carries the chain the launcher handed it: one agent, live on its tty.
  fx.files.set(`${HOME}/.claude/claude-orchestrator/store/sessions/s-two`, JSON.stringify({
    role: 'orchestrator', name: 'Orch: belt-2', pid: '9002', tty: '/dev/ttys009', repo: null, context_percent: 5, context_tokens: 1, window: 100,
    model: 'a-model', busy: false, updated_at: '2026-10-30T16:20:00.000Z',
  }) + '\n')
  fx.files.set(`${HOME}/.claude/claude-orchestrator/chains/ttys009.jsonl`, JSON.stringify({ tab_id: 'tab-p4', tty: '/dev/ttys011', owner: 'w9' }) + '\n')
  fx.files.set(`${HOME}/.claude/sessions/9011.json`, JSON.stringify({ pid: 9011, sessionId: 's-agent', name: 'Agent: belt-p4', status: 'idle' }))
  const run = fx.dollar.process.run
  fx.dollar.process.run = async (argv: readonly string[], init?: Parameters<typeof run>[1]) =>
    argv[0] === 'ps' && argv[2] === 'ttys011' ? { exitCode: 0, stdout: '9011\n', stderr: '' } : run(argv, init)
  DECLARATIONS.handOver('s-one')
  try {
    await drive(chains, 'session.receive', fx.dollar, confirmed('Orch: belt-2'))
  } finally {
    DECLARATIONS.handOver('')
  }
  expectMoved(fx, asked, other, settled)
  expect(fx.sent.filter(s => s.text === successorText({ name: 'Orch: belt-2', session: 's-two' })).map(s => s.to)).toEqual([{ sessionId: 's-agent' }])
  // The line is recorded as told: the successor's own module passes this agent at its next measure.
  expect(JSON.parse(fx.files.get(`${HOME}/.claude/claude-orchestrator/store/told/s-agent`)!).session).toBe('s-two')
})

test('a « takeover confirmed » to a session that spawned no successor moves nothing before its end', async () => {
  const { chains, fx, asked } = await senderWithEntries()
  successorRunning(fx)
  await drive(chains, 'session.receive', fx.dollar, confirmed('Orch: belt-2'))
  expect(entries(fx).find(e => e.id === asked.id)!.session).toBe('s-one')
})

// A question asked with `ask` (question.ts, `v` 2) follows its asker as the relay's entries do:
// withdrawn when its session ends or hands over with no successor, moved to a successor it learnt.
const askedObject = (id: string, session: string, over: Record<string, unknown> = {}) => ({
  v: 2, id, sender: { session, name: session === 's-one' ? 'Orch: belt' : 'Orch: other', role: 'orchestrator', machine: 'box-1' },
  subject: 'merge order', context: 'Two pull requests touch one file.', ask: 'Which merges first?',
  choices: [], recommended: null, why: null, blocks: 'phase 3', status: 'open', at: '2026-10-30T16:00:00.000Z', answer: null, seq: 1, ...over,
})
function withAsked(fx: ReturnType<typeof fake>) {
  const mine = askedObject('q-mine', 's-one')
  const theirs = askedObject('q-theirs', 's-two')
  const done = askedObject('q-done', 's-one', { status: 'answered', answer: { text: 'A', by: 'tab', at: 'T', settler: 'Orch: belt' } })
  for (const asked of [mine, theirs, done]) fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(asked) + '\n')
  const read = (id: string) => JSON.parse(fx.files.get(`${ROUND}/${id}.json`)!)
  return { mine, theirs, done, read }
}

for (const [label, end, why] of [
  ['its session end', async (chains: Hooks, fx: ReturnType<typeof fake>) => drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' }), "the sender's session ended"],
] as const) {
  test(`a question asked with ask is withdrawn by ${label}, and no other session's, and none settled`, async () => {
    const chains = mounted()
    const fx = fake()
    const { theirs, done, read } = withAsked(fx)
    await end(chains, fx)
    expect([read('q-mine').status, read('q-mine').answer?.text, read('q-mine').answer?.by]).toEqual(['withdrawn', why, 'sender'])
    expect(read('q-theirs')).toEqual(theirs)
    expect(read('q-done')).toEqual(done)
  })
}

test('a question asked with ask withdrawn at its session end is told settled to the coordinator that was shown it, the other not', async () => {
  const chains = mounted()
  const fx = fake()
  withAsked(fx)
  const other = askedObject('q-unseen', 's-one', { subject: 'tag order' })
  fx.files.set(`${ROUND}/${other.id}.json`, JSON.stringify(other) + '\n')
  fx.files.set(`${HOME}/.claude/claude-orchestrator/round-listed.json`, JSON.stringify(['q-mine']) + '\n')
  await drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' })
  const told = fx.sent.filter(s => s.text.startsWith('[module] Settled'))
  expect(told.map(s => s.to)).toEqual(['Coord: ops [abc]'])
  expect(only(told).text).toBe("[module] Settled: Orch: belt's question since 2026-10-30T16:00:00.000Z (entry q-mine) — session ended. Already closed: drop it, never ask or relay it again, present the next.")
})

test('a question asked with ask moves to the successor the takeover named, still open, at the session end', async () => {
  const chains = mounted()
  const fx = fake()
  const { mine, theirs, read } = withAsked(fx)
  successorRunning(fx)
  await drive(chains, 'session.receive', fx.dollar, confirmed('Orch: belt-2'))
  await drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' })
  expect(read('q-mine')).toEqual({ ...mine, sender: { ...mine.sender, session: 's-two', name: 'Orch: belt-2' }, movedFrom: 's-one', seq: 2 })
  expect(read('q-theirs')).toEqual(theirs)
})

test('a successor not found on this machine is recorded by its name: the entries move to that name', async () => {
  const { chains, fx, asked } = await senderWithEntries()
  await drive(chains, 'session.receive', fx.dollar, confirmed('Orch: belt-2', 'Takeover confirmed.\nAgents re-addressed.'))
  await drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' })
  const moved = entries(fx).find(e => e.id === asked.id)!
  expect([moved.status, moved.session, moved.from]).toEqual(['open', '', 'Orch: belt-2'])
})

// A successor whose session the registry did not name yet when its « takeover confirmed » came:
// the move resolves it again, or the moved entry names no session, never drawn nor due.
test('a successor the registry names only after its « takeover confirmed » is resolved at the move', async () => {
  const { chains, fx, asked, other, settled } = await senderWithEntries()
  await drive(chains, 'session.receive', fx.dollar, confirmed('Orch: belt-2'))
  successorRunning(fx)
  await drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' })
  expectMoved(fx, asked, other, settled)
})

// The successor's real word of 2026-11-04T17:15:27Z: the phrase, then its report on the same
// line. Read as no takeover, the hand-over withdrew the open questions instead of moving them.
// Runs `move` in a session that spawned its successor (the guards' mark), the mark taken off after.
async function spawned(move: () => Promise<unknown>): Promise<void> {
  DECLARATIONS.handOver('s-one')
  try {
    await move()
  } finally {
    DECLARATIONS.handOver('')
  }
}

const TAKEOVER_REPORT = 'takeover confirmed — Orch: belt-2 [a1b2c3] holds the orchestration; the agents are re-addressed and the round is read.'

test('takeover confirmed followed by the successor\'s report confirms the takeover', async () => {
  expect(confirmsTakeover(TAKEOVER_REPORT)).toBe(true)
  expect(confirmsTakeover(`**Takeover confirmed**: ${TAKEOVER_REPORT.slice(19)}\nNext line.`)).toBe(true)
  expect(confirmsTakeover('takeover confirmedly')).toBe(false)
  expect(confirmsTakeover('the takeover confirmed')).toBe(false)
  const { chains, fx, asked, other, settled } = await senderWithEntries()
  successorRunning(fx)
  await spawned(() => drive(chains, 'session.receive', fx.dollar, confirmed('Orch: belt-2', TAKEOVER_REPORT)))
  expectMoved(fx, asked, other, settled)
})

test('the successor\'s own wait file is left as it is by the move', async () => {
  const { chains, fx } = await senderWithEntries()
  successorRunning(fx)
  const theirs = `${HOME}/.claude/claude-orchestrator/store/waits/s-two`
  const wait = JSON.stringify({ waiting: 'operator', blocks: 'phase 9', waiting_since: 'T', relayed: 'its-own', name: 'Orch: belt-2', pid: '9002' }) + '\n'
  fx.files.set(theirs, wait)
  await spawned(() => drive(chains, 'session.receive', fx.dollar, confirmed('Orch: belt-2')))
  expect(fx.files.get(theirs)).toBe(wait)
})

for (const [label, delivery] of [
  ['an agent', confirmed('Agent: belt-p3')],
  ['a coordinator', confirmed('Coord: ops')],
  ['an orchestrator saying something else', confirmed('Orch: belt-2', 'takeover not confirmed yet')],
  ['the operator', { origin: { kind: 'user' }, text: 'takeover confirmed' }],
] as const) {
  test(`« takeover confirmed » from ${label} learns no successor: nothing moves, and the session end withdraws`, async () => {
    const { chains, fx, asked, other, settled } = await senderWithEntries()
    successorRunning(fx)
    await spawned(() => drive(chains, 'session.receive', fx.dollar, delivery))
    expect(entries(fx).find(e => e.id === asked.id)!.status).toBe('open')
    await drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' })
    expectWithdrawn(fx, asked, other, settled, "the sender's session ended")
  })
}

test('a later « takeover confirmed » replaces the successor learnt before it', async () => {
  const { chains, fx, asked } = await senderWithEntries()
  successorRunning(fx)
  fx.files.set(`${HOME}/.claude/sessions/9003.json`, JSON.stringify({ pid: 9003, sessionId: 's-three', name: 'Orch: belt-3' }))
  await drive(chains, 'session.receive', fx.dollar, confirmed('Orch: belt-2'))
  await drive(chains, 'session.receive', fx.dollar, confirmed('Orch: belt-3'))
  await drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' })
  const moved = entries(fx).find(e => e.id === asked.id)!
  expect([moved.status, moved.session, moved.from]).toEqual(['open', 's-three', 'Orch: belt-3'])
})

test('a session that is no orchestrator learns no successor', async () => {
  const chains = mounted()
  const agent = fake({ name: 'Agent: belt-p3', role: 'agent' })
  await drive(chains, 'session.receive', agent.dollar, confirmed('Orch: belt-2'))
  expect([...agent.files.keys()].some(p => p.includes('/store/successors/'))).toBe(false)
})

test('two sessions share the successor\'s name, one of them the receiver\'s own: the other is the successor', async () => {
  const { chains, fx, asked } = await senderWithEntries()
  fx.files.set(`${HOME}/.claude/sessions/501.json`, JSON.stringify({ pid: 501, sessionId: 's-one', name: 'Orch: belt-2' }))
  successorRunning(fx)
  await drive(chains, 'session.receive', fx.dollar, confirmed('Orch: belt-2'))
  expect(fx.logged.filter(l => l.includes('round: successor learnt: Orch: belt-2 (session s-two)')).length).toBe(1)
  await drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' })
  const moved = entries(fx).find(e => e.id === asked.id)!
  expect([moved.status, moved.session, moved.from]).toEqual(['open', 's-two', 'Orch: belt-2'])
})

test('several sessions share the successor\'s name besides the receiver: the reply address\'s process id chooses', async () => {
  const { chains, fx, asked } = await senderWithEntries()
  fx.files.set(`${HOME}/.claude/sessions/501.json`, JSON.stringify({ pid: 501, sessionId: 's-one', name: 'Orch: belt-2' }))
  successorRunning(fx)
  fx.files.set(`${HOME}/.claude/sessions/9003.json`, JSON.stringify({ pid: 9003, sessionId: 's-three', name: 'Orch: belt-2' }))
  await drive(chains, 'session.receive', fx.dollar, {
    origin: { kind: 'peer' },
    text: '<cross-session-message from="uds:/tmp/claude-sockets/9003.sock" from-name="Orch: belt-2" from-mode="prompting">\ntakeover confirmed\n</cross-session-message>',
  })
  await drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' })
  const moved = entries(fx).find(e => e.id === asked.id)!
  expect([moved.status, moved.session, moved.from]).toEqual(['open', 's-three', 'Orch: belt-2'])
})

// --- a settled question leaves the coordinator's tab -------------------------------------------

// The operator answered « A » in the pane at 21:10:00Z, then the coordinator, which had presented
// the same question in its tab, relayed the same « A » again at 21:10:30Z (his report of
// 2026-10-25). An entry the coordinator was shown — listed by its `round`, or woken for — is
// closed by the module when its sender withdraws it, and the coordinator told once, with no
// command to run; one it never saw is only withdrawn, and tells it nothing.
const LISTED = `${HOME}/.claude/claude-orchestrator/round-listed.json`
const DROP = 'Already closed: drop it, never ask or relay it again, present the next.'

test('a closing proposal the coordinator was shown is closed and told once at its session\'s next turn, and entered again is no longer shown', async () => {
  const { chains, fx } = await relayedProposal()
  const proposal = only(entries(fx))
  fx.files.set(LISTED, JSON.stringify([proposal.id]) + '\n')
  await drive(chains, 'turn.start', fx.dollar, {})
  const closed = only(entries(fx))
  expect([closed.status, closed.answer?.text, closed.answer?.by]).toEqual(['closed', `withdrawn: ${WORKS_AGAIN}`, 'sender'])
  expect(fx.sent.filter(s => s.text.startsWith('[module] Settled') && s.text.includes(proposal.id)).length).toBe(1)
  // The turn ends on done again: the same id, open, and the coordinator's list no longer marks it shown.
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(PROPOSAL))
  expect(only(entries(fx)).status).toBe('open')
  expect(JSON.parse(fx.files.get(LISTED)!)).toEqual([])
  // Its next withdrawal, never shown, tells the coordinator nothing.
  fx.sent.length = 0
  await drive(chains, 'turn.start', fx.dollar, {})
  expect(only(entries(fx)).status).toBe('withdrawn')
  expect(fx.sent.filter(s => s.text.startsWith('[module] Settled')).length).toBe(0)
})

test('a sender that ends with a successor learnt withdraws its closing proposal and moves its questions', async () => {
  const { chains, fx, asked } = await senderWithEntries()
  const proposal: RoundEntry = { ...asked, id: 's-one-done', kind: 'done', blocks: null, question: 'Everything merged.' }
  fx.files.set(`${ROUND}/${proposal.id}.json`, JSON.stringify(proposal) + '\n')
  successorRunning(fx)
  await drive(chains, 'session.receive', fx.dollar, confirmed('Orch: belt-2'))
  await drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' })
  const after = new Map(entries(fx).map(e => [e.id, e]))
  expect([after.get(proposal.id)!.session, after.get(proposal.id)!.status, after.get(proposal.id)!.answer?.text]).toEqual(['s-one', 'withdrawn', HANDED_ON])
  expect([after.get(asked.id)!.session, after.get(asked.id)!.status]).toEqual(['s-two', 'open'])
})

test('the settled notice is worded by the answer the entry was closed with, and carries no command', () => {
  const asked = roundEntry('s-one', 'Orch: belt', parseWait(answerOf(QUESTION, QUESTION_LINE))!, '2026-10-25T21:00:00.000Z', 'T')
  const head = `Orch: belt's question since 2026-10-25T21:00:00.000Z (entry ${asked.id})`
  const at = '2026-10-25T21:10:00.000Z'
  for (const [text, by, expected] of [
    ['answered from the pane: A : "ship" it', 'pane', `[module] Settled in the pane: ${head} — answered at ${at}. ${DROP}`],
    ["withdrawn: answered in the sender's own tab", 'tab', `[module] Settled in Orch: belt's tab: ${head} — answered there. ${DROP}`],
    ["withdrawn: answered in the sender's own tab", 'sender', `[module] Settled in Orch: belt's tab: ${head} — answered there. ${DROP}`],
    ['withdrawn: superseded by s-one-17-abc', 'sender', `[module] Settled superseded: ${head} — by s-one-17-abc, present that one. ${DROP}`],
    ["withdrawn: the sender's session ended", 'sender', `[module] Settled: ${head} — session ended. ${DROP}`],
    ['withdrawn: handed over to its successor', 'sender', `[module] Settled: ${head} — handed over to its successor. ${DROP}`],
  ] as const) {
    expect(settledText(asked, { text, by, at })).toBe(expected)
  }
  expect(settledText(asked, { text: 'answered from the pane: A : "ship" it', by: 'pane', at })).not.toContain('ship')
})

// A coordinator recorded by its bare name shares it with another session the host lists (a
// session of the same name kept by the host's remote control, say): the host refuses a send to
// that name as ambiguous, and the settled notice would be lost. The registry's own record of the
// session on this machine gives it unambiguously; without one, the refusal names it.
const AMBIGUOUS = "2 agents are named 'Coord: e2e'. Re-send with the ref of the one you mean:\n"
  + '  Coord: e2e [abc] — a session, on this machine, active 36s ago\n'
  + '  Coord: e2e [xyz] — a session, on another machine (Remote Control), active 30m ago'
async function ambiguousCoordinator(registry: Record<string, object>) {
  const { chains, fx } = await relayedProposal()
  fx.files.set(RECORD, JSON.stringify({ name: 'Coord: e2e' }))
  for (const [pid, record] of Object.entries(registry)) fx.files.set(`${HOME}/.claude/sessions/${pid}.json`, JSON.stringify(record))
  const tried: unknown[] = []
  fx.dollar.session.send = async (args: Parameters<World['session']['send']>[0]): Promise<SessionSendResult> => {
    tried.push(args.to)
    if (args.to === 'Coord: e2e') return { isDelivered: false, reason: AMBIGUOUS }
    fx.sent.push(args)
    return { isDelivered: true }
  }
  const asked = only(entries(fx))
  fx.files.set(LISTED, JSON.stringify([asked.id]) + '\n')
  await drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' })
  return { fx, asked, tried }
}

test('a coordinator recorded by a name another session shares is sent the settled notice by its session id', async () => {
  const { fx, asked, tried } = await ambiguousCoordinator({
    4242: { pid: 4242, sessionId: 'coord-session', name: 'Coord: e2e', kind: 'interactive' },
    4343: { pid: 4343, sessionId: 'other-session', name: 'Orch: belt', kind: 'interactive' },
  })
  expect(only(entries(fx)).status).toBe('closed')
  expect(tried).toEqual([{ sessionId: 'coord-session' }])
  expect(fx.sent).toEqual([{ to: { sessionId: 'coord-session' }, text: `[module] Settled: Orch: belt's question since ${asked.since} (entry ${asked.id}) — session ended. ${DROP}` }])
})

test('with no record of it in the registry, the refusal of an ambiguous name is sent again to the one on this machine', async () => {
  const { fx, tried } = await ambiguousCoordinator({})
  expect(tried).toEqual(['Coord: e2e', 'Coord: e2e [abc]'])
  expect(fx.sent.map(s => s.to)).toEqual(['Coord: e2e [abc]'])
  expect(fx.logged.filter(l => !l.includes('round: withdrawn by the sender'))).toEqual([])
})

for (const [label, end, why] of [
  ['its session ending', async (chains: Hooks, fx: ReturnType<typeof fake>) => drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' }), 'session ended'],
] as const) {
  test(`${label} closes every entry the coordinator was shown before it tells it of the first`, async () => {
    const { chains, fx, asked } = await senderWithEntries()
    const second: RoundEntry = { ...asked, id: 'second', blocks: 'phase 9' }
    fx.files.set(`${ROUND}/second.json`, JSON.stringify(second) + '\n')
    fx.files.set(LISTED, JSON.stringify([asked.id, 'second']) + '\n')
    const seen: string[][] = []
    const send = fx.dollar.session.send
    fx.dollar.session.send = async (args: Parameters<World['session']['send']>[0]): Promise<SessionSendResult> => {
      if (args.text.startsWith('[module] Settled')) seen.push([asked.id, 'second'].map(id => entries(fx).find(e => e.id === id)!.status))
      return send(args)
    }
    await end(chains, fx)
    expect(seen).toEqual([['closed', 'closed'], ['closed', 'closed']])
    expect(fx.sent.filter(s => s.text.startsWith('[module] Settled')).map(s => s.text)).toEqual([asked, second].map(e =>
      `[module] Settled: Orch: belt's question since ${e.since} (entry ${e.id}) — ${why}. ${DROP}`))
  })
}

test('a notice that does not fit in what the session end leaves is one log line, the entries closed all the same', async () => {
  const { chains, fx, asked } = await senderWithEntries()
  const second: RoundEntry = { ...asked, id: 'second', blocks: 'phase 9' }
  fx.files.set(`${ROUND}/second.json`, JSON.stringify(second) + '\n')
  fx.files.set(LISTED, JSON.stringify([asked.id, 'second']) + '\n')
  fx.dollar.session.send = () => new Promise<never>(() => undefined)
  const ended = { sessionId: 's-one' }
  const budget = { remainingMs: 60 }
  expect(await drive(chains, 'session.end', fx.dollar, ended, budget)).toBe(ended)
  expect([asked.id, 'second'].map(id => entries(fx).find(e => e.id === id)!.status)).toEqual(['closed', 'closed'])
  for (const id of [asked.id, 'second']) expect(fx.logged.filter(l => l.endsWith(`| round: no time left to tell Coord: ops [abc] that ${id} is settled`)).length).toBe(1)
})

test('a coordinator on another machine is told nothing of a withdrawal in this round, and the entry is only withdrawn', async () => {
  const chains = mounted()
  const fx = fake({ remote: true })
  // The round on this machine holds the sender's entry, listed as if shown: only a coordinator on
  // this machine reads it, so it is neither closed nor told.
  const asked = roundEntry('s-one', 'Orch: belt', parseWait(answerOf(QUESTION, QUESTION_LINE))!, '2026-10-25T21:00:00.000Z', 'T')
  fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(asked) + '\n')
  fx.files.set(LISTED, JSON.stringify([asked.id]) + '\n')
  await drive(chains, 'session.end', fx.dollar, { sessionId: 's-one' })
  expect([only(entries(fx)).status, only(entries(fx)).answer?.text]).toEqual(['withdrawn', "the sender's session ended"])
  expect(fx.sent.filter(s => s.text.startsWith('[module] Settled'))).toEqual([])
})

// --- what a turn truly waits on ------------------------------------------------------------

// A turn that waits on a command of its own, or that declares a wait on the operator blocking
// nothing, asks him nothing: neither is entered in the round, nor sent, nor kept as a wait.
test('an operator wait blocking nothing is no wait', () => {
  for (const blocks of ['nothing', 'Nothing.', 'none', 'nothing yet', 'n/a', '-', '']) {
    expect([blocks, declaredWait({ kind: 'operator', blocks }, 'Watching.')]).toEqual([blocks, null])
  }
  expect(declaredWait({ kind: 'operator', blocks: 'none', urgent: true }, 'Watching.')).toBeNull()
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

test('after the coordinator settles it, the same proposal made again is entered again', async () => {
  const chains = mounted()
  const fx = fake()
  const ask = turnEnd(PROPOSAL)
  await drive(chains, 'turn.complete', fx.dollar, ask)
  const first = only(entries(fx))
  // The coordinator's close, as its settle writes it: the entry closed (the wait file left to the relay).
  const path = `${ROUND}/${first.id}.json`
  fx.files.set(path, JSON.stringify({ ...first, status: 'closed', answer: { text: 'A', by: 'coordinator', at: first.at } }) + '\n')
  await drive(chains, 'turn.start', fx.dollar, {})
  await drive(chains, 'turn.complete', fx.dollar, ask)
  const again = JSON.parse(fx.files.get(path)!) as RoundEntry
  expect(entries(fx).length).toBe(1)
  expect(again.status).toBe('open')
  expect(again.answer).toBeNull()
  expect(fx.row()!.relayed).toBe(fingerprint(parseWait(PROPOSAL)!))
  expect(fx.sent.length).toBe(0)
  // An entry the coordinator archived is no file at all: entered again as well.
  fx.files.delete(path)
  await drive(chains, 'turn.complete', fx.dollar, ask)
  expect((JSON.parse(fx.files.get(path)!) as RoundEntry).status).toBe('open')
})

test('an open entry, the same wait again, is not entered twice', async () => {
  const chains = mounted()
  const fx = fake()
  const ask = turnEnd(PROPOSAL)
  await drive(chains, 'turn.complete', fx.dollar, ask)
  const first = only(entries(fx))
  const path = `${ROUND}/${first.id}.json`
  // A mark only the first writing carries: a second writing would erase it.
  const at = '2026-11-18T13:01:19.825Z'
  fx.files.set(path, JSON.stringify({ ...first, at, marked: true }) + '\n')
  await drive(chains, 'turn.complete', fx.dollar, ask)
  expect(entries(fx).length).toBe(1)
  expect((JSON.parse(fx.files.get(path)!) as { marked?: boolean }).marked).toBe(true)
  // A done declared again after the session worked is a new fact, dated by its declaration: one entry, open, the old one gone.
  await drive(chains, 'turn.start', fx.dollar, {})
  await drive(chains, 'turn.complete', fx.dollar, ask)
  const again = only(entries(fx))
  expect([again.id, again.status]).toEqual([first.id, 'open'])
  expect(again.at).not.toBe(at)
  expect((JSON.parse(fx.files.get(path)!) as { marked?: boolean }).marked).toBeUndefined()
})

// --- a coordinator on another machine: the entry carried to its round, acknowledged ------------

// Two machines, each its own module over its own files: the sender, an orchestrator whose
// coordinator a peer delivery taught, and the coordinator, registered on its own machine. A line
// one sends is handed to the other's receive as the host delivers it, in its envelope.
const SENDER_AT = 'uds:/tmp/cc-socks/501.sock'
const COORD_AT = 'bridge:session_coord'
const COORD_ROW = `${HOME}/.claude/claude-orchestrator/store/sessions/s-coord`

function coordinatorMachine(over: Parameters<typeof fake>[0] = {}) {
  const fx = fake({ name: 'Coord: ops [abc]', role: 'coordinator', ...over })
  fx.files.set(COORD_ROW, fx.files.get(ROW)!)
  fx.files.delete(ROW)
  fx.dollar.session.id = async () => 's-coord'
  return fx
}

function delivered(from: string, fromName: string, body: string) {
  return { text: `<cross-session-message from="${from}" from-name="${fromName}">\n${body}\n</cross-session-message>`, origin: { kind: 'peer' } }
}

const asks = (fx: ReturnType<typeof fake>) => fx.sent.filter(s => isAskLine(s.text))
const acks = (fx: ReturnType<typeof fake>) => fx.sent.filter(s => parseQAck(s.text)?.of === 'ask')
const waitOf = (fx: ReturnType<typeof fake>) => JSON.parse(fx.files.get(WAIT)!)

test('a remote wait becomes an entry on the coordinator\'s machine, and is acked', async () => {
  const chains = mounted()
  const sender = fake({ remote: true })
  const coordinator = coordinatorMachine()
  const ask = turnEnd(PROPOSAL)
  await drive(chains, 'turn.complete', sender.dollar, ask)
  const line = only(asks(sender))
  expect(asks(sender).length).toBe(1)
  expect(line.to).toBe('Coord: ops [abc]')
  expect(sender.sent.filter(s => s.text.startsWith('[module] '))).toEqual([])
  const since = sender.row().waiting_since!
  const asked = roundEntry('s-one', 'Orch: belt', waitOfEnd(ask)!, since, 'T')
  expect([waitOf(sender).pending, waitOf(sender).relayed ?? null]).toEqual([asked.id, null])
  expect(entries(sender)).toEqual([])
  const consumed = await receive(chains, coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', line.text))
  expect(typeof consumed.consumed).toBe('string')
  const entry = only(entries(coordinator))
  expect(entries(coordinator).length).toBe(1)
  expect(entry).toEqual({ ...asked, at: entry.at, origin: { machine: 'unknown', address: SENDER_AT } })
  expect(coordinator.files.has(`${ROUND}/${asked.id}.json`)).toBe(true)
  expect(acks(coordinator)).toEqual([{ to: SENDER_AT, text: ackLine(asked.id, since) }])
})

test('a turn end is one message, and received whole it enters the entry, stores the row and is acked once', async () => {
  const chains = mounted()
  const sender = fake({ remote: true })
  const coordinator = coordinatorMachine()
  await drive(chains, 'turn.complete', sender.dollar, turnEnd(PROPOSAL))
  expect(sender.messages.length).toBe(1)
  expect(sender.sent.length).toBe(2)
  const consumed = await receive(chains, coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(sender.messages)))
  expect(typeof consumed.consumed).toBe('string')
  expect(entries(coordinator).length).toBe(1)
  expect([...coordinator.files.keys()].some(k => k.includes('/remote/'))).toBe(true)
  expect(coordinator.sent.length).toBe(1)
})

test('a turn end the coordinator did not take records nothing as delivered: the entry is no longer pending, the row is sent again', async () => {
  const chains = mounted()
  const sender = fake({ remote: true, send: 'refuse' })
  await drive(chains, 'turn.complete', sender.dollar, turnEnd(PROPOSAL))
  expect(waitOf(sender).pending ?? null).toBeNull()
  expect([...sender.files.keys()].some(k => k.includes('/rows/'))).toBe(false)
  expect(sender.logged.filter(l => l.includes('not delivered')).length).toBe(2)
})

test('the ack sets relayed and clears pending on the sender', async () => {
  const chains = mounted()
  const sender = fake({ remote: true })
  const ask = turnEnd(PROPOSAL)
  await drive(chains, 'turn.complete', sender.dollar, ask)
  const id = waitOf(sender).pending
  // An acknowledgment of another entry keeps nothing.
  const other = await receive(chains, sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', ackLine('s-one-9-abc', waitOf(sender).waiting_since)))
  expect(typeof other.consumed).toBe('string')
  expect([waitOf(sender).pending, waitOf(sender).relayed ?? null]).toEqual([id, null])
  expect(sender.logged.filter(l => l.endsWith('| receive: an acknowledgment of s-one-9-abc matches no pending question')).length).toBe(1)
  const consumed = await receive(chains, sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', ackLine(id, waitOf(sender).waiting_since)))
  expect(typeof consumed.consumed).toBe('string')
  expect([waitOf(sender).pending, waitOf(sender).relayed]).toEqual([null, fingerprint(waitOfEnd(ask)!)])
  expect([waitOf(sender).waiting, waitOf(sender).blocks]).toEqual(['done', null])
  sender.sent.length = 0
  await drive(chains, 'turn.complete', sender.dollar, ask)
  expect(asks(sender)).toEqual([])
})

test('no ack → resent at the next turn end, never twice entered', async () => {
  const chains = mounted()
  const sender = fake({ remote: true })
  const coordinator = coordinatorMachine()
  const ask = turnEnd(PROPOSAL)
  await drive(chains, 'turn.complete', sender.dollar, ask)
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(asks(sender)).text))
  const first = only(entries(coordinator))
  const path = `${ROUND}/${first.id}.json`
  // A mark only the first writing carries: a second writing would erase it.
  coordinator.files.set(path, JSON.stringify({ ...first, marked: true }) + '\n')
  // The acknowledgment is lost: the next turn's end on the same wait sends the same entry again.
  await drive(chains, 'turn.start', sender.dollar, {})
  await drive(chains, 'turn.complete', sender.dollar, ask)
  const once = only(asks(sender))
  const again = only(asks(sender), 1)
  expect(asks(sender).length).toBe(2)
  const read = askObject
  expect([read(again.text).id, read(again.text).since]).toEqual([read(once.text).id, read(once.text).since])
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', again.text))
  expect(entries(coordinator).length).toBe(1)
  expect((JSON.parse(coordinator.files.get(path)!) as { marked?: boolean }).marked).toBe(true)
  expect(acks(coordinator).map(a => [a.to, a.text])).toEqual([[SENDER_AT, ackLine(first.id, first.since)], [SENDER_AT, ackLine(first.id, first.since)]])
  await drive(chains, 'session.receive', sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', only(acks(coordinator), 1).text))
  expect(waitOf(sender).relayed).toBe(fingerprint(waitOfEnd(ask)!))
})

test('an ask reaching a session that is not the coordinator is consumed and entered nowhere', async () => {
  const chains = mounted()
  const sender = fake({ remote: true })
  const elsewhere = fake({ name: 'Orch: other' })
  await drive(chains, 'turn.complete', sender.dollar, turnEnd(PROPOSAL))
  const consumed = await receive(chains, elsewhere.dollar, delivered(SENDER_AT, 'Orch: belt', only(asks(sender)).text))
  expect(typeof consumed.consumed).toBe('string')
  expect(consumed.text).toBeUndefined()
  expect(entries(elsewhere)).toEqual([])
  expect(elsewhere.sent).toEqual([])
  expect(elsewhere.logged.filter(l => l.includes('| receive: a remote question reached a session that is no coordinator')).length).toBe(1)
  // A line that fails the check is consumed the same, in the coordinator's own session too.
  const coordinator = coordinatorMachine()
  const refused = await receive(chains, coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', `${Q_MARKER}{"id":1}`))
  expect(typeof refused.consumed).toBe('string')
  expect([entries(coordinator), coordinator.sent]).toEqual([[], []])
})

// A throw inside the handling of a marked line is one log line and the line stays consumed: the
// marker is the module's own, never a message for the model.
for (const [label, over, step] of [
  ['the round write fails', { roundWrite: 'fail' }, 'the entry write'],
  ['the ack cannot be sent', { send: 'reject' }, 'the acknowledgment'],
] as const) {
  test(`a remote ask whose handling throws (${label}) is consumed, with one log line and nothing passed on`, async () => {
    const chains = mounted()
    const sender = fake({ remote: true })
    const coordinator = coordinatorMachine(over)
    await drive(chains, 'turn.complete', sender.dollar, turnEnd(PROPOSAL))
    const id = waitOf(sender).pending
    const result = await receive(chains, coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(asks(sender)).text))
    expect(typeof result.consumed).toBe('string')
    expect(result.text).toBeUndefined()
    const failures = coordinator.logged.filter(l => l.includes(`| receive: a remote question failed at ${step} (${id}):`))
    expect(failures.length).toBe(1)
  })
}

test('a remote ack whose handling throws is consumed, with one log line and nothing passed on', async () => {
  const chains = mounted()
  const sender = fake({ remote: true })
  await drive(chains, 'turn.complete', sender.dollar, turnEnd(PROPOSAL))
  const id = waitOf(sender).pending
  const since = sender.row().waiting_since!
  const run = sender.dollar.process.run
  sender.dollar.process.run = async (argv: readonly string[]) => argv[0] === 'mv' && argv[3] === WAIT ? { exitCode: 1, stdout: '', stderr: 'refused' } : run(argv)
  const result = await receive(chains, sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', ackLine(id, since)))
  expect(typeof result.consumed).toBe('string')
  expect(result.text).toBeUndefined()
  expect(sender.logged.filter(l => l.includes(`| receive: an acknowledgment failed at the wait write (${id}):`)).length).toBe(1)
})

test('a late ack of an older ask leaves a newer pending wait pending, resent at the next turn end', async () => {
  const chains = mounted()
  const sender = fake({ remote: true })
  const ask = turnEnd(PROPOSAL)
  await drive(chains, 'turn.complete', sender.dollar, ask)
  const id = waitOf(sender).pending
  const older = sender.row().waiting_since!
  // The same wait asked again later: the same id, a newer start, still pending.
  const newer = new Date(Date.parse(older) + 60_000).toISOString()
  sender.files.set(WAIT, JSON.stringify({ ...waitOf(sender), waiting_since: newer }) + '\n')
  await drive(chains, 'session.receive', sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', ackLine(id, older)))
  expect([waitOf(sender).pending, waitOf(sender).relayed ?? null]).toEqual([id, null])
  expect(sender.logged.filter(l => l.includes(`| receive: an acknowledgment of ${id} matches no pending question`)).length).toBe(1)
  await drive(chains, 'turn.start', sender.dollar, {})
  await drive(chains, 'turn.complete', sender.dollar, ask)
  expect(asks(sender).length).toBe(2)
  expect(askObject(only(asks(sender), 1).text).since).toBe(newer)
  await drive(chains, 'session.receive', sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', ackLine(id, newer)))
  expect(waitOf(sender).relayed).toBe(fingerprint(waitOfEnd(ask)!))
})

// --- a remote entry settled meanwhile -------------------------------------------------------

// A remote wait entered on the coordinator's machine and acknowledged on the sender's: the entry
// as the coordinator's round holds it.
async function enteredRemotely(over: Parameters<typeof fake>[0] = {}) {
  const chains = mounted()
  const sender = fake({ remote: true })
  const coordinator = coordinatorMachine(over)
  const ask = turnEnd(PROPOSAL)
  await drive(chains, 'turn.complete', sender.dollar, ask)
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', asks(sender).at(-1)!.text))
  if (acks(coordinator).length > 0) await drive(chains, 'session.receive', sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', acks(coordinator).at(-1)!.text))
  const entry = only(entries(coordinator))
  const stored = () => JSON.parse(coordinator.files.get(`${ROUND}/${entry.id}.json`)!) as RoundEntry
  return { chains, sender, coordinator, ask, entry, stored }
}

test('an ask sent again, of the same start, never reopens its entry settled meanwhile, and is acked again', async () => {
  const { chains, sender, coordinator, entry, stored } = await enteredRemotely()
  const path = `${ROUND}/${entry.id}.json`
  const again = () => drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(asks(sender)).text))
  // Closed by the coordinator's settle while the ask's first acknowledgment was lost.
  const closed = { ...stored(), status: 'closed', answer: { text: 'A', by: 'coordinator', at: entry.at } }
  coordinator.files.set(path, JSON.stringify(closed) + '\n')
  await again()
  expect(stored()).toEqual(closed)
  // Answered from the pane, its delivery failed after its sends.
  const failed = { ...closed, status: 'answered', answer: { text: 'A : merge it', by: 'pane', at: entry.at }, delivery: { state: 'failed', at: entry.at, attempts: 3, reason: 'no acknowledgment after 3 sends' } }
  coordinator.files.set(path, JSON.stringify(failed) + '\n')
  await again()
  expect(stored()).toEqual(failed)
  expect(acks(coordinator).length).toBe(3)
})

// --- an answer that reached the orchestrator by a message --------------------------------------

test('the orchestrator settles its own open question when it acts on an answer by message: answered, by message, with its author', async () => {
  const chains = mounted()
  const fx = fake()
  await drive(chains, 'turn.complete', fx.dollar, turnEnd(PROPOSAL))
  const asked = only(entries(fx))
  const call = await toolHandler()(fx.dollar, byMessage(asked.id, 'Coord: ops [abc]'))
  expect(call.isError).toBeUndefined()
  const now = only(entries(fx))
  expect([now.id, now.status, now.answer?.by, now.answer?.author]).toEqual([asked.id, 'answered', 'message', 'Coord: ops [abc]'])
  expect((await toolHandler()(fx.dollar, byMessage(asked.id, ''))).isError).toBe(true)
  expect((await toolHandler()(fx.dollar, { ...byMessage(asked.id, 'x'), agentId: 'a' })).isError).toBe(true)
})

// A coordinator's and an auditor's question is closed by the tool as an orchestrator's is (row 161-bis).
for (const [name, role] of [['Coord: ops [abc]', 'coordinator'], ['Audit: method', 'auditor']] as const) {
  test(`a tool call from a ${role} marks its open question answered by message`, async () => {
    const chains = mounted()
    const fx = fake({ name, role })
    await drive(chains, 'turn.complete', fx.dollar, turnEnd(PROPOSAL))
    const asked = only(entries(fx))
    const call = await toolHandler()(fx.dollar, byMessage(asked.id, 'Coord: other [def]'))
    expect(call.isError).toBeUndefined()
    const now = only(entries(fx))
    expect([now.id, now.status, now.answer?.by, now.answer?.author]).toEqual([asked.id, 'answered', 'message', 'Coord: other [def]'])
  })
}

test('a tool call from a session that is no orchestrator, coordinator or auditor settles nothing', async () => {
  const fx = fake({ name: 'Agent: belt-p3', role: 'agent' })
  const asked = { ...roundEntry('s-one', 'Orch: belt', parseWait(answerOf(QUESTION, QUESTION_LINE))!, 'T', 'T') }
  fx.files.set(`${ROUND}/${asked.id}.json`, JSON.stringify(asked) + '\n')
  expect((await toolHandler()(fx.dollar, byMessage(asked.id, 'x'))).isError).toBe(true)
  expect(entries(fx).map(e => e.status)).toEqual(['open'])
})

// The settle call of an answer that reached the asker by a message.
const byMessage = (id: string, author: string) => ({ id, outcome: 'answered-by-message', answer: 'A, ship it', author })

// The handler registered for the settle tool, its matcher read.
function toolHandler(): (dollar: World, e: Events['tool.call']) => Promise<{ isError: unknown }> {
  const hook = hookOf(mounted(), 'tool.call', { tool: 'mcp__orchestrator__settle' })
  return async (dollar, e) => ({ isError: fieldsOf(await hook.handler(dollar, e, async x => x))?.['isError'] })
}

test('the notice of a question settled in the tab carries his words on one line, and the report to a remote coordinator too', () => {
  const asked = roundEntry('s-one', 'Orch: belt', parseWait(answerOf(QUESTION, QUESTION_LINE))!, '2026-10-14T08:00:00.000Z', 'T')
  const notice = settledText(asked, { text: "withdrawn: answered in the sender's own tab", by: 'tab', at: 'T', typed: 'B,\nkeep it small' })
  expect(notice).toContain(`(entry ${asked.id}) — answered there: "B, keep it small". ${DROP}`)
  expect(settledText(asked, { text: "withdrawn: answered in the sender's own tab", by: 'tab', at: 'T' })).toContain(`— answered there. ${DROP}`)
  expect(withdrawalText('Orch: belt', 'phase 3', 'T', 'B,\nkeep it small')).toContain('(he typed: "B, keep it small")')
  expect(withdrawalText('Orch: belt', 'phase 3', 'T')).not.toContain('typed')
})

// --- the event line alone between machines -----------------------------------------------------

test('the ask goes by the event line alone, and an old line from another machine is entered nowhere', async () => {
  const chains = mounted()
  const sender = fake({ remote: true })
  const coordinator = coordinatorMachine()
  await drive(chains, 'turn.complete', sender.dollar, turnEnd(PROPOSAL))
  const q = only(asks(sender))
  expect(sender.sent.filter(s => s.text.startsWith('[module-') && !s.text.startsWith('[module-row] ')).map(s => s.text)).toEqual([q.text])
  // The entry's old ask line ([module-ask]) is no line this module reads: nothing entered, nothing acknowledged.
  const old = `[module-ask] ${JSON.stringify(askObject(q.text))}`
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', old))
  expect([entries(coordinator), coordinator.sent]).toEqual([[], []])
  // Nor is an old acknowledgment: the ask stays pending until its event line's.
  const pending = waitOf(sender).pending
  await drive(chains, 'session.receive', sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', `[module-ack] {"id":"${pending}","since":"${waitOf(sender).waiting_since}"}`))
  expect([waitOf(sender).pending, waitOf(sender).relayed_id ?? null]).toEqual([pending, null])
  await drive(chains, 'session.receive', sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', ackLine(pending, waitOf(sender).waiting_since)))
  expect([waitOf(sender).pending, waitOf(sender).relayed_id]).toEqual([null, pending])
})

// An older machine's question, asked by its machine line: this release enters none. It is
// refused, logged, and answered by the event line, so its sender is told to ask it with ask, its
// wait cleared there, never acknowledged as entered.
test('an operator question from an older machine is entered nowhere, logged, and answered to its sender to ask it again', async () => {
  const chains = mounted()
  const coordinator = coordinatorMachine()
  const asked = roundEntry('s-one', 'Orch: belt', parseWait(answerOf(QUESTION, 'waiting: operator — blocks: phase 3'))!, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')
  const result = await receive(chains, coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', qAskLine(asked, 'm-old')))
  expect(typeof result.consumed).toBe('string')
  expect(result.text).toBeUndefined()
  expect(entries(coordinator)).toEqual([])
  expect(coordinator.logged.filter(l => l.endsWith(`| receive: an operator question from m-old refused, its release asks by its machine line: ${asked.id}`)).length).toBe(1)
  const sentBack = coordinator.sent.filter(s => s.to === SENDER_AT)
  expect(sentBack.length).toBe(1)
  expect(parseQAck(only(sentBack).text)).toBeNull()
  const q = parseQ(only(sentBack).text)
  const answer = q?.event.kind === 'answer' ? { id: q.id, ...q.event } : null
  expect([answer?.id, answer?.since]).toEqual([asked.id, asked.since])
  expect(answer?.readable).toContain('Ask it again with the ask tool.')
})

// --- a question asked with ask, its coordinator on another machine (remote-asked.ts) ------------

// The asker's machine owns the question; the coordinator's machine keeps a replica, which its pane
// draws and answers. Each module over its own files, a line one sends handed to the other's receive.
const ASKED_FIELDS = {
  subject: 'merge order', context: 'Two pull requests touch one file.', question: 'Which merges first?',
  choice_a: 'acme/app#1 first', choice_b: 'acme/app#2 first', recommended: 'A', why: 'no rebase', blocks: 'acme/app#1',
}
const pushes = (fx: ReturnType<typeof fake>) => fx.sent.filter(s => parseQ(s.text)?.event.kind === 'asked')
const replies = (fx: ReturnType<typeof fake>) => fx.sent.filter(s => parseQ(s.text)?.event.kind === 'reply')
const qAcks = (fx: ReturnType<typeof fake>, of: string) => fx.sent.filter(s => parseQAck(s.text)?.of === of)
const objectAt = (fx: ReturnType<typeof fake>, id: string) => JSON.parse(fx.files.get(`${ROUND}/${id}.json`)!)

const CONSENT_ASKED_FIELDS = { ...ASKED_FIELDS, subject: 'auto-deploy', question: 'Auto-deploy Acme/Thing to prod?', choice_a: 'Accorder', choice_b: 'Refuser' }
// A peer at another address, naming itself the coordinator.
const FORGER_AT = 'uds:/tmp/cc-socks/666.sock'

async function askedRemotely(fields: Record<string, string> = ASKED_FIELDS) {
  const chains = mounted()
  const sender = fake({ remote: true })
  sender.dollar.ui.log = () => undefined
  const coordinator = coordinatorMachine()
  askTurnStarted()
  const asked = await callAsk(sender.dollar, { tool: 'mcp__orchestrator__ask', ...fields })
  const id = /Asked as (q-\S+?):/.exec(asked.result)![1]!
  // The coordinator's address, taught by a message of its own: the only one its replies and acks come from.
  await drive(chains, 'session.receive', sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', 'Noted.'))
  expect(JSON.parse(sender.files.get(LEARNT)!).from).toBe(COORD_AT)
  return { chains, sender, coordinator, id }
}

test('a question asked with ask is pushed to the coordinator on another machine, kept there as a replica, and acked', async () => {
  const { chains, sender, coordinator, id } = await askedRemotely()
  expect(pushes(sender).map(s => s.to)).toEqual(['Coord: ops [abc]'])
  expect(objectAt(sender, id).replica).toMatchObject({ seq: 1, state: 'sent', attempts: 1 })
  const consumed = await receive(chains, coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  expect(typeof consumed.consumed).toBe('string')
  const replica = objectAt(coordinator, id)
  expect(replica).toMatchObject({ v: 2, id, status: 'open', seq: 1, origin: { machine: 'unknown', address: SENDER_AT }, sender: { session: 's-one', name: 'Orch: belt' } })
  expect(replica.replica).toBeUndefined()
  expect(qAcks(coordinator, 'asked')).toEqual([{ to: SENDER_AT, text: qAckLine({ id, seq: 1, of: 'asked' }) }])
  await drive(chains, 'session.receive', sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', only(qAcks(coordinator, 'asked')).text))
  expect(objectAt(sender, id).replica.state).toBe('acked')
  // The same push again changes nothing and is acked again.
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  expect(objectAt(coordinator, id)).toEqual(replica)
  expect(qAcks(coordinator, 'asked').length).toBe(2)
})

test('the pane\'s answer on a replica is applied at the owner, told to its asker\'s model, acked, and the replica delivered', async () => {
  const { chains, sender, coordinator, id } = await askedRemotely()
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  const done = await answerAskedFromPane(coordinator.dollar, id, 'B : acme/app#2 first')
  expect(done?.seq).toBe(1)
  expect(objectAt(coordinator, id)).toMatchObject({ status: 'answered', seq: 1, delivery: { state: 'sent', attempts: 1 } })
  expect(replies(coordinator).map(s => s.to)).toEqual([SENDER_AT])
  // No message by name to the asker from the coordinator's machine: the owner tells it.
  expect(coordinator.sent.filter(s => s.text.startsWith('[module] '))).toEqual([])
  const passed = await receive(chains, sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', only(replies(coordinator)).text))
  expect(passed.consumed).toBeUndefined()
  expect(passed.text).toContain(`[module] The operator answered your question ${id} « merge order » (blocks: acme/app#1) through Coord: ops [abc]`)
  expect(passed.text).toContain('B : acme/app#2 first')
  expect(passed.text).not.toContain('[module-q]')
  const owned = objectAt(sender, id)
  expect(owned).toMatchObject({ status: 'answered', seq: 2, answer: { text: 'B : acme/app#2 first', by: 'pane', settler: 'Coord: ops [abc]' } })
  expect(qAcks(sender, 'reply')).toEqual([{ to: COORD_AT, text: qAckLine({ id, seq: 1, of: 'reply' }) }])
  expect(parseQ(pushes(sender).at(-1)!.text)?.seq).toBe(2)
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', pushes(sender).at(-1)!.text))
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(qAcks(sender, 'reply')).text))
  expect(objectAt(coordinator, id)).toMatchObject({ status: 'answered', seq: 2, answer: { by: 'pane' }, delivery: { state: 'delivered' } })
  // The same reply again is acked again, applied and told nowhere.
  const again = await receive(chains, sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', only(replies(coordinator)).text))
  expect(typeof again.consumed).toBe('string')
  expect(qAcks(sender, 'reply').map(s => parseQAck(s.text)?.already)).toEqual([undefined, undefined])
  expect(objectAt(sender, id).seq).toBe(2)
})

test('answers that cross: the asker\'s own, first at the owner, wins; the pane\'s is said already answered there', async () => {
  const { chains, sender, coordinator, id } = await askedRemotely()
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  await answerAskedFromPane(coordinator.dollar, id, 'B : acme/app#2 first')
  const settled = await settle(sender.dollar, { id, outcome: 'answered-here', text: 'A', author: null, work: null })
  expect(settled.isError).toBeUndefined()
  const received = await receive(chains, sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', only(replies(coordinator)).text))
  expect(typeof received.consumed).toBe('string')
  expect(objectAt(sender, id)).toMatchObject({ status: 'answered', seq: 2, answer: { text: 'A', by: 'tab' } })
  expect(qAcks(sender, 'reply').map(s => parseQAck(s.text))).toEqual([{ id, seq: 1, of: 'reply', already: true }])
  // The owner's state, pushed at its settle and again with the « already », replaces the replica's answer.
  for (const push of pushes(sender)) await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', push.text))
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(qAcks(sender, 'reply')).text))
  expect(objectAt(coordinator, id)).toMatchObject({ status: 'answered', seq: 2, answer: { text: 'A', by: 'tab' }, delivery: { state: 'failed', reason: 'already answered in its own tab' } })
})

test('a push not acked is sent again at the asker\'s turn ends every 30 s, three sends in all, then failed', async () => {
  const { chains, sender, id } = await askedRemotely()
  const age = () => {
    const now = objectAt(sender, id)
    sender.files.set(`${ROUND}/${id}.json`, JSON.stringify({ ...now, replica: { ...now.replica, at: new Date(Date.now() - 31_000).toISOString() } }) + '\n')
  }
  // Not yet 30 s: nothing sent again.
  await drive(chains, 'turn.complete', sender.dollar, turnEnd('Done.'))
  expect(pushes(sender).length).toBe(1)
  for (const attempts of [2, 3]) {
    age()
    await drive(chains, 'turn.complete', sender.dollar, turnEnd('Done.'))
    expect(pushes(sender).length).toBe(attempts)
    expect(objectAt(sender, id).replica).toMatchObject({ seq: 1, state: 'sent', attempts })
  }
  age()
  await drive(chains, 'turn.complete', sender.dollar, turnEnd('Done.'))
  expect(pushes(sender).length).toBe(3)
  expect(objectAt(sender, id).replica).toMatchObject({ state: 'failed', attempts: 3, reason: 'no acknowledgment after 3 sends' })
  expect(sender.logged.filter(l => l.endsWith(`${id} not pushed to the coordinator Coord: ops [abc]: no acknowledgment after 3 sends`)).length).toBe(1)
})

test('a replica\'s answer not acked is sent again by the round\'s wake every 30 s, three sends in all, then failed', async () => {
  const { chains, sender, coordinator, id } = await askedRemotely()
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  await answerAskedFromPane(coordinator.dollar, id, 'A : acme/app#1 first')
  const age = () => {
    const now = objectAt(coordinator, id)
    coordinator.files.set(`${ROUND}/${id}.json`, JSON.stringify({ ...now, delivery: { ...now.delivery, at: new Date(Date.now() - 31_000).toISOString() } }) + '\n')
  }
  await resendReplies(coordinator.dollar)
  expect(replies(coordinator).length).toBe(1)
  for (const attempts of [2, 3]) {
    age()
    await resendReplies(coordinator.dollar)
    expect(replies(coordinator).length).toBe(attempts)
    expect(objectAt(coordinator, id).delivery).toMatchObject({ state: 'sent', attempts })
  }
  age()
  await resendReplies(coordinator.dollar)
  expect(replies(coordinator).length).toBe(3)
  expect(objectAt(coordinator, id).delivery).toMatchObject({ state: 'failed', attempts: 3, reason: 'no acknowledgment after 3 sends' })
})

test('a push reaching a session that is no coordinator is consumed and kept nowhere', async () => {
  const { chains, sender, id } = await askedRemotely()
  const elsewhere = fake({ name: 'Orch: other' })
  const consumed = await receive(chains, elsewhere.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  expect(typeof consumed.consumed).toBe('string')
  expect(elsewhere.files.has(`${ROUND}/${id}.json`)).toBe(false)
  expect(elsewhere.sent).toEqual([])
})

test('the coordinator\'s withdrawal of a replica by settle is applied at the owner, and told by message to its asker\'s session', async () => {
  const { chains, sender, coordinator, id } = await askedRemotely()
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  const settled = await settle(coordinator.dollar, { id, outcome: 'withdrawn', text: 'merged meanwhile', author: null, work: null })
  expect(settled.result).toContain('The answer goes to Orch: belt on its machine now.')
  expect(objectAt(coordinator, id)).toMatchObject({ status: 'withdrawn', seq: 1, answer: { by: 'coordinator', text: 'merged meanwhile' }, delivery: { state: 'sent', attempts: 1 } })
  expect(parseQ(only(replies(coordinator)).text)?.event).toMatchObject({ kind: 'reply', reply: { status: 'withdrawn', by: 'coordinator' } })
  // The reply reaches another session of the owner's machine: the asker's own is sent the message.
  sender.dollar.session.id = async () => 's-other'
  const received = await receive(chains, sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', only(replies(coordinator)).text))
  expect(typeof received.consumed).toBe('string')
  expect(objectAt(sender, id)).toMatchObject({ status: 'withdrawn', seq: 2, answer: { text: 'merged meanwhile', by: 'coordinator', settler: 'Coord: ops [abc]' } })
  expect(sender.sent.filter(s => s.text.startsWith('[module] '))).toEqual([{ to: { sessionId: 's-one' }, text: `[module] Coord: ops [abc] withdrew your question ${id} « merge order » (blocks: acme/app#1): merged meanwhile` }])
})

test('a claim in the asker\'s tab moves the seq and is pushed; the replica keeps the pane\'s answer on its way over that open push', async () => {
  const { chains, sender, coordinator, id } = await askedRemotely()
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  await answerAskedFromPane(coordinator.dollar, id, 'B : acme/app#2 first')
  await drive(chains, 'prompt.submit', sender.dollar, typed('composer', 'B'))
  expect(objectAt(sender, id)).toMatchObject({ status: 'open', seq: 2, claimed: { typed: 'B' } })
  const claim = pushes(sender).at(-1)!
  expect(parseQ(claim.text)?.seq).toBe(2)
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', claim.text))
  const replica = objectAt(coordinator, id)
  expect(replica).toMatchObject({ status: 'answered', seq: 2, answer: { text: 'B : acme/app#2 first', by: 'pane' }, delivery: { state: 'sent' } })
  expect(replica.claimed).toBeUndefined()
})

test('a push older than the replica, arriving after a newer one, changes nothing and is acked', async () => {
  const { chains, sender, coordinator, id } = await askedRemotely()
  await drive(chains, 'prompt.submit', sender.dollar, typed('composer', 'B'))
  const first = only(pushes(sender))
  const second = only(pushes(sender), 1)
  expect([parseQ(first.text)?.seq, parseQ(second.text)?.seq]).toEqual([1, 2])
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', second.text))
  const replica = objectAt(coordinator, id)
  expect(replica.seq).toBe(2)
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', first.text))
  expect(objectAt(coordinator, id)).toEqual(replica)
  expect(qAcks(coordinator, 'asked').map(s => [s.to, parseQAck(s.text)?.seq])).toEqual([[SENDER_AT, 2], [SENDER_AT, 1]])
})

test('a close its owner makes reaches an open replica, and the coordinator here that was shown it is told', async () => {
  const { chains, sender, coordinator, id } = await askedRemotely()
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  coordinator.files.set(`${HOME}/.claude/claude-orchestrator/round-listed.json`, JSON.stringify([id]))
  await settle(sender.dollar, { id, outcome: 'withdrawn', text: 'moot now', author: null, work: null })
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', pushes(sender).at(-1)!.text))
  expect(objectAt(coordinator, id)).toMatchObject({ status: 'withdrawn', seq: 2 })
  const told = coordinator.sent.filter(s => s.text.startsWith('[module] Settled'))
  expect(told.length).toBe(1)
  expect(only(told).text).toContain(`(entry ${id}) — moot now`)
})

test('a push arms its own resend: the timer sends it again 30 s on, with no turn of the asker\'s ending', async () => {
  forgetResendTimer()
  const { sender, id } = await askedRemotely()
  const timers = sender.later.filter(t => t.ms > 30_000)
  expect(timers.length).toBe(1)
  const now = objectAt(sender, id)
  sender.files.set(`${ROUND}/${id}.json`, JSON.stringify({ ...now, replica: { ...now.replica, at: new Date(Date.now() - 31_000).toISOString() } }) + '\n')
  await only(timers).fn()
  expect(pushes(sender).length).toBe(2)
  expect(objectAt(sender, id).replica).toMatchObject({ seq: 1, state: 'sent', attempts: 2 })
})

test('a push sent after the timer was armed is sent again 30 s on: the tick that finds it too young arms the timer again', async () => {
  forgetResendTimer()
  const { chains, sender, coordinator, id } = await askedRemotely()
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  await drive(chains, 'session.receive', sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', only(qAcks(coordinator, 'asked')).text))
  expect(objectAt(sender, id).replica.state).toBe('acked')
  // A second question, of a later turn, pushed while the first push's timer is still armed: no timer of its own.
  askTurnStarted()
  const asked = await callAsk(sender.dollar, { tool: 'mcp__orchestrator__ask', ...ASKED_FIELDS, subject: 'release order', blocks: 'acme/app#3' })
  const second = /Asked as (q-\S+?):/.exec(asked.result)![1]!
  expect(sender.later.filter(t => t.ms > 30_000).length).toBe(1)
  await only(sender.later.filter(t => t.ms > 30_000)).fn()
  expect(pushes(sender).length).toBe(2)
  const timers = sender.later.filter(t => t.ms > 30_000)
  expect(timers.length).toBe(2)
  const now = objectAt(sender, second)
  sender.files.set(`${ROUND}/${second}.json`, JSON.stringify({ ...now, replica: { ...now.replica, at: new Date(Date.now() - 31_000).toISOString() } }) + '\n')
  await only(timers, 1).fn()
  expect(pushes(sender).length).toBe(3)
  expect(objectAt(sender, second).replica).toMatchObject({ seq: 1, state: 'sent', attempts: 2 })
})

test('the resend timer is armed again by no tick that finds every push acked, nor while its coordinator is on this machine', async () => {
  forgetResendTimer()
  const { chains, sender, coordinator, id } = await askedRemotely()
  const timers = () => sender.later.filter(t => t.ms > 30_000)
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  await drive(chains, 'session.receive', sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', only(qAcks(coordinator, 'asked')).text))
  await only(timers()).fn()
  expect(timers().length).toBe(1)
  // A push still waiting, its coordinator now on this machine: nothing to send it again to.
  const now = objectAt(sender, id)
  sender.files.set(`${ROUND}/${id}.json`, JSON.stringify({ ...now, replica: { ...now.replica, state: 'sent' } }) + '\n')
  sender.files.set(RECORD, JSON.stringify({ name: 'Coord: ops [abc]', tty: '/dev/ttys9' }))
  forgetResendTimer()
  const armed = timers().length
  await only(timers()).fn()
  expect(timers().length).toBe(armed)
})

test('a reply from another address than the coordinator\'s is refused: no answer, no acknowledgment', async () => {
  const { chains, sender, coordinator, id } = await askedRemotely(CONSENT_ASKED_FIELDS)
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  await answerAskedFromPane(coordinator.dollar, id, 'A : Accorder')
  const consumed = await receive(chains, sender.dollar, delivered(FORGER_AT, 'Coord: ops [abc]', only(replies(coordinator)).text))
  expect(typeof consumed.consumed).toBe('string')
  expect(objectAt(sender, id)).toMatchObject({ status: 'open', seq: 1, answer: null })
  expect(qAcks(sender, 'reply')).toEqual([])
  expect(sender.logged.some(l => l.endsWith(`a remote reply to ${id} from ${FORGER_AT}, not the coordinator's, refused`))).toBe(true)
})

test('acknowledgments from another address are refused: the push is sent again, the reply stays on its way', async () => {
  const { chains, sender, coordinator, id } = await askedRemotely()
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  // A forged acknowledgment of the push stops no resend.
  await drive(chains, 'session.receive', sender.dollar, delivered(FORGER_AT, 'Coord: ops [abc]', qAckLine({ id, seq: 1, of: 'asked' })))
  expect(objectAt(sender, id).replica.state).toBe('sent')
  const now = objectAt(sender, id)
  sender.files.set(`${ROUND}/${id}.json`, JSON.stringify({ ...now, replica: { ...now.replica, at: new Date(Date.now() - 31_000).toISOString() } }) + '\n')
  await drive(chains, 'turn.complete', sender.dollar, turnEnd('Done.'))
  expect(pushes(sender).length).toBe(2)
  // A forged acknowledgment of the pane's reply leaves it on its way.
  await answerAskedFromPane(coordinator.dollar, id, 'B : acme/app#2 first')
  await drive(chains, 'session.receive', coordinator.dollar, delivered(FORGER_AT, 'Orch: belt', qAckLine({ id, seq: 1, of: 'reply' })))
  expect(objectAt(coordinator, id).delivery.state).toBe('sent')
})

test('a push resent by another session of the owner\'s machine, at its own address, updates the replica and is acked there', async () => {
  const { chains, sender, coordinator, id } = await askedRemotely()
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  await drive(chains, 'prompt.submit', sender.dollar, typed('composer', 'B'))
  const OTHER_SESSION_AT = 'uds:/tmp/cc-socks/502.sock'
  await drive(chains, 'session.receive', coordinator.dollar, delivered(OTHER_SESSION_AT, 'Orch: other', pushes(sender).at(-1)!.text))
  expect(objectAt(coordinator, id)).toMatchObject({ seq: 2, origin: { machine: 'unknown', address: OTHER_SESSION_AT } })
  expect(qAcks(coordinator, 'asked').map(s => [s.to, parseQAck(s.text)?.seq])).toEqual([[SENDER_AT, 1], [OTHER_SESSION_AT, 2]])
})

test('a push meeting a question this machine owns is ignored, and a reply to a question never pushed answers nothing', async () => {
  const { chains, sender, id } = await askedRemotely()
  const before = objectAt(sender, id)
  // Its own push, handed back to its machine's coordinator session: never written over the owner's object.
  const own = coordinatorMachine()
  own.files.set(`${ROUND}/${id}.json`, JSON.stringify(before) + '\n')
  await drive(chains, 'session.receive', own.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  expect(objectAt(own, id)).toEqual(before)
  expect(qAcks(own, 'asked')).toEqual([])
  // A reply to a question that was never pushed to a coordinator elsewhere.
  const { replica: _replica, ...unpushed } = before
  sender.files.set(`${ROUND}/${id}.json`, JSON.stringify(unpushed) + '\n')
  const reply = qReplyLine(id, 1, { status: 'answered', text: 'A', by: 'pane', at: '2026-11-14T15:00:00.000Z', settler: 'Coord: ops [abc]' })
  await drive(chains, 'session.receive', sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', reply))
  expect(objectAt(sender, id).status).toBe('open')
  expect(qAcks(sender, 'reply')).toEqual([])
})

// --- the coordinator replaced on its machine: the address the sender learnt is stale ------------

// Observed 2026-11-17: the coordinator handed over to a successor of the same name, and the sender's
// learnt address, its predecessor's bridge, answered every send with HTTP 409. The questions and the
// waits went to that address alone, refused each time and entered nowhere; only the row fell back
// to the name. Every send to the coordinator falls back to its name, forgets the stale address, and
// learns the new one from the coordinator's own acknowledgment.
const STALE_AT = 'bridge:session_predecessor'
const learntFrom = (fx: ReturnType<typeof fake>) => JSON.parse(fx.files.get(LEARNT)!).from

test('a question asked with ask reaches a coordinator whose learnt address went stale, by its name, and its ack teaches the new address', async () => {
  const chains = mounted()
  const sender = fake({ remote: true, staleAt: STALE_AT })
  sender.dollar.ui.log = () => undefined
  const coordinator = coordinatorMachine()
  // The address is forgotten before the send by name: an acknowledgment landing as that send returns teaches the new one.
  const send = sender.dollar.session.send
  const forgottenAtSend: unknown[] = []
  sender.dollar.session.send = async args => {
    if (args.to === 'Coord: ops [abc]') forgottenAtSend.push(learntFrom(sender))
    return send(args)
  }
  askTurnStarted()
  const asked = await callAsk(sender.dollar, { tool: 'mcp__orchestrator__ask', ...ASKED_FIELDS })
  const id = /Asked as (q-\S+?):/.exec(asked.result)![1]!
  expect(pushes(sender).map(s => s.to)).toEqual(['Coord: ops [abc]'])
  expect(forgottenAtSend).toEqual([null])
  expect(learntFrom(sender)).toBeNull()
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  expect(objectAt(coordinator, id)).toMatchObject({ id, status: 'open', seq: 1 })
  await drive(chains, 'session.receive', sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', only(qAcks(coordinator, 'asked')).text))
  expect(objectAt(sender, id).replica.state).toBe('acked')
  expect(learntFrom(sender)).toBe(COORD_AT)
})

test('a wait reaches a coordinator whose learnt address went stale, by its name, is acked, and is not sent again unchanged', async () => {
  const chains = mounted()
  const sender = fake({ remote: true, staleAt: STALE_AT })
  const coordinator = coordinatorMachine()
  await drive(chains, 'turn.complete', sender.dollar, turnEnd(PROPOSAL))
  expect(asks(sender).map(s => s.to)).toEqual(['Coord: ops [abc]'])
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(asks(sender)).text))
  expect(entries(coordinator).length).toBe(1)
  await drive(chains, 'session.receive', sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', only(acks(coordinator)).text))
  expect(waitOf(sender).pending).toBeNull()
  expect(learntFrom(sender)).toBe(COORD_AT)
  await drive(chains, 'turn.complete', sender.dollar, turnEnd(PROPOSAL))
  expect(asks(sender).length).toBe(1)
})

// --- the replica's owner replaced on its machine: the address its last push came from is stale ----

// Observed 2026-11-23 and 2026-11-27: a remote orchestrator restarted, or its bridge changed, and the
// pane's answer went to the address its last push came from alone, refused with HTTP 409 three times
// and failed, while a session of its name ran. The listing the host gives names the one that runs now.
const GONE_AT = 'bridge:session_old'
const NOW_AT = 'bridge:session_now'
const LIVE_AT = 'Orch: belt [b2060c]'
const remoteRows = (...rows: [string, string][]) => ['This session is Coord: ops [abc] — the name other sessions use to message it', '', `Peer sessions (${rows.length}):`,
  ...rows.map(([name, state]) => `  ${name}  ·  Remote Control  ·  ${state}`)].join('\n')
const LIVE_LISTING = remoteRows([LIVE_AT, 'running'], ['Orch: belt [22e182]', 'offline'], ['Orch: other [7b46ca]', 'running'])

// The coordinator of a question pushed from `GONE_AT`, which the host now refuses; `listing` is what
// ListAgents answers there, and `refused` the further addresses refused.
async function replicaOfGone(listing: string, refused: readonly string[] = []) {
  const ctx = await askedRemotely()
  const { chains, sender, coordinator, id } = ctx
  const send = coordinator.dollar.session.send
  coordinator.dollar.session.send = async args => typeof args.to === 'string' && [GONE_AT, ...refused].includes(args.to)
    ? { isDelivered: false, reason: `Failed to send to ${args.to}: HTTP 409 — "Session is not active"` }
    : send(args)
  coordinator.dollar.tool.call = async () => ({ text: listing })
  await drive(chains, 'session.receive', coordinator.dollar, delivered(GONE_AT, 'Orch: belt', only(pushes(sender)).text))
  const age = () => {
    const now = objectAt(coordinator, id)
    coordinator.files.set(`${ROUND}/${id}.json`, JSON.stringify({ ...now, delivery: { ...now.delivery, at: new Date(Date.now() - 31_000).toISOString() } }) + '\n')
  }
  return { ...ctx, age }
}

test('an answer refused at the recorded address goes to the live session of the asker\'s name, whose address every replica of that sender takes', async () => {
  const { coordinator, id } = await replicaOfGone(LIVE_LISTING)
  // An older question of the same sender holds the same stale address; another sender's keeps its own.
  const sibling = { ...objectAt(coordinator, id), id: 'q-sibling' }
  coordinator.files.set(`${ROUND}/q-sibling.json`, JSON.stringify(sibling) + '\n')
  coordinator.files.set(`${ROUND}/q-foreign.json`, JSON.stringify({ ...sibling, id: 'q-foreign', sender: { ...sibling.sender, name: 'Orch: other' } }) + '\n')
  await answerAskedFromPane(coordinator.dollar, id, 'B : acme/app#2 first')
  expect(replies(coordinator).map(s => s.to)).toEqual([LIVE_AT])
  const replica = objectAt(coordinator, id)
  expect(replica.delivery).toMatchObject({ state: 'sent', attempts: 1 })
  expect(replica.delivery.reason).toBeUndefined()
  expect(replica.origin.address).toBe(LIVE_AT)
  expect(objectAt(coordinator, 'q-sibling').origin.address).toBe(LIVE_AT)
  expect(objectAt(coordinator, 'q-foreign').origin.address).toBe(GONE_AT)
})

test('an acknowledgment from the live session of a readdressed answer delivers it, one from another name is refused', async () => {
  const { chains, coordinator, id } = await replicaOfGone(LIVE_LISTING)
  await answerAskedFromPane(coordinator.dollar, id, 'B : acme/app#2 first')
  const line = qAckLine({ id, seq: 1, of: 'reply' })
  await drive(chains, 'session.receive', coordinator.dollar, delivered(FORGER_AT, 'Orch: other', line))
  expect(objectAt(coordinator, id).delivery.state).toBe('sent')
  // The host's envelope may carry the name with its reference, in the former spelling.
  await drive(chains, 'session.receive', coordinator.dollar, delivered(NOW_AT, 'Orch : belt [b2060c]', line))
  expect(objectAt(coordinator, id).delivery.state).toBe('delivered')
})

test('a send no acknowledgment answered is sent again to the live session of the asker\'s name', async () => {
  const { coordinator, id, age } = await replicaOfGone(LIVE_LISTING)
  const send = coordinator.dollar.session.send
  const reached: unknown[] = []
  // The recorded address takes this send and answers nothing.
  coordinator.dollar.session.send = async args => {
    reached.push(args.to)
    return args.to === GONE_AT ? { isDelivered: true } : send(args)
  }
  await answerAskedFromPane(coordinator.dollar, id, 'A : acme/app#1 first')
  age()
  await resendReplies(coordinator.dollar)
  expect(reached).toEqual([GONE_AT, LIVE_AT])
  expect(objectAt(coordinator, id)).toMatchObject({ origin: { address: LIVE_AT }, delivery: { state: 'sent', attempts: 1 } })
  for (let i = 0; i < 3; i++) {
    age()
    await resendReplies(coordinator.dollar)
  }
  // The live session took three sends and acknowledged none: failed, as an address that answers nothing.
  expect(reached).toEqual([GONE_AT, LIVE_AT, LIVE_AT, LIVE_AT])
  expect(objectAt(coordinator, id).delivery).toMatchObject({ state: 'failed', reason: 'no acknowledgment after 3 sends' })
})

test('an answer refused everywhere is not failed while a live session of the asker\'s name is listed, and is once none is', async () => {
  const { coordinator, id, age } = await replicaOfGone(LIVE_LISTING, [LIVE_AT])
  await answerAskedFromPane(coordinator.dollar, id, 'A : acme/app#1 first')
  for (let i = 0; i < 4; i++) {
    age()
    await resendReplies(coordinator.dollar)
  }
  expect(objectAt(coordinator, id)).toMatchObject({ origin: { address: GONE_AT }, delivery: { state: 'sent', attempts: 3 } })
  coordinator.dollar.tool.call = async () => ({ text: remoteRows([LIVE_AT, 'offline']) })
  age()
  await resendReplies(coordinator.dollar)
  expect(objectAt(coordinator, id).delivery).toMatchObject({ state: 'failed', attempts: 3, reason: 'no acknowledgment after 3 sends' })
})

for (const [what, listing] of [
  ['no session of the name', remoteRows(['Orch: other [7b46ca]', 'running'])],
  ['only an offline one', remoteRows([LIVE_AT, 'offline'])],
  ['two live ones', remoteRows([LIVE_AT, 'running'], ['Orch: belt [22e182]', 'idle'])],
] as const) {
  test(`an answer refused with ${what} listed is failed after three sends, its address kept`, async () => {
    const { coordinator, id, age } = await replicaOfGone(listing)
    await answerAskedFromPane(coordinator.dollar, id, 'A : acme/app#1 first')
    for (let i = 0; i < 3; i++) {
      age()
      await resendReplies(coordinator.dollar)
    }
    expect(replies(coordinator)).toEqual([])
    expect(objectAt(coordinator, id)).toMatchObject({ origin: { address: GONE_AT }, delivery: { state: 'failed', attempts: 3, reason: 'no acknowledgment after 3 sends' } })
  })
}

test('a reply reaching the successor of an asker gone from its machine is read by the successor\'s own model', async () => {
  const { chains, sender, coordinator, id } = await askedRemotely()
  await drive(chains, 'session.receive', coordinator.dollar, delivered(SENDER_AT, 'Orch: belt', only(pushes(sender)).text))
  await answerAskedFromPane(coordinator.dollar, id, 'B : acme/app#2 first')
  // The asker's session is gone; another one of its name runs on its machine and takes the delivery.
  sender.files.set(ROW.replace('s-one', 's-two'), sender.files.get(ROW)!)
  sender.files.delete(ROW)
  sender.dollar.session.id = async () => 's-two'
  const before = sender.sent.length
  const passed = await receive(chains, sender.dollar, delivered(COORD_AT, 'Coord: ops [abc]', only(replies(coordinator)).text))
  expect(passed.consumed).toBeUndefined()
  expect(passed.text).toContain('B : acme/app#2 first')
  // Nothing sent to the asker by message: the successor is the one reading.
  expect(sender.sent.slice(before).filter(s => s.text.startsWith('[module] '))).toEqual([])
  expect(objectAt(sender, id)).toMatchObject({ status: 'answered', seq: 2 })
})
