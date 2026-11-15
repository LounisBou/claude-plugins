import assert from 'node:assert/strict'
import { test } from 'node:test'
import { messageOf, reasonOf } from './host.ts'

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
