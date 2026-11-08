import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fixture } from './fixture.ts'
import { lockHolder, lockPath, releaseHeld, withCoordinatorLock } from './lock.ts'

describe('the coordinator lock', () => {
  it('records its holder inside it while held, and is gone after', () => {
    const f = fixture()
    const lock = lockPath(f.state)
    const seen = withCoordinatorLock(f.ctx, 'registration', () => readFileSync(join(lock, 'holder'), 'utf8'))
    assert.equal(seen, '4242 registration\n')
    assert.equal(existsSync(lock), false)
  })

  it('is released when the work throws', () => {
    const f = fixture()
    assert.throws(() => withCoordinatorLock(f.ctx, 'sleep', () => { throw new Error('boom') }), /boom/)
    assert.equal(existsSync(lockPath(f.state)), false)
  })

  it('waits five seconds for a held lock, then refuses naming it, and leaves it in place', () => {
    const f = fixture({ running: pid => pid === 77 })
    const lock = lockPath(f.state)
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'holder'), '77 registration\n')
    assert.throws(() => withCoordinatorLock(f.ctx, 'drop', () => 1),
      { message: `refused: a registration holds the lock: ${lock} held by pid 77 (running): remove ${lock}` })
    assert.equal(f.slept.length, 49)
    assert.equal(f.slept.reduce((a, b) => a + b, 0), 4_900)
    assert.equal(readFileSync(join(lock, 'holder'), 'utf8'), '77 registration\n')
  })

  it('names a holder as far as its file says, and nothing guessed', () => {
    const f = fixture()
    const lock = lockPath(f.state)
    mkdirSync(lock, { recursive: true })
    assert.equal(lockHolder(f.ctx, lock), `the coordinator's lock is held: ${lock} names no holder`)
    writeFileSync(join(lock, 'holder'), '12\n')
    assert.equal(lockHolder(f.ctx, lock), `the coordinator's lock is held: ${lock} held by pid 12 (dead)`)
    writeFileSync(join(lock, 'holder'), 'someone\n')
    assert.equal(lockHolder(f.ctx, lock), `the coordinator's lock is held: ${lock} names no holder`)
  })

  it('refuses a state directory it cannot create or write, at once', () => {
    const f = fixture()
    writeFileSync(join(f.root, 'file'), '')
    const blocked = { ...f.ctx, env: { ORCHESTRATOR_STATE_DIR: join(f.root, 'file', 'state') } }
    assert.throws(() => withCoordinatorLock(blocked, 'sleep', () => 1), { message: `cannot create the state directory ${join(f.root, 'file', 'state')}` })
    if (process.getuid?.() !== 0) {
      mkdirSync(f.state)
      chmodSync(f.state, 0o555)
      assert.throws(() => withCoordinatorLock(f.ctx, 'sleep', () => 1), { message: `cannot write into the state directory ${f.state}` })
      assert.equal(f.slept.length, 0)
      chmodSync(f.state, 0o755)
    }
  })

  it('refuses a lock path that is no directory', () => {
    const f = fixture()
    mkdirSync(f.state)
    writeFileSync(lockPath(f.state), '')
    assert.throws(() => withCoordinatorLock(f.ctx, 'sleep', () => 1), { message: `cannot create the lock ${lockPath(f.state)}` })
  })

  it('releases on a signal the locks this process holds', () => {
    const f = fixture()
    withCoordinatorLock(f.ctx, 'sleep', () => {
      releaseHeld()
      assert.equal(existsSync(lockPath(f.state)), false)
    })
  })
})
