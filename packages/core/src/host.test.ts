import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerOf, dialogOf, fieldsOf, listOf, messageOf, reasonOf } from './host.ts'

test('a rejection reads as its message, else as the value itself', () => {
  assert.equal(reasonOf(new Error('no such file')), 'no such file')
  assert.equal(reasonOf({ message: 'refused' }), 'refused')
  assert.equal(reasonOf('timed out'), 'timed out')
  assert.equal(reasonOf({ message: undefined }), '[object Object]')
  assert.equal(reasonOf(null), 'null')
})

test('a thrown value reads as its message, or as undefined when it carries none', () => {
  assert.equal(messageOf(new Error('no such file')), 'no such file')
  assert.equal(messageOf('timed out'), 'undefined')
  assert.equal(messageOf(null), 'undefined')
})

test('a record\'s fields are read, and nothing of what is no record', () => {
  assert.deepEqual(fieldsOf({ a: 1 }), { a: 1 })
  for (const value of [null, undefined, 'text', 3, [1]]) assert.equal(fieldsOf(value), undefined)
})

test('a tool\'s answer reads as its refusal, its error flag, its result and its text', () => {
  assert.deepEqual(answerOf({ result: ' 12\n' }), { deny: undefined, isError: false, result: ' 12\n', text: '12' })
  assert.deepEqual(answerOf({ text: 'said', isError: true }), { deny: undefined, isError: true, result: undefined, text: 'said' })
  assert.equal(answerOf({ deny: ' not allowed ' }).deny, 'not allowed')
  for (const deny of [undefined, null, false, '']) assert.equal(answerOf({ deny }).deny, undefined)
  assert.deepEqual(answerOf('no record'), { deny: undefined, isError: false, result: undefined, text: '' })
})

test('a list reads as its items, anything else as none', () => {
  assert.deepEqual(listOf(['a', 1]), ['a', 1])
  assert.deepEqual(listOf('a'), [])
  assert.deepEqual(listOf(undefined), [])
})

test('a dialog reads as its first question and that question\'s labels', () => {
  const questions = [{ question: 'Run it?', options: [{ label: 'Allow' }, { label: 'Deny' }] }, { question: 'second' }]
  assert.deepEqual(dialogOf({ questions }), { question: 'Run it?', labels: ['Allow', 'Deny'] })
  assert.deepEqual(dialogOf({ questions: 'none' }), { question: '', labels: [] })
  assert.deepEqual(dialogOf({ questions: [{ question: 'q', options: [{}, 'x'] }] }), { question: 'q', labels: ['', ''] })
})
