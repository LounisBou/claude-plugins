// The orchestrator session's transcript read for what the harness decides on: the wait its last
// turn declared, whether the turn has ended, and the decisions it took in place of the operator.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { findTranscript, readTranscript, WAIT_TOOL } from './transcript.ts'

type Line = Record<string, unknown>

const prompt = (text = 'go'): Line => ({ type: 'user', message: { role: 'user', content: text } })
const said = (text: string, stop = 'end_turn'): Line => ({ type: 'assistant', message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] } })
const called = (name: string, input: unknown, id = 't1'): Line => ({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, isError = false): Line => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' }] } })
const declare = (kind: string, blocks = '', id = 't1'): Line => called(WAIT_TOOL, { kind, blocks }, id)
const jsonl = (lines: readonly Line[]): string => `${lines.map(line => JSON.stringify(line)).join('\n')}\n`

describe('outcome evals: the orchestrator transcript', () => {
  it('reads a declared wait from the turn that made it, once its turn has ended', () => {
    const reading = readTranscript(jsonl([prompt(), declare('done'), result('t1'), said('All goals met.')]))
    assert.deepEqual(reading.wait, { kind: 'done', blocks: '' })
    assert.equal(reading.idle, true)
    const asked = readTranscript(jsonl([prompt(), declare('operator', 'which name?'), result('t1'), said('Which name?')]))
    assert.deepEqual(asked.wait, { kind: 'operator', blocks: 'which name?' })
  })

  it('reads a turn that is still working as not idle', () => {
    assert.equal(readTranscript(jsonl([prompt(), said('working', 'tool_use')])).idle, false)
    assert.equal(readTranscript(jsonl([prompt(), declare('done')])).idle, false)
    assert.equal(readTranscript(jsonl([prompt(), said('done.'), prompt('a notice')])).idle, false)
    assert.equal(readTranscript('').idle, false)
  })

  it('ignores a wait declared in an earlier turn, and one the tool refused', () => {
    const earlier = readTranscript(jsonl([prompt(), declare('done'), result('t1'), said('ok'), prompt('an agent reported'), said('reading it')]))
    assert.equal(earlier.wait, null)
    const refused = readTranscript(jsonl([prompt(), declare('operator', 'q', 't9'), result('t9', true), said('sorry')]))
    assert.equal(refused.wait, null)
  })

  it('reads no wait from the wording of a last line: only a declaration decides', () => {
    assert.equal(readTranscript(jsonl([prompt(), said('text\nwaiting: done')])).wait, null)
    assert.equal(readTranscript(jsonl([prompt(), said('waiting: operator — blocks: pick one\n')])).wait, null)
    assert.equal(readTranscript(jsonl([prompt(), said('waiting: tool — a monitor')])).wait, null)
    assert.equal(readTranscript(jsonl([prompt(), said('nothing to declare')])).wait, null)
  })

  it('lets a declaration beat the wording of the last line', () => {
    const reading = readTranscript(jsonl([prompt(), declare('tool', 'a watch'), result('t1'), said('waiting: done')]))
    assert.deepEqual(reading.wait, { kind: 'tool', blocks: 'a watch' })
  })

  it("leaves a subagent's turns out, and the lines that are not messages", () => {
    const side: Line = { ...said('waiting: done'), isSidechain: true }
    const reading = readTranscript(`${jsonl([prompt(), said('working', 'tool_use'), side, { type: 'system', subtype: 'turn_duration' }])}{"half`)
    assert.equal(reading.wait, null)
    assert.equal(reading.idle, false)
    assert.equal(readTranscript(jsonl([prompt(), said('fin'), { type: 'system', subtype: 'turn_duration' }, { type: 'last-prompt' }])).idle, true)
  })

  it('collects the decisions taken in place of the operator, once each', () => {
    const reading = readTranscript(
      jsonl([
        prompt('Decision: not mine → ignored'),
        said('Plan.\nDecision: which model? → sonnet\n- Decision: merge now or later → later'),
        called('Bash', { command: 'echo Decision: x → y' }),
        said('Decision: which model? → sonnet\nDecision: no arrow here'),
      ]),
    )
    assert.deepEqual(reading.decisions, ['which model? → sonnet', 'merge now or later → later'])
  })

  it('tells a changed transcript from an unchanged one', () => {
    const a = readTranscript(jsonl([prompt(), said('x')]))
    assert.equal(a.signature, readTranscript(jsonl([prompt(), said('x')])).signature)
    assert.notEqual(a.signature, readTranscript(jsonl([prompt(), said('x'), prompt('y'), said('z')])).signature)
  })
})

describe('outcome evals: finding the transcript', () => {
  it('finds the session under any project directory, and nothing for an unsafe name', () => {
    const projects = mkdtempSync(join(tmpdir(), 'outcome-projects-'))
    mkdirSync(join(projects, '-a-b'))
    mkdirSync(join(projects, '-c'))
    writeFileSync(join(projects, '-c', 'abcd1234-aaaa.jsonl'), 'x')
    assert.equal(findTranscript(projects, 'abcd1234-aaaa'), join(projects, '-c', 'abcd1234-aaaa.jsonl'))
    assert.equal(findTranscript(projects, 'abcd1234-bbbb'), null)
    assert.equal(findTranscript(join(projects, 'missing'), 'abcd1234-aaaa'), null)
    assert.equal(findTranscript(projects, '../x'), null)
  })
})
