import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { answerOf, fieldsOf, messageOf } from './host.ts'

describe('what a hooks module reads of the host', () => {
  it('reads a record\'s fields, and nothing of what is no record', () => {
    assert.deepEqual(fieldsOf({ a: 1 }), { a: 1 })
    for (const value of [null, undefined, 'text', 3, [1]]) assert.equal(fieldsOf(value), undefined)
  })

  it('reads an error\'s message, and any other thrown value as text', () => {
    assert.equal(messageOf(new Error('disk full')), 'disk full')
    assert.equal(messageOf({ message: 'refused' }), 'refused')
    assert.equal(messageOf('plain'), 'plain')
    assert.equal(messageOf(undefined), 'undefined')
  })

  it('reads a tool\'s answer: its refusal, its error flag, its result and its text', () => {
    assert.deepEqual(answerOf({ result: ' 12\n' }), { deny: undefined, isError: false, result: ' 12\n', text: '12' })
    assert.deepEqual(answerOf({ text: 'said', isError: true }), { deny: undefined, isError: true, result: undefined, text: 'said' })
    assert.equal(answerOf({ deny: ' not allowed ' }).deny, 'not allowed')
    for (const deny of [undefined, null, false, '']) assert.equal(answerOf({ deny }).deny, undefined)
    assert.deepEqual(answerOf({ result: { status: 'completed' } }).result, { status: 'completed' })
    assert.deepEqual(answerOf('no record'), { deny: undefined, isError: false, result: undefined, text: '' })
  })
})
