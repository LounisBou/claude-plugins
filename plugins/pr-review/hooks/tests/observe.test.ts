// hooks/tests/observe.test.ts
// The line an observed guard leaves: an event core's reader takes, holding the guard's code and
// nothing of the call; and a journal that cannot be written changes no answer.
import { expect, test } from 'claude-code/testing'
import type { TestOn } from 'claude-code/testing'
import { parseJournalEvent } from '../../core/learning.ts'
import { observedAs, watchJournal } from './journal.ts'

const editCall = { tool: 'Edit', file_path: '/repo/secret-name.ts', old_string: 'a', new_string: 'hunter2', replace_all: false } as const

function engine(on: TestOn) {
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('skill.prompt', () => ({ text: 'SKILL TEXT' }))
  on('tool.call', () => ({ result: 'ran' }))
}

test('the line is an event core reads, and holds neither the path nor the text of the call', async ($, on) => {
  engine(on)
  const journal = watchJournal(on)
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  await $.tool.call(editCall)
  const [event] = journal()
  expect(parseJournalEvent(event)).toEqual(event)
  expect(event).toMatchObject(observedAs('pr-review.edit.ungranted'))
  expect(JSON.stringify(event)).not.toMatch(/secret-name|hunter2|\/repo/)
})

test('a journal that cannot be written is one line in the log, and the call goes through', async ($, on) => {
  engine(on)
  const logged: string[] = []
  on('env.get', () => ({ value: '/home/op' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.write', () => ({ deny: 'disk full' }))
  on('ui.log', (_$, e) => { logged.push(String(e.text)); return { value: undefined } })
  await $.skill.prompt({ skill: 'pr-review:start-review', text: '' })
  const out = await $.tool.call(editCall)
  expect(out.deny).toBeUndefined()
  expect(out.result).toBe('ran')
  expect(logged.length).toBe(1)
  expect(logged[0]).toContain('the journal could not be written or pruned')
  expect(logged[0]).toContain('disk full')
})
