// hooks/tests/round.test.ts
// The coordinator's round as the module keeps it (round.ts): the lettered choices and the
// recommendation read out of a question in the decide shape, near misses read as none, the
// entry built from an orchestrator's wait, and the order the round takes its open entries in.
import { expect, test } from 'claude-code/testing'
import { parseChoices, questionBody, questionShape, questionParts, entryQuestions, textSpans, plainText, prReferences, prPieces, repositoryOwners, numberLabel, roundEntry, roundEntryId, roundPath, openEntries, isDue, type RoundEntry } from '../round.ts'
import { TWO_QUESTIONS, GLUED_BLOCKS, SHAPED, SHAPED_SUBJECT, SHAPED_CONTEXT, SHAPED_RECOMMENDATION, FIRST_B, SECOND_RECOMMENDATION_START } from './fixtures.ts'
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

test('with the pane open only an urgent question is due, however old; with no pane every open question is; nothing else is', () => {
  const now = Date.parse('2026-10-24T12:00:00.000Z')
  const at = (since: string, over: Partial<RoundEntry> = {}) => ({ ...roundEntry('s-one', 'Orch : belt', { kind: 'operator', blocks: 'x', question: 'q' }, since, AT), ...over })
  expect(isDue(at('2026-10-24T11:59:00.000Z', { urgent: true }), now, true)).toBe(true)
  expect(isDue(at('2026-10-24T09:00:00.000Z'), now, true)).toBe(false)
  expect(isDue(at('2026-10-24T11:45:00.000Z'), now, true)).toBe(false)
  expect(isDue(at('not a time'), now, true)).toBe(false)
  expect(isDue(at('2026-10-24T11:59:00.000Z'), now, false)).toBe(true)
  expect(isDue(at('2026-10-24T09:00:00.000Z', { status: 'answered', urgent: true }), now, false)).toBe(false)
  expect(isDue(at('2026-10-24T09:00:00.000Z', { kind: 'done', blocks: null }), now, false)).toBe(false)
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


test('a question in the decide shape gives its number, its fields as labelled and its recommendation, nothing else', () => {
  const { choices, recommendation } = parseChoices(SHAPED)
  expect(choices.map(c => c.letter)).toEqual(['A', 'B'])
  expect(recommendation).toBe('A')
  expect(questionShape(SHAPED, choices)).toEqual({
    number: 'Question 5 sur 6',
    fields: [
      { label: 'Sujet', separator: ' : ', text: SHAPED_SUBJECT },
      { label: 'Contexte', separator: ' : ', text: SHAPED_CONTEXT },
      { label: 'Question', separator: ' : ', text: 'laquelle garder ?' },
      { label: 'Propositions', separator: ' : ', text: '' },
    ],
    recommendation: { label: 'Recommandation de l\'orchestrateur', separator: ' : ', text: SHAPED_RECOMMENDATION },
  })
})

test('the fields are read by their shape in any language, the separator as written', () => {
  const english = '**Question 2 of 3**\n_Subject_: the merge\n_Question_: merge it?\n- **A** : yes\n- **B** : no\n_Recommendation_: B'
  const shape = questionShape(english, parseChoices(english).choices)!
  expect(shape.number).toBe('Question 2 of 3')
  expect(shape.fields.map(f => `${f.label}${f.separator}${f.text}`)).toEqual(['Subject: the merge', 'Question: merge it?'])
  expect(shape.recommendation).toEqual({ label: 'Recommendation', separator: ': ', text: 'B' })
})

test('without a bold numbering line the shape has no number, and a bold line without two numbers is none', () => {
  const plain = '_Sujet_ : x\n_Question_ : y ?'
  expect(questionShape(plain, [])!.number).toBeNull()
  expect(questionShape(`**Important**\n${plain}`, [])!.number).toBeNull()
  expect(questionShape(plain, [])!.fields.map(f => f.label)).toEqual(['Sujet', 'Question'])
})

test('a field after the choices that names no choice letter is no recommendation, and nothing after the recommendation is read', () => {
  const question = '_Question_ : y ?\n- **A** : one\n- **B** : two\n_Note_ : a cheap one\n_Recommandation_ : B\n_Autre_ : A'
  const shape = questionShape(question, parseChoices(question).choices)!
  expect(shape.fields.map(f => f.label)).toEqual(['Question'])
  expect(shape.recommendation).toEqual({ label: 'Recommandation', separator: ' : ', text: 'B' })
})

test('a question in today\'s shape has no labelled field before its choices: it is no shaped question', () => {
  expect(questionShape(DECIDE, parseChoices(DECIDE).choices)).toBeNull()
  expect(questionShape('Merge it?', [])).toBeNull()
  expect(questionShape('Question 1 of 1 — **merge** it?\n_Context._ The review is green.', [])).toBeNull()
})

test('a recommendation label of several words is read by parseChoices too, and dropped from the old body', () => {
  const question = 'Merge it?\n- **A** : one\n- **B** : two\n_Recommandation de l\'orchestrateur_ : B — the reason'
  const read = parseChoices(question)
  expect(read.recommendation).toBe('B')
  expect(questionBody({ question, choices: read.choices })).toBe('Merge it?')
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

// --- several questions in one entry ------------------------------------------------------------

test('an entry holding two numbered questions is split at each numbering line, the first keeping what precedes it', () => {
  const parts = questionParts(`Recorded: B.\n\n${TWO_QUESTIONS}`)
  expect(parts.length).toBe(2)
  expect(parts[0].startsWith('Recorded: B.')).toBe(true)
  expect(parts[0]).toContain('**Question 3 sur 4**')
  expect(parts[0]).not.toContain('Question 4 sur 4')
  expect(parts[1].startsWith('**Question 4 sur 4**')).toBe(true)
  // One numbering line, or none: one question, the text whole.
  expect(questionParts('**Question 5 of 6**\n_Question_ : which?')).toEqual(['**Question 5 of 6**\n_Question_ : which?'])
  expect(questionParts('Merge it?')).toEqual(['Merge it?'])
})

test('the real entry of two questions gives each its own choices, recommendation and number', () => {
  const asked = { question: TWO_QUESTIONS, choices: [], recommendation: null }
  const parts = entryQuestions(asked)
  expect(parts.map(part => [part.number, part.choices.map(c => c.letter), part.recommendation])).toEqual([
    ['Question 3 sur 4', ['A', 'B'], 'A'],
    ['Question 4 sur 4', ['A', 'B'], 'A'],
  ])
  expect(parts[0].choices[1].text).toBe(FIRST_B)
  expect(parts[1].choices[0].text.startsWith('une release par module converti.')).toBe(true)
  const shape = questionShape(parts[1].question, parts[1].choices)!
  expect(shape.fields.map(f => f.label)).toEqual(['Sujet', 'Contexte', 'Question', 'Choix'])
  expect(shape.fields[0].text).toBe('rythme de publication de la v2')
  expect(shape.recommendation!.text.startsWith(SECOND_RECOMMENDATION_START)).toBe(true)
})

test('the entry of two questions records the first one\'s choices, so the round reads it as a question with choices', () => {
  const wait: Wait = { kind: 'operator', blocks: 'the version', question: TWO_QUESTIONS }
  const entry = roundEntry('s-1', 'Orch : s', wait, '2026-10-25T11:52:50.299Z', '2026-10-25T11:52:50.302Z')
  expect(entry.question).toBe(TWO_QUESTIONS)
  expect(entry.choices.map(c => c.letter)).toEqual(['A', 'B'])
  expect(entry.choices[0].text.startsWith('1.15.0, puis des 1.x.')).toBe(true)
  expect(entry.recommendation).toBe('A')
})

test('an entry of one question keeps the choices it recorded', () => {
  const choices = [{ letter: 'A', text: 'one' }, { letter: 'B', text: 'two' }]
  expect(entryQuestions({ question: 'Merge it?', choices, recommendation: 'B' })).toEqual([
    { question: 'Merge it?', number: null, choices, recommendation: 'B' },
  ])
})

// --- the text's own marks --------------------------------------------------------------------

test('the spans keep inline code and bold as marks, their markers dropped, and join to the plain text', () => {
  const text = 'the **review** is green, see `pr-219` and snake_case_name, *really*'
  expect(textSpans(text)).toEqual([
    { text: 'the ' },
    { text: 'review', bold: true },
    { text: ' is green, see ' },
    { text: 'pr-219', code: true },
    { text: ' and snake_case_name, ' },
    { text: 'really', italic: true },
  ])
  expect(textSpans(text).map(span => span.text).join('')).toBe(plainText(text))
  expect(textSpans('')).toEqual([])
})

test('the references to a pull request are found one each, glued by a slash, a comma or nothing', () => {
  expect(prReferences('merge of infra#195/infra#196, geo-git-flow#21,geo-git-flow#22 and api#7api#8')).toEqual([
    { at: 9, text: 'infra#195', repo: 'infra', number: 195 },
    { at: 19, text: 'infra#196', repo: 'infra', number: 196 },
    { at: 30, text: 'geo-git-flow#21', repo: 'geo-git-flow', number: 21 },
    { at: 46, text: 'geo-git-flow#22', repo: 'geo-git-flow', number: 22 },
    { at: 66, text: 'api#7', repo: 'api', number: 7 },
    { at: 71, text: 'api#8', repo: 'api', number: 8 },
  ])
  expect(prReferences('issue #12 and a#b')).toEqual([])
})

test('the owners of the repositories the module knows, by the repository\'s name', () => {
  const owners = repositoryOwners(['LounisBou/infra', null, 'geonative/geo-git-flow#21', 'not a repository', 'LounisBou/infra#7'])
  expect([...owners]).toEqual([['infra', 'LounisBou'], ['geo-git-flow', 'geonative']])
})

test('a repository name two owners hold has no owner: no guess', () => {
  const owners = repositoryOwners(['LounisBou/infra', 'other/infra', 'third/infra#2', 'geonative/api'])
  expect([...owners]).toEqual([['api', 'geonative']])
  expect(prPieces('see infra#5 and api#7', owners)).toEqual([
    'see infra#5 and ',
    { href: 'https://github.com/geonative/api/pull/7', text: 'api#7' },
  ])
})

test('an owner written in the text is the owner of the link, whatever the known one', () => {
  const owners = new Map([['infra', 'LounisBou']])
  expect(prPieces('merge other/infra#5, then infra#6', owners)).toEqual([
    'merge ',
    { href: 'https://github.com/other/infra/pull/5', text: 'other/infra#5' },
    ', then ',
    { href: 'https://github.com/LounisBou/infra/pull/6', text: 'infra#6' },
  ])
  expect(prPieces('merge other/infra#5', new Map())).toEqual([
    'merge ',
    { href: 'https://github.com/other/infra/pull/5', text: 'other/infra#5' },
  ])
  expect(prReferences('other/infra#5')).toEqual([{ at: 0, text: 'other/infra#5', repo: 'infra', number: 5, owner: 'other' }])
})

test('a reference stuck to the word or the sign before it is still linked', () => {
  const owners = new Map([['infra', 'acme']])
  expect(prPieces('done at the end.infra#195 and (-infra#196', owners)).toEqual([
    'done at the end.',
    { href: 'https://github.com/acme/infra/pull/195', text: 'infra#195' },
    ' and (-',
    { href: 'https://github.com/acme/infra/pull/196', text: 'infra#196' },
  ])
  expect(prReferences('.infra#1 -infra#2')).toEqual([
    { at: 1, text: 'infra#1', repo: 'infra', number: 1 },
    { at: 10, text: 'infra#2', repo: 'infra', number: 2 },
  ])
})

test('a glued pair of references whose owner is known: each its own link, the slash between them plain', () => {
  const owners = new Map([['infra', 'acme'], ['geo-git-flow', 'acme']])
  expect(prPieces(GLUED_BLOCKS, owners)).toEqual([
    'merge of ',
    { href: 'https://github.com/acme/infra/pull/195', text: 'infra#195' },
    '/',
    { href: 'https://github.com/acme/infra/pull/196', text: 'infra#196' },
    ' (staging lot content), E2E waiver for ',
    { href: 'https://github.com/acme/geo-git-flow/pull/21', text: 'geo-git-flow#21' },
    '/',
    { href: 'https://github.com/acme/geo-git-flow/pull/22', text: 'geo-git-flow#22' },
  ])
})

test('a reference whose owner is unknown stays plain text', () => {
  expect(prPieces('see infra#195 and api#7', new Map([['api', 'acme']]))).toEqual([
    'see infra#195 and ',
    { href: 'https://github.com/acme/api/pull/7', text: 'api#7' },
  ])
  expect(prPieces('no reference here', new Map())).toEqual(['no reference here'])
  expect(prPieces('', new Map())).toEqual([''])
})

test('two bold version lines are no numbering: the text is not split at them', () => {
  const text = '**Version 1.2**\n_Subject_ : a\n**Version 1.3**\n_Subject_ : b'
  expect(questionParts(text)).toEqual([text])
  expect(questionShape(text, [])!.number).toBeNull()
  expect(questionParts('**Question 3/4**\n_Subject_ : a\n**Question 4/4**\n_Subject_ : b').length).toBe(2)
  expect(questionParts('**3 sur 4**\n_Subject_ : a\n**4 sur 4**\n_Subject_ : b').length).toBe(1)
})

test('a woken entry of several questions reads each question\'s choices from its text, whatever it recorded', () => {
  const stale = [{ letter: 'A', text: 'stale one' }, { letter: 'B', text: 'stale two' }]
  const parts = entryQuestions({ question: TWO_QUESTIONS, choices: stale, recommendation: 'B' })
  expect(parts.map(part => [part.choices.map(c => c.text.slice(0, 6)), part.recommendation])).toEqual([
    [['1.15.0', '2.0.0,'], 'A'],
    [['une re', 'une se'], 'A'],
  ])
})

test('the sender\'s numbering drawn as its two numbers', () => {
  expect(numberLabel('Question 3 sur 4')).toBe('Question 3 / 4')
  expect(numberLabel('Question 5 of 6')).toBe('Question 5 / 6')
  expect(numberLabel('3/4')).toBe('3 / 4')
})
