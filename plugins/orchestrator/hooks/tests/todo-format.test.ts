// hooks/tests/todo-format.test.ts
// The to-do list's format (todo-format.ts): the grammar of a line, the numbering, the closing and the deferring.
import { expect, test } from 'claude-code/testing'
import {
  addTodo, closeTodo, deferTodo, deferredTodos, holderOf, openTodos, parseTodoItem, pendingTodos, todoItems, todoFile, todoLabel, todoName, todoPath, TODO_VERSION,
} from '../todo-format.ts'

const NOW = new Date('2026-11-14T15:00:00Z')
const SAID = '2026-11-14T14:58:00Z'

const added = (text: string | undefined, words: string, change: Record<string, unknown> = {}) =>
  addTodo(text ?? '', { words, said_at: SAID, from: 'Coord: general', ...change }, NOW)

test('belongs to the holder\'s name, without its reference and in the current shape', () => {
  expect(holderOf('Orch: Billing app [a1b2c3]')).toBe('Orch: Billing app')
  expect(holderOf('Orch : Billing app')).toBe('Orch: Billing app')
  expect(holderOf('Orch:Billing app [abc]')).toBe('Orch: Billing app')
  expect(holderOf('  Coord: general  ')).toBe('Coord: general')
  expect(todoPath('/state', 'Orch: Billing app [a1b2c3]')).toBe('/state/todo/Orch: Billing app.jsonl')
  expect(todoPath('/state', 'Audit: a/b..c')).toBe('/state/todo/Audit: a_b..c.jsonl')
  expect(todoPath('/state', 'Orch: x [1]')).toBe(todoPath('/state', 'Orch: x [2]'))
  expect(todoFile('Orch: x [1]')).toBe('Orch: x.jsonl')
})

test('adds an item with his words as given, dated, numbered after the last, open', () => {
  const first = added(undefined, 'merge it once ready')
  expect(first.item).toEqual({
    v: TODO_VERSION, id: 1, opened: '2026-11-14T15:00:00Z', label: 'merge it once ready', state: 'open', verdict: '',
    words: 'merge it once ready', said_at: SAID, from: 'Coord: general',
  })
  const second = added(first.text, 'and the other one', { label: 'the other' })
  expect(second.item.id).toBe(2)
  expect(second.item.label).toBe('the other')
  expect(todoItems(second.text).map(item => item.id)).toEqual([1, 2])
  expect(second.text.endsWith('\n')).toBe(true)
})

test('numbers after the highest id, a closed item\'s included', () => {
  const one = added(undefined, 'a')
  const closed = closeTodo(one.text, 1, 'acme/app#1', NOW)
  expect('item' in closed).toBe(true)
  expect(added('item' in closed ? closed.text : '', 'b').item.id).toBe(2)
})

test('labels an item with its first words when none is given, flattened and cut', () => {
  expect(todoLabel('two\nlines   here')).toBe('two lines here')
  expect(todoLabel('x'.repeat(200)).length).toBe(80)
  expect(added(undefined, 'a\n  b').item.label).toBe('a b')
})

test('closes an item with its outcome, once, and refuses what it does not hold', () => {
  const { text } = added(undefined, 'do it')
  const closed = closeTodo(text, 1, 'row 170', NOW)
  expect('item' in closed).toBe(true)
  if (!('item' in closed)) return
  expect(closed.item.state).toBe('closed')
  expect(closed.item.verdict).toBe('row 170')
  expect(closed.item.closed).toBe('2026-11-14T15:00:00Z')
  expect(openTodos(todoItems(closed.text))).toEqual([])
  expect(closeTodo(closed.text, 1, 'again', NOW)).toEqual({ error: 'to-do 1 is already closed' })
  expect(closeTodo(text, 7, 'x', NOW)).toEqual({ error: 'no to-do 7 in this list' })
})

test('defers an item with his ruling: still open, no longer pending', () => {
  const { text } = added(undefined, 'later')
  const put = deferTodo(text, 1, 'after the release, 2026-11-14')
  expect('item' in put).toBe(true)
  if (!('item' in put)) return
  const items = todoItems(put.text)
  expect(openTodos(items).map(item => item.id)).toEqual([1])
  expect(deferredTodos(items).map(item => item.id)).toEqual([1])
  expect(pendingTodos(items)).toEqual([])
  expect(pendingTodos(todoItems(text)).map(item => item.id)).toEqual([1])
  expect(deferTodo(put.text, 2, 'x')).toEqual({ error: 'no to-do 2 in this list' })
  const closed = closeTodo(put.text, 1, 'done', NOW)
  expect('item' in closed).toBe(true)
  if ('item' in closed) expect(deferredTodos(todoItems(closed.text))).toEqual([])
})

test('reads only what is an item: a torn line, a foreign shape or another version is none', () => {
  const good = added(undefined, 'keep').item
  const text = [JSON.stringify(good), '{"id":2,"state":"open"', 'not json', JSON.stringify({ ...good, id: 3, v: 2 }),
    JSON.stringify({ ...good, id: 4, words: '' }), JSON.stringify({ ...good, id: 5, state: 'weird' }), JSON.stringify({ ...good, id: 0 }), JSON.stringify({ ...good, id: 6, from: 3 }), ''].join('\n')
  expect(todoItems(text).map(item => item.id)).toEqual([1])
  for (const raw of [null, [], 'x', 3]) expect(parseTodoItem(raw)).toBeUndefined()
})

test('names an item by its id and label, as the refusals list it', () => {
  const { item } = added(undefined, 'rewrite the wait')
  expect(todoName(item)).toBe('1 (rewrite the wait)')
})
