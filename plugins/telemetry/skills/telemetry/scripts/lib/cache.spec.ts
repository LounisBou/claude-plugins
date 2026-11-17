// The API calls of a transcript, from lines built here: no message text is in them or kept.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiCalls, callFields, END_SLACK_AFTER_MS, END_SLACK_BEFORE_MS, lastTurn, TAIL_START_BYTES } from './cache.ts'

const T = (hhmmss: string): string => `2026-11-17T${hhmmss}.000Z`
const user = (at: string, promptId: string): string => JSON.stringify({ type: 'user', timestamp: T(at), promptId, message: { role: 'user', content: 'never kept' } })
const call = (at: string, id: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}, content: unknown[] = [], stop?: string): string =>
  JSON.stringify({ type: 'assistant', timestamp: T(at), requestId: `req_${id}`, message: { id, model: 'claude-opus-5-5', content, usage, ...(stop === undefined ? {} : { stop_reason: stop }) }, ...extra })
const usage = (read: number, write: number, ttl?: [number, number]): Record<string, unknown> => ({
  input_tokens: 2, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write, future_field: { kept: true },
  ...(ttl === undefined ? {} : { cache_creation: { ephemeral_1h_input_tokens: ttl[0], ephemeral_5m_input_tokens: ttl[1] } }),
})

/** Turn p1, turn p2 five minutes later with two calls, turn p3 70 minutes later. */
const LINES = [
  user('10:00:00', 'p1'), call('10:00:02', 'm1', usage(0, 30_000, [30_000, 0])),
  user('10:05:00', 'p2'), call('10:05:02', 'm2', usage(30_000, 500, [500, 0])), call('10:05:03', 'm2', usage(30_000, 500, [500, 0])),
  user('10:05:10', 'p2'), call('10:05:12', 'm3', usage(30_500, 100)),
  user('11:15:00', 'p3'), call('11:15:04', 'm4', usage(0, 31_000, [0, 31_000])),
].join('\n')

test('apiCalls: each call whole and raw, in order: ids, model, the usage object as written, times; a response in several entries is one call', () => {
  const calls = apiCalls(LINES)
  assert.deepEqual(calls.map(c => [c.prompt, c.message, c.request]), [['p1', 'm1', 'req_m1'], ['p2', 'm2', 'req_m2'], ['p2', 'm3', 'req_m3'], ['p3', 'm4', 'req_m4']])
  assert.deepEqual(calls[0]?.usage, usage(0, 30_000, [30_000, 0]))
  assert.equal(calls[1]?.start, Date.parse(T('10:05:02')))
  assert.equal(calls[1]?.end, Date.parse(T('10:05:03')))
  assert.equal(calls[0]?.model, 'claude-opus-5-5')
})

test('callFields: raw facts, ISO end, the tool names and the stop reason; no tool input or output, no derived value', () => {
  const tool = { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'never kept' } }
  const server = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: { q: 'never kept' } }
  const lines = [user('10:00:00', 'p1'), call('10:00:02', 'm1', usage(0, 5), {}, [{ type: 'text', text: 'never kept' }]), call('10:00:03', 'm1', usage(0, 5), {}, [tool, server], 'tool_use')].join('\n')
  const [first] = apiCalls(lines)
  const fields = callFields(first!)
  assert.deepEqual(fields, { prompt: 'p1', message: 'm1', request: 'req_m1', model: 'claude-opus-5-5', stop_reason: 'tool_use', end: T('10:00:03'), usage: usage(0, 5), tools: ['Bash', 'advisor'] })
  assert.ok(!JSON.stringify(fields).includes('never kept'))
  assert.equal('tools' in callFields(apiCalls([user('10:00:00', 'p1'), call('10:00:02', 'm2', usage(0, 1))].join('\n'))[0]!), false)
})

test('apiCalls: the last entry of a response gives its usage; a synthetic answer, a subagent entry, an untimed one and a call before any prompt are left out', () => {
  const lines = [
    call('09:59:00', 'early', usage(0, 5)),
    user('10:00:00', 'p1'), call('10:00:02', 'm1', usage(0, 100)), call('10:00:04', 'm1', { ...usage(0, 100), output_tokens: 40 }),
    JSON.stringify({ type: 'assistant', timestamp: T('10:00:05'), message: { id: 'syn', model: '<synthetic>', usage: {} } }),
    call('10:00:06', 'side', usage(7, 7), { isSidechain: true }),
    JSON.stringify({ type: 'assistant', message: { id: 'untimed', usage: usage(9, 9) } }),
    'not json', '{"type":"api-request-blob","message":"{\\"type\\":\\"user\\"}"}',
  ].join('\n')
  const calls = apiCalls(lines)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.usage['output_tokens'], 40)
  assert.equal(calls[0]?.end, Date.parse(T('10:00:04')))
  assert.deepEqual(apiCalls(''), [])
})

function withFile(body: string, work: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-cache-'))
  try {
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, body)
    work(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('lastTurn: the calls of the turn that ended at the event\'s time, all of them', () => {
  withFile(`${LINES}\n`, path => {
    assert.deepEqual(lastTurn(path, Date.parse(T('11:15:05')))?.map(c => c.message), ['m4'])
  })
  withFile([user('10:00:00', 'p1'), call('10:00:02', 'a', usage(0, 1)), call('10:00:09', 'b', usage(1, 1))].join('\n'), path => {
    assert.deepEqual(lastTurn(path, Date.parse(T('10:00:10')))?.map(c => c.message), ['a', 'b'])
  })
})

test('lastTurn: the turn is taken from 120 s before to 5 s after the event, edges included; none that is not written yet', () => {
  withFile(`${LINES}\n`, path => {
    const ended = Date.parse(T('11:15:04'))
    assert.equal(lastTurn(path, ended + END_SLACK_BEFORE_MS)?.length, 1)
    assert.equal(lastTurn(path, ended + END_SLACK_BEFORE_MS + 1), undefined)
    assert.equal(lastTurn(path, ended - END_SLACK_AFTER_MS)?.length, 1)
    assert.equal(lastTurn(path, ended - END_SLACK_AFTER_MS - 1), undefined)
  })
  withFile('', path => assert.equal(lastTurn(path, 0), undefined))
})

test('lastTurn: with the turn\'s start known, a previous turn that ended just before it is not taken for a turn that made no call', () => {
  withFile(`${LINES}\n`, path => {
    const ended = Date.parse(T('11:15:30'))
    assert.equal(lastTurn(path, ended, { startedAt: ended - 1_000 }), undefined)
    assert.equal(lastTurn(path, ended, { startedAt: ended - 30_000 })?.length, 1)
  })
})

test('lastTurn: a turn longer than the first window widens it until the turn is whole; past the cap it is not read', () => {
  const blob = JSON.stringify({ type: 'api-request-blob', message: 'x'.repeat(TAIL_START_BYTES) })
  // The turn p2 starts before more than a window of blobs: its first call is only in the widened window.
  const body = [user('10:00:00', 'p1'), call('10:00:02', 'm1', usage(0, 100)), user('10:10:00', 'p2'), call('10:10:02', 'm2', usage(100, 5)), blob, blob, call('10:10:09', 'm3', usage(100, 5)), blob].join('\n')
  withFile(`${body}\n`, path => {
    assert.deepEqual(lastTurn(path, Date.parse(T('10:10:10')))?.map(c => c.message), ['m2', 'm3'])
    assert.equal(lastTurn(path, Date.parse(T('10:10:10')), { maxBytes: TAIL_START_BYTES }), undefined)
  })
})

test('lastTurn: a session\'s first turn, cut by the first window, is read whole once the window is the file', () => {
  const blob = JSON.stringify({ type: 'api-request-blob', message: 'x'.repeat(TAIL_START_BYTES) })
  withFile([blob, user('10:00:00', 'p1'), call('10:00:02', 'm1', usage(0, 100)), blob].join('\n'), path => {
    assert.deepEqual(lastTurn(path, Date.parse(T('10:00:03')))?.map(c => c.message), ['m1'])
  })
})
