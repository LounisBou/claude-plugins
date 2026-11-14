import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main } from './coordinator.ts'
import { fixture, type Fixture } from './fixture.ts'
import { parseEntry } from './round.ts'

function entry(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, from: 'Orch: b', session: `s-${id}`, kind: 'operator', since: '2026-10-18T10:01:00.000Z', blocks: 'phase 3',
    question: 'Ship it?', choices: [], recommendation: null, status: 'open', at: '2026-10-18T10:01:00.000Z', answer: null, ...fields }
}

function put(f: Fixture, id: string, value: unknown): string {
  const path = join(f.state, 'round', `${id}.json`)
  mkdirSync(join(f.state, 'round'), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
  return path
}

const OLD = '2026-10-16T10:00:00Z'

describe('round-archive', () => {
  it('moves the closed entries alone, and says how many', () => {
    const f = fixture()
    put(f, 'z-closed', entry('z-closed', { status: 'closed', answer: { text: 'A', by: 'coordinator', at: OLD } }))
    put(f, 'y-closed', entry('y-closed', { status: 'closed', answer: { text: 'A', by: 'coordinator', at: OLD } }))
    put(f, 'z-open', entry('z-open'))
    put(f, 'z-broken', '{"id": "half')
    put(f, 'z-shape', { id: 'z-shape', status: 'closed', answer: { at: OLD } })
    mkdirSync(join(f.state, 'round', 'dir.json'))
    assert.equal(main(f.ctx, ['round-archive']), 0)
    assert.equal(main(f.ctx, ['round-archive']), 0)
    assert.deepEqual(f.out, ['archived 2', 'archived 0'])
    assert.deepEqual(readdirSync(join(f.state, 'round', 'archive')).sort(), ['y-closed.json', 'z-closed.json'])
    assert.deepEqual(readdirSync(join(f.state, 'round')).sort(), ['archive', 'dir.json', 'z-broken.json', 'z-open.json', 'z-shape.json'])
  })

  it('moves every settled entry settled over a day ago, delivered or never sent, the withdrawn apart', () => {
    const f = fixture()
    const settled = (status: string, at: string, more: Record<string, unknown> = {}) => ({ status, answer: { text: 'A', by: 'pane', at }, ...more })
    put(f, 'a-answered', entry('a-answered', settled('answered', OLD)))
    put(f, 'a-delivered', entry('a-delivered', settled('closed', OLD, { delivery: { state: 'delivered', at: OLD, attempts: 1 } })))
    put(f, 'a-withdrawn', entry('a-withdrawn', settled('withdrawn', OLD)))
    put(f, 'a-since', entry('a-since', { status: 'withdrawn', since: OLD, answer: null }))
    put(f, 'k-fresh', entry('k-fresh', settled('withdrawn', '2026-10-18T08:06:07Z')))
    put(f, 'k-failed', entry('k-failed', settled('answered', OLD, { delivery: { state: 'failed', at: OLD, attempts: 1, reason: 'gone' } })))
    put(f, 'k-pending', entry('k-pending', settled('closed', OLD, { delivery: { state: 'pending', at: OLD, attempts: 0 } })))
    put(f, 'k-sent', entry('k-sent', settled('closed', OLD, { delivery: { state: 'sent', at: OLD, attempts: 1 } })))
    put(f, 'k-open', entry('k-open', { since: OLD }))
    put(f, 'v-answered', { v: 2, id: 'v-answered', status: 'answered', at: OLD, answer: { text: 'B', by: 'tab', at: OLD } })
    put(f, 'v-withdrawn', { v: 2, id: 'v-withdrawn', status: 'withdrawn', at: OLD, answer: { text: 'moot', by: 'sender', at: OLD } })
    put(f, 'v-open', { v: 2, id: 'v-open', status: 'open', at: OLD, answer: null })
    assert.equal(main(f.ctx, ['round-archive']), 0)
    assert.deepEqual(f.out, ['archived 6'])
    assert.deepEqual(readdirSync(join(f.state, 'round', 'archive')).sort(), ['a-answered.json', 'a-delivered.json', 'v-answered.json', 'withdrawn'])
    assert.deepEqual(readdirSync(join(f.state, 'round', 'archive', 'withdrawn')).sort(), ['a-since.json', 'a-withdrawn.json', 'v-withdrawn.json'])
    assert.deepEqual(readdirSync(join(f.state, 'round')).sort(), ['archive', 'k-failed.json', 'k-fresh.json', 'k-open.json', 'k-pending.json', 'k-sent.json', 'v-open.json'])
  })

  it('removes a temporary file a day old and keeps a fresh one', () => {
    const f = fixture()
    const old = put(f, 'old', '').replace(/old\.json$/, 'old.json.tmp-1-abc')
    writeFileSync(old, '{')
    writeFileSync(join(f.state, 'round', 'fresh.json.tmp-2-def'), '{')
    utimesSync(old, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
    utimesSync(join(f.state, 'round', 'fresh.json.tmp-2-def'), new Date('2026-10-18T10:00:00Z'), new Date('2026-10-18T10:00:00Z'))
    assert.equal(main(f.ctx, ['round-archive']), 0)
    assert.equal(existsSync(old), false)
    assert.equal(existsSync(join(f.state, 'round', 'fresh.json.tmp-2-def')), true)
  })

  it('moves nothing with no round directory, and refuses an argument', () => {
    const f = fixture()
    assert.equal(main(f.ctx, ['round-archive']), 0)
    assert.equal(main(f.ctx, ['round-archive', 'now']), 1)
    assert.deepEqual([f.out, f.err], [['archived 0'], ['coordinator: round-archive: unexpected argument now']])
  })

  it('refuses when the archive cannot be made', () => {
    const f = fixture()
    put(f, 'c', entry('c', { status: 'closed', answer: { text: 'A', by: 'coordinator', at: OLD } }))
    writeFileSync(join(f.state, 'round', 'archive'), '')
    assert.equal(main(f.ctx, ['round-archive']), 1)
    assert.deepEqual(f.err, [`coordinator: round-archive: cannot create ${join(f.state, 'round', 'archive')}`])
  })

  it('reads an entry only when its fields have their types', () => {
    assert.equal(parseEntry('[]'), undefined)
    assert.equal(parseEntry('{"id":"x"}'), undefined)
    assert.deepEqual(parseEntry(JSON.stringify(entry('x'))), entry('x'))
  })
})
