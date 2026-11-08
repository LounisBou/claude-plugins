import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main } from './coordinator.ts'
import { fixture, liveOn, type FixtureOptions } from './fixture.ts'
import { parseRecord } from './record.ts'

/** A fixture whose COORDINATOR_VERIFY names an executable file, its answers given by `live`. */
function withCheck(live: Readonly<Record<string, number | null>>, options: FixtureOptions = {}) {
  const f = fixture({ ...options, run: options.run ?? liveOn(live) })
  const check = join(f.root, 'verify')
  writeFileSync(check, '#!/bin/sh\n')
  chmodSync(check, 0o755)
  return { ...f, ctx: { ...f.ctx, env: { ...f.ctx.env, COORDINATOR_VERIFY: check } }, check }
}

function record(state: string): unknown {
  return JSON.parse(readFileSync(join(state, 'coordinator.json'), 'utf8'))
}

describe('register', () => {
  it('records the name, the tty, the start and the pid the check names, then says so', () => {
    const f = withCheck({ '/dev/ttys101': 5100 })
    assert.equal(main(f.ctx, ['register', '--name', 'Coord : one [a1b2c3]', '--tty', '/dev/ttys101']), 0)
    assert.deepEqual(f.out, ['registered Coord : one [a1b2c3]'])
    assert.deepEqual(record(f.state), { name: 'Coord : one [a1b2c3]', tty: '/dev/ttys101', started: '2026-10-18T10:06:07Z', pid: 5100 })
    assert.equal(existsSync(join(f.state, 'coordinator.lock')), false)
  })

  it('records no pid when the check names none, and says so in one line', () => {
    const f = withCheck({ '/dev/ttys123': null })
    assert.equal(main(f.ctx, ['register', '--name', 'Coord : n', '--tty', '/dev/ttys123']), 0)
    assert.equal((record(f.state) as { pid?: number }).pid, undefined)
    assert.deepEqual(f.err, ['coordinator: no process id found on /dev/ttys123: the record is written without one'])
  })

  it('refuses while the recorded coordinator runs, and keeps its record', () => {
    const f = withCheck({ '/dev/ttys101': 5100 })
    main(f.ctx, ['register', '--name', 'Coord : one', '--tty', '/dev/ttys101'])
    assert.equal(main(f.ctx, ['register', '--name', 'Coord : two', '--tty', '/dev/ttys102']), 1)
    assert.deepEqual(f.err, ['coordinator: refused: a live coordinator is recorded: Coord : one on /dev/ttys101'])
    assert.equal((record(f.state) as { name: string }).name, 'Coord : one')
    assert.deepEqual(f.runs.at(-1)?.slice(1), ['--tty', '/dev/ttys101', '--pid', '5100'])
  })

  it('replaces a stale or unreadable record and says which', () => {
    const f = withCheck({ '/dev/ttys102': 7 })
    mkdirSync(f.state, { recursive: true })
    writeFileSync(join(f.state, 'coordinator.json'), JSON.stringify({ name: 'Coord : old', tty: '/dev/ttys101', pid: 1 }))
    assert.equal(main(f.ctx, ['register', '--name', 'Coord : two', '--tty', '/dev/ttys102']), 0)
    writeFileSync(join(f.state, 'coordinator.json'), 'not json')
    assert.equal(main(f.ctx, ['register', '--name', 'Coord : three', '--tty', '/dev/ttys102']), 0)
    assert.deepEqual(f.err, ['coordinator: replaced a stale record: Coord : old', 'coordinator: replaced a stale record: an unreadable record'])
  })

  it('is no registration when the record cannot be written', () => {
    const f = withCheck({})
    mkdirSync(join(f.state, 'coordinator.json'), { recursive: true })
    assert.equal(main(f.ctx, ['register', '--name', 'Coord : r', '--tty', '/dev/ttys110']), 1)
    assert.deepEqual(f.out, [])
    assert.deepEqual(f.err, [`coordinator: cannot write ${join(f.state, 'coordinator.json')}: it is a directory`])
  })

  it('refuses a usage it does not know', () => {
    const f = withCheck({})
    assert.equal(main(f.ctx, ['register', '--name', 'Coord : x']), 1)
    assert.equal(main(f.ctx, ['register', '--name']), 1)
    assert.equal(main(f.ctx, ['register', '--port', '1']), 1)
    assert.deepEqual(f.err, [
      'coordinator: register: usage: register --name "<name [ref]>" --tty /dev/ttysNNN',
      'coordinator: register: --name needs a value',
      'coordinator: register: unknown option --port',
    ])
  })
})

describe('liveness', () => {
  it('reads an error of the check as an error, never as dead', () => {
    const f = withCheck({}, { run: () => ({ status: 1, stdout: '', stderr: 'cannot read the process table\n' }) })
    mkdirSync(f.state, { recursive: true })
    writeFileSync(join(f.state, 'coordinator.json'), JSON.stringify({ name: 'Coord : six', tty: '/dev/ttys106' }))
    assert.equal(main(f.ctx, ['lookup']), 1)
    assert.deepEqual(f.err, ['coordinator: the liveness check failed on /dev/ttys106: cannot read the process table'])
    const g = withCheck({}, { run: () => ({ status: 3, stdout: '', stderr: '' }) })
    mkdirSync(g.state, { recursive: true })
    writeFileSync(join(g.state, 'coordinator.json'), JSON.stringify({ name: 'Coord : six', tty: '/dev/ttys106' }))
    assert.equal(main(g.ctx, ['lookup']), 1)
    assert.deepEqual(g.err, ['coordinator: the liveness check failed on /dev/ttys106: exit 3'])
  })

  it('refuses a liveness command that is missing, and runs the launcher when none is named', () => {
    const f = fixture({ env: { COORDINATOR_VERIFY: '/nowhere/verify' } })
    mkdirSync(f.state, { recursive: true })
    writeFileSync(join(f.state, 'coordinator.json'), JSON.stringify({ name: 'Coord : six', tty: '/dev/ttys106' }))
    assert.equal(main(f.ctx, ['lookup']), 1)
    assert.deepEqual(f.err, ['coordinator: the liveness command /nowhere/verify is missing or not executable'])

    const g = fixture({ run: liveOn({ '/dev/ttys106': 9 }) })
    mkdirSync(g.state, { recursive: true })
    writeFileSync(join(g.state, 'coordinator.json'), JSON.stringify({ name: 'Coord : six', tty: '/dev/ttys106' }))
    assert.equal(main(g.ctx, ['lookup']), 1)
    const launcher = join(g.ctx.here, '..', '..', 'iterm-agents', 'scripts', 'iterm-agent.sh')
    assert.deepEqual(g.err, [`coordinator: the launcher ${launcher} is missing`])
    mkdirSync(join(launcher, '..'), { recursive: true })
    writeFileSync(launcher, '')
    assert.equal(main(g.ctx, ['lookup']), 0)
    assert.deepEqual(g.out, ['Coord : six'])
    assert.deepEqual(g.runs.at(-1), ['bash', launcher, 'verify', '--tty', '/dev/ttys106'])
  })
})

describe('lookup and clear', () => {
  it('prints the name only while its session runs, and names a stale record on the error stream', () => {
    const f = withCheck({ '/dev/ttys120': 4002 })
    assert.equal(main(f.ctx, ['lookup']), 0)
    assert.deepEqual([f.out, f.err], [[], []])
    mkdirSync(f.state, { recursive: true })
    writeFileSync(join(f.state, 'coordinator.json'), JSON.stringify({ name: 'Coord : pid', tty: '/dev/ttys120', pid: 4001 }))
    assert.equal(main(f.ctx, ['lookup']), 0)
    writeFileSync(join(f.state, 'coordinator.json'), JSON.stringify({ name: 'Coord : pid', tty: '/dev/ttys120', pid: 4002 }))
    assert.equal(main(f.ctx, ['lookup']), 0)
    writeFileSync(join(f.state, 'coordinator.json'), '[]')
    assert.equal(main(f.ctx, ['lookup']), 0)
    assert.deepEqual(f.out, ['Coord : pid'])
    assert.deepEqual(f.err, ['coordinator: stale record: Coord : pid on /dev/ttys120', 'coordinator: stale record: an unreadable record on no tty'])
  })

  it('clears the record, none being no error, and refuses an argument', () => {
    const f = withCheck({})
    mkdirSync(f.state, { recursive: true })
    writeFileSync(join(f.state, 'coordinator.json'), '{}')
    assert.equal(main(f.ctx, ['clear']), 0)
    assert.equal(existsSync(join(f.state, 'coordinator.json')), false)
    assert.equal(main(f.ctx, ['clear']), 0)
    assert.equal(main(f.ctx, ['clear', 'x']), 1)
    assert.equal(main(f.ctx, ['lookup', 'x']), 1)
    mkdirSync(join(f.state, 'coordinator.json'))
    assert.equal(main(f.ctx, ['clear']), 1)
    assert.deepEqual(f.err, [
      'coordinator: clear: unexpected argument x',
      'coordinator: lookup: unexpected argument x',
      `coordinator: clear: cannot remove ${join(f.state, 'coordinator.json')}`,
    ])
  })

  it('reads every field as text, and anything but an object as an empty record', () => {
    assert.deepEqual(parseRecord('{"name":"n","tty":"t","pid":12}'), { name: 'n', tty: 't', pid: '12' })
    assert.deepEqual(parseRecord('{"name":null,"tty":false,"pid":{"a":1}}'), { name: '', tty: '', pid: '{"a":1}' })
    assert.deepEqual(parseRecord('"text"'), { name: '', tty: '', pid: '' })
    assert.deepEqual(parseRecord('{'), { name: '', tty: '', pid: '' })
  })

  it('refuses a subcommand it does not hold', () => {
    const f = fixture()
    assert.equal(main(f.ctx, ['facts']), 1)
    assert.deepEqual(f.err, ['coordinator: not a ported subcommand: facts'])
  })
})
