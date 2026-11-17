// The cache figures of a transcript, from lines built here: no message text is in them or kept.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheFields, cacheTurns, lastTurn, TAIL_START_BYTES } from './cache.ts'

const T = (hhmmss: string): string => `2026-11-17T${hhmmss}.000Z`
const user = (at: string, promptId: string): string => JSON.stringify({ type: 'user', timestamp: T(at), promptId, message: { role: 'user', content: 'never kept' } })
const call = (at: string, id: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'assistant', timestamp: T(at), message: { id, model: 'claude-opus-5-5', content: [], usage }, ...extra })
const usage = (read: number, write: number, ttl?: [number, number]): Record<string, unknown> => ({
  input_tokens: 2, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write,
  ...(ttl === undefined ? {} : { cache_creation: { ephemeral_1h_input_tokens: ttl[0], ephemeral_5m_input_tokens: ttl[1] } }),
})

/** Turn p1 (a cold start), turn p2 five minutes later with two calls, turn p3 70 minutes later after a cold rewrite. */
const LINES = [
  user('10:00:00', 'p1'), call('10:00:02', 'm1', usage(0, 30_000, [30_000, 0])),
  user('10:05:00', 'p2'), call('10:05:02', 'm2', usage(30_000, 500, [500, 0])), call('10:05:03', 'm2', usage(30_000, 500, [500, 0])),
  user('10:05:10', 'p2'), call('10:05:12', 'm3', usage(30_500, 100)),
  user('11:15:00', 'p3'), call('11:15:04', 'm4', usage(0, 31_000, [0, 31_000])),
].join('\n')

test('cacheTurns: a turn is the calls under one promptId; its first call is its own, and the idle gap runs from the previous call\'s end', () => {
  const turns = cacheTurns(LINES)
  assert.deepEqual(turns.map(t => [t.prompt, t.idleMs, t.first.cache_read, t.first.cache_write]), [['p1', undefined, 0, 30_000], ['p2', 300_000, 30_000, 500], ['p3', 4_192_000, 0, 31_000]])
  assert.equal(turns[1]?.end, Date.parse(T('10:05:12')))
})

test('cacheFields: the first call with its writes by TTL, the idle gap absent for a session\'s first call', () => {
  const [first, second, third] = cacheTurns(LINES)
  assert.deepEqual(cacheFields(first!), { first_call: { in: 2, out: 10, cache_read: 0, cache_write: 30_000, write_1h: 30_000, write_5m: 0 } })
  assert.deepEqual(cacheFields(second!)['first_call'], { in: 2, out: 10, cache_read: 30_000, cache_write: 500, write_1h: 500, write_5m: 0 })
  assert.deepEqual(cacheFields(third!), { first_call: { in: 2, out: 10, cache_read: 0, cache_write: 31_000, write_1h: 0, write_5m: 31_000 }, idle_ms: 4_192_000 })
})

test('cacheTurns: a response written in several entries is one call; a synthetic answer, a subagent entry, an untimed one and a call before any prompt are left out', () => {
  const lines = [
    call('09:59:00', 'early', usage(0, 5)),
    user('10:00:00', 'p1'), call('10:00:02', 'm1', usage(0, 100)), call('10:00:04', 'm1', { ...usage(0, 100), output_tokens: 40 }),
    JSON.stringify({ type: 'assistant', timestamp: T('10:00:05'), message: { id: 'syn', model: '<synthetic>', usage: {} } }),
    call('10:00:06', 'side', usage(7, 7), { isSidechain: true }),
    JSON.stringify({ type: 'assistant', message: { id: 'untimed', usage: usage(9, 9) } }),
    'not json', '{"type":"api-request-blob","message":"{\\"type\\":\\"user\\"}"}',
  ].join('\n')
  const turns = cacheTurns(lines)
  assert.equal(turns.length, 1)
  assert.equal(turns[0]?.first.out, 40)
  assert.equal(turns[0]?.end, Date.parse(T('10:00:04')))
  assert.deepEqual(cacheTurns(''), [])
})

test('cacheTurns: a transcript without the TTL split writes zeros for it', () => {
  const [turn] = cacheTurns([user('10:00:00', 'p1'), call('10:00:02', 'm1', usage(0, 100))].join('\n'))
  assert.deepEqual([turn?.first.write_1h, turn?.first.write_5m], [0, 0])
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

test('lastTurn: the turn that ended at the event\'s time, with its idle gap', () => {
  withFile(`${LINES}\n`, path => {
    const turn = lastTurn(path, Date.parse(T('11:15:05')))
    assert.equal(turn?.prompt, 'p3')
    assert.equal(turn?.idleMs, 4_192_000)
  })
})

test('lastTurn: a last turn that did not end near the event, or that is not written yet, is not the turn asked for', () => {
  withFile(`${LINES}\n`, path => {
    assert.equal(lastTurn(path, Date.parse(T('11:30:00'))), undefined)
    assert.equal(lastTurn(path, Date.parse(T('11:14:00'))), undefined)
  })
  withFile('', path => assert.equal(lastTurn(path, 0), undefined))
})

test('lastTurn: a turn longer than the first window widens it until the call before the turn is in it', () => {
  // The previous turn's call sits before more than a window of blobs: the idle gap needs it.
  const blob = JSON.stringify({ type: 'api-request-blob', message: 'x'.repeat(TAIL_START_BYTES) })
  const body = [user('10:00:00', 'p1'), call('10:00:02', 'm1', usage(0, 100)), blob, blob, user('10:10:00', 'p2'), call('10:10:02', 'm2', usage(100, 5)), blob].join('\n')
  withFile(`${body}\n`, path => {
    const turn = lastTurn(path, Date.parse(T('10:10:03')))
    assert.equal(turn?.prompt, 'p2')
    assert.equal(turn?.idleMs, 600_000)
  })
})

test('lastTurn: a session\'s first turn has no idle gap, and a window cut inside it is widened to the whole file', () => {
  const blob = JSON.stringify({ type: 'api-request-blob', message: 'x'.repeat(TAIL_START_BYTES) })
  withFile([blob, user('10:00:00', 'p1'), call('10:00:02', 'm1', usage(0, 100)), blob].join('\n'), path => {
    const turn = lastTurn(path, Date.parse(T('10:00:03')))
    assert.equal(turn?.idleMs, undefined)
    assert.equal(turn?.first.cache_write, 100)
  })
})
