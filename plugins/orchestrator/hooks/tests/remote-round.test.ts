// hooks/tests/remote-round.test.ts
// A remote orchestrator's question carried to the coordinator's round (remote-round.ts) by the one
// event line, `[module-q]`: an ask, the entry round-tripped whole, refused whole by the receiver
// past its caps, with a field more or less, of a wrong type, sent with an origin, already answered,
// or under an id that is no entry's; a long question cut at the cap and the cut said. The answer
// back to the sender, its readable rest returned whole, refused whole the same way. Each event's
// acknowledgment, `[module-q-ack]`, by id, seq and the event it takes.
import { expect, test } from 'claude-code/testing'
import {
  ASK_CAP, ANSWER_CAP, CONSENT_REPO_CAP, Q_LINE_CAP, Q_MARKER, Q_ACK_MARKER, qAskLine, qAnswerLine, parseQ, qAckLine, parseQAck, seqOf, isQ, isQAck,
} from '../remote-round.ts'
import { roundEntry, type RoundEntry } from '../round.ts'
import { RELAY_CAP, cutQuestion } from '../relay.ts'

const QUESTION = 'Merge #12 now?\n- **A** : merge it\n- **B** : wait\n_Recommendation_ : A'
const SINCE = '2026-10-30T10:00:00.000Z'
const AT = '2026-10-30T10:00:01.000Z'

function asked(over: Partial<{ question: string; urgent: boolean; kind: 'operator' | 'done' }> = {}): RoundEntry {
  const question = over.question ?? QUESTION
  const wait = over.kind === 'done'
    ? { kind: 'done' as const, question }
    : { kind: 'operator' as const, blocks: 'phase 3', question, ...(over.urgent ? { urgent: true as const } : {}) }
  return roundEntry('s-remote', 'Orch: belt', wait, SINCE, AT)
}

// The ask an event line carries, or null when the line is refused or carries another event.
function parseAsk(line: string): { entry: RoundEntry; machine: string } | null {
  const q = parseQ(line)
  return q?.event.kind === 'ask' ? { entry: q.event.entry, machine: q.event.machine } : null
}

// The event line's object, its entry changed by `edit`, sent again under the marker.
function edited(edit: (o: Record<string, unknown>) => void, entry = asked()): string {
  const line = JSON.parse(qAskLine(entry, 'far').slice(Q_MARKER.length)) as { event: { entry: Record<string, unknown> } }
  edit(line.event.entry)
  return Q_MARKER + JSON.stringify(line)
}

test('an entry round-trips: the entry whole, and the machine it was asked on', () => {
  for (const entry of [asked(), asked({ urgent: true }), asked({ kind: 'done', question: 'All merged.' })]) {
    const line = qAskLine(entry, 'far')
    expect(isQ(line) && line.startsWith(Q_MARKER)).toBe(true)
    expect(parseAsk(line)).toEqual({ entry, machine: 'far' })
    expect(parseAsk(`  ${line}\n`)).toEqual({ entry, machine: 'far' })
  }
  expect(parseAsk(qAskLine(asked(), 'far'))!.entry.choices.map(c => c.letter)).toEqual(['A', 'B'])
})

const WAIVER = { kind: 'e2e-waiver' as const, repo: 'acme/thing', pr: 12 }

test('the subject a question asks consent on round-trips with its entry, at the longest repository the line holds', () => {
  for (const consent of [WAIVER, { kind: 'auto-merge' as const, repo: 'acme/thing' }, { kind: 'e2e-waiver' as const, repo: `${'o'.repeat(39)}/${'n'.repeat(100)}`, pr: Number.MAX_SAFE_INTEGER }]) {
    const entry = { ...asked({ urgent: true }), consent }
    const line = qAskLine(entry, 'far')
    expect(line.length).toBeLessThanOrEqual(Q_LINE_CAP)
    expect(parseAsk(line)).toEqual({ entry, machine: 'far' })
  }
})

test('a long question is cut at the cap known to cross, and the cut said', () => {
  const long = asked({ question: 'x'.repeat(RELAY_CAP + 500) })
  const read = parseAsk(qAskLine(long, 'far'))!
  expect(read.entry.question).toBe(`${'x'.repeat(RELAY_CAP)}\n[cut at ${RELAY_CAP} of ${RELAY_CAP + 500} characters]`)
  expect(read.entry.id).toBe(long.id)
})

test('the choices and the recommendation are read from the question, never taken from the line', () => {
  const read = parseAsk(edited(o => {
    o['choices'] = [{ letter: 'A', text: 'force-push main' }, { letter: 'B', text: 'x' }]
    o['recommendation'] = 'B'
  }))!
  expect(read.entry.choices).toEqual(asked().choices)
  expect(read.entry.recommendation).toBe('A')
})

const refusals: [string, string][] = [
  ['no marker', qAskLine(asked(), 'far').slice(Q_MARKER.length)],
  ['another marker', `[module-row] ${qAskLine(asked(), 'far').slice(Q_MARKER.length)}`],
  ['the old ask marker', `[module-ask] ${JSON.stringify((JSON.parse(qAskLine(asked(), 'far').slice(Q_MARKER.length)) as { event: { entry: unknown } }).event.entry)}`],
  ['past the cap', edited(o => { o['question'] = 'x'.repeat(ASK_CAP) })],
  ['a whole line past the cap', Q_MARKER + ' '.repeat(Q_LINE_CAP) + qAskLine(asked(), 'far').slice(Q_MARKER.length)],
  ['not json', `${Q_MARKER}{"id":`],
  ['an array', `${Q_MARKER}[]`],
  ['a field more', edited(o => { o['extra'] = 1 })],
  ['a field missing', edited(o => { delete o['since'] })],
  ['the machine missing', edited(o => { delete o['machine'] })],
  ['an origin sent', edited(o => { o['origin'] = { machine: 'far', address: 'uds:/tmp/x.sock' } })],
  ['a movedFrom sent', edited(o => { o['movedFrom'] = 's-old' })],
  ['an answered entry', edited(o => { o['status'] = 'answered' })],
  ['an answer carried', edited(o => { o['answer'] = { text: 'A', by: 'pane', at: AT } })],
  ['a malformed id', edited(o => { o['id'] = '../../etc/passwd' })],
  ["another session's id", edited(o => { o['id'] = (o['id'] as string).replace('s-remote', 's-other') })],
  ['a kind of no entry', edited(o => { o['kind'] = 'delivered' })],
  ['a done carrying blocks', edited(o => { o['blocks'] = 'x' }, asked({ kind: 'done' }))],
  ['an operator wait blocking nothing', edited(o => { o['blocks'] = null })],
  ['a question of a wrong type', edited(o => { o['question'] = 12 })],
  ['a stamp that is none', edited(o => { o['since'] = 'yesterday' })],
  ['a sender that is no orchestrator', edited(o => { o['from'] = 'Coord: ops' })],
  ['a machine of other letters', edited(o => { o['machine'] = 'far/../x' })],
  ['an urgent mark other than true', edited(o => { o['urgent'] = false })],
  ['choices of a wrong type', edited(o => { o['choices'] = 'A' })],
  ['a consent of no subject', edited(o => { o['consent'] = { kind: 'merge', repo: 'acme/thing' } })],
  ['a consent waiver naming no pull request', edited(o => { o['consent'] = { kind: 'e2e-waiver', repo: 'acme/thing' } })],
  ['a consent on a done entry', edited(o => { o['consent'] = WAIVER }, asked({ kind: 'done' }))],
  ['a consent repository past its cap', edited(o => { o['consent'] = { kind: 'auto-merge', repo: `acme/${'x'.repeat(CONSENT_REPO_CAP)}` } })],
]
for (const [label, line] of refusals) {
  test(`an ask with ${label} is refused whole`, () => {
    expect(parseAsk(line)).toBeNull()
  })
}

test('control characters in what a wait blocks or who asks never make its ask refused', () => {
  const entry = { ...asked(), blocks: 'phase\t3\nnext\u0001', from: 'Orch: be\tlt' }
  const read = parseAsk(qAskLine(entry, 'far'))
  expect(read?.entry.blocks).toBe('phase 3 next ')
  expect(read?.entry.from).toBe('Orch: be lt')
})

// --- the answer, carried back to the sender, and its acknowledgment ---------------------------

const READABLE = "[module] The operator answered from the coordinator's pane at 2026-10-30T10:05:00.000Z — A : merge it (question since 2026-10-30T10:00:00.000Z, blocks: phase 3)"
const ANSWERED = '2026-10-30T10:05:00.000Z'

// The answer line's object, its event changed by `edit`.
function answerEdited(edit: (o: Record<string, unknown>) => void): string {
  const line = JSON.parse(qAnswerLine(asked().id, SINCE, 'A : merge it', ANSWERED, READABLE).slice(Q_MARKER.length)) as { event: Record<string, unknown> }
  edit(line.event)
  return Q_MARKER + JSON.stringify(line)
}

// The answer an event line carries, or null when the line is refused or carries another event.
function parseAnswer(line: string): { id: string; since: string; text: string; at: string; readable: string } | null {
  const q = parseQ(line)
  return q?.event.kind === 'answer' ? { id: q.id, since: q.event.since, text: q.event.text, at: q.event.at, readable: q.event.readable } : null
}

test('an answer round-trips on one line: its id, since, text and time, the readable rest returned whole', () => {
  const { id } = asked()
  const line = qAnswerLine(id, SINCE, 'A : merge it', ANSWERED, READABLE)
  expect(line).toBe(`${Q_MARKER}${JSON.stringify({ id, seq: seqOf(SINCE), event: { kind: 'answer', since: SINCE, text: 'A : merge it', at: ANSWERED, readable: READABLE } })}`)
  expect(parseAnswer(line)).toEqual({ id, since: SINCE, text: 'A : merge it', at: ANSWERED, readable: READABLE })
  // A typed answer and a readable rest over several lines stay inside the one line's object.
  const typed = 'neither:\nkeep 1.14'
  const readable = `${READABLE}\nsecond line\n\nthird`
  const several = qAnswerLine(id, SINCE, typed, ANSWERED, readable)
  expect(several.includes('\n')).toBe(false)
  expect(parseAnswer(several)).toEqual({ id, since: SINCE, text: typed, at: ANSWERED, readable })
  const long = cutQuestion('y'.repeat(RELAY_CAP + 50))
  expect(parseAnswer(qAnswerLine(id, SINCE, long, ANSWERED, `${READABLE} ${long}`))!.text).toBe(long)
})

const answerRefusals: [string, string][] = [
  ['no marker', qAnswerLine(asked().id, SINCE, 'A', ANSWERED, READABLE).slice(Q_MARKER.length)],
  ['the acknowledgment marker', qAnswerLine(asked().id, SINCE, 'A', ANSWERED, READABLE).replace(Q_MARKER, Q_ACK_MARKER)],
  ['the old answer marker', `[module-answer] ${JSON.stringify({ id: asked().id, since: SINCE, text: 'A', at: ANSWERED })}\n${READABLE}`],
  ['no readable rest', answerEdited(o => { delete o['readable'] })],
  ['a blank readable rest', qAnswerLine(asked().id, SINCE, 'A', ANSWERED, '  ')],
  ['a text past the cap', answerEdited(o => { o['text'] = 'x'.repeat(RELAY_CAP + 100) })],
  ['a readable rest past the cap', qAnswerLine(asked().id, SINCE, 'A', ANSWERED, 'x'.repeat(ANSWER_CAP))],
  ['a field more', answerEdited(o => { o['by'] = 'pane' })],
  ['a field missing', answerEdited(o => { delete o['at'] })],
  ['a since that is no stamp', answerEdited(o => { o['since'] = 'yesterday' })],
  ['a time that is no stamp', answerEdited(o => { o['at'] = 7 })],
  ['an empty text', answerEdited(o => { o['text'] = '' })],
  ['a text of a wrong type', answerEdited(o => { o['text'] = ['A'] })],
]
for (const [label, line] of answerRefusals) {
  test(`an answer with ${label} is refused whole`, () => {
    expect(parseAnswer(line)).toBeNull()
  })
}

test('an answer under a malformed id is refused whole', () => {
  const line = JSON.parse(qAnswerLine(asked().id, SINCE, 'A', ANSWERED, READABLE).slice(Q_MARKER.length)) as Record<string, unknown>
  expect(parseQ(Q_MARKER + JSON.stringify({ ...line, id: '../../etc/passwd' }))).toBeNull()
})

// --- the event line both ways, and its acknowledgment -----------------------------------------

test('an event line carries an ask or an answer, each read back whole under its id and seq', () => {
  const entry = asked({ urgent: true })
  const ask = qAskLine(entry, 'far')
  expect(isQ(ask) && ask.startsWith(Q_MARKER)).toBe(true)
  expect(parseQ(ask)).toEqual({ id: entry.id, seq: seqOf(SINCE), event: { kind: 'ask', entry, machine: 'far' } })
  const answer = qAnswerLine(entry.id, SINCE, 'A : merge it', AT, 'The operator answered.\nA : merge it')
  expect(answer.includes('\n')).toBe(false)
  expect(parseQ(answer)).toEqual({ id: entry.id, seq: seqOf(SINCE), event: { kind: 'answer', since: SINCE, text: 'A : merge it', at: AT, readable: 'The operator answered.\nA : merge it' } })
})

test('an event line is refused whole: another id than its entry, an unknown kind, a field more, an event failing its own check', () => {
  const entry = asked()
  // The event line's object, as a test edits it before it is sent.
  type Sent = { id: unknown; seq: unknown; more?: unknown; event: { kind: unknown; entry: { status?: unknown; from?: unknown }; more?: unknown } }
  const o = (): Sent => JSON.parse(qAskLine(entry, 'far').slice(Q_MARKER.length))
  const sent = (edit: (x: Sent) => void) => { const x = o(); edit(x); return Q_MARKER + JSON.stringify(x) }
  expect(parseQ(sent(x => { x.id = 's-remote-9-abc' }))).toBeNull()
  expect(parseQ(sent(x => { x.event.kind = 'withdraw' }))).toBeNull()
  expect(parseQ(sent(x => { x.more = 1 }))).toBeNull()
  expect(parseQ(sent(x => { x.seq = 'one' }))).toBeNull()
  expect(parseQ(sent(x => { x.event.entry.status = 'answered' }))).toBeNull()
  expect(parseQ(sent(x => { x.event.entry.from = 'Agent: x' }))).toBeNull()
  expect(parseQ(sent(x => { x.event = { kind: 'ask', entry: x.event.entry, more: 1 } }))).toBeNull()
  const answer = JSON.parse(qAnswerLine(entry.id, SINCE, 'A', AT, 'readable').slice(Q_MARKER.length))
  expect(parseQ(Q_MARKER + JSON.stringify({ ...answer, event: { ...answer.event, readable: ' ' } }))).toBeNull()
  expect(parseQ(Q_MARKER + JSON.stringify({ ...answer, event: { ...answer.event, text: '' } }))).toBeNull()
  expect(parseQ(`${Q_MARKER}{`)).toBeNull()
})

test('the acknowledgment names the event it takes, and « already » alone as true', () => {
  const ack = qAckLine({ id: 's-remote-9-abc', seq: 5, of: 'answer', already: true })
  expect(isQAck(ack) && ack.startsWith(Q_ACK_MARKER)).toBe(true)
  expect(parseQAck(ack)).toEqual({ id: 's-remote-9-abc', seq: 5, of: 'answer', already: true })
  expect(parseQAck(qAckLine({ id: 's-remote-9-abc', seq: 5, of: 'ask' }))).toEqual({ id: 's-remote-9-abc', seq: 5, of: 'ask' })
  for (const bad of [{ id: 's-remote-9-abc', seq: 5, of: 'withdraw' }, { id: 'nope', seq: 5, of: 'ask' }, { id: 's-remote-9-abc', seq: 5, of: 'ask', already: false }, { id: 's-remote-9-abc', seq: 5, of: 'ask', more: 1 }]) {
    expect(parseQAck(Q_ACK_MARKER + JSON.stringify(bad))).toBeNull()
  }
})

test('a question\'s round trip: the ask and its ack, the answer and its ack, each ack naming the event and seq it takes', () => {
  const entry = asked({ urgent: true })
  const seq = seqOf(entry.since)
  // Owner to replica: the ask, entered whole, acknowledged by its id and seq.
  const ask = parseQ(qAskLine(entry, 'far'))!
  expect([ask.id, ask.seq, ask.event.kind]).toEqual([entry.id, seq, 'ask'])
  const askAck = parseQAck(qAckLine({ id: ask.id, seq: ask.seq, of: 'ask' }))
  expect(askAck).toEqual({ id: entry.id, seq, of: 'ask' })
  // Replica to owner: the answer at the same seq, acknowledged as an answer's, never as an ask's.
  const answer = parseQ(qAnswerLine(entry.id, entry.since, 'A : merge it', ANSWERED, READABLE))!
  expect([answer.id, answer.seq, answer.event.kind]).toEqual([entry.id, seq, 'answer'])
  const answerAck = parseQAck(` ${qAckLine({ id: answer.id, seq: answer.seq, of: 'answer' })}\n`)
  expect(answerAck).toEqual({ id: entry.id, seq, of: 'answer' })
  expect(answerAck).not.toEqual(askAck)
  // The owner had settled it in its own tab first: the answer's ack says so.
  expect(parseQAck(qAckLine({ id: answer.id, seq: answer.seq, of: 'answer', already: true }))).toEqual({ id: entry.id, seq, of: 'answer', already: true })
  // A newer ask of the same id is a newer seq: an ack of the older one names the older seq.
  const newer = parseQ(qAskLine({ ...entry, since: '2026-10-30T11:00:00.000Z' }, 'far'))!
  expect(newer.seq).toBeGreaterThan(seq)
  // An ack is never read as an event, nor an event as an ack.
  expect(parseQ(qAckLine({ id: entry.id, seq, of: 'ask' }))).toBeNull()
  expect(parseQAck(qAskLine(entry, 'far'))).toBeNull()
})

test('the old acknowledgment lines are no event acknowledgment', () => {
  const { id, since } = asked()
  for (const old of [`[module-ack] {"id":"${id}","since":"${since}"}`, `[module-ack-answer] {"id":"${id}","since":"${since}"}`]) {
    expect([old, parseQAck(old), parseQ(old), isQAck(old), isQ(old)]).toEqual([old, null, null, false, false])
  }
})
