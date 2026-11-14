// hooks/tests/round.test.ts
// The coordinator's round as the module keeps it (round.ts): the entry built from an
// orchestrator's wait, and the order the round takes its open entries in. The question's own
// parsing (choices, recommendation, numbering, fields) is core's, tested in method.test.ts.
import { expect, test } from 'claude-code/testing'
import { operatorAnswer, recordedAnswer, recordedText, textSpans, plainText, prReferences, prPieces, repositoryOwners, numberLabel, roundEntry, roundEntryId, roundPath, openEntries, isDue, asksNothing, type RoundEntry } from '../round.ts'
import { TWO_QUESTIONS, GLUED_BLOCKS, SHAPED } from './fixtures.ts'
import { entryQuestions, parseChoices } from '../../core/method.ts'
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

// --- the entry ------------------------------------------------------------------------------

const SINCE = '2026-10-18T18:45:57.000Z'
const AT = '2026-10-18T18:46:00.000Z'

test('an operator wait becomes an open entry: its sender, its question, its choices', () => {
  const wait: Wait = { kind: 'operator', blocks: 'phase 3', question: DECIDE }
  const entry = roundEntry('s-one', 'Orch: belt [a1b2c3]', wait, SINCE, AT)
  expect(entry).toEqual({
    id: `s-one-${fingerprint(wait)}`,
    from: 'Orch: belt [a1b2c3]',
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
  const urgent = roundEntry('s-one', 'Orch: belt', parseWait('Prod is down.\nwaiting: operator (urgent) — blocks: x')!, SINCE, AT)
  const plain = roundEntry('s-one', 'Orch: belt', parseWait('Prod is down.\nwaiting: operator — blocks: x')!, SINCE, AT)
  expect(urgent.urgent).toBe(true)
  expect(plain.urgent).toBeUndefined()
  expect(urgent.id).toBe(plain.id)
})

test('with the pane open only an urgent question is due, however old; with no pane every open question is; nothing else is', () => {
  const now = Date.parse('2026-10-24T12:00:00.000Z')
  const at = (since: string, over: Partial<RoundEntry> = {}) => ({ ...roundEntry('s-one', 'Orch: belt', { kind: 'operator', blocks: 'x', question: 'q' }, since, AT), ...over })
  expect(isDue(at('2026-10-24T11:59:00.000Z', { urgent: true }), now, true)).toBe(true)
  expect(isDue(at('2026-10-24T09:00:00.000Z'), now, true)).toBe(false)
  expect(isDue(at('2026-10-24T11:45:00.000Z'), now, true)).toBe(false)
  expect(isDue(at('not a time'), now, true)).toBe(false)
  expect(isDue(at('2026-10-24T11:59:00.000Z'), now, false)).toBe(true)
  expect(isDue(at('2026-10-24T09:00:00.000Z', { status: 'answered', urgent: true }), now, false)).toBe(false)
  expect(isDue(at('2026-10-24T09:00:00.000Z', { kind: 'done', blocks: null }), now, false)).toBe(false)
})

test('done is an entry with nothing blocked', () => {
  const entry = roundEntry('s-one', 'Orch: belt', { kind: 'done', question: 'Everything merged.' }, SINCE, AT)
  expect(entry.kind).toBe('done')
  expect(entry.blocks).toBeNull()
  expect(entry.question).toBe('Everything merged.')
  expect(entry.choices).toEqual([])
  expect(entry.recommendation).toBeNull()
  expect(entry.status).toBe('open')
})

test('the id is sanitised as the store sanitises its keys', () => {
  const wait: Wait = { kind: 'operator', blocks: 'phase 3', question: '' }
  expect(roundEntry('a/b c:d', 'Orch: belt', wait, SINCE, AT).id).toBe(`a_b_c_d-${fingerprint(wait)}`)
  expect(roundEntry('a/b c:d', 'Orch: belt', wait, SINCE, AT).session).toBe('a/b c:d')
})

test('the entry keeps the whole question; the message a remote coordinator receives is still cut, the cut said', () => {
  const long = 'x'.repeat(RELAY_CAP + 10)
  const wait: Wait = { kind: 'operator', blocks: 'phase 3', question: long }
  const entry = roundEntry('s-one', 'Orch: belt', wait, SINCE, AT)
  expect(entry.question).toBe(long)
  expect(relayText('Orch: belt', wait, SINCE).endsWith(`\n\n${'x'.repeat(RELAY_CAP)}\n[cut at ${RELAY_CAP} of ${RELAY_CAP + 10} characters]`)).toBe(true)
})

test('a 2,500-character question is kept whole in its entry', () => {
  const question = `Question 1 of 1 — ${'the whole context, word for word. '.repeat(73)}`.slice(0, 2500)
  expect(question.length).toBe(2500)
  expect(roundEntry('s-one', 'Orch: belt', { kind: 'operator', blocks: 'phase 3', question }, SINCE, AT).question).toBe(question)
})

test('the id of a wait\'s entry is the one its entry carries', () => {
  const wait: Wait = { kind: 'operator', blocks: 'phase 3', question: DECIDE }
  expect(roundEntryId('a/b', wait)).toBe(roundEntry('a/b', 'Orch: belt', wait, SINCE, AT).id)
})

test('the choices of a question cut past the cap are still read', () => {
  const question = `${'x'.repeat(RELAY_CAP)}\n- **A** : one\n- **B** : two\n_Recommendation_ : B`
  const entry = roundEntry('s-one', 'Orch: belt', { kind: 'operator', blocks: 'phase 3', question }, SINCE, AT)
  expect(entry.choices.map(c => c.letter)).toEqual(['A', 'B'])
  expect(entry.recommendation).toBe('B')
})

test('an agent\'s wait is no round entry', () => {
  expect(() => roundEntry('s-one', 'Agent: belt', { kind: 'question', blocks: 'x', question: 'y' }, SINCE, AT)).toThrow()
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
    entry('Orch: b', '2026-10-18T10:05:00.000Z'),
    entry('Orch: a', '2026-10-18T10:03:00.000Z'),
    entry('Orch: b', '2026-10-18T10:01:00.000Z'),
    entry('Orch: c', '2026-10-18T10:00:00.000Z', 'closed'),
    entry('Orch: a', '2026-10-18T10:02:00.000Z', 'withdrawn'),
    entry('Orch: a', '2026-10-18T10:04:00.000Z', 'answered'),
    entry('Orch: c', '2026-10-18T10:06:00.000Z', 'open', 'done'),
  ]
  expect(openEntries(entries).map(e => `${e.from} ${e.since.slice(11, 16)}`)).toEqual([
    'Orch: b 10:01',
    'Orch: b 10:05',
    'Orch: a 10:03',
    'Orch: c 10:06',
  ])
  expect(openEntries([])).toEqual([])
})

// The operator's ruling of 2026-10-31 (6.2): urgent first, then grouped by orchestrator within each
// level, oldest first.
test('an urgent question of a later sender comes first, and within each level its sender\'s questions stay together', () => {
  const urgent = (e: RoundEntry): RoundEntry => ({ ...e, urgent: true })
  const entries = [
    entry('Orch: a', '2026-10-18T10:00:00.000Z'),
    urgent(entry('Orch: b', '2026-10-18T10:01:00.000Z')),
    entry('Orch: b', '2026-10-18T10:02:00.000Z'),
    urgent(entry('Orch: a', '2026-10-18T10:03:00.000Z')),
    entry('Orch: b', '2026-10-18T10:06:00.000Z'),
    entry('Orch: a', '2026-10-18T10:07:00.000Z'),
    urgent(entry('Orch: a', '2026-10-18T10:04:00.000Z', 'answered')),
  ]
  expect(openEntries(entries).map(e => `${e.from} ${e.since.slice(11, 16)}${e.urgent ? ' urgent' : ''}`)).toEqual([
    'Orch: b 10:01 urgent',
    'Orch: a 10:03 urgent',
    'Orch: a 10:00',
    'Orch: a 10:07',
    'Orch: b 10:02',
    'Orch: b 10:06',
  ])
})

// --- several questions in one entry ------------------------------------------------------------

test('the entry of two questions records the first one\'s choices, so the round reads it as a question with choices', () => {
  const wait: Wait = { kind: 'operator', blocks: 'the version', question: TWO_QUESTIONS }
  const entry = roundEntry('s-1', 'Orch: s', wait, '2026-10-25T11:52:50.299Z', '2026-10-25T11:52:50.302Z')
  expect(entry.question).toBe(TWO_QUESTIONS)
  expect(entry.choices.map(c => c.letter)).toEqual(['A', 'B'])
  expect(entry.choices[0].text.startsWith('1.15.0, puis des 1.x.')).toBe(true)
  expect(entry.recommendation).toBe('A')
})

test('an entry of several questions asks nothing only when none of them carries a choice or a labelled field', () => {
  // Its first question a bare line, its second the decide shape: the entry asks something.
  const mixed = '**Question 1 of 2**\nShall I go on?\n\n**Question 2 of 2**\n_Question_ : which?\n- **A** : this\n- **B** : that'
  expect(entryQuestions({ question: mixed, choices: [], recommendation: null })[0].choices).toEqual([])
  expect(asksNothing({ question: mixed, choices: [], recommendation: null })).toBe(false)
  const bare = '**Question 1 of 2**\nShall I go on?\n\n**Question 2 of 2**\nAnd tag it?'
  expect(asksNothing({ question: bare, choices: [], recommendation: null })).toBe(true)
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

test('the sender\'s numbering drawn as its two numbers', () => {
  expect(numberLabel('Question 3 sur 4')).toBe('Question 3 / 4')
  expect(numberLabel('Question 5 of 6')).toBe('Question 5 / 6')
  expect(numberLabel('3/4')).toBe('3 / 4')
})

// --- the record: his answer, read before he is asked again ------------------------------------

const asked = (session: string, from: string, question = SHAPED, blocks = 'pane numbering') =>
  roundEntry(session, from, { kind: 'operator', blocks, question }, '2026-11-14T08:00:00.000Z', '2026-11-14T08:00:00.000Z')
const answered = (entry: RoundEntry, answer: RoundEntry['answer'], status: RoundEntry['status'] = 'answered'): RoundEntry => ({ ...entry, id: `${entry.id}-done`, status, answer })

test('his own answer an entry holds: the pane\'s, the coordinator\'s settle, a choice typed in the tab; nothing else', () => {
  const entry = asked('s-pred', 'Orch: belt')
  const at = '2026-11-14T08:05:00.000Z'
  expect(operatorAnswer(answered(entry, { text: 'B : celle du pane — elle compte la file', by: 'pane', at }))).toEqual({ letter: 'B', text: 'celle du pane — elle compte la file', by: 'pane', at })
  expect(operatorAnswer(answered(entry, { text: 'answered from the pane: A : x', by: 'pane', at }, 'closed'))!.letter).toBe('A')
  expect(operatorAnswer(answered(entry, { text: 'A', by: 'coordinator', at }, 'closed'))).toEqual({ letter: 'A', text: 'celle de l\'orchestrateur — elle suit sa vague', by: 'coordinator', at })
  expect(operatorAnswer(answered(entry, { text: 'keep both for a week', by: 'coordinator', at }, 'closed'))).toEqual({ letter: null, text: 'keep both for a week', by: 'coordinator', at })
  expect(operatorAnswer(answered(entry, { text: 'withdrawn: tab', by: 'tab', at, typed: 'b' }, 'withdrawn'))!.letter).toBe('B')
  for (const answer of [
    { text: 'withdrawn: settled meanwhile — merged', by: 'coordinator' as const, at, evidence: 'merged' },
    { text: 'withdrawn: tab', by: 'tab' as const, at, typed: 'go on with the next phase' },
    { text: 'superseded by x', by: 'sender' as const, at },
    { text: 'answered by a message from Coord: c', by: 'message' as const, at, author: 'Coord: c' },
  ]) expect(operatorAnswer(answered(entry, answer, 'withdrawn'))).toBeNull()
})

test('a successor asking the same question block of the same project, for the same blocks, finds his answer, the newest', () => {
  const pred = asked('s-pred', 'Orch: belt')
  const older = answered(pred, { text: 'A : celle de l\'orchestrateur — elle suit sa vague', by: 'pane', at: '2026-11-14T08:05:00.000Z' })
  const newer = { ...answered(pred, { text: 'B', by: 'coordinator', at: '2026-11-14T09:00:00.000Z' }, 'closed'), id: 'newer' }
  // Another preamble and another numbering: the same question block.
  const again = asked('s-succ', 'Orch : belt', SHAPED.replace('Décision notée : B, la vague continue.', 'Relève faite.').replace('Question 5 sur 6', 'Question 1 sur 2'))
  expect(recordedAnswer([older, newer, again], again)).toEqual({ entry: newer, answer: { letter: 'B', text: 'celle du pane — elle compte la file', by: 'coordinator', at: '2026-11-14T09:00:00.000Z' } })
  expect(recordedText(again, recordedAnswer([older], again)!)).toBe(
    `[module] Answered from the record, not asked again: the operator answered this question on 2026-11-14T08:05:00.000Z by pane — A : celle de l'orchestrateur — elle suit sa vague (entry ${older.id}; question since ${again.since}, blocks: pane numbering)`)
})

test('another project, other blocks, another context, another consent, no shape or no answer of his: no record', () => {
  const record = answered(asked('s-pred', 'Orch: belt'), { text: 'A', by: 'pane', at: 'T' })
  const misses = [
    asked('s-succ', 'Orch: other'),
    asked('s-succ', 'Orch: belt', SHAPED, 'pane numbering, row 7'),
    asked('s-succ', 'Orch: belt', SHAPED.replace('Deux numéros', 'Trois numéros')),
    { ...asked('s-succ', 'Orch: belt'), consent: { kind: 'auto-merge' as const, repo: 'acme/thing' } },
    asked('s-succ', 'Orch: belt', 'Merge it?\n- **A** : yes\n- **B** : no'),
  ]
  for (const entry of misses) expect(recordedAnswer([record, entry], entry)).toBeNull()
  // An auto-deploy answered for one environment never answers it for another.
  const deploy = (env: 'staging' | 'prod') => ({ ...asked('s-succ', 'Orch: belt'), consent: { kind: 'auto-deploy' as const, repo: 'acme/thing', env } })
  const staging = answered(deploy('staging'), { text: 'A', by: 'pane', at: 'T' })
  expect(recordedAnswer([staging, deploy('prod')], deploy('prod'))).toBeNull()
  expect(recordedAnswer([staging, deploy('staging')], deploy('staging'))?.entry).toBe(staging)
  const none = answered(asked('s-pred', 'Orch: belt'), { text: 'superseded', by: 'sender', at: 'T' }, 'withdrawn')
  const again = asked('s-succ', 'Orch: belt')
  expect(recordedAnswer([none, again], again)).toBeNull()
})
