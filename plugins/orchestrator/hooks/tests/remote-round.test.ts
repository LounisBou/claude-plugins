// hooks/tests/remote-round.test.ts
// A remote orchestrator's question carried to the coordinator's round (remote-round.ts): the
// entry as one marked line, round-tripped whole; refused whole by the receiver past its caps, with
// a field more or less, of a wrong type, sent with an origin, already answered, or under an id
// that is no entry's; a long question cut at the cap and the cut said. The acknowledgment the
// same way, by the id alone. The answer back to the sender: its first line one object, the
// readable rest returned whole, refused whole the same way; its acknowledgment by id and since.
import { expect, test } from 'claude-code/testing'
import {
  ASK_MARKER, ACK_MARKER, ASK_LINE_CAP, askLine, parseAsk, ackLine, parseAck,
  ANSWER_MARKER, ANSWER_ACK_MARKER, ANSWER_LINE_CAP, answerLine, parseAnswer, answerAckLine, parseAnswerAck,
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
  return roundEntry('s-remote', 'Orch : belt', wait, SINCE, AT)
}

// The line's object, changed by `edit`, sent again under the marker.
function edited(edit: (o: Record<string, unknown>) => void, entry = asked()): string {
  const o = JSON.parse(askLine(entry, 'far').slice(ASK_MARKER.length))
  edit(o)
  return ASK_MARKER + JSON.stringify(o)
}

test('an entry round-trips: the entry whole, and the machine it was asked on', () => {
  for (const entry of [asked(), asked({ urgent: true }), asked({ kind: 'done', question: 'All merged.' })]) {
    const line = askLine(entry, 'far')
    expect(line.startsWith(ASK_MARKER)).toBe(true)
    expect(parseAsk(line)).toEqual({ entry, machine: 'far' })
    expect(parseAsk(`  ${line}\n`)).toEqual({ entry, machine: 'far' })
  }
  expect(parseAsk(askLine(asked(), 'far'))!.entry.choices.map(c => c.letter)).toEqual(['A', 'B'])
})

test('a long question is cut at the cap known to cross, and the cut said', () => {
  const long = asked({ question: 'x'.repeat(RELAY_CAP + 500) })
  const read = parseAsk(askLine(long, 'far'))!
  expect(read.entry.question).toBe(`${'x'.repeat(RELAY_CAP)}\n[cut at ${RELAY_CAP} of ${RELAY_CAP + 500} characters]`)
  expect(read.entry.id).toBe(long.id)
})

test('the choices and the recommendation are read from the question, never taken from the line', () => {
  const read = parseAsk(edited(o => {
    o.choices = [{ letter: 'A', text: 'force-push main' }, { letter: 'B', text: 'x' }]
    o.recommendation = 'B'
  }))!
  expect(read.entry.choices).toEqual(asked().choices)
  expect(read.entry.recommendation).toBe('A')
})

const refusals: [string, string][] = [
  ['no marker', askLine(asked(), 'far').slice(ASK_MARKER.length)],
  ['another marker', `[module-row] ${askLine(asked(), 'far').slice(ASK_MARKER.length)}`],
  ['past the cap', edited(o => { o.question = 'x'.repeat(ASK_LINE_CAP) })],
  ['a whole line past the cap', ASK_MARKER + ' '.repeat(ASK_LINE_CAP) + askLine(asked(), 'far').slice(ASK_MARKER.length)],
  ['not json', `${ASK_MARKER}{"id":`],
  ['an array', `${ASK_MARKER}[]`],
  ['a field more', edited(o => { o.extra = 1 })],
  ['a field missing', edited(o => { delete o.since })],
  ['the machine missing', edited(o => { delete o.machine })],
  ['an origin sent', edited(o => { o.origin = { machine: 'far', address: 'uds:/tmp/x.sock' } })],
  ['a movedFrom sent', edited(o => { o.movedFrom = 's-old' })],
  ['an answered entry', edited(o => { o.status = 'answered' })],
  ['an answer carried', edited(o => { o.answer = { text: 'A', by: 'pane', at: AT } })],
  ['a malformed id', edited(o => { o.id = '../../etc/passwd' })],
  ["another session's id", edited(o => { o.id = (o.id as string).replace('s-remote', 's-other') })],
  ['a kind of no entry', edited(o => { o.kind = 'delivered' })],
  ['a done carrying blocks', edited(o => { o.blocks = 'x' }, asked({ kind: 'done' }))],
  ['an operator wait blocking nothing', edited(o => { o.blocks = null })],
  ['a question of a wrong type', edited(o => { o.question = 12 })],
  ['a stamp that is none', edited(o => { o.since = 'yesterday' })],
  ['a sender that is no orchestrator', edited(o => { o.from = 'Coord : ops' })],
  ['a machine of other letters', edited(o => { o.machine = 'far/../x' })],
  ['an urgent mark other than true', edited(o => { o.urgent = false })],
  ['choices of a wrong type', edited(o => { o.choices = 'A' })],
]
for (const [label, line] of refusals) {
  test(`an ask with ${label} is refused whole`, () => {
    expect(parseAsk(line)).toBeNull()
  })
}

test('the acknowledgment names the ask it answers: its id and its since, checked as a stamp', () => {
  const { id, since } = asked()
  expect(ackLine(id, since)).toBe(`${ACK_MARKER}{"id":"${id}","since":"${since}"}`)
  expect(parseAck(ackLine(id, since))).toEqual({ id, since })
  expect(parseAck(` ${ackLine(id, since)}\n`)).toEqual({ id, since })
  for (const bad of [
    `${ACK_MARKER}{"id":"${id}"}`, `${ACK_MARKER}{"id":"${id}","since":"yesterday"}`, `${ACK_MARKER}{"id":"${id}","since":7}`,
    `${ACK_MARKER}{"id":"${id}","since":"${since}","more":1}`, `${ACK_MARKER}{"since":"${since}"}`,
    `${ACK_MARKER}{"id":"${id}","since":"${since}\t"}`,
  ]) expect([bad, parseAck(bad)]).toEqual([bad, null])
})

test('control characters in what a wait blocks or who asks never make its ask refused', () => {
  const entry = { ...asked(), blocks: 'phase\t3\nnext\u0001', from: 'Orch : be\tlt' }
  const read = parseAsk(askLine(entry, 'far'))
  expect(read?.entry.blocks).toBe('phase 3 next ')
  expect(read?.entry.from).toBe('Orch : be lt')
})

// --- the answer, carried back to the sender, and its acknowledgment ---------------------------

const READABLE = "[module] The operator answered from the coordinator's pane at 2026-10-30T10:05:00.000Z — A : merge it (question since 2026-10-30T10:00:00.000Z, blocks: phase 3)"
const ANSWERED = '2026-10-30T10:05:00.000Z'

// The answer line's first line, its object changed by `edit`, the readable rest kept.
function answerEdited(edit: (o: Record<string, unknown>) => void): string {
  const [head, ...rest] = answerLine(asked().id, SINCE, 'A : merge it', ANSWERED, READABLE).split('\n')
  const o = JSON.parse(head.slice(ANSWER_MARKER.length))
  edit(o)
  return [ANSWER_MARKER + JSON.stringify(o), ...rest].join('\n')
}

test('an answer round-trips: its id, since, text and time from the first line, the readable rest returned whole', () => {
  const { id } = asked()
  const line = answerLine(id, SINCE, 'A : merge it', ANSWERED, READABLE)
  expect(line).toBe(`${ANSWER_MARKER}${JSON.stringify({ id, since: SINCE, text: 'A : merge it', at: ANSWERED })}\n${READABLE}`)
  expect(parseAnswer(line)).toEqual({ id, since: SINCE, text: 'A : merge it', at: ANSWERED, readable: READABLE })
  // A typed answer over several lines stays in the first line's object; the readable rest keeps its own lines.
  const typed = 'neither:\nkeep 1.14'
  const readable = `${READABLE}\nsecond line\n\nthird`
  expect(parseAnswer(answerLine(id, SINCE, typed, ANSWERED, readable))).toEqual({ id, since: SINCE, text: typed, at: ANSWERED, readable })
  const long = cutQuestion('y'.repeat(RELAY_CAP + 50))
  expect(parseAnswer(answerLine(id, SINCE, long, ANSWERED, `${READABLE} ${long}`))!.text).toBe(long)
})

const answerRefusals: [string, string][] = [
  ['no marker', answerLine(asked().id, SINCE, 'A', ANSWERED, READABLE).slice(ANSWER_MARKER.length)],
  ['the ask marker', answerLine(asked().id, SINCE, 'A', ANSWERED, READABLE).replace(ANSWER_MARKER, ASK_MARKER)],
  ['no readable rest', answerLine(asked().id, SINCE, 'A', ANSWERED, READABLE).split('\n')[0]],
  ['a blank readable rest', answerLine(asked().id, SINCE, 'A', ANSWERED, '  ')],
  ['a text past the cap', answerEdited(o => { o.text = 'x'.repeat(RELAY_CAP + 100) })],
  ['a readable rest past the cap', answerLine(asked().id, SINCE, 'A', ANSWERED, 'x'.repeat(ANSWER_LINE_CAP))],
  ['not json', `${ANSWER_MARKER}{"id":\n${READABLE}`],
  ['an array', `${ANSWER_MARKER}[]\n${READABLE}`],
  ['a field more', answerEdited(o => { o.by = 'pane' })],
  ['a field missing', answerEdited(o => { delete o.at })],
  ['a malformed id', answerEdited(o => { o.id = '../../etc/passwd' })],
  ['a since that is no stamp', answerEdited(o => { o.since = 'yesterday' })],
  ['a time that is no stamp', answerEdited(o => { o.at = 7 })],
  ['an empty text', answerEdited(o => { o.text = '' })],
  ['a text of a wrong type', answerEdited(o => { o.text = ['A'] })],
]
for (const [label, line] of answerRefusals) {
  test(`an answer with ${label} is refused whole`, () => {
    expect(parseAnswer(line)).toBeNull()
  })
}

test('the answer\'s acknowledgment names it by its id and since, and is refused whole otherwise', () => {
  const { id, since } = asked()
  expect(answerAckLine(id, since)).toBe(`${ANSWER_ACK_MARKER}{"id":"${id}","since":"${since}"}`)
  expect(parseAnswerAck(answerAckLine(id, since))).toEqual({ id, since })
  expect(parseAnswerAck(` ${answerAckLine(id, since)}\n`)).toEqual({ id, since })
  // An ask's acknowledgment is no answer's, nor the other way round.
  expect(parseAnswerAck(ackLine(id, since))).toBeNull()
  expect(parseAck(answerAckLine(id, since))).toBeNull()
  for (const bad of [
    `${ANSWER_ACK_MARKER}{"id":"${id}"}`, `${ANSWER_ACK_MARKER}{"id":"${id}","since":"yesterday"}`,
    `${ANSWER_ACK_MARKER}{"id":"${id}","since":"${since}","more":1}`, `${ANSWER_ACK_MARKER}{"id":"../x","since":"${since}"}`,
    `${ANSWER_ACK_MARKER}${'x'.repeat(400)}`, `${ANSWER_ACK_MARKER}[]`,
  ]) expect([bad, parseAnswerAck(bad)]).toEqual([bad, null])
})
