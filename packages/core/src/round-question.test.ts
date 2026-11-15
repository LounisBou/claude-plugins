import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseRoundQuestion } from './round-question.ts'

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
