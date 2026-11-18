import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { answersChoice, givenAnswer, parseRoundQuestion } from './round-question.ts'
import { kindFor, producersOf } from './pr-record.ts'

const CHOICES = [{ letter: 'A', text: 'Ship it now' }, { letter: 'B', text: 'Wait for the review' }]
const ASKED = {
  v: 2, id: 's1-20261115-ab12', sender: { session: 's1', name: 'Orch: demo [ab12cd]', role: 'orchestrator', machine: 'here' },
  subject: 'the release', context: 'words', ask: 'Ship?', choices: CHOICES, recommended: 'B', why: 'words', blocks: 'the release',
  status: 'open', at: '2026-11-15T10:00:00.000Z', answer: null, seq: 1,
}
const RELAYED = {
  id: 's2-f00d', from: 'Orch: other', session: 's2', kind: 'operator', since: '2026-11-15T09:00:00.000Z', blocks: 'x', question: 'words',
  choices: CHOICES, recommendation: 'A', status: 'open', at: '2026-11-15T09:00:01.000Z', answer: null,
}

describe('a round question', () => {
  it('reads an object the ask tool stored: its asker, its choices by count, the recommended letter', () => {
    assert.deepEqual(parseRoundQuestion(ASKED), {
      id: 's1-20261115-ab12', session: 's1', asker: 'Orch: demo [ab12cd]', kind: 'operator', at: '2026-11-15T10:00:00.000Z', status: 'open',
      options: 2, recommended: 'B', urgent: false, answer: null,
    })
  })

  it('reads an entry the relay wrote, asked at its wait\'s start', () => {
    const read = parseRoundQuestion({ ...RELAYED, urgent: true })
    assert.deepEqual([read?.session, read?.asker, read?.at, read?.recommended, read?.urgent], ['s2', 'Orch: other', '2026-11-15T09:00:00.000Z', 'A', true])
    assert.equal(parseRoundQuestion({ ...RELAYED, kind: 'done', choices: [], recommendation: null })?.kind, 'done')
  })

  it('names the letter an answer chose, by its letter or by its choice\'s text, and none for other words', () => {
    const answered = (answer: object) => parseRoundQuestion({ ...ASKED, status: 'answered', answer: { by: 'pane', at: '2026-11-15T10:05:00.000Z', settler: 'Coord: c', ...answer } })?.answer
    assert.deepEqual(answered({ text: 'A' }), { at: '2026-11-15T10:05:00.000Z', by: 'pane', withdrawn: false, letter: 'A' })
    assert.equal(answered({ text: 'wait for the review' })?.letter, 'B')
    assert.equal(answered({ text: 'do something else entirely' })?.letter, null)
    // The words typed in the asker's tab are kept beside the reason: they name the choice.
    assert.equal(answered({ text: "answered in the sender's own tab", typed: 'b', by: 'tab' })?.letter, 'B')
  })

  it('gives a withdrawn question no letter, whatever its reason says', () => {
    const read = parseRoundQuestion({ ...ASKED, status: 'withdrawn', answer: { text: 'A', by: 'sender', at: '2026-11-15T10:05:00.000Z' } })
    assert.deepEqual(read?.answer, { at: '2026-11-15T10:05:00.000Z', by: 'sender', withdrawn: true, letter: null })
    // A relayed entry is closed by an answer, by the coordinator's withdrawal on evidence, or by its asker's.
    const closed = (answer: object) => parseRoundQuestion({ ...RELAYED, status: 'closed', answer: { at: '2026-11-15T10:05:00.000Z', ...answer } })?.answer
    assert.deepEqual([closed({ text: 'B', by: 'coordinator' })?.withdrawn, closed({ text: 'B', by: 'coordinator' })?.letter], [false, 'B'])
    assert.deepEqual([closed({ text: 'withdrawn: settled meanwhile — A', by: 'coordinator', evidence: 'A' })?.withdrawn, closed({ text: 'A', by: 'sender' })?.withdrawn], [true, true])
  })

  it('reads nothing from another version, a missing asker, an unknown status or a settled entry without its answer', () => {
    assert.equal(parseRoundQuestion({ ...ASKED, v: 3 }), undefined)
    assert.equal(parseRoundQuestion({ ...ASKED, sender: { name: 'x' } }), undefined)
    assert.equal(parseRoundQuestion({ ...ASKED, status: 'lost' }), undefined)
    assert.equal(parseRoundQuestion({ ...ASKED, at: 'yesterday' }), undefined)
    assert.equal(parseRoundQuestion({ ...ASKED, status: 'answered', answer: null }), undefined)
    assert.equal(parseRoundQuestion({ ...ASKED, status: 'answered', answer: { text: 'A', by: 'someone', at: '2026-11-15T10:05:00.000Z' } }), undefined)
    assert.equal(parseRoundQuestion({ ...RELAYED, kind: 'tool' }), undefined)
    assert.equal(parseRoundQuestion('text'), undefined)
    assert.equal(parseRoundQuestion([ASKED]), undefined)
  })

  it('counts only lettered choices', () => {
    assert.equal(parseRoundQuestion({ ...ASKED, choices: [...CHOICES, { letter: 'Z', text: 'x' }, 'C', { letter: 'C' }] })?.options, 3)
    assert.equal(parseRoundQuestion({ ...ASKED, choices: 'none', recommended: 'x' })?.recommended, null)
  })
})

describe('an answer given', () => {
  it('gives an answer as the choice its letter names, letter and text, or as his own words', () => {
    const choices = [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }]
    assert.deepEqual(givenAnswer('A : Accorder', choices), { letter: 'A', text: 'Accorder' })
    assert.deepEqual(givenAnswer('b — refuse it', choices), { letter: 'B', text: 'Refuser' })
    assert.deepEqual(givenAnswer('B', choices), { letter: 'B', text: 'Refuser' })
    assert.deepEqual(givenAnswer('  I would wait a day  ', choices), { letter: null, text: 'I would wait a day' })
    assert.deepEqual(givenAnswer('C', choices), { letter: null, text: 'C' })
  })

  it('takes a choice pressed as its text then its letter in parentheses', () => {
    const choices = [{ letter: 'A', text: 'Accorder' }, { letter: 'B', text: 'Refuser' }]
    assert.equal(answersChoice('Accorder (A)', choices)?.letter, 'A')
    assert.equal(answersChoice(' accorder  (a) ', choices)?.letter, 'A')
    assert.equal(answersChoice('Accorder (B)', choices), undefined)
  })
})

describe('words typed in the sender\'s own tab', () => {
  const choices = [{ letter: 'A', text: 'waive it, docs only' }, { letter: 'B', text: 'run the E2E' }]
  const [waive, run] = choices

  it('answers a choice by its letter alone, its letter set apart from nothing or its exact text, or its exact text alone', () => {
    for (const typed of ['A', ' a ', 'a)', 'A.', 'a) waive it, docs only', 'A — waive it,  docs only', 'A—waive it, docs only', 'a - WAIVE IT, docs only', 'waive it, docs only', '  WAIVE it,\n docs only ']) {
      assert.deepEqual(answersChoice(typed, choices), waive, typed)
    }
    for (const typed of ['b', 'B : run the e2e', 'RUN THE E2E']) assert.deepEqual(answersChoice(typed, choices), run, typed)
    for (const typed of ['waive it, docs only (A)', 'Waive it, docs only (a)', 'waive it, docs only  ( A )']) assert.deepEqual(answersChoice(typed, choices), waive, typed)
  })

  it('is no answer when it is anything else', () => {
    for (const typed of [
      '', 'C', 'C)', 'yes', 'go on with phase 2',
      'do not waive it, docs only', 'I say WAIVE IT, docs only, thanks', 'ok: waive it, docs only',
      'B waive it, docs only', 'B : waive it, docs only', 'A run the E2E', 'A - but not yet', 'A, but check the diff first', 'A go', 'a) yes',
      'waive it, docs only (B)', 'run the E2E (A)', 'yes (A)', '(A)',
    ]) assert.equal(answersChoice(typed, choices), undefined, typed)
    assert.equal(answersChoice('anything', []), undefined)
  })

  it('is no answer when a short choice text sits inside an unrelated prompt', () => {
    const short = [{ letter: 'A', text: 'yes' }, { letter: 'B', text: 'no' }]
    assert.deepEqual(answersChoice('Yes', short), short[0])
    for (const typed of ['yes, and then rebase the branch on main', 'no idea, go on', 'B yes']) assert.equal(answersChoice(typed, short), undefined, typed)
  })

})

describe('record producers', () => {
  it('gives each kind its declared producer, and any other caller the open kind', () => {
    assert.equal(kindFor('pr-review'), 'review')
    assert.equal(kindFor('norms'), 'norms')
    assert.equal(kindFor('engine'), 'e2e')
    assert.equal(kindFor('orchestrator'), 'review')
    assert.deepEqual(producersOf('review').map(p => p.plugin), ['pr-review', 'orchestrator'])
    assert.deepEqual(producersOf('e2e'), [])
  })
})
