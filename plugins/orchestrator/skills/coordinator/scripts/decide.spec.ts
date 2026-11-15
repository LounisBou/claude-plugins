import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main } from './coordinator.ts'
import { fixture, liveOn, type Fixture } from './fixture.ts'

function entry(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, from: 'Orch: b', session: `s-${id}`, kind: 'operator', since: '2026-10-18T10:01:00.000Z', blocks: 'phase 3',
    question: `Ship ${id}?`, choices: [], recommendation: null, status: 'open', at: '2026-10-18T10:01:00.000Z', answer: null, ...fields }
}

function put(f: Fixture, id: string, value: unknown): void {
  mkdirSync(join(f.state, 'round'), { recursive: true })
  writeFileSync(join(f.state, 'round', `${id}.json`), `${JSON.stringify(value)}\n`)
}

/** A fixture whose liveness check finds `live`, with a coordinator recorded on /dev/ttys101 (pid 5100). */
function withCoordinator(live: Readonly<Record<string, number | null>>) {
  const f = fixture({ run: liveOn(live) })
  const check = join(f.root, 'verify')
  writeFileSync(check, '#!/bin/sh\n')
  chmodSync(check, 0o755)
  const ctx = { ...f.ctx, env: { ...f.ctx.env, COORDINATOR_VERIFY: check } }
  mkdirSync(f.state, { recursive: true })
  writeFileSync(join(f.state, 'coordinator.json'), JSON.stringify({ name: 'Coord: ops [c0ffee]', tty: '/dev/ttys101', pid: 5100 }))
  return { ...f, ctx }
}

const ids = (lines: readonly string[]) => lines.filter(line => line.startsWith('round ')).map(line => line.split(' ')[1])

function seed(f: Fixture): void {
  put(f, 'a-late', entry('a-late', { from: 'Orch: a', since: '2026-10-18T10:03:00.000Z' }))
  put(f, 'b-early', entry('b-early', { from: 'Orch: b', since: '2026-10-18T10:01:00.000Z' }))
  put(f, 'c-urgent', entry('c-urgent', { from: 'Audit: c', since: '2026-10-18T10:05:00.000Z', urgent: true }))
  put(f, 'd-coord', entry('d-coord', { from: 'Coord: other', since: '2026-10-18T10:04:00.000Z' }))
  put(f, 'e-answered', entry('e-answered', { status: 'answered', answer: { text: 'A', by: 'pane', at: '2026-10-18T10:02:00.000Z' } }))
  put(f, 'f-withdrawn', entry('f-withdrawn', { status: 'withdrawn', answer: { text: 'moot', by: 'sender', at: '2026-10-18T10:02:00.000Z' } }))
  put(f, 'g-done', entry('g-done', { kind: 'done', question: 'done?' }))
  // A second question of Orch: a, asked after the others' first ones: grouped with its first.
  put(f, 'h-late', entry('h-late', { from: 'Orch: a', since: '2026-10-18T10:06:00.000Z' }))
  // A question asked with `ask` (v 2), as the hooks module writes it.
  put(f, 'q-v2', { v: 2, id: 'q-v2', sender: { session: 's-v2', name: 'Orch: v', role: 'orchestrator', machine: 'box' }, subject: 'merge order', context: 'ctx', ask: 'Which first?',
    choices: [{ letter: 'A', text: 'one' }, { letter: 'B', text: 'two' }], status: 'open', at: '2026-10-18T10:07:00.000Z', answer: null })
}

describe('round --decide', () => {
  it('with no coordinator live, lists every open operator question of the machine, the urgent first, each grouped by sender', () => {
    const f = fixture()
    seed(f)
    assert.equal(main(f.ctx, ['round', '--decide', '--as', 'Orch: me [a1b2c3]']), 0)
    assert.equal(f.out[0], 'decide: machine | 6 open')
    assert.deepEqual(ids(f.out), ['c-urgent', 'b-early', 'a-late', 'h-late', 'd-coord', 'q-v2'])
    assert.ok(f.out.includes('    Ship b-early?'))
    assert.ok(f.out.includes('    _Question_ : Which first?'))
    assert.ok(!f.out.some(line => line.includes('g-done') || line.includes('e-answered') || line.includes('settled:')))
    assert.equal(existsSync(join(f.state, 'round-listed.json')), false)
  })

  it('takes a record whose session no longer runs for no coordinator', () => {
    const f = withCoordinator({})
    seed(f)
    assert.equal(main(f.ctx, ['round', '--decide', '--as', 'Orch: me [a1b2c3]']), 0)
    assert.equal(f.out[0], 'decide: machine | 6 open')
  })

  it('with a coordinator live elsewhere, says where to run it and lists nothing', () => {
    const f = withCoordinator({ '/dev/ttys101': 5100 })
    seed(f)
    assert.equal(main(f.ctx, ['round', '--decide', '--as', 'Orch: me [a1b2c3]']), 0)
    assert.deepEqual(f.out, ['decide: elsewhere | Coord: ops [c0ffee] | /dev/ttys101'])
    f.out.length = 0
    assert.equal(main(f.ctx, ['round', '--decide', '--as', 'Orch: me [a1b2c3]']), 0)
    assert.deepEqual(f.out, ['decide: elsewhere | Coord: ops [c0ffee] | /dev/ttys101'])
  })

  it('in the live coordinator\'s own session, keeps today\'s round: round --by-urgency as it prints it', () => {
    const f = withCoordinator({ '/dev/ttys101': 5100 })
    seed(f)
    assert.equal(main(f.ctx, ['round', '--decide', '--as', 'Coord: ops [c0ffee]']), 0)
    const decided = f.out.slice()
    f.out.length = 0
    assert.equal(main(f.ctx, ['round', '--by-urgency']), 0)
    assert.deepEqual(decided, ['decide: coordinator', ...f.out])
    assert.ok(ids(decided).includes('g-done'))
  })

  it('counts a record that names no pid as a coordinator live, as the hooks module does', () => {
    const f = withCoordinator({})
    writeFileSync(join(f.state, 'coordinator.json'), JSON.stringify({ name: 'Coord: ops [c0ffee]', tty: '/dev/ttys101' }))
    seed(f)
    assert.equal(main(f.ctx, ['round', '--decide', '--as', 'Orch: me [a1b2c3]']), 0)
    assert.deepEqual(f.out, ['decide: elsewhere | Coord: ops [c0ffee] | /dev/ttys101'])
  })

  it('says in one line that the round is empty: no entry, only settled ones, or only a closing proposal', () => {
    const none = fixture()
    assert.equal(main(none.ctx, ['round', '--decide', '--as', 'Orch: me [a1b2c3]']), 0)
    assert.deepEqual(none.out, ['decide: empty | no open question'])
    const settled = fixture()
    put(settled, 'e-answered', entry('e-answered', { status: 'answered', answer: { text: 'A', by: 'pane', at: '2026-10-18T10:02:00.000Z' } }))
    put(settled, 'g-done', entry('g-done', { kind: 'done' }))
    assert.equal(main(settled.ctx, ['round', '--decide', '--as', 'Orch: me [a1b2c3]']), 0)
    assert.deepEqual(settled.out, ['decide: empty | no open question'])
  })

  it('refuses an option it does not know, --as with no value or twice, and --decide with no --as', () => {
    const f = fixture()
    assert.equal(main(f.ctx, ['round', '--decide', '--all']), 1)
    assert.equal(main(f.ctx, ['round', '--decide', '--as']), 1)
    assert.equal(main(f.ctx, ['round', '--as', 'Orch: me']), 1)
    assert.equal(main(f.ctx, ['round', '--decide']), 1)
    assert.equal(main(f.ctx, ['round', '--as', '--decide']), 1)
    assert.equal(main(f.ctx, ['round', '--decide', '--as', 'a', '--as', 'b']), 1)
    assert.deepEqual(f.err, ['coordinator: round: --decide takes no --all', 'coordinator: round: --as needs a value', 'coordinator: round: --as goes with --decide',
      'coordinator: round: --decide needs --as "<your exact name and reference>"', 'coordinator: round: --as needs a value', 'coordinator: round: --as is given once'])
    assert.deepEqual(f.out, [])
  })
})
