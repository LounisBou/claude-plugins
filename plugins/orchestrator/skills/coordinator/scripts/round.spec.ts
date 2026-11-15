import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main } from './coordinator.ts'
import { fixture, type Fixture } from './fixture.ts'
import { entryOf, paneOpen, parseEntry } from './round.ts'

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

describe('round', () => {
  /** A fixture whose senders' sessions files exist, under a module directory of its own. */
  function live(f: Fixture, ...sessions: string[]): void {
    const dir = join(moduleOf(f), 'store', 'sessions', 'nested')
    mkdirSync(dir, { recursive: true })
    for (const session of sessions) writeFileSync(join(dir, session), '')
    writeFileSync(join(dir, 'x.tmp-1'), '')
  }
  const moduleOf = (f: Fixture): string => f.ctx.env['ORCHESTRATOR_MODULE_DIR'] ?? ''
  const withModule = (env: Record<string, string> = {}) =>
    fixture({ env: { ORCHESTRATOR_MODULE_DIR: join(mkdtempSync(join(tmpdir(), 'coordinator-module-')), 'module'), ...env } })
  function pane(f: Fixture, record: unknown): void {
    mkdirSync(f.state, { recursive: true })
    writeFileSync(join(f.state, 'pane.json'), JSON.stringify(record))
  }

  it('prints the open entries, the urgent first, each level grouped by sender, after the settled count', () => {
    const f = withModule()
    live(f, 's-b-late', 's-a-one', 's-b-early', 's-u')
    put(f, 'b-late', entry('b-late', { since: '2026-10-18T10:05:00.000Z', question: 'Merge?\n- **A** : yes' }))
    put(f, 'a-one', entry('a-one', { from: 'Orch: a', since: '2026-10-18T10:03:00.000Z', blocks: null }))
    put(f, 'b-early', entry('b-early', { since: '2026-10-18T10:01:00.000Z' }))
    put(f, 'u', entry('u', { from: 'Orch: z', urgent: true, since: '2026-10-18T10:09:00.000Z' }))
    put(f, 'c-done', entry('c-done', { kind: 'done', session: '', question: 'Merged.' }))
    put(f, 'gone', entry('gone', { from: 'Orch: a', session: 's/gone', since: '2026-10-18T10:04:00.000Z' }))
    put(f, 'w', entry('w', { status: 'withdrawn' }))
    put(f, 'n', entry('n', { status: 'answered', answer: { at: 'T', text: 'A : yes' } }))
    put(f, 'd', entry('d', { status: 'closed' }))
    put(f, 'broken', '{"id": "half')
    writeFileSync(join(f.state, 'round', 'a-one.json.tmp-1'), '{}')
    mkdirSync(join(f.state, 'round', 'dir.json'))
    pane(f, { pid: 4242 })
    const ps = join(f.root, 'ps')
    writeFileSync(ps, '  4242 1 ttys1 x\n')
    const g = fixture({ env: { ...f.ctx.env, COORDINATOR_PS_TABLE: ps } })
    assert.equal(main(g.ctx, ['round']), 0)
    assert.deepEqual(g.out, [
      'settled: 1 answered, 1 withdrawn (round --all prints them)',
      'round u | operator | from Orch: z | since 2026-10-18T10:09:00.000Z | blocks: phase 3 | open | due',
      '    Ship it?',
      'round b-early | operator | from Orch: b | since 2026-10-18T10:01:00.000Z | blocks: phase 3 | open',
      'round c-done | done | from Orch: b | since 2026-10-18T10:01:00.000Z | blocks: phase 3 | open',
      '    Merged.',
      'round b-late | operator | from Orch: b | since 2026-10-18T10:05:00.000Z | blocks: phase 3 | open',
      'round a-one | operator | from Orch: a | since 2026-10-18T10:03:00.000Z | blocks: - | open',
      'round gone | operator | from Orch: a | since 2026-10-18T10:04:00.000Z | blocks: phase 3 | open | sender gone',
    ])
    // The entries printed as their header alone are the pane's: not recorded as shown.
    assert.deepEqual(JSON.parse(readFileSync(join(f.state, 'round-listed.json'), 'utf8')), ['c-done', 'u'])
  })

  it('prints with --all the answered and the withdrawn entries with their close, every question whole', () => {
    const f = withModule()
    live(f, 's-n', 's-w1', 's-w2', 's-w3', 's-w4', 's-o')
    const at = '2026-10-18T10:00:00Z'
    put(f, 'n', entry('n', { status: 'answered', answer: { at, text: 'A : yes' } }))
    put(f, 'n2', entry('n2', { session: 's-n', status: 'answered', answer: null }))
    put(f, 'w1', entry('w1', { status: 'withdrawn', answer: { by: 'sender', at, text: '' } }))
    put(f, 'w2', entry('w2', { status: 'withdrawn', answer: { by: 'sender', at, text: 'superseded by q2' } }))
    put(f, 'w3', entry('w3', { status: 'withdrawn', answer: { by: 'tab', at, text: 'he answered there', typed: 'B,\n  then  \n merge' } }))
    put(f, 'w4', entry('w4', { status: 'withdrawn', answer: { at, text: 'lost' } }))
    put(f, 'w5', entry('w5', { session: 's-w4', status: 'withdrawn', answer: { by: 'tab', at } }))
    put(f, 'o', entry('o', { question: '' }))
    assert.equal(main(f.ctx, ['round', '--all']), 0)
    assert.deepEqual(f.out, [
      'round o | operator | from Orch: b | since 2026-10-18T10:01:00.000Z | blocks: phase 3 | open | due',
      'round n | operator | from Orch: b | since 2026-10-18T10:01:00.000Z | blocks: phase 3 | answered',
      '    Ship it?',
      `    answered from the pane at ${at}: A : yes`,
      'round n2 | operator | from Orch: b | since 2026-10-18T10:01:00.000Z | blocks: phase 3 | answered',
      '    Ship it?',
      '    answered from the pane at ?: ',
      'round w1 | operator | from Orch: b | since 2026-10-18T10:01:00.000Z | blocks: phase 3 | withdrawn',
      '    Ship it?',
      `    withdrawn by the sender at ${at}: a later turn the operator typed in waits on something else`,
      'round w2 | operator | from Orch: b | since 2026-10-18T10:01:00.000Z | blocks: phase 3 | withdrawn',
      '    Ship it?',
      `    withdrawn by the sender at ${at}: superseded by q2`,
      'round w3 | operator | from Orch: b | since 2026-10-18T10:01:00.000Z | blocks: phase 3 | withdrawn',
      '    Ship it?',
      `    withdrawn in the sender's tab at ${at}: he answered there — he typed: B, then merge`,
      'round w4 | operator | from Orch: b | since 2026-10-18T10:01:00.000Z | blocks: phase 3 | withdrawn',
      '    Ship it?',
      `    withdrawn by ? at ${at}: lost`,
      'round w5 | operator | from Orch: b | since 2026-10-18T10:01:00.000Z | blocks: phase 3 | withdrawn',
      '    Ship it?',
      `    withdrawn in the sender's tab at ${at}: `,
    ])
  })

  it('reads a question asked with ask from its fields, and none its asker\'s tab claimed', () => {
    const v2 = { v: 2, id: 'q', sender: { session: 's-v', name: 'Orch: v' }, subject: 's', context: 'c', ask: 'a?',
      choices: [{ letter: 'A', text: 'one' }, null], recommended: 'A', why: 'w', urgent: true, status: 'open', at: 'T' }
    assert.equal(entryOf({ ...v2, claimed: {} }), undefined)
    assert.equal(entryOf({ ...v2, choices: 'A' }), undefined)
    assert.equal(entryOf({ ...v2, choices: [3] }), undefined)
    assert.equal(entryOf('text'), undefined)
    assert.deepEqual(entryOf({ ...v2, choices: [], why: 'w', recommended: null })?.['question'], '_Subject_ : s\n_Context_ : c\n_Question_ : a?\n_Recommendation_ : w')
    assert.deepEqual(entryOf({ ...v2, subject: null, why: null })?.['question'], '_Subject_ : null\n_Context_ : c\n_Question_ : a?\n_Choices_ :\n- **A** : one\n- **null** : null')
    const f = withModule()
    put(f, 'q', v2)
    put(f, 'r', { ...v2, id: 'r', origin: { machine: 'box' }, sender: { session: 's-r', name: 'Orch: r' }, urgent: false })
    put(f, 'g', { ...v2, id: 'g', origin: { machine: 'box' }, sender: { session: 's-g', name: 'Orch: g' }, urgent: false })
    const remote = join(moduleOf(f), 'store', 'remote')
    mkdirSync(remote, { recursive: true })
    writeFileSync(join(remote, 'Orch_r'), JSON.stringify({ name: 'Orch: r', machine: 'bench' }))
    writeFileSync(join(remote, 'Orch_x'), 'not json')
    writeFileSync(join(remote, 'Orch_r.tmp-1'), JSON.stringify({ name: 'Orch: g', machine: 'no' }))
    assert.equal(main(f.ctx, ['round', '--by-urgency']), 0)
    assert.deepEqual(f.out.filter(l => l.startsWith('round ')), [
      'round q | operator | from Orch: v | since T | blocks: phase 3 | open | due | sender gone'.replace(' | blocks: phase 3', ' | blocks: -'),
      'round g | operator | from Orch: g | since T | blocks: - | open | due | sender gone',
      'round r | operator | from Orch: r | since T | blocks: - | open | due | remote on bench',
    ])
  })

  it('reads the pane open from the machine\'s ps: listed, not exiting nor a zombie, on its tty', () => {
    const answer = (stdout: string, status = 0) => fixture({ run: () => ({ status, stdout, stderr: '' }) })
    const open = (f: Fixture, record: unknown) => {
      pane(f, record)
      return paneOpen(f.ctx, f.state)
    }
    assert.equal(open(answer('S+ ttys001\n'), { pid: '7', tty: '/dev/ttys001' }), true)
    assert.equal(open(answer('S+ ttys002\n'), { pid: '7', tty: '/dev/ttys001' }), false)
    assert.equal(open(answer('?E ??\n'), { pid: 7 }), false)
    assert.equal(open(answer('Z+ ttys001\n'), { pid: 7 }), false)
    assert.equal(open(answer('S \n'), { pid: 7, tty: 'ttys001' }), true)
    assert.equal(open(answer('\n'), { pid: 7 }), false)
    assert.equal(open(answer('', 1), { pid: 7 }), false)
    assert.equal(open(answer(''), { pid: 'x' }), false)
    assert.equal(open(answer(''), []), false)
    const table = fixture({ env: { COORDINATOR_PS_TABLE: '/no/such/table' } })
    assert.equal(open(table, { pid: 7 }), false)
  })

  it('keeps the ids it printed before while the round holds them, and says a record it cannot write', () => {
    const f = withModule()
    put(f, 'a', entry('a'))
    put(f, 'b', entry('b', { status: 'closed' }))
    writeFileSync(join(f.state, 'round-listed.json'), JSON.stringify(['b', 'gone', 3]))
    assert.equal(main(f.ctx, ['round']), 0)
    assert.deepEqual(JSON.parse(readFileSync(join(f.state, 'round-listed.json'), 'utf8')), ['a', 'b'])
    writeFileSync(join(f.state, 'round-listed.json'), '{}')
    assert.equal(main(f.ctx, ['round']), 0)
    assert.deepEqual(JSON.parse(readFileSync(join(f.state, 'round-listed.json'), 'utf8')), ['a'])
    rmSync(join(f.state, 'round-listed.json'))
    mkdirSync(join(f.state, 'round-listed.json'))
    assert.equal(main(f.ctx, ['round']), 0)
    assert.deepEqual(f.err, [`coordinator: round: cannot record the listed entries in ${join(f.state, 'round-listed.json')}`])
  })

  it('prints nothing with no round directory, and refuses an argument', () => {
    const f = withModule()
    assert.equal(main(f.ctx, ['round']), 0)
    assert.equal(existsSync(join(f.state, 'round-listed.json')), false)
    assert.equal(main(f.ctx, ['round', '--soon']), 1)
    assert.deepEqual([f.out, f.err], [[], ['coordinator: round: unexpected argument --soon']])
  })
})
