// hooks/tests/round.test.ts
// The coordinator's round as the module keeps it (round.ts): the lettered choices and the
// recommendation read out of a question in the decide shape, near misses read as none, the
// entry built from an orchestrator's wait, and the order the round takes its open entries in.
import { expect, test } from 'claude-code/testing'
import { parseChoices, questionBody, roundEntry, roundEntryId, roundPath, openEntries, isDue, DUE_AFTER_MS, type RoundEntry } from '../round.ts'
import { fingerprint, parseWait, relayText, RELAY_CAP, type Wait } from '../relay.ts'

const DECIDE = [
  'Question 1 of 1 — merge the scraper pull request now?',
  '_Context._ It is green and reviewed.',
  '- **A** : merge it now — one click, the release goes out today',
  '- **B** : wait for the next review — a day lost, one more pair of eyes',
  '- **C** : close it — the work is dropped',
  '_Recommendation_ : A — it is green and nothing waits on it',
  'You decide: A, B or C?',
].join('\n')

// --- the choices ----------------------------------------------------------------------------

test('a question in the decide shape gives its lettered choices and its recommendation', () => {
  expect(parseChoices(DECIDE)).toEqual({
    choices: [
      { letter: 'A', text: 'merge it now — one click, the release goes out today' },
      { letter: 'B', text: 'wait for the next review — a day lost, one more pair of eyes' },
      { letter: 'C', text: 'close it — the work is dropped' },
    ],
    recommendation: 'A',
  })
})

test('every separator the shape allows is read, and the recommendation by its shape', () => {
  const question = [
    '* **A**. first',
    '- **B**) second',
    '  - **C** — third',
    '- **D** – fourth',
    '- **E** - fifth  ',
    '_Recommendation_ : C',
  ].join('\n')
  expect(parseChoices(question)).toEqual({
    choices: [
      { letter: 'A', text: 'first' },
      { letter: 'B', text: 'second' },
      { letter: 'C', text: 'third' },
      { letter: 'D', text: 'fourth' },
      { letter: 'E', text: 'fifth' },
    ],
    recommendation: 'C',
  })
  expect(parseChoices('- **A**: one\n- **B**: two\n_Recommended._ B').recommendation).toBe('B')
  expect(parseChoices('- **A**: one\n- **B**: two\n_Recommendation_ : B. one more review').recommendation).toBe('B')
  expect(parseChoices('- **A**: one\n- **B**: two\n_Recommendation_: **A** — it ships today').recommendation).toBe('A')
})

test('a line of another shape names no recommendation', () => {
  const choices = '- **A** : one\n- **B** : two\n'
  expect(parseChoices(`${choices}_Context._ A new pane`).recommendation).toBeNull()
  expect(parseChoices(`${choices}Recommendation: B`).recommendation).toBeNull()
  expect(parseChoices(`${choices}_Context._ A new pane\n_Recommendation_ : B`).recommendation).toBe('B')
})

for (const [label, question] of [
  ['a lone choice', '- **A** : the only one\n_Recommendation_ : A'],
  ['letters out of order', '- **A** : one\n- **C** : two\n_Recommendation_ : A'],
  ['letters that do not start at A', '- **B** : one\n- **C** : two\n_Recommendation_ : B'],
  ['a letter twice', '- **A** : one\n- **A** : two\n_Recommendation_ : A'],
  ['six choices', '- **A** : 1\n- **B** : 2\n- **C** : 3\n- **D** : 4\n- **E** : 5\n- **F** : 6\n_Recommendation_ : A'],
  ['no lettered line at all', 'Merge it now?\n_Recommendation_ : A'],
] as const) {
  test(`${label}: no choices, so no recommendation`, () => {
    expect(parseChoices(question)).toEqual({ choices: [], recommendation: null })
  })
}

test('a recommendation naming an absent letter is none, and only the first recommendation line counts', () => {
  expect(parseChoices('- **A** : one\n- **B** : two\n_Recommendation_ : C')).toEqual({
    choices: [{ letter: 'A', text: 'one' }, { letter: 'B', text: 'two' }],
    recommendation: null,
  })
  expect(parseChoices('- **A** : one\n- **B** : two\n_Recommendation_ : D\n_Recommendation_ : B').recommendation).toBeNull()
  expect(parseChoices('- **A** : one\n- **B** : two').recommendation).toBeNull()
  // A lowercase word after the label is no choice letter.
  expect(parseChoices('- **A** : one\n- **B** : two\n_Recommendation_ : a cheap one').recommendation).toBeNull()
})

// --- the entry ------------------------------------------------------------------------------

const SINCE = '2026-10-18T18:45:57.000Z'
const AT = '2026-10-18T18:46:00.000Z'

test('an operator wait becomes an open entry: its sender, its question, its choices', () => {
  const wait: Wait = { kind: 'operator', blocks: 'phase 3', question: DECIDE }
  const entry = roundEntry('s-one', 'Orch : belt [a1b2c3]', wait, SINCE, AT)
  expect(entry).toEqual({
    id: `s-one-${fingerprint(wait)}`,
    from: 'Orch : belt [a1b2c3]',
    session: 's-one',
    kind: 'operator',
    since: SINCE,
    blocks: 'phase 3',
    question: DECIDE,
    choices: parseChoices(DECIDE).choices,
    recommendation: 'A',
    status: 'open',
    at: AT,
    answer: null,
  })
})

test('an urgent wait becomes an urgent entry, a plain one does not, and both land on the same id', () => {
  const urgent = roundEntry('s-one', 'Orch : belt', parseWait('Prod is down.\nwaiting: operator (urgent) — blocks: x')!, SINCE, AT)
  const plain = roundEntry('s-one', 'Orch : belt', parseWait('Prod is down.\nwaiting: operator — blocks: x')!, SINCE, AT)
  expect(urgent.urgent).toBe(true)
  expect(plain.urgent).toBeUndefined()
  expect(urgent.id).toBe(plain.id)
})

test('an open question is due when urgent, open 15 minutes or more, or with no pane to show it; nothing else is', () => {
  const now = Date.parse('2026-10-24T12:00:00.000Z')
  const at = (since: string, over: Partial<RoundEntry> = {}) => ({ ...roundEntry('s-one', 'Orch : belt', { kind: 'operator', blocks: 'x', question: 'q' }, since, AT), ...over })
  expect(isDue(at('2026-10-24T11:59:00.000Z', { urgent: true }), now, true)).toBe(true)
  expect(isDue(at('2026-10-24T11:45:00.000Z'), now, true)).toBe(true)
  expect(isDue(at('2026-10-24T11:45:01.000Z'), now, true)).toBe(false)
  expect(isDue(at('2026-10-24T11:59:00.000Z'), now, false)).toBe(true)
  expect(isDue(at('not a time'), now, true)).toBe(true)
  expect(isDue(at('2026-10-24T09:00:00.000Z', { status: 'answered', urgent: true }), now, false)).toBe(false)
  expect(isDue(at('2026-10-24T09:00:00.000Z', { kind: 'done', blocks: null }), now, false)).toBe(false)
  expect(DUE_AFTER_MS).toBe(15 * 60 * 1000)
})

test('done is an entry with nothing blocked', () => {
  const entry = roundEntry('s-one', 'Orch : belt', { kind: 'done', question: 'Everything merged.' }, SINCE, AT)
  expect(entry.kind).toBe('done')
  expect(entry.blocks).toBeNull()
  expect(entry.question).toBe('Everything merged.')
  expect(entry.choices).toEqual([])
  expect(entry.recommendation).toBeNull()
  expect(entry.status).toBe('open')
})

test('the id is sanitised as the store sanitises its keys', () => {
  const wait: Wait = { kind: 'operator', blocks: 'phase 3', question: '' }
  expect(roundEntry('a/b c:d', 'Orch : belt', wait, SINCE, AT).id).toBe(`a_b_c_d-${fingerprint(wait)}`)
  expect(roundEntry('a/b c:d', 'Orch : belt', wait, SINCE, AT).session).toBe('a/b c:d')
})

test('the entry keeps the whole question; the message a remote coordinator receives is still cut, the cut said', () => {
  const long = 'x'.repeat(RELAY_CAP + 10)
  const wait: Wait = { kind: 'operator', blocks: 'phase 3', question: long }
  const entry = roundEntry('s-one', 'Orch : belt', wait, SINCE, AT)
  expect(entry.question).toBe(long)
  expect(relayText('Orch : belt', wait, SINCE).endsWith(`\n\n${'x'.repeat(RELAY_CAP)}\n[cut at ${RELAY_CAP} of ${RELAY_CAP + 10} characters]`)).toBe(true)
})

test('a 2,500-character question is kept whole in its entry', () => {
  const question = `Question 1 of 1 — ${'the whole context, word for word. '.repeat(73)}`.slice(0, 2500)
  expect(question.length).toBe(2500)
  expect(roundEntry('s-one', 'Orch : belt', { kind: 'operator', blocks: 'phase 3', question }, SINCE, AT).question).toBe(question)
})

test('the question as the pane shows it leaves out the choice lines and the recommendation it draws below', () => {
  const entry = roundEntry('s-one', 'Orch : belt', { kind: 'operator', blocks: 'phase 3', question: DECIDE }, SINCE, AT)
  expect(questionBody(entry)).toBe([
    'Question 1 of 1 — merge the scraper pull request now?',
    '_Context._ It is green and reviewed.',
    'You decide: A, B or C?',
  ].join('\n'))
  // No lettered choices read: the text is shown as it is, its lines that look like choices included.
  expect(questionBody({ question: 'Merge it?\n- **A** : alone\n', choices: [] })).toBe('Merge it?\n- **A** : alone')
})

test('the id of a wait\'s entry is the one its entry carries', () => {
  const wait: Wait = { kind: 'operator', blocks: 'phase 3', question: DECIDE }
  expect(roundEntryId('a/b', wait)).toBe(roundEntry('a/b', 'Orch : belt', wait, SINCE, AT).id)
})

test('the choices of a question cut past the cap are still read', () => {
  const question = `${'x'.repeat(RELAY_CAP)}\n- **A** : one\n- **B** : two\n_Recommendation_ : B`
  const entry = roundEntry('s-one', 'Orch : belt', { kind: 'operator', blocks: 'phase 3', question }, SINCE, AT)
  expect(entry.choices.map(c => c.letter)).toEqual(['A', 'B'])
  expect(entry.recommendation).toBe('B')
})

test('an agent\'s wait is no round entry', () => {
  expect(() => roundEntry('s-one', 'Agent : belt', { kind: 'question', blocks: 'x', question: 'y' }, SINCE, AT)).toThrow()
})

test('the entry file sits in the round directory of the state directory', () => {
  expect(roundPath('/state', 's-one-12-ab')).toBe('/state/round/s-one-12-ab.json')
})

// --- the order ------------------------------------------------------------------------------

function entry(from: string, since: string, status: RoundEntry['status'] = 'open', kind: RoundEntry['kind'] = 'operator'): RoundEntry {
  return {
    id: `${from}-${since}`, from, session: from, kind, since, blocks: kind === 'operator' ? 'x' : null, question: 'q',
    choices: [], recommendation: null, status, at: since, answer: null,
  }
}

test('the open entries come grouped by sender, the groups by their earliest wait, each in its own order', () => {
  const entries = [
    entry('Orch : b', '2026-10-18T10:05:00.000Z'),
    entry('Orch : a', '2026-10-18T10:03:00.000Z'),
    entry('Orch : b', '2026-10-18T10:01:00.000Z'),
    entry('Orch : c', '2026-10-18T10:00:00.000Z', 'closed'),
    entry('Orch : a', '2026-10-18T10:02:00.000Z', 'withdrawn'),
    entry('Orch : a', '2026-10-18T10:04:00.000Z', 'answered'),
    entry('Orch : c', '2026-10-18T10:06:00.000Z', 'open', 'done'),
  ]
  expect(openEntries(entries).map(e => `${e.from} ${e.since.slice(11, 16)}`)).toEqual([
    'Orch : b 10:01',
    'Orch : b 10:05',
    'Orch : a 10:03',
    'Orch : c 10:06',
  ])
  expect(openEntries([])).toEqual([])
})
