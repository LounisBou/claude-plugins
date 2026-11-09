import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main } from './coordinator.ts'
import { fixture, type Fixture } from './fixture.ts'
import { entryFingerprint, parseEntry, storeKey } from './round.ts'

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

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function waitFile(f: Fixture, session: string, value: unknown): string {
  const dir = join(f.root, 'module', 'store', 'waits')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, storeKey(session))
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
  return path
}

const AT = '2026-10-18T10:06:07Z'

describe('round-close', () => {
  it('closes an open entry with the answer, by the coordinator, its delivery pending as the answer', () => {
    const f = fixture()
    const path = put(f, 'b-early', entry('b-early'))
    assert.equal(main(f.ctx, ['round-close', 'b-early', '--answer', 'A, ship it']), 0)
    assert.deepEqual(f.out, ['closed b-early'])
    const closed = json(path)
    assert.equal(closed['status'], 'closed')
    assert.deepEqual(closed['answer'], { text: 'A, ship it', by: 'coordinator', at: AT })
    assert.deepEqual(closed['delivery'], { state: 'pending', at: AT, attempts: 0, answerAt: AT })
    assert.deepEqual(readdirSync(join(f.state, 'round')), ['b-early.json'])
  })

  it('leaves no delivery on a done entry or one not open, and no answer stamp for another machine', () => {
    const f = fixture()
    const done = put(f, 'd', entry('d', { kind: 'done' }))
    const withdrawn = put(f, 'w', entry('w', { status: 'withdrawn' }))
    const far = put(f, 'r', entry('r', { origin: { machine: 'far' } }))
    for (const id of ['d', 'w', 'r']) assert.equal(main(f.ctx, ['round-close', id, '--answer', 'ok']), 0)
    assert.equal(json(done)['delivery'], undefined)
    assert.equal(json(withdrawn)['delivery'], undefined)
    assert.deepEqual(json(far)['delivery'], { state: 'pending', at: AT, attempts: 0 })
  })

  it('records the answer to a question that asks consent as its subject\'s consent record, and none on a withdrawal', () => {
    const config = join(fixture().root, 'config')
    const f = fixture({ env: { CLAUDE_CONFIG_DIR: config } })
    const consent = { kind: 'e2e-waiver', repo: 'Acme/Thing', pr: 12 }
    put(f, 'c', entry('c', { consent, question: 'Waive E2E on thing#12?', choices: [{ letter: 'A', text: 'waive it, docs only' }] }))
    put(f, 'w', entry('w', { consent }))
    put(f, 'n', entry('n'))
    assert.equal(main(f.ctx, ['round-close', 'c', '--answer', 'A : waive it, docs only']), 0)
    assert.equal(main(f.ctx, ['round-close', 'w', '--withdraw', '#12 merged']), 0)
    assert.equal(main(f.ctx, ['round-close', 'n', '--answer', 'go ahead with it']), 0)
    const dir = join(config, 'consents', 'acme', 'thing')
    assert.deepEqual(readdirSync(dir), ['c.json'])
    assert.deepEqual(json(join(dir, 'c.json')), {
      v: 1, subject: consent, entry: 'c', question: 'Waive E2E on thing#12?', answer: 'waive it, docs only', by: 'coordinator', at: AT,
    })
  })

  it('closes the entry all the same when its consent record cannot be written, and says so', () => {
    const blocker = join(fixture().root, 'file')
    writeFileSync(blocker, '')
    const f = fixture({ env: { CLAUDE_CONFIG_DIR: blocker } })
    const path = put(f, 'c', entry('c', { consent: { kind: 'auto-merge', repo: 'acme/thing' } }))
    assert.equal(main(f.ctx, ['round-close', 'c', '--answer', 'thing in auto-merge, yes']), 0)
    assert.equal(json(path)['status'], 'closed')
    assert.ok(f.err.some(line => line.includes('the consent of c was not recorded')))
  })

  it('withdraws on evidence, kept beside the text', () => {
    const f = fixture()
    const path = put(f, 'w', entry('w'))
    assert.equal(main(f.ctx, ['round-close', 'w', '--withdraw', '#12 merged at 10:04Z']), 0)
    assert.deepEqual(json(path)['answer'], { text: 'withdrawn: settled meanwhile — #12 merged at 10:04Z', by: 'coordinator', at: AT, evidence: '#12 merged at 10:04Z' })
  })

  it('refuses an unknown id, a path, an unreadable entry and a wrong usage, writing nothing', () => {
    const f = fixture()
    put(f, 'broken', '{"id": "half')
    put(f, 'other', entry('another'))
    const round = join(f.state, 'round')
    const cases: Array<[string[], string]> = [
      [['nobody', '--answer', 'x'], `round-close: no entry nobody in ${round}`],
      [['../coordinator', '--answer', 'x'], `round-close: no entry ../coordinator in ${round}`],
      [['..', '--answer', 'x'], `round-close: no entry .. in ${round}`],
      [['broken', '--answer', 'x'], `round-close: no entry broken in ${round}`],
      [['other', '--answer', 'x'], `round-close: no entry other in ${round}`],
      [['broken'], 'round-close: usage: round-close <id> --answer "<text>" | --withdraw "<evidence>"'],
      [[], 'round-close: usage: round-close <id> --answer "<text>" | --withdraw "<evidence>"'],
      [['broken', '--answer'], 'round-close: --answer needs a value'],
      [['broken', '--withdraw', ''], 'round-close: --withdraw needs the evidence read on the artifact'],
      [['broken', '--withdraw', 'x', '--answer', 'A'], 'round-close: usage: round-close <id> --answer "<text>" | --withdraw "<evidence>"'],
      [['broken', '--why', 'x'], 'round-close: unknown option --why'],
    ]
    for (const [args, message] of cases) {
      f.err.length = 0
      assert.equal(main(f.ctx, ['round-close', ...args]), 1, message)
      assert.deepEqual(f.err, [`coordinator: ${message}`])
    }
    assert.equal(readFileSync(join(round, 'broken.json'), 'utf8'), '{"id": "half')
  })

  it('refuses when the closed entry cannot be written', () => {
    const f = fixture()
    put(f, 'x', entry('x'))
    if (process.getuid?.() === 0) return
    chmodSync(join(f.state, 'round'), 0o555)
    assert.equal(main(f.ctx, ['round-close', 'x', '--answer', 'A']), 1)
    chmodSync(join(f.state, 'round'), 0o755)
    assert.deepEqual(f.err, [`coordinator: round-close: cannot write ${join(f.state, 'round', 'x.json')}`])
  })
})

describe('the fingerprint a close forgets', () => {
  it('is the module\'s, unit for unit', () => {
    // Computed by the bash implementation this one replaces.
    assert.equal(entryFingerprint({ kind: 'operator', blocks: 'phase 3', question: 'q' }), '17-fdd599a1')
    assert.equal(entryFingerprint({ kind: 'operator', blocks: null, question: 'Ship é 😀?', urgent: true }), '27-e529cb4d')
    assert.equal(entryFingerprint({ kind: 'done', blocks: 'x', question: 'Everything merged.' }), '24-766c6a9e')
    assert.equal(entryFingerprint({ kind: 'operator', blocks: 7, question: 'q' }), '11-2282f824')
  })

  it('is forgotten in the sender\'s wait file, with the turn\'s mark, the rest kept', () => {
    const f = fixture({ env: { ORCHESTRATOR_MODULE_DIR: '' } })
    const ctx = { ...f.ctx, env: { ...f.ctx.env, ORCHESTRATOR_MODULE_DIR: join(f.root, 'module') } }
    const one = entry('fp', { session: 's/1' })
    put(f, 'fp', one)
    const wait = waitFile(f, 's/1', { waiting: 'operator', blocks: 'phase 3', relayed: entryFingerprint(one), typed: true, name: 'Orch: f' })
    assert.equal(main(ctx, ['round-close', 'fp', '--answer', 'A']), 0)
    assert.equal(readFileSync(wait, 'utf8'), '{"waiting":"operator","blocks":"phase 3","relayed":null,"name":"Orch: f"}\n')
    assert.deepEqual(readdirSync(join(wait, '..')), ['s_1'])
  })

  it('is kept when the wait is a later one, and a wait that cannot be read is said, the close done', () => {
    const f = fixture()
    const ctx = { ...f.ctx, env: { ...f.ctx.env, ORCHESTRATOR_MODULE_DIR: join(f.root, 'module') } }
    put(f, 'a', entry('a'))
    const later = waitFile(f, 's-a', { relayed: '17-00000000' })
    assert.equal(main(ctx, ['round-close', 'a', '--answer', 'A']), 0)
    assert.equal(json(later)['relayed'], '17-00000000')
    put(f, 'b', entry('b'))
    const broken = waitFile(f, 's-b', 'not json')
    assert.equal(main(ctx, ['round-close', 'b', '--answer', 'A']), 0)
    assert.deepEqual(f.err, [`coordinator: round-close: cannot read ${broken}, its fingerprint is not forgotten`])
    put(f, 'c', entry('c'))
    waitFile(f, 's-c', '[1]')
    put(f, 'd', entry('d', { session: null }))
    put(f, 'e', entry('e', { session: 'nobody' }))
    for (const id of ['c', 'd', 'e']) assert.equal(main(ctx, ['round-close', id, '--answer', 'A']), 0)
    assert.equal(f.err.length, 1)
    assert.deepEqual(f.out, ['closed a', 'closed b', 'closed c', 'closed d', 'closed e'])
  })
})

describe('round-archive', () => {
  it('moves the closed entries alone, and says how many', () => {
    const f = fixture()
    put(f, 'z-closed', entry('z-closed', { status: 'closed' }))
    put(f, 'y-closed', entry('y-closed', { status: 'closed' }))
    put(f, 'z-open', entry('z-open'))
    put(f, 'z-broken', '{"id": "half')
    put(f, 'z-shape', { id: 'z-shape', status: 'closed' })
    mkdirSync(join(f.state, 'round', 'dir.json'))
    assert.equal(main(f.ctx, ['round-archive']), 0)
    assert.equal(main(f.ctx, ['round-archive']), 0)
    assert.deepEqual(f.out, ['archived 2', 'archived 0'])
    assert.deepEqual(readdirSync(join(f.state, 'round', 'archive')).sort(), ['y-closed.json', 'z-closed.json'])
    assert.deepEqual(readdirSync(join(f.state, 'round')).sort(), ['archive', 'dir.json', 'z-broken.json', 'z-open.json', 'z-shape.json'])
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
    put(f, 'c', entry('c', { status: 'closed' }))
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
