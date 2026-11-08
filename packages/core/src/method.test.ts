import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { markRow, nextRow, parseState, reportStatus, twoDigits } from './method.ts'

const STATE = `**Codename**: demo
**Title**: A demo feature
**Branch**: feat/demo
**Bump**: minor
**Artifacts**: local
**Base**: abc1234

| phase | title | status | milestone |
|---|---|---|---|
| 01 | the skeleton | done | 82525e4 |
| 02 | the core | doing | 9f31a0c |
| 03 | the cycle | todo |  |
`

describe('the state file', () => {
  it('reads the header and the rows', () => {
    const state = parseState(STATE)
    assert.equal(state.codename, 'demo')
    assert.equal(state.base, 'abc1234')
    assert.deepEqual(state.rows.map(row => [row.phase, row.status, row.milestone]), [['01', 'done', '82525e4'], ['02', 'doing', '9f31a0c'], ['03', 'todo', '']])
    assert.equal(parseState('nothing here').codename, null)
  })

  it('names the first row not done, or none', () => {
    assert.equal(nextRow(parseState(STATE).rows)?.phase, '02')
    assert.equal(nextRow([{ phase: '01', title: 't', status: 'done', milestone: 'abc1' }]), null)
  })

  it('writes a number on two digits, and refuses what is not one', () => {
    assert.equal(twoDigits(3), '03')
    assert.equal(twoDigits('003'), '03')
    assert.equal(twoDigits('x'), null)
  })

  it('rewrites one row in place, a todo row without its milestone', () => {
    const done = markRow(STATE, 2, 'done', 'deadbee')
    assert.ok('text' in done)
    assert.match(done.text, /^\| 02 \| the core \| done \| deadbee \|$/m)
    assert.match(done.text, /^\| 01 \| the skeleton \| done \| 82525e4 \|$/m)
    const todo = markRow(STATE, '1', 'todo', 'abc1234')
    assert.ok('row' in todo)
    assert.equal(todo.row.milestone, '')
  })

  it('says what is wrong with a mark', () => {
    assert.deepEqual(markRow(STATE, 'x', 'done', 'abc1234'), { error: 'not a phase number: x' })
    assert.deepEqual(markRow(STATE, 2, 'finished', 'abc1234'), { error: 'status must be todo, doing or done, not finished' })
    assert.deepEqual(markRow(STATE, 2, 'done', 'HEAD'), { error: 'a done row needs a commit sha as its milestone, not "HEAD"' })
    assert.deepEqual(markRow(STATE, 9, 'done', 'abc1234'), { error: 'no row 09 in the state table' })
  })
})

describe('the report status', () => {
  it('reads the last non-empty line, with or without its reason', () => {
    assert.deepEqual(reportStatus('branch: feat/x\nstatus: done — all phases green\n\n'), { status: 'done', reason: 'all phases green' })
    assert.deepEqual(reportStatus('status: question'), { status: 'question', reason: '' })
    assert.deepEqual(reportStatus('status: blocked — gate red'), { status: 'blocked', reason: 'gate red' })
  })

  it('reads no status from another ending or another word', () => {
    assert.equal(reportStatus('status: done\nmore text'), null)
    assert.equal(reportStatus('status: DONE_WITH_CONCERNS'), null)
    assert.equal(reportStatus(''), null)
  })
})
