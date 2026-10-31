// hooks/tests/remote-round.test.ts
// A remote orchestrator's question carried to the coordinator's round (remote-round.ts): the
// entry as one marked line, round-tripped whole; refused whole by the receiver past its caps, with
// a field more or less, of a wrong type, sent with an origin, already answered, or under an id
// that is no entry's; a long question cut at the cap and the cut said. The acknowledgment the
// same way, by the id alone.
import { expect, test } from 'claude-code/testing'
import { ASK_MARKER, ACK_MARKER, ASK_LINE_CAP, askLine, parseAsk, ackLine, parseAck } from '../remote-round.ts'
import { roundEntry, type RoundEntry } from '../round.ts'
import { RELAY_CAP } from '../relay.ts'

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
