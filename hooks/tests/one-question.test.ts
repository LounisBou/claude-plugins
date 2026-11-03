// hooks/tests/one-question.test.ts
// The question rules of the stop gate. One question per turn: a final message with two numbered
// question blocks or more is refused, the refusal names the rule; one block or none passes. And an
// operator wait asks a question: a turn ending on one with no block is refused. The blocks are the
// ones round.ts's questionParts recognises, in whatever language it accepts, outside code fences.
import { expect, test } from 'claude-code/testing'
import { oneQuestionRefusal, operatorWaitRefusal } from '../one-question.ts'
import { TWO_QUESTIONS } from './fixtures.ts'

const BLOCK = (head: string) => [head, '_Subject_ : a thing', '- **A** : yes', '- **B** : no', '_Recommendation_ : A. Safer.'].join('\n')

test('a message with two question blocks is refused, the refusal naming the rule', () => {
  const reason = oneQuestionRefusal([BLOCK('**Question 1 of 2**'), '', BLOCK('**Question 2 of 2**')].join('\n'))
  expect(reason).not.toBeNull()
  expect(reason).toContain('One question per turn')
  expect(reason).toContain('wait for his answer')
  expect(reason).toContain('i of N')
})

test('a message with one question block passes', () => {
  expect(oneQuestionRefusal(BLOCK('**Question 2 of 4**'))).toBeNull()
})

test('a message with no question block passes', () => {
  expect(oneQuestionRefusal('the report\n\nwaiting: operator — blocks: the report')).toBeNull()
  expect(oneQuestionRefusal('')).toBeNull()
})

test('two blocks in two languages are refused', () => {
  expect(oneQuestionRefusal([BLOCK('**Question 1 of 2**'), BLOCK('**Question 2 sur 2**')].join('\n\n'))).not.toBeNull()
  expect(oneQuestionRefusal(TWO_QUESTIONS)).not.toBeNull()
})

test('a bold line that is no numbering is no block', () => {
  expect(oneQuestionRefusal(['**Version 1.2**', '**Version 1.3**'].join('\n'))).toBeNull()
})

// --- an operator wait that asks no question ------------------------------------------------------

test('an operator wait with no question block is refused, the refusal naming the shape and the lines that fit', () => {
  const reason = operatorWaitRefusal('the report\n\nwaiting: operator — blocks: ligne 359, ligne 343')
  expect(reason).not.toBeNull()
  expect(reason).toContain('**Question i of N**')
  expect(reason).toContain('orchestrator:decide')
  expect(reason).toContain('waiting: tool')
  expect(reason).toContain('waiting: deferred')
  expect(reason).toContain('waiting: done')
})

test('the urgent form of an operator wait with no question block is refused', () => {
  expect(operatorWaitRefusal('the report\n\nwaiting: operator (urgent) — blocks: the deploy')).not.toBeNull()
})

test('an operator wait with one question block passes', () => {
  expect(operatorWaitRefusal(`${BLOCK('**Question 2 of 4**')}\nwaiting: operator — blocks: the answer`)).toBeNull()
  expect(operatorWaitRefusal(`${BLOCK('**Question 1 sur 1**')}\nwaiting: operator (urgent) — blocks: the answer`)).toBeNull()
})

test('a wait on a tool, a deferral, done, or no machine line passes with no question block', () => {
  expect(operatorWaitRefusal('the report\n\nwaiting: tool — ci-watch 12')).toBeNull()
  expect(operatorWaitRefusal('the report\n\nwaiting: deferred — row 3')).toBeNull()
  expect(operatorWaitRefusal('the report\n\nwaiting: done')).toBeNull()
  expect(operatorWaitRefusal('the report, no machine line')).toBeNull()
  expect(operatorWaitRefusal('')).toBeNull()
})

// --- a quoted example is no block ----------------------------------------------------------------

const FENCE = (fence: string, ...lines: string[]) => [fence, ...lines, fence].join('\n')

test('question blocks quoted in a fenced code block do not count toward the several-blocks refusal', () => {
  const example = (fence: string) => [BLOCK('**Question 1 of 2**'), '', FENCE(fence, BLOCK('**Question 2 of 2**'))].join('\n')
  expect(oneQuestionRefusal(example('```'))).toBeNull()
  expect(oneQuestionRefusal(example('~~~'))).toBeNull()
  expect(oneQuestionRefusal(example('```markdown'))).toBeNull()
})

test('two blocks outside a fence are still refused beside a fenced example', () => {
  const message = [FENCE('```', BLOCK('**Question 1 of 3**')), BLOCK('**Question 2 of 3**'), BLOCK('**Question 3 of 3**')].join('\n\n')
  expect(oneQuestionRefusal(message)).not.toBeNull()
})

test('a block quoted in a fenced code block does not satisfy an operator wait', () => {
  const wait = 'waiting: operator — blocks: the answer'
  expect(operatorWaitRefusal(`the format:\n\n${FENCE('```', BLOCK('**Question 1 of 1**'))}\n\n${wait}`)).not.toBeNull()
  expect(operatorWaitRefusal(`the format:\n\n${FENCE('~~~', BLOCK('**Question 1 of 1**'))}\n\n${wait}`)).not.toBeNull()
  expect(operatorWaitRefusal(`${FENCE('```', BLOCK('**Question 1 of 1**'))}\n\n${BLOCK('**Question 1 of 1**')}\n${wait}`)).toBeNull()
})

test('a fence closes only on its own marker, at least as long as the opening one', () => {
  const wait = 'waiting: operator — blocks: the answer'
  const open = ['````', BLOCK('**Question 1 of 1**'), '```', '````', wait].join('\n')
  expect(operatorWaitRefusal(open)).not.toBeNull()
  const mixed = ['```', '~~~', BLOCK('**Question 1 of 1**'), '```', wait].join('\n')
  expect(operatorWaitRefusal(mixed)).not.toBeNull()
})

test('the refusal says what a block is: the numbering line followed by its labelled fields, a heading alone being refused', () => {
  const reason = operatorWaitRefusal('the report\n\nwaiting: operator — blocks: the answer')
  expect(reason).toContain('`**Question i of N**` line followed by its labelled fields')
  for (const field of ['_Subject_ :', '_Context_ :', '_Question_ :', '_Choices_ :', '_Recommendation_ :']) expect(reason).toContain(field)
  expect(reason).toContain('a heading alone is refused')
})
