// hooks/tests/unanswered-question.test.ts
// The stop gate's rule on a question still on the operator (his ruling of 2026-11-03): an
// orchestrator's turn that ends while one of its operator questions is unanswered shows it again
// in full in its own chat. Which question is still on him is read off the
// round and the session's wait file; whether the turn shows it, off the final message.
import { expect, test } from 'claude-code/testing'
import { pendingQuestion, unansweredRefusal, type WaitRead } from '../unanswered-question.ts'
import { roundEntry, type RoundEntry } from '../round.ts'
import { fingerprint } from '../relay.ts'
import { TWO_QUESTIONS } from './fixtures.ts'

const SESSION = 'a1b2c3'
const SINCE = '2026-11-03T10:00:00.000Z'
const BLOCKS = 'the deploy order'
const QUESTION = [
  '**Question 1 of 2**',
  '_Subject_ : the deploy order',
  '_Context_ : two pull requests touch the same table.',
  '_Question_ : which one ships first?',
  '_Choices_ :',
  '- **A** : the schema first, the reads after',
  '- **B** : both at once',
  '_Recommendation_ : A — the reads need the column.',
].join('\n')
const WAIT_LINE = `waiting: operator — blocks: ${BLOCKS}`

const entry = (over: Partial<RoundEntry> = {}, question = QUESTION): RoundEntry => ({
  ...roundEntry(SESSION, 'Orch: belt [1]', { kind: 'operator', blocks: BLOCKS, question }, SINCE, SINCE),
  ...over,
})
const tabAnswer = { text: "answered in the sender's own tab", by: 'tab' as const, at: SINCE }
const relayedWait: WaitRead = { waiting: 'operator', blocks: BLOCKS, waiting_since: SINCE, relayed: fingerprint({ kind: 'operator', blocks: BLOCKS, question: '' }) }

// --- which question is still on him --------------------------------------------------------------

test('an open operator entry of the session is its pending question', () => {
  const pending = pendingQuestion(SESSION, [entry()], null)
  expect(pending?.entry?.id).toBe(entry().id)
  expect(pending?.blocks).toBe(BLOCKS)
})

test('an entry answered from the pane, closed by the coordinator, or another session\'s is no pending question', () => {
  expect(pendingQuestion(SESSION, [entry({ status: 'answered', answer: { text: 'A', by: 'pane', at: SINCE } })], null)).toBeNull()
  expect(pendingQuestion(SESSION, [entry({ status: 'closed', answer: { text: 'ruled', by: 'coordinator', at: SINCE } })], null)).toBeNull()
  expect(pendingQuestion('other', [entry()], null)).toBeNull()
  expect(pendingQuestion(SESSION, [entry({ kind: 'done', blocks: null })], null)).toBeNull()
})

test('an entry his prompt withdrew as answered in its own tab is settled, as is one withdrawn by the sender', () => {
  // His answer withdraws it as it arrives (withdrawOnTyped); the wait file keeps no fingerprint of it.
  const forgotten: WaitRead = { ...relayedWait, waiting: null, last_waiting: 'operator', relayed: null }
  expect(pendingQuestion(SESSION, [entry({ status: 'withdrawn', answer: tabAnswer })], forgotten)).toBeNull()
  const closed = entry({ status: 'closed', answer: { ...tabAnswer, text: `withdrawn: ${tabAnswer.text}` } })
  expect(pendingQuestion(SESSION, [closed], forgotten)).toBeNull()
  const sender = entry({ status: 'withdrawn', answer: { text: 'handed over to its successor', by: 'sender', at: SINCE } })
  expect(pendingQuestion(SESSION, [sender], null)).toBeNull()
})

test('the same wait asked again after his prompt is open again, and pending again', () => {
  const reopened = entry({ since: '2026-11-03T10:05:00.000Z' })
  expect(pendingQuestion(SESSION, [reopened], null)?.entry?.since).toBe('2026-11-03T10:05:00.000Z')
})

test('the earliest of several open questions is the pending one', () => {
  const later = entry({ id: 'later', since: '2026-11-03T11:00:00.000Z', blocks: 'later' })
  expect(pendingQuestion(SESSION, [later, entry()], null)?.entry?.id).toBe(entry().id)
})

test('an open wait that asks nothing in the decide shape is passed over', () => {
  expect(pendingQuestion(SESSION, [entry({}, 'a status report, still waiting on the answer')], null)).toBeNull()
})

test('with no entry in this round, the wait file\'s relayed operator wait is the pending question', () => {
  expect(pendingQuestion(SESSION, [], relayedWait)).toEqual({ entry: null, blocks: BLOCKS, since: SINCE })
  const sent: WaitRead = { waiting: 'operator', blocks: BLOCKS, waiting_since: SINCE, relayed: null, pending: 'an-id' }
  expect(pendingQuestion(SESSION, [], sent)).toEqual({ entry: null, blocks: BLOCKS, since: SINCE })
})

test('a wait file whose question the round answered, or that was never relayed, holds no pending question', () => {
  expect(pendingQuestion(SESSION, [entry({ status: 'answered', answer: { text: 'A', by: 'pane', at: SINCE } })], relayedWait)).toBeNull()
  expect(pendingQuestion(SESSION, [], { waiting: 'operator', blocks: BLOCKS, waiting_since: SINCE, relayed: null })).toBeNull()
  expect(pendingQuestion(SESSION, [], { waiting: null, blocks: null, waiting_since: null, relayed: null })).toBeNull()
})

// --- whether the turn shows it -------------------------------------------------------------------

test('a turn that does not show the pending question is refused, the refusal naming its question line', () => {
  const reason = unansweredRefusal('Agent belt-p3 delivered its pull request; review next.', pendingQuestion(SESSION, [entry()], null))
  expect(reason).not.toBeNull()
  expect(reason).toContain('still unanswered')
  expect(reason).toContain('**Question 1 of 2** — which one ships first?')
  expect(reason).toContain('own chat')
  expect(reason).toContain('IN FULL')
  expect(reason).toContain(WAIT_LINE)
  expect(reason).not.toContain('Recorded')
  expect(reason).toContain('2026-11-03')
})

test('a turn that shows the question again in full passes', () => {
  const pending = pendingQuestion(SESSION, [entry()], null)
  expect(unansweredRefusal(`${QUESTION}\n\nYou decide: A or B?\n${WAIT_LINE}`, pending)).toBeNull()
  // Its emphasis and spacing may differ, and its numbering's words: the numbers are what count.
  const reworded = QUESTION.replace('**Question 1 of 2**', '**Question 1 sur 2**').replace('which one ships first?', '**which one**  ships first?')
  expect(unansweredRefusal(`Agent report.\n\n${reworded}\n${WAIT_LINE}`, pending)).toBeNull()
})

test('a turn that shows the question cut short, or another question, is refused', () => {
  const pending = pendingQuestion(SESSION, [entry()], null)
  const noQuestion = QUESTION.split('\n').filter(line => !line.startsWith('_Question_')).join('\n')
  expect(unansweredRefusal(noQuestion, pending)).not.toBeNull()
  expect(unansweredRefusal(QUESTION.replace('which one ships first?', 'which one ships last?'), pending)).not.toBeNull()
  const noChoice = QUESTION.split('\n').filter(line => !line.startsWith('- **B**')).join('\n')
  expect(unansweredRefusal(noChoice, pending)).not.toBeNull()
  expect(unansweredRefusal(QUESTION.replace('both at once', 'both in turn'), pending)).not.toBeNull()
  expect(unansweredRefusal(QUESTION.replace('- **B** :', '- **C** :'), pending)).not.toBeNull()
  expect(unansweredRefusal(QUESTION.replace('Question 1 of 2', 'Question 2 of 2'), pending)).not.toBeNull()
  expect(unansweredRefusal('**Question 1 of 2**', pending)).not.toBeNull()
})

test('its other fields may be worded anew or left out: the number, the question and the choices are what count', () => {
  const pending = pendingQuestion(SESSION, [entry()], null)
  expect(unansweredRefusal(QUESTION.replace('two pull requests touch the same table.', 'both change the table.'), pending)).toBeNull()
  const noContext = QUESTION.split('\n').filter(line => !line.startsWith('_Context_')).join('\n')
  expect(unansweredRefusal(noContext, pending)).toBeNull()
  const noRecommendation = QUESTION.split('\n').filter(line => !line.startsWith('_Recommendation_')).join('\n')
  expect(unansweredRefusal(noRecommendation, pending)).toBeNull()
})

test('a question quoted in a code fence is not shown', () => {
  const pending = pendingQuestion(SESSION, [entry()], null)
  expect(unansweredRefusal(['```', QUESTION, '```'].join('\n'), pending)).not.toBeNull()
})

test('a « Recorded » line frees no question still open: only his answer settles it', () => {
  const pending = pendingQuestion(SESSION, [entry()], null)
  expect(unansweredRefusal('Recorded: A, the schema first.', pending)).not.toBeNull()
  expect(unansweredRefusal('**Recorded** : A.\n\nnext question…', pending)).not.toBeNull()
})

test('no pending question passes whatever the turn says', () => {
  expect(unansweredRefusal('anything', null)).toBeNull()
})

test('the question of an entry asking several is its first one the pane has not answered', () => {
  const several = entry({}, TWO_QUESTIONS)
  const pending = pendingQuestion(SESSION, [several], null)
  const first = TWO_QUESTIONS.split('\n\n')[0]
  const second = TWO_QUESTIONS.split('\n\n')[1]
  expect(unansweredRefusal(first, pending)).toBeNull()
  expect(unansweredRefusal(second, pending)).not.toBeNull()
  const half = pendingQuestion(SESSION, [{ ...several, partial: ['3 : A'] }], null)
  expect(unansweredRefusal(second, half)).toBeNull()
  expect(unansweredRefusal(first, half)).not.toBeNull()
  expect(unansweredRefusal('', half)).toContain('**Question 4 sur 4** — publie-t-on une release par module converti, ou une seule à la fin ?')
})

test('with only the wait file\'s knowledge, any numbered block in the decide shape passes, none is refused naming its blocks', () => {
  const pending = pendingQuestion(SESSION, [], relayedWait)
  expect(unansweredRefusal(`${QUESTION}\n${WAIT_LINE}`, pending)).toBeNull()
  const reason = unansweredRefusal('the report', pending)
  expect(reason).toContain(`« blocks: ${BLOCKS} »`)
})
