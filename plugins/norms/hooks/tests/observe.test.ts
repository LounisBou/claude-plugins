// hooks/tests/observe.test.ts
// The line an observed guard leaves: an event core's reader takes, holding the guard's code and
// nothing of the call; and a journal that cannot be written changes no answer.
import { expect, test } from 'claude-code/testing'
import { parseJournalEvent } from '../../core/learning.ts'
import { register, resetGuards } from '../guards.ts'
import { fakeDollar, hook, mount, nextOf, type World } from './fakes.ts'
import { fieldsOf, listOf } from '../../core/host.ts'
import { hostOf } from '../../core/capture.ts'
import { observedAs, watchJournal } from './journal.ts'

async function walkthrough($: World) {
  resetGuards()
  const hooks = mount(register)
  await hook(hooks, 'command.run', { command: 'norms:check' }).handler($, { command: 'norms:check', args: '' }, nextOf().next)
  return async (e: { tool: string } & Readonly<Record<string, unknown>>) => {
    const { next, seen } = nextOf()
    const out = await hook(hooks, 'tool.call', { tool: e.tool }).handler($, e, next)
    return { out, ran: seen.length === 1 }
  }
}

const editCall = { tool: 'Edit', file_path: '/repo/secret-name.ts', old_string: 'a', new_string: 'hunter2' }

test('the line is an event core reads, and holds neither the path nor the text of the call', async () => {
  const { $ } = fakeDollar({})
  const journal = watchJournal($)
  const call = await walkthrough($)
  expect((await call(editCall)).ran).toBe(true)
  const [event] = journal()
  expect(parseJournalEvent(event)).toEqual(event)
  expect(event).toMatchObject(observedAs('norms.edit.ungranted'))
  expect(JSON.stringify(event)).not.toMatch(/secret-name|hunter2|\/repo/)
})

test('a journal that cannot be written is one line in the log, and the call goes through', async () => {
  const { $, logs } = fakeDollar({})
  watchJournal($)
  $.fs.write = async () => { throw new Error('disk full') }
  const call = await walkthrough($)
  const { out, ran } = await call(editCall)
  expect(fieldsOf(out)?.['deny']).toBeUndefined()
  expect(ran).toBe(true)
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('the journal could not be written or pruned')
  expect(logs[0]).toContain('disk full')
})

test('a session with no log and no journal still lets the call through', async () => {
  const { $ } = fakeDollar({})
  $.ui = hostOf().ui
  $.env = { get: async () => { throw new Error('no env') } }
  const call = await walkthrough($)
  const { out, ran } = await call(editCall)
  expect(fieldsOf(out)?.['deny']).toBeUndefined()
  expect(ran).toBe(true)
})
