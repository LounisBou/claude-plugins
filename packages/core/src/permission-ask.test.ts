import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { askOfDialog, stableJson, type AskKey } from './permission-ask.ts'

const ask = (id: string, tool: string, input: unknown, agent?: string): AskKey => ({ id, tool, input: stableJson(input), agent })

describe('permission asks', () => {
  it('two inputs equal as values give one text, whatever their keys\' order; an undefined field is no field', () => {
    assert.equal(stableJson({ b: 1, a: [{ d: 'x', c: null }] }), stableJson({ a: [{ c: null, d: 'x' }], b: 1 }))
    assert.equal(stableJson({ a: 1, b: undefined }), stableJson({ a: 1 }))
    assert.equal(stableJson('text'), '"text"')
    assert.equal(stableJson(undefined), 'null')
  })

  it('a dialog takes the only ask of its tool and loop with the same arguments', () => {
    const asks = [ask('w1', 'Write', { file_path: '/a', content: 'x' }), ask('w2', 'Write', { file_path: '/b', content: 'x' }), ask('w3', 'Write', { file_path: '/a', content: 'x' }, 'sub')]
    assert.equal(askOfDialog(asks, 'Write', { content: 'x', file_path: '/a' }, undefined)?.id, 'w1')
    assert.equal(askOfDialog(asks, 'Write', { file_path: '/a', content: 'x' }, 'sub')?.id, 'w3')
  })

  it('no ask with the same arguments, or several, leave the dialog unmatched: no guess on the tool alone', () => {
    const asks = [ask('w1', 'Write', { file_path: '/a', content: 'x' }), ask('b1', 'Bash', { command: 'ls' }), ask('b2', 'Bash', { command: 'ls' })]
    assert.equal(askOfDialog(asks, 'Write', { file_path: '/elsewhere', content: 'x' }, undefined), undefined)
    assert.equal(askOfDialog(asks, 'Bash', { command: 'ls' }, undefined), undefined)
    assert.equal(askOfDialog(asks, 'Read', { file_path: '/a' }, undefined), undefined)
  })

  it('a payload that carries its call id takes the ask of that id in its tool and loop, whatever the arguments', () => {
    const asks = [ask('b1', 'Bash', { command: 'ls' }), ask('b2', 'Bash', { command: 'ls' })]
    assert.equal(askOfDialog(asks, 'Bash', { command: 'other' }, undefined, 'b2')?.id, 'b2')
    assert.equal(askOfDialog(asks, 'Bash', { command: 'ls' }, 'sub', 'b2'), undefined)
    assert.equal(askOfDialog(asks, 'Bash', { command: 'ls' }, undefined, 'b9'), undefined)
  })
})
