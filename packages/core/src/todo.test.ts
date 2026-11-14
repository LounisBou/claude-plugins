import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  addTodo, closeTodo, deferTodo, deferredTodos, holderOf, openTodos, parseTodoItem, pendingTodos, todoItems, todoFile, todoLabel, todoName, todoPath, TODO_VERSION,
} from './todo.ts'

const NOW = new Date('2026-11-14T15:00:00Z')
const SAID = '2026-11-14T14:58:00Z'

const added = (text: string | undefined, words: string, change: Record<string, unknown> = {}) =>
  addTodo(text ?? '', { words, said_at: SAID, from: 'Coord: general', ...change }, NOW)

describe('the to-do list of a session', () => {
  it('belongs to the holder\'s name, without its reference and in the current shape', () => {
    assert.equal(holderOf('Orch: Claude plugins [08eb0d]'), 'Orch: Claude plugins')
    assert.equal(holderOf('Orch : Claude plugins'), 'Orch: Claude plugins')
    assert.equal(holderOf('Orch:Claude plugins [abc]'), 'Orch: Claude plugins')
    assert.equal(holderOf('  Coord: general  '), 'Coord: general')
    assert.equal(todoPath('/state', 'Orch: Claude plugins [08eb0d]'), '/state/todo/Orch: Claude plugins.jsonl')
    assert.equal(todoPath('/state', 'Audit: a/b..c'), '/state/todo/Audit: a_b..c.jsonl')
    assert.equal(todoPath('/state', 'Orch: x [1]'), todoPath('/state', 'Orch: x [2]'))
    assert.equal(todoFile('Orch: x [1]'), 'Orch: x.jsonl')
  })

  it('adds an item with his words as given, dated, numbered after the last, open', () => {
    const first = added(undefined, 'merge it once ready')
    assert.deepEqual(first.item, {
      v: TODO_VERSION, id: 1, opened: '2026-11-14T15:00:00Z', label: 'merge it once ready', state: 'open', verdict: '',
      words: 'merge it once ready', said_at: SAID, from: 'Coord: general',
    })
    const second = added(first.text, 'and the other one', { label: 'the other' })
    assert.equal(second.item.id, 2)
    assert.equal(second.item.label, 'the other')
    assert.deepEqual(todoItems(second.text).map(item => item.id), [1, 2])
    assert.ok(second.text.endsWith('\n'))
  })

  it('numbers after the highest id, a closed item\'s included', () => {
    const one = added(undefined, 'a')
    const closed = closeTodo(one.text, 1, 'claude-plugins#1', NOW)
    assert.ok('item' in closed)
    assert.equal(added('item' in closed ? closed.text : '', 'b').item.id, 2)
  })

  it('labels an item with its first words when none is given, flattened and cut', () => {
    assert.equal(todoLabel('two\nlines   here'), 'two lines here')
    assert.equal(todoLabel('x'.repeat(200)).length, 80)
    assert.equal(added(undefined, 'a\n  b').item.label, 'a b')
  })

  it('closes an item with its outcome, once, and refuses what it does not hold', () => {
    const { text } = added(undefined, 'do it')
    const closed = closeTodo(text, 1, 'row 170', NOW)
    assert.ok('item' in closed)
    if (!('item' in closed)) return
    assert.equal(closed.item.state, 'closed')
    assert.equal(closed.item.verdict, 'row 170')
    assert.equal(closed.item.closed, '2026-11-14T15:00:00Z')
    assert.deepEqual(openTodos(todoItems(closed.text)), [])
    assert.deepEqual(closeTodo(closed.text, 1, 'again', NOW), { error: 'to-do 1 is already closed' })
    assert.deepEqual(closeTodo(text, 7, 'x', NOW), { error: 'no to-do 7 in this list' })
  })

  it('defers an item with his ruling: still open, no longer pending', () => {
    const { text } = added(undefined, 'later')
    const put = deferTodo(text, 1, 'after the release, 2026-11-14')
    assert.ok('item' in put)
    if (!('item' in put)) return
    const items = todoItems(put.text)
    assert.deepEqual(openTodos(items).map(item => item.id), [1])
    assert.deepEqual(deferredTodos(items).map(item => item.id), [1])
    assert.deepEqual(pendingTodos(items), [])
    assert.deepEqual(pendingTodos(todoItems(text)).map(item => item.id), [1])
    assert.deepEqual(deferTodo(put.text, 2, 'x'), { error: 'no to-do 2 in this list' })
    const closed = closeTodo(put.text, 1, 'done', NOW)
    assert.ok('item' in closed)
    if ('item' in closed) assert.deepEqual(deferredTodos(todoItems(closed.text)), [])
  })

  it('reads only what is an item: a torn line, a foreign shape or another version is none', () => {
    const good = added(undefined, 'keep').item
    const text = [JSON.stringify(good), '{"id":2,"state":"open"', 'not json', JSON.stringify({ ...good, id: 3, v: 2 }),
      JSON.stringify({ ...good, id: 4, words: '' }), JSON.stringify({ ...good, id: 5, state: 'weird' }), JSON.stringify({ ...good, id: 0 }), JSON.stringify({ ...good, id: 6, from: 3 }), ''].join('\n')
    assert.deepEqual(todoItems(text).map(item => item.id), [1])
    for (const raw of [null, [], 'x', 3]) assert.equal(parseTodoItem(raw), undefined)
  })

  it('names an item by its id and label, as the refusals list it', () => {
    const { item } = added(undefined, 'rewrite the wait')
    assert.equal(todoName(item), '1 (rewrite the wait)')
  })
})
